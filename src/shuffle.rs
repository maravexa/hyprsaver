//! `shuffle.rs` — Shuffle-bag random selection.
//!
//! A `ShuffleBag` returns every index in `0..len` exactly once per bag
//! cycle, in a freshly randomized order. When a bag is exhausted, a
//! new one is generated; the first pick of the new bag is guaranteed
//! to differ from the last pick of the previous bag (when `len >= 2`).
//!
//! This is the "iPod shuffle" pattern: uniform-over-cycle, not
//! uniform-per-pick. It eliminates the perceived clumping of true
//! random selection on short playlists.
//!
//! A separate `ShuffleBag` instance is used per cycle stream (shaders,
//! palettes). Each owns its own state and PRNG seed.

use std::time::{SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// ShuffleBag
// ---------------------------------------------------------------------------

/// A shuffle-bag selector over indices `0..len`.
///
/// Returns each index exactly once per bag cycle, reshuffling on
/// exhaustion. Consecutive repeats across bag boundaries are
/// prevented when `len >= 2`.
///
/// For `len == 0`, `next` will panic (debug) or loop (release) — the
/// caller is expected to guard against empty playlists, which
/// `CycleManager` already does.
///
/// For `len == 1`, `next` always returns `0` without consulting the
/// PRNG.
pub struct ShuffleBag {
    len: usize,
    /// Remaining shuffled indices for the current bag; consumed from the end.
    order: Vec<usize>,
    /// Last returned index, used to prevent cross-bag consecutive repeats.
    last_returned: Option<usize>,
    /// xorshift64 state; always non-zero.
    rng_state: u64,
}

impl ShuffleBag {
    /// Construct a new shuffle bag over `0..len` with the given PRNG seed.
    ///
    /// The bag starts empty; the first `next()` call triggers the first
    /// shuffle. The seed is coerced to a non-zero value to keep xorshift64
    /// valid.
    pub fn new(len: usize, seed: u64) -> Self {
        let rng_state = if seed == 0 {
            0x853c_49e6_748f_ea9b
        } else {
            seed
        };
        ShuffleBag {
            len,
            order: Vec::new(),
            last_returned: None,
            rng_state,
        }
    }

    /// Return the next index from the bag, reshuffling when exhausted.
    ///
    /// Guarantees:
    /// - Over any contiguous span of `len` calls, every index in
    ///   `0..len` appears exactly once.
    /// - When `len >= 2`, no two consecutive return values are equal
    ///   (including across bag boundaries).
    /// - When `len == 1`, always returns `0`.
    pub fn next(&mut self) -> usize {
        debug_assert!(self.len > 0, "ShuffleBag: len must be > 0");
        if self.len == 1 {
            self.last_returned = Some(0);
            return 0;
        }

        if self.order.is_empty() {
            self.refill();
        }

        let idx = self.order.pop().expect("bag was just refilled");
        self.last_returned = Some(idx);
        idx
    }

    /// Refill `self.order` with a fresh Fisher-Yates shuffle of `0..len`.
    ///
    /// If the tail of the new bag (i.e. the next index to be popped)
    /// equals `self.last_returned`, swap it with position 0 of the bag
    /// to prevent a cross-bag consecutive repeat. Safe for `len >= 2`.
    fn refill(&mut self) {
        self.order = (0..self.len).collect();
        // Fisher-Yates, i from len-1 down to 1.
        for i in (1..self.len).rev() {
            let j = (xorshift64(&mut self.rng_state) as usize) % (i + 1);
            self.order.swap(i, j);
        }
        // Prevent cross-bag consecutive repeat.
        if self.len >= 2 {
            if let (Some(last), Some(&tail)) = (self.last_returned, self.order.last()) {
                if tail == last {
                    // Swap the to-be-popped tail with position 0. Since
                    // `last` is not in `0..len`'s permutation twice,
                    // position 0 cannot also equal `last`, so this
                    // always breaks the tie.
                    let tail_pos = self.order.len() - 1;
                    self.order.swap(0, tail_pos);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// PRNG (no external rand crate dependency)
// ---------------------------------------------------------------------------

/// xorshift64 — fast, sufficient statistical quality for playlist shuffling.
///
/// Reference: G. Marsaglia, "Xorshift RNGs", *Journal of Statistical
/// Software* 8(14), 2003. State must never be 0.
pub(crate) fn xorshift64(state: &mut u64) -> u64 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    x
}

/// Seed a PRNG from wall-clock time.
///
/// Mixes sub-second nanos with the seconds component so rapid
/// successive calls don't produce identical seeds. Falls back to a
/// non-zero constant if the clock is unavailable.
pub fn seed_from_time() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| {
            let secs = d.as_secs();
            let sub = d.subsec_nanos() as u64;
            secs.wrapping_mul(1_000_000_007).wrapping_add(sub)
        })
        .unwrap_or(0x243f_6a88_85a3_08d3);
    if nanos == 0 {
        0x853c_49e6_748f_ea9b
    } else {
        nanos
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn len_one_always_returns_zero() {
        let mut bag = ShuffleBag::new(1, 42);
        for _ in 0..10 {
            assert_eq!(bag.next(), 0);
        }
    }

    #[test]
    fn each_index_appears_exactly_once_per_bag() {
        let len = 7;
        let mut bag = ShuffleBag::new(len, 12345);
        let mut seen: HashSet<usize> = HashSet::new();
        for _ in 0..len {
            let idx = bag.next();
            assert!(idx < len, "index out of range");
            assert!(seen.insert(idx), "duplicate within a single bag cycle");
        }
        assert_eq!(seen.len(), len);
    }

    #[test]
    fn no_consecutive_repeats_across_bag_boundaries() {
        let len = 5;
        let mut bag = ShuffleBag::new(len, 99);
        let mut prev = bag.next();
        // Run long enough to exercise many bag refills.
        for _ in 0..(len * 20) {
            let next = bag.next();
            assert_ne!(next, prev, "consecutive repeat");
            prev = next;
        }
    }

    #[test]
    fn uniform_distribution_over_many_cycles() {
        // Over k full bag cycles, every index must appear exactly k times.
        let len = 8;
        let k = 50;
        let mut bag = ShuffleBag::new(len, 0xdead_beef);
        let mut counts = vec![0usize; len];
        for _ in 0..(len * k) {
            counts[bag.next()] += 1;
        }
        for (i, c) in counts.iter().enumerate() {
            assert_eq!(*c, k, "index {i} appeared {c} times, expected {k}");
        }
    }

    #[test]
    fn deterministic_given_seed() {
        let mut a = ShuffleBag::new(6, 0xcafe);
        let mut b = ShuffleBag::new(6, 0xcafe);
        for _ in 0..30 {
            assert_eq!(a.next(), b.next());
        }
    }

    #[test]
    fn zero_seed_coerced_to_nonzero() {
        // Must not panic or loop; must still produce a valid permutation.
        let mut bag = ShuffleBag::new(4, 0);
        let mut seen = HashSet::new();
        for _ in 0..4 {
            seen.insert(bag.next());
        }
        assert_eq!(seen.len(), 4);
    }

    #[test]
    fn len_two_alternates() {
        let mut bag = ShuffleBag::new(2, 7);
        let mut prev = bag.next();
        for _ in 0..50 {
            let next = bag.next();
            assert_ne!(next, prev);
            prev = next;
        }
    }

    #[test]
    fn seed_from_time_nonzero() {
        assert_ne!(seed_from_time(), 0);
    }
}
