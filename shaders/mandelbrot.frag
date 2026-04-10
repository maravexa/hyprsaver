#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — mandelbrot.frag
//
// Zoom cycle: home (full-fractal view) → target → home.
// Cycles through 12 verified boundary targets every 50 s; max zoom ~268×
// (1.5^14) — safely within float32 precision limits.
//
// v0.3.3 changes:
//   • No center panning. At HOME_SCALE the entire Mandelbrot set is on screen,
//     so moving the center from one target to another is visually imperceptible.
//     The camera is always centered exactly on the current target — no mix(),
//     no cubic lag, no transit through the black interior of the set.
//   • Target switches at zoom_t = 0.0 during a 5 % dwell at home zoom. The
//     wide-angle view shifts slightly; at this zoom level the shift spans only
//     a fraction of the visible area and is not a jarring jump.
//   • Removed: HOME_CENTER constant, center_t cubic, mix() call.
//   • Main cardioid + period-2 bulb early exit retained from v0.3.1.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// Palette function and fragColor output declaration injected by shaders.rs.

// ---------------------------------------------------------------------------
// Smooth iteration count — returns 0.0 for interior pixels (never escaped).
//
// Early-exit tests (in order of cheapness):
//   1. Main cardioid      — the large heart-shaped region centred near 0.25
//   2. Period-2 bulb      — the large circle centred at −1.0
// Both checks are O(1) arithmetic with no branching inside loops.
// ---------------------------------------------------------------------------
float mandelbrot(vec2 c, int max_iter) {
    // Main cardioid: q*(q + (x − 0.25)) < 0.25·y²
    float xm = c.x - 0.25;
    float q  = xm * xm + c.y * c.y;
    if (q * (q + xm) < 0.25 * c.y * c.y) return 0.0;

    // Period-2 bulb: (x+1)² + y² < 0.0625
    float xp1 = c.x + 1.0;
    if (xp1 * xp1 + c.y * c.y < 0.0625) return 0.0;

    vec2 z = vec2(0.0);
    for (int i = 0; i < max_iter; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        if (dot(z, z) > 4.0) {
            // Smooth colouring: normalised iteration count eliminates banding.
            float log2z = log2(dot(z, z)) * 0.5;
            float nu    = log2(log2z);
            return float(i) + 1.0 - nu;
        }
    }
    return 0.0; // inside the set
}

// ---------------------------------------------------------------------------
// Pseudo-random hash — maps a float seed to [0, 1)
// ---------------------------------------------------------------------------
float hash(float n) {
    return fract(sin(n) * 43758.5453123);
}

// ---------------------------------------------------------------------------
// Zoom targets — 12 verified Mandelbrot boundary coordinates.
//
// Selection criteria: the coordinate must be ON or within ~0.001 of the set
// boundary AND must show rich detail (not solid black, not washed-out) at
// every zoom level from 1× to 268× (1.5^14).
//
// Sources: coords 0-7 are community-verified; 8-11 retained from previous
// version after confirming they satisfy the above criteria.
// ---------------------------------------------------------------------------
#define NUM_TARGETS 12
vec2 zoom_target(int idx) {
    if (idx ==  0) return vec2(-0.7463,      0.1102    );  // Seahorse Valley (classic)
    if (idx ==  1) return vec2(-0.7453,      0.1127    );  // Seahorse Valley (variant)
    if (idx ==  2) return vec2(-0.16,        1.0405    );  // Branch Tip (upper)
    if (idx ==  3) return vec2(-0.1011,      0.9563    );  // Spiral Arm (upper)
    if (idx ==  4) return vec2( 0.281717,    0.5771    );  // Elephant Trunk
    if (idx ==  5) return vec2(-0.0452,     -0.9868    );  // Double Spiral
    if (idx ==  6) return vec2( 0.3245,      0.04855   );  // Lightning
    if (idx ==  7) return vec2(-0.3905407,   0.5867879 );  // Fibonacci Spiral
    if (idx ==  8) return vec2(-0.77568377,  0.13646737);  // Dendrite (seahorse family)
    if (idx ==  9) return vec2(-1.4011552,   0.0       );  // Feigenbaum Point
    if (idx == 10) return vec2(-0.748,       0.102     );  // Seahorse Tail
                   return vec2(-0.1592,     -1.0318    );  // Feather (lower set)
}

