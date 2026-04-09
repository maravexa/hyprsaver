//! `config.rs` — Configuration loading and defaults for hyprsaver.
//!
//! Responsibilities:
//! - Define the full `Config` struct hierarchy with serde derive
//! - Provide sensible defaults for every field via `#[serde(default)]`
//! - Resolve the config file path: CLI flag → `$XDG_CONFIG_HOME/hypr/hyprsaver.toml`
//!   (new) → `$XDG_CONFIG_HOME/hyprsaver/config.toml` (legacy, deprecated) →
//!   built-in defaults (zero-config must work)
//! - Parse TOML via the `toml` crate

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

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

    /// User-defined cosine palettes keyed by name (`[palettes.name]` TOML syntax).
    /// Merged with built-in cosine palettes at runtime.
    #[serde(default)]
    pub palettes: HashMap<String, Palette>,

    /// Extended palette entries using `[[palette]]` table-array syntax.
    /// Supports `type = "lut"` (PNG file) and `type = "gradient"` (CSS stops).
    #[serde(default, rename = "palette")]
    pub palette_entries: Vec<PaletteConfigEntry>,

    /// Per-monitor shader and palette overrides using `[[monitor]]` table-array syntax.
    /// Each entry matches a Wayland output by name (from `hyprctl monitors`).
    /// Monitors without an entry use the global `[general]` shader/palette.
    #[serde(default, rename = "monitor")]
    pub monitors: Vec<MonitorConfig>,

    /// Named shader playlists (`[shader_playlists.name]` TOML syntax).
    /// Used when `general.shader_playlist` selects a named subset for cycle mode.
    #[serde(default)]
    pub shader_playlists: HashMap<String, ShaderPlaylist>,

    /// Named palette playlists (`[palette_playlists.name]` TOML syntax).
    /// Used when `general.palette_playlist` selects a named subset for cycle mode.
    #[serde(default)]
    pub palette_playlists: HashMap<String, PalettePlaylist>,
}

// ---------------------------------------------------------------------------
// [general]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct GeneralConfig {
    /// Target render FPS. Default: 30.
    pub fps: u32,

    /// Shader to use. One of: a shader name, `"random"`, or `"cycle"`. Default: `"cycle"`.
    pub shader: String,

    /// Palette to use. One of: a palette name, `"random"`, or `"cycle"`. Default: `"cycle"`.
    pub palette: String,

    /// How many seconds to display each shader before cycling. Default: 300 (5 min).
    pub shader_cycle_interval: u64,

    /// How many seconds to display each palette before cycling. Default: 60.
    pub palette_cycle_interval: u64,

    /// Optional ordered list of palette names for cycle rotation (legacy field).
    pub palette_cycle: Vec<String>,

    /// Cross-fade duration when switching palettes, in seconds. `0.0` = instant snap (default).
    pub palette_transition_duration: f32,

    /// Named shader playlist to use when `shader = "cycle"`. If unset, cycles all shaders.
    pub shader_playlist: Option<String>,

    /// Named palette playlist to use when `palette = "cycle"`. If unset, cycles all palettes.
    pub palette_playlist: Option<String>,

    /// Cycle selection order: `"random"` (default) or `"sequential"`.
    pub cycle_order: String,

    /// Whether all monitors cycle in sync. Default: `true`.
    ///
    /// When `true` (default), all outputs display the same shader and palette
    /// at all times — cycle events are broadcast simultaneously.
    ///
    /// When `false`, each output gets an independent cycle with a different RNG
    /// seed so monitors naturally desynchronize over time.
    pub synced: bool,
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self {
            fps: 30,
            shader: "cycle".to_string(),
            palette: "cycle".to_string(),
            shader_cycle_interval: 300,
            palette_cycle_interval: 60,
            palette_cycle: Vec::new(),
            palette_transition_duration: 0.0,
            shader_playlist: None,
            palette_playlist: None,
            cycle_order: "random".to_string(),
            synced: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Playlist config
// ---------------------------------------------------------------------------

/// A named ordered list of shader names for use in cycle mode.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ShaderPlaylist {
    /// Shader names in cycle order.
    pub shaders: Vec<String>,
}

