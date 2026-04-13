#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — flames.frag
//
// Two-layer fire: background (larger, slower shapes) + foreground (finer,
// faster shapes). Both layers use fBm + IQ domain warping (two-pass q then
// p + q * 0.5). The background uses 3 octaves and a noise-perturbed height
// mask to keep GPU budget in check while producing irregular, ragged flame
// tips instead of a flat top edge.
//
// Foreground layer: unchanged from initial implementation.
//   - 4-octave fBm, freq 2.0x, scroll t * 1.5, seeds (0/0, 5.2/1.3)
// Background layer: same technique, different parameters for depth.
//   - 3-octave fBm (fbm3), freq 1.5x, scroll t * 1.0, seeds (3.1/7.4,
//     8.7/2.8) — independent motion, larger shapes, slower movement.
//   - Height mask uses vnoise perturbation so the cutoff is ragged and
//     irregular rather than a smooth horizontal edge.
//   - 60 % brightness to push the layer visually behind the foreground.
// Compositing: screen blend (fg + bg - fg * bg) so both layers contribute
// to bright zones without clipping, and background shows through wherever
// the foreground is transparent.
//
// Key implementation invariants:
//   - No horizontal drift: p.z (time) wires into fBm through y-component only.
//   - Ember floor on both layers: hot glowing coals at the base regardless
//     of palette mapping at low-t values.
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
// 3-octave turbulence fBm — background flame layer.
//
// One fewer octave than the foreground to stay within GPU budget.
// Background sits behind the foreground so the detail loss is not visible.
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
    // BACKGROUND layer — larger, slower flames behind the foreground.
    //
    // Same IQ domain-warping technique as foreground, with these differences:
    //   - Spatial frequency 1.5x (vs 2.0x): larger flame shapes → reads as
    //     deeper/further from the viewer.
    //   - Upward scroll t * 1.0 (vs t * 1.5): slower, background feels heavy.
    //   - Domain warp seeds (3.1/7.4) and (8.7/2.8): fully independent motion
    //     from foreground seeds (0.0/0.0) and (5.2/1.3).
    //   - fbm3 (3 octaves) instead of fbm (4 octaves): GPU savings; detail
    //     loss is hidden behind the foreground layer.
    //   - Height mask perturbed with vnoise: irregular ragged top edge.
    //   - 60 % brightness: recedes visually behind the foreground.
    // -----------------------------------------------------------------------
    vec3 p_bg = vec3(flame_uv.x * 1.5, flame_uv.y * 1.2 - t * 1.0, t * 0.3);

    // First warp pass — two independent fbm3 samples offset in space and time.
    vec3 q_bg = vec3(
        fbm3(p_bg + vec3(3.1, 7.4, t * 0.2)),
        fbm3(p_bg + vec3(8.7, 2.8, t * 0.2)),
        t
    );

    // Final background intensity: sample at the domain-warped position.
    float bg_intensity = fbm3(p_bg + q_bg * 0.5);

    // Inject per-column noise into the height cutoff to break up the flat
    // top edge. vnoise at low spatial frequency gives smooth column variation.
    // Range: [0.0, 0.25], so edge1 in [0.70, 0.95] — always > edge0 (0.30).
    float height_noise   = vnoise(vec2(flame_uv.x * 3.0, t * 0.5)) * 0.25;
    float bg_height_mask = 1.0 - smoothstep(0.3, 0.7 + height_noise, flame_uv.y);
    bg_height_mask = clamp(bg_height_mask, 0.0, 1.0);

    float bg_shaped = clamp(bg_intensity * bg_height_mask * 2.5 - 0.05, 0.0, 1.0);

    // Ember glow floor — same logic as foreground, keeps the base hot.
    float bg_ember     = smoothstep(0.3, 0.0, flame_uv.y);
    float bg_palette_t = bg_shaped;
    bg_palette_t = max(bg_palette_t, 0.6 + bg_ember * 0.4);

    // 60 % brightness scale pushes this layer visually behind the foreground.
    vec3 bg_color = palette(pow(clamp(bg_palette_t, 0.0, 1.0), 0.65)) * 0.6;
    bg_color *= smoothstep(0.0, 0.04, bg_shaped);

    // -----------------------------------------------------------------------
    // FOREGROUND layer — original domain-warped fBm fire, unchanged.
    //
    //   - p encodes position with upward scroll built in (y - t * 1.5).
    //   - q is two independent fbm samples for first warp pass.
    //   - intensity = fbm(p + q * 0.5): second warp pass (IQ technique).
    //   - height_mask: smooth falloff above y = 0.3, hard ceiling at y = 0.7,
    //     with a small vnoise perturbation for irregular tips.
    //   - ember floor: forces palette_t ≥ 0.6 at the base.
    // -----------------------------------------------------------------------
    vec3 p = vec3(flame_uv.x * 2.0, flame_uv.y * 1.5 - t * 1.5, t * 0.5);

    vec3 q = vec3(
        fbm(p + vec3(0.0, 0.0, t * 0.3)),
        fbm(p + vec3(5.2, 1.3, t * 0.3)),
        t
    );

    float intensity = fbm(p + q * 0.5);

    float height_mask = 1.0 - smoothstep(0.3, 0.7, flame_uv.y);
    height_mask += vnoise(vec2(flame_uv.x * 8.0, t * 2.5)) * 0.1
                   * (1.0 - flame_uv.y);
    height_mask = clamp(height_mask, 0.0, 1.0);

    float shaped = clamp(intensity * height_mask * 2.5 - 0.05, 0.0, 1.0);

    float ember    = smoothstep(0.3, 0.0, flame_uv.y);
    float palette_t = shaped;
    palette_t = max(palette_t, 0.6 + ember * 0.4);

    vec3 color = palette(pow(clamp(palette_t, 0.0, 1.0), 0.65));
    color *= smoothstep(0.0, 0.04, shaped);

    // -----------------------------------------------------------------------
    // Composite: screen blend background under foreground.
    //
    // Screen blend: out = bg + fg - bg * fg.
    // Both layers brighten overlapping zones without hard clipping.
    // Background shows through wherever foreground is dark (flame tips,
    // screen sides) giving a perception of depth without ray-sorting.
    // -----------------------------------------------------------------------
    vec3 final_color = bg_color + color - bg_color * color;

    // Subtle side vignette to focus the eye toward the screen centre.
    float vignette = 1.0 - smoothstep(0.3, 0.9, abs(uv.x / (aspect * 0.5)));
    final_color *= mix(0.7, 1.0, vignette);

    fragColor = vec4(clamp(final_color, 0.0, 1.0), 1.0);
}
