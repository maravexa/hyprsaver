#version 320 es
precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// waves.frag — retro-styled 2D wave field with a horizon perspective.
//
// Flat-plane perspective inverse: z = 1.0 / (horizon - pixel_y). No raymarching,
// no normals, no lighting. Triangle waves instead of sin, hard `step` isolines
// (intentionally aliased), posterized palette quantization, CRT scanlines.
// Everything above the horizon line is pure black "sky."

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const float HORIZON          = 0.68;   // y-coordinate of horizon line in [0,1]
const float Z_MAX            = 20.0;   // cap on perspective depth to prevent moire
const float WAVE_STRETCH_X   = 1.8;    // perspective x-stretch factor
const float SCROLL_SPEED     = 0.4;    // wave scroll toward viewer (world-z per sec)
const float ISOLINE_COUNT    = 3.0;    // isolines per unit of height
const float ISOLINE_WIDTH    = 0.06;   // in fract-space; larger = thicker lines
const float POSTERIZE        = 6.0;    // palette color bands; 0.0 disables
const float PALETTE_DRIFT    = 0.02;   // palette cycle speed
const float HAZE_START       = 0.08;   // distance below horizon where fade begins
const float HAZE_END         = 0.02;   // distance below horizon where fully faded
const float SCANLINE         = 0.25;   // 0.0 = off, 1.0 = fully black dim rows
const float SCANLINE_PERIOD  = 4.0;    // pixels per scanline cycle (2 bright, 2 dim)
const float PIXEL_SIZE       = 1.0;    // 1.0 = no snap, 2-3 = visible pixelation

// ---------------------------------------------------------------------------
// Triangle wave in [-1, 1] with period 2.0 — cheaper than sin on RDNA,
// and the harmonic content reads as "textured" rather than "smooth swell."
// ---------------------------------------------------------------------------
float tri(float x) {
    return abs(fract(x * 0.5) - 0.5) * 4.0 - 1.0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
void main() {
    float t = u_time * u_speed_scale;

    // Optional fragment snap for PS1-style low-res look
    vec2 px = floor(gl_FragCoord.xy / PIXEL_SIZE) * PIXEL_SIZE;
    vec2 uv = px / u_resolution.xy;

    // Perspective depth via horizon inverse. Clamp both ends:
    //   depth_y > 1e-3 prevents divide-by-zero at horizon line
    //   z < Z_MAX prevents unbounded wave frequencies that would moire
    float depth_y = max(HORIZON - uv.y, 1e-3);
    float z = min(1.0 / depth_y, Z_MAX);

    // Perspective-mapped world coordinates
    // wx is centered on screen and stretches with depth
    // wz scrolls toward viewer over time
    float wx = (uv.x - 0.5) * z * WAVE_STRETCH_X;
    float wz = z + t * SCROLL_SPEED;

    // Wave field — 3 triangle waves with crossed frequencies
    float h = tri(wx * 0.8 + wz * 0.3)
            + 0.6 * tri(wz * 0.5 + wx * 0.2)
            + 0.4 * tri((wx - wz) * 1.1);

    // Hard-edged isolines — intentional aliasing.
    // band = fract(h*N) is 0 at each crossing.
    // edge = abs(band - 0.5) is 0 at the midpoint, 0.5 at crossings.
    // step(0.5 - W, edge) = 1 near crossings, 0 between them.
    float edge = abs(fract(h * ISOLINE_COUNT) - 0.5);
    float lines = step(0.5 - ISOLINE_WIDTH, edge);

    // Posterized palette coordinate drifting with height, time, and depth
    float pc = h * 0.15 + t * PALETTE_DRIFT + z * 0.01;
    pc = floor(pc * POSTERIZE) / POSTERIZE;
    vec3 col = palette(fract(pc));

    // Horizon haze — fades waves to black approaching horizon line.
    // Also kills the above-horizon region (pixels with uv.y >= HORIZON)
    // because smoothstep(a, b, uv.y) with a < b returns 1 for uv.y >= b,
    // and we subtract from 1.
    float fade = 1.0 - smoothstep(HORIZON - HAZE_START,
                                   HORIZON - HAZE_END,
                                   uv.y);

    // CRT scanlines in screen-space (unaffected by PIXEL_SIZE snap)
    float scan = 1.0 - SCANLINE * step(0.5, fract(gl_FragCoord.y / SCANLINE_PERIOD));

    fragColor = vec4(col * lines * fade * scan, 1.0);
}
