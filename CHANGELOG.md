# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.4.5] - 2026-04-28

### Added
- **New shaders:** 5 new Lightweight-tier shaders
  - Fireflies: 25% (warm glowing wanderers drifting across a dark field, per-firefly palette colors)
  - Stonks: 18% (procedural candlestick chart with MACD oscillator; palette-sampled bull/bear colors)
  - Attitude: 28% (artificial-horizon instrument with simulated flight motion)
  - Waterfall: 32% (stylized 2D waterfall with retro quantize-and-dither post)
  - Mobius: 31% (race along a twisted Möbius ribbon against the void; palette gradient flips after each full loop)
- **Preview UI — palette transition test button:** symmetric with the existing shader transition test; lives in preview > palette tab
- **Preview UI — FPS toggle:** new `I` keybind shows/hides the FPS counter
- **Config — `[render_preview.palettes]`:** optional shader→palette overrides for preview generation. Falls back to hash-based defaults for any shader not listed; invalid entries fail config load with clear error messages
- **CLI — `render-preview --skip-existing`:** incremental regen flag that preserves existing previews

### Changed
- **Triangle-wrap palette sampling:** 11 shaders (circuit, fractaltrap, gridwave, julia, mobius, planet, plasma, shipburn, tunnel, voronoi, plus mobius-internal) refactored to sample palettes via `abs(fract(x * 0.5) * 2.0 - 1.0)` instead of `fract(x)`. Eliminates the seam at the palette wrap point on directional palettes (pride flags). Caustics audited and confirmed unaffected
- **Preview FPS counter:** moved top-left, doubled in size, black-bordered for legibility on bright shaders
- **Preview UI — palette tab dropdown:** now uses the same gradient-rectangle dropdown style as the preview and playlist tabs
- **CLI — `render-gif` → `render-preview`:** subcommand renamed; output format is animated WebP instead of GIF. Defaults: 480×270, 3 s, 15 fps, quality 80. Batch mode renders all shaders when no names are given. Deterministic palette per shader via stable hash. Old `--palettes` (cycling list with random padding) replaced by `--palette` (single) and `--cycle-palettes` (explicit list, no padding)

### Fixed
- **Palette wrap seam:** directional palettes (pride flags etc.) no longer show a hard discontinuity where `t` wraps from 1.0 → 0.0 in shaders that sample monotonically. Triangle-wrap refactor across 11 shaders, see Changed

### Removed
- **CLI — `render-gif` subcommand:** superseded by `render-preview`. Users with scripts that call `render-gif` should switch to `render-preview` (output is now `.webp`, defaults differ)
- **Preview UI — Display section:** removed from preview settings panel (FPS counter is now toggled with the `I` key instead)
- **`--palettes` flag random-padding behavior:** replaced by `--palette` / `--cycle-palettes` on `render-preview`


## [0.4.4] - 2026-04-22

### Added
- **New shaders:** 7 new shaders spanning Lightweight and Medium tiers
  - Wormhole: 22% (3D raymarched curved tunnel with TunnelCenter sin-wave displacement, PS1 palette quantize)
  - Blob: 27% (sphere SDF + analytical sin warp, Phong via palette, Fresnel rim, atmospheric halo)
  - Gridwave: 15% (2D screen-space Tron/Outrun grid with horizontal + vertical warping)
  - Circuit: 44% (hex-adjacency PCB grid with gradient pulses along traces)
  - Sonar: 25% (rotating sweep gates wavefront visibility, white emitter dots)
  - Shipburn: 21% (Burning Ship Julia variant with julia.glsl-style coloring)
  - Fractaltrap: 29% (three-point orbit-trap Julia with three-fold rotational symmetry)
- **Pride palette pack:** 7 new gradient LUT palettes (achilles, sappho, marsha, cahun, mercury, frida, emily) + `[playlists.pride]` grouping in example config
- **CLI — `render-gif` subcommand:** Headless shader→GIF rendering via EGL surfaceless + FBO capture. Defaults: 960×540, 20 fps, 9 s, 3 random palettes as hard-cut segments. Deterministic frame timing for reproducibility. Purpose: generate README showcase GIFs without screen recording.
- **Persistent shuffle bag:** `$XDG_STATE_HOME/hyprsaver/shuffle.toml` backs `randomize_cycle_start()` for both palette and shader managers — each name returns once per bag cycle before repeats; cross-launch consecutive repeats eliminated
- **New benchmarks documented:** Clouds (25%), Terminal (18%)
- **Benchmark doc:** `docs/benchmark-v0.4.4.md`

### Changed
- **Starfield:** Spawn-time dead zone resolves "stars through viewer" artifact — closes v0.4.3 carry-forward. Util 43% → 49%
- **Preview mode:** Now calls `randomize_cycle_start()` matching daemon behavior — fixes preview always starting on alphabetically-first palette (aurora)
- **`--list-shaders` descriptions:** Concision pass across the full roster, filled missing entries for Blob, Gridwave, Wormhole

