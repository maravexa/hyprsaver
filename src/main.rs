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
mod palette;
mod renderer;
mod shaders;
mod wayland;

use crate::config::Config;
use crate::palette::PaletteManager;
use crate::shaders::ShaderManager;

/// hyprsaver -- Wayland-native fractal screensaver for Hyprland
///
/// Renders GLSL fragment shaders as fullscreen overlays on every connected
/// monitor using the wlr-layer-shell Wayland protocol. Designed to work with
/// hypridle (timeout orchestration) and hyprlock (lock screen).
///
/// Configuration: ~/.config/hyprsaver/config.toml
/// User shaders:  ~/.config/hyprsaver/shaders/*.frag
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
                  Configuration: ~/.config/hyprsaver/config.toml\n\
                  User shaders:  ~/.config/hyprsaver/shaders/*.frag"
)]
struct Cli {
    /// Path to config file (overrides XDG default)
    #[arg(short, long, value_name = "PATH")]
    config: Option<PathBuf>,

    /// Shader to use (name or "random" or "cycle")
    #[arg(short, long, value_name = "NAME")]
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

    /// Open a windowed preview of the given shader (for authoring)
    #[arg(long, value_name = "SHADER")]
    preview: Option<String>,

    /// Enable verbose debug logging (equivalent to RUST_LOG=hyprsaver=debug)
    #[arg(short, long)]
    verbose: bool,
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

    // Build managers (needed for --list-* subcommands too).
    let shader_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from(".config"))
        .join("hyprsaver")
        .join("shaders");
    let mut shader_manager =
        ShaderManager::new(shader_dir.clone()).context("failed to initialise ShaderManager")?;

    // Start hot-reload watcher (silently skipped if dir doesn't exist).
    if let Err(e) = shader_manager.watch_for_changes() {
        log::warn!("Could not start shader watcher: {e:#}");
    }

    let palette_manager = PaletteManager::new(cfg.palettes.clone());

    // Early-exit commands.
    if cli.list_shaders {
        print_shaders(&shader_manager, &shader_dir);
        return Ok(());
    }
    if cli.list_palettes {
        print_palettes(&palette_manager, &cfg);
        return Ok(());
    }

    // Check if another instance is already running.
    check_already_running()?;

    // Write PID file for --quit support.
    let _pid_guard = PidFile::create().context("failed to write PID file")?;

    // Branch: preview window vs full screensaver overlay.
    let preview_mode = cli.preview.is_some();
    wayland::run(cfg, shader_manager, palette_manager, preview_mode, running)
        .context("screensaver exited with error")?;

    info!("hyprsaver exiting cleanly");
    Ok(())
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
// --list-shaders / --list-palettes
// ---------------------------------------------------------------------------

/// Short descriptions for built-in shaders.
fn shader_descriptions() -> std::collections::HashMap<&'static str, &'static str> {
    [
        ("mandelbrot", "Mandelbrot set zoom"),
        ("julia", "Julia set with animated constant"),
        ("plasma", "Classic plasma effect"),
        ("tunnel", "Infinite tunnel flythrough"),
        ("voronoi", "Animated Voronoi cells"),
    ]
    .into_iter()
    .collect()
}

/// Short descriptions for built-in palettes.
fn palette_descriptions() -> std::collections::HashMap<&'static str, &'static str> {
    [
        ("autumn", "Golds, rusts, deep reds"),
        ("electric", "Classic rainbow (default)"),
        ("ember", "Deep reds to bright orange"),
        ("forest", "Sage greens, deep greens, and earthy coffee browns"),
        ("frost", "Icy blues and silvers"),
        ("groovy", "Groovy 70s oranges, pinks, and warm tones"),
        ("monochrome", "Grayscale"),
        ("ocean", "Deep navy to cyan to white"),
        ("vapor", "Vaporwave pinks, teals, purples"),
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
    let builtin_names = palette::builtin_palettes();
    let all = manager.list();

    println!("Built-in palettes:");
    for name in &all {
        if !builtin_names.contains_key(*name) {
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
    if cfg.palettes.is_empty() {
        println!("  (none defined)");
    } else {
        for name in cfg.palettes.keys() {
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

/// Load config from CLI flag -> XDG path -> built-in defaults, then apply
/// CLI overrides.
fn load_config(cli: &Cli) -> anyhow::Result<Config> {
    let path = cli.config.as_deref().and_then(|p| p.to_str());
    let mut cfg = config::load_config(path)?;
    cfg.apply_cli_overrides(cli.shader.as_deref(), cli.palette.as_deref());
    Ok(cfg)
}
