# Wormhole first-hit correction

The old abs-step march treated the radial tunnel field as a distance bound.
At bends it could skip the first wall or stop without a valid hit, producing
incorrect depth bands around the center. The corrected march combines a global
Lipschitz step with a conservative radial-curvature bound; the curvature step is
clipped to the region where its bound holds. Positive-slope quadratic roots use
a rationalized expression, and a 0.00005 field tolerance avoids float32 stalls.
Rays that exhaust the budget now use the fog color instead of shading a false hit.

Local qualification on 2026-11-17 used an AMD Radeon RX 6700 XT,
Mesa 26.2.4, OpenGL ES 3.2:

- 26 cases: 160×90 and 90×160, every five seconds from 0 through 60.
  All 374,400 rays hit; none exceeded the 0.2-unit first-depth gate.
  Maximum observed depth error was 0.03766 units.
- The independent reference searches at 0.025-unit intervals, then bisects the
  first observed crossing 12 times. This is a sampled regression test, not a
  proof for all rays or arbitrarily thin grazing intersections.
- Four visual comparisons cover 800×480 and 480×800 in rainbow and forest
  palettes at 0/10/20/30 seconds. The corrected center retains the curved tunnel
  composition without the rejected candidate's missing-hit fog patches.
- Five alternating-order 1080p benchmark repeats, 240 frames each, 24 warmup,
  60-second span, rainbow: baseline median 0.2365 ms (MAD 0.0127), candidate
  0.2487 ms (MAD 0.0059), +5.16%. This passes the existing regression rule:
  increase must exceed max(0.1 ms, 15% of baseline, 3 × summed MAD) to fail.
  These numbers measure synchronized render throughput, not GPU timer utilization.
- Rust 1.94.1: formatting, all-target/all-feature Clippy with warnings denied,
  all 153 tests, and the debug build passed. The rebuilt binary contains the
  exact corrected shader; its four sampled built-in frames match the tested
  custom shader within one channel level.

Reproduce the depth gate with NumPy and Pillow available:

```sh
cargo build --locked
python3 scripts/check_wormhole_depth.py \
  --binary target/debug/hyprsaver --output /tmp/wormhole-depth-new-run
```

The output directory must not exist. The script captures encoded hit/depth PNGs,
records source/binary hashes and renderer identity, and fails on missing rays,
reference misses or depth errors over 0.2. `--software` deliberately selects
software rendering and must not be reported as hardware qualification.
The source shader is loaded through temporary configuration, so this check is
independent of embedding freshness; verify the built-in build separately.

No new compositor session, installed screensaver, public release, physical-device,
thermal or multi-monitor acceptance is implied by these offscreen checks.
