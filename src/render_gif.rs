//! `render_gif.rs` — `render-gif` subcommand.
//!
//! Renders a looping GIF of a single built-in shader cycled through a palette
//! playlist with CPU-side LUT crossfades. Designed for README showcase GIFs,
//! not end-user screensaver operation.
//!
//! Requires no Wayland compositor — uses a headless EGL context.

use std::io::Write as _;
use std::path::PathBuf;

use anyhow::Context as _;
use clap::Args;

use crate::palette::PaletteManager;
use crate::renderer::{OffscreenTarget, Renderer};
use crate::shaders::ShaderManager;
use crate::shuffle::{seed_from_time, xorshift64};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/// Render a looping GIF of a shader for README showcases.
///
/// Uses headless EGL — no Wayland compositor required.
///
/// Examples:
///   hyprsaver render-gif aurora
///   hyprsaver render-gif flames --palettes sunset,ocean,forest --duration 10
///   hyprsaver render-gif starfield --resolution 640x360 --fps 15
#[derive(Args, Debug)]
pub struct RenderGifArgs {
    /// Built-in shader name (e.g. "aurora", "flames", "starfield").
    /// Run `hyprsaver --list-shaders` for the full list.
    pub shader: String,

    /// Comma-separated palette names in render order.
    /// Fewer than 3 are padded with random palettes from the embedded set.
    /// If omitted, 3 random palettes are chosen.
    #[arg(long, value_name = "NAME,...")]
    pub palettes: Option<String>,

    /// Total GIF duration in seconds (integer).
    #[arg(long, default_value = "10", value_name = "SECONDS")]
    pub duration: u64,

    /// Output resolution.
    #[arg(long, default_value = "960x540", value_name = "WxH")]
    pub resolution: String,

    /// Frames per second.
    #[arg(long, default_value = "20", value_name = "FPS")]
    pub fps: u64,

    /// Random seed for palette selection when padding.
    /// Logged to stderr when omitted so runs can be reproduced.
    #[arg(long, value_name = "U64")]
    pub seed: Option<u64>,

