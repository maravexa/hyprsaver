//! `renderer.rs` — OpenGL rendering context and per-frame render loop.
//!
//! Responsibilities:
//! - Own the `glow::Context` and all GPU objects (VAO, VBO, shader program,
//!   LUT textures)
//! - Compile and link vertex + fragment shaders
//! - Upload per-frame uniforms: `u_time`, `u_resolution`, `u_frame`, `u_mouse`,
//!   palette LUT samplers (`u_lut_a/b`), and `u_palette_blend`
//! - Draw the fullscreen quad each frame
//! - Support swapping in a new fragment shader at runtime (hot-reload)
//! - Does NOT know about Wayland — it only speaks OpenGL

use glow::HasContext as _;
use std::time::Instant;

use crate::palette::PaletteEntry;

// ---------------------------------------------------------------------------
// Uniform locations cache
// ---------------------------------------------------------------------------

/// Cached uniform locations for the current shader program.
/// Refreshed whenever the program is relinked.
#[derive(Debug, Default, Clone)]
pub struct UniformLocations {
    pub u_time: Option<glow::UniformLocation>,
    pub u_resolution: Option<glow::UniformLocation>,
    pub u_frame: Option<glow::UniformLocation>,
    pub u_mouse: Option<glow::UniformLocation>,
    // LUT samplers (texture units 1 and 2)
    pub u_lut_a: Option<glow::UniformLocation>,
    pub u_lut_b: Option<glow::UniformLocation>,
    pub u_palette_blend: Option<glow::UniformLocation>,
    // Fade alpha
    pub u_alpha: Option<glow::UniformLocation>,
    // Preview speed/zoom multipliers (uploaded every frame; default 1.0 in daemon mode)
    pub u_speed_scale: Option<glow::UniformLocation>,
    pub u_zoom_scale: Option<glow::UniformLocation>,
}

// ---------------------------------------------------------------------------
// OffscreenTarget — FBO + color texture for offscreen rendering
// ---------------------------------------------------------------------------

/// A framebuffer object with a color texture attachment, used for offscreen
/// rendering passes (e.g. rendering two shaders to textures and crossfading
/// between them on the default framebuffer).
///
/// The texture is allocated as `GL_RGBA8` with `GL_LINEAR` filtering and
/// `GL_CLAMP_TO_EDGE` wrapping. No depth/stencil attachment — these targets
/// are for 2D fullscreen passes only.
///
/// # Lifecycle
/// - `new()` allocates the FBO and color texture
/// - `resize()` reallocates the texture if dimensions changed
/// - `bind()` / `unbind()` switch draw target and viewport
/// - `destroy()` must be called before the GL context is torn down
pub struct OffscreenTarget {
    pub fbo: glow::Framebuffer,
    pub texture: glow::Texture,
    pub width: u32,
    pub height: u32,
}

impl OffscreenTarget {
    /// Create a new offscreen target at the given dimensions.
    ///
    /// # Panics
    /// Panics if GL fails to create the framebuffer or texture, or if the
    /// framebuffer is incomplete after attachment.
    ///
    /// # Safety
    /// The caller must ensure a current GL context is bound on the calling
    /// thread.
    pub fn new(gl: &glow::Context, width: u32, height: u32) -> Self {
        unsafe {
            let fbo = gl
                .create_framebuffer()
                .expect("OffscreenTarget: create_framebuffer failed");
            let texture = gl
                .create_texture()
                .expect("OffscreenTarget: create_texture failed");

            // Allocate color texture storage.
            gl.bind_texture(glow::TEXTURE_2D, Some(texture));
            gl.tex_image_2d(
                glow::TEXTURE_2D,
                0,
                glow::RGBA8 as i32,
                width as i32,
                height as i32,
                0,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                None,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MIN_FILTER,
                glow::LINEAR as i32,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MAG_FILTER,
                glow::LINEAR as i32,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_WRAP_S,
                glow::CLAMP_TO_EDGE as i32,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_WRAP_T,
                glow::CLAMP_TO_EDGE as i32,
            );
            gl.bind_texture(glow::TEXTURE_2D, None);

            // Attach the texture as COLOR_ATTACHMENT0 on the FBO.
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo));
            gl.framebuffer_texture_2d(
                glow::FRAMEBUFFER,
                glow::COLOR_ATTACHMENT0,
                glow::TEXTURE_2D,
                Some(texture),
                0,
            );

            let status = gl.check_framebuffer_status(glow::FRAMEBUFFER);
            if status != glow::FRAMEBUFFER_COMPLETE {
                panic!(
                    "OffscreenTarget: framebuffer incomplete after attachment \
                     (status = 0x{status:04X}, size = {width}x{height})"
                );
            }

            gl.bind_framebuffer(glow::FRAMEBUFFER, None);

            Self {
                fbo,
                texture,
                width,
                height,
            }
        }
    }

    /// Resize the color texture. No-op if the dimensions are unchanged.
    ///
    /// The FBO handle itself is reused; only the backing texture is
    /// reallocated and re-attached.
    pub fn resize(&mut self, gl: &glow::Context, width: u32, height: u32) {
        if width == self.width && height == self.height {
            return;
        }

        unsafe {
            // Drop the old texture.
            gl.delete_texture(self.texture);

            // Create + configure a replacement at the new size.
            let texture = gl
                .create_texture()
                .expect("OffscreenTarget::resize: create_texture failed");
            gl.bind_texture(glow::TEXTURE_2D, Some(texture));
            gl.tex_image_2d(
                glow::TEXTURE_2D,
                0,
                glow::RGBA8 as i32,
                width as i32,
                height as i32,
                0,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                None,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MIN_FILTER,
                glow::LINEAR as i32,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MAG_FILTER,
                glow::LINEAR as i32,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_WRAP_S,
                glow::CLAMP_TO_EDGE as i32,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_WRAP_T,
                glow::CLAMP_TO_EDGE as i32,
            );
            gl.bind_texture(glow::TEXTURE_2D, None);

            // Re-attach the new texture to the existing FBO.
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.fbo));
            gl.framebuffer_texture_2d(
                glow::FRAMEBUFFER,
                glow::COLOR_ATTACHMENT0,
                glow::TEXTURE_2D,
                Some(texture),
                0,
            );

            let status = gl.check_framebuffer_status(glow::FRAMEBUFFER);
            if status != glow::FRAMEBUFFER_COMPLETE {
                panic!(
                    "OffscreenTarget::resize: framebuffer incomplete after reattach \
                     (status = 0x{status:04X}, size = {width}x{height})"
                );
            }

            gl.bind_framebuffer(glow::FRAMEBUFFER, None);

            self.texture = texture;
            self.width = width;
            self.height = height;
        }
    }

    /// Bind this FBO as the current draw target and set the viewport to its
    /// full dimensions.
    pub fn bind(&self, gl: &glow::Context) {
        unsafe {
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.fbo));
            gl.viewport(0, 0, self.width as i32, self.height as i32);
        }
    }

    /// Unbind any offscreen target, restoring the default framebuffer
    /// (window / layer surface). Does not touch the viewport — the caller is
    /// responsible for restoring it if needed.
    pub fn unbind(gl: &glow::Context) {
        unsafe {
            gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        }
    }

    /// Delete the FBO and its color texture. Consumes `self` so the handles
    /// cannot be reused after destruction.
    pub fn destroy(self, gl: &glow::Context) {
        unsafe {
            gl.delete_framebuffer(self.fbo);
            gl.delete_texture(self.texture);
        }
    }
}