### Removed
- **Mandelbrot shader:** Unsuited to per-pixel iteration-count variance at animated zoom depth. Fractal slot filled by Shipburn and Fractaltrap. Users with `shader = "mandelbrot"` or mandelbrot in playlists should update config.
- **Network shader:** Plexus/connected-node aesthetic is vertex-native; per-pixel O(n) iteration cannot reach parity with a proper vertex renderer. Replaced by Circuit and Sonar — both fragment-native. Users with `shader = "network"` or network in playlists should update config.


## [0.4.3] - 2026-04-16

### Changed

- **GPU audit:** All 7 Heavy-tier shaders optimized to Medium tier
  - Snowfall: 57% → 32% (grid-based spatial lookup)
  - Geometry: 70% → 35–55% (flat indexed arrays, bounded edge loops)
  - Bezier: 70% → 48% (two-pass coarse+fine distance estimation)
  - Lissajous: 70% → 49% (deferred sqrt, sample count reduction)
  - Marble: 70% → 43% (merged curl noise samples, reduced steps)
  - Network: 70% → 43% (grid topology, removed O(n²) pair evaluation)
  - Starfield: 70% → 43% (Art-of-Code 20-layer zoom architecture)
- **Lissajous:** Fixed color cycling stall — independent per-curve hue rates
- **Network:** Grid topology for even screen coverage, 35% overscan, depth-tapered cross-layer lines
- **Snowfall:** Complete rewrite using grid-cell spatial lookup (3 layers, 27 checks/pixel)
- **Starfield:** Complete rewrite using multi-layer zoom with golden-angle rotation and dashed trails

### Added

- New benchmarks documented: Aurora (50%), Flames (24%), Oscilloscope (18%)
- Benchmark doc: `docs/BENCHMARK_0.4.3.md`

## [0.4.2] - 2026-04-15

### Added

- **Shader: aurora** — Full rewrite using domain-warped FBM with striation ridges.
  Overhead sky view with organic aperiodic curtain movement, asymmetric exponential
  falloff (sharp lower edge, soft upward glow), and fine internal filament shimmer.
  Diagonal movement with aggressive wiggle.
- **Shader: flames** — New fire shader replacing Fire. Single-layer fBm with domain
  warping and turbulence noise. Fractal 3-octave height boundary for chaotic flame
  tips. Ember glow floor at base.
- **Default playlists** added to example config: Elements, Math, Nature,
  Psychedelic, Tech.
- **Preview UI**: shader screenshot thumbnails in Playlists tab shader dropdown
  (matching Preview tab); compact gradient preview rectangles in all palette
  dropdowns; dropdown items selectable by clicking anywhere on the row.
- **Preview UI**: Playlists sub-tab menu uses larger centered text spanning full
  width; playlist delete button moved above item list for stable positioning during
  bulk deletion.

### Changed

- Default preview shader changed from Mandelbrot to Oscilloscope.
- Config defaults updated: `shader_cycle_interval = 120`,
  `palette_cycle_interval = 20`, `palette_transition_duration = 2.0`.
- Preview dropdown layout: thumbnails/gradients right-aligned, text left-aligned.

### Fixed

- **Preview UI**: scroll wheel not working in dropdown menus.
- **Preview UI**: dropdown scrollbar anchored to far right edge instead of
  floating alongside the list.
- **Oscilloscope**: sine wave precision degradation after extended runtime (hours)
  — time value now wraps to prevent float overflow in noise functions.
- **Tesla**: orbiting nodes clipping off screen edges — orbit radius now
  constrained to screen bounds with padding.

### Removed

- **Shader: fire** — superseded by Flames.
- **Shader: vortex** — experimental shader removed.
- **Shader: wormhole** — removed pending future rewrite (deferred to v0.5.0).

## [0.4.1] - 2026-04-13

### Added

- **Shader: terminal** — scrolling terminal output with bitmap glyphs, discrete
  line-jump scrolling, and choppy cadence
- **Shader: clouds** — lightweight fBm cloud layer with parallax background layer
- **Shader: oscilloscope** — CRT oscilloscope with waveform traces, measurement
  grid, scanlines, and vignette
- **Starfield**: progressive tail growth — tails start at zero length and expand
  over star lifetime for realistic hyperspeed effect
- **Mandelbrot**: additional zoom targets (seahorse valley, elephant valley, double
  spiral, mini-brot, antenna tip, scepter valley), loop zoom mode replacing
  pingpong
- **Preview panel**: Playlists tab redesigned with shader/palette sub-tabs,
  corrected entry list ordering, playlist name input field

### Changed

- **Oscilloscope**: palette-derived background color, thicker grid lines
- **Clouds**: doubled scroll speed, added parallax background cloud layer

### Fixed

- **Packaging**: Cargo.toml version now committed to repo before release workflow
  runs, fixing deb/rpm version mismatch

### Deferred to v0.5.0

- Aurora (flat sky shader) — needs visual rework
- Fire shader improvements — reverted to v0.4.0 baseline pending fBm domain warp
  rewrite
- Wormhole improvements — center singularity artifact unresolved, reverted to
  v0.4.0 baseline
