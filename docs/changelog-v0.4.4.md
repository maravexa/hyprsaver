# Changelog — v0.4.4

## Mandelbrot Removal & UI Cleanup

### Rationale

The v0.4.4 deep-zoom Mandelbrot effort is abandoned. The HawkPoint1 GPU architecture is fundamentally unsuited to the compound cost of the iteration loop, df32 coordinate arithmetic, and exponential zoom scaling. No per-shader optimization can resolve a hardware-level precision and throughput mismatch at depth ~1e11.

The fractal-aesthetic slot in the roster is instead filled by Julia variants (`shipburn` and `fractaltrap`), added in the subsequent prompt.

### Changes

#### Deleted files
- `shaders/mandelbrot.frag` — original animated Mandelbrot zoom shader
- `shaders/mandelbrot_deep.frag` — abandoned df32 deep-zoom variant
- `src/mandelbrot_deep.rs` — CPU-side state machine (`MandelbrotDeepState`, `CyclePhase`, `FOCAL_POINTS`, `split_f64_to_df32`, `MandelbrotDeepUniforms`)

#### `src/shaders.rs`
- Removed `BUILTIN_MANDELBROT` and `BUILTIN_MANDELBROT_DEEP` constants.
- Removed both entries from the built-in shader roster.

#### `src/main.rs`
- Removed `mod mandelbrot_deep;`.
- Removed `"mandelbrot"` entry from `shader_descriptions()`.

#### `src/wayland.rs`
- Removed `mandelbrot_deep_state` field from `WaylandState`.
- Removed all initialization and per-frame tick logic for the deep-zoom state machine.
- Changed hard-coded `"mandelbrot"` fallback strings to `"julia"`.

#### `src/renderer.rs`
- Removed df32 uniform fields from `UniformLocations`: `u_test_pi_hi`, `u_test_pi_lo`, `u_pi_sq_hi`, `u_pi_sq_lo`.
- Removed mandelbrot_deep uniform fields from `UniformLocations`: `u_focal_real_hi`, `u_focal_real_lo`, `u_focal_imag_hi`, `u_focal_imag_lo`, `u_zoom_t`, `u_initial_extent`, `u_max_iter_deep`, `u_fade`.
- Removed corresponding `md_*` fields from `Renderer`.
- Removed `set_mandelbrot_deep_uniforms()` method.
- Removed df32 precision constant upload block.
- Removed mandelbrot_deep per-frame uniform upload block.
- Removed dead uniform lookups from both `UniformLocations` constructors.

#### `src/preview.rs`
- Removed egui zoom slider from the Display section of the control panel.
- Removed `zoom: f32` field from `PreviewPanelState`.
- Removed `mandelbrot_deep_state` field from `PreviewState` and all associated initialization and per-frame tick logic.
- Removed `zoom` parameter from `save_preview_config()`; no longer writes `zoom_scale` to the config file.

### Shader count after Mandelbrot removal
- Before: 26 built-ins (including mandelbrot, mandelbrot_deep, and the unreferenced df32_nuclear_test framework).
- After Mandelbrot removal: 23 built-ins.

---

## Julia Variants: shipburn & fractaltrap

Two new fractal shaders filling the aesthetic slot left by the removed Mandelbrot.

### shipburn

Burning Ship Julia variant. Uses the same z² + c iteration structure as `julia.frag` but applies `abs()` to both components of z before squaring each step. The absolute-value folding breaks the smooth rotational symmetry of the standard Julia set and produces angular, mirror-symmetric "ship" silhouette shapes — a distinctly different aesthetic from anything else in the roster.

#### Algorithm
- Formula: `z = abs(z)`, then `z = z² + c` (the Burning Ship Julia iteration)
- c orbits near (-1.75, -0.04) with radius 0.15, completing a full cycle in ~126 s at default speed
- MAX_ITER: 150; smooth escape coloring (Inigo Quilez log2-log2 technique)
- Interior pixels: palette(0.0); exterior: palette(clamp(escape_iter / MAX_ITER, 0.0, 1.0))

#### Files
- `shaders/shipburn.frag` — new file

#### src/shaders.rs
- Added `BUILTIN_SHIPBURN` constant (`include_str!("../shaders/shipburn.frag")`)
- Registered `("shipburn", BUILTIN_SHIPBURN)` in the built-in shader roster

#### src/main.rs
- Added `"shipburn"` entry to `shader_descriptions()`

### fractaltrap

Julia set with orbit-trap coloring. Uses the same `z² + c` iteration as `julia.frag` but colors pixels by the minimum distance the orbit passes from a unit circle (the trap shape) rather than by escape iteration count. Both escaping and non-escaping (interior) pixels use the trap distance signal — there is no solid-color interior, which is the defining visual characteristic of orbit-trap coloring.

The result is a stained-glass / cellular / circuit-board aesthetic immediately distinguishable from every other fractal shader in the roster.

#### Algorithm
- Formula: standard Julia z² + c
- c at radius 0.7885 (main cardioid boundary), angular velocity 0.04 rad/s, full cycle ~157 s
- MAX_ITER: 100 (lower than julia.frag; trap signal settles early)
- Trap: circle of radius 1.0; minimum distance tracked over all iterations
- Coloring: `palette(sqrt(clamp(min_trap_dist, 0.0, 1.0)))` for all pixels

#### Files
- `shaders/fractaltrap.frag` — new file

#### src/shaders.rs
- Added `BUILTIN_FRACTALTRAP` constant (`include_str!("../shaders/fractaltrap.frag")`)
- Registered `("fractaltrap", BUILTIN_FRACTALTRAP)` in the built-in shader roster

#### src/main.rs
- Added `"fractaltrap"` entry to `shader_descriptions()`

### Shader count after Julia variants
- Count after Julia variants: 25 built-ins

---

## Network Deletion & circuit + sonar Shaders

### Rationale

`network.frag` produces a plexus / connected-nodes aesthetic — the visual that vertex-based libraries (particles.js, Vanta.js, Three.js line primitives) render at <5% GPU by drawing actual line segments. After three optimization passes the shader still sat at 45–52% GPU util because the fundamental architecture is wrong: per-pixel iteration over O(n) nodes and edges cannot compete with a vertex renderer on this visual.

