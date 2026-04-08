//! `shaders.rs` — Shader loading, Shadertoy compat shim, palette injection, and hot-reload.
//!
//! Responsibilities:
//! - Maintain a registry of available shaders: built-ins (compiled into the binary via
//!   `include_str!()`) and user shaders loaded from the config shader directory.
//! - Prepare each shader through a pipeline: #version/#precision preservation,
//!   common uniform injection, palette function injection, and Shadertoy compat shim.
//! - Watch the shader directory for filesystem changes and reload on the fly.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;

// ---------------------------------------------------------------------------
// Built-in shaders compiled into the binary
// ---------------------------------------------------------------------------

/// Mandelbrot set with animated zoom and smooth iteration coloring.
pub const BUILTIN_MANDELBROT: &str = include_str!("../shaders/mandelbrot.frag");

/// Julia set with animated parameter.
pub const BUILTIN_JULIA: &str = include_str!("../shaders/julia.frag");

/// Classic plasma effect.
pub const BUILTIN_PLASMA: &str = include_str!("../shaders/plasma.frag");

/// Infinite tunnel flythrough.
pub const BUILTIN_TUNNEL: &str = include_str!("../shaders/tunnel.frag");

/// Animated Voronoi cells.
pub const BUILTIN_VORONOI: &str = include_str!("../shaders/voronoi.frag");

/// Three-layer parallax starfield with palette-colored glow and brightness pulse.
pub const BUILTIN_STARFIELD: &str = include_str!("../shaders/starfield.frag");

/// N-fold kaleidoscope driven by domain-warped FBM noise.
pub const BUILTIN_KALEIDOSCOPE: &str = include_str!("../shaders/kaleidoscope.frag");

/// Curl-noise flow field with 8-step particle tracing and palette-colored glow.
pub const BUILTIN_FLOW_FIELD: &str = include_str!("../shaders/flow_field.frag");

/// Raymarched torus with Phong lighting and palette-mapped surface color.
pub const BUILTIN_RAYMARCHER: &str = include_str!("../shaders/raymarcher.frag");

/// Three overlapping Lissajous curves with smooth glow and drifting hue.
pub const BUILTIN_LISSAJOUS: &str = include_str!("../shaders/lissajous.frag");

// ---------------------------------------------------------------------------
// Vertex shader for the fullscreen quad (triangle-strip, no VBO needed)
// ---------------------------------------------------------------------------

/// Vertex shader for the fullscreen quad. Uses `gl_VertexID` with a triangle strip
/// (4 vertices). The renderer calls `glDrawArrays(GL_TRIANGLE_STRIP, 0, 4)` with
/// an empty VAO — no vertex buffers are required.
pub const VERTEX_SHADER: &str = r#"#version 320 es
precision highp float;

const vec2 positions[4] = vec2[4](
    vec2(-1.0, -1.0),
    vec2( 1.0, -1.0),
    vec2(-1.0,  1.0),
    vec2( 1.0,  1.0)
);

const vec2 uvs[4] = vec2[4](
    vec2(0.0, 0.0),
    vec2(1.0, 0.0),
    vec2(0.0, 1.0),
    vec2(1.0, 1.0)
);

out vec2 v_uv;

void main() {
    gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
    v_uv = uvs[gl_VertexID];
}
"#;

// ---------------------------------------------------------------------------
// ShaderSource
// ---------------------------------------------------------------------------

/// A single shader entry in the registry.
pub struct ShaderSource {
    /// Canonical name (file stem, e.g. "mandelbrot").
    pub name: String,
    /// Original source as loaded from disk or binary.
    pub raw: String,
    /// Processed source ready for GL: palette + uniforms injected, Shadertoy shim applied.
    pub compiled: String,
    /// `true` if from a built-in `include_str!`, `false` if from the user's shader dir.
    pub builtin: bool,
}

// ---------------------------------------------------------------------------
// ShaderManager
// ---------------------------------------------------------------------------

/// Manages the collection of available shaders and the hot-reload watcher.
pub struct ShaderManager {
    /// Directory scanned for user `.frag` files.
    shader_dir: PathBuf,
    /// Map of shader name → source (raw + compiled).
    shaders: HashMap<String, ShaderSource>,
    /// Filesystem watcher. `None` until `watch_for_changes()` is called.
    watcher: Option<RecommendedWatcher>,
    /// Receiver for shader-name strings sent by the watcher thread.
    change_rx: Option<mpsc::Receiver<String>>,
}

