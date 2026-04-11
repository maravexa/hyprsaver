#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — fire.frag
//
// Procedural fire anchored to the bottom of the screen. Flames cover the
// bottom ~40% always, with random columns pulsing up to 60-80% height.
// The top 20%+ stays black. No smoke — clean flame shapes only.
//
// Uses 5-8 independent flame columns driven by low-frequency noise, with
// high-frequency tips for flickering edges. Ember particles drift upward
// above the flame body.
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
// FBM — three octaves for flame turbulence within the masked region.
// ---------------------------------------------------------------------------

float fbm_fire(vec2 uv, float t) {
    vec2 scroll = vec2(t * 0.05, -t * 0.8);
    vec2 p = uv + scroll;

    float n = noise2(p * 1.0) * 0.5
            + noise2(p * 2.0) * 0.3
            + noise2(p * 4.0) * 0.2;

    return n;
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
            float py = fract(hy + hspeed * t);

            // Only visible in the upper portion (above base flames)
            if (py < 0.3) continue;

            float dist = length(uv - vec2(px, py));
            float g    = smoothstep(hsize, 0.0, dist);
            // Fade out as embers rise higher.
            float fade = 1.0 - smoothstep(0.3, 0.8, py);
            glow += g * g * fade * 0.6;
        }
    }

    return glow;
}

// ---------------------------------------------------------------------------

void main() {
    float aspect = u_resolution.x / u_resolution.y;
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;  // uv.y: 0=bottom, 1=top

    float t = u_time * u_speed_scale;

    // -----------------------------------------------------------------------
    // 1. COVERAGE MASK — per-column flame height
    // -----------------------------------------------------------------------

    float base_height = 0.4;  // flames always present below 40%

    // Low-frequency noise creates 5-8 flame columns across screen width.
    // noise2 at frequency ~3.0 gives ~3 full periods across width → ~6 columns.
    // Multiple time offsets create independent column pulsing.
    float col_noise1 = noise2(vec2(uv.x * 3.0 + t * 0.5, t * 0.3));
    float col_noise2 = noise2(vec2(uv.x * 4.5 + 10.0, t * 0.7 + 5.0));
    float col_noise  = col_noise1 * 0.7 + col_noise2 * 0.3;

    // Column height varies from base_height (0.4) up to 0.8
    float column_height = base_height + col_noise * 0.4;

    // 3. FLAME TIPS — high-frequency noise breaks up the boundary
    float tip_noise = noise2(vec2(uv.x * 15.0 + t * 4.0, t * 2.0)) * 0.08;
    column_height += tip_noise;

    // Additional fine tips for flickering
    float fine_tips = noise2(vec2(uv.x * 25.0 - t * 6.0, t * 3.5 + 7.0)) * 0.04;
    column_height += fine_tips;

    // The mask: 1.0 below column_height, fading to 0.0 above it
    // Transition band of 0.15 for soft flame edges
    float flame_mask = smoothstep(column_height, column_height - 0.15, uv.y);

    // -----------------------------------------------------------------------
    // 2. FLAME TURBULENCE — noise within the masked region
    // -----------------------------------------------------------------------

    // Map UVs for noise sampling: wider at base, tapered toward tips
    vec2 flame_uv = vec2(uv.x * aspect, uv.y);

    // Organic horizontal sway
    flame_uv.x += sin(uv.y * 3.0 + t * 0.9) * 0.025;

    // Flame shape: wider noise at base, tighter at tips
    float x_scale = 1.0 + (1.0 - uv.y) * 0.6;
    vec2 noise_uv = vec2(flame_uv.x * x_scale, flame_uv.y * 2.5);

    float n = fbm_fire(noise_uv, t * 1.3);

    // Combined intensity: noise shaped by the coverage mask
    float intensity = n * flame_mask * 2.5;

    // Edge flicker within the flame body
    float edge_noise = noise2(vec2(uv.x * 20.0 + t * 3.0, uv.y * 10.0 - t * 2.0));
    intensity += edge_noise * 0.08 * flame_mask;

    intensity = clamp(intensity, 0.0, 1.0);

    // -----------------------------------------------------------------------
    // 5. BOTTOM GLOW — hottest part of the fire bed
    // -----------------------------------------------------------------------

    float base_glow = smoothstep(0.15, 0.0, uv.y);
    intensity = max(intensity, base_glow);
    intensity = clamp(intensity, 0.0, 1.0);

    // -----------------------------------------------------------------------
    // Color mapping
    // -----------------------------------------------------------------------

    // Nonlinear palette mapping: power curve concentrates color range
    float palette_t = pow(intensity, 0.7);
    vec3 col = palette(palette_t) * smoothstep(0.0, 0.15, intensity);

    // Boost brightness at the very bottom for white-hot coals effect
    col += palette(0.95) * base_glow * 0.4;

    // -----------------------------------------------------------------------
    // Ember particles (only visible above flame body, within reason)
    // -----------------------------------------------------------------------

    float ember_glow = embers(vec2((uv.x - 0.5) * aspect, uv.y), t * 0.7);
    // Fade embers that are within the main flame body (they'd be invisible anyway)
    float ember_vis = smoothstep(base_height - 0.1, base_height + 0.1, uv.y);
    col += palette(0.85) * ember_glow * ember_vis;

    // -----------------------------------------------------------------------
    // 4. ENSURE TOP IS BLACK — hard cutoff above flame reach
    // -----------------------------------------------------------------------

    // Faint ambient warmth right above flame tips (2-3% opacity), then black
    float ambient_fade = smoothstep(column_height + 0.05, column_height - 0.02, uv.y);
    float top_kill = smoothstep(0.85, 0.80, uv.y);  // hard black above 85%
    col *= max(ambient_fade, flame_mask) * top_kill;

    // Re-add ember contribution (embers can exist above flame mask)
    col += palette(0.85) * ember_glow * ember_vis * top_kill * 0.3;

    // Subtle vignette on the sides
    float vignette = 1.0 - smoothstep(0.3, 0.9, abs((uv.x - 0.5) / 0.5));
    col *= mix(0.7, 1.0, vignette);

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