- Ping-pong FBO / dual framebuffer infrastructure
- Expanded terminal glyph character set

## [0.4.0] - 2026-04-11

### Added

- **`cycle.rs`**: `CycleManager` extracted from `wayland.rs`; tick()-driven scheduler with `CycleEvent` and `CycleOrder` (`Random` / `Sequential`) types
- **`preview.rs`**: windowed preview mode separated from `main.rs`; egui control panel with Shader, Palette, and Display sections; thumbnail previews; keyboard shortcuts (Space, ←/→, ↑/↓, R, F, T, Q)

### Changed

- Config path migrated to `~/.config/hypr/hyprsaver.toml`; legacy `~/.config/hyprsaver/config.toml` deprecated (warns on load, removal scheduled for v0.5.0)
- Shader directory migrated to `~/.config/hypr/hyprsaver/shaders/`; legacy `~/.config/hyprsaver/shaders/` deprecated

## [0.3.0] - 2026-04-09

### Added

- **Shaders**: geometry, hypercube, network, matrix, fire, caustics (6 new built-ins)
- **Cycle mode** for shaders and palettes with configurable intervals
  (`shader_cycle_interval`, `palette_cycle_interval` in `[general]` config)
- **Named playlists** for shader and palette cycling:
  `[shader_playlists.<name>]` and `[palette_playlists.<name>]` config sections;
  reference with `shader_playlist` / `palette_playlist` in `[general]`
- **CLI flags**: `--shader-cycle-interval`, `--palette-cycle-interval`,
  `--list-shader-playlists`, `--list-palette-playlists`
- **Shader descriptions** shown in `--list-shaders` output

### Changed

- Cycle mode now starts at a random position instead of alphabetically first
- Both monitors stay in sync during cycle transitions

### Removed

- `pipes` shader (visual artifacts on some GPU/driver combinations)
- `palette_test` example shader (use `--preview` mode instead)

### Fixed

- Cycle mode only updating one monitor when multi-monitor was configured
- Palette cycle not triggering at all (timer was registered but handler was incomplete)
- Shader and palette cycling not synchronized across monitors

## [0.2.0] - 2026-04-08

### Added

- **Shaders**: kaleidoscope, flow_field, donut, lissajous, starfield, snowfall
- **Preview mode**: xdg-toplevel window with docked egui control panel (shader/palette
  dropdowns, speed/zoom sliders with reset buttons)
- **LUT palette support**: load 256-color PNG strips as palettes via `type = "lut"` in
  config `[[palette]]` blocks
- **CSS-style gradient stop palettes** with built-ins: `sunset`, `aurora`, `midnight`
- **Palette crossfade transitions**: configurable `palette_transition_duration` in
  `[general]` config; smooth blend when cycling palettes
- **Per-monitor shader/palette assignment** via `[[monitor]]` config blocks
- **Fade in/out** wired to render pipeline (`fade_in_duration`, `fade_out_duration`)
- **`u_speed_scale` and `u_zoom_scale` uniforms** injected into all shaders (default 1.0);
  preview control panel sliders drive these values
- **Nix flake** for NixOS/Hyprland users (`nix run github:maravexa/hyprsaver`)
- **GitHub Actions CI**: fmt, clippy, test, audit, deny, msrv checks
- Architecture diagram updated to Mermaid in README

### Changed

- `starfield` shader renamed to `snowfall`; new `starfield` is a hyperspace zoom effect
- Snowfall: 5-layer parallax, size range 9 px → 0.7 px, rebalanced speeds, palette
  background tint
- Palette uniform names updated for multi-palette support:
  `u_palette_a/b/c/d` → `u_palette_a_a/b/c/d` (palette A cosine params)
- README installation section includes Nix and crates.io instructions

### Fixed

- Starfield: stars grow as they zoom in (were shrinking), full radial core glow,
  fading sampled tracers with 0.5 s lifetime, all stars palette-colored

## [0.1.1] - 2025-12-01

### Fixed

- Minor packaging and metadata corrections

## [0.1.0] - 2025-11-15

### Added

- Initial release
- Wayland-native layer-shell screensaver for Hyprland
- GPU-accelerated GLSL fragment shaders via OpenGL ES (glow)
- Multi-monitor support with one surface per output
- Cosine gradient palettes (Inigo Quilez technique) with 9 built-ins
- Shadertoy-compatible shader format with automatic uniform remapping
- Hot-reload shaders from `~/.config/hyprsaver/shaders/`
- Built-in shaders: mandelbrot, julia, plasma, tunnel, voronoi
- PID-file instance management (`--quit` to dismiss a running instance)
- Zero-config mode with sensible built-in defaults
- hypridle integration via `on-timeout` / `on-resume`

[0.4.5]: https://github.com/maravexa/hyprsaver/compare/v0.4.4...v0.4.5
[0.4.2]: https://github.com/maravexa/hyprsaver/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/maravexa/hyprsaver/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/maravexa/hyprsaver/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/maravexa/hyprsaver/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/maravexa/hyprsaver/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/maravexa/hyprsaver/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/maravexa/hyprsaver/releases/tag/v0.1.0
