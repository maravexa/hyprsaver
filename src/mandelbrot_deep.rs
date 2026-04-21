//! `mandelbrot_deep.rs` — CPU-side state machine for the deep-zoom Mandelbrot shader.
//!
//! Drives `mandelbrot_deep.frag` by uploading per-frame uniforms:
//!   - Focal point as df32 hi/lo pairs (f64 split to two f32s)
//!   - Exponential zoom factor `u_zoom_t`
//!   - Scaled iteration budget `u_max_iter`
//!   - Lifecycle fade factor `u_fade`
//!
//! Each cycle is ~92 s: 90 s exponential zoom from overview to precision limit,
//! then a 2 s fade-to-background before advancing to the next focal point.

use std::time::Instant;

// ---------------------------------------------------------------------------
// Curated focal points
// ---------------------------------------------------------------------------

/// 15 community-known Mandelbrot boundary coordinates that produce visually
/// rich zooms at every scale from 1× to 1e11×.
///
/// After initial deployment, each point should be visually inspected for a
/// full cycle. Points that produce disappointing zooms (too quickly uniform,
/// visible pixelation before cycle end, boring boundary structure) should be
/// replaced or adjusted.
pub const FOCAL_POINTS: &[(f64, f64, &str)] = &[
    (-0.7436438870,  0.1318259042,  "Seahorse Valley"),
    (-0.74364990,    0.13188204,    "Seahorse Deep"),
    ( 0.2550,        0.0055,        "Elephant Valley"),
    (-0.088,         0.654,         "Triple Spiral"),
    (-1.108180578,   0.230179813,   "Scepter Valley"),
    (-0.77568377,    0.13646737,    "Feather"),
    (-1.25066,       0.02012,       "Mini-Mandel West"),
    (-0.101096,      0.956286,      "Misiurewicz Spiral"),
    (-0.74529,       0.11307,       "Double Spiral"),
    (-1.768778833,   0.001738996,   "Julia Island"),
    (-0.743644786,   0.131826789,   "Wada Basin"),
    ( 0.285,         0.01,          "Cardioid Cusp"),
    (-0.16,          1.0405,        "Tendril Near-i"),
    (-0.77,          0.1,           "Seahorse West"),
    (-1.4011551,     0.0,           "Period-3 Bulb"),
];

// ---------------------------------------------------------------------------
// Cycle timing constants
// ---------------------------------------------------------------------------

/// Total zoom phase duration in seconds. Covers zoom_t = ZOOM_MIN → ZOOM_MAX.
pub const CYCLE_DURATION: f32 = 90.0;

/// Fade-to-background duration in seconds at end of each cycle.
pub const FADE_DURATION: f32 = 2.0;

/// Zoom factor at cycle start (near-overview, set appears sub-pixel).
/// With u_initial_extent = 4.0: extent = 4.0 / 1e-3 = 4000 complex units.
pub const ZOOM_MIN: f32 = 1.0e-3;

/// Zoom factor at cycle end (df32 precision ceiling with safety margin).
/// With u_initial_extent = 4.0: extent = 4.0 / 1e11 = 4e-11 complex units.
pub const ZOOM_MAX: f32 = 1.0e11;

/// Minimum iteration budget regardless of zoom depth.
pub const MAX_ITER_FLOOR: i32 = 100;

/// Hard iteration ceiling. Must match MAX_ITER_HARD_CAP in the GLSL shader.
pub const MAX_ITER_CEILING: i32 = 2000;

// ---------------------------------------------------------------------------
// State machine types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub enum CyclePhase {
    /// Exponential zoom from ZOOM_MIN to ZOOM_MAX.
    Zooming,
    /// Fade-to-background over FADE_DURATION before advancing focal point.
    Fading,
}

/// Per-frame uniform values to upload for `mandelbrot_deep.frag`.
#[derive(Debug, Clone, Copy)]
pub struct MandelbrotDeepUniforms {
    pub focal_real_hi:  f32,
    pub focal_real_lo:  f32,
    pub focal_imag_hi:  f32,
    pub focal_imag_lo:  f32,
    pub zoom_t:         f32,
    pub initial_extent: f32,
    pub max_iter:       i32,
    pub fade:           f32,
}

/// Per-session state for the deep-zoom Mandelbrot cycle.
pub struct MandelbrotDeepState {
    cycle_start:  Instant,
    focal_index:  usize,
    phase:        CyclePhase,
}

impl MandelbrotDeepState {
    /// Create a new state, starting at a random focal point chosen from
    /// system-time nanoseconds so each launch begins differently.
    pub fn new() -> Self {
        let focal_index = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos() as usize
            % FOCAL_POINTS.len();

        log::debug!(
            "mandelbrot_deep: starting at focal point {} — {}",
            focal_index,
            FOCAL_POINTS[focal_index].2
        );

        Self {
            cycle_start: Instant::now(),
            focal_index,
            phase: CyclePhase::Zooming,
        }
    }

