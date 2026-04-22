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
| ~20–24 | ~16 | Temple | Retro temple interior — centered horizon; floor + ceiling share triangle-wave field (ceiling phase-offset by 3.7); 20 scrolling pillars (5 rows × 4 columns, outer ±4.0, inner ±1.5), 2 faces per pillar (front + inner side face), vertical lines on both faces, cap bars at top/bottom 10% of each pillar, `PILLAR_DRIFT_SCALE=0` removes drift multiply on pillar pixels, `is_pillar` bool skips horizon haze. Round 4: `NUM_ROWS` 3→5 (12→20 pillars), liveness inverted (online brightens toward white via `mix`, offline raw palette), inner side face per pillar (perspective-correct `1/z` depth interpolation). Round 5: side face pattern changed from horizontal rings to vertical lines (`face_u * SIDE_FACE_LINE_DENSITY`); cap bars added to side face matching front face. Expected util: **~20%**, unchanged (1 divide replaced by 1 divide; cap_zone same 3 ops). |

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
- Both circuit and sonar are single-pass with no texture reads in inner loops. Expected to behave well on RDNA wavefront execution.
- Update this file with actual radeontop measurements after v0.4.4 ships and verifies on HawkPoint1.
