//! `wayland.rs` — Wayland connection and wlr-layer-shell surface management.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    cycle::{CycleConfig, CycleEvent, CycleManager, CycleOrder},
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

        Ok(Self {
            egl,
            display,
            config,
        })
    }
}

// ---------------------------------------------------------------------------
// FadeState — per-surface fade tracking
// ---------------------------------------------------------------------------

/// Tracks the fade-in / fade-out lifecycle of a single surface.
#[derive(Debug, Clone, Copy)]
pub enum FadeState {
    /// Fading from transparent → opaque. `start` is when the fade began.
    FadingIn { start: Instant },

    /// Fully opaque, normal rendering.
    Active,

    /// Fading from current alpha → transparent.
    /// `start_alpha` captures the alpha at the moment dismiss was triggered
    /// (handles the edge case of dismiss during fade-in).
    FadingOut { start: Instant, start_alpha: f32 },

    /// Fade-out complete. Surface can be destroyed.
    Done,
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

    /// Per-surface fade state for fade-in / fade-out.
    fade_state: FadeState,

    /// Wayland output name (e.g. "DP-1") — used for per-monitor config lookup.
    output_name: Option<String>,

    /// Shader name resolved for this surface (per-monitor override or global).
    shader_name: String,

    /// Palette name resolved for this surface (per-monitor override or global).
    palette_name: String,

    /// Per-output cycle manager. `Some` only in `synced = false` mode.
    cycle_manager: Option<CycleManager>,

    /// Start time of an in-progress palette cross-fade on this surface.
    /// Used in `synced = false` mode; ignored when `synced = true` (global
    /// PaletteManager tracks the transition instead).
    palette_transition_start: Option<Instant>,

    /// Name of the incoming palette for an in-progress cross-fade.
    /// `None` when no transition is active on this surface.
    palette_next_name: Option<String>,
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

    /// Compute the current alpha value based on fade state and config durations.
    /// Also advances the state machine (FadingIn → Active, FadingOut → Done).
    fn update_fade(&mut self, fade_in_ms: u64, fade_out_ms: u64) -> f32 {
        let now = Instant::now();
        match self.fade_state {
            FadeState::FadingIn { start } => {
                if fade_in_ms == 0 {
                    self.fade_state = FadeState::Active;
                    return 1.0;
                }
                let elapsed = now.duration_since(start).as_secs_f32();
                let duration = fade_in_ms as f32 / 1000.0;
                let alpha = (elapsed / duration).clamp(0.0, 1.0);
                if alpha >= 1.0 {
                    self.fade_state = FadeState::Active;
                }
                alpha
            }
            FadeState::Active => 1.0,
            FadeState::FadingOut { start, start_alpha } => {
                if fade_out_ms == 0 {
                    self.fade_state = FadeState::Done;
                    return 0.0;
                }
                let elapsed = now.duration_since(start).as_secs_f32();
                let duration = fade_out_ms as f32 / 1000.0;
                let progress = (elapsed / duration).clamp(0.0, 1.0);
                let alpha = start_alpha * (1.0 - progress);
                if progress >= 1.0 {
                    self.fade_state = FadeState::Done;
                }
                alpha
            }
            FadeState::Done => 0.0,
        }
    }

    /// Begin fade-out from the current alpha level. If already fading out or done, no-op.
    fn begin_fade_out(&mut self, fade_in_ms: u64) {
        let current_alpha = match self.fade_state {
            FadeState::FadingIn { start } => {
                if fade_in_ms == 0 {
                    1.0
                } else {
                    let elapsed = Instant::now().duration_since(start).as_secs_f32();
                    let duration = fade_in_ms as f32 / 1000.0;
                    (elapsed / duration).clamp(0.0, 1.0)
                }
            }
            FadeState::Active => 1.0,
            FadeState::FadingOut { .. } | FadeState::Done => return,
        };
        self.fade_state = FadeState::FadingOut {
            start: Instant::now(),
            start_alpha: current_alpha,
        };
    }

