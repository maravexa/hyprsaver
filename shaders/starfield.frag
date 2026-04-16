#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — starfield.frag
//
// Polar sector lookup architecture — O(1)-per-pixel star rendering.
// Three parallax layers (far / mid / near) divide 2π into angular sectors
// (60 / 35 / 18). Each pixel converts to polar coordinates once, identifies
// its sector, and checks only 3 neighbouring sectors per layer — 9 total
// star evaluations regardless of total star count.
//
// Stars are born near screen centre and accelerate outward with d²-quadratic
// radial growth. Tails extend inward along the radial axis using a simple
// range test (no segment-distance computation needed).
// Per-cycle angular re-randomisation prevents visible pattern repetition.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Hash — float → float in [0, 1)
// ---------------------------------------------------------------------------

float h11(float p) {
    p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p);
}

// ---------------------------------------------------------------------------

void main() {
    const float PI     = 3.14159265359;
    const float TWO_PI = 6.28318530718;

    vec2  uv      = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    float radius  = length(uv);
    float angle   = atan(uv.y, uv.x);          // [-PI, PI]
    float angle_pos = mod(angle + PI, TWO_PI);  // [0, TWO_PI)

    vec3 col = vec3(0.0);  // black void

    // Three parallax layers — rendered back-to-front so near stars composite on top.
    // Layer 0 (far):  dense pinpoint background — 60 sectors, slow, short tails
    // Layer 1 (mid):  mid-depth fill            — 35 sectors, medium speed/tails
    // Layer 2 (near): dramatic foreground        — 18 sectors, fast, long tails
    for (int layer = 0; layer < 3; layer++) {
        float num_sec, radial_speed, size_mult, tail_mult;

        if (layer == 0) {
            num_sec = 60.0;  radial_speed = 0.06;  size_mult = 0.5;  tail_mult = 0.5;
        } else if (layer == 1) {
            num_sec = 35.0;  radial_speed = 0.12;  size_mult = 1.0;  tail_mult = 1.0;
        } else {
            num_sec = 18.0;  radial_speed = 0.22;  size_mult = 2.0;  tail_mult = 2.0;
        }

        float sector_width = TWO_PI / num_sec;
        float sector_id    = floor(angle_pos / sector_width);

        // Check this sector and its two angular neighbours (handles 2π wraparound).
        for (int nb = -1; nb <= 1; nb++) {
            float check_id = mod(sector_id + float(nb), num_sec);

            float seed = float(layer) * 137.531 + check_id * 17.37;

            // Angular position: sector centre + per-star random offset within sector.
            float star_angle  = (check_id + 0.5) * sector_width - PI;
            star_angle += (h11(seed + 1.11) - 0.5) * sector_width * 0.7;

            // Each star has a random phase so they don't all reset simultaneously.
            float radial_phase = h11(seed + 2.22);
            float t     = radial_phase + u_time * u_speed_scale * u_zoom_scale * radial_speed;
            float d     = fract(t);
            float cycle = floor(t);

            // Per-cycle angular perturbation: each pass through a sector looks different.
            star_angle += (h11(seed + cycle * 127.1 + 5.55) - 0.5) * sector_width * 0.15;

            // Cubic radial growth: slow near center (linger ahead), accelerate to edges.
            // d=0.3 → r≈0.077, d=0.6 → r≈0.374, d=0.9 → r≈1.144
            float star_radius = d * d * d * 1.5 + 0.05;

            // Dead zone: enlarged void at vanishing point — you're heading there but never arriving.
            if (star_radius < 0.12) continue;

            // Core radius: pinpoint at birth (d≈0), swells as star flies outward (d→1).
            float core_r = (d * 0.014 + 0.001) * size_mult;

            // Angular distance from pixel to star — wrapped to shortest path [0, PI].
            float star_angle_pos = mod(star_angle + PI, TWO_PI);
            float delta_angle    = abs(mod(angle_pos - star_angle_pos + PI, TWO_PI) - PI);

            // Convert angular separation to approximate screen-space lateral distance.
            float lateral_dist = delta_angle * radius;

            // Radial distance from pixel to star head.
            float radial_dist = abs(radius - star_radius);

            // Core dot: elliptical distance metric (tight radially, wider laterally).
            float dot_dist = sqrt(lateral_dist * lateral_dist + radial_dist * radial_dist);
            float star_dot = 1.0 - smoothstep(core_r * 0.7, core_r, dot_dist);

            // Tail: extends inward from the star head along the radial axis.
            float tail_growth = smoothstep(0.0, 0.3, d);  // progressive growth as star ages
            float tail_length = 0.18 * star_radius * star_radius * 4.0 * tail_growth * tail_mult;
            float tail_wid    = core_r * 1.4 * (1.0 + star_radius * 0.5);

            // Is this pixel radially inward from the star head, within the tail?
            float radial_behind = star_radius - radius;  // positive when pixel is closer to centre
            float tail_intensity = 0.0;

            if (tail_length > 0.0 && radial_behind > 0.0 && radial_behind < tail_length) {
                float lateral_falloff   = 1.0 - smoothstep(0.0, tail_wid, lateral_dist);
                float longitudinal_fade = 1.0 - (radial_behind / tail_length);
                tail_intensity = lateral_falloff * longitudinal_fade * tail_growth;
            }

            float final_intensity = max(star_dot, tail_intensity);
            vec3  star_color      = palette(h11(seed + 3.33));
            col += star_color * final_intensity;
        }
    }

    fragColor = vec4(col, 1.0);
}
