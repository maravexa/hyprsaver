//! `main.rs` — Entry point for hyprsaver.
// Public API items in sub-modules are intentionally unused in v0.1.0 and will
// be called by future callers (palette previewer, interactive mode, etc.).
#![allow(dead_code)]

use anyhow::Context;
use clap::Parser;
use log::{debug, info};
use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

mod config;
mod cycle;
mod palette;
mod preview;
mod renderer;
mod shaders;
mod wayland;

use crate::config::{CliOverrides, Config};
use crate::palette::{GradientStop, PaletteEntry, PaletteManager};
use crate::shaders::ShaderManager;

/// hyprsaver -- Wayland-native fractal screensaver for Hyprland
///
/// Renders GLSL fragment shaders as fullscreen overlays on every connected
/// monitor using the wlr-layer-shell Wayland protocol. Designed to work with
/// hypridle (timeout orchestration) and hyprlock (lock screen).
///
/// Configuration: ~/.config/hypr/hyprsaver.toml
/// User shaders:  ~/.config/hypr/hyprsaver/shaders/*.frag
#[derive(Parser, Debug)]
#[command(
    name = "hyprsaver",
    version,
    author,
    about = "Wayland-native fractal screensaver for Hyprland",
    long_about = "Renders GLSL fragment shaders as fullscreen overlays on every connected \
                  monitor using the wlr-layer-shell Wayland protocol.\n\n\
                  Designed to work with hypridle (timeout orchestration) and hyprlock \
                  (lock screen). Add to your hypridle.conf:\n\n  \
                  listener {\n      \
                  timeout = 600\n      \
                  on-timeout = hyprsaver\n      \
                  on-resume = hyprsaver --quit\n  \
                  }\n\n\
                  Preview mode — shader/palette authoring without triggering the screensaver:\n\n  \
                  hyprsaver --preview                        (config shader/palette)\n  \
                  hyprsaver --preview --shader kaleidoscope  (specific shader)\n  \
                  hyprsaver --preview --shader ~/my.frag     (custom shader from path)\n\n\
                  Press Q/Escape to quit the preview window, R to reload the shader.\n\n\
                  Configuration: ~/.config/hypr/hyprsaver.toml\n\
                  User shaders:  ~/.config/hypr/hyprsaver/shaders/*.frag"
)]
struct Cli {
    /// Path to config file (overrides XDG default)
    #[arg(short, long, value_name = "PATH")]
    config: Option<PathBuf>,

    /// Shader to use (name or path to .frag file; "random" or "cycle" in daemon mode)
    #[arg(short, long, value_name = "NAME|PATH")]
    shader: Option<String>,

    /// Palette to use (name or "random" or "cycle")
    #[arg(short, long, value_name = "NAME")]
    palette: Option<String>,

    /// List all available shaders and exit
    #[arg(long)]
    list_shaders: bool,

    /// List all available palettes and exit
    #[arg(long)]
    list_palettes: bool,

    /// Send SIGTERM to the running hyprsaver instance and exit
    #[arg(long)]
    quit: bool,

    /// Open a resizable preview window for shader authoring (no screensaver overlay).
    /// Combine with --shader to select what to preview.
    /// Keyboard: Q/Escape = quit, R = reload shader from disk.
    #[arg(long)]
    preview: bool,

    /// Enable verbose debug logging (equivalent to RUST_LOG=hyprsaver=debug)
    #[arg(short, long)]
    verbose: bool,

    /// List all defined shader playlists and exit
    #[arg(long)]
    list_shader_playlists: bool,

    /// List all defined palette playlists and exit
    #[arg(long)]
    list_palette_playlists: bool,

    /// Override shader cycle interval in seconds (only used when shader = "cycle")
    #[arg(long, value_name = "SECONDS")]
    shader_cycle_interval: Option<u64>,

    /// Override palette cycle interval in seconds (only used when palette = "cycle")
    #[arg(long, value_name = "SECONDS")]
    palette_cycle_interval: Option<u64>,

    /// Shorter alias for --shader-cycle-interval
    #[arg(long, value_name = "SECONDS")]
    shader_interval: Option<u64>,

    /// Shorter alias for --palette-cycle-interval
    #[arg(long, value_name = "SECONDS")]
    palette_interval: Option<u64>,