impl ShaderManager {
    /// Create a new `ShaderManager`. Loads all five built-ins immediately.
    /// If `shader_dir` exists, scans it for `.frag` files (user shaders override
    /// built-ins on name collision). The watcher is not started until
    /// `watch_for_changes()` is called.
    pub fn new(shader_dir: PathBuf) -> anyhow::Result<Self> {
        let mut shaders = HashMap::new();

        // Register built-in shaders.
        let builtins: &[(&str, &str)] = &[
            ("flow_field", BUILTIN_FLOW_FIELD),
            ("julia", BUILTIN_JULIA),
            ("kaleidoscope", BUILTIN_KALEIDOSCOPE),
            ("lissajous", BUILTIN_LISSAJOUS),
            ("mandelbrot", BUILTIN_MANDELBROT),
            ("plasma", BUILTIN_PLASMA),
            ("raymarcher", BUILTIN_RAYMARCHER),
            ("starfield", BUILTIN_STARFIELD),
            ("tunnel", BUILTIN_TUNNEL),
            ("voronoi", BUILTIN_VORONOI),
        ];
        for (name, raw_const) in builtins {
            let raw = raw_const
                .strip_prefix('\u{FEFF}')
                .unwrap_or(raw_const)
                .to_string();
            let compiled = prepare_shader(&raw);
            shaders.insert(
                name.to_string(),
                ShaderSource {
                    name: name.to_string(),
                    raw,
                    compiled,
                    builtin: true,
                },
            );
        }

        // Scan user shader directory if it exists.
        if shader_dir.is_dir() {
            match std::fs::read_dir(&shader_dir) {
                Ok(entries) => {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().and_then(|e| e.to_str()) != Some("frag") {
                            continue;
                        }
                        let Some(name) = path
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .map(str::to_string)
                        else {
                            continue;
                        };
                        match std::fs::read_to_string(&path) {
                            Ok(content) => {
                                let raw = content
                                    .strip_prefix('\u{FEFF}')
                                    .unwrap_or(&content)
                                    .to_string();
                                let compiled = prepare_shader(&raw);
                                shaders.insert(
                                    name.clone(),
                                    ShaderSource {
                                        name,
                                        raw,
                                        compiled,
                                        builtin: false,
                                    },
                                );
                            }
                            Err(e) => {
                                log::warn!("Failed to load user shader {:?}: {e}", path);
                            }
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Failed to read shader directory {:?}: {e}", shader_dir);
                }
            }
        } else {
            log::info!(
                "Shader directory {:?} does not exist; using built-ins only",
                shader_dir
            );
        }

        Ok(Self {
            shader_dir,
            shaders,
            watcher: None,
            change_rx: None,
        })
    }

    /// Return the `ShaderSource` for the named shader, or `None` if unknown.
    pub fn get(&self, name: &str) -> Option<&ShaderSource> {
        self.shaders.get(name)
    }

    /// Return a sorted list of all known shader names.
    pub fn list(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.shaders.keys().map(String::as_str).collect();
        names.sort_unstable();
        names
    }

    /// Return a random shader. Uses current-time subsecond nanos modulo count.
    pub fn random(&self) -> (&str, &ShaderSource) {
        let idx = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos() as usize
            % self.shaders.len();
        let (name, src) = self
            .shaders
            .iter()
            .nth(idx)
            .expect("shaders map is non-empty");
        (name.as_str(), src)
    }

    /// Convenience shortcut: return just the compiled GLSL source string.
    pub fn get_compiled(&self, name: &str) -> Option<&str> {
        self.shaders.get(name).map(|s| s.compiled.as_str())
    }

    /// Re-read `name.frag` from `shader_dir`, re-run the preparation pipeline, and
    /// update the entry. Returns an error if the file is missing or unreadable, but
    /// does NOT remove the old entry on failure.
    pub fn reload_shader(&mut self, name: &str) -> anyhow::Result<()> {
        use anyhow::Context;
        let path = self.shader_dir.join(format!("{name}.frag"));
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("cannot read shader file: {}", path.display()))?;
        let raw = content
            .strip_prefix('\u{FEFF}')
            .unwrap_or(&content)
            .to_string();
        let compiled = prepare_shader(&raw);
        self.shaders.insert(
            name.to_string(),
            ShaderSource {
                name: name.to_string(),
                raw,
                compiled,
                builtin: false,
            },
        );
        Ok(())
    }

