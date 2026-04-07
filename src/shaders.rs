//! `shaders.rs` — Shader loading, compilation management, hot-reload, and Shadertoy compat.
//!
//! Responsibilities:
//! - Maintain a registry of available shaders: built-ins (compiled into the binary via
//!   `include_str!()`) and user shaders loaded from the config shader directory
//! - Watch the shader directory for filesystem changes and report which shaders changed
//! - Shadertoy compatibility shim: remap `iTime`/`iResolution`/etc. uniforms and wrap
//!   `mainImage(out vec4, in vec2)` into `void main()`
//! - Prepend the cosine palette function and uniform declarations to every shader

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
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

// ---------------------------------------------------------------------------
// Palette preamble injected into every shader
// ---------------------------------------------------------------------------

/// GLSL preamble prepended to every fragment shader. Declares palette uniforms and
/// the `palette(t)` convenience function (Inigo Quilez cosine gradient technique).
pub const PALETTE_PREAMBLE: &str = r#"
uniform vec3 u_palette_a;
uniform vec3 u_palette_b;
uniform vec3 u_palette_c;
uniform vec3 u_palette_d;

/// Cosine gradient palette. Returns an RGB color for parameter t ∈ [0, 1].
/// Reference: https://iquilezles.org/articles/palettes/
vec3 palette(float t) {
    return u_palette_a + u_palette_b * cos(6.28318530718 * (u_palette_c * t + u_palette_d));
}
"#;

// ---------------------------------------------------------------------------
// ShaderManager
// ---------------------------------------------------------------------------

/// Manages the collection of available shaders and the hot-reload watcher.
pub struct ShaderManager {
    /// Directory scanned for user `.frag` files.
    shader_dir: PathBuf,

    /// Map of shader name → preprocessed source (palette preamble prepended,
    /// Shadertoy uniforms remapped, mainImage wrapped).
    shaders: HashMap<String, String>,

    /// Filesystem watcher. `None` if hot-reload is disabled or watcher failed to start.
    watcher: Option<RecommendedWatcher>,

    /// Receiver for filesystem change events from the watcher thread.
    change_rx: Option<mpsc::Receiver<notify::Result<notify::Event>>>,
}

impl ShaderManager {
    /// Create a new ShaderManager. Loads built-ins immediately.
    /// If `shader_dir` exists, scans it for `.frag` files.
    pub fn new(shader_dir: PathBuf) -> anyhow::Result<Self> {
        todo!(
            "register all BUILTIN_* constants into self.shaders with their canonical names \
             (mandelbrot, julia, plasma, tunnel, voronoi); \
             if shader_dir exists, scan *.frag files and load them too"
        )
    }

    /// Return a sorted list of all known shader names.
    pub fn list(&self) -> Vec<&str> {
        todo!("collect self.shaders.keys(), sort, return as Vec<&str>")
    }

    /// Return the preprocessed source for the named shader, or `None` if unknown.
    pub fn get(&self, name: &str) -> Option<&str> {
        todo!("self.shaders.get(name).map(String::as_str)")
    }

    /// Start watching `shader_dir` for `.frag` file changes.
    /// Does nothing (and logs a warning) if the watcher is already running or the dir
    /// does not exist.
    pub fn watch_for_changes(&mut self) {
        todo!(
            "create mpsc channel, create RecommendedWatcher that sends to tx, \
             watch shader_dir with RecursiveMode::NonRecursive, \
             store watcher and rx in self"
        )
    }

    /// Drain the filesystem event queue and return the names of shaders whose source
    /// has changed. Reloads changed files into `self.shaders` automatically.
    /// Returns an empty Vec if hot-reload is not active or no changes occurred.
    pub fn poll_changes(&mut self) -> Vec<String> {
        todo!(
            "drain change_rx, for each Create/Modify event re-read the .frag file, \
             run preprocess() on it, update self.shaders, collect changed shader names"
        )
    }

    // ------------------------------------------------------------------
    // Preprocessing pipeline
    // ------------------------------------------------------------------

    /// Full preprocessing pipeline applied to every shader source:
    /// 1. `shadertoy_compat()` — detect and remap Shadertoy conventions
    /// 2. Prepend `PALETTE_PREAMBLE`
    /// 3. Prepend the standard uniform declarations (`u_time`, `u_resolution`, etc.)
    pub fn preprocess(source: &str) -> String {
        todo!(
            "call shadertoy_compat(source), prepend UNIFORM_PREAMBLE then PALETTE_PREAMBLE, \
             return combined string"
        )
    }
}

/// Standard uniform declarations prepended to every shader (after version + precision directives).
pub const UNIFORM_PREAMBLE: &str = r#"
uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
"#;

// ---------------------------------------------------------------------------
// Shadertoy compatibility shim
// ---------------------------------------------------------------------------

/// Transform a Shadertoy-style fragment shader into hyprsaver's native format.
///
/// Detection heuristic: if the source contains `void mainImage` or any of the
/// Shadertoy uniform names (`iTime`, `iResolution`, `iMouse`, `iFrame`), treat it as
/// Shadertoy-style.
///
/// Transformations applied:
/// - `iTime`       → `u_time`
/// - `iResolution` → `vec3(u_resolution, 0.0)` (Shadertoy iResolution is vec3)
/// - `iMouse`      → `vec4(u_mouse, 0.0, 0.0)` (Shadertoy iMouse is vec4)
/// - `iFrame`      → `u_frame`
/// - If `void mainImage` is present, append a `void main()` wrapper that calls it.
pub fn shadertoy_compat(source: &str) -> String {
    todo!(
        "check if source contains Shadertoy markers; if not, return source unchanged; \
         otherwise perform text substitutions for each uniform alias, \
         then if mainImage is present append the void main() wrapper below"
    )
}

/// The `void main()` wrapper appended when a Shadertoy `mainImage` function is detected.
pub const SHADERTOY_MAIN_WRAPPER: &str = r#"
out vec4 fragColor;

void main() {
    mainImage(fragColor, gl_FragCoord.xy);
}
"#;
