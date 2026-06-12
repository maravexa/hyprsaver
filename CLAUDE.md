# CLAUDE.md — hyprsaver

## Project Overview
hyprsaver is a Wayland-native screensaver for Hyprland. It renders GLSL fractal shaders on fullscreen wlr-layer-shell overlay surfaces via OpenGL ES (glow). It integrates with hypridle (timeout orchestration) and coexists with hyprlock (lock screen). The two are intentionally separate — Unix philosophy.

## Architecture
Ten modules in `src/` (plus `main.rs`):
- `wayland.rs` — Wayland connection, output enumeration, layer-shell surface lifecycle. Uses smithay-client-toolkit. One surface per monitor. Hosts the calloop event loop, calls `CycleManager::tick(now)` each frame, and dispatches `CycleEvent`s to advance shaders/palettes.
- `renderer.rs` — OpenGL via glow. Fullscreen quad, uploads uniforms (time, resolution, palette vectors, speed/zoom scales, alpha fade), calls draw. Doesn't know about Wayland.
- `shaders.rs` — Loads `.frag` files from config dir and built-ins. Handles compilation, hot-reload (notify crate), Shadertoy uniform remapping. Prepends palette function to all shaders. Manages cycle playlists (`set_playlist`, `cycle_next`, `randomize_cycle_start`).
- `palette.rs` — Cosine gradient palettes (Inigo Quilez technique) and LUT palettes. Four vec3 params (a,b,c,d) → 12 floats. PNG LUT loading via `image` crate. CSS gradient stop palettes. `PaletteManager` with crossfade transition state (`begin_transition` / `advance_transition`).
- `config.rs` — TOML config with serde. Every field has a default. Config path: CLI flag → `$XDG_CONFIG_HOME/hypr/hyprsaver.toml` (new) → `$XDG_CONFIG_HOME/hyprsaver/config.toml` (legacy, deprecated) → built-in defaults. Includes `[playlists.<name>]` table sections (unified v0.4.0 format; legacy `[shader_playlists.<name>]` / `[palette_playlists.<name>]` still parsed), cycle interval fields, and the `[render_preview.palettes]` shader→palette override map.
- `cycle.rs` — `CycleManager`: tick-driven scheduler for shader and palette rotation. `tick(&mut self, now: Instant) -> Vec<CycleEvent>` returns an empty vec when nothing changed. `CycleOrder` supports `Random` (shuffle-bag, no consecutive repeats across bag boundaries) and `Sequential`. Single-item playlists never emit events, preserving fixed-shader behaviour.
- `shuffle.rs` — `ShuffleBag` randomizer. Returns every index in `0..len` exactly once per bag cycle in a freshly randomized order; reshuffles on exhaustion; guarantees no cross-bag consecutive repeats when `len >= 2`. "iPod shuffle" pattern — uniform-over-cycle, not uniform-per-pick. A separate instance per cycle stream (shaders, palettes), each with its own xorshift64 seed. `seed_from_time()` helper for wall-clock seeding.
- `preview.rs` — Windowed preview mode with egui control panel. Left region: shader viewport. Right region: 300-px docked panel with Shader and Palette tabs and thumbnail previews. FPS counter is an overlay (top-left, toggled with `I`). Keyboard shortcuts: Space (pause/resume), ←/→ (prev/next shader), ↑/↓ (prev/next palette), R (reset time), F (toggle panel), I (toggle FPS), T (test shader crossfade), Q/Escape (quit).
- `render_preview.rs` — `render-preview` subcommand. Headless EGL surfaceless + FBO capture; encodes animated WebP. Defaults: 480×270, 3 s, 15 fps, quality 80. Batch mode (no shader names) renders all shaders. Per-shader palette resolution: CLI override → `[render_preview.palettes]` config map → stable hash-based default. `--skip-existing` skips outputs that already exist.
- `headless_egl.rs` — Surfaceless EGL context for `render-preview` (no Wayland surface needed).

