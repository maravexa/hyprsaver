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
/// Transition lifecycle:
/// 1. Call `begin_transition(name)` when the active palette should change.
/// 2. Call `advance_transition(now)` every frame; it returns the blend factor in `[0.0, 1.0]`.
/// 3. When `advance_transition` returns `1.0` the transition is complete; subsequent calls
///    return `0.0` (no blend) until the next `begin_transition`.
pub struct PaletteManager {
    palettes: HashMap<String, PaletteEntry>,
    /// Duration of the crossfade, in seconds. `0.0` means instant snap.
    pub transition_duration: f32,
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

    /// Initiate a crossfade to the palette named `to_name`.
    ///
    /// If `transition_duration == 0.0` the swap is instant (no blend).
    /// If `to_name` is unknown, does nothing.
    pub fn begin_transition(&mut self, to_name: &str, now: Instant) {
        if !self.palettes.contains_key(to_name) {
            log::warn!("begin_transition: unknown palette '{to_name}'");
            return;
        }
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

    /// Set a playlist so that `cycle_next()` iterates only the given names.
    /// Pass an empty vec to reset to "cycle all".
    pub fn set_playlist(&mut self, names: Vec<String>) {
        if names.is_empty() {
            self.cycle_playlist = None;
        } else {
            self.cycle_playlist = Some(names);
        }
        self.cycle_index = 0;
    }

    /// Advance the transition and return the current blend factor in `[0.0, 1.0]`.
    ///
    /// - Returns `0.0` when no transition is active.
    /// - Promotes `next` → `current` and returns `0.0` once the blend reaches `1.0`.
    pub fn advance_transition(&mut self, now: Instant) -> f32 {
        let (Some(start), Some(next_name)) = (self.transition_start, self.next_name.as_deref())
        else {
            return 0.0;
        };

        let elapsed = now.duration_since(start).as_secs_f32();
        let blend = (elapsed / self.transition_duration).clamp(0.0, 1.0);

        if blend >= 1.0 {
            // Transition complete: promote next → current.
            self.current_name = next_name.to_string();
            self.next_name = None;
            self.transition_start = None;
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
