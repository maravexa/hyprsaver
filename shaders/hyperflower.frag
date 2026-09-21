#version 320 es
precision highp float;

// Hyperflower — psychedelic polar flower with kaleidoscopic folds and filigree.
// Copyright (c) 2026 Tijs Zwinkels. MIT licensed.
// https://github.com/tijszwinkels/hyperflower
//
// Pure screen-space math: inverse-radius depth, six/nine-fold petal waves,
// eight angular folds, and four bounded folding/inversion iterations.
// Keeps the original cosine rainbow palette rather than sampling palette LUTs.

uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed_scale;
uniform float u_zoom_scale;

out vec4 fragColor;

vec3 palette(float v) {
    return 0.52 + 0.48 * cos(6.28318 * (v + vec3(0.0, 0.33, 0.67)));
}

void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - u_resolution) / min(u_resolution.x, u_resolution.y);
    uv /= max(u_zoom_scale, 0.01);
    float time = u_time * u_speed_scale * 0.5;
    float r = length(uv);
    // atan(0, 0) is undefined; the center is masked below, but keep intermediates finite.
    float a = r > 0.0 ? atan(uv.y, uv.x) : 0.0;
    float t = time * 0.6;

    float petal = 1.0 + 0.13 * sin(6.0 * a + t) + 0.07 * cos(9.0 * a - t * 0.7);
    float depth = 1.6 / (r * petal + 0.22);
    float z = depth + time;
    float twist = a + depth * 0.46 + 0.38 * sin(depth * 0.7 - t);
    float fold = abs(fract(twist / 6.28318 * 8.0) - 0.5) * 2.0;

    // Thin neon rings and braided rails, with a softer halo underneath.
    float rings = abs(sin(z * 2.6 + fold * 3.0 + sin(twist * 6.0 - t)));
    float rails = abs(sin(twist * 12.0 + sin(z * 1.4) * 1.8));
    vec3 col = palette(depth * 0.16 + fold * 0.42 - t * 0.09)
        * (0.035 + 0.65 * exp(-rings * 24.0));
    col += palette(fold * 0.6 - depth * 0.1 + t * 0.08) * exp(-rails * 30.0) * 0.65;
    col += palette(z * 0.06 + fold * 0.3) * exp(-rings * 6.0) * 0.17;

    vec2 p = vec2(fold * 2.0 - 1.0, depth * 0.22 - t * 0.15);
    for (int i = 0; i < 4; i++) {
        float fi = float(i);
        p = abs(p) / max(dot(p, p), 0.32) - vec2(0.85 + 0.12 * sin(t * 0.5), 1.1);
        float filigree = abs(length(p) - (0.65 + 0.15 * sin(t * 0.6 + fi)));
        col += palette(fi * 0.21 + depth * 0.08 + t * 0.05)
            * (0.018 / (filigree + 0.055)) * 0.23;
    }

    float braid = abs(sin(twist * 5.0 + z * 1.8) * cos(twist * 3.0 - z * 0.9));
    col += palette(fold + z * 0.07 + 0.4) * exp(-braid * 45.0) * 0.24;
    col *= smoothstep(0.015, 0.23, r);
    col += palette(t * 0.07 + 0.55) * exp(-r * 9.0) * 0.38;
    col *= 1.0 - 0.28 * smoothstep(0.5, 1.9, r);
    col = 1.0 - exp(-col * 1.35);
    fragColor = vec4(col, 1.0);
}
