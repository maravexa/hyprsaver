#version 320 es
precision highp float;

uniform float u_time;
uniform vec2 u_resolution;
uniform vec3 u_palette_a;
uniform vec3 u_palette_b;
uniform vec3 u_palette_c;
uniform vec3 u_palette_d;

out vec4 fragColor;

vec3 palette(float t) {
    return u_palette_a + u_palette_b * cos(6.28318 * (u_palette_c * t + u_palette_d));
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;

    // Top 70%: full palette gradient left to right, with slow time scroll
    // Bottom 30%: palette applied to a simple pattern to preview how it looks on geometry

    if (uv.y > 0.3) {
        // Pure gradient bar — shows the entire palette across the screen
        // Time offset scrolls the palette slowly so you see it animate
        float t = uv.x + u_time * 0.05;
        fragColor = vec4(palette(t), 1.0);
    } else {
        // Preview pattern: concentric rings centered with aspect correction
        vec2 ring_uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
        ring_uv.y += 0.35;  // shift center to the middle of the bottom 30%
        float dist = length(ring_uv) * 8.0;
        float t = dist + u_time * 0.2;
        fragColor = vec4(palette(t), 1.0);
    }
}
