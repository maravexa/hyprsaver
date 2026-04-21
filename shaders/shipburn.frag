#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — shipburn.frag
//
// Burning Ship Julia variant. Same iteration structure as the classic Julia
// set but with |re(z)| + i·|im(z)| absolute-value folding before squaring
// each step. The fold breaks the rotational symmetry of the standard Julia
// and produces the angular, mirror-symmetric "ship" silhouette aesthetic.
//
// c follows a tight orbit through a known-interesting region of the Burning
// Ship parameter space. Full cycle ≈ 42 s at default speed.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

void main() {
    // Centered, aspect-ratio-correct coordinates.
    vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec2 z = p * 2.0;

    // Tight orbit in a structurally-rich region of Burning Ship parameter
    // space. 3× faster angular velocity keeps interesting-state frequency high.
    // Full cycle ≈ 42 s at default speed.
    float angle = u_time * u_speed_scale * 0.15;
    vec2 c = vec2(
        -1.762 + 0.020 * cos(angle),
        -0.028 + 0.020 * sin(angle)
    );

    const int MAX_ITER = 150;
    float escape_iter = float(MAX_ITER);
    bool escaped = false;

    for (int i = 0; i < MAX_ITER; i++) {
        // Burning Ship folding: take absolute value of each component before
        // squaring. This is what produces the angular, asymmetric shapes
        // instead of the smooth spirals of the classic Julia set.
        z = abs(z);
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;

        float d2 = dot(z, z);
        if (d2 > 4.0) {
            // Smooth iteration count (Inigo Quilez technique).
            float nu = log2(log2(sqrt(d2)));
            escape_iter = float(i) + 1.0 - nu;
            escaped = true;
            break;
        }
    }

    // Interior pixels are pure black — no palette sampling inside the set
    if (!escaped) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    float t_col = escape_iter / float(MAX_ITER);

    // Smoothstep thickening (preserved from previous tuning)
    // Widens bright bands by compressing high-iter region into wider palette range
    float t_thick = smoothstep(0.0, 0.6, t_col);

    // Two-layer julia-style palette cycling
    // col_boundary cycles 3x across palette, drifts with time
    vec3 col_boundary = palette(fract(t_thick * 3.0 + u_time * 0.05));
    // col_shimmer cycles 2x, offset in palette space by 0.3, drifts at different rate
    vec3 col_shimmer  = palette(fract(t_thick * 2.0 + u_time * 0.07 + 0.3));

    // Blend — boundary dominant, shimmer adds within-line color variation
    vec3 col = mix(col_boundary, col_shimmer, 0.35);

    // Brightness shaping: pow curve emphasizes mid-to-high escape range
    // The 1.6 multiplier pushes bright regions toward saturation
    col *= pow(t_thick, 0.5) * 1.6;

    // Edge smoothstep: pixels with very low t_col fade to black
    col *= smoothstep(0.0, 0.02, t_col);

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
