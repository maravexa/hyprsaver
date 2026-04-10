//! `palette.rs` — Palette definitions, loading, and transition management.
//!
//! Three palette kinds are supported:
//! - **Cosine** (`Palette`): Inigo Quilez cosine gradient. Defined by four RGB vec3 params
//!   (a,b,c,d) and evaluated on the GPU via `palette(t)`. Zero texture overhead.
//! - **LUT**: A 256-sample RGB strip loaded from a PNG file. Uploaded as a 256×1 RGBA8
//!   `GL_TEXTURE_2D` and sampled in the fragment shader via `sampler2D u_lut_a/b`.
//! - **Gradient**: CSS-style stops interpolated at load time into a 256-sample LUT.
//!   Shares the LUT GPU upload path; stops are not stored at runtime.
//!
//! `PaletteManager` is a named registry that also owns cross-fade transition state
//! (current → next palette over a configurable duration). Call `advance_transition()`
//! every frame and forward the returned blend factor to the renderer.

use std::collections::HashMap;
use std::f32::consts::TAU;
use std::path::Path;
use std::time::Instant;

use serde::Deserialize;

// ---------------------------------------------------------------------------
// Cosine palette
// ---------------------------------------------------------------------------

/// A cosine gradient palette defined by four RGB parameter vectors.
///
/// The color at parameter `t ∈ [0, 1]` is:
/// ```text
///   color(t) = a + b * cos(2π * (c * t + d))
/// ```
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Palette {
    pub a: [f32; 3],
    pub b: [f32; 3],
    pub c: [f32; 3],
    pub d: [f32; 3],
}

impl Palette {
    /// Evaluate the cosine gradient at `t`, returning `[r, g, b]` in `[0, 1]`.
    pub fn color_at(&self, t: f32) -> [f32; 3] {
        let r = self.a[0] + self.b[0] * (TAU * (self.c[0] * t + self.d[0])).cos();
        let g = self.a[1] + self.b[1] * (TAU * (self.c[1] * t + self.d[1])).cos();
        let b = self.a[2] + self.b[2] * (TAU * (self.c[2] * t + self.d[2])).cos();
        [r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b.clamp(0.0, 1.0)]
    }

    /// Pre-compute 256 evenly-spaced samples as a LUT.
    pub fn to_lut(&self) -> Vec<[f32; 3]> {
        (0..256).map(|i| self.color_at(i as f32 / 255.0)).collect()
    }
}

impl Default for Palette {
    fn default() -> Self {
        Palette {
            a: [0.5, 0.5, 0.5],
            b: [0.5, 0.5, 0.5],
            c: [1.0, 1.0, 1.0],
            d: [0.00, 0.33, 0.67],
        }
    }
}

// ---------------------------------------------------------------------------
// PaletteEntry — unified runtime palette representation
// ---------------------------------------------------------------------------

/// A resolved palette that the renderer can consume.
///
/// Both variants ultimately produce RGB colors in `[0, 1]`.
#[derive(Debug, Clone)]
pub enum PaletteEntry {
    /// Cosine gradient — uploaded as four vec3 uniforms, evaluated on the GPU.
    Cosine(Palette),
    /// 256-sample LUT — uploaded as a 256×1 RGBA8 texture and sampled in GLSL.
    Lut(Vec<[f32; 3]>),
}

impl Default for PaletteEntry {
    fn default() -> Self {
        PaletteEntry::Cosine(Palette::default())
    }
}

impl PaletteEntry {
    /// Return a 256-sample LUT regardless of the internal kind.
    /// Used when the renderer needs a homogeneous LUT for cross-fading.
    pub fn to_lut(&self) -> Vec<[f32; 3]> {
        match self {
            PaletteEntry::Cosine(p) => p.to_lut(),
            PaletteEntry::Lut(v) => v.clone(),
        }
    }

