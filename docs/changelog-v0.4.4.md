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
