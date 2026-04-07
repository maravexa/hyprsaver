//! `palette.rs` — Cosine gradient palette definitions and management.
//!
//! Implements the Inigo Quilez cosine gradient palette technique:
//!   color(t) = a + b * cos(2π * (c*t + d))
//!
//! where a, b, c, d are RGB vec3 values. The four 3-float vectors are uploaded as
//! GLSL uniforms and the `palette(t)` function in every shader evaluates them on the GPU.
//!
//! This module also provides CPU-side palette evaluation (`color_at`) for use in
//! palette preview tooling and tests.
//!
//! Reference: <https://iquilezles.org/articles/palettes/>

use serde::Deserialize;
use std::collections::HashMap;
use std::f32::consts::TAU;

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/// A cosine gradient palette defined by four RGB parameter vectors.
///
/// The color at parameter `t ∈ [0, 1]` is:
/// ```text
///   color(t) = a + b * cos(2π * (c * t + d))
/// ```
///
/// Intuition:
/// - `a` — brightness / DC offset (average color)
/// - `b` — contrast / amplitude of oscillation
/// - `c` — frequency (how many full cycles over t = 0..1)
/// - `d` — phase shift per channel (controls hue rotation)
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Palette {
    /// Brightness offset. Each component in [0, 1].
    pub a: [f32; 3],
    /// Contrast / amplitude. Each component in [0, 1].
    pub b: [f32; 3],
    /// Frequency per channel. Typically near 1.0.
    pub c: [f32; 3],
    /// Phase shift per channel. Drives hue rotation.
    pub d: [f32; 3],
}

impl Palette {
    /// Evaluate the cosine gradient at parameter `t`, returning `[r, g, b]` in [0, 1].
    pub fn color_at(&self, t: f32) -> [f32; 3] {
        let r = self.a[0] + self.b[0] * (TAU * (self.c[0] * t + self.d[0])).cos();
        let g = self.a[1] + self.b[1] * (TAU * (self.c[1] * t + self.d[1])).cos();
        let b = self.a[2] + self.b[2] * (TAU * (self.c[2] * t + self.d[2])).cos();
        [r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b.clamp(0.0, 1.0)]
    }
}

// ---------------------------------------------------------------------------
// Built-in palettes
// ---------------------------------------------------------------------------

/// Classic rainbow — `d = [0.00, 0.33, 0.67]` produces a full hue rotation.
pub const PALETTE_ELECTRIC: Palette = Palette {
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [1.0, 1.0, 1.0],
    d: [0.00, 0.33, 0.67],
};

/// Golds, rusts, and deep reds — warm autumn tones.
pub const PALETTE_AUTUMN: Palette = Palette {
    a: [0.5, 0.35, 0.1],
    b: [0.5, 0.35, 0.1],
    c: [1.0, 1.0, 0.5],
    d: [0.00, 0.10, 0.20],
};

/// Vaporwave: hot pinks, electric teals, deep purples.
pub const PALETTE_VAPOR: Palette = Palette {
    a: [0.5, 0.3, 0.6],
    b: [0.5, 0.3, 0.4],
    c: [1.0, 0.7, 1.0],
    d: [0.00, 0.50, 0.75],
};

/// Icy blues and silvers — cold, crystalline.
pub const PALETTE_FROST: Palette = Palette {
    a: [0.6, 0.7, 0.8],
    b: [0.4, 0.3, 0.2],
    c: [0.8, 1.0, 1.2],
    d: [0.55, 0.60, 0.65],
};

/// Deep reds through bright orange to yellow — volcanic.
pub const PALETTE_EMBER: Palette = Palette {
    a: [0.5, 0.2, 0.05],
    b: [0.5, 0.2, 0.05],
    c: [1.0, 0.7, 0.4],
    d: [0.00, 0.05, 0.10],
};

/// Deep navy through cyan to near-white — ocean depth.
pub const PALETTE_OCEAN: Palette = Palette {
    a: [0.15, 0.40, 0.55],
    b: [0.15, 0.40, 0.45],
    c: [0.6, 0.8, 1.0],
    d: [0.50, 0.55, 0.60],
};

/// Grayscale — pure luminance, no hue.
pub const PALETTE_MONOCHROME: Palette = Palette {
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [1.0, 1.0, 1.0],
    d: [0.0, 0.0, 0.0],
};

// ---------------------------------------------------------------------------
// PaletteManager
// ---------------------------------------------------------------------------

/// Manages the collection of named palettes (built-ins + user-defined from config).
pub struct PaletteManager {
    palettes: HashMap<String, Palette>,
}

impl PaletteManager {
    /// Create a new PaletteManager pre-populated with all built-in palettes.
    pub fn new() -> Self {
        let mut palettes = HashMap::new();
        palettes.insert("electric".to_string(), PALETTE_ELECTRIC);
        palettes.insert("autumn".to_string(), PALETTE_AUTUMN);
        palettes.insert("vapor".to_string(), PALETTE_VAPOR);
        palettes.insert("frost".to_string(), PALETTE_FROST);
        palettes.insert("ember".to_string(), PALETTE_EMBER);
        palettes.insert("ocean".to_string(), PALETTE_OCEAN);
        palettes.insert("monochrome".to_string(), PALETTE_MONOCHROME);
        Self { palettes }
    }

    /// Merge user-defined palettes from config. User entries overwrite built-ins if names collide.
    pub fn merge_user_palettes(&mut self, user: HashMap<String, Palette>) {
        self.palettes.extend(user);
    }

    /// Return a sorted list of all known palette names.
    pub fn list(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.palettes.keys().map(String::as_str).collect();
        names.sort_unstable();
        names
    }

    /// Look up a palette by name. Returns `None` if the name is not registered.
    pub fn get(&self, name: &str) -> Option<&Palette> {
        self.palettes.get(name)
    }

    /// Return a random palette. Useful for `palette = "random"` config option.
    pub fn random(&self) -> &Palette {
        todo!(
            "pick a random key from self.palettes using a simple index into the values iterator"
        )
    }
}

impl Default for PaletteManager {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn electric_at_zero_is_white() {
        // At t=0, cos(2π*d) for d=[0,0.33,0.67] ≈ [1, -0.5, -0.5], so
        // color = [0.5+0.5, 0.5-0.25, 0.5-0.25] = [1.0, 0.25, 0.25] (approximately).
        let c = PALETTE_ELECTRIC.color_at(0.0);
        assert!((c[0] - 1.0).abs() < 0.01, "r should be ~1.0, got {}", c[0]);
    }

    #[test]
    fn color_at_clamps_to_unit_range() {
        // Any palette with extreme values should still clamp to [0, 1].
        let extreme = Palette {
            a: [2.0, 2.0, 2.0],
            b: [2.0, 2.0, 2.0],
            c: [1.0, 1.0, 1.0],
            d: [0.0, 0.0, 0.0],
        };
        for i in 0..=100 {
            let c = extreme.color_at(i as f32 / 100.0);
            for ch in c {
                assert!(ch >= 0.0 && ch <= 1.0, "channel out of range: {}", ch);
            }
        }
    }

    #[test]
    fn palette_manager_contains_all_builtins() {
        let mgr = PaletteManager::new();
        let names = mgr.list();
        for expected in &["electric", "autumn", "vapor", "frost", "ember", "ocean", "monochrome"] {
            assert!(names.contains(expected), "missing built-in palette: {}", expected);
        }
    }
}
