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

    // Darken palette[0] so background reads as dark on every palette.
    vec3 bg = palette(0.0) * 0.25;

    vec3 color;
    if (escaped) {
        float raw_t = escape_iter / float(MAX_ITER);
        // Compress high-escape-iter region into a wider bright band.
        float t_primary = smoothstep(0.0, 0.6, raw_t);

        // Angle of escape gives subtle color variation within bands.
        float angle_mod = 0.5 + 0.5 * sin(atan(z.y, z.x) * 2.0 + u_time * 0.1);

        // Blend primary (structure) with secondary (detail), weighted toward primary.
        float t = mix(t_primary, t_primary * angle_mod + (1.0 - angle_mod) * 0.5, 0.3);
        t = clamp(t, 0.0, 1.0);

        color = palette(t);
    } else {
        color = bg;
    }

    fragColor = vec4(color, 1.0);
}
