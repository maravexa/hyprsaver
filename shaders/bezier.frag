#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — bezier.frag
//
// Six animated cubic Bézier curves rendered simultaneously. Each curve has
// four control points that drift slowly via sine / cosine oscillation at
// independent frequencies in the 0.1 – 0.3 Hz range, producing organic,
// flowing motion. Control points stay within [-1.2, 1.2] normalized space.
//
// Per-pixel minimum distance is computed by sampling 128 parametric points
// along t ∈ [0, 1] for each curve. Hard-edged smoothstep lines replace the
// original Gaussian glow, and a per-curve AABB test skips most curves for
// most pixels.
//
// Optimisations vs v0.3.0:
//   • smoothstep hard edges instead of exp(-d²×400) Gaussian glow
//   • Secondary bloom pass removed entirely
//   • Per-curve AABB early rejection — skips most curves for most pixels
//   • Curve count reduced 8 → 6 (25% fewer distance loop iterations)
//   • Sample count reduced 256 → 128 (50% fewer samples per curve)
//   • Net: 6×128 = 768 checks vs previous 8×256 = 2048 (−63%)
//
// Curve hue cycles slowly using palette(curve_index/6.0 + time×0.03) so
// any palette produces a distinct multi-colour result. Background is (0.02).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_alpha;

const float LINE_WIDTH  = 0.0036;
const float AABB_MARGIN = 0.05;

// Evaluate a cubic Bézier at parameter t ∈ [0, 1].
vec2 cubic_bezier(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
    float u = 1.0 - t;
    return u*u*u * p0
         + 3.0*u*u*t * p1
         + 3.0*u*t*t * p2
         + t*t*t * p3;
}

// Minimum distance from uv to the curve via 128-sample brute-force search.
float bezier_dist(vec2 p0, vec2 p1, vec2 p2, vec2 p3, vec2 uv) {
    float min_d2 = 1.0e9;
    for (int i = 0; i < 128; i++) {
        float t  = float(i) / 127.0;
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

    vec3  col    = vec3(0.02);
    float thresh = LINE_WIDTH + AABB_MARGIN;

    for (int ci = 0; ci < 6; ci++) {
        float cf = float(ci);

        // Per-curve phase offset (2π/6 ≈ 1.0472 rad between curves).
        float ph = cf * 1.04720;

        // Independent oscillation frequencies in [0.10, 0.28] Hz.
        // Step sizes chosen so all 6 curves stay within range.
        float fa = 0.10 + cf * 0.030;  // 0.100 / 0.130 / 0.160 / 0.190 / 0.220 / 0.250 Hz
        float fb = 0.12 + cf * 0.028;  // 0.120 / 0.148 / 0.176 / 0.204 / 0.232 / 0.260 Hz
        float fc = 0.28 - cf * 0.030;  // 0.280 / 0.250 / 0.220 / 0.190 / 0.160 / 0.130 Hz
        float fd = 0.17 + cf * 0.020;  // 0.170 / 0.190 / 0.210 / 0.230 / 0.250 / 0.270 Hz

        // Y centre staggered so curves span the visible area.
        float cy = (cf - 2.5) * 0.16;  // -0.400, -0.240, -0.080, 0.080, 0.240, 0.400

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

        // AABB early rejection: skip this curve if the pixel lies outside the
        // axis-aligned bounding box of the control-point hull, expanded by
        // LINE_WIDTH + AABB_MARGIN. Skips most curves for most pixels.
        vec2 bb_min = min(min(p0, p1), min(p2, p3)) - vec2(thresh);
        vec2 bb_max = max(max(p0, p1), max(p2, p3)) + vec2(thresh);
        if (uv.x < bb_min.x || uv.x > bb_max.x ||
            uv.y < bb_min.y || uv.y > bb_max.y) continue;

        float dist = bezier_dist(p0, p1, p2, p3, uv);

        // Hard-edged anti-aliased line (replaces expensive Gaussian glow).
        float intensity = 1.0 - smoothstep(0.0, LINE_WIDTH, dist);

        vec3 curve_col = palette(cf / 6.0 + T * 0.03);
        col += curve_col * intensity;
    }

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