    /// Cycle selection order: "random" (default) or "sequential"
    #[arg(long, value_name = "random|sequential")]
    cycle_order: Option<String>,

    /// All monitors cycle shaders and palettes in sync (default). Overrides config `synced = false`.
    #[arg(long, overrides_with = "no_synced")]
    synced: bool,

    /// Each monitor cycles independently. Overrides config `synced = true`.
    #[arg(long, overrides_with = "synced")]
    no_synced: bool,

    /// Set both shader and palette playlist by name.
    /// Overrides config `shader_playlist` and `palette_playlist` simultaneously.
    /// Use with `--shader cycle --palette cycle` for full playlist control.
    #[arg(long, value_name = "NAME")]
    playlist: Option<String>,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("hyprsaver: {:#}", e);
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if cli.verbose {
        std::env::set_var("RUST_LOG", "hyprsaver=debug");
    }
    env_logger::init();

    // Handle --quit early (before config loading, signal handlers, etc.)
    if cli.quit {
        return quit_running_instance();
    }

    info!("hyprsaver starting");
    debug!("CLI args: {:?}", cli);

    // Install signal handlers so SIGTERM (from hypridle) and SIGINT (Ctrl-C)
    // exit cleanly.
    let running = Arc::new(AtomicBool::new(true));
    install_signal_handlers(Arc::clone(&running)).context("failed to install signal handlers")?;

    // Load configuration, applying CLI overrides.
    let cfg = load_config(&cli).context("failed to load config")?;
    debug!("Loaded config: {:?}", cfg);

    // Resolve user shader directory with new/legacy fallback.
    // TODO: Remove legacy path fallback in v0.5.0
    let shader_dir_outcome = shaders::resolve_shader_dir();
    let shader_dir = match &shader_dir_outcome {
        shaders::ShaderDirOutcome::New(p) => p.clone(),
        shaders::ShaderDirOutcome::Legacy(p) => {
            log::warn!(
                "User shaders found at {} — this path is deprecated. \
                 Please move your shaders to ~/.config/hypr/hyprsaver/shaders/",
                p.display()
            );
            p.clone()
        }
        shaders::ShaderDirOutcome::Both { new, legacy } => {
            log::warn!(
                "User shaders found at both {} and {} — loading from both. \
                 Please move your shaders from {} to {} to silence this warning.",
                new.display(),
                legacy.display(),
                legacy.display(),
                new.display()
            );
            new.clone()
        }
        shaders::ShaderDirOutcome::NotFound(p) => p.clone(),
    };

    let mut shader_manager =
        ShaderManager::new(shader_dir.clone()).context("failed to initialise ShaderManager")?;

    // If both dirs exist, also load from the legacy dir (without overwriting new-path shaders).
    if let shaders::ShaderDirOutcome::Both { legacy, .. } = &shader_dir_outcome {
        shader_manager.load_from_dir_no_overwrite(legacy);
    }

    // Start hot-reload watcher on the primary dir (silently skipped if dir doesn't exist).
    if let Err(e) = shader_manager.watch_for_changes() {
        log::warn!("Could not start shader watcher: {e:#}");
    }

    // Build extra (LUT / gradient) palette entries from config.
    let extra_entries = build_palette_entries(&cfg);
    let mut palette_manager = PaletteManager::new(
        cfg.palettes.clone(),
        extra_entries,
        cfg.general.palette_transition_duration,
        &cfg.general.palette,
    );

    // Early-exit commands.
    if cli.list_shaders {
        print_shaders(&shader_manager, &shader_dir);
        return Ok(());
    }
    if cli.list_palettes {
        print_palettes(&palette_manager, &cfg);
        return Ok(());
    }
    if cli.list_shader_playlists {
        print_shader_playlists(&cfg);
        return Ok(());
    }
    if cli.list_palette_playlists {
        print_palette_playlists(&cfg);
        return Ok(());
    }

    // Validate and wire playlists into managers (Phases 2+3).
    validate_and_apply_playlists(&cfg, &mut shader_manager, &mut palette_manager);