    /// Initialise EGL context + renderer for this surface, using the shared EGL state.
    fn init_gl(
        &mut self,
        egl: &EglState,
        shader_compiled: &str,
        palette: &crate::palette::PaletteEntry,
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
            .make_current(
                egl.display,
                Some(egl_surface),
                Some(egl_surface),
                Some(egl_context),
            )
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
        renderer
            .set_palette(palette)
            .context("initial palette upload failed")?;

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
            let _ = egl
                .egl
                .make_current(egl.display, Some(es), Some(es), Some(ec));
        }
    }

    /// Destroy GL resources for this surface.
    fn destroy_gl(&mut self, egl: &EglState) {
        // Drop renderer first while context is current
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

    /// Set to false when exit is requested (after fade-out completes or immediately
    /// if fade_out_ms == 0).
    pub running: bool,

    /// True while surfaces are fading out (dismiss received, waiting for fade to finish).
    pub fading_out: bool,

    pub config: Config,
    pub shader_manager: ShaderManager,
    pub palette_manager: PaletteManager,

    /// Name of the currently active shader.
    active_shader: String,

    /// Name of the currently active palette.
    active_palette: String,

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

    /// Global CycleManager used in `synced = true` mode.
    /// `None` when neither shader nor palette is cycling, or when `synced = false`.
    global_cycle_manager: Option<CycleManager>,

    /// Whether all monitors cycle in sync (`true`, default) or independently (`false`).
    synced: bool,
}

