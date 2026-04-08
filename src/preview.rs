//! `preview.rs` — Windowed preview mode with egui control panel.
//!
//! Renders the selected shader in a resizable window split into two regions:
//! - Left: shader viewport (fullscreen sans panel)
//! - Right: 280-px egui control panel (shader/palette ComboBox, speed/zoom sliders,
//!   ▶ Preview button to apply changes live)
//!
//! Keyboard shortcuts (the window must have keyboard focus):
//!   Q / Escape — quit
//!   R          — force-reload the current shader from disk

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context as _;
use calloop::EventLoop;
use calloop_wayland_source::WaylandSource;
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState},
    delegate_compositor, delegate_keyboard, delegate_output, delegate_pointer, delegate_registry,
    delegate_seat, delegate_xdg_shell, delegate_xdg_window,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{
        keyboard::{KeyEvent, KeyboardHandler, Keysym, Modifiers},
        pointer::{PointerEvent, PointerEventKind, PointerHandler},
        Capability, SeatHandler, SeatState,
    },
    shell::{
        xdg::{
            window::{Window, WindowConfigure, WindowDecorations, WindowHandler},
            XdgShell,
        },
        WaylandSurface,
    },
};
use wayland_client::{
    globals::registry_queue_init,
    protocol::{wl_keyboard, wl_output, wl_pointer, wl_seat, wl_surface},
    Connection, QueueHandle,
};

use crate::{config::Config, palette::PaletteManager, renderer::Renderer, shaders::ShaderManager};

// Width of the right-side egui control panel in logical pixels.
const PANEL_WIDTH: u32 = 280;

// ---------------------------------------------------------------------------
// EGL state (mirrors wayland.rs — preview and daemon paths are kept separate)
// ---------------------------------------------------------------------------

struct EglState {
    egl: khronos_egl::DynamicInstance<khronos_egl::EGL1_4>,
    display: khronos_egl::Display,
    config: khronos_egl::Config,
}

impl EglState {
    fn new(display_ptr: *mut std::ffi::c_void) -> anyhow::Result<Self> {
        let egl = unsafe {
            khronos_egl::DynamicInstance::<khronos_egl::EGL1_4>::load_required()
                .context("failed to load libEGL")?
        };

        let display = unsafe { egl.get_display(display_ptr) }
            .ok_or_else(|| anyhow::anyhow!("eglGetDisplay returned EGL_NO_DISPLAY"))?;

        egl.initialize(display).context("eglInitialize failed")?;

        egl.bind_api(khronos_egl::OPENGL_ES_API)
            .context("eglBindAPI(OPENGL_ES_API) failed")?;

        #[rustfmt::skip]
        let attribs = [
            khronos_egl::RED_SIZE,        8,
            khronos_egl::GREEN_SIZE,      8,
            khronos_egl::BLUE_SIZE,       8,
            khronos_egl::ALPHA_SIZE,      8,
            khronos_egl::DEPTH_SIZE,      0,
            khronos_egl::STENCIL_SIZE,    0,
            khronos_egl::SURFACE_TYPE,    khronos_egl::WINDOW_BIT,
            khronos_egl::RENDERABLE_TYPE, khronos_egl::OPENGL_ES3_BIT,
            khronos_egl::NONE,
        ];

        let config = egl
            .choose_first_config(display, &attribs)
            .context("eglChooseConfig failed")?
            .ok_or_else(|| anyhow::anyhow!("no suitable EGL config found"))?;

        Ok(Self {
            egl,
            display,
            config,
        })
    }
}

// ---------------------------------------------------------------------------
// egui panel state
// ---------------------------------------------------------------------------

/// Persistent UI state for the right-side egui control panel.
struct PreviewPanelState {
    selected_shader: String,
    selected_palette: String,
    speed: f32,
    zoom: f32,
    status_message: String,
    /// Set to true by the ▶ Preview button; cleared after applying changes.
    preview_requested: bool,
}

/// egui resources bundled together so they can be `.take()`n out of
/// `PreviewState` during rendering without borrow-checker conflicts.
struct EguiBundle {
    ctx: egui::Context,
    painter: egui_glow::Painter,
    /// Second `glow::Context` sharing function pointers with the renderer's GL
    /// context; used to reset the GL viewport before egui paints.
    gl_arc: Arc<glow::Context>,
    state: PreviewPanelState,
}

// ---------------------------------------------------------------------------
// PreviewState — central state for the xdg-toplevel preview window
// ---------------------------------------------------------------------------