Continuing to optimize is a losing battle with the architecture. The correct response is to replace it with two aesthetics that are genuinely fragment-native: work that is localized to a small fixed neighbourhood per pixel regardless of scene complexity.

### circuit

Brick-offset grid (staggered rows) with hash-gated traces between cells. Each cell has a solder-pad node; each edge can carry a gradient signal pulse. Produces a PCB / circuit-board-ish network without rectangular-grid feel.

**Why fragment-native:** All work is confined to a 3×3 cell neighbourhood (9 cells, 27 edges). A 4×5 = 20-entry node cache eliminates redundant hash calls. The 20-node array is computed once; the inner loop only reads from it. Per-pixel cost is O(1) regardless of how large the grid extends.

**Algorithm:**
- 8×6 brick-offset grid scrolling diagonally at `SCROLL_VELOCITY`
- Odd rows shift x by 0.5 cell (`mod(cell_id.y, 2.0) * 0.5`) for non-rectangular appearance
- Per-cell jitter via `hash22` places nodes within a 0.35–0.65 cell region
- Three outgoing edges per cell: E, NE, SE; ~55% exist (hash threshold)
- Edge width tapers between endpoint intensities; gradient pulse at `fract(t * 0.25 + e_hash)`
- Single `palette()` call per edge with hash offset for per-edge color variety
- Fast fract hash (Dave Hoskins) throughout — no `sin()`-based hashing

**Expected GPU util:** 20–30% on HawkPoint1.

#### Files
- `shaders/circuit.frag` — new file

#### src/shaders.rs
- Added `BUILTIN_CIRCUIT` constant (`include_str!("../shaders/circuit.frag")`)
- Registered `("circuit", BUILTIN_CIRCUIT)` in the built-in shader roster

#### src/main.rs
- Added `"circuit"` entry to `shader_descriptions()`

### sonar

Multi-source wavefront interference with a rotating radial sweep. Six point emitters trace slow Lissajous paths; each emits expanding cosine rings. The sweep reveals constructive interference peaks as contacts — classic sonar scope behaviour.

**Why fragment-native:** Per-pixel cost is a fixed sum over 6 emitters (no spatial index needed): 6 distance computations, 6 `cos()` ring samples, 6 `exp()` attenuations, 1 `atan()`, 1 `exp()` sweep decay, 6 `exp()` blip contributions. Total ~40 trig-equivalent ops/pixel, constant regardless of scene state.

**Algorithm:**
- 6 emitters on Lissajous paths `(0.6*sin(t*0.08+i*1.237), 0.5*cos(t*0.11+i*2.413))`
- Wave: `cos(d * RING_FREQ - t * WAVE_SPEED + phase)` per emitter, attenuated by `exp(-d * 1.2)`
- Normalised wave sum prevents brightness drift across emitter configurations
- Sweep: `exp(-recency * 6.0)` exponential trailing decay; `recency = mod((sweep_angle - pixel_angle)/TAU + 1.0, 1.0)`
- Sweep **multiplies** the existing wave pattern rather than overpainting it — contacts are the waves, the sweep just reveals them
- Blips: `exp(-d * 35.0)` tight bright points at each emitter position
- Fast fract hash (Dave Hoskins) — included for completeness, used in hash22 only if future variants need it

**Expected GPU util:** 20–30% on HawkPoint1.

#### Files
- `shaders/sonar.frag` — new file

#### src/shaders.rs
- Added `BUILTIN_SONAR` constant (`include_str!("../shaders/sonar.frag")`)
- Registered `("sonar", BUILTIN_SONAR)` in the built-in shader roster

#### src/main.rs
- Added `"sonar"` entry to `shader_descriptions()`

### Deleted

- `shaders/network.frag` — removed entirely. Architecture mismatch: plexus aesthetic is vertex-native, not fragment-native. Three optimization passes failed to bring it below Medium-Heavy boundary at 45–52%.

#### src/shaders.rs
- Removed `BUILTIN_NETWORK` constant
- Removed `("network", BUILTIN_NETWORK)` from the built-in shader roster

#### src/main.rs
- Removed `"network"` entry from `shader_descriptions()`

### Shader count after network → circuit + sonar pivot
- Before: 25 built-ins (network present)
- After: 26 built-ins (network removed, circuit + sonar added — net +1)

---

## waves — Retro Horizon Shader

First member of the planned "retro playlist" sub-group. Flat-plane perspective
inverse producing a 2D-over-horizon wave field — no raymarching, no normals,
no lighting model. The retro aesthetic is produced by *doing less*: triangle
waves instead of sin, hard-step isolines instead of smoothstep AA, posterized
palette quantization, CRT scanlines. Each choice is also a cost win on RDNA.

Replaces the discarded Seascape (TDM, 2014) port which would have pegged
HawkPoint1 at 100%+ (32-step raymarched 3D heightfield, 5-octave FBM normals,
sin-based hashing — architectural mismatch identical to the deleted `network`
shader).

### Algorithm

- Perspective: `z = min(1.0 / max(HORIZON - uv.y, 1e-3), Z_MAX)` — one divide,
  one min, one max. Z_MAX cap prevents unbounded wave frequencies near the
  horizon line that would otherwise moire.
- Wave field: sum of 3 triangle waves in perspective-mapped world
  coordinates `(wx, wz)` where `wx = (uv.x - 0.5) * z * WAVE_STRETCH_X` and
  `wz = z + t * SCROLL_SPEED`. Triangle wave is ~2× cheaper than `sin` on
  RDNA and its harmonic content reads as "textured" rather than "smooth swell."
- Isolines: `step(0.5 - ISOLINE_WIDTH, abs(fract(h * ISOLINE_COUNT) - 0.5))`
  — hard-edged, intentionally aliased at crossings of `h * ISOLINE_COUNT`.
  Subpixel shimmer in motion is the feature.
- Palette coordinate quantized with `floor(pc * POSTERIZE) / POSTERIZE` to
  produce discrete color bands that crawl as the field scrolls.
