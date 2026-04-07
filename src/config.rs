//! `config.rs` — Configuration loading and defaults for hyprsaver.
//!
//! Responsibilities:
//! - Define the full `Config` struct hierarchy with serde derive
//! - Provide sensible defaults for every field via `#[serde(default)]`
//! - Resolve the config file path: CLI flag → `$XDG_CONFIG_HOME/hyprsaver/config.toml`
//!   → `~/.config/hyprsaver/config.toml` → built-in defaults (zero-config must work)
//! - Parse TOML via the `toml` crate

use serde::Deserialize;
use std::collections::HashMap;

use crate::palette::Palette;

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

/// Complete hyprsaver configuration. All fields are optional in the TOML file;
/// missing keys fall back to the `Default` impl.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Config {
    #[serde(default)]
    pub general: GeneralConfig,

    #[serde(default)]
    pub behavior: BehaviorConfig,

    /// User-defined palettes keyed by name. Merged with built-in palettes at runtime.
    #[serde(default)]
    pub palettes: HashMap<String, Palette>,
}

// ---------------------------------------------------------------------------
// [general]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct GeneralConfig {
    /// Target render FPS. Default: 30.
    pub fps: u32,

    /// Shader to use. One of: a shader name, `"random"`, or `"cycle"`. Default: `"mandelbrot"`.
    pub shader: String,

    /// Palette to use. One of: a palette name, `"random"`, or `"cycle"`. Default: `"electric"`.
    pub palette: String,

    /// How many seconds to display each shader before cycling. Default: 300 (5 min).
    pub shader_cycle_interval: u64,

    /// Optional ordered list of palette names for cycle rotation.
    pub palette_cycle: Vec<String>,
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self {
            fps: 30,
            shader: "mandelbrot".to_string(),
            palette: "electric".to_string(),
            shader_cycle_interval: 300,
            palette_cycle: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// [behavior]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct BehaviorConfig {
    /// Fade-in duration in milliseconds. Default: 800.
    pub fade_in_ms: u64,

    /// Fade-out duration in milliseconds. Default: 400.
    pub fade_out_ms: u64,

    /// Which input events dismiss the screensaver. Default: all four.
    pub dismiss_on: Vec<DismissEvent>,
}

