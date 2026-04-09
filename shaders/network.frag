#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — network.frag
//
// Network monitoring dashboard: 4 parallax layers of glowing nodes with
// always-visible translucent connection lines that pulse in brightness to
// simulate network activity.  ~35 % of lines pulse at any moment, rotating
// slowly on a per-layer cycle.  Back layers (0) are small, dim, and slow;
// front layers (3) are large, bright, and faster.
// 40 nodes total (4 layers × 10), additive compositing over black.
// Fully stateless GLSL — no per-frame CPU work.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

const int   LAYERS          = 4;
const int   NODES_PER_LAYER = 10;
const float CONN_THRESH     = 0.55;   // generous same-layer cutoff (~1/3 screen width)
const float CROSS_THRESH    = 0.42;   // cross-layer cutoff

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

void main() {
    float aspect = u_resolution.x / u_resolution.y;
    vec2  uv     = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec3  col    = vec3(0.0);
    float t      = u_time * u_speed_scale;

    // ---- Pre-compute all node positions ----

    vec2 np[40];   // LAYERS * NODES_PER_LAYER

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

        float lineW    = 0.0012 + fL * 0.0004;
        float baseAlph = 0.12 + fL * 0.03;   // slightly brighter on front layers

        // Activity rotation: different cycle length per layer keeps layers de-synced
        float cycleDur  = 8.0 + fL * 2.0;
        float cycleSeed = floor(t / cycleDur);

        // Same-layer connections
        for (int a = 0; a < NODES_PER_LAYER; a++) {
            vec2 pA = np[base + a];

            for (int b = a + 1; b < NODES_PER_LAYER; b++) {
                vec2  pB = np[base + b];
                if (length(pA - pB) > CONN_THRESH) continue;

                float ld = segDist(uv, pA, pB);
                float lg = smoothstep(lineW, 0.0, ld);
                if (lg < 0.001) continue;   // skip heavy work for off-line pixels

                // Color: average palette t of the two endpoint nodes
                float tA = hash11(float(base + a) * 7.77 + 0.5);
                float tB = hash11(float(base + b) * 7.77 + 0.5);
                float ct = (tA + tB) * 0.5;

                // Per-connection pulse (speed 0.3–1.5, staggered phase)
                float connId   = hash11(float(base + a) * 13.37 + float(base + b) * 7.13);
                float pulseSpd = 0.3 + hash11(connId * 1.23) * 1.2;
                float pulsePh  = hash11(connId * 4.56) * 6.28318;
                float pulse    = sin(t * pulseSpd + pulsePh) * 0.5 + 0.5;

                // ~35 % of connections active per cycle window
                float actHash = hash11(connId + cycleSeed * 17.11);
                float active  = step(actHash, 0.35);

                float lineAlph = baseAlph + active * (0.50 - baseAlph) * pulse;
                vec3  lineCol  = mix(palette(ct), vec3(1.0), 0.2 * pulse * active);

                col += lineCol * lg * lineAlph;
            }
        }

        // Cross-layer connections (L -> L+1)
        if (L < LAYERS - 1) {
            int   baseN  = (L + 1) * NODES_PER_LAYER;
            float crossA = baseAlph * 0.55;
            float crossW = lineW * 0.70;

            for (int a = 0; a < NODES_PER_LAYER; a++) {
                vec2 pA = np[base + a];

                for (int b = 0; b < NODES_PER_LAYER; b++) {
                    vec2  pB = np[baseN + b];
                    if (length(pA - pB) > CROSS_THRESH) continue;

                    float ld = segDist(uv, pA, pB);
                    float lg = smoothstep(crossW, 0.0, ld);
                    if (lg < 0.001) continue;

                    float tA = hash11(float(base + a) * 7.77 + 0.5);
                    float tB = hash11(float(baseN + b) * 7.77 + 0.5);
                    float ct = (tA + tB) * 0.5;

                    float connId   = hash11(float(base + a) * 23.37 + float(baseN + b) * 5.13);
                    float pulseSpd = 0.3 + hash11(connId * 1.23) * 1.2;
                    float pulsePh  = hash11(connId * 4.56) * 6.28318;
                    float pulse    = sin(t * pulseSpd + pulsePh) * 0.5 + 0.5;

                    float actHash = hash11(connId + cycleSeed * 17.11);
                    float active  = step(actHash, 0.35);

                    float lineAlph = crossA + active * (0.35 - crossA) * pulse;
                    vec3  lineCol  = mix(palette(ct), vec3(1.0), 0.2 * pulse * active);

                    col += lineCol * lg * lineAlph;
                }
            }
        }
    }

    // ---- Render nodes (on top of connections) ----

    for (int L = 0; L < LAYERS; L++) {
        float fL   = float(L);
        int   base = L * NODES_PER_LAYER;

        float minDim = min(u_resolution.x, u_resolution.y);
        // Layer size multipliers: back=1×, L1=1.5×, L2=2.25×, front=3× — deepens parallax.
        float lscale = (L == 3) ? 3.00 : (L == 2) ? 2.25 : (L == 1) ? 1.50 : 1.00;
        float nodeR  = (2.5 + fL * 1.8) / minDim * lscale;
        float bright = 0.45 + fL * 0.18;

        for (int j = 0; j < NODES_PER_LAYER; j++) {
            vec2  pos  = np[base + j];
            float dist = length(uv - pos);

            // Subtle pulse
            float phase = hash11(float(base + j) * 91.73 + 3.33) * 6.28318;
            float pulse = 0.85 + 0.15 * sin(t * 1.2 + phase);

            // Outer glow — palette-colored
            float glow = exp(-dist * dist / (nodeR * nodeR));
            float pt   = hash11(float(base + j) * 7.77 + 0.5);
            col += palette(pt) * glow * bright * pulse;

            // Bright core — white
            float coreR = nodeR * 0.30;
            col += vec3(1.0) * exp(-dist * dist / (coreR * coreR))
                   * bright * 0.35 * pulse;
        }
    }

    fragColor = vec4(col, 1.0);
}
