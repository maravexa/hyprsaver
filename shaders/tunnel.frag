#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — tunnel.frag
//
// Infinite tunnel flythrough. The camera moves forward along the Z axis while
// slowly rotating. The tunnel walls are textured with a procedural pattern
// built from polar coordinates (angle + distance rings), giving the illusion
// of infinite forward motion through a psychedelic tube.
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

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;

void main() {
    // Centered at screen midpoint, uniform scaling, aspect-ratio correct.
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    float t = u_time;

    // ---------------------------------------------------------------------------
    // Tunnel projection
    // Convert screen-space ray to polar tunnel coordinates.
    // Origin at screen center — vanishing point is always centered.
    // ---------------------------------------------------------------------------
    float dist  = length(uv) + 0.001;  // epsilon prevents div-by-zero at center
    float angle = atan(uv.y, uv.x);

    // Tunnel UV:
    //   s = angular position around the tunnel, wrapped [0, 1]
    //   r = forward position — increases as you approach the centre (dist → 0)
    float s = angle / TAU + 0.5;                  // [0, 1] angular
    float r = 0.35 / dist;                            // forward depth

    // Forward motion: add time to r to fly forward.
    float depth = r + t * 0.5;

    // Slow rotation of the camera.
    float twist = t * 0.12;
    float s_twisted = fract(s + twist / TAU);

    // ---------------------------------------------------------------------------
    // Tunnel wall pattern
    // Rings (from r) crossed with angular bands (from s) produce a grid-like
    // texture. Multiple harmonics add visual complexity.
    // ---------------------------------------------------------------------------

    // Primary ring pattern.
    float rings = sin(depth * TAU * 1.0) * 0.5 + 0.5;

    // Angular stripes — 8 bands around the tunnel.
    float stripes = sin(s_twisted * TAU * 8.0) * 0.5 + 0.5;

    // Secondary diagonal weave.
    float weave = sin((depth + s_twisted * 4.0) * TAU * 0.5 + t * 0.7) * 0.5 + 0.5;

    // Combine into a single value.
    float pattern = rings * 0.5 + stripes * 0.3 + weave * 0.2;

    // ---------------------------------------------------------------------------
    // Colour
    // ---------------------------------------------------------------------------
    float col_t = fract(pattern + depth * 0.05 + t * 0.04);
    vec3  col   = palette(col_t);

    // Distance fog: bright at the vanishing point, dark at the edges.
    float fog = 1.0 - smoothstep(0.0, 1.6, dist / 0.35);
    col = mix(vec3(0.0), col, fog);

    // Tunnel edge vignette.
    col *= smoothstep(0.5, 0.3, dist);

    // Subtle centre glow.
    float glow = exp(-dist * 8.0) * 0.6;
    col += palette(fract(t * 0.08)) * glow;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
