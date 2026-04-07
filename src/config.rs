//! `config.rs` — Configuration loading and defaults for hyprsaver.
//!
//! Responsibilities:
//! - Define the full `Config` struct hierarchy with serde derive
//! - Provide sensible defaults for every field via `#[serde(default)]`
//! - Resolve the config file path: CLI flag → `$XDG_CONFIG_HOME/hyprsaver/config.toml`
//!   → `~/.config/hyprsaver/config.toml` → built-in defaults (zero-config must work)
//! - Parse TOML via the `toml` crate

use serde::Deserialize;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

/// Complete hyprsaver configuration. All fields are optional in the TOML file;
/// missing keys fall back to the `Default` impl.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub general: GeneralConfig,

    #[serde(default)]
    pub behavior: BehaviorConfig,

    #[serde(default)]
    pub shaders: ShaderConfig,

    #[serde(default)]
    pub palettes: PaletteConfig,
}

// ---------------------------------------------------------------------------
// [general]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct GeneralConfig {
    /// Target render FPS. Default: 30.
    #[serde(default = "default_fps")]
    pub fps: u32,

    /// Shader to use. One of: a shader name, `"random"`, or `"cycle"`. Default: `"mandelbrot"`.
    #[serde(default = "default_shader")]
    pub shader: String,

    /// Palette to use. One of: a palette name, `"random"`, or `"cycle"`. Default: `"electric"`.
    #[serde(default = "default_palette")]
    pub palette: String,

    /// How many seconds to display each shader before cycling. Default: 300 (5 min).
    #[serde(default = "default_shader_cycle_interval")]
    pub shader_cycle_interval: u64,

    /// Optional ordered list of palette names for month-indexed rotation.
    /// If provided and `palette = "cycle"`, the palette at index (current_month - 1) is used.
    #[serde(default)]
    pub palette_cycle: Vec<String>,
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self {
            fps: default_fps(),
            shader: default_shader(),
            palette: default_palette(),
            shader_cycle_interval: default_shader_cycle_interval(),
            palette_cycle: Vec::new(),
        }
    }
}

fn default_fps() -> u32 { 30 }
fn default_shader() -> String { "mandelbrot".to_string() }
fn default_palette() -> String { "electric".to_string() }
fn default_shader_cycle_interval() -> u64 { 300 }

// ---------------------------------------------------------------------------
// [behavior]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct BehaviorConfig {
    /// Fade-in duration in milliseconds. Default: 800.
    #[serde(default = "default_fade_in_ms")]
    pub fade_in_ms: u64,

    /// Fade-out duration in milliseconds. Default: 400.
    #[serde(default = "default_fade_out_ms")]
    pub fade_out_ms: u64,

    /// Which input events dismiss the screensaver. Default: all four.
    #[serde(default = "default_dismiss_on")]
    pub dismiss_on: Vec<DismissEvent>,
}

impl Default for BehaviorConfig {
    fn default() -> Self {
        Self {
            fade_in_ms: default_fade_in_ms(),
            fade_out_ms: default_fade_out_ms(),
            dismiss_on: default_dismiss_on(),
        }
    }
}

fn default_fade_in_ms() -> u64 { 800 }
fn default_fade_out_ms() -> u64 { 400 }
fn default_dismiss_on() -> Vec<DismissEvent> {
    vec![
        DismissEvent::Key,
        DismissEvent::MouseMove,
        DismissEvent::MouseClick,
        DismissEvent::Touch,
    ]
}

/// Input events that can dismiss the screensaver.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DismissEvent {
    Key,
    MouseMove,
    MouseClick,
    Touch,
}

// ---------------------------------------------------------------------------
// [shaders]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct ShaderConfig {
    /// Directory to search for user `.frag` shader files.
    /// Default: `~/.config/hyprsaver/shaders/`
    #[serde(default = "default_shader_dir")]
    pub shader_dir: PathBuf,

    /// Watch `shader_dir` for changes and hot-reload. Default: true.
    #[serde(default = "default_true")]
    pub hot_reload: bool,

    /// Fall back to built-in shader on compile error instead of crashing. Default: true.
    #[serde(default = "default_true")]
    pub fallback_on_error: bool,
}

impl Default for ShaderConfig {
    fn default() -> Self {
        Self {
            shader_dir: default_shader_dir(),
            hot_reload: true,
            fallback_on_error: true,
        }
    }
}

fn default_shader_dir() -> PathBuf {
    todo!("return dirs::config_dir() / hyprsaver / shaders, or ~/.config/hyprsaver/shaders")
}

// ---------------------------------------------------------------------------
// [palettes]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PaletteConfig {
    /// User-defined palettes keyed by name. Merged with built-in palettes; user entries win.
    #[serde(default)]
    pub custom: std::collections::HashMap<String, crate::palette::Palette>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn default_true() -> bool { true }

impl Config {
    /// Resolve the config file path and parse it. Returns `Config::default()` if no file
    /// is found (zero-config mode).
    pub fn load(explicit_path: Option<&std::path::Path>) -> anyhow::Result<Self> {
        todo!(
            "if explicit_path given, read it (error if missing); \
             else try XDG_CONFIG_HOME/hyprsaver/config.toml then \
             ~/.config/hyprsaver/config.toml; if neither exists return Default::default()"
        )
    }
}
