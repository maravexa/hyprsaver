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
