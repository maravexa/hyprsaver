#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — pipes.frag
//
// Classic 3D Pipes screensaver rendered as a stateless 2D fragment shader.
// A 20-row grid of axis-aligned tube segments grows across the screen; pipes
// make 90-degree turns at grid intersections chosen by a hash function seeded
// on the current era and pipe index. Tubes are shaded as glossy cylinders
// (Blinn-Phong); elbow joints and growing tips are rendered as spheres.
//
// 12 pipes grow in staggered waves over a 22-second era. At the end of each
// era the screen fades to black and a fresh set of pipes begins. Each pipe
// samples the palette at a unique hue offset so all 12 are visually distinct.
//
// Collision avoidance: when choosing the next direction at an intersection,
// the shader checks whether the next 2 cells in that direction are already
// occupied by an earlier pipe in this era.  If they are, a perpendicular
// direction is tried instead.  If all options are blocked the pipe terminates
// early.  Single-cell crossings are intentionally allowed (they look good).
//
// All pipe state is reconstructed deterministically from u_time every frame —
// no GPU buffers or textures are required. Pipes are culled at grid boundaries.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ── Grid layout ───────────────────────────────────────────────────────────────
// CELL = 1.0 / 20 rows.  Pipe radius < cell/2 so tubes don't overlap neighbours.
const float CELL    = 0.05;    // cell edge length in y-normalised UV
const float PIPE_R  = 0.016;   // cylinder radius (UV units)
const float JOINT_R = 0.022;   // elbow / tip sphere radius (UV units)

// ── Simulation parameters ─────────────────────────────────────────────────────
const int   N_PIPES   = 12;
const int   MAX_STEPS = 36;    // max grid segments per pipe
const float STEP_DUR  = 0.18;  // seconds to grow one grid segment
const float STAGGER   = 0.55;  // seconds between consecutive pipe starts
const float ERA_DUR   = 22.0;  // seconds per era (then fade-out & reset)
const float FADE_DUR  = 2.5;   // fade-out window at end of each era
const float TURN_PROB = 0.25;  // probability of 90° turn at each intersection

// ── Collision-avoidance grid ───────────────────────────────────────────────────
// 40 columns × 20 rows covers up to ~2:1 aspect ratio at CELL = 0.05.
// Cells beyond GRID_W_MAX are not tracked (no avoidance there, but no crash).
// Kept small: the array lives in per-thread GPU scratch memory (4 B × size),
// so every element saved reduces AMD register-file / scratch pressure.
const int GRID_W_MAX = 40;
const int GRID_H_MAX = 20;

// ── Hash functions ─────────────────────────────────────────────────────────────

float h11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

// Two-input hash → float in [0, 1)
float h21(float a, float b) {
    vec2 p = fract(vec2(a, b) * vec2(0.1031, 0.1030));
    p += dot(p, p.yx + 33.33);
    return fract((p.x + p.y) * p.x);
}

// Three-input hash → float in [0, 1)
float h31(float a, float b, float c) {
    return h21(a + c * 113.47, b + c * 79.31);
}

// ── Direction encoding: 0 = +x  1 = +y  2 = −x  3 = −y ──────────────────────

vec2 dir_vec(int d) {
    if (d == 0) return vec2( 1.0,  0.0);
    if (d == 1) return vec2( 0.0,  1.0);
    if (d == 2) return vec2(-1.0,  0.0);
               return vec2( 0.0, -1.0);
}

// 90-degree turns (never reverses direction).
int turn_cw(int d)  { return (d + 3) % 4; }   // clockwise
int turn_ccw(int d) { return (d + 1) % 4; }   // counter-clockwise

// ── Blinn-Phong shading ───────────────────────────────────────────────────────
// base: unlit surface colour.  N: surface normal in view space (z faces viewer).

vec3 blinn_phong(vec3 base, vec3 N) {
    vec3  L    = normalize(vec3(0.5, 0.8, 1.2));
    vec3  H    = normalize(L + vec3(0.0, 0.0, 1.0));
    float diff = max(dot(N, L), 0.0);
    float spec = pow(max(dot(N, H), 0.0), 64.0);
    return base * (0.12 + 0.80 * diff) + vec3(spec * 0.90);
}

// ── Main ───────────────────────────────────────────────────────────────────────

