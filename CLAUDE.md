# CLAUDE.md — hyprsaver

## Project Overview
hyprsaver is a Wayland-native screensaver for Hyprland. It renders GLSL fractal shaders on fullscreen wlr-layer-shell overlay surfaces via OpenGL ES (glow). It integrates with hypridle (timeout orchestration) and coexists with hyprlock (lock screen). The two are intentionally separate — Unix philosophy.

## Architecture
Four layers, each a module in `src/`:
- `wayland.rs` — Wayland connection, output enumeration, layer-shell surface lifecycle. Uses smithay-client-toolkit. One surface per monitor. Hosts the calloop event loop, cycle timers, and `advance_transition()` calls each frame.
- `renderer.rs` — OpenGL via glow. Fullscreen quad, uploads uniforms (time, resolution, palette vectors, speed/zoom scales, alpha fade), calls draw. Doesn't know about Wayland.
- `shaders.rs` — Loads `.frag` files from config dir and built-ins. Handles compilation, hot-reload (notify crate), Shadertoy uniform remapping. Prepends palette function to all shaders. Manages cycle playlists (`set_playlist`, `cycle_next`, `randomize_cycle_start`).
- `palette.rs` — Cosine gradient palettes (Inigo Quilez technique) and LUT palettes. Four vec3 params (a,b,c,d) → 12 floats. PNG LUT loading via `image` crate. CSS gradient stop palettes. `PaletteManager` with crossfade transition state (`begin_transition` / `advance_transition`).
- `config.rs` — TOML config with serde. Every field has a default. Config path: CLI flag → `$XDG_CONFIG_HOME/hypr/hyprsaver.toml` (new) → `$XDG_CONFIG_HOME/hyprsaver/config.toml` (legacy, deprecated) → built-in defaults. Includes `[[shader_playlists]]` and `[[palette_playlists]]` table sections and cycle interval fields.

Entry point: `main.rs` — CLI (clap), signal handling (signal-hook), config load, then either preview mode (xdg-toplevel window) or screensaver mode (layer-shell overlay). Event loop is calloop.

## Build & Run
```sh
cargo build --release
./target/release/hyprsaver              # screensaver mode (needs Hyprland)
./target/release/hyprsaver --preview mandelbrot  # windowed preview
```

## Key Design Decisions
- **glow over wgpu**: Thin OpenGL wrapper, minimal complexity for v1. wgpu is on the roadmap for v0.4.0 (Vulkan support).
- **Cosine palettes + LUT**: 12 floats or a 256×1 PNG strip. LUT palettes on texture units 1/2.
- **Shadertoy compat**: Shaders use Shadertoy conventions (iTime, iResolution, mainImage). A shim in shaders.rs remaps to our uniforms. Users can paste Shadertoy code with minimal edits.
- **Palette as uniforms, not in-shader**: Palettes are uploaded as vec3 uniforms. Shaders call `palette(t)` with a float. This decouples color from math — any shader × any palette.
- **Belt-and-suspenders exit**: Exits on either (1) input events on the layer surface or (2) SIGTERM from hypridle's on-resume. Both paths must work independently.
- **Hot-reload**: Filesystem watcher on shader dir. On change, recompile shader; on compile error, log and keep current shader. No restart needed.
- **Cycle timers**: calloop `Timer` events in `wayland.rs`. Shader cycle and palette cycle can have independent intervals. Both advance all surfaces simultaneously so monitors stay in sync. Startup randomizes the cycle position.

## Conventions
- Rust 2021 edition, stable toolchain
- `cargo fmt` and `cargo clippy` clean before every commit
- Error handling: `anyhow` for application errors, descriptive context on every `?`
- Logging: `log` macros (debug!/info!/warn!/error!), user runs with `RUST_LOG=hyprsaver=debug` for verbose output
- Shader files: `#version 320 es`, `precision highp float;`, uniforms prefixed `u_` (our convention) with Shadertoy aliases (iTime etc.) added by the shim
- Config: all fields optional with serde defaults. Zero-config must work.

## File Locations at Runtime
- Config: `~/.config/hypr/hyprsaver.toml` (legacy: `~/.config/hyprsaver/config.toml`, deprecated — warns on load, will be removed in v0.5.0)
- User shaders: `~/.config/hypr/hyprsaver/shaders/*.frag` (legacy: `~/.config/hyprsaver/shaders/`, deprecated)
- Built-in shaders: compiled into binary via `include_str!()`
- Logs: stderr (journalctl if launched by hypridle)

## Built-in Shaders (v0.3.0 — 22 total)

| Name          | Description                                              |
|---------------|----------------------------------------------------------|
| mandelbrot    | Mandelbrot set with animated zoom                        |
| julia         | Julia set with animated parameter                        |
| plasma        | Classic plasma effect                                    |
| tunnel        | Infinite tunnel flythrough                               |
| voronoi       | Animated Voronoi cells                                   |
| snowfall      | Five-layer parallax snowfall with palette dot glow       |
| starfield     | Hyperspace zoom tunnel with motion-blur tracers          |
| kaleidoscope  | 6-fold kaleidoscope driven by domain-warped FBM          |
| marble        | Curl-noise flow field with 8-step particle tracing       |
| donut         | Raymarched torus with Phong lighting                     |
| lissajous     | Three overlapping Lissajous curves with glow             |
| geometry      | Wireframe polyhedron morphing (cube→icosahedron→...)     |
| hypercube     | Rotating 4D tesseract projected to 2D, neon glow         |
| network       | Neural network node graph with glowing connections       |
| matrix        | Classic Matrix digital rain with procedural glyphs       |
| fire          | Roiling procedural flames with ember particles           |
| caustics      | Underwater caustic light patterns                        |
| bezier        | Five animated Bézier curves with additive palette glow   |
| planet        | Raymarched planet sphere with aurora borealis bands      |
| tesla         | Tesla coil arcs — fractal-lightning between electrodes   |
| terminal      | Scrolling build-log output with CRT scanlines and glow   |
| wormhole      | Curving wormhole tunnel with ring-textured walls         |

