//! `bench.rs` — `hyprsaver bench`: headless GPU cost benchmark for shaders.
//!
//! Renders each shader into an offscreen FBO at a fixed per-monitor resolution
//! for a fixed number of frames with deterministic time stepping, waits for the
//! GPU with `glFinish`, and reports the mean frame time. The frame time is then
//! expressed as the share of the daemon's frame budget it would consume:
//!
//! ```text
//! util% = frame_ms × monitors / (1000 / fps) × 100
//! ```
//!
//! With the defaults (1920×1200, 2 monitors, 30 fps) this approximates the
//! "% GPU" figures in `docs/BENCHMARK_*.md`, which were read off `radeontop`
//! on the dual-monitor reference rig. The two measures are not identical —
//! this one is pure render throughput with no compositor or presentation
//! overhead — but the tier thresholds are the same, and relative rankings
//! between shaders are what optimisation work needs. No compositor is
//! required; the daemon's own headless EGL path (`headless_egl.rs`) is used.

use std::io::Write as _;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::Context as _;
use glow::HasContext as _;

use crate::palette::PaletteManager;
use crate::renderer::{OffscreenTarget, Renderer};
use crate::shaders::ShaderManager;

/// GPU utilisation tiers shared by all performance decisions (see
/// `docs/backlog.md`, "GPU util tiers").
const TIERS: &[(f64, &str)] = &[
    (33.0, "Lightweight"),
    (50.0, "Medium"),
    (66.0, "Heavy"),
    (f64::INFINITY, "Ultra"),
];

#[derive(clap::Args, Debug)]
pub struct BenchArgs {
    /// Shader names. If omitted, benchmarks every built-in shader.
    #[arg(value_name = "SHADER")]
    pub shaders: Vec<String>,

    /// Render resolution of one monitor.
    #[arg(long, default_value = "1920x1200", value_name = "WxH")]
    pub resolution: String,

    /// Number of monitors the daemon would drive; the per-frame cost is
    /// multiplied by this before computing the utilisation percentage.
    #[arg(long, default_value = "2", value_name = "N")]
    pub monitors: u32,

    /// Daemon frame rate that defines the frame budget (1000 / fps ms).
    #[arg(long, default_value = "30", value_name = "FPS")]
    pub fps: u32,

    /// Timed frames per shader.
    #[arg(long, default_value = "120", value_name = "N")]
    pub frames: u32,

    /// Untimed warm-up frames per shader (pipeline compile, caches).
    #[arg(long, default_value = "15", value_name = "N")]
    pub warmup: u32,

    /// Shader-time span the timed frames are spread over, in seconds. Sampling
    /// evenly across a long span keeps phase-based shaders honest (geometry's
    /// 10 s morph cycle, temple's pillar scroll) instead of timing only their
    /// first few seconds.
    #[arg(long, default_value = "30", value_name = "SECONDS")]
    pub span: f32,

    /// Palette to sample while rendering.
    #[arg(long, default_value = "rainbow", value_name = "NAME")]
    pub palette: String,

    /// Print a Markdown table (for `docs/BENCHMARK_*.md`) instead of the
    /// aligned text table.
    #[arg(long)]
    pub markdown: bool,

    /// Also write the results as JSON to this path.
    #[arg(long, value_name = "PATH")]
    pub json: Option<PathBuf>,

    /// Sort by "cost" (most expensive first, default) or "name".
    #[arg(long, default_value = "cost", value_name = "cost|name")]
    pub sort: String,
}

/// One shader's measurement.
#[derive(Debug, Clone)]
pub struct BenchResult {
    pub name: String,
    /// Mean GPU time per frame for one monitor, in milliseconds.
    pub frame_ms: f64,
    /// Share of the frame budget used across all monitors, in percent.
    pub util_pct: f64,
    pub tier: &'static str,
    /// Set when the shader failed to compile; the numbers are then zero.
    pub error: Option<String>,
}

/// Map a utilisation percentage to its tier name.
pub fn tier_for(util_pct: f64) -> &'static str {
    TIERS
        .iter()
        .find(|(limit, _)| util_pct < *limit)
        .map(|(_, name)| *name)
        .unwrap_or("Ultra")
}

/// Convert a per-monitor frame time into a utilisation percentage.
pub fn util_pct(frame_ms: f64, monitors: u32, fps: u32) -> f64 {
    let budget_ms = 1000.0 / f64::from(fps.max(1));
    frame_ms * f64::from(monitors.max(1)) / budget_ms * 100.0
}

