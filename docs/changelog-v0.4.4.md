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

### Shader count
- Before: 26 built-ins (including mandelbrot, mandelbrot_deep, and the unreferenced df32_nuclear_test framework).
- After: 23 built-ins.
- Next: 25 built-ins once `shipburn` and `fractaltrap` are added.
