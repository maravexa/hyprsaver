#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — waterfall.frag
//
// Stylized 2D waterfall with retro quantize-and-dither post.
// Solid rock background fills the screen; central downward-scrolling 3-octave
// fbm water channel composites on top with soft noise-fringed edges (rocks
// stay solid — shape defined by absence of water). Mist billows at the base
// from a 2-octave fbm with upward drift, wider than the water column so it
// spills onto the rocks. PS1-style Bayer dither + color quantize post.
// Lightweight GPU tier (<30% util).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_speed_scale;
uniform float u_zoom_scale;

// ---------------------------------------------------------------------------
// Hash + 1D value noise
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
// 2D value noise
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
// 3-octave fbm for water — frequencies 4/8/16
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
// 2-octave fbm for mist — cheaper, softer shape
// ---------------------------------------------------------------------------
float fbm_mist(vec2 p) {
    return 0.67 * vnoise2(p) + 0.33 * vnoise2(p * 2.0);
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    // uv.y = 0.0 at bottom, 1.0 at top

    // Layer 1: solid rock silhouette across the full screen.
    // Rocks are defined by absence of water (see Layer 2), so their shape
    // is implicit and does not wiggle. No more curvy rock fingers.
    vec3 col = palette(0.20);

    // Layer 2: waterfall column, nominally uv.x in [0.30, 0.70].
    // vnoise1 on uv.y gives the column a gentle sway (water is not a rigid
    // rectangle) and smoothstep feathers the water-rock contact into spray.
    // Because the mask is applied to the water alpha only, the rock layer
    // beneath stays solid.
    float edge_wiggle_l = 0.03 * (vnoise1(uv.y * 8.0)        * 2.0 - 1.0);
    float edge_wiggle_r = 0.03 * (vnoise1(uv.y * 8.0 + 37.0) * 2.0 - 1.0);
    float left_edge  = 0.30 + edge_wiggle_l;
    float right_edge = 0.70 + edge_wiggle_r;
    float feather    = 0.02;

    float water_alpha =
          smoothstep(left_edge  - feather, left_edge  + feather, uv.x)
        * (1.0 - smoothstep(right_edge - feather, right_edge + feather, uv.x));

    // Plus on time: uv.y=0 at bottom → noise pattern advances upward in
    // sample space, which renders as the pattern translating DOWN on screen.
    vec2 water_uv = vec2(uv.x * 4.0, uv.y * 8.0 + u_time * u_speed_scale * 0.4);
    float w = fbm_water(water_uv);
    vec3 water_col = palette(mix(0.60, 0.80, w));

    col = mix(col, water_col, water_alpha);

    // Layer 3: mist at the base. Gated to bottom 30% — this is a uniform
    // branch across most of each RDNA wavefront (nearby pixels share uv.y),
    // so the early-out saves the fbm_mist call for 70% of the screen.
    if (uv.y < 0.30) {
        float x_dist = abs(uv.x - 0.5);

        // Horizontal envelope: 0.35 half-width at base, 0.26 by top of zone.
        // Extends past the waterfall edges (0.30/0.70) → mist spills onto rocks.
        float mist_half_width = 0.35 - uv.y * 0.3;
        float horizontal = 1.0 - smoothstep(0.0, mist_half_width, x_dist);

        // Vertical envelope: strong at bottom, fades to ~0.17 by y=0.3.
        float vertical = exp(-uv.y * 6.0);

        // Minus on time in y → pattern rises (mirror-image of water flow math).
        vec2 mist_uv = vec2(uv.x * 3.0, uv.y * 4.0 - u_time * u_speed_scale * 0.25);
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
