#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — starfield.frag
//
// Hyperspace zoom tunnel. 120 stars radiate outward from a central vanishing
// point. Each star zooms from its seed position toward the screen edge,
// leaving a motion-blur tracer behind it. Close stars have large cores and
// long bright tracers; distant stars are tiny pinpricks.
// Fully stateless GLSL — no per-frame CPU work.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

const float ZOOM = 0.4;   // zoom-cycle frequency (cycles / second)
const int   N    = 120;   // total star count

// ---------------------------------------------------------------------------
// Hash — float → float in [0, 1)
// ---------------------------------------------------------------------------

float h11(float p) {
    p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p);
}

// ---------------------------------------------------------------------------

void main() {
    float aspect = u_resolution.x / u_resolution.y;
    vec2  uv     = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec3  col    = vec3(0.0);   // black void

    float zoom_speed = ZOOM * u_speed_scale * u_zoom_scale;

    for (int i = 0; i < N; i++) {
        float fi = float(i);

        float hash_d = h11(fi * 91.73 + 3.0);   // per-star depth phase
        float hc     = h11(fi * 37.11 + 4.0);   // color selector

        // d: zoom phase in [0,1). d≈0 = born near center; d→1 = exits screen.
        float phase = hash_d + u_time * zoom_speed;
        float d     = fract(phase);
        float cycle = floor(phase);   // increments each time this star resets

        // Seed position is re-randomized each cycle so no two passes look identical.
        vec2 seed_xy = vec2((h11(fi * 17.37 + cycle * 127.1 + 1.0) - 0.5) * aspect,
                             h11(fi * 53.19 + cycle * 311.7 + 2.0) - 0.5);

        float depth = 1.0 - d;
        vec2  p     = seed_xy / max(depth, 0.001);   // project outward from center

        // Cull stars that are too far off screen.
        if (abs(p.x) > 1.6 || abs(p.y) > 1.6) continue;

        // Core radius: pinpoint at birth (d≈0, r≈0.001), swells as star flies outward (d→1, r≈0.015).
        float core_r    = d * 0.014 + 0.001;
        vec2  delta_uv  = uv - p;
        float core_dist = length(delta_uv);

        // Star color from palette.
        vec3 star_color = palette(hc);

        // Hard-edged circle with single-pixel anti-aliased rim — no exp() glow.
        col += star_color * (1.0 - smoothstep(core_r * 0.8, core_r, core_dist));

        // Analytical tracer tail: oriented strip behind the star, linearly faded.
        // Replaces the old 16-sample exp() loop. The tail extends from the star tip
        // back toward the vanishing point along the radial direction of travel.
        float tail_len = d * 0.36 + 0.006;    // tripled — dramatic streaks as star nears screen edge
        float tail_wid = core_r * 1.4;         // slightly wider than the core

        float p_len = length(p);
        if (p_len > 0.002) {
            vec2  tail_dir  = p / p_len;                      // unit: center → star (direction of travel)
            vec2  tail_perp = vec2(-tail_dir.y, tail_dir.x);  // perpendicular axis

            // along: positive when the pixel is behind the star tip (toward the center).
            float along   = -dot(delta_uv, tail_dir);
            float lateral = abs(dot(delta_uv, tail_perp));

            if (along > 0.0 && along < tail_len && lateral < tail_wid) {
                float fade_along   = 1.0 - (along / tail_len);
                float fade_lateral = 1.0 - smoothstep(tail_wid * 0.5, tail_wid, lateral);
                col += star_color * 0.55 * fade_along * fade_lateral;
            }
        }
    }

    fragColor = vec4(col, 1.0);
}
