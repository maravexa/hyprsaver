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

// Pillar cap bars — horizontal bus-bars at top and bottom of each pillar
const float PILLAR_CAP_WIDTH     = 0.1;   // fraction of pillar length (from each end) that is cap
const float PILLAR_CAP_H_VALUE   = 0.0;   // h_render in cap zone; must be at an isoline
                                          // (integer / ISOLINE_COUNT). 0.0 works; 0.333 also works.

// Pillar temporal drift — default 0 makes pillar colors static and eliminates flicker.
// Raise to 0.3-1.0 to re-enable color cycling on pillars (at cost of returning flicker).
const float PILLAR_DRIFT_SCALE   = 0.0;

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

// Side face trace pattern
// Shares density with front face for visual coherence — same vertical lines, two sides.
const float SIDE_FACE_LINE_DENSITY = 0.5;  // matches front face's effective density
const float SIDE_FACE_COLOR_SHIFT  = 0.19; // palette offset for side face vs front face

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

    // Pillar pass — 2 faces per pillar: front face and inner side face.
    // Inner side face is the face on the corridor-axis side of the pillar,
    // showing depth parallax as the viewer walks past.
    float best_pillar_z = z_surface;
    for (int i = 0; i < NUM_PILLARS; i++) {
        vec2  pos    = pillar_wpos(i, t);
        float wx_p   = pos.x;
        float wz_p   = pos.y;

        // Early reject: pillar is entirely behind whatever we've already chosen
        if (wz_p + PILLAR_RADIUS >= best_pillar_z) { continue; }

        // ---- Front face test (existing logic) ----
        {
            float sx       = 0.5 + wx_p / (wz_p * WAVE_STRETCH_X);
            float sw       = PILLAR_RADIUS / (wz_p * WAVE_STRETCH_X);
            float y_extent = 1.0 / wz_p;

            if (abs(uv.x - sx) < sw && abs(dist_h) < y_extent && wz_p < best_pillar_z) {
                best_pillar_z = wz_p;

                float pillar_u = (uv.x - sx) / sw;
                float pillar_v = dist_h * wz_p;
                float cap_zone = step(1.0 - PILLAR_CAP_WIDTH, abs(pillar_v));

                h_render = mix(pillar_u * PILLAR_LINE_DENSITY,
                               PILLAR_CAP_H_VALUE,
                               cap_zone);

                z_render     = wz_p;
                color_offset = (float(i) + 1.0) * PILLAR_COLOR_SHIFT;
                is_pillar    = true;
            }
        }

        // ---- Inner side face test ----
        // The inner face is on the corridor-axis side of the pillar.
        // For wx_p > 0, inner side is at x = wx_p - PILLAR_RADIUS.
        // For wx_p < 0, inner side is at x = wx_p + PILLAR_RADIUS.
        // The side face extends in world-z from (wz_p - PILLAR_RADIUS) to wz_p,
        // and projects as a screen-space quad between the near and far corners.
        {
            float inner_sign = wx_p < 0.0 ? 1.0 : -1.0;  // face faces toward center
            float face_wx    = wx_p + inner_sign * PILLAR_RADIUS;  // world-x of inner edge
            float wz_near    = wz_p - PILLAR_RADIUS;
            float wz_far     = wz_p;

            // Skip side face if near edge would be behind camera
            if (wz_near > PILLAR_NEAR_CLIP * 0.5) {
                // Near and far corner screen-x
                float sx_near  = 0.5 + face_wx / (wz_near * WAVE_STRETCH_X);
                float sx_far   = 0.5 + face_wx / (wz_far  * WAVE_STRETCH_X);

                // The face spans [min(sx_near, sx_far), max(sx_near, sx_far)] on screen
                float sx_lo    = min(sx_near, sx_far);
                float sx_hi    = max(sx_near, sx_far);

                // Interpolate world-z across the face for the current pixel.
                // Linear 1/z interpolation maintains perspective correctness.
                float face_t   = clamp((uv.x - sx_lo) / max(sx_hi - sx_lo, 1e-5), 0.0, 1.0);
                bool  near_is_lo = sx_near < sx_far;
                float inv_z_near = 1.0 / wz_near;
                float inv_z_far  = 1.0 / wz_far;
                float inv_z_here = near_is_lo
                    ? mix(inv_z_near, inv_z_far,  face_t)
                    : mix(inv_z_far,  inv_z_near, face_t);
                float z_here     = 1.0 / inv_z_here;

                // Y extent at this sub-pixel's depth
                float y_extent_here = 1.0 / z_here;

                if (uv.x >= sx_lo && uv.x <= sx_hi &&
                    abs(dist_h) < y_extent_here &&
                    z_here < best_pillar_z) {
                    best_pillar_z = z_here;

                    // Face-local horizontal coordinate [-1, +1]. Derived from pixel
                    // position within the face's current screen-x bounds, so a point
                    // on the face keeps the same face_u regardless of pillar depth —
                    // no scanning as the pillar scrolls toward the viewer.
                    float face_u = ((uv.x - sx_lo) / max(sx_hi - sx_lo, 1e-5)) * 2.0 - 1.0;

                    // Pillar vertical coord for cap zone (identical to front face)
                    float pillar_v = dist_h * z_here;
                    float cap_zone = step(1.0 - PILLAR_CAP_WIDTH, abs(pillar_v));

                    // Vertical lines matching front face style + cap override
                    h_render = mix(face_u * SIDE_FACE_LINE_DENSITY,
                                   PILLAR_CAP_H_VALUE,
                                   cap_zone);

                    z_render     = z_here;
                    color_offset = (float(i) + 1.0) * PILLAR_COLOR_SHIFT
                                 + SIDE_FACE_COLOR_SHIFT;
                    is_pillar    = true;
                }
            }
        }
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