    /// Output file path.
    /// Defaults to `./hyprsaver-<shader>-<seed>.gif` in the current directory.
    #[arg(long, short, value_name = "PATH")]
    pub output: Option<PathBuf>,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub fn run(
    args: &RenderGifArgs,
    shader_manager: &ShaderManager,
    palette_manager: &PaletteManager,
) -> anyhow::Result<()> {
    // --- Validate shader ---
    let shader_src = shader_manager.get(&args.shader).ok_or_else(|| {
        anyhow::anyhow!(
            "unknown shader '{}'; run `hyprsaver --list-shaders` for available names",
            args.shader
        )
    })?;
    let frag_src = shader_src.compiled.clone();

    // --- Parse resolution ---
    let (width, height) = parse_resolution(&args.resolution)?;
    let fps = args.fps.max(1);
    let duration = args.duration.max(1);

    // --- Determine seed ---
    let seed = match args.seed {
        Some(s) => s,
        None => {
            let s = seed_from_time();
            eprintln!("hyprsaver render-gif: seed = {s}  (--seed {s} to reproduce)");
            s
        }
    };

    // --- Resolve palette list ---
    let palette_names = resolve_palettes(args, palette_manager, seed)?;
    let n = palette_names.len();

    eprintln!(
        "render-gif: shader={shader}  palettes=[{pals}]  {dur}s @ {fps}fps  {w}x{h}",
        shader = args.shader,
        pals = palette_names.join(", "),
        dur = duration,
        w = width,
        h = height,
    );

    // --- Pre-compute per-palette LUTs (CPU side) ---
    let luts: Vec<Vec<[f32; 3]>> = palette_names
        .iter()
        .map(|name| {
            palette_manager
                .get(name)
                .ok_or_else(|| anyhow::anyhow!("palette '{}' not found after validation", name))
                .map(|e| e.to_lut())
        })
        .collect::<anyhow::Result<_>>()?;

    // --- Headless EGL + Renderer ---
    let (gl, _egl_ctx) =
        crate::headless_egl::init().context("failed to initialise headless EGL context")?;

    let mut renderer = Renderer::new(gl).context("failed to create renderer")?;
    renderer
        .load_shader(&frag_src)
        .with_context(|| format!("failed to compile shader '{}'", args.shader))?;

    // Upload palette 0 as the initial LUT; palette_blend stays 0.0 (default).
    renderer
        .update_lut_a(&luts[0])
        .context("failed to upload initial palette LUT")?;
    renderer.set_blend(0.0);

    // --- GIF FBO at target resolution ---
    let gif_fbo = OffscreenTarget::new(renderer.gl(), width, height);

    // --- Output path ---
    let output_path = args
        .output
        .clone()
        .unwrap_or_else(|| PathBuf::from(format!("hyprsaver-{}-{}.gif", args.shader, seed)));

    let file = std::fs::File::create(&output_path)
        .with_context(|| format!("failed to create output file: {}", output_path.display()))?;
    let writer = std::io::BufWriter::new(file);

    // --- GIF encoder ---
    let mut encoder = gif::Encoder::new(writer, width as u16, height as u16, &[])
        .context("failed to create GIF encoder")?;
    encoder
        .set_repeat(gif::Repeat::Infinite)
        .context("failed to set GIF repeat mode")?;

    // --- Palette crossfade schedule ---
    // xfade = 1.0 s fixed; slot_duration derived from total duration and N.
    let xfade: f32 = 1.0;
    let slot_duration: f32 = if n == 1 {
        duration as f32
    } else {
        (duration as f32 - xfade) / n as f32
    };

    // --- Deterministic render loop ---
    let dt = 1.0_f32 / fps as f32;
    let total_frames = duration * fps;

    for frame_idx in 0..total_frames {
        let t = frame_idx as f32 * dt;

        // Determine active palette(s) and crossfade mix for this time.
        let (a_idx, b_idx, mix) = palette_state_at(t, n, slot_duration, xfade);

        // Upload blended LUT for this frame.
        if mix <= 0.0 {
            renderer
                .update_lut_a(&luts[a_idx])
                .context("failed to update palette LUT")?;
        } else {
            let blended = cpu_blend_luts(&luts[a_idx], &luts[b_idx], mix);
            renderer
                .update_lut_a(&blended)
                .context("failed to update blended palette LUT")?;
        }
        // palette_blend stays 0.0 — all blending is CPU-side; GPU sees one LUT.
        renderer.set_blend(0.0);

        // Render the frame into the headless FBO.
        let mut pixels = renderer
            .render_and_capture(gif_fbo.fbo, [width, height], t, frame_idx)
            .context("render_and_capture failed")?;

        // Flip vertically: OpenGL origin is bottom-left; GIF expects top-left.
        flip_vertical(&mut pixels, width, height);

        // Encode frame.
        let mut frame = gif::Frame::from_rgba_speed(width as u16, height as u16, &mut pixels, 10);
        // delay is in centiseconds (1/100 s).
        frame.delay = (100 / fps) as u16;
        encoder
            .write_frame(&frame)
            .context("failed to write GIF frame")?;

        // Progress heartbeat once per second.
        if frame_idx % fps == 0 {
            eprint!("  {}/{}s\r", frame_idx / fps, duration);
            let _ = std::io::stderr().flush();
        }
    }
    eprintln!(); // newline after progress

    // Flush GIF (encoder is consumed here).
    drop(encoder);

    // Clean up the headless FBO before the renderer drops.
    gif_fbo.destroy(renderer.gl());

    println!("Written: {}", output_path.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// Palette crossfade schedule
// ---------------------------------------------------------------------------

/// Compute `(palette_a_idx, palette_b_idx, mix)` for time `t`.
///
/// `mix = 0.0` → pure palette `a_idx`.
/// `mix > 0.0` → crossfade from `a_idx` toward `b_idx`.
///
/// Schedule (for N palettes, `duration` seconds, `xfade = 1.0` s):
///
/// ```text
/// slot_duration = (duration - xfade) / N
///
/// For palette k: crossfade to palette (k+1)%N is centred at
///   (k+1) * slot_duration, spanning ±xfade/2.
///
/// Tail: [N*slot_duration + xfade/2, duration] is pure palette 0,
///   making the loop seamless at t=0 and t=duration-1/fps.
/// ```
fn palette_state_at(t: f32, n: usize, slot_duration: f32, xfade: f32) -> (usize, usize, f32) {
    if n == 1 {
        return (0, 0, 0.0);
    }

    let half = xfade * 0.5;

    // Check each crossfade window.
    for k in 0..n {
        let center = (k + 1) as f32 * slot_duration;
        let xfade_start = center - half;
        let xfade_end = center + half;
        if t >= xfade_start && t < xfade_end {
            let mix = ((t - xfade_start) / xfade).clamp(0.0, 1.0);
            return (k, (k + 1) % n, mix);
        }
    }

    // Pure zone: determine which palette is active.
    let tail_start = n as f32 * slot_duration + half;
    if t >= tail_start || t < half {
        // Wrap-around tail (after last crossfade) or pre-loop — pure palette 0.
        return (0, 0, 0.0);
    }

    // t is in [half, N*slot_duration + half) and not in any crossfade window.
    let k = ((t - half) / slot_duration) as usize;
    (k.min(n - 1), 0, 0.0)
}

// ---------------------------------------------------------------------------
// CPU LUT blending
// ---------------------------------------------------------------------------

/// Linearly blend two 256-sample LUTs in linear RGB.
/// `mix = 0.0` → pure `a`, `mix = 1.0` → pure `b`.
fn cpu_blend_luts(lut_a: &[[f32; 3]], lut_b: &[[f32; 3]], mix: f32) -> Vec<[f32; 3]> {
    let inv = 1.0 - mix;
    lut_a
        .iter()
        .zip(lut_b.iter())
        .map(|(a, b)| {
            [
                (a[0] * inv + b[0] * mix).clamp(0.0, 1.0),
                (a[1] * inv + b[1] * mix).clamp(0.0, 1.0),
                (a[2] * inv + b[2] * mix).clamp(0.0, 1.0),
            ]
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Pixel helpers
// ---------------------------------------------------------------------------

/// Flip RGBA pixel buffer vertically in-place.
/// OpenGL reads bottom-up; GIF expects top-down.
fn flip_vertical(pixels: &mut [u8], width: u32, height: u32) {
    let row = (width * 4) as usize;
    for y in 0..(height as usize / 2) {
        let top = y * row;
        let bot = (height as usize - 1 - y) * row;
        for x in 0..row {
            pixels.swap(top + x, bot + x);
        }
    }
}

// ---------------------------------------------------------------------------
// Palette resolution
// ---------------------------------------------------------------------------

/// Validate the user-specified palette names and pad to at least 3 with
/// random picks from the full palette list.
fn resolve_palettes(
    args: &RenderGifArgs,
    palette_manager: &PaletteManager,
    seed: u64,
) -> anyhow::Result<Vec<String>> {
    let mut names: Vec<String> = if let Some(ref csv) = args.palettes {
        csv.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        Vec::new()
    };

    // Validate that every named palette exists.
    for name in &names {
        if palette_manager.get(name).is_none() {
            anyhow::bail!(
                "unknown palette '{}'; run `hyprsaver --list-palettes` for available names",
                name
            );
        }
    }

    // Pad to at least 3 palettes with random picks.
    if names.len() < 3 {
        let all = palette_manager.list();
        let needed = 3 - names.len();
        let picks = random_palette_picks(&all, needed, seed);
        names.extend(picks);
    }

    Ok(names)
}

/// Pick `count` palette names at random using `seed`, sampling with replacement
/// from `all`. Uses the same xorshift64 PRNG as the rest of the codebase —
/// no external `rand` dependency.
fn random_palette_picks(all: &[&str], count: usize, seed: u64) -> Vec<String> {
    if all.is_empty() || count == 0 {
        return Vec::new();
    }
    let mut state = if seed == 0 {
        0x853c_49e6_748f_ea9b_u64
    } else {
        seed
    };
    let n = all.len();
    (0..count)
        .map(|_| all[(xorshift64(&mut state) as usize) % n].to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Resolution parsing
// ---------------------------------------------------------------------------

fn parse_resolution(s: &str) -> anyhow::Result<(u32, u32)> {
    let (ws, hs) = s
        .split_once('x')
        .or_else(|| s.split_once('X'))
        .ok_or_else(|| {
            anyhow::anyhow!("invalid resolution '{}'; expected WxH, e.g. '960x540'", s)
        })?;
    let w: u32 = ws
        .trim()
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid width in resolution '{}'", s))?;
    let h: u32 = hs
        .trim()
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid height in resolution '{}'", s))?;
    anyhow::ensure!(w > 0 && h > 0, "resolution must be non-zero (got {w}x{h})");
    Ok((w, h))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn check(t: f32, n: usize, dur: f32, xfade: f32, expect_a: usize, expect_mix_approx: f32) {
        let slot = if n == 1 {
            dur
        } else {
            (dur - xfade) / n as f32
        };
        let (a, _b, mix) = palette_state_at(t, n, slot, xfade);
        assert_eq!(a, expect_a, "t={t} expected a_idx={expect_a} got {a}");
        assert!(
            (mix - expect_mix_approx).abs() < 1e-4,
            "t={t} expected mix≈{expect_mix_approx} got {mix}"
        );
    }

    #[test]
    fn schedule_n3_pure_zones() {
        // N=3, duration=10s, xfade=1s → slot=3s
        check(0.0, 3, 10.0, 1.0, 0, 0.0); // pre-loop → pure A
        check(1.0, 3, 10.0, 1.0, 0, 0.0); // pure A
        check(3.5, 3, 10.0, 1.0, 1, 0.0); // pure B
        check(6.5, 3, 10.0, 1.0, 2, 0.0); // pure C
        check(9.5, 3, 10.0, 1.0, 0, 0.0); // tail → pure A
        check(9.95, 3, 10.0, 1.0, 0, 0.0); // last frame → pure A
    }

    #[test]
    fn schedule_n3_crossfades() {
        // A→B crossfade: [2.5, 3.5)
        check(2.5, 3, 10.0, 1.0, 0, 0.0); // start of A→B
        check(3.0, 3, 10.0, 1.0, 0, 0.5); // midpoint A→B
                                          // B→C crossfade: [5.5, 6.5)
        check(5.5, 3, 10.0, 1.0, 1, 0.0); // start of B→C
        check(6.0, 3, 10.0, 1.0, 1, 0.5); // midpoint B→C
                                          // C→A crossfade: [8.5, 9.5)
        check(8.5, 3, 10.0, 1.0, 2, 0.0); // start of C→A
        check(9.0, 3, 10.0, 1.0, 2, 0.5); // midpoint C→A
    }

    #[test]
    fn schedule_n1_always_palette_0() {
        for t in [0.0f32, 2.5, 5.0, 9.9] {
            let (a, b, mix) = palette_state_at(t, 1, 10.0, 1.0);
            assert_eq!((a, b, mix), (0, 0, 0.0), "t={t}");
        }
    }

    #[test]
    fn parse_resolution_ok() {
        assert_eq!(parse_resolution("960x540").unwrap(), (960, 540));
        assert_eq!(parse_resolution("1920X1080").unwrap(), (1920, 1080));
    }

    #[test]
    fn parse_resolution_err() {
        assert!(parse_resolution("960").is_err());
        assert!(parse_resolution("0x540").is_err());
    }
}