Entry point: `main.rs` — CLI (clap), signal handling (signal-hook), config load, then dispatches to `preview.rs` (windowed preview) or `wayland.rs` (layer-shell screensaver). Event loop is calloop.

## Build Environment

This environment does not have all system libraries installed (notably `xkbcommon`). `cargo build` will fail at the linker stage — this is expected and not a code error.

After editing shader files (`.frag`, `.vert`) or Rust source:
1. Run `touch src/shaders.rs` to invalidate the cargo cache for shader changes
2. Do NOT run `cargo build` — it will fail on missing system deps
3. Do NOT attempt to install system packages
4. Commit changes and push to the current feature branch

## Build & Run
```sh
cargo build --release
./target/release/hyprsaver                          # screensaver mode (needs Hyprland)
./target/release/hyprsaver --preview oscilloscope   # windowed preview
./target/release/hyprsaver render-preview           # batch-render WebP previews of all shaders
./target/release/hyprsaver render-preview blob      # single-shader WebP preview
```

## Key Design Decisions
- **glow over wgpu**: Thin OpenGL wrapper, minimal complexity for v1. wgpu (Vulkan support) remains on the long-term roadmap.
- **Cosine palettes + LUT**: 12 floats or a 256×1 PNG strip. LUT palettes on texture units 1/2.
- **Shadertoy compat**: Shaders use Shadertoy conventions (iTime, iResolution, mainImage). A shim in shaders.rs remaps to our uniforms. Users can paste Shadertoy code with minimal edits.
- **Palette as uniforms, not in-shader**: Palettes are uploaded as vec3 uniforms. Shaders call `palette(t)` with a float. This decouples color from math — any shader × any palette.
- **Belt-and-suspenders exit**: Exits on either (1) input events on the layer surface or (2) SIGTERM from hypridle's on-resume. Both paths must work independently.
- **Hot-reload**: Filesystem watcher on shader dir. On change, recompile shader; on compile error, log and keep current shader. No restart needed.
- **Cycle timers**: `CycleManager` in `cycle.rs` (tick()-driven, returns `CycleEvent`s). `wayland.rs` calls `tick()` each frame and acts on the returned events. Shader and palette cycles can have independent intervals; both advance all surfaces simultaneously so monitors stay in sync. Startup randomizes the cycle position.
- **Triangle-wrap palette sampling**: when sampling a palette over a monotonically growing `t` (depth, scroll position, ribbon arc length), use `palette(abs(fract(x * 0.5) * 2.0 - 1.0))` instead of `palette(fract(x))`. Triangle-wrap reverses direction at the seam, so directional palettes (pride flags etc.) avoid a hard discontinuity at the wrap point. Use plain `fract(x)` only when `t` is intrinsically cyclic and the palette is symmetric. New shaders should default to triangle-wrap.
- **Camera-roll for view-rotation animations**: when raymarching a scene where the apparent motion is "rolling along an axis" (e.g. mobius, twisted ribbons), roll the *view orientation* and keep the camera position fixed. Moving the camera position to fake roll produces parallax artifacts that don't match the intended geometry. Lesson learned in the mobius v3→v4 rewrite.

## Conventions
- Rust 2021 edition, stable toolchain
- `cargo fmt` and `cargo clippy` clean before every commit
- Error handling: `anyhow` for application errors, descriptive context on every `?`
- Logging: `log` macros (debug!/info!/warn!/error!), user runs with `RUST_LOG=hyprsaver=debug` for verbose output
- Shader files: `#version 320 es`, `precision highp float;`, uniforms prefixed `u_` (our convention) with Shadertoy aliases (iTime etc.) added by the shim
- GLSL helper duplication is deliberate: hash/noise/fbm helpers are copied per-shader rather than injected as a shared prelude. Each shader tunes its own variant (sin-dot hashes kept for ARM Mali/Iris Xe stability, Dave-Hoskins fract hashes where `sin()` precision bites), and a shared prelude would risk `contains()` needle collisions in `prepare_shader()` and force recompiling all built-ins on any helper change. Do not "deduplicate" these across `.frag` files.
- Config: all fields optional with serde defaults. Zero-config must work.

