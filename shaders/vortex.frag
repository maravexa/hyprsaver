#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — vortex.frag
//
// Polar tunnel with a wobbling mouth — singularity-free 2D polar mapping.
//
// The screen maps through polar coordinates onto a spinning vortex funnel.
// The vanishing-point centre drifts on a slow Lissajous path (two
// incommensurate frequencies) so the mouth never stays centred for long.
//
// Singularity-free: radius is clamped to a small epsilon before any polar
// division — no NaN or Inf can escape to the framebuffer.
//
// Uses u_speed_scale (animation rate) and u_zoom_scale (radial zoom depth).
// Color from palette(t).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;

void main() {
    vec2  uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    float t  = u_time * u_speed_scale;

    // -----------------------------------------------------------------------
    // Wobbling centre — Lissajous drift on two incommensurate frequencies.
    // The mouth traces a slow figure-8 path across the screen so the eye
    // never settles on a static axis of symmetry.
    // -----------------------------------------------------------------------
    vec2 center = vec2(
        0.15 * sin(t * 0.37 + 1.10),
        0.10 * sin(t * 0.53 + 2.71)
    );
    vec2 p = uv - center;

    // Singularity-free radius. Epsilon 1e-4 ≈ sub-pixel, visually invisible.
    float r = max(length(p), 1e-4);
    float a = atan(p.y, p.x);   // [-PI, PI]

    // -----------------------------------------------------------------------
    // Tunnel depth — maps screen radius to a "distance into the funnel".
    // Large near the centre (r → 0), small at the edges.  u_zoom_scale lets
    // the preview panel control how tightly the funnel narrows.
    // -----------------------------------------------------------------------
    float depth  = (u_zoom_scale * 0.35) / r;

    // Forward scroll — camera flies into the vortex over time.
    float scroll = fract(depth - t * 0.50);

    // -----------------------------------------------------------------------
    // Twist — angular coordinate that winds with depth and rotates over time,
    // giving the characteristic pinwheeling look.
    // -----------------------------------------------------------------------
    float twist = a / TAU + depth * 0.20 + t * 0.10;
    float s     = fract(twist);   // [0, 1) angular position around the vortex

    // -----------------------------------------------------------------------
    // Pattern: concentric rings × spiral arms
    //
    // rings — glowing circles from the radial scroll coordinate.
    // band  — N sharp spiral arms (sharpened with pow for thin bright lines).
    // Combined they produce the bright-arm look of a real vortex.
    // -----------------------------------------------------------------------
    float rings = 0.5 + 0.5 * sin(scroll * TAU * 3.0);
    float N     = 6.0;
    float band  = 0.5 + 0.5 * cos(s * TAU * N);
    band        = pow(clamp(band, 0.0, 1.0), 2.5);   // sharpen arms to thin lines

    float pattern = rings * 0.6 + band * 0.4;

    // -----------------------------------------------------------------------
    // Color — palette index driven by both pattern and depth so each ring
    // carries a slightly different hue as it scrolls inward.
    // -----------------------------------------------------------------------
    float pal_t = fract(pattern + depth * 0.08 + t * 0.05);
    vec3  col   = palette(pal_t) * pattern;

    // -----------------------------------------------------------------------
    // Vignette: smooth fade near the singularity and at the screen edge.
    // -----------------------------------------------------------------------
    float vign = smoothstep(0.0, 0.06, r) * smoothstep(0.70, 0.50, r);
    col *= vign;

    // Bright eye glow at the centre.
    float eye_glow = exp(-r * 18.0) * 0.8;
    col += palette(fract(t * 0.07)) * eye_glow;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