    if cli.preview {
        // Preview mode: windowed xdg-toplevel window, no PID file, no daemon check.
        // Resolve shader path or name override from --shader flag.
        let shader_override = resolve_preview_shader(&cli, &mut shader_manager, &cfg);

        println!("Preview mode: press Q or Escape to quit, R to reload shader");
        preview::run(
            cfg,
            shader_manager,
            palette_manager,
            running,
            shader_override.as_deref(),
        )
        .context("preview exited with error")?;
    } else {
        // Screensaver daemon mode.
        check_already_running()?;
        let _pid_guard = PidFile::create().context("failed to write PID file")?;
        wayland::run(cfg, shader_manager, palette_manager, running)
            .context("screensaver exited with error")?;
    }

    info!("hyprsaver exiting cleanly");
    Ok(())
}

// ---------------------------------------------------------------------------
// Preview-mode shader resolution
// ---------------------------------------------------------------------------

/// Resolve the shader for preview mode.
///
/// If `--shader` looks like a file path (contains `/` or ends with `.frag`),
/// load it into the ShaderManager and return its registered name.
/// Otherwise, return the raw name string as-is (ShaderManager lookup happens
/// inside `preview::run`).
fn resolve_preview_shader(
    cli: &Cli,
    shader_manager: &mut ShaderManager,
    cfg: &Config,
) -> Option<String> {
    // The shader value comes from --shader (if provided), else config general.shader.
    // We only need to do special path handling in preview mode.
    let raw = match &cli.shader {
        Some(s) => s.clone(),
        None => cfg.general.shader.clone(),
    };

    // Detect a file-system path: contains a directory separator or ends with .frag.
    let looks_like_path = raw.contains('/') || raw.ends_with(".frag");

    if looks_like_path {
        let path = expand_tilde(&raw);
        match shader_manager.load_from_path(&path) {
            Ok(name) => {
                log::info!("preview: loaded shader '{}' from {}", name, path.display());
                Some(name)
            }
            Err(e) => {
                log::warn!("preview: could not load shader from '{}': {e:#}", raw);
                None
            }
        }
    } else if raw.is_empty() || raw == "cycle" || raw == "random" {
        // Let preview::run() handle these special tokens itself.
        None
    } else {
        Some(raw)
    }
}

// ---------------------------------------------------------------------------
// PID file guard
// ---------------------------------------------------------------------------

/// RAII guard that writes the current process PID to a file on creation and
/// removes it on drop.
struct PidFile {
    path: PathBuf,
}

impl PidFile {
    fn create() -> anyhow::Result<Self> {
        let dir = runtime_dir();
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("failed to create directory: {}", dir.display()))?;
        let path = dir.join("hyprsaver.pid");
        std::fs::write(&path, std::process::id().to_string())
            .with_context(|| format!("failed to write PID file: {}", path.display()))?;
        log::debug!("Wrote PID file: {}", path.display());
        Ok(Self { path })
    }
}

impl Drop for PidFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        log::debug!("Removed PID file: {}", self.path.display());
    }
}

/// Return the runtime directory for PID files.
fn runtime_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() }))
}

/// Return the path to the PID file.
fn pid_file_path() -> PathBuf {
    runtime_dir().join("hyprsaver.pid")
}

// ---------------------------------------------------------------------------
// --quit implementation
// ---------------------------------------------------------------------------

/// Find and signal a running hyprsaver instance via PID file.
fn quit_running_instance() -> anyhow::Result<()> {
    let pid_path = pid_file_path();

    if !pid_path.exists() {
        anyhow::bail!(
            "No running hyprsaver instance found (no PID file at {})",
            pid_path.display()
        );
    }

    let pid_str = std::fs::read_to_string(&pid_path).context("failed to read PID file")?;
    let pid: i32 = pid_str.trim().parse().context("invalid PID file")?;

    // Check if the process is alive first.
    let alive = unsafe { libc::kill(pid, 0) } == 0;
    if !alive {
        // Stale PID file — clean it up.
        let _ = std::fs::remove_file(&pid_path);
        anyhow::bail!(
            "No running hyprsaver instance (stale PID file for PID {} removed)",
            pid
        );
    }

    let ret = unsafe { libc::kill(pid, libc::SIGTERM) };
    if ret == 0 {
        info!("Sent SIGTERM to hyprsaver (PID {})", pid);
        // Wait briefly for it to exit and clean up its PID file.
        std::thread::sleep(std::time::Duration::from_millis(500));
        Ok(())
    } else {
        anyhow::bail!("Failed to send SIGTERM to PID {}. Try: kill {}", pid, pid);
    }
}

