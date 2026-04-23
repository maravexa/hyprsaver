#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — waterfall.frag
//
// Stylized 2D waterfall with retro quantize-and-dither post.
// Solid black rock background fills the screen; central waterfall column
// composites on top with soft noise-fringed edges. Water texture is a
// plasma-inspired sum of four incommensurable-frequency sine layers biased
// toward vertical flow, mapped through a [0.50, 0.85] palette slice. Mist
// billows at the base from 2-octave fbm with upward drift, wider than the
// water column so it spills onto the rocks. PS1-style Bayer dither +
// color quantize post. Lightweight GPU tier (<30% util).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_speed_scale;
uniform float u_zoom_scale;

// ---------------------------------------------------------------------------
// Hash + 1D value noise (used by rock edge wiggle)
// ---------------------------------------------------------------------------
float hash1(float n) {
    return fract(sin(n) * 43758.5453123);
}
float vnoise1(float x) {
    float i = floor(x);
    float f = fract(x);
    float u = f * f * (3.0 - 2.0 * f);
    return mix(hash1(i), hash1(i + 1.0), u);
}

// ---------------------------------------------------------------------------
// 2D value noise (used by mist fbm)
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
// 2-octave fbm for mist — cheap, soft
// ---------------------------------------------------------------------------
float fbm_mist(vec2 p) {
    return 0.67 * vnoise2(p) + 0.33 * vnoise2(p * 2.0);
}

// ---------------------------------------------------------------------------
// Plasma wave helper — sin remapped to [0, 1]
// ---------------------------------------------------------------------------
float wave(float x) {
    return sin(x) * 0.5 + 0.5;
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    // uv.y = 0.0 at bottom, 1.0 at top
    float t = u_time * u_speed_scale;

    // Layer 1: solid black rock. Shape is implicit (absence of water).
    vec3 col = vec3(0.0);

    // Layer 2: waterfall column, nominally uv.x in [0.30, 0.70].
    float edge_wiggle_l = 0.03 * (vnoise1(uv.y * 8.0)        * 2.0 - 1.0);
    float edge_wiggle_r = 0.03 * (vnoise1(uv.y * 8.0 + 37.0) * 2.0 - 1.0);
    float left_edge  = 0.30 + edge_wiggle_l;
    float right_edge = 0.70 + edge_wiggle_r;
    float feather    = 0.02;

    float water_alpha =
          smoothstep(left_edge  - feather, left_edge  + feather, uv.x)
        * (1.0 - smoothstep(right_edge - feather, right_edge + feather, uv.x));

    // Plasma-inspired water texture — four layers of axis-aligned sines
    // with incommensurable frequencies. Vertical layers dominate; time
    // terms on vertical layers are `+t` so bands advance downward on
    // screen (uv.y=0 at bottom convention).
    //
    // v1: broad vertical bands, moderate speed
    float v1 = wave(uv.y *  7.3                + t * 2.1);
    // v2: finer vertical bands, faster — incommensurable with v1
    float v2 = wave(uv.y * 13.7                + t * 2.9);
    // v3: diagonal streaks — adds angled cross-structure to the flow
    float v3 = wave(uv.x *  5.1 + uv.y * 11.4  + t * 2.4);
    // v4: slow horizontal ripple — prevents pure-stripe appearance.
    //     Small t coefficient: horizontal flow in a vertical waterfall
    //     must be subtle, or it looks like rain sheeting sideways.
    float v4 = wave(uv.x *  4.6                - t * 0.7);

    float plasma = (v1 + v2 + v3 + v4) * 0.25;

    // Harmonic detail — one extra sine at 2× wrap, cheap fine breakup.
    float detail = wave(plasma * 6.2832 * 2.0 + t * 0.5) * 0.15;
    plasma = clamp(plasma + detail, 0.0, 1.0);

    // Gradient through [0.50, 0.85] palette slice (no palette rotation —
    // water should keep one mood of color, not chromatic-cycle).
    vec3 water_col = palette(mix(0.50, 0.85, plasma));

    // Brightness modulation — subtle shimmer on wave crests.
    // Range [0.64, 1.00]; plasma's original ±0.3 was too dramatic for water.
    float brightness = 0.82 + 0.18 * sin(plasma * 6.28318 * 3.0 + t * 0.5);
    water_col *= brightness;

    col = mix(col, water_col, water_alpha);

    // Layer 3: mist at the base (bottom 30%). Uniform early-out across
    // most RDNA wavefronts — saves fbm_mist on ~70% of pixels.
    if (uv.y < 0.30) {
        float x_dist = abs(uv.x - 0.5);

        // Horizontal envelope: extends past the water edges, spills onto rock
        float mist_half_width = 0.35 - uv.y * 0.3;
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
