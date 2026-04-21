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
// c follows a slow orbit through a region of the Burning Ship parameter
// space that stays structurally rich across the full cycle.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

void main() {
    // Centered, aspect-ratio-correct coordinates.
    vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec2 z = p * 2.0;

    // c traces a slow orbit near the most structured column of the Burning
    // Ship parameter space. Full cycle ≈ 126 s at default speed.
    float angle = u_time * u_speed_scale * 0.05;
    vec2 c = vec2(
        -1.75 + 0.15 * cos(angle),
        -0.04 + 0.15 * sin(angle)
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

    vec3 color;
    if (escaped) {
        float t = clamp(escape_iter / float(MAX_ITER), 0.0, 1.0);
        color = palette(t);
    } else {
        color = palette(0.0);
    }

    fragColor = vec4(color, 1.0);
}