/// Check if another hyprsaver instance is already running. If so, bail with a
/// helpful error message.
fn check_already_running() -> anyhow::Result<()> {
    let pid_path = pid_file_path();
    if !pid_path.exists() {
        return Ok(());
    }

    let pid_str = match std::fs::read_to_string(&pid_path) {
        Ok(s) => s,
        Err(_) => return Ok(()), // Can't read — ignore
    };
    let pid: i32 = match pid_str.trim().parse() {
        Ok(p) => p,
        Err(_) => {
            // Invalid PID file — remove it
            let _ = std::fs::remove_file(&pid_path);
            return Ok(());
        }
    };

    // Check if the process is still alive.
    let alive = unsafe { libc::kill(pid, 0) } == 0;
    if alive && pid != std::process::id() as i32 {
        anyhow::bail!(
            "hyprsaver is already running (PID {}). Use --quit to stop it.",
            pid
        );
    }

    // Stale PID file — clean it up.
    let _ = std::fs::remove_file(&pid_path);
    Ok(())
}

// ---------------------------------------------------------------------------
// Palette entry loading
// ---------------------------------------------------------------------------

/// Resolve a `[[palette]]` config block into a `(name, PaletteEntry)` pair.
///
/// LUT entries open the PNG from disk; gradient entries interpolate stops.
/// Failures are logged as warnings and the entry is skipped.
fn build_palette_entries(cfg: &Config) -> Vec<(String, PaletteEntry)> {
    let mut out = Vec::new();
    for entry in &cfg.palette_entries {
        match entry.kind.as_str() {
            "lut" => {
                let Some(ref raw_path) = entry.path else {
                    log::warn!("LUT palette '{}' has no path", entry.name);
                    continue;
                };
                let expanded = expand_tilde(raw_path);
                match palette::load_lut_from_png(&expanded) {
                    Ok(lut) => {
                        log::info!(
                            "Loaded LUT palette '{}' from {}",
                            entry.name,
                            expanded.display()
                        );
                        out.push((entry.name.clone(), PaletteEntry::Lut(lut)));
                    }
                    Err(e) => log::warn!("Failed to load LUT palette '{}': {e:#}", entry.name),
                }
            }
            "gradient" => {
                let Some(ref stops_cfg) = entry.stops else {
                    log::warn!("Gradient palette '{}' has no stops", entry.name);
                    continue;
                };
                let stops: Vec<GradientStop> = stops_cfg
                    .iter()
                    .filter_map(|s| match palette::parse_hex_color(&s.color) {
                        Ok(color) => Some(GradientStop {
                            position: s.position,
                            color,
                        }),
                        Err(e) => {
                            log::warn!("Gradient '{}': bad color '{}': {e}", entry.name, s.color);
                            None
                        }
                    })
                    .collect();
                match palette::gradient_to_lut(&stops) {
                    Ok(lut) => {
                        log::info!("Built gradient palette '{}'", entry.name);
                        out.push((entry.name.clone(), PaletteEntry::Lut(lut)));
                    }
                    Err(e) => {
                        log::warn!("Failed to build gradient palette '{}': {e:#}", entry.name)
                    }
                }
            }
            other => log::warn!(
                "Unknown palette type '{}' for palette '{}'",
                other,
                entry.name
            ),
        }
    }
    out
}

/// Expand a leading `~` to the user's home directory.
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

// ---------------------------------------------------------------------------
// --list-shaders / --list-palettes
// ---------------------------------------------------------------------------

