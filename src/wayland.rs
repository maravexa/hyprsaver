//! `wayland.rs` — Wayland connection and wlr-layer-shell surface management.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use calloop::EventLoop;
use calloop_wayland_source::WaylandSource;
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState},
    delegate_compositor, delegate_keyboard, delegate_layer, delegate_output, delegate_pointer,
    delegate_registry, delegate_seat,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{
        keyboard::{KeyEvent, KeyboardHandler, Modifiers},
        pointer::{PointerEvent, PointerEventKind, PointerHandler},
        Capability, SeatHandler, SeatState,
    },
    shell::{
        wlr_layer::{
            Anchor, KeyboardInteractivity, Layer, LayerShell, LayerShellHandler, LayerSurface,
            LayerSurfaceConfigure,
        },
        WaylandSurface,
    },
};
use wayland_client::{
    globals::registry_queue_init,
    protocol::{wl_keyboard, wl_output, wl_pointer, wl_seat, wl_surface},
    Connection, QueueHandle,
};

use crate::{
    config::{Config, DismissEvent},
    palette::PaletteManager,
    renderer::Renderer,
    shaders::ShaderManager,
};

// ---------------------------------------------------------------------------
// EGL state (shared across all surfaces)
// ---------------------------------------------------------------------------

/// Holds the EGL instance, display, and chosen config. Shared across all surfaces.
struct EglState {
    egl: khronos_egl::DynamicInstance<khronos_egl::EGL1_4>,
    display: khronos_egl::Display,
    config: khronos_egl::Config,
}

impl EglState {
    /// Initialise EGL from the raw Wayland display pointer.
    fn new(display_ptr: *mut std::ffi::c_void) -> anyhow::Result<Self> {
        // Safety: display_ptr is the wl_display pointer which lives as long as the Connection.
        let egl = unsafe {
            khronos_egl::DynamicInstance::<khronos_egl::EGL1_4>::load_required()
                .context("failed to load libEGL")?
        };

        let display = unsafe { egl.get_display(display_ptr) }
            .ok_or_else(|| anyhow::anyhow!("eglGetDisplay returned EGL_NO_DISPLAY"))?;

        egl.initialize(display).context("eglInitialize failed")?;

        // We need OpenGL ES
        egl.bind_api(khronos_egl::OPENGL_ES_API)
            .context("eglBindAPI(OPENGL_ES_API) failed")?;

        #[rustfmt::skip]
        let attribs = [
            khronos_egl::RED_SIZE,     8,
            khronos_egl::GREEN_SIZE,   8,
            khronos_egl::BLUE_SIZE,    8,
            khronos_egl::ALPHA_SIZE,   8,
            khronos_egl::DEPTH_SIZE,   0,
            khronos_egl::STENCIL_SIZE, 0,
            khronos_egl::SURFACE_TYPE, khronos_egl::WINDOW_BIT,
            khronos_egl::RENDERABLE_TYPE, khronos_egl::OPENGL_ES3_BIT,
            khronos_egl::NONE,
        ];

        let config = egl
            .choose_first_config(display, &attribs)
            .context("eglChooseConfig failed")?
            .ok_or_else(|| anyhow::anyhow!("no suitable EGL config found"))?;

        Ok(Self { egl, display, config })
    }
}

// ---------------------------------------------------------------------------
// Surface — one per monitor
// ---------------------------------------------------------------------------

/// Represents one wlr-layer-shell overlay surface bound to a single Wayland output.
pub struct Surface {
    /// The underlying Wayland surface.
    pub wl_surface: wl_surface::WlSurface,

    /// The layer-shell surface handle.
    pub layer_surface: LayerSurface,

    /// Width in logical pixels (before scale factor).
    pub width: u32,

    /// Height in logical pixels (before scale factor).
    pub height: u32,

    /// Output scale factor (1 = normal, 2 = HiDPI ×2, etc.).
    pub scale_factor: i32,

    /// Whether the surface has been configured by the compositor yet.
    pub configured: bool,

    /// wl_egl_window — must be kept alive as long as the EGL surface exists.
    wl_egl_window: Option<wayland_egl::WlEglSurface>,

