#version 320 es
precision highp float;
precision highp int;

// df32 nuclear test — three horizontal stripes that each exercise one df32
// operation. Correct implementation produces three visible gray stripes.
// Any stripe that renders pure black identifies which operation the GLSL
// compiler has algebraically collapsed.
//
// Pass/fail interpretation:
//   Stripe 1 gray (~0.87)   → ds_set_from_pair + uniform upload functional
//   Stripe 1 black           → lo part lost in uniform upload or ds_set_from_pair
//   Stripe 2 gray (~1.0)    → ds_add TwoSum functional
//   Stripe 2 black           → ds_add discarded the sub-ULP contribution
//   Stripe 3 near-black      → ds_mul Dekker split functional (PASS)
//   Stripe 3 mid-gray ≥ 0.5 → ds_mul Dekker split collapsed
//   Stripe 3 bright/white    → ds_mul mathematically incorrect

uniform vec2  u_resolution;

// CPU-split hi/lo pairs for π and π².  Must be computed from f64 Rust-side.
uniform float u_test_pi_hi;  // f32(π)
uniform float u_test_pi_lo;  // f64(π) − f64(f32(π)), cast to f32
uniform float u_pi_sq_hi;    // f32(π²)
uniform float u_pi_sq_lo;    // f64(π²) − f64(f32(π²)), cast to f32

out vec4 fragColor;

// ── df32 library ──────────────────────────────────────────────────────────────
// Convention: vec2.x = hi (leading significant bits), vec2.y = lo (error term).
//
// Every intermediate uses 'precise highp float' to prevent:
//   1. Fused-multiply-add collapsing TwoProd error terms.
//   2. Algebraic re-association of the TwoSum identity.
//   3. CSE elimination of the Dekker split sub-expression sa − (sa − a.x).
//
// Do NOT merge adjacent statements into a single subexpression.  The
// separate-statement discipline is the primary defense; 'precise' is
// belt-and-suspenders.

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

    // Rounded product (this is the hi result; the lo is the rounding error).
    precise highp float p    = a.x * b.x;

    // Dekker split of a.x — three separate statements defeat CSE.
    // If collapsed: ahi == a.x, alo == 0, and df32 degrades silently to FP32.
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
    // 'precise' prevents FMA fusion of 'ahi * bhi - p' which would give an
    // exact (not rounded) intermediate and destroy the error capture.
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

// ── main ──────────────────────────────────────────────────────────────────────

void main() {
    highp vec2  uv  = gl_FragCoord.xy / u_resolution;
    highp float y   = uv.y;
    highp float sep = 2.0 / u_resolution.y;  // 2-pixel separator band

    // White separator lines at stripe boundaries.
    if (abs(y - 0.3333) < sep || abs(y - 0.6667) < sep) {
        fragColor = vec4(1.0);
        return;
    }

    highp vec3 col;

    if (y > 0.6667) {
        // ── Stripe 1: ds_set_from_pair passthrough ────────────────────────────
        // Amplifies u_test_pi_lo (≈ −8.7e-8) by 1e7 → expected brightness ≈ 0.87.
        // Black = lo part lost in uniform upload or ds_set_from_pair dropped it.
        highp vec2 pi_ds = ds_set_from_pair(u_test_pi_hi, u_test_pi_lo);
        col = vec3(abs(pi_ds.y) * 1.0e7);

    } else if (y > 0.3333) {
        // ── Stripe 2: ds_add TwoSum preservation ─────────────────────────────
        // 1.0 + 1e-20 (sub-ULP): the 1e-20 lives only in the lo word.
        // Expected brightness ≈ 1.0.  Black = lo contribution discarded.
        highp vec2 a = ds_set(1.0);
        highp vec2 b = ds_set_from_pair(0.0, 1.0e-20);
        highp vec2 s = ds_add(a, b);
        col = vec3(abs(s.y) * 1.0e20);

    } else {
        // ── Stripe 3: ds_mul Dekker split verification ────────────────────────
        // Squares π in df32 and diffs against the CPU-computed f64 reference.
        // Expected: near-black (residual ≈ 1e-14, × 1e6 ≈ 1e-8).
        // Mid-gray ≥ 0.5 → Dekker split collapsed (sq.y ≈ 0, FP32 error shows).
        // Bright/white   → ds_mul mathematically wrong.
        highp vec2  a    = ds_set_from_pair(u_test_pi_hi, u_test_pi_lo);
        highp vec2  sq   = ds_mul(a, a);
        highp float diff = (sq.x - u_pi_sq_hi) + (sq.y - u_pi_sq_lo);
        col = vec3(abs(diff) * 1.0e6);
    }

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
