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
use std::path::{Path, PathBuf};
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

/// Five-layer parallax snowfall with palette-colored dot glow and brightness pulse.
pub const BUILTIN_SNOWFALL: &str = include_str!("../shaders/snowfall.frag");

/// Hyperspace zoom tunnel — 120 stars radiate outward from a central vanishing point.
pub const BUILTIN_STARFIELD: &str = include_str!("../shaders/starfield.frag");

/// N-fold kaleidoscope driven by domain-warped FBM noise.
pub const BUILTIN_KALEIDOSCOPE: &str = include_str!("../shaders/kaleidoscope.frag");

/// Curl-noise flow field with 8-step particle tracing and palette-colored glow.
pub const BUILTIN_FLOW_FIELD: &str = include_str!("../shaders/flow_field.frag");

/// Raymarched torus with Phong lighting and palette-mapped surface color.
pub const BUILTIN_RAYMARCHER: &str = include_str!("../shaders/raymarcher.frag");

/// Three overlapping Lissajous curves with smooth glow and drifting hue.
pub const BUILTIN_LISSAJOUS: &str = include_str!("../shaders/lissajous.frag");

/// Classic 3D Pipes screensaver — glossy cylinders with sphere joints on a dark grid.
pub const BUILTIN_PIPES: &str = include_str!("../shaders/pipes.frag");

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
// Shader directory resolution
// ---------------------------------------------------------------------------

/// Outcome of resolving the user shader directory.
///
/// Priority:
/// 1. `$XDG_CONFIG_HOME/hypr/hyprsaver/shaders/` (new path)
/// 2. `$XDG_CONFIG_HOME/hyprsaver/shaders/` (legacy — deprecated)
///
/// If both exist and contain `.frag` files, both are used (new takes precedence).
#[derive(Debug, PartialEq)]
pub enum ShaderDirOutcome {
    /// Use the new path only.
    New(PathBuf),
    /// Use only the legacy path (new doesn't exist). Caller should log a deprecation warning.
    Legacy(PathBuf),
    /// Both exist and contain `.frag` files. Load from both; new takes precedence.
    /// Caller should log a deprecation warning about the legacy path.
    Both { new: PathBuf, legacy: PathBuf },
    /// Neither directory exists; only built-in shaders are available.
    NotFound(PathBuf),
}

/// Resolve the user shader directory, checking the new Hyprland-ecosystem location
/// first and falling back to the legacy location.
///
/// The returned `ShaderDirOutcome` tells the caller which directory to use as the
/// primary (and which legacy directory to also load from, if applicable).
pub fn resolve_shader_dir() -> ShaderDirOutcome {
    let cfg_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from(".config"));
    let new_dir = cfg_dir.join("hypr").join("hyprsaver").join("shaders");
    let legacy_dir = cfg_dir.join("hyprsaver").join("shaders");
    resolve_shader_dir_impl(new_dir, legacy_dir)
}

/// Inner implementation that accepts explicit paths for testability.
fn resolve_shader_dir_impl(new_dir: PathBuf, legacy_dir: PathBuf) -> ShaderDirOutcome {
    let new_exists = new_dir.is_dir();
    let legacy_has_frags = legacy_dir.is_dir() && dir_has_frags(&legacy_dir);

    if new_exists {
        if legacy_has_frags {
            ShaderDirOutcome::Both {
                new: new_dir,
                legacy: legacy_dir,
            }
        } else {
            ShaderDirOutcome::New(new_dir)
        }
    } else if legacy_has_frags {
        ShaderDirOutcome::Legacy(legacy_dir)
    } else if legacy_dir.is_dir() {
        // Legacy dir exists but is empty; treat as "new dir" for the watcher path.
        ShaderDirOutcome::New(new_dir)
    } else {
        ShaderDirOutcome::NotFound(new_dir)
    }
}

