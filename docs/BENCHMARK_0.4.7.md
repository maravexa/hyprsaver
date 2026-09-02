# Benchmark — hyprsaver v0.4.7

First benchmark produced by `hyprsaver bench` instead of reading `radeontop`.

## Test Configuration

| Parameter | Value |
|---|---|
| **Device** | GMKtec NucBox K12 |
| **GPU** | AMD Radeon 780M (HawkPoint1, radeonsi / ACO, Mesa 26.1.7) |
| **Command** | `hyprsaver bench --markdown` |
| **Resolution** | 1920×1200 per monitor × 2 monitors |
| **Frame budget** | 33.33 ms (30 fps) |
| **Sampling** | 120 timed frames spread over 30 s of shader time, 15 warm-up frames, `glFinish` bracketed |
| **Palette** | rainbow (LUT) |
| **Date** | 2026-09-01 |

## Method

`bench` renders each shader into an offscreen FBO at explicit frame times, waits for the GPU,
and divides the wall time by the frame count. **GPU %** is `ms/frame × monitors / budget`.

This is pure render throughput — no compositor, presentation, or clock-scaling effects — so
it reads roughly 3–4× lower than the `radeontop` "GPU busy" figures in the v0.4.3 / v0.4.4
docs. The ranking agrees with those docs (aurora, lissajous, starfield, bezier, circuit,
marble at the top). Tier thresholds are unchanged: Lightweight < 33 %, Medium < 50 %,
Heavy < 66 %, Ultra ≥ 66 %. Every built-in is Lightweight on this metric.

Run-to-run noise is about ±10 % (GPU clock state). Compare shaders within one run, and use
`--frames 240` for before/after work on a single shader.

## Results

| Shader | ms/frame | GPU % | Tier |
|--------|---------:|------:|------|
| fibonacci | 2.28 | 14% | Lightweight |
| lissajous | 2.13 | 13% | Lightweight |
| aurora | 2.07 | 12% | Lightweight |
| starfield | 1.99 | 12% | Lightweight |
| bezier | 1.98 | 12% | Lightweight |
| circuit | 1.90 | 11% | Lightweight |
| marble | 1.60 | 10% | Lightweight |
| voronoi | 1.60 | 10% | Lightweight |
| geometry | 1.57 | 9% | Lightweight |
| tesla | 1.22 | 7% | Lightweight |
| attitude | 1.14 | 7% | Lightweight |
| hypercube | 1.08 | 6% | Lightweight |
| snowfall | 1.08 | 6% | Lightweight |
| fractaltrap | 1.01 | 6% | Lightweight |
| mobius | 0.95 | 6% | Lightweight |
| waterfall | 0.94 | 6% | Lightweight |
| kaleidoscope | 0.86 | 5% | Lightweight |
| julia | 0.79 | 5% | Lightweight |
| blob | 0.77 | 5% | Lightweight |
| temple | 0.68 | 4% | Lightweight |
| clouds | 0.66 | 4% | Lightweight |
| donut | 0.66 | 4% | Lightweight |
| sonar | 0.66 | 4% | Lightweight |
| flames | 0.62 | 4% | Lightweight |
| fireflies | 0.61 | 4% | Lightweight |
| wormhole | 0.56 | 3% | Lightweight |
| planet | 0.37 | 2% | Lightweight |
| shipburn | 0.36 | 2% | Lightweight |
| terminal | 0.30 | 2% | Lightweight |
| matrix | 0.27 | 2% | Lightweight |
| oscilloscope | 0.26 | 2% | Lightweight |
| stonks | 0.13 | 1% | Lightweight |
| tunnel | 0.11 | 1% | Lightweight |
| plasma | 0.10 | 1% | Lightweight |
| caustics | 0.10 | 1% | Lightweight |
| gridwave | 0.07 | 0% | Lightweight |

## Changes this release

| Shader | Before | After | Notes |
|---|---|---|---|
| geometry | 1.88 ms | 1.41 ms | palette LUT fetch and AA only inside a line's footprint; only referenced vertices projected; pixel-identical (`--frames 240 --span 30`) |
| fibonacci | — | 2.28 ms | new; per pixel visits the index band \|Δn\| ≤ 2·r/c (≤ 113 seed tests at the screen edge) |
| terminal | 0.29 ms | 0.30 ms | 72-glyph font, no measurable change |

Reproduce: `cargo build --release && ./target/release/hyprsaver bench --markdown`.
