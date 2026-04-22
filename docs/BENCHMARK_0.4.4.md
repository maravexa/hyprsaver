# Benchmark — hyprsaver v0.4.4

## Test Configuration

| Parameter | Value |
|---|---|
| **Device** | GMKtec Nucbox K12 |
| **GPU** | AMD ATI 65:00.0 HawkPoint1 |
| **Monitors** | Dual 1920×1200 |
| **Palette transitions** | 2s crossfade |
| **Mode** | Shader cycle with all palettes |

Results ranked by maximum GPU utilization (%). Tier thresholds: Lightweight <25%, Medium 25–50%, Heavy 51–75%.

v0.4.4 new and reworked shaders report max % only (visual monitoring). Unchanged shaders carry forward min/max from v0.4.3.

## Results

### Lightweight (<25% GPU)

| Max % | Min % | Shader | Notes |
|---|---|---|---|
| 15 | — | Gridwave | **New in v0.4.4.** 2D screen-space Tron/Outrun grid with lateral + vertical sine warping |
| 18 | — | Oscilloscope | Unchanged from v0.4.3 |
| 18 | — | Terminal | Newly benchmarked (existed pre-v0.4.4) |
| 19 | 18 | Caustics | Unchanged from v0.4.0 |
| 19 | 18 | Plasma | Unchanged from v0.4.0 |
| 20 | 18 | Tunnel | Unchanged from v0.4.0 |
| 21 | 19 | Matrix | Unchanged from v0.4.0 |
| 21 | — | Shipburn | **New in v0.4.4.** Burning Ship Julia variant, julia.glsl-style coloring, +50% animation speed |
| 22 | — | Wormhole | **New in v0.4.4.** 3D raymarched curved tunnel with TunnelCenter sin-wave displacement. PS1 palette quantization applied |
| 23 | 22 | Planet | Unchanged from v0.4.0 |
| 24 | — | Flames | Unchanged from v0.4.2 |

### Medium (25–50% GPU)

| Max % | Min % | Shader | Notes |
|---|---|---|---|
| 25 | — | Clouds | Newly benchmarked (existed pre-v0.4.4) |
| 25 | — | Sonar | **New in v0.4.4.** Rotating sweep gates wavefront visibility; white emitter dots, black backdrop |
| 26 | — | Temple | Newly benchmarked after v0.4.4 geometry tuning |
| 27 | — | Blob | **New in v0.4.4.** Sphere SDF + analytical sin warp, Phong via palette, Fresnel rim, atmospheric halo |
| 29 | 27 | Donut | Unchanged from v0.4.0 |
| 29 | — | Fractaltrap | **New in v0.4.4.** Three-point orbit-trap Julia with three-fold rotational symmetry |
| 32 | — | Snowfall | Unchanged from v0.4.3 |
| 33 | 31 | Kaleidoscope | Unchanged from v0.4.0 |
| 35 | 34 | Hypercube | Unchanged from v0.4.0 |
| 38 | 35 | Tesla | Unchanged from v0.4.0 |
| 43 | 19 | Julia | Unchanged from v0.4.0 |
| 43 | — | Marble | Unchanged from v0.4.3 |
| 44 | — | Circuit | **New in v0.4.4.** Hex-adjacency PCB grid with gradient pulses along traces |
| 45 | 43 | Voronoi | Unchanged from v0.4.0 |
| 48 | — | Bezier | Unchanged from v0.4.3 |
| 49 | — | Lissajous | Unchanged from v0.4.3 |
| 49 | — | Starfield | **Reworked in v0.4.4.** Spawn-time dead zone resolves "stars through viewer" artifact (v0.4.3 carry-forward). Util +6% from v0.4.3 baseline (43%) |
| 50 | — | Aurora | Unchanged from v0.4.2 |

### Heavy (51–75% GPU)

