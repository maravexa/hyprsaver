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

use glow::HasContext as _;
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

            // Upload quad vertices as raw bytes
            let bytes = bytemuck::cast_slice(QUAD_VERTS);
            gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, bytes, glow::STATIC_DRAW);

            // a_pos at attribute location 0: 2 floats, not normalized
            gl.enable_vertex_attrib_array(0);
            gl.vertex_attrib_pointer_f32(
                0,           // location
                2,           // components
                glow::FLOAT, // type
                false,       // normalized
                8,           // stride = 2 * sizeof(f32)
                0,           // offset
            );

            gl.bind_vertex_array(None);
            gl.bind_buffer(glow::ARRAY_BUFFER, None);

            (vao, vbo)
        };

        // Default palette: electric (Inigo Quilez standard rainbow)
        let palette_a = [0.5_f32, 0.5, 0.5];
        let palette_b = [0.5_f32, 0.5, 0.5];
        let palette_c = [1.0_f32, 1.0, 1.0];
        let palette_d = [0.0_f32, 0.33, 0.67];

        unsafe {
            gl.clear_color(0.0, 0.0, 0.0, 1.0);
        }

        Ok(Self {
            gl,
            program: None,
            vao: Some(vao),
            vbo: Some(vbo),
            uniforms: UniformLocations::default(),
            frame: 0,
            start_time: Instant::now(),
            mouse_pos: [0.0, 0.0],
            palette_a,
            palette_b,
            palette_c,
            palette_d,
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

        // Delete old program before replacing
        if let Some(old) = self.program.take() {
            unsafe { self.gl.delete_program(old) };
        }
        self.program = Some(program);
        self.refresh_uniform_locations();

        log::debug!("Shader loaded successfully");
        Ok(())
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
    ///
    /// # TODO: fade support
    /// Fade in/out is config-supported but implementation is deferred to a later milestone.
    pub fn render(&mut self, resolution: [f32; 2]) {
        unsafe {
            self.gl
                .viewport(0, 0, resolution[0] as i32, resolution[1] as i32);
            self.gl.clear(glow::COLOR_BUFFER_BIT);
        }

        let program = match self.program {
            Some(p) => p,
            None => return, // No shader loaded yet; show black.
        };

        let elapsed = self.start_time.elapsed().as_secs_f32();

        unsafe {
            self.gl.use_program(Some(program));

            // Time
            if let Some(ref loc) = self.uniforms.u_time {
                self.gl.uniform_1_f32(Some(loc), elapsed);
            }
            // Resolution
            if let Some(ref loc) = self.uniforms.u_resolution {
                self.gl
                    .uniform_2_f32(Some(loc), resolution[0], resolution[1]);
            }
            // Frame
            if let Some(ref loc) = self.uniforms.u_frame {
                self.gl.uniform_1_i32(Some(loc), self.frame as i32);
            }
            // Mouse
            if let Some(ref loc) = self.uniforms.u_mouse {
                self.gl
                    .uniform_2_f32(Some(loc), self.mouse_pos[0], self.mouse_pos[1]);
            }

            // Palette
            self.set_uniform_vec3(&self.uniforms.u_palette_a.clone(), self.palette_a);
            self.set_uniform_vec3(&self.uniforms.u_palette_b.clone(), self.palette_b);
            self.set_uniform_vec3(&self.uniforms.u_palette_c.clone(), self.palette_c);
            self.set_uniform_vec3(&self.uniforms.u_palette_d.clone(), self.palette_d);

            self.gl.bind_vertex_array(self.vao);
            self.gl.draw_arrays(glow::TRIANGLES, 0, 6);
            self.gl.bind_vertex_array(None);
        }

        self.frame += 1;
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
        }
    }

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

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
                u_palette_a: self.gl.get_uniform_location(prog, "u_palette_a"),
                u_palette_b: self.gl.get_uniform_location(prog, "u_palette_b"),
                u_palette_c: self.gl.get_uniform_location(prog, "u_palette_c"),
                u_palette_d: self.gl.get_uniform_location(prog, "u_palette_d"),
            };
        }
    }

    /// Upload a vec3 uniform by cached location (no-op if location is None).
    #[inline]
    fn set_uniform_vec3(&self, loc: &Option<glow::UniformLocation>, v: [f32; 3]) {
        if let Some(l) = loc {
            unsafe { self.gl.uniform_3_f32(Some(l), v[0], v[1], v[2]) }
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
        // Helper function logic: 1000ms / fps = interval
        fn fps_to_interval_ms(fps: u32) -> u64 {
            if fps == 0 {
                return 33; // fallback to ~30fps
            }
            1000u64 / fps as u64
        }
        assert_eq!(fps_to_interval_ms(30), 33);
        assert_eq!(fps_to_interval_ms(60), 16);
        assert_eq!(fps_to_interval_ms(0), 33);
    }

    #[test]
    fn test_quad_verts_count() {
        // 6 vertices × 2 floats = 12 values
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
}
