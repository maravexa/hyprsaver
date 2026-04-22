//! `cycle.rs` — CycleManager: schedules shader and palette rotation.
//!
//! The caller drives the cycle by passing `Instant::now()` to `tick()` each
//! frame. Events are returned as a `Vec<CycleEvent>` — empty when nothing
//! changed, otherwise containing one entry per elapsed interval.
//!
//! A playlist with a single entry is treated as a fixed selection: no cycle
//! events are ever emitted for it, preserving the pre-cycle-mode behaviour
//! where `shader = "mandelbrot"` just shows mandelbrot forever.

use std::time::{Duration, Instant};

use crate::shuffle::{seed_from_time, xorshift64, ShuffleBag};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Determines the order in which items are selected during a cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CycleOrder {
    /// Pick a random item each time, avoiding consecutive repeats.
    Random,
    /// Advance through the playlist in order, wrapping at the end.
    Sequential,
}

impl CycleOrder {
    /// Parse from a config/CLI string (`"random"` or `"sequential"`).
    /// Returns `CycleOrder::Random` for unknown values.
    pub fn from_str(s: &str) -> Self {
        match s {
            "sequential" => CycleOrder::Sequential,
            _ => CycleOrder::Random,
        }
    }
}

/// Event emitted by [`CycleManager::tick`] when a rotation is due.
#[derive(Debug, Clone)]
pub enum CycleEvent {
    /// Time to switch to this shader (name).
    ShaderChange(String),
    /// Time to switch to this palette (name).
    PaletteChange(String),
}

/// Construction parameters for a [`CycleManager`].
///
/// Both playlists must be fully expanded before construction — the caller
/// resolves `"all"` to a concrete list of names via `ShaderManager::list()` /
/// `PaletteManager::list()`. A single-entry playlist means "fixed" mode.
pub struct CycleConfig {
    /// Ordered list of shader names to cycle through.
    pub shader_playlist: Vec<String>,
    /// Ordered list of palette names to cycle through.
    pub palette_playlist: Vec<String>,
    /// How long to display each shader. Default: 300 s.
    pub shader_interval: Duration,
    /// How long to display each palette. Default: 60 s.
    pub palette_interval: Duration,
    /// Selection order within each playlist.
    pub order: CycleOrder,
}

impl Default for CycleConfig {
    fn default() -> Self {
        Self {
            shader_playlist: Vec::new(),
            palette_playlist: Vec::new(),
            shader_interval: Duration::from_secs(300),
            palette_interval: Duration::from_secs(60),
            order: CycleOrder::Random,
        }
    }
}

// ---------------------------------------------------------------------------
// CycleManager
// ---------------------------------------------------------------------------

/// Manages timed rotation of shaders and palettes.
///
/// # Lifecycle
///
/// 1. Build a [`CycleConfig`] with expanded playlists.
/// 2. Call [`CycleManager::new`] — randomises start positions, starts timers.
/// 3. Each frame: call [`tick`](CycleManager::tick) with `Instant::now()`.
///    Act on any returned [`CycleEvent`]s.
///
/// # Fixed-shader / fixed-palette mode
///
/// If a playlist has only one entry, [`tick`](CycleManager::tick) never
/// emits a change event for it. This preserves backwards compatibility:
/// a config with `shader = "mandelbrot"` passes `["mandelbrot"]` as the
/// shader playlist and hyprsaver shows mandelbrot forever.
pub struct CycleManager {
    shader_playlist: Vec<String>,
    palette_playlist: Vec<String>,
    shader_interval: Duration,
    palette_interval: Duration,
    shader_index: usize,
    palette_index: usize,
    last_shader_change: Instant,
    last_palette_change: Instant,
    order: CycleOrder,
    shader_bag: ShuffleBag,
    palette_bag: ShuffleBag,
}

impl CycleManager {
    /// Create a new `CycleManager`.
    ///
    /// Starting indices are randomised so the first item shown is not always
    /// the first in the playlist. Both interval timers begin at
    /// `Instant::now()`.
    ///
    /// # Panics
    ///
    /// Panics if either playlist is empty (a single `"_fixed_"` sentinel is
    /// acceptable; the caller must ensure at least one entry is present).
    pub fn new(config: CycleConfig) -> Self {
        assert!(
            !config.shader_playlist.is_empty(),
            "CycleManager: shader_playlist must not be empty"
        );
        assert!(
            !config.palette_playlist.is_empty(),
            "CycleManager: palette_playlist must not be empty"
        );

        // Derive two independent seeds from one wall-clock read.
        let mut rng = seed_from_time();
        let shader_seed = xorshift64(&mut rng);
        let palette_seed = xorshift64(&mut rng);

        let mut shader_bag = ShuffleBag::new(config.shader_playlist.len(), shader_seed);
        let mut palette_bag = ShuffleBag::new(config.palette_playlist.len(), palette_seed);

        // Random starting positions: pop once from each bag so the first
        // shown item isn't always index 0, and the popped index is removed
        // from the first bag cycle.
        let shader_index = if config.shader_playlist.len() > 1 {
            shader_bag.next()
        } else {
            0
        };
        let palette_index = if config.palette_playlist.len() > 1 {
            palette_bag.next()
        } else {
            0
        };

        let now = Instant::now();
        CycleManager {
            shader_playlist: config.shader_playlist,
            palette_playlist: config.palette_playlist,
            shader_interval: config.shader_interval,
            palette_interval: config.palette_interval,
            shader_index,
            palette_index,
            last_shader_change: now,
            last_palette_change: now,
            order: config.order,
            shader_bag,
            palette_bag,
        }
    }

