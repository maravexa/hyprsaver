#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — starfield.frag
//
// Hyperspace zoom tunnel. 120 stars radiate outward from a central vanishing
// point. Each star zooms from its seed position toward the screen edge.
// Tails are radial line segments drawn from each star back toward screen
// center — bright at the star head, fading to transparent at the tail end.
// Stars further from center move faster and have longer dramatic streaks.
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

        // Dead zone: skip stars seeded within 5% of screen height from center.
        // Stars this close to origin have a near-zero radial vector; normalizing it
        // produces an unstable tail direction that flickers or points the wrong way.
        if (length(seed_xy) < 0.05) continue;

        // Progressive tail growth: d is the star's age (0.0 at spawn, ~1.0 at exit).
        // Tails grow from zero to full length over the first 30% of the star's
        // lifetime, then stay at max for the remaining 70%.
        float star_age   = d;
        float tail_scale = smoothstep(0.0, 0.3, star_age);

        float depth = 1.0 - d;
        vec2  p     = seed_xy / max(depth, 0.001);   // project outward from center

        // Cull stars that are too far off screen.
        if (abs(p.x) > 1.6 || abs(p.y) > 1.6) continue;

        // Core radius: pinpoint at birth (d≈0, r≈0.001), swells as star flies outward (d→1, r≈0.015).
        float core_r    = d * 0.014 + 0.001;
        float core_dist = length(uv - p);

        // Star color from palette.
        vec3 star_color = palette(hc);

        // Star head: bright dot at current position.
        float star_dot = 1.0 - smoothstep(core_r * 0.7, core_r, core_dist);

        // Tail: radial line segment from star back toward screen center.
        // Stars further from center are moving faster, so their tails are longer.
        float dist_from_center = length(p);
        float base_tail_length = 0.18;
        float tail_length      = base_tail_length * dist_from_center * 2.0 * tail_scale;
        float tail_wid         = core_r * 1.4;   // thin streak, slightly wider than the core

        float tail_intensity = 0.0;

        if (dist_from_center > 0.002 && tail_length > 0.0) {
            vec2 radial_dir = p / dist_from_center;     // unit vector: center → star (direction of travel)
            vec2 tail_end   = p - radial_dir * tail_length;   // tail end lies toward center

            // Line segment distance from uv to (p → tail_end).
            vec2  seg     = tail_end - p;                 // vector: star → tail_end (points toward center)
            float seg_len = length(seg);
            vec2  seg_dir = seg / seg_len;

            vec2  to_pixel = uv - p;
            float proj     = clamp(dot(to_pixel, seg_dir), 0.0, seg_len);
            float dist     = length(to_pixel - seg_dir * proj);

            // Lateral falloff: thin streak perpendicular to tail axis.
            float lateral = 1.0 - smoothstep(0.0, tail_wid, dist);

            // Longitudinal fade: full brightness at star head (proj=0), transparent at tail end.
            float fade = 1.0 - (proj / seg_len);

            tail_intensity = lateral * fade * tail_scale;
        }

        // Combine head dot and tail — take the brighter contribution per pixel.
        float final_intensity = max(star_dot, tail_intensity);
        col += star_color * final_intensity;
    }

    fragColor = vec4(col, 1.0);
}