impl WaylandState {
    /// Select the initial shader, handling "random" and "cycle" modes.
    fn resolve_shader(config: &Config, shader_manager: &ShaderManager) -> String {
        match config.general.shader.as_str() {
            "random" => shader_manager.random().0.to_string(),
            "cycle" => {
                // Start at the randomized cycle index set during ShaderManager init.
                shader_manager
                    .current_cycle_name()
                    .map(str::to_string)
                    .unwrap_or_else(|| "julia".to_string())
            }
            name => {
                if shader_manager.get(name).is_some() {
                    name.to_string()
                } else {
                    // Graceful alias: "flow_field" was renamed to "marble".
                    if name == "flow_field" {
                        log::warn!(
                            "Unknown shader 'flow_field', did you mean 'marble'? \
                             Please update your config. Falling back to 'marble'."
                        );
                        return "marble".to_string();
                    }
                    // Graceful alias: "raymarcher" was renamed to "donut" in v0.3.1.
                    if name == "raymarcher" {
                        log::warn!(
                            "Unknown shader 'raymarcher', did you mean 'donut'? \
                             Falling back to 'donut'."
                        );
                        return "donut".to_string();
                    }
                    // Graceful alias: "aurora_sphere" was renamed to "planet".
                    if name == "aurora_sphere" {
                        log::warn!(
                            "Shader 'aurora_sphere' was renamed to 'planet'. \
                             Please update your config. Falling back to 'planet'."
                        );
                        return "planet".to_string();
                    }
                    // Fallback to first available shader.
                    shader_manager
                        .list()
                        .first()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| "julia".to_string())
                }
            }
        }
    }

    /// Select the initial palette, handling "random" and "cycle" modes.
    fn resolve_palette(config: &Config, palette_manager: &PaletteManager) -> String {
        match config.general.palette.as_str() {
            "random" => palette_manager.random().0.to_string(),
            "cycle" => {
                // Start at the randomized cycle index set during PaletteManager init.
                palette_manager
                    .current_cycle_name()
                    .map(str::to_string)
                    .unwrap_or_else(|| "rainbow".to_string())
            }
            name => {
                if palette_manager.get(name).is_some() {
                    name.to_string()
                } else {
                    "rainbow".to_string()
                }
            }
        }
    }

    /// Initiate screensaver dismissal. If fade_out_ms > 0, starts fade-out on all
    /// surfaces; otherwise exits immediately.
    fn dismiss(&mut self) {
        if self.fading_out {
            return; // Already fading out
        }
        let fade_out_ms = self.config.behavior.fade_out_ms;
        if fade_out_ms == 0 {
            self.running = false;
            return;
        }
        let fade_in_ms = self.config.behavior.fade_in_ms;
        self.fading_out = true;
        for surf in self.surfaces.values_mut() {
            surf.begin_fade_out(fade_in_ms);
        }
        log::info!(
            "Dismiss: starting {fade_out_ms}ms fade-out on {} surfaces",
            self.surfaces.len()
        );
    }

    /// Resolve shader and palette names for a given output, checking per-monitor
    /// config first and falling back to global settings.
    fn resolve_monitor_config(&self, output_name: Option<&str>) -> (String, String) {
        if let Some(name) = output_name {
            if let Some(mc) = self.config.monitors.iter().find(|m| m.name == name) {
                let shader = mc
                    .shader
                    .clone()
                    .unwrap_or_else(|| self.active_shader.clone());
                let palette = mc
                    .palette
                    .clone()
                    .unwrap_or_else(|| self.active_palette.clone());
                log::info!(
                    "Monitor '{name}': shader={shader}, palette={palette} (per-monitor config)"
                );
                return (shader, palette);
            }
        }
        (self.active_shader.clone(), self.active_palette.clone())
    }

    /// Build a [`CycleManager`] for a single output in `synced = false` mode.
    ///
    /// If the output has a per-monitor config that pins the shader or palette to a
    /// fixed name, that slot in the CycleManager gets a single-entry playlist so it
    /// never cycles (the single-entry invariant in [`CycleManager::tick`]).
    fn build_per_output_cycle_manager(
        &self,
        output_name: Option<&str>,
        seed_offset: u64,
    ) -> CycleManager {
        // Determine which shader/palette this output uses.
        let mc = output_name.and_then(|n| self.config.monitors.iter().find(|m| m.name == n));
        let monitor_shader = mc
            .and_then(|m| m.shader.as_deref())
            .unwrap_or(&self.config.general.shader);
        let monitor_palette = mc
            .and_then(|m| m.palette.as_deref())
            .unwrap_or(&self.config.general.palette);

        let shader_pl: Vec<String> = if monitor_shader == "cycle" || monitor_shader == "random" {
            self.shader_manager.effective_playlist()
        } else {
            // Single-entry list → CycleManager never emits a ShaderChange.
            vec![monitor_shader.to_string()]
        };

        let palette_pl: Vec<String> = if monitor_palette == "cycle" || monitor_palette == "random" {
            self.palette_manager.effective_playlist()
        } else {
            vec![monitor_palette.to_string()]
        };

        // Guard against empty playlists (should not happen given the fallback above).
        let shader_pl = if shader_pl.is_empty() {
            vec!["julia".to_string()]
        } else {
            shader_pl
        };
        let palette_pl = if palette_pl.is_empty() {
            vec!["rainbow".to_string()]
        } else {
            palette_pl
        };

        CycleManager::new_with_offset(
            CycleConfig {
                shader_playlist: shader_pl,
                palette_playlist: palette_pl,
                shader_interval: Duration::from_secs(
                    self.config.general.shader_cycle_interval.max(1),
                ),
                palette_interval: Duration::from_secs(
                    self.config.general.palette_cycle_interval.max(1),
                ),
                order: CycleOrder::from_str(&self.config.general.cycle_order),
            },
            seed_offset,
        )
    }

    /// Create a layer surface for the given output and return the Surface.
    fn make_layer_surface(
        compositor: &CompositorState,
        layer_shell: &LayerShell,
        output: Option<&wl_output::WlOutput>,
        qh: &QueueHandle<Self>,
        output_name: Option<String>,
        shader_name: String,
        palette_name: String,
    ) -> Surface {
        let wl_surf = compositor.create_surface(qh);
        let layer_surface = layer_shell.create_layer_surface(
            qh,
            wl_surf.clone(),
            Layer::Overlay,
            Some("hyprsaver"),
            output,
        );
        layer_surface.set_anchor(Anchor::TOP | Anchor::BOTTOM | Anchor::LEFT | Anchor::RIGHT);
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
            fade_state: FadeState::FadingIn {
                start: Instant::now(),
            },
            output_name,
            shader_name,
            palette_name,
            cycle_manager: None,
            palette_transition_start: None,
            palette_next_name: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/// Run the screensaver event loop. Blocks until exit.
pub fn run(
    config: Config,
    mut shader_manager: ShaderManager,
    mut palette_manager: PaletteManager,
    signal_flag: Arc<AtomicBool>,
) -> anyhow::Result<()> {
    let conn = Connection::connect_to_env()
        .context("failed to connect to Wayland display; is WAYLAND_DISPLAY set?")?;

    let (globals, event_queue) =
        registry_queue_init(&conn).context("failed to enumerate Wayland globals")?;
    let qh: QueueHandle<WaylandState> = event_queue.handle();

    let compositor = CompositorState::bind(&globals, &qh).context("wl_compositor not available")?;
    let layer_shell = LayerShell::bind(&globals, &qh)
        .context("zwlr_layer_shell_v1 not available; is a wlr-compatible compositor running?")?;
    let seat_state = SeatState::new(&globals, &qh);
    let output_state = OutputState::new(&globals, &qh);
    let registry_state = RegistryState::new(&globals);

    // Randomize the cycle starting position once at startup so every session
    // begins at a different shader/palette regardless of playlist order.
    if config.general.shader == "cycle" {
        shader_manager.randomize_cycle_start();
    }
    if config.general.palette == "cycle" {
        palette_manager.randomize_cycle_start();
    }

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

    // Warn about monitor config entries that don't match any connected output.
    // We do this after the roundtrip when we have output info available.
    let synced = config.general.synced;

    // Build the global CycleManager used in synced=true mode.
    // In synced=false mode each Surface gets its own CycleManager below.
    let global_cycle_manager: Option<CycleManager> = if synced {
        let shader_cycling = config.general.shader == "cycle";
        let palette_cycling = config.general.palette == "cycle";
        if shader_cycling || palette_cycling {
            // Build the playlists from the managers (which already had set_playlist()
            // called on them in validate_and_apply_playlists()).
            let shader_pl = if shader_cycling {
                shader_manager.effective_playlist()
            } else {
                vec![active_shader.clone()]
            };
            let palette_pl = if palette_cycling {
                palette_manager.effective_playlist()
            } else {
                vec![active_palette.clone()]
            };
            let shader_pl = if shader_pl.is_empty() {
                vec!["julia".to_string()]
            } else {
                shader_pl
            };
            let palette_pl = if palette_pl.is_empty() {
                vec!["rainbow".to_string()]
            } else {
                palette_pl
            };

            Some(CycleManager::new(CycleConfig {
                shader_playlist: shader_pl,
                palette_playlist: palette_pl,
                shader_interval: Duration::from_secs(config.general.shader_cycle_interval.max(1)),
                palette_interval: Duration::from_secs(config.general.palette_cycle_interval.max(1)),
                order: CycleOrder::from_str(&config.general.cycle_order),
            }))
        } else {
            None
        }
    } else {
        None
    };

    let mut state = WaylandState {
        registry_state,
        output_state,
        compositor_state: compositor,
        seat_state,
        layer_shell,
        surfaces: HashMap::new(),
        running: true,
        fading_out: false,
        config,
        shader_manager,
        palette_manager,
        active_shader,
        active_palette,
        egl,
        qh: Some(qh.clone()),
        keyboard: None,
        pointer: None,
        signal_flag,
        global_cycle_manager,
        synced,
    };

    // Initial roundtrip to get outputs.
    let _ = conn.roundtrip();

    // Create one layer surface per known output, resolving per-monitor config.
    {
        let outputs: Vec<wl_output::WlOutput> = state.output_state.outputs().collect();
        for (output_index, output) in outputs.iter().enumerate() {
            let output_name = state
                .output_state
                .info(output)
                .and_then(|info| info.name.clone());

            let (shader_name, palette_name, cycle_manager) = if state.synced {
                let (sn, pn) = state.resolve_monitor_config(output_name.as_deref());
                (sn, pn, None)
            } else {
                let mgr = state
                    .build_per_output_cycle_manager(output_name.as_deref(), output_index as u64);
                let sn = mgr.current_shader().to_string();
                let pn = mgr.current_palette().to_string();
                (sn, pn, Some(mgr))
            };

            let mut surface = WaylandState::make_layer_surface(
                &state.compositor_state,
                &state.layer_shell,
                Some(output),
                &qh,
                output_name,
                shader_name,
                palette_name,
            );
            surface.cycle_manager = cycle_manager;
            state.surfaces.insert(output.clone(), surface);
        }

        // Warn about monitor config entries that don't match any connected output.
        let connected_names: Vec<String> = outputs
            .iter()
            .filter_map(|o| {
                state
                    .output_state
                    .info(o)
                    .and_then(|info| info.name.clone())
            })
            .collect();
        for mc in &state.config.monitors {
            if !connected_names.iter().any(|n| n == &mc.name) {
                log::warn!(
                    "Monitor config for '{}' does not match any connected output; ignoring",
                    mc.name
                );
            }
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

    let mut event_loop: EventLoop<WaylandState> =
        EventLoop::try_new().context("failed to create calloop EventLoop")?;
    let loop_handle = event_loop.handle();

    // Insert Wayland event source.
    WaylandSource::new(conn.clone(), event_queue)
        .insert(loop_handle.clone())
        .map_err(|e| anyhow::anyhow!("failed to insert WaylandSource: {e}"))?;

    // Render timer — fires every frame_ms milliseconds.
    // This also drives cycle advancement via CycleManager::tick() each frame,
    // replacing the old separate calloop cycle timers.
    let render_timer = calloop::timer::Timer::from_duration(Duration::from_millis(frame_ms));
    loop_handle
        .insert_source(render_timer, move |_, _, state: &mut WaylandState| {
            // Check signal flag — trigger fade-out (or immediate exit if duration==0).
            if !state.signal_flag.load(Ordering::Relaxed) && !state.fading_out {
                state.dismiss();
                if !state.running {
                    return calloop::timer::TimeoutAction::Drop;
                }
            }

            // Poll shader hot-reload changes — update any surface using the changed shader.
            let reloaded = state.shader_manager.poll_changes();
            for name in &reloaded {
                if let Some(src) = state.shader_manager.get_compiled(name) {
                    let src = src.to_string();
                    for surf in state.surfaces.values_mut() {
                        if surf.shader_name == *name {
                            if let Some(r) = surf.renderer.as_mut() {
                                if let Err(e) = r.load_shader(&src) {
                                    log::warn!("Hot-reload shader compile error: {e:#}");
                                }
                            }
                        }
                    }
                    log::info!("Hot-reloaded shader '{name}'");
                }
            }

            let now = std::time::Instant::now();

            // --- Cycle advancement (per-frame via CycleManager::tick) ---
            //
            // synced=true:  one global CycleManager; broadcast events to all surfaces.
            // synced=false: each surface has its own CycleManager; tick independently.
            if state.synced {
                let events = if let Some(ref mut mgr) = state.global_cycle_manager {
                    mgr.tick(now)
                } else {
                    vec![]
                };

                let egl_ptr = state.egl.as_ref().map(|e| e as *const EglState);
                for event in events {
                    match event {
                        CycleEvent::ShaderChange(name) => {
                            log::info!("Cycling shader: {name}");
                            let compiled =
                                state.shader_manager.get_compiled(&name).map(str::to_string);
                            if let Some(compiled) = compiled {
                                let old_active = state.active_shader.clone();
                                for surf in state.surfaces.values_mut() {
                                    // Skip surfaces with per-monitor pinned shaders.
                                    if surf.shader_name != old_active {
                                        continue;
                                    }
                                    if let (Some(egl), Some(es), Some(ec)) =
                                        (egl_ptr, surf.egl_surface, surf.egl_context)
                                    {
                                        let egl_ref = unsafe { &*egl };
                                        let _ = egl_ref.egl.make_current(
                                            egl_ref.display,
                                            Some(es),
                                            Some(es),
                                            Some(ec),
                                        );
                                    }
                                    if let Some(r) = surf.renderer.as_mut() {
                                        if let Err(e) = r.load_shader(&compiled) {
                                            log::warn!("Shader cycle compile error: {e:#}");
                                        }
                                    }
                                    surf.shader_name = name.clone();
                                }
                                state.active_shader = name;
                            }
                        }
                        CycleEvent::PaletteChange(name) => {
                            log::info!("Cycling palette: {name}");
                            let entry = state.palette_manager.get(&name).cloned();
                            let td = state.palette_manager.transition_duration;
                            if let Some(entry) = entry {
                                for surf in state.surfaces.values_mut() {
                                    if let (Some(egl), Some(es), Some(ec)) =
                                        (egl_ptr, surf.egl_surface, surf.egl_context)
                                    {
                                        let egl_ref = unsafe { &*egl };
                                        let _ = egl_ref.egl.make_current(
                                            egl_ref.display,
                                            Some(es),
                                            Some(es),
                                            Some(ec),
                                        );
                                    }
                                    if let Some(r) = surf.renderer.as_mut() {
                                        if td <= 0.0 {
                                            r.set_palette(&entry).ok();
                                        } else {
                                            r.begin_transition(&entry).ok();
                                        }
                                    }
                                }
                            }
                            state.palette_manager.begin_transition(&name, now);
                            state.active_palette = name;
                        }
                    }
                }
            } else {
                // synced=false: tick each surface's CycleManager independently.
                // Collect keys first to avoid the borrow-split issue with
                // shader_manager / palette_manager access inside the surface loop.
                let surface_keys: Vec<wl_output::WlOutput> =
                    state.surfaces.keys().cloned().collect();
                let egl_ptr = state.egl.as_ref().map(|e| e as *const EglState);

                for key in &surface_keys {
                    let events = {
                        let Some(surf) = state.surfaces.get_mut(key) else {
                            continue;
                        };
                        let Some(ref mut mgr) = surf.cycle_manager else {
                            continue;
                        };
                        mgr.tick(now)
                    };

                    for event in events {
                        match event {
                            CycleEvent::ShaderChange(shader_name) => {
                                log::info!("Cycling shader on output: {shader_name}");
                                let compiled = state
                                    .shader_manager
                                    .get_compiled(&shader_name)
                                    .map(str::to_string);
                                if let Some(compiled) = compiled {
                                    if let Some(surf) = state.surfaces.get_mut(key) {
                                        if let (Some(egl), Some(es), Some(ec)) =
                                            (egl_ptr, surf.egl_surface, surf.egl_context)
                                        {
                                            let egl_ref = unsafe { &*egl };
                                            let _ = egl_ref.egl.make_current(
                                                egl_ref.display,
                                                Some(es),
                                                Some(es),
                                                Some(ec),
                                            );
                                        }
                                        if let Some(r) = surf.renderer.as_mut() {
                                            if let Err(e) = r.load_shader(&compiled) {
                                                log::warn!("Shader cycle compile error: {e:#}");
                                            }
                                        }
                                        surf.shader_name = shader_name;
                                    }
                                }
                            }
                            CycleEvent::PaletteChange(palette_name) => {
                                log::info!("Cycling palette on output: {palette_name}");
                                let entry = state.palette_manager.get(&palette_name).cloned();
                                let td = state.palette_manager.transition_duration;
                                if let Some(entry) = entry {
                                    if let Some(surf) = state.surfaces.get_mut(key) {
                                        if let (Some(egl), Some(es), Some(ec)) =
                                            (egl_ptr, surf.egl_surface, surf.egl_context)
                                        {
                                            let egl_ref = unsafe { &*egl };
                                            let _ = egl_ref.egl.make_current(
                                                egl_ref.display,
                                                Some(es),
                                                Some(es),
                                                Some(ec),
                                            );
                                        }
                                        if let Some(r) = surf.renderer.as_mut() {
                                            if td <= 0.0 {
                                                r.set_palette(&entry).ok();
                                            } else {
                                                r.begin_transition(&entry).ok();
                                            }
                                        }
                                        if td > 0.0 {
                                            surf.palette_transition_start = Some(now);
                                            surf.palette_next_name = Some(palette_name.clone());
                                        } else {
                                            surf.palette_name = palette_name;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // --- Palette cross-fade transition ---
            //
            // synced=true:  advance the global PaletteManager and propagate its blend to
            //               all renderers (same as before).
            // synced=false: compute per-surface blend from surf.palette_transition_start.
            //               Two-pass approach: pass 1 computes blends and collects
            //               completed names; pass 2 commits the new palette to each
            //               renderer (needed to split the mutable-borrow of surfaces from
            //               the shared-borrow of palette_manager).
            if state.synced {
                let was_transitioning = state.palette_manager.next_palette().is_some();
                let blend = state.palette_manager.advance_transition(now);
                // True only when the transition just completed this frame (next_name was
                // cleared by advance_transition promoting next→current).  On the very first
                // frame of a new transition elapsed=0 so blend=0, but next_name is still
                // set — that must NOT be treated as a completion or we'd call set_palette()
                // prematurely, destroying the lut_texture_b uploaded by begin_transition().
                let just_completed =
                    was_transitioning && state.palette_manager.next_palette().is_none();
                if blend > 0.0 {
                    for surf in state.surfaces.values_mut() {
                        if let Some(r) = surf.renderer.as_mut() {
                            r.set_blend(blend);
                        }
                    }
                } else {
                    for surf in state.surfaces.values_mut() {
                        if let Some(r) = surf.renderer.as_mut() {
                            r.set_blend(0.0);
                        }
                    }
                    if just_completed {
                        if let Some(entry) = state.palette_manager.current_palette().cloned() {
                            let egl_ptr = state.egl.as_ref().map(|e| e as *const EglState);
                            for surf in state.surfaces.values_mut() {
                                if let (Some(egl), Some(es), Some(ec)) =
                                    (egl_ptr, surf.egl_surface, surf.egl_context)
                                {
                                    let egl_ref = unsafe { &*egl };
                                    let _ = egl_ref.egl.make_current(
                                        egl_ref.display,
                                        Some(es),
                                        Some(es),
                                        Some(ec),
                                    );
                                }
                                if let Some(r) = surf.renderer.as_mut() {
                                    r.set_palette(&entry).ok();
                                }
                            }
                        }
                    }
                }
            } else {
                // Per-surface blend.
                let td = state.palette_manager.transition_duration;

                // Pass 1: compute and apply blend; collect names of completed transitions.
                let mut completions: Vec<(wl_output::WlOutput, String)> = Vec::new();
                for (key, surf) in state.surfaces.iter_mut() {
                    let blend = if let Some(start) = surf.palette_transition_start {
                        if td > 0.0 {
                            let elapsed = now.duration_since(start).as_secs_f32();
                            let b = (elapsed / td).clamp(0.0, 1.0);
                            if b >= 1.0 {
                                if let Some(next) = surf.palette_next_name.take() {
                                    surf.palette_transition_start = None;
                                    surf.palette_name = next.clone();
                                    completions.push((key.clone(), next));
                                }
                                0.0
                            } else {
                                b
                            }
                        } else {
                            surf.palette_transition_start = None;
                            0.0
                        }
                    } else {
                        0.0
                    };
                    if let Some(r) = surf.renderer.as_mut() {
                        r.set_blend(blend);
                    }
                }

                // Pass 2: commit the new palette A to each surface that just finished.
                let egl_ptr = state.egl.as_ref().map(|e| e as *const EglState);
                for (key, name) in completions {
                    if let Some(entry) = state.palette_manager.get(&name).cloned() {
                        if let Some(surf) = state.surfaces.get_mut(&key) {
                            if let (Some(egl), Some(es), Some(ec)) =
                                (egl_ptr, surf.egl_surface, surf.egl_context)
                            {
                                let egl_ref = unsafe { &*egl };
                                let _ = egl_ref.egl.make_current(
                                    egl_ref.display,
                                    Some(es),
                                    Some(es),
                                    Some(ec),
                                );
                            }
                            if let Some(r) = surf.renderer.as_mut() {
                                r.set_palette(&entry).ok();
                            }
                        }
                    }
                }
            }

            // Update fade state and render all configured surfaces.
            let fade_in_ms = state.config.behavior.fade_in_ms;
            let fade_out_ms = state.config.behavior.fade_out_ms;

            // SAFETY: egl is only None if init failed; surfaces won't have renderers in that case.
            let egl_ptr = state.egl.as_ref().map(|e| e as *const EglState);
            if let Some(egl_ptr) = egl_ptr {
                let egl = unsafe { &*egl_ptr };
                for surf in state.surfaces.values_mut() {
                    if surf.configured {
                        // Compute and upload alpha for fade in/out.
                        let alpha = surf.update_fade(fade_in_ms, fade_out_ms);
                        if let Some(r) = surf.renderer.as_mut() {
                            r.set_alpha(alpha);
                        }
                        // Skip rendering surfaces that have fully faded out.
                        if !matches!(surf.fade_state, FadeState::Done) {
                            surf.render_frame(egl);
                        }
                    }
                }
            }

            // If fading out, check if all surfaces are done.
            if state.fading_out {
                let all_done = state
                    .surfaces
                    .values()
                    .all(|s| matches!(s.fade_state, FadeState::Done));
                if all_done {
                    log::info!("Fade-out complete on all surfaces");
                    state.running = false;
                    return calloop::timer::TimeoutAction::Drop;
                }
            }

            calloop::timer::TimeoutAction::ToDuration(Duration::from_millis(frame_ms))
        })
        .map_err(|e| anyhow::anyhow!("failed to insert render timer: {e}"))?;

    // Run the event loop until running becomes false.
    log::info!("hyprsaver entering event loop");
    loop {
        event_loop
            .dispatch(Some(Duration::from_millis(frame_ms)), &mut state)
            .context("event loop dispatch error")?;

        // Check signal flag after each dispatch iteration.
        if !state.signal_flag.load(Ordering::Relaxed) && !state.fading_out {
            state.dismiss();
        }

        if !state.running {
            log::info!("Exiting hyprsaver (running=false)");
            break;
        }
    }

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
        let output_name = self
            .output_state
            .info(&output)
            .and_then(|info| info.name.clone());

        let (shader_name, palette_name, cycle_manager) = if self.synced {
            let (sn, pn) = self.resolve_monitor_config(output_name.as_deref());
            (sn, pn, None)
        } else {
            // Use surfaces.len() as a seed offset for any hot-plugged outputs.
            let seed_offset = self.surfaces.len() as u64;
            let mgr = self.build_per_output_cycle_manager(output_name.as_deref(), seed_offset);
            let sn = mgr.current_shader().to_string();
            let pn = mgr.current_palette().to_string();
            (sn, pn, Some(mgr))
        };

        log::info!(
            "New output detected (name={:?}); creating layer surface",
            output_name
        );
        let mut surface = WaylandState::make_layer_surface(
            &self.compositor_state,
            &self.layer_shell,
            Some(&output),
            qh,
            output_name,
            shader_name,
            palette_name,
        );
        surface.cycle_manager = cycle_manager;
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
    fn closed(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _layer: &LayerSurface) {
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
        let surf = self
            .surfaces
            .values_mut()
            .find(|s| &s.layer_surface == layer);
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

            // First configure: initialise EGL + GL using per-surface shader/palette.
            if let Some(egl) = &self.egl {
                let egl_ptr = egl as *const EglState;
                let palette_name = surf.palette_name.clone();
                let shader_name = surf.shader_name.clone();
                let palette = self
                    .palette_manager
                    .get(&palette_name)
                    .cloned()
                    .unwrap_or_default(); // PaletteEntry::default() is cosine rainbow
                let shader_compiled = self
                    .shader_manager
                    .get_compiled(&shader_name)
                    .unwrap_or(crate::shaders::BUILTIN_MANDELBROT)
                    .to_string();

                if let Err(e) = surf.init_gl(unsafe { &*egl_ptr }, &shader_compiled, &palette) {
                    log::error!("Failed to init GL for surface: {e:#}");
                } else {
                    log::info!(
                        "GL context initialised for surface {}x{}",
                        surf.width,
                        surf.height
                    );
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

    fn remove_seat(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _seat: wl_seat::WlSeat) {
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
            self.dismiss();
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
                PointerEventKind::Motion { .. }
                    if self
                        .config
                        .behavior
                        .dismiss_on
                        .contains(&DismissEvent::MouseMove) =>
                {
                    log::info!("Mouse motion detected; dismissing screensaver");
                    self.dismiss();
                    return;
                }
                PointerEventKind::Press { .. }
                    if self
                        .config
                        .behavior
                        .dismiss_on
                        .contains(&DismissEvent::MouseClick) =>
                {
                    log::info!("Mouse button press detected; dismissing screensaver");
                    self.dismiss();
                    return;
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
