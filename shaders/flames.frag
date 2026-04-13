#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — flames.frag
//
// Three-layer fire: background (largest, slowest) + mid-ground (medium) +
// foreground (finest, fastest). All three layers use fBm + IQ domain warping
// with noise-in-edge1 height masking so every layer produces irregular,
// ragged flame tips instead of a flat horizontal cutoff.
//
// Height mask technique (applied to all layers):
//   height_noise = vnoise(vec2(flame_uv.x * FREQ, t * SPEED)) * AMP
//   height_mask  = 1.0 - smoothstep(EDGE0, EDGE1 + height_noise, flame_uv.y)
//   Injecting noise into edge1 moves the cutoff boundary per-column, creating
//   tall peaks and short valleys. Adding noise to the mask value after the
//   smoothstep only adds faint jitter on an already-decided smooth fade —
//   that approach is intentionally NOT used here.
//
// Layer summary:
//   Background:  fbm3 (3 oct), spatial 1.5x, scroll t*1.0, seeds (3.1/7.4,
//                8.7/2.8), noise-in-edge1 freq=2.5 amp=0.25, edge1=0.70,
//                brightness 0.50 — largest shapes, slowest, dimmest.
//   Mid-ground:  fbm3 (3 oct), spatial 1.75x, scroll t*1.25, seeds (6.3/0.9,
//                1.7/5.5), noise-in-edge1 freq=3.5 amp=0.20, edge1=0.65,
//                brightness 0.75 — medium shapes and speed.
//   Foreground:  fbm  (4 oct), spatial 2.0x,  scroll t*1.5,  seeds (0.0/0.0,
//                5.2/1.3), noise-in-edge1 freq=5.0 amp=0.15, edge1=0.60,
//                brightness 1.00 — finest detail, fastest, brightest.
//
// Compositing: two-step screen blend (bg⊕mid⊕fg) so all layers contribute
//   to bright zones without clipping, and deeper layers show through gaps in
//   the foreground.
//
// Key implementation invariants:
//   - No horizontal drift: p.z (time) wires into fBm through y-component only.
//   - Ember floor on all layers: hot glowing coals at the base regardless of
//     palette mapping at low-t values.
//   - Shader compilation error safety: if this fails, wayland.rs falls back
//     to the previous built-in shader (fire.frag).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;

// ---------------------------------------------------------------------------
// Hash and value noise — returns [0, 1].
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
// 4-octave turbulence fBm — foreground flame layer.
//
// Turbulence: abs(noise * 2 - 1) converts [0,1] → signed before abs().
// Using abs() directly on [0,1] noise produces flat blobs; the signed
// conversion produces the folded-noise turbulence that looks like fire.
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
        float n = vnoise(p.xy * freq + vec2(0.0, p.z * freq));
        v    += abs(n * 2.0 - 1.0) * amp;
        norm += amp;
        amp  *= 0.5;
        freq *= 2.0;
    }

    return v / norm;
}

// ---------------------------------------------------------------------------
// 3-octave turbulence fBm — background and mid-ground flame layers.
//
// One fewer octave than the foreground to stay within GPU budget.
// Detail loss on the back layers is hidden behind the foreground.
// ---------------------------------------------------------------------------

