#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — starfield.frag
//
// Three depth layers of scrolling stars. Each layer moves at a different
// speed along the Y axis, simulating parallax depth. Stars are hash-positioned
// within a grid of cells, colored by depth through the cosine palette, and
// brightness-pulsed with per-star phase offsets. Fully stateless GLSL —
// no CPU work per frame.
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
// Hash utilities
// ---------------------------------------------------------------------------

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

vec2 hash21(float p) {
    vec2 q = fract(vec2(p) * vec2(0.1031, 0.1030));
    q += dot(q, q.yx + 33.33);
    return fract((q.xx + q.yx) * q.xy);
}

// ---------------------------------------------------------------------------
// Accumulate star glow for one depth layer.
//   depth : 0.0 = far (slow, small, dim) … 1.0 = near (fast, large, bright)
//   speed : scroll velocity along Y
// ---------------------------------------------------------------------------
vec3 starLayer(vec2 uv, float depth, float speed) {
    float cellSize = mix(0.05, 0.15, depth);
    vec2 scaled = uv / cellSize;
    scaled.y += u_time * speed;

    vec2 cellId   = floor(scaled);
    vec2 cellFrac = fract(scaled);

    vec3 col = vec3(0.0);

    // Check 3×3 neighborhood so stars near cell boundaries are not clipped.
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            vec2  nb = cellId + vec2(float(dx), float(dy));
            float h  = hash11(nb.x * 127.1 + nb.y * 311.7 + depth * 74.3);

            // Star centre within cell in [0.2, 0.8] — avoids edge crowding.
            vec2 pos = hash21(h * 127.1) * 0.6 + 0.2;

            vec2  diff   = cellFrac - (pos + vec2(float(dx), float(dy)));
            float dist   = length(diff);
            float radius = mix(0.05, 0.13, depth);

            // Soft circular glow with sharpened core.
            float glow = smoothstep(radius, 0.0, dist);
            glow *= glow;

            // Per-star brightness pulse using a unique phase offset.
            float phase    = hash11(h * 53.7) * 6.28318530718;
            float pulseSpd = mix(0.4, 1.3, hash11(h * 31.4));
            float pulse    = 0.75 + 0.25 * sin(u_time * pulseSpd + phase);

            // Color from palette at star depth with a small per-star jitter.
            vec3 starCol = palette(depth + hash11(h * 91.3) * 0.15);

            col += starCol * glow * pulse;
        }
    }
    return col;
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    vec3 col = vec3(0.0);

    // Three layers: distant (slow, small) → near (fast, large).
    col += starLayer(uv, 0.0, 0.04);
    col += starLayer(uv, 0.5, 0.13);
    col += starLayer(uv, 1.0, 0.32);

    // Subtle vignette to draw the eye toward the centre.
    float vig = 1.0 - 0.28 * dot(uv * 1.2, uv * 1.2);
    col *= clamp(vig, 0.0, 1.0);

    fragColor = vec4(col, 1.0);
}
