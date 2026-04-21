#version 320 es
precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// circuit.glsl — hex-offset grid with hash-gated traces and gradient pulses.
// Reads as PCB / circuit network. Fragment-native: work is localized to
// one cell-neighbourhood per pixel.

// ---------------------------------------------------------------------------
// Fast hash functions (Dave Hoskins style)
// https://www.shadertoy.com/view/4djSRW
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
// Constants
// ---------------------------------------------------------------------------
const vec2  GRID_SIZE       = vec2(8.0, 6.0);
const vec2  SCROLL_VELOCITY = vec2(0.03, 0.015);
const float NODE_SIZE       = 0.09;   // normalized to previous intensity-max size
const float EDGE_WIDTH      = 0.038;  // normalized to previous intensity-max width

// ---------------------------------------------------------------------------
// Node info
// ---------------------------------------------------------------------------
struct NodeInfo {
    vec2  cell_uv;   // position in grid-coordinate space
    float intensity; // uniform 1.0 — all nodes normalized to largest size
};

NodeInfo get_node(vec2 cell_id) {
    // Brick offset: odd rows shift x by 0.5 cell
    float row_shift = mod(cell_id.y, 2.0) * 0.5;

    NodeInfo n;
    // Node at center of cell — uniform positioning, no per-node jitter
    n.cell_uv   = vec2(cell_id.x + row_shift + 0.5, cell_id.y + 0.5);
    n.intensity = 1.0;  // uniform — all nodes normalized to largest size
    return n;
}

float hash_edge(vec2 a, vec2 b) {
    return hash21(a + b);  // symmetric — both endpoints agree
}

// ---------------------------------------------------------------------------
// Edge contribution
// ---------------------------------------------------------------------------
vec3 edge_contribution(vec2 pg, NodeInfo nA, NodeInfo nB,
                        float e_hash, float t) {
    float exists = smoothstep(0.60, 0.70, e_hash);  // ~30% density

    vec2  ab     = nB.cell_uv - nA.cell_uv;
    vec2  ap     = pg - nA.cell_uv;
    float ab_dot = max(dot(ab, ab), 1e-6);
    float edge_t = clamp(dot(ap, ab) / ab_dot, 0.0, 1.0);
    vec2  closest = nA.cell_uv + edge_t * ab;
    float dist    = length(pg - closest);

    float width = mix(nA.intensity, nB.intensity, edge_t) * EDGE_WIDTH;
    float shape = smoothstep(width, width * 0.35, dist);

    // Single palette call per edge; hash offset provides per-edge variety
    vec3 col = palette(fract(edge_t * 2.0 + t * 0.08 + e_hash * 0.7));

    // Gradient pulse sweeps along edge
    float pulse_pos = fract(t * 0.25 + e_hash);
    float pulse     = smoothstep(0.08, 0.0, abs(edge_t - pulse_pos));

    float brightness = mix(0.35, 1.4, pulse);

    return col * shape * brightness * exists;
}

// ---------------------------------------------------------------------------
// Node contribution
// ---------------------------------------------------------------------------
vec3 node_contribution(vec2 pg, NodeInfo n, float t) {
    float dist   = length(pg - n.cell_uv);
    float radius = NODE_SIZE * n.intensity;
    float shape  = smoothstep(radius, radius * 0.3, dist);

    vec3 col = palette(fract(n.intensity * 0.6 + t * 0.05));
    return col * shape * 0.8;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
void main() {
    float t  = u_time * u_speed_scale;
    vec2  uv = gl_FragCoord.xy / u_resolution.xy;

    vec2 cell_coord  = uv * GRID_SIZE + SCROLL_VELOCITY * t;
    vec2 center_cell = floor(cell_coord);
    vec2 pg          = cell_coord;

    // Node cache: 5 cols × 4 rows = 20 entries
    // i = 0..4 represents dx -2..+2
    // j = 0..3 represents dy -1..+2
    NodeInfo nodes[20];
    for (int j = 0; j < 4; j++) {
        for (int i = 0; i < 5; i++) {
            vec2 cell = center_cell + vec2(float(i) - 2.0, float(j) - 1.0);
            nodes[j * 5 + i] = get_node(cell);
        }
    }

    vec3 color = vec3(0.0);

    // Iterate 3x3 center range: dx, dy in {-1, 0, 1}
    // Array indices: di = dx + 2 (range 1..3), dj = dy + 1 (range 0..2)
    for (int dj = 0; dj <= 2; dj++) {
        for (int di = 1; di <= 3; di++) {
            vec2 cell_id = center_cell + vec2(float(di) - 2.0, float(dj) - 1.0);
            float row_parity = mod(cell_id.y, 2.0);
            int parity_i = int(row_parity);

            NodeInfo n = nodes[dj * 5 + di];
            color += node_contribution(pg, n, t);

            // E neighbor: always (di+1, dj)
            NodeInfo nE = nodes[dj * 5 + (di + 1)];

            // NE neighbor: parity-dependent
            //   even row (parity=0): (di, dj+1)   — same col, row up
            //   odd row  (parity=1): (di+1, dj+1) — col right, row up
            NodeInfo nNE = nodes[(dj + 1) * 5 + (di + parity_i)];

            // NW neighbor: parity-dependent
            //   even row (parity=0): (di-1, dj+1) — col left, row up
            //   odd row  (parity=1): (di, dj+1)   — same col, row up
            NodeInfo nNW = nodes[(dj + 1) * 5 + (di + parity_i - 1)];

            color += edge_contribution(pg, n, nE,
                hash_edge(cell_id, cell_id + vec2(1.0, 0.0)), t);
            color += edge_contribution(pg, n, nNE,
                hash_edge(cell_id, cell_id + vec2(row_parity,       1.0)), t);
            color += edge_contribution(pg, n, nNW,
                hash_edge(cell_id, cell_id + vec2(row_parity - 1.0, 1.0)), t);
        }
    }

    fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
