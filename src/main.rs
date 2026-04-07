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

/// hyprsaver — Wayland-native fractal screensaver for Hyprland
#[derive(Parser, Debug)]
#[command(
    name = "hyprsaver",
    version,
    author,
    about = "Wayland-native fractal screensaver for Hyprland"
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

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if cli.verbose {
        std::env::set_var("RUST_LOG", "hyprsaver=debug");
    }
    env_logger::init();

    info!("hyprsaver starting");
    debug!("CLI args: {:?}", cli);

    // Install signal handlers so SIGTERM (from hypridle) and SIGINT (Ctrl-C) exit cleanly.
    let running = Arc::new(AtomicBool::new(true));
    install_signal_handlers(Arc::clone(&running))
        .context("failed to install signal handlers")?;

    // Load configuration, applying CLI overrides.
    let cfg = load_config(&cli).context("failed to load config")?;
    debug!("Loaded config: {:?}", cfg);

    // Build managers (needed for --list-* subcommands too).
    let shader_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from(".config"))
        .join("hyprsaver")
        .join("shaders");
    let mut shader_manager =
        ShaderManager::new(shader_dir).context("failed to initialise ShaderManager")?;

    // Start hot-reload watcher (silently skipped if dir doesn't exist).
    if let Err(e) = shader_manager.watch_for_changes() {
        log::warn!("Could not start shader watcher: {e:#}");
    }

    let palette_manager = PaletteManager::new(cfg.palettes.clone());

    // Early-exit commands.
    if cli.list_shaders {
        for name in shader_manager.list() {
            println!("{name}");
        }
        return Ok(());
    }
    if cli.list_palettes {
        for name in palette_manager.list() {
            println!("{name}");
        }
        return Ok(());
    }
    if cli.quit {
        send_quit_signal().context("failed to send quit signal")?;
        return Ok(());
    }

    // Branch: preview window vs full screensaver overlay.
    let preview_mode = cli.preview.is_some();
    wayland::run(cfg, shader_manager, palette_manager, preview_mode, running)
        .context("screensaver exited with error")?;

    info!("hyprsaver exiting cleanly");
    Ok(())
}

/// Register OS signal handlers. Sets `running` to false on SIGTERM or SIGINT.
fn install_signal_handlers(running: Arc<AtomicBool>) -> anyhow::Result<()> {
    let mut signals = Signals::new([SIGTERM, SIGINT])
        .context("could not create signal iterator")?;

    std::thread::spawn(move || {
        for sig in &mut signals {
            info!("Received signal {}, shutting down", sig);
            running.store(false, Ordering::SeqCst);
        }
    });

    Ok(())
}

/// Load config from CLI flag → XDG path → built-in defaults, then apply CLI overrides.
fn load_config(cli: &Cli) -> anyhow::Result<Config> {
    let path = cli.config.as_deref().and_then(|p| p.to_str());
    let mut cfg = config::load_config(path)?;
    cfg.apply_cli_overrides(cli.shader.as_deref(), cli.palette.as_deref());
    Ok(cfg)
}

/// Send SIGTERM to the PID stored in the lock file, or find via process name.
fn send_quit_signal() -> anyhow::Result<()> {
    // Try lock file first.
    let pid_path = dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("hyprsaver")
        .join("hyprsaver.pid");

    if pid_path.exists() {
        let pid_str = std::fs::read_to_string(&pid_path)
            .context("failed to read PID file")?;
        let pid: i32 = pid_str.trim().parse().context("invalid PID in lock file")?;
        // Safety: kill(pid, SIGTERM) is a standard POSIX call.
        let ret = unsafe { libc::kill(pid, libc::SIGTERM) };
        if ret == 0 {
            info!("Sent SIGTERM to PID {pid}");
            return Ok(());
        }
        log::warn!("kill({pid}, SIGTERM) failed; trying pkill");
    }

    // Fallback: pkill by process name.
    let status = std::process::Command::new("pkill")
        .arg("-TERM")
        .arg("hyprsaver")
        .status()
        .context("failed to run pkill")?;
    if status.success() {
        info!("Sent SIGTERM via pkill");
        Ok(())
    } else {
        anyhow::bail!("pkill found no running hyprsaver process")
    }
}
