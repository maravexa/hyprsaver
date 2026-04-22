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

// Offline/online band mechanism
const float OFFLINE_FLOOR    = 0.25;   // dimming factor for offline bands (0 = black, 1 = no effect)
const float OFFLINE_RATIO    = 0.4;    // fraction of bands that are offline (higher = more offline)
const float OFFLINE_HASH     = 0.375;  // band-to-liveness hash multiplier; keep irrational-ish

// Palette sampling
const float PALETTE_HASH         = 0.618;  // band-to-palette-position hash (golden ratio)

// Brightness clamps — applied AFTER liveness to guarantee visibility on all palettes
const float MIN_TRACE_BRIGHTNESS = 0.08;   // per-channel floor; ensures dark palettes remain visible
const float MAX_TRACE_BRIGHTNESS = 0.85;   // per-channel ceiling; prevents wash-out on bright palettes

// Distance fog (exponential, retro-era)
const float FOG_DENSITY      = 0.12;   // fog falloff rate per unit of z; higher = closer fog wall
const float FOG_FLOOR        = 0.0;    // min fog factor (0 = fog fades to black, 1 = no fog)

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

    // Raw palette coordinate (drifts with height, time, depth)
    float pc_raw = h * 0.15 + t * PALETTE_DRIFT + z * 0.01;

    // Band index
    float band_idx = floor(pc_raw * POSTERIZE);

    // Palette coordinate — hash to scatter samples across the palette,
    // guaranteeing visually-distinct colors appear simultaneously on screen.
    // Sequential sampling (band_idx / POSTERIZE) sampled adjacent palette
    // regions, which on segmented palettes (marsha, pride flags) could miss
    // entire color regions. Golden-ratio hash spreads samples uniformly.
    float pc_quantized = fract(band_idx * PALETTE_HASH);

    // Palette sample
    vec3 col = palette(pc_quantized);

    // Offline/online liveness — unchanged
    float liveness = OFFLINE_FLOOR + (1.0 - OFFLINE_FLOOR)
                   * step(OFFLINE_RATIO, fract(band_idx * OFFLINE_HASH));
    col *= liveness;

    // Brightness clamp — applied AFTER liveness so offline traces on
    // dark palettes remain visible at the MIN floor. On midnight/other
    // dark palettes, online and offline will converge toward the floor
    // brightness; the palette's color character (hue) is preserved as
    // long as any channel of the palette sample is above zero.
    col = clamp(col, vec3(MIN_TRACE_BRIGHTNESS), vec3(MAX_TRACE_BRIGHTNESS));

    // Exponential distance fog — retro-era depth cue that also hides horizon aliasing
    // by crushing dynamic range where sub-pixel wave frequencies live.
    float fog = FOG_FLOOR + (1.0 - FOG_FLOOR) * exp(-z * FOG_DENSITY);

    // Horizon haze — existing mechanism, unchanged
    float fade = 1.0 - smoothstep(HORIZON - HAZE_START,
                                   HORIZON - HAZE_END,
                                   uv.y);

    // CRT scanlines — existing, unchanged, NOT affected by fog
    float scan = 1.0 - SCANLINE * step(0.5, fract(gl_FragCoord.y / SCANLINE_PERIOD));

    // Compose: lines × color × fog × haze, then scanlines
    fragColor = vec4(col * lines * fog * fade * scan, 1.0);
}
