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
// Built-in palettes
// ---------------------------------------------------------------------------

/// Returns a map of all built-in named palettes.
pub fn builtin_palettes() -> HashMap<String, Palette> {
    let mut map = HashMap::new();
    map.insert(
        "electric".to_string(),
        Palette {
            a: [0.5, 0.5, 0.5],
            b: [0.5, 0.5, 0.5],
            c: [1.0, 1.0, 1.0],
            d: [0.00, 0.33, 0.67],
        },
    );
    map.insert(
        "autumn".to_string(),
        Palette {
            a: [0.5, 0.5, 0.5],
            b: [0.5, 0.5, 0.2],
            c: [1.0, 1.0, 1.0],
            d: [0.00, 0.15, 0.20],
        },
    );
    map.insert(
        "vapor".to_string(),
        Palette {
            a: [0.8, 0.5, 0.4],
            b: [0.2, 0.4, 0.2],
            c: [2.0, 1.0, 1.0],
            d: [0.00, 0.25, 0.50],
        },
    );
    map.insert(
        "frost".to_string(),
        Palette {
            a: [0.7, 0.8, 0.9],
            b: [0.2, 0.2, 0.3],
            c: [1.0, 1.0, 0.5],
            d: [0.00, 0.10, 0.20],
        },
    );
    map.insert(
        "ember".to_string(),
        Palette {
            a: [0.5, 0.2, 0.1],
            b: [0.5, 0.3, 0.2],
            c: [0.8, 0.8, 0.5],
            d: [0.00, 0.05, 0.10],
        },
    );
    map.insert(
        "ocean".to_string(),
        Palette {
            a: [0.2, 0.4, 0.6],
            b: [0.3, 0.3, 0.3],
            c: [1.0, 1.0, 1.0],
            d: [0.00, 0.10, 0.30],
        },
    );
    map.insert(
        "monochrome".to_string(),
        Palette {
            a: [0.5, 0.5, 0.5],
            b: [0.5, 0.5, 0.5],
            c: [1.0, 1.0, 1.0],
            d: [0.00, 0.00, 0.00],
        },
    );
    map
}

// ---------------------------------------------------------------------------
// PaletteManager
// ---------------------------------------------------------------------------

/// Manages the collection of named palettes (built-ins + user-defined from config).
pub struct PaletteManager {
    palettes: HashMap<String, Palette>,
}

impl PaletteManager {
    /// Create a new PaletteManager pre-populated with all built-in palettes, then merge
    /// `custom` on top. Custom entries overwrite built-ins if names collide.
    pub fn new(custom: HashMap<String, Palette>) -> Self {
        let mut palettes = builtin_palettes();
        palettes.extend(custom);
        Self { palettes }
    }

    /// Look up a palette by name. Returns `None` if the name is not registered.
    pub fn get(&self, name: &str) -> Option<&Palette> {
        self.palettes.get(name)
    }

    /// Return a sorted list of all known palette names.
    pub fn list(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.palettes.keys().map(String::as_str).collect();
        names.sort_unstable();
        names
    }

    /// Return a random palette. Uses current time modulo palette count as the index.
    pub fn random(&self) -> (&str, &Palette) {
        let idx = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos() as usize
            % self.palettes.len();
        let (name, palette) = self
            .palettes
            .iter()
            .nth(idx)
            .expect("palette map is non-empty");
        (name.as_str(), palette)
    }
}

impl Default for PaletteManager {
    fn default() -> Self {
        Self::new(HashMap::new())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Compute the expected cosine palette value for a given t and palette params.
    fn expected(a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3], t: f32) -> [f32; 3] {
        [
            (a[0] + b[0] * (TAU * (c[0] * t + d[0])).cos()).clamp(0.0, 1.0),
            (a[1] + b[1] * (TAU * (c[1] * t + d[1])).cos()).clamp(0.0, 1.0),
            (a[2] + b[2] * (TAU * (c[2] * t + d[2])).cos()).clamp(0.0, 1.0),
        ]
    }

    fn electric() -> Palette {
        Palette {
            a: [0.5, 0.5, 0.5],
            b: [0.5, 0.5, 0.5],
            c: [1.0, 1.0, 1.0],
            d: [0.00, 0.33, 0.67],
        }
    }

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

    #[test]
    fn test_palette_color_at_zero() {
        let p = electric();
        let got = p.color_at(0.0);
        let want = expected(p.a, p.b, p.c, p.d, 0.0);
        assert_approx(got, want, 1e-5);
    }

    #[test]
    fn test_palette_color_at_half() {
        let p = electric();
        let got = p.color_at(0.5);
        let want = expected(p.a, p.b, p.c, p.d, 0.5);
        assert_approx(got, want, 1e-5);
    }

    #[test]
    fn test_palette_color_at_one() {
        let p = electric();
        let at_zero = p.color_at(0.0);
        let at_one = p.color_at(1.0);
        // For c=[1,1,1], t=1.0 and t=0.0 produce the same cosine value.
        assert_approx(at_one, at_zero, 1e-5);
    }

    #[test]
    fn test_builtin_count() {
        assert_eq!(builtin_palettes().len(), 7);
    }

    #[test]
    fn test_manager_custom_override() {
        let custom_electric = Palette {
            a: [0.1, 0.2, 0.3],
            b: [0.4, 0.5, 0.6],
            c: [0.7, 0.8, 0.9],
            d: [0.0, 0.1, 0.2],
        };
        let mut custom = HashMap::new();
        custom.insert("electric".to_string(), custom_electric.clone());
        let mgr = PaletteManager::new(custom);
        let got = mgr.get("electric").expect("electric must exist");
        assert_eq!(
            got, &custom_electric,
            "custom palette should override built-in"
        );
    }

    #[test]
    fn test_manager_list_sorted() {
        let mgr = PaletteManager::new(HashMap::new());
        let names = mgr.list();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(
            names, sorted,
            "list() must return alphabetically sorted names"
        );
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
            let c = extreme.color_at(i as f32 / 100.0);
            for ch in c {
                assert!(ch >= 0.0 && ch <= 1.0, "channel out of range: {ch}");
            }
        }
    }
}
