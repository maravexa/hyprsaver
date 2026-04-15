# Benchmark — hyprsaver v0.4.0

## Test Configuration

| Parameter | Value |
|---|---|
| **Device** | GMKtec Nucbox K12 |
| **GPU** | AMD ATI 65:00.0 HawkPoint1 |
| **Monitors** | Dual 1920×1200 |
| **Palette transitions** | 2s crossfade |
| **Mode** | Shader cycle with all palettes |

Results ranked by maximum GPU utilization (%). Min column shows the lowest observed utilization during the shader's cycle. Tier thresholds: Lightweight <25%, Medium 25–50%, Heavy 51–75%.

## Results

### Lightweight (<25% GPU)

| Max % | Min % | Shader | Notes |
|---|---|---|---|
| 19 | 18 | Caustics | Consistent utilization across palettes |
| 19 | 18 | Plasma | Consistent utilization across palettes |
| 20 | 18 | Tunnel | Minor fluctuations. Consistent across palettes |
| 21 | 19 | Matrix | Minor fluctuations on some palettes |
| 23 | 22 | Planet | Consistent utilization across palettes |

### Medium (25–50% GPU)

| Max % | Min % | Shader | Notes |
|---|---|---|---|
| 25 | 24 | Fire | Consistent utilization across palettes |
| 29 | 27 | Donut | Consistent utilization across palettes |
| 33 | 31 | Kaleidoscope | Consistent utilization across palettes |
| 35 | 34 | Hypercube | Consistent utilization across palettes |
| 38 | 35 | Tesla | Minor fluctuations. Consistent across palettes |
| 40 | 19 | Mandelbrot | Utilization highest during zoom-in. Consistent across palettes |
| 43 | 19 | Julia | Large consistent fluctuations during loop. Consistent across palettes |
| 45 | 43 | Voronoi | Minor fluctuations. Consistent across palettes |

### Heavy (51–75% GPU)

| Max % | Min % | Shader | Notes |
|---|---|---|---|
| 57 | 55 | Snowfall | Consistent utilization across palettes |
| 70 | 69 | Bezier | Consistent utilization across palettes |
| 70 | 69 | Geometry | Consistent utilization across palettes |
| 70 | 69 | Lissajous | Consistent utilization across palettes |
| 70 | 69 | Marble | Consistent utilization across palettes |
| 70 | 69 | Network | Consistent utilization across palettes |
| 70 | 69 | Starfield | Consistent utilization across palettes |

## Observations

- **No shaders in the Ultra (>75%) tier.** All previously Ultra shaders were optimized by replacing exponential glow effects (`exp(-d²)`) with `smoothstep` hard edges and pre-baking cosine palettes into LUT textures.
- **Palette LUT pre-bake** eliminated the GPU utilization variance between palette types. Hypercube previously swung between 34% (LUT) and 70% (cosine) — now stable at 35% for all palettes.
- **Mandelbrot and Julia** show the widest min-max ranges (19–40% and 19–43%) due to zoom-level-dependent iteration counts. Cardioid/bulb early bailout reduces cost at low zoom.
- **Heavy tier shaders** cluster at the 70% cap. Further optimization is tracked for v0.5.0.