| Max % | Min % | Shader | Notes |
|---|---|---|---|
| 55 | 35 | Geometry | Unchanged from v0.4.3. Transition-spike behavior persists (35–55% during 3s morph) |

## Shaders Removed Since v0.4.3

| Shader | Former tier | Reason |
|---|---|---|
| Mandelbrot | Medium (40% max) | HawkPoint1 architecture unsuited to per-pixel iteration-count variance at animated zoom depth. Fractal slot filled by Shipburn and Fractaltrap Julia variants |
| Network | Medium (43% max) | Plexus/connected-node aesthetic is vertex-native; per-pixel O(n) iteration cannot reach parity with a proper vertex renderer. Replaced by Circuit and Sonar — both fragment-native aesthetics |

## Key Findings

- **2D screen-space grids beat raymarched cube grids for "flying-through-structure" aesthetics.** The gridfly sprint arc burned multiple Claude Code rounds on raymarched grid corridors before pivoting to gridwave's 2D projected grid — same visual read at 15% util vs. 35–40% for the corridor raymarcher. Principle: when an aesthetic goal can be achieved with either raymarching or 2D screen-space math, try 2D first.
- **Raymarching from inside an SDF requires `abs(d) < HIT_EPS`.** The standard `d < HIT_EPS` hit test fires on negative distances when the camera starts inside the surface, producing immediate "miss" terminations that look like solid color at the center of the wormhole. Abs-step march (`t += abs(d)`) also converges faster than sign-following and keeps `t` monotonic.
- **Julia.glsl coloring convention generalizes across Julia variants.** Two palette layers at different cycle rates + time drifts + palette-space offset + pure-black background on escape = predictable, palette-agnostic coloring. Shipburn and Fractaltrap both adopted it and landed at 21% and 29% respectively.
- **Removing angular terms from polar shaders can improve both performance and aesthetic.** Wormhole with arms used `atan` per pixel and rendered as spirals; removing the arm term dropped atan cost and produced the concentric-ring aesthetic that reads as actual wormhole geometry.
- **Commit to diagnostic visualization early in raymarching iteration.** The gridfly arc would have pivoted to gridwave several days sooner if a debug shader had been run after Phase 4 of corridor iteration instead of Phase 8.

## Observations

- **Three of four new fragment-native shaders landed in Lightweight tier** (gridwave 15%, shipburn 21%, wormhole 22%). The fourth — circuit at 44% — sits comfortably in Medium. Sprint strategy of leaning into GPU constraints (PS1/Y2K aesthetic, single-layer approaches) validated.
- **Wormhole at 22% with PS1 quantize is the standout result.** A fully aesthetic-complete raymarched curved tunnel in Lightweight tier — the 3D raymarch pivot produced a cheaper shader than the ~10 failed 2D polar attempts from v0.4.2.
- **Circuit and Sonar read as a matched pair visually but diverge in cost** (44% vs 25%). The per-pixel edge evaluation in Circuit is the cost driver; Sonar's sweep-gating keeps most pixels at zero-cost miss.
- **Blob's atmospheric halo is essentially free** — miss-path `length(cross(ro, rd))` returns before any SDF work. Vibrancy correction on blob (amb=0.7, diff*0.5) lifted the shadow floor so palette colors don't crush to dark variants — worth documenting for future Phong-via-palette shaders.
- **Starfield rework increased util +6%** (43% → 49%). The spawn-time dead-zone check adds per-star work before culling, which doesn't early-out the way the prior center-fade did. Acceptable trade for resolving the "stars through viewer" artifact but worth noting for future reference.
- **Fractaltrap at 29% vs Shipburn at 21%** — the three orbit-trap distance calculations per iteration add meaningful cost vs. Shipburn's two `abs()` calls. Both ship well within Medium-or-better tier.
- **Palette LUT pre-bake** (from v0.4.0) continues to keep palette-related variance at zero across all shaders.
- **Geometry remains the only Heavy-tier shader**, unchanged from v0.4.3.
