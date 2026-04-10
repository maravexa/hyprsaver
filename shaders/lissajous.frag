#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — lissajous.frag
//
// Three overlapping Lissajous curves with frequency ratios 3:2, 5:4, 7:4.
// For each fragment the minimum distance to each parametric curve is found
// by sampling 192 points along t ∈ [0, 2π]. A smoothstep edge function
// gives clean anti-aliased hard edges without expensive exp() glow, keeping
// GPU load in the Medium tier. Curves are colored independently through the
// palette, drifting slowly in hue over time. Phase shifts at different rates
// cause the curves to drift and occasionally snap into star patterns.
// Background is black; curve contributions are added.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Lissajous parametric point
// ---------------------------------------------------------------------------
vec2 lissajousPoint(float t, float fx, float fy, float phase) {
    return vec2(sin(fx * t + phase), sin(fy * t));
}

// ---------------------------------------------------------------------------
// Minimum distance from p to one Lissajous curve sampled at N = 192 points
// ---------------------------------------------------------------------------
float distToLissajous(vec2 p, float fx, float fy, float phase) {
    const int   N      = 192;
    const float TWO_PI = 6.28318530718;
    float minDist = 1.0e6;
    for (int i = 0; i < N; i++) {
        float t = float(i) / float(N) * TWO_PI;
        vec2  q = lissajousPoint(t, fx, fy, phase);
        minDist = min(minDist, length(p - q));
    }
    return minDist;
}

// ---------------------------------------------------------------------------

void main() {
    // Normalize to [-1.5, 1.5] coordinate space.
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y * 1.5;

    // Each curve's phase drifts at a distinct rate so they interact over time.
    float phase0 = u_time * u_speed_scale * 0.17;
    float phase1 = u_time * u_speed_scale * 0.11;
    float phase2 = u_time * u_speed_scale * 0.07;

    // Slowly cycling hue base for all three curves.
    float hueBase = u_time * u_speed_scale * 0.05;

    vec3 col = vec3(0.0);   // black background

    // Hard-edge line width in normalised coords (≈2 px at 1080p).
    const float LINE_WIDTH = 0.006;

    // Curve 0 — frequency ratio 3:2
    float d0 = distToLissajous(uv, 3.0, 2.0, phase0);
    col += palette(0.0 / 3.0 + hueBase) * (1.0 - smoothstep(0.0, LINE_WIDTH, d0));

    // Curve 1 — frequency ratio 5:4
    float d1 = distToLissajous(uv, 5.0, 4.0, phase1);
    col += palette(1.0 / 3.0 + hueBase) * (1.0 - smoothstep(0.0, LINE_WIDTH, d1));

    // Curve 2 — frequency ratio 7:4
    float d2 = distToLissajous(uv, 7.0, 4.0, phase2);
    col += palette(2.0 / 3.0 + hueBase) * (1.0 - smoothstep(0.0, LINE_WIDTH, d2));

    fragColor = vec4(col, 1.0);
}