float fbm3(vec3 p) {
    float v    = 0.0;
    float amp  = 0.5;
    float freq = 1.0;
    float norm = 0.0;

    for (int i = 0; i < 3; i++) {
        float n = vnoise(p.xy * freq + vec2(0.0, p.z * freq));
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

    // Standard projected UV — centred at screen middle, resolution-independent.
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    float t = u_time * u_speed_scale;

    // Remap so flame_uv.y = 0.0 at bottom edge, 1.0 at top.
    // Centred UV has y in [-0.5, +0.5] (screen-height units).
    vec2 flame_uv = vec2(uv.x, uv.y + 0.5);

    // -----------------------------------------------------------------------
    // BACKGROUND layer — largest, slowest flames, furthest back.
    //
    //   - Spatial frequency 1.5x/1.2y: large flame shapes → reads as deep.
    //   - Upward scroll t * 1.0: slow, heavy movement.
    //   - Domain warp seeds (3.1/7.4) and (8.7/2.8): decorrelated from other
    //     layers so motion is fully independent.
    //   - fbm3 (3 octaves): GPU savings; detail loss hidden behind foreground.
    //   - Noise-in-edge1: freq=2.5 (wide peaks), amp=0.25 (25% variation),
    //     edge1 base=0.70 — peaks reach up to y=0.95 (tallest layer).
    //   - 50% brightness: pushed furthest back visually.
    // -----------------------------------------------------------------------
    vec3 p_bg = vec3(flame_uv.x * 1.5, flame_uv.y * 1.2 - t * 1.0, t * 0.3);

    vec3 q_bg = vec3(
        fbm3(p_bg + vec3(3.1, 7.4, t * 0.2)),
        fbm3(p_bg + vec3(8.7, 2.8, t * 0.2)),
        t
    );

    float bg_intensity = fbm3(p_bg + q_bg * 0.5);

    // Noise-in-edge1: inject per-column noise into the smoothstep upper bound.
    // Range [0.0, 0.25] → edge1 in [0.70, 0.95] — wide, slow-drifting peaks.
    float bg_height_noise = vnoise(vec2(flame_uv.x * 2.5, t * 0.5)) * 0.25;
    float bg_height_mask  = 1.0 - smoothstep(0.3, 0.70 + bg_height_noise, flame_uv.y);
    bg_height_mask = clamp(bg_height_mask, 0.0, 1.0);

    float bg_shaped = clamp(bg_intensity * bg_height_mask * 2.5 - 0.05, 0.0, 1.0);

    float bg_ember     = smoothstep(0.3, 0.0, flame_uv.y);
    float bg_palette_t = max(bg_shaped, 0.6 + bg_ember * 0.4);

    vec3 bg_color = palette(pow(clamp(bg_palette_t, 0.0, 1.0), 0.65)) * 0.50;
    bg_color *= smoothstep(0.0, 0.04, bg_shaped);

    // -----------------------------------------------------------------------
    // MID-GROUND layer — medium shapes and speed, between back and front.
    //
    //   - Spatial frequency 1.75x/1.35y: medium flame shapes.
    //   - Upward scroll t * 1.25: medium speed.
    //   - Domain warp seeds (6.3/0.9) and (1.7/5.5): distinct from both the
    //     background and foreground — no correlated swaying between layers.
    //   - fbm3 (3 octaves): same GPU budget tier as background.
    //   - Noise-in-edge1: freq=3.5 (medium peak width), amp=0.20 (20%
    //     variation), edge1 base=0.65 — peaks reach up to y=0.85.
    //   - 75% brightness: sits between background (50%) and foreground (100%).
    // -----------------------------------------------------------------------
    vec3 p_mid = vec3(flame_uv.x * 1.75, flame_uv.y * 1.35 - t * 1.25, t * 0.4);

    vec3 q_mid = vec3(
        fbm3(p_mid + vec3(6.3, 0.9, t * 0.25)),
        fbm3(p_mid + vec3(1.7, 5.5, t * 0.25)),
        t
    );

    float mid_intensity = fbm3(p_mid + q_mid * 0.5);

    // Noise-in-edge1: medium frequency peaks, moderate amplitude.
    // Range [0.0, 0.20] → edge1 in [0.65, 0.85].
    float mid_height_noise = vnoise(vec2(flame_uv.x * 3.5, t * 0.8)) * 0.20;
    float mid_height_mask  = 1.0 - smoothstep(0.3, 0.65 + mid_height_noise, flame_uv.y);
    mid_height_mask = clamp(mid_height_mask, 0.0, 1.0);

    float mid_shaped = clamp(mid_intensity * mid_height_mask * 2.5 - 0.05, 0.0, 1.0);

    float mid_ember     = smoothstep(0.3, 0.0, flame_uv.y);
    float mid_palette_t = max(mid_shaped, 0.6 + mid_ember * 0.4);

    vec3 mid_color = palette(pow(clamp(mid_palette_t, 0.0, 1.0), 0.65)) * 0.75;
    mid_color *= smoothstep(0.0, 0.04, mid_shaped);

    // -----------------------------------------------------------------------
    // FOREGROUND layer — finest detail, fastest, full brightness.
    //
    //   - Spatial frequency 2.0x/1.5y: fine flame shapes closest to viewer.
    //   - Upward scroll t * 1.5: fastest movement — lively foreground.
    //   - Domain warp seeds (0.0/0.0) and (5.2/1.3): same as the original
    //     foreground — preserves its established fine-detail character.
    //   - fbm (4 octaves): maximum detail on the frontmost layer.
    //   - Noise-in-edge1: freq=5.0 (narrow peaks — fine flame tips), amp=0.15
    //     (15% variation), edge1 base=0.60 — peaks reach up to y=0.75.
    //     This replaces the old additive-noise-on-mask approach which produced
    //     only ≤3% variation and a visually flat horizontal cutoff.
    //   - 100% brightness: full intensity, front layer dominates compositing.
    // -----------------------------------------------------------------------
    vec3 p_fg = vec3(flame_uv.x * 2.0, flame_uv.y * 1.5 - t * 1.5, t * 0.5);

    vec3 q_fg = vec3(
        fbm(p_fg + vec3(0.0, 0.0, t * 0.3)),
        fbm(p_fg + vec3(5.2, 1.3, t * 0.3)),
        t
    );

    float fg_intensity = fbm(p_fg + q_fg * 0.5);

    // Noise-in-edge1: high spatial frequency for narrow, lively tips.
    // Range [0.0, 0.15] → edge1 in [0.60, 0.75].
    float fg_height_noise = vnoise(vec2(flame_uv.x * 5.0, t * 1.2)) * 0.15;
    float fg_height_mask  = 1.0 - smoothstep(0.3, 0.60 + fg_height_noise, flame_uv.y);
    fg_height_mask = clamp(fg_height_mask, 0.0, 1.0);

    float fg_shaped = clamp(fg_intensity * fg_height_mask * 2.5 - 0.05, 0.0, 1.0);

    float fg_ember     = smoothstep(0.3, 0.0, flame_uv.y);
    float fg_palette_t = max(fg_shaped, 0.6 + fg_ember * 0.4);

    vec3 fg_color = palette(pow(clamp(fg_palette_t, 0.0, 1.0), 0.65));
    fg_color *= smoothstep(0.0, 0.04, fg_shaped);

    // -----------------------------------------------------------------------
    // Composite: two-step screen blend, back to front.
    //
    // Screen blend: out = a + b - a * b
    // Each step combines the running composite with the next layer forward.
    // Deeper layers show through wherever the foreground is dark (flame tips,
    // screen edges), giving depth perception without ray-sorting.
    // -----------------------------------------------------------------------
    vec3 composite = bg_color + mid_color - bg_color * mid_color;
    composite = composite + fg_color - composite * fg_color;

    // Subtle side vignette to focus the eye toward the screen centre.
    float vignette = 1.0 - smoothstep(0.3, 0.9, abs(uv.x / (aspect * 0.5)));
    vec3 final_color = composite * mix(0.7, 1.0, vignette);

    fragColor = vec4(clamp(final_color, 0.0, 1.0), 1.0);
}
