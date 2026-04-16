# Benchmark — hyprsaver v0.4.3

## Test Configuration

| Parameter | Value |
|---|---|
| **Device** | GMKtec Nucbox K12 |
| **GPU** | AMD ATI 65:00.0 HawkPoint1 |
| **Monitors** | Dual 1920×1200 |
| **Palette transitions** | 2s crossfade |
| **Mode** | Shader cycle with all palettes |

Results ranked by maximum GPU utilization (%). Tier thresholds: Lightweight <25%, Medium 25–50%, Heavy 51–75%.

v0.4.3 optimized shaders report max % only (visual monitoring). Unchanged shaders carry forward min/max from v0.4.0 radeontop measurements.

## Results

### Lightweight (<25% GPU)

| Max % | Min % | Shader | Notes |
|---|---|---|---|
| 18 | — | Oscilloscope | New benchmark (existed pre-v0.4.0, never benchmarked) |
| 19 | 18 | Caustics | Unchanged from v0.4.0 |
| 19 | 18 | Plasma | Unchanged from v0.4.0 |
| 20 | 18 | Tunnel | Unchanged from v0.4.0 |
| 21 | 19 | Matrix | Unchanged from v0.4.0 |
| 23 | 22 | Planet | Unchanged from v0.4.0 |
| 24 | — | Flames | New shader in v0.4.2 (replaced Fire). Single-layer domain-warped fBm |

### Medium (25–50% GPU)

| Max % | Min % | Shader | Notes |
|---|---|---|---|
| 29 | 27 | Donut | Unchanged from v0.4.0 |
| 32 | — | Snowfall | **Optimized from 57%.** Grid-based spatial lookup replaced 5-layer particle list (100→27 distance checks/pixel) |
| 33 | 31 | Kaleidoscope | Unchanged from v0.4.0 |
| 35 | 34 | Hypercube | Unchanged from v0.4.0 |
| 38 | 35 | Tesla | Unchanged from v0.4.0 |
| 40 | 19 | Mandelbrot | Unchanged from v0.4.0. Wide min-max from zoom-dependent iteration count |
| 43 | 19 | Julia | Unchanged from v0.4.0. Wide min-max from zoom-dependent iteration count |
| 43 | — | Marble | **Optimized from 70%.** Merged glow noise into curl samples, reduced 8→4 steps, smoothstep replaced exp() |
| 43 | — | Network | **Optimized from 70%.** Grid topology replaced random positions + O(n²) distance thresholds. Diagonal connections removed. 35% grid overscan for edge-to-edge coverage |
| 43 | — | Starfield | **Optimized from 70%.** Art-of-Code 20-layer zoom technique replaced particle list. Sparse hash grid, golden-angle rotation, analytical dashed trails |
| 45 | 43 | Voronoi | Unchanged from v0.4.0 |
| 48 | — | Bezier | **Optimized from 70%.** Two-pass coarse+fine distance estimation (128→32 samples/curve) |
| 49 | — | Lissajous | **Optimized from 70%.** Squared distance in loop (deferred sqrt), 192→96 samples. Color cycling bug fixed |
| 50 | — | Aurora | New shader in v0.4.2. Domain-warped FBM + striation ridges |

### Heavy (51–75% GPU)

| Max % | Min % | Shader | Notes |
|---|---|---|---|
| 55 | 35 | Geometry | **Optimized from 70%.** Flat indexed arrays replaced 8-way if-chains. Bounded edge loops, morph-phase skip. 35–40% during solid hold, spikes to 55% during 3s shape transitions |

## Shaders Removed Since v0.4.0

| Shader | Reason |
|---|---|
| Fire | Superseded by Flames in v0.4.2 |
| Vortex | Experimental, curve effect never worked. Deleted in v0.4.2 |
| Wormhole | Deferred to v0.5.0 pending curved tunnel rewrite. Deleted in v0.4.2 |

## Optimization Summary (v0.4.0 → v0.4.3)

| Shader | v0.4.0 | v0.4.3 | Reduction | Technique |
|---|---|---|---|---|
| Snowfall | 57% | 32% | −44% | Grid spatial lookup |
| Geometry | 70% | 35–55% | −21 to −50% | Flat arrays, bounded loops |
| Bezier | 70% | 48% | −31% | Coarse+fine sampling |
| Lissajous | 70% | 49% | −30% | Deferred sqrt, sample reduction |
| Marble | 70% | 43% | −39% | Merged noise, fewer steps |
| Network | 70% | 43% | −39% | Grid topology |
| Starfield | 70% | 43% | −39% | Multi-layer zoom architecture |

**No shaders remain in the Ultra (>75%) tier.** The v0.4.0 Heavy tier cluster at 70% (6 shaders pinned at fill rate ceiling) has been broken — only Geometry remains in Heavy, and only during shape transitions.

## Key Findings

- **Per-pixel particle loops were the #1 GPU killer.** Snowfall, Network, and Starfield all used O(N) per-pixel iteration over global particle/node lists. Replacing with O(1) grid/sector lookups or multi-layer zoom produced the largest gains.
- **GPU branches inside per-pixel loops add overhead on RDNA.** AABB early-bail and squared-distance continue-checks consistently increased or preserved utilization rather than reducing it. SIMD wavefronts cannot skip work unless the entire wavefront agrees.
- **Uniform branches are free.** Morph-phase skip (Geometry), off-screen cull (Starfield), and sparsity threshold checks where all pixels in a cell agree cost zero.
- **The 70% cluster was a fill rate ceiling.** Six unrelated shaders pinning at 69–70% indicated a HawkPoint1 hardware limit. Breaking below it required reducing loop iteration count, not optimizing loop body math.
- **Deferred sqrt is a reliable micro-optimization.** Replacing `length()` with `dot()` for comparison, then `sqrt()` only when needed for smoothstep, helped Lissajous and Bezier by eliminating hundreds of unnecessary sqrt calls per pixel.
- **Multi-layer zoom (Art of Code technique) solved starfield.** 20 thin layers with golden-angle rotation eliminated layer transition popping that plagued all 4–6 layer approaches.

## Observations

- **Palette LUT pre-bake** (from v0.4.0) continues to keep palette-related variance at zero across all shaders.
- **Aurora at 50%** is the most expensive new shader. Domain-warped FBM with per-octave rotation matrices is inherently costly but within Medium tier.
- **Geometry's transition spike (55%)** is inherent to evaluating two shapes' edges simultaneously during the 3s morph window. Acceptable since solid-shape hold is 70% of cycle time at 35–40%.
- **Mandelbrot and Julia** remain the widest min-max shaders (19–40%, 19–43%) due to zoom-dependent iteration counts.