    /// Linearly interpolate between two palettes at parameter `t ∈ [0, 1]`.
    ///
    /// - **Cosine → Cosine**: interpolates all 12 cosine params (a, b, c, d)
    ///   component-wise and returns a [`PaletteEntry::Cosine`]. At `t = 0.0`
    ///   the result equals `from`; at `t = 1.0` it equals `to`.
    /// - **LUT → LUT**: interpolates the 256 RGB samples linearly and returns
    ///   a [`PaletteEntry::Lut`]. Per-channel clamped to `[0, 1]`.
    /// - **Mixed (Cosine ↔ LUT)**: resolves the cosine side to 256 samples via
    ///   [`PaletteEntry::to_lut`] first, then performs LUT-to-LUT interpolation.
    ///
    /// `t` is clamped to `[0, 1]`. This is a pure function — neither input is
    /// mutated. Produces no NaN for finite inputs, and the returned RGB values
    /// are in `[0, 1]` for both variants (cosine output is clamped inside
    /// [`Palette::color_at`] during sampling).
    pub fn interpolate(from: &PaletteEntry, to: &PaletteEntry, t: f32) -> PaletteEntry {
        let t = t.clamp(0.0, 1.0);
        match (from, to) {
            (PaletteEntry::Cosine(a), PaletteEntry::Cosine(b)) => {
                let lerp3 = |x: [f32; 3], y: [f32; 3]| -> [f32; 3] {
                    [
                        x[0] * (1.0 - t) + y[0] * t,
                        x[1] * (1.0 - t) + y[1] * t,
                        x[2] * (1.0 - t) + y[2] * t,
                    ]
                };
                PaletteEntry::Cosine(Palette {
                    a: lerp3(a.a, b.a),
                    b: lerp3(a.b, b.b),
                    c: lerp3(a.c, b.c),
                    d: lerp3(a.d, b.d),
                })
            }
            _ => {
                // LUT↔LUT or mixed: resolve both to 256 samples then lerp.
                let lut_a = from.to_lut();
                let lut_b = to.to_lut();
                let blended: Vec<[f32; 3]> = lut_a
                    .iter()
                    .zip(lut_b.iter())
                    .map(|(sa, sb)| {
                        [
                            (sa[0] * (1.0 - t) + sb[0] * t).clamp(0.0, 1.0),
                            (sa[1] * (1.0 - t) + sb[1] * t).clamp(0.0, 1.0),
                            (sa[2] * (1.0 - t) + sb[2] * t).clamp(0.0, 1.0),
                        ]
                    })
                    .collect();
                PaletteEntry::Lut(blended)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Gradient stops
// ---------------------------------------------------------------------------

/// A single CSS-style gradient stop.
pub struct GradientStop {
    /// Position in `[0.0, 1.0]`.
    pub position: f32,
    /// Linear RGB color in `[0.0, 1.0]` per channel.
    pub color: [f32; 3],
}

/// Parse a `#RRGGBB` hex color string into `[r, g, b]` in `[0.0, 1.0]`.
///
/// Returns an error on invalid input (wrong length, bad hex digits, missing `#`).
pub fn parse_hex_color(s: &str) -> anyhow::Result<[f32; 3]> {
    let s = s.trim();
    anyhow::ensure!(
        s.starts_with('#') && s.len() == 7,
        "color must be #RRGGBB, got {:?}",
        s
    );
    let r = u8::from_str_radix(&s[1..3], 16)
        .map_err(|_| anyhow::anyhow!("invalid red component in {:?}", s))?;
    let g = u8::from_str_radix(&s[3..5], 16)
        .map_err(|_| anyhow::anyhow!("invalid green component in {:?}", s))?;
    let b = u8::from_str_radix(&s[5..7], 16)
        .map_err(|_| anyhow::anyhow!("invalid blue component in {:?}", s))?;
    Ok([r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0])
}

/// Interpolate a set of gradient stops into exactly 256 RGB samples.
///
/// Validation rules (returns `Err` on failure):
/// - At least 2 stops.
/// - All positions in `[0.0, 1.0]`.
/// - Positions strictly ascending.
pub fn gradient_to_lut(stops: &[GradientStop]) -> anyhow::Result<Vec<[f32; 3]>> {
    anyhow::ensure!(stops.len() >= 2, "gradient must have at least 2 stops");

    for (i, s) in stops.iter().enumerate() {
        anyhow::ensure!(
            (0.0..=1.0).contains(&s.position),
            "stop[{i}] position {} is outside [0, 1]",
            s.position
        );
    }
    for pair in stops.windows(2) {
        anyhow::ensure!(
            pair[0].position < pair[1].position,
            "stop positions must be strictly ascending: {} >= {}",
            pair[0].position,
            pair[1].position
        );
    }

    let mut out = Vec::with_capacity(256);
    for i in 0u32..256 {
        let t = i as f32 / 255.0;
        // Find the surrounding pair of stops.
        let (lo, hi) = match stops.windows(2).find(|w| t <= w[1].position) {
            Some(w) => (&w[0], &w[1]),
            None => {
                // t is beyond the last stop — clamp to last color.
                let last = stops.last().unwrap();
                out.push(last.color);
                continue;
            }
        };
        let span = hi.position - lo.position;
        let frac = if span > 0.0 {
            (t - lo.position) / span
        } else {
            0.0
        };
        out.push([
            lo.color[0] + (hi.color[0] - lo.color[0]) * frac,
            lo.color[1] + (hi.color[1] - lo.color[1]) * frac,
            lo.color[2] + (hi.color[2] - lo.color[2]) * frac,
        ]);
    }
    Ok(out)
}

/// Load a PNG file and resample it to exactly 256 RGB samples.
///
/// Expects a horizontal strip (any width ≥ 1, height ≥ 1). Row 0 is used.
/// Each sample is linearly interpolated from the source pixels.
pub fn load_lut_from_png(path: &Path) -> anyhow::Result<Vec<[f32; 3]>> {
    use anyhow::Context as _;
    let img = image::open(path)
        .with_context(|| format!("failed to open LUT PNG: {}", path.display()))?
        .into_rgb8();

    let (src_w, _src_h) = img.dimensions();
    anyhow::ensure!(src_w >= 1, "LUT PNG must have at least 1 pixel wide");

    // Sample row 0, resampling to exactly 256 entries via linear interpolation.
    let mut out = Vec::with_capacity(256);
    for i in 0u32..256 {
        // Map sample index into source pixel space.
        let src_x = i as f32 * (src_w - 1) as f32 / 255.0;
        let x0 = src_x.floor() as u32;
        let x1 = (x0 + 1).min(src_w - 1);
        let frac = src_x - x0 as f32;

        let p0 = img.get_pixel(x0, 0);
        let p1 = img.get_pixel(x1, 0);

        out.push([
            (p0[0] as f32 / 255.0) * (1.0 - frac) + (p1[0] as f32 / 255.0) * frac,
            (p0[1] as f32 / 255.0) * (1.0 - frac) + (p1[1] as f32 / 255.0) * frac,
            (p0[2] as f32 / 255.0) * (1.0 - frac) + (p1[2] as f32 / 255.0) * frac,
        ]);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Built-in palettes
// ---------------------------------------------------------------------------

/// Returns a map of all built-in cosine palettes by name.
pub fn builtin_palettes() -> HashMap<String, Palette> {
    let mut map = HashMap::new();
    map.insert(
        "electric".into(),
        Palette {
            a: [0.5, 0.5, 0.5],
            b: [0.5, 0.5, 0.5],
            c: [1.0, 1.0, 1.0],
            d: [0.00, 0.33, 0.67],
        },
    );
    map.insert(
        "autumn".into(),
        Palette {
            a: [0.65, 0.3, 0.1],
            b: [0.4, 0.3, 0.1],
            c: [1.0, 1.0, 1.0],
            d: [0.0, 0.1, 0.2],
        },
    );
    map.insert(
        "groovy".into(),
        Palette {
            a: [0.8, 0.5, 0.4],
            b: [0.2, 0.4, 0.2],
            c: [2.0, 1.0, 1.0],
            d: [0.00, 0.25, 0.50],
        },
    );
    map.insert(
        "frost".into(),
        Palette {
            a: [0.6, 0.7, 0.9],
            b: [0.2, 0.2, 0.1],
            c: [1.0, 1.0, 0.5],
            d: [0.00, 0.05, 0.15],
        },
    );
    map.insert(
        "ember".into(),
        Palette {
            a: [0.97, 0.30, 0.05],
            b: [0.33, 0.35, 0.05],
            c: [1.0, 1.0, 1.0],
            d: [0.0, 0.08, 0.1],
        },
    );
    map.insert(
        "ocean".into(),
        Palette {
            a: [0.2, 0.5, 0.6],
            b: [0.2, 0.3, 0.3],
            c: [1.0, 1.0, 0.8],
            d: [0.30, 0.20, 0.10],
        },
    );
    map.insert(
        "vapor".into(),
        Palette {
            a: [0.55, 0.22, 0.65],
            b: [0.45, 0.30, 0.35],
            c: [1.0, 1.0, 1.0],
            d: [0.0, 0.50, 0.45],
        },
    );
    map.insert(
        "forest".into(),
        Palette {
            a: [0.25, 0.50, 0.12],
            b: [0.15, 0.25, 0.05],
            c: [1.0, 1.0, 1.5],
            d: [0.15, 0.0, 0.2],
        },
    );
    map.insert(
        "monochrome".into(),
        Palette {
            a: [0.5, 0.5, 0.5],
            b: [0.5, 0.5, 0.5],
            c: [1.0, 1.0, 1.0],
            d: [0.00, 0.00, 0.00],
        },
    );
    map
}

/// Build the three built-in gradient/LUT palettes: "sunset", "aurora", "midnight".
pub fn builtin_gradient_palettes() -> Vec<(String, PaletteEntry)> {
    let sunset = gradient_to_lut(&[
        GradientStop {
            position: 0.0,
            color: [0.051, 0.008, 0.129],
        }, // #0d0221
        GradientStop {
            position: 0.3,
            color: [1.000, 0.420, 0.208],
        }, // #ff6b35
        GradientStop {
            position: 0.7,
            color: [0.969, 0.773, 0.624],
        }, // #f7c59f
        GradientStop {
            position: 1.0,
            color: [0.937, 0.937, 0.816],
        }, // #efefd0
    ])
    .unwrap_or_default();

    let aurora = gradient_to_lut(&[
        GradientStop {
            position: 0.0,
            color: [0.012, 0.024, 0.157],
        }, // #030640
        GradientStop {
            position: 0.3,
            color: [0.000, 0.690, 0.502],
        }, // #00b080
        GradientStop {
            position: 0.6,
            color: [0.220, 0.918, 0.690],
        }, // #38eab0
        GradientStop {
            position: 0.8,
            color: [0.639, 0.384, 0.933],
        }, // #a362ee
        GradientStop {
            position: 1.0,
            color: [0.102, 0.008, 0.220],
        }, // #1a0238
    ])
    .unwrap_or_default();

    let midnight = gradient_to_lut(&[
        GradientStop {
            position: 0.0,
            color: [0.004, 0.004, 0.020],
        }, // #010105
        GradientStop {
            position: 0.4,
            color: [0.020, 0.047, 0.271],
        }, // #050c45
        GradientStop {
            position: 0.7,
            color: [0.098, 0.165, 0.588],
        }, // #192a96
        GradientStop {
            position: 1.0,
            color: [0.431, 0.604, 0.961],
        }, // #6e9af5
    ])
    .unwrap_or_default();

    vec![
        ("sunset".into(), PaletteEntry::Lut(sunset)),
        ("aurora".into(), PaletteEntry::Lut(aurora)),
        ("midnight".into(), PaletteEntry::Lut(midnight)),
    ]
}

// ---------------------------------------------------------------------------
// PaletteManager
// ---------------------------------------------------------------------------

/// Manages named palettes (built-ins + user-defined) and cross-fade transitions.
///
/// Transition lifecycle (two equivalent APIs):
///
/// **GPU-blended path** (used by the main render loop):
/// 1. Call [`Self::begin_transition`] or [`Self::transition_to`] when the
///    active palette should change.
/// 2. Call [`Self::advance_transition`] every frame; it returns the blend
///    factor in `[0.0, 1.0]` which is forwarded to the shader's
///    `u_palette_blend` uniform. Palette A and palette B are uploaded
///    separately and the shader mixes on-GPU.
/// 3. When `advance_transition` returns `1.0` the transition is complete;
///    subsequent calls return `0.0` (no blend) until the next transition.
///
/// **CPU-interpolated path** (useful for tests and pre-blended uploads):
/// 1. Call [`Self::transition_to`] with an explicit per-call duration.
/// 2. Call [`Self::tick`] once per frame; it returns `true` while the
///    transition is in progress.
/// 3. Call [`Self::interpolated_palette`] each frame to get the current
///    single, pre-blended [`PaletteEntry`] ready for upload.
pub struct PaletteManager {
    palettes: HashMap<String, PaletteEntry>,
    /// Default duration of the crossfade, in seconds. `0.0` means instant snap.
    /// Used by [`PaletteManager::begin_transition`]; can be overridden per call
    /// via [`PaletteManager::transition_to`].
    pub transition_duration: f32,
    /// Duration of the currently active transition, in seconds. Set by
    /// [`PaletteManager::transition_to`]; falls back to `transition_duration`
    /// when `None`.
    active_duration: Option<f32>,
    /// Name of the currently displayed palette.
    current_name: String,
    /// Name of the palette being transitioned to (`None` when idle).
    next_name: Option<String>,
    /// Wall-clock time when the current transition started.
    transition_start: Option<Instant>,
    /// Current position in the cycle. Advances on each `cycle_next()` call.
    cycle_index: usize,
    /// If `Some`, `cycle_next()` iterates only these names (in order).
    /// If `None`, iterates all palettes sorted by name.
    cycle_playlist: Option<Vec<String>>,
}

impl PaletteManager {
    /// Create a new manager.
    ///
    /// - `custom_cosine`: user-defined cosine palettes from `[palettes.*]` TOML.
    /// - `extra_entries`: additional LUT/gradient entries resolved by the caller.
    /// - `transition_duration`: crossfade time in seconds (`0.0` = snap).
    /// - `initial_palette`: the name to treat as the active palette on start.
    pub fn new(
        custom_cosine: HashMap<String, Palette>,
        extra_entries: Vec<(String, PaletteEntry)>,
        transition_duration: f32,
        initial_palette: &str,
    ) -> Self {
        let mut palettes: HashMap<String, PaletteEntry> = builtin_palettes()
            .into_iter()
            .map(|(k, v)| (k, PaletteEntry::Cosine(v)))
            .collect();

        // Merge built-in gradient palettes.
        for (name, entry) in builtin_gradient_palettes() {
            palettes.insert(name, entry);
        }

        // Merge user cosine palettes (override built-ins on collision).
        for (k, v) in custom_cosine {
            palettes.insert(k, PaletteEntry::Cosine(v));
        }

        // Merge extra LUT/gradient entries.
        for (k, v) in extra_entries {
            palettes.insert(k, v);
        }

        // Resolve the initial name.
        let current_name = if palettes.contains_key(initial_palette) {
            initial_palette.to_string()
        } else {
            "electric".to_string()
        };

        Self {
            palettes,
            transition_duration,
            active_duration: None,
            current_name,
            next_name: None,
            transition_start: None,
            cycle_index: 0,
            cycle_playlist: None,
        }
    }

    /// Look up a palette entry by name.
    pub fn get(&self, name: &str) -> Option<&PaletteEntry> {
        self.palettes.get(name)
    }

    /// Return a sorted list of all known palette names.
    pub fn list(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.palettes.keys().map(String::as_str).collect();
        names.sort_unstable();
        names
    }

    /// Insert or replace a cosine palette at runtime.
    ///
    /// Used by the preview-mode palette editor so that a palette saved from
    /// the UI becomes immediately available for selection in the current
    /// session without requiring a restart.
    pub fn insert_cosine(&mut self, name: String, palette: Palette) {
        self.palettes.insert(name, PaletteEntry::Cosine(palette));
    }

    /// Return the effective cycle playlist as an owned `Vec<String>`.
    ///
    /// If a playlist was set via [`set_playlist`], returns that list.
    /// Otherwise returns all known palette names sorted alphabetically.
    pub fn effective_playlist(&self) -> Vec<String> {
        if let Some(ref pl) = self.cycle_playlist {
            pl.clone()
        } else {
            let mut names: Vec<String> = self.palettes.keys().cloned().collect();
            names.sort_unstable();
            names
        }
    }

    /// Return a random palette (current-time subsecond-nanos mod count).
    pub fn random(&self) -> (&str, &PaletteEntry) {
        let idx = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos() as usize
            % self.palettes.len();
        let (name, entry) = self
            .palettes
            .iter()
            .nth(idx)
            .expect("palette map non-empty");
        (name.as_str(), entry)
    }

    /// The name of the currently active palette (palette A during a transition).
    pub fn current_name(&self) -> &str {
        &self.current_name
    }

    /// The `PaletteEntry` for the current palette (palette A).
    pub fn current_palette(&self) -> Option<&PaletteEntry> {
        self.palettes.get(&self.current_name)
    }

    /// The `PaletteEntry` for the next palette (palette B), or `None` when idle.
    pub fn next_palette(&self) -> Option<&PaletteEntry> {
        self.next_name.as_deref().and_then(|n| self.palettes.get(n))
    }

    /// Initiate a crossfade to the palette named `to_name`, using the
    /// manager's default [`PaletteManager::transition_duration`] field.
    ///
    /// If `transition_duration == 0.0` the swap is instant (no blend).
    /// If `to_name` is unknown, does nothing.
    pub fn begin_transition(&mut self, to_name: &str, now: Instant) {
        if !self.palettes.contains_key(to_name) {
            log::warn!("begin_transition: unknown palette '{to_name}'");
            return;
        }
        // Clear any per-call override so the default duration takes effect.
        self.active_duration = None;
        if self.transition_duration <= 0.0 {
            // Instant swap.
            self.current_name = to_name.to_string();
            self.next_name = None;
            self.transition_start = None;
        } else {
            self.next_name = Some(to_name.to_string());
            self.transition_start = Some(now);
        }
    }

    /// Initiate a crossfade to the palette named `to_name` with an explicit
    /// per-call `duration` in seconds.
    ///
    /// This overrides the default [`PaletteManager::transition_duration`] for
    /// just the current transition. Useful when the cycle engine wants a
    /// palette-specific fade length (e.g. a longer blend on shader change).
    ///
    /// If `duration <= 0.0` the swap is instant (no blend).
    /// If `to_name` is unknown, does nothing and logs a warning.
    ///
    /// After calling this, poll the transition each frame with [`Self::tick`]
    /// and sample the current blended palette with [`Self::interpolated_palette`].
    pub fn transition_to(&mut self, to_name: &str, duration: f32, now: Instant) {
        if !self.palettes.contains_key(to_name) {
            log::warn!("transition_to: unknown palette '{to_name}'");
            return;
        }
        if duration <= 0.0 {
            // Instant swap.
            self.current_name = to_name.to_string();
            self.next_name = None;
            self.transition_start = None;
            self.active_duration = None;
        } else {
            self.next_name = Some(to_name.to_string());
            self.transition_start = Some(now);
            self.active_duration = Some(duration);
        }
    }

    /// Returns `true` if a crossfade is currently in progress (i.e. a target
    /// palette is pending and the transition clock has not yet expired).
    ///
    /// Does not advance the clock — prefer [`Self::tick`] inside the render
    /// loop when you also want the clock to tick.
    pub fn is_transitioning(&self) -> bool {
        self.transition_start.is_some() && self.next_name.is_some()
    }

    /// Advance the transition clock and return whether a transition is still
    /// in progress.
    ///
    /// Returns:
    /// - `true` while a crossfade is active (`0.0 ≤ blend < 1.0`).
    /// - `false` when idle, or on the frame the transition just completed —
    ///   in which case the target palette has been promoted to current and
    ///   [`Self::interpolated_palette`] will return the target from now on.
    ///
    /// This is a thin wrapper over [`Self::advance_transition`] that exposes
    /// progress as a bool; call it once per frame.
    pub fn tick(&mut self, now: Instant) -> bool {
        self.advance_transition(now);
        self.is_transitioning()
    }

    /// Return the current interpolated palette for wall-clock `now`, or the
    /// active palette if no transition is in progress.
    ///
    /// During a transition this performs CPU-side linear interpolation:
    /// - **Cosine → Cosine**: 12 cosine params blended component-wise; returns
    ///   a [`PaletteEntry::Cosine`].
    /// - **LUT → LUT** or **mixed**: both sides resolved to 256-sample LUTs,
    ///   blended per-sample; returns a [`PaletteEntry::Lut`].
    ///
    /// Does not mutate the transition clock — call [`Self::tick`] for that.
    /// Returns `None` only if the current palette name is not registered
    /// (should not happen in normal use).
    pub fn interpolated_palette(&self, now: Instant) -> Option<PaletteEntry> {
        let current = self.current_palette()?;
        let (Some(start), Some(next)) = (self.transition_start, self.next_palette()) else {
            return Some(current.clone());
        };
        let duration = self.active_duration.unwrap_or(self.transition_duration);
        let t = if duration > 0.0 {
            (now.duration_since(start).as_secs_f32() / duration).clamp(0.0, 1.0)
        } else {
            1.0
        };
        Some(PaletteEntry::interpolate(current, next, t))
    }

    /// Advance the palette cycle index and return the name of the next palette.
    ///
    /// If a playlist is set, iterates only playlist items in definition order.
    /// Otherwise iterates all available palettes alphabetically.
    /// Wraps around when it reaches the end. Returns `None` if there are no palettes.
    ///
    /// Call `get()` with the returned name to access the palette entry.
    pub fn cycle_next(&mut self) -> Option<String> {
        let names: Vec<String> = match &self.cycle_playlist {
            Some(pl) => pl
                .iter()
                .filter(|n| self.palettes.contains_key(*n))
                .cloned()
                .collect(),
            None => {
                let mut ns: Vec<String> = self.palettes.keys().cloned().collect();
                ns.sort_unstable();
                ns
            }
        };
        if names.is_empty() {
            return None;
        }
        self.cycle_index = self.cycle_index.wrapping_add(1) % names.len();
        Some(names[self.cycle_index].clone())
    }

    /// Return the name of the palette at the current cycle index, without advancing.
    ///
    /// Uses the playlist if set, otherwise all palettes alphabetically.
    /// Returns `None` if the collection is empty.
    pub fn current_cycle_name(&self) -> Option<&str> {
        let names: Vec<&str> = match &self.cycle_playlist {
            Some(pl) => pl
                .iter()
                .filter(|n| self.palettes.contains_key(*n))
                .map(String::as_str)
                .collect(),
            None => {
                let mut ns: Vec<&str> = self.palettes.keys().map(String::as_str).collect();
                ns.sort_unstable();
                ns
            }
        };
        if names.is_empty() {
            return None;
        }
        Some(names[self.cycle_index % names.len()])
    }

    /// Set a playlist so that `cycle_next()` iterates only the given names.
    /// Pass an empty vec to reset to "cycle all".
    /// Always resets `cycle_index` to 0; call `randomize_cycle_start()` afterward
    /// if a random starting position is desired (e.g. at screensaver startup).
    pub fn set_playlist(&mut self, names: Vec<String>) {
        if names.is_empty() {
            self.cycle_playlist = None;
        } else {
            self.cycle_playlist = Some(names);
        }
        self.cycle_index = 0;
    }

    /// Randomize the starting cycle index within the current playlist (or all palettes
    /// if no playlist is set). Call this once at screensaver startup so every session
    /// begins at a different point in the rotation.
    pub fn randomize_cycle_start(&mut self) {
        let count = match &self.cycle_playlist {
            Some(pl) => pl.iter().filter(|n| self.palettes.contains_key(*n)).count(),
            None => self.palettes.len(),
        };
        self.cycle_index = if count > 1 {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos() as usize
                % count
        } else {
            0
        };
    }

    /// Advance the transition and return the current blend factor in `[0.0, 1.0]`.
    ///
    /// - Returns `0.0` when no transition is active.
    /// - Promotes `next` → `current` and returns `0.0` once the blend reaches `1.0`.
    ///
    /// Uses the per-call duration set by [`Self::transition_to`] when present,
    /// otherwise the default [`Self::transition_duration`] field.
    pub fn advance_transition(&mut self, now: Instant) -> f32 {
        let (Some(start), Some(next_name)) = (self.transition_start, self.next_name.as_deref())
        else {
            return 0.0;
        };

        let duration = self.active_duration.unwrap_or(self.transition_duration);
        let elapsed = now.duration_since(start).as_secs_f32();
        let blend = if duration > 0.0 {
            (elapsed / duration).clamp(0.0, 1.0)
        } else {
            1.0
        };

        if blend >= 1.0 {
            // Transition complete: promote next → current.
            self.current_name = next_name.to_string();
            self.next_name = None;
            self.transition_start = None;
            self.active_duration = None;
            return 0.0;
        }

        blend
    }
}

impl Default for PaletteManager {
    fn default() -> Self {
        Self::new(HashMap::new(), Vec::new(), 0.0, "electric")
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn assert_approx(got: [f32; 3], want: [f32; 3], eps: f32) {
        for i in 0..3 {
            assert!(
                (got[i] - want[i]).abs() < eps,
                "channel {i}: got {}, want {} (eps {eps})",
                got[i],
                want[i]
            );
        }
    }

    fn electric() -> Palette {
        Palette {
            a: [0.5, 0.5, 0.5],
            b: [0.5, 0.5, 0.5],
            c: [1.0, 1.0, 1.0],
            d: [0.00, 0.33, 0.67],
        }
    }

    // --- Cosine palette ---

    #[test]
    fn test_palette_color_at_zero() {
        let p = electric();
        let got = p.color_at(0.0);
        let want = [
            (p.a[0] + p.b[0] * (TAU * p.d[0]).cos()).clamp(0.0, 1.0),
            (p.a[1] + p.b[1] * (TAU * p.d[1]).cos()).clamp(0.0, 1.0),
            (p.a[2] + p.b[2] * (TAU * p.d[2]).cos()).clamp(0.0, 1.0),
        ];
        assert_approx(got, want, 1e-5);
    }

    #[test]
    fn test_palette_color_at_one_matches_zero() {
        let p = electric();
        // c=[1,1,1]: t=1.0 and t=0.0 produce identical cosine values.
        assert_approx(p.color_at(1.0), p.color_at(0.0), 1e-5);
    }

    #[test]
    fn color_at_clamps_to_unit_range() {
        let extreme = Palette {
            a: [2.0, 2.0, 2.0],
            b: [2.0, 2.0, 2.0],
            c: [1.0, 1.0, 1.0],
            d: [0.0, 0.0, 0.0],
        };
        for i in 0..=100 {
            for ch in extreme.color_at(i as f32 / 100.0) {
                assert!((0.0..=1.0).contains(&ch), "channel out of range: {ch}");
            }
        }
    }

    #[test]
    fn test_builtin_cosine_count() {
        assert_eq!(builtin_palettes().len(), 9);
    }

    // --- Hex color parsing ---

    #[test]
    fn test_parse_hex_black() {
        assert_eq!(parse_hex_color("#000000").unwrap(), [0.0, 0.0, 0.0]);
    }

    #[test]
    fn test_parse_hex_white() {
        let c = parse_hex_color("#ffffff").unwrap();
        assert_approx(c, [1.0, 1.0, 1.0], 0.005);
    }

    #[test]
    fn test_parse_hex_red() {
        let c = parse_hex_color("#ff0000").unwrap();
        assert!(c[0] > 0.99 && c[1] < 0.01 && c[2] < 0.01);
    }

    #[test]
    fn test_parse_hex_invalid() {
        assert!(parse_hex_color("123456").is_err()); // missing #
        assert!(parse_hex_color("#1234").is_err()); // wrong length
        assert!(parse_hex_color("#gggggg").is_err()); // bad digits
    }

    // --- Gradient interpolation ---

    #[test]
    fn test_gradient_black_to_white_midpoint() {
        let stops = vec![
            GradientStop {
                position: 0.0,
                color: [0.0, 0.0, 0.0],
            },
            GradientStop {
                position: 1.0,
                color: [1.0, 1.0, 1.0],
            },
        ];
        let lut = gradient_to_lut(&stops).unwrap();
        assert_eq!(lut.len(), 256);
        // Sample 128 ≈ position 128/255 ≈ 0.502, so color ≈ [0.502, 0.502, 0.502].
        assert_approx(lut[128], [0.502, 0.502, 0.502], 0.01);
    }

    #[test]
    fn test_gradient_needs_at_least_two_stops() {
        let stops = vec![GradientStop {
            position: 0.0,
            color: [1.0, 0.0, 0.0],
        }];
        assert!(gradient_to_lut(&stops).is_err());
    }

    #[test]
    fn test_gradient_positions_must_ascend() {
        let stops = vec![
            GradientStop {
                position: 0.8,
                color: [0.0, 0.0, 0.0],
            },
            GradientStop {
                position: 0.2,
                color: [1.0, 1.0, 1.0],
            },
        ];
        assert!(gradient_to_lut(&stops).is_err());
    }

    #[test]
    fn test_gradient_position_out_of_range() {
        let stops = vec![
            GradientStop {
                position: 0.0,
                color: [0.0, 0.0, 0.0],
            },
            GradientStop {
                position: 1.5,
                color: [1.0, 1.0, 1.0],
            },
        ];
        assert!(gradient_to_lut(&stops).is_err());
    }

    // --- LUT PNG loading ---

    #[test]
    fn test_load_fire_lut() {
        let path = std::path::Path::new("examples/palettes/fire.png");
        if !path.exists() {
            // If the build script hasn't generated it yet, skip (don't fail CI).
            eprintln!("fire.png not found; skipping test");
            return;
        }
        let lut = load_lut_from_png(path).expect("fire.png must load");
        assert_eq!(lut.len(), 256, "LUT must have exactly 256 samples");

        // First sample (near-black) must be non-zero (has some red component).
        let first = lut[0];
        assert!(
            first[0] > 0.0 || first[1] > 0.0 || first[2] > 0.0,
            "first sample must be non-zero, got {:?}",
            first
        );

        // Last sample (near-white) must be non-zero.
        let last = lut[255];
        assert!(
            last[0] > 0.0 || last[1] > 0.0 || last[2] > 0.0,
            "last sample must be non-zero, got {:?}",
            last
        );
    }

    // --- Built-in gradient palettes ---

    #[test]
    fn test_builtin_gradients_present() {
        let entries = builtin_gradient_palettes();
        let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"sunset"));
        assert!(names.contains(&"aurora"));
        assert!(names.contains(&"midnight"));
    }

    #[test]
    fn test_builtin_gradients_have_256_samples() {
        for (name, entry) in builtin_gradient_palettes() {
            if let PaletteEntry::Lut(lut) = entry {
                assert_eq!(lut.len(), 256, "'{name}' must have 256 LUT samples");
            } else {
                panic!("built-in gradient '{name}' should be a Lut variant");
            }
        }
    }

    // --- PaletteManager ---

    #[test]
    fn test_manager_list_sorted() {
        let mgr = PaletteManager::default();
        let names = mgr.list();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted, "list() must be alphabetically sorted");
    }

    #[test]
    fn test_manager_custom_cosine_override() {
        let mut custom = HashMap::new();
        let custom_electric = Palette {
            a: [0.1, 0.2, 0.3],
            b: [0.4, 0.5, 0.6],
            c: [0.7, 0.8, 0.9],
            d: [0.0, 0.1, 0.2],
        };
        custom.insert("electric".to_string(), custom_electric.clone());
        let mgr = PaletteManager::new(custom, Vec::new(), 0.0, "electric");
        match mgr.get("electric").unwrap() {
            PaletteEntry::Cosine(p) => assert_eq!(p.a, custom_electric.a),
            _ => panic!("expected Cosine"),
        }
    }

    #[test]
    fn test_manager_includes_builtin_gradients() {
        let mgr = PaletteManager::default();
        assert!(mgr.get("sunset").is_some(), "sunset must be registered");
        assert!(mgr.get("aurora").is_some(), "aurora must be registered");
        assert!(mgr.get("midnight").is_some(), "midnight must be registered");
    }

    #[test]
    fn test_transition_instant_snap() {
        let mut mgr = PaletteManager::new(HashMap::new(), Vec::new(), 0.0, "electric");
        let now = Instant::now();
        mgr.begin_transition("frost", now);
        assert_eq!(mgr.current_name(), "frost");
        assert_eq!(mgr.advance_transition(now), 0.0);
    }

    #[test]
    fn test_transition_blend_advances() {
        let mut mgr = PaletteManager::new(HashMap::new(), Vec::new(), 2.0, "electric");
        let t0 = Instant::now();
        mgr.begin_transition("frost", t0);
        // At 1 second into a 2-second transition, blend ≈ 0.5.
        let t1 = t0 + std::time::Duration::from_secs(1);
        let blend = mgr.advance_transition(t1);
        assert!(
            (blend - 0.5).abs() < 0.01,
            "blend at 1s / 2s should be ~0.5, got {blend}"
        );
    }

    #[test]
    fn test_transition_completes() {
        let mut mgr = PaletteManager::new(HashMap::new(), Vec::new(), 1.0, "electric");
        let t0 = Instant::now();
        mgr.begin_transition("frost", t0);
        // After the duration elapses the transition should complete.
        let t1 = t0 + std::time::Duration::from_secs(2);
        let blend = mgr.advance_transition(t1);
        assert_eq!(blend, 0.0, "completed transition should return 0.0");
        assert_eq!(
            mgr.current_name(),
            "frost",
            "current should have advanced to frost"
        );
        assert!(
            mgr.next_palette().is_none(),
            "next should be None after completion"
        );
    }

    // --- transition_to / tick / interpolated_palette ---

    /// Helper: assert a 3-channel color has no NaN and is in [0, 1].
    fn assert_valid_rgb(c: [f32; 3], ctx: &str) {
        for (i, ch) in c.iter().enumerate() {
            assert!(!ch.is_nan(), "{ctx}: channel {i} is NaN");
            assert!(
                (0.0..=1.0).contains(ch),
                "{ctx}: channel {i} out of range: {ch}"
            );
        }
    }

    #[test]
    fn test_tick_returns_false_when_idle() {
        let mut mgr = PaletteManager::new(HashMap::new(), Vec::new(), 1.0, "electric");
        assert!(!mgr.tick(Instant::now()));
        assert!(!mgr.is_transitioning());
    }

    #[test]
    fn test_transition_to_drives_tick_true_then_false() {
        let mut mgr = PaletteManager::new(HashMap::new(), Vec::new(), 0.0, "electric");
        let t0 = Instant::now();
        mgr.transition_to("ember", 1.0, t0);
        assert!(
            mgr.is_transitioning(),
            "should be transitioning immediately"
        );
        // Mid-transition: tick returns true.
        assert!(mgr.tick(t0 + Duration::from_millis(500)));
        // After duration: tick returns false and target is promoted to current.
        assert!(!mgr.tick(t0 + Duration::from_secs(2)));
        assert_eq!(mgr.current_name(), "ember");
    }

    #[test]
    fn test_transition_to_cosine_to_cosine() {
        // Cosine → Cosine: electric → ember.
        let mut mgr = PaletteManager::new(HashMap::new(), Vec::new(), 0.0, "electric");
        let t0 = Instant::now();
        mgr.transition_to("ember", 1.0, t0);

        // Source palette (electric) and target palette (ember), as snapshots.
        let source = match mgr.get("electric").expect("electric exists") {
            PaletteEntry::Cosine(p) => p.clone(),
            _ => panic!("electric must be cosine"),
        };
        let target = match mgr.get("ember").expect("ember exists") {
            PaletteEntry::Cosine(p) => p.clone(),
            _ => panic!("ember must be cosine"),
        };

        // --- t = 0.0: must match source. ---
        let start = mgr.interpolated_palette(t0).expect("must have palette");
        let start_pal = match &start {
            PaletteEntry::Cosine(p) => p,
            _ => panic!("cosine→cosine must stay Cosine"),
        };
        for i in 0..=16 {
            let ti = i as f32 / 16.0;
            let got = start_pal.color_at(ti);
            let want = source.color_at(ti);
            assert_approx(got, want, 1e-5);
            assert_valid_rgb(got, "cosine→cosine t=0");
        }

        // --- t = 1.0: must match target. ---
        let end = mgr
            .interpolated_palette(t0 + Duration::from_secs(1))
            .expect("must have palette");
        let end_pal = match &end {
            PaletteEntry::Cosine(p) => p,
            _ => panic!("cosine→cosine must stay Cosine"),
        };
        for i in 0..=16 {
            let ti = i as f32 / 16.0;
            let got = end_pal.color_at(ti);
            let want = target.color_at(ti);
            assert_approx(got, want, 1e-5);
            assert_valid_rgb(got, "cosine→cosine t=1");
        }

        // --- t = 0.5: plausible midpoint, no NaN, all in range. ---
        let mid = mgr
            .interpolated_palette(t0 + Duration::from_millis(500))
            .expect("must have palette");
        let mid_pal = match &mid {
            PaletteEntry::Cosine(p) => p,
            _ => panic!("cosine→cosine must stay Cosine"),
        };
        // Verify that mid params are the exact linear blend of source and target.
        for i in 0..3 {
            let expected_a = source.a[i] * 0.5 + target.a[i] * 0.5;
            let expected_b = source.b[i] * 0.5 + target.b[i] * 0.5;
            let expected_c = source.c[i] * 0.5 + target.c[i] * 0.5;
            let expected_d = source.d[i] * 0.5 + target.d[i] * 0.5;
            assert!((mid_pal.a[i] - expected_a).abs() < 1e-5);
            assert!((mid_pal.b[i] - expected_b).abs() < 1e-5);
            assert!((mid_pal.c[i] - expected_c).abs() < 1e-5);
            assert!((mid_pal.d[i] - expected_d).abs() < 1e-5);
        }
        // Sample colors should be finite and in-range.
        for i in 0..=16 {
            let ti = i as f32 / 16.0;
            assert_valid_rgb(mid_pal.color_at(ti), "cosine→cosine t=0.5");
        }
    }

    #[test]
    fn test_transition_to_lut_to_lut() {
        // LUT → LUT: sunset → aurora (both are built-in gradient LUTs).
        let mut mgr = PaletteManager::new(HashMap::new(), Vec::new(), 0.0, "sunset");
        let t0 = Instant::now();
        mgr.transition_to("aurora", 2.0, t0);

        let source_lut = match mgr.get("sunset").expect("sunset exists") {
            PaletteEntry::Lut(v) => v.clone(),
            _ => panic!("sunset must be LUT"),
        };
        let target_lut = match mgr.get("aurora").expect("aurora exists") {
            PaletteEntry::Lut(v) => v.clone(),
            _ => panic!("aurora must be LUT"),
        };
        assert_eq!(source_lut.len(), 256);
        assert_eq!(target_lut.len(), 256);

        // --- t = 0.0 ---
        let start = mgr.interpolated_palette(t0).expect("must have palette");
        match &start {
            PaletteEntry::Lut(samples) => {
                assert_eq!(samples.len(), 256);
                for (i, (got, want)) in samples.iter().zip(source_lut.iter()).enumerate() {
                    assert_approx(*got, *want, 1e-5);
                    assert_valid_rgb(*got, &format!("LUT→LUT t=0 sample {i}"));
                }
            }
            _ => panic!("LUT→LUT must produce Lut"),
        }

        // --- t = 1.0 ---
        let end = mgr
            .interpolated_palette(t0 + Duration::from_secs(2))
            .expect("must have palette");
        match &end {
            PaletteEntry::Lut(samples) => {
                assert_eq!(samples.len(), 256);
                for (i, (got, want)) in samples.iter().zip(target_lut.iter()).enumerate() {
                    assert_approx(*got, *want, 1e-5);
                    assert_valid_rgb(*got, &format!("LUT→LUT t=1 sample {i}"));
                }
            }
            _ => panic!("LUT→LUT must produce Lut"),
        }

        // --- t = 0.5: plausible midpoint. ---
        let mid = mgr
            .interpolated_palette(t0 + Duration::from_secs(1))
            .expect("must have palette");
        match &mid {
            PaletteEntry::Lut(samples) => {
                assert_eq!(samples.len(), 256);
                for (i, got) in samples.iter().enumerate() {
                    let expected = [
                        (source_lut[i][0] * 0.5 + target_lut[i][0] * 0.5).clamp(0.0, 1.0),
                        (source_lut[i][1] * 0.5 + target_lut[i][1] * 0.5).clamp(0.0, 1.0),
                        (source_lut[i][2] * 0.5 + target_lut[i][2] * 0.5).clamp(0.0, 1.0),
                    ];
                    assert_approx(*got, expected, 1e-5);
                    assert_valid_rgb(*got, &format!("LUT→LUT t=0.5 sample {i}"));
                }
            }
            _ => panic!("LUT→LUT must produce Lut"),
        }
    }

    #[test]
    fn test_transition_to_cosine_to_lut() {
        // Mixed: cosine (electric) → LUT (sunset). Must resolve cosine to 256
        // samples first, then LUT-to-LUT interpolate.
        let mut mgr = PaletteManager::new(HashMap::new(), Vec::new(), 0.0, "electric");
        let t0 = Instant::now();
        mgr.transition_to("sunset", 1.0, t0);

        // Expected source samples = cosine resolved to LUT.
        let source_lut = match mgr.get("electric").expect("electric exists") {
            PaletteEntry::Cosine(p) => p.to_lut(),
            _ => panic!("electric must be cosine"),
        };
        let target_lut = match mgr.get("sunset").expect("sunset exists") {
            PaletteEntry::Lut(v) => v.clone(),
            _ => panic!("sunset must be LUT"),
        };

        // --- t = 0.0: must match source's LUT-resolved samples. ---
        let start = mgr.interpolated_palette(t0).expect("must have palette");
        match &start {
            PaletteEntry::Lut(samples) => {
                assert_eq!(samples.len(), 256);
                for (i, (got, want)) in samples.iter().zip(source_lut.iter()).enumerate() {
                    assert_approx(*got, *want, 1e-5);
                    assert_valid_rgb(*got, &format!("cosine→LUT t=0 sample {i}"));
                }
            }
            _ => panic!("mixed transition must produce Lut"),
        }

        // --- t = 1.0: must match target LUT. ---
        let end = mgr
            .interpolated_palette(t0 + Duration::from_secs(1))
            .expect("must have palette");
        match &end {
            PaletteEntry::Lut(samples) => {
                assert_eq!(samples.len(), 256);
                for (i, (got, want)) in samples.iter().zip(target_lut.iter()).enumerate() {
                    assert_approx(*got, *want, 1e-5);
                    assert_valid_rgb(*got, &format!("cosine→LUT t=1 sample {i}"));
                }
            }
            _ => panic!("mixed transition must produce Lut"),
        }

        // --- t = 0.5: plausible midpoint, no NaN, in [0, 1]. ---
        let mid = mgr
            .interpolated_palette(t0 + Duration::from_millis(500))
            .expect("must have palette");
        match &mid {
            PaletteEntry::Lut(samples) => {
                assert_eq!(samples.len(), 256);
                for (i, got) in samples.iter().enumerate() {
                    let expected = [
                        (source_lut[i][0] * 0.5 + target_lut[i][0] * 0.5).clamp(0.0, 1.0),
                        (source_lut[i][1] * 0.5 + target_lut[i][1] * 0.5).clamp(0.0, 1.0),
                        (source_lut[i][2] * 0.5 + target_lut[i][2] * 0.5).clamp(0.0, 1.0),
                    ];
                    assert_approx(*got, expected, 1e-5);
                    assert_valid_rgb(*got, &format!("cosine→LUT t=0.5 sample {i}"));
                }
            }
            _ => panic!("mixed transition must produce Lut"),
        }
    }

    #[test]
    fn test_transition_to_unknown_is_noop() {
        let mut mgr = PaletteManager::new(HashMap::new(), Vec::new(), 0.0, "electric");
        let t0 = Instant::now();
        mgr.transition_to("no_such_palette", 1.0, t0);
        assert!(!mgr.is_transitioning());
        assert_eq!(mgr.current_name(), "electric");
    }

    #[test]
    fn test_transition_to_zero_duration_snaps() {
        let mut mgr = PaletteManager::new(HashMap::new(), Vec::new(), 0.0, "electric");
        let t0 = Instant::now();
        mgr.transition_to("frost", 0.0, t0);
        assert!(!mgr.is_transitioning());
        assert_eq!(mgr.current_name(), "frost");
    }

    // --- cycle_next / set_playlist ---

    #[test]
    fn test_cycle_next_iterates_all_sorted() {
        let mut mgr = PaletteManager::default();
        let sorted = mgr.list().iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let n = sorted.len();
        let mut seen = Vec::new();
        for _ in 0..n {
            let name = mgr.cycle_next().expect("must return Some");
            seen.push(name);
        }
        let mut seen_sorted = seen.clone();
        seen_sorted.sort_unstable();
        assert_eq!(seen_sorted, sorted, "cycle_next must visit all palettes");
    }

    #[test]
    fn test_cycle_next_wraps_around() {
        let mut mgr = PaletteManager::default();
        let n = mgr.list().len();
        let first_name = mgr.cycle_next().expect("must return Some");
        for _ in 0..(n - 1) {
            mgr.cycle_next().expect("must return Some");
        }
        let after_full_rotation = mgr.cycle_next().expect("must return Some");
        assert_eq!(
            after_full_rotation, first_name,
            "cycle_next must wrap back after n calls"
        );
    }

    #[test]
    fn test_set_playlist_restricts_cycle() {
        let mut mgr = PaletteManager::default();
        // cycle_index starts at 0; first call increments to 1.
        // Playlist = ["electric", "frost"], so: call1→"frost", call2→"electric", call3→"frost".
        mgr.set_playlist(vec!["electric".to_string(), "frost".to_string()]);
        let name1 = mgr.cycle_next().expect("must return Some");
        let name2 = mgr.cycle_next().expect("must return Some");
        let name3 = mgr.cycle_next().expect("must return Some"); // wraps
        assert_eq!(name1, "frost");
        assert_eq!(name2, "electric");
        assert_eq!(name3, "frost", "must wrap around within playlist");
    }

    #[test]
    fn test_set_playlist_empty_resets_to_all() {
        let mut mgr = PaletteManager::default();
        mgr.set_playlist(vec!["electric".to_string()]);
        mgr.set_playlist(vec![]); // reset
        let n = mgr.list().len();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..n {
            let name = mgr.cycle_next().expect("must return Some");
            seen.insert(name);
        }
        assert_eq!(seen.len(), n, "after reset, all palettes should be visited");
    }

    #[test]
    fn test_random_selection_unchanged() {
        let mgr = PaletteManager::default();
        let (name, _entry) = mgr.random();
        assert!(
            mgr.get(name).is_some(),
            "random() must return a known palette"
        );
    }
}