/// Central state object for the preview mode event loop.
struct PreviewState {
    // SCTK protocol state
    registry_state: RegistryState,
    compositor_state: CompositorState,
    xdg_shell: XdgShell,
    seat_state: SeatState,
    output_state: OutputState,

    // Window + GL
    window: Option<Window>,
    width: u32,
    height: u32,
    scale_factor: i32,
    configured: bool,

    wl_egl_window: Option<wayland_egl::WlEglSurface>,
    egl_surface: Option<khronos_egl::Surface>,
    egl_context: Option<khronos_egl::Context>,
    renderer: Option<Renderer>,

    // Control
    running: bool,
    force_reload: bool,
    start_time: Instant,

    // Application state
    config: Config,
    shader_manager: ShaderManager,
    palette_manager: PaletteManager,
    active_shader: String,
    active_palette: String,

    // Infrastructure
    egl: Option<EglState>,
    keyboard: Option<wl_keyboard::WlKeyboard>,
    pointer: Option<wl_pointer::WlPointer>,
    signal_flag: Arc<AtomicBool>,

    // egui control panel
    egui_bundle: Option<EguiBundle>,
    cursor_pos: (f32, f32),
    /// Accumulates egui::Events from pointer/keyboard callbacks between frames.
    egui_events: Vec<egui::Event>,
}

impl PreviewState {
    fn phys_width(&self) -> u32 {
        self.width * self.scale_factor.max(1) as u32
    }

    fn phys_height(&self) -> u32 {
        self.height * self.scale_factor.max(1) as u32
    }

    /// Initialise EGL context and renderer using the window's wl_surface.
    fn init_gl(
        &mut self,
        egl: &EglState,
        wl_surface_id: wayland_client::backend::ObjectId,
        shader_compiled: &str,
        palette: &crate::palette::PaletteEntry,
    ) -> anyhow::Result<()> {
        let w = self.phys_width().max(1) as i32;
        let h = self.phys_height().max(1) as i32;

        let wl_egl = wayland_egl::WlEglSurface::new(wl_surface_id, w, h)
            .context("failed to create wl_egl_window")?;

        let egl_surface = unsafe {
            egl.egl
                .create_window_surface(
                    egl.display,
                    egl.config,
                    wl_egl.ptr() as khronos_egl::NativeWindowType,
                    None,
                )
                .context("eglCreateWindowSurface failed")?
        };

        #[rustfmt::skip]
        let ctx_attribs = [
            khronos_egl::CONTEXT_MAJOR_VERSION, 3,
            khronos_egl::NONE,
        ];
        let egl_context = egl
            .egl
            .create_context(egl.display, egl.config, None, &ctx_attribs)
            .context("eglCreateContext failed")?;

        egl.egl
            .make_current(
                egl.display,
                Some(egl_surface),
                Some(egl_surface),
                Some(egl_context),
            )
            .context("eglMakeCurrent failed")?;

        let gl = unsafe {
            glow::Context::from_loader_function(|sym| {
                egl.egl
                    .get_proc_address(sym)
                    .map(|f| f as *const _)
                    .unwrap_or(std::ptr::null())
            })
        };

        let mut renderer = Renderer::new(gl).context("Renderer::new failed")?;
        renderer
            .load_shader(shader_compiled)
            .context("initial shader load failed")?;
        renderer
            .set_palette(palette)
            .context("initial palette upload failed")?;
        // No fade in preview mode — always fully opaque.
        renderer.set_alpha(1.0);

        self.wl_egl_window = Some(wl_egl);
        self.egl_surface = Some(egl_surface);
        self.egl_context = Some(egl_context);
        self.renderer = Some(renderer);

        // Create a second glow::Context from the same EGL loader for egui_glow.
        // Both contexts hold function pointers into the same underlying OpenGL
        // context — only one is ever active at a time, so this is safe.
        let gl_arc = Arc::new(unsafe {
            glow::Context::from_loader_function(|sym| {
                egl.egl
                    .get_proc_address(sym)
                    .map(|f| f as *const _)
                    .unwrap_or(std::ptr::null())
            })
        });

        let egui_ctx = egui::Context::default();
        let mut visuals = egui::Visuals::dark();
        visuals.panel_fill = egui::Color32::from_rgba_unmultiplied(18, 18, 24, 240);
        egui_ctx.set_visuals(visuals);

        match egui_glow::Painter::new(Arc::clone(&gl_arc), "", None) {
            Ok(painter) => {
                self.egui_bundle = Some(EguiBundle {
                    ctx: egui_ctx,
                    painter,
                    gl_arc,
                    state: PreviewPanelState {
                        selected_shader: self.active_shader.clone(),
                        selected_palette: self.active_palette.clone(),
                        speed: 1.0,
                        zoom: 1.0,
                        status_message: String::new(),
                        preview_requested: false,
                    },
                });
            }
            Err(e) => {
                log::warn!("preview: egui_glow::Painter::new failed: {e}; panel disabled");
            }
        }

        Ok(())
    }

