//! `preview.rs` — Windowed preview mode using an xdg-toplevel desktop window.
//!
//! Renders the selected shader in a resizable 800×600 window instead of the
//! wlr-layer-shell fullscreen overlay. Intended for shader and palette
//! authoring without triggering the actual screensaver.
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
    delegate_compositor, delegate_keyboard, delegate_output, delegate_registry, delegate_seat,
    delegate_xdg_shell, delegate_xdg_window,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{
        keyboard::{KeyEvent, KeyboardHandler, Keysym, Modifiers},
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
    protocol::{wl_keyboard, wl_output, wl_seat, wl_surface},
    Connection, QueueHandle,
};

use crate::{config::Config, palette::PaletteManager, renderer::Renderer, shaders::ShaderManager};

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
    signal_flag: Arc<AtomicBool>,
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

        let resolution = [self.phys_width() as f32, self.phys_height() as f32];
        self.renderer.as_mut().unwrap().render(resolution);

        if let Err(e) = egl.egl.swap_buffers(egl.display, es) {
            log::warn!("preview: swap_buffers failed: {e:?}");
        }
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
    window.set_min_size(Some((400, 300)));
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
        signal_flag,
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
        // Use compositor suggestion or default to 800×600.
        let w = new_w.map(|v| v.get()).unwrap_or(800);
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

impl ProvidesRegistryState for PreviewState {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }
    registry_handlers![OutputState, SeatState];
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
delegate_registry!(PreviewState);