    /// EGL surface for this output.
    egl_surface: Option<khronos_egl::Surface>,

    /// EGL context for this output.
    egl_context: Option<khronos_egl::Context>,

    /// OpenGL renderer for this output.
    renderer: Option<Renderer>,
}

impl Surface {
    /// Physical pixel width (logical × scale).
    pub fn phys_width(&self) -> u32 {
        self.width * self.scale_factor.max(1) as u32
    }

    /// Physical pixel height (logical × scale).
    pub fn phys_height(&self) -> u32 {
        self.height * self.scale_factor.max(1) as u32
    }

    /// Initialise EGL context + renderer for this surface, using the shared EGL state.
    fn init_gl(
        &mut self,
        egl: &EglState,
        shader_compiled: &str,
        palette: &crate::palette::Palette,
    ) -> anyhow::Result<()> {
        let w = self.phys_width().max(1) as i32;
        let h = self.phys_height().max(1) as i32;

        // Create the wl_egl_window from the wl_surface id
        use wayland_client::Proxy as _;
        let wl_egl = wayland_egl::WlEglSurface::new(self.wl_surface.id(), w, h)
            .context("failed to create wl_egl_window")?;

        // Create EGL window surface
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
            .make_current(egl.display, Some(egl_surface), Some(egl_surface), Some(egl_context))
            .context("eglMakeCurrent failed")?;

        // Create glow context from EGL proc loader
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
        renderer.set_palette(palette.a, palette.b, palette.c, palette.d);

        self.wl_egl_window = Some(wl_egl);
        self.egl_surface = Some(egl_surface);
        self.egl_context = Some(egl_context);
        self.renderer = Some(renderer);
        Ok(())
    }

