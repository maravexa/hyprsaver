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
const float NODE_SIZE       = 0.06;   // in cell units
const float EDGE_WIDTH      = 0.025;  // in cell units

// ---------------------------------------------------------------------------
// Node info
// ---------------------------------------------------------------------------
struct NodeInfo {
    vec2  cell_uv;   // position in grid-coordinate space
    float intensity; // 0.5 to 1.5, controls brightness and pulse strength
};

NodeInfo get_node(vec2 cell_id) {
    vec2 h = hash22(cell_id + vec2(13.0, 29.0));

    // Brick-offset: odd rows shift x by 0.5 cell for non-rectangular feel
    float row_shift = mod(cell_id.y, 2.0) * 0.5;

    vec2 local_offset = vec2(0.35 + 0.3 * h.x, 0.35 + 0.3 * h.y);
    vec2 cell_origin  = vec2(cell_id.x + row_shift, cell_id.y);

    NodeInfo n;
    n.cell_uv   = cell_origin + local_offset;
    n.intensity = 0.5 + 1.0 * h.x;
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
    float exists = smoothstep(0.40, 0.50, e_hash);  // ~55% density

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

    // Cache 4×5 = 20 nodes covering all potential edge endpoints.
    // i=0..3 → dx offset -1..+2,  j=0..4 → dy offset -2..+2
    NodeInfo nodes[20];
    for (int j = 0; j < 5; j++) {
        for (int i = 0; i < 4; i++) {
            vec2 cell = center_cell + vec2(float(i) - 1.0, float(j) - 2.0);
            nodes[j * 4 + i] = get_node(cell);
        }
    }

    vec3 color = vec3(0.0);

    // Iterate 3×3 centre cells: di ∈ {1,2,3} → dx ∈ {-1,0,1}
    //                            dj ∈ {1,2,3} → dy ∈ {-1,0,1}
    for (int dj = 1; dj <= 3; dj++) {
        for (int di = 1; di <= 3; di++) {
            NodeInfo n = nodes[dj * 4 + di];
            color += node_contribution(pg, n, t);

            // Three outgoing edges: E, NE, SE
            NodeInfo nE  = nodes[dj       * 4 + (di + 1)];
            NodeInfo nNE = nodes[(dj + 1) * 4 + (di + 1)];
            NodeInfo nSE = nodes[(dj - 1) * 4 + (di + 1)];

            vec2 cell_id = center_cell + vec2(float(di) - 1.0, float(dj) - 2.0);
            color += edge_contribution(pg, n, nE,
                hash_edge(cell_id, cell_id + vec2(1.0,  0.0)), t);
            color += edge_contribution(pg, n, nNE,
                hash_edge(cell_id, cell_id + vec2(1.0,  1.0)), t);
            color += edge_contribution(pg, n, nSE,
                hash_edge(cell_id, cell_id + vec2(1.0, -1.0)), t);
        }
    }

    fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
