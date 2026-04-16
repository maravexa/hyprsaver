#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — starfield.frag
//
// Hyperspace zoom tunnel. 100 stars radiate outward from a central vanishing
// point. Each star zooms from its seed position toward the screen edge.
// Tails are radial line segments drawn from each star back toward screen
// center — bright at the star head, fading to transparent at the tail end.
// Stars further from center move faster and have longer dramatic streaks.
// Fully stateless GLSL — no per-frame CPU work.
//
// Optimised tail math: radial cross/dot replaces generic point-to-segment
// distance (2-3 sqrt removed). Core dot uses squared distance (1 more sqrt
// removed). Total cost per star: 1 sqrt (dist_from_center, uniform across
// all pixels for that star).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

const float ZOOM = 0.4;   // zoom-cycle frequency (cycles / second)
const int   N    = 100;   // total star count

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
        if (dot(seed_xy, seed_xy) < 0.0025) continue;

        // Progressive tail growth: d is the star's age (0.0 at spawn, ~1.0 at exit).
        // Tails grow from zero to full length over the first 30% of the star's
        // lifetime, then stay at max for the remaining 70%.
        float star_age   = d;
        float tail_scale = smoothstep(0.0, 0.3, star_age);

        float depth = 1.0 - d;
        vec2  p     = seed_xy / max(depth, 0.001);   // project outward from center

        // Cull stars that are too far off screen.
        if (abs(p.x) > 1.6 || abs(p.y) > 1.6) continue;

        // Uniform per-star quantities (same value for every pixel in this iteration).
        float dist_from_center = length(p);   // 1 sqrt — reused by tail math below

        // Core radius: pinpoint at birth (d≈0, r≈0.001), swells as star flies outward (d→1, r≈0.015).
        float core_r = d * 0.014 + 0.001;

        // Tail geometry (uniform: same for all pixels).
        float base_tail_length = 0.18;
        float tail_length      = 0.0;
        float tail_wid         = core_r * 1.4;   // thin streak, slightly wider than the core

        if (dist_from_center > 0.002 && tail_scale > 0.0) {
            tail_length = base_tail_length * dist_from_center * 2.0 * tail_scale;
        }

        // Star color from palette.
        vec3 star_color = palette(hc);

        // Core dot — squared distance avoids a sqrt.
        vec2  core_delta = uv - p;
        float core_dist2 = dot(core_delta, core_delta);
        float cr_inner   = core_r * 0.7;
        float star_dot   = 1.0 - smoothstep(cr_inner * cr_inner, core_r * core_r, core_dist2);

        float tail_intensity = 0.0;

        if (dist_from_center > 0.002 && tail_length > 0.0) {
            // Lateral distance: perpendicular distance from pixel to the ray
            // from origin through star position. Uses 2D cross product.
            // No sqrt needed — dist_from_center is already computed.
            float lateral_dist = abs(p.x * uv.y - p.y * uv.x) / dist_from_center;

            // Longitudinal position: projection of pixel onto the radial ray.
            float proj_along_ray = dot(uv, p) / dist_from_center;

            // The star head is at radial distance dist_from_center.
            // The tail end is at dist_from_center - tail_length (toward center).
            float tail_start = dist_from_center - tail_length;  // tail end (toward center)
            float tail_end_r = dist_from_center;                 // star head

            // Clamp projection to the tail segment range.
            float clamped_proj = clamp(proj_along_ray, tail_start, tail_end_r);

            // Lateral falloff: thin streak perpendicular to tail axis.
            float lateral = 1.0 - smoothstep(0.0, tail_wid, lateral_dist);

            // Longitudinal fade: full brightness at star head, transparent at tail end.
            float seg_length = tail_length;
            float along_frac = (clamped_proj - tail_start) / max(seg_length, 0.001);
            float fade = along_frac;  // 0 at tail end, 1 at star head

            // Only contribute if pixel is within the tail segment range.
            // (proj_along_ray outside [tail_start, tail_end_r] means pixel is beyond
            // the tail — lateral check alone would incorrectly extend the tail
            // infinitely along the ray.)
            float in_range = step(tail_start, proj_along_ray) *
                             step(proj_along_ray, tail_end_r + tail_wid);

            tail_intensity = lateral * fade * tail_scale * in_range;
        }

        float final_intensity = max(star_dot, tail_intensity);
        col += star_color * final_intensity;
    }

    fragColor = vec4(col, 1.0);
}