- Haze: `1.0 - smoothstep(HORIZON - HAZE_START, HORIZON - HAZE_END, uv.y)`
  fades waves to black approaching the horizon line AND zeros out the
  above-horizon region (pure black "sky").
- Scanlines: `1.0 - SCANLINE * step(0.5, fract(gl_FragCoord.y / SCANLINE_PERIOD))`
  in screen-space, unaffected by the optional PIXEL_SIZE snap.
- Optional PIXEL_SIZE fragment snap (default 1.0 = off) for PS1-style
  low-res look. Quantizes `gl_FragCoord.xy` before perspective math.

No hashing. The wave field is fully deterministic from `(wx, wz)` — the
retro aesthetic comes from regularity, not noise.

### Expected GPU util

18–25% on HawkPoint1. Lightweight tier — cheapest shader added in v0.4.4.

### Files
- `shaders/waves.frag` — new file

#### src/shaders.rs
- Added `BUILTIN_WAVES` constant (`include_str!("../shaders/waves.frag")`)
- Registered `("waves", BUILTIN_WAVES)` in the built-in shader roster
- Updated `test_builtin_shader_count` from 28 → 29
- Added `"waves"` to `test_builtin_names` list

#### src/main.rs
- Added `"waves"` entry to `shader_descriptions()`

#### README.md
- Incremented built-in shader count 25 → 26
- Added `waves` row to the built-in shader table
- Added `Waves` to the Lightweight tier list in GPU Performance section

#### docs/benchmark-v0.4.4.md
- Added Lightweight-tier entry for Waves (~18–25% estimate)
- Added "Waves estimate basis" note

### Shader count after waves
- Before: 26 built-ins
- After: 27 built-ins

### Future work (not part of this change)

- A roster-metadata aesthetic-tag system to support curated playlists
  (enabling the planned "retro" sub-group that will include `waves`,
  `terminal`, `oscilloscope`, and future additions) is a candidate for
  v0.5.0. Not built here.
- Starfield center dead-zone (carry-forward from v0.4.3) remains the final
  open v0.4.4 task.

---

## waves — Offline-Band Mechanism + Distance Fog

Two focused tweaks to `shaders/waves.frag`. No other files changed.

### Offline/online band mechanism

Previously, some palettes happened to produce bright-and-dark traces because
they contained dark bands in their gradient. On palettes that don't, all traces
rendered at uniform brightness and the retro "network trace" reading was lost.

The mechanism is now built in: a deterministic per-band liveness hash controls
whether each posterized band renders at full brightness ("online") or at a
configurable floor brightness ("offline"). The hash is `fract(band_idx * 0.375)`
compared against `OFFLINE_RATIO` via `step` — no branches, no trig, no noise.

Because the palette coordinate drifts continuously (`pc_raw` includes `t *
PALETTE_DRIFT`), the band_idx for any given pixel changes over time, so traces
cycle between online and offline states as the wave field scrolls. The pattern
is deterministic and globally coherent — all pixels in the same band share the
same liveness.

**New constants:**
- `OFFLINE_FLOOR = 0.25` — offline band brightness floor (0 = black, 1 = no dimming)
- `OFFLINE_RATIO = 0.4` — ~60% of bands online, ~40% offline
- `OFFLINE_HASH = 0.375` — band-to-liveness multiplier (period 8 bands; avoid 0.5, 0.25)

**Implementation change:** The single-step posterize (`floor(pc * POSTERIZE) / POSTERIZE`)
is split into two steps so the integer `band_idx` is accessible for the hash.
The quantized palette coordinate (`band_idx / POSTERIZE`) feeds the palette
sample unchanged — on-band visual output is identical to before.

### Exponential distance fog

Retro-era depth cue: `fog = exp(-z * FOG_DENSITY)`. Multiplied onto the
composed color before the horizon haze and scanline overlay.

Primary purpose is aesthetic depth reinforcement. Secondary benefit: the
near-horizon region (where sub-pixel wave frequencies produce shimmering
aliases) is crushed toward black by the fog before the haze completes the
fade — the shimmer becomes imperceptible before it would otherwise read as
interference.

Fog fades toward black (`FOG_FLOOR = 0.0`) because the sky is pure black;
fog-to-black produces a seamless foreground → horizon → sky gradient. Scanlines
are applied after fog, as they are a screen-space CRT overlay not subject to
perspective depth.

**New constants:**
- `FOG_DENSITY = 0.12` — falloff rate per unit of z; `exp(-20 * 0.12) ≈ 0.09`
- `FOG_FLOOR = 0.0` — full fog fades to black

**GPU cost:** One `exp()` per pixel added. Expected delta +0–2% from pre-tweak
baseline (~18–25%); new estimate ~18–27%. Still Lightweight tier.

### Compose order (unchanged semantics, clarified structure)

```
fragColor = col * liveness * lines * fog * fade * scan
```

- `col * liveness` — posterized palette color with online/offline dimming
- `* lines` — isoline mask (0 or 1 hard-step)
- `* fog` — per-pixel exponential depth attenuation
- `* fade` — horizon haze (y-based smoothstep, kills above-horizon pixels)
- `* scan` — CRT scanline overlay (screen-space, unaffected by fog)

---

## waves — Palette Hash + Brightness Clamps

Two focused color-behavior tweaks to `shaders/waves.frag`. No other files changed.

### Problem

The shader previously passed palette colors through unchanged, so aesthetic
quality depended entirely on palette character. Dark palettes (`midnight`)
rendered near-black — traces invisible. Bright palettes (`marsha`, pride flags)
washed out. Narrow-hue palettes that only span a small region of the gradient
showed only 1–2 distinct colors simultaneously because sequential band
indexing sampled adjacent palette regions.

### Palette position hashing

Previously the palette coordinate was `band_idx / POSTERIZE` — sequential
sampling that clusters adjacent bands into adjacent palette regions. On
segmented palettes (marsha pink/white/blue, pride flag colors), adjacent
regions can all land in the same color block, producing a near-monochrome
scene.

