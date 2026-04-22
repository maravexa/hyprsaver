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
const float SCROLL_SPEED         = 0.8;    // scene scroll toward viewer

// Ceiling-specific
const float CEILING_PHASE_OFFSET = 3.7;    // wz shift so ceiling != mirror of floor

// ---------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------
const float PILLAR_RADIUS        = 0.3;    // world radius of pillar
const float PILLAR_NEAR_CLIP     = 1.0;    // minimum visible depth
const float PILLAR_CYCLE_DEPTH   = 24.0;   // scrolling cycle length
const float PILLAR_COLOR_SHIFT    = 0.37;   // palette offset per pillar index

// Pillar corridor layout — 5 rows × 4 columns grid
const float PILLAR_X_INNER        = 1.5;   // inner columns (±): wider central walkway
const float PILLAR_X_OUTER        = 4.0;   // outer columns (±): pushed to edges

// Pillar grid layout
const int   NUM_PILLARS_PER_ROW  = 4;
const int   NUM_ROWS             = 5;
const int   NUM_PILLARS          = NUM_PILLARS_PER_ROW * NUM_ROWS;   // 20

// Pillar trace pattern — vertical circuit lines, static on pillar surface
const float PILLAR_LINE_DENSITY   = 0.5;   // linear h coefficient; 3 vertical lines per pillar (was 1.0 = ~7)
const float PILLAR_ISOLINE_WIDTH  = 0.12;  // pillar isoline thickness; doubled vs. surface (0.06) to suppress sweep-aliasing flicker

// Pillar temporal drift — default 0 makes pillar colors static and eliminates flicker.
// Raise to 0.3-1.0 to re-enable color cycling on pillars (at cost of returning flicker).
const float PILLAR_DRIFT_SCALE   = 0.0;

// Column structure (classical architecture: base + shaft + capital)
const float BASE_HEIGHT            = 0.15;  // base zone: pillar_v < -(1.0 - BASE_HEIGHT*2) = -0.70
const float CAPITAL_HEIGHT         = 0.15;  // capital zone: pillar_v > +(1.0 - CAPITAL_HEIGHT*2) = +0.70
const float BASE_WIDTH_SCALE       = 1.35;  // base is 1.35× shaft width
const float CAPITAL_WIDTH_SCALE    = 1.35;  // capital mirrors base width
const float CAPITAL_BRACKET_SCALE  = 1.55;  // top fraction of capital flares wider ("bracket")
const float CAPITAL_BRACKET_THRESH = 0.90;  // pillar_v threshold for bracket flare

// Trace patterns per zone
const float BASE_BAR_DENSITY       = 6.0;   // horizontal bar frequency in base zone
const float CAPITAL_BAR_DENSITY    = 6.0;   // horizontal bar frequency in capital zone
const float BASE_NOTCH_AMPLITUDE   = 0.15;  // u-direction notch modulation in base pattern