    /// Start watching `shader_dir` for `.frag` file creation and modification events.
    ///
    /// Returns `Ok(())` and logs an info message if the directory does not exist or
    /// the watcher is already running — hot-reload is silently disabled in those cases.
    pub fn watch_for_changes(&mut self) -> anyhow::Result<()> {
        if self.watcher.is_some() {
            log::info!("Hot-reload watcher is already running");
            return Ok(());
        }
        if !self.shader_dir.exists() {
            log::info!(
                "Shader directory {:?} does not exist; hot-reload disabled",
                self.shader_dir
            );
            return Ok(());
        }

        let (tx, rx) = mpsc::channel::<String>();

        let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            match event.kind {
                EventKind::Modify(_) | EventKind::Create(_) => {
                    for path in &event.paths {
                        if path.extension().and_then(|e| e.to_str()) != Some("frag") {
                            continue;
                        }
                        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                            let _ = tx.send(stem.to_string());
                        }
                    }
                }
                _ => {}
            }
        })?;

        w.watch(&self.shader_dir, RecursiveMode::NonRecursive)?;

        self.watcher = Some(w);
        self.change_rx = Some(rx);
        Ok(())
    }

    /// Drain the filesystem event queue. For each changed shader, reloads its source
    /// from disk and returns the names of successfully reloaded shaders.
    pub fn poll_changes(&mut self) -> Vec<String> {
        // Collect names from the channel (non-blocking).
        let mut names: Vec<String> = Vec::new();
        if let Some(rx) = &self.change_rx {
            while let Ok(name) = rx.try_recv() {
                names.push(name);
            }
        } else {
            return Vec::new();
        }

        // Deduplicate (one save can emit multiple events).
        names.sort_unstable();
        names.dedup();

        // Reload each changed shader; log failures but don't abort.
        let mut reloaded = Vec::new();
        for name in &names {
            match self.reload_shader(name) {
                Ok(()) => {
                    log::info!("Hot-reloaded shader '{name}'");
                    reloaded.push(name.clone());
                }
                Err(e) => log::warn!("Failed to reload shader '{name}': {e:#}"),
            }
        }
        reloaded
    }
}

// ---------------------------------------------------------------------------
// Shader preparation pipeline
// ---------------------------------------------------------------------------

