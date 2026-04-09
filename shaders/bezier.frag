#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — bezier.frag
//
// Five animated cubic Bézier curves rendered simultaneously. Each curve has
// four control points that drift slowly via sine / cosine oscillation at
// independent frequencies in the 0.1 – 0.3 Hz range, producing organic,
// flowing motion. Control points stay within [-1.2, 1.2] normalized space.
//
// Per-pixel minimum distance is computed by sampling 256 parametric points
// along t ∈ [0, 1] for each curve. Two glow layers are blended additively:
//   • Primary:   exp(-d² × 200) — thin, bright core line
//   • Secondary: exp(-d² × 50) × 0.3 — soft bloom halo at 2× width
//
// Curve hue cycles slowly using palette(curve_index/5.0 + time×0.03) so
// any palette produces a distinct multi-colour result. Background is (0.02).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// Evaluate a cubic Bézier at parameter t ∈ [0, 1].
vec2 cubic_bezier(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
    float u = 1.0 - t;
    return u*u*u * p0
         + 3.0*u*u*t * p1
         + 3.0*u*t*t * p2
         + t*t*t * p3;
}

// Minimum distance from uv to the curve via 256-sample brute-force search.
float bezier_dist(vec2 p0, vec2 p1, vec2 p2, vec2 p3, vec2 uv) {
    float min_d2 = 1.0e9;
    for (int i = 0; i < 256; i++) {
        float t  = float(i) / 255.0;
        vec2  pt = cubic_bezier(p0, p1, p2, p3, t);
        vec2  dv = uv - pt;
        min_d2 = min(min_d2, dot(dv, dv));
    }
    return sqrt(min_d2);
}

void main() {
    float T = u_time * u_speed_scale;

    // Aspect-correct, Y-normalised UV (visible range ≈ ±0.89 × ±0.50 @ 16:9).
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    uv /= u_zoom_scale;

    vec3 col = vec3(0.02);

    for (int ci = 0; ci < 5; ci++) {
        float cf = float(ci);

        // Per-curve phase offset (2π/5 ≈ 1.2566 rad between curves).
        float ph = cf * 1.25664;

        // Independent oscillation frequencies in [0.10, 0.28] Hz.
        float fa = 0.10 + cf * 0.04;   // 0.10 / 0.14 / 0.18 / 0.22 / 0.26 Hz
        float fb = 0.13 + cf * 0.03;   // 0.13 / 0.16 / 0.19 / 0.22 / 0.25 Hz
        float fc = 0.27 - cf * 0.03;   // 0.27 / 0.24 / 0.21 / 0.18 / 0.15 Hz
        float fd = 0.20 + cf * 0.02;   // 0.20 / 0.22 / 0.24 / 0.26 / 0.28 Hz

        // Y centre staggered so curves span the visible area.
        float cy = (cf - 2.0) * 0.22;  // -0.44, -0.22, 0.0, 0.22, 0.44

        // Control points oscillate around base positions; all stay in [-1.2, 1.2].
        vec2 p0 = vec2(
            -1.10 + 0.10 * sin(T * fa * 6.28318 + ph),
             cy   + 0.35 * cos(T * fb * 6.28318 + ph)
        );
        vec2 p1 = vec2(
            -0.35 + 0.35 * cos(T * fb * 6.28318 + ph + 1.5),
             cy   + 0.55 * sin(T * fc * 6.28318 + ph + 0.7)
        );
        vec2 p2 = vec2(
             0.35 + 0.35 * sin(T * fc * 6.28318 + ph + 2.3),
             cy   + 0.55 * cos(T * fd * 6.28318 + ph + 1.1)
        );
        vec2 p3 = vec2(
             1.10 + 0.10 * cos(T * fd * 6.28318 + ph + 0.9),
             cy   + 0.35 * sin(T * fa * 6.28318 + ph + 2.0)
        );

        float dist = bezier_dist(p0, p1, p2, p3, uv);

        // Primary glow: thin bright core.
        float glow  = exp(-dist * dist * 200.0);
        // Secondary glow: soft bloom at 2× width, 0.3× intensity.
        float bloom = exp(-dist * dist * 50.0) * 0.3;

        vec3 curve_col = palette(cf / 5.0 + T * 0.03);
        col += curve_col * (glow + bloom);
    }

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