/// Short descriptions for built-in shaders.
fn shader_descriptions() -> std::collections::HashMap<&'static str, &'static str> {
    [
        (
            "planet",
            "Raymarched planet sphere wrapped in aurora borealis bands — sine-wave latitude bands perturbed by noise",
        ),
        (
            "bezier",
            "Five animated cubic Bézier curves with slow-drifting control points and additive palette glow",
        ),
        (
            "caustics",
            "Underwater light caustic patterns dancing across the screen",
        ),
        (
            "fire",
            "Procedural flames rising with fractal noise turbulence",
        ),
        ("marble", "Curl-noise flow field with particle tracing"),
        (
            "geometry",
            "Rotating wireframe polyhedra morphing between geometric forms",
        ),
        (
            "hypercube",
            "4D tesseract rotating in two planes, projected to 2D with neon glow",
        ),
        ("julia", "Julia set with animated constant"),
        ("kaleidoscope", "6-fold kaleidoscope with domain-warped FBM"),
        ("lissajous", "Three overlapping Lissajous curves with glow"),
        ("mandelbrot", "Mandelbrot set zoom"),
        (
            "matrix",
            "Digital rain — falling characters in the style of The Matrix",
        ),
        (
            "network",
            "Neural network visualization with parallax nodes and pulsing connections",
        ),
        ("plasma", "Classic plasma effect"),
        ("donut", "Raymarched torus with Phong lighting"),
        ("snowfall", "Five-layer parallax snowfall"),
        (
            "starfield",
            "Hyperspace zoom tunnel with motion-blur tracers",
        ),
        (
            "tesla",
            "Tesla coil arcs — fractal-lightning between three electrodes with branching and a wandering endpoint",
        ),
        ("tunnel", "Infinite tunnel flythrough"),
        ("voronoi", "Animated Voronoi cells"),
        (
            "wormhole",
            "Curving wormhole tunnel with ring-textured walls, depth fog, and interior point lights",
        ),
    ]
    .into_iter()
    .collect()
}

/// Short descriptions for built-in palettes.
fn palette_descriptions() -> std::collections::HashMap<&'static str, &'static str> {
    [
        ("aurora", "Deep indigo → teal → mint → violet"),
        ("autumn", "Golds, rusts, deep reds"),
        ("rainbow", "Classic rainbow (default)"),
        ("ember", "Deep reds to bright orange"),
        (
            "forest",
            "Sage greens, deep greens, and earthy coffee browns",
        ),
        ("frost", "Icy blues and silvers"),
        ("groovy", "Groovy 70s oranges, pinks, and warm tones"),
        ("midnight", "Deep navy to steel blue gradient"),
        ("monochrome", "Grayscale"),
        ("ocean", "Deep navy to cyan to white"),
        ("sunset", "Deep violet → burnt orange → warm cream"),
        ("vaporwave", "Vaporwave pinks, teals, purples"),
    ]
    .into_iter()
    .collect()
}

fn print_shaders(manager: &ShaderManager, shader_dir: &std::path::Path) {
    let descs = shader_descriptions();
    let all = manager.list();

    let builtins: Vec<&str> = all
        .iter()
        .copied()
        .filter(|n| manager.get(n).is_some_and(|s| s.builtin))
        .collect();
    let user: Vec<&str> = all
        .iter()
        .copied()
        .filter(|n| manager.get(n).is_some_and(|s| !s.builtin))
        .collect();

    println!("Built-in shaders:");
    for name in &builtins {
        let desc = descs.get(name).unwrap_or(&"");
        if desc.is_empty() {
            println!("  {name}");
        } else {
            println!("  {name:<14}{desc}");
        }
    }

    println!();
    println!("User shaders ({}):", shader_dir.display());
    if user.is_empty() {
        println!("  (none found)");
    } else {
        for name in &user {
            println!("  {name}");
        }
    }
}

fn print_palettes(manager: &PaletteManager, cfg: &Config) {
    let descs = palette_descriptions();
    // Cosine built-ins (hardcoded in palette::builtin_palettes)
    let cosine_builtin_names = palette::builtin_palettes();
    // Gradient built-ins ("sunset", "aurora", "midnight")
    let gradient_builtin_names: std::collections::HashSet<&str> =
        ["sunset", "aurora", "midnight"].iter().copied().collect();
    let all = manager.list();

    println!("Built-in palettes:");
    for name in &all {
        let is_builtin =
            cosine_builtin_names.contains_key(*name) || gradient_builtin_names.contains(*name);
        if !is_builtin {
            continue;
        }
        let desc = descs.get(name).unwrap_or(&"");
        if desc.is_empty() {
            println!("  {name}");
        } else {
            println!("  {name:<14}{desc}");
        }
    }

    println!();
    println!("Custom palettes (from config):");
    let custom_cosine: Vec<&String> = cfg.palettes.keys().collect();
    let custom_entries: Vec<&str> = cfg
        .palette_entries
        .iter()
        .map(|e| e.name.as_str())
        .collect();
    if custom_cosine.is_empty() && custom_entries.is_empty() {
        println!("  (none defined)");
    } else {
        for name in &custom_cosine {
            println!("  {name}  [cosine]");
        }
        for name in &custom_entries {
            println!("  {name}");
        }
    }
}