// ---------------------------------------------------------------------------
// Composite blend shader (used by TransitionRenderer::render_composite)
// ---------------------------------------------------------------------------

/// GLSL ES 3.20 fragment shader that samples two FBO color textures and
/// linearly blends them using `u_blend` ∈ \[0, 1\]. Paired with
/// [`crate::shaders::VERTEX_SHADER`] (an attribute-less, `gl_VertexID`-driven
/// fullscreen-quad vertex shader) so the composite pass needs no VBO and only
/// an empty VAO bound on the caller's side.
///
/// Sampling uses `gl_FragCoord.xy / u_resolution` rather than a varying so the
/// shader is independent of the vertex shader's UV layout.
pub const COMPOSITE_FRAGMENT_SHADER: &str = r#"#version 320 es
precision mediump float;

uniform sampler2D u_tex_a;
uniform sampler2D u_tex_b;
uniform float u_blend;
uniform vec2 u_resolution;

out vec4 fragColor;

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    vec4 color_a = texture(u_tex_a, uv);
    vec4 color_b = texture(u_tex_b, uv);
    fragColor = mix(color_a, color_b, u_blend);
}
"#;

/// Compile + link the composite blend program from
/// [`crate::shaders::VERTEX_SHADER`] and [`COMPOSITE_FRAGMENT_SHADER`].
///
/// Panics with a descriptive message on any GL error. The composite shader is
/// a built-in (compiled into the binary), so a failure here indicates a driver
/// bug or a build-time regression in the shader source — not a recoverable
/// runtime condition.
fn compile_composite_program(gl: &glow::Context) -> glow::Program {
    unsafe {
        let vert = gl
            .create_shader(glow::VERTEX_SHADER)
            .expect("composite: create vertex shader failed");
        gl.shader_source(vert, crate::shaders::VERTEX_SHADER);
        gl.compile_shader(vert);
        if !gl.get_shader_compile_status(vert) {
            let log = gl.get_shader_info_log(vert);
            gl.delete_shader(vert);
            panic!("composite: vertex shader compile error: {log}");
        }

        let frag = gl
            .create_shader(glow::FRAGMENT_SHADER)
            .expect("composite: create fragment shader failed");
        gl.shader_source(frag, COMPOSITE_FRAGMENT_SHADER);
        gl.compile_shader(frag);
        if !gl.get_shader_compile_status(frag) {
            let log = gl.get_shader_info_log(frag);
            gl.delete_shader(vert);
            gl.delete_shader(frag);
            panic!("composite: fragment shader compile error: {log}");
        }

        let program = gl
            .create_program()
            .expect("composite: create program failed");
        gl.attach_shader(program, vert);
        gl.attach_shader(program, frag);
        gl.link_program(program);
        gl.delete_shader(vert);
        gl.delete_shader(frag);

        if !gl.get_program_link_status(program) {
            let log = gl.get_program_info_log(program);
            gl.delete_program(program);
            panic!("composite: program link error: {log}");
        }

        program
    }
}

// ---------------------------------------------------------------------------
// TransitionRenderer — shader-to-shader crossfade state machine
// ---------------------------------------------------------------------------

/// State of a shader-to-shader crossfade transition.
///
/// Lives inside `TransitionRenderer`. The `Crossfading` variant carries the
/// outgoing shader program handle so the dual-FBO render path knows which
/// program to render into `fbo_a`.
#[derive(Debug)]
pub enum TransitionState {
    /// No transition active — render directly to the default framebuffer.
    Idle,
    /// Crossfading from an outgoing shader to an incoming shader.
    Crossfading {
        /// The outgoing shader's compiled GL program handle.
        ///
        /// `TransitionRenderer` does NOT own this program — its lifecycle is
        /// managed by `ShaderManager`. When the transition completes, the
        /// caller is responsible for releasing it if necessary.
        outgoing_program: glow::Program,
        /// Current eased progress, 0.0 (all outgoing) → 1.0 (all incoming).
        ///
        /// Refreshed by `tick()` each frame and read via `blend_alpha()`.
        /// The value stored here is post-easing; raw linear progress is
        /// recomputed from `started_at` / `duration` on the next tick.
        progress: f32,
        /// Total transition duration, in seconds.
        duration: f32,
        /// Wall-clock instant the transition started. Used by `tick()` to
        /// compute elapsed time.
        started_at: std::time::Instant,
    },
}

/// Drives a crossfade between two fragment shaders by rendering each to its
/// own offscreen target (`fbo_a` = outgoing, `fbo_b` = incoming) and blending
/// them on the default framebuffer.
///
/// `TransitionRenderer` owns the two FBOs but **not** the shader programs —
/// shader program lifecycle stays with `ShaderManager`. The `outgoing_program`
/// stored in `TransitionState::Crossfading` is a borrowed handle.
///
/// # Usage
/// 1. Call `start_transition()` with the program that was previously active
///    when the caller swaps in a new shader.
/// 2. Call `tick()` once per frame. If it returns `true`, the caller should
///    use the dual-FBO render path and composite `fbo_a` + `fbo_b` using
///    `blend_alpha()` as the blend factor.
/// 3. When it returns `false`, the transition is either idle or just
///    finished; fall back to the normal single-pass render path.
pub struct TransitionRenderer {
    /// Current transition state.
    pub state: TransitionState,
    /// Offscreen target for the outgoing shader.
    pub fbo_a: OffscreenTarget,
    /// Offscreen target for the incoming shader.
    pub fbo_b: OffscreenTarget,
    /// Default transition duration in seconds (from config). Used when
    /// `start_transition()` is called without an explicit override.
    pub default_duration: f32,
    /// Compiled + linked composite blend program. Owned by this renderer and
    /// released by [`TransitionRenderer::destroy`].
    pub composite_program: glow::Program,
    /// `u_tex_a` (sampler2D, unit 0 — `fbo_a` color texture).
    pub loc_tex_a: glow::UniformLocation,
    /// `u_tex_b` (sampler2D, unit 1 — `fbo_b` color texture).
    pub loc_tex_b: glow::UniformLocation,
    /// `u_blend` (float, current eased crossfade alpha).
    pub loc_blend: glow::UniformLocation,
    /// `u_resolution` (vec2, target framebuffer pixel dimensions).
    pub loc_resolution: glow::UniformLocation,
}

impl TransitionRenderer {
    /// Create a new `TransitionRenderer` with two offscreen targets at the
    /// given dimensions. Initial state is `Idle`.
    ///
    /// # Safety
    /// The caller must ensure a current GL context is bound on the calling
    /// thread.
    pub fn new(gl: &glow::Context, width: u32, height: u32, default_duration: f32) -> Self {
        let composite_program = compile_composite_program(gl);

        // Look up all four uniform locations. The composite shader uses every
        // uniform unconditionally, so a missing location indicates a driver
        // bug rather than a recoverable condition — panic with a clear name.
        let (loc_tex_a, loc_tex_b, loc_blend, loc_resolution) = unsafe {
            let tex_a = gl
                .get_uniform_location(composite_program, "u_tex_a")
                .expect("composite: u_tex_a uniform location missing");
            let tex_b = gl
                .get_uniform_location(composite_program, "u_tex_b")
                .expect("composite: u_tex_b uniform location missing");
            let blend = gl
                .get_uniform_location(composite_program, "u_blend")
                .expect("composite: u_blend uniform location missing");
            let resolution = gl
                .get_uniform_location(composite_program, "u_resolution")
                .expect("composite: u_resolution uniform location missing");
            (tex_a, tex_b, blend, resolution)
        };

        Self {
            state: TransitionState::Idle,
            fbo_a: OffscreenTarget::new(gl, width, height),
            fbo_b: OffscreenTarget::new(gl, width, height),
            default_duration,
            composite_program,
            loc_tex_a,
            loc_tex_b,
            loc_blend,
            loc_resolution,
        }
    }

