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
- Final v0.4.4 count: 25 built-ins