// ---------------------------------------------------------------------------
// Signal handling
// ---------------------------------------------------------------------------

/// Register OS signal handlers. Sets `running` to false on SIGTERM or SIGINT.
fn install_signal_handlers(running: Arc<AtomicBool>) -> anyhow::Result<()> {
    let mut signals =
        Signals::new([SIGTERM, SIGINT]).context("could not create signal iterator")?;

    std::thread::spawn(move || {
        for sig in &mut signals {
            info!("Received signal {}, shutting down", sig);
            running.store(false, Ordering::SeqCst);
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Playlist validation and wiring (Phases 2 + 3)
// ---------------------------------------------------------------------------

/// Validate playlist config and wire resolved playlists into the managers.
///
/// Resolution order for shader playlists:
/// 1. `[playlists.<name>].shaders` (v0.4.0 unified format)
/// 2. `[shader_playlists.<name>].shaders` (v0.3.0 legacy format)
/// 3. If the playlist name is `"default"` and not found, treat as `["all"]`
///
/// The special value `"all"` in a playlist expands to all available shaders/palettes.
fn validate_and_apply_playlists(
    cfg: &Config,
    shader_manager: &mut ShaderManager,
    palette_manager: &mut PaletteManager,
) {
    let playlist_name = &cfg.general.shader_playlist;

    // --- Shader playlist ---
    if cfg.general.shader == "cycle" {
        let shader_names = resolve_shader_playlist(cfg, playlist_name);
        if let Some(names) = shader_names {
            if names.iter().any(|n| n == "all") {
                log::info!("Shader cycle: all shaders");
                // Don't call set_playlist — default behavior is cycle all.
            } else {
                let resolved: Vec<String> = names
                    .iter()
                    .filter_map(|name| {
                        if shader_manager.get(name).is_some() {
                            Some(name.clone())
                        } else {
                            log::warn!(
                                "Shader '{name}' in playlist '{playlist_name}' not found; skipping"
                            );
                            None
                        }
                    })
                    .collect();
                if resolved.is_empty() {
                    log::warn!(
                        "Shader playlist '{playlist_name}' is empty after filtering; cycling all shaders"
                    );
                } else {
                    log::info!(
                        "Shader cycle playlist: {playlist_name} ({} shaders)",
                        resolved.len()
                    );
                    shader_manager.set_playlist(resolved);
                }
            }
        }
    }

    let palette_playlist_name = &cfg.general.palette_playlist;

    // --- Palette playlist ---
    if cfg.general.palette == "cycle" {
        let palette_names = resolve_palette_playlist(cfg, palette_playlist_name);
        if let Some(names) = palette_names {
            if names.iter().any(|n| n == "all") {
                log::info!("Palette cycle: all palettes");
            } else {
                let resolved: Vec<String> = names
                    .iter()
                    .filter_map(|name| {
                        if palette_manager.get(name).is_some() {
                            Some(name.clone())
                        } else {
                            log::warn!(
                                "Palette '{name}' in playlist '{palette_playlist_name}' not found; skipping"
                            );
                            None
                        }
                    })
                    .collect();
                if resolved.is_empty() {
                    log::warn!(
                        "Palette playlist '{palette_playlist_name}' is empty after filtering; cycling all palettes"
                    );
                } else {
                    log::info!(
                        "Palette cycle playlist: {palette_playlist_name} ({} palettes)",
                        resolved.len()
                    );
                    palette_manager.set_playlist(resolved);
                }
            }
        }
    }
}

/// Resolve the shader list for a named playlist.
///
/// Checks unified `[playlists]` first, then legacy `[shader_playlists]`.
/// Returns `None` only if `"default"` is not found anywhere (implicit "all").
fn resolve_shader_playlist(cfg: &Config, name: &str) -> Option<Vec<String>> {
    // 1. Check unified [playlists.<name>]
    if let Some(pl) = cfg.playlists.get(name) {
        return Some(pl.shaders.clone());
    }
    // 2. Check legacy [shader_playlists.<name>]
    if let Some(pl) = cfg.shader_playlists.get(name) {
        return Some(pl.shaders.clone());
    }
    // 3. "default" playlist not found → implicit ["all"]
    if name == "default" {
        return Some(vec!["all".to_string()]);
    }
    // 4. Named playlist not found at all
    log::warn!("Shader playlist '{name}' not found; cycling all shaders");
    None
}

/// Resolve the palette list for a named playlist.
///
/// Checks unified `[playlists]` first, then legacy `[palette_playlists]`.
/// Returns `None` only if `"default"` is not found anywhere (implicit "all").
fn resolve_palette_playlist(cfg: &Config, name: &str) -> Option<Vec<String>> {
    // 1. Check unified [playlists.<name>]
    if let Some(pl) = cfg.playlists.get(name) {
        return Some(pl.palettes.clone());
    }
    // 2. Check legacy [palette_playlists.<name>]
    if let Some(pl) = cfg.palette_playlists.get(name) {
        return Some(pl.palettes.clone());
    }
    // 3. "default" playlist not found → implicit ["all"]
    if name == "default" {
        return Some(vec!["all".to_string()]);
    }
    // 4. Named playlist not found at all
    log::warn!("Palette playlist '{name}' not found; cycling all palettes");
    None
}

// ---------------------------------------------------------------------------
// --list-shader-playlists / --list-palette-playlists
// ---------------------------------------------------------------------------

fn print_shader_playlists(cfg: &Config) {
    let has_unified = !cfg.playlists.is_empty();
    let has_legacy = !cfg.shader_playlists.is_empty();
    if !has_unified && !has_legacy {
        println!("No shader playlists defined.");
        println!("  (\"default\" playlist implicitly cycles all shaders)");
        return;
    }
    println!("Shader playlists:");
    // Print unified playlists first
    let mut names: Vec<&String> = cfg.playlists.keys().collect();
    names.sort_unstable();
    for name in &names {
        let shaders = cfg.playlists[*name].shaders.join(", ");
        println!("  {name}: {shaders}");
    }
    // Print legacy playlists not already covered by unified
    let mut legacy_names: Vec<&String> = cfg
        .shader_playlists
        .keys()
        .filter(|n| !cfg.playlists.contains_key(*n))
        .collect();
    legacy_names.sort_unstable();
    for name in legacy_names {
        let shaders = cfg.shader_playlists[name].shaders.join(", ");
        println!("  {name}: {shaders}  (legacy)");
    }
}

fn print_palette_playlists(cfg: &Config) {
    let has_unified = !cfg.playlists.is_empty();
    let has_legacy = !cfg.palette_playlists.is_empty();
    if !has_unified && !has_legacy {
        println!("No palette playlists defined.");
        println!("  (\"default\" playlist implicitly cycles all palettes)");
        return;
    }
    println!("Palette playlists:");
    // Print unified playlists first
    let mut names: Vec<&String> = cfg.playlists.keys().collect();
    names.sort_unstable();
    for name in &names {
        let palettes = cfg.playlists[*name].palettes.join(", ");
        println!("  {name}: {palettes}");
    }
    // Print legacy playlists not already covered by unified
    let mut legacy_names: Vec<&String> = cfg
        .palette_playlists
        .keys()
        .filter(|n| !cfg.playlists.contains_key(*n))
        .collect();
    legacy_names.sort_unstable();
    for name in legacy_names {
        let palettes = cfg.palette_playlists[name].palettes.join(", ");
        println!("  {name}: {palettes}  (legacy)");
    }
}

/// Load config from CLI flag -> XDG path -> built-in defaults, then apply
/// CLI overrides.
fn load_config(cli: &Cli) -> anyhow::Result<Config> {
    let path = cli.config.as_deref().and_then(|p| p.to_str());
    let mut cfg = config::load_config(path)?;

    // --shader-interval / --palette-interval are shorter aliases; the
    // explicit --shader-cycle-interval / --palette-cycle-interval take
    // precedence when both are provided.
    let shader_interval = cli.shader_cycle_interval.or(cli.shader_interval);
    let palette_interval = cli.palette_cycle_interval.or(cli.palette_interval);

    let synced = if cli.synced {
        Some(true)
    } else if cli.no_synced {
        Some(false)
    } else {
        None
    };

    cfg.apply_cli_overrides(CliOverrides {
        shader: cli.shader.as_deref(),
        palette: cli.palette.as_deref(),
        shader_cycle_interval: shader_interval,
        palette_cycle_interval: palette_interval,
        cycle_order: cli.cycle_order.as_deref(),
        synced,
        playlist: cli.playlist.as_deref(),
    });
    Ok(cfg)
}