Now: `fract(band_idx * PALETTE_HASH)` where `PALETTE_HASH = 0.618` (golden
ratio). For any N consecutive `band_idx` values the hashes fill [0, 1] as
uniformly as possible — optimal equidistribution for integer sequences. All
flag colors (or palette regions) appear simultaneously on screen.

`POSTERIZE` is retained unchanged as the quantization granularity (band width
in `pc_raw` space). Its previous role as "palette cycle length" is superseded
by the hash.

**New constant:**
- `PALETTE_HASH = 0.618` — golden-ratio hash; optimal irrational for equidistributed sequences

### Brightness clamps

Per-channel `clamp` applied **after** the liveness multiply:

```glsl
col = clamp(col, vec3(MIN_TRACE_BRIGHTNESS), vec3(MAX_TRACE_BRIGHTNESS));
```

Clamp order is deliberate: placing it after liveness means offline traces on
dark palettes still reach the `MIN_TRACE_BRIGHTNESS` floor (offline × palette
could be near zero on midnight; post-liveness clamp lifts it). Placing it
before would leave offline traces at 0.08 × 0.25 = 0.02 (near-invisible). The
tradeoff is that online/offline contrast weakens on very dark palettes — online
and offline both converge toward the floor — but visibility wins over contrast.

Per-channel clamp (not luminance) intentionally preserves simplicity: one
`max` + one `min` per channel vs. `dot` + `divide` for luminance. The palette
set has no pure primaries where hue-shift from per-channel clamping would be
visible. If it becomes an issue on a specific palette, lower `MAX_TRACE_BRIGHTNESS`
toward 1.0 rather than switching clamp type.

**New constants:**
- `MIN_TRACE_BRIGHTNESS = 0.08` — per-channel floor; dark palettes remain visible
- `MAX_TRACE_BRIGHTNESS = 0.85` — per-channel ceiling; bright palettes don't wash out

### GPU cost

Hash: replaces one divide with one multiply — slight cost reduction. Clamp:
~6 ALU ops (3× max + 3× min on RDNA; no branches). Expected delta ±1% from
the 16% pre-tweak measurement. Updated benchmark estimate: 16–18% max.

---

## waves — Hash Decorrelation + Luminance-Preserving Ceiling

Two root-cause fixes to `shaders/waves.frag`. No other files changed.

### Problem 1: Bright palettes wash out on per-channel MAX clamp

Per-channel `clamp(col, MIN, MAX)` desaturates colors whose brightest channel
exceeds `MAX_TRACE_BRIGHTNESS`. On marsha (pink/white/blue), pink became
muted-grey-pink, white became pure grey, blue became muted blue — the saturation
was being destroyed proportionally to how bright each color was.

A luminance-preserving scale (`col *= MAX / max_channel` when `max_channel > MAX`)
scales all three channels uniformly. The ratio between channels is preserved, so
hue and saturation are preserved. White still goes grey (it has zero saturation
by definition — unavoidable), but every non-white color retains its hue under
the scale.

### Problem 2: Online/offline color variety asymmetric (structural bias)

`OFFLINE_HASH = 0.375 = 3/8` is rational, producing a strict period-8 cycle
over integer `band_idx`. With `OFFLINE_RATIO = 0.4`, ~60% of bands are online.
The online set in each period-8 block is a fixed subset: `band_idx mod 8 ∈ {2, 4, 5, 7}`.

Evaluating `PALETTE_HASH = 0.618` at those exact online positions:

```
band_idx mod 8:      2     4     5     7
palette position: .236  .472  .090  .326
```

Every online palette position is below 0.5. The offline positions land at
`{0.0, 0.618, 0.854, 0.708, 0.944, 0.562}` — nearly all above 0.5. On
segmented palettes (marsha: pink 0–0.33, white 0.33–0.67, blue 0.67–1.0),
online bands are mathematically excluded from the blue region entirely.
Consistently 2 online colors vs 3 offline colors — not random variance.

**Fix:** `OFFLINE_HASH = 0.4142` (≈ √2 − 1, irrational). An irrational
multiplier produces no period over integer `band_idx`, so the online subset
is not a fixed mod-8 slice. Its intersection with `PALETTE_HASH` is no
longer structurally biased; palette positions become uniformly distributed
across both online and offline bands.

`PALETTE_HASH` is not changed — the golden-ratio value `0.618` remains
mathematically optimal for palette equidistribution.

### Constant changes

| Constant | Old | New | Reason |
|---|---|---|---|
| `OFFLINE_HASH` | `0.375` | `0.4142` | Break period-8 correlation with `PALETTE_HASH` |
| `MAX_TRACE_BRIGHTNESS` | `0.85` | `0.70` | More aggressive ceiling, now safe because luminance-preserving scale no longer desaturates |

### Implementation change (brightness ceiling)

Replaced:
```glsl
col = clamp(col, vec3(MIN_TRACE_BRIGHTNESS), vec3(MAX_TRACE_BRIGHTNESS));
```

With:
```glsl
col = max(col, vec3(MIN_TRACE_BRIGHTNESS));
float max_channel = max(max(col.r, col.g), col.b);
col *= min(1.0, MAX_TRACE_BRIGHTNESS / max(max_channel, 1e-4));
```

MIN floor remains per-channel (intentional — preserves hue above floor, lifts
dim colors to neutral grey below it; visibility over hue fidelity on dark
palettes). MAX ceiling switches to luminance-preserving scale.

MIN is applied before MAX so the max-channel computation sees post-floor values.
On dim palettes where the floor raises channels, max-channel reflects the actual
brightest visible channel after lifting — reversing the order would produce
inconsistent floor behavior.

### GPU cost

`OFFLINE_HASH` constant change: zero GPU cost. Luminance-preserving ceiling:
2× `max` + 1 `min` + 1 `divide` + 1 `mul` ≈ 4 ALU ops, replacing the prior
6 ALU per-channel clamp (3× max + 3× min). Net slight reduction. Expected
delta from 16–18% baseline: ±1%.

---

## waves → temple — Ceiling Mirroring and Scrolling Pillars

`shaders/waves.frag` renamed to `shaders/temple.frag`. Shader body fully
replaced. All other files updated to reflect the rename. Shader count unchanged
(rename, not addition).

