#version 320 es
precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// temple.frag — retro temple interior with floor, ceiling, and scrolling pillars.
//
// Floor and ceiling use flat-plane perspective inverse (z = 1/|y - HORIZON|).
// Pillars are screen-space rectangles with pillar-local UV for ring trace pattern.
// Triangle waves throughout — no sin, no raymarching, no normals.

// ---------------------------------------------------------------------------
// Scene layout
// ---------------------------------------------------------------------------
const float HORIZON              = 0.5;    // centered for symmetric floor/ceiling
const float Z_MAX                = 20.0;   // cap on perspective depth
const float WAVE_STRETCH_X       = 1.8;    // perspective x-stretch
const float SCROLL_SPEED         = 0.4;    // scene scroll toward viewer

// Ceiling-specific
const float CEILING_PHASE_OFFSET = 3.7;    // wz shift so ceiling != mirror of floor

// ---------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------
const int   NUM_PILLARS          = 4;
const float PILLAR_RADIUS        = 0.3;    // world radius of pillar
const float PILLAR_NEAR_CLIP     = 1.0;    // minimum visible depth
const float PILLAR_CYCLE_DEPTH   = 24.0;   // scrolling cycle length
const float PILLAR_RING_DENSITY  = 1.0;    // h units per unit of pillar_v; ~6-7 rings visible
const float PILLAR_SCROLL_SPEED  = 0.3;    // ring animation speed
const float PILLAR_COLOR_SHIFT   = 0.37;   // palette offset per pillar index
const float PILLAR_UV_VARIATION  = 0.2;    // horizontal wobble amplitude

// ---------------------------------------------------------------------------
// Isolines (unchanged)
// ---------------------------------------------------------------------------
const float ISOLINE_COUNT        = 3.0;
const float ISOLINE_WIDTH        = 0.06;

// ---------------------------------------------------------------------------
// Posterize and palette (unchanged)
// ---------------------------------------------------------------------------
const float POSTERIZE            = 6.0;
const float PALETTE_DRIFT        = 0.02;
const float PALETTE_HASH         = 0.618;

// ---------------------------------------------------------------------------
// Offline/online (unchanged from color-tweaks-r2)
// ---------------------------------------------------------------------------
const float OFFLINE_FLOOR        = 0.25;
const float OFFLINE_RATIO        = 0.4;
const float OFFLINE_HASH         = 0.4142;

// ---------------------------------------------------------------------------
// Brightness clamps (unchanged from color-tweaks-r2)
// ---------------------------------------------------------------------------
const float MIN_TRACE_BRIGHTNESS = 0.08;
const float MAX_TRACE_BRIGHTNESS = 0.70;

// ---------------------------------------------------------------------------
// Depth fog and horizon haze (updated to use abs distance)
// ---------------------------------------------------------------------------
const float FOG_DENSITY          = 0.12;
const float FOG_FLOOR            = 0.0;
const float HAZE_START           = 0.08;   // abs distance from horizon where fade begins
const float HAZE_END             = 0.02;   // abs distance from horizon where fully faded

// ---------------------------------------------------------------------------
// Retro: scanlines and fragment snap (unchanged)
// ---------------------------------------------------------------------------
const float SCANLINE             = 0.25;
const float SCANLINE_PERIOD      = 4.0;
const float PIXEL_SIZE           = 1.0;

// ---------------------------------------------------------------------------
// Triangle wave — cheaper than sin on RDNA
// ---------------------------------------------------------------------------
float tri(float x) {
    return abs(fract(x * 0.5) - 0.5) * 4.0 - 1.0;
}

