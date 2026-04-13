#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — aurora.frag
//
// Overhead aurora borealis — the viewer lies on their back looking straight up.
// The entire screen is sky.  Four horizontal curtain bands drift side-to-side;
// each has an asymmetric exponential falloff (sharp bright lower edge, long soft
// glow tail upward) — the visual signature of real aurora.
//
// Technique: pure trig + exp, no raymarching, no fBm.  <10 % GPU load.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    float t  = u_time * u_speed_scale;
    vec3 color = vec3(0.0);

    // Four curtain bands laid out as horizontal ribbons across the sky.
    //
    // base_y : resting vertical centre (in aspect-corrected UV space)
    // phase  : per-band phase so bands evolve independently
    // amp    : wobble amplitude (same scale as uv.y)
    // bright : relative peak brightness weight
    float base_y[4]; float phase_[4]; float amp[4]; float bright[4];

    base_y[0] = -0.35; phase_[0] = 0.00; amp[0] = 0.05; bright[0] = 1.00;
    base_y[1] = -0.10; phase_[1] = 2.09; amp[1] = 0.06; bright[1] = 0.85;
    base_y[2] =  0.15; phase_[2] = 4.19; amp[2] = 0.04; bright[2] = 0.90;
    base_y[3] =  0.35; phase_[3] = 1.05; amp[3] = 0.05; bright[3] = 0.75;

    for (int i = 0; i < 4; i++) {
        // Curtain centre oscillates along y, varying along x so the band
        // forms a rippling horizontal curtain.  Two sines with an irrational
        // frequency ratio keep motion non-repeating over screensaver lifetimes.
        float center = base_y[i]
            + sin(uv.x * 3.00 + t * 0.40 + phase_[i])        * amp[i]
            + sin(uv.x * 1.71 + t * 0.25 + phase_[i] * 1.31) * amp[i] * 0.45;

        // Signed distance along y-axis from curtain centre.
        // Positive dist = above the band, negative dist = below.
        float dist = uv.y - center;

        // Asymmetric exponential falloff — the aurora visual signature:
        //   positive dist (above) : wide Gaussian, long soft glow upward
        //   negative dist (below) : tight Gaussian, sharp bright lower edge
        float band = (dist > 0.0)
            ? exp(-dist * dist *  20.0)   // long soft glow UPWARD
            : exp(-dist * dist * 300.0);  // sharp bright edge BELOW

        // Shimmer: only in the upward diffusion zone (dist > 0.0)
        float shimmer = 0.0;
        if (dist > 0.0) {
            // Low-frequency shimmer using simple trig, NOT heavy fBm
            shimmer = sin(uv.x * 15.0 + u_time * 2.0 + uv.y * 8.0) *
                      sin(uv.x *  7.0 - u_time * 1.3) *
                      0.3; // shimmer intensity — keep subtle
            shimmer *= smoothstep(0.0, 0.05, dist); // fade in away from bright edge
        }
        band *= (1.0 + shimmer);

        // Slow horizontal breathing gives each curtain a gentle pulsing life.
        float pulse = 0.80 + 0.20 * sin(t * 0.60 + phase_[i] * 1.7 + uv.x * 2.0);

        // Colour radiates outward from the curtain centre (unsigned distance),
        // so both sides of the band share the same palette gradient.
        vec3 col = palette(0.15 + abs(uv.y - center) * 3.5);

        color += col * band * bright[i] * pulse;
    }

    // Reinhard-style tone map prevents blowout where bands overlap.
    color = color / (1.0 + color * 0.2);

    // Very dim sky base so pure-black pixels don't appear between curtains.
    color += palette(0.0) * 0.025;

    fragColor = vec4(color, 1.0);
}