### What changed

**Renamed:** `waves` → `temple` across all source files and documentation.

**Horizon recentered:** `HORIZON` moved from `0.68` to `0.5`. Floor takes the
bottom half of the screen; ceiling takes the top half. Previously the horizon
sat near the top third, leaving a narrow sky band.

**Ceiling added:** Pixels above the horizon (`uv.y > HORIZON`) now render the
same triangle-wave field as the floor, using mirrored perspective math:
`z = 1 / (uv.y - HORIZON)`. A `CEILING_PHASE_OFFSET = 3.7` is added to the
ceiling's `wz` so the ceiling pattern is visually distinct from the floor —
not a mirror reflection.

**Pillars added:** 4 scrolling pillars rendered as screen-space rectangles.
Each pillar is placed at an evenly-spaced base depth with a fract-hashed x
position (`fract(fi * 0.7213 + 0.137)`, no `sin`). Pillars scroll toward the
viewer via `mod(wz_base - t * SCROLL_SPEED, PILLAR_CYCLE_DEPTH)` and wrap
smoothly at `PILLAR_CYCLE_DEPTH = 24`. The pillar loop uses early `continue`
to reject pillars further than the current nearest candidate; the initial
threshold is `z_surface` so only pillars in front of the floor/ceiling render.

**Pillar vertical extent:** Each pillar's screen-rect spans `±1/wz_p` from the
horizon, which is exactly where `z_surface = wz_p`. This means pillar top/bottom
edges coincide with the floor/ceiling surface at the same depth — no explicit
z-clipping needed, no seam.

**Pillar trace pattern:** Linear in `pillar_v` (world-height coordinate) produces
regularly-spaced horizontal rings. A time term scrolls the rings; a `tri()`-based
u-wobble adds subtle horizontal variation. This feeds into the same isoline
detection as the floor/ceiling.

**Unified color pipeline:** All three surface types (floor, ceiling, pillar) feed
into the same `h_render → isoline → palette → liveness → clamp → fog → haze → scanline`
pipeline. Pillars inject a per-pillar `color_offset` so each pillar samples a
distinct palette region. The `+1` in `(float(i) + 1.0) * PILLAR_COLOR_SHIFT`
ensures pillar 0 is offset from the surface (which has `color_offset = 0.0`).

**Haze updated:** Previously computed as `1 - smoothstep(HORIZON - START, HORIZON - END, uv.y)`,
which only faded the floor side. Now computed as `smoothstep(HAZE_END, HAZE_START, abs(uv.y - HORIZON))`,
which symmetrically fades both floor and ceiling near the horizon.

**Fog:** Now uses `z_render` (the depth of whichever surface — floor, ceiling, or
pillar — is rendered at this pixel) rather than always the surface depth. Near
pillars fog less; far pillars fog more. Correct depth-cue behavior.

### Files changed

- `shaders/waves.frag` → `shaders/temple.frag` (git mv; content fully replaced)
- `src/shaders.rs` — `BUILTIN_WAVES` → `BUILTIN_TEMPLE`; `include_str!` path updated;
  roster entry `("waves", …)` → `("temple", …)`; `test_builtin_names` list updated
- `src/main.rs` — `shader_descriptions()` entry updated
- `CLAUDE.md` — shader table row, roadmap entry, and new-shaders list updated
- `README.md` — shader feature row updated; GPU tier lists updated (temple moves from
  Lightweight to Medium tier due to pillar loop overhead)
- `docs/benchmark-v0.4.4.md` — waves entry replaced with temple entry
- `docs/changelog-v0.4.4.md` — this entry

### New constants

| Constant | Value | Purpose |
|---|---|---|
| `HORIZON` | `0.5` | Recentered (was 0.68) |
| `CEILING_PHASE_OFFSET` | `3.7` | Ceiling wz offset to distinguish from floor |
| `NUM_PILLARS` | `4` | Number of scrolling pillars |
| `PILLAR_RADIUS` | `0.3` | World radius |
| `PILLAR_NEAR_CLIP` | `1.0` | Minimum visible depth |
| `PILLAR_CYCLE_DEPTH` | `24.0` | Wrap period for pillar scroll |
| `PILLAR_RING_DENSITY` | `1.0` | Ring spacing along pillar length |
| `PILLAR_SCROLL_SPEED` | `0.3` | Ring animation speed |
| `PILLAR_COLOR_SHIFT` | `0.37` | Palette offset per pillar index |
| `PILLAR_UV_VARIATION` | `0.2` | U-direction wobble amplitude |
| `HAZE_START` | `0.08` | Now abs-distance from horizon (symmetric) |
| `HAZE_END` | `0.02` | Now abs-distance from horizon (symmetric) |

### GPU cost estimate

Baseline (waves): 16–18% max. Delta:
- Ceiling branch: ~+1% (shared math, single bool + float add)
- Pillar loop (4 iterations, early reject): ~+5–10%
- Pillar pixels (same color pipeline, additional screen area): ~+2–3%

Estimated: **22–30% max, Medium tier**. Pending HawkPoint1 verification.

---

## temple — Pillar Fixes (Fixed Layout, Vertical Trace Pattern, No Haze on Pillars)

Three separation-of-concerns fixes to `shaders/temple.frag`. No other files changed.

### Fixed corridor layout

`pillar_wpos()` previously placed pillars at fract-hashed x positions, which could
land near 0 and produce centered pillars that filled the screen at close range.
Replaced with a deterministic two-pair corridor layout:

- Outer pair (indices 0/1): x = ±`PILLAR_X_OUTER` (3.5), phase 0
- Inner pair (indices 2/3): x = ±`PILLAR_X_INNER` (1.0), phase `PILLAR_CYCLE_DEPTH * 0.5`

Paired z-phase staggering means outer and inner pairs approach the viewer
alternately, producing a clear architectural rhythm rather than chaotic
one-at-a-time arrival.

**Constants removed:** `PILLAR_RING_DENSITY`, `PILLAR_SCROLL_SPEED`, `PILLAR_UV_VARIATION`