    /// Begin a crossfade toward a new shader.
    ///
    /// * `outgoing_program` — the shader program that was active before the
    ///   swap; its output will be rendered into `fbo_a` for the duration of
    ///   the transition.
    /// * `duration` — optional override for the transition length in seconds.
    ///   When `None`, falls back to `self.default_duration`.
    ///
    /// If the renderer is already in `Crossfading`, the in-flight transition
    /// is snapped to complete instantly (its outgoing program handle is
    /// dropped from this struct — `ShaderManager` remains responsible for
    /// the old handle's lifecycle) before the new transition begins.
    pub fn start_transition(&mut self, outgoing_program: glow::Program, duration: Option<f32>) {
        if matches!(self.state, TransitionState::Crossfading { .. }) {
            // Complete the in-flight transition instantly. We intentionally
            // do NOT delete the old outgoing program here — it is owned by
            // ShaderManager. Dropping the enum variant forgets the handle.
            self.state = TransitionState::Idle;
        }

        let duration = duration.unwrap_or(self.default_duration);
        self.state = TransitionState::Crossfading {
            outgoing_program,
            progress: 0.0,
            duration,
            started_at: std::time::Instant::now(),
        };
    }

    /// Advance the transition clock. Call once per frame.
    ///
    /// Returns:
    /// - `false` when `Idle`, or when the transition has just completed on
    ///   this tick (state is moved back to `Idle`).
    /// - `true` while a crossfade is active; the caller should use the
    ///   dual-FBO render path and composite using `blend_alpha()`.
    ///
    /// Applies smoothstep easing (`3t² − 2t³`) to the linear progress before
    /// storing it. A non-positive `duration` is treated as an instant
    /// transition and moves the state to `Idle` on the next tick.
    pub fn tick(&mut self) -> bool {
        // Copy out the Copy fields we need so the read borrow ends before we
        // potentially overwrite `self.state` below.
        let (duration, started_at) = match &self.state {
            TransitionState::Idle => return false,
            TransitionState::Crossfading {
                duration,
                started_at,
                ..
            } => (*duration, *started_at),
        };

        let elapsed = started_at.elapsed().as_secs_f32();
        let raw = if duration <= 0.0 {
            1.0
        } else {
            elapsed / duration
        };
        let clamped = raw.clamp(0.0, 1.0);

        if clamped >= 1.0 {
            self.state = TransitionState::Idle;
            return false;
        }

        // Smoothstep easing.
        let eased = clamped * clamped * (3.0 - 2.0 * clamped);
        if let TransitionState::Crossfading { progress, .. } = &mut self.state {
            *progress = eased;
        }
        true
    }

    /// Resize both offscreen targets. Per-FBO no-op if dimensions are
    /// unchanged.
    pub fn resize(&mut self, gl: &glow::Context, width: u32, height: u32) {
        self.fbo_a.resize(gl, width, height);
        self.fbo_b.resize(gl, width, height);
    }

    /// Release both offscreen targets and the composite blend program.
    /// Consumes `self`.
    ///
    /// Does NOT delete any *content* shader program (the user-facing fractal
    /// shaders are owned by `ShaderManager`). If the renderer is still in
    /// `Crossfading`, the caller is responsible for flagging the outgoing
    /// program for cleanup via `ShaderManager` — this method simply drops
    /// the enum variant and forgets the handle.
    pub fn destroy(self, gl: &glow::Context) {
        unsafe {
            gl.delete_program(self.composite_program);
        }
        self.fbo_a.destroy(gl);
        self.fbo_b.destroy(gl);
    }

    /// Returns `true` if a crossfade is currently in progress.
    pub fn is_transitioning(&self) -> bool {
        matches!(self.state, TransitionState::Crossfading { .. })
    }

    /// Current eased blend factor, in `[0.0, 1.0]`. Returns `0.0` when idle.
    ///
    /// Reflects the value most recently stored by `tick()`; call `tick()`
    /// before reading this each frame so the value is fresh.
    pub fn blend_alpha(&self) -> f32 {
        match self.state {
            TransitionState::Idle => 0.0,
            TransitionState::Crossfading { progress, .. } => progress,
        }
    }

    /// Composite `fbo_a` and `fbo_b` onto the default framebuffer using the
    /// linear blend program. Uses `blend_alpha()` as the mix factor: `0.0`
    /// outputs purely `fbo_a`, `1.0` outputs purely `fbo_b`.
    ///
    /// The caller must have a VAO bound that supplies four vertices for a
    /// `TRIANGLE_STRIP` draw — the composite shader is paired with
    /// [`crate::shaders::VERTEX_SHADER`], which is attribute-less and uses
    /// `gl_VertexID`, so an empty VAO is sufficient.
    ///
    /// Leaves the active texture unit at `TEXTURE0` and the default
    /// framebuffer bound when it returns.
    ///
    /// # Safety
    /// The caller must ensure a current GL context is bound on the calling
    /// thread.
    pub fn render_composite(&self, gl: &glow::Context, width: u32, height: u32) {
        unsafe {
            // Bind default framebuffer (screen) and set viewport.
            OffscreenTarget::unbind(gl);
            gl.viewport(0, 0, width as i32, height as i32);

            gl.use_program(Some(self.composite_program));

            // Bind fbo_a texture to unit 0.
            gl.active_texture(glow::TEXTURE0);
            gl.bind_texture(glow::TEXTURE_2D, Some(self.fbo_a.texture));
            gl.uniform_1_i32(Some(&self.loc_tex_a), 0);

            // Bind fbo_b texture to unit 1.
            gl.active_texture(glow::TEXTURE1);
            gl.bind_texture(glow::TEXTURE_2D, Some(self.fbo_b.texture));
            gl.uniform_1_i32(Some(&self.loc_tex_b), 1);

            // Set blend alpha (eased crossfade progress).
            gl.uniform_1_f32(Some(&self.loc_blend), self.blend_alpha());

            // Set target resolution.
            gl.uniform_2_f32(Some(&self.loc_resolution), width as f32, height as f32);

            // Draw fullscreen quad — paired vertex shader is attribute-less
            // and uses gl_VertexID with TRIANGLE_STRIP / 4 verts.
            gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);

            // Reset active texture unit so subsequent passes start from a
            // known state.
            gl.active_texture(glow::TEXTURE0);
        }
    }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/// Default crossfade duration, in seconds, used when `start_shader_transition`
/// is called without an explicit duration. Can be overridden per-call.
pub const DEFAULT_SHADER_TRANSITION_SECONDS: f32 = 2.0;

/// Owns all GL state for rendering fractal shaders onto a fullscreen quad.
pub struct Renderer {
    /// The glow OpenGL context. Not Send — must stay on the GL thread.
    gl: glow::Context,

    /// Compiled + linked shader program (vert + frag).
    program: Option<glow::Program>,

    /// Vertex Array Object for the fullscreen quad.
    vao: Option<glow::VertexArray>,

