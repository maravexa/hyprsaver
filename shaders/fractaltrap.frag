#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — fractaltrap.frag
//
// Classic Julia iteration (z² + c) with orbit-trap coloring. Instead of
// counting iterations to escape, we track the minimum distance from the
// orbit to three rotating point traps arranged at 120° phase offsets.
// The color comes entirely from that minimum distance — both escaping and
// non-escaping (interior) pixels use the trap signal, so there is no
// solid-color interior region.
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

void main() {
    // Centered, aspect-ratio-correct coordinates.
    vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec2 z = p * 1.8;

    // c traces the r=0.7885 circle — every angle produces a structured Julia.
    // Full cycle ≈ 157 s at default speed.
    float angle = u_time * u_speed_scale * 0.04;
    vec2 c = vec2(0.7885 * cos(angle), 0.7885 * sin(angle));

    // Three trap points at 120° phase offsets, rotating with time.
    const float TRAP_ORBIT_RADIUS = 0.6;
    float trap_angle = u_time * 0.03;
    vec2 trap_p1 = TRAP_ORBIT_RADIUS * vec2(cos(trap_angle),          sin(trap_angle));
    vec2 trap_p2 = TRAP_ORBIT_RADIUS * vec2(cos(trap_angle + 2.0944), sin(trap_angle + 2.0944));
    vec2 trap_p3 = TRAP_ORBIT_RADIUS * vec2(cos(trap_angle + 4.1888), sin(trap_angle + 4.1888));

    const int MAX_ITER = 80;
    // Accumulate squared distances; take sqrt once after the loop (v0.4.3 pattern).
    float min_trap_dist_sq = 1.0e10;

    for (int i = 0; i < MAX_ITER; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;

        // Minimum squared distance to any of the three trap points.
        vec2 d1 = z - trap_p1;
        vec2 d2 = z - trap_p2;
        vec2 d3 = z - trap_p3;
        float dsq = min(min(dot(d1,d1), dot(d2,d2)), dot(d3,d3));
        min_trap_dist_sq = min(min_trap_dist_sq, dsq);

        if (dot(z, z) > 4.0) {
            break;
        }
    }

    // Deferred sqrt; invert so close-to-trap orbits are bright, far are dark.
    float min_trap_dist = sqrt(min_trap_dist_sq);
    float t = 1.0 - sqrt(clamp(min_trap_dist, 0.0, 1.0));
    fragColor = vec4(palette(t), 1.0);
}
