#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — network.frag
//
// Network monitoring dashboard: 3 parallax layers of nodes with
// always-visible translucent connection lines that pulse in brightness to
// simulate network activity.  ~35 % of connections are active at any moment;
// each fades in/out over 1.5 s on its own independent timer so at most ~3
// change simultaneously — no jarring pop.  Back layers (0) are small, dim, slow;
// front layers (2) are large, bright, and faster.
// 21 nodes total (3 layers × 7), additive compositing over black.
// Nodes rendered as single smoothstep circles (no layered glow) for GPU efficiency.
// Same-layer connections capped at 3 per node; cross-layer at 2 per node.
// Fully stateless GLSL — no per-frame CPU work.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

const int   LAYERS          = 3;
const int   NODES_PER_LAYER = 7;
const float CONN_THRESH     = 0.45;   // same-layer cutoff (tightened from 0.55)
const float CROSS_THRESH    = 0.40;   // cross-layer cutoff

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
//
// Hash values (period, phaseOff) are time-independent — they are constant per
// connection and computed once in the loop before the pixel-distance test, so
// the two hash11 calls are not repeated per pixel inside the hot path.
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

void main() {
    float aspect = u_resolution.x / u_resolution.y;
    vec2  uv     = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec3  col    = vec3(0.0);
    float t      = u_time * u_speed_scale;

    // ---- Pre-compute all node positions ----

    vec2 np[21];   // LAYERS * NODES_PER_LAYER

    for (int L = 0; L < LAYERS; L++) {
        float fL    = float(L);
        float speed = 0.04 + fL * 0.02;   // back: slow drift, front: faster

        for (int j = 0; j < NODES_PER_LAYER; j++) {
            float seed = fL * 137.531 + float(j) * 17.37;

            // Base position spread across screen
            float bx = (hash11(seed + 1.11) - 0.5) * aspect * 0.92;
            float by = (hash11(seed + 2.22) - 0.5) * 0.92;

            // Organic drift — sin/cos at per-node frequencies and phases
            float fx = 0.30 + hash11(seed + 3.33) * 0.50;
            float fy = 0.25 + hash11(seed + 4.44) * 0.40;
            float px = hash11(seed + 5.55) * 6.28318;
            float py = hash11(seed + 6.66) * 6.28318;

            float amp = 0.08 + fL * 0.025;
            float dx  = sin(t * speed * fx + px) * amp;
            float dy  = cos(t * speed * fy + py) * amp * 0.85;

            np[L * NODES_PER_LAYER + j] = vec2(bx + dx, by + dy);
        }
    }

    // ---- Render connection lines (behind nodes) ----

    for (int L = 0; L < LAYERS; L++) {
        float fL   = float(L);
        int   base = L * NODES_PER_LAYER;

        float lineW    = 0.003 + fL * 0.001;   // doubled vs prior version for visibility
        float baseAlph = 0.12 + fL * 0.03;

        // Same-layer connections — cap at 3 per node to bound O(n²) evaluations
        for (int a = 0; a < NODES_PER_LAYER; a++) {
            vec2 pA    = np[base + a];
            int  conns = 0;

            for (int b = a + 1; b < NODES_PER_LAYER; b++) {
                if (conns >= 3) break;
                vec2 pB = np[base + b];
                if (length(pA - pB) > CONN_THRESH) continue;
                conns++;

                float ld = segDist(uv, pA, pB);
                float lg = 1.0 - smoothstep(0.0, lineW, ld);
                if (lg < 0.001) continue;   // skip heavy work for off-line pixels

                float tA = hash11(float(base + a) * 7.77 + 0.5);
                float tB = hash11(float(base + b) * 7.77 + 0.5);
                float ct = (tA + tB) * 0.5;

                float connId   = hash11(float(base + a) * 13.37 + float(base + b) * 7.13);
                float pulseSpd = 0.3 + hash11(connId * 1.23) * 1.2;
                float pulsePh  = hash11(connId * 4.56) * 6.28318;
                float pulse    = sin(t * pulseSpd + pulsePh) * 0.5 + 0.5;

                float connAlpha = connectionAlpha(connId, t);

                float lineAlph = baseAlph + connAlpha * (0.50 - baseAlph) * pulse;
                vec3  lineCol  = mix(palette(ct), vec3(1.0), 0.2 * pulse * connAlpha);
                col += lineCol * lg * lineAlph;
            }
        }

        // Cross-layer connections (L -> L+1) — cap at 2 per node
        if (L < LAYERS - 1) {
            int   baseN  = (L + 1) * NODES_PER_LAYER;
            float crossA = baseAlph * 0.55;
            float crossW = lineW * 0.70;

            for (int a = 0; a < NODES_PER_LAYER; a++) {
                vec2 pA         = np[base + a];
                int  crossConns = 0;

                for (int b = 0; b < NODES_PER_LAYER; b++) {
                    if (crossConns >= 2) break;
                    vec2 pB = np[baseN + b];
                    if (length(pA - pB) > CROSS_THRESH) continue;
                    crossConns++;

                    float ld = segDist(uv, pA, pB);
                    float lg = 1.0 - smoothstep(0.0, crossW, ld);
                    if (lg < 0.001) continue;

                    float tA = hash11(float(base + a) * 7.77 + 0.5);
                    float tB = hash11(float(baseN + b) * 7.77 + 0.5);
                    float ct = (tA + tB) * 0.5;

                    float connId    = hash11(float(base + a) * 23.37 + float(baseN + b) * 5.13);
                    float pulseSpd  = 0.3 + hash11(connId * 1.23) * 1.2;
                    float pulsePh   = hash11(connId * 4.56) * 6.28318;
                    float pulse     = sin(t * pulseSpd + pulsePh) * 0.5 + 0.5;

                    float connAlpha = connectionAlpha(connId, t);

                    float lineAlph = crossA + connAlpha * (0.35 - crossA) * pulse;
                    vec3  lineCol  = mix(palette(ct), vec3(1.0), 0.2 * pulse * connAlpha);
                    col += lineCol * lg * lineAlph;
                }
            }
        }
    }

    // ---- Render nodes (on top of connections) — single smoothstep, no glow layer ----

    for (int L = 0; L < LAYERS; L++) {
        float fL   = float(L);
        int   base = L * NODES_PER_LAYER;

        float minDim = min(u_resolution.x, u_resolution.y);
        // Layer size multipliers: back=1×, mid=1.8×, front=3× — deepens parallax.
        float lscale = (L == 2) ? 3.00 : (L == 1) ? 1.80 : 1.00;
        float nodeR  = (2.5 + fL * 1.8) / minDim * lscale;
        float bright = 0.45 + fL * 0.18;

        for (int j = 0; j < NODES_PER_LAYER; j++) {
            vec2  pos  = np[base + j];
            float dist = length(uv - pos);

            if (dist > nodeR) continue;

            float phase = hash11(float(base + j) * 91.73 + 3.33) * 6.28318;
            float pulse = 0.85 + 0.15 * sin(t * 1.2 + phase);

            float pt        = hash11(float(base + j) * 7.77 + 0.5);
            float intensity = 1.0 - smoothstep(nodeR * 0.85, nodeR, dist);
            col += palette(pt) * intensity * bright * pulse;
        }
    }

    fragColor = vec4(col, 1.0);
}
