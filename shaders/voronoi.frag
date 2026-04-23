#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — voronoi.frag
//
// Animated Voronoi cells. Cell sites move along Lissajous-like paths with
// incommensurable frequencies, ensuring the pattern is always in motion.
// Cells are coloured by their index, the distance to the nearest site, and
// the angle to it — all fed through the palette for smooth, organic hues.
// A second Voronoi pass at a larger scale creates a background layer.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Low-quality but fast hash for seeding cell positions.
// ---------------------------------------------------------------------------
vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453123);
}

// ---------------------------------------------------------------------------
// Voronoi: returns (min_dist, cell_id, angle_to_site)
// Cell sites move over time using animated offsets seeded from hash.
// ---------------------------------------------------------------------------
vec3 voronoi(vec2 p, float t, float cell_size) {
    vec2 i_p = floor(p / cell_size);
    vec2 f_p = fract(p / cell_size);

    float min_dist  = 1e9;
    float cell_id   = 0.0;
    float min_angle = 0.0;

    for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
            vec2  neighbor = vec2(float(dx), float(dy));
            vec2  cell     = i_p + neighbor;
            vec2  seed     = hash2(cell);

            // Animate site position with a Lissajous path seeded per-cell.
            float phase_x = seed.x * 6.28318;
            float phase_y = seed.y * 6.28318;
            float freq_x  = 0.5 + seed.x * 0.8; // unique freq per cell
            float freq_y  = 0.5 + seed.y * 0.8;
            vec2  site    = neighbor + 0.5 + 0.45 * vec2(
                sin(t * freq_x + phase_x),
                cos(t * freq_y + phase_y)
            );

            vec2  diff = f_p - site;
            float d    = dot(diff, diff); // squared distance (avoid sqrt in loop)

            if (d < min_dist) {
                min_dist  = d;
                cell_id   = hash2(cell).x;
                min_angle = atan(diff.y, diff.x);
            }
        }
    }

    return vec3(sqrt(min_dist) * cell_size, cell_id, min_angle);
}

// ---------------------------------------------------------------------------
// Edge detection using second-nearest-distance trick
// ---------------------------------------------------------------------------
float voronoi_edge(vec2 p, float t, float cell_size) {
    vec2 i_p = floor(p / cell_size);
    vec2 f_p = fract(p / cell_size);

    float d1 = 1e9, d2 = 1e9;

    for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
            vec2  cell = i_p + vec2(float(dx), float(dy));
            vec2  seed = hash2(cell);

            float phase_x = seed.x * 6.28318;
            float phase_y = seed.y * 6.28318;
            vec2  site    = vec2(float(dx), float(dy)) + 0.5 + 0.45 * vec2(
                sin(t * (0.5 + seed.x * 0.8) + phase_x),
                cos(t * (0.5 + seed.y * 0.8) + phase_y)
            );
            float d = dot(f_p - site, f_p - site);
            if (d < d1)      { d2 = d1; d1 = d; }
            else if (d < d2) { d2 = d; }
        }
    }

    // Edge sharpness: narrow band where d1 ≈ d2.
    return smoothstep(0.0, 0.05, sqrt(d2) - sqrt(d1));
}

void main() {
    // Centered at screen midpoint, uniform scaling, aspect-ratio correct.
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    float t = u_time * u_speed_scale * 0.18;

    // Two Voronoi layers at different scales.
    float cell_lg = 0.22;  // large background cells
    float cell_sm = 0.09;  // small foreground cells

    vec3  v_lg   = voronoi(uv, t * 0.7, cell_lg);
    vec3  v_sm   = voronoi(uv, t * 1.3, cell_sm);
    float edge_lg = voronoi_edge(uv, t * 0.7, cell_lg);
    float edge_sm = voronoi_edge(uv, t * 1.3, cell_sm);

    // Colour each layer independently.
    float id_lg  = v_lg.y;
    float id_sm  = v_sm.y;
    float dist_sm = v_sm.x;

    // Palette lookup: mix cell ID, dist, angle, and time for richness.
    float t_lg = abs(fract(id_lg + u_time * u_speed_scale * 0.05) * 2.0 - 1.0);
    float t_sm = abs(fract(id_sm * 3.1 + dist_sm * 0.8 + u_time * u_speed_scale * 0.08) * 2.0 - 1.0);

    vec3 col_lg = palette(t_lg) * 0.5;
    vec3 col_sm = palette(t_sm);

    // Blend layers.
    vec3 col = mix(col_lg, col_sm, 0.6);

    // Draw cell edges as bright glowing lines.
    vec3 edge_col = palette(abs(fract(u_time * u_speed_scale * 0.04 + 0.3) * 2.0 - 1.0));
    col = mix(col, edge_col * 1.4, (1.0 - edge_sm) * 0.5);
    col = mix(col, edge_col * 0.8, (1.0 - edge_lg) * 0.25);

    // Distance-based brightness within each small cell.
    float cell_dark = smoothstep(0.0, cell_sm * 0.8, dist_sm);
    col *= 0.6 + 0.4 * cell_dark;

    // Subtle vignette.
    float vignette = 1.0 - dot(uv, uv) * 0.7;
    col *= clamp(vignette, 0.0, 1.0);

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