## File Locations at Runtime
- Config: `~/.config/hypr/hyprsaver.toml` (legacy: `~/.config/hyprsaver/config.toml`, deprecated — warns on load, will be removed in v0.5.0)
- User shaders: `~/.config/hypr/hyprsaver/shaders/*.frag` (legacy: `~/.config/hyprsaver/shaders/`, deprecated)
- Built-in shaders: compiled into binary via `include_str!()`
- Logs: stderr (journalctl if launched by hypridle)

## Built-in Shaders (v0.4.5 — 35 total)

`mandelbrot` was removed in v0.4.4 (GPU architectural mismatch on deep zoom). Do NOT add it back. `network` was removed in the same cycle (plexus aesthetic is vertex-native, not fragment-native); `circuit` and `sonar` are its fragment-native replacements.

| Name          | Description                                              |
|---------------|----------------------------------------------------------|
| julia         | Julia set with animated parameter                        |
| shipburn      | Burning-Ship Julia — `abs()`-folded z² + c for angular mirror-symmetric "ship" silhouettes |
| fractaltrap   | Julia with orbit-trap coloring (unit circle trap) — stained-glass / cellular aesthetic |
| plasma        | Classic plasma effect                                    |
| tunnel        | Infinite tunnel flythrough                               |
| voronoi       | Animated Voronoi cells                                   |
| snowfall      | Five-layer parallax snowfall with palette dot glow       |
| starfield     | Hyperspace zoom tunnel with motion-blur tracers          |
| aurora        | Overhead aurora curtains — domain-warped FBM with striation ridges, asymmetric falloff, filament shimmer, diagonal movement |
| kaleidoscope  | 6-fold kaleidoscope driven by domain-warped FBM          |
| marble        | Curl-noise flow field with 8-step particle tracing       |
| donut         | Raymarched torus with Phong lighting                     |
| flames        | Single-layer fBm with domain warping + turbulence noise; fractal 3-octave height boundary; ember glow floor |
| lissajous     | Three overlapping Lissajous curves with glow             |
| geometry      | Wireframe polyhedron morphing (cube→icosahedron→...)     |
| hypercube     | Rotating 4D tesseract projected to 2D, neon glow         |
| circuit       | Brick-offset grid with hash-gated traces between cells — PCB / circuit-board aesthetic; 3×3 cell neighbourhood, 20-node cache |
| sonar         | 6 point emitters on Lissajous paths emit cosine wavefronts; rotating radial sweep reveals constructive-interference contacts |
| matrix        | Classic Matrix digital rain with procedural glyphs       |
| caustics      | Underwater caustic light patterns                        |
| bezier        | Five animated Bézier curves with additive palette glow   |
| planet        | Raymarched planet sphere with aurora borealis bands      |
| tesla         | Tesla coil arcs — fractal-lightning between electrodes   |
| terminal      | Scrolling build-log output with CRT scanlines and glow   |
| oscilloscope  | Realistic CRT oscilloscope display with three animated waveform traces |
| clouds        | Slowly drifting procedural fBm clouds over a tinted sky  |
| temple        | Retro temple interior — floor + ceiling triangle-wave lattice, 4 scrolling pillars with ring trace pattern, CRT scanlines |
| wormhole      | Curved-tunnel raymarch; z-dominant palette rings, angular contribution dropped |
| waterfall     | Stylized 2D waterfall with retro quantize-and-dither post |
| gridwave      | Perspective-projected neon grid with scrolling forward motion — classic Tron/Outrun aesthetic |
| blob          | Lit blob with flowing energy emission and atmospheric halo — warped sphere SDF, Phong lighting |
| mobius        | Race along a twisted Möbius ribbon against the void — palette gradient flips after each full loop |
| stonks        | Procedural candlestick chart with MACD oscillator; palette-sampled bull/bear colors |
| fireflies     | Warm glowing wanderers drifting across a dark field, per-firefly palette colors |
| attitude      | Artificial-horizon instrument with simulated flight motion |

