#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — fire.frag
//
// Three-layer demoscene flame effect.  Each layer has an independent spiky
// 1D profile (4 octaves of 1D noise along x) that creates sharp tongue tips
// rather than a smooth wave.  Layers are composited additively.
//
// Architecture:
//   Layer 1 (base)  — height 20–50%, widest, slowest
//   Layer 2 (mid)   — height 30–65%, medium width, medium speed
//   Layer 3 (tips)  — height 40–80%, narrow spikes, fastest
//
// Each layer: sharp smoothstep cutoff (0.03 band), internal turbulence noise.
// Bottom 10% always fully hot.  Hard black above 85%.
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
// 1D smooth noise (bilinear between hashed lattice points).
// ---------------------------------------------------------------------------
float noise1(float p) {
    float i = floor(p);
    float f = fract(p);
    float u = f * f * (3.0 - 2.0 * f);
    return mix(hash11(i), hash11(i + 1.0), u);
}

// ---------------------------------------------------------------------------
// 2D value noise (for internal turbulence).
// ---------------------------------------------------------------------------
float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// ---------------------------------------------------------------------------
// 1D flame profile — 4 octaves of noise sampled along x.
// High-frequency octaves create SHARP spiky tips.
// Returns value in roughly [0, 1].
// ---------------------------------------------------------------------------
float flameProfile(float x, float t_local) {
    return noise1(x * 2.0  + t_local * 0.50) * 0.500
         + noise1(x * 5.0  + t_local * 1.20) * 0.250
         + noise1(x * 11.0 + t_local * 2.50) * 0.125
         + noise1(x * 23.0 + t_local * 4.00) * 0.0625;
}

// ---------------------------------------------------------------------------
// Single flame layer.
// base_y    — minimum flame top (uv.y = 0 at bottom)
// amplitude — how far above base_y the profile can reach
// t_anim    — independent time offset for this layer
// Returns intensity in [0, 1].
// ---------------------------------------------------------------------------
float flameLayer(vec2 uv, float base_y, float amplitude, float t_anim) {
    float profile  = flameProfile(uv.x, t_anim);
    float flame_top = base_y + profile * amplitude;

    // Sharp top edge — 0.03 transition band.
    float mask = smoothstep(flame_top, flame_top - 0.03, uv.y);

    // Internal turbulence: vertical streaking within the flame body.
    float turb = noise2(uv * vec2(6.0, 10.0) + vec2(0.0, -t_anim * 1.5));
    float body = mix(0.55, 1.0, turb);

    return mask * body;
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;  // uv.y: 0 = bottom, 1 = top
    float t = u_time * u_speed_scale;

    // ── Three flame layers ────────────────────────────────────────────────────

    // Layer 1: base fire — wide, slow, covers 20–50% height
    float L1 = flameLayer(uv, 0.20, 0.30, t * 1.0);

    // Layer 2: mid flames — medium, moderate speed, 30–65% height
    float L2 = flameLayer(uv, 0.30, 0.35, t * 1.3 + 7.3);

    // Layer 3: flame tips — narrow sharp spikes, fastest, 40–80% height
    float L3 = flameLayer(uv, 0.40, 0.40, t * 1.7 + 13.7);

    // Additive composite with layer weights
    float total = L1 * 0.50 + L2 * 0.35 + L3 * 0.25;

    // ── Bottom 10%: always fully hot ─────────────────────────────────────────
    float base_glow = smoothstep(0.10, 0.0, uv.y);
    total = max(total, base_glow);

    // ── Hard black above 85% ─────────────────────────────────────────────────
    float top_kill = smoothstep(0.85, 0.80, uv.y);
    total *= top_kill;

    total = clamp(total, 0.0, 1.0);

    // ── Color mapping ─────────────────────────────────────────────────────────
    float palette_t = pow(total, 0.6);
    vec3 col = palette(palette_t) * smoothstep(0.0, 0.12, total);

    // Boost white-hot coals at very bottom
    col += palette(0.95) * base_glow * top_kill * 0.45;

    // Subtle side vignette
    float vignette = 1.0 - smoothstep(0.3, 0.9, abs((uv.x - 0.5) / 0.5));
    col *= mix(0.75, 1.0, vignette);

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