## Playlist / Cycle System (v0.3.0)

`config.rs` parses `[shader_playlists.<name>]` and `[palette_playlists.<name>]` table sections. When `shader = "cycle"` (or `palette = "cycle"`) is active and `shader_playlist` / `palette_playlist` is set in `[general]`, the `ShaderManager` / `PaletteManager` iterates only the named playlist. `ShaderManager::set_playlist()` and `randomize_cycle_start()` are called at startup. `cycle_next()` advances on each timer tick.

Cycle timer logic lives in `wayland.rs`: calloop `Timer` events are registered once the screensaver is active. The timer handler advances all `Renderer` instances simultaneously (one per connected monitor) so they stay in sync.

## Testing Strategy
- Unit tests: palette math (color_at for known inputs), config deserialization (missing fields → defaults), Shadertoy shim (uniform remapping), playlist cycle, shader count
- Integration: `--preview` mode with a test shader, assert it opens a window and renders frames without panic
- Manual: run under Hyprland, verify layer surface appears on all monitors, verify input dismiss, verify SIGTERM dismiss, verify hot-reload, verify cycle advances across monitors

## What to Watch Out For
- smithay-client-toolkit API churn: SCTK 0.18→0.19 had breaking changes. Pin the version.
- EGL context creation on Wayland: glutin's Wayland support can be finicky. If issues arise, consider raw EGL via `khronos-egl` crate.
- AMD GPU (ROCm/Mesa): Test on both AMDGPU (Mesa) and proprietary. GLSL ES 3.20 should be fine on Mesa 24+.
- Multi-monitor with mixed DPI: layer surfaces report scale factor. The renderer must multiply resolution by scale for crisp rendering on HiDPI outputs.
- Shader compilation errors must never crash the process. Always fall back to a known-good built-in shader.

## Palette Uniforms — v0.2.0 Migration Note

**Custom shaders must be updated** after upgrading from v0.1.x. The palette uniform names changed:

| Old (v0.1.x)       | New (v0.2.0+)                                     |
|--------------------|---------------------------------------------------|
| `u_palette_a`      | `u_palette_a_a` (brightness, palette A)           |
| `u_palette_b`      | `u_palette_a_b` (amplitude, palette A)            |
| `u_palette_c`      | `u_palette_a_c` (frequency, palette A)            |
| `u_palette_d`      | `u_palette_a_d` (phase, palette A)                |

New uniforms (injected by the shader pipeline):
- `u_palette_b_{a,b,c,d}` — palette B cosine params for cross-fade
- `u_lut_a`, `u_lut_b` — `sampler2D` for LUT-based palettes (256×1 RGBA8 on texture units 1/2)
- `u_use_lut` — `int`; 0 = cosine, 1 = LUT
- `u_palette_blend` — `float` blend factor 0.0→1.0 for transitions

The `palette(t)` GLSL function signature is unchanged: `vec3 palette(float t)`.
If your shader does not define `palette()`, the new multi-mode version is injected automatically.
Built-in shaders are all updated; user shaders that define their own `palette()` are untouched.

## Preview-Mode Speed / Zoom Uniforms

Two additional uniforms are injected by `prepare_shader()` in `shaders.rs` for every shader that does not already declare them:

| Uniform | Type | Default | Purpose |
|---------|------|---------|---------|
| `u_speed_scale` | `float` | `1.0` | Multiplies time-based motion expressions |
| `u_zoom_scale` | `float` | `1.0` | Multiplies zoom depth (fractal/starfield shaders) |

**In daemon mode** both uniforms are always uploaded as `1.0` — no behavioral change from before.

**In preview mode** the egui control panel's Speed and Zoom sliders call `Renderer::set_speed_scale()` / `set_zoom_scale()` which are forwarded to the shader each frame.

## Roadmap Summary
- v0.1.0: Core screensaver. Layer-shell, glow, cosine palettes, built-in shaders, hot-reload, preview mode.
- v0.2.0: LUT + gradient palettes, per-monitor config, palette transitions.
- v0.3.0: 6 new shaders, cycle mode with playlists, shader descriptions, random start position. ✓ shipped
- v0.4.0: per-monitor shader/palette assignment, screencopy texture pipeline, rain-on-glass shader, palette crossfade on cycle.
- v1.0.0: Stable config format, AUR/Nix packages, full Shadertoy uniform support.

## v0.3.0 Status

All cycle/playlist features implemented:
- config.rs: `shader_cycle_interval`, `palette_cycle_interval`, `shader_playlist`, `palette_playlist` fields in `[general]`; `[shader_playlists.<name>]` and `[palette_playlists.<name>]` table sections.
- shaders.rs: `set_playlist()`, `cycle_next()`, `current_cycle_name()`, `randomize_cycle_start()` on `ShaderManager`.
- wayland.rs: Unified cycle timer; both shader + palette advance together when both are cycling; independent timers otherwise. `randomize_cycle_start()` called at startup. All monitors advanced in sync.
- main.rs: `--shader-cycle-interval`, `--palette-cycle-interval`, `--list-shader-playlists`, `--list-palette-playlists` CLI flags.
- 6 new built-in shaders: geometry, hypercube, network, matrix, fire, caustics.
- Removed: pipes shader (visual artifacts), palette_test example.