    /// Advance the cycle timers and return any events that fired.
    ///
    /// Call this every frame (or at worst every few hundred ms). Returns an
    /// empty `Vec` when nothing changed. A playlist with a single entry never
    /// produces a change event regardless of elapsed time.
    pub fn tick(&mut self, now: Instant) -> Vec<CycleEvent> {
        let mut events = Vec::new();

        if self.shader_playlist.len() > 1
            && now.duration_since(self.last_shader_change) >= self.shader_interval
        {
            self.shader_index = self.next_shader_index();
            self.last_shader_change = now;
            events.push(CycleEvent::ShaderChange(
                self.shader_playlist[self.shader_index].clone(),
            ));
        }

        if self.palette_playlist.len() > 1
            && now.duration_since(self.last_palette_change) >= self.palette_interval
        {
            self.palette_index = self.next_palette_index();
            self.last_palette_change = now;
            events.push(CycleEvent::PaletteChange(
                self.palette_playlist[self.palette_index].clone(),
            ));
        }

        events
    }

    /// Create a new `CycleManager` with an additional seed offset for per-output independence.
    ///
    /// Pass the output index (0, 1, 2, …) or any unique u64 derived from the
    /// output name to guarantee independent RNG streams across monitors.
    pub fn new_with_offset(config: CycleConfig, seed_offset: u64) -> Self {
        let mut mgr = Self::new(config);
        // Rebuild the bags with offset-mixed seeds so per-monitor cycles
        // follow independent streams. The start indices chosen in `new`
        // are preserved.
        let shader_len = mgr.shader_playlist.len();
        let palette_len = mgr.palette_playlist.len();
        let mut rng = seed_from_time() ^ seed_offset.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        if rng == 0 {
            rng = 0x853c_49e6_748f_ea9b;
        }
        let shader_seed = xorshift64(&mut rng);
        let palette_seed = xorshift64(&mut rng);
        mgr.shader_bag = ShuffleBag::new(shader_len, shader_seed);
        mgr.palette_bag = ShuffleBag::new(palette_len, palette_seed);
        mgr
    }

    /// Immediately advance to the next shader, bypassing the interval timer.
    ///
    /// Resets the shader timer so the next automatic advance starts from now.
    /// Useful for preview/debug manual advancement.
    pub fn force_next_shader(&mut self) -> CycleEvent {
        if self.shader_playlist.len() > 1 {
            self.shader_index = self.next_shader_index();
        }
        self.last_shader_change = Instant::now();
        CycleEvent::ShaderChange(self.current_shader().to_string())
    }

    /// Immediately advance to the next palette, bypassing the interval timer.
    ///
    /// Resets the palette timer so the next automatic advance starts from now.
    pub fn force_next_palette(&mut self) -> CycleEvent {
        if self.palette_playlist.len() > 1 {
            self.palette_index = self.next_palette_index();
        }
        self.last_palette_change = Instant::now();
        CycleEvent::PaletteChange(self.current_palette().to_string())
    }

    /// Name of the currently active shader.
    pub fn current_shader(&self) -> &str {
        &self.shader_playlist[self.shader_index]
    }

    /// Name of the currently active palette.
    pub fn current_palette(&self) -> &str {
        &self.palette_playlist[self.palette_index]
    }

    // ---------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------

    /// Pick the next shader index according to the configured [`CycleOrder`].
    ///
    /// Sequential: `(current + 1) % len`.
    /// Random: next pick from the shuffle bag — every index appears
    /// exactly once per bag cycle, with no cross-bag consecutive repeats.
    fn next_shader_index(&mut self) -> usize {
        let len = self.shader_playlist.len();
        debug_assert!(len > 0);
        match self.order {
            CycleOrder::Sequential => (self.shader_index + 1) % len,
            CycleOrder::Random => self.shader_bag.next(),
        }
    }

