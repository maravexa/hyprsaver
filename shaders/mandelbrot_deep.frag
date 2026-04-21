#version 320 es
precision highp float;
precision highp int;

// Deep-zoom Mandelbrot with df32 (double-single) coordinate arithmetic.
// Zoom depth ~1e11 vs FP32's ~1e6 limit.
//
// CPU-side state machine in mandelbrot_deep.rs uploads per-frame uniforms:
//   u_focal_*_hi/lo  — focal point as df32 hi/lo split pair
//   u_zoom_t         — current zoom factor (exponential, CPU-driven)
//   u_initial_extent — viewport half-extent at zoom_t = 1.0
//   u_max_iter       — iteration budget (scales with zoom depth, capped 100–2000)
//   u_fade           — lifecycle fade factor (0.0 = normal, 1.0 = background)
//
// u_resolution, u_time, u_alpha, palette() / u_lut_a/b injected by shaders.rs.

uniform float u_focal_real_hi;
uniform float u_focal_real_lo;
uniform float u_focal_imag_hi;
uniform float u_focal_imag_lo;
uniform float u_zoom_t;
uniform float u_initial_extent;
uniform int   u_max_iter;
uniform float u_fade;

// ── df32 library ──────────────────────────────────────────────────────────────
// Convention: vec2.x = hi (leading bits), vec2.y = lo (error term).
//
// Verbatim copy from df32_nuclear_test.frag — do NOT merge statements.
// Separate-statement discipline prevents the GLSL compiler from:
//   1. FMA-fusing TwoProd error terms into zero
//   2. Algebraically re-associating TwoSum (a+b)-b = a
//   3. CSE-eliminating the Dekker split sub-expression sa-(sa-a.x)
// 'precise' is belt-and-suspenders on top of the statement discipline.

highp vec2 ds_set(highp float a) {
    return vec2(a, 0.0);
}

highp vec2 ds_set_from_pair(highp float hi, highp float lo) {
    return vec2(hi, lo);
}

// TwoSum-based df32 addition.
highp vec2 ds_add(highp vec2 a, highp vec2 b) {
    precise highp float s   = a.x + b.x;
    precise highp float bb  = s - a.x;
    precise highp float e1  = s - bb;
    precise highp float e2  = a.x - e1;
    precise highp float e3  = b.x - bb;
    precise highp float e   = e2 + e3;
    e = e + a.y;
    e = e + b.y;
    // renormalize
    precise highp float t   = s + e;
    precise highp float elo = t - s;
    return vec2(t, e - elo);
}

highp vec2 ds_sub(highp vec2 a, highp vec2 b) {
    return ds_add(a, vec2(-b.x, -b.y));
}

// TwoProd via Dekker split — df32 multiplication.
// SPLIT = 2^12 + 1 = 4097 splits a 23-bit FP32 mantissa into two 12-bit halves.
highp vec2 ds_mul(highp vec2 a, highp vec2 b) {
    const highp float SPLIT = 4097.0;

    // Rounded product (hi result; lo is the rounding error).
    precise highp float p    = a.x * b.x;

    // Dekker split of a.x — three separate statements defeat CSE.
    precise highp float sa   = SPLIT * a.x;
    precise highp float sa_m = sa - a.x;
    precise highp float ahi  = sa - sa_m;
    precise highp float alo  = a.x - ahi;

    // Dekker split of b.x — same discipline.
    precise highp float sb   = SPLIT * b.x;
    precise highp float sb_m = sb - b.x;
    precise highp float bhi  = sb - sb_m;
    precise highp float blo  = b.x - bhi;

    // TwoProd error term — each line is a separate statement.
    // 'precise' prevents FMA fusion of 'ahi*bhi - p' which would destroy
    // the error capture.
    precise highp float t1   = ahi * bhi - p;
    precise highp float t2   = ahi * blo;
    precise highp float t3   = alo * bhi;
    precise highp float t4   = alo * blo;
    precise highp float err  = t1 + t2;
    err = err + t3;
    err = err + t4;

    // Incorporate cross-terms with lo parts of the inputs.
    err = err + a.x * b.y;
    err = err + a.y * b.x;

    // Renormalize.
    precise highp float r    = p + err;
    precise highp float elo  = r - p;
    return vec2(r, err - elo);
}

// Squared magnitude for escape test.
// Returns single highp float — FP32 precision is sufficient for |z|^2 > 4.
float ds_sqr_mag(highp vec2 real, highp vec2 imag) {
    highp vec2 r2 = ds_mul(real, real);
    highp vec2 i2 = ds_mul(imag, imag);
    highp vec2 s  = ds_add(r2, i2);
    return s.x;  // lo part irrelevant for escape comparison against 4.0
}

// Hard compile-time iteration cap. GLSL ES requires a static loop bound;
// u_max_iter is enforced at runtime via break.
#define MAX_ITER_HARD_CAP 2000

void main() {
    // Centered UV, aspect-ratio corrected.
    highp vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;

    // Viewport extent in complex-plane units shrinks as zoom increases.
    highp float extent = u_initial_extent / max(u_zoom_t, 1.0e-6);

    // c = focal_point + p * extent  (in df32)
    highp vec2 focal_real = ds_set_from_pair(u_focal_real_hi, u_focal_real_lo);
    highp vec2 focal_imag = ds_set_from_pair(u_focal_imag_hi, u_focal_imag_lo);
    highp vec2 c_real     = ds_add(focal_real, ds_set(p.x * extent));
    highp vec2 c_imag     = ds_add(focal_imag, ds_set(p.y * extent));

    // Mandelbrot iteration in df32.
    highp vec2 z_real = ds_set(0.0);
    highp vec2 z_imag = ds_set(0.0);

    bool escaped   = false;
    int  iter_count = 0;

    for (int i = 0; i < MAX_ITER_HARD_CAP; i++) {
        if (i >= u_max_iter) { break; }

        // z^2 = (zr^2 - zi^2) + 2*zr*zi*i
        highp vec2 zr2      = ds_mul(z_real, z_real);
        highp vec2 zi2      = ds_mul(z_imag, z_imag);
        highp vec2 new_real = ds_add(ds_sub(zr2, zi2), c_real);

        highp vec2 zri      = ds_mul(z_real, z_imag);
        highp vec2 two_zri  = ds_add(zri, zri);  // multiply by 2 via self-add
        highp vec2 new_imag = ds_add(two_zri, c_imag);

        z_real = new_real;
        z_imag = new_imag;

        // Escape test — FP32 sufficient for |z|^2 > 4 comparison.
        if (ds_sqr_mag(z_real, z_imag) > 4.0) {
            escaped    = true;
            iter_count = i;
            break;
        }
    }

    // Background color from palette lowest sample.
    vec3 bg = palette(0.0);

    vec3 color;
    if (escaped) {
        // Smooth iteration count (Inigo Quilez) eliminates banding at boundaries.
        // sqm > 4 at escape, so log2z > 1 and log2(log2z) > 0 — no NaN/negative.
        float sqm   = ds_sqr_mag(z_real, z_imag);
        float log2z = log2(sqm) * 0.5;   // = log2(|z|)
        float nu    = log2(log2z);         // = log2(log2(|z|))
        float smooth_n = float(iter_count) + 1.0 - nu;
        float t = smooth_n / float(u_max_iter);
        color = palette(clamp(t, 0.0, 1.0));
    } else {
        // Interior of the set — inherit background for visual consistency.
        color = bg;
    }

    // Fade phase: blend toward background color (0.0 = normal, 1.0 = full bg).
    color = mix(color, bg, u_fade);

    fragColor = vec4(color, 1.0);
}