// ---------------------------------------------------------------------------
// Pillar world position — evenly-spaced depths, hashed x, scrolling with time
// ---------------------------------------------------------------------------
vec2 pillar_wpos(float fi, float t) {
    // X position: pseudo-random in [-3, +3]. Fract-based, no sin.
    float wx_p = (fract(fi * 0.7213 + 0.137) - 0.5) * 6.0;

    // Z: evenly-spaced base depths, scroll toward viewer, wrap at cycle boundary
    float wz_base = fi / float(NUM_PILLARS) * PILLAR_CYCLE_DEPTH;
    float wz_p    = mod(wz_base - t * SCROLL_SPEED, PILLAR_CYCLE_DEPTH) + PILLAR_NEAR_CLIP;

    return vec2(wx_p, wz_p);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
void main() {
    float t = u_time * u_speed_scale;

    // Fragment snap for PS1-style pixelation
    vec2 px = floor(gl_FragCoord.xy / PIXEL_SIZE) * PIXEL_SIZE;
    vec2 uv = px / u_resolution.xy;

    // Signed horizon distance (positive = ceiling side, negative = floor side)
    float dist_h     = uv.y - HORIZON;
    float abs_dist_h = max(abs(dist_h), 1e-3);
    bool  is_ceiling = dist_h > 0.0;
    float z_surface  = min(1.0 / abs_dist_h, Z_MAX);

    // Surface wave field — shared math between floor and ceiling.
    // Ceiling gets a wz phase offset so its pattern is not a mirror of the floor.
    float wx = (uv.x - 0.5) * z_surface * WAVE_STRETCH_X;
    float wz = z_surface + t * SCROLL_SPEED + (is_ceiling ? CEILING_PHASE_OFFSET : 0.0);
    float h_surface = tri(wx * 0.8 + wz * 0.3)
                    + 0.6 * tri(wz * 0.5 + wx * 0.2)
                    + 0.4 * tri((wx - wz) * 1.1);

    // Default render target: the surface (floor or ceiling)
    float h_render     = h_surface;
    float z_render     = z_surface;
    float color_offset = 0.0;

    // Pillar pass — check each pillar; closest one in front of the surface wins.
    float best_pillar_z = z_surface;  // must beat the surface depth to render
    for (int i = 0; i < NUM_PILLARS; i++) {
        vec2  pos  = pillar_wpos(float(i), t);
        float wz_p = pos.y;

        // Early reject: pillar further than current best candidate
        if (wz_p >= best_pillar_z) { continue; }

        // Screen rect for this pillar at its depth
        float sx       = 0.5 + pos.x / (wz_p * WAVE_STRETCH_X);
        float sw       = PILLAR_RADIUS / (wz_p * WAVE_STRETCH_X);
        float y_extent = 1.0 / wz_p;

        // Containment test: rect in screen space. The +-y_extent matches the depth
        // where z_surface == wz_p, so vertical edges are automatically flush with
        // the floor/ceiling intersection line.
        if (abs(uv.x - sx) < sw && abs(dist_h) < y_extent) {
            best_pillar_z = wz_p;

            // Pillar-local UV
            float pillar_u = (uv.x - sx) / sw;    // [-1, +1] across pillar
            float pillar_v = dist_h * wz_p;       // [-1, +1] floor-edge to ceiling-edge

            // Pillar trace pattern: linear in v for regular horizontal rings,
            // scrolling upward over time, plus subtle u-wobble.
            h_render = pillar_v * PILLAR_RING_DENSITY
                     + t * PILLAR_SCROLL_SPEED
                     + PILLAR_UV_VARIATION * tri(pillar_u * 2.0);
            z_render = wz_p;
            color_offset = (float(i) + 1.0) * PILLAR_COLOR_SHIFT;
        }
    }

    // Isoline detection (common to all surfaces)
    float edge  = abs(fract(h_render * ISOLINE_COUNT) - 0.5);
    float lines = step(0.5 - ISOLINE_WIDTH, edge);

    // Palette sampling via band index hash
    float pc_raw       = h_render * 0.15 + t * PALETTE_DRIFT + z_render * 0.01 + color_offset;
    float band_idx     = floor(pc_raw * POSTERIZE);
    float pc_quantized = fract(band_idx * PALETTE_HASH);
    vec3  col          = palette(pc_quantized);

    // Offline/online liveness
    float liveness = OFFLINE_FLOOR + (1.0 - OFFLINE_FLOOR)
                   * step(OFFLINE_RATIO, fract(band_idx * OFFLINE_HASH));
    col *= liveness;

    // Brightness floor (per-channel — preserves hue above floor)
    col = max(col, vec3(MIN_TRACE_BRIGHTNESS));

    // Brightness ceiling (luminance-preserving scale — preserves saturation)
    float max_channel = max(max(col.r, col.g), col.b);
    col *= min(1.0, MAX_TRACE_BRIGHTNESS / max(max_channel, 1e-4));

    // Exponential distance fog based on whatever we're rendering (surface or pillar)
    float fog = FOG_FLOOR + (1.0 - FOG_FLOOR) * exp(-z_render * FOG_DENSITY);

    // Horizon haze — symmetric, fades both floor and ceiling toward the horizon line
    float fade = smoothstep(HAZE_END, HAZE_START, abs_dist_h);

    // CRT scanlines in screen space
    float scan = 1.0 - SCANLINE * step(0.5, fract(gl_FragCoord.y / SCANLINE_PERIOD));

    // Compose
    fragColor = vec4(col * lines * fog * fade * scan, 1.0);
}
