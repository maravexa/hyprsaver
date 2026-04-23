#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — waterfall.frag
//
// Stylized 2D waterfall with retro quantize-and-dither post.
// Rock is implicit — the base color is vec3(0.0) and water is added on top
// as a density field (not a mask). A horizontal smoothstep envelope tapers
// water density to zero at the column edges, so black rock shows through
// with no border line to wiggle or feather. Water texture is 2-octave fbm
// with deliberate x-heavy frequency bias (7.2:1) for pronounced vertical
// streaks, mapped through a [0.50, 0.85] palette slice. Streak crests get
// an additive highlight from the same fbm, thresholded. Mist billows at the
// base from 2-octave fbm with upward drift, wider than the water column so
// it spills onto the rocks. PS1-style Bayer dither + color quantize post.
// Lightweight GPU tier (<30% util).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_speed_scale;
uniform float u_zoom_scale;

// ---------------------------------------------------------------------------
// 2D value noise (used by both water and mist fbm)
// ---------------------------------------------------------------------------
float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float vnoise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash2(i + vec2(0.0, 0.0)), hash2(i + vec2(1.0, 0.0)), u.x),
        mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x),
        u.y
    );
}

// ---------------------------------------------------------------------------
// 3-octave fbm for water — x-heavy sampling elsewhere gives vertical streaks
// ---------------------------------------------------------------------------
float fbm_water(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
        v += a * vnoise2(p);
        p *= 2.0;
        a *= 0.5;
    }
    return v;
}

// ---------------------------------------------------------------------------
// 2-octave fbm for the hue field — slow, large-scale color variation
// ---------------------------------------------------------------------------
float fbm_hue(vec2 p) {
    return 0.67 * vnoise2(p) + 0.33 * vnoise2(p * 2.0);
}

// ---------------------------------------------------------------------------
// 2-octave fbm for mist — cheap, soft (same shape as fbm_water; kept
// separate for readability)
// ---------------------------------------------------------------------------
float fbm_mist(vec2 p) {
    return 0.67 * vnoise2(p) + 0.33 * vnoise2(p * 2.0);
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    // uv.y = 0.0 at bottom, 1.0 at top
    float t = u_time * u_speed_scale;

    // Water density envelope: solid core in x ∈ [0.25, 0.75] (50% of screen),
    // smooth falloff to zero at x ∈ [0.10, 0.90]. No alpha mask — where
    // density is zero, black rock shows through by default.
    float water_density = 1.0 - smoothstep(0.25, 0.40, abs(uv.x - 0.5));

    // Hue field — low frequency, slow downward drift. Decouples color from
    // streak structure so multi-color bands show across the falls regardless
    // of where the streaks are.
    //   x-freq 2.5  → ~3 color bands visible across the column width
    //   y-freq 2.0  → ~2 bands visible vertically at once
    //   t * 0.25    → slow downward drift; ~2.4x slower than streaks for parallax
    vec2 hue_uv = vec2(uv.x * 2.5, uv.y * 2.0 + t * 0.25);
    float hue = fbm_hue(hue_uv);

    // Stretch noise-clustered output toward palette edges.
    // fbm output lives roughly in [0.15, 0.85]; this remaps to [0, 1] with
    // clamping, so ~30% of pixels hit pure palette endpoints.
    float palette_t = clamp(hue * 1.5 - 0.25, 0.0, 1.0);

    // Streak texture — high frequency, fast downward flow. Drives brightness.
    vec2 water_uv = vec2(uv.x * 18.0, uv.y * 2.5 + t * 0.6);
    float w = fbm_water(water_uv);

    // Base water color: hue from palette, brightness modulated by streaks.
    // mix(0.5, 1.0, w) keeps dimmest streaks at 50% brightness so deep water
    // stays visible (not black) while bright streaks reach full intensity.
    vec3 water_col = palette(palette_t) * mix(0.5, 1.0, w);

    // Additive composition: rock is implicit (vec3(0.0)); water and
    // highlight are scaled by water_density so they fade to zero at the
    // column edges with no visible border.
    vec3 col = vec3(0.0);
    col += water_col * water_density;

    // Highlights: brighten the base hue rather than adding palette(0.95).
    // This keeps highlights chromatically consistent with the water they're
    // highlighting — no foreign-color splash when hue is far from 0.95.
    col += water_col * smoothstep(0.65, 0.85, w) * water_density * 0.8;

    // Mist at the base (bottom 30%). Uniform early-out across most RDNA
    // wavefronts — saves fbm_mist on ~70% of pixels.
    if (uv.y < 0.30) {
        float x_dist = abs(uv.x - 0.5);

        // Horizontal envelope: extends past the wider water column onto rock
        float mist_half_width = 0.45 - uv.y * 0.4;
        float horizontal = 1.0 - smoothstep(0.0, mist_half_width, x_dist);

        // Vertical envelope: strong at base, decays upward
        float vertical = exp(-uv.y * 6.0);

        // Mist drifts UP: -t in y sample direction
        vec2 mist_uv = vec2(uv.x * 3.0, uv.y * 4.0 - t * 0.25);
        float mist_noise = fbm_mist(mist_uv);

        float mist_density = horizontal * vertical * mist_noise;
        col += palette(0.95) * mist_density * 0.6;
    }

    col = clamp(col, 0.0, 1.0);

    // PS1-style quantize + 4×4 Bayer dither — copied verbatim from wormhole.frag
    const mat4 bayer4 = mat4(
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0
    ) / 16.0 - 0.5;
    ivec2 px     = ivec2(gl_FragCoord.xy) & 3;
    float dither = bayer4[px.x][px.y] / 32.0;
    col = floor(col * 32.0 + dither + 0.5) / 32.0;
    fragColor = vec4(col, 1.0);
}