// Zone color offsets
const float BASE_COLOR_SHIFT       = 0.19;  // palette shift for base zone
const float CAPITAL_COLOR_SHIFT    = 0.31;  // palette shift for capital zone (different tonal variety)

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
// Offline/online (liveness inverted in round 4: online brightens, offline raw)
// ---------------------------------------------------------------------------
const float ONLINE_BRIGHTEN      = 0.6;    // 0 = no change, 1 = online fully white
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
// Pillar world position — 5 rows × 4 columns grid, scrolling in z.
//
// Row layout (4 pillars per row, evenly spread across corridor):
//   col 0: outer left   (-PILLAR_X_OUTER)
//   col 1: inner left   (-PILLAR_X_INNER)
//   col 2: inner right  (+PILLAR_X_INNER)
//   col 3: outer right  (+PILLAR_X_OUTER)
//
// Rows are phase-offset in z by CYCLE_DEPTH / NUM_ROWS, so at any moment
// you see three depth layers of the corridor simultaneously.
// ---------------------------------------------------------------------------
vec2 pillar_wpos(int i, float t) {
    int row = i / NUM_PILLARS_PER_ROW;
    int col = i - row * NUM_PILLARS_PER_ROW;  // `i % NUM_PILLARS_PER_ROW` without mod for portability

    // X position by column
    float wx_p;
    if      (col == 0) { wx_p = -PILLAR_X_OUTER; }
    else if (col == 1) { wx_p = -PILLAR_X_INNER; }
    else if (col == 2) { wx_p = +PILLAR_X_INNER; }
    else               { wx_p = +PILLAR_X_OUTER; }

    // Z phase by row
    float phase = float(row) * PILLAR_CYCLE_DEPTH / float(NUM_ROWS);
    float wz_p  = mod(phase - t * SCROLL_SPEED, PILLAR_CYCLE_DEPTH) + PILLAR_NEAR_CLIP;

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
    bool  is_pillar    = false;

    // Pillar pass — structured columns with base / shaft / capital.
    // Single face per pillar; widening in base and capital zones sells 3D
    // through silhouette variation rather than projected second face.
    float best_pillar_z = z_surface;
    for (int i = 0; i < NUM_PILLARS; i++) {
        vec2  pos    = pillar_wpos(i, t);
        float wx_p   = pos.x;
        float wz_p   = pos.y;

        // Early reject: any pillar farther than current best is useless
        if (wz_p >= best_pillar_z) { continue; }

        // Shaft screen projection (same math as before)
        float sx         = 0.5 + wx_p / (wz_p * WAVE_STRETCH_X);
        float sw_shaft   = PILLAR_RADIUS / (wz_p * WAVE_STRETCH_X);
        float y_extent   = 1.0 / wz_p;

        // Widened half-widths for base and capital zones
        float sw_base    = sw_shaft * BASE_WIDTH_SCALE;
        float sw_capital = sw_shaft * CAPITAL_WIDTH_SCALE;
        float sw_bracket = sw_shaft * CAPITAL_BRACKET_SCALE;

        // Widest possible rect (used for quick rect rejection)
        float sw_widest  = max(sw_base, sw_bracket);

        // Quick rejection: not even inside the widest possible rect
        if (abs(uv.x - sx) >= sw_widest || abs(dist_h) >= y_extent) { continue; }
        if (wz_p >= best_pillar_z) { continue; }  // re-check after prior hits

        // pillar_v identifies vertical zone: [-1, +1], floor edge to ceiling edge
        float pillar_v = dist_h * wz_p;

        // Determine zone based on pillar_v
        bool in_base    = pillar_v < -(1.0 - BASE_HEIGHT * 2.0);
        bool in_capital = pillar_v >  (1.0 - CAPITAL_HEIGHT * 2.0);
        bool in_shaft   = !in_base && !in_capital;

        // Effective horizontal half-width for this zone
        float sw_effective;
        if (in_base) {
            sw_effective = sw_base;
        } else if (in_capital) {
            sw_effective = (pillar_v > CAPITAL_BRACKET_THRESH) ? sw_bracket : sw_capital;
        } else {
            sw_effective = sw_shaft;
        }

        // Horizontal test against zone-specific width
        if (abs(uv.x - sx) >= sw_effective) { continue; }

        // This pixel IS part of this pillar. Lock it in.
        best_pillar_z = wz_p;

        // Face-local u coordinate, normalized against shaft width consistently so
        // shaft vertical lines register at the same face-local positions regardless of depth.
        float pillar_u = (uv.x - sx) / sw_shaft;

        float h_zone;
        float zone_color_offset = 0.0;

        if (in_shaft) {
            // Shaft: vertical line pattern
            h_zone = pillar_u * PILLAR_LINE_DENSITY;
        } else if (in_base) {
            // Base: horizontal bars with u-modulated notch detail
            h_zone = pillar_v * BASE_BAR_DENSITY
                   + tri(pillar_u * 4.0) * BASE_NOTCH_AMPLITUDE;
            zone_color_offset = BASE_COLOR_SHIFT;
        } else {
            // Capital: horizontal bars
            h_zone = pillar_v * CAPITAL_BAR_DENSITY;
            zone_color_offset = CAPITAL_COLOR_SHIFT;
        }

        h_render     = h_zone;
        z_render     = wz_p;
        color_offset = (float(i) + 1.0) * PILLAR_COLOR_SHIFT + zone_color_offset;
        is_pillar    = true;
    }

    // Isoline detection. Pillars use a thicker isoline width than floor/ceiling
    // to reduce spatial aliasing as pillars scroll past the viewer.
    float iso_width = is_pillar ? PILLAR_ISOLINE_WIDTH : ISOLINE_WIDTH;
    float edge      = abs(fract(h_render * ISOLINE_COUNT) - 0.5);
    float lines     = step(0.5 - iso_width, edge);

    // Palette sampling via band index hash
    // Palette drift is removed for pillars (PILLAR_DRIFT_SCALE = 0 by default).
    // This eliminates the "whole-vertical-line flashes palette band" flicker that
    // occurs because every pixel of a pillar's vertical line shares identical pc_raw
    // and thus crosses band boundaries simultaneously. Floor and ceiling are unaffected
    // because they have per-pixel h/z variation and cross boundaries spatially.
    float drift_mul          = is_pillar ? PILLAR_DRIFT_SCALE : 1.0;
    float drift_contribution = t * PALETTE_DRIFT * drift_mul;

    float pc_raw       = h_render * 0.15 + drift_contribution + z_render * 0.01 + color_offset;
    float band_idx     = floor(pc_raw * POSTERIZE);
    float pc_quantized = fract(band_idx * PALETTE_HASH);
    vec3  col          = palette(pc_quantized);

    // Online/offline liveness (INVERTED SEMANTICS vs earlier rounds).
    // Offline bands render as raw palette color (no dimming).
    // Online bands blend toward white, reading as "signal active on this trace."
    // liveness_bit is 0.0 for offline, 1.0 for online.
    float liveness_bit = step(OFFLINE_RATIO, fract(band_idx * OFFLINE_HASH));
    col = mix(col, vec3(1.0), ONLINE_BRIGHTEN * liveness_bit);

    // Brightness floor (per-channel — preserves hue above floor)
    col = max(col, vec3(MIN_TRACE_BRIGHTNESS));

    // Brightness ceiling (luminance-preserving scale — preserves saturation)
    float max_channel = max(max(col.r, col.g), col.b);
    col *= min(1.0, MAX_TRACE_BRIGHTNESS / max(max_channel, 1e-4));

    // Exponential distance fog based on whatever we're rendering (surface or pillar)
    float fog = FOG_FLOOR + (1.0 - FOG_FLOOR) * exp(-z_render * FOG_DENSITY);

    // Horizon haze applies to floor/ceiling only. Pillars are vertical objects
    // that pass through the horizon at their midpoint — haze-fading them would
    // produce a dark band across each pillar's vertical center. Skip haze when
    // we're rendering a pillar.
    float fade = is_pillar ? 1.0 : smoothstep(HAZE_END, HAZE_START, abs_dist_h);

    // CRT scanlines in screen space
    float scan = 1.0 - SCANLINE * step(0.5, fract(gl_FragCoord.y / SCANLINE_PERIOD));

    // Compose
    fragColor = vec4(col * lines * fog * fade * scan, 1.0);
}
