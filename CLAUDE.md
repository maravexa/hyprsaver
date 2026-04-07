# CLAUDE.md — hyprsaver

## Project Overview
hyprsaver is a Wayland-native screensaver for Hyprland. It renders GLSL fractal shaders on fullscreen wlr-layer-shell overlay surfaces via OpenGL ES (glow). It integrates with hypridle (timeout orchestration) and coexists with hyprlock (lock screen). The two are intentionally separate — Unix philosophy.

## Architecture
Four layers, each a module in `src/`:
- `wayland.rs` — Wayland connection, output enumeration, layer-shell surface lifecycle. Uses smithay-client-toolkit. One surface per monitor.
- `renderer.rs` — OpenGL via glow. Fullscreen quad, uploads uniforms (time, resolution, palette vectors), calls draw. Doesn't know about Wayland.
- `shaders.rs` — Loads `.frag` files from config dir and built-ins. Handles compilation, hot-reload (notify crate), Shadertoy uniform remapping. Prepends palette function to all shaders.
- `palette.rs` — Cosine gradient palettes (Inigo Quilez technique). Four vec3 params (a,b,c,d) → 12 floats. Loaded from config TOML.
- `config.rs` — TOML config with serde. Every field has a default. Config path: CLI flag → XDG_CONFIG_HOME → ~/.config/hyprsaver/config.toml → built-in defaults.

Entry point: `main.rs` — CLI (clap), signal handling (signal-hook), config load, then either preview mode (xdg-toplevel window) or screensaver mode (layer-shell overlay). Event loop is calloop.

## Build & Run
```sh
cargo build --release
./target/release/hyprsaver              # screensaver mode (needs Hyprland)
./target/release/hyprsaver --preview mandelbrot  # windowed preview
```

## Key Design Decisions
- **glow over wgpu**: Thin OpenGL wrapper, minimal complexity for v1. wgpu is on the roadmap for v0.4.0 (Vulkan support).
- **Cosine palettes only (v1)**: 12 floats, no texture uploads. LUT/gradient palettes are v0.2.0.
- **Shadertoy compat**: Shaders use Shadertoy conventions (iTime, iResolution, mainImage). A shim in shaders.rs remaps to our uniforms. Users can paste Shadertoy code with minimal edits.
- **Palette as uniforms, not in-shader**: Palettes are uploaded as vec3 uniforms. Shaders call `palette(t)` with a float. This decouples color from math — any shader × any palette.
- **Belt-and-suspenders exit**: Exits on either (1) input events on the layer surface or (2) SIGTERM from hypridle's on-resume. Both paths must work independently.
- **Hot-reload**: Filesystem watcher on shader dir. On change, recompile shader; on compile error, log and keep current shader. No restart needed.

## Conventions
- Rust 2021 edition, stable toolchain
- `cargo fmt` and `cargo clippy` clean before every commit
- Error handling: `anyhow` for application errors, descriptive context on every `?`
- Logging: `log` macros (debug!/info!/warn!/error!), user runs with `RUST_LOG=hyprsaver=debug` for verbose output
- Shader files: `#version 320 es`, `precision highp float;`, uniforms prefixed `u_` (our convention) with Shadertoy aliases (iTime etc.) added by the shim
- Config: all fields optional with serde defaults. Zero-config must work.

## File Locations at Runtime
- Config: `~/.config/hyprsaver/config.toml`
- User shaders: `~/.config/hyprsaver/shaders/*.frag`
- Built-in shaders: compiled into binary via `include_str!()`
- Logs: stderr (journalctl if launched by hypridle)

## Testing Strategy
- Unit tests: palette math (color_at for known inputs), config deserialization (missing fields → defaults), Shadertoy shim (uniform remapping)
- Integration: `--preview` mode with a test shader, assert it opens a window and renders frames without panic
- Manual: run under Hyprland, verify layer surface appears on all monitors, verify input dismiss, verify SIGTERM dismiss, verify hot-reload

## What to Watch Out For
- smithay-client-toolkit API churn: SCTK 0.18→0.19 had breaking changes. Pin the version.
- EGL context creation on Wayland: glutin's Wayland support can be finicky. If issues arise, consider raw EGL via `khronos-egl` crate.
- AMD GPU (ROCm/Mesa): Test on both AMDGPU (Mesa) and proprietary. GLSL ES 3.20 should be fine on Mesa 24+.
- Multi-monitor with mixed DPI: layer surfaces report scale factor. The renderer must multiply resolution by scale for crisp rendering on HiDPI outputs.
- Shader compilation errors must never crash the process. Always fall back to a known-good built-in shader.

## Roadmap Summary
- v0.1.0: Core screensaver. Layer-shell, glow, cosine palettes, built-in shaders, hot-reload, preview mode.
- v0.2.0: LUT + gradient palettes, per-monitor config, palette transitions.
- v0.3.0: PipeWire audio reactivity, interactive mode, MPRIS integration.
- v0.4.0: wgpu backend, shader parameter GUI, community repo.
- v1.0.0: Stable config format, AUR/Nix packages, full Shadertoy uniform support.

## v0.1.0 Status

All core modules implemented:
- config.rs: TOML config with full defaults, CLI overrides
- palette.rs: Cosine gradient palettes, 7 built-ins, PaletteManager
- shaders.rs: Shader loading, Shadertoy compat shim, hot-reload via notify, 5 built-in shaders
- renderer.rs: glow-based OpenGL ES renderer, fullscreen quad, uniform upload
- wayland.rs: SCTK layer-shell surfaces, EGL context per output, input dismiss, calloop event loop
- main.rs: CLI (clap), signal handling, PID file, config→manager→run pipeline

### Known Limitations (v0.1.0)
- Fade in/out not implemented (config fields exist but are ignored)
- Preview mode (--preview) falls back to layer-shell mode with a warning
- Shader cycling timer is wired into the event loop but palette cycling by month is not
- Multi-monitor uses same shader+palette on all outputs (per-monitor config is v0.2.0)
- No audio reactivity, no interactive mouse input

### Next Implementation Priorities
1. Fade in/out (render alpha ramp)
2. Preview mode (xdg-toplevel fallback)
3. Palette cycling in the event loop
4. Per-monitor shader/palette assignment
5. LUT and gradient-stop palettes