## Playlist / Cycle System (v0.3.0)

`config.rs` parses `[playlists.<name>]` table sections (unified v0.4.0 format; the legacy v0.3.0 `[shader_playlists.<name>]` / `[palette_playlists.<name>]` sections are still parsed for backward compatibility). When `shader = "cycle"` (or `palette = "cycle"`) is active and `shader_playlist` / `palette_playlist` is set in `[general]`, the `ShaderManager` / `PaletteManager` iterates only the named playlist. `ShaderManager::set_playlist()` and `randomize_cycle_start()` are called at startup. `cycle_next()` advances on each timer tick.

Cycle scheduling is handled by `CycleManager` in `cycle.rs`. `wayland.rs` calls `CycleManager::tick()` each frame and dispatches the returned `CycleEvent`s — advancing all `Renderer` instances simultaneously so monitors stay in sync.

## Testing Strategy
- Unit tests: `#[cfg(test)]` modules in `config`, `cycle`, `palette`, `renderer`, `shaders`, `shuffle`, `wayland` — palette math (`color_at` for known inputs), config deserialization (missing fields → defaults), Shadertoy shim (uniform remapping), playlist cycle, built-in shader count (`test_builtin_shader_count` asserts 35), shuffle-bag uniformity + no-consecutive-repeats.
- Integration: `--preview` mode with a test shader, assert it opens a window and renders frames without panic.
- Manual: run under Hyprland, verify layer surface appears on all monitors, verify input dismiss, verify SIGTERM dismiss, verify hot-reload, verify cycle advances across monitors.

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
- v0.1.0: Core screensaver. Layer-shell, glow, cosine palettes, built-in shaders, hot-reload, preview mode. ✓ shipped
- v0.2.0: LUT + gradient palettes, per-monitor config, palette transitions, egui preview panel. ✓ shipped
- v0.3.0: 6 new shaders, cycle mode with playlists, shader descriptions, random start position. ✓ shipped
- v0.4.0: `cycle.rs` extracted, `preview.rs` separated, config path migration to `~/.config/hypr/`. ✓ shipped
- v0.4.1: 2 new shaders (oscilloscope, clouds), doc path updates, patch fixes. ✓ shipped
- v0.4.2: Aurora rewrite, Flames shader, preview UI fixes, shader precision fixes, default playlists. ✓ shipped
- v0.4.3: GPU optimization audit — all 7 Heavy-tier shaders optimized to Medium tier. ✓ shipped
- v0.4.4: Mandelbrot removed (GPU architectural mismatch on df32 deep zoom); `network` → `circuit` + `sonar` pivot; new shaders `shipburn`, `fractaltrap`, `wormhole`; `waves` renamed to `temple` (ceiling + pillars added); `ShuffleBag` randomizer extracted to `shuffle.rs`; pride palette pack + `pride` playlist. ✓ shipped
- v0.4.5: 5 new Lightweight shaders (`fireflies`, `stonks`, `attitude`, `waterfall`, `mobius`); triangle-wrap palette refactor across 11 shaders; `render-gif` → `render-preview` (animated WebP); `[render_preview.palettes]` config overrides; preview UI polish (FPS toggle keybind, palette tab dropdown parity, palette transition test button). ✓ shipped
- v1.0.0: Stable config format, AUR/Nix packages, full Shadertoy uniform support, wgpu/Vulkan backend.

## v0.4.4 Status

Shipped. `Cargo.toml` reflects the current release version.

Authoritative change log: `CHANGELOG.md`. Benchmarks: `docs/BENCHMARK_0.4.4.md`.