    /// Make the EGL context current, render one frame, and swap buffers.
    fn render_frame(&mut self, egl: &EglState) {
        let (Some(es), Some(ec)) = (self.egl_surface, self.egl_context) else {
            return;
        };
        if self.renderer.is_none() {
            return;
        }

        if egl
            .egl
            .make_current(egl.display, Some(es), Some(es), Some(ec))
            .is_err()
        {
            log::warn!("preview: make_current failed");
            return;
        }

        let phys_w = self.phys_width();
        let phys_h = self.phys_height();
        let scale = self.scale_factor.max(1) as u32;
        let panel_w_phys = PANEL_WIDTH * scale;
        let shader_w_phys = phys_w.saturating_sub(panel_w_phys).max(1);

        // Render shader in the left portion of the window.
        self.renderer
            .as_mut()
            .unwrap()
            .render([shader_w_phys as f32, phys_h as f32]);

        // Drain accumulated egui input events, then paint the control panel.
        let events = std::mem::take(&mut self.egui_events);
        self.render_panel(phys_w, phys_h, events);

        if let Err(e) = egl.egl.swap_buffers(egl.display, es) {
            log::warn!("preview: swap_buffers failed: {e:?}");
        }
    }

    /// Run one egui frame and paint the right-side control panel.
    ///
    /// Takes `EguiBundle` out of `self` to avoid borrow conflicts while
    /// mutating other fields (renderer, shader_manager, etc.) inside the
    /// "apply preview" block.
    fn render_panel(&mut self, phys_w: u32, phys_h: u32, events: Vec<egui::Event>) {
        let mut bundle = match self.egui_bundle.take() {
            Some(b) => b,
            None => return,
        };

        let scale = self.scale_factor.max(1) as f32;
        let logical_w = phys_w as f32 / scale;
        let logical_h = phys_h as f32 / scale;

        let raw_input = egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::Vec2::new(logical_w, logical_h),
            )),
            pixels_per_point: Some(scale),
            events,
            ..Default::default()
        };

        let mut shader_list: Vec<String> =
            self.shader_manager.list().iter().map(|s| s.to_string()).collect();
        shader_list.sort();
        let mut palette_list: Vec<String> =
            self.palette_manager.list().iter().map(|p| p.to_string()).collect();
        palette_list.sort();

        let full_output = bundle.ctx.run(raw_input, |ctx| {
            draw_panel(ctx, &mut bundle.state, &shader_list, &palette_list);
        });

        let clipped = bundle.ctx.tessellate(full_output.shapes, scale);

        // Reset the GL viewport to the full window before egui paints.
        unsafe {
            bundle.gl_arc.viewport(0, 0, phys_w as i32, phys_h as i32);
        }
        bundle.painter.paint_and_update_textures(
            [phys_w, phys_h],
            scale,
            &clipped,
            &full_output.textures_delta,
        );

        // Apply selections when the ▶ Preview button is pressed.
        if bundle.state.preview_requested {
            bundle.state.preview_requested = false;
            let sel_shader = bundle.state.selected_shader.clone();
            let sel_palette = bundle.state.selected_palette.clone();
            let speed = bundle.state.speed;
            let zoom = bundle.state.zoom;

            if let Some(src) = self.shader_manager.get_compiled(&sel_shader) {
                let src = src.to_string();
                if let Some(r) = self.renderer.as_mut() {
                    match r.load_shader(&src) {
                        Ok(()) => {
                            self.active_shader = sel_shader.clone();
                            bundle.state.status_message =
                                format!("Loaded '{sel_shader}'");
                            log::info!("panel: shader → '{sel_shader}'");
                        }
                        Err(e) => {
                            bundle.state.status_message =
                                format!("Compile error (see log)");
                            log::warn!(
                                "panel: compile error for '{sel_shader}': {e:#}"
                            );
                        }
                    }
                }
            }

            if let Some(palette) = self.palette_manager.get(&sel_palette).cloned() {
                self.active_palette = sel_palette.clone();
                if let Some(r) = self.renderer.as_mut() {
                    r.set_palette(&palette).ok();
                }
            }

            if let Some(r) = self.renderer.as_mut() {
                r.set_speed_scale(speed);
                r.set_zoom_scale(zoom);
            }

            if let Some(win) = &self.window {
                win.set_title(format!("hyprsaver preview — {sel_shader}"));
            }
        }

        self.egui_bundle = Some(bundle);
    }

    /// Resize the EGL surface after a configure event.
    fn resize_gl(&mut self, egl: &EglState) {
        let w = self.phys_width().max(1) as i32;
        let h = self.phys_height().max(1) as i32;

        if let Some(ref wew) = self.wl_egl_window {
            wew.resize(w, h, 0, 0);
        }
        if let (Some(es), Some(ec)) = (self.egl_surface, self.egl_context) {
            let _ = egl
                .egl
                .make_current(egl.display, Some(es), Some(es), Some(ec));
        }
    }

    /// Release all GL resources.
    fn destroy_gl(&mut self, egl: &EglState) {
        if let (Some(es), Some(ec)) = (self.egl_surface, self.egl_context) {
            let _ = egl
                .egl
                .make_current(egl.display, Some(es), Some(es), Some(ec));
        }
        // Drop egui FIRST: its Painter deletes GL objects while the context is current.
        self.egui_bundle = None;
        self.renderer = None;
        if let Some(ec) = self.egl_context.take() {
            let _ = egl.egl.destroy_context(egl.display, ec);
        }
        if let Some(es) = self.egl_surface.take() {
            let _ = egl.egl.destroy_surface(egl.display, es);
        }
        self.wl_egl_window = None;
    }

    /// Handle a force-reload of the current shader (R key).
    fn reload_current_shader(&mut self) {
        let name = self.active_shader.clone();
        if let Err(e) = self.shader_manager.reload_shader(&name) {
            log::warn!("preview: shader reload failed for '{name}': {e:#}");
            return;
        }
        if let Some(src) = self.shader_manager.get_compiled(&name) {
            let src = src.to_string();
            if let Some(r) = self.renderer.as_mut() {
                match r.load_shader(&src) {
                    Ok(()) => log::info!("preview: reloaded shader '{name}'"),
                    Err(e) => log::warn!("preview: shader compile error: {e:#}"),
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Run the preview window event loop. Blocks until the window is closed.
pub fn run(
    config: Config,
    shader_manager: ShaderManager,
    palette_manager: PaletteManager,
    signal_flag: Arc<AtomicBool>,
    shader_override: Option<&str>,
) -> anyhow::Result<()> {
    let conn = Connection::connect_to_env()
        .context("failed to connect to Wayland display; is WAYLAND_DISPLAY set?")?;

    let (globals, event_queue) =
        registry_queue_init(&conn).context("failed to enumerate Wayland globals")?;
    let qh: QueueHandle<PreviewState> = event_queue.handle();

    let compositor = CompositorState::bind(&globals, &qh).context("wl_compositor not available")?;
    let xdg_shell = XdgShell::bind(&globals, &qh)
        .context("xdg_wm_base not available; is a desktop compositor running?")?;
    let seat_state = SeatState::new(&globals, &qh);
    let output_state = OutputState::new(&globals, &qh);
    let registry_state = RegistryState::new(&globals);

    // Resolve shader name (CLI override → config → "mandelbrot" fallback).
    let active_shader = resolve_shader(&config, &shader_manager, shader_override);
    let active_palette = resolve_palette(&config, &palette_manager);

    log::info!(
        "preview: shader='{}' palette='{}'",
        active_shader,
        active_palette
    );

    // Initialise EGL.
    let display_ptr = conn.backend().display_ptr() as *mut std::ffi::c_void;
    let egl = match EglState::new(display_ptr) {
        Ok(e) => {
            log::info!("preview: EGL initialised");
            Some(e)
        }
        Err(e) => {
            log::error!("preview: EGL init failed: {e:#}");
            None
        }
    };

    // Create the xdg-toplevel window.
    let wl_surf = compositor.create_surface(&qh);
    let window = xdg_shell.create_window(wl_surf, WindowDecorations::ServerDefault, &qh);
    window.set_title(format!("hyprsaver preview — {active_shader}"));
    window.set_app_id("hyprsaver");
    window.set_min_size(Some((PANEL_WIDTH + 400, 300)));
    // Commit to request the initial configure from the compositor.
    window.wl_surface().commit();

    let mut state = PreviewState {
        registry_state,
        compositor_state: compositor,
        xdg_shell,
        seat_state,
        output_state,
        window: Some(window),
        width: 800,
        height: 600,
        scale_factor: 1,
        configured: false,
        wl_egl_window: None,
        egl_surface: None,
        egl_context: None,
        renderer: None,
        running: true,
        force_reload: false,
        start_time: Instant::now(),
        config,
        shader_manager,
        palette_manager,
        active_shader,
        active_palette,
        egl,
        keyboard: None,
        pointer: None,
        signal_flag,
        egui_bundle: None,
        cursor_pos: (0.0, 0.0),
        egui_events: Vec::new(),
    };

    // Calloop event loop.
    let fps = state.config.general.fps.max(1);
    let frame_ms = 1000u64 / fps as u64;

    let mut event_loop: EventLoop<PreviewState> =
        EventLoop::try_new().context("failed to create calloop EventLoop")?;
    let loop_handle = event_loop.handle();

    WaylandSource::new(conn.clone(), event_queue)
        .insert(loop_handle.clone())
        .map_err(|e| anyhow::anyhow!("failed to insert WaylandSource: {e}"))?;

    // Render timer — fires every frame_ms milliseconds.
    let render_timer = calloop::timer::Timer::from_duration(Duration::from_millis(frame_ms));
    loop_handle
        .insert_source(render_timer, move |_, _, state: &mut PreviewState| {
            // Check signal flag (SIGTERM/SIGINT).
            if !state.signal_flag.load(Ordering::Relaxed) {
                state.running = false;
                return calloop::timer::TimeoutAction::Drop;
            }

            // Hot-reload: changes detected by the filesystem watcher.
            let reloaded = state.shader_manager.poll_changes();
            for name in &reloaded {
                if *name == state.active_shader {
                    if let Some(src) = state.shader_manager.get_compiled(name) {
                        let src = src.to_string();
                        if let Some(r) = state.renderer.as_mut() {
                            match r.load_shader(&src) {
                                Ok(()) => log::info!("preview: hot-reloaded shader '{name}'"),
                                Err(e) => log::warn!("preview: hot-reload compile error: {e:#}"),
                            }
                        }
                    }
                }
            }

            // R key: force-reload from disk.
            if state.force_reload {
                state.force_reload = false;
                state.reload_current_shader();
            }

            // Advance palette cross-fade transition.
            let now = Instant::now();
            let blend = state.palette_manager.advance_transition(now);
            if let Some(r) = state.renderer.as_mut() {
                r.set_blend(if blend > 0.0 { blend } else { 0.0 });
            }

            // Render if configured.
            if state.configured {
                let egl_ptr = state.egl.as_ref().map(|e| e as *const EglState);
                if let Some(egl_ptr) = egl_ptr {
                    // SAFETY: egl lives as long as PreviewState.
                    state.render_frame(unsafe { &*egl_ptr });
                }
            }

            calloop::timer::TimeoutAction::ToDuration(Duration::from_millis(frame_ms))
        })
        .map_err(|e| anyhow::anyhow!("failed to insert render timer: {e}"))?;

    log::info!("preview: entering event loop");
    loop {
        event_loop
            .dispatch(Some(Duration::from_millis(frame_ms)), &mut state)
            .context("event loop dispatch error")?;

        if !state.signal_flag.load(Ordering::Relaxed) {
            state.running = false;
        }

        if !state.running {
            log::info!("preview: exiting (running=false)");
            break;
        }
    }

    // Cleanup — use raw pointer to avoid simultaneous borrow of state.egl and state (mut).
    if let Some(egl_ptr) = state.egl.as_ref().map(|e| e as *const EglState) {
        // SAFETY: egl lives as long as state; we just split the borrow.
        state.destroy_gl(unsafe { &*egl_ptr });
        unsafe { (*egl_ptr).egl.terminate((*egl_ptr).display).ok() };
    }

    log::info!("preview: event loop exited");
    Ok(())
}

// ---------------------------------------------------------------------------
// Shader / palette resolution
// ---------------------------------------------------------------------------

fn resolve_shader(
    config: &Config,
    shader_manager: &ShaderManager,
    override_name: Option<&str>,
) -> String {
    let name = override_name.unwrap_or(&config.general.shader);
    match name {
        "random" => shader_manager.random().0.to_string(),
        n => {
            if shader_manager.get(n).is_some() {
                n.to_string()
            } else {
                log::warn!("preview: unknown shader '{n}', falling back to mandelbrot");
                shader_manager
                    .get("mandelbrot")
                    .map(|_| "mandelbrot".to_string())
                    .unwrap_or_else(|| {
                        shader_manager
                            .list()
                            .first()
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| "mandelbrot".to_string())
                    })
            }
        }
    }
}

fn resolve_palette(config: &Config, palette_manager: &PaletteManager) -> String {
    let name = &config.general.palette;
    match name.as_str() {
        "random" => palette_manager.random().0.to_string(),
        n => {
            if palette_manager.get(n).is_some() {
                n.to_string()
            } else {
                "electric".to_string()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// SCTK delegate implementations
// ---------------------------------------------------------------------------

impl CompositorHandler for PreviewState {
    fn scale_factor_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        new_factor: i32,
    ) {
        self.scale_factor = new_factor;
        if self.configured {
            if let Some(egl) = &self.egl {
                let egl_ptr = egl as *const EglState;
                self.resize_gl(unsafe { &*egl_ptr });
            }
        }
    }

    fn transform_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_transform: wl_output::Transform,
    ) {
    }

    fn frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _time: u32,
    ) {
    }

    fn surface_enter(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }

    fn surface_leave(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }
}

impl OutputHandler for PreviewState {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }

    fn new_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn update_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn output_destroyed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }
}

impl WindowHandler for PreviewState {
    fn request_close(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _window: &Window) {
        log::info!("preview: window close requested by compositor");
        self.running = false;
    }

    fn configure(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        window: &Window,
        configure: WindowConfigure,
        _serial: u32,
    ) {
        let (new_w, new_h) = configure.new_size;
        // Use compositor suggestion but enforce minimum width for the panel.
        let w = new_w
            .map(|v| v.get())
            .unwrap_or(800)
            .max(PANEL_WIDTH + 400);
        let h = new_h.map(|v| v.get()).unwrap_or(600);

        let was_configured = self.configured;
        self.width = w;
        self.height = h;

        if !was_configured {
            self.configured = true;

            if let Some(egl) = &self.egl {
                let egl_ptr = egl as *const EglState;

                let palette = self
                    .palette_manager
                    .get(&self.active_palette)
                    .cloned()
                    .unwrap_or_default();
                let shader_compiled = self
                    .shader_manager
                    .get_compiled(&self.active_shader)
                    .unwrap_or(crate::shaders::BUILTIN_MANDELBROT)
                    .to_string();

                use wayland_client::Proxy as _;
                let surface_id = window.wl_surface().id();

                if let Err(e) =
                    self.init_gl(unsafe { &*egl_ptr }, surface_id, &shader_compiled, &palette)
                {
                    log::error!("preview: GL init failed: {e:#}");
                } else {
                    log::info!("preview: GL context initialised ({}x{})", w, h);
                }
            }
        } else {
            // Resize existing GL surface.
            if let Some(egl) = &self.egl {
                let egl_ptr = egl as *const EglState;
                self.resize_gl(unsafe { &*egl_ptr });
            }
        }

        // Commit to apply the configure state.
        window.wl_surface().commit();
    }
}

impl SeatHandler for PreviewState {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }

    fn new_seat(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _seat: wl_seat::WlSeat) {}

    fn new_capability(
        &mut self,
        _conn: &Connection,
        qh: &QueueHandle<Self>,
        seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Keyboard && self.keyboard.is_none() {
            match self.seat_state.get_keyboard(qh, &seat, None) {
                Ok(kb) => self.keyboard = Some(kb),
                Err(e) => log::warn!("preview: failed to get keyboard: {e:?}"),
            }
        }
        if capability == Capability::Pointer && self.pointer.is_none() {
            match self.seat_state.get_pointer(qh, &seat) {
                Ok(ptr) => self.pointer = Some(ptr),
                Err(e) => log::warn!("preview: failed to get pointer: {e:?}"),
            }
        }
    }

    fn remove_capability(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Keyboard {
            if let Some(kb) = self.keyboard.take() {
                kb.release();
            }
        }
        if capability == Capability::Pointer {
            if let Some(ptr) = self.pointer.take() {
                ptr.release();
            }
        }
    }

    fn remove_seat(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _seat: wl_seat::WlSeat) {
    }
}

impl KeyboardHandler for PreviewState {
    fn enter(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _keyboard: &wl_keyboard::WlKeyboard,
        _surface: &wl_surface::WlSurface,
        _serial: u32,
        _raw: &[u32],
        _keysyms: &[Keysym],
    ) {
    }

    fn leave(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _keyboard: &wl_keyboard::WlKeyboard,
        _surface: &wl_surface::WlSurface,
        _serial: u32,
    ) {
    }

    fn press_key(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _keyboard: &wl_keyboard::WlKeyboard,
        _serial: u32,
        event: KeyEvent,
    ) {
        // Forward to egui when a text field or widget has keyboard focus.
        let wants_kb = self
            .egui_bundle
            .as_ref()
            .map(|b| b.ctx.wants_keyboard_input())
            .unwrap_or(false);
        if wants_kb {
            if let Some(key) = keysym_to_egui(event.keysym) {
                self.egui_events.push(egui::Event::Key {
                    key,
                    physical_key: None,
                    pressed: true,
                    repeat: false,
                    modifiers: egui::Modifiers::default(),
                });
            }
            if let Some(utf8) = event.utf8 {
                if !utf8.is_empty() && !utf8.chars().any(|c| c.is_control()) {
                    self.egui_events.push(egui::Event::Text(utf8));
                }
            }
        }

        // App-level shortcuts are always active regardless of egui focus.
        match event.keysym {
            Keysym::q | Keysym::Q | Keysym::Escape => {
                log::info!("preview: quit key pressed");
                self.running = false;
            }
            Keysym::r | Keysym::R => {
                log::info!("preview: reload key pressed");
                self.force_reload = true;
            }
            _ => {}
        }
    }

    fn release_key(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _keyboard: &wl_keyboard::WlKeyboard,
        _serial: u32,
        _event: KeyEvent,
    ) {
    }

    fn update_modifiers(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _keyboard: &wl_keyboard::WlKeyboard,
        _serial: u32,
        _modifiers: Modifiers,
        _layout: u32,
    ) {
    }
}

impl PointerHandler for PreviewState {
    fn pointer_frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _pointer: &wl_pointer::WlPointer,
        events: &[PointerEvent],
    ) {
        // Route mouse events to egui only when the cursor is in the panel area.
        let panel_left = self.width as f32 - PANEL_WIDTH as f32;

        for event in events {
            match event.kind {
                PointerEventKind::Motion { .. } => {
                    let (x, y) = event.position;
                    self.cursor_pos = (x as f32, y as f32);
                    if x as f32 >= panel_left {
                        self.egui_events.push(egui::Event::PointerMoved(
                            egui::Pos2::new(x as f32, y as f32),
                        ));
                    } else {
                        // Cursor moved into shader area — let egui know it's gone.
                        self.egui_events.push(egui::Event::PointerGone);
                    }
                }
                PointerEventKind::Press { button, .. } => {
                    if self.cursor_pos.0 >= panel_left {
                        if let Some(btn) = linux_btn_to_egui(button) {
                            self.egui_events.push(egui::Event::PointerButton {
                                pos: egui::Pos2::new(
                                    self.cursor_pos.0,
                                    self.cursor_pos.1,
                                ),
                                button: btn,
                                pressed: true,
                                modifiers: egui::Modifiers::default(),
                            });
                        }
                    }
                }
                PointerEventKind::Release { button, .. } => {
                    if self.cursor_pos.0 >= panel_left {
                        if let Some(btn) = linux_btn_to_egui(button) {
                            self.egui_events.push(egui::Event::PointerButton {
                                pos: egui::Pos2::new(
                                    self.cursor_pos.0,
                                    self.cursor_pos.1,
                                ),
                                button: btn,
                                pressed: false,
                                modifiers: egui::Modifiers::default(),
                            });
                        }
                    }
                }
                PointerEventKind::Leave { .. } => {
                    self.egui_events.push(egui::Event::PointerGone);
                }
                _ => {}
            }
        }
    }
}

