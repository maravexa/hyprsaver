#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — julia.frag
//
// Julia set with an animated parameter c that slowly traces a cardioid path
// through the Mandelbrot set boundary, morphing through dramatically different
// fractal shapes. Smooth iteration coloring + orbit trap glow.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Animated Julia constant — traces the main cardioid boundary
// ---------------------------------------------------------------------------
vec2 julia_c(float t) {
    // Slow path along a cardioid near the main bulb / period-2 bulb boundary.
    // This keeps the Julia set in a visually interesting, connected region.
    float angle = t * 0.15 + 1.3;
    float r     = 0.7885;
    return vec2(r * cos(angle), r * sin(angle));
}

// ---------------------------------------------------------------------------
// Smooth Julia iteration
// Returns normalised escape value, or 0.0 for interior.
// Also accumulates minimum orbit trap distance for glow.
// ---------------------------------------------------------------------------
float julia(vec2 z, vec2 c, int max_iter, out float trap) {
    trap = 1e9;
    for (int i = 0; i < max_iter; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        float d2 = dot(z, z);
        // Orbit trap: minimum distance to the real axis (creates filament glow).
        trap = min(trap, abs(z.y));
        if (d2 > 4.0) {
            float nu = log2(log2(sqrt(d2)));
            return float(i) + 1.0 - nu;
        }
    }
    return 0.0;
}

void main() {
    float t = u_time * 0.5;  // half speed
    // Centered at screen midpoint, uniform scaling, aspect-ratio correct.
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // Gentle oscillating zoom to animate depth without dizziness.
    float zoom = 1.3 + 0.3 * sin(t * 0.07);
    // Slow pan to keep interesting regions centered.
    vec2 offset = vec2(sin(t * 0.031) * 0.05, cos(t * 0.023) * 0.05);

    vec2 z = uv * 2.5 / zoom + offset;
    vec2 c = julia_c(t);

    int   max_iter = 200;
    float trap;
    float n = julia(z, c, max_iter, trap);

    if (n == 0.0) {
        // Interior: dark with subtle orbit-trap glow.
        float glow = exp(-trap * 4.0) * 0.4;
        vec3 interior = palette(fract(t * 0.03)) * glow;
        fragColor = vec4(interior, 1.0);
        return;
    }

    float t_col = n / float(max_iter);

    // Two-layer coloring: boundary striping + orbit trap shimmer.
    vec3 col_boundary = palette(fract(t_col * 3.0 + t * 0.05));
    float trap_glow   = exp(-trap * 6.0);
    vec3 col_trap     = palette(fract(t * 0.07 + 0.5)) * trap_glow;

    vec3 col = mix(col_boundary, col_trap, 0.35);
    col *= pow(t_col, 0.5) * 1.6;

    // Subtle edge darkening.
    float edge = smoothstep(0.0, 0.02, t_col);
    col *= edge;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