/// A named ordered list of palette names for use in cycle mode.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PalettePlaylist {
    /// Palette names in cycle order.
    pub palettes: Vec<String>,
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
// Extended palette config — [[palette]] table-array
// ---------------------------------------------------------------------------

/// A gradient stop used in `type = "gradient"` palette entries.
#[derive(Debug, Clone, Deserialize)]
pub struct GradientStopConfig {
    /// Stop position in `[0.0, 1.0]`.
    pub position: f32,
    /// Color as a `#RRGGBB` hex string.
    pub color: String,
}

/// One entry from the `[[palette]]` TOML table-array.
///
/// Example TOML:
/// ```toml
/// [[palette]]
/// name = "fire"
/// type = "lut"
/// path = "~/.config/hyprsaver/palettes/fire.png"
///
/// [[palette]]
/// name = "sunset"
/// type = "gradient"
/// stops = [
///   { position = 0.0, color = "#0d0221" },
///   { position = 1.0, color = "#efefd0" },
/// ]
/// ```
#[derive(Debug, Clone, Deserialize)]
pub struct PaletteConfigEntry {
    /// Palette name (used to refer to it in `general.palette` or `general.palette_cycle`).
    pub name: String,

    /// Palette kind: `"lut"` or `"gradient"`.
    #[serde(rename = "type")]
    pub kind: String,

    /// Path to a PNG file (`type = "lut"`). Tilde expansion is performed by the caller.
    pub path: Option<String>,

    /// Gradient stops (`type = "gradient"`).
    pub stops: Option<Vec<GradientStopConfig>>,
}

// ---------------------------------------------------------------------------
// Per-monitor config — [[monitor]] table-array
// ---------------------------------------------------------------------------

/// Per-monitor shader and palette override.
///
/// Example TOML:
/// ```toml
/// [[monitor]]
/// name = "DP-1"
/// shader = "raymarcher"
/// palette = "frost"
///
/// [[monitor]]
/// name = "HDMI-A-1"
/// shader = "snowfall"
/// palette = "vapor"
/// ```
#[derive(Debug, Clone, Deserialize)]
pub struct MonitorConfig {
    /// Wayland output name (e.g. `"DP-1"`, `"HDMI-A-1"`). Must match the
    /// `wl_output.name` reported by the compositor (`hyprctl monitors`).
    pub name: String,

    /// Shader override for this monitor. `None` = use global `[general].shader`.
    pub shader: Option<String>,

    /// Palette override for this monitor. `None` = use global `[general].palette`.
    pub palette: Option<String>,
}

// ---------------------------------------------------------------------------
// Config path resolution
// ---------------------------------------------------------------------------

/// Outcome of resolving the default config file path.
///
/// Priority:
/// 1. `$XDG_CONFIG_HOME/hypr/hyprsaver.toml` (new path)
/// 2. `$XDG_CONFIG_HOME/hyprsaver/config.toml` (legacy — deprecated)
#[derive(Debug, PartialEq)]
pub enum ConfigPathOutcome {
    /// Found at `$XDG_CONFIG_HOME/hypr/hyprsaver.toml`.
    New(PathBuf),
    /// Found only at the legacy path `$XDG_CONFIG_HOME/hyprsaver/config.toml`.
    /// Caller should log a deprecation warning.
    Legacy(PathBuf),
    /// Both paths exist. Caller should use the new path and warn about the old one.
    Both { new: PathBuf, legacy: PathBuf },
    /// Neither path exists; caller should use built-in defaults.
    NotFound,
}

/// Resolve the default config path, checking the new Hyprland-ecosystem location
/// first and falling back to the legacy location.
pub fn resolve_config_path() -> ConfigPathOutcome {
    let cfg_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from(".config"));
    resolve_config_path_impl(
        cfg_dir.join("hypr").join("hyprsaver.toml"),
        cfg_dir.join("hyprsaver").join("config.toml"),
    )
}

