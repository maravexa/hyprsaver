#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — oscilloscope.frag
//
// Realistic Tektronix/HP-style CRT oscilloscope display with three animated
// waveform traces drawn over a phosphor-tinted measurement grid.
//
// Features:
//   - Major grid: 8 vertical × 6 horizontal evenly-spaced divisions.
//   - Minor grid: each major cell subdivided 5× (40 × 30 minor lines).
//   - Center crosshair: slightly brighter centre H/V lines.
//   - Screen frame: bright rectangle at the outer edge.
//   - Three waveform channels:
//       Ch1 palette(0.4) — composite sine  (two-tone)
//       Ch2 palette(0.7) — Lissajous-modulated sine
//       Ch3 palette(0.9) — sine + cheap hash noise
//   - Gaussian phosphor glow on each trace (exp(-d²·800)).
//   - CRT overlay: 1-pixel scanlines, radial vignette, green phosphor tint.
//
// GPU cost:
//   9 sin/cos calls (3 per channel) + 1 hash for the noise term + a handful
//   of fract/smoothstep for the grid. Well below 10% GPU — one of the
//   cheapest shaders in the set.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Cheap hash-based noise (1D, value-noise, no fbm)
// ---------------------------------------------------------------------------

float hash11(float x) {
    return fract(sin(x * 127.1) * 43758.5453);
}

float vnoise(float x) {
    float i = floor(x);
    float f = fract(x);
    float a = hash11(i);
    float b = hash11(i + 1.0);
    float u = f * f * (3.0 - 2.0 * f);          // smoothstep interpolant
    return mix(a, b, u) * 2.0 - 1.0;            // → [-1, 1]
}

// ---------------------------------------------------------------------------
// Waveform channels.  x is in radians (screen spans [-π, π]).
// ---------------------------------------------------------------------------

float wave1(float x, float t) {
    // Composite sine: two-tone interference.
    return 0.25 * sin(6.0  * x + t * 1.2)
         + 0.08 * sin(14.0 * x + t * 3.1);
}

float wave2(float x, float t) {
    // Lissajous-influenced amplitude modulation.
    return 0.20 * sin(8.0 * x + t) * cos(x * 0.5 + t * 0.3);
}

float wave3(float x, float t) {
    // Irregular, noisy signal.
    return 0.15 * sin(4.0 * x + t * 2.0)
         + 0.06 * vnoise(x * 5.0 + t);
}

// ---------------------------------------------------------------------------

void main() {
    vec2  fc  = gl_FragCoord.xy;
    vec2  res = u_resolution.xy;
    float t   = u_time * u_speed_scale;

    // Normalised coords centred on the screen.
    // uv_c.x ∈ [-aspect, aspect], uv_c.y ∈ [-1, 1].
    vec2 uv_c = (fc - 0.5 * res) / res.y * 2.0;

    // Signal-space X in radians — screen spans 2π so freq=6 ⇒ 6 cycles.
    float xn      = fc.x / res.x * 2.0 - 1.0;                // [-1, 1]
    float yn      = fc.y / res.y * 2.0 - 1.0;                // [-1, 1]
    float x_phase = xn * 3.14159265;                         // [-π, π]

    // -----------------------------------------------------------------------
    // GRID — major (8×6) and minor (40×30).  Anti-aliased thin lines in
    // pixel space via fract() and smoothstep().
    // -----------------------------------------------------------------------

    vec2 cellMaj = res / vec2(8.0, 6.0);
    vec2 cellMin = cellMaj / 5.0;

    vec2 fMaj = mod(fc, cellMaj);
    vec2 dMaj = min(fMaj, cellMaj - fMaj);   // pixels from nearest major line
    vec2 fMin = mod(fc, cellMin);
    vec2 dMin = min(fMin, cellMin - fMin);   // pixels from nearest minor line

    // 1-pixel major lines, 0.5-pixel minor lines.
    float majX   = 1.0 - smoothstep(0.0, 1.0, dMaj.x);
    float majY   = 1.0 - smoothstep(0.0, 1.0, dMaj.y);
    float minorX = 1.0 - smoothstep(0.0, 0.5, dMin.x);
    float minorY = 1.0 - smoothstep(0.0, 0.5, dMin.y);
    float major  = max(majX, majY);
    float minor  = max(minorX, minorY);

    vec3 col = vec3(0.0);
    col += palette(0.2) * minor * 0.05;
    col += palette(0.3) * major * 0.15;

    // Center crosshair — 1px H + V lines through screen midpoint.
    float cx = 1.0 - smoothstep(0.0, 1.0, abs(fc.x - 0.5 * res.x));
    float cy = 1.0 - smoothstep(0.0, 1.0, abs(fc.y - 0.5 * res.y));
    col += palette(0.3) * max(cx, cy) * 0.25;

    // Subtle screen-edge border (~2px frame).
    float bx = smoothstep(0.0, 2.0, min(fc.x, res.x - fc.x));
    float by = smoothstep(0.0, 2.0, min(fc.y, res.y - fc.y));
    col += palette(0.3) * (1.0 - min(bx, by)) * 0.35;

    // -----------------------------------------------------------------------
    // WAVEFORM TRACES — Gaussian glow on |yn - y_wave|.
    //   intensity = exp(-d² · 800) → tight bright core, soft falloff.
    // -----------------------------------------------------------------------

    float y1 = wave1(x_phase, t);
    float y2 = wave2(x_phase, t);
    float y3 = wave3(x_phase, t);

    float d1 = yn - y1;
    float d2 = yn - y2;
    float d3 = yn - y3;

    const float GLOW = 800.0;
    float g1 = exp(-d1 * d1 * GLOW);
    float g2 = exp(-d2 * d2 * GLOW);
    float g3 = exp(-d3 * d3 * GLOW);

    col += palette(0.4) * g1;
    col += palette(0.7) * g2;
    col += palette(0.9) * g3;

    // -----------------------------------------------------------------------
    // CRT EFFECTS — scanlines, vignette, phosphor tint.
    // -----------------------------------------------------------------------

    // Alternate-row scanlines: 8% darkening on every other pixel row.
    float scanline = 1.0 - 0.08 * step(0.5, fract(fc.y * 0.5));
    col *= scanline;

    // Radial vignette — darkens corners up to 30%.
    float vignette = 1.0 - 0.3 * dot(uv_c, uv_c);
    col *= vignette;

    // Persistent green phosphor cast on the whole image.
    col *= vec3(0.9, 1.0, 0.9);

    fragColor = vec4(col, 1.0);
}
