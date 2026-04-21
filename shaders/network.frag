#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — network.frag  (v0.4.4)
//
// Single-layer scrolling grid network.  Nodes placed on a hash-perturbed
// grid scroll diagonally over time.  Hash-gated edges (≈60% density) with
// tapered width and gradient pulse animation.  Node-size variance (0.5–2.0×,
// 4× ratio) drives visual size, edge width, and brightness — producing depth
// illusion without parallax layers.  Each node drifts in a slow small circle
// within its cell.  Each cell emits one long-offset edge from an 8-direction
// table, producing screen-spanning lines at varied angles.  Additive
// composition over pure black.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Grid constants (all distances in cell-coordinate units)
// ---------------------------------------------------------------------------

const vec2  GRID_SIZE         = vec2(8.0, 5.0);   // nominal cells visible
const vec2  SCROLL_VELOCITY   = vec2(0.02, 0.01);  // diagonal scroll (cell/s)
const float BASE_FEATURE_SIZE = 0.025;             // base edge half-width (cell units)

// ---------------------------------------------------------------------------
// Hash utilities
// ---------------------------------------------------------------------------

float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// ---------------------------------------------------------------------------
// Node info
// ---------------------------------------------------------------------------

struct NodeInfo {
    vec2  cell_uv;  // node position in grid (cell) coordinates
    float size;     // visual size multiplier: 0.5 – 2.0
};

NodeInfo get_node(vec2 cell_id) {
    float h1 = hash21(cell_id + vec2(17.0, 23.0));
    float h2 = hash21(cell_id + vec2(47.0, 91.0));

    // Keep node in the central 40 % of its cell — avoids crossing cell boundaries.
    vec2 local_offset = vec2(0.3) + 0.4 * vec2(h1, h2);

    // Per-node drift: small circular motion within cell (one rotation ~63 s, independent phase).
    float drift_angle = u_time * 0.1 + h1 * 6.2831853;
    vec2  drift       = 0.12 * vec2(cos(drift_angle), sin(drift_angle));

    NodeInfo n;
    n.cell_uv = cell_id + local_offset + drift;
    n.size    = 0.5 + 1.5 * h1;  // 0.5 → 2.0, 4× ratio
    return n;
}

// ---------------------------------------------------------------------------
// Edge existence — symmetric hash so both endpoints agree
// ---------------------------------------------------------------------------

float hash_edge(vec2 a, vec2 b) {
    return hash21(a + b);  // a+b == b+a keeps the gate symmetric
}

// ---------------------------------------------------------------------------
// Long-offset edge table — 8 directions, Chebyshev magnitude 2
// so a 5×5 search catches every rendered edge fully.
// ---------------------------------------------------------------------------

const vec2 EDGE_OFFSETS[8] = vec2[8](
    vec2( 2.0,  0.0),   // E
    vec2( 2.0,  2.0),   // SE
    vec2( 0.0,  2.0),   // S
    vec2(-2.0,  2.0),   // SW
    vec2(-2.0,  0.0),   // W
    vec2(-2.0, -2.0),   // NW
    vec2( 0.0, -2.0),   // N
    vec2( 2.0, -2.0)    // NE
);

vec2 get_cell_offset(vec2 cell_id) {
    float h   = hash21(cell_id + vec2(71.0, 149.0));
    int   idx = int(floor(h * 8.0));
    return EDGE_OFFSETS[idx];
}

// ---------------------------------------------------------------------------
// Node contribution
// ---------------------------------------------------------------------------

vec3 node_contribution(vec2 pg, NodeInfo n, float t) {
    float dist        = length(pg - n.cell_uv);
    float node_radius = n.size * BASE_FEATURE_SIZE * 1.3;
    // smoothstep(big, small, dist): 1 at centre, 0 outside radius
    float shape       = smoothstep(node_radius, node_radius * 0.4, dist);
    vec3  col         = palette(fract(n.size * 0.4 + t * 0.03));
    return col * shape * 0.7;
}

// ---------------------------------------------------------------------------
// Edge contribution
// ---------------------------------------------------------------------------

vec3 edge_contribution(vec2 pg, NodeInfo nA, NodeInfo nB,
                        float edge_hash_val, float t) {
    // Branchless existence gate: 0 for ~40% of edges, 1 for ~60%.
    float edge_exists = smoothstep(0.35, 0.45, edge_hash_val);

    // Parametric position along edge (0 = A, 1 = B)
    vec2  ab     = nB.cell_uv - nA.cell_uv;
    vec2  ap     = pg - nA.cell_uv;
    float ab_dot = dot(ab, ab);
    float edge_t = clamp(dot(ap, ab) / ab_dot, 0.0, 1.0);
    vec2  closest = nA.cell_uv + edge_t * ab;
    float dist    = length(pg - closest);

    // Width tapers from nA.size to nB.size — creates depth illusion.
    float width = mix(nA.size, nB.size, edge_t) * BASE_FEATURE_SIZE;
    float shape = smoothstep(width, width * 0.4, dist);

    // Single palette call — edge_hash offsets starting position so neighboring
    // edges sample different palette positions despite similar edge_t values.
    vec3 col = palette(fract(edge_t * 2.5 + t * 0.06 + edge_hash_val * 0.5));

    // Gradient pulse sweeping along the edge at a per-edge phase offset.
    float pulse_pos = fract(t * 0.15 + edge_hash_val);
    float pulse     = smoothstep(0.1, 0.0, abs(edge_t - pulse_pos));

    // Base edge is dim; pulse boosts to peak brightness.
    float brightness = mix(0.4, 1.3, pulse);

    return col * shape * brightness * edge_exists;
}

// ---------------------------------------------------------------------------

void main() {
    float t  = u_time * u_speed_scale;
    vec2  uv = gl_FragCoord.xy / u_resolution.xy;

    // Scrolling cell coordinates — source of apparent node motion.
    vec2 cell_coord  = uv * GRID_SIZE + SCROLL_VELOCITY * t;
    vec2 center_cell = floor(cell_coord);
    // All distances computed in cell-coordinate space for consistent scaling.
    vec2 pg          = cell_coord;

    vec3 color = vec3(0.0);

    // 5×5 cell neighbourhood — required to catch both endpoints of magnitude-2 edges.
    for (float dy = -2.0; dy <= 2.0; dy += 1.0) {
        for (float dx = -2.0; dx <= 2.0; dx += 1.0) {
            vec2     cell = center_cell + vec2(dx, dy);
            NodeInfo n    = get_node(cell);

            color += node_contribution(pg, n, t);

            // One outgoing long-offset edge per cell, direction selected by per-cell hash.
            vec2     offset    = get_cell_offset(cell);
            vec2     dest_cell = cell + offset;
            NodeInfo n_dest    = get_node(dest_cell);
            float    e_hash    = hash_edge(cell, dest_cell);
            color += edge_contribution(pg, n, n_dest, e_hash, t);
        }
    }

    fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
