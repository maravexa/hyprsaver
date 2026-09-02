# hyprsaver

**A Wayland-native screensaver for Hyprland -- fractal shaders on wlr-layer-shell overlays**

[![CI](https://img.shields.io/github/actions/workflow/status/maravexa/hyprsaver/ci.yml?label=CI)](https://github.com/maravexa/hyprsaver/actions)
[![Crates.io](https://img.shields.io/crates/v/hyprsaver)](https://crates.io/crates/hyprsaver)
[![AUR](https://img.shields.io/aur/version/hyprsaver)](https://aur.archlinux.org/packages/hyprsaver)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## What is hyprsaver?

hyprsaver is a GPU-accelerated screensaver for [Hyprland](https://hyprland.org). It renders GLSL fragment shaders as fullscreen overlays on every connected monitor using the [wlr-layer-shell](https://wayland.app/protocols/wlr-layer-shell-unstable-v1) Wayland protocol -- a proper Wayland citizen, not a window hack.

It is designed to complement [hyprlock](https://github.com/hyprwm/hyprlock) and [hypridle](https://github.com/hyprwm/hypridle). Screensaver and lock screen are separate concerns: hyprsaver blankets your monitor with beautiful fractals, hypridle triggers it after a configurable idle timeout, and hyprlock handles authentication when you want to resume. Each tool does one thing well.

---


## Quick Start

### Arch Linux
```bash
yay -S hyprsaver
```

### Cargo Install
```bash
cargo install hyprsaver
```

## Shader Previews

<details>
<summary>Click to expand shader gallery</summary>

| Shader | Preview |
|---|---|
| **attitude** | ![attitude](https://maravexa.github.io/hyprsaver/gallery/attitude.webp) |
| **aurora** | ![aurora](https://maravexa.github.io/hyprsaver/gallery/aurora.webp) |
| **bezier** | ![bezier](https://maravexa.github.io/hyprsaver/gallery/bezier.webp) |
| **blob** | ![blob](https://maravexa.github.io/hyprsaver/gallery/blob.webp) |
| **caustics** | ![caustics](https://maravexa.github.io/hyprsaver/gallery/caustics.webp) |
| **circuit** | ![circuit](https://maravexa.github.io/hyprsaver/gallery/circuit.webp) |
| **clouds** | ![clouds](https://maravexa.github.io/hyprsaver/gallery/clouds.webp) |
| **donut** | ![donut](https://maravexa.github.io/hyprsaver/gallery/donut.webp) |
| **fibonacci** | ![fibonacci](https://maravexa.github.io/hyprsaver/gallery/fibonacci.webp) |
| **fireflies** | ![fireflies](https://maravexa.github.io/hyprsaver/gallery/fireflies.webp) |
| **flames** | ![flames](https://maravexa.github.io/hyprsaver/gallery/flames.webp) |
| **fractaltrap** | ![fractaltrap](https://maravexa.github.io/hyprsaver/gallery/fractaltrap.webp) |
| **geometry** | ![geometry](https://maravexa.github.io/hyprsaver/gallery/geometry.webp) |
| **gridwave** | ![gridwave](https://maravexa.github.io/hyprsaver/gallery/gridwave.webp) |
| **hypercube** | ![hypercube](https://maravexa.github.io/hyprsaver/gallery/hypercube.webp) |
| **julia** | ![julia](https://maravexa.github.io/hyprsaver/gallery/julia.webp) |
| **kaleidoscope** | ![kaleidoscope](https://maravexa.github.io/hyprsaver/gallery/kaleidoscope.webp) |
| **lissajous** | ![lissajous](https://maravexa.github.io/hyprsaver/gallery/lissajous.webp) |
| **marble** | ![marble](https://maravexa.github.io/hyprsaver/gallery/marble.webp) |
| **matrix** | ![matrix](https://maravexa.github.io/hyprsaver/gallery/matrix.webp) |
| **mobius** | ![mobius](https://maravexa.github.io/hyprsaver/gallery/mobius.webp) |
| **oscilloscope** | ![oscilloscope](https://maravexa.github.io/hyprsaver/gallery/oscilloscope.webp) |
| **planet** | ![planet](https://maravexa.github.io/hyprsaver/gallery/planet.webp) |
| **plasma** | ![plasma](https://maravexa.github.io/hyprsaver/gallery/plasma.webp) |
| **shipburn** | ![shipburn](https://maravexa.github.io/hyprsaver/gallery/shipburn.webp) |
| **snowfall** | ![snowfall](https://maravexa.github.io/hyprsaver/gallery/snowfall.webp) |
| **sonar** | ![sonar](https://maravexa.github.io/hyprsaver/gallery/sonar.webp) |
| **starfield** | ![starfield](https://maravexa.github.io/hyprsaver/gallery/starfield.webp) |
| **stonks** | ![stonks](https://maravexa.github.io/hyprsaver/gallery/stonks.webp) |
| **temple** | ![temple](https://maravexa.github.io/hyprsaver/gallery/temple.webp) |
| **terminal** | ![terminal](https://maravexa.github.io/hyprsaver/gallery/terminal.webp) |
| **tesla** | ![tesla](https://maravexa.github.io/hyprsaver/gallery/tesla.webp) |
| **tunnel** | ![tunnel](https://maravexa.github.io/hyprsaver/gallery/tunnel.webp) |
| **voronoi** | ![voronoi](https://maravexa.github.io/hyprsaver/gallery/voronoi.webp) |
| **waterfall** | ![waterfall](https://maravexa.github.io/hyprsaver/gallery/waterfall.webp) |
| **wormhole** | ![wormhole](https://maravexa.github.io/hyprsaver/gallery/wormhole.webp) |

</details>

## Architecture

hyprsaver is structured as four independent layers that communicate through clean interfaces:

<details>
<summary>Architecture</summary>

```mermaid
graph TD
    subgraph core ["Core Modules"]
        main["main.rs<br/>CLI · clap · signal-hook · PID file guard"]
        config["config.rs<br/>TOML + serde · XDG paths · zero-config"]
        wayland["wayland.rs<br/>layer-shell surfaces · output hotplug · input events"]
        renderer["renderer.rs<br/>glow · fullscreen quad · uniform uploads"]
        shaders["shaders.rs<br/>load/compile · hot-reload · Shadertoy shim"]
        palette["palette.rs<br/>cosine gradient · 12 floats"]
    end

    subgraph ext ["External Protocols"]
        layershell(["wlr-layer-shell"])
        egl(["EGL / GLES2"])
        calloop(["calloop"])
    end

    subgraph files ["User File Paths"]
        configfile[("~/.config/hypr/hyprsaver.toml")]
        shaderfiles[("~/.config/hypr/hyprsaver/shaders/*.frag")]
        pidfile[("$XDG_RUNTIME_DIR/hyprsaver.pid")]
    end

    main --> config
    main --> wayland
    main --> renderer
    config -->|SurfaceConfig| wayland
    shaders -->|compiled program| renderer
    palette -->|uniform vec3s| renderer
    wayland -->|frame callbacks| renderer

    wayland --- layershell
    renderer --- egl
    main --- calloop

    configfile --> config
    shaderfiles --> shaders
    pidfile --> main
```

</details>

`renderer.rs` knows nothing about Wayland. `wayland.rs` knows nothing about OpenGL. `shaders.rs` knows nothing about palettes at upload time -- it only prepends the GLSL `palette()` function. This makes each layer independently testable and replaceable (a future wgpu backend only needs to replace `renderer.rs`).

---

## Manual Installation

1. Build and install:
   ```
   git clone https://github.com/maravexa/hyprsaver
   cd hyprsaver
   make install
   ```

2. Test it (launches screensaver immediately):
   ```
   hyprsaver
   ```
   Press any key or move the mouse to dismiss.

3. Add to your hypridle config (`~/.config/hypr/hypridle.conf`):
   ```ini
   listener {
       timeout = 600
       on-timeout = hyprsaver
       on-resume = hyprsaver --quit
   }
   ```

4. Customize (`~/.config/hypr/hyprsaver.toml`):
   ```toml
   [general]
   shader = "julia"
   palette = "vaporwave"

   [behavior]
   fade_in_ms = 800
   fade_out_ms = 400

   # Per-monitor overrides (run `hyprctl monitors` for output names)
   [[monitor]]
   name = "DP-1"
   shader = "donut"
   palette = "frost"
   ```

---

## Features

- **Wayland-native** via wlr-layer-shell -- not a window, a proper overlay surface
- **GPU-accelerated GLSL** fragment shaders via OpenGL ES (glow crate)
- **Multi-monitor** support -- one surface per output, with per-monitor shader/palette assignment via `[[monitor]]` config blocks
- **HiDPI and fractional scaling** -- correct rendering on 1.25×, 1.5×, and 2× outputs via `wp-fractional-scale-v1` + `wp_viewporter`
- **Cosine gradient palettes** -- 12 floats define smooth, infinite color ramps. Any shader x any palette
- **Shadertoy-compatible** shader format -- paste Shadertoy code with minimal edits, it just works
- **Hot-reload** shaders from `~/.config/hypr/hyprsaver/shaders/` -- edit, save, see the change instantly
- **Cycle mode** for shaders and palettes -- rotate through all or a named playlist on a configurable interval
- **Built-in shader collection** (36 shaders):

  | Name            | Description                                          |
  |-----------------|------------------------------------------------------|
  | `julia`         | Julia set with animated parameter                    |
  | `shipburn`      | Burning Ship Julia — absolute-value folding produces angular, mirror-symmetric ship silhouettes |
  | `fractaltrap`   | Julia with orbit-trap coloring — stained-glass / cellular aesthetic, no solid interior |
  | `plasma`        | Classic plasma effect                                |
  | `tunnel`        | Infinite tunnel flythrough                           |
  | `voronoi`       | Animated Voronoi cells                               |
  | `snowfall`      | Five-layer parallax snowfall with palette dot glow   |
  | `starfield`     | Hyperspace zoom tunnel with motion-blur tracers      |
  | `aurora`        | Overhead aurora curtains — domain-warped FBM with striation ridges and filament shimmer |
  | `kaleidoscope`  | 6-fold kaleidoscope driven by domain-warped FBM      |
  | `marble`        | Curl-noise flow field with 8-step particle tracing   |
  | `donut`         | Raymarched torus with Phong lighting and fog         |
  | `flames`        | fBm fire with domain warping, turbulence noise, and fractal flame-tip boundary |
  | `lissajous`     | Three overlapping Lissajous curves with glow         |
  | `geometry`      | Wireframe polyhedron morphing (cube→icosahedron→...) |
  | `hypercube`     | Rotating 4D tesseract projected to 2D, neon glow     |
  | `circuit`       | Brick-offset grid with hash-gated traces and gradient pulses — PCB / circuit network |
  | `sonar`         | Multi-source wavefront interference with rotating radial sweep — sonar scope |
  | `matrix`        | Classic Matrix digital rain with procedural glyphs   |
  | `caustics`      | Underwater caustic light patterns                    |
  | `clouds`        | Slowly drifting procedural clouds (plain 5-octave fBm) |
  | `bezier`        | Five animated Bézier curves with additive palette glow |
  | `planet`        | Raymarched planet sphere with aurora borealis bands and noise-perturbed curtains |
  | `tesla`         | Tesla coil arcs — fractal-lightning between three electrodes with branching |
  | `terminal`      | Scrolling build-log output — block-glyph rows scroll upward with CRT scanlines and phosphor glow |
  | `oscilloscope`  | Realistic CRT oscilloscope — three animated waveform traces over a phosphor grid with scanlines and vignette |
  | `temple`        | Retro temple interior — floor + ceiling triangle-wave lattice, 4 scrolling pillars with ring trace pattern, CRT scanlines |
  | `wormhole`      | Curved-tunnel raymarch with z-dominant palette rings |
  | `gridwave`      | Perspective-projected neon grid with scrolling forward motion — Tron / Outrun aesthetic |
  | `blob`          | Lit blob with flowing energy emission and atmospheric halo — warped sphere SDF, Phong lighting |
  | `mobius`        | Race along a twisted Möbius ribbon against the void — palette gradient flips after each full loop |
  | `fireflies`     | Warm glowing wanderers drifting across a dark field, per-firefly palette colors |
  | `stonks`        | Procedural candlestick chart with MACD oscillator — palette-sampled bull/bear colors |
  | `attitude`      | Artificial-horizon instrument with simulated flight motion |
  | `waterfall`     | Stylized 2D waterfall with retro quantize-and-dither post |
  | `fibonacci`     | Phyllotaxis sunflower — golden-angle seed spiral growing outward, Fibonacci parastichy arms, golden log-spiral overlay |
- **Built-in palette collection**: rainbow, autumn, vaporwave, frost, ember, ocean, monochrome, sunset, aurora, midnight
- Configurable FPS and dismiss triggers
- **Preview mode** for shader authoring (`--preview <shader>`) with speed/zoom control panel
- **PID file based instance management** (`--quit` to signal a running instance)
- Zero-config: works with no config file, sensible defaults throughout
- Clean integration with hypridle and hyprlock

---

## GPU Performance

### GPU Performance (v0.4.4)

Benchmarked on AMD HawkPoint1 (GMKtec Nucbox K12) with dual 1920×1200 monitors.

- **Lightweight (<25% GPU):** Caustics, Flames, Matrix, Oscilloscope, Planet, Plasma, Tunnel
- **Medium (25–50% GPU):** Aurora, Bezier, Donut, Fractaltrap, Geometry, Hypercube, Julia, Kaleidoscope, Lissajous, Marble, Network, Shipburn, Snowfall, Starfield, Temple, Tesla, Voronoi
- **Heavy (51–75% GPU):** None at steady state (Geometry spikes to 55% during shape transitions only)

All shaders previously in the Heavy tier (Bezier, Geometry, Lissajous, Marble, Network, Snowfall, Starfield) were optimized in v0.4.3. See `docs/BENCHMARK_0.4.3.md` for full results. New shaders in v0.4.4: see `docs/BENCHMARK_0.4.4.md`.

Since v0.4.7 the numbers come from `hyprsaver bench`, which renders every shader headlessly and reports ms/frame and the share of the 30 fps frame budget for two 1920×1200 monitors (`docs/BENCHMARK_0.4.7.md`). It measures pure render throughput, so its percentages sit well below the old `radeontop` readings, but the ranking and the tier thresholds are the same:

```sh
hyprsaver bench                      # every built-in shader, sorted by cost
hyprsaver bench geometry --frames 240 --span 30
hyprsaver bench --markdown > docs/BENCHMARK_x.y.z.md
```

---

## Installation

### Build from Source

Requires the Rust stable toolchain, development headers for Wayland (`wayland-devel` / `libwayland-dev`), and EGL (`mesa-libEGL-devel` / `libegl-dev`).

```sh
git clone https://github.com/maravexa/hyprsaver
cd hyprsaver
make install          # builds release and installs to /usr/local/bin
```

Or manually:

```sh
cargo build --release
sudo install -Dm755 target/release/hyprsaver /usr/local/bin/hyprsaver
```

To install to a custom prefix:

```sh
make install PREFIX=/usr
```

To uninstall:

```sh
make uninstall
```

### AUR

```sh
yay -S hyprsaver
```

### Debian / Ubuntu

```bash
# Download the .deb from the latest release
sudo dpkg -i hyprsaver_0.4.7_amd64.deb
```

### Fedora / RHEL / openSUSE

```bash
# Download the .rpm from the latest release
sudo rpm -i hyprsaver-0.4.7-1.x86_64.rpm
```

### Nix / NixOS

A Nix flake is included in the repository root.

**Run without installing:**

```sh
nix run github:maravexa/hyprsaver
```

**Add to your NixOS / Home Manager flake:**

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    hyprsaver.url = "github:maravexa/hyprsaver";
  };

  outputs = { self, nixpkgs, hyprsaver, ... }: {
    # NixOS system config:
    nixosConfigurations.myhostname = nixpkgs.lib.nixosSystem {
      modules = [
        ({ pkgs, ... }: {
          environment.systemPackages = [
            hyprsaver.packages.${pkgs.system}.default
          ];
        })
      ];
    };
  };
}
```

**Development shell** (includes Rust stable + rust-analyzer + clippy):

```sh
nix develop github:maravexa/hyprsaver
```

> **NixOS note**: `libGL` and `libEGL` are dlopen'd at runtime. The flake's
> `devShell` sets `LD_LIBRARY_PATH` automatically. If you run the installed
> binary outside the dev shell, wrap it with:
> ```sh
> LD_LIBRARY_PATH=$(nix eval --raw 'nixpkgs#mesa')/lib:$LD_LIBRARY_PATH hyprsaver
> ```
> or use `programs.hyprsaver.enable` once a NixOS module is added (planned for v1.0.0).

---

## Integration with Hyprland

Example configuration files for hypridle and hyprland are provided in the [`examples/`](examples/) directory.

### hypridle.conf

The recommended setup: hypridle triggers hyprsaver after 10 minutes of idle, then hyprlock after 20 minutes.

```ini
# ~/.config/hypridle/hypridle.conf

general {
    lock_cmd = hyprlock          # run hyprlock when the session is locked
    ignore_dbus_inhibit = false  # respect Wayland idle inhibitors (video players, etc.)
}

listener {
    timeout = 600                # 10 minutes -> start screensaver
    on-timeout = hyprsaver
    on-resume = hyprsaver --quit # dismiss screensaver when activity resumes
}

listener {
    timeout = 1200               # 20 minutes -> lock screen
    on-timeout = hyprlock
}
```

> **Note**: hypridle respects `org.freedesktop.ScreenSaver.Inhibit` (set by most video players and browsers during full-screen playback), so hyprsaver is automatically suppressed while you watch a film.

### hyprland.conf (optional hotkey)

```ini
# Start/stop the screensaver manually
bind = $mod, F12, exec, hyprsaver
bind = , escape, exec, hyprsaver --quit
```

---

## Configuration

The config file lives at `~/.config/hypr/hyprsaver.toml`. It is entirely optional -- hyprsaver runs with built-in defaults if no file exists.

> **Upgrading from v0.1.x?** The config path moved from `~/.config/hyprsaver/config.toml` to
> `~/.config/hypr/hyprsaver.toml` and the shader directory from `~/.config/hyprsaver/shaders/`
> to `~/.config/hypr/hyprsaver/shaders/`. The old paths are still recognised with a deprecation
> warning — move your files at your convenience.

A full annotated example is provided at [`examples/hyprsaver.toml`](examples/hyprsaver.toml).

### Minimal Config

```toml
[general]
shader = "julia"
palette = "vaporwave"
fps = 30
```

### Full Reference

```toml
[general]
fps = 30                          # render frame rate
shader = "cycle"                  # a shader name, "random", or "cycle" (default)
palette = "cycle"                 # a palette name, "random", or "cycle" (default)
shader_cycle_interval = 300       # seconds per shader when shader = "cycle"
palette_cycle_interval = 60       # seconds per palette when palette = "cycle"
cycle_order = "random"            # "random" (default) or "sequential"
synced = true                     # sync monitors in cycle mode (default: true)
shader_playlist = "default"       # playlist name for shader cycling
palette_playlist = "default"      # playlist name for palette cycling

[behavior]
fade_in_ms = 800               # fade-in duration
fade_out_ms = 400              # fade-out duration
dismiss_on = ["key", "mouse_move", "mouse_click", "touch"]
exclusive_keyboard = true      # grab the keyboard so any key dismisses; false = rely on --quit only

# Playlists group shaders and palettes together for cycle mode.
# "all" = all available shaders/palettes. If "default" is not defined, it
# implicitly expands to ["all"] for both.
[playlists.default]
shaders = ["all"]
palettes = ["all"]

[playlists.chill]
shaders = ["plasma", "marble", "bezier", "lissajous", "planet"]
palettes = ["vaporwave", "frost", "ocean", "aurora"]

# Custom palettes are defined as top-level [palettes.<name>] sections
[palettes.my_palette]
a = [0.5, 0.5, 0.5]
b = [0.5, 0.5, 0.5]
c = [1.0, 1.0, 1.0]
d = [0.00, 0.33, 0.67]

# Optional shader→palette overrides for the `render-preview` subcommand.
# Any shader not listed falls back to a stable hash-based default.
[render_preview.palettes]
blob = "marsha"
mobius = "achilles"
```

### Cycle Mode

By default, hyprsaver cycles through all shaders and palettes (`shader = "cycle"`, `palette = "cycle"`):

```toml
[general]
shader = "cycle"
shader_cycle_interval = 300   # advance every 5 minutes

palette = "cycle"
palette_cycle_interval = 60   # advance every minute

cycle_order = "random"        # "random" (default) or "sequential"
synced = true                 # all monitors cycle together (default)
```

To cycle only a subset, define a playlist and reference it:

```toml
[general]
shader = "cycle"
shader_playlist = "chill"

[playlists.chill]
shaders = ["snowfall", "starfield", "tunnel", "plasma"]
palettes = ["vaporwave", "frost", "ocean"]
```

On startup, cycle mode begins at a random position in the playlist so each session looks different. Use `--list-shader-playlists` or `--list-palette-playlists` to inspect defined playlists.

### Playlists

Playlists are named subsets used with cycle mode. Each playlist can contain both a `shaders` and `palettes` list. Define them under `[playlists]` and reference by name in `[general]`:

```toml
[general]
shader_playlist = "chill"      # use the "chill" playlist for shaders
palette_playlist = "chill"     # use the "chill" playlist for palettes

[playlists.default]
shaders = ["all"]              # "all" = every built-in + user shader
palettes = ["all"]

[playlists.chill]
shaders = ["plasma", "marble", "bezier", "lissajous", "planet"]
palettes = ["vaporwave", "frost", "ocean", "aurora"]

[playlists.intense]
shaders = ["shipburn", "fractaltrap", "julia", "tesla", "kaleidoscope", "flames"]
palettes = ["rainbow", "ember", "groovy"]
```

If the `"default"` playlist is not defined, it implicitly expands to `["all"]` for both shaders and palettes.

`shader_playlist` and `palette_playlist` can reference different playlists, or the same one.

Unknown shader or palette names in a playlist are skipped with a warning. If a playlist resolves to empty, all available shaders/palettes are cycled instead.

> **Upgrading from v0.3.0?** The separate `[shader_playlists.*]` and `[palette_playlists.*]` sections
> still work for backward compatibility. The new unified `[playlists.*]` format is preferred.

### Cosine Gradient Palettes

Palettes use Inigo Quilez's cosine gradient technique. The formula is:

```
color(t) = a + b * cos(2pi * (c * t + d))
```

where `a`, `b`, `c`, `d` are RGB vectors and `t` is in [0, 1].

- **a** -- average brightness (midpoint of the oscillation)
- **b** -- amplitude/contrast of each channel
- **c** -- frequency (1.0 = one hue cycle; 2.0 = two cycles)
- **d** -- phase shift (rotates each channel's hue independently)

Full mathematical background: [https://iquilezles.org/articles/palettes/](https://iquilezles.org/articles/palettes/)

---

## Writing Custom Shaders

Drop `.frag` files in `~/.config/hypr/hyprsaver/shaders/`. They are available immediately by filename stem (e.g. `my_effect.frag` -> `--shader my_effect`).

### Shader Format

hyprsaver shaders are GLSL ES 3.20 fragment shaders with these uniforms available:

```glsl
#version 320 es
precision highp float;

uniform float u_time;        // seconds since screensaver started
uniform vec2  u_resolution;  // physical pixel dimensions of the surface
uniform vec2  u_mouse;       // last mouse position (window-space pixels)
uniform int   u_frame;       // frame counter, starts at 0

// Cosine gradient palette -- set by the active palette config (v0.2.0+ names)
uniform vec3  u_palette_a_a;   // brightness
uniform vec3  u_palette_a_b;   // amplitude
uniform vec3  u_palette_a_c;   // frequency
uniform vec3  u_palette_a_d;   // phase
// LUT palette (texture units 1/2) and blend factor are also injected automatically
uniform sampler2D u_lut_a;
uniform int       u_use_lut;   // 0 = cosine, 1 = LUT
uniform float     u_palette_blend;

// Speed/zoom controls (preview panel drives these; daemon always sends 1.0)
uniform float u_speed_scale;
uniform float u_zoom_scale;

// Previous frame (feedback / ping-pong). Sampling this uniform is what turns
// the buffers on: texture(u_prev_frame, gl_FragCoord.xy / u_resolution).
// Black on the first frame, after a resize, and whenever the shader is loaded.
uniform sampler2D u_prev_frame;

out vec4 fragColor;

// Palette helper -- included automatically, always available
// Signature unchanged from v0.1.x; implementation handles cosine + LUT modes
vec3 palette(float t);
```

### Minimal Example Shader

```glsl
#version 320 es
precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform float u_speed_scale;

out vec4 fragColor;

// palette() is injected automatically — no need to declare it yourself

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    float t = length(uv - 0.5) * 3.0 - u_time * u_speed_scale * 0.5;
    fragColor = vec4(palette(fract(t)), 1.0);
}
```

### Shadertoy Compatibility

hyprsaver accepts shaders written in Shadertoy's convention. The following remappings are applied automatically:

| Shadertoy uniform | hyprsaver uniform |
|---|---|
| `iTime` | `u_time` |
| `iResolution` | `vec3(u_resolution, 0.0)` |
| `iMouse` | `vec4(u_mouse, 0.0, 0.0)` |
| `iFrame` | `u_frame` |

If your shader contains `void mainImage(out vec4 fragColor, in vec2 fragCoord)`, a `void main()` wrapper is appended automatically. You can paste most Shadertoy shaders directly (note: `iChannel` texture uniforms are not yet supported -- v1.0.0).

### Preview Mode — Control Panel

`--preview` opens a desktop window split into two regions:

- **Left**: live shader viewport
- **Right**: 300-px egui control panel

The panel provides:

| Tab | Contents |
|-----|----------|
| **Preview** | Shader and palette dropdowns with thumbnails, **Speed** slider (0.1× – 3.0×, applies live), **Test Transition** button for the shader crossfade |
| **Playlists** | Build and edit `[playlists.<name>]` entries (saved to your config), **Apply & Restart Cycle** |
| **Palette** | Palette dropdown with gradient previews, transition speed slider, **Test Palette Transition** button |

Keyboard shortcuts always active in the preview window:

| Key | Action |
|-----|--------|
| `Q` / `Esc` | Quit preview |
| `Space` | Pause / resume animation |
| `←` / `→` | Previous / next shader |
| `↑` / `↓` | Previous / next palette |
| `R` | Reset shader time to zero |
| `F` | Toggle fullscreen viewport (hides the panel) |
| `T` | Test the shader crossfade transition |
| `I` | Toggle the FPS overlay |

Shaders hot-reload automatically when the file on disk changes.

> **Note:** The speed slider only affects the preview window — the daemon always uses `u_speed_scale = 1.0` (and `u_zoom_scale = 1.0`) unless you add those uniforms to your own shader logic.

### Hot-Reload Workflow

```sh
# Open a live preview window
hyprsaver --preview my_shader

# In another terminal, edit the shader -- changes appear within one second
$EDITOR ~/.config/hypr/hyprsaver/shaders/my_shader.frag
```

Compile errors are logged to stderr; the last working shader continues running.

---

## Writing Custom Palettes

A palette is just four RGB vectors in TOML. Add them to `config.toml`:

```toml
[palettes.my_palette]
a = [0.5, 0.4, 0.3]   # midpoint brightness per channel
b = [0.5, 0.4, 0.3]   # oscillation amplitude
c = [1.0, 1.0, 0.5]   # frequency (0.5 = half a cycle for blue)
d = [0.00, 0.15, 0.30] # phase offset (shifts each channel's hue)
```

**Tips for palette design:**
- Keep `a + b <= 1.0` per channel to avoid clipping
- `d = [0.00, 0.33, 0.67]` evenly spaces RGB phases -> classic rainbow
- `c = [1.0, 1.0, 1.0]` means one full color cycle per sweep of `t`
- Low `b` values (e.g. `[0.2, 0.2, 0.2]`) produce subtle, pastel gradients
- `a = [0.8, 0.7, 0.6]`, `b = [0.2, 0.2, 0.2]` -> warm cream with gentle color hints

Palettes are tiny and easy to share -- post them as four TOML lines.

### Palette Tuning Workflow

For fast iteration when designing or tweaking palettes:

1. Launch hyprsaver in preview mode with any shader and your target palette:
   ```bash
   hyprsaver --preview julia --palette autumn
   ```

2. Edit your palette values in `~/.config/hypr/hyprsaver.toml`:
   ```toml
   [palettes.my_custom_palette]
   a = [0.5, 0.3, 0.2]
   b = [0.5, 0.4, 0.3]
   c = [1.0, 1.0, 1.0]
   d = [0.0, 0.1, 0.2]
   ```

3. Hot-reload picks up config changes automatically — save the file and the
   palette updates live on screen. No restart needed.

The cosine palette formula is `color(t) = a + b × cos(2π × (c × t + d))`.
Each channel ranges from `a - b` (minimum) to `a + b` (maximum). Adjust `d`
values to control where each color channel peaks relative to the others.
For a deeper explanation, see
[Inigo Quilez's palette article](https://iquilezles.org/articles/palettes/).

---

## CLI Reference

```
hyprsaver [OPTIONS]

OPTIONS:
    -c, --config <PATH>              Path to config file (overrides XDG default)
    -s, --shader <NAME>              Shader to use (name, "random", or "cycle")
    -p, --palette <NAME>             Palette to use (name, "random", or "cycle")
        --shader-cycle-interval <N>  Override shader cycle interval (seconds)
        --shader-interval <N>        Shorter alias for --shader-cycle-interval
        --palette-cycle-interval <N> Override palette cycle interval (seconds)
        --palette-interval <N>       Shorter alias for --palette-cycle-interval
        --cycle-order <ORDER>        Cycle order: "random" (default) or "sequential"
        --synced                     All monitors cycle in sync (default)
        --no-synced                  Each monitor cycles independently
        --playlist <NAME>            Set both shader and palette playlist by name
        --list-shaders               Print all available shader names and exit
        --list-palettes              Print all available palette names and exit
        --list-shader-playlists      Print all defined shader playlists and exit
        --list-palette-playlists     Print all defined palette playlists and exit
        --quit                       Send SIGTERM to the running hyprsaver instance
        --preview                    Open a windowed preview (combine with --shader)
    -v, --verbose                    Enable debug logging (RUST_LOG=hyprsaver=debug)
    -h, --help                       Print help
    -V, --version                    Print version

SUBCOMMANDS (headless — no compositor needed):
    render-preview [SHADER]...       Render animated WebP previews (480×270, 3 s, 15 fps by default)
                                     Options: --palette, --cycle-palettes, --duration, --resolution,
                                     --fps, --quality, --seed, --skip-existing, -o/--output
    bench [SHADER]...                Benchmark GPU cost: ms/frame and share of the frame budget
                                     Options: --resolution (1920x1200), --monitors (2), --fps (30),
                                     --frames (120), --span (30 s), --warmup, --palette,
                                     --markdown, --json <PATH>, --sort cost|name
```

**Examples:**

```sh
# Start with a specific shader and palette
hyprsaver --shader julia --palette vaporwave

# Cycle through all shaders every 2 minutes
hyprsaver --shader cycle --shader-interval 120

# Cycle through a specific playlist
hyprsaver --shader cycle --playlist chill

# Cycle sequentially instead of randomly
hyprsaver --shader cycle --cycle-order sequential

# Each monitor cycles independently
hyprsaver --no-synced

# Preview a custom shader while editing it
hyprsaver --preview --shader my_shader

# See what's available
hyprsaver --list-shaders
hyprsaver --list-palettes
hyprsaver --list-shader-playlists

# Dismiss the running screensaver (e.g. from a hotkey)
hyprsaver --quit
```

---

## Roadmap

Full history lives in `CHANGELOG.md`; the working backlog is `docs/backlog.md`.

### Shipped in v0.4.6

- **Fix:** a daemon whose output went DPMS-off or was unplugged could wedge inside the GPU driver, ignore `--quit` / SIGTERM, and keep its exclusive keyboard grab so no window in the session could be focused. Rendering now paces on compositor frame callbacks with swap interval 0, and a shutdown watchdog force-exits a stuck event loop
- **Fractional scaling** (`wp-fractional-scale-v1` + `wp_viewporter`): correct rendering on 1.25×, 1.5×, and 2× outputs — contributed by [@livmackintosh](https://github.com/livmackintosh)
- **Config:** `[behavior] exclusive_keyboard` to opt out of the exclusive keyboard grab
- **Preview:** the speed slider applies live, no restart needed
- Internal refactors from the codebase audit (shared EGL state, playlist cursor, table-driven uniform injection)

### Shipped in v0.4.5

- 5 new Lightweight shaders: Fireflies, Stonks, Attitude, Waterfall, Mobius
- Triangle-wrap palette sampling across 11 shaders (no seam on directional palettes)
- `render-preview` subcommand (animated WebP, batch mode, `--skip-existing`) replaces `render-gif`
- `[render_preview.palettes]` shader→palette overrides
- Preview UI: FPS overlay toggle (`I`), palette tab dropdown parity, palette transition test button

### Shipped in v0.4.4

- 7 new shaders: Wormhole, Blob, Gridwave, Circuit, Sonar, Shipburn, Fractaltrap
- Pride palette pack and `pride` playlist
- Persistent shuffle bag across launches
- Removed: Mandelbrot (deep-zoom GPU mismatch), Network (replaced by Circuit + Sonar)

### Shipped in v0.4.7

- Benchmark automation (`hyprsaver bench`) and a Geometry optimization pass
- CI pipeline that regenerates and deploys the WebP gallery through GitHub Pages
- Ping-pong FBO support in the renderer (feedback shaders)
- Terminal shader glyph set expansion; one new math-themed shader

### v0.5.0

- Screencopy pipeline (blurred desktop as shader input) and a Rain-on-Glass shader
- Legacy config path fallback removed (`~/.config/hyprsaver/`)

### v1.0.0

- Stable install story (AUR, Nix module)
- Stable config format -- no breaking changes after this
- Full Shadertoy uniform support: `iChannel` textures, `iDate`, `iSampleRate`
- wgpu / Vulkan backend
- Comprehensive documentation and shader authoring guide

---

## Contributing

Contributions are welcome. Fork, create a branch, submit a pull request.

**Shader and palette contributions have the lowest barrier to entry** -- a new built-in shader is just a `.frag` file plus an entry in `shaders.rs`. A new palette is four lines of TOML and a constant in `palette.rs`. If you've made something beautiful, please share it.

For larger contributions, open an issue first to discuss the approach.

Before submitting:
```sh
cargo fmt
cargo clippy -- -D warnings
cargo test
```

---

## License

MIT -- see [LICENSE](LICENSE).

---

## Acknowledgments

- **[Inigo Quilez](https://iquilezles.org/)** -- for the cosine gradient palette technique, the smooth iteration coloring technique used in the Julia family shaders, and for [Shadertoy](https://www.shadertoy.com), the best shader playground in existence.
- **[Hyprland](https://hyprland.org)** and the [hyprwm](https://github.com/hyprwm) ecosystem (hyprlock, hypridle) -- for building a compositor worth building screensavers for.
- **[wlr-protocols](https://gitlab.freedesktop.org/wlroots/wlr-protocols)** -- for `zwlr_layer_shell_v1`, which makes proper Wayland screensavers possible.
- **[smithay](https://github.com/Smithay/smithay)** -- for smithay-client-toolkit, the best Rust Wayland client toolkit.
- **[glow](https://github.com/grovesNL/glow)** -- for a sane OpenGL abstraction that doesn't require unsafe everywhere.
