#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — flow_field.frag
//
// Curl-noise flow field. A divergence-free velocity field is derived from
// 2-D simplex noise by rotating its numerical gradient 90°. Each fragment
// traces a virtual particle for 8 steps along the field, accumulating a
// glow contribution at each step. Color shifts across the palette with
// t = step / 8, animating from one hue family to another as the eye follows
// a stream. The noise phase advances at 0.03 speed so streams drift slowly.
// Background is near-black so glow lines read clearly.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

uniform vec3  u_palette_a;
uniform vec3  u_palette_b;
uniform vec3  u_palette_c;
uniform vec3  u_palette_d;

out vec4 fragColor;

vec3 palette(float t) {
    return u_palette_a + u_palette_b * cos(6.28318530718 * (u_palette_c * t + u_palette_d));
}

// ---------------------------------------------------------------------------
// Compact 2-D simplex noise (Stefan Gustavson / Ian McEwan algorithm)
// ~40 LOC, returns value in [-1, 1]
// ---------------------------------------------------------------------------
vec2  mod289v2(vec2  x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3  mod289v3(vec3  x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3  permute (vec3  x) { return mod289v3(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
    const vec4 C = vec4( 0.211324865405187,   //  (3 - sqrt(3)) / 6
                         0.366025403784439,   //  (sqrt(3) - 1) / 2
                        -0.577350269189626,   // -1 + 2*(3-sqrt(3))/6
                         0.024390243902439);  //  1/41

    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);

    vec2 i1  = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy  -= i1;

    i = mod289v2(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                             + i.x + vec3(0.0, i1.x, 1.0));

    vec3 m = max(0.5 - vec3(dot(x0, x0),
                             dot(x12.xy, x12.xy),
                             dot(x12.zw, x12.zw)), 0.0);
    m = m * m * m * m;

    vec3 x  = 2.0 * fract(p * C.www) - 1.0;
    vec3 h  = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;

    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);

    vec3 g;
    g.x  = a0.x  * x0.x   + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
}

// ---------------------------------------------------------------------------
// Curl noise: numerical gradient of snoise rotated 90° → divergence-free
// ---------------------------------------------------------------------------
vec2 curlNoise(vec2 p) {
    const float eps = 0.0015;
    float dX = (snoise(p + vec2(0.0,  eps)) - snoise(p - vec2(0.0,  eps))) / (2.0 * eps);
    float dY = (snoise(p + vec2(eps,  0.0)) - snoise(p - vec2(eps,  0.0))) / (2.0 * eps);
    return vec2(dX, -dY);   // 90° rotation of the gradient
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // Seed the virtual particle at the fragment position.
    vec2 pos = uv;

    // Near-black background so glow lines read clearly.
    vec3 col = vec3(0.03);

    const int   STEPS = 8;
    const float DT    = 0.10;

    for (int i = 0; i < STEPS; i++) {
        float t = float(i) / float(STEPS);

        // Noise coordinate: scale, then animate phase at 0.03 speed.
        vec2 np  = pos * 1.5 + vec2(u_time * 0.03, 0.0);
        vec2 vel = curlNoise(np);

        // Glow contribution: bright near zero-crossings of a secondary noise
        // layer, which align with the streamlines of the curl field.
        float n    = snoise(np * 2.0);
        float glow = exp(-n * n * 8.0) * 0.30;

        col += palette(t) * glow;

        // Advance particle along the curl field.
        pos += vel * DT;
    }

    fragColor = vec4(col, 1.0);
}
