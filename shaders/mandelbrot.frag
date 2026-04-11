#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — mandelbrot.frag
//
// Continuous forward zoom with fade-through-black transitions.
// Cycles through 16 verified boundary targets; max zoom ~268×
// (1.5^14) — safely within float32 precision limits.
//
// v0.4.0 changes:
//   • Replaced pingpong (zoom in then out) with continuous forward zoom loop.
//     Zoom progresses from HOME_SCALE (overview) to deep detail, then fades
//     through black and starts the next cycle on a new random target.
//   • Fade-through-black transition: 0.5 s fade out at max zoom, switch
//     target, 0.5 s fade in at overview zoom.  Dual-FBO cross-dissolve is
//     not available inside a fragment shader; see TODO below.
//   • 16 zoom targets (was 12).  Added: Elephant Valley, Mini-brot,
//     Antenna Tip, Scepter Valley.
//   • Iteration count scales with zoom depth:
//       max_iter = 100 + int(log2(zoom) * 20.0), capped at 500.
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
// Zoom targets — 16 verified Mandelbrot boundary coordinates.
//
// Selection criteria: the coordinate must be ON or within ~0.001 of the set
// boundary AND must show rich detail (not solid black, not washed-out) at
// every zoom level from 1× to 268× (1.5^14).
//
// Sources: coords 0-7 are community-verified; 8-11 retained from previous
// version after confirming they satisfy the above criteria; 12-15 added in
// v0.4.0.
// ---------------------------------------------------------------------------
#define NUM_TARGETS 16
vec2 zoom_target(int idx) {
    if (idx ==  0) return vec2(-0.7463,      0.1102    );  // Seahorse Valley (classic)
    if (idx ==  1) return vec2(-0.7453,      0.1127    );  // Seahorse Valley (variant)
    if (idx ==  2) return vec2(-0.16,        1.0405    );  // Branch Tip (upper)
    if (idx ==  3) return vec2(-0.1011,      0.9563    );  // Double Spiral
    if (idx ==  4) return vec2( 0.281717,    0.5771    );  // Elephant Trunk
    if (idx ==  5) return vec2(-0.0452,     -0.9868    );  // Double Spiral (lower)
    if (idx ==  6) return vec2( 0.3245,      0.04855   );  // Lightning
    if (idx ==  7) return vec2(-0.3905407,   0.5867879 );  // Fibonacci Spiral
    if (idx ==  8) return vec2(-0.77568377,  0.13646737);  // Dendrite (seahorse family)
    if (idx ==  9) return vec2(-1.4011552,   0.0       );  // Feigenbaum Point
    if (idx == 10) return vec2(-0.748,       0.102     );  // Seahorse Tail
    if (idx == 11) return vec2(-0.1592,     -1.0318    );  // Feather (lower set)
    if (idx == 12) return vec2( 0.2819,      0.0100    );  // Elephant Valley
    if (idx == 13) return vec2(-1.7497,      0.0       );  // Mini-brot
    if (idx == 14) return vec2(-0.1528,      1.0397    );  // Antenna Tip
                   return vec2(-0.1002,      0.8383    );  // Scepter Valley
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

    float cycle_duration = 50.0;                 // seconds per full zoom-in cycle
    float max_zoom_exp   = 14.0 * u_zoom_scale;  // 1.5^14 ≈ 268× at default scale

    // -----------------------------------------------------------------------
    // Fade-through-black transition at cycle boundaries.
    //
    // Each fade direction lasts 0.5 real seconds.  At the end of a cycle the
    // image fades to black (0.5 s), the target switches, and the new cycle
    // fades in from black (0.5 s).  Total black gap ≈ 0 frames (the last
    // fade-out frame of cycle N and first fade-in frame of cycle N+1 are
    // both near-black).
    //
    // TODO: Upgrade to true crossfade (mix deep_frame with overview_frame)
    // once per-shader dual-FBO rendering is available.  The renderer's
    // existing TransitionRenderer handles shader-to-shader crossfades but
    // cannot drive intra-shader zoom-cycle transitions.  When FBO access is
    // exposed to individual shaders, render both frames and blend directly.
    // -----------------------------------------------------------------------
    float fade_seconds = 0.5;
    float fade_frac    = fade_seconds / cycle_duration;  // ≈ 0.01

    // Decompose time into whole-cycle index and fractional phase [0, 1).
    float total_t  = u_time * u_speed_scale / cycle_duration;
    float cycle_id = floor(total_t);
    float t        = fract(total_t);  // phase within current cycle

    // -----------------------------------------------------------------------
    // Continuous forward zoom (no pingpong).
    //
    //   t ∈ [0, fade_frac)            → fade in from black, zoom begins
    //   t ∈ [fade_frac, 1-fade_frac)  → full brightness, zooming deeper
    //   t ∈ [1-fade_frac, 1)          → fade out to black, near max zoom
    //
    // zoom_t maps the full [0, 1) phase to zoom depth with ease-in/out so
    // the start and end feel smooth rather than abruptly starting/stopping.
    // -----------------------------------------------------------------------
    float zoom_t = smoothstep(0.0, 1.0, t);

    // Fade alpha: smooth ramp up at cycle start, ramp down at cycle end.
    float alpha = smoothstep(0.0, fade_frac, t)
                * (1.0 - smoothstep(1.0 - fade_frac, 1.0, t));

    // Exponential zoom: logarithmic feel — slow at overview, faster at depth.
    float scale = HOME_SCALE * pow(1.5, zoom_t * max_zoom_exp);

    // -----------------------------------------------------------------------
    // Target selection — stateless, deterministic, no consecutive repeats.
    //
    // Each cycle_id hashes to a target index.  If the hash collides with the
    // previous cycle's target, bump by one (mod NUM_TARGETS).
    // -----------------------------------------------------------------------
    int cur_raw  = int(hash(cycle_id)       * float(NUM_TARGETS));
    int prev_raw = int(hash(cycle_id - 1.0) * float(NUM_TARGETS));
    int cur_idx  = (cur_raw == prev_raw) ? (cur_raw + 1) % NUM_TARGETS : cur_raw;

    // -----------------------------------------------------------------------
    // Camera centre — always exactly the current target, no interpolation.
    // -----------------------------------------------------------------------
    vec2 center = zoom_target(cur_idx);

    vec2 c = center + uv / scale;

    // -----------------------------------------------------------------------
    // Adaptive iteration cap — scales with zoom depth.
    //
    //   max_iter = 100 + int(log2(zoom) * 20.0)
    //
    // At overview (zoom_t ≈ 0):  max_iter = 100   (fast full-set render)
    // At max zoom (zoom_t = 1):  max_iter ≈ 264   (14 * log2(1.5) * 20)
    // Hard cap at 500 to prevent GPU stalls on integrated hardware.
    // -----------------------------------------------------------------------
    float log2_zoom = zoom_t * max_zoom_exp * log2(1.5);
    int max_iter = min(100 + int(log2_zoom * 20.0), 500);
    float n = mandelbrot(c, max_iter);

    if (n == 0.0) {
        // Interior of the set: near-black with a faint blue depth cue,
        // modulated by fade alpha.
        fragColor = vec4(vec3(0.01, 0.01, 0.04) * alpha, 1.0);
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

    // Apply fade alpha for transition through black between cycles.
    col *= alpha;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
