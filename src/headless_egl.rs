//! `headless_egl.rs` — Headless EGL context for off-screen GPU rendering.
//!
//! Initialises a GLES 3.0 context without a Wayland compositor or display
//! server. No smithay-client-toolkit, no wayland-egl, no wl_display involved.
//!
//! Primary path: make the context current with no surface (requires
//! `EGL_KHR_surfaceless_context` — available on Mesa ≥ 12 and most
//! discrete GPUs). Fallback: create a 1×1 pbuffer surface and use that.
//! Both paths fail → descriptive error naming the missing capability.

use anyhow::Context as _;

// ---------------------------------------------------------------------------
// HeadlessContext — keeps EGL alive
// ---------------------------------------------------------------------------

/// Opaque RAII guard that holds EGL state alive for the lifetime of the
/// associated `glow::Context`. Drop tears down the context, surface (if any),
/// and terminates the display.
pub struct HeadlessContext {
    egl: khronos_egl::DynamicInstance<khronos_egl::EGL1_4>,
    display: khronos_egl::Display,
    context: khronos_egl::Context,
    /// Pbuffer surface, populated only when the surfaceless path failed.
    surface: Option<khronos_egl::Surface>,
}

impl Drop for HeadlessContext {
    fn drop(&mut self) {
        // Detach the context before teardown so subsequent EGL calls in other
        // threads (if any) don't hit a dangling context.
        let _ = self
            .egl
            .make_current(self.display, None, None, None);
        if let Some(surf) = self.surface.take() {
            let _ = self.egl.destroy_surface(self.display, surf);
        }
        let _ = self.egl.destroy_context(self.display, self.context);
        let _ = self.egl.terminate(self.display);
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Initialise a headless GLES 3.0 context.
///
/// Primary path: surfaceless context (`EGL_KHR_surfaceless_context`).
/// Fallback: 1×1 pbuffer surface.
/// Both fail → `Err` with the specific capability that was missing.
///
/// Returns `(glow::Context, HeadlessContext)`. Keep `HeadlessContext` alive
/// as long as the `glow::Context` is in use — dropping it terminates EGL.
pub fn init() -> anyhow::Result<(glow::Context, HeadlessContext)> {
    // Load libEGL dynamically.
    let egl = unsafe {
        khronos_egl::DynamicInstance::<khronos_egl::EGL1_4>::load_required()
            .context("failed to load libEGL.so")?
    };

    // EGL_DEFAULT_DISPLAY: Mesa finds the DRM device automatically; no
    // Wayland socket or X display needed.
    let display = unsafe { egl.get_display(khronos_egl::DEFAULT_DISPLAY) }
        .ok_or_else(|| {
            anyhow::anyhow!(
                "eglGetDisplay(EGL_DEFAULT_DISPLAY) returned EGL_NO_DISPLAY; \
                 no GPU/DRM device found"
            )
        })?;

    egl.initialize(display).context("eglInitialize failed")?;

    egl.bind_api(khronos_egl::OPENGL_ES_API)
        .context("eglBindAPI(OPENGL_ES_API) failed")?;

    // Request a PBUFFER-capable config so the fallback path can create a
    // pbuffer surface if needed. WINDOW_BIT is omitted because we have no
    // native window.
    #[rustfmt::skip]
    let config_attribs = [
        khronos_egl::RED_SIZE,        8,
        khronos_egl::GREEN_SIZE,      8,
        khronos_egl::BLUE_SIZE,       8,
        khronos_egl::ALPHA_SIZE,      8,
        khronos_egl::DEPTH_SIZE,      0,
        khronos_egl::STENCIL_SIZE,    0,
        khronos_egl::SURFACE_TYPE,    khronos_egl::PBUFFER_BIT,
        khronos_egl::RENDERABLE_TYPE, khronos_egl::OPENGL_ES3_BIT,
        khronos_egl::NONE,
    ];

    let config = egl
        .choose_first_config(display, &config_attribs)
        .context("eglChooseConfig failed")?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no suitable EGL config found for headless GLES3 \
                 (PBUFFER_BIT + OPENGL_ES3_BIT)"
            )
        })?;

    #[rustfmt::skip]
    let ctx_attribs = [
        khronos_egl::CONTEXT_CLIENT_VERSION, 3,
        khronos_egl::NONE,
    ];

    let context = egl
        .create_context(display, config, None, &ctx_attribs)
        .context("eglCreateContext failed")?;

    // --- Primary: surfaceless current (EGL_KHR_surfaceless_context) ----------
    let surface = match egl.make_current(display, None, None, Some(context)) {
        Ok(()) => {
            log::debug!("headless EGL: surfaceless context active (EGL_KHR_surfaceless_context)");
            None
        }
        Err(surfaceless_err) => {
            log::debug!(
                "headless EGL: EGL_KHR_surfaceless_context unavailable ({surfaceless_err:?}), \
                 trying pbuffer fallback"
            );

            // --- Fallback: 1×1 pbuffer surface --------------------------------
            #[rustfmt::skip]
            let pb_attribs = [
                khronos_egl::WIDTH,  1,
                khronos_egl::HEIGHT, 1,
                khronos_egl::NONE,
            ];

            let pb = egl
                .create_pbuffer_surface(display, config, &pb_attribs)
                .map_err(|pb_err| {
                    anyhow::anyhow!(
                        "EGL_KHR_surfaceless_context not supported ({surfaceless_err:?}) \
                         and pbuffer surface creation also failed ({pb_err:?}); \
                         check GPU driver (Mesa ≥ 12 or discrete GPU with EGL headless support)"
                    )
                })?;

            egl.make_current(display, Some(pb), Some(pb), Some(context))
                .map_err(|e| {
                    anyhow::anyhow!(
                        "eglMakeCurrent with pbuffer failed ({e:?}); \
                         headless GPU rendering is not available on this system"
                    )
                })?;

            log::debug!("headless EGL: pbuffer fallback active");
            Some(pb)
        }
    };

    // Build the glow context from the EGL proc address loader.
    let gl = unsafe {
        glow::Context::from_loader_function(|sym| {
            egl.get_proc_address(sym)
                .map_or(std::ptr::null(), |f| f as *const _)
        })
    };

    let handle = HeadlessContext {
        egl,
        display,
        context,
        surface,
    };

    Ok((gl, handle))
}
