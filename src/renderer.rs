//! `renderer.rs` — OpenGL rendering context and per-frame render loop.
//!
//! Responsibilities:
//! - Own the `glow::Context` and all GPU objects (VAO, VBO, shader program,
//!   LUT textures)
//! - Compile and link vertex + fragment shaders
//! - Upload per-frame uniforms: `u_time`, `u_resolution`, `u_frame`, `u_mouse`,
//!   palette uniforms (cosine vec3s or LUT sampler), and `u_palette_blend`
//! - Draw the fullscreen quad each frame
//! - Support swapping in a new fragment shader at runtime (hot-reload)
//! - Does NOT know about Wayland — it only speaks OpenGL

use glow::HasContext as _;
use std::time::Instant;

use crate::palette::{Palette, PaletteEntry};

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
    // Cosine palette A (current)
    pub u_palette_a_a: Option<glow::UniformLocation>,
    pub u_palette_a_b: Option<glow::UniformLocation>,
    pub u_palette_a_c: Option<glow::UniformLocation>,
    pub u_palette_a_d: Option<glow::UniformLocation>,
    // Cosine palette B (transition target)
    pub u_palette_b_a: Option<glow::UniformLocation>,
    pub u_palette_b_b: Option<glow::UniformLocation>,
    pub u_palette_b_c: Option<glow::UniformLocation>,
    pub u_palette_b_d: Option<glow::UniformLocation>,
    // LUT samplers (texture units 1 and 2)
    pub u_lut_a: Option<glow::UniformLocation>,
    pub u_lut_b: Option<glow::UniformLocation>,
    // Control
    pub u_use_lut: Option<glow::UniformLocation>,
    pub u_palette_blend: Option<glow::UniformLocation>,
    // Fade alpha
    pub u_alpha: Option<glow::UniformLocation>,
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

    // ------------------------------------------------------------------
    // Palette state
    // ------------------------------------------------------------------
    /// Whether the active palette is a LUT (true) or cosine (false).
    palette_is_lut: bool,

    /// Cosine palette A (current).
    pal_a: Palette,
    /// Cosine palette B (transition target; same as A when not transitioning).
    pal_b: Palette,

    /// LUT texture for the current palette (texture unit 1).
    lut_texture_a: Option<glow::Texture>,
    /// LUT texture for the transition target (texture unit 2; `None` = same as A).
    lut_texture_b: Option<glow::Texture>,

    /// Blend factor: 0.0 = pure A, 1.0 = pure B.
    palette_blend: f32,

    /// Fade alpha: 0.0 = fully transparent, 1.0 = fully opaque.
    /// Multiplied into the final fragColor for fade in/out.
    alpha: f32,
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

        Ok(Self {
            gl,
            program: None,
            vao: Some(vao),
            vbo: Some(vbo),
            uniforms: UniformLocations::default(),
            frame: 0,
            start_time: Instant::now(),
            mouse_pos: [0.0, 0.0],
            palette_is_lut: false,
            pal_a: Palette::default(),
            pal_b: Palette::default(),
            lut_texture_a: None,
            lut_texture_b: None,
            palette_blend: 0.0,
            alpha: 1.0,
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
        self.refresh_uniform_locations();

        log::debug!("Shader loaded successfully");
        Ok(())
    }

    /// Set the active palette. Replaces the current palette A, resets blend to 0.
    ///
    /// For a `Lut` entry, uploads a 256×1 RGBA8 texture to GPU (texture unit 1).
    /// For a `Cosine` entry, stores the params for uniform upload during `render()`.
    pub fn set_palette(&mut self, entry: &PaletteEntry) -> anyhow::Result<()> {
        let old_a = self.lut_texture_a.take();
        let old_b = self.lut_texture_b.take();
        self.delete_texture(old_a);
        self.delete_texture(old_b);
        self.palette_blend = 0.0;

        match entry {
            PaletteEntry::Cosine(p) => {
                self.palette_is_lut = false;
                self.pal_a = p.clone();
                self.pal_b = p.clone();
            }
            PaletteEntry::Lut(samples) => {
                self.palette_is_lut = true;
                self.lut_texture_a = Some(self.upload_lut(samples)?);
            }
        }
        Ok(())
    }

    /// Begin a cross-fade transition toward `next`.
    ///
    /// Uploads the next palette as palette B. The caller must update
    /// `palette_blend` every frame via `set_blend()`.
    ///
    /// For mixed-type transitions (cosine ↔ LUT), both sides are converted to LUT
    /// so the shader uses a single code path.
    pub fn begin_transition(&mut self, next: &PaletteEntry) -> anyhow::Result<()> {
        match (self.palette_is_lut, next) {
            (false, PaletteEntry::Cosine(p)) => {
                // Cosine → Cosine: purely uniform-based blend.
                self.pal_b = p.clone();
                let old_b = self.lut_texture_b.take();
                self.delete_texture(old_b);
            }
            (true, PaletteEntry::Lut(samples)) => {
                // LUT → LUT: upload second texture.
                let old_b = self.lut_texture_b.take();
                self.delete_texture(old_b);
                let new_tex = self.upload_lut(samples)?;
                self.lut_texture_b = Some(new_tex);
            }
            _ => {
                // Mixed types: convert everything to LUT for a homogeneous blend.
                // Pre-compute LUTs before touching any fields.
                let cur_lut = self.pal_a.to_lut();
                let next_lut = next.to_lut();

                let old_a = self.lut_texture_a.take();
                let old_b = self.lut_texture_b.take();
                self.delete_texture(old_a);
                self.delete_texture(old_b);
                self.palette_is_lut = true;
                let tex_a = self.upload_lut(&cur_lut)?;
                self.lut_texture_a = Some(tex_a);
                let tex_b = self.upload_lut(&next_lut)?;
                self.lut_texture_b = Some(tex_b);
            }
        }
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

    /// Update the last known mouse position (window-space pixels, origin top-left).
    pub fn set_mouse(&mut self, x: f32, y: f32) {
        self.mouse_pos = [x, y];
    }

    /// Render one frame. Uploads all uniforms and calls `glDrawArrays`.
    ///
    /// * `resolution` — physical pixel dimensions `[width, height]` of the target surface.
    pub fn render(&mut self, resolution: [f32; 2]) {
        unsafe {
            self.gl
                .viewport(0, 0, resolution[0] as i32, resolution[1] as i32);
            self.gl.clear(glow::COLOR_BUFFER_BIT);
        }

        let program = match self.program {
            Some(p) => p,
            None => return,
        };

        let elapsed = self.start_time.elapsed().as_secs_f32();

        unsafe {
            self.gl.use_program(Some(program));

            // Time / resolution / frame / mouse
            if let Some(ref loc) = self.uniforms.u_time {
                self.gl.uniform_1_f32(Some(loc), elapsed);
            }
            if let Some(ref loc) = self.uniforms.u_resolution {
                self.gl
                    .uniform_2_f32(Some(loc), resolution[0], resolution[1]);
            }
            if let Some(ref loc) = self.uniforms.u_frame {
                self.gl.uniform_1_i32(Some(loc), self.frame as i32);
            }
            if let Some(ref loc) = self.uniforms.u_mouse {
                self.gl
                    .uniform_2_f32(Some(loc), self.mouse_pos[0], self.mouse_pos[1]);
            }

            // Palette blend factor (always uploaded)
            if let Some(ref loc) = self.uniforms.u_palette_blend {
                self.gl.uniform_1_f32(Some(loc), self.palette_blend);
            }

            // Fade alpha (always uploaded)
            if let Some(ref loc) = self.uniforms.u_alpha {
                self.gl.uniform_1_f32(Some(loc), self.alpha);
            }

            if self.palette_is_lut {
                // --- LUT path ---
                if let Some(ref loc) = self.uniforms.u_use_lut {
                    self.gl.uniform_1_i32(Some(loc), 1);
                }
                // Texture unit 1 → u_lut_a
                self.gl.active_texture(glow::TEXTURE1);
                self.gl.bind_texture(glow::TEXTURE_2D, self.lut_texture_a);
                if let Some(ref loc) = self.uniforms.u_lut_a {
                    self.gl.uniform_1_i32(Some(loc), 1);
                }
                // Texture unit 2 → u_lut_b (fall back to A when not transitioning)
                self.gl.active_texture(glow::TEXTURE2);
                let tex_b = self.lut_texture_b.or(self.lut_texture_a);
                self.gl.bind_texture(glow::TEXTURE_2D, tex_b);
                if let Some(ref loc) = self.uniforms.u_lut_b {
                    self.gl.uniform_1_i32(Some(loc), 2);
                }
                // Reset active texture unit to 0
                self.gl.active_texture(glow::TEXTURE0);
            } else {
                // --- Cosine path ---
                if let Some(ref loc) = self.uniforms.u_use_lut {
                    self.gl.uniform_1_i32(Some(loc), 0);
                }
                // Unbind texture slots (prevents spurious sampler warnings)
                self.gl.active_texture(glow::TEXTURE1);
                self.gl.bind_texture(glow::TEXTURE_2D, None);
                self.gl.active_texture(glow::TEXTURE2);
                self.gl.bind_texture(glow::TEXTURE_2D, None);
                self.gl.active_texture(glow::TEXTURE0);

                // Upload palette A params
                self.set_uniform_vec3(&self.uniforms.u_palette_a_a.clone(), self.pal_a.a);
                self.set_uniform_vec3(&self.uniforms.u_palette_a_b.clone(), self.pal_a.b);
                self.set_uniform_vec3(&self.uniforms.u_palette_a_c.clone(), self.pal_a.c);
                self.set_uniform_vec3(&self.uniforms.u_palette_a_d.clone(), self.pal_a.d);

                // Upload palette B params (same as A when not transitioning → blend=0 no-op)
                self.set_uniform_vec3(&self.uniforms.u_palette_b_a.clone(), self.pal_b.a);
                self.set_uniform_vec3(&self.uniforms.u_palette_b_b.clone(), self.pal_b.b);
                self.set_uniform_vec3(&self.uniforms.u_palette_b_c.clone(), self.pal_b.c);
                self.set_uniform_vec3(&self.uniforms.u_palette_b_d.clone(), self.pal_b.d);
            }

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
            if let Some(tex) = self.lut_texture_a.take() {
                self.gl.delete_texture(tex);
            }
            if let Some(tex) = self.lut_texture_b.take() {
                self.gl.delete_texture(tex);
            }
        }
    }

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

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
                u_palette_a_a: self.gl.get_uniform_location(prog, "u_palette_a_a"),
                u_palette_a_b: self.gl.get_uniform_location(prog, "u_palette_a_b"),
                u_palette_a_c: self.gl.get_uniform_location(prog, "u_palette_a_c"),
                u_palette_a_d: self.gl.get_uniform_location(prog, "u_palette_a_d"),
                u_palette_b_a: self.gl.get_uniform_location(prog, "u_palette_b_a"),
                u_palette_b_b: self.gl.get_uniform_location(prog, "u_palette_b_b"),
                u_palette_b_c: self.gl.get_uniform_location(prog, "u_palette_b_c"),
                u_palette_b_d: self.gl.get_uniform_location(prog, "u_palette_b_d"),
                u_lut_a: self.gl.get_uniform_location(prog, "u_lut_a"),
                u_lut_b: self.gl.get_uniform_location(prog, "u_lut_b"),
                u_use_lut: self.gl.get_uniform_location(prog, "u_use_lut"),
                u_palette_blend: self.gl.get_uniform_location(prog, "u_palette_blend"),
                u_alpha: self.gl.get_uniform_location(prog, "u_alpha"),
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
}