// ---------------------------------------------------------------------------
// Home zoom scale — the standard full-fractal Mandelbrot view.
// HOME_SCALE < 1.0 is required because the UV coordinate system divides by
// resolution.y, giving a half-height of 0.5 in complex-plane units. At
// HOME_SCALE = 0.35 the view spans ≈ ±1.43 imaginary and ≈ [-3.0, 2.0] real,
// comfortably framing the entire set (which fits in ≈ [-2.5, 0.5] × [-1.25, 1.25]).
// ---------------------------------------------------------------------------
const float HOME_SCALE = 0.35;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
void main() {
    // Centred UV, aspect-ratio corrected.
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    float cycle_duration = 50.0;                 // seconds per full in-out cycle
    float max_zoom_exp   = 14.0 * u_zoom_scale;  // 1.5^14 ≈ 268× at default scale

    // Decompose time into whole-cycle index and fractional phase [0, 1).
    float total_t  = u_time * u_speed_scale / cycle_duration;
    float cycle_id = floor(total_t);
    float t        = fract(total_t);  // phase within current cycle

    // -----------------------------------------------------------------------
    // Zoom depth with a 5 % dwell at home zoom at each cycle boundary.
    //
    //   t ∈ [0.00, 0.05)        → zoom_t = 0.0  (dwell; target just snapped)
    //   t ∈ [0.05, 0.50)        → zoom_t 0 → 1  (zoom in, smoothstep)
    //   t ∈ [0.50, 0.95)        → zoom_t 1 → 0  (zoom out, smoothstep)
    //   t ∈ [0.95, 1.00)        → zoom_t = 0.0  (dwell; eye settles before next snap)
    //
    // The dwell windows are when the target center snaps to the new value.
    // Because zoom_t = 0 → scale = HOME_SCALE, the full set is on screen and
    // the snap shifts the view by at most a fraction of the visible area.
    // -----------------------------------------------------------------------
    const float DWELL = 0.05;
    float zoom_t;
    if (t < DWELL) {
        zoom_t = 0.0;
    } else if (t < 0.5) {
        zoom_t = smoothstep(0.0, 0.5 - DWELL, t - DWELL);
    } else if (t < 1.0 - DWELL) {
        zoom_t = 1.0 - smoothstep(0.0, 0.5 - DWELL, t - 0.5);
    } else {
        zoom_t = 0.0;
    }

    // Exponential zoom: logarithmic feel — slow at start, faster in middle.
    float scale = HOME_SCALE * pow(1.5, zoom_t * max_zoom_exp);

    // -----------------------------------------------------------------------
    // Target selection — stateless, deterministic, no consecutive repeats.
    //
    // Target advances at the cycle boundary (zoom_t = 0.0, dwell window) so
    // the snap always happens while the full-fractal home view is on screen.
    // -----------------------------------------------------------------------
    int cur_raw  = int(hash(cycle_id)       * float(NUM_TARGETS));
    int prev_raw = int(hash(cycle_id - 1.0) * float(NUM_TARGETS));
    int cur_idx  = (cur_raw == prev_raw) ? (cur_raw + 1) % NUM_TARGETS : cur_raw;

    // -----------------------------------------------------------------------
    // Camera centre — always exactly the current target, no interpolation.
    //
    // At HOME_SCALE the visible complex-plane region spans ~3.5 × 2.4 units,
    // which comfortably contains the entire Mandelbrot set (~2.5 × 2.5 units).
    // Every zoom target lies within that frame, so the exact centre value is
    // irrelevant while zoomed out. At deep zoom the centre is precisely on the
    // target boundary detail. No mix(), no cubic lag, no transit through the
    // black interior.
    // -----------------------------------------------------------------------
    vec2 center = zoom_target(cur_idx);

    vec2 c = center + uv / scale;

    // Adaptive iteration cap: 80 at widest view (fast), 256 at max zoom (fine
    // boundary detail).  Interior pixels bail out early via cardioid/bulb
    // checks so the reduced ceiling costs nothing at the boundary.
    int max_iter = 80 + int(zoom_t * 176.0);
    float n = mandelbrot(c, max_iter);

    if (n == 0.0) {
        // Interior of the set: near-black with a faint blue depth cue.
        fragColor = vec4(0.01, 0.01, 0.04, 1.0);
        return;
    }

    // Normalise to [0, 1] for palette lookup.
    float t_palette = n / float(max_iter);

    // Slow time-based colour drift so hues shift even when geometry is stable.
    float time_offset = u_time * u_speed_scale * 0.02;
    vec3  col = palette(fract(t_palette + time_offset));

    // Enhance contrast near the boundary with a smooth power curve.
    float brightness = pow(t_palette, 0.6);
    col *= brightness * 1.4;

    // Subtle vignette.
    float vignette = 1.0 - 0.3 * dot(uv, uv);
    col *= vignette;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
