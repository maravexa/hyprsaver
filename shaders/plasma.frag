#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — plasma.frag
//
// Classic plasma effect: overlapping sine waves in screen space, time, and
// polar coordinates create a smoothly undulating colour field. Four independent
// wave layers with irrational frequency ratios ensure the pattern never
// visibly repeats.
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

vec3 palette(float t) {
    return u_palette_a + u_palette_b * cos(6.28318530718 * (u_palette_c * t + u_palette_d));
}

// ---------------------------------------------------------------------------
// Smooth noise helper — cheaper than a true hash, visually sufficient.
// ---------------------------------------------------------------------------
float wave(float x) {
    return sin(x) * 0.5 + 0.5;
}

void main() {
    vec2 uv  = gl_FragCoord.xy / u_resolution;
    float ar = u_resolution.x / u_resolution.y;

    // Aspect-corrected coordinates centered at (0, 0).
    vec2 p = (uv - 0.5) * vec2(ar, 1.0) * 2.0;
    float t = u_time;

    // ---------------------------------------------------------------------------
    // Four plasma layers with incommensurable frequencies
    // ---------------------------------------------------------------------------

    // Layer 1 — horizontal sine ripple, slow drift
    float v1 = wave(p.x * 3.1 + t * 0.7);

    // Layer 2 — diagonal sine, medium speed
    float v2 = wave(p.x * 1.7 + p.y * 2.3 - t * 1.1);

    // Layer 3 — radial: distance from animated off-centre point
    vec2 center3 = vec2(sin(t * 0.41) * 0.6, cos(t * 0.37) * 0.4);
    float v3 = wave(length(p - center3) * 4.7 - t * 1.9);

    // Layer 4 — second radial, different orbit
    vec2 center4 = vec2(cos(t * 0.29) * 0.5, sin(t * 0.53) * 0.3);
    float v4 = wave(length(p - center4) * 3.3 + t * 1.3);

    // Combine: simple average produces a smooth [0, 1] value.
    float plasma = (v1 + v2 + v3 + v4) * 0.25;

    // Add a secondary frequency for fine detail.
    float detail = wave(plasma * 6.2832 * 2.0 + t * 0.3) * 0.15;
    plasma = clamp(plasma + detail, 0.0, 1.0);

    // Slow global palette rotation.
    float palette_t = fract(plasma + t * 0.06);
    vec3 col = palette(palette_t);

    // Brightness modulation: brighter near the wave crests.
    float brightness = 0.7 + 0.3 * sin(plasma * 6.28318 * 3.0 + t * 0.5);
    col *= brightness;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