    /// Make this surface's EGL context current, render one frame, and swap buffers.
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
            log::warn!("make_current failed during render");
            return;
        }

        let resolution = [self.phys_width() as f32, self.phys_height() as f32];
        self.renderer.as_mut().unwrap().render(resolution);

        if let Err(e) = egl.egl.swap_buffers(egl.display, es) {
            log::warn!("swap_buffers failed: {e:?}");
        }
    }

    /// Resize the EGL surface and wl_egl_window after a configure event.
    fn resize_gl(&mut self, egl: &EglState) {
        let w = self.phys_width().max(1) as i32;
        let h = self.phys_height().max(1) as i32;

        if let Some(ref wew) = self.wl_egl_window {
            wew.resize(w, h, 0, 0);
        }
        // eglSurfaceAttrib for resize is handled by the wl_egl_window resize.
        // Just re-make-current to re-sync the viewport.
        if let (Some(es), Some(ec)) = (self.egl_surface, self.egl_context) {
            let _ = egl.egl.make_current(egl.display, Some(es), Some(es), Some(ec));
        }
    }

    /// Destroy GL resources for this surface.
    fn destroy_gl(&mut self, egl: &EglState) {
        // Drop renderer first while context is current
        if let (Some(es), Some(ec)) = (self.egl_surface, self.egl_context) {
            let _ = egl.egl.make_current(egl.display, Some(es), Some(es), Some(ec));
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
}

// ---------------------------------------------------------------------------
// WaylandState — owns the connection and all protocol objects
// ---------------------------------------------------------------------------

/// Central state object passed into all SCTK delegate implementations.
pub struct WaylandState {
    pub registry_state: RegistryState,
    pub output_state: OutputState,
    pub compositor_state: CompositorState,
    pub seat_state: SeatState,
    pub layer_shell: LayerShell,

    /// Active surfaces, keyed by the `WlOutput` they cover.
    pub surfaces: HashMap<wl_output::WlOutput, Surface>,

    /// Set to true when any dismiss event is received or signal arrives.
    pub running: bool,

    pub config: Config,
    pub shader_manager: ShaderManager,
    pub palette_manager: PaletteManager,

    /// Name of the currently active shader.
    active_shader: String,

    /// Name of the currently active palette.
    active_palette: String,

    /// Shader cycling index (round-robin).
    shader_cycle_index: usize,

    /// EGL state (initialised before the event loop).
    egl: Option<EglState>,

    /// QueueHandle stored so delegates can create layer surfaces for new outputs.
    #[allow(dead_code)]
    qh: Option<QueueHandle<Self>>,

    /// Keyboard object (to release on exit).
    keyboard: Option<wl_keyboard::WlKeyboard>,

    /// Pointer object (to release on exit).
    pointer: Option<wl_pointer::WlPointer>,

    /// Signal flag — set to false by signal handler.
    signal_flag: Arc<AtomicBool>,
}

impl WaylandState {
    /// Select the initial shader, handling "random" and "cycle" modes.
    fn resolve_shader(config: &Config, shader_manager: &ShaderManager) -> String {
        match config.general.shader.as_str() {
            "random" => shader_manager.random().0.to_string(),
            _ => {
                // For "cycle", start with the first shader alphabetically.
                let name = &config.general.shader;
                if shader_manager.get(name).is_some() {
                    name.clone()
                } else {
                    // Fallback to mandelbrot or first available
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

    /// Select the initial palette, handling "random" and "cycle" modes.
    fn resolve_palette(config: &Config, palette_manager: &PaletteManager) -> String {
        match config.general.palette.as_str() {
            "random" => palette_manager.random().0.to_string(),
            name => {
                if palette_manager.get(name).is_some() {
                    name.to_string()
                } else {
                    "electric".to_string()
                }
            }
        }
    }

    /// Create a layer surface for the given output and return the Surface.
    fn make_layer_surface(
        compositor: &CompositorState,
        layer_shell: &LayerShell,
        output: Option<&wl_output::WlOutput>,
        qh: &QueueHandle<Self>,
    ) -> Surface {
        let wl_surf = compositor.create_surface(qh);
        let layer_surface = layer_shell.create_layer_surface(
            qh,
            wl_surf.clone(),
            Layer::Overlay,
            Some("hyprsaver"),
            output,
        );
        layer_surface.set_anchor(
            Anchor::TOP | Anchor::BOTTOM | Anchor::LEFT | Anchor::RIGHT,
        );
        layer_surface.set_exclusive_zone(-1);
        layer_surface.set_keyboard_interactivity(KeyboardInteractivity::Exclusive);
        layer_surface.commit();

        Surface {
            wl_surface: wl_surf,
            layer_surface,
            width: 0,
            height: 0,
            scale_factor: 1,
            configured: false,
            wl_egl_window: None,
            egl_surface: None,
            egl_context: None,
            renderer: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/// Run the screensaver event loop. Blocks until exit.
pub fn run(
    config: Config,
    shader_manager: ShaderManager,
    palette_manager: PaletteManager,
    preview_mode: bool,
    signal_flag: Arc<AtomicBool>,
) -> anyhow::Result<()> {
    if preview_mode {
        log::warn!("Preview mode not yet implemented — launching in screensaver mode");
    }

    let conn = Connection::connect_to_env()
        .context("failed to connect to Wayland display; is WAYLAND_DISPLAY set?")?;

    let (globals, event_queue) = registry_queue_init(&conn)
        .context("failed to enumerate Wayland globals")?;
    let qh: QueueHandle<WaylandState> = event_queue.handle();

    let compositor =
        CompositorState::bind(&globals, &qh).context("wl_compositor not available")?;
    let layer_shell = LayerShell::bind(&globals, &qh).context("zwlr_layer_shell_v1 not available; is a wlr-compatible compositor running?")?;
    let seat_state = SeatState::new(&globals, &qh);
    let output_state = OutputState::new(&globals, &qh);
    let registry_state = RegistryState::new(&globals);

    let active_shader = WaylandState::resolve_shader(&config, &shader_manager);
    let active_palette = WaylandState::resolve_palette(&config, &palette_manager);

    // Initialise EGL using the raw Wayland display pointer.
    let display_ptr = conn.backend().display_ptr() as *mut std::ffi::c_void;
    let egl = match EglState::new(display_ptr) {
        Ok(e) => {
            log::info!("EGL initialised successfully");
            Some(e)
        }
        Err(e) => {
            log::error!("EGL initialisation failed: {e:#}; rendering will be disabled");
            None
        }
    };

    let mut state = WaylandState {
        registry_state,
        output_state,
        compositor_state: compositor,
        seat_state,
        layer_shell,
        surfaces: HashMap::new(),
        running: true,
        config,
        shader_manager,
        palette_manager,
        active_shader,
        active_palette,
        shader_cycle_index: 0,
        egl,
        qh: Some(qh.clone()),
        keyboard: None,
        pointer: None,
        signal_flag,
    };

    // Initial roundtrip to get outputs.
    let _ = conn.roundtrip();

    // Create one layer surface per known output.
    {
        let outputs: Vec<wl_output::WlOutput> =
            state.output_state.outputs().collect();
        for output in outputs {
            let surface = WaylandState::make_layer_surface(
                &state.compositor_state,
                &state.layer_shell,
                Some(&output),
                &qh,
            );
            state.surfaces.insert(output, surface);
        }
        if state.surfaces.is_empty() {
            log::info!(
                "No outputs detected on initial roundtrip; waiting for new_output callbacks"
            );
        }
    }

    // Set up calloop event loop.
    let fps = state.config.general.fps.max(1);
    let frame_ms = 1000u64 / fps as u64;
    let shader_cycle_interval = state.config.general.shader_cycle_interval;
    let shader_cycling = state.config.general.shader == "cycle";

    let mut event_loop: EventLoop<WaylandState> =
        EventLoop::try_new().context("failed to create calloop EventLoop")?;
    let loop_handle = event_loop.handle();

    // Insert Wayland event source.
    WaylandSource::new(conn.clone(), event_queue)
        .insert(loop_handle.clone())
        .map_err(|e| anyhow::anyhow!("failed to insert WaylandSource: {e}"))?;

    // Render timer — fires every frame_ms milliseconds.
    let render_timer = calloop::timer::Timer::from_duration(Duration::from_millis(frame_ms));
    loop_handle
        .insert_source(render_timer, move |_, _, state: &mut WaylandState| {
            // Check signal flag.
            if !state.signal_flag.load(Ordering::Relaxed) {
                state.running = false;
                return calloop::timer::TimeoutAction::Drop;
            }

            // Poll shader hot-reload changes.
            let reloaded = state.shader_manager.poll_changes();
            for name in &reloaded {
                if name == &state.active_shader {
                    if let Some(src) = state.shader_manager.get_compiled(name) {
                        let src = src.to_string();
                        for surf in state.surfaces.values_mut() {
                            if let Some(r) = surf.renderer.as_mut() {
                                if let Err(e) = r.load_shader(&src) {
                                    log::warn!("Hot-reload shader compile error: {e:#}");
                                }
                            }
                        }
                        log::info!("Hot-reloaded active shader '{name}'");
                    }
                }
            }

            // Render all configured surfaces.
            // We need egl ref — take it out temporarily.
            // SAFETY: egl is only None if init failed; surfaces won't have renderers in that case.
            let egl_ptr = state.egl.as_ref().map(|e| e as *const EglState);
            if let Some(egl_ptr) = egl_ptr {
                let egl = unsafe { &*egl_ptr };
                for surf in state.surfaces.values_mut() {
                    if surf.configured {
                        surf.render_frame(egl);
                    }
                }
            }

            calloop::timer::TimeoutAction::ToDuration(Duration::from_millis(frame_ms))
        })
        .map_err(|e| anyhow::anyhow!("failed to insert render timer: {e}"))?;

    // Shader cycling timer (if enabled).
    if shader_cycling {
        let cycle_timer = calloop::timer::Timer::from_duration(Duration::from_secs(
            shader_cycle_interval.max(1),
        ));
        loop_handle
            .insert_source(cycle_timer, move |_, _, state: &mut WaylandState| {
                let names: Vec<String> =
                    state.shader_manager.list().iter().map(|s| s.to_string()).collect();
                if names.is_empty() {
                    return calloop::timer::TimeoutAction::ToDuration(Duration::from_secs(
                        shader_cycle_interval,
                    ));
                }
                state.shader_cycle_index = (state.shader_cycle_index + 1) % names.len();
                let next = names[state.shader_cycle_index].clone();
                log::info!("Cycling to shader '{next}'");
                if let Some(src) = state.shader_manager.get_compiled(&next) {
                    let src = src.to_string();
                    let egl_ptr = state.egl.as_ref().map(|e| e as *const EglState);
                    if let Some(egl_ptr) = egl_ptr {
                        let _egl = unsafe { &*egl_ptr };
                    }
                    for surf in state.surfaces.values_mut() {
                        if let Some(r) = surf.renderer.as_mut() {
                            if let Err(e) = r.load_shader(&src) {
                                log::warn!("Shader cycle compile error: {e:#}");
                            }
                        }
                    }
                    state.active_shader = next;
                }
                calloop::timer::TimeoutAction::ToDuration(Duration::from_secs(
                    shader_cycle_interval,
                ))
            })
            .map_err(|e| anyhow::anyhow!("failed to insert shader cycle timer: {e}"))?;
    }

    // Run the event loop until running becomes false.
    log::info!("hyprsaver entering event loop");
    event_loop
        .run(None, &mut state, |state| {
            // Check signal flag each iteration.
            if !state.signal_flag.load(Ordering::Relaxed) {
                state.running = false;
            }
        })
        .context("event loop error")?;

    // Cleanup: destroy GL resources before dropping everything.
    if let Some(egl) = &state.egl {
        for surf in state.surfaces.values_mut() {
            surf.destroy_gl(egl);
        }
        egl.egl.terminate(egl.display).ok();
    }

    log::info!("Wayland event loop exited");
    Ok(())
}

// ---------------------------------------------------------------------------
// SCTK delegate impls
// ---------------------------------------------------------------------------

impl CompositorHandler for WaylandState {
    fn scale_factor_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        surface: &wl_surface::WlSurface,
        new_factor: i32,
    ) {
        for surf in self.surfaces.values_mut() {
            if &surf.wl_surface == surface {
                surf.scale_factor = new_factor;
                // If already configured, resize GL surface.
                if surf.configured {
                    if let Some(egl) = &self.egl {
                        // Safety: egl lives as long as WaylandState
                        let egl_ptr = egl as *const EglState;
                        surf.resize_gl(unsafe { &*egl_ptr });
                    }
                }
                break;
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
        // Frame callbacks are handled in the render loop, not here.
        // TODO: switch to frame callbacks for better compositor integration.
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

impl OutputHandler for WaylandState {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }

    fn new_output(
        &mut self,
        _conn: &Connection,
        qh: &QueueHandle<Self>,
        output: wl_output::WlOutput,
    ) {
        log::info!("New output detected; creating layer surface");
        let surface = WaylandState::make_layer_surface(
            &self.compositor_state,
            &self.layer_shell,
            Some(&output),
            qh,
        );
        self.surfaces.insert(output, surface);
    }

    fn update_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
        // Handled via configure events.
    }

    fn output_destroyed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        output: wl_output::WlOutput,
    ) {
        if let Some(mut surf) = self.surfaces.remove(&output) {
            if let Some(egl) = &self.egl {
                let egl_ptr = egl as *const EglState;
                surf.destroy_gl(unsafe { &*egl_ptr });
            }
            log::info!("Output removed; surface destroyed");
        }
    }
}

impl LayerShellHandler for WaylandState {
    fn closed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _layer: &LayerSurface,
    ) {
        log::info!("Layer surface closed by compositor");
        self.running = false;
    }

    fn configure(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        layer: &LayerSurface,
        configure: LayerSurfaceConfigure,
        _serial: u32,
    ) {
        // Find the matching surface.
        let surf = self.surfaces.values_mut().find(|s| &s.layer_surface == layer);
        let Some(surf) = surf else { return };

        let (new_w, new_h) = configure.new_size;
        let was_configured = surf.configured;

        if new_w > 0 {
            surf.width = new_w;
        }
        if new_h > 0 {
            surf.height = new_h;
        }

        if !was_configured {
            surf.configured = true;

            // First configure: initialise EGL + GL.
            if let Some(egl) = &self.egl {
                let egl_ptr = egl as *const EglState;
                let palette_name = self.active_palette.clone();
                let shader_name = self.active_shader.clone();
                let palette = self
                    .palette_manager
                    .get(&palette_name)
                    .cloned()
                    .unwrap_or_default();
                let shader_compiled = self
                    .shader_manager
                    .get_compiled(&shader_name)
                    .unwrap_or(crate::shaders::BUILTIN_MANDELBROT)
                    .to_string();

                if let Err(e) = surf.init_gl(unsafe { &*egl_ptr }, &shader_compiled, &palette) {
                    log::error!("Failed to init GL for surface: {e:#}");
                } else {
                    log::info!("GL context initialised for surface {}x{}", surf.width, surf.height);
                }
            }
        } else {
            // Subsequent configure: resize.
            if let Some(egl) = &self.egl {
                let egl_ptr = egl as *const EglState;
                surf.resize_gl(unsafe { &*egl_ptr });
            }
        }

        // Ack the configure.
        surf.layer_surface.commit();
    }
}

impl SeatHandler for WaylandState {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }

    fn new_seat(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _seat: wl_seat::WlSeat,
    ) {
    }

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
                Err(e) => log::warn!("Failed to get keyboard: {e:?}"),
            }
        }
        if capability == Capability::Pointer && self.pointer.is_none() {
            match self.seat_state.get_pointer(qh, &seat) {
                Ok(ptr) => self.pointer = Some(ptr),
                Err(e) => log::warn!("Failed to get pointer: {e:?}"),
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

    fn remove_seat(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _seat: wl_seat::WlSeat,
    ) {
    }
}

impl KeyboardHandler for WaylandState {
    fn enter(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _keyboard: &wl_keyboard::WlKeyboard,
        _surface: &wl_surface::WlSurface,
        _serial: u32,
        _raw: &[u32],
        _keysyms: &[smithay_client_toolkit::seat::keyboard::Keysym],
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
        _event: KeyEvent,
    ) {
        if self.config.behavior.dismiss_on.contains(&DismissEvent::Key) {
            log::info!("Key press detected; dismissing screensaver");
            self.running = false;
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

impl PointerHandler for WaylandState {
    fn pointer_frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _pointer: &wl_pointer::WlPointer,
        events: &[PointerEvent],
    ) {
        for event in events {
            match event.kind {
                PointerEventKind::Motion { .. } => {
                    if self.config.behavior.dismiss_on.contains(&DismissEvent::MouseMove) {
                        log::info!("Mouse motion detected; dismissing screensaver");
                        self.running = false;
                        return;
                    }
                }
                PointerEventKind::Press { .. } => {
                    if self.config.behavior.dismiss_on.contains(&DismissEvent::MouseClick) {
                        log::info!("Mouse button press detected; dismissing screensaver");
                        self.running = false;
                        return;
                    }
                }
                _ => {}
            }
        }
    }
}

impl ProvidesRegistryState for WaylandState {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }
    registry_handlers![OutputState, SeatState];
}

// calloop event loop needs WaylandState to be the data type
// for the calloop loop; we stop it by setting running = false and checking in the
// post-dispatch callback.  calloop 0.13 doesn't have a built-in "stop" mechanism
// so we rely on the loop callback below.

delegate_compositor!(WaylandState);
delegate_output!(WaylandState);
delegate_layer!(WaylandState);
delegate_seat!(WaylandState);
delegate_keyboard!(WaylandState);
delegate_pointer!(WaylandState);
delegate_registry!(WaylandState);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    /// Test the fps-to-interval helper logic used in the run() function.
    #[test]
    fn test_fps_to_interval() {
        fn fps_to_ms(fps: u32) -> u64 {
            1000u64 / fps.max(1) as u64
        }
        assert_eq!(fps_to_ms(30), 33);
        assert_eq!(fps_to_ms(60), 16);
        assert_eq!(fps_to_ms(1), 1000);
    }

    /// shader_cycle_index wraps correctly
    #[test]
    fn test_shader_cycle_index_wrap() {
        let num_shaders = 5usize;
        let mut idx = 4usize;
        idx = (idx + 1) % num_shaders;
        assert_eq!(idx, 0);
    }
}
