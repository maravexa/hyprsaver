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

### Medium (25–50% GPU) — continued

| Max % | Min % | Shader | Notes |
|---|---|---|---|
| ~30–33 | ~20 | Temple | Retro temple interior — centered horizon; floor + ceiling share triangle-wave field (ceiling phase-offset by 3.7); 20 scrolling pillars (5 rows × 4 columns, outer ±4.0, inner ±1.5). Round 9: `hex_visible_faces` removed; inner pillar loop iterates all 6 faces with back-face culling (`dot(normal, -pillar_pos) > 0.02`) determining which ~3 are visible. Fixes right-side pillar geometry — no more selection heuristic to get wrong. Expected util: **~30–33%**, +0–1% from round 8's ~30–32% estimate. Cost delta: +3 cull tests per pillar (3 extra iterations that bail at 5 ops each) = ~300 extra ops/pixel, fraction of a percent on HawkPoint1. |

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
- **Temple estimate basis (round 2 — 3×4 grid, caps, static drift):** Baseline after round-1 fixes: ~17%. Round 2 delta: 12-pillar loop (3× iteration cost from 4→12) partially offset by early-reject efficiency on foreground pixels where the nearest row occludes the rest — net +3–5%. Cap zone: `step` + `mix` = ~3 ALU ops/pillar pixel, negligible at +0–1%. Drift removal: saves one `float * float` mul on pillar pixels, negligible at −0.5%. Total: 17% + 3–5% ≈ **20–24%**. If util exceeds 28%, the pillar loop early-reject is not firing as expected; reduce `NUM_ROWS` to 2 as fallback.
- **Temple estimate basis (round 3 — pillar trace density + thickness + 2× scroll):** `PILLAR_LINE_DENSITY` 1.0→0.5 reduces lines per pillar from ~7 to 3; fewer `fract`+`step` evaluations across the pillar body — slight cost reduction, negligible. `PILLAR_ISOLINE_WIDTH=0.12` adds one ternary select per fragment in the isoline branch — ~1 ALU op, negligible. `SCROLL_SPEED` 0.4→0.8 doubles the constant multiplied into `wz` and `wz_p`; compile-time constant fold means zero runtime cost delta. Net round-3 change: **0%**. Expected util remains **20–24%**.
- **Temple estimate basis (round 4 — density, liveness inversion, 3D side faces):** `NUM_ROWS` 3→5 adds 8 more pillars to the loop (12→20); early-reject fires more aggressively with denser rows so net delta is ~+2% not +5%. Side face per pillar: one additional rect test + perspective `1/z` interpolation (2 divides, 1 mix, ~6 ALU) — ~+2% total across all 20 pillars. Liveness inversion: replaces `float * float` multiply with `mix(col, vec3(1.0), ...)` — same ALU class, ±0%. Total estimated delta: **+4%** from 17% baseline = **~20–24%**, unchanged from round 3.
- **Temple estimate basis (round 6 — structured columns, side face removed):** Side face removal saves the 1/z interpolation block (2 divides + 1 mix + 6 ALU) plus the side face rect test — estimated −2–3%. Zone logic adds: 3 scale multiplies (`sw_base`, `sw_capital`, `sw_bracket`), 1 max, 1 wide rect test, 3-way bool chain, 1 ternary for bracket threshold, and a 3-branch pattern select — estimated +1–2%. Net: ~−1% to −2% from round-5 baseline (~20%). **Expected util: ~18–22%**.
- **Temple estimate basis (round 7 — hex columns, 3 visible faces):** Baseline ~20% from round 6. Delta: hex geometry (3 faces × corner projection + depth interp) +6–10%; trig operations (1 atan + 4 sin + 4 cos per pillar × 20 pillars) +3–5%; early rejection slightly less effective (wider `max_reach` guard) +1–2%; single-face rect test removed −2%. Net ~+8–14%. **Expected util: ~28–34%**. If util exceeds 40%, trig ops are compiling to more ALU than expected on the target driver; consider caching shared hex corners across adjacent face tests.
- **Temple estimate basis (round 8 — back-face culling):** Baseline ~28–34% from round 7. Delta: `hex_face_is_visible()` adds 1 sin + 1 cos + 1 dot per face × 3 faces = ~9 trig-equivalent ops per pillar × 20 pillars = ~180 extra ops/pixel. On HawkPoint1, trig throughput means this is <1% util increase. Net: **~30–32%**, small increase from round 7. If util exceeds 35%, the bool-returning function is evaluating more expensively than expected; consider inlining manually.
- **Temple estimate basis (round 9 — iterate all 6 faces with culling):** Baseline ~30–32% from round 8. `hex_visible_faces` removed; inner pillar loop iterates all 6 faces. The 3 back faces each bail at the first `continue` (~5 ops each) = 3 × 5 × 20 pillars = 300 extra ops/pixel vs round 8. On HawkPoint1, 300 ops is well under 1% util. Net: **~30–33%**. If util exceeds 36%, the GLSL compiler is not optimizing the 6-iteration inner loop well; fallback is manual unroll to 6 face blocks.
- Both circuit and sonar are single-pass with no texture reads in inner loops. Expected to behave well on RDNA wavefront execution.
- Update this file with actual radeontop measurements after v0.4.4 ships and verifies on HawkPoint1.
