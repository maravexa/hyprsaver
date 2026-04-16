#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — network.frag
//
// Neural network node graph with glowing connections.  Three parallax layers
// of nodes placed on regular grids (4×3 back, 3×2 mid, 2×2 front) with small
// hash-based offsets for organic feel and slow sinusoidal drift.  Fixed
// grid-neighbour topology (right / below / diagonal) replaces the former
// random-position + O(n²) distance-threshold approach, giving even screen
// coverage with a bounded, predictable edge set.
//
// 22 nodes total: 12 back + 6 mid + 4 front.
// ~25 grid edges per frame, independent connection lifecycle fades (~35 %
// active at any moment).  Additive compositing over black.
// Fully stateless GLSL — no per-frame CPU work.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

const int LAYERS = 3;

// Grid dimensions per layer:
//   Layer 0 (back):  4 cols × 3 rows = 12 nodes — dense, dim, slow
//   Layer 1 (mid):   3 cols × 2 rows =  6 nodes — medium
//   Layer 2 (front): 2 cols × 2 rows =  4 nodes — sparse, bright, fast
// Total: 22 nodes
const int GRID_COLS[3]    = int[3](4, 3, 2);
const int GRID_ROWS[3]    = int[3](3, 2, 2);
const int LAYER_OFFSET[3] = int[3](0, 12, 18);
const int LAYER_NODES[3]  = int[3](12, 6, 4);

// ---------------------------------------------------------------------------
// Hash — float -> float in [0, 1)
// ---------------------------------------------------------------------------

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

// ---------------------------------------------------------------------------
// Distance from point p to line segment a–b
// ---------------------------------------------------------------------------

float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}

// ---------------------------------------------------------------------------
// Per-connection lifecycle alpha — smooth fade in/out, no global-cycle pops.
//
// Each connection has its own pseudo-random period (10–25 s) and a staggered
// phase offset so starts are not synchronised across the network.  Connections
// are "active" (bright) for 35 % of their period and spend 1.5 s fading in at
// the start of that window and 1.5 s fading out at the end.
// ---------------------------------------------------------------------------

float connectionAlpha(float connId, float t) {
    float period    = 10.0 + hash11(connId * 7.77) * 15.0;   // 10–25 s per connection
    float phaseOff  = hash11(connId * 13.17) * period;        // stagger: no two sync'd
    float phase     = mod(t + phaseOff, period);              // 0..period
    float activeEnd = 0.35 * period;                          // active 35 % of period
    float fadeDur   = 1.5;                                    // 1.5 s fade-in AND fade-out
    return smoothstep(0.0, fadeDur, phase) *
           (1.0 - smoothstep(activeEnd - fadeDur, activeEnd, phase));
}

// ---------------------------------------------------------------------------
// Render a single grid edge into col.
// idxA / idxB are absolute indices into np[] (offset already added).
// ---------------------------------------------------------------------------

void drawEdge(vec2 uv, vec2 pA, vec2 pB, int idxA, int idxB,
              float lineW, float baseAlph, float t, inout vec3 col) {
    float ld = segDist(uv, pA, pB);
    float lg = 1.0 - smoothstep(0.0, lineW, ld);
    if (lg < 0.001) return;

    float connId    = hash11(float(idxA) * 13.37 + float(idxB) * 7.13);
    float tA        = hash11(float(idxA) * 7.77 + 0.5);
    float tB        = hash11(float(idxB) * 7.77 + 0.5);
    float ct        = (tA + tB) * 0.5;
    float pulseSpd  = 0.3 + hash11(connId * 1.23) * 1.2;
    float pulsePh   = hash11(connId * 4.56) * 6.28318;
    float pulse     = sin(t * pulseSpd + pulsePh) * 0.5 + 0.5;
    float connAlpha = connectionAlpha(connId, t);

    float lineAlph  = baseAlph + connAlpha * (0.50 - baseAlph) * pulse;
    vec3  lineCol   = mix(palette(ct), vec3(1.0), 0.2 * pulse * connAlpha);
    col += lineCol * lg * lineAlph;
}

// ---------------------------------------------------------------------------

