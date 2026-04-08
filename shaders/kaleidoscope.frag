#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — kaleidoscope.frag
//
// N-fold (N = 6) kaleidoscope driven by domain-warped FBM value noise.
// The polar angle is folded into one sector and mirrored, producing
// repeating crystalline symmetry. Rotation and warp magnitude oscillate
// slowly (≈ 30 s period). Palette lookup uses both the noise value and
// the radial distance so color varies angularly AND radially.
// ---------------------------------------------------------------------------

#define SECTORS 6.0

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Value noise on a 2-D integer lattice
// ---------------------------------------------------------------------------
float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);   // smooth-step blend

    float a = fract(sin(dot(i,              vec2(127.1, 311.7))) * 43758.5453);
    float b = fract(sin(dot(i + vec2(1, 0), vec2(127.1, 311.7))) * 43758.5453);
    float c = fract(sin(dot(i + vec2(0, 1), vec2(127.1, 311.7))) * 43758.5453);
    float d = fract(sin(dot(i + vec2(1, 1), vec2(127.1, 311.7))) * 43758.5453);

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// ---------------------------------------------------------------------------
// Domain-warped FBM (3 octaves, 2 warp passes)
// ---------------------------------------------------------------------------
float fbm(vec2 p) {
    // First warp pass
    vec2 q = vec2(vnoise(p),
                  vnoise(p + vec2(5.2, 1.3)));
    // Second warp pass
    vec2 r = vec2(vnoise(p + 4.0 * q + vec2(1.7, 9.2)),
                  vnoise(p + 4.0 * q + vec2(8.3, 2.8)));

    // 3-octave FBM on twice-warped coordinates
    float val  = 0.0;
    float amp  = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 3; i++) {
        val  += amp * vnoise(p + 4.0 * r * freq);
        amp  *= 0.5;
        freq *= 2.0;
    }
    return val;
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    float r     = length(uv);
    float theta = atan(uv.y, uv.x);

    // Slow global rotation (period ≈ 30 s)
    theta += u_time * u_speed_scale * (6.28318530718 / 30.0);

    // Fold theta into [0, sector) and mirror for true kaleidoscope symmetry.
    float sector = 6.28318530718 / SECTORS;
    theta = mod(theta, sector);
    if (theta > sector * 0.5) theta = sector - theta;

    // Reconstruct folded Cartesian coordinates for noise sampling.
    vec2 kp = vec2(cos(theta), sin(theta)) * r;

    // Warp magnitude oscillates on the same ≈ 30 s period.
    float warpMag  = 0.4 + 0.2 * sin(u_time * u_speed_scale * (6.28318530718 / 30.0) + 1.5);
    vec2  noiseC   = kp * 2.0 + vec2(u_time * u_speed_scale * 0.05, 0.0);
    vec2  warpVec  = vec2(fbm(noiseC), fbm(noiseC + vec2(3.7, 1.9)));
    float n        = fbm(noiseC + warpMag * warpVec);

    // Palette lookup: noise output + radial offset for dual variation.
    float t   = fract(n + r * 0.5);
    vec3  col = palette(t);

    // Radial vignette — fade edges to black.
    col *= 1.0 - smoothstep(0.6, 1.2, r);

    fragColor = vec4(col, 1.0);
}