    /// Vertex Buffer Object for the fullscreen quad.
    vbo: Option<glow::Buffer>,

    /// Cached uniform locations for `program`.
    uniforms: UniformLocations,

    /// Frame counter (incremented each call to `render()`).
    frame: u64,

    /// Wall-clock time when `new()` was called, for `u_time` computation.
    start_time: Instant,

    /// Last known mouse position in window-space pixels.
    mouse_pos: [f32; 2],

    // ------------------------------------------------------------------
    // Palette state
    // ------------------------------------------------------------------
    /// LUT texture for the current palette (texture unit 1).
    /// Cosine palettes are pre-baked to 256-sample LUTs on the CPU before upload.
    lut_texture_a: Option<glow::Texture>,
    /// LUT texture for the transition target (texture unit 2; `None` = same as A).
    lut_texture_b: Option<glow::Texture>,

    /// Blend factor: 0.0 = pure A, 1.0 = pure B.
    palette_blend: f32,

    /// Fade alpha: 0.0 = fully transparent, 1.0 = fully opaque.
    /// Multiplied into the final fragColor for fade in/out.
    alpha: f32,

    /// Preview speed multiplier (u_speed_scale). Default 1.0; no effect in daemon mode.
    speed_scale: f32,
    /// Preview zoom multiplier (u_zoom_scale). Default 1.0; no effect in daemon mode.
    zoom_scale: f32,

    // ------------------------------------------------------------------
    // Shader crossfade state (integrated TransitionRenderer)
    // ------------------------------------------------------------------
    /// Offscreen render targets + composite pass used during shader crossfades.
    /// Wrapped in `Option` so `destroy()` can move it out (its own `destroy`
    /// method consumes `self`). In practice this is always `Some` between
    /// `Renderer::new()` and `Renderer::destroy()`.
    transition: Option<TransitionRenderer>,

    /// Uniform locations cached for the outgoing shader program during a
    /// crossfade. GLSL uniform locations are per-program, so the incoming
    /// program's locations in `self.uniforms` are NOT usable for the outgoing
    /// draw pass — this snapshot is populated by `start_shader_transition()`
    /// from `self.uniforms` at the moment of the swap.
    outgoing_uniforms: UniformLocations,

    /// `start_time.elapsed()` at the moment the current shader program was
    /// loaded.  Subtracted from the current elapsed time before uploading
    /// `u_time` so every shader sees time starting near 0.0 on its first
    /// frame, regardless of how long the renderer has been alive.
    shader_start_elapsed: f32,

    /// Same as `shader_start_elapsed` but captured for the *outgoing* program
    /// at the start of a crossfade so it keeps consistent time during the
    /// transition.
    outgoing_start_elapsed: f32,

}

/// Hardcoded GLSL ES 3.20 vertex shader source. Passes UV coordinates (0..1) to the fragment
/// shader as `v_uv`. The fullscreen quad fills NDC space entirely.
pub const VERT_SRC: &str = r#"#version 320 es
precision highp float;

layout(location = 0) in vec2 a_pos;

out vec2 v_uv;