void main() {
    // y-normalised UV: x in [0, asp], y in [0, 1]
    vec2  uv  = gl_FragCoord.xy / u_resolution.y;
    float asp = u_resolution.x / u_resolution.y;
    float t   = u_time * u_speed_scale;

    // ── Era timing ─────────────────────────────────────────────────────────────
    float era_idx = floor(t / ERA_DUR);
    float era_t   = mod(t, ERA_DUR);   // seconds within current era [0, ERA_DUR)

    // Fade: full brightness for the first (ERA_DUR − FADE_DUR) seconds, then
    // smoothly to black in the final FADE_DUR seconds.
    float fade = clamp((ERA_DUR - era_t) / FADE_DUR, 0.0, 1.0);

    // ── Grid dimensions ─────────────────────────────────────────────────────────
    float gw = floor(asp / CELL);   // columns  (≈ 35 at 16:9 with CELL = 0.05)
    float gh = 20.0;                // rows     (fixed = 1.0 / CELL)
    int   igw = min(int(gw), GRID_W_MAX);  // clamped column count for grid array

    // ── Hit tracking ─────────────────────────────────────────────────────────────
    // best_nd: normalised distance from pixel to nearest surface (< 1.0 = inside).
    // Cylinders normalise by PIPE_R; spheres normalise by JOINT_R.
    float best_nd  = 1.0;
    vec3  best_col = vec3(0.0);
    vec3  best_N   = vec3(0.0, 0.0, 1.0);

    // ── Collision-avoidance grid ───────────────────────────────────────────────
    // Tracks which grid cells have been occupied by earlier pipes this era.
    // Initialised to 0 (free); marked 1 when a pipe segment or joint passes through.
    int visited[GRID_W_MAX * GRID_H_MAX];
    for (int _i = 0; _i < GRID_W_MAX * GRID_H_MAX; _i++) visited[_i] = 0;

    // Hue offset common to all pipes this era (rotates the palette each reset).
    float era_hue = h11(era_idx * 113.7 + 1.0);

    // ── Per-pipe loop ─────────────────────────────────────────────────────────
    for (int pi = 0; pi < N_PIPES; pi++) {
        float fi   = float(pi);
        float seed = era_idx * float(N_PIPES) + fi;

        // Pipe pi starts fi * STAGGER seconds into the era.
        float age = era_t - fi * STAGGER;
        if (age <= 0.0) continue;

        int   steps   = min(int(age / STEP_DUR), MAX_STEPS);
        float partial = fract(age / STEP_DUR);       // progress within current step
        if (steps >= MAX_STEPS) partial = 1.0;

        // Starting grid cell (integer coords stored as float for arithmetic).
        vec2 pos = vec2(floor(h21(seed, 1.0) * gw),
                        floor(h21(seed, 2.0) * gh));
        int  dir  = int(h21(seed, 3.0) * 4.0);

        // Each pipe samples the palette at a unique, evenly-spaced offset.
        vec3 pc = palette(fract(fi / float(N_PIPES) + era_hue));

        // ── Sphere at the pipe's origin cell ──────────────────────────────────
        {
            vec2  sc = (pos + 0.5) * CELL;
            float jd = length(uv - sc);
            float nd = jd / JOINT_R;
            if (nd < 1.0 && nd < best_nd) {
                float z = sqrt(max(JOINT_R * JOINT_R - jd * jd, 0.0));
                best_nd  = nd;
                best_col = pc;
                best_N   = normalize(vec3(uv - sc, z));
            }
        }

        // Mark the starting cell as occupied.
        {
            int cx = int(pos.x), cy = int(pos.y);
            if (cx >= 0 && cy >= 0 && cx < igw && cy < GRID_H_MAX)
                visited[cy * GRID_W_MAX + cx] = 1;
        }

        // ── Grow one grid segment per step ────────────────────────────────────
        for (int s = 0; s < MAX_STEPS; s++) {
            if (s >= steps) break;
            if (dir < 0) break;   // terminated by collision avoidance

            bool is_last = (s == steps - 1);
            vec2 dv      = dir_vec(dir);
            vec2 next_p  = pos + dv;

            // Stop at the grid boundary (pipe ends here, no wrap).
            if (next_p.x < 0.0 || next_p.y < 0.0 ||
                next_p.x >= gw  || next_p.y >= gh) break;

            // UV endpoints of this segment.
            // For the current (partial) step the far end moves with the grow front.
            vec2 sa = (pos    + 0.5) * CELL;
            vec2 sb = is_last ? sa + dv * CELL * partial
                              : (next_p + 0.5) * CELL;

            // ── Cylinder hit ──────────────────────────────────────────────────
            // Horizontal pipe (dir 0 or 2): perpendicular distance is |Δy|.
            // Vertical   pipe (dir 1 or 3): perpendicular distance is |Δx|.
            if (dir == 0 || dir == 2) {
                float perp = abs(uv.y - sa.y);
                float nd   = perp / PIPE_R;
                float xlo  = min(sa.x, sb.x);
                float xhi  = max(sa.x, sb.x);
                if (nd < 1.0 && nd < best_nd && uv.x >= xlo && uv.x <= xhi) {
                    float z  = sqrt(max(PIPE_R * PIPE_R - perp * perp, 0.0));
                    best_nd  = nd;
                    best_col = pc;
                    // Normal lives in the YZ plane: x-axis pipe, tube curves in y.
                    best_N   = normalize(vec3(0.0, uv.y - sa.y, z));
                }
            } else {
                float perp = abs(uv.x - sa.x);
                float nd   = perp / PIPE_R;
                float ylo  = min(sa.y, sb.y);
                float yhi  = max(sa.y, sb.y);
                if (nd < 1.0 && nd < best_nd && uv.y >= ylo && uv.y <= yhi) {
                    float z  = sqrt(max(PIPE_R * PIPE_R - perp * perp, 0.0));
                    best_nd  = nd;
                    best_col = pc;
                    // Normal lives in the XZ plane: y-axis pipe, tube curves in x.
                    best_N   = normalize(vec3(uv.x - sa.x, 0.0, z));
                }
            }

            // ── Sphere at segment end (elbow joint or growing tip) ─────────────
            // Completed segments: sphere at the corner (next_p cell centre).
            // Growing (last) segment: sphere travels with the grow front (sb).
            {
                vec2  jc = is_last ? sb : (next_p + 0.5) * CELL;
                float jd = length(uv - jc);
                float nd = jd / JOINT_R;
                if (nd < 1.0 && nd < best_nd) {
                    float z  = sqrt(max(JOINT_R * JOINT_R - jd * jd, 0.0));
                    best_nd  = nd;
                    best_col = pc;
                    best_N   = normalize(vec3(uv - jc, z));
                }
            }

            // Advance position.
            pos = next_p;

            // Mark the cell just entered as occupied.
            {
                int cx = int(pos.x), cy = int(pos.y);
                if (cx >= 0 && cy >= 0 && cx < igw && cy < GRID_H_MAX)
                    visited[cy * GRID_W_MAX + cx] = 1;
            }

            // ── Turn decision with collision avoidance ────────────────────────
            // Only needed for non-final steps (last step doesn't need a next dir).
            if (!is_last) {
                // Record direction before the hash turn so we know the 3 valid
                // non-reverse options: straight (prev_dir), CCW, CW.
                int prev_dir = dir;

                // Original hash-based turn decision.
                float th = h31(seed, float(s), 5.0);
                if (th < TURN_PROB) {
                    dir = (h31(seed, float(s), 6.0) < 0.5)
                        ? turn_ccw(dir) : turn_cw(dir);
                }

                // Collision avoidance: if the chosen direction leads to 2+
                // consecutive occupied cells, try the other non-reverse options.
                // Try order: hash-chosen dir, CCW of prev_dir, CW of prev_dir.
                bool dir_found = false;
                for (int dt = 0; dt < 3; dt++) {
                    int td = (dt == 0) ? dir
                           : (dt == 1) ? turn_ccw(prev_dir)
                                       : turn_cw(prev_dir);

                    vec2 d1 = dir_vec(td);
                    vec2 c1 = pos + d1;
                    vec2 c2 = pos + 2.0 * d1;

                    int cx1 = int(c1.x), cy1 = int(c1.y);
                    int cx2 = int(c2.x), cy2 = int(c2.y);

                    // A cell blocks if it is out-of-bounds or already occupied.
                    // IMPORTANT: do NOT rely on short-circuit evaluation to guard the
                    // array access — AMD drivers may evaluate all operands of || even
                    // when the left side is already true, causing out-of-bounds scratch
                    // memory access (negative or ≥ size indices) → GPU hard recovery.
                    // Instead: clamp indices unconditionally so the access is always
                    // in-range, and use a separate oob flag to override the result.
                    bool oob1 = (cx1 < 0 || cy1 < 0 || cx1 >= igw || cy1 >= GRID_H_MAX);
                    int  idx1 = clamp(cy1, 0, GRID_H_MAX - 1) * GRID_W_MAX
                              + clamp(cx1, 0, GRID_W_MAX - 1);
                    bool b1   = oob1 || (visited[idx1] != 0);

                    bool oob2 = (cx2 < 0 || cy2 < 0 || cx2 >= igw || cy2 >= GRID_H_MAX);
                    int  idx2 = clamp(cy2, 0, GRID_H_MAX - 1) * GRID_W_MAX
                              + clamp(cx2, 0, GRID_W_MAX - 1);
                    bool b2   = oob2 || (visited[idx2] != 0);

                    // Only redirect if BOTH ahead cells are occupied (single-cell
                    // crossings are allowed and look good).
                    if (!(b1 && b2)) {
                        dir = td;
                        dir_found = true;
                        break;
                    }
                }

                // All non-reverse options blocked → terminate this pipe.
                if (!dir_found) dir = -1;
            }
        }
    }

    // ── Compose final colour ──────────────────────────────────────────────────
    vec3 bg = vec3(0.05, 0.04, 0.06);   // near-black background

    vec3 col;
    if (best_nd < 1.0) {
        // Smooth anti-aliased edge: full intensity inside 75% of radius.
        float edge = smoothstep(1.0, 0.75, best_nd);
        col = mix(bg, blinn_phong(best_col, best_N), edge);
    } else {
        col = bg;
    }

    // Era fade-out: mix toward background in the last FADE_DUR seconds.
    col = mix(bg, col, fade);

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
