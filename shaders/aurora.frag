#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — aurora.frag
//
// Ground-up view of aurora borealis: tall vertical curtains hang from the
// top of the screen and sway side to side, shimmering across the full height.
//
// Technique:
//   - 4 vertical curtain bands, each positioned at an evenly-spaced x
//     fraction of the screen
//   - Two-frequency sine wobble (driven by Y) + fBm displacement gives each
//     band an organic, swaying path
//   - Tight Gaussian profile (exp(-d*d*120)) keeps bands narrow and distinct
//   - Per-band fBm shimmer creates the characteristic pulsing/breathing
//   - Additive compositing with soft tone-map (x/(1+0.3x)) prevents blowout
//   - Unified palette gradient (bottom→top = palette(0.1)→palette(0.9)) so
//     the full colour spectrum is visible in every curtain
//   - No ground plane, no horizon mask — the entire screen is sky
//
// GPU cost: 4 bands × (1 fbm shimmer + 1 fbm displacement) + global fbm.
// Moderate — same tier as the clouds shader.
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
    return mix(mix(hash(i),                  hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// 4-octave fBm — soft shimmer, not rich structure.
float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    mat2 rot = mat2(1.6, 1.2, -1.2, 1.6);
    for (int j = 0; j < 4; j++) {
        value += amplitude * noise(p);
        p = rot * p;
        amplitude *= 0.5;
    }
    return value;
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;

    float t = u_time * u_speed_scale;

    // Very dark sky tint — just enough to see the palette colour in the voids.
    vec3 color = palette(0.05) * 0.1;

    const int NUM_BANDS = 4;

    for (int i = 0; i < NUM_BANDS; i++) {
        float fi = float(i);

        // Evenly distribute band centres across the full screen width.
        float band_x = (fi + 0.5) / float(NUM_BANDS);

        // Two-frequency sine wobble driven by Y — the curtain sways left/right
        // as it descends down the screen.
        float wobble = sin(uv.y * 2.5 + t * 0.12 + fi * 1.7) * 0.12
                     + sin(uv.y * 6.0 - t * 0.20 + fi * 3.1) * 0.04;

        // fBm displacement along Y breaks up the sine regularity for a more
        // organic, wind-blown curtain shape.
        float noise_offset = fbm(vec2(uv.y * 3.0 + fi * 10.0,
                                      t * 0.05)) * 0.08;

        float path_x = band_x + wobble + noise_offset;

        // Tight Gaussian profile perpendicular to the band path.
        // Factor 120 keeps bands narrow (~0.06 screen-width wide) and
        // prevents them from bleeding into each other.
        float dist = abs(uv.x - path_x);
        float band = exp(-dist * dist * 120.0);

        // fBm shimmer — characteristic aurora pulsing / rippling intensity.
        band *= 0.4 + 0.6 * fbm(vec2(uv.y * 8.0 + t * 0.15 + fi,
                                      uv.x * 4.0));

        // Palette gradient from bottom to top — all curtains share the same
        // colour range so the full spectrum is visible across each curtain's
        // height (bottom → palette(0.1), top → palette(0.9)).
        vec3 band_color = palette(uv.y * 0.8 + 0.1);
        vec3 contribution = band_color * band;

        color += contribution;
    }

    // Soft tone-map: prevents blowout where bands overlap while keeping
    // isolated bands at full brightness.
    color = color / (1.0 + color * 0.3);

    fragColor = vec4(color, 1.0);
}