void main() {
    float aspect = u_resolution.x / u_resolution.y;
    vec2  uv     = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec3  col    = vec3(0.0);
    float t      = u_time * u_speed_scale;

    // ---- Pre-compute all node positions (22 total) ----

    vec2 np[22];

    for (int L = 0; L < LAYERS; L++) {
        float fL     = float(L);
        int   cols   = GRID_COLS[L];
        int   rows   = GRID_ROWS[L];
        int   offset = LAYER_OFFSET[L];
        float speed  = 0.04 + fL * 0.02;   // back: slow drift, front: faster
        float expand = 1.35;               // 35% overscan — nodes extend past all screen edges
        float grid_w = aspect * expand;
        float grid_h = 1.0   * expand;
        float cell_w = grid_w / float(cols);
        float cell_h = grid_h / float(rows);

        for (int r = 0; r < 3; r++) {      // max rows = 3
            if (r >= rows) break;
            for (int c = 0; c < 4; c++) {  // max cols = 4
                if (c >= cols) break;

                int   ni   = r * cols + c;          // local index within layer
                float seed = fL * 137.531 + float(ni) * 17.37;

                // Regular grid position, centred on expanded area
                float bx = (float(c) + 0.5) * cell_w - grid_w * 0.5;
                float by = (float(r) + 0.5) * cell_h - grid_h * 0.5;

                // Small hash-based offset — keeps nodes near their cell centre
                float ox = (hash11(seed + 1.11) - 0.5) * cell_w * 0.5;
                float oy = (hash11(seed + 2.22) - 0.5) * cell_h * 0.5;

                // Slow organic drift
                float fx  = 0.30 + hash11(seed + 3.33) * 0.50;
                float fy  = 0.25 + hash11(seed + 4.44) * 0.40;
                float px  = hash11(seed + 5.55) * 6.28318;
                float py  = hash11(seed + 6.66) * 6.28318;
                float amp = 0.04 + fL * 0.015;
                float dx  = sin(t * speed * fx + px) * amp;
                float dy  = cos(t * speed * fy + py) * amp * 0.85;

                np[offset + ni] = vec2(bx + ox + dx, by + oy + dy);
            }
        }
    }

    // ---- Render connection lines (behind nodes) ----
    //
    // Fixed grid topology: each node connects to its right, below, and
    // diagonal (right+below) neighbour.  No distance threshold needed.

    for (int L = 0; L < LAYERS; L++) {
        float fL     = float(L);
        int   cols   = GRID_COLS[L];
        int   rows   = GRID_ROWS[L];
        int   offset = LAYER_OFFSET[L];
        float lineW  = 0.009 + fL * 0.003;
        float baseA  = 0.12 + fL * 0.03;

        for (int r = 0; r < 3; r++) {
            if (r >= rows) break;
            for (int c = 0; c < 4; c++) {
                if (c >= cols) break;

                int  a  = r * cols + c;
                vec2 pA = np[offset + a];

                // Horizontal edge: node → right neighbour
                if (c + 1 < cols) {
                    int b = r * cols + (c + 1);
                    drawEdge(uv, pA, np[offset + b],
                             offset + a, offset + b, lineW, baseA, t, col);
                }

                // Vertical edge: node → below neighbour
                if (r + 1 < rows) {
                    int b = (r + 1) * cols + c;
                    drawEdge(uv, pA, np[offset + b],
                             offset + a, offset + b, lineW, baseA, t, col);
                }

                // Diagonal edge: node → right-below neighbour
                if (c + 1 < cols && r + 1 < rows) {
                    int b = (r + 1) * cols + (c + 1);
                    drawEdge(uv, pA, np[offset + b],
                             offset + a, offset + b, lineW, baseA, t, col);
                }
            }
        }
    }

    // ---- Render nodes (on top of connections) ----

    for (int L = 0; L < LAYERS; L++) {
        float fL     = float(L);
        int   nNodes = LAYER_NODES[L];
        int   offset = LAYER_OFFSET[L];

        float minDim = min(u_resolution.x, u_resolution.y);
        // Size multipliers: back=1×, mid=1.8×, front=3× — deepens parallax
        float lscale = (L == 2) ? 3.00 : (L == 1) ? 1.80 : 1.00;
        float nodeR  = (2.5 + fL * 1.8) / minDim * lscale;
        float r2     = nodeR * nodeR;
        float bright = 0.45 + fL * 0.18;

        for (int j = 0; j < 12; j++) {     // max nodes per layer = 12
            if (j >= nNodes) break;

            vec2  pos   = np[offset + j];
            vec2  dv    = uv - pos;
            float dist2 = dot(dv, dv);
            if (dist2 > r2) continue;
            float dist = sqrt(dist2);

            float phase = hash11(float(offset + j) * 91.73 + 3.33) * 6.28318;
            float pulse = 0.85 + 0.15 * sin(t * 1.2 + phase);

            float pt        = hash11(float(offset + j) * 7.77 + 0.5);
            float intensity = 1.0 - smoothstep(nodeR * 0.85, nodeR, dist);
            col += palette(pt) * intensity * bright * pulse;
        }
    }

    fragColor = vec4(col, 1.0);
}