/// Run the full preparation pipeline on a raw shader source string:
///
/// 1. Strip UTF-8 BOM if present.
/// 2. Extract `#version` / `precision` header lines (kept at the top).
/// 3. Inject missing common uniforms (`u_time`, `u_resolution`, `u_mouse`, `u_frame`,
///    `out vec4 fragColor`). Skips each one if already present in the source.
/// 4. Inject palette uniforms and `palette(t)` function if not already present.
/// 5. If Shadertoy-style (`void mainImage` detected), add `#define` aliases and a
///    `void main()` wrapper.
fn prepare_shader(raw: &str) -> String {
    let source = raw.strip_prefix('\u{FEFF}').unwrap_or(raw);

    let is_shadertoy = source.contains("void mainImage");

    // ---- split header (#version / precision) from body ----
    let mut header_lines: Vec<&str> = Vec::new();
    let mut body_lines: Vec<&str> = Vec::new();
    let mut header_done = false;
    for line in source.lines() {
        let trimmed = line.trim();
        if !header_done && (trimmed.starts_with("#version") || trimmed.starts_with("precision")) {
            header_lines.push(line);
        } else {
            header_done = true;
            body_lines.push(line);
        }
    }

    let header = if header_lines.is_empty() {
        "#version 320 es\nprecision highp float;\n".to_string()
    } else {
        let mut h = header_lines.join("\n");
        h.push('\n');
        h
    };

    let mut out = header;

    // ---- inject common uniforms (skip those already declared) ----
    if !source.contains("u_time") {
        out.push_str("uniform float u_time;\n");
    }
    if !source.contains("u_resolution") {
        out.push_str("uniform vec2 u_resolution;\n");
    }
    if !source.contains("u_mouse") {
        out.push_str("uniform vec2 u_mouse;\n");
    }
    if !source.contains("u_frame") {
        out.push_str("uniform int u_frame;\n");
    }
    // Use "out vec4 fragColor;" (with semicolon) to avoid matching function params.
    if !source.contains("out vec4 fragColor;") {
        out.push_str("out vec4 fragColor;\n");
    }

    // Fade alpha uniform — multiplied into the final fragColor for fade in/out.
    if !source.contains("u_alpha") {
        out.push_str("uniform float u_alpha;\n");
    }

    // ---- inject palette block (if not already present) ----
    // Guard on the palette() function signature — avoids injecting twice even if
    // the shader already declares u_palette_a_* uniforms by another name.
    if !source.contains("vec3 palette(") {
        // Cosine palette A (current) — four RGB vec3 params.
        out.push_str("uniform vec3 u_palette_a_a;\n"); // brightness offset
        out.push_str("uniform vec3 u_palette_a_b;\n"); // amplitude
        out.push_str("uniform vec3 u_palette_a_c;\n"); // frequency
        out.push_str("uniform vec3 u_palette_a_d;\n"); // phase
                                                       // Cosine palette B (next / cross-fade target).
        out.push_str("uniform vec3 u_palette_b_a;\n");
        out.push_str("uniform vec3 u_palette_b_b;\n");
        out.push_str("uniform vec3 u_palette_b_c;\n");
        out.push_str("uniform vec3 u_palette_b_d;\n");
        // LUT textures — 256×1 RGBA8 strips on texture units 1 and 2.
        // On OpenGL ES there is no sampler1D; we use sampler2D with height=1.
        out.push_str("uniform sampler2D u_lut_a;\n");
        out.push_str("uniform sampler2D u_lut_b;\n");
        // Control uniforms.
        out.push_str("uniform int u_use_lut;\n"); // 0=cosine, 1=LUT
        out.push_str("uniform float u_palette_blend;\n"); // 0.0=A, 1.0=B
                                                          // palette(t) — evaluates either cosine or LUT, with optional cross-fade.
        out.push_str("vec3 palette(float t) {\n");
        out.push_str("    vec3 col_a, col_b;\n");
        out.push_str("    if (u_use_lut == 1) {\n");
        out.push_str("        col_a = texture(u_lut_a, vec2(t, 0.5)).rgb;\n");
        out.push_str("        col_b = texture(u_lut_b, vec2(t, 0.5)).rgb;\n");
        out.push_str("    } else {\n");
        out.push_str(
            "        col_a = u_palette_a_a + u_palette_a_b * cos(6.28318 * (u_palette_a_c * t + u_palette_a_d));\n",
        );
        out.push_str(
            "        col_b = u_palette_b_a + u_palette_b_b * cos(6.28318 * (u_palette_b_c * t + u_palette_b_d));\n",
        );
        out.push_str("    }\n");
        out.push_str("    return mix(col_a, col_b, u_palette_blend);\n");
        out.push_str("}\n");
    }

    // ---- Shadertoy uniform aliases ----
    if is_shadertoy {
        out.push_str("#define iTime u_time\n");
        out.push_str("#define iResolution u_resolution\n");
        out.push_str("#define iMouse u_mouse\n");
        out.push_str("#define iFrame u_frame\n");
    }

    // ---- user body ----
    let body = body_lines.join("\n");
    if !body.trim().is_empty() {
        out.push('\n');
        out.push_str(&body);
        out.push('\n');
    }

    // ---- void main() wrapper with u_alpha fade multiply ----
    if is_shadertoy {
        // Shadertoy: we generate main(), so append alpha multiply directly.
        out.push_str("void main() {\n");
        out.push_str("    mainImage(fragColor, gl_FragCoord.xy);\n");
        out.push_str("    fragColor *= u_alpha;\n");
        out.push_str("}\n");
    } else {
        // Native shader: rename void main() → _hyprsaver_main(), then wrap it
        // so we can apply the u_alpha fade multiply after the user code runs.
        // This correctly handles early `return;` statements in user shaders.
        out = out.replace("void main()", "void _hyprsaver_main()");
        out.push_str("\nvoid main() {\n");
        out.push_str("    _hyprsaver_main();\n");
        out.push_str("    fragColor *= u_alpha;\n");
        out.push_str("}\n");
    }

    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> ShaderManager {
        // Non-existent dir → built-ins only; never panics.
        ShaderManager::new(PathBuf::from("/tmp/hyprsaver_shaders_test_nonexistent_xyz"))
            .expect("ShaderManager::new must succeed")
    }

    #[test]
    fn test_builtin_shader_count() {
        assert_eq!(manager().list().len(), 10);
    }

    #[test]
    fn test_builtin_names() {
        let mgr = manager();
        let names = mgr.list();
        for expected in &[
            "mandelbrot",
            "julia",
            "plasma",
            "tunnel",
            "voronoi",
            "starfield",
            "kaleidoscope",
            "flow_field",
            "raymarcher",
            "lissajous",
        ] {
            assert!(
                names.contains(expected),
                "missing built-in shader: {expected}"
            );
        }
    }

    #[test]
    fn test_list_sorted() {
        let mgr = manager();
        let names = mgr.list();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(
            names, sorted,
            "list() must return alphabetically sorted names"
        );
    }

    #[test]
    fn test_prepare_native_shader() {
        let source = concat!(
            "#version 320 es\n",
            "precision highp float;\n",
            "uniform float u_time;\n",
            "void main() {\n",
            "    float t = u_time * 0.1;\n",
            "    fragColor = vec4(t, t, t, 1.0);\n",
            "}\n",
        );
        let compiled = prepare_shader(source);

        // Palette function must be injected.
        assert!(
            compiled.contains("vec3 palette("),
            "palette function must be present"
        );

        // u_time declaration must not be duplicated.
        assert_eq!(
            compiled.matches("uniform float u_time").count(),
            1,
            "uniform float u_time must appear exactly once"
        );

        // u_alpha must be injected.
        assert!(
            compiled.contains("uniform float u_alpha"),
            "u_alpha uniform must be present"
        );

        // Native shader gets wrapped: user main renamed, wrapper applies alpha.
        assert!(
            compiled.contains("void _hyprsaver_main()"),
            "user main() must be renamed to _hyprsaver_main()"
        );
        assert!(
            compiled.contains("fragColor *= u_alpha"),
            "alpha multiply must be present"
        );
    }

    #[test]
    fn test_prepare_shadertoy_shader() {
        let source = concat!(
            "void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n",
            "    vec2 uv = fragCoord / iResolution.xy;\n",
            "    fragColor = vec4(uv, 0.5 + 0.5 * sin(iTime), 1.0);\n",
            "}\n",
        );
        let compiled = prepare_shader(source);

        assert!(
            compiled.contains("#define iTime u_time"),
            "iTime alias must be present"
        );
        assert!(
            compiled.contains("void main()"),
            "void main() wrapper must be present"
        );
        assert!(
            compiled.contains("mainImage(fragColor,"),
            "wrapper must call mainImage"
        );
        assert!(
            compiled.contains("vec3 palette("),
            "palette function must be present"
        );
        assert!(
            compiled.contains("uniform float u_time"),
            "u_time uniform must be present"
        );
        assert!(
            compiled.contains("uniform vec2 u_resolution"),
            "u_resolution must be present"
        );
        // Alpha uniform and multiply must be present in Shadertoy wrapper.
        assert!(
            compiled.contains("uniform float u_alpha"),
            "u_alpha uniform must be present"
        );
        assert!(
            compiled.contains("fragColor *= u_alpha"),
            "alpha multiply must be in main() wrapper"
        );
    }

    #[test]
    fn test_prepare_no_duplicate_uniforms() {
        // Source already declares u_time.
        let source = "uniform float u_time;\nvoid main() { fragColor = vec4(u_time); }\n";
        let compiled = prepare_shader(source);
        assert_eq!(
            compiled.matches("uniform float u_time").count(),
            1,
            "u_time uniform must appear exactly once"
        );
    }

    #[test]
    fn test_prepare_preserves_version() {
        let source = "#version 320 es\nprecision highp float;\nvoid main() {}\n";
        let compiled = prepare_shader(source);
        assert!(
            compiled.starts_with("#version 320 es"),
            "#version must be the first line; got: {}",
            compiled.lines().next().unwrap_or("")
        );
    }

    #[test]
    fn test_get_compiled() {
        let mgr = manager();
        let compiled = mgr.get_compiled("mandelbrot");
        assert!(compiled.is_some(), "mandelbrot compiled source must exist");
        assert!(
            !compiled.unwrap().is_empty(),
            "compiled source must not be empty"
        );
    }

    #[test]
    fn test_reload_nonexistent() {
        let tmp = std::env::temp_dir().join("hyprsaver_reload_test");
        std::fs::create_dir_all(&tmp).expect("cannot create temp dir");
        let mut mgr = ShaderManager::new(tmp).expect("ShaderManager::new must succeed");
        let result = mgr.reload_shader("doesnotexist");
        assert!(
            result.is_err(),
            "reload of a non-existent shader must return Err"
        );
    }
}
