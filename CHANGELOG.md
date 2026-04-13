# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-04-13

### Added

- **Shaders**: oscilloscope, clouds, aurora (3 new built-ins; total 25)

### Fixed

- Doc comment example paths updated from legacy `~/.config/hyprsaver/` to canonical `~/.config/hypr/hyprsaver/`

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

[0.4.1]: https://github.com/maravexa/hyprsaver/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/maravexa/hyprsaver/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/maravexa/hyprsaver/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/maravexa/hyprsaver/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/maravexa/hyprsaver/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/maravexa/hyprsaver/releases/tag/v0.1.0
