//! `preview.rs` — Windowed preview mode with egui control panel.
//!
//! Renders the selected shader in a resizable window split into two regions:
//! - Left: shader viewport (fullscreen sans panel)
//! - Right: 300-px egui control panel with collapsible sections (Shader, Palette,
//!   Display) and shader preview thumbnails.
//!
//! The panel auto-collapses for windows narrower than 640px, or can be toggled
//! with the F key. A ☰ button restores it when collapsed.
//!
//! Keyboard shortcuts (the window must have keyboard focus):
//!   Space      — pause/resume animation
//!   ←/→        — previous/next shader
//!   ↑/↓        — previous/next palette
//!   R          — reset u_time to 0.0
//!   F          — toggle fullscreen (hide/show panel)
//!   T          — test shader crossfade transition
//!   Q / Escape — quit

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Context as _;
use calloop::EventLoop;
use calloop_wayland_source::WaylandSource;
use glow::HasContext as _;
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

use crate::{
    config::Config,
    palette::{Palette, PaletteEntry, PaletteManager},
    renderer::Renderer,
    shaders::ShaderManager,
};

// Width of the right-side egui control panel in logical pixels.
const PANEL_WIDTH: u32 = 300;

/// Below this window width (logical pixels) the panel collapses to an overlay.
const PANEL_COLLAPSE_THRESHOLD: u32 = 640;

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

/// Which tab is shown in the right-side control panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewTab {
    Preview,
    Playlists,
    PaletteEditor,
}

/// Sentinel name used in the palette editor's dropdown to represent the
/// "create a new palette" option.
const NEW_PALETTE_SENTINEL: &str = "— New Palette —";

/// Which sub-tab is active inside the Playlists tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlaylistSubTab {
    Shaders,
    Palettes,
}

/// All state for the Playlists editor tab.
struct PlaylistEditorState {
    // Which sub-tab is currently visible.
    active_subtab: PlaylistSubTab,

    // Shader playlist
    shader_playlist_name: String,
    shader_items: Vec<String>,
    selected_shader_idx: Option<usize>,
    add_shader_selected: String,
    shader_drag_src: Option<usize>,
    shader_drag_tgt: Option<usize>,

    // Palette playlist
    palette_playlist_name: String,
    palette_items: Vec<String>,
    selected_palette_idx: Option<usize>,
    add_palette_selected: String,
    palette_drag_src: Option<usize>,
    palette_drag_tgt: Option<usize>,

    // Interval controls (seconds)
    shader_interval: u64,
    palette_interval: u64,

    // true = random, false = sequential
    cycle_order_random: bool,

    // Action flags (set by UI buttons, consumed by render_panel)
    save_requested: bool,
    apply_requested: bool,

    // Status message shown beneath the action buttons
    save_status: String,
}

/// All state for the Palette Editor tab.
///
/// Only cosine palettes are editable here — LUT palettes are out of scope for
/// this editor. Slider changes update `current` and flip `dirty`, which the
/// render loop consumes on each frame to push new vec3 uniforms to the GPU
/// without recompiling the shader.
struct PaletteEditorState {
    /// Name of the palette currently being edited. Either an existing cosine
    /// palette name, or [`NEW_PALETTE_SENTINEL`] while building a new one.
    selected_name: String,
    /// When the selector dropdown is on [`NEW_PALETTE_SENTINEL`], the text
    /// the user is typing into the "Palette name" field.
    new_name: String,
    /// The palette currently baked into the sliders. Edited live.
    current: Palette,
    /// The palette as it was when loaded. The Reset button restores this.
    original: Palette,
    /// Set to `true` on any slider change. The render loop clears this and
    /// uploads the new uniforms on the next frame — no shader recompile.
    dirty: bool,
    /// Set by the "Save Palette" button, consumed by `render_panel`.
    save_requested: bool,
    /// Set by the "Reset" button, consumed inline.
    reset_requested: bool,
    /// Status message shown beneath the action buttons.
    save_status: String,
}

impl PaletteEditorState {
    /// Build an initial editor state from a palette manager, preferring to
    /// edit `preferred_name` if it exists and is a cosine palette. Falls back
    /// to the first cosine palette found, or the default palette if the
    /// manager contains only LUTs.
    fn from_manager(pm: &PaletteManager, preferred_name: &str) -> Self {
        // Try the requested name first.
        if let Some(PaletteEntry::Cosine(p)) = pm.get(preferred_name) {
            return Self::with_palette(preferred_name.to_string(), p.clone());
        }
        // Fall back to the first cosine palette in the sorted list.
        for name in pm.list() {
            if let Some(PaletteEntry::Cosine(p)) = pm.get(name) {
                return Self::with_palette(name.to_string(), p.clone());
            }
        }
        // No cosine palettes available — start fresh.
        Self::with_palette(NEW_PALETTE_SENTINEL.to_string(), Palette::default())
    }

    fn with_palette(name: String, palette: Palette) -> Self {
        Self {
            selected_name: name,
            new_name: String::new(),
            current: palette.clone(),
            original: palette,
            dirty: false,
            save_requested: false,
            reset_requested: false,
            save_status: String::new(),
        }
    }
}

/// Persistent UI state for the right-side egui control panel.
struct PreviewPanelState {
    selected_shader: String,
    selected_palette: String,
    speed: f32,
    zoom: f32,
    status_message: String,
    /// Set to true by the ▶ Preview button; cleared after applying changes.
    preview_requested: bool,
    /// Which tab is currently shown.
    active_tab: PreviewTab,
    /// State for the Playlists editor tab.
    playlist_editor: PlaylistEditorState,
    /// State for the Palette Editor tab.
    palette_editor: PaletteEditorState,
    /// Set by the "Save Config" button on the Preview tab.
    save_config_requested: bool,
    /// While `Some(t)` and `Instant::now() < t`, the Preview tab shows a
    /// transient "Saved ✓" toast. Cleared once the instant has passed.
    save_config_toast_until: Option<Instant>,
    /// Set by the "⟳ Test Transition" button on the Preview tab.
    test_transition_requested: bool,
    /// Names of cosine palettes the user saved via the Palette Editor tab
    /// during this session. Re-written to `[palettes.<name>]` by
    /// "Save Config" so the whole config file stays in sync.
    session_created_palettes: Vec<String>,

    /// Whether the panel is collapsed (narrow window or F key toggle).
    panel_collapsed: bool,
    /// Whether the user explicitly toggled fullscreen (F key). When true,
    /// panel stays hidden regardless of window width.
    fullscreen_mode: bool,
    /// Whether to show the FPS counter overlay.
    show_fps: bool,
    /// Palette cross-fade transition duration in seconds.
    palette_transition_speed: f32,
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

    /// Animation is paused (Space key). When true, u_time stops advancing.
    paused: bool,
    /// Accumulated shader time when paused. Used so pause/resume doesn't jump.
    pause_time_offset: f32,
    /// Instant when the animation was last unpaused.
    unpause_instant: Instant,

    // FPS tracking
    fps_frame_count: u32,
    fps_last_sample: Instant,
    fps_display: f32,

    /// Cached 64×64 shader thumbnails keyed by shader name. Regenerated when
    /// palette changes. Values are RGBA8 pixel data (64*64*4 bytes).
    thumbnail_pixels: std::collections::HashMap<String, Vec<u8>>,
    /// egui texture handles for thumbnails, uploaded lazily.
    thumbnail_textures: std::collections::HashMap<String, egui::TextureHandle>,
    /// The palette name thumbnails were last generated for. If the active
    /// palette changes, thumbnails are regenerated.
    thumbnails_palette: String,
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

