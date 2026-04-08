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
//   speed   = 0.45 - i * 0.09       (UV units / second along -y)
//   dot_r   = (4.5 - i * 0.72) px   (radius, converted to UV via resolution.y)
//   density = 10 dots per layer      (50 total / 5 layers)
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
    // Layer kinematics.
    float speed  = 0.45 - fi * 0.09;                       // 0.45 → 0.09 UV/s
    float dot_r  = (4.5 - fi * 0.72) / u_resolution.y;    // pixel radius → UV units

    // Per-layer hash seed so dot positions are independent across layers.
    float seed = fi * 137.531;

    // One palette hue per layer — 5 evenly spaced samples.
    vec3 dot_col = palette(fi / 5.0);

    vec3 col = vec3(0.0);

    for (int j = 0; j < 10; j++) {
        float fj = float(j);

        // Independent position hashes for each dot.
        float hx = hash11(seed + fj * 17.37 + 1.11);
        float hy = hash11(seed + fj * 53.19 + 2.22);

        // x: stationary, spread across the full screen width.
        float dot_x = (hx - 0.5) * aspect;

        // y: falls straight down; wraps from bottom back to top.
        //    fract(hy + speed*t) grows over time → mapped to decreasing UV y.
        float dot_y = 0.5 - fract(hy + speed * u_time);

        // Distance from current pixel to dot centre.
        float dist = length(uv - vec2(dot_x, dot_y));

        // Smoothstep glow. Inner edge is tighter for distant (small) dots,
        // giving them a crisper point-like appearance; near dots get a wide halo.
        float inner = dot_r * (fi / 4.0) * 0.65;
        float glow  = smoothstep(dot_r, inner, dist);
        glow *= glow;   // sharpen the falloff

        // Subtle per-dot brightness pulse (hash-driven phase, slow oscillation).
        float phase = hash11(seed + fj * 91.73 + 3.33) * 6.28318;
        float pulse = 0.75 + 0.25 * sin(u_time * 0.8 + phase);

        col += dot_col * glow * pulse;
    }

    return col;
}

// ---------------------------------------------------------------------------

void main() {
    float aspect = u_resolution.x / u_resolution.y;
    vec2  uv     = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // Background color.
    // Detect monochrome palette: cosine amplitude (u_palette_a_b) near zero
    // means palette() returns a nearly constant, unsaturated value — treat as
    // monochrome and use a plain black background.
    vec3 bg;
    if (all(lessThan(u_palette_a_b, vec3(0.05)))) {
        bg = vec3(0.0);
    } else {
        // Slow drift along the far end of the palette for a complementary hue.
        float bg_t = 0.5 + 0.5 * sin(u_time * 0.03);
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