/// Returns `true` if `dir` contains at least one `.frag` file.
fn dir_has_frags(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .any(|e| e.path().extension().and_then(|ext| ext.to_str()) == Some("frag"))
        })
        .unwrap_or(false)
}

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
    /// Current position in the cycle. Advances on each `cycle_next()` call.
    cycle_index: usize,
    /// If `Some`, `cycle_next()` iterates only these names (in order).
    /// If `None`, iterates all shaders sorted by name.
    playlist: Option<Vec<String>>,
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
            ("pipes", BUILTIN_PIPES),
            ("plasma", BUILTIN_PLASMA),
            ("raymarcher", BUILTIN_RAYMARCHER),
            ("snowfall", BUILTIN_SNOWFALL),
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
            cycle_index: 0,
            playlist: None,
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

    /// Advance the cycle index and return the name of the next shader.
    ///
    /// If a playlist is set, iterates only playlist items in definition order.
    /// Otherwise iterates all available shaders alphabetically.
    /// Wraps around when it reaches the end. Returns `None` if there are no shaders.
    ///
    /// Call `get()` or `get_compiled()` with the returned name to access the source.
    pub fn cycle_next(&mut self) -> Option<String> {
        let names: Vec<String> = match &self.playlist {
            Some(pl) => pl
                .iter()
                .filter(|n| self.shaders.contains_key(*n))
                .cloned()
                .collect(),
            None => {
                let mut ns: Vec<String> = self.shaders.keys().cloned().collect();
                ns.sort_unstable();
                ns
            }
        };
        if names.is_empty() {
            return None;
        }
        self.cycle_index = self.cycle_index.wrapping_add(1) % names.len();
        Some(names[self.cycle_index].clone())
    }

    /// Set a playlist so that `cycle_next()` iterates only the given names.
    /// Pass an empty vec or call without a playlist to reset to "cycle all".
    pub fn set_playlist(&mut self, names: Vec<String>) {
        if names.is_empty() {
            self.playlist = None;
        } else {
            self.playlist = Some(names);
        }
        self.cycle_index = 0;
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

    /// Load a shader from an arbitrary file path (e.g. `~/my.frag` for preview mode).
    ///
    /// The shader is registered under its file stem (e.g. `"my"`). Returns the name
    /// on success. On failure, no entry is added or modified.
    pub fn load_from_path(&mut self, path: &std::path::Path) -> anyhow::Result<String> {
        use anyhow::Context;
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow::anyhow!("path '{}' has no file stem", path.display()))?
            .to_string();
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("cannot read shader file: {}", path.display()))?;
        let raw = content
            .strip_prefix('\u{FEFF}')
            .unwrap_or(&content)
            .to_string();
        let compiled = prepare_shader(&raw);
        log::info!("Loaded shader '{}' from {}", name, path.display());
        self.shaders.insert(
            name.clone(),
            ShaderSource {
                name: name.clone(),
                raw,
                compiled,
                builtin: false,
            },
        );
        Ok(name)
    }

    /// Load all `.frag` files from `dir` without overwriting entries that are already
    /// registered. Used for merging the legacy shader directory when both the new and
    /// legacy directories exist — the new-path shaders are loaded first, so they win
    /// on name collision.
    pub fn load_from_dir_no_overwrite(&mut self, dir: &Path) {
        if !dir.is_dir() {
            return;
        }
        match std::fs::read_dir(dir) {
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
                    // Skip if already registered (new-path shader takes precedence).
                    if self.shaders.contains_key(&name) {
                        log::info!(
                            "Shader '{name}': new-path version takes precedence over legacy {:?}",
                            path
                        );
                        continue;
                    }
                    match std::fs::read_to_string(&path) {
                        Ok(content) => {
                            let raw = content
                                .strip_prefix('\u{FEFF}')
                                .unwrap_or(&content)
                                .to_string();
                            let compiled = prepare_shader(&raw);
                            self.shaders.insert(
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
                            log::warn!("Failed to load legacy shader {:?}: {e}", path);
                        }
                    }
                }
            }
            Err(e) => {
                log::warn!("Failed to read legacy shader directory {:?}: {e}", dir);
            }
        }
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

    // Speed / zoom multipliers — uploaded every frame; default 1.0 in daemon mode.
    // Check for the *declaration* (not just usage) so shaders that reference these
    // uniforms in their body without declaring them still get the injection.
    if !source.contains("uniform float u_speed_scale") {
        out.push_str("uniform float u_speed_scale;\n");
    }
    if !source.contains("uniform float u_zoom_scale") {
        out.push_str("uniform float u_zoom_scale;\n");
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
        assert_eq!(manager().list().len(), 12);
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
            "snowfall",
            "starfield",
            "kaleidoscope",
            "flow_field",
            "raymarcher",
            "lissajous",
            "pipes",
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

    /// Regression test: shaders that USE u_speed_scale / u_zoom_scale in their body
    /// without declaring them must still get the uniform declaration injected.
    /// Previously, `source.contains("u_speed_scale")` matched the usage and skipped
    /// injection, causing a GLSL compile error ("undeclared identifier").
    #[test]
    fn test_speed_zoom_injected_when_used_but_not_declared() {
        let source = concat!(
            "#version 320 es\n",
            "precision highp float;\n",
            "uniform float u_time;\n",
            "void main() {\n",
            "    float t = u_time * u_speed_scale;\n",
            "    float z = 1.0 * u_zoom_scale;\n",
            "    fragColor = vec4(t, z, 0.0, 1.0);\n",
            "}\n",
        );
        let compiled = prepare_shader(source);
        assert!(
            compiled.contains("uniform float u_speed_scale;"),
            "u_speed_scale declaration must be injected when used but not declared"
        );
        assert!(
            compiled.contains("uniform float u_zoom_scale;"),
            "u_zoom_scale declaration must be injected when used but not declared"
        );
        // Must appear exactly once each.
        assert_eq!(
            compiled.matches("uniform float u_speed_scale").count(),
            1,
            "u_speed_scale uniform must appear exactly once"
        );
        assert_eq!(
            compiled.matches("uniform float u_zoom_scale").count(),
            1,
            "u_zoom_scale uniform must appear exactly once"
        );
    }

    /// Shaders that already declare u_speed_scale / u_zoom_scale must not get
    /// a duplicate injection.
    #[test]
    fn test_speed_zoom_no_duplicate_when_already_declared() {
        let source = concat!(
            "uniform float u_speed_scale;\n",
            "uniform float u_zoom_scale;\n",
            "void main() {\n",
            "    float t = u_speed_scale * u_zoom_scale;\n",
            "    fragColor = vec4(t, 0.0, 0.0, 1.0);\n",
            "}\n",
        );
        let compiled = prepare_shader(source);
        assert_eq!(
            compiled.matches("uniform float u_speed_scale").count(),
            1,
            "u_speed_scale must appear exactly once"
        );
        assert_eq!(
            compiled.matches("uniform float u_zoom_scale").count(),
            1,
            "u_zoom_scale must appear exactly once"
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
    fn test_cycle_next_iterates_all_sorted() {
        let mut mgr = manager();
        let sorted = mgr.list().iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let n = sorted.len();
        let mut seen = Vec::new();
        for _ in 0..n {
            let name = mgr.cycle_next().expect("must return Some");
            seen.push(name);
        }
        let mut seen_sorted = seen.clone();
        seen_sorted.sort_unstable();
        assert_eq!(seen_sorted, sorted, "cycle_next must visit all shaders");
    }

    #[test]
    fn test_cycle_next_wraps_around() {
        let mut mgr = manager();
        let n = mgr.list().len();
        // Record what the first call returns, then advance n-1 more times to
        // complete one full rotation (n calls total). The n+1th call must match.
        let first_name = mgr.cycle_next().expect("must return Some");
        for _ in 0..(n - 1) {
            mgr.cycle_next().expect("must return Some");
        }
        let after_full_rotation = mgr.cycle_next().expect("must return Some");
        assert_eq!(
            after_full_rotation, first_name,
            "cycle_next must wrap back after n calls"
        );
    }

    #[test]
    fn test_set_playlist_restricts_cycle() {
        let mut mgr = manager();
        // cycle_index starts at 0; first call increments to 1.
        // Playlist = ["mandelbrot", "julia"], so: call1→"julia", call2→"mandelbrot", call3→"julia".
        mgr.set_playlist(vec!["mandelbrot".to_string(), "julia".to_string()]);
        let name1 = mgr.cycle_next().expect("must return Some");
        let name2 = mgr.cycle_next().expect("must return Some");
        let name3 = mgr.cycle_next().expect("must return Some"); // wraps
        assert_eq!(name1, "julia");
        assert_eq!(name2, "mandelbrot");
        assert_eq!(name3, "julia", "must wrap around within playlist");
    }

    #[test]
    fn test_set_playlist_empty_resets_to_all() {
        let mut mgr = manager();
        mgr.set_playlist(vec!["mandelbrot".to_string()]);
        mgr.set_playlist(vec![]); // reset
        let n = mgr.list().len();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..n {
            let name = mgr.cycle_next().expect("must return Some");
            seen.insert(name);
        }
        assert_eq!(seen.len(), n, "after reset, all shaders should be visited");
    }

    #[test]
    fn test_random_selection_unchanged() {
        let mgr = manager();
        let (name, _src) = mgr.random();
        assert!(
            mgr.get(name).is_some(),
            "random() must return a known shader"
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

    // ---------------------------------------------------------------------------
    // resolve_shader_dir tests
    // ---------------------------------------------------------------------------

    #[test]
    fn test_resolve_shader_dir_new_only() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let new_dir = tmp.path().join("new_shaders");
        let legacy_dir = tmp.path().join("legacy_shaders");
        std::fs::create_dir_all(&new_dir).expect("create new_dir");

        let outcome = resolve_shader_dir_impl(new_dir.clone(), legacy_dir);
        assert_eq!(outcome, ShaderDirOutcome::New(new_dir));
    }

    #[test]
    fn test_resolve_shader_dir_legacy_only_with_frags() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let new_dir = tmp.path().join("new_shaders");
        let legacy_dir = tmp.path().join("legacy_shaders");
        std::fs::create_dir_all(&legacy_dir).expect("create legacy_dir");
        std::fs::write(legacy_dir.join("test.frag"), "void main() {}").expect("write frag");

        let outcome = resolve_shader_dir_impl(new_dir, legacy_dir.clone());
        assert_eq!(outcome, ShaderDirOutcome::Legacy(legacy_dir));
    }

    #[test]
    fn test_resolve_shader_dir_both_with_frags() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let new_dir = tmp.path().join("new_shaders");
        let legacy_dir = tmp.path().join("legacy_shaders");
        std::fs::create_dir_all(&new_dir).expect("create new_dir");
        std::fs::create_dir_all(&legacy_dir).expect("create legacy_dir");
        std::fs::write(legacy_dir.join("test.frag"), "void main() {}").expect("write frag");

        let outcome = resolve_shader_dir_impl(new_dir.clone(), legacy_dir.clone());
        assert_eq!(
            outcome,
            ShaderDirOutcome::Both {
                new: new_dir,
                legacy: legacy_dir,
            }
        );
    }

    #[test]
    fn test_resolve_shader_dir_neither_exists() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let new_dir = tmp.path().join("new_shaders");
        let legacy_dir = tmp.path().join("legacy_shaders");

        let outcome = resolve_shader_dir_impl(new_dir.clone(), legacy_dir);
        assert_eq!(outcome, ShaderDirOutcome::NotFound(new_dir));
    }

    #[test]
    fn test_load_from_dir_no_overwrite() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir_a = tmp.path().join("dir_a");
        let dir_b = tmp.path().join("dir_b");
        std::fs::create_dir_all(&dir_a).expect("create dir_a");
        std::fs::create_dir_all(&dir_b).expect("create dir_b");

        // Write "shared" to both dirs — dir_a version should win.
        std::fs::write(
            dir_a.join("shared.frag"),
            "#version 320 es\nprecision highp float;\nvoid main() { fragColor = vec4(1.0); }\n",
        )
        .expect("write dir_a/shared.frag");
        std::fs::write(
            dir_b.join("shared.frag"),
            "#version 320 es\nprecision highp float;\nvoid main() { fragColor = vec4(0.0); }\n",
        )
        .expect("write dir_b/shared.frag");
        // Write "unique_b" only in dir_b.
        std::fs::write(
            dir_b.join("unique_b.frag"),
            "#version 320 es\nprecision highp float;\nvoid main() { fragColor = vec4(0.5); }\n",
        )
        .expect("write dir_b/unique_b.frag");

        let mut mgr = ShaderManager::new(dir_a).expect("ShaderManager::new must succeed");
        mgr.load_from_dir_no_overwrite(&dir_b);

        // "shared" should contain the dir_a version (vec4(1.0)).
        let shared = mgr.get("shared").expect("shared must exist");
        assert!(
            shared.raw.contains("vec4(1.0)"),
            "dir_a version of 'shared' must win"
        );
        // "unique_b" should be loaded from dir_b.
        assert!(
            mgr.get("unique_b").is_some(),
            "unique_b from dir_b must be loaded"
        );
    }
}
