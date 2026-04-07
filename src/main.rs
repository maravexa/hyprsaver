//! `main.rs` — Entry point for hyprsaver.
//!
//! Responsibilities:
//! - Parse CLI arguments via clap derive macros
//! - Register SIGTERM/SIGINT handlers via signal-hook
//! - Initialize env_logger for structured logging
//! - Load and validate configuration
//! - Branch into preview mode (xdg-toplevel window) or screensaver mode (layer-shell overlay)
//! - Drive the calloop event loop until signal or dismiss input
//! - Clean up Wayland surfaces and GL contexts on exit

use anyhow::Context;
use clap::Parser;
use log::{debug, info};
use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::config::Config;

mod config;
mod palette;
mod renderer;
mod shaders;
mod wayland;

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

    // Initialise logging. --verbose sets level to debug, otherwise respect RUST_LOG or default info.
    if cli.verbose {
        std::env::set_var("RUST_LOG", "hyprsaver=debug");
    }
    env_logger::init();

    info!("hyprsaver starting");
    debug!("CLI args: {:?}", cli);

    // Install signal handlers so SIGTERM (from hypridle) and SIGINT (Ctrl-C) both exit cleanly.
    let running = Arc::new(AtomicBool::new(true));
    install_signal_handlers(Arc::clone(&running))
        .context("failed to install signal handlers")?;

    // Load configuration, applying CLI overrides.
    let cfg = load_config(&cli).context("failed to load config")?;
    debug!("Loaded config: {:?}", cfg);

    // Early-exit commands.
    if cli.list_shaders {
        list_shaders(&cfg).context("failed to list shaders")?;
        return Ok(());
    }
    if cli.list_palettes {
        list_palettes(&cfg).context("failed to list palettes")?;
        return Ok(());
    }
    if cli.quit {
        send_quit_signal().context("failed to send quit signal")?;
        return Ok(());
    }

    // Branch: preview window vs full screensaver overlay.
    if let Some(shader_name) = &cli.preview {
        run_preview(shader_name, &cfg, running).context("preview mode failed")?;
    } else {
        run_screensaver(&cfg, running).context("screensaver mode failed")?;
    }

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
    todo!("resolve config path from cli.config / XDG / defaults, parse TOML, apply cli.shader and cli.palette overrides")
}

/// Print each available shader name to stdout, one per line.
fn list_shaders(_cfg: &Config) -> anyhow::Result<()> {
    todo!("instantiate ShaderManager, call .list(), print each name")
}

/// Print each available palette name to stdout, one per line.
fn list_palettes(_cfg: &Config) -> anyhow::Result<()> {
    todo!("instantiate PaletteManager, call .list(), print each name")
}

/// Send SIGTERM to the PID stored in the lock file (or find via process name).
fn send_quit_signal() -> anyhow::Result<()> {
    todo!("read PID from ~/.cache/hyprsaver/hyprsaver.pid, send SIGTERM")
}

/// Run in windowed preview mode: open an xdg-toplevel window, render the named shader,
/// exit when the window is closed or a signal is received.
fn run_preview(
    shader_name: &str,
    cfg: &Config,
    running: Arc<AtomicBool>,
) -> anyhow::Result<()> {
    todo!(
        "create xdg-toplevel window via glutin/winit, init Renderer, load shader '{}', \
         enter render loop checking running flag and window close events",
        shader_name
    )
}

/// Run in screensaver mode: create wlr-layer-shell surfaces on all outputs, render until
/// input event or signal sets running=false.
fn run_screensaver(cfg: &Config, running: Arc<AtomicBool>) -> anyhow::Result<()> {
    todo!(
        "call wayland::WaylandState::connect(), create_surfaces(), \
         init Renderer per surface, enter calloop event loop, \
         on running=false call destroy_surfaces() and return"
    )
}