    /// Compute per-frame uniforms from current wall-clock time.
    /// Advances the phase state machine and resets the cycle when the fade
    /// phase completes.
    pub fn update(&mut self, now: Instant) -> MandelbrotDeepUniforms {
        let elapsed = now.duration_since(self.cycle_start).as_secs_f32();

        let (zoom_t, fade) = match self.phase {
            CyclePhase::Zooming => {
                if elapsed >= CYCLE_DURATION {
                    self.phase = CyclePhase::Fading;
                }
                // Interpolate logarithmically between ZOOM_MIN and ZOOM_MAX.
                let log_zoom = (elapsed / CYCLE_DURATION).clamp(0.0, 1.0);
                let zoom = ZOOM_MIN.powf(1.0 - log_zoom) * ZOOM_MAX.powf(log_zoom);
                (zoom, 0.0_f32)
            }
            CyclePhase::Fading => {
                let fade_elapsed = elapsed - CYCLE_DURATION;
                if fade_elapsed >= FADE_DURATION {
                    // Cycle complete — advance to next focal point and restart.
                    self.focal_index = next_focal_index(self.focal_index);
                    self.cycle_start = now;
                    self.phase = CyclePhase::Zooming;
                    log::debug!(
                        "mandelbrot_deep: advancing to focal point {} — {}",
                        self.focal_index,
                        FOCAL_POINTS[self.focal_index].2
                    );
                    return self.update(now);
                }
                let fade = (fade_elapsed / FADE_DURATION).clamp(0.0, 1.0);
                (ZOOM_MAX, fade)
            }
        };

        // Iteration budget: 100 base + 100 per decade of zoom depth.
        // Stays within [MAX_ITER_FLOOR, MAX_ITER_CEILING].
        let max_iter = (MAX_ITER_FLOOR + (100.0 * zoom_t.max(1.0).log10()) as i32)
            .clamp(MAX_ITER_FLOOR, MAX_ITER_CEILING);

        let (fr, fi, _) = FOCAL_POINTS[self.focal_index];
        let (fr_hi, fr_lo) = split_f64_to_df32(fr);
        let (fi_hi, fi_lo) = split_f64_to_df32(fi);

        MandelbrotDeepUniforms {
            focal_real_hi:  fr_hi,
            focal_real_lo:  fr_lo,
            focal_imag_hi:  fi_hi,
            focal_imag_lo:  fi_lo,
            zoom_t,
            initial_extent: 4.0,
            max_iter,
            fade,
        }
    }

    /// Name of the current focal point (for logging).
    pub fn current_point_name(&self) -> &'static str {
        FOCAL_POINTS[self.focal_index].2
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Split an f64 value into a (hi, lo) f32 pair for df32 upload.
/// The hi word is the nearest f32; the lo word carries the rounding residual.
fn split_f64_to_df32(v: f64) -> (f32, f32) {
    let hi = v as f32;
    let lo = (v - hi as f64) as f32;
    (hi, lo)
}

/// Sequential rotation through the focal point list. Could be randomized later.
fn next_focal_index(current: usize) -> usize {
    (current + 1) % FOCAL_POINTS.len()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_focal_point_count() {
        assert_eq!(FOCAL_POINTS.len(), 15);
    }

    #[test]
    fn test_split_f64_roundtrip() {
        // The hi+lo pair must reconstruct the original f64 within f32 precision.
        for (fr, fi, _) in FOCAL_POINTS {
            let (hi, lo) = split_f64_to_df32(*fr);
            let reconstructed = hi as f64 + lo as f64;
            let err = (reconstructed - fr).abs();
            assert!(
                err < 1e-14,
                "focal real {fr}: reconstruction error {err} exceeds threshold"
            );

            let (hi, lo) = split_f64_to_df32(*fi);
            let reconstructed = hi as f64 + lo as f64;
            let err = (reconstructed - fi).abs();
            assert!(
                err < 1e-14,
                "focal imag {fi}: reconstruction error {err} exceeds threshold"
            );
        }
    }

    #[test]
    fn test_split_lo_nonzero_for_boundary_coords() {
        // At least one focal coordinate should have a non-zero lo word, confirming
        // that the split actually captures sub-f32 precision.
        let has_nonzero_lo = FOCAL_POINTS.iter().any(|(fr, fi, _)| {
            let (_, lo_r) = split_f64_to_df32(*fr);
            let (_, lo_i) = split_f64_to_df32(*fi);
            lo_r != 0.0 || lo_i != 0.0
        });
        assert!(has_nonzero_lo, "all focal lo-words are zero — split_f64_to_df32 may be broken");
    }

    #[test]
    fn test_iter_budget_scaling() {
        // At zoom_t = 1.0 (log10 = 0): max_iter = MAX_ITER_FLOOR
        let at_one = (MAX_ITER_FLOOR + (100.0f32 * 1.0f32.max(1.0).log10()) as i32)
            .clamp(MAX_ITER_FLOOR, MAX_ITER_CEILING);
        assert_eq!(at_one, MAX_ITER_FLOOR);

        // At zoom_t = 1e11 (log10 = 11): max_iter = 100 + 1100 = 1200
        let at_max = (MAX_ITER_FLOOR + (100.0f32 * (1.0e11f32).max(1.0).log10()) as i32)
            .clamp(MAX_ITER_FLOOR, MAX_ITER_CEILING);
        assert_eq!(at_max, 1200);
    }

    #[test]
    fn test_zoom_interpolation_endpoints() {
        let at_start = ZOOM_MIN.powf(1.0) * ZOOM_MAX.powf(0.0);
        assert!((at_start - ZOOM_MIN).abs() < 1e-6 * ZOOM_MIN);

        let at_end = ZOOM_MIN.powf(0.0) * ZOOM_MAX.powf(1.0);
        assert!((at_end - ZOOM_MAX).abs() < 1e-3 * ZOOM_MAX);
    }

    #[test]
    fn test_next_focal_index_wraps() {
        assert_eq!(next_focal_index(FOCAL_POINTS.len() - 1), 0);
        assert_eq!(next_focal_index(0), 1);
    }
}