    /// Pick the next palette index according to the configured [`CycleOrder`].
    ///
    /// Sequential: `(current + 1) % len`.
    /// Random: next pick from the shuffle bag — every index appears
    /// exactly once per bag cycle, with no cross-bag consecutive repeats.
    fn next_palette_index(&mut self) -> usize {
        let len = self.palette_playlist.len();
        debug_assert!(len > 0);
        match self.order {
            CycleOrder::Sequential => (self.palette_index + 1) % len,
            CycleOrder::Random => self.palette_bag.next(),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_mgr(shaders: &[&str], palettes: &[&str], order: CycleOrder) -> CycleManager {
        CycleManager::new(CycleConfig {
            shader_playlist: shaders.iter().map(|s| s.to_string()).collect(),
            palette_playlist: palettes.iter().map(|s| s.to_string()).collect(),
            shader_interval: Duration::from_secs(300),
            palette_interval: Duration::from_secs(60),
            order,
        })
    }

    // --- fixed-mode (single entry) ---

    #[test]
    fn single_shader_never_cycles() {
        let mut mgr = make_mgr(
            &["mandelbrot"],
            &["rainbow", "frost"],
            CycleOrder::Sequential,
        );
        let far = Instant::now() + Duration::from_secs(100_000);
        let events = mgr.tick(far);
        let shader_changes = events
            .iter()
            .filter(|e| matches!(e, CycleEvent::ShaderChange(_)))
            .count();
        assert_eq!(
            shader_changes, 0,
            "single-entry shader playlist must not cycle"
        );
    }

    #[test]
    fn single_palette_never_cycles() {
        let mut mgr = make_mgr(
            &["mandelbrot", "julia"],
            &["rainbow"],
            CycleOrder::Sequential,
        );
        let far = Instant::now() + Duration::from_secs(100_000);
        let events = mgr.tick(far);
        let palette_changes = events
            .iter()
            .filter(|e| matches!(e, CycleEvent::PaletteChange(_)))
            .count();
        assert_eq!(
            palette_changes, 0,
            "single-entry palette playlist must not cycle"
        );
    }

    // --- interval gating ---

    #[test]
    fn no_event_before_interval() {
        let mut mgr = make_mgr(&["a", "b"], &["x", "y"], CycleOrder::Sequential);
        // Tick immediately — elapsed ≈ 0, well under both intervals.
        let events = mgr.tick(Instant::now());
        assert!(
            events.is_empty(),
            "nothing should fire before the interval elapses"
        );
    }

    #[test]
    fn shader_event_fires_after_interval() {
        let mut mgr = make_mgr(&["a", "b", "c"], &["x"], CycleOrder::Sequential);
        let initial = mgr.current_shader().to_string();
        // Tick 301 s after construction (> 300 s shader interval).
        let far = Instant::now() + Duration::from_secs(301);
        let events = mgr.tick(far);
        let changed: Vec<_> = events
            .iter()
            .filter_map(|e| {
                if let CycleEvent::ShaderChange(n) = e {
                    Some(n.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(changed.len(), 1, "exactly one ShaderChange expected");
        assert_ne!(changed[0], initial.as_str(), "must pick a different shader");
    }

    #[test]
    fn palette_event_fires_after_interval() {
        let mut mgr = make_mgr(&["a"], &["x", "y", "z"], CycleOrder::Sequential);
        let initial = mgr.current_palette().to_string();
        // Tick 61 s after construction (> 60 s palette interval).
        let far = Instant::now() + Duration::from_secs(61);
        let events = mgr.tick(far);
        let changed: Vec<_> = events
            .iter()
            .filter_map(|e| {
                if let CycleEvent::PaletteChange(n) = e {
                    Some(n.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(changed.len(), 1, "exactly one PaletteChange expected");
        assert_ne!(
            changed[0],
            initial.as_str(),
            "must pick a different palette"
        );
    }

    // --- force_next ---

    #[test]
    fn force_next_shader_changes_name() {
        let mut mgr = make_mgr(&["x", "y", "z"], &["e"], CycleOrder::Sequential);
        let initial = mgr.current_shader().to_string();
        let event = mgr.force_next_shader();
        match event {
            CycleEvent::ShaderChange(name) => {
                assert_ne!(name, initial, "force_next_shader must advance");
                assert_eq!(
                    mgr.current_shader(),
                    name,
                    "current_shader must reflect the advance"
                );
            }
            _ => panic!("expected ShaderChange"),
        }
    }

    #[test]
    fn force_next_palette_changes_name() {
        let mut mgr = make_mgr(&["a"], &["p", "q", "r"], CycleOrder::Sequential);
        let initial = mgr.current_palette().to_string();
        let event = mgr.force_next_palette();
        match event {
            CycleEvent::PaletteChange(name) => {
                assert_ne!(name, initial, "force_next_palette must advance");
                assert_eq!(
                    mgr.current_palette(),
                    name,
                    "current_palette must reflect the advance"
                );
            }
            _ => panic!("expected PaletteChange"),
        }
    }

    #[test]
    fn force_next_shader_single_entry_stays() {
        // Single-entry list: force_next still returns an event but the name stays the same.
        let mut mgr = make_mgr(&["mandelbrot"], &["e"], CycleOrder::Sequential);
        let event = mgr.force_next_shader();
        match event {
            CycleEvent::ShaderChange(name) => assert_eq!(name, "mandelbrot"),
            _ => panic!("expected ShaderChange"),
        }
    }

    // --- sequential wrapping ---

    #[test]
    fn sequential_wraps_around() {
        let mut mgr = make_mgr(&["a", "b"], &["e"], CycleOrder::Sequential);
        // After 2 advances we must have visited both names and be back to start.
        let mut seen = std::collections::HashSet::new();
        for _ in 0..4 {
            if let CycleEvent::ShaderChange(n) = mgr.force_next_shader() {
                seen.insert(n);
            }
        }
        assert!(seen.contains("a"), "a must be visited");
        assert!(seen.contains("b"), "b must be visited");
    }

    // --- random: no consecutive repeat ---

    #[test]
    fn random_avoids_consecutive_repeat() {
        let mut mgr = make_mgr(&["a", "b", "c", "d"], &["e"], CycleOrder::Random);
        let mut prev = mgr.current_shader().to_string();
        for _ in 0..30 {
            if let CycleEvent::ShaderChange(name) = mgr.force_next_shader() {
                assert_ne!(name, prev, "random must not repeat consecutive item");
                prev = name;
            }
        }
    }

    // --- CycleOrder::from_str ---

    #[test]
    fn cycle_order_from_str_random() {
        assert_eq!(CycleOrder::from_str("random"), CycleOrder::Random);
        assert_eq!(CycleOrder::from_str("unknown"), CycleOrder::Random);
        assert_eq!(CycleOrder::from_str(""), CycleOrder::Random);
    }

    #[test]
    fn cycle_order_from_str_sequential() {
        assert_eq!(CycleOrder::from_str("sequential"), CycleOrder::Sequential);
    }

    // PRNG internals (xorshift64, seed_from_time) are tested in `shuffle.rs`.

    // Regression for the former `rng_state = 0` hang is now structurally
    // impossible: `ShuffleBag::new` coerces any zero seed to a non-zero
    // constant at construction, and `new_with_offset` does the same before
    // rebuilding the bags. The test below is kept as a smoke check that
    // `new_with_offset` with offset=0 still produces a working manager.

    // --- new_with_offset ---

    #[test]
    fn new_with_offset_terminates_with_zero_offset() {
        let mut mgr = CycleManager::new_with_offset(
            CycleConfig {
                shader_playlist: vec!["a".into(), "b".into()],
                palette_playlist: vec!["x".into()],
                shader_interval: std::time::Duration::from_secs(300),
                palette_interval: std::time::Duration::from_secs(60),
                order: CycleOrder::Random,
            },
            0,
        );
        let _ = mgr.force_next_shader();
    }

    #[test]
    fn new_with_offset_terminates_with_nonzero_offset() {
        // Same sanity check with a nonzero offset.
        let mut mgr = CycleManager::new_with_offset(
            CycleConfig {
                shader_playlist: vec!["a".into(), "b".into()],
                palette_playlist: vec!["x".into()],
                shader_interval: std::time::Duration::from_secs(300),
                palette_interval: std::time::Duration::from_secs(60),
                order: CycleOrder::Random,
            },
            42,
        );
        let _ = mgr.force_next_shader();
    }

    #[test]
    fn new_with_offset_sequential_starts_differ() {
        // With sequential order, cycle_index starts randomly in [0, len). Two
        // managers seeded with different offsets may or may not start at the same
        // index, but both must produce valid, non-panicking sequences.
        let mk = |offset: u64| {
            CycleManager::new_with_offset(
                CycleConfig {
                    shader_playlist: vec!["a".into(), "b".into(), "c".into()],
                    palette_playlist: vec!["x".into()],
                    shader_interval: std::time::Duration::from_secs(300),
                    palette_interval: std::time::Duration::from_secs(60),
                    order: CycleOrder::Sequential,
                },
                offset,
            )
        };
        // Verify both complete 6 sequential draws without panicking.
        for offset in 0u64..4 {
            let mut mgr = mk(offset);
            for _ in 0..6 {
                let _ = mgr.force_next_shader();
            }
        }
    }
}
