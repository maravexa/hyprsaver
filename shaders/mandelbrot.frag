#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — mandelbrot.frag
//
// Animated zoom into the Seahorse Valley of the Mandelbrot set at
// c ≈ (-0.74364, 0.13183) — a boundary point with infinite spiral detail at
// every scale. Zoom loops every ~133s before float32 precision degrades.
// Smooth (continuous) iteration count coloring eliminates band artifacts and
// feeds directly into the cosine gradient palette.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

uniform vec3  u_palette_a;
uniform vec3  u_palette_b;
uniform vec3  u_palette_c;
uniform vec3  u_palette_d;

out vec4 fragColor;

// ---------------------------------------------------------------------------
// Cosine gradient palette (Inigo Quilez technique)
// ---------------------------------------------------------------------------
vec3 palette(float t) {
    return u_palette_a + u_palette_b * cos(6.28318530718 * (u_palette_c * t + u_palette_d));
}

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
// Zoom path: slow inward spiral toward the target point
// ---------------------------------------------------------------------------

// Target: Seahorse Valley — exact boundary point with infinite spiral detail.
const vec2 TARGET = vec2(-0.743643887037158, 0.131825904205330);

vec2 zoom_center(float t) {
    // Very slow drift to keep the interesting region in frame.
    float drift_x = sin(t * 0.013) * 0.00012;
    float drift_y = cos(t * 0.017) * 0.00008;
    return TARGET + vec2(drift_x, drift_y);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;

    // Aspect-corrected UV in [-1, 1]² (y flipped to match math convention).
    vec2 p = (uv * 2.0 - 1.0) * vec2(u_resolution.x / u_resolution.y, 1.0);

    float t      = u_time;
    // Loop zoom every ~133s (40 zoom-seconds at rate 0.3). Resets cleanly
    // before float32 precision degrades (~zoom 1e7 at zoom_t ≈ 40).
    float zoom_t = mod(t * 0.3, 40.0);
    vec2  center = zoom_center(t);
    float scale  = pow(1.5, zoom_t);

    // Map screen coordinates to complex plane.
    vec2 c = center + p / scale;

    // Adaptive iteration count: ramp up with zoom depth to preserve detail.
    int max_iter = 100 + int(zoom_t * 8.0);
    float n = mandelbrot(c, max_iter);

    if (n == 0.0) {
        // Interior of the set: deep black with a faint blue glow for depth.
        fragColor = vec4(0.01, 0.01, 0.04, 1.0);
        return;
    }

    // Normalise to [0, 1] for palette lookup.
    float t_palette = n / float(max_iter);

    // Slow time-based color drift so hues shift even when geometry is stable.
    float time_offset = u_time * 0.02;
    vec3 col = palette(fract(t_palette + time_offset));

    // Enhance contrast near the boundary with a smooth power curve.
    float brightness = pow(t_palette, 0.6);
    col *= brightness * 1.4;

    // Subtle vignette.
    float vignette = 1.0 - 0.35 * dot(uv - 0.5, uv - 0.5) * 4.0;
    col *= vignette;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
