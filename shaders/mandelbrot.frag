#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — mandelbrot.frag
//
// Zoom cycle: home (full-fractal view) → target → home.
// Cycles through 12 verified boundary targets every 50 s; max zoom ~268×
// (1.5^14) — safely within float32 precision limits.
//
// v0.3.2 changes:
//   • Home position: every cycle starts and ends at HOME_CENTER = (-0.5, 0.0)
//     with scale 1.0, showing the classic full-fractal view.  The prior
//     ping-pong zoom kept the camera near the active target even at the widest
//     point; now it always returns to the standard textbook framing.
//   • Three-phase cycle: zoom-in (zoom_t 0→1) then zoom-out (zoom_t 1→0),
//     each driven by a smoothstep S-curve for natural easing.
//   • Target switches only at zoom_t = 0.0 (camera at HOME_CENTER, scale 1×),
//     so there is never a visible jump or pop between targets.
//   • Center interpolates as mix(HOME_CENTER, target, zoom_t): the pan from
//     home to the next target happens automatically during zoom-in.
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
// Home position — the standard full-fractal Mandelbrot view.
// At scale 1.0 the camera shows the central region of the set centred on the
// geometric midpoint of the main cardioid and period-2 bulb.
// ---------------------------------------------------------------------------
const vec2 HOME_CENTER = vec2(-0.5, 0.0);

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
    float t        = fract(total_t);

    // -----------------------------------------------------------------------
    // Zoom depth: smoothstep S-curve for both in and out phases.
    //   zoom_t = 0.0  →  home (scale 1×, center HOME_CENTER)
    //   zoom_t = 1.0  →  maximum zoom (scale ~268×, center = target)
    // -----------------------------------------------------------------------
    float zoom_t;
    if (t < 0.5) {
        zoom_t = smoothstep(0.0, 0.5, t);        // 0 → 1  (zoom in)
    } else {
        zoom_t = 1.0 - smoothstep(0.5, 1.0, t); // 1 → 0  (zoom out)
    }

    // Exponential zoom: logarithmic feel — slow at start, faster in middle.
    float scale = pow(1.5, zoom_t * max_zoom_exp);

    // -----------------------------------------------------------------------
    // Target selection — stateless, deterministic, no consecutive repeats.
    //
    // Target advances at the cycle boundary (zoom_t = 0.0, camera at
    // HOME_CENTER) so switching targets never causes a visible jump.
    // -----------------------------------------------------------------------
    int cur_raw  = int(hash(cycle_id)       * float(NUM_TARGETS));
    int prev_raw = int(hash(cycle_id - 1.0) * float(NUM_TARGETS));
    int cur_idx  = (cur_raw == prev_raw) ? (cur_raw + 1) % NUM_TARGETS : cur_raw;

    // -----------------------------------------------------------------------
    // Camera centre: HOME_CENTER at zoom_t = 0, target at zoom_t = 1.
    // The pan from home toward the target happens naturally during zoom-in;
    // the return pan happens during zoom-out — always through HOME_CENTER.
    // -----------------------------------------------------------------------
    vec2 center = mix(HOME_CENTER, zoom_target(cur_idx), zoom_t);

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