void main() {
    // a_pos is in NDC (-1..1); remap to UV (0..1) for the fragment shader.
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
"#;

/// NDC coordinates of two triangles forming a fullscreen quad.
/// Layout: (x, y) — 6 vertices × 2 floats.
#[rustfmt::skip]
const QUAD_VERTS: &[f32] = &[
    -1.0, -1.0,
     1.0, -1.0,
     1.0,  1.0,
    -1.0, -1.0,
     1.0,  1.0,
    -1.0,  1.0,
];

impl Renderer {
    /// Create a new renderer. Uploads the fullscreen quad geometry.
    ///
    /// # Safety
    /// The caller must ensure a current GL context is bound on the calling thread.
    pub fn new(gl: glow::Context) -> anyhow::Result<Self> {
        let (vao, vbo) = unsafe {
            let vao = gl
                .create_vertex_array()
                .map_err(|e| anyhow::anyhow!("create VAO: {e}"))?;
            gl.bind_vertex_array(Some(vao));

            let vbo = gl
                .create_buffer()
                .map_err(|e| anyhow::anyhow!("create VBO: {e}"))?;
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(vbo));

            let bytes = bytemuck::cast_slice(QUAD_VERTS);
            gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, bytes, glow::STATIC_DRAW);

            gl.enable_vertex_attrib_array(0);
            gl.vertex_attrib_pointer_f32(0, 2, glow::FLOAT, false, 8, 0);

            gl.bind_vertex_array(None);
            gl.bind_buffer(glow::ARRAY_BUFFER, None);

            (vao, vbo)
        };

        unsafe {
            gl.clear_color(0.0, 0.0, 0.0, 1.0);
        }

        // Run a one-shot FBO sanity check at startup so any GL driver quirks
        // surface early, before we care about frame timing.
        Self::debug_sanity_check_fbo(&gl);

        // Allocate the shader crossfade infrastructure with placeholder
        // dimensions. `render()` calls `TransitionRenderer::resize()` every
        // frame, which is a no-op when dimensions are unchanged, so the FBOs
        // will snap to the real surface size on the first frame.
        let transition = TransitionRenderer::new(&gl, 1, 1, DEFAULT_SHADER_TRANSITION_SECONDS);

        Ok(Self {
            gl,
            program: None,
            vao: Some(vao),
            vbo: Some(vbo),
            uniforms: UniformLocations::default(),
            frame: 0,
            start_time: Instant::now(),
            mouse_pos: [0.0, 0.0],
            lut_texture_a: None,
            lut_texture_b: None,
            palette_blend: 0.0,
            alpha: 1.0,
            speed_scale: 1.0,
            zoom_scale: 1.0,
            transition: Some(transition),
            outgoing_uniforms: UniformLocations::default(),
            shader_start_elapsed: 0.0,
            outgoing_start_elapsed: 0.0,
        })
    }

    /// Compile and link a new shader program from the given fragment source.
    /// On success replaces `self.program` and refreshes `self.uniforms`.
    /// On compile/link error, logs the error and returns Err — caller decides whether to fallback.
    pub fn load_shader(&mut self, frag_src: &str) -> anyhow::Result<()> {
        let vert = self.compile_shader(glow::VERTEX_SHADER, VERT_SRC)?;
        let frag = match self.compile_shader(glow::FRAGMENT_SHADER, frag_src) {
            Ok(s) => s,
            Err(e) => {
                unsafe { self.gl.delete_shader(vert) };
                return Err(e);
            }
        };

        let program = unsafe {
            let prog = self
                .gl
                .create_program()
                .map_err(|e| anyhow::anyhow!("create program: {e}"))?;
            self.gl.attach_shader(prog, vert);
            self.gl.attach_shader(prog, frag);
            self.gl.link_program(prog);

            self.gl.delete_shader(vert);
            self.gl.delete_shader(frag);

            if !self.gl.get_program_link_status(prog) {
                let log = self.gl.get_program_info_log(prog);
                self.gl.delete_program(prog);
                return Err(anyhow::anyhow!("shader link error: {log}"));
            }
            prog
        };

        if let Some(old) = self.program.take() {
            unsafe { self.gl.delete_program(old) };
        }
        self.program = Some(program);
        self.shader_start_elapsed = self.start_time.elapsed().as_secs_f32();
        self.refresh_uniform_locations();

        log::debug!("Shader loaded successfully");
        Ok(())
    }

    /// Begin a crossfade transition from the currently-loaded shader to a new
    /// one compiled from `frag_src`.
    ///
    /// Compilation and linking are attempted **before** any state mutation.
    /// On compile/link failure the current program, uniform cache, and
    /// transition state are left untouched and `Err` is returned — the caller
    /// can keep rendering the old shader unchanged.
    ///
    /// On success:
    /// 1. The previous program is preserved as the transition's outgoing
    ///    shader (rendered into `fbo_a` until `tick()` completes).
    /// 2. The current uniform location cache is snapshotted into
    ///    `outgoing_uniforms` — GLSL uniform locations are per-program, so
    ///    the incoming program's locations (refreshed in the next step)
    ///    are NOT valid for the outgoing draw pass.
    /// 3. The new program is installed and its uniform locations are cached.
    /// 4. [`TransitionRenderer::start_transition`] is invoked; `tick()` drives
    ///    the crossfade to completion on subsequent frames.
    ///
    /// When a transition is already in flight, its previous outgoing program
    /// is deleted here rather than leaking — `TransitionRenderer` intentionally
    /// does not own program handles.
    ///
    /// `duration` overrides the default crossfade length in seconds; when
    /// `None`, the transition renderer's configured default is used
    /// ([`DEFAULT_SHADER_TRANSITION_SECONDS`]).
    ///
    /// If no program is currently loaded, or the transition renderer failed
    /// to initialise, this falls back to the normal [`Renderer::load_shader`]
    /// path (instant swap, no crossfade).
    pub fn start_shader_transition(
        &mut self,
        frag_src: &str,
        duration: Option<f32>,
    ) -> anyhow::Result<()> {
        // Nothing to cross-fade from → fall back to the normal swap.
        let Some(outgoing_program) = self.program else {
            return self.load_shader(frag_src);
        };
        if self.transition.is_none() {
            return self.load_shader(frag_src);
        }

        // --- Compile + link the incoming shader ---
        // Done first so a compile error leaves all state untouched.
        let vert = self.compile_shader(glow::VERTEX_SHADER, VERT_SRC)?;
        let frag = match self.compile_shader(glow::FRAGMENT_SHADER, frag_src) {
            Ok(s) => s,
            Err(e) => {
                unsafe { self.gl.delete_shader(vert) };
                return Err(e);
            }
        };
        let new_program = unsafe {
            let prog = self
                .gl
                .create_program()
                .map_err(|e| anyhow::anyhow!("create program: {e}"))?;
            self.gl.attach_shader(prog, vert);
            self.gl.attach_shader(prog, frag);
            self.gl.link_program(prog);
            self.gl.delete_shader(vert);
            self.gl.delete_shader(frag);
            if !self.gl.get_program_link_status(prog) {
                let log = self.gl.get_program_info_log(prog);
                self.gl.delete_program(prog);
                return Err(anyhow::anyhow!("shader link error: {log}"));
            }
            prog
        };

        // If a transition was already in-flight, release its outgoing program
        // before it gets overwritten — TransitionRenderer does not own program
        // handles, so dropping the enum variant on the floor would leak.
        let prev_outgoing = self.transition.as_ref().and_then(|t| {
            if let TransitionState::Crossfading {
                outgoing_program, ..
            } = &t.state
            {
                Some(*outgoing_program)
            } else {
                None
            }
        });
        if let Some(prev) = prev_outgoing {
            unsafe { self.gl.delete_program(prev) };
            log::debug!("start_shader_transition: released previous outgoing program");
        }

        // Snapshot the current (soon-to-be outgoing) uniform locations and
        // install the new program + its uniform locations. The outgoing
        // snapshot must happen BEFORE refresh_uniform_locations overwrites
        // self.uniforms with the incoming program's locations.
        self.outgoing_uniforms = std::mem::take(&mut self.uniforms);
        self.outgoing_start_elapsed = self.shader_start_elapsed;
        self.program = Some(new_program);
        self.shader_start_elapsed = self.start_time.elapsed().as_secs_f32();
        self.refresh_uniform_locations();

        // Kick off the transition state machine. The outgoing program handle
        // stays alive inside `TransitionState::Crossfading` until `tick()`
        // completes it in `render()`.
        if let Some(t) = self.transition.as_mut() {
            t.start_transition(outgoing_program, duration);
        }

        log::info!(
            "Shader transition started ({})",
            duration
                .map(|d| format!("{d:.2}s"))
                .unwrap_or_else(|| "default duration".to_string())
        );
        Ok(())
    }

    /// Set the active palette. Replaces the current palette A, resets blend to 0.
    ///
    /// Cosine palettes are pre-baked to a 256-sample LUT on the CPU before upload.
    /// All palette types are stored as a 256×1 RGBA8 texture on texture unit 1.
    pub fn set_palette(&mut self, entry: &PaletteEntry) -> anyhow::Result<()> {
        let old_a = self.lut_texture_a.take();
        let old_b = self.lut_texture_b.take();
        self.delete_texture(old_a);
        self.delete_texture(old_b);
        self.palette_blend = 0.0;

        let lut = entry.to_lut();
        self.lut_texture_a = Some(self.upload_lut(&lut)?);
        Ok(())
    }

    /// Begin a cross-fade transition toward `next`.
    ///
    /// Uploads the next palette as a pre-baked LUT on texture unit 2.
    /// The caller must update `palette_blend` every frame via `set_blend()`.
    pub fn begin_transition(&mut self, next: &PaletteEntry) -> anyhow::Result<()> {
        let old_b = self.lut_texture_b.take();
        self.delete_texture(old_b);
        let lut = next.to_lut();
        self.lut_texture_b = Some(self.upload_lut(&lut)?);
        Ok(())
    }

    /// Update the current blend factor. Call this each frame during a transition.
    pub fn set_blend(&mut self, blend: f32) {
        self.palette_blend = blend.clamp(0.0, 1.0);
    }

    /// Update the fade alpha. 0.0 = fully transparent, 1.0 = fully opaque.
    pub fn set_alpha(&mut self, alpha: f32) {
        self.alpha = alpha.clamp(0.0, 1.0);
    }

    /// Set the speed multiplier forwarded to `u_speed_scale` each frame.
    /// Values below 0.01 are clamped. Pass 1.0 to disable (daemon mode default).
    pub fn set_speed_scale(&mut self, s: f32) {
        self.speed_scale = s.max(0.01);
    }

    /// Set the zoom multiplier forwarded to `u_zoom_scale` each frame.
    /// Values below 0.01 are clamped. Pass 1.0 to disable (daemon mode default).
    pub fn set_zoom_scale(&mut self, z: f32) {
        self.zoom_scale = z.max(0.01);
    }

    /// Update the last known mouse position (window-space pixels, origin top-left).
    pub fn set_mouse(&mut self, x: f32, y: f32) {
        self.mouse_pos = [x, y];
    }

    /// Render one frame. Uploads all uniforms and calls `glDrawArrays`.
    ///
    /// * `resolution` — physical pixel dimensions `[width, height]` of the target surface.
    ///
    /// Two render paths:
    /// - **No transition active**: identical to the pre-0.4 single-pass path —
    ///   viewport → clear → draw shader to the default framebuffer. Zero FBO
    ///   overhead, which matters because this is the hot path.
    /// - **Transition active** (set by [`Renderer::start_shader_transition`]):
    ///   render the outgoing shader to `fbo_a`, the incoming shader to
    ///   `fbo_b`, then composite both onto the default framebuffer with the
    ///   eased crossfade alpha.
    pub fn render(&mut self, resolution: [f32; 2]) {
        let width = (resolution[0] as u32).max(1);
        let height = (resolution[1] as u32).max(1);

        // Resize FBOs to match the current surface. Both calls are no-ops if
        // dimensions are unchanged, so this is cheap on the hot path.
        if let Some(t) = self.transition.as_mut() {
            t.resize(&self.gl, width, height);
        }

        // Snapshot the outgoing program handle BEFORE tick(): if tick()
        // completes the transition on this frame, it moves state back to Idle
        // and the handle would otherwise be lost here.
        let outgoing_before_tick = self.transition.as_ref().and_then(|t| {
            if let TransitionState::Crossfading {
                outgoing_program, ..
            } = &t.state
            {
                Some(*outgoing_program)
            } else {
                None
            }
        });
        let transitioning = self.transition.as_mut().map(|t| t.tick()).unwrap_or(false);

        // Transition just completed on this frame: release the outgoing
        // program and drop its cached uniform locations. Logged so the manual
        // debug trigger is visible in RUST_LOG=hyprsaver=info.
        if outgoing_before_tick.is_some() && !transitioning {
            if let Some(prev) = outgoing_before_tick {
                unsafe { self.gl.delete_program(prev) };
            }
            self.outgoing_uniforms = UniformLocations::default();
            log::info!("Shader transition complete (outgoing program released)");
        }

        let elapsed = self.start_time.elapsed().as_secs_f32();
        let frame = self.frame;

        if transitioning {
            self.render_with_transition(resolution, elapsed, frame);
        } else {
            unsafe {
                self.gl
                    .viewport(0, 0, resolution[0] as i32, resolution[1] as i32);
                self.gl.clear(glow::COLOR_BUFFER_BIT);
            }
            if let Some(program) = self.program {
                // Clone because draw_program_with takes &UniformLocations by
                // reference and we're inside &mut self — the borrow checker
                // won't let us pass &self.uniforms while also needing &self
                // to call the helper on. UniformLocations is a small struct
                // of Options so the clone is cheap.
                let uniforms = self.uniforms.clone();
                self.draw_program_with(
                    program,
                    &uniforms,
                    resolution,
                    elapsed,
                    self.shader_start_elapsed,
                    frame,
                );
            }
        }

        self.frame += 1;
    }

    /// Dual-FBO render path, used only when a shader crossfade is active.
    ///
    /// Renders the outgoing shader into `fbo_a`, the incoming shader into
    /// `fbo_b`, then composites both onto the default framebuffer via
    /// [`TransitionRenderer::render_composite`]. Both passes upload the same
    /// time/resolution/palette/etc. uniforms — per-shader palette during a
    /// transition is a future enhancement (see docs/0.1d prompt).
    fn render_with_transition(&self, resolution: [f32; 2], elapsed: f32, frame: u64) {
        let Some(incoming_program) = self.program else {
            return;
        };
        let Some(transition) = self.transition.as_ref() else {
            return;
        };
        let outgoing_program = match &transition.state {
            TransitionState::Crossfading {
                outgoing_program, ..
            } => *outgoing_program,
            TransitionState::Idle => return,
        };

        // ---- Outgoing → fbo_a ----
        transition.fbo_a.bind(&self.gl);
        unsafe {
            self.gl.clear(glow::COLOR_BUFFER_BIT);
        }
        // outgoing_uniforms was captured from self.uniforms at the moment
        // start_shader_transition() was called; those locations are the only
        // ones valid for the outgoing program.
        let out_uniforms = self.outgoing_uniforms.clone();
        self.draw_program_with(
            outgoing_program,
            &out_uniforms,
            resolution,
            elapsed,
            self.outgoing_start_elapsed,
            frame,
        );

        // ---- Incoming → fbo_b ----
        transition.fbo_b.bind(&self.gl);
        unsafe {
            self.gl.clear(glow::COLOR_BUFFER_BIT);
        }
        let in_uniforms = self.uniforms.clone();
        self.draw_program_with(
            incoming_program,
            &in_uniforms,
            resolution,
            elapsed,
            self.shader_start_elapsed,
            frame,
        );

        // ---- Composite to default framebuffer ----
        // render_composite internally unbinds the FBO and sets the viewport
        // to `width × height` before drawing the blend pass. It requires a
        // VAO to be bound even though the composite vertex shader is
        // attribute-less (GLES 3.20 does not allow an unbound VAO for draw
        // calls) — draw_program_with left `self.vao` unbound on exit, so we
        // re-bind it here.
        unsafe {
            self.gl.bind_vertex_array(self.vao);
        }
        transition.render_composite(&self.gl, resolution[0] as u32, resolution[1] as u32);
        unsafe {
            self.gl.bind_vertex_array(None);
        }
    }

    /// Upload all per-frame uniforms and issue the fullscreen-quad draw for
    /// the given program, using the given cached uniform location set.
    ///
    /// Factored out of `render()` so both the single-pass path and the
    /// dual-FBO transition path can share the exact same uniform upload and
    /// draw logic. Takes an explicit `&UniformLocations` parameter because
    /// locations are per-program: during a transition the outgoing shader
    /// must use `self.outgoing_uniforms` rather than `self.uniforms`.
    ///
    /// `shader_start_elapsed` is subtracted from `elapsed` before uploading
    /// `u_time` so that each shader sees time starting near 0.0 on its first
    /// frame.  Pass `self.shader_start_elapsed` for the incoming/normal shader
    /// and `self.outgoing_start_elapsed` for the outgoing shader during a
    /// crossfade.
    fn draw_program_with(
        &self,
        program: glow::Program,
        uniforms: &UniformLocations,
        resolution: [f32; 2],
        elapsed: f32,
        shader_start_elapsed: f32,
        frame: u64,
    ) {
        unsafe {
            self.gl.use_program(Some(program));

            // Time / resolution / frame / mouse
            // Upload shader-relative time (0.0 on the first frame after load)
            // so cycle-based shaders always start at phase 0.
            if let Some(ref loc) = uniforms.u_time {
                self.gl
                    .uniform_1_f32(Some(loc), elapsed - shader_start_elapsed);
            }
            if let Some(ref loc) = uniforms.u_resolution {
                self.gl
                    .uniform_2_f32(Some(loc), resolution[0], resolution[1]);
            }
            if let Some(ref loc) = uniforms.u_frame {
                self.gl.uniform_1_i32(Some(loc), frame as i32);
            }
            if let Some(ref loc) = uniforms.u_mouse {
                self.gl
                    .uniform_2_f32(Some(loc), self.mouse_pos[0], self.mouse_pos[1]);
            }

            // Palette blend factor (always uploaded)
            if let Some(ref loc) = uniforms.u_palette_blend {
                self.gl.uniform_1_f32(Some(loc), self.palette_blend);
            }

            // Fade alpha (always uploaded)
            if let Some(ref loc) = uniforms.u_alpha {
                self.gl.uniform_1_f32(Some(loc), self.alpha);
            }

            // Speed / zoom multipliers (default 1.0 — no behavioral change in daemon mode)
            if let Some(ref loc) = uniforms.u_speed_scale {
                self.gl.uniform_1_f32(Some(loc), self.speed_scale);
            }
            if let Some(ref loc) = uniforms.u_zoom_scale {
                self.gl.uniform_1_f32(Some(loc), self.zoom_scale);
            }

            // All palettes are pre-baked to LUT on the CPU. Always sample via texture.
            // Texture unit 1 → u_lut_a (current)
            self.gl.active_texture(glow::TEXTURE1);
            self.gl.bind_texture(glow::TEXTURE_2D, self.lut_texture_a);
            if let Some(ref loc) = uniforms.u_lut_a {
                self.gl.uniform_1_i32(Some(loc), 1);
            }
            // Texture unit 2 → u_lut_b (fall back to A when not transitioning)
            self.gl.active_texture(glow::TEXTURE2);
            let tex_b = self.lut_texture_b.or(self.lut_texture_a);
            self.gl.bind_texture(glow::TEXTURE_2D, tex_b);
            if let Some(ref loc) = uniforms.u_lut_b {
                self.gl.uniform_1_i32(Some(loc), 2);
            }
            // Reset active texture unit to 0
            self.gl.active_texture(glow::TEXTURE0);

            self.gl.bind_vertex_array(self.vao);
            self.gl.draw_arrays(glow::TRIANGLES, 0, 6);
            self.gl.bind_vertex_array(None);
        }
    }

    /// Reset `start_time` so `u_time` starts from 0.0 again on the next frame.
    pub fn reset_time(&mut self) {
        self.start_time = Instant::now();
        self.shader_start_elapsed = 0.0;
    }

    /// Return a reference to the underlying glow context.
    pub fn gl(&self) -> &glow::Context {
        &self.gl
    }

    /// Render a single frame of `frag_src` at the given time into a temporary
    /// 64×64 FBO and return the RGBA8 pixel data (64*64*4 = 16384 bytes).
    ///
    /// This compiles a temporary shader program, renders one frame, reads back
    /// the pixels, and cleans up. The renderer's own program and state are
    /// preserved.
    pub fn render_thumbnail(&mut self, frag_src: &str, time: f32) -> Option<Vec<u8>> {
        let size: u32 = 64;

        // Compile temp program
        let vert = self.compile_shader(glow::VERTEX_SHADER, VERT_SRC).ok()?;
        let frag = match self.compile_shader(glow::FRAGMENT_SHADER, frag_src) {
            Ok(f) => f,
            Err(_) => {
                unsafe { self.gl.delete_shader(vert) };
                return None;
            }
        };

        let prog = unsafe {
            let p = self.gl.create_program().ok()?;
            self.gl.attach_shader(p, vert);
            self.gl.attach_shader(p, frag);
            self.gl.link_program(p);
            self.gl.delete_shader(vert);
            self.gl.delete_shader(frag);
            if !self.gl.get_program_link_status(p) {
                self.gl.delete_program(p);
                return None;
            }
            p
        };

        // Create temp FBO
        let fbo = unsafe { self.gl.create_framebuffer().ok()? };
        let tex = unsafe { self.gl.create_texture().ok()? };
        unsafe {
            self.gl.bind_texture(glow::TEXTURE_2D, Some(tex));
            self.gl.tex_image_2d(
                glow::TEXTURE_2D,
                0,
                glow::RGBA8 as i32,
                size as i32,
                size as i32,
                0,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                None,
            );
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MIN_FILTER,
                glow::LINEAR as i32,
            );
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MAG_FILTER,
                glow::LINEAR as i32,
            );
            self.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo));
            self.gl.framebuffer_texture_2d(
                glow::FRAMEBUFFER,
                glow::COLOR_ATTACHMENT0,
                glow::TEXTURE_2D,
                Some(tex),
                0,
            );
        }

        // Get uniform locations for the temp program
        let uniforms = unsafe {
            UniformLocations {
                u_time: self.gl.get_uniform_location(prog, "u_time"),
                u_resolution: self.gl.get_uniform_location(prog, "u_resolution"),
                u_frame: self.gl.get_uniform_location(prog, "u_frame"),
                u_mouse: self.gl.get_uniform_location(prog, "u_mouse"),
                u_lut_a: self.gl.get_uniform_location(prog, "u_lut_a"),
                u_lut_b: self.gl.get_uniform_location(prog, "u_lut_b"),
                u_palette_blend: self.gl.get_uniform_location(prog, "u_palette_blend"),
                u_alpha: self.gl.get_uniform_location(prog, "u_alpha"),
                u_speed_scale: self.gl.get_uniform_location(prog, "u_speed_scale"),
                u_zoom_scale: self.gl.get_uniform_location(prog, "u_zoom_scale"),
            }
        };

        // Render one frame
        unsafe {
            self.gl.viewport(0, 0, size as i32, size as i32);
            self.gl.clear(glow::COLOR_BUFFER_BIT);
        }
        self.draw_program_with(prog, &uniforms, [size as f32, size as f32], time, 0.0, 0);

        // Read pixels
        let mut pixels = vec![0u8; (size * size * 4) as usize];
        unsafe {
            self.gl.read_pixels(
                0,
                0,
                size as i32,
                size as i32,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelPackData::Slice(&mut pixels),
            );
        }

        // OpenGL reads bottom-up; flip vertically for egui (top-down)
        let row_bytes = (size * 4) as usize;
        for y in 0..(size as usize / 2) {
            let top = y * row_bytes;
            let bot = ((size as usize) - 1 - y) * row_bytes;
            for x in 0..row_bytes {
                pixels.swap(top + x, bot + x);
            }
        }

        // Cleanup
        unsafe {
            self.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
            self.gl.delete_framebuffer(fbo);
            self.gl.delete_texture(tex);
            self.gl.delete_program(prog);
        }

        Some(pixels)
    }

    /// Release all GPU resources. Must be called before the GL context is destroyed.
    pub fn destroy(&mut self) {
        unsafe {
            if let Some(prog) = self.program.take() {
                self.gl.delete_program(prog);
            }
            if let Some(vao) = self.vao.take() {
                self.gl.delete_vertex_array(vao);
            }
            if let Some(vbo) = self.vbo.take() {
                self.gl.delete_buffer(vbo);
            }
            if let Some(tex) = self.lut_texture_a.take() {
                self.gl.delete_texture(tex);
            }
            if let Some(tex) = self.lut_texture_b.take() {
                self.gl.delete_texture(tex);
            }
        }

        // If a crossfade was still in flight at teardown, release the
        // outgoing program handle ourselves — TransitionRenderer does not
        // own program lifecycles. Then consume the transition renderer
        // itself (its `destroy` method takes `self` by value).
        if let Some(t) = self.transition.as_ref() {
            if let TransitionState::Crossfading {
                outgoing_program, ..
            } = &t.state
            {
                unsafe { self.gl.delete_program(*outgoing_program) };
            }
        }
        if let Some(t) = self.transition.take() {
            t.destroy(&self.gl);
        }
        self.outgoing_uniforms = UniformLocations::default();
    }

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

    /// One-shot sanity check for `OffscreenTarget`: allocate a 1920×1080 FBO,
    /// bind it, clear to red, unbind, and destroy. Logs GL errors (if any)
    /// and emits a debug message on success.
    ///
    /// Runs at `Renderer::new()` time to catch driver/context issues early.
    fn debug_sanity_check_fbo(gl: &glow::Context) {
        // Drain any pre-existing GL error state so we only report issues
        // caused by the check itself.
        loop {
            let e = unsafe { gl.get_error() };
            if e == glow::NO_ERROR {
                break;
            }
        }

        let target = OffscreenTarget::new(gl, 1920, 1080);
        target.bind(gl);
        unsafe {
            gl.clear_color(1.0, 0.0, 0.0, 1.0);
            gl.clear(glow::COLOR_BUFFER_BIT);
        }
        OffscreenTarget::unbind(gl);

        let err = unsafe { gl.get_error() };
        if err != glow::NO_ERROR {
            log::warn!(
                "OffscreenTarget sanity check reported GL error 0x{err:04X} \
                 (1920x1080 RGBA8 FBO)"
            );
        } else {
            log::debug!("OffscreenTarget sanity check passed (1920x1080 RGBA8)");
        }

        // Restore the default clear color so the first real frame starts from
        // a known state.
        unsafe {
            gl.clear_color(0.0, 0.0, 0.0, 1.0);
        }

        target.destroy(gl);
    }

    /// Upload a 256-sample LUT as a 256×1 RGBA8 texture and return its handle.
    ///
    /// On OpenGL ES, `GL_TEXTURE_1D` is not available; a 256×1 `GL_TEXTURE_2D`
    /// provides equivalent functionality.
    fn upload_lut(&self, samples: &[[f32; 3]]) -> anyhow::Result<glow::Texture> {
        let mut pixels: Vec<u8> = Vec::with_capacity(samples.len() * 4);
        for [r, g, b] in samples {
            pixels.push((r.clamp(0.0, 1.0) * 255.0) as u8);
            pixels.push((g.clamp(0.0, 1.0) * 255.0) as u8);
            pixels.push((b.clamp(0.0, 1.0) * 255.0) as u8);
            pixels.push(255u8); // alpha = 1
        }

        let texture = unsafe {
            let tex = self
                .gl
                .create_texture()
                .map_err(|e| anyhow::anyhow!("create LUT texture: {e}"))?;
            self.gl.bind_texture(glow::TEXTURE_2D, Some(tex));
            self.gl.tex_image_2d(
                glow::TEXTURE_2D,
                0,
                glow::RGBA8 as i32,
                samples.len() as i32,
                1,
                0,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                Some(&pixels),
            );
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MIN_FILTER,
                glow::LINEAR as i32,
            );
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MAG_FILTER,
                glow::LINEAR as i32,
            );
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_WRAP_S,
                glow::CLAMP_TO_EDGE as i32,
            );
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_WRAP_T,
                glow::CLAMP_TO_EDGE as i32,
            );
            self.gl.bind_texture(glow::TEXTURE_2D, None);
            tex
        };
        Ok(texture)
    }

    /// Delete a GPU texture if the handle is valid.
    fn delete_texture(&self, tex: Option<glow::Texture>) {
        if let Some(t) = tex {
            unsafe { self.gl.delete_texture(t) };
        }
    }

    /// Compile a single shader stage. Returns the shader object or an error with the info log.
    fn compile_shader(&self, stage: u32, source: &str) -> anyhow::Result<glow::NativeShader> {
        unsafe {
            let shader = self
                .gl
                .create_shader(stage)
                .map_err(|e| anyhow::anyhow!("create shader: {e}"))?;
            self.gl.shader_source(shader, source);
            self.gl.compile_shader(shader);

            if !self.gl.get_shader_compile_status(shader) {
                let log = self.gl.get_shader_info_log(shader);
                self.gl.delete_shader(shader);
                let stage_name = if stage == glow::VERTEX_SHADER {
                    "vertex"
                } else {
                    "fragment"
                };
                return Err(anyhow::anyhow!("{stage_name} shader compile error: {log}"));
            }

            Ok(shader)
        }
    }

    /// Query and cache all uniform locations from the current program.
    fn refresh_uniform_locations(&mut self) {
        let Some(prog) = self.program else {
            self.uniforms = UniformLocations::default();
            return;
        };
        unsafe {
            self.uniforms = UniformLocations {
                u_time: self.gl.get_uniform_location(prog, "u_time"),
                u_resolution: self.gl.get_uniform_location(prog, "u_resolution"),
                u_frame: self.gl.get_uniform_location(prog, "u_frame"),
                u_mouse: self.gl.get_uniform_location(prog, "u_mouse"),
                u_lut_a: self.gl.get_uniform_location(prog, "u_lut_a"),
                u_lut_b: self.gl.get_uniform_location(prog, "u_lut_b"),
                u_palette_blend: self.gl.get_uniform_location(prog, "u_palette_blend"),
                u_alpha: self.gl.get_uniform_location(prog, "u_alpha"),
                u_speed_scale: self.gl.get_uniform_location(prog, "u_speed_scale"),
                u_zoom_scale: self.gl.get_uniform_location(prog, "u_zoom_scale"),
            };
        }
    }
}