**Constants added:**
- `PILLAR_X_INNER = 1.0` — inner pair x position (viewer walks between these)
- `PILLAR_X_OUTER = 3.5` — outer pair x position (perspective framing)
- `PILLAR_LINE_DENSITY = 1.0` — vertical line density on pillar surface

### Vertical trace pattern

`h_render` for pillar pixels was computed as `pillar_v * RING_DENSITY + t * SCROLL_SPEED + PILLAR_UV_VARIATION * tri(pillar_u * 2.0)`, producing horizontal scrolling rings — the wrong geometry for "vertical circuit traces."

Replaced with `h_render = pillar_u * PILLAR_LINE_DENSITY`. No `pillar_v`, no `t` dependency: lines stay fixed on the pillar surface. Palette drift over time still cycles colors through the lines (circuit signal flow), but line positions don't move.

### No haze on pillars

Horizon haze (`smoothstep` on abs distance from horizon) is a surface-specific
depth cue for floor/ceiling pixels where `z_surface → ∞` near the horizon.
Applied to pillars, it produced a dark band across each pillar's vertical midpoint.

Added `bool is_pillar = false` before the pillar loop; set to `true` inside the
hit branch. Haze term: `fade = is_pillar ? 1.0 : smoothstep(HAZE_END, HAZE_START, abs_dist_h)`.

Pillar depth dimming continues to be handled by existing distance fog (`exp(-z_render * FOG_DENSITY)`), which is the correct depth cue for a 3D vertical object.

### Files changed

- `shaders/temple.frag` — `pillar_wpos()` replaced; pillar hit-branch `h_render` formula replaced; `is_pillar` bool added; haze conditional on `is_pillar`

### GPU cost

Computationally neutral: same number of pillar checks; fixed x arithmetic replaces
fract hash at identical ALU count; one-mul `h_render` replaces three-term sum;
`is_pillar` bool select on haze is ~0 ops on RDNA wavefront execution. Expected
util: **~17%, unchanged**.

---

## temple — Pillar Round 2 (3 rows × 4 columns, cap bars, static pillar colors)

Three targeted improvements to `shaders/temple.frag`. No other files changed.

### Flicker elimination — static pillar colors

`pc_raw` previously included `t * PALETTE_DRIFT` unconditionally. For pillar pixels,
every pixel of a given vertical line shares identical `pc_raw` (no per-pixel spatial
variation in h or z along a pillar line), so every pixel in that line crosses palette
band boundaries simultaneously — producing a whole-line palette flash perceived as
flicker during approach.

Added `PILLAR_DRIFT_SCALE = 0.0` constant and conditional drift term:

```glsl
float drift_mul          = is_pillar ? PILLAR_DRIFT_SCALE : 1.0;
float drift_contribution = t * PALETTE_DRIFT * drift_mul;
```

Floor and ceiling are unaffected: surface pixels have per-pixel `h` and `z`
variation, so band boundary crossings are spatially distributed rather than
simultaneous. `drift_mul = 1.0` for surface pixels; `drift_mul = 0.0` for pillar
pixels (default).

Pillar color variety is preserved through `color_offset = (float(i) + 1.0) * PILLAR_COLOR_SHIFT`
— 12 pillars simultaneously show 12 different palette positions. Spatial variety
replaces temporal variety.

### Pillar grid expansion — 3 rows × 4 columns (12 pillars)

Replaced the 2-pair (4-pillar) layout with a 3-row × 4-column grid:

| Constant | Old | New | Notes |
|---|---|---|---|
| `NUM_PILLARS` | `4` (literal) | `NUM_PILLARS_PER_ROW * NUM_ROWS = 12` | Derived |
| `NUM_PILLARS_PER_ROW` | — | `4` | New |
| `NUM_ROWS` | — | `3` | New |
| `PILLAR_X_INNER` | `1.0` | `1.5` | Wider central walkway |
| `PILLAR_X_OUTER` | `3.5` | `4.0` | Pushed further to screen edges |

Column layout per row: outer-left (−4.0), inner-left (−1.5), inner-right (+1.5), outer-right (+4.0).

Row z-phase: `float(row) * PILLAR_CYCLE_DEPTH / float(NUM_ROWS)`, distributing rows evenly through the scroll cycle. Three depth layers visible simultaneously.

`pillar_wpos()` uses integer division + subtract (`col = i - row * NUM_PILLARS_PER_ROW`) rather than `%` for portability across GLSL ES drivers that may produce slower code for integer modulo in loops.

### Cap bars — horizontal bus-bars at pillar top and bottom

Each pillar now has a solid horizontal band at its top and bottom 10% (where it meets
the ceiling and floor surfaces). This gives a visual anchor — pillars "land" on the
floor and meet the ceiling, reading as an architectural connection.

Implementation: `pillar_v = dist_h * wz_p` maps `[−1, +1]` across the pillar's
vertical extent (floor edge to ceiling edge). The cap zone is detected with
`step(1.0 - PILLAR_CAP_WIDTH, abs(pillar_v))`. Inside the cap, `h_render` is
overridden to `PILLAR_CAP_H_VALUE = 0.0` (an isoline-aligned value, producing a
solid lit bar). Outside the cap, `h_render` remains `pillar_u * PILLAR_LINE_DENSITY`
as before. A `mix()` blends between the two based on `cap_zone`.

`PILLAR_CAP_H_VALUE` must be `n / ISOLINE_COUNT` for integer `n`. `0.0` satisfies
this (`0 × 3 = 0`). Non-aligned values (e.g., `0.5`) land between isolines and
render as empty/black.

New constants:
- `PILLAR_CAP_WIDTH = 0.1` — 10% of pillar length at each end
- `PILLAR_CAP_H_VALUE = 0.0` — isoline-aligned constant; cap renders as solid bar

### Files changed

- `shaders/temple.frag` — constant block; `pillar_wpos()` replaced; pillar hit-branch
  updated with `pillar_v`, `cap_zone`, `mix`; `pc_raw` computation updated with
  `drift_mul` and `drift_contribution`
- `docs/benchmark-v0.4.4.md` — Temple entry updated: expected util 20–24% (up from 17%)
- `docs/changelog-v0.4.4.md` — this entry

