#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — starfield.frag
//
// Hyperspace warp starfield using the Art-of-Code multi-layer technique.
// 20 layers of stars, each zooming outward from screen center via UV scaling.
// Each layer cycles independently: fract(time/layers + offset) provides the
// zoom phase, floor() re-randomizes the star pattern each cycle. With 20
// layers, any single layer's birth/death is ~5% of visible stars — invisible.
// Per-layer rotation breaks grid alignment. Y2K-style hard pixel dots with
// dashed radial trails via dual time-offset sampling.
// Fully stateless GLSL — no per-frame CPU work.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

const float NUM_LAYERS = 20.0;
const float GRID_DENSITY = 8.0;   // cells per unit — controls star count per layer
const float SPEED = 0.36;         // base warp speed

// ---------------------------------------------------------------------------
// Hash functions
// ---------------------------------------------------------------------------

float Hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

vec2 Hash22(vec2 p) {
    float n = Hash21(p);
    return vec2(n, Hash21(p + n));
}

// ---------------------------------------------------------------------------
// 2D rotation matrix
// ---------------------------------------------------------------------------

mat2 Rot(float a) {
    float s = sin(a), c = cos(a);
    return mat2(c, -s, s, c);
}

// ---------------------------------------------------------------------------
// Single star layer
//
// uv       : screen coords (centered, aspect-corrected)
// trans     : zoom phase [0, 1) — 0 = just born (center), 1 = flying off edges
// cycle_id  : integer that increments each time this layer resets — used as
//             random seed so each pass has a unique star pattern
// layer_idx : which layer (0–19), used for rotation offset
// ---------------------------------------------------------------------------

vec3 StarLayer(vec2 uv, float trans, float cycle_id, float layer_idx) {
    vec3 col = vec3(0.0);

    // Scale UV from center — THIS is the warp zoom effect.
    // trans=0: UV scaled to zero (everything at center, invisible).
    // trans=1: UV at full scale (stars at their widest spread).
    // Using trans*trans for acceleration (slow birth, fast exit).
    float scale_now = mix(20.0, 0.15, trans);

    // Per-layer rotation breaks grid alignment between layers.
    // Golden angle (137.508°) ensures no two layers share grid axes.
    // uv_rot is the rotated-but-not-scaled UV, needed for trail offset direction.
    vec2 uv_rot = uv * Rot(layer_idx * 2.3999);
    vec2 scaled = uv_rot * scale_now;

    // Unique layer shift so star positions differ between layers
    scaled += layer_idx * 31.416;

    // Grid: floor = cell ID, fract = position within cell [-0.5, 0.5]
    vec2 cell_id = floor(scaled);
    vec2 gv = fract(scaled) - 0.5;

    // Single cell check — stars are offset max ±0.35 and sized max 0.033,
    // so they never reach the cell boundary at ±0.5; neighbor check is unnecessary.
    {
        vec2 this_cell = cell_id;

        float n = Hash21(this_cell + cycle_id * 127.1);

        // Compute star_pos up-front so the dead-zone check can use it.
        vec2 star_pos = (Hash22(this_cell + cycle_id * 311.7) - 0.5) * 0.7;

        // Spawn-time dead zone:
        //
        // The star's rotated-screen-space position is
        //     uv_rot_star = (this_cell + 0.5 + star_pos - layer_idx * 31.416) / scale_now
        // and |uv_rot_star| = |uv_star| (rotation preserves length from origin).
        //
        // At spawn (trans=0), scale_now = 20.0 (the first arg to mix() below).
        // We reject stars whose spawn screen-radius is inside DEAD_ZONE_RADIUS,
        // so no star ever traverses the center — they appear at the dead-zone
        // boundary and fly outward past the viewer.
        const float DEAD_ZONE_RADIUS = 0.12;
        vec2  world_grid = this_cell + vec2(0.5) + star_pos - vec2(layer_idx * 31.416);
        float spawn_screen_r = length(world_grid) / 20.0;
        bool  in_dead_zone = spawn_screen_r < DEAD_ZONE_RADIUS;

        if (n <= 0.36 && !in_dead_zone) {
            vec2 delta = gv - star_pos;
            float d2 = dot(delta, delta);

            float size_hash = fract(n * 345.67);
            float star_size = 0.0195 + size_hash * 0.03;   // 1.5× original (0.013→0.0195, 0.02→0.03)

            float att = 1.0 - smoothstep(star_size * 0.85, star_size, sqrt(d2));

            float hue = fract(n * 789.01);

            // Trail dots: shift delta analytically using zoom-phase difference.
            // At an earlier zoom phase the pixel mapped to a slightly different
            // grid position; the difference is uv_rot * (S_prev - scale_now).
            float dt = 0.018;
            float trail_fade = smoothstep(0.0, 0.08, trans); // suppress on newborn stars

            float S_prev1 = mix(20.0, 0.15, max(trans - dt, 0.0));
            vec2 trail_delta1 = delta + uv_rot * (S_prev1 - scale_now);
            float trail_att1 = (1.0 - smoothstep(star_size * 0.85, star_size, sqrt(dot(trail_delta1, trail_delta1)))) * trail_fade;

            float S_prev2 = mix(20.0, 0.15, max(trans - dt * 2.0, 0.0));
            vec2 trail_delta2 = delta + uv_rot * (S_prev2 - scale_now);
            float trail_att2 = (1.0 - smoothstep(star_size * 0.85, star_size, sqrt(dot(trail_delta2, trail_delta2)))) * trail_fade;

            col += palette(hue) * att;
            col += palette(hue) * trail_att1 * 0.65;
            col += palette(hue) * trail_att2 * 0.35;
        }
    }

    return col;
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec3 col = vec3(0.0);

    float t = u_time * u_speed_scale * SPEED;

    for (float i = 0.0; i < 1.0; i += 1.0 / NUM_LAYERS) {
        // Each layer has a unique time offset — distributes births evenly
        float layer_time = t + i;

        // Zoom phase: 0 = born at center, 1 = exiting at edges
        float trans = fract(layer_time);

        // Cycle ID: increments each time this layer wraps — new star pattern
        float cycle_id = floor(layer_time);

        // Fade: birth ramp + death fade
        // smoothstep(0, 0.1, trans): fade in over first 10% (stars emerge from center)
        // smoothstep(1, 0.85, trans): fade out over last 15% (stars dissolve at edges)
        // With 20 layers, these brief transitions overlap so smoothly that
        // no pop is visible.
        float fade = smoothstep(0.0, 0.1, trans) * smoothstep(1.0, 0.92, trans);

        // Depth-based brightness: layers at mid-depth are brightest
        float brightness = trans * fade;

        col += StarLayer(uv, trans, cycle_id, i * NUM_LAYERS) * brightness;
    }

    // Gentle tone-map to handle star overlaps
    col = col / (col + 0.8);

    fragColor = vec4(col, 1.0);
}
