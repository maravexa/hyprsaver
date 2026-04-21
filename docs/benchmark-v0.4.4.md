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
| ~20–30 | ~15 | Sonar | 6 Lissajous emitters, wave interference sum, radial sweep, blips — ~40 trig-equivalent ops/px, 3 palette samples. Estimate pending HawkPoint1 verification. |

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
- **Sonar estimate basis:** 6 emitter_pos calls × 2 sin/cos = 12 trig. 6 exp for wave attenuation. 1 atan. 1 exp for sweep. 6 exp for blips. 3 palette samples. Total ~30 trig-equivalent ops/px. Expected 20–30% max.
- Both circuit and sonar are single-pass with no texture reads in inner loops. Expected to behave well on RDNA wavefront execution.
- Update this file with actual radeontop measurements after v0.4.4 ships and verifies on HawkPoint1.
