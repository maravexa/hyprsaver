#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — waterfall.frag
//
// Stylized 2D waterfall with retro quantize-and-dither post.
// Three vertical bands: dark rock silhouettes (left/right) flanking a
// downward-scrolling 3-octave fbm water channel (center). Bottom mist
// overlay fades upward. PS1-style Bayer dither + color quantize post.
// Lightweight GPU tier (<30% util).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_speed_scale;
uniform float u_zoom_scale;

// ---------------------------------------------------------------------------
// Hash + 1D value noise — smooth Hermite interpolation, no trig
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
// 3-octave fbm for water — frequencies 4/8/16, amplitudes 0.5/0.25/0.125
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

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    // uv.y = 0.0 at bottom, 1.0 at top

    // Rock band edges with 1D value noise — centered (vnoise*2.0-1.0) so
    // edges shift both inward and outward around the nominal 0.25/0.75 split.
    float left_edge  = 0.25 + 0.08 * (vnoise1(uv.y * 6.0)         * 2.0 - 1.0);
    float right_edge = 0.75 + 0.08 * (vnoise1(uv.y * 6.0 + 100.0) * 2.0 - 1.0);

    bool is_rock = (uv.x < left_edge || uv.x > right_edge);

    vec3 col;

    if (is_rock) {
        // Dark rock silhouette — sharp edge against water (intentional, no AA)
        col = palette(0.20);
    } else {
        // Water: downward-scrolling fbm. Minus on time → texture moves down.
        vec2 water_uv = vec2(uv.x * 4.0, uv.y * 8.0 - u_time * u_speed_scale * 0.4);
        float w = fbm_water(water_uv);
        col = palette(mix(0.60, 0.80, w));
    }

    // Mist overlay — bottom 15% only, additive palette(0.92).
    // exp(-uv.y * 8.0): 1.0 at bottom, ≈0.30 at y=0.15, ≈0.14 at y=0.25.
    // Restrict to bottom 15% to avoid painting over the rock bands higher up.
    if (uv.y < 0.15) {
        float mist_str  = exp(-uv.y * 8.0);
        float mist_x    = uv.x + u_time * u_speed_scale * 0.15;
        float mist_var  = vnoise1(mist_x * 5.0) * 0.4 + 0.6;
        col += palette(0.92) * mist_str * mist_var * 0.5;
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
