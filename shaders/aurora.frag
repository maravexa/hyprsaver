#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — aurora.frag
//
// Overhead aurora borealis — the viewer lies on their back looking straight up.
// The entire screen is sky.  Four vertical curtain bands drift side-to-side;
// each has an asymmetric exponential falloff (sharp bright edge, long soft glow
// tail) — the visual signature of real aurora.
//
// Technique: pure trig + exp, no raymarching, no fBm.  <10 % GPU load.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    float t  = u_time * u_speed_scale;
    vec3 color = vec3(0.0);

    // Four curtain bands.  Constants in parallel arrays — avoids struct overhead
    // on ES targets that may not optimise those well.
    //
    // base_x : resting horizontal centre (in aspect-corrected UV space)
    // phase  : per-band phase so bands evolve independently
    // amp    : wobble amplitude (height-units — same scale as uv.y)
    // dir    : +1 → sharp edge on right (+x), tail bleeds left
    //          -1 → sharp edge on left  (-x), tail bleeds right
    // bright : relative peak brightness weight
    float base_x[4]; float phase_[4]; float amp[4]; float dir_[4]; float bright[4];

    base_x[0] = -0.75; phase_[0] = 0.00; amp[0] = 0.09; dir_[0] =  1.0; bright[0] = 1.00;
    base_x[1] = -0.20; phase_[1] = 2.09; amp[1] = 0.11; dir_[1] = -1.0; bright[1] = 0.85;
    base_x[2] =  0.28; phase_[2] = 4.19; amp[2] = 0.08; dir_[2] =  1.0; bright[2] = 0.90;
    base_x[3] =  0.72; phase_[3] = 1.05; amp[3] = 0.07; dir_[3] = -1.0; bright[3] = 0.75;

    for (int i = 0; i < 4; i++) {
        // Curtain centre oscillates side-to-side, varying along y so the band
        // forms a rippling vertical curtain.  Two sines with an irrational
        // frequency ratio keep motion non-repeating over screensaver lifetimes.
        float center = base_x[i]
            + sin(uv.y * 3.00 + t * 0.40 + phase_[i])        * amp[i]
            + sin(uv.y * 1.71 + t * 0.25 + phase_[i] * 1.31) * amp[i] * 0.45;

        // Signed distance on the curtain's asymmetry axis.
        float dist = (uv.x - center) * dir_[i];

        // Asymmetric exponential falloff — the aurora visual signature:
        //   positive side (sharp edge) : tight Gaussian, stays crisp
        //   negative side (glow tail)  : wide  Gaussian, bleeds far
        float band = (dist > 0.0)
            ? exp(-dist * dist * 300.0)
            : exp(-dist * dist *  20.0);

        // Slow vertical breathing gives each curtain a gentle pulsing life.
        float pulse = 0.80 + 0.20 * sin(t * 0.60 + phase_[i] * 1.7 + uv.y * 2.0);

        // Colour radiates outward from the curtain centre (unsigned distance),
        // so both sides of the band share the same palette gradient.
        vec3 col = palette(0.15 + abs(uv.x - center) * 3.5);

        color += col * band * bright[i] * pulse;
    }

    // Reinhard-style tone map prevents blowout where bands overlap.
    color = color / (1.0 + color * 0.2);

    // Very dim sky base so pure-black pixels don't appear between curtains.
    color += palette(0.0) * 0.025;

    fragColor = vec4(color, 1.0);
}
