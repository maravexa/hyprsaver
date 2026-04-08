#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — mandelbrot.frag
//
// Animated ping-pong zoom into Mandelbrot boundary regions.
// Cycles through 4 targets every 50 s; max zoom ~268x (1.5^14) — safely
// within float32 precision limits. Smooth (continuous) iteration count
// coloring eliminates band artifacts and feeds into the cosine palette.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Cosine gradient palette (Inigo Quilez technique)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Smooth iteration count
// Returns a float in [0, max_iter) representing how quickly the orbit escaped.
// Uses the "normalized iteration count" formula to eliminate colour banding.
// ---------------------------------------------------------------------------
float mandelbrot(vec2 c, int max_iter) {
    vec2 z = vec2(0.0);
    for (int i = 0; i < max_iter; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        if (dot(z, z) > 4.0) {
            // Smooth colouring: subtract log of log of magnitude from iteration count.
            float log2z = log2(dot(z, z)) * 0.5;
            float nu    = log2(log2z);
            return float(i) + 1.0 - nu;
        }
    }
    return 0.0; // inside the set
}

// ---------------------------------------------------------------------------
// Zoom targets — four Mandelbrot boundary regions with rich detail
// ---------------------------------------------------------------------------
// GLSL ES 3.2 requires constant-index access on arrays declared as const.
// Declare as a function returning the appropriate vec2 to stay compatible.
vec2 zoom_target(int idx) {
    if (idx == 0) return vec2(-0.743643887037158, 0.131825904205330); // seahorse valley
    if (idx == 1) return vec2(-0.1015,            0.9658);            // elephant valley
    if (idx == 2) return vec2(-0.749,             0.1);               // spiral arm
                  return vec2(-1.25066,            0.02012);           // deep spiral
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
void main() {
    // Centered at screen midpoint, uniform scaling, aspect-ratio correct.
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // Zoom parameters — stay well within float32 precision limits.
    float zoom_cycle  = 50.0;        // seconds per ping-pong cycle
    float max_zoom_exp = 14.0 * u_zoom_scale;  // u_zoom_scale deepens the zoom ceiling

    // Sine-based ping-pong: 0→1→0 over zoom_cycle seconds, no discontinuity.
    float t = 0.5 - 0.5 * cos(u_time * u_speed_scale * 6.28318 / zoom_cycle);  // [0, 1]
    float scale = pow(1.5, t * max_zoom_exp);

    // Switch target region each time the sine wave completes a full cycle.
    int target_idx = int(floor(u_time * u_speed_scale / zoom_cycle)) % 4;
    vec2 center = zoom_target(target_idx);

    // Map screen coordinates to complex plane.
    vec2 c = center + uv / scale;

    // Adaptive iteration count: 100 at widest view, 300 at maximum zoom.
    int max_iter = 100 + int(t * 200.0);
    float n = mandelbrot(c, max_iter);

    if (n == 0.0) {
        // Interior of the set: deep black with a faint blue glow for depth.
        fragColor = vec4(0.01, 0.01, 0.04, 1.0);
        return;
    }

    // Normalise to [0, 1] for palette lookup.
    float t_palette = n / float(max_iter);

    // Slow time-based color drift so hues shift even when geometry is stable.
    float time_offset = u_time * u_speed_scale * 0.02;
    vec3 col = palette(fract(t_palette + time_offset));

    // Enhance contrast near the boundary with a smooth power curve.
    float brightness = pow(t_palette, 0.6);
    col *= brightness * 1.4;

    // Subtle vignette.
    float vignette = 1.0 - 0.3 * dot(uv, uv);
    col *= vignette;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