pub fn run(
    args: &BenchArgs,
    shader_manager: &ShaderManager,
    palette_manager: &PaletteManager,
) -> anyhow::Result<()> {
    let shaders: Vec<String> = if args.shaders.is_empty() {
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
    if shaders.is_empty() {
        anyhow::bail!("no shaders to benchmark");
    }
    if args.sort != "cost" && args.sort != "name" {
        anyhow::bail!("--sort must be 'cost' or 'name'");
    }

    let (width, height) = crate::render_preview::parse_resolution(&args.resolution)?;
    let fps = args.fps.max(1);
    let frames = args.frames.max(1);
    let lut = palette_manager
        .get(&args.palette)
        .ok_or_else(|| anyhow::anyhow!("unknown palette '{}'", args.palette))?
        .to_lut();

    let (gl, _egl_ctx) =
        crate::headless_egl::init().context("failed to initialise headless EGL context")?;
    let renderer_name = unsafe { gl.get_parameter_string(glow::RENDERER) };
    let mut renderer = Renderer::new(gl).context("failed to create renderer")?;
    let fbo = OffscreenTarget::new(renderer.gl(), width, height);
    renderer
        .update_lut_a(&lut)
        .context("failed to upload palette LUT")?;
    renderer.set_blend(0.0);

    eprintln!(
        "bench: {renderer_name}; {width}x{height} × {} monitor(s) @ {fps} fps \
         (budget {:.2} ms); {frames} timed frames over {:.0} s of shader time \
         + {} warm-up per shader",
        args.monitors,
        1000.0 / f64::from(fps),
        args.span,
        args.warmup
    );

    let mut results: Vec<BenchResult> = Vec::with_capacity(shaders.len());
    let total = shaders.len();
    for (idx, name) in shaders.iter().enumerate() {
        eprint!("[{}/{}] {name:<14}", idx + 1, total);
        let _ = std::io::stderr().flush();

        let src = shader_manager
            .get(name)
            .map(|s| s.compiled.clone())
            .ok_or_else(|| anyhow::anyhow!("shader '{name}' not found"))?;
        if let Err(e) = renderer.load_shader(&src) {
            eprintln!(" compile FAILED: {e:#}");
            results.push(BenchResult {
                name: name.clone(),
                frame_ms: 0.0,
                util_pct: 0.0,
                tier: "n/a",
                error: Some(format!("{e:#}")),
            });
            continue;
        }

        // Frame f renders shader time f·step; the timed frames tile `span`.
        let step = args.span.max(0.001) / frames as f32;
        for f in 0..args.warmup {
            let t = (f % frames) as f32 * step;
            renderer.render_offscreen(fbo.fbo, [width, height], t, u64::from(f));
        }
        renderer.finish();

        let start = Instant::now();
        for f in 0..frames {
            let frame = u64::from(args.warmup + f);
            renderer.render_offscreen(fbo.fbo, [width, height], f as f32 * step, frame);
        }
        renderer.finish();
        let frame_ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(frames);

        let pct = util_pct(frame_ms, args.monitors, fps);
        let tier = tier_for(pct);
        eprintln!(" {frame_ms:7.2} ms  {pct:6.1}%  {tier}");
        results.push(BenchResult {
            name: name.clone(),
            frame_ms,
            util_pct: pct,
            tier,
            error: None,
        });
    }

    fbo.destroy(renderer.gl());
    renderer.destroy();

    match args.sort.as_str() {
        "name" => results.sort_by(|a, b| a.name.cmp(&b.name)),
        _ => results.sort_by(|a, b| {
            b.util_pct
                .partial_cmp(&a.util_pct)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.name.cmp(&b.name))
        }),
    }

    let mut out = std::io::stdout().lock();
    if args.markdown {
        writeln!(out, "| Shader | ms/frame | GPU % | Tier |")?;
        writeln!(out, "|--------|---------:|------:|------|")?;
        for r in &results {
            match &r.error {
                Some(e) => writeln!(out, "| {} | — | — | compile error: {} |", r.name, e)?,
                None => writeln!(
                    out,
                    "| {} | {:.2} | {:.0}% | {} |",
                    r.name, r.frame_ms, r.util_pct, r.tier
                )?,
            }
        }
    } else {
        writeln!(out, "shader          ms/frame    GPU%  tier")?;
        for r in &results {
            match &r.error {
                Some(e) => writeln!(
                    out,
                    "{:<14} {:>9} {:>7}  compile error: {e}",
                    r.name, "-", "-"
                )?,
                None => writeln!(
                    out,
                    "{:<14} {:>9.2} {:>6.1}%  {}",
                    r.name, r.frame_ms, r.util_pct, r.tier
                )?,
            }
        }
    }

    if let Some(path) = &args.json {
        let mut s = String::from("[\n");
        for (i, r) in results.iter().enumerate() {
            let err = match &r.error {
                Some(e) => format!("\"{}\"", e.replace('\\', "\\\\").replace('"', "\\\"")),
                None => "null".to_string(),
            };
            s.push_str(&format!(
                "  {{\"shader\": \"{}\", \"frame_ms\": {:.4}, \"util_pct\": {:.2}, \"tier\": \"{}\", \"error\": {}}}{}\n",
                r.name,
                r.frame_ms,
                r.util_pct,
                r.tier,
                err,
                if i + 1 < results.len() { "," } else { "" }
            ));
        }
        s.push_str("]\n");
        std::fs::write(path, s).with_context(|| format!("failed to write '{}'", path.display()))?;
        eprintln!("bench: wrote {}", path.display());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers_follow_backlog_thresholds() {
        assert_eq!(tier_for(0.0), "Lightweight");
        assert_eq!(tier_for(32.9), "Lightweight");
        assert_eq!(tier_for(33.0), "Medium");
        assert_eq!(tier_for(49.9), "Medium");
        assert_eq!(tier_for(50.0), "Heavy");
        assert_eq!(tier_for(65.9), "Heavy");
        assert_eq!(tier_for(66.0), "Ultra");
        assert_eq!(tier_for(250.0), "Ultra");
    }

    #[test]
    fn util_pct_scales_with_monitors_and_fps() {
        // 10 ms per frame, 2 monitors, 30 fps: 20 / 33.33 = 60 %
        let pct = util_pct(10.0, 2, 30);
        assert!((pct - 60.0).abs() < 0.01, "{pct}");
        // 1 monitor at 60 fps: 10 / 16.67 = 60 %
        let pct = util_pct(10.0, 1, 60);
        assert!((pct - 60.0).abs() < 0.01, "{pct}");
        // zero monitors / fps are clamped to 1
        assert!(util_pct(10.0, 0, 0) > 0.0);
    }
}
