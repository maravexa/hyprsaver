#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — flames.frag
//
// Realistic fire using fBm with domain warping + turbulence noise hybrid.
// Reference techniques: Inigo Quilez domain warping (two-pass q then p+q*0.5)
// combined with Book of Shaders abs(noise) turbulence for organic flame tongues.
//
// A/B companion to fire.frag (v0.4.0 baseline). fire.frag is intentionally
// untouched — this shader tests fBm+domain-warping vs fire.frag's
// scroll-only FBM approach.
//
// Key implementation decisions:
//   - Turbulence: abs(noise*2-1) converts [0,1] noise to signed range before
//     taking abs(). Using abs() directly on [0,1] noise produces flat blobs.
//   - No horizontal drift: p.z (time) wires into fbm() through the y-component
//     only. Adding it to x causes lateral flame sliding that breaks the illusion.
//   - Ember floor: forces palette_t >= 0.6 at the base so any palette produces
//     hot glowing coals regardless of what it maps at low-t values.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;

// ---------------------------------------------------------------------------
// Hash and value noise [0, 1]
// ---------------------------------------------------------------------------

float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// 2D value noise — bilinear interpolation with Hermite cubic smoothing.
float vnoise(vec2 p) {
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
// fBm with turbulence — 4 octaves.
//
// Turbulence: noise is in [0,1] so we must convert to [-1,1] BEFORE abs().
// abs(noise) on [0,1] gives a one-sided blob; abs(noise*2-1) gives true
// turbulent folds that look like fire.
//
// Time axis: p.z feeds into the y-component of the 2D sample only.
// Wiring p.z into x causes horizontal flame drift — must stay y-only.
// ---------------------------------------------------------------------------

float fbm(vec3 p) {
    float v    = 0.0;
    float amp  = 0.5;
    float freq = 1.0;
    float norm = 0.0;

    for (int i = 0; i < 4; i++) {
        // Y-only time wiring — temporal variation without lateral drift.
        float n = vnoise(p.xy * freq + vec2(0.0, p.z * freq));
        // Turbulence: convert [0,1] → signed [-1,1], then fold with abs().
        v    += abs(n * 2.0 - 1.0) * amp;
        norm += amp;
        amp  *= 0.5;
        freq *= 2.0;
    }

    return v / norm;
}

// ---------------------------------------------------------------------------

void main() {
    float aspect = u_resolution.x / u_resolution.y;

    // Standard project UV — centred at screen middle, resolution-independent.
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    float t = u_time * u_speed_scale;

    // Remap so flame_uv.y = 0.0 at the bottom edge, 1.0 at the top.
    // Centred UV has y in [-0.5, +0.5] (screen-height units).
    vec2 flame_uv = vec2(uv.x, uv.y + 0.5);

    // -----------------------------------------------------------------------
    // Domain warping — Inigo Quilez two-pass technique.
    //
    // p encodes the sample position with upward scroll built in:
    //   - flame_uv.y * 1.5 - t * 1.5: as t grows, y-offset decreases
    //     which makes the noise field scroll upward (fire rises).
    //   - p.z = t * 0.5: slow temporal evolution passed through fbm() via y.
    // -----------------------------------------------------------------------
    vec3 p = vec3(flame_uv.x * 2.0, flame_uv.y * 1.5 - t * 1.5, t * 0.5);

    // First warp pass: two independent fbm samples offset in space and time.
    vec3 q = vec3(
        fbm(p + vec3(0.0, 0.0, t * 0.3)),
        fbm(p + vec3(5.2, 1.3, t * 0.3)),
        t
    );

    // Final intensity: sample at the domain-warped position.
    float intensity = fbm(p + q * 0.5);

    // -----------------------------------------------------------------------
    // Height mask — anchors fire at the bottom, hard 70% ceiling above.
    //
    //   flame_uv.y in [0.0, 0.3]: full intensity (bed of coals / embers)
    //   flame_uv.y in [0.3, 0.7]: smooth falloff (flame tongues, varying peak)
    //   flame_uv.y above 0.7   : no fire (black sky)
    //
    // A small high-frequency noise perturbation creates irregular flame tips
    // rather than a hard horizontal cutoff.
    // -----------------------------------------------------------------------
    float height_mask = 1.0 - smoothstep(0.3, 0.7, flame_uv.y);
    height_mask += vnoise(vec2(flame_uv.x * 8.0, t * 2.5)) * 0.1
                   * (1.0 - flame_uv.y);
    height_mask = clamp(height_mask, 0.0, 1.0);

    // Shape fire intensity by the height mask.
    float shaped = clamp(intensity * height_mask * 2.5 - 0.05, 0.0, 1.0);

    // -----------------------------------------------------------------------
    // Ember glow floor — guarantees a hot base with any palette.
    //
    // ember = 1.0 at the very bottom, 0.0 at flame_uv.y = 0.3 and above.
    //
    // The floor forces palette_t into [0.6, 1.0] at the base so palettes
    // that map low-t values to dark/cool colors still produce glowing coals.
    // This is critical: without it, dark-base palettes look broken.
    //
    // The final smoothstep gate on `shaped` keeps the sky black even though
    // `palette_t` might be 0.6 from the floor above the flame zone.
    // -----------------------------------------------------------------------
    float ember    = smoothstep(0.3, 0.0, flame_uv.y); // 1.0 at bottom → 0 at 30%
    float palette_t = shaped;
    palette_t = max(palette_t, 0.6 + ember * 0.4);     // ember floor: 0.6–1.0

    // Power curve: realistic brightness ramp — bright base, dark wispy tips.
    vec3 color = palette(pow(clamp(palette_t, 0.0, 1.0), 0.65));

    // Zero color where there is no fire (sky stays black despite the floor).
    color *= smoothstep(0.0, 0.04, shaped);

    // Subtle side vignette to focus the eye toward the screen centre.
    float vignette = 1.0 - smoothstep(0.3, 0.9, abs(uv.x / (aspect * 0.5)));
    color *= mix(0.7, 1.0, vignette);

    fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
