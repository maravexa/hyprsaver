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

## Rewritten Shaders in v0.4.4

### Network (rewrite — v0.4.3 → v0.4.4)

| Max % | Min % | Shader | Notes |
|---|---|---|---|
| ~45–52 | ~30 | Network | Single-layer grid, long-offset edges. Estimate pending HawkPoint1 verification. |

**v0.4.4 architecture:** Single scrolling grid (8×5 nominal), 5×5 cell neighbourhood per pixel (25 cells), 1 outgoing long-offset edge per cell from an 8-direction table (Chebyshev magnitude 2). Per-node size variance (0.5–2.0×, 4× ratio) tapers edge widths and scales node brightness. Per-node circular drift (radius 0.12 cell units, ~63 s period, independent phase per node). Hash-driven edge existence (~60% density). Single palette call per edge (with per-edge hash offset for color variety). Gradient pulse via `smoothstep`. Additive composition over pure black.

**Expected improvement vs. prior v0.4.4 iteration:** Prior iteration used 3×3 + 3 outgoing short edges (36 features, 2 palette calls/edge = 54 palette calls/px). New iteration uses 5×5 + 1 long-offset edge (50 features, 1 palette call/edge = 50 palette calls/px). Net palette cost slightly lower; ALU slightly higher due to longer edge distances in projection math. Expected landing: 45–52% util.

Update this entry with actual radeontop measurements after verification on HawkPoint1.

## Shaders Removed in v0.4.4

| Shader | Former tier | Reason |
|---|---|---|
| Mandelbrot | Medium (40% max) | HawkPoint1 GPU architecture unsuited to per-pixel iteration count variance at animated zoom depth. Fractal slot filled by Julia variants. |

## Carry-Forward Results (v0.4.3 — unchanged shaders)

See `docs/BENCHMARK_0.4.3.md` for the full v0.4.3 baseline. All 23 shaders that survived into v0.4.4 retain their v0.4.3 benchmark numbers.

## Notes

- **Shipburn estimate basis:** Burning Ship Julia iteration body is structurally identical to classic Julia plus two `abs()` calls per step. `abs()` is a single instruction on HawkPoint1 (RDNA compute). Expected overhead is <5% versus Julia (43% max). Estimated 45% max.
- **Fractaltrap estimate basis (updated — cubic formula):** Iteration changed from z²+c to z³+c — Cartesian form uses 4 muls + 2 muls/adds vs. 2 muls + 1 mul for quadratic, roughly 3× per-step ALU cost. However, cubic Julias escape faster on average and MAX_ITER is 80 (lower than prior estimate's 100). Orbit trap adds length()+min() but no texture reads. Net estimate: 25–30% max, Lightweight tier.
- Both shaders are single-pass, no texture reads in the iteration loop, no divergent branches inside the loop body. Expected to behave well on RDNA wavefront execution.
- Update this file with actual radeontop measurements after v0.4.4 ships and verifies on HawkPoint1.
