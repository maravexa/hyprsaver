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
| ~43 | ~38 | Fractaltrap | Julia with orbit trap — MAX_ITER 100 (lower than julia.frag's 200), one extra length()+min()+abs() per step. Net cost lower than Julia. Estimate pending HawkPoint1 verification. |

## Shaders Removed in v0.4.4

| Shader | Former tier | Reason |
|---|---|---|
| Mandelbrot | Medium (40% max) | HawkPoint1 GPU architecture unsuited to per-pixel iteration count variance at animated zoom depth. Fractal slot filled by Julia variants. |

## Carry-Forward Results (v0.4.3 — unchanged shaders)

See `docs/BENCHMARK_0.4.3.md` for the full v0.4.3 baseline. All 23 shaders that survived into v0.4.4 retain their v0.4.3 benchmark numbers.

## Notes

- **Shipburn estimate basis:** Burning Ship Julia iteration body is structurally identical to classic Julia plus two `abs()` calls per step. `abs()` is a single instruction on HawkPoint1 (RDNA compute). Expected overhead is <5% versus Julia (43% max). Estimated 45% max.
- **Fractaltrap estimate basis:** Circle-trap tracking adds `length()` + `abs()` + `min()` per iteration — roughly 3 extra ALU ops. However, MAX_ITER is 100 vs. Julia's 200, cutting total iteration work roughly in half. Net estimate: slightly below Julia at ~43% max.
- Both shaders are single-pass, no texture reads in the iteration loop, no divergent branches inside the loop body. Expected to behave well on RDNA wavefront execution.
- Update this file with actual radeontop measurements after v0.4.4 ships and verifies on HawkPoint1.
