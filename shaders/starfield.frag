#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — starfield.frag
//
// Hyperspace warp starfield using zoom-layer technique with golden-angle
// rotation between layers. Each layer is a grid of point lights created
// by mod() cell distance. Time-varying zoom makes stars stream radially
// outward. Golden-angle rotation breaks grid artifacts between layers.
// Radial stretch creates perspective-correct streaks at screen edges.
// 6 layers, desynchronized speeds, ~15-25% GPU.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// Golden angle rotation matrix (≈137.508°)
// cos(137.508°) ≈ -0.7374,  sin(137.508°) ≈ 0.6755
const mat2 GOLDEN_ROT = mat2(
    -0.73736882, -0.67549030,
     0.67549030, -0.73736882
);

const int   LAYERS    = 6;
const float CELL_SIZE = 2.0;     // mod period — each cell is 2.0 units wide

float h11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec3 col = vec3(0.0);

    // Per-layer speeds and phase offsets — irregular to prevent synchronized bursts
    float speeds[6]  = float[](0.20, 0.27, 0.33, 0.23, 0.30, 0.17);
    float offsets[6] = float[](0.00, 0.41, 0.17, 0.73, 0.56, 0.89);

    // Density scale controls how many stars per layer
    float density = 8.0 * u_zoom_scale;

    // Cumulative rotation matrix — identity before the loop
    mat2 rot = mat2(1.0, 0.0, 0.0, 1.0);

    for (int i = 0; i < LAYERS; i++) {
        float fi = float(i);

        // Accumulate golden-angle rotation each layer
        rot *= GOLDEN_ROT;

        // Zoom phase for this layer
        float phase = fract(u_time * u_speed_scale * speeds[i] + offsets[i]);

        // Skip layers near cycle wrap — nothing visible anyway
        if (phase > 0.93) continue;

        // Zoom: small = far (dense tiny stars), large = near (sparse, flying past)
        float zoom = mix(0.3, 5.0, phase * phase);  // quadratic: accelerates outward

        // Fade in at birth only — zoom handles exit naturally
        float fade = smoothstep(0.0, 0.2, phase);

        // Zoom FIRST (expansion always from screen center), THEN rotate
        vec2 p = (uv / zoom) * rot * density;

        // Layer shift — prevents overlapping star positions between layers
        p += fi * 2.618;  // golden ratio shift

        // Cell-local position: distance from nearest cell center
        vec2 cell_local = mod(p, CELL_SIZE) - (CELL_SIZE * 0.5);

        // --- Radial streak ---
        // Stretch cell_local along the radial direction from screen center
        // Stars at edges get elongated, center stars stay round
        float dist_from_center = length(uv);
        float streak = dist_from_center * 3.5;
        streak = min(streak, 5.0);

        if (streak > 0.01 && dist_from_center > 0.01) {
            vec2 radial_dir = uv / dist_from_center;
            float radial_comp = dot(cell_local, radial_dir);
            float tangent_comp = cell_local.x * radial_dir.y - cell_local.y * radial_dir.x;

            // Compress radial component — elongates star along travel direction
            cell_local = vec2(
                radial_comp / (1.0 + streak),
                tangent_comp
            );
        }

        // Distance to cell center
        float len = length(cell_local);

        // Hard dot: binary on/off based on distance threshold
        float att = step(len, 0.3);

        att *= 0.35;

        // Color: each layer samples palette at a different point
        float hue = fract(fi * 0.1618 + u_time * u_speed_scale * 0.01);
        col += palette(hue) * att * fade;
    }

    col = min(col, 1.0);

    fragColor = vec4(col, 1.0);
}
