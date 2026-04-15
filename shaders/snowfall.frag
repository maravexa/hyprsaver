#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — snowfall.frag
//
// Grid-based spatial-lookup snowfall. Three parallax layers (near, mid, far)
// each tile UV space into a grid of cells. Each cell contains exactly one
// randomised snowflake. Each pixel checks only its own cell plus the 8
// surrounding neighbours — 3 layers × 9 checks = 27 distance evaluations,
// down from the original 100 (5 layers × 20 dots each).
//
// Layer parameters (0 = near … 2 = far):
//   grid_scale : 6.0 / 10.0 / 16.0   (cells per screen height)
//   radius_px  : 7–9 / 3–5 / 0.8–1.8 (randomised per cell)
//   fall_speed : 0.14 / 0.10 / 0.06
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Hash functions — all results in [0, 1)
// ---------------------------------------------------------------------------

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

// ---------------------------------------------------------------------------
// Accumulate glow for one grid-based snow layer.
//
//   uv         : centred UV (origin at screen center, normalised by height)
//   grid_scale : cells per screen height
//   fall_speed : scroll rate (cells/second at u_speed_scale = 1.0)
//   min_px     : minimum dot radius in pixels
//   max_px     : maximum dot radius in pixels
//   pal_t      : palette sample offset for this layer's hue
// ---------------------------------------------------------------------------

vec3 snowGridLayer(vec2 uv, float grid_scale, float fall_speed,
                   float min_px, float max_px, float pal_t) {
    // Scale UV to cell space and scroll the grid downward over time.
    vec2 suv = uv * grid_scale;
    suv.y += u_time * u_speed_scale * fall_speed;

    vec2 cell_id   = floor(suv);
    vec2 local_pos = fract(suv) - 0.5;   // [-0.5, +0.5] within current cell

    vec3 dot_col = palette(pal_t);
    vec3 acc = vec3(0.0);

    for (int dx = -1; dx <= 1; dx++) {
        for (int dy = -1; dy <= 1; dy++) {
            vec2 neighbor_id = cell_id + vec2(float(dx), float(dy));

            // Random dot offset within the neighbour cell: [-0.4, +0.4].
            vec2 dot_offset = (hash22(neighbor_id) - 0.5) * 0.8;

            // Per-cell size variation — use a shifted seed for independence.
            float t_size = hash21(neighbor_id + vec2(7.13, 3.71));
            float dot_r  = mix(min_px, max_px, t_size) / u_resolution.y * grid_scale;

            float dist = length(local_pos - vec2(float(dx), float(dy)) - dot_offset);

            float inner = dot_r * 0.4;
            float glow  = smoothstep(dot_r, inner, dist);
            glow *= glow;

            acc += dot_col * glow;
        }
    }

    return acc;
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // Background color.
    // Detect monochrome palette: sample LUT endpoints; if they're nearly the
    // same colour the palette has no hue variation — use plain black background.
    vec3 _lut_lo = texture(u_lut_a, vec2(0.0, 0.5)).rgb;
    vec3 _lut_hi = texture(u_lut_a, vec2(1.0, 0.5)).rgb;
    vec3 bg;
    if (all(lessThan(abs(_lut_hi - _lut_lo), vec3(0.05)))) {
        bg = vec3(0.0);
    } else {
        // Slow drift along the far end of the palette for a complementary hue.
        float bg_t = 0.5 + 0.5 * sin(u_time * u_speed_scale * 0.03);
        bg = palette(bg_t) * 0.18;   // dark but not black — enough to contrast snow
    }

    // Composite: start with background, additively blend all 3 snow layers.
    // Render back-to-front (layer 2 / far first) so near flakes composite on top.
    vec3 col = bg;

    // Layer 2 — far: dense fine haze
    col += snowGridLayer(uv, 16.0, 0.06,  0.8,  1.8, 0.7);

    // Layer 1 — mid: medium fill
    col += snowGridLayer(uv, 10.0, 0.10,  3.0,  5.0, 0.35);

    // Layer 0 — near: large foreground flakes
    col += snowGridLayer(uv,  6.0, 0.14,  7.0,  9.0, 0.0);

    fragColor = vec4(col, 1.0);
}