impl ProvidesRegistryState for PreviewState {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }
    registry_handlers![OutputState, SeatState];
}

// ---------------------------------------------------------------------------
// egui panel drawing (free function — no access to PreviewState)
// ---------------------------------------------------------------------------

fn draw_panel(
    ctx: &egui::Context,
    state: &mut PreviewPanelState,
    shader_list: &[String],
    palette_list: &[String],
) {
    egui::SidePanel::right("control_panel")
        .exact_width(PANEL_WIDTH as f32)
        .resizable(false)
        .show(ctx, |ui| {
            ui.add_space(8.0);
            ui.heading("hyprsaver");
            ui.add_space(2.0);
            ui.separator();
            ui.add_space(8.0);

            ui.label("Shader");
            egui::ComboBox::from_id_source("shader_combo")
                .width(PANEL_WIDTH as f32 - 24.0)
                .selected_text(&state.selected_shader)
                .show_ui(ui, |ui| {
                    for name in shader_list {
                        ui.selectable_value(
                            &mut state.selected_shader,
                            name.clone(),
                            name,
                        );
                    }
                });

            ui.add_space(6.0);
            ui.label("Palette");
            egui::ComboBox::from_id_source("palette_combo")
                .width(PANEL_WIDTH as f32 - 24.0)
                .selected_text(&state.selected_palette)
                .show_ui(ui, |ui| {
                    for name in palette_list {
                        ui.selectable_value(
                            &mut state.selected_palette,
                            name.clone(),
                            name,
                        );
                    }
                });

            ui.add_space(10.0);
            ui.label(format!("Speed  {:.2}×", state.speed));
            ui.add(
                egui::Slider::new(&mut state.speed, 0.1_f32..=3.0)
                    .step_by(0.05f64)
                    .clamp_to_range(true)
                    .show_value(false),
            );

            ui.add_space(6.0);
            ui.label(format!("Zoom  {:.2}×", state.zoom));
            ui.add(
                egui::Slider::new(&mut state.zoom, 0.1_f32..=3.0)
                    .step_by(0.05f64)
                    .clamp_to_range(true)
                    .show_value(false),
            );

            ui.add_space(14.0);

            let accent = egui::Color32::from_rgb(0x5e, 0x81, 0xf4);
            if ui
                .add(
                    egui::Button::new(
                        egui::RichText::new("▶  Preview")
                            .color(egui::Color32::WHITE),
                    )
                    .fill(accent)
                    .min_size(egui::Vec2::new(PANEL_WIDTH as f32 - 24.0, 32.0)),
                )
                .clicked()
            {
                state.preview_requested = true;
            }

            ui.add_space(8.0);
            if !state.status_message.is_empty() {
                ui.label(
                    egui::RichText::new(&state.status_message)
                        .small()
                        .color(egui::Color32::from_gray(160)),
                );
            }

            ui.add_space(16.0);
            ui.separator();
            ui.add_space(6.0);
            ui.label(egui::RichText::new("Keyboard shortcuts").small().strong());
            ui.label(
                egui::RichText::new("Q / Esc  quit\nR           reload shader")
                    .small()
                    .monospace(),
            );
        });
}

