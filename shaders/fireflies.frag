#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — fireflies.frag
//
// Warm glowing wanderers drifting across a dark field. Grid-based spatial
// lookup (20×12 cells): one firefly per cell. Each pixel sums contributions
// from its own cell and the 8 surrounding neighbours — 9 Gaussian evaluations
// total, no per-pixel loops over all fireflies.
//
// Each firefly wanders on a slow per-cell Lissajous path (amplitude ±0.35 of
// cell size — stays safely inside the 9-cell neighbourhood). Brightness pulses
// at a per-cell frequency. Accumulated intensity maps directly to palette(t),
// so warm palettes read as cozy amber fireflies, cool palettes as bioluminescent
// deep-sea drifters.
//
// Perf: no sqrt in the inner loop (squared Gaussian), 9 iterations, no
// branching per pixel. Target <30% GPU on HawkPoint1.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const vec2  GRID      = vec2(20.0, 12.0);
const float FALLOFF_K = 120.0;   // Gaussian width in squared cell-space units
const float TAU       = 6.283185307;

// ---------------------------------------------------------------------------
// Hash — Dave Hoskins style, no sin()
// ---------------------------------------------------------------------------

float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

void main() {
    vec2 uv       = gl_FragCoord.xy / u_resolution.xy;
    vec2 cell     = uv * GRID;
    vec2 cell_id  = floor(cell);
    vec2 cell_frac = fract(cell);

    float t = u_time * u_speed_scale;
    float intensity = 0.0;

    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            vec2 nid = cell_id + vec2(float(dx), float(dy));

            float h  = hash21(nid);
            float h2 = hash21(nid + vec2(17.3, 5.7));

            // Lissajous wander — amplitude capped at ±0.35 so firefly stays
            // within the 9-cell neighbourhood and never pops at boundaries.
            vec2 offset = 0.35 * vec2(
                sin(t * (0.3 + 0.3 * h)  + h  * TAU),
                cos(t * (0.2 + 0.4 * h2) + h2 * TAU * 1.3)
            );

            // Firefly position relative to the current cell's origin.
            vec2 firefly_pos = vec2(float(dx), float(dy)) + 0.5 + offset;
            vec2 d           = cell_frac - firefly_pos;
            float r2         = dot(d, d);

            // Brightness pulse — never fully dark (min 0.4) so fireflies are
            // always faintly visible even at trough.
            float pulse = 0.4 + 0.6 * (0.5 + 0.5 * sin(
                t * (0.3 + 0.5 * h) + h * TAU
            ));

            intensity += pulse * exp(-r2 * FALLOFF_K);
        }
    }

    float clamped = clamp(intensity, 0.0, 1.0);
    fragColor = vec4(palette(clamped), 1.0);
}
