//! `renderer.rs` — OpenGL rendering context and per-frame render loop.
//!
//! Responsibilities:
//! - Own the `glow::Context` and all GPU objects (VAO, VBO, shader program)
//! - Compile and link vertex + fragment shaders
//! - Upload per-frame uniforms: `u_time`, `u_resolution`, `u_frame`, `u_mouse`,
//!   and the four cosine palette vectors `u_palette_a/b/c/d`
//! - Draw the fullscreen quad each frame
//! - Support swapping in a new fragment shader at runtime (hot-reload)
//! - Does NOT know about Wayland — it only speaks OpenGL

use glow::{Context as GlContext, HasContext as _, NativeProgram, NativeVertexArray, NativeBuffer};
use std::time::Instant;

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
    pub u_palette_a: Option<glow::UniformLocation>,
    pub u_palette_b: Option<glow::UniformLocation>,
    pub u_palette_c: Option<glow::UniformLocation>,
    pub u_palette_d: Option<glow::UniformLocation>,
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/// Owns all GL state for rendering fractal shaders onto a fullscreen quad.
pub struct Renderer {
    /// The glow OpenGL context. Not Send — must stay on the GL thread.
    gl: GlContext,

    /// Compiled + linked shader program (vert + frag).
    program: Option<NativeProgram>,

    /// Vertex Array Object for the fullscreen quad.
    vao: Option<NativeVertexArray>,

    /// Vertex Buffer Object for the fullscreen quad.
    vbo: Option<NativeBuffer>,

    /// Cached uniform locations for `program`.
    uniforms: UniformLocations,

    /// Frame counter (incremented each call to `render()`).
    frame: u64,

    /// Wall-clock time when `new()` was called, for `u_time` computation.
    start_time: Instant,

    /// Last known mouse position in window-space pixels.
    mouse_pos: [f32; 2],

    /// Current cosine palette vectors.
    palette_a: [f32; 3],
    palette_b: [f32; 3],
    palette_c: [f32; 3],
    palette_d: [f32; 3],
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
    /// Create a new renderer. Uploads the fullscreen quad geometry and uploads palette defaults.
    ///
    /// # Safety
    /// The caller must ensure a current GL context is bound on the calling thread.
    pub fn new(gl: GlContext) -> anyhow::Result<Self> {
        todo!(
            "create VAO + VBO, upload QUAD_VERTS, set attrib pointer for a_pos at location 0; \
             set default palette (electric); return Ok(Self {{ gl, vao, vbo, ... }})"
        )
    }

    /// Compile and link a new shader program from the given fragment source.
    /// On success replaces `self.program` and refreshes `self.uniforms`.
    /// On compile/link error, logs the error and returns Err — caller decides whether to fallback.
    pub fn load_shader(&mut self, frag_src: &str) -> anyhow::Result<()> {
        todo!(
            "compile VERT_SRC as GL_VERTEX_SHADER, compile frag_src as GL_FRAGMENT_SHADER, \
             link program, delete old program if Some, cache uniform locations"
        )
    }

    /// Upload the four cosine palette vectors as vec3 uniforms.
    pub fn set_palette(&mut self, a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3]) {
        self.palette_a = a;
        self.palette_b = b;
        self.palette_c = c;
        self.palette_d = d;
        // Uniforms are uploaded lazily in render() so the program must be bound first.
    }

    /// Update the last known mouse position (window-space pixels, origin top-left).
    pub fn set_mouse(&mut self, x: f32, y: f32) {
        self.mouse_pos = [x, y];
    }

    /// Render one frame. Uploads all uniforms and calls `glDrawArrays`.
    ///
    /// * `resolution` — physical pixel dimensions `[width, height]` of the target surface.
    pub fn render(&mut self, resolution: [f32; 2]) {
        todo!(
            "use_program(self.program), upload u_time = elapsed seconds, \
             u_resolution, u_frame, u_mouse, u_palette_a..d; \
             bind_vertex_array(self.vao); draw_arrays(TRIANGLES, 0, 6); \
             increment self.frame"
        )
    }

    /// Release all GPU resources. Must be called before the GL context is destroyed.
    pub fn destroy(&mut self) {
        todo!("delete_program, delete_vertex_array, delete_buffer")
    }

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

    /// Compile a single shader stage. Returns the shader object or an error with the info log.
    fn compile_shader(&self, stage: u32, source: &str) -> anyhow::Result<glow::NativeShader> {
        todo!(
            "create_shader(stage), shader_source, compile_shader, \
             check get_shader_compile_status; if false, return Err with get_shader_info_log"
        )
    }

    /// Query and cache all uniform locations from the current program.
    fn refresh_uniform_locations(&mut self) {
        todo!(
            "for each uniform name (u_time, u_resolution, etc.) call \
             get_uniform_location(program, name) and store in self.uniforms"
        )
    }

    /// Upload a vec3 uniform by cached location (no-op if location is None).
    #[inline]
    fn set_uniform_vec3(&self, loc: &Option<glow::UniformLocation>, v: [f32; 3]) {
        todo!("if let Some(l) = loc {{ self.gl.uniform_3_f32(Some(l), v[0], v[1], v[2]) }}")
    }
}

impl Drop for Renderer {
    fn drop(&mut self) {
        self.destroy();
    }
}
