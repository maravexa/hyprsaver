//! `render_preview.rs` — `render-preview` subcommand.
//!
//! Renders animated WebP previews of built-in shaders for README galleries.
//! Supports batch mode (all shaders when none specified), deterministic palette
//! selection via stable FNV-1a hash, and incremental generation with
//! `--skip-existing`.
//!
//! Requires no Wayland compositor — uses a headless EGL context.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Context as _;
use clap::Args;

use crate::palette::PaletteManager;
use crate::renderer::{OffscreenTarget, Renderer};
use crate::shaders::ShaderManager;

// Default seed used for deterministic palette selection when --seed is omitted.
const DEFAULT_SEED: u64 = 0;

// Fixed crossfade window (seconds) between palettes in --cycle-palettes mode.
const XFADE_DURATION: f32 = 1.0;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/// Render animated WebP previews of shaders for README galleries.
///
/// Uses headless EGL — no Wayland compositor required.
///
/// Examples:
///   hyprsaver render-preview
///   hyprsaver render-preview blob mobius
///   hyprsaver render-preview blob --palette marsha -o /tmp/blob.webp
///   hyprsaver render-preview --cycle-palettes marsha,achilles,sappho --duration 9
///   hyprsaver render-preview --skip-existing --seed 42
#[derive(Args, Debug)]
pub struct RenderPreviewArgs {
    /// Built-in shader names. If omitted, renders all built-in shaders.
    #[arg(value_name = "SHADER")]
    pub shaders: Vec<String>,

    /// Palette name. If omitted, a palette is chosen deterministically per
    /// shader via stable hash of the shader name and seed.
    #[arg(long, value_name = "NAME", conflicts_with = "cycle_palettes")]
    pub palette: Option<String>,

    /// Comma-separated palette names for multi-palette cycling preview.
    /// Spends duration/N seconds on each palette with crossfades at boundaries.
    #[arg(long, value_name = "NAMES")]
    pub cycle_palettes: Option<String>,

    /// Preview duration in seconds.
    #[arg(long, default_value = "3", value_name = "SECONDS")]
    pub duration: u64,

    /// Output resolution.
    #[arg(long, default_value = "480x270", value_name = "WxH")]
    pub resolution: String,

    /// Frames per second.
    #[arg(long, default_value = "15", value_name = "FPS")]
    pub fps: u64,

    /// WebP quality (0–100).
    #[arg(long, default_value = "80", value_name = "0-100")]
    pub quality: u8,

    /// Hash salt for deterministic palette selection.
    /// Same shader name + same seed always produces the same palette.
    /// Defaults to 0; logged to stderr when omitted.
    #[arg(long, value_name = "U64")]
    pub seed: Option<u64>,

    /// Skip shaders whose output file already exists.
    #[arg(long)]
    pub skip_existing: bool,

