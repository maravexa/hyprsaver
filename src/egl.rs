//! `egl.rs` — shared EGL initialisation for Wayland-backed frontends.
//!
//! Used by both the layer-shell daemon (`wayland.rs`) and the windowed preview
//! (`preview.rs`), which create window surfaces on a `wl_display`. The headless
//! `render-preview` path uses `headless_egl.rs` instead (surfaceless / pbuffer,
//! different display acquisition and ownership model) — do not merge the two.

use anyhow::Context;

/// Holds the EGL instance, display, and chosen config. Shared across all surfaces.
pub(crate) struct EglState {
    pub(crate) egl: khronos_egl::DynamicInstance<khronos_egl::EGL1_4>,
    pub(crate) display: khronos_egl::Display,
    pub(crate) config: khronos_egl::Config,
}

impl EglState {
    /// Initialise EGL from the raw Wayland display pointer.
    pub(crate) fn new(display_ptr: *mut std::ffi::c_void) -> anyhow::Result<Self> {
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
