#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — snowfall.frag
//
// Five parallax layers of falling snow dots. Layer 0 is closest (fast, large),
// layer 4 is furthest (slow, tiny). Dots fall straight down; x position is
// stationary per dot (no horizontal drift). Background is a slow-drifting
// dark palette color, or pure black when the active palette is monochrome.
// All layers are additively composited over the background. Fully stateless
// GLSL — no per-frame CPU work.
//
// Layer parameters (i = 0 nearest … 4 furthest):
//   speed   = float[](0.144, 0.126, 0.108, 0.090, 0.072) + jitter
//   size_px = float[](9.0, 5.5, 3.0, 1.6, 0.7)  (exponential depth falloff)
//   density = 20 dots per layer      (100 total / 5 layers)
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Hash — float → float in [0, 1)
// ---------------------------------------------------------------------------

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

// ---------------------------------------------------------------------------
// Accumulate glow for one snow layer.
//   fi     : float(layer_index), 0.0 = closest … 4.0 = furthest
//   aspect : u_resolution.x / u_resolution.y
// ---------------------------------------------------------------------------

vec3 snowLayer(vec2 uv, float fi, float aspect) {
    // Layer kinematics — compressed range, less mechanical lockstep.
    float speed_base[5] = float[](0.144, 0.126, 0.108, 0.090, 0.072);
    // Exponential size falloff for strong depth illusion; layer 4 sub-pixel → soft haze.
    float size_px[5]    = float[](9.0, 5.5, 3.0, 1.6, 0.7);

    int li      = int(fi);
    float base  = speed_base[li];
    float dot_r = size_px[li] / min(u_resolution.x, u_resolution.y);

    // Per-layer hash seed so dot positions are independent across layers.
    float seed = fi * 137.531;

    // One palette hue per layer — 5 evenly spaced samples.
    vec3 dot_col = palette(fi / 5.0);

    vec3 col = vec3(0.0);

    for (int j = 0; j < 20; j++) {
        float fj = float(j);

        // Independent position hashes for each dot.
        float hx         = hash11(seed + fj * 17.37 + 1.11);
        float hy         = hash11(seed + fj * 53.19 + 2.22);
        float hash_phase = hash11(seed + fj * 73.11 + 4.44);

        // Per-dot speed jitter breaks mechanical lockstep within a layer.
        float effective_speed = base + (hash_phase - 0.5) * 0.02;

        // x: stationary, spread across the full screen width.
        float dot_x = (hx - 0.5) * aspect;

        // y: falls straight down; wraps from bottom back to top.
        //    fract(hy + speed*t) grows over time → mapped to decreasing UV y.
        float dot_y = 0.5 - fract(hy + effective_speed * u_time * u_speed_scale);

        // Distance from current pixel to dot centre.
        float dist = length(uv - vec2(dot_x, dot_y));

        // Smoothstep glow. Inner edge is tighter for distant (small) dots,
        // giving them a crisper point-like appearance; near dots get a wide halo.
        float inner = dot_r * (fi / 4.0) * 0.65;
        float glow  = smoothstep(dot_r, inner, dist);
        glow *= glow;   // sharpen the falloff

        // Subtle per-dot brightness pulse (hash-driven phase, slow oscillation).
        float phase = hash11(seed + fj * 91.73 + 3.33) * 6.28318;
        float pulse = 0.75 + 0.25 * sin(u_time * u_speed_scale * 0.8 + phase);

        col += dot_col * glow * pulse;
    }

    return col;
}

// ---------------------------------------------------------------------------

void main() {
    float aspect = u_resolution.x / u_resolution.y;
    vec2  uv     = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // Background color.
    // Detect monochrome palette: sample LUT endpoints; if they're nearly the
    // same colour the palette has no hue variation — use plain black background.
    vec3 _lut_lo = texture(u_lut_a, vec2(0.0, 0.5)).rgb;
    vec3 _lut_hi = texture(u_lut_a, vec2(1.0, 0.5)).rgb;
    vec3 bg;
    if (all(lessThan(abs(_lut_hi - _lut_lo), vec3(0.05)))) {
        bg = vec3(0.0);
    } else {
        // Slow drift along the far end of the palette for a complementary hue.
        float bg_t = 0.5 + 0.5 * sin(u_time * u_speed_scale * 0.03);
        bg = palette(bg_t) * 0.18;   // dark but not black — enough to contrast snow
    }

    // Composite: start with background, additively blend all 5 snow layers.
    // Render back-to-front (layer 4 first) so near layers appear on top.
    vec3 col = bg;
    for (int i = 4; i >= 0; i--) {
        col += snowLayer(uv, float(i), aspect);
    }

    fragColor = vec4(col, 1.0);
}