    /// Output path. Valid only when exactly one shader is specified.
    /// Defaults to ./<shader>.webp in the current working directory.
    #[arg(long, short, value_name = "PATH")]
    pub output: Option<PathBuf>,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub fn run(
    args: &RenderPreviewArgs,
    shader_manager: &ShaderManager,
    palette_manager: &PaletteManager,
) -> anyhow::Result<()> {
    // -o is only valid for a single-shader invocation.
    if args.output.is_some() {
        match args.shaders.len() {
            0 => anyhow::bail!(
                "'-o/--output' is only valid for a single shader; \
                 omit it for batch mode or specify exactly one shader name"
            ),
            1 => {}
            n => anyhow::bail!(
                "'-o/--output' is only valid for a single shader; {} shaders were specified",
                n
            ),
        }
    }

    // Determine which shaders to render.
    let shaders_to_render: Vec<String> = if args.shaders.is_empty() {
        shader_manager
            .list()
            .iter()
            .filter(|n| shader_manager.get(n).is_some_and(|s| s.builtin))
            .map(|s| s.to_string())
            .collect()
    } else {
        for name in &args.shaders {
            if shader_manager.get(name).is_none() {
                anyhow::bail!(
                    "unknown shader '{}'; run `hyprsaver --list-shaders` for available names",
                    name
                );
            }
        }
        args.shaders.clone()
    };

    if shaders_to_render.is_empty() {
        anyhow::bail!("no shaders found to render");
    }

    // Parse shared render parameters.
    let (width, height) = parse_resolution(&args.resolution)?;
    let fps = args.fps.max(1);
    let duration = args.duration.max(1);
    let quality = args.quality.min(100);

    // Seed for deterministic palette selection.
    let seed = args.seed.unwrap_or(DEFAULT_SEED);
    if args.seed.is_none() {
        eprintln!(
            "render-preview: using default seed {DEFAULT_SEED}  \
             (--seed {DEFAULT_SEED} to reproduce)"
        );
    }

    // Validate --palette.
    if let Some(ref name) = args.palette {
        if palette_manager.get(name).is_none() {
            anyhow::bail!(
                "unknown palette '{}'; run `hyprsaver --list-palettes` for available names",
                name
            );
        }
    }

    // Parse and validate --cycle-palettes.
    let cycle_palette_names: Option<Vec<String>> = if let Some(ref csv) = args.cycle_palettes {
        let names: Vec<String> = csv
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if names.is_empty() {
            anyhow::bail!("--cycle-palettes: palette list is empty");
        }
        for name in &names {
            if palette_manager.get(name).is_none() {
                anyhow::bail!(
                    "unknown palette '{}'; run `hyprsaver --list-palettes` for available names",
                    name
                );
            }
        }
        Some(names)
    } else {
        None
    };

    // Collect all palette names for deterministic selection fallback.
    let all_palette_names: Vec<String> = palette_manager
        .list()
        .iter()
        .map(|s| s.to_string())
        .collect();

    // Initialise headless EGL and renderer once; reuse across all shaders.
    let (gl, _egl_ctx) =
        crate::headless_egl::init().context("failed to initialise headless EGL context")?;
    let mut renderer = Renderer::new(gl).context("failed to create renderer")?;
    let fbo = OffscreenTarget::new(renderer.gl(), width, height);

    let total = shaders_to_render.len();
    let mut any_failed = false;

    for (idx, shader_name) in shaders_to_render.iter().enumerate() {
        let label = format!("[{}/{}]", idx + 1, total);

        let output_path = args
            .output
            .clone()
            .unwrap_or_else(|| PathBuf::from(format!("{shader_name}.webp")));

        if args.skip_existing && output_path.exists() {
            eprintln!("{label} Skipping {shader_name} (exists)");
            continue;
        }

        eprint!("{label} Rendering {shader_name}...");
        let _ = std::io::stderr().flush();

        let t_start = Instant::now();

        let palette_list = resolve_palette_list(
            shader_name,
            args.palette.as_deref(),
            cycle_palette_names.as_deref(),
            &all_palette_names,
            seed,
        );

        let result = render_shader_to_webp(
            shader_name,
            shader_manager,
            palette_manager,
            &palette_list,
            &mut renderer,
            &fbo,
            width,
            height,
            fps,
            duration,
            quality,
            &output_path,
        );

        match result {
            Ok(file_size) => {
                let elapsed = t_start.elapsed().as_secs_f32();
                eprintln!(" done ({} KB, {:.1}s)", file_size / 1024, elapsed);
            }
            Err(e) => {
                eprintln!(" FAILED: {e:#}");
                any_failed = true;
            }
        }
    }

    fbo.destroy(renderer.gl());

    if any_failed {
        anyhow::bail!("one or more shaders failed to render (see output above)");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Single-shader render → animated WebP
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn render_shader_to_webp(
    shader_name: &str,
    shader_manager: &ShaderManager,
    palette_manager: &PaletteManager,
    palette_list: &[String],
    renderer: &mut Renderer,
    fbo: &OffscreenTarget,
    width: u32,
    height: u32,
    fps: u64,
    duration: u64,
    quality: u8,
    output_path: &Path,
) -> anyhow::Result<usize> {
    // Validate output directory.
    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            anyhow::bail!("output directory '{}' does not exist", parent.display());
        }
    }

    // Compile shader.
    let shader_src = shader_manager
        .get(shader_name)
        .ok_or_else(|| anyhow::anyhow!("shader '{}' not found", shader_name))?;
    let frag_src = shader_src.compiled.clone();

    renderer
        .load_shader(&frag_src)
        .with_context(|| format!("failed to compile shader '{shader_name}'"))?;

    // Pre-compute palette LUTs.
    let n = palette_list.len();
    let luts: Vec<Vec<[f32; 3]>> = palette_list
        .iter()
        .map(|name| {
            palette_manager
                .get(name)
                .ok_or_else(|| anyhow::anyhow!("palette '{name}' not found"))
                .map(|e| e.to_lut())
        })
        .collect::<anyhow::Result<_>>()?;

    renderer
        .update_lut_a(&luts[0])
        .context("failed to upload initial palette LUT")?;
    renderer.set_blend(0.0);

    // Crossfade schedule: fixed 1.0 s xfade windows between palette slots.
    let slot_duration: f32 = if n == 1 {
        duration as f32
    } else {
        (duration as f32 - XFADE_DURATION) / n as f32
    };

    let total_frames = duration * fps;

    // Build WebP encoder with quality setting.
    //
    // `webp-animation` wraps libwebp's animation encoder. EncoderOptions
    // maps to WebPAnimEncoderOptions; EncodingConfig maps to WebPConfig.
    // loop_count defaults to 0 (infinite loop) in libwebp.
    let enc_options = webp_animation::EncoderOptions {
        encoding_config: Some(webp_animation::EncodingConfig {
            quality: quality as f32,
            ..Default::default()
        }),
        ..Default::default()
    };
    let mut encoder = webp_animation::Encoder::new_with_options((width, height), enc_options)
        .context("failed to create WebP encoder")?;

    for frame_idx in 0..total_frames {
        let t = frame_idx as f32 / fps as f32;

        // Palette crossfade state for this moment in time.
        let (a_idx, b_idx, mix) = palette_state_at(t, n, slot_duration, XFADE_DURATION);

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
        renderer.set_blend(0.0);

        // Render and read back pixels.
        let mut pixels = renderer
            .render_and_capture(fbo.fbo, [width, height], t, frame_idx)
            .context("render_and_capture failed")?;

        // OpenGL origin is bottom-left; WebP expects top-left.
        flip_vertical(&mut pixels, width, height);

        // Timestamp is the start of this frame in milliseconds.
        let timestamp_ms = ((frame_idx as f64 * 1000.0) / fps as f64).round() as i32;
        encoder
            .add_frame(&pixels, timestamp_ms)
            .context("failed to add WebP frame")?;
    }

    // End timestamp = total animation duration in ms.
    let end_ms = ((total_frames as f64 * 1000.0) / fps as f64).round() as i32;
    let webp_data = encoder
        .finalize(end_ms)
        .context("failed to finalize WebP animation")?;

    std::fs::write(output_path, &*webp_data)
        .with_context(|| format!("failed to write '{}'", output_path.display()))?;

    Ok(webp_data.len())
}

// ---------------------------------------------------------------------------
// Palette resolution
// ---------------------------------------------------------------------------

/// Return the ordered palette list for `shader_name`.
///
/// Priority:
/// 1. `cycle_palettes` — explicit multi-palette list
/// 2. `single_palette` — explicit single palette
/// 3. FNV-1a hash of `shader_name + seed` → deterministic pick from all palettes
fn resolve_palette_list(
    shader_name: &str,
    single_palette: Option<&str>,
    cycle_palettes: Option<&[String]>,
    all_palette_names: &[String],
    seed: u64,
) -> Vec<String> {
    if let Some(names) = cycle_palettes {
        return names.to_vec();
    }
    if let Some(name) = single_palette {
        return vec![name.to_string()];
    }
    if all_palette_names.is_empty() {
        return Vec::new();
    }
    let idx = fnv1a_pick(shader_name, seed, all_palette_names.len());
    vec![all_palette_names[idx].clone()]
}

/// FNV-1a 64-bit hash of `seed_bytes || shader_name_bytes`, mapped to `[0, count)`.
///
/// Stable across Rust versions, compilers, and platforms (no `std::hash`).
fn fnv1a_pick(shader_name: &str, seed: u64, count: usize) -> usize {
    const FNV_OFFSET: u64 = 14695981039346656037;
    const FNV_PRIME: u64 = 1099511628211;

    let mut hash = FNV_OFFSET;
    for byte in seed.to_le_bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    for &byte in shader_name.as_bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    (hash as usize) % count
}

// ---------------------------------------------------------------------------
// Palette crossfade schedule
// ---------------------------------------------------------------------------

/// Compute `(palette_a_idx, palette_b_idx, mix)` for time `t`.
///
/// `mix = 0.0` → pure palette `a_idx`.
/// `mix > 0.0` → crossfade from `a_idx` toward `b_idx`.
fn palette_state_at(t: f32, n: usize, slot_duration: f32, xfade: f32) -> (usize, usize, f32) {
    if n == 1 {
        return (0, 0, 0.0);
    }

    let half = xfade * 0.5;

    for k in 0..n {
        let center = (k + 1) as f32 * slot_duration;
        let xfade_start = center - half;
        let xfade_end = center + half;
        if t >= xfade_start && t < xfade_end {
            let mix = ((t - xfade_start) / xfade).clamp(0.0, 1.0);
            return (k, (k + 1) % n, mix);
        }
    }

    let tail_start = n as f32 * slot_duration + half;
    if t >= tail_start || t < half {
        return (0, 0, 0.0);
    }

    let k = ((t - half) / slot_duration) as usize;
    (k.min(n - 1), 0, 0.0)
}

// ---------------------------------------------------------------------------
// CPU LUT blending
// ---------------------------------------------------------------------------

/// Linearly blend two 256-sample LUTs. `mix = 0.0` → pure `a`; `1.0` → pure `b`.
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
/// OpenGL reads bottom-up; WebP expects top-down.
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
// Resolution parsing
// ---------------------------------------------------------------------------

fn parse_resolution(s: &str) -> anyhow::Result<(u32, u32)> {
    let (ws, hs) = s
        .split_once('x')
        .or_else(|| s.split_once('X'))
        .ok_or_else(|| anyhow::anyhow!("invalid resolution '{s}'; expected WxH, e.g. '480x270'"))?;
    let w: u32 = ws
        .trim()
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid width in resolution '{s}'"))?;
    let h: u32 = hs
        .trim()
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid height in resolution '{s}'"))?;
    anyhow::ensure!(w > 0 && h > 0, "resolution must be non-zero (got {w}x{h})");
    Ok((w, h))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_palette_pick_is_stable() {
        let a = fnv1a_pick("blob", 0, 12);
        let b = fnv1a_pick("blob", 0, 12);
        assert_eq!(a, b);
    }

    #[test]
    fn different_shaders_spread_across_palettes() {
        let shaders = ["blob", "aurora", "julia", "plasma", "starfield", "flames"];
        let indices: Vec<usize> = shaders.iter().map(|s| fnv1a_pick(s, 0, 12)).collect();
        let first = indices[0];
        assert!(
            indices.iter().any(|&i| i != first),
            "all shaders hashed to same palette — hash may be broken"
        );
    }

    #[test]
    fn seed_changes_assignment() {
        // With 12 palettes, collision probability = 1/12 per pair.
        // Testing multiple shaders gives high confidence.
        let shaders = ["blob", "aurora", "julia", "plasma"];
        let seed0: Vec<usize> = shaders.iter().map(|s| fnv1a_pick(s, 0, 12)).collect();
        let seed1: Vec<usize> = shaders.iter().map(|s| fnv1a_pick(s, 99, 12)).collect();
        assert!(
            seed0 != seed1,
            "seed did not change palette assignments — hash may be broken"
        );
    }

    #[test]
    fn parse_resolution_valid() {
        assert_eq!(parse_resolution("480x270").unwrap(), (480, 270));
        assert_eq!(parse_resolution("1920X1080").unwrap(), (1920, 1080));
    }

    #[test]
    fn parse_resolution_invalid() {
        assert!(parse_resolution("480").is_err());
        assert!(parse_resolution("0x270").is_err());
        assert!(parse_resolution("480x0").is_err());
    }

    #[test]
    fn palette_state_single_palette() {
        for t in [0.0f32, 1.5, 2.9] {
            assert_eq!(palette_state_at(t, 1, 3.0, 1.0), (0, 0, 0.0), "t={t}");
        }
    }

    #[test]
    fn palette_state_crossfade_zones() {
        // N=3, duration=3s, xfade=1s → slot = (3-1)/3 ≈ 0.667s
        let (n, dur, xf) = (3usize, 3.0f32, 1.0f32);
        let slot = (dur - xf) / n as f32;

        // Pure zone: t=0 should be palette 0.
        let (a, _, mix) = palette_state_at(0.0, n, slot, xf);
        assert_eq!(a, 0);
        assert_eq!(mix, 0.0);

        // Midpoint of first crossfade (A→B): mix should be ~0.5.
        let center1 = slot;
        let (a, b, mix) = palette_state_at(center1, n, slot, xf);
        assert_eq!(a, 0);
        assert_eq!(b, 1);
        assert!((mix - 0.5).abs() < 0.01, "mix={mix}");
    }
}