impl Drop for Renderer {
    fn drop(&mut self) {
        self.destroy();
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fps_to_interval_ms() {
        fn fps_to_interval_ms(fps: u32) -> u64 {
            if fps == 0 {
                return 33;
            }
            1000u64 / fps as u64
        }
        assert_eq!(fps_to_interval_ms(30), 33);
        assert_eq!(fps_to_interval_ms(60), 16);
        assert_eq!(fps_to_interval_ms(0), 33);
    }

    #[test]
    fn test_quad_verts_count() {
        assert_eq!(QUAD_VERTS.len(), 12);
    }

    #[test]
    fn test_vert_src_has_a_pos() {
        assert!(
            VERT_SRC.contains("a_pos"),
            "vertex shader must reference a_pos attribute"
        );
        assert!(
            VERT_SRC.contains("layout(location = 0)"),
            "a_pos must be at location 0"
        );
    }

    /// Mirrors the easing expression used in `TransitionRenderer::tick()`.
    /// Kept as a standalone helper so the curve can be verified without a
    /// GL context.
    fn smoothstep(t: f32) -> f32 {
        t * t * (3.0 - 2.0 * t)
    }

    #[test]
    fn test_transition_smoothstep_boundaries() {
        assert!((smoothstep(0.0) - 0.0).abs() < 1e-6);
        assert!((smoothstep(0.5) - 0.5).abs() < 1e-6);
        assert!((smoothstep(1.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_composite_fragment_shader_uniforms() {
        // All four uniforms must be declared — render_composite uploads each
        // every frame, so a missing one would silently corrupt the blend.
        for name in ["u_tex_a", "u_tex_b", "u_blend", "u_resolution", "fragColor"] {
            assert!(
                COMPOSITE_FRAGMENT_SHADER.contains(name),
                "composite shader missing identifier `{name}`"
            );
        }
    }

    #[test]
    fn test_composite_fragment_shader_version_matches_vertex() {
        // The composite fragment shader is linked against
        // `crate::shaders::VERTEX_SHADER`, so both stages must declare the
        // same GLSL ES version directive or linking will fail.
        assert!(
            COMPOSITE_FRAGMENT_SHADER.starts_with("#version 320 es"),
            "composite fragment shader must be GLSL ES 3.20 to match VERTEX_SHADER"
        );
        assert!(
            crate::shaders::VERTEX_SHADER.starts_with("#version 320 es"),
            "shaders::VERTEX_SHADER must remain GLSL ES 3.20"
        );
    }

    #[test]
    fn test_transition_smoothstep_monotonic() {
        // The eased curve must be monotonically non-decreasing on [0, 1]
        // so the crossfade never visually "reverses".
        let mut prev = smoothstep(0.0);
        for i in 1..=100 {
            let t = i as f32 / 100.0;
            let cur = smoothstep(t);
            assert!(
                cur >= prev - 1e-6,
                "smoothstep not monotonic at t={t}: {prev} → {cur}"
            );
            prev = cur;
        }
    }
}
