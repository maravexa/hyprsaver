#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — fractaltrap.frag
//
// Classic Julia iteration (z² + c) with orbit-trap coloring. Instead of
// counting iterations to escape, we track the minimum distance from the
// orbit to a unit circle (the trap). The color comes entirely from that
// minimum distance — both escaping and non-escaping (interior) pixels use
// the trap signal, so there is no solid-color interior region.
//
// This produces a stained-glass / cellular aesthetic that is visually
// distinct from every other shader in the roster despite using the same
// underlying iteration as julia.frag.
//
// c orbits at the classic r=0.7885 radius, which sits on the boundary of
// the Mandelbrot main cardioid for all angles — every moment of the
// animation produces a connected, structured Julia set.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

const float TRAP_RADIUS = 1.0;

void main() {
    // Centered, aspect-ratio-correct coordinates.
    vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec2 z = p * 1.8;

    // c traces the r=0.7885 circle — every angle produces a structured Julia.
    // Full cycle ≈ 157 s at default speed.
    float angle = u_time * u_speed_scale * 0.04;
    vec2 c = vec2(0.7885 * cos(angle), 0.7885 * sin(angle));

    const int MAX_ITER = 100;
    // Start far from the trap so the first real measurement wins.
    float min_trap_dist = 1.0e10;

    for (int i = 0; i < MAX_ITER; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;

        // Distance from current orbit position to the trap circle.
        float d = abs(length(z) - TRAP_RADIUS);
        min_trap_dist = min(min_trap_dist, d);

        if (dot(z, z) > 4.0) {
            break;
        }
    }

    // Sqrt remap compresses the distribution toward the bright palette end.
    // Both escaped and interior pixels use the trap distance — this is the
    // defining feature of orbit-trap coloring.
    float t = sqrt(clamp(min_trap_dist, 0.0, 1.0));
    fragColor = vec4(palette(t), 1.0);
}
