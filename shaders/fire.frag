#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — fire.frag
//
// Classic procedural fire effect — roiling flames rise from the bottom edge.
// Three octaves of hash-based value noise scroll upward over time. A height
// mask (smoothstep along Y) focuses intensity at the base; the noise output
// feeds directly into palette(t) so any palette works — ember gives realistic
// fire, frost gives an ice-flame, etc.
//
// Optional ember particles: small bright dots drift upward above the main
// flame body using a hash-based particle system (20 particles per 2 layers).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// ---------------------------------------------------------------------------
// 2D value noise — bilinear interpolation of hashed lattice points.
// Smooth-stepped for C1 continuity. ~12 lines, no additional dependencies.
// ---------------------------------------------------------------------------

float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);

    // Smooth interpolation (Hermite cubic).
    vec2 u = f * f * (3.0 - 2.0 * f);

    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// ---------------------------------------------------------------------------
// FBM — three octaves of value noise scrolling upward.
// Each octave has 2× frequency and 0.5× amplitude vs the previous.
// ---------------------------------------------------------------------------

float fbm_fire(vec2 uv, float t) {
    float v    = 0.0;
    float amp  = 1.0;
    float freq = 1.0;
    float norm = 0.0;

    for (int i = 0; i < 3; i++) {
        // Scroll upward at slightly different speeds per octave.
        float scroll = t * (1.2 + float(i) * 0.4);
        v    += noise2(uv * freq + vec2(0.0, -scroll)) * amp;
        norm += amp;
        amp  *= 0.5;
        freq *= 2.0;
    }

    return v / norm;
}

// ---------------------------------------------------------------------------
// Ember particles — small bright dots drifting upward above the flame body.
// Two layers × 10 particles each.
// ---------------------------------------------------------------------------

float embers(vec2 uv, float t) {
    float glow = 0.0;
    float aspect = u_resolution.x / u_resolution.y;

    for (int layer = 0; layer < 2; layer++) {
        float fl = float(layer);
        float seed_base = fl * 137.531;

        for (int j = 0; j < 10; j++) {
            float fj = float(j);

            float hx     = hash11(seed_base + fj * 17.37 + 1.11);
            float hy     = hash11(seed_base + fj * 53.19 + 2.22);
            float hspeed = hash11(seed_base + fj * 73.11 + 3.33) * 0.15 + 0.08;
            float hsize  = hash11(seed_base + fj * 31.47 + 4.44) * 0.008 + 0.003;

            // Drift upward; x has a gentle sine sway.
            float px = (hx - 0.5) * aspect + sin(t * hspeed * 3.0 + hx * 6.28) * 0.02;
            float py = -0.5 + fract(hy + hspeed * t);

            // Only visible above the main flame (upper half of screen).
            if (py < 0.0) continue;

            float dist = length(uv - vec2(px, py));
            float g    = smoothstep(hsize, 0.0, dist);
            // Fade out as embers rise higher.
            float fade = 1.0 - smoothstep(0.0, 0.5, py);
            glow += g * g * fade * 0.6;
        }
    }

    return glow;
}

// ---------------------------------------------------------------------------

void main() {
    float aspect = u_resolution.x / u_resolution.y;
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    float t = u_time * u_speed_scale;

    // Remap UV so Y=0 is the bottom edge, Y=1 is the top.
    // uv.y in our centred space goes from -0.5 to +0.5 (screen-height units).
    vec2 flame_uv = vec2(uv.x, uv.y + 0.5);

    // Organic horizontal sway before sampling noise.
    flame_uv.x += sin(flame_uv.y * 3.0 + t * 0.9) * 0.025;

    // Scale: X wider than Y for broader flame tongues.
    vec2 noise_uv = vec2(flame_uv.x * 1.8, flame_uv.y * 2.5);

    float n = fbm_fire(noise_uv, t * 1.3);

    // Height mask: full intensity at the base, zero at the top.
    float height_mask = smoothstep(1.0, 0.0, flame_uv.y * 1.1);

    // Combined intensity — noise shaped by the height mask.
    float intensity = clamp(n * height_mask * 2.2 - 0.05, 0.0, 1.0);

    // Map intensity to palette. t≈0 → cool embers/dark, t≈1 → hot bright tips.
    vec3 col = palette(intensity);

    // Ember particles additively blended on top.
    float ember_glow = embers(uv, t * 0.7);
    col += palette(0.85) * ember_glow;

    // Subtle vignette on the sides to focus the eye to the centre.
    float vignette = 1.0 - smoothstep(0.3, 0.9, abs(uv.x / (aspect * 0.5)));
    col *= mix(0.7, 1.0, vignette);

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