### GPU cost

Delta from 17% baseline: +3–5% from 3× pillar loop iterations (partially offset by
early-reject on occluded rows); +0–1% from cap zone `step` + `mix`; −0.5% from
removed drift multiply on pillar pixels. **Expected util: 20–24%, Medium tier**.

---

## temple — Pillar Round 3 (Trace Density + Thickness + 2× Scroll)

Three targeted changes to `shaders/temple.frag` to suppress spatial aliasing flicker on pillar vertical traces. No other files changed except benchmark and changelog docs.

### Problem

Remaining flicker on pillar traces is *spatial*, not temporal. As a pillar scrolls, `sx` and `sw` shift, which causes `pillar_u` for any fixed screen pixel to change over time. Thin lines (~1–4 pixels wide) sweep across pixels fast enough that each pixel alternates on/off visibly.

### Changes

**1. Reduced pillar line density (`PILLAR_LINE_DENSITY` 1.0 → 0.5)**

Fewer lines per pillar means fewer on/off transitions per pixel per scroll cycle. At `K = 0.5`, `h_render = pillar_u * 0.5` ranges over `[−0.5, +0.5]`, yielding exactly three isolines at `h = 0, ±1/3` (pillar_u ≈ `0, ±0.667`). No lines at pillar edges (u = ±1) — clean pillar body with three interior traces.

**2. Added `PILLAR_ISOLINE_WIDTH = 0.12` (surface `ISOLINE_WIDTH` unchanged at 0.06)**

Each pillar trace now covers more pixels per scroll sweep; a given pixel spends more time inside a line as it passes. Isoline detection updated to select width by surface type:

```glsl
float iso_width = is_pillar ? PILLAR_ISOLINE_WIDTH : ISOLINE_WIDTH;
float edge      = abs(fract(h_render * ISOLINE_COUNT) - 0.5);
float lines     = step(0.5 - iso_width, edge);
```

Floor and ceiling isolines remain at `ISOLINE_WIDTH = 0.06` — the surface aesthetic is unchanged.

**3. Doubled scroll speed (`SCROLL_SPEED` 0.4 → 0.8)**

Governs both surface wave scroll (`wz = z + t * SCROLL_SPEED`) and pillar approach (`wz_p = mod(phase - t * SCROLL_SPEED, ...)`). Unified constant keeps pillars and surface waves synchronized. The corridor now has a "pacing" rather than "strolling" feel; a new pillar row approaches roughly every 10 s.

### Constants changed

| Constant | Old | New | Effect |
|---|---|---|---|
| `SCROLL_SPEED` | `0.4` | `0.8` | 2× corridor approach and wave drift speed |
| `PILLAR_LINE_DENSITY` | `1.0` | `0.5` | 3 vertical lines per pillar (was ~7) |

### Constants added

| Constant | Value | Purpose |
|---|---|---|
| `PILLAR_ISOLINE_WIDTH` | `0.12` | Pillar-only isoline thickness; doubles surface width to suppress sweep-aliasing |

### Files changed

- `shaders/temple.frag` — constant block; isoline detection block
- `docs/benchmark-v0.4.4.md` — Temple entry and estimate note updated
- `docs/changelog-v0.4.4.md` — this entry

### GPU cost

Round 3 is cost-neutral: fewer isoline evaluations (3 lines vs ~7); one ternary select for `iso_width` (~1 ALU op); `SCROLL_SPEED` constant doubling is folded at compile time. **Expected util: 20–24%, unchanged**.

---

## temple — Pillar Round 4 (Density + Liveness Inversion + 3D Inner Side Face)

Three changes to `shaders/temple.frag`. No other files changed except benchmark and changelog docs.

### Density — 20 pillars (5 rows × 4 columns)

`NUM_ROWS` increased from 3 to 5, bringing total visible pillars from 12 to 20. Row z-phases remain evenly distributed through `PILLAR_CYCLE_DEPTH`, so all 5 rows are visible simultaneously in the corridor. The denser grid produces a "corridor of columns" feel vs. the sparser 3-row layout. Early-reject (`wz_p + PILLAR_RADIUS >= best_pillar_z`) fires more aggressively with denser rows, partially offsetting the loop cost.

### Liveness inversion — online brightens, offline raw

Semantics flipped from all previous rounds:

| Round | Offline | Online |
|---|---|---|
| 1–3 | raw palette × `OFFLINE_FLOOR` (dimmed) | raw palette (undimmed) |
| 4 | raw palette (undimmed) | `mix(col, vec3(1.0), ONLINE_BRIGHTEN)` |

**Why this reads better:** In rounds 1–3, `OFFLINE_FLOOR = 0.25` dimmed ~60% of bands to 25% brightness — on most palettes, the majority of the corridor was dark. The "online" (minority) bands were the only palette-colored pixels; the rest was near-black. With inversion, the quiescent corridor wire is the full palette color, and signal-carrying bands brighten toward white. Reads as "circuit lighting up" rather than "lights mostly off."

**Why `mix` toward white, not multiplicative boost:** `col * (1.0 + BOOST)` pushes channels above 1.0 and the luminance-preserving ceiling clamp desaturates them. `mix(col, vec3(1.0), ONLINE_BRIGHTEN)` at `ONLINE_BRIGHTEN = 0.6` maps `(0.2, 0.2, 0.8)` → `(0.68, 0.68, 0.92)` — light blue, still visibly blue, no channel clip.

**Constants removed:** `OFFLINE_FLOOR` — no longer meaningful.

**Constants added:**
- `ONLINE_BRIGHTEN = 0.6` — blend factor toward white for online bands.

### 3D inner side face per pillar

Each pillar now renders two faces:

**Front face** (existing): screen-space rect at depth `wz_p`, vertical trace pattern `pillar_u * PILLAR_LINE_DENSITY`.

**Inner side face** (new): the face on the corridor-centerline side of the pillar. For right-side pillars (`wx_p > 0`), this is the left face; for left-side pillars (`wx_p < 0`), this is the right face. The face spans world-z from `wz_p - PILLAR_RADIUS` (near corner) to `wz_p` (far corner) and projects to a screen-space quad between the two perspective-mapped x positions.

