#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — fibonacci.frag
//
// Phyllotaxis: the sunflower / pine-cone seed arrangement. Seed n sits at
// polar (r = c·√n, θ = n·137.508°) — the golden angle — which packs seeds so
// the eye reads consecutive Fibonacci numbers of spiral arms (13, 21, 34…).
//
// Animation: the head "grows" — a continuous index offset pushes every seed
// outward while new seeds are born at the centre — and the whole pattern
// slowly rotates. Colour follows the 21-arm parastichy family with a slow
// radial drift and a brightness pulse travelling along the arms. A faint
// golden log-spiral (radius × φ every quarter turn) is overlaid.
//
// Cost model: per pixel we only visit the seeds that can be within reach —
// the index band |Δn| ≤ 2·r/c around the ring at the pixel's own radius,
// which is a handful near the centre and ~50 at the screen edge. No
// per-pixel loop over all seeds.
//
// u_speed_scale — animation speed multiplier (injected by prepare_shader)
// u_zoom_scale  — seed spacing multiplier   (injected by prepare_shader)
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;

const float GOLDEN_ANGLE = 2.399963229728653;   // 2π·(2 − φ) rad ≈ 137.508°
const float PHI          = 1.618033988749895;
const float TAU          = 6.283185307179586;
const float SEED_SPACING = 0.040;               // c in r = c·√n (screen height = 1)
const int   MAX_WINDOW   = 56;                  // per-side index band cap

// Dave Hoskins fract hash — kept per-shader on purpose (see CLAUDE.md).
float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

// Triangle-wrap: reverses direction at the seam so directional palettes
// never show a hard discontinuity.
float triwrap(float x) {
    return abs(fract(x * 0.5) * 2.0 - 1.0);
}

void main() {
    vec2  uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t  = u_time * u_speed_scale;

    float c    = SEED_SPACING * u_zoom_scale;
    float grow = t * 0.8;      // seeds born per second
    float rot  = -t * 0.06;    // global rotation, rad/s

    float r = length(uv);

    // ── Seeds ──────────────────────────────────────────────────────────────
    // Age a = k + grow: seed k is born (a = 0) at the centre and drifts out.
    // The ring at this pixel's radius has age (r/c)²; seeds within one
    // spacing of the pixel have |Δa| ≤ 2·r/c + 1.
    float a_est  = (r * r) / (c * c);
    int   k0     = int(floor(a_est - grow + 0.5));
    int   window = min(MAX_WINDOW, int(2.0 * r / c) + 3);

    vec3 col = vec3(0.0);
    for (int i = -window; i <= window; i++) {
        float k = float(k0 + i);
        float a = k + grow;
        if (a < 0.0) continue;                       // not born yet

        float sa = sqrt(a);                          // ∝ radius, smooth across neighbours
        float rs = c * sa;
        float an = k * GOLDEN_ANGLE + rot;
        vec2  d  = uv - rs * vec2(cos(an), sin(an));
        float d2 = dot(d, d);

        // Seeds pop in over their first two units of age, then ripen: young
        // seeds near the centre are small, mature seeds at the rim are larger.
        float rad   = c * (0.30 + 0.16 * smoothstep(0.0, 400.0, a)) * smoothstep(0.0, 2.0, a);
        float reach = 2.0 * rad;
        if (d2 > reach * reach) continue;

        float dist = sqrt(d2);
        float core = 1.0 - smoothstep(rad * 0.7, rad, dist);
        float halo = exp(-d2 / (rad * rad)) * 0.30;

        // Colour by the seed's own angle (a colour wheel that turns with the
        // head) plus a slow radial drift so colour streams outward with the
        // growth. Triangle wave over one turn: forward through the palette on
        // the first half-turn, backward on the second — continuous around the
        // circle, so directional palettes show no seam. Note the drift uses
        // √a (∝ radius): spatially adjacent seeds differ by 34 or 55 in index,
        // so anything keyed on the raw index scrambles into confetti.
        float hue   = abs(fract(an / TAU + sa * 0.02) * 2.0 - 1.0);
        float pulse = 0.80 + 0.20 * sin(sa * 0.9 - t * 1.6);
        float twink = 0.92 + 0.08 * sin(t * 2.7 + hash11(k) * TAU);

        col += palette(hue) * (core + halo) * pulse * twink * 1.35;
    }

    // ── Golden spiral overlay ─────────────────────────────────────────────
    // r = A·e^{bθ} with b = ln φ / (π/2): the radius grows by φ every quarter
    // turn. In log-polar space the spiral is a straight line repeating every
    // 2πb in ln r; the distance to the nearest branch, scaled back by r,
    // gives an approximately constant on-screen line width.
    float b     = log(PHI) / (TAU * 0.25);
    float theta = atan(uv.y, uv.x) - rot;
    float rho   = log(max(r, 1e-4));
    float phase = (rho - b * theta + t * 0.12) / (TAU * b);
    float dl    = abs(fract(phase) - 0.5) * (TAU * b);      // distance in ln r
    float de    = r * dl / sqrt(1.0 + b * b);               // ≈ euclidean
    float line  = 1.0 - smoothstep(0.0025, 0.0065, de);
    line *= smoothstep(0.03, 0.12, r);                      // hide the pole
    col += palette(triwrap(rho * 0.35 + t * 0.03)) * line * 0.28;

    // ── Soft centre glow, edge fade, tone-map ─────────────────────────────
    col += palette(0.08) * 0.05 * exp(-r * r * 9.0);
    col *= 1.0 - 0.85 * smoothstep(0.62, 1.02, r);
    col  = 1.0 - exp(-col * 1.5);

    fragColor = vec4(col, 1.0);
}
