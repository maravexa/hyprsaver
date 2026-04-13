#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — aurora.frag  (v2)
//
// Aurora borealis: vertical curtain bands with asymmetric exponential falloff.
// Sharp bright edge on one side, long soft glow tail on the other — this is
// what gives real aurora its distinctive luminous fringe appearance.
//
// Technique:
//   - 4 vertical curtain bands evenly distributed across the screen width
//   - Each band sways via multi-frequency sine waves driven by Y position
//   - Small raw-noise displacement for organic irregularity (cheap, no fBm)
//   - Asymmetric falloff: exp(-d²·300) on the sharp side,
//                         exp(-d²·20)  on the long tail side
//   - Palette sampled by abs(dist) from band center — color radiates outward
//     from the bright edge into the tail; no per-band palette offset
//   - Raw-noise shimmer on intensity (single noise() call, not fBm)
//   - Additive compositing + soft tone-map prevents blowout where bands overlap
//
// GPU cost: 4 bands × (2 noise() + sin math). No fBm in the hot path.
// One of the cheapest shaders in the collection (target: <10% GPU).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Hash + 2D value noise (smoothstep-interpolated lattice)
// ---------------------------------------------------------------------------

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i),               hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// 3-octave fBm — defined here for shimmer fallback if raw noise looks too
// uniform, but NOT called in the hot path below.
float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 3; i++) {
        v += a * noise(p);
        p = rot * p;
        a *= 0.5;
    }
    return v;
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    float time = u_time * u_speed_scale;

    // Dark sky background — just a faint hint of palette colour.
    vec3 color = palette(0.05) * 0.08;

    // --- CURTAIN BANDS ---
    // 4 vertical curtain bands distributed across the screen width.
    const int NUM_BANDS = 4;

    for (int i = 0; i < NUM_BANDS; i++) {
        float fi = float(i);

        // Band centre x, evenly spaced: 0.125, 0.375, 0.625, 0.875
        float band_x = (fi + 0.5) / float(NUM_BANDS);

        // Multi-frequency sine wobble driven by Y — curtain sways as it
        // descends.  Three frequencies give a natural, non-periodic sway.
        float wobble = sin(uv.y * 3.0  + time * 0.10 + fi * 2.5) * 0.060
                     + sin(uv.y * 7.0  - time * 0.15 + fi * 4.2) * 0.025
                     + sin(uv.y * 13.0 + time * 0.22 + fi * 1.8) * 0.010;

        // Single noise() call for small organic displacement — cheap, no fBm.
        float noise_displace = (noise(vec2(uv.y * 4.0 + fi * 10.0,
                                           time * 0.08)) - 0.5) * 0.04;

        float center = band_x + wobble + noise_displace;

        // Signed distance: positive = right of centre, negative = left.
        float dist = uv.x - center;

        // --- ASYMMETRIC FALLOFF — the aurora signature ---
        // Positive dist (right of centre): tight Gaussian → sharp bright edge.
        // Negative dist (left of centre):  wide Gaussian  → long glowing tail.
        float band;
        if (dist > 0.0) {
            band = exp(-dist * dist * 300.0);
        } else {
            band = exp(-dist * dist * 20.0);
        }

        // --- SHIMMER ---
        // Single noise() call — intensity pulses organically along the curtain.
        float shimmer = 0.6 + 0.4 * noise(vec2(uv.y * 10.0 + fi * 7.0,
                                                time * 0.12));
        band *= shimmer;

        // --- COLOR GRADIENT ---
        // Palette driven by distance from centre — color radiates outward from
        // the bright edge through the tail.  NOT by vertical position.
        // All bands share this same gradient (no per-band offset).
        float palette_t = clamp(abs(dist) * 5.0, 0.0, 0.85);
        // Bright edge → palette(0.15), far tail → palette(0.85)
        vec3 band_color = palette(0.15 + palette_t * 0.70);

        // Additive blend — bands layer naturally on top of each other.
        color += band_color * band * 0.7;
    }

    // Soft Reinhard-style tone-map: prevents blowout where bands overlap.
    color = color / (1.0 + color * 0.2);

    fragColor = vec4(color, 1.0);
}