impl Default for BehaviorConfig {
    fn default() -> Self {
        Self {
            fade_in_ms: 800,
            fade_out_ms: 400,
            dismiss_on: vec![
                DismissEvent::Key,
                DismissEvent::MouseMove,
                DismissEvent::MouseClick,
                DismissEvent::Touch,
            ],
        }
    }
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
// Config loading
// ---------------------------------------------------------------------------

/// Resolve and load the config file.
///
/// - If `path` is `Some`, read it (returns an error if the file is missing).
/// - Otherwise, try `$XDG_CONFIG_HOME/hyprsaver/config.toml`, then
///   `~/.config/hyprsaver/config.toml`.
/// - If no file is found, returns `Config::default()` (zero-config mode).
pub fn load_config(path: Option<&str>) -> anyhow::Result<Config> {
    use anyhow::Context;

    if let Some(explicit) = path {
        let content = std::fs::read_to_string(explicit)
            .with_context(|| format!("failed to read config file: {explicit}"))?;
        let config = toml::from_str::<Config>(&content)
            .with_context(|| format!("failed to parse config file: {explicit}"))?;
        return Ok(config);
    }

    // Try XDG_CONFIG_HOME / hyprsaver / config.toml
    if let Some(xdg_cfg) = dirs::config_dir() {
        let candidate = xdg_cfg.join("hyprsaver").join("config.toml");
        if candidate.exists() {
            let content = std::fs::read_to_string(&candidate)
                .with_context(|| format!("failed to read config file: {}", candidate.display()))?;
            return toml::from_str::<Config>(&content)
                .with_context(|| format!("failed to parse config file: {}", candidate.display()));
        }
    }

    // Try ~/.config/hyprsaver/config.toml (explicit home fallback)
    if let Some(home) = dirs::home_dir() {
        let candidate = home.join(".config").join("hyprsaver").join("config.toml");
        if candidate.exists() {
            let content = std::fs::read_to_string(&candidate)
                .with_context(|| format!("failed to read config file: {}", candidate.display()))?;
            return toml::from_str::<Config>(&content)
                .with_context(|| format!("failed to parse config file: {}", candidate.display()));
        }
    }

    log::info!("No config file found, using defaults");
    Ok(Config::default())
}

impl Config {
    /// Override `general.shader` and/or `general.palette` from CLI arguments.
    pub fn apply_cli_overrides(&mut self, shader: Option<&str>, palette: Option<&str>) {
        if let Some(s) = shader {
            self.general.shader = s.to_string();
        }
        if let Some(p) = palette {
            self.general.palette = p.to_string();
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let cfg = Config::default();
        assert_eq!(cfg.general.fps, 30);
        assert_eq!(cfg.general.shader, "mandelbrot");
        assert_eq!(cfg.general.palette, "electric");
        assert_eq!(cfg.general.shader_cycle_interval, 300);
        assert!(cfg.general.palette_cycle.is_empty());
        assert_eq!(cfg.behavior.fade_in_ms, 800);
        assert_eq!(cfg.behavior.fade_out_ms, 400);
        assert!(cfg.behavior.dismiss_on.contains(&DismissEvent::Key));
        assert!(cfg.behavior.dismiss_on.contains(&DismissEvent::MouseMove));
        assert!(cfg.behavior.dismiss_on.contains(&DismissEvent::MouseClick));
        assert!(cfg.behavior.dismiss_on.contains(&DismissEvent::Touch));
        assert!(cfg.palettes.is_empty());
    }

    #[test]
    fn test_parse_minimal_toml() {
        let cfg: Config = toml::from_str("").expect("empty TOML must parse");
        assert_eq!(cfg.general.fps, 30);
        assert_eq!(cfg.general.shader, "mandelbrot");
        assert_eq!(cfg.general.palette, "electric");
        assert_eq!(cfg.behavior.fade_in_ms, 800);
        assert_eq!(cfg.behavior.fade_out_ms, 400);
        assert_eq!(cfg.behavior.dismiss_on.len(), 4);
    }

    #[test]
    fn test_parse_full_toml() {
        let toml_str = r#"
[general]
fps = 60
shader = "julia"
palette = "vapor"
shader_cycle_interval = 120
palette_cycle = ["electric", "frost"]

[behavior]
fade_in_ms = 200
fade_out_ms = 100
dismiss_on = ["key", "touch"]
"#;
        let cfg: Config = toml::from_str(toml_str).expect("full TOML must parse");
        assert_eq!(cfg.general.fps, 60);
        assert_eq!(cfg.general.shader, "julia");
        assert_eq!(cfg.general.palette, "vapor");
        assert_eq!(cfg.general.shader_cycle_interval, 120);
        assert_eq!(cfg.general.palette_cycle, vec!["electric", "frost"]);
        assert_eq!(cfg.behavior.fade_in_ms, 200);
        assert_eq!(cfg.behavior.fade_out_ms, 100);
        assert_eq!(
            cfg.behavior.dismiss_on,
            vec![DismissEvent::Key, DismissEvent::Touch]
        );
    }

    #[test]
    fn test_parse_custom_palette() {
        let toml_str = r#"
[palettes.neon]
a = [0.1, 0.2, 0.3]
b = [0.4, 0.5, 0.6]
c = [1.0, 2.0, 3.0]
d = [0.0, 0.1, 0.2]
"#;
        let cfg: Config = toml::from_str(toml_str).expect("palette TOML must parse");
        let neon = cfg.palettes.get("neon").expect("neon palette must exist");
        assert_eq!(neon.a, [0.1, 0.2, 0.3]);
        assert_eq!(neon.b, [0.4, 0.5, 0.6]);
        assert_eq!(neon.c, [1.0, 2.0, 3.0]);
        assert_eq!(neon.d, [0.0, 0.1, 0.2]);
    }

    #[test]
    fn test_parse_partial_toml() {
        let toml_str = "[general]\nfps = 60\n";
        let cfg: Config = toml::from_str(toml_str).expect("partial TOML must parse");
        assert_eq!(cfg.general.fps, 60);
        assert_eq!(cfg.general.shader, "mandelbrot");
        assert_eq!(cfg.general.palette, "electric");
        assert_eq!(cfg.behavior.fade_in_ms, 800);
        assert_eq!(cfg.behavior.fade_out_ms, 400);
    }

    #[test]
    fn test_cli_overrides() {
        let mut cfg = Config::default();
        cfg.apply_cli_overrides(Some("julia"), Some("vapor"));
        assert_eq!(cfg.general.shader, "julia");
        assert_eq!(cfg.general.palette, "vapor");
    }

    #[test]
    fn test_cli_overrides_partial() {
        let mut cfg = Config::default();
        cfg.apply_cli_overrides(Some("julia"), None);
        assert_eq!(cfg.general.shader, "julia");
        assert_eq!(cfg.general.palette, "electric"); // unchanged
    }

    #[test]
    fn test_missing_file_returns_default() {
        // Explicit nonexistent path must return an error.
        assert!(
            load_config(Some("/nonexistent_hyprsaver_xyz/config.toml")).is_err(),
            "explicit nonexistent path should error"
        );

        // load_config(None) with no config file on disk returns Config::default().
        // Override XDG_CONFIG_HOME and HOME to point at a nonexistent directory so
        // no config file can be found.
        let orig_xdg = std::env::var("XDG_CONFIG_HOME").ok();
        let orig_home = std::env::var("HOME").ok();

        std::env::set_var("XDG_CONFIG_HOME", "/nonexistent_xdg_hyprsaver_test");
        std::env::set_var("HOME", "/nonexistent_home_hyprsaver_test");

        let result = load_config(None);

        // Restore env vars
        match orig_xdg {
            Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
            None => std::env::remove_var("XDG_CONFIG_HOME"),
        }
        match orig_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }

        let cfg = result.expect("load_config(None) with no file must return Ok");
        assert_eq!(cfg.general.fps, 30);
        assert_eq!(cfg.general.shader, "mandelbrot");
    }
}