/// Inner implementation that accepts explicit paths for testability.
fn resolve_config_path_impl(new_path: PathBuf, legacy_path: PathBuf) -> ConfigPathOutcome {
    match (new_path.exists(), legacy_path.exists()) {
        (true, true) => ConfigPathOutcome::Both {
            new: new_path,
            legacy: legacy_path,
        },
        (true, false) => ConfigPathOutcome::New(new_path),
        (false, true) => ConfigPathOutcome::Legacy(legacy_path),
        (false, false) => ConfigPathOutcome::NotFound,
    }
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/// Resolve and load the config file.
///
/// - If `path` is `Some`, read it directly (returns an error if the file is missing).
///   The migration fallback logic only applies to the default path resolution.
/// - Otherwise, check `$XDG_CONFIG_HOME/hypr/hyprsaver.toml` (new) then
///   `$XDG_CONFIG_HOME/hyprsaver/config.toml` (legacy, deprecated).
/// - If no file is found, returns `Config::default()` (zero-config mode).
///
/// # Deprecation warnings
/// If only the legacy path exists a warning is logged asking the user to migrate.
/// If both paths exist the new path is used and a warning is logged about the old one.
///
/// TODO: Remove legacy path fallback in v0.5.0
pub fn load_config(path: Option<&str>) -> anyhow::Result<Config> {
    use anyhow::Context;

    if let Some(explicit) = path {
        let content = std::fs::read_to_string(explicit)
            .with_context(|| format!("failed to read config file: {explicit}"))?;
        let config = toml::from_str::<Config>(&content)
            .with_context(|| format!("failed to parse config file: {explicit}"))?;
        return Ok(config);
    }

    // TODO: Remove legacy path fallback in v0.5.0
    match resolve_config_path() {
        ConfigPathOutcome::New(p) => {
            let content = std::fs::read_to_string(&p)
                .with_context(|| format!("failed to read config file: {}", p.display()))?;
            toml::from_str::<Config>(&content)
                .with_context(|| format!("failed to parse config file: {}", p.display()))
        }
        ConfigPathOutcome::Legacy(p) => {
            log::warn!(
                "Config found at {} — this path is deprecated. \
                 Please move your config to ~/.config/hypr/hyprsaver.toml",
                p.display()
            );
            let content = std::fs::read_to_string(&p)
                .with_context(|| format!("failed to read config file: {}", p.display()))?;
            toml::from_str::<Config>(&content)
                .with_context(|| format!("failed to parse config file: {}", p.display()))
        }
        ConfigPathOutcome::Both { new, legacy } => {
            log::warn!(
                "Config found at both {} and {} — using {}. \
                 Remove the old file to silence this warning.",
                new.display(),
                legacy.display(),
                new.display()
            );
            let content = std::fs::read_to_string(&new)
                .with_context(|| format!("failed to read config file: {}", new.display()))?;
            toml::from_str::<Config>(&content)
                .with_context(|| format!("failed to parse config file: {}", new.display()))
        }
        ConfigPathOutcome::NotFound => {
            log::info!("No config file found, using defaults");
            Ok(Config::default())
        }
    }
}

impl Config {
    /// Override `general` fields from CLI arguments.
    pub fn apply_cli_overrides(
        &mut self,
        shader: Option<&str>,
        palette: Option<&str>,
        shader_cycle_interval: Option<u64>,
        palette_cycle_interval: Option<u64>,
        cycle_order: Option<&str>,
        synced: Option<bool>,
    ) {
        if let Some(s) = shader {
            self.general.shader = s.to_string();
        }
        if let Some(p) = palette {
            self.general.palette = p.to_string();
        }
        if let Some(interval) = shader_cycle_interval {
            self.general.shader_cycle_interval = interval;
        }
        if let Some(interval) = palette_cycle_interval {
            self.general.palette_cycle_interval = interval;
        }
        if let Some(order) = cycle_order {
            self.general.cycle_order = order.to_string();
        }
        if let Some(s) = synced {
            self.general.synced = s;
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
        assert_eq!(cfg.general.shader, "cycle");
        assert_eq!(cfg.general.palette, "cycle");
        assert_eq!(cfg.general.shader_cycle_interval, 300);
        assert_eq!(cfg.general.palette_cycle_interval, 60);
        assert!(cfg.general.palette_cycle.is_empty());
        assert_eq!(cfg.general.palette_transition_duration, 0.0);
        assert!(cfg.general.shader_playlist.is_none());
        assert!(cfg.general.palette_playlist.is_none());
        assert_eq!(cfg.general.cycle_order, "random");
        assert_eq!(cfg.behavior.fade_in_ms, 800);
        assert_eq!(cfg.behavior.fade_out_ms, 400);
        assert!(cfg.behavior.dismiss_on.contains(&DismissEvent::Key));
        assert!(cfg.palettes.is_empty());
        assert!(cfg.palette_entries.is_empty());
        assert!(cfg.monitors.is_empty());
        assert!(cfg.shader_playlists.is_empty());
        assert!(cfg.palette_playlists.is_empty());
    }

    #[test]
    fn test_parse_minimal_toml() {
        let cfg: Config = toml::from_str("").expect("empty TOML must parse");
        assert_eq!(cfg.general.fps, 30);
        assert_eq!(cfg.general.shader, "cycle");
        assert_eq!(cfg.general.palette, "cycle");
        assert_eq!(cfg.general.cycle_order, "random");
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
palette_transition_duration = 1.5

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
        assert_eq!(cfg.general.palette_transition_duration, 1.5);
        assert_eq!(cfg.behavior.fade_in_ms, 200);
        assert_eq!(cfg.behavior.fade_out_ms, 100);
        assert_eq!(
            cfg.behavior.dismiss_on,
            vec![DismissEvent::Key, DismissEvent::Touch]
        );
    }

    #[test]
    fn test_parse_custom_cosine_palette() {
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
    fn test_parse_lut_palette_entry() {
        let toml_str = r#"
[[palette]]
name = "fire"
type = "lut"
path = "~/.config/hyprsaver/palettes/fire.png"
"#;
        let cfg: Config = toml::from_str(toml_str).expect("lut TOML must parse");
        assert_eq!(cfg.palette_entries.len(), 1);
        let entry = &cfg.palette_entries[0];
        assert_eq!(entry.name, "fire");
        assert_eq!(entry.kind, "lut");
        assert_eq!(
            entry.path.as_deref(),
            Some("~/.config/hyprsaver/palettes/fire.png")
        );
    }

    #[test]
    fn test_parse_gradient_palette_entry() {
        // Use r##"..."## so that "#RRGGBB" hex colors don't close the raw string.
        let toml_str = r##"
[[palette]]
name = "sunset"
type = "gradient"
stops = [
  { position = 0.0, color = "#0d0221" },
  { position = 0.3, color = "#ff6b35" },
  { position = 1.0, color = "#efefd0" },
]
"##;
        let cfg: Config = toml::from_str(toml_str).expect("gradient TOML must parse");
        assert_eq!(cfg.palette_entries.len(), 1);
        let entry = &cfg.palette_entries[0];
        assert_eq!(entry.name, "sunset");
        assert_eq!(entry.kind, "gradient");
        let stops = entry.stops.as_ref().expect("stops must be present");
        assert_eq!(stops.len(), 3);
        assert_eq!(stops[0].color, "#0d0221");
    }

    #[test]
    fn test_parse_monitor_config() {
        let toml_str = r#"
[[monitor]]
name = "DP-1"
shader = "raymarcher"
palette = "frost"

[[monitor]]
name = "HDMI-A-1"
shader = "snowfall"
"#;
        let cfg: Config = toml::from_str(toml_str).expect("monitor TOML must parse");
        assert_eq!(cfg.monitors.len(), 2);
        assert_eq!(cfg.monitors[0].name, "DP-1");
        assert_eq!(cfg.monitors[0].shader.as_deref(), Some("raymarcher"));
        assert_eq!(cfg.monitors[0].palette.as_deref(), Some("frost"));
        assert_eq!(cfg.monitors[1].name, "HDMI-A-1");
        assert_eq!(cfg.monitors[1].shader.as_deref(), Some("snowfall"));
        assert_eq!(cfg.monitors[1].palette, None); // falls back to global
    }

    #[test]
    fn test_default_has_no_monitors() {
        let cfg = Config::default();
        assert!(cfg.monitors.is_empty());
    }

    #[test]
    fn test_parse_partial_toml() {
        let toml_str = "[general]\nfps = 60\n";
        let cfg: Config = toml::from_str(toml_str).expect("partial TOML must parse");
        assert_eq!(cfg.general.fps, 60);
        assert_eq!(cfg.general.shader, "cycle");
        assert_eq!(cfg.general.palette, "cycle");
        assert_eq!(cfg.general.cycle_order, "random");
        assert_eq!(cfg.behavior.fade_in_ms, 800);
        assert_eq!(cfg.behavior.fade_out_ms, 400);
    }

    #[test]
    fn test_cli_overrides() {
        let mut cfg = Config::default();
        cfg.apply_cli_overrides(Some("julia"), Some("vapor"), None, None, None, None);
        assert_eq!(cfg.general.shader, "julia");
        assert_eq!(cfg.general.palette, "vapor");
    }

    #[test]
    fn test_cli_overrides_partial() {
        let mut cfg = Config::default();
        cfg.apply_cli_overrides(Some("julia"), None, None, None, None, None);
        assert_eq!(cfg.general.shader, "julia");
        assert_eq!(cfg.general.palette, "cycle"); // unchanged default
    }

    #[test]
    fn test_cli_overrides_cycle_intervals() {
        let mut cfg = Config::default();
        cfg.apply_cli_overrides(None, None, Some(120), Some(45), None, None);
        assert_eq!(cfg.general.shader_cycle_interval, 120);
        assert_eq!(cfg.general.palette_cycle_interval, 45);
    }

    #[test]
    fn test_cli_overrides_cycle_intervals_partial() {
        let mut cfg = Config::default();
        cfg.apply_cli_overrides(None, None, Some(90), None, None, None);
        assert_eq!(cfg.general.shader_cycle_interval, 90);
        assert_eq!(cfg.general.palette_cycle_interval, 60); // unchanged default
    }

    #[test]
    fn test_cli_overrides_cycle_order() {
        let mut cfg = Config::default();
        cfg.apply_cli_overrides(None, None, None, None, Some("sequential"), None);
        assert_eq!(cfg.general.cycle_order, "sequential");
    }

    #[test]
    fn test_parse_cycle_order() {
        let toml_str = "[general]\ncycle_order = \"sequential\"\n";
        let cfg: Config = toml::from_str(toml_str).expect("must parse");
        assert_eq!(cfg.general.cycle_order, "sequential");
    }

    #[test]
    fn test_default_synced_is_true() {
        let cfg = Config::default();
        assert!(cfg.general.synced, "synced must default to true");
    }

    #[test]
    fn test_parse_synced_false() {
        let toml_str = "[general]\nsynced = false\n";
        let cfg: Config = toml::from_str(toml_str).expect("must parse");
        assert!(!cfg.general.synced);
    }

    #[test]
    fn test_cli_override_synced() {
        let mut cfg = Config::default();
        assert!(cfg.general.synced);
        cfg.apply_cli_overrides(None, None, None, None, None, Some(false));
        assert!(!cfg.general.synced);
        cfg.apply_cli_overrides(None, None, None, None, None, Some(true));
        assert!(cfg.general.synced);
    }

    #[test]
    fn test_parse_playlists() {
        let toml_str = r#"
[general]
shader_playlist = "my_favorites"
palette_playlist = "warm_tones"

[shader_playlists.my_favorites]
shaders = ["mandelbrot", "julia", "plasma"]

[shader_playlists.chill]
shaders = ["plasma", "tunnel"]

[palette_playlists.warm_tones]
palettes = ["ember", "autumn", "groovy"]

[palette_playlists.cool_vibes]
palettes = ["frost", "ocean", "vapor"]
"#;
        let cfg: Config = toml::from_str(toml_str).expect("playlist TOML must parse");
        assert_eq!(cfg.general.shader_playlist.as_deref(), Some("my_favorites"));
        assert_eq!(cfg.general.palette_playlist.as_deref(), Some("warm_tones"));

        assert_eq!(cfg.shader_playlists.len(), 2);
        let fav = cfg
            .shader_playlists
            .get("my_favorites")
            .expect("my_favorites must exist");
        assert_eq!(fav.shaders, vec!["mandelbrot", "julia", "plasma"]);
        let chill = cfg.shader_playlists.get("chill").expect("chill must exist");
        assert_eq!(chill.shaders, vec!["plasma", "tunnel"]);

        assert_eq!(cfg.palette_playlists.len(), 2);
        let warm = cfg
            .palette_playlists
            .get("warm_tones")
            .expect("warm_tones must exist");
        assert_eq!(warm.palettes, vec!["ember", "autumn", "groovy"]);
    }

    #[test]
    fn test_parse_no_playlists_backward_compat() {
        let cfg: Config = toml::from_str("").expect("empty TOML must parse");
        assert!(cfg.shader_playlists.is_empty());
        assert!(cfg.palette_playlists.is_empty());
        assert!(cfg.general.shader_playlist.is_none());
        assert!(cfg.general.palette_playlist.is_none());
    }

    #[test]
    fn test_parse_palette_cycle_interval() {
        let toml_str = "[general]\npalette_cycle_interval = 30\n";
        let cfg: Config = toml::from_str(toml_str).expect("must parse");
        assert_eq!(cfg.general.palette_cycle_interval, 30);
    }

    #[test]
    fn test_missing_file_returns_default() {
        assert!(
            load_config(Some("/nonexistent_hyprsaver_xyz/config.toml")).is_err(),
            "explicit nonexistent path should error"
        );

        let orig_xdg = std::env::var("XDG_CONFIG_HOME").ok();

        std::env::set_var("XDG_CONFIG_HOME", "/nonexistent_xdg_hyprsaver_test");

        let result = load_config(None);

        match orig_xdg {
            Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
            None => std::env::remove_var("XDG_CONFIG_HOME"),
        }

        let cfg = result.expect("load_config(None) with no file must return Ok");
        assert_eq!(cfg.general.fps, 30);
        assert_eq!(cfg.general.shader, "cycle");
    }

    // ---------------------------------------------------------------------------
    // resolve_config_path tests
    // ---------------------------------------------------------------------------

    #[test]
    fn test_resolve_config_path_new_only() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let new_path = tmp.path().join("hyprsaver.toml");
        let legacy_path = tmp.path().join("legacy_config.toml"); // does not exist
        std::fs::write(&new_path, "").expect("write new path");

        let outcome = resolve_config_path_impl(new_path.clone(), legacy_path);
        assert_eq!(outcome, ConfigPathOutcome::New(new_path));
    }

    #[test]
    fn test_resolve_config_path_legacy_only() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let new_path = tmp.path().join("hyprsaver.toml"); // does not exist
        let legacy_path = tmp.path().join("config.toml");
        std::fs::write(&legacy_path, "").expect("write legacy path");

        let outcome = resolve_config_path_impl(new_path, legacy_path.clone());
        assert_eq!(outcome, ConfigPathOutcome::Legacy(legacy_path));
    }

    #[test]
    fn test_resolve_config_path_both_exist() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let new_path = tmp.path().join("hyprsaver.toml");
        let legacy_path = tmp.path().join("config.toml");
        std::fs::write(&new_path, "").expect("write new path");
        std::fs::write(&legacy_path, "").expect("write legacy path");

        let outcome = resolve_config_path_impl(new_path.clone(), legacy_path.clone());
        assert_eq!(
            outcome,
            ConfigPathOutcome::Both {
                new: new_path,
                legacy: legacy_path,
            }
        );
    }

    #[test]
    fn test_resolve_config_path_neither_exists() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let new_path = tmp.path().join("hyprsaver.toml");
        let legacy_path = tmp.path().join("config.toml");

        let outcome = resolve_config_path_impl(new_path, legacy_path);
        assert_eq!(outcome, ConfigPathOutcome::NotFound);
    }
}
