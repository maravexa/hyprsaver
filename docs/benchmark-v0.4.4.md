# Benchmark — hyprsaver v0.4.4

## Test Configuration

| Parameter | Value |
|---|---|
| **Device** | GMKtec Nucbox K12 |
| **GPU** | AMD ATI 65:00.0 HawkPoint1 |
| **Monitors** | Dual 1920×1200 |
| **Palette transitions** | 2s crossfade |
| **Mode** | Single shader, fixed palette, 2-minute sample |

Results ranked by maximum GPU utilization (%). Tier thresholds: Lightweight <25%, Medium 25–50%, Heavy 51–75%.

## New Shaders in v0.4.4

### Medium (25–50% GPU)

| Max % | Min % | Shader | Notes |
|---|---|---|---|
| ~45 | ~40 | Shipburn | Burning Ship Julia — MAX_ITER 150, abs() fold adds negligible cost vs. standard Julia. Estimate pending HawkPoint1 verification. |
| ~30 | ~25 | Fractaltrap | Cubic Julia (z³+c) with orbit trap — MAX_ITER 80, cubic step ~3× quadratic ALU cost but most pixels escape early. Orbit trap adds length()+min() per step. Net estimate: Lightweight tier. Pending HawkPoint1 verification. |
| ~20–30 | ~15 | Circuit | Brick-offset grid, 4×5 cached nodes, 3 edges per cell — fast fract hash, single palette call per feature. Estimate pending HawkPoint1 verification. |
| ~15–20 | ~10 | Sonar | Full rewrite (v0.4.4): static backdrop (crosshair + rings), rotating sweep, blip contacts. ~12 sin/cos (emitter_pos) + 6 atan + 2 exp + 2 palette calls. No wave-interference math. Estimate pending HawkPoint1 verification. |

### Lightweight (<25% GPU)

| Max % | Min % | Shader | Notes |
|---|---|---|---|
| ~18–27 | ~15 | Waves | Retro 2D wave field on a horizon perspective — flat-plane `1.0/(horizon-y)` perspective inverse, 3 triangle waves (no sin), hard-`step` isolines (no smoothstep), posterized palette bands, offline/online liveness (step + fract), exponential distance fog (1 `exp()`), CRT scanlines. No raymarching, no normals, no hashing. First member of the planned retro sub-group. Estimate pending HawkPoint1 verification. |

## Shaders Removed in v0.4.4

| Shader | Former tier | Reason |
|---|---|---|
| Mandelbrot | Medium (40% max) | HawkPoint1 GPU architecture unsuited to per-pixel iteration count variance at animated zoom depth. Fractal slot filled by Julia variants. |
| Network | Medium (45–52% max) | Plexus/connected-nodes aesthetic is vertex-native; per-pixel O(n) iteration is structurally unable to reach parity with a proper vertex renderer. Replaced by circuit and sonar — both fragment-native aesthetics at expected 20–30% cost. |

## Carry-Forward Results (v0.4.3 — unchanged shaders)

See `docs/BENCHMARK_0.4.3.md` for the full v0.4.3 baseline. All 23 shaders that survived into v0.4.4 retain their v0.4.3 benchmark numbers.

## Notes

- **Shipburn estimate basis:** Burning Ship Julia iteration body is structurally identical to classic Julia plus two `abs()` calls per step. `abs()` is a single instruction on HawkPoint1 (RDNA compute). Expected overhead is <5% versus Julia (43% max). Estimated 45% max.
- **Fractaltrap estimate basis (updated — cubic formula):** Iteration changed from z²+c to z³+c — Cartesian form uses 4 muls + 2 muls/adds vs. 2 muls + 1 mul for quadratic, roughly 3× per-step ALU cost. However, cubic Julias escape faster on average and MAX_ITER is 80 (lower than prior estimate's 100). Orbit trap adds length()+min() but no texture reads. Net estimate: 25–30% max, Lightweight tier.
- **Circuit estimate basis:** 4×5 = 20 node cache eliminates repeated hash calls. 3×3 = 9 cell iteration × 3 edges = 27 edge evaluations/pixel. Each edge: 1 hash + 1 distance + 1 palette = cheap. Fast fract hash throughout. Expected 20–30% max.
- **Sonar estimate basis (v0.4.4 rewrite):** 6 emitter_pos calls × 2 sin/cos = 12 trig. 6 atan (emitter angles) + 1 atan (pixel angle) = 7 atan. 1 exp (beam) + 1 exp (trail) = 2 exp. 6 length + 6 smoothstep (blips). 2 palette samples. No wave cos/exp per emitter. Total ~25 trig-equivalent ops/px. Expected 15–20% max — cheaper than prior wave-interference version.
- **Waves estimate basis (post-tweak, palette hash + brightness clamps):** Single divide + min (perspective), 3 triangle-wave calls (each: 1 mul, 1 fract, 1 abs, 1 sub, 1 mul, 1 sub — ~6 ALU, no transcendentals), 1 fract + 1 abs + 1 step (isolines), 1 floor + 1 mul + 1 fract (band index / golden-ratio hash palette coord — replaces divide with multiply, slight cost reduction), 1 texture read (palette), 1 mul + 1 fract + 1 step (liveness hash — offline/online), 3× `max` + 3× `min` (per-channel brightness clamp — ~6 ALU, no branches on RDNA), 1 `exp()` + 1 mul (distance fog), 1 smoothstep (haze), 1 fract + 1 step (scanlines). Hash replace (divide → multiply) and clamp (~6 ALU) are net near-zero. Expected 16–18% max (±1% from 16% pre-tweak measurement; divide→multiply saves ~1%, clamp adds ~1%).
- Both circuit and sonar are single-pass with no texture reads in inner loops. Expected to behave well on RDNA wavefront execution.
- Update this file with actual radeontop measurements after v0.4.4 ships and verifies on HawkPoint1.