// ---------------------------------------------------------------------------
// Input conversion helpers
// ---------------------------------------------------------------------------

fn keysym_to_egui(sym: Keysym) -> Option<egui::Key> {
    Some(match sym {
        Keysym::Return | Keysym::KP_Enter => egui::Key::Enter,
        Keysym::Tab => egui::Key::Tab,
        Keysym::BackSpace => egui::Key::Backspace,
        Keysym::Delete => egui::Key::Delete,
        Keysym::Escape => egui::Key::Escape,
        Keysym::Home => egui::Key::Home,
        Keysym::End => egui::Key::End,
        Keysym::Page_Up => egui::Key::PageUp,
        Keysym::Page_Down => egui::Key::PageDown,
        Keysym::Left => egui::Key::ArrowLeft,
        Keysym::Right => egui::Key::ArrowRight,
        Keysym::Up => egui::Key::ArrowUp,
        Keysym::Down => egui::Key::ArrowDown,
        _ => return None,
    })
}

fn linux_btn_to_egui(button: u32) -> Option<egui::PointerButton> {
    match button {
        0x110 => Some(egui::PointerButton::Primary),   // BTN_LEFT
        0x111 => Some(egui::PointerButton::Secondary), // BTN_RIGHT
        0x112 => Some(egui::PointerButton::Middle),    // BTN_MIDDLE
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Delegate macros
// ---------------------------------------------------------------------------

delegate_compositor!(PreviewState);
delegate_output!(PreviewState);
delegate_xdg_shell!(PreviewState);
delegate_xdg_window!(PreviewState);
delegate_seat!(PreviewState);
delegate_keyboard!(PreviewState);
delegate_pointer!(PreviewState);
delegate_registry!(PreviewState);
