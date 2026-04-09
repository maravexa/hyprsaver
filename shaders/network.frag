#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — network.frag
//
// Neural network / node graph visualization with parallax depth.  Five layers
// of glowing nodes drift across the screen with organic floating motion.
// Thin lines connect nearby nodes within and across adjacent layers.  Small
// bright data packets travel along connections with comet tails, creating a
// living neural network with visible signal propagation.  Back layers (0)
// are small, dim, and slow; front layers (4) are large, bright, and faster.
// 40 nodes total (5 layers x 8), additive compositing over black.  Fully
// stateless GLSL — no per-frame CPU work.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

const int   LAYERS          = 5;
const int   NODES_PER_LAYER = 8;
const float CONN_THRESH     = 0.35;   // max distance for same-layer connection
const float CROSS_THRESH    = 0.28;   // max distance for cross-layer connection

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

    // ---- Render connections + data packets (behind nodes) ----

    for (int L = 0; L < LAYERS; L++) {
        float fL   = float(L);
        int   base = L * NODES_PER_LAYER;

        float lineW     = 0.0012 + fL * 0.0004;
        float connAlpha = 0.10 + fL * 0.06;

        // Same-layer connections
        for (int a = 0; a < NODES_PER_LAYER; a++) {
            vec2 pA = np[base + a];

            for (int b = a + 1; b < NODES_PER_LAYER; b++) {
                vec2  pB = np[base + b];
                float d  = length(pA - pB);
                if (d > CONN_THRESH) continue;

                float ld   = segDist(uv, pA, pB);
                float lg   = smoothstep(lineW, 0.0, ld);
                float fade = 1.0 - d / CONN_THRESH;
                fade *= fade;   // quadratic falloff

                float ct = fract(hash11(float(base + a) * 7.77) * 0.5
                                + hash11(float(base + b) * 7.77) * 0.5);
                col += palette(ct) * lg * fade * connAlpha;

                // ---- Data packet ----
                float cid  = hash11(float(base + a) * 13.37
                                   + float(base + b) * 7.13);
                float dur  = 2.5 + cid * 3.0;        // 2.5–5.5 s per trip
                float cyc  = floor(t / dur);

                if (hash11(cid * 100.0 + cyc) > 0.35) {
                    float prog = fract(t / dur);
                    // Alternate direction per cycle
                    float dirH = hash11(cid * 200.0 + cyc);
                    vec2 src = (dirH > 0.5) ? pA : pB;
                    vec2 dst = (dirH > 0.5) ? pB : pA;

                    float pkR = 0.0025 + fL * 0.0008;

                    // Head — bright white dot
                    vec2  pkP = mix(src, dst, prog);
                    float pkD = length(uv - pkP);
                    col += vec3(1.0) * exp(-pkD * pkD / (pkR * pkR))
                           * connAlpha * 3.5;

                    // Comet tail — 3 trailing samples
                    for (int s = 1; s <= 3; s++) {
                        float tp = prog - float(s) * 0.04;
                        if (tp < 0.0) continue;
                        vec2  tP = mix(src, dst, tp);
                        float tD = length(uv - tP);
                        float tf = 1.0 - float(s) / 4.0;
                        col += palette(ct)
                             * exp(-tD * tD / (pkR * pkR * 0.7))
                             * connAlpha * 2.0 * tf;
                    }
                }
            }
        }

        // Cross-layer connections (L -> L+1)
        if (L < LAYERS - 1) {
            int   baseN  = (L + 1) * NODES_PER_LAYER;
            float crossA = connAlpha * 0.45;
            float crossW = lineW * 0.65;

            for (int a = 0; a < NODES_PER_LAYER; a++) {
                vec2 pA = np[base + a];

                for (int b = 0; b < NODES_PER_LAYER; b++) {
                    vec2  pB = np[baseN + b];
                    float d  = length(pA - pB);
                    if (d > CROSS_THRESH) continue;

                    float ld   = segDist(uv, pA, pB);
                    float lg   = smoothstep(crossW, 0.0, ld);
                    float fade = 1.0 - d / CROSS_THRESH;
                    fade *= fade;

                    float ct = hash11(float(base + a) * 11.11
                                     + float(baseN + b) * 3.33);
                    col += palette(ct) * lg * fade * crossA;

                    // Cross-layer packet (head only — no tail for perf)
                    float cid = hash11(float(base + a) * 23.37
                                      + float(baseN + b) * 5.13);
                    float dur = 3.0 + cid * 3.0;
                    float cyc = floor(t / dur);
                    if (hash11(cid * 100.0 + cyc) > 0.50) {
                        float prog = fract(t / dur);
                        vec2  pkP  = mix(pA, pB, prog);
                        float pkD  = length(uv - pkP);
                        float pkR  = 0.002 + fL * 0.0006;
                        col += vec3(1.0)
                             * exp(-pkD * pkD / (pkR * pkR))
                             * crossA * 3.0;
                    }
                }
            }
        }
    }

    // ---- Render nodes (on top of connections) ----

    for (int L = 0; L < LAYERS; L++) {
        float fL   = float(L);
        int   base = L * NODES_PER_LAYER;

        float minDim = min(u_resolution.x, u_resolution.y);
        float nodeR  = (2.5 + fL * 1.8) / minDim;    // ~2.5 px back, ~9.7 px front
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