**Deletions (v0.4.4):**
- `shaders/mandelbrot.frag`, `shaders/mandelbrot_deep.frag`, `src/mandelbrot_deep.rs` — deep-zoom Mandelbrot effort abandoned. HawkPoint1 GPU is fundamentally unsuited to the compound cost of the iteration loop + df32 coordinate arithmetic + exponential zoom at depth ~1e11. **Do not attempt to reintroduce mandelbrot shaders.** The fractal-aesthetic slot is now filled by `shipburn` and `fractaltrap`.
- `shaders/network.frag` — plexus aesthetic is vertex-native, not fragment-native. After three optimization passes it still sat at 45–52% GPU. Replaced by `circuit` (PCB cells) + `sonar` (wavefront interference) — both confined to a fixed neighbourhood per pixel.

**Renderer / Wayland cleanup (v0.4.4):**
- `UniformLocations` lost df32 fields (`u_test_pi_{hi,lo}`, `u_pi_sq_{hi,lo}`) and mandelbrot_deep fields (`u_focal_real_{hi,lo}`, `u_focal_imag_{hi,lo}`, `u_zoom_t`, `u_initial_extent`, `u_max_iter_deep`, `u_fade`).
- `Renderer::set_mandelbrot_deep_uniforms()` removed; corresponding `md_*` fields gone.
- `WaylandState::mandelbrot_deep_state` removed.
- `preview.rs`: egui zoom slider gone; `PreviewPanelState::zoom` and `PreviewState::mandelbrot_deep_state` removed; `save_preview_config()` no longer writes `zoom_scale`. **Note**: `u_zoom_scale` shader uniform is still injected by `prepare_shader()` and uploaded every frame — only the UI surface was removed.
- Hard-coded `"mandelbrot"` fallback strings in `wayland.rs` changed to `"julia"`.

**New shaders (v0.4.4):**
- `shipburn` — Burning-Ship Julia; `abs()` applied to z before squaring each step; smooth escape coloring (Inigo Quilez log2-log2).
- `fractaltrap` — Julia with unit-circle orbit-trap coloring; no solid interior; stained-glass look.
- `circuit` — brick-offset grid with hash-gated traces. 3×3 cell neighbourhood (9 cells, 27 edges); 20-entry node cache; Dave-Hoskins fract hash (no `sin()` hashing).
- `sonar` — 6 Lissajous-path emitters, cosine ring waves, rotating sweep decays as `exp(-recency * 6.0)`; sweep multiplies the wave field rather than overpainting it.
- `temple` — retro temple interior; `waves` renamed and expanded with ceiling mirroring and 4 scrolling pillars. Centered horizon (0.5), floor + ceiling share triangle-wave lattice with phase offset; pillars are screen-space rects with ring trace pattern. Medium tier (~22–30% GPU).
- `wormhole` — curved-tunnel raymarch (finally shipped; previously deferred to v0.5.0). Palette is z-dominant; angular contribution intentionally dropped.

**Randomization (v0.4.4):**
- `src/shuffle.rs` — `ShuffleBag` randomizer. Separate instances for shader and palette streams. Replaces the previous ad-hoc "avoid last pick" logic.

**Palettes (v0.4.4):**
- Pride palette pack added; `pride` playlist defined. Available as both cosine and CSS gradient-stop variants depending on the specific palette.

**Config defaults (current, as of v0.4.4):**
- `shader_cycle_interval = 300` (5 min), `palette_cycle_interval = 60` (1 min), `palette_transition_duration = 0.0`. These superseded the v0.4.2 values (120 / 20 / 2.0).

## v0.4.3 Status

All features through v0.4.3 implemented:

**v0.4.3 (GPU optimization audit):**
- All 7 Heavy-tier shaders optimized to Medium tier: Snowfall, Geometry, Bezier, Lissajous, Marble, Network (since removed), Starfield.
- Snowfall: complete rewrite using grid-cell spatial lookup (3 layers, 27 checks/pixel); 57% → 32%.
- Geometry: flat indexed arrays, bounded edge loops; 70% → 35–55%.
- Bezier: two-pass coarse+fine distance estimation; 70% → 48%.
- Lissajous: deferred sqrt, reduced sample count, independent per-curve hue rates; 70% → 49%.
- Marble: merged curl noise samples, reduced tracing steps; 70% → 43%.
- Network: grid topology for even screen coverage, removed O(n²) pair evaluation; 70% → 43%. (Shader itself deleted in v0.4.4.)
- Starfield: complete rewrite using Art-of-Code 20-layer zoom with golden-angle rotation and dashed trails; 70% → 43%.
- New benchmarks documented: Aurora (50%), Flames (24%), Oscilloscope (18%).
- Benchmark docs: `docs/BENCHMARK_0.4.3.md` (v0.4.3), `docs/BENCHMARK_0.4.4.md` (v0.4.4 additions).

## v0.4.2 Status

All features through v0.4.2 implemented:

**v0.3.0 (cycle/playlist):**
- config.rs: `shader_cycle_interval`, `palette_cycle_interval`, `shader_playlist`, `palette_playlist` fields in `[general]`; `[shader_playlists.<name>]` and `[palette_playlists.<name>]` table sections.
- shaders.rs: `set_playlist()`, `cycle_next()`, `current_cycle_name()`, `randomize_cycle_start()` on `ShaderManager`.
- main.rs: `--shader-cycle-interval`, `--palette-cycle-interval`, `--list-shader-playlists`, `--list-palette-playlists` CLI flags.
- 6 new built-in shaders: geometry, hypercube, network, matrix, fire, caustics. (`network` later deleted in v0.4.4; `fire` superseded by `flames` in v0.4.2.)
- Removed: pipes shader (visual artifacts), palette_test example.

**v0.4.0 (refactor + path migration):**
- cycle.rs: `CycleManager` extracted from `wayland.rs`; tick()-driven with `CycleEvent` / `CycleOrder` types.
- preview.rs: windowed preview separated from `main.rs`; full egui panel with shader/palette/display controls.
- Config and shader paths migrated to `~/.config/hypr/hyprsaver.toml` / `~/.config/hypr/hyprsaver/shaders/`; legacy paths deprecated with v0.5.0 removal scheduled.

**v0.4.1 (new shaders + docs):**
- 2 new built-in shaders: oscilloscope, clouds (total 24).
- Doc comment example paths updated to canonical `~/.config/hypr/hyprsaver/` layout.

**v0.4.2 (shader refresh + preview UI + fixes):**
- New shaders: aurora (domain-warped FBM rewrite with striation ridges), flames (fBm + domain warp + fractal height boundary).
- Removed shaders: fire (superseded by flames), vortex (experimental), wormhole (deferred to v0.5.0 — curved tunnel singularity unresolved). (`wormhole` was eventually shipped in v0.4.4 with a different raymarch approach.)
- Preview UI: scroll wheel fixed in dropdowns; scrollbar float fixed; shader thumbnails in Playlists tab; palette gradient previews in all dropdowns; full-row click targets; right-aligned thumbnails; Playlists sub-tab full-width centered text; delete button moved above list.
- Default preview shader changed from Mandelbrot to Oscilloscope.
- Shader fixes: Oscilloscope time wrapping (prevents float precision loss after hours); Tesla orbit radius clamped to screen bounds.
- Config defaults at the time: `shader_cycle_interval = 120`, `palette_cycle_interval = 20`, `palette_transition_duration = 2.0`. (Superseded in v0.4.4 by `300` / `60` / `0.0`.)
- Example config: default playlists added (Elements, Math, Nature, Psychedelic, Tech).
- **Note**: After editing built-in shader `.frag` files in `shaders/`, run `touch src/shaders.rs` (or `cargo clean`) to force recompile — `include_str!()` does not trigger recompilation on shader-only changes in all tool configurations.