        let playlist_editor = self.make_playlist_editor_state();
        let palette_editor =
            PaletteEditorState::from_manager(&self.palette_manager, &self.active_palette);
        match egui_glow::Painter::new(Arc::clone(&gl_arc), "", None, false) {
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
                        active_tab: PreviewTab::Preview,
                        playlist_editor,
                        palette_editor,
                        save_config_requested: false,
                        save_config_toast_until: None,
                        test_transition_requested: false,
                        session_created_palettes: Vec::new(),
                        panel_collapsed: false,
                        fullscreen_mode: false,
                        show_fps: true,
                        palette_transition_speed: self.config.general.palette_transition_duration,
                    },
                });
            }
            Err(e) => {
                log::warn!("preview: egui_glow::Painter::new failed: {e}; panel disabled");
            }
        }

        Ok(())
    }

    /// Build the initial `PlaylistEditorState` from the loaded config.
    fn make_playlist_editor_state(&self) -> PlaylistEditorState {
        let shader_pl_name = &self.config.general.shader_playlist;
        let shader_items = self
            .config
            .playlists
            .get(shader_pl_name)
            .map(|pl| pl.shaders.clone())
            .or_else(|| {
                self.config
                    .shader_playlists
                    .get(shader_pl_name)
                    .map(|pl| pl.shaders.clone())
            })
            .unwrap_or_default();

        let palette_pl_name = &self.config.general.palette_playlist;
        let palette_items = self
            .config
            .playlists
            .get(palette_pl_name)
            .map(|pl| pl.palettes.clone())
            .or_else(|| {
                self.config
                    .palette_playlists
                    .get(palette_pl_name)
                    .map(|pl| pl.palettes.clone())
            })
            .unwrap_or_default();

        PlaylistEditorState {
            active_subtab: PlaylistSubTab::Shaders,

            shader_playlist_name: self.config.general.shader_playlist.clone(),
            shader_items,
            selected_shader_idx: None,
            add_shader_selected: String::new(),
            shader_drag_src: None,
            shader_drag_tgt: None,

            palette_playlist_name: self.config.general.palette_playlist.clone(),
            palette_items,
            selected_palette_idx: None,
            add_palette_selected: String::new(),
            palette_drag_src: None,
            palette_drag_tgt: None,

            shader_interval: self.config.general.shader_cycle_interval,
            palette_interval: self.config.general.palette_cycle_interval,
            cycle_order_random: self.config.general.cycle_order != "sequential",

            save_requested: false,
            apply_requested: false,
            save_status: String::new(),
        }
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

        // FPS tracking
        self.fps_frame_count += 1;
        let now = Instant::now();
        let dt = now.duration_since(self.fps_last_sample).as_secs_f32();
        if dt >= 1.0 {
            self.fps_display = self.fps_frame_count as f32 / dt;
            self.fps_frame_count = 0;
            self.fps_last_sample = now;
        }

        let phys_w = self.phys_width();
        let phys_h = self.phys_height();
        let scale = self.scale_factor.max(1) as u32;

        // Determine if panel should be shown based on collapse state.
        let panel_visible = !self
            .egui_bundle
            .as_ref()
            .map(|b| b.state.panel_collapsed || b.state.fullscreen_mode)
            .unwrap_or(false);

        // Auto-collapse for narrow windows (unless user explicitly toggled fullscreen).
        if let Some(ref mut bundle) = self.egui_bundle {
            if !bundle.state.fullscreen_mode {
                bundle.state.panel_collapsed = self.width < PANEL_COLLAPSE_THRESHOLD;
            }
        }

        let panel_w_phys = if panel_visible {
            PANEL_WIDTH * scale
        } else {
            0
        };
        let shader_w_phys = phys_w.saturating_sub(panel_w_phys).max(1);

        // Render shader in the left portion (or full window when panel hidden).
        self.renderer
            .as_mut()
            .unwrap()
            .render([shader_w_phys as f32, phys_h as f32]);

        // Drain accumulated egui input events, then paint the control panel + overlays.
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

        bundle.ctx.set_pixels_per_point(scale);

        let raw_input = egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::Vec2::new(logical_w, logical_h),
            )),
            events,
            ..Default::default()
        };

        let mut shader_list: Vec<String> = self
            .shader_manager
            .list()
            .iter()
            .map(|s| s.to_string())
            .collect();
        shader_list.sort();
        let mut palette_list: Vec<String> = self
            .palette_manager
            .list()
            .iter()
            .map(|p| p.to_string())
            .collect();
        palette_list.sort();

        // Cosine-only map for the palette editor dropdown — LUT palettes are
        // intentionally excluded because the editor only operates on the 12
        // cosine parameters. The list is sorted; the map is the source of
        // truth when the user picks a different palette to load into the
        // sliders.
        let mut cosine_palettes: std::collections::BTreeMap<String, Palette> =
            std::collections::BTreeMap::new();
        for name in self.palette_manager.list() {
            if let Some(PaletteEntry::Cosine(p)) = self.palette_manager.get(name) {
                cosine_palettes.insert(name.to_string(), p.clone());
            }
        }

        let fps_val = self.fps_display;
        let is_paused = self.paused;
        let thumbnail_textures = &mut self.thumbnail_textures;

        let full_output = bundle.ctx.run(raw_input, |ctx| {
            let panel_hidden = bundle.state.panel_collapsed || bundle.state.fullscreen_mode;

            if !panel_hidden {
                draw_panel(
                    ctx,
                    &mut bundle.state,
                    &shader_list,
                    &palette_list,
                    &cosine_palettes,
                    thumbnail_textures,
                );
            }

            // ☰ hamburger button — shown when panel is collapsed/hidden
            if panel_hidden {
                egui::Area::new(egui::Id::new("hamburger_btn"))
                    .fixed_pos(egui::Pos2::new(logical_w - 40.0, 8.0))
                    .show(ctx, |ui| {
                        if ui
                            .add(
                                egui::Button::new(
                                    egui::RichText::new("☰")
                                        .size(20.0)
                                        .color(egui::Color32::WHITE),
                                )
                                .fill(egui::Color32::from_rgba_unmultiplied(30, 30, 40, 180)),
                            )
                            .clicked()
                        {
                            bundle.state.panel_collapsed = false;
                            bundle.state.fullscreen_mode = false;
                        }
                    });
            }

            // FPS counter — bottom-left of render area
            if bundle.state.show_fps {
                let fps_text = if is_paused {
                    format!("{:.0} FPS (paused)", fps_val)
                } else {
                    format!("{:.0} FPS", fps_val)
                };
                egui::Area::new(egui::Id::new("fps_counter"))
                    .fixed_pos(egui::Pos2::new(8.0, logical_h - 24.0))
                    .show(ctx, |ui| {
                        ui.label(
                            egui::RichText::new(fps_text)
                                .size(12.0)
                                .color(egui::Color32::from_rgba_unmultiplied(200, 200, 200, 160))
                                .monospace(),
                        );
                    });
            }
        });

        let clipped = bundle.ctx.tessellate(full_output.shapes, scale);

        // Reset the GL viewport to the full window before egui paints.
        unsafe {
            (*bundle.gl_arc).viewport(0, 0, phys_w as i32, phys_h as i32);
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
                            bundle.state.status_message = format!("Loaded '{sel_shader}'");
                            log::info!("panel: shader → '{sel_shader}'");
                        }
                        Err(e) => {
                            bundle.state.status_message = "Compile error (see log)".to_string();
                            log::warn!("panel: compile error for '{sel_shader}': {e:#}");
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

        // Handle "Save Playlist" button — write config to disk.
        if bundle.state.playlist_editor.save_requested {
            bundle.state.playlist_editor.save_requested = false;
            let ed = &bundle.state.playlist_editor;
            match save_playlist_config(
                &ed.shader_playlist_name,
                &ed.palette_playlist_name,
                &ed.shader_items,
                &ed.palette_items,
                ed.shader_interval,
                ed.palette_interval,
                ed.cycle_order_random,
            ) {
                Ok(path) => {
                    bundle.state.playlist_editor.save_status = format!("Saved to {path}");
                    log::info!("preview: playlist saved to {path}");
                }
                Err(e) => {
                    bundle.state.playlist_editor.save_status = format!("Error: {e}");
                    log::warn!("preview: playlist save error: {e}");
                }
            }
        }

        // Handle "Apply & Restart Cycle" — push playlist into the live managers.
        if bundle.state.playlist_editor.apply_requested {
            bundle.state.playlist_editor.apply_requested = false;
            let shader_items = bundle.state.playlist_editor.shader_items.clone();
            let palette_items = bundle.state.playlist_editor.palette_items.clone();
            self.shader_manager.set_playlist(shader_items);
            self.palette_manager.set_playlist(palette_items);
            self.config.general.shader_cycle_interval =
                bundle.state.playlist_editor.shader_interval;
            self.config.general.palette_cycle_interval =
                bundle.state.playlist_editor.palette_interval;
            self.config.general.cycle_order = if bundle.state.playlist_editor.cycle_order_random {
                "random".to_string()
            } else {
                "sequential".to_string()
            };
            bundle.state.playlist_editor.save_status =
                "Applied! Cycle manager updated.".to_string();
            log::info!("preview: playlist applied and cycle restarted");
        }

        // ── Palette editor: Reset button ──────────────────────────────
        if bundle.state.palette_editor.reset_requested {
            bundle.state.palette_editor.reset_requested = false;
            let original = bundle.state.palette_editor.original.clone();
            bundle.state.palette_editor.current = original;
            bundle.state.palette_editor.dirty = true;
            bundle.state.palette_editor.save_status = "Reset to loaded values.".to_string();
        }

        // ── Palette editor: live uniform update ───────────────────────
        // Slider drags flip `dirty`. Consume it and push the 12 cosine
        // params straight into the renderer via `set_palette`. This is a
        // pure uniform upload — no shader recompile, no texture work for
        // cosine palettes. See the `PaletteEditorState` doc comment.
        if bundle.state.palette_editor.dirty {
            bundle.state.palette_editor.dirty = false;
            let p = bundle.state.palette_editor.current.clone();
            if let Some(r) = self.renderer.as_mut() {
                if let Err(e) = r.set_palette(&PaletteEntry::Cosine(p)) {
                    log::warn!("preview: live palette uniform upload failed: {e:#}");
                }
            }
        }

        // ── Palette editor: Save button ───────────────────────────────
        if bundle.state.palette_editor.save_requested {
            bundle.state.palette_editor.save_requested = false;
            let ed = &bundle.state.palette_editor;
            let name = if ed.selected_name == NEW_PALETTE_SENTINEL {
                ed.new_name.trim().to_string()
            } else {
                ed.selected_name.clone()
            };
            if name.is_empty() {
                bundle.state.palette_editor.save_status = "Enter a name before saving.".to_string();
            } else {
                let palette_to_save = ed.current.clone();
                match save_palette_config(&name, &palette_to_save) {
                    Ok(path) => {
                        // Make the new palette visible for the rest of the
                        // session — without this the user would need to
                        // restart to see it in any palette dropdown.
                        self.palette_manager
                            .insert_cosine(name.clone(), palette_to_save.clone());
                        // Snap "original" to the just-saved values so a
                        // subsequent Reset doesn't revert the save.
                        bundle.state.palette_editor.original = palette_to_save;
                        bundle.state.palette_editor.selected_name = name.clone();
                        bundle.state.palette_editor.new_name.clear();
                        bundle.state.palette_editor.save_status = format!("Saved to {path}");
                        // Track for the Save Config merge so Tab 1 can
                        // re-emit this palette into `[palettes.<name>]`.
                        if !bundle.state.session_created_palettes.contains(&name) {
                            bundle.state.session_created_palettes.push(name.clone());
                        }
                        log::info!("preview: palette '{name}' saved to {path}");
                    }
                    Err(e) => {
                        bundle.state.palette_editor.save_status = format!("Error: {e}");
                        log::warn!("preview: palette save error: {e}");
                    }
                }
            }
        }

        // ── Preview tab: "⟳ Test Transition" button ───────────────────
        // Pick a random shader different from the one currently displayed,
        // compile it, and start a 2-second crossfade via the transition
        // renderer. On any failure, log and leave the current shader as-is.
        if bundle.state.test_transition_requested {
            bundle.state.test_transition_requested = false;
            let mut shader_list: Vec<String> = self
                .shader_manager
                .list()
                .iter()
                .map(|s| s.to_string())
                .collect();
            shader_list.sort();
            let candidates: Vec<String> = shader_list
                .into_iter()
                .filter(|s| *s != self.active_shader)
                .collect();
            if candidates.is_empty() {
                log::warn!("preview: no alternate shader available for transition");
                bundle.state.status_message = "No other shader to transition to".to_string();
            } else {
                // Same nanos-mod-count PRNG the ShaderManager uses.
                let idx = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .subsec_nanos() as usize
                    % candidates.len();
                let next_name = candidates[idx].clone();
                if let Some(src) = self.shader_manager.get_compiled(&next_name) {
                    let src = src.to_string();
                    if let Some(r) = self.renderer.as_mut() {
                        match r.start_shader_transition(&src, Some(2.0)) {
                            Ok(()) => {
                                log::info!(
                                    "preview: test transition {} → {}",
                                    self.active_shader,
                                    next_name
                                );
                                self.active_shader = next_name.clone();
                                bundle.state.selected_shader = next_name.clone();
                                bundle.state.status_message =
                                    format!("Transitioning to '{next_name}'");
                                if let Some(win) = &self.window {
                                    win.set_title(format!("hyprsaver preview — {next_name}"));
                                }
                            }
                            Err(e) => {
                                log::warn!("preview: test transition failed: {e:#}");
                                bundle.state.status_message =
                                    "Transition compile error (see log)".to_string();
                            }
                        }
                    }
                } else {
                    log::warn!("preview: compiled source missing for '{next_name}'");
                }
            }
        }

        // ── Preview tab: "Save Config" button ─────────────────────────
        // Merge the current preview state (active shader/palette, slider
        // values, any edited playlists, any palettes saved this session)
        // into `~/.config/hypr/hyprsaver.toml` and write it back. On
        // success, trigger a 2-second "Saved ✓" toast.
        if bundle.state.save_config_requested {
            bundle.state.save_config_requested = false;

            // Collect session-created cosine palettes from the live manager.
            // Names are tracked in `session_created_palettes` — we look up
            // the current values from the manager each time so the saved
            // data reflects post-edit state (not a stale snapshot).
            let session_palettes: Vec<(String, Palette)> = bundle
                .state
                .session_created_palettes
                .iter()
                .filter_map(|name| match self.palette_manager.get(name) {
                    Some(PaletteEntry::Cosine(p)) => Some((name.clone(), p.clone())),
                    _ => None,
                })
                .collect();

            let ed = &bundle.state.playlist_editor;
            let result = save_preview_config(
                &self.active_shader,
                &self.active_palette,
                bundle.state.speed,
                bundle.state.zoom,
                &ed.shader_playlist_name,
                &ed.palette_playlist_name,
                &ed.shader_items,
                &ed.palette_items,
                ed.shader_interval,
                ed.palette_interval,
                ed.cycle_order_random,
                &session_palettes,
            );
            match result {
                Ok(path) => {
                    bundle.state.save_config_toast_until =
                        Some(Instant::now() + Duration::from_secs(2));
                    log::info!("preview: config saved to {path}");
                }
                Err(e) => {
                    bundle.state.status_message = format!("Save error: {e}");
                    log::warn!("preview: save config error: {e}");
                }
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

    /// Debug trigger for the Phase 0.1 shader crossfade integration (T key).
    ///
    /// Advances to the next shader in the sorted shader list and starts a
    /// 2-second crossfade transition via [`Renderer::start_shader_transition`].
    /// On compile/link error, the renderer keeps the current shader
    /// unchanged and the error is logged — the keybind is purely for manual
    /// testing of the dual-FBO render path until the cycle manager lands.
    fn trigger_debug_transition(&mut self) {
        let mut shader_list: Vec<String> = self
            .shader_manager
            .list()
            .iter()
            .map(|s| s.to_string())
            .collect();
        shader_list.sort();
        if shader_list.is_empty() {
            log::warn!("preview: no shaders available for transition");
            return;
        }

        let current_idx = shader_list
            .iter()
            .position(|s| s == &self.active_shader)
            .unwrap_or(0);
        let next_idx = (current_idx + 1) % shader_list.len();
        let next_name = shader_list[next_idx].clone();
        let prev_name = self.active_shader.clone();

        let Some(src) = self.shader_manager.get_compiled(&next_name) else {
            log::warn!("preview: compiled source missing for '{next_name}'");
            return;
        };
        let src = src.to_string();

        // GL operations below need the preview window's EGL context current.
        if let (Some(es), Some(ec), Some(egl)) =
            (self.egl_surface, self.egl_context, self.egl.as_ref())
        {
            let _ = egl
                .egl
                .make_current(egl.display, Some(es), Some(es), Some(ec));
        }
        let Some(r) = self.renderer.as_mut() else {
            return;
        };
        match r.start_shader_transition(&src, Some(2.0)) {
            Ok(()) => {
                log::info!("preview: shader transition: {prev_name} → {next_name}");
                self.active_shader = next_name.clone();
                if let Some(win) = &self.window {
                    win.set_title(format!("hyprsaver preview — {next_name}"));
                }
            }
            Err(e) => {
                log::warn!("preview: start_shader_transition failed: {e:#}");
            }
        }
    }

    /// Cycle to the previous (-1) or next (+1) shader in the sorted list
    /// and apply it immediately (no ▶ Preview button needed).
    fn cycle_shader(&mut self, direction: i32) {
        let mut shader_list: Vec<String> = self
            .shader_manager
            .list()
            .iter()
            .map(|s| s.to_string())
            .collect();
        shader_list.sort();
        if shader_list.is_empty() {
            return;
        }
        let current_idx = shader_list
            .iter()
            .position(|s| s == &self.active_shader)
            .unwrap_or(0) as i32;
        let n = shader_list.len() as i32;
        let next_idx = ((current_idx + direction) % n + n) % n;
        let next_name = shader_list[next_idx as usize].clone();

        if let Some(src) = self.shader_manager.get_compiled(&next_name) {
            let src = src.to_string();
            if let Some(r) = self.renderer.as_mut() {
                if r.load_shader(&src).is_ok() {
                    self.active_shader = next_name.clone();
                    if let Some(ref mut bundle) = self.egui_bundle {
                        bundle.state.selected_shader = next_name.clone();
                        bundle.state.status_message = format!("Loaded '{next_name}'");
                    }
                    if let Some(win) = &self.window {
                        win.set_title(format!("hyprsaver preview — {next_name}"));
                    }
                    log::info!("preview: cycled to shader '{next_name}'");
                }
            }
        }
    }

    /// Cycle to the previous (-1) or next (+1) palette in the sorted list
    /// and apply it immediately.
    fn cycle_palette(&mut self, direction: i32) {
        let mut palette_list: Vec<String> = self
            .palette_manager
            .list()
            .iter()
            .map(|p| p.to_string())
            .collect();
        palette_list.sort();
        if palette_list.is_empty() {
            return;
        }
        let current_idx = palette_list
            .iter()
            .position(|p| p == &self.active_palette)
            .unwrap_or(0) as i32;
        let n = palette_list.len() as i32;
        let next_idx = ((current_idx + direction) % n + n) % n;
        let next_name = palette_list[next_idx as usize].clone();

        if let Some(palette) = self.palette_manager.get(&next_name).cloned() {
            self.active_palette = next_name.clone();
            if let Some(r) = self.renderer.as_mut() {
                r.set_palette(&palette).ok();
            }
            if let Some(ref mut bundle) = self.egui_bundle {
                bundle.state.selected_palette = next_name.clone();
                bundle.state.status_message = format!("Palette '{next_name}'");
            }
            log::info!("preview: cycled to palette '{next_name}'");
        }
    }

    /// Generate 64×64 thumbnails for all shaders using the current palette.
    /// Results are stored in `self.thumbnail_pixels`.
    fn generate_thumbnails(&mut self) {
        let shader_list: Vec<String> = self
            .shader_manager
            .list()
            .iter()
            .map(|s| s.to_string())
            .collect();

        self.thumbnail_pixels.clear();
        self.thumbnail_textures.clear();

        let renderer = match self.renderer.as_mut() {
            Some(r) => r,
            None => return,
        };

        for name in &shader_list {
            if let Some(src) = self.shader_manager.get_compiled(name) {
                let src = src.to_string();
                if let Some(pixels) = renderer.render_thumbnail(&src, 2.0) {
                    self.thumbnail_pixels.insert(name.clone(), pixels);
                }
            }
        }

        self.thumbnails_palette = self.active_palette.clone();
        log::info!(
            "preview: generated {} shader thumbnails",
            self.thumbnail_pixels.len()
        );
    }

    /// Upload cached thumbnail pixels as egui textures. Must be called after
    /// the egui context is available.
    fn upload_thumbnail_textures(&mut self) {
        let ctx = match self.egui_bundle.as_ref() {
            Some(b) => b.ctx.clone(),
            None => return,
        };

        for (name, pixels) in &self.thumbnail_pixels {
            if self.thumbnail_textures.contains_key(name) {
                continue;
            }
            let image = egui::ColorImage::from_rgba_unmultiplied([64, 64], pixels);
            let handle =
                ctx.load_texture(format!("thumb_{name}"), image, egui::TextureOptions::LINEAR);
            self.thumbnail_textures.insert(name.clone(), handle);
        }
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

    // Use config-persisted window size, or 1280×720 default.
    let initial_w = config.general.preview_width.max(PANEL_WIDTH + 200);
    let initial_h = config.general.preview_height.max(300);

    let now = Instant::now();
    let mut state = PreviewState {
        registry_state,
        compositor_state: compositor,
        xdg_shell,
        seat_state,
        output_state,
        window: Some(window),
        width: initial_w,
        height: initial_h,
        scale_factor: 1,
        configured: false,
        wl_egl_window: None,
        egl_surface: None,
        egl_context: None,
        renderer: None,
        running: true,
        force_reload: false,
        start_time: now,
        config,
        shader_manager,
        palette_manager,
        active_shader: active_shader.clone(),
        active_palette: active_palette.clone(),
        egl,
        keyboard: None,
        pointer: None,
        signal_flag,
        egui_bundle: None,
        cursor_pos: (0.0, 0.0),
        egui_events: Vec::new(),
        paused: false,
        pause_time_offset: 0.0,
        unpause_instant: now,
        fps_frame_count: 0,
        fps_last_sample: now,
        fps_display: 0.0,
        thumbnail_pixels: std::collections::HashMap::new(),
        thumbnail_textures: std::collections::HashMap::new(),
        thumbnails_palette: active_palette,
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

            // Pause: override speed_scale to freeze animation time.
            if let Some(r) = state.renderer.as_mut() {
                if state.paused {
                    r.set_speed_scale(0.0);
                } else {
                    let speed = state
                        .egui_bundle
                        .as_ref()
                        .map(|b| b.state.speed)
                        .unwrap_or(1.0);
                    r.set_speed_scale(speed);
                }
            }

            // Advance palette cross-fade transition.
            let now = Instant::now();
            let blend = state.palette_manager.advance_transition(now);
            if let Some(r) = state.renderer.as_mut() {
                r.set_blend(if blend > 0.0 { blend } else { 0.0 });
            }

            // Generate thumbnails once after GL init, and regenerate on palette change.
            if state.configured && state.renderer.is_some() {
                let needs_gen = state.thumbnail_pixels.is_empty()
                    || state.thumbnails_palette != state.active_palette;
                if needs_gen {
                    // Make EGL context current for thumbnail rendering.
                    if let (Some(es), Some(ec), Some(egl)) =
                        (state.egl_surface, state.egl_context, state.egl.as_ref())
                    {
                        let _ = egl
                            .egl
                            .make_current(egl.display, Some(es), Some(es), Some(ec));
                    }
                    state.generate_thumbnails();
                }
                state.upload_thumbnail_textures();
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

    // Persist last-used window size into config file for next launch.
    save_window_size(state.width, state.height);

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
                // Graceful alias: "raymarcher" was renamed to "donut" in v0.3.1.
                if n == "raymarcher" {
                    log::warn!(
                        "Unknown shader 'raymarcher', did you mean 'donut'? \
                         Falling back to 'donut'."
                    );
                    return "donut".to_string();
                }
                // Graceful alias: "aurora_sphere" was renamed to "planet".
                if n == "aurora_sphere" {
                    log::warn!(
                        "Shader 'aurora_sphere' was renamed to 'planet'. \
                         Please update your config. Falling back to 'planet'."
                    );
                    return "planet".to_string();
                }
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
                "rainbow".to_string()
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
        let default_w = self.config.general.preview_width.max(PANEL_WIDTH + 200);
        let default_h = self.config.general.preview_height.max(300);
        let w = new_w
            .map(|v| v.get())
            .unwrap_or(default_w)
            .max(PANEL_WIDTH + 200);
        let h = new_h.map(|v| v.get()).unwrap_or(default_h);

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

        // App-level shortcuts — only fire when egui doesn't want keyboard.
        if !wants_kb {
            match event.keysym {
                Keysym::q | Keysym::Q | Keysym::Escape => {
                    log::info!("preview: quit key pressed");
                    self.running = false;
                }
                Keysym::space => {
                    // Pause / resume animation
                    if self.paused {
                        self.unpause_instant = Instant::now();
                        self.paused = false;
                        log::info!("preview: animation resumed");
                    } else {
                        self.pause_time_offset += self.unpause_instant.elapsed().as_secs_f32();
                        self.paused = true;
                        log::info!("preview: animation paused");
                    }
                }
                Keysym::Left => {
                    self.cycle_shader(-1);
                }
                Keysym::Right => {
                    self.cycle_shader(1);
                }
                Keysym::Up => {
                    self.cycle_palette(-1);
                }
                Keysym::Down => {
                    self.cycle_palette(1);
                }
                Keysym::r | Keysym::R => {
                    log::info!("preview: time reset");
                    self.pause_time_offset = 0.0;
                    self.unpause_instant = Instant::now();
                    if let Some(r) = self.renderer.as_mut() {
                        r.reset_time();
                    }
                }
                Keysym::f | Keysym::F => {
                    if let Some(ref mut bundle) = self.egui_bundle {
                        bundle.state.fullscreen_mode = !bundle.state.fullscreen_mode;
                        log::info!("preview: fullscreen={}", bundle.state.fullscreen_mode);
                    }
                }
                Keysym::t | Keysym::T => {
                    log::info!("preview: transition key pressed");
                    self.trigger_debug_transition();
                }
                _ => {}
            }
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
        let panel_visible = !self
            .egui_bundle
            .as_ref()
            .map(|b| b.state.panel_collapsed || b.state.fullscreen_mode)
            .unwrap_or(false);
        let panel_left = if panel_visible {
            self.width as f32 - PANEL_WIDTH as f32
        } else {
            self.width as f32 // panel off-screen, all events go to shader area
        };

        for event in events {
            match event.kind {
                PointerEventKind::Motion { .. } => {
                    let (x, y) = event.position;
                    self.cursor_pos = (x as f32, y as f32);
                    if x as f32 >= panel_left {
                        self.egui_events
                            .push(egui::Event::PointerMoved(egui::Pos2::new(
                                x as f32, y as f32,
                            )));
                    } else {
                        // Cursor moved into shader area — let egui know it's gone.
                        self.egui_events.push(egui::Event::PointerGone);
                    }
                }
                PointerEventKind::Press { button, .. } => {
                    if self.cursor_pos.0 >= panel_left {
                        if let Some(btn) = linux_btn_to_egui(button) {
                            self.egui_events.push(egui::Event::PointerButton {
                                pos: egui::Pos2::new(self.cursor_pos.0, self.cursor_pos.1),
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
                                pos: egui::Pos2::new(self.cursor_pos.0, self.cursor_pos.1),
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
    cosine_palettes: &std::collections::BTreeMap<String, Palette>,
    thumbnail_textures: &mut std::collections::HashMap<String, egui::TextureHandle>,
) {
    egui::SidePanel::right("control_panel")
        .exact_width(PANEL_WIDTH as f32)
        .resizable(false)
        .show(ctx, |ui| {
            ui.add_space(8.0);
            ui.heading("hyprsaver");
            ui.add_space(2.0);
            ui.separator();

            // Tab bar — pre-compute active flags to avoid closure capture conflicts.
            let on_preview = state.active_tab == PreviewTab::Preview;
            let on_playlists = state.active_tab == PreviewTab::Playlists;
            let on_palette = state.active_tab == PreviewTab::PaletteEditor;
            let tab_fill_active = egui::Color32::from_rgba_unmultiplied(60, 80, 130, 220);

            // Helper inlined three times below: one button per tab.
            let tab_w = (PANEL_WIDTH as f32 - 20.0) / 3.0;
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                if ui
                    .add(
                        egui::Button::new(egui::RichText::new("Preview").color(if on_preview {
                            egui::Color32::WHITE
                        } else {
                            egui::Color32::from_gray(150)
                        }))
                        .fill(if on_preview {
                            tab_fill_active
                        } else {
                            egui::Color32::TRANSPARENT
                        })
                        .min_size(egui::Vec2::new(tab_w, 22.0)),
                    )
                    .clicked()
                {
                    state.active_tab = PreviewTab::Preview;
                }
                if ui
                    .add(
                        egui::Button::new(egui::RichText::new("Playlists").color(
                            if on_playlists {
                                egui::Color32::WHITE
                            } else {
                                egui::Color32::from_gray(150)
                            },
                        ))
                        .fill(if on_playlists {
                            tab_fill_active
                        } else {
                            egui::Color32::TRANSPARENT
                        })
                        .min_size(egui::Vec2::new(tab_w, 22.0)),
                    )
                    .clicked()
                {
                    state.active_tab = PreviewTab::Playlists;
                }
                if ui
                    .add(
                        egui::Button::new(egui::RichText::new("Palette").color(if on_palette {
                            egui::Color32::WHITE
                        } else {
                            egui::Color32::from_gray(150)
                        }))
                        .fill(if on_palette {
                            tab_fill_active
                        } else {
                            egui::Color32::TRANSPARENT
                        })
                        .min_size(egui::Vec2::new(tab_w, 22.0)),
                    )
                    .clicked()
                {
                    state.active_tab = PreviewTab::PaletteEditor;
                }
            });
            ui.add_space(2.0);
            ui.separator();
            ui.add_space(6.0);

            match state.active_tab {
                PreviewTab::Preview => {
                    draw_preview_tab(ui, state, shader_list, palette_list, thumbnail_textures);
                }
                PreviewTab::Playlists => {
                    draw_playlists_tab(ui, state, shader_list, palette_list);
                }
                PreviewTab::PaletteEditor => {
                    draw_palette_editor_tab(ui, state, cosine_palettes);
                }
            }
        });
}

/// Contents of the "Preview" tab — organized with collapsible sections.
fn draw_preview_tab(
    ui: &mut egui::Ui,
    state: &mut PreviewPanelState,
    shader_list: &[String],
    palette_list: &[String],
    thumbnail_textures: &mut std::collections::HashMap<String, egui::TextureHandle>,
) {
    egui::ScrollArea::vertical()
        .id_salt("preview_tab_scroll")
        .auto_shrink([false; 2])
        .show(ui, |ui| {
            let avail_w = ui.available_width();

            // ── Shader section ─────────────────────────────────────────
            egui::CollapsingHeader::new(egui::RichText::new("Shader").strong())
                .default_open(true)
                .show(ui, |ui| {
                    egui::ComboBox::from_id_salt("shader_combo")
                        .width(avail_w - 12.0)
                        .selected_text(&state.selected_shader)
                        .show_ui(ui, |ui| {
                            for name in shader_list {
                                ui.horizontal(|ui| {
                                    // Show 64×64 thumbnail if available
                                    if let Some(tex) = thumbnail_textures.get(name.as_str()) {
                                        ui.image(egui::load::SizedTexture::new(
                                            tex.id(),
                                            egui::Vec2::new(32.0, 32.0),
                                        ));
                                    }
                                    if ui
                                        .selectable_label(state.selected_shader == *name, name)
                                        .clicked()
                                    {
                                        state.selected_shader = name.clone();
                                    }
                                });
                            }
                        });

                    ui.add_space(4.0);
                    ui.label(format!("Speed  {:.2}×", state.speed));
                    ui.horizontal(|ui| {
                        ui.add(
                            egui::Slider::new(&mut state.speed, 0.1_f32..=3.0)
                                .step_by(0.05f64)
                                .show_value(false),
                        );
                        if ui
                            .add(egui::Button::new("↺").min_size(egui::Vec2::new(24.0, 0.0)))
                            .on_hover_text("Reset to default")
                            .clicked()
                        {
                            state.speed = 1.0;
                        }
                    });

                    ui.add_space(4.0);
                    if ui
                        .add(
                            egui::Button::new("⟳ Test Transition")
                                .min_size(egui::Vec2::new(avail_w - 12.0, 22.0)),
                        )
                        .on_hover_text("Preview a 2-second crossfade to a random shader")
                        .clicked()
                    {
                        state.test_transition_requested = true;
                    }
                });

            ui.add_space(4.0);

            // ── Palette section ────────────────────────────────────────
            egui::CollapsingHeader::new(egui::RichText::new("Palette").strong())
                .default_open(true)
                .show(ui, |ui| {
                    egui::ComboBox::from_id_salt("palette_combo")
                        .width(avail_w - 12.0)
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

                    ui.add_space(4.0);
                    ui.label(format!(
                        "Transition  {:.1}s",
                        state.palette_transition_speed
                    ));
                    ui.add(
                        egui::Slider::new(&mut state.palette_transition_speed, 0.0_f32..=5.0)
                            .step_by(0.1f64)
                            .show_value(false),
                    );
                });

            ui.add_space(4.0);

            // ── Display section ────────────────────────────────────────
            egui::CollapsingHeader::new(egui::RichText::new("Display").strong())
                .default_open(true)
                .show(ui, |ui| {
                    ui.label(format!("Zoom  {:.2}×", state.zoom));
                    ui.horizontal(|ui| {
                        ui.add(
                            egui::Slider::new(&mut state.zoom, 0.1_f32..=3.0)
                                .step_by(0.05f64)
                                .show_value(false),
                        );
                        if ui
                            .add(egui::Button::new("↺").min_size(egui::Vec2::new(24.0, 0.0)))
                            .on_hover_text("Reset to default")
                            .clicked()
                        {
                            state.zoom = 1.0;
                        }
                    });

                    ui.add_space(4.0);
                    ui.checkbox(&mut state.show_fps, "Show FPS counter");
                });

            ui.add_space(10.0);

            // ── Action buttons ─────────────────────────────────────────
            let accent = egui::Color32::from_rgb(0x5e, 0x81, 0xf4);
            if ui
                .add(
                    egui::Button::new(
                        egui::RichText::new("▶  Preview").color(egui::Color32::WHITE),
                    )
                    .fill(accent)
                    .min_size(egui::Vec2::new(avail_w - 8.0, 32.0)),
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

            ui.add_space(8.0);
            let save_accent = egui::Color32::from_rgb(0x30, 0xa0, 0x60);
            if ui
                .add(
                    egui::Button::new(
                        egui::RichText::new("Save Config").color(egui::Color32::WHITE),
                    )
                    .fill(save_accent)
                    .min_size(egui::Vec2::new(avail_w - 8.0, 28.0)),
                )
                .on_hover_text("Write current shader/palette/speed/zoom to hyprsaver.toml")
                .clicked()
            {
                state.save_config_requested = true;
            }

            // "Saved ✓" toast — visible for ~2s after a successful save.
            if let Some(until) = state.save_config_toast_until {
                if Instant::now() < until {
                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new("Saved ✓")
                            .small()
                            .strong()
                            .color(egui::Color32::from_rgb(0x5e, 0xd0, 0x90)),
                    );
                } else {
                    state.save_config_toast_until = None;
                }
            }

            ui.add_space(12.0);
            ui.separator();
            ui.add_space(6.0);
            ui.label(egui::RichText::new("Keyboard shortcuts").small().strong());
            ui.label(
                egui::RichText::new(
                    "Space       pause/resume\n\
                     ←/→         prev/next shader\n\
                     ↑/↓         prev/next palette\n\
                     R           reset time\n\
                     F           toggle fullscreen\n\
                     Esc         exit",
                )
                .small()
                .monospace(),
            );
        });
}

/// Contents of the "Playlists" editor tab.
fn draw_playlists_tab(
    ui: &mut egui::Ui,
    state: &mut PreviewPanelState,
    shader_list: &[String],
    palette_list: &[String],
) {
    let avail_w = ui.available_width();

    // ── Sub-tab bar ──────────────────────────────────────────────────
    // Visually distinct from the main tab bar: uses SelectableLabel with
    // small text instead of full button widgets.
    {
        let ed = &mut state.playlist_editor;
        ui.horizontal(|ui| {
            if ui
                .add(egui::SelectableLabel::new(
                    ed.active_subtab == PlaylistSubTab::Shaders,
                    egui::RichText::new("Shaders").small(),
                ))
                .clicked()
            {
                ed.active_subtab = PlaylistSubTab::Shaders;
            }
            ui.separator();
            if ui
                .add(egui::SelectableLabel::new(
                    ed.active_subtab == PlaylistSubTab::Palettes,
                    egui::RichText::new("Palettes").small(),
                ))
                .clicked()
            {
                ed.active_subtab = PlaylistSubTab::Palettes;
            }
        });
    }
    ui.add_space(4.0);
    ui.separator();
    ui.add_space(6.0);

    egui::ScrollArea::vertical()
        .id_salt("playlists_scroll")
        .auto_shrink([false; 2])
        .show(ui, |ui| {
            let ed = &mut state.playlist_editor;

            match ed.active_subtab {
                // ── Shaders sub-tab ──────────────────────────────────
                PlaylistSubTab::Shaders => {
                    // a. Playlist name field
                    ui.label(egui::RichText::new("Playlist name").small());
                    ui.add(
                        egui::TextEdit::singleline(&mut ed.shader_playlist_name)
                            .hint_text("New Playlist")
                            .desired_width(avail_w - 4.0),
                    );
                    ui.add_space(6.0);

                    // b. Dropdown to select items to add
                    // c. Add button
                    ui.horizontal(|ui| {
                        let available: Vec<String> = shader_list
                            .iter()
                            .filter(|s| !ed.shader_items.contains(*s))
                            .cloned()
                            .collect();
                        let combo_text = if ed.add_shader_selected.is_empty() {
                            "— add —"
                        } else {
                            &ed.add_shader_selected
                        };
                        egui::ComboBox::from_id_salt("add_shader_combo")
                            .width(avail_w - 48.0)
                            .selected_text(combo_text)
                            .show_ui(ui, |ui| {
                                for name in &available {
                                    ui.selectable_value(
                                        &mut ed.add_shader_selected,
                                        name.clone(),
                                        name,
                                    );
                                }
                            });
                        let can_add = !ed.add_shader_selected.is_empty()
                            && !ed.shader_items.contains(&ed.add_shader_selected);
                        if ui
                            .add_enabled(
                                can_add,
                                egui::Button::new("+").min_size(egui::Vec2::new(28.0, 0.0)),
                            )
                            .clicked()
                        {
                            ed.shader_items.push(ed.add_shader_selected.clone());
                            ed.add_shader_selected.clear();
                        }
                    });

                    ui.add_space(4.0);

                    // d. Scrollable list of current playlist entries
                    egui::ScrollArea::vertical()
                        .id_salt("shader_list_scroll")
                        .max_height(140.0)
                        .show(ui, |ui| {
                            draw_reorderable_list(
                                ui,
                                &mut ed.shader_items,
                                &mut ed.selected_shader_idx,
                                &mut ed.shader_drag_src,
                                &mut ed.shader_drag_tgt,
                            );
                        });

                    if ui
                        .add_enabled(
                            ed.selected_shader_idx.is_some(),
                            egui::Button::new("− Remove selected")
                                .min_size(egui::Vec2::new(avail_w, 0.0)),
                        )
                        .clicked()
                    {
                        if let Some(idx) = ed.selected_shader_idx {
                            if idx < ed.shader_items.len() {
                                ed.shader_items.remove(idx);
                                ed.selected_shader_idx = if ed.shader_items.is_empty() {
                                    None
                                } else {
                                    Some(idx.min(ed.shader_items.len() - 1))
                                };
                            }
                        }
                    }
                }

                // ── Palettes sub-tab ─────────────────────────────────
                PlaylistSubTab::Palettes => {
                    // a. Playlist name field
                    ui.label(egui::RichText::new("Playlist name").small());
                    ui.add(
                        egui::TextEdit::singleline(&mut ed.palette_playlist_name)
                            .hint_text("New Playlist")
                            .desired_width(avail_w - 4.0),
                    );
                    ui.add_space(6.0);

                    // b. Dropdown to select items to add
                    // c. Add button
                    ui.horizontal(|ui| {
                        let available: Vec<String> = palette_list
                            .iter()
                            .filter(|s| !ed.palette_items.contains(*s))
                            .cloned()
                            .collect();
                        let combo_text = if ed.add_palette_selected.is_empty() {
                            "— add —"
                        } else {
                            &ed.add_palette_selected
                        };
                        egui::ComboBox::from_id_salt("add_palette_combo")
                            .width(avail_w - 48.0)
                            .selected_text(combo_text)
                            .show_ui(ui, |ui| {
                                for name in &available {
                                    ui.selectable_value(
                                        &mut ed.add_palette_selected,
                                        name.clone(),
                                        name,
                                    );
                                }
                            });
                        let can_add = !ed.add_palette_selected.is_empty()
                            && !ed.palette_items.contains(&ed.add_palette_selected);
                        if ui
                            .add_enabled(
                                can_add,
                                egui::Button::new("+").min_size(egui::Vec2::new(28.0, 0.0)),
                            )
                            .clicked()
                        {
                            ed.palette_items.push(ed.add_palette_selected.clone());
                            ed.add_palette_selected.clear();
                        }
                    });

                    ui.add_space(4.0);

                    // d. Scrollable list of current playlist entries
                    egui::ScrollArea::vertical()
                        .id_salt("palette_list_scroll")
                        .max_height(140.0)
                        .show(ui, |ui| {
                            draw_reorderable_list(
                                ui,
                                &mut ed.palette_items,
                                &mut ed.selected_palette_idx,
                                &mut ed.palette_drag_src,
                                &mut ed.palette_drag_tgt,
                            );
                        });

                    if ui
                        .add_enabled(
                            ed.selected_palette_idx.is_some(),
                            egui::Button::new("− Remove selected")
                                .min_size(egui::Vec2::new(avail_w, 0.0)),
                        )
                        .clicked()
                    {
                        if let Some(idx) = ed.selected_palette_idx {
                            if idx < ed.palette_items.len() {
                                ed.palette_items.remove(idx);
                                ed.selected_palette_idx = if ed.palette_items.is_empty() {
                                    None
                                } else {
                                    Some(idx.min(ed.palette_items.len() - 1))
                                };
                            }
                        }
                    }
                }
            }

            ui.add_space(6.0);
            ui.separator();
            ui.add_space(4.0);

            // ── Intervals ───────────────────────────────────────────────
            ui.horizontal(|ui| {
                ui.label("Shader interval:");
                ui.add(
                    egui::DragValue::new(&mut ed.shader_interval)
                        .range(10_u64..=3600_u64)
                        .speed(1.0)
                        .suffix(" s"),
                );
            });
            ui.horizontal(|ui| {
                ui.label("Palette interval:");
                ui.add(
                    egui::DragValue::new(&mut ed.palette_interval)
                        .range(5_u64..=3600_u64)
                        .speed(1.0)
                        .suffix(" s"),
                );
            });

            ui.add_space(4.0);

            // ── Cycle order ─────────────────────────────────────────────
            ui.horizontal(|ui| {
                ui.label("Cycle order:");
                ui.radio_value(&mut ed.cycle_order_random, true, "Random");
                ui.radio_value(&mut ed.cycle_order_random, false, "Sequential");
            });

            ui.add_space(6.0);
            ui.separator();
            ui.add_space(4.0);

            // ── Action buttons ──────────────────────────────────────────
            let accent = egui::Color32::from_rgb(0x5e, 0x81, 0xf4);
            if ui
                .add(
                    egui::Button::new(
                        egui::RichText::new("Save Playlist").color(egui::Color32::WHITE),
                    )
                    .fill(accent)
                    .min_size(egui::Vec2::new(avail_w, 28.0)),
                )
                .clicked()
            {
                ed.save_requested = true;
            }

            ui.add_space(4.0);

            if ui
                .add(
                    egui::Button::new("Apply & Restart Cycle")
                        .min_size(egui::Vec2::new(avail_w, 28.0)),
                )
                .clicked()
            {
                ed.apply_requested = true;
            }

            if !ed.save_status.is_empty() {
                ui.add_space(4.0);
                ui.label(
                    egui::RichText::new(&ed.save_status)
                        .small()
                        .color(egui::Color32::from_gray(160)),
                );
            }
        });
}

/// Contents of the "Palette Editor" tab.
///
/// Lays out, top-to-bottom:
/// 1. Palette selector dropdown (cosine palettes + "New Palette")
/// 2. Optional "Palette name" text field (new-palette mode only)
/// 3. Four rows of R/G/B sliders: a (center), b (amplitude), c (frequency), d (phase)
/// 4. Live gradient preview strip rendered as 256 egui rects
/// 5. Save / Reset buttons + status line
///
/// Slider changes mark `state.palette_editor.dirty = true`. The render loop
/// consumes that flag and uploads new uniform values — no shader recompile.
fn draw_palette_editor_tab(
    ui: &mut egui::Ui,
    state: &mut PreviewPanelState,
    cosine_palettes: &std::collections::BTreeMap<String, Palette>,
) {
    let avail_w = ui.available_width();
    egui::ScrollArea::vertical()
        .id_salt("palette_editor_scroll")
        .auto_shrink([false; 2])
        .show(ui, |ui| {
            let ed = &mut state.palette_editor;

            // ── Palette selector ────────────────────────────────────────
            ui.label(egui::RichText::new("Palette").strong().small());
            let prev_selection = ed.selected_name.clone();
            egui::ComboBox::from_id_salt("palette_editor_combo")
                .width(avail_w - 4.0)
                .selected_text(&ed.selected_name)
                .show_ui(ui, |ui| {
                    for name in cosine_palettes.keys() {
                        ui.selectable_value(&mut ed.selected_name, name.clone(), name);
                    }
                    ui.separator();
                    ui.selectable_value(
                        &mut ed.selected_name,
                        NEW_PALETTE_SENTINEL.to_string(),
                        NEW_PALETTE_SENTINEL,
                    );
                });

            // Dropdown selection changed this frame — load the new palette
            // into the sliders and mark dirty so uniforms get pushed.
            if ed.selected_name != prev_selection {
                if ed.selected_name == NEW_PALETTE_SENTINEL {
                    let def = Palette::default();
                    ed.current = def.clone();
                    ed.original = def;
                    ed.new_name.clear();
                } else if let Some(p) = cosine_palettes.get(&ed.selected_name) {
                    ed.current = p.clone();
                    ed.original = p.clone();
                }
                ed.dirty = true;
                ed.save_status.clear();
            }

            ui.add_space(6.0);

            // ── New palette name field (shown only when creating new) ──
            if ed.selected_name == NEW_PALETTE_SENTINEL {
                ui.label(egui::RichText::new("New palette name").small());
                ui.add(
                    egui::TextEdit::singleline(&mut ed.new_name)
                        .hint_text("my_palette")
                        .desired_width(avail_w - 4.0),
                );
                ui.add_space(6.0);
            }

            // ── Slider rows ─────────────────────────────────────────────
            // (a: center [0,1], b: amplitude [0,1], c: frequency [0,5], d: phase [0,1])
            let label_col_w: f32 = 22.0;
            let slider_col_w: f32 = ((avail_w - label_col_w - 12.0) / 3.0).max(40.0);

            // Helper closure factored out so the four rows stay compact.
            // Returns true if any of the three sliders changed this frame.
            let row =
                |ui: &mut egui::Ui, label: &str, vals: &mut [f32; 3], range: (f32, f32)| -> bool {
                    let mut any_changed = false;
                    ui.horizontal(|ui| {
                        ui.add_sized(
                            egui::Vec2::new(label_col_w, 18.0),
                            egui::Label::new(egui::RichText::new(label).monospace().strong()),
                        );
                        for v in vals.iter_mut() {
                            if ui
                                .add_sized(
                                    egui::Vec2::new(slider_col_w, 18.0),
                                    egui::DragValue::new(v)
                                        .range(range.0..=range.1)
                                        .speed(0.01)
                                        .fixed_decimals(2),
                                )
                                .changed()
                            {
                                any_changed = true;
                            }
                        }
                    });
                    any_changed
                };

            ui.label(egui::RichText::new("Cosine parameters").small().strong());
            ui.add_space(2.0);
            let mut changed = false;
            changed |= row(ui, "a", &mut ed.current.a, (0.0, 1.0));
            changed |= row(ui, "b", &mut ed.current.b, (0.0, 1.0));
            changed |= row(ui, "c", &mut ed.current.c, (0.0, 5.0));
            changed |= row(ui, "d", &mut ed.current.d, (0.0, 1.0));

            if changed {
                ed.dirty = true;
            }

            ui.add_space(10.0);

            // ── Gradient preview strip ─────────────────────────────────
            // Render 256 horizontally-tiled colored rects from palette(t)
            // sampled at t = i/255 for i in 0..256. Width adapts to panel.
            ui.label(egui::RichText::new("Preview").small().strong());
            ui.add_space(2.0);
            const STRIP_HEIGHT: f32 = 28.0;
            const STEPS: usize = 256;
            let (strip_rect, _) = ui.allocate_exact_size(
                egui::Vec2::new(avail_w - 4.0, STRIP_HEIGHT),
                egui::Sense::hover(),
            );
            let painter = ui.painter();
            // Frame first so overdraw by the samples gives clean edges.
            painter.rect_stroke(
                strip_rect,
                2.0,
                egui::Stroke::new(1.0, egui::Color32::from_gray(80)),
            );
            let step_w = strip_rect.width() / STEPS as f32;
            for i in 0..STEPS {
                let t = i as f32 / (STEPS - 1) as f32;
                let [r, g, b] = ed.current.color_at(t);
                let color = egui::Color32::from_rgb(
                    (r * 255.0) as u8,
                    (g * 255.0) as u8,
                    (b * 255.0) as u8,
                );
                let x0 = strip_rect.left() + i as f32 * step_w;
                // Add half a pixel to x1 so adjacent rects overlap and no
                // seam shows between samples at fractional widths.
                let x1 = x0 + step_w + 0.5;
                let rect = egui::Rect::from_min_max(
                    egui::pos2(x0, strip_rect.top() + 1.0),
                    egui::pos2(x1, strip_rect.bottom() - 1.0),
                );
                painter.rect_filled(rect, 0.0, color);
            }

            ui.add_space(10.0);
            ui.separator();
            ui.add_space(4.0);

            // ── Save / Reset buttons ───────────────────────────────────
            let accent = egui::Color32::from_rgb(0x5e, 0x81, 0xf4);
            let is_new = ed.selected_name == NEW_PALETTE_SENTINEL;
            let save_ok = if is_new {
                !ed.new_name.trim().is_empty()
            } else {
                true
            };
            if ui
                .add_enabled(
                    save_ok,
                    egui::Button::new(
                        egui::RichText::new("Save Palette").color(egui::Color32::WHITE),
                    )
                    .fill(accent)
                    .min_size(egui::Vec2::new(avail_w - 4.0, 28.0)),
                )
                .clicked()
            {
                ed.save_requested = true;
            }

            ui.add_space(4.0);
            if ui
                .add(egui::Button::new("Reset").min_size(egui::Vec2::new(avail_w - 4.0, 24.0)))
                .clicked()
            {
                ed.reset_requested = true;
            }

            if !ed.save_status.is_empty() {
                ui.add_space(4.0);
                ui.label(
                    egui::RichText::new(&ed.save_status)
                        .small()
                        .color(egui::Color32::from_gray(160)),
                );
            }

            ui.add_space(8.0);
            ui.separator();
            ui.add_space(4.0);
            ui.label(
                egui::RichText::new("Tip: slider changes are applied live — no shader recompile.")
                    .small()
                    .color(egui::Color32::from_gray(120)),
            );
        });
}

/// Draw a compact drag-and-drop reorderable list.
///
/// Each item row has a `⋮` drag handle on the left and the item name on the right.
/// Click to select; drag to reorder (uses `Sense::drag()`).
/// A blue insertion-point line tracks the drop target while dragging.
///
/// All arguments are raw `&mut` to individual `PlaylistEditorState` fields so the
/// caller can split-borrow without holding a mutable ref to the whole struct.
fn draw_reorderable_list(
    ui: &mut egui::Ui,
    items: &mut Vec<String>,
    selected: &mut Option<usize>,
    drag_src: &mut Option<usize>,
    drag_tgt: &mut Option<usize>,
) {
    const ITEM_H: f32 = 22.0;

    let avail_w = ui.available_width();
    let n = items.len();

    if n == 0 {
        let (rect, _) =
            ui.allocate_exact_size(egui::Vec2::new(avail_w, ITEM_H), egui::Sense::hover());
        ui.painter().text(
            rect.left_center() + egui::vec2(8.0, 0.0),
            egui::Align2::LEFT_CENTER,
            "(empty — add items below)",
            egui::FontId::proportional(11.0),
            egui::Color32::from_gray(80),
        );
        return;
    }

    // Capture the top of the list in screen coordinates before allocating rows.
    let list_top = ui.cursor().min.y;
    let list_left = ui.cursor().min.x;

    // Compute drag insertion point from the live pointer position.
    if drag_src.is_some() {
        if let Some(ptr) = ui.ctx().pointer_hover_pos() {
            let raw = ((ptr.y - list_top) / ITEM_H).round() as i32;
            *drag_tgt = Some(raw.clamp(0, n as i32) as usize);
        }
    }

    for (i, item) in items.iter().enumerate() {
        let is_selected = *selected == Some(i);
        let is_dragging = *drag_src == Some(i);

        let (rect, resp) = ui.allocate_exact_size(
            egui::Vec2::new(avail_w, ITEM_H),
            egui::Sense::click_and_drag(),
        );

        let bg = if is_dragging {
            egui::Color32::from_rgba_unmultiplied(50, 50, 75, 180)
        } else if is_selected {
            egui::Color32::from_rgba_unmultiplied(55, 75, 135, 220)
        } else if resp.hovered() && drag_src.is_none() {
            egui::Color32::from_rgba_unmultiplied(35, 35, 65, 180)
        } else {
            egui::Color32::from_rgba_unmultiplied(22, 22, 38, 200)
        };

        let painter = ui.painter();
        painter.rect_filled(rect, 3.0, bg);

        // ⋮ drag handle indicator
        painter.text(
            rect.left_center() + egui::vec2(6.0, 0.0),
            egui::Align2::LEFT_CENTER,
            "⋮",
            egui::FontId::proportional(11.0),
            egui::Color32::from_gray(90),
        );

        // Item label
        painter.text(
            rect.left_center() + egui::vec2(18.0, 0.0),
            egui::Align2::LEFT_CENTER,
            item,
            egui::FontId::proportional(12.0),
            if is_dragging {
                egui::Color32::from_gray(130)
            } else {
                egui::Color32::from_gray(215)
            },
        );

        if resp.clicked() {
            *selected = Some(i);
        }
        if resp.drag_started() {
            *drag_src = Some(i);
            *selected = Some(i);
        }
    }

    // Draw blue insertion-point line while dragging.
    if let (Some(_src), Some(tgt)) = (*drag_src, *drag_tgt) {
        let y = list_top + tgt as f32 * ITEM_H;
        ui.painter().line_segment(
            [egui::pos2(list_left, y), egui::pos2(list_left + avail_w, y)],
            egui::Stroke::new(2.0, egui::Color32::from_rgb(0x5e, 0x81, 0xf4)),
        );
    }

    // Commit drag on pointer release.
    if ui.input(|i| i.pointer.any_released()) && drag_src.is_some() {
        if let (Some(src), Some(tgt)) = (*drag_src, *drag_tgt) {
            // tgt == src or tgt == src+1 both leave the item in the same slot.
            if tgt != src && tgt != src.saturating_add(1) {
                let item = items.remove(src);
                let insert_at = if tgt > src { tgt - 1 } else { tgt };
                items.insert(insert_at.min(items.len()), item);
                *selected = Some(insert_at.min(items.len().saturating_sub(1)));
            }
        }
        *drag_src = None;
        *drag_tgt = None;
    }
}

/// Merge the playlist editor state into the on-disk config file and write it back.
///
/// Uses the same path-resolution logic as `config.rs`:
///   `$XDG_CONFIG_HOME/hypr/hyprsaver.toml` (preferred) or
///   `$XDG_CONFIG_HOME/hyprsaver/config.toml` (legacy).
/// Creates the new path if neither exists.
///
/// Returns the path written on success, or an error string.
fn save_playlist_config(
    shader_playlist_name: &str,
    palette_playlist_name: &str,
    shader_items: &[String],
    palette_items: &[String],
    shader_interval: u64,
    palette_interval: u64,
    cycle_order_random: bool,
) -> Result<String, String> {
    use std::path::PathBuf;

    // Resolve target path: prefer new location, fall back to legacy, else create new.
    let cfg_path: PathBuf = {
        let cfg_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        let new_path = cfg_dir.join("hypr").join("hyprsaver.toml");
        let legacy_path = cfg_dir.join("hyprsaver").join("config.toml");
        if new_path.exists() {
            new_path
        } else if legacy_path.exists() {
            legacy_path
        } else {
            new_path // will be created below
        }
    };

    // Read existing content (empty string if file doesn't exist yet).
    let existing = if cfg_path.exists() {
        std::fs::read_to_string(&cfg_path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };

    // Parse as a generic TOML value so we can merge without losing other keys.
    let mut doc: toml::Value = if existing.trim().is_empty() {
        toml::Value::Table(Default::default())
    } else {
        existing.parse::<toml::Value>().map_err(|e| e.to_string())?
    };

    // Helper: ensure `key` maps to a Table inside `parent`, then return it.
    fn ensure_table<'a>(
        parent: &'a mut toml::map::Map<String, toml::Value>,
        key: &str,
    ) -> &'a mut toml::map::Map<String, toml::Value> {
        if !parent.contains_key(key) {
            parent.insert(key.to_string(), toml::Value::Table(Default::default()));
        }
        parent.get_mut(key).unwrap().as_table_mut().unwrap()
    }

    let root = doc
        .as_table_mut()
        .ok_or("TOML config root is not a table")?;

    // Update [general] keys.
    {
        let general = ensure_table(root, "general");
        general.insert(
            "shader_cycle_interval".to_string(),
            toml::Value::Integer(shader_interval as i64),
        );
        general.insert(
            "palette_cycle_interval".to_string(),
            toml::Value::Integer(palette_interval as i64),
        );
        general.insert(
            "cycle_order".to_string(),
            toml::Value::String(
                if cycle_order_random {
                    "random"
                } else {
                    "sequential"
                }
                .to_string(),
            ),
        );
        if !shader_items.is_empty() {
            let sname = if shader_playlist_name.trim().is_empty() {
                "custom"
            } else {
                shader_playlist_name.trim()
            };
            general.insert(
                "shader_playlist".to_string(),
                toml::Value::String(sname.to_string()),
            );
            general.insert(
                "shader".to_string(),
                toml::Value::String("cycle".to_string()),
            );
        }
        if !palette_items.is_empty() {
            let pname = if palette_playlist_name.trim().is_empty() {
                "custom"
            } else {
                palette_playlist_name.trim()
            };
            general.insert(
                "palette_playlist".to_string(),
                toml::Value::String(pname.to_string()),
            );
            general.insert(
                "palette".to_string(),
                toml::Value::String("cycle".to_string()),
            );
        }
    }

    // Update [playlists.<name>] (unified v0.4.0 format).
    let playlists = ensure_table(root, "playlists");
    if !shader_items.is_empty() {
        let sname = if shader_playlist_name.trim().is_empty() {
            "custom"
        } else {
            shader_playlist_name.trim()
        };
        let shader_pl = ensure_table(playlists, sname);
        shader_pl.insert(
            "shaders".to_string(),
            toml::Value::Array(
                shader_items
                    .iter()
                    .map(|s| toml::Value::String(s.clone()))
                    .collect(),
            ),
        );
    }
    if !palette_items.is_empty() {
        let pname = if palette_playlist_name.trim().is_empty() {
            "custom"
        } else {
            palette_playlist_name.trim()
        };
        let palette_pl = ensure_table(playlists, pname);
        palette_pl.insert(
            "palettes".to_string(),
            toml::Value::Array(
                palette_items
                    .iter()
                    .map(|s| toml::Value::String(s.clone()))
                    .collect(),
            ),
        );
    }

    // Ensure the parent directory exists.
    if let Some(parent) = cfg_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Serialize and write.
    let content = toml::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&cfg_path, &content).map_err(|e| e.to_string())?;

    Ok(cfg_path.display().to_string())
}

/// Merge a single cosine palette into the on-disk config under
/// `[palettes.<name>]` and write it back. The rest of the config is
/// preserved (generic TOML merge — other tables, comments are not
/// preserved since `toml::Value` round-trip drops them).
///
/// Path resolution matches `save_playlist_config`.
fn save_palette_config(name: &str, palette: &Palette) -> Result<String, String> {
    use std::path::PathBuf;

    // Basic name validation: non-empty, no whitespace, no `.` or `[` which
    // would make the TOML key ambiguous.
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("palette name cannot be empty".to_string());
    }
    if trimmed
        .chars()
        .any(|c| c.is_whitespace() || c == '.' || c == '[' || c == ']')
    {
        return Err("palette name cannot contain whitespace or . [ ]".to_string());
    }

    // Resolve target path: prefer new location, fall back to legacy, else create new.
    let cfg_path: PathBuf = {
        let cfg_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        let new_path = cfg_dir.join("hypr").join("hyprsaver.toml");
        let legacy_path = cfg_dir.join("hyprsaver").join("config.toml");
        if new_path.exists() {
            new_path
        } else if legacy_path.exists() {
            legacy_path
        } else {
            new_path // will be created below
        }
    };

    // Read existing content (empty string if file doesn't exist yet).
    let existing = if cfg_path.exists() {
        std::fs::read_to_string(&cfg_path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };

    // Parse as a generic TOML value so we can merge without losing other keys.
    let mut doc: toml::Value = if existing.trim().is_empty() {
        toml::Value::Table(Default::default())
    } else {
        existing.parse::<toml::Value>().map_err(|e| e.to_string())?
    };

    let root = doc
        .as_table_mut()
        .ok_or("TOML config root is not a table")?;

    // Ensure [palettes] exists, then insert/replace [palettes.<name>].
    if !root.contains_key("palettes") {
        root.insert(
            "palettes".to_string(),
            toml::Value::Table(Default::default()),
        );
    }
    let palettes = root
        .get_mut("palettes")
        .and_then(|v| v.as_table_mut())
        .ok_or("[palettes] is not a table")?;

    let to_vec3 = |v: [f32; 3]| -> toml::Value {
        toml::Value::Array(v.iter().map(|f| toml::Value::Float(*f as f64)).collect())
    };

    let mut entry = toml::map::Map::new();
    entry.insert("a".to_string(), to_vec3(palette.a));
    entry.insert("b".to_string(), to_vec3(palette.b));
    entry.insert("c".to_string(), to_vec3(palette.c));
    entry.insert("d".to_string(), to_vec3(palette.d));
    palettes.insert(trimmed.to_string(), toml::Value::Table(entry));

    // Ensure the parent directory exists.
    if let Some(parent) = cfg_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Serialize and write.
    let content = toml::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&cfg_path, &content).map_err(|e| e.to_string())?;

    Ok(cfg_path.display().to_string())
}

/// Merge the full preview state into the on-disk config and write it back.
///
/// Sets `[general].shader`, `[general].palette`, `[general].speed_scale`,
/// `[general].zoom_scale`. If `shader_items` or `palette_items` are
/// non-empty, also writes `[shader_playlists.custom]` /
/// `[palette_playlists.custom]` plus the matching cycle-interval and
/// order keys (same logic as [`save_playlist_config`]). For every
/// `(name, palette)` in `session_palettes`, writes `[palettes.<name>]`
/// with the four cosine vectors.
///
/// Existing fields in the file that are NOT managed by the preview (fade
/// durations, `[[monitor]]` blocks, other `[palettes.*]` entries, etc.)
/// are preserved by round-tripping through `toml::Value`.
///
/// Path resolution matches the rest of the module: prefers
/// `$XDG_CONFIG_HOME/hypr/hyprsaver.toml`, falls back to the legacy
/// `$XDG_CONFIG_HOME/hyprsaver/config.toml`, creates the new path if
/// neither exists.
#[allow(clippy::too_many_arguments)]
fn save_preview_config(
    shader: &str,
    palette: &str,
    speed: f32,
    zoom: f32,
    shader_playlist_name: &str,
    palette_playlist_name: &str,
    shader_items: &[String],
    palette_items: &[String],
    shader_interval: u64,
    palette_interval: u64,
    cycle_order_random: bool,
    session_palettes: &[(String, Palette)],
) -> Result<String, String> {
    use std::path::PathBuf;

    let cfg_path: PathBuf = {
        let cfg_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        let new_path = cfg_dir.join("hypr").join("hyprsaver.toml");
        let legacy_path = cfg_dir.join("hyprsaver").join("config.toml");
        if new_path.exists() {
            new_path
        } else if legacy_path.exists() {
            legacy_path
        } else {
            new_path
        }
    };

    let existing = if cfg_path.exists() {
        std::fs::read_to_string(&cfg_path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };

    let mut doc: toml::Value = if existing.trim().is_empty() {
        toml::Value::Table(Default::default())
    } else {
        existing.parse::<toml::Value>().map_err(|e| e.to_string())?
    };

    fn ensure_table<'a>(
        parent: &'a mut toml::map::Map<String, toml::Value>,
        key: &str,
    ) -> &'a mut toml::map::Map<String, toml::Value> {
        if !parent.contains_key(key) {
            parent.insert(key.to_string(), toml::Value::Table(Default::default()));
        }
        parent.get_mut(key).unwrap().as_table_mut().unwrap()
    }

    let root = doc
        .as_table_mut()
        .ok_or("TOML config root is not a table")?;

    // ── [general] ────────────────────────────────────────────────────
    {
        let general = ensure_table(root, "general");
        general.insert(
            "shader".to_string(),
            toml::Value::String(shader.to_string()),
        );
        general.insert(
            "palette".to_string(),
            toml::Value::String(palette.to_string()),
        );
        general.insert("speed_scale".to_string(), toml::Value::Float(speed as f64));
        general.insert("zoom_scale".to_string(), toml::Value::Float(zoom as f64));

        // Only push playlist-related keys when the user actually has items
        // in either list — otherwise Save Config should not mutate cycle
        // behavior the user didn't touch.
        if !shader_items.is_empty() || !palette_items.is_empty() {
            general.insert(
                "shader_cycle_interval".to_string(),
                toml::Value::Integer(shader_interval as i64),
            );
            general.insert(
                "palette_cycle_interval".to_string(),
                toml::Value::Integer(palette_interval as i64),
            );
            general.insert(
                "cycle_order".to_string(),
                toml::Value::String(
                    if cycle_order_random {
                        "random"
                    } else {
                        "sequential"
                    }
                    .to_string(),
                ),
            );
        }
        if !shader_items.is_empty() {
            let sname = if shader_playlist_name.trim().is_empty() {
                "custom"
            } else {
                shader_playlist_name.trim()
            };
            general.insert(
                "shader_playlist".to_string(),
                toml::Value::String(sname.to_string()),
            );
        }
        if !palette_items.is_empty() {
            let pname = if palette_playlist_name.trim().is_empty() {
                "custom"
            } else {
                palette_playlist_name.trim()
            };
            general.insert(
                "palette_playlist".to_string(),
                toml::Value::String(pname.to_string()),
            );
        }
    }

    // ── [playlists.<name>] (unified v0.4.0 format) ────────────────────
    let playlists = ensure_table(root, "playlists");
    if !shader_items.is_empty() {
        let sname = if shader_playlist_name.trim().is_empty() {
            "custom"
        } else {
            shader_playlist_name.trim()
        };
        let shader_pl = ensure_table(playlists, sname);
        shader_pl.insert(
            "shaders".to_string(),
            toml::Value::Array(
                shader_items
                    .iter()
                    .map(|s| toml::Value::String(s.clone()))
                    .collect(),
            ),
        );
    }
    if !palette_items.is_empty() {
        let pname = if palette_playlist_name.trim().is_empty() {
            "custom"
        } else {
            palette_playlist_name.trim()
        };
        let palette_pl = ensure_table(playlists, pname);
        palette_pl.insert(
            "palettes".to_string(),
            toml::Value::Array(
                palette_items
                    .iter()
                    .map(|s| toml::Value::String(s.clone()))
                    .collect(),
            ),
        );
    }

    // ── [palettes.<name>] for every session-created cosine palette ──
    if !session_palettes.is_empty() {
        let palettes_tbl = ensure_table(root, "palettes");
        let to_vec3 = |v: [f32; 3]| -> toml::Value {
            toml::Value::Array(v.iter().map(|f| toml::Value::Float(*f as f64)).collect())
        };
        for (name, p) in session_palettes {
            let mut entry = toml::map::Map::new();
            entry.insert("a".to_string(), to_vec3(p.a));
            entry.insert("b".to_string(), to_vec3(p.b));
            entry.insert("c".to_string(), to_vec3(p.c));
            entry.insert("d".to_string(), to_vec3(p.d));
            palettes_tbl.insert(name.clone(), toml::Value::Table(entry));
        }
    }

    if let Some(parent) = cfg_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let content = toml::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&cfg_path, &content).map_err(|e| e.to_string())?;

    Ok(cfg_path.display().to_string())
}

/// Best-effort save of the last-used preview window dimensions into the
/// config file. Errors are logged but not propagated — failing to persist
/// the window size is not fatal.
fn save_window_size(width: u32, height: u32) {
    use std::path::PathBuf;

    let cfg_path: PathBuf = {
        let cfg_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        let new_path = cfg_dir.join("hypr").join("hyprsaver.toml");
        let legacy_path = cfg_dir.join("hyprsaver").join("config.toml");
        if new_path.exists() {
            new_path
        } else if legacy_path.exists() {
            legacy_path
        } else {
            new_path
        }
    };

    let existing = if cfg_path.exists() {
        std::fs::read_to_string(&cfg_path).unwrap_or_default()
    } else {
        String::new()
    };

    let mut doc: toml::Value = if existing.trim().is_empty() {
        toml::Value::Table(Default::default())
    } else {
        match existing.parse::<toml::Value>() {
            Ok(v) => v,
            Err(e) => {
                log::warn!("preview: failed to parse config for window size save: {e}");
                return;
            }
        }
    };

    if let Some(root) = doc.as_table_mut() {
        if !root.contains_key("general") {
            root.insert(
                "general".to_string(),
                toml::Value::Table(Default::default()),
            );
        }
        if let Some(general) = root.get_mut("general").and_then(|v| v.as_table_mut()) {
            general.insert(
                "preview_width".to_string(),
                toml::Value::Integer(width as i64),
            );
            general.insert(
                "preview_height".to_string(),
                toml::Value::Integer(height as i64),
            );
        }
    }

    if let Some(parent) = cfg_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match toml::to_string_pretty(&doc) {
        Ok(content) => {
            if let Err(e) = std::fs::write(&cfg_path, &content) {
                log::warn!("preview: failed to save window size: {e}");
            } else {
                log::debug!("preview: saved window size {width}×{height}");
            }
        }
        Err(e) => log::warn!("preview: failed to serialize config: {e}"),
    }
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
        0x110 => Some(egui::PointerButton::Primary), // BTN_LEFT
        0x111 => Some(egui::PointerButton::Secondary), // BTN_RIGHT
        0x112 => Some(egui::PointerButton::Middle),  // BTN_MIDDLE
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