**Perspective correctness:** Screen-space x maps to world-z via linear interpolation of `1/z` (inverse depth). This is the standard perspective-correct attribute interpolation: a world-space line projects to a screen-space segment where attributes interpolated linearly in `1/z` correspond to uniform world-space sampling. Horizontal rings in world-z appear at the correct non-uniform screen spacing (close rings wider, far rings narrower).

**Pattern:** Side face uses `z_here * SIDE_FACE_RING_DENSITY` as `h_render` — horizontal rings fixed in world space. These rings parallax-scroll as the viewer advances, distinct from the front face's vertical static lines. Cap logic identical to front face.

**Color offset:** `color_offset` for side face pixels adds `SIDE_FACE_COLOR_SHIFT = 0.19` on top of the pillar's own `(float(i) + 1.0) * PILLAR_COLOR_SHIFT`. The offset samples a slightly different palette region, making front and side faces subtly different in hue — emphasizing the "separate plane" reading.

**Early reject:** Changed from `wz_p >= best_pillar_z` to `wz_p + PILLAR_RADIUS >= best_pillar_z` to conservatively account for the side face's near edge at `wz_p - PILLAR_RADIUS`.

**Near-clip guard:** Side face test gated on `wz_near > PILLAR_NEAR_CLIP * 0.5`. Threshold below `PILLAR_NEAR_CLIP` keeps the side face visible as a pillar passes close — exactly when the parallax effect is most dramatic.

**Constants added:**
- `SIDE_FACE_RING_DENSITY = 0.8` — horizontal ring frequency per unit world-z.
- `SIDE_FACE_COLOR_SHIFT = 0.19` — palette offset to distinguish side from front face.

### Files changed

- `shaders/temple.frag` — constant block; liveness section; pillar loop replaced with 2-face loop
- `docs/benchmark-v0.4.4.md` — Temple entry and estimate note updated (expected util still 20–24%)
- `docs/changelog-v0.4.4.md` — this entry

### GPU cost

Delta from round-3 baseline (~20–24%): +2% from 20 vs 12 pillars (partially offset by denser early-reject); +2% from side face test per pillar (1/z interpolation + rect test); ±0% from liveness inversion (same ALU class). **Expected util: 20–24%, Medium tier, unchanged from round 3**.

---

## temple — Pillar Round 5 (Side Face Vertical Lines + Caps)

Two targeted changes to `shaders/temple.frag`. No other files changed except benchmark and changelog docs.

### Side face pattern: horizontal rings → vertical lines

**Problem:** The horizontal ring pattern (`h_render = z_here * SIDE_FACE_RING_DENSITY`) had two issues: (1) temporally unstable — as the pillar scrolls in z, `z_here` shifts per-pixel, so ring positions sweep continuously across the face; (2) reads as "pillar is wider on one side" rather than "two faces of a 3D column" — the narrow face width prevents perspective compression from being perceptible.

**Fix:** Replace with `face_u * SIDE_FACE_LINE_DENSITY` where `face_u` is a face-local horizontal coordinate:

```glsl
float face_u = ((uv.x - sx_lo) / max(sx_hi - sx_lo, 1e-5)) * 2.0 - 1.0;
h_render = mix(face_u * SIDE_FACE_LINE_DENSITY, PILLAR_CAP_H_VALUE, cap_zone);
```

`face_u` maps `[0, 1]` → `[-1, +1]` within the face's current screen-x bounds (`sx_lo`, `sx_hi`). Because both `uv.x` (fixed screen pixel) and `sx_lo`/`sx_hi` (face bounds that move with the pillar) shift together, the *ratio* `(uv.x - sx_lo) / (sx_hi - sx_lo)` is stable in face-local coordinates — a point on "the left third of the face" keeps the same `face_u` as the pillar approaches. Vertical lines hold their face-local position with no scanning.

`SIDE_FACE_LINE_DENSITY = 0.5` matches `PILLAR_LINE_DENSITY = 0.5` on the front face, producing lines at identical face-local positions (`face_u ≈ 0, ±0.667`). Both faces show the same 3 vertical traces — maximally coherent "same column, two sides" reading.

**Constant removed:** `SIDE_FACE_RING_DENSITY = 0.8`

**Constant added:** `SIDE_FACE_LINE_DENSITY = 0.5`

### Cap bars added to side face

**Problem:** Round 4 omitted cap bars from the side face. Front face had solid bus-bar bands at top and bottom 10%; side face had none. Visual disconnect at pillar corners where front and side faces meet.

**Fix:** The `cap_zone` computation was already present in the round-4 side face block (for `pillar_v`); it was not applied to `h_render`. Round 5 incorporates it via the same `mix()` used on the front face:

```glsl
float pillar_v = dist_h * z_here;
float cap_zone = step(1.0 - PILLAR_CAP_WIDTH, abs(pillar_v));
h_render = mix(face_u * SIDE_FACE_LINE_DENSITY, PILLAR_CAP_H_VALUE, cap_zone);
```

Because `pillar_v = dist_h * z_here` and the face top/bottom is at `dist_h = ±1/z_here`, the pillar_v at the face edge is exactly `±1.0` — same as front face. Cap zone triggers at `|pillar_v| > 0.9` (top/bottom 10%), matching front face proportions. Caps on the side face follow the curved top/bottom edges of the trapezoidal screen silhouette, reinforcing the 3D reading.

### Files changed

- `shaders/temple.frag` — constant block (`SIDE_FACE_RING_DENSITY` → `SIDE_FACE_LINE_DENSITY`); side face hit-branch: `face_u` computation added; `h_render` formula replaced; `mix()` with `cap_zone` applied
- `docs/benchmark-v0.4.4.md` — Temple entry updated to reflect round 5
- `docs/changelog-v0.4.4.md` — this entry

### GPU cost

Pattern change: 1 divide replaced by 1 divide (`face_u` normalize vs. `z_here * DENSITY` multiply) — same ALU class. Cap zone `mix`: already present in round 4 (no-op on `ring_h`); now operative — zero additional ops. **Expected util: ~20%, unchanged**.
