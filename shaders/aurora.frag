#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — aurora.frag
//
// Ground-up view of the aurora borealis: shimmering vertical curtains of
// light hang in the upper sky, slowly waving and pulsing over a dark ground.
// This is a FLAT/SKY shader — no 3D geometry. It pairs with the `planet`
// shader (view from space) and is a thematic companion to an aurora_sphere
// scene; here the viewer stands beneath the curtains looking up.
//
// Technique:
//   - 4 overlapping curtain bands, each a sum of 3 sine folds along x
//     (creates the characteristic draped shape)
//   - Gaussian falloff above the fold line + exponential tail below
//     (aurora hangs DOWN from a bright arc)
//   - Each curtain samples the palette at a different offset to get the
//     green/blue/purple banding typical of real aurora
//   - One 4-octave value-noise fBm provides the shimmer/breath intensity
//   - High-frequency sine adds fine vertical ray striations
//   - Horizon mask darkens the lower 15% (ground)
//
// GPU cost: ~16 sin calls for curtains + 1 fBm (4 octaves) + a few
// utility ops. Tier-1 / very light.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Hash + 2D value noise (smoothstep-interpolated lattice) — same pattern
// as the clouds shader for consistency and cheap reuse by the shader cache.
// ---------------------------------------------------------------------------

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i),               hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// 4-octave fBm — slightly lighter than the clouds 5-octave version because
// the aurora only needs a soft shimmer, not rich cloud structure.
float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    mat2 rot = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 4; i++) {
        value += amplitude * noise(p);
        p = rot * p;
        amplitude *= 0.5;
    }
    return value;
}

// ---------------------------------------------------------------------------

void main() {
    // Use 0..1 screen UV: we want y to mean "height above the horizon".
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;

    float t = u_time * u_speed_scale;

    // -----------------------------------------------------------------------
    // Sky background — dark, but not pure black. Palette sample at 0.0 at
    // very low brightness so the scene is tinted by the active palette.
    // -----------------------------------------------------------------------
    vec3 color = palette(0.0) * 0.05;

    // -----------------------------------------------------------------------
    // Shimmer field — one fBm lookup reused by every curtain. Slowly drifts
    // horizontally so the brightness ripples travel along the curtains.
    // -----------------------------------------------------------------------
    float shimmer = fbm(vec2(uv.x * 5.0 + t * 0.1, uv.y * 2.0));

    // -----------------------------------------------------------------------
    // 4 overlapping curtain bands.
    // -----------------------------------------------------------------------
    vec3 aurora = vec3(0.0);
    for (int i = 0; i < 4; i++) {
        float fi = float(i);

        // Curtain "arc" y-position — upper portion of the sky.
        float center_y = 0.55 + fi * 0.08;

        // Three-frequency sine fold creates the characteristic organic
        // drape of an aurora curtain.
        float fold = sin(uv.x * 3.0  + t * 0.15 + fi * 2.0) * 0.08
                   + sin(uv.x * 7.0  - t * 0.25 + fi * 5.0) * 0.03
                   + sin(uv.x * 13.0 + t * 0.40 + fi * 1.3) * 0.015;

        // Distance from the fold line (signed: positive = above the arc).
        float dist = uv.y - (center_y + fold);

        // Bright Gaussian crown along the fold; slower exponential tail
        // DOWNWARD because aurora curtains hang from a bright arc.
        float curtain;
        if (dist < 0.0) {
            curtain = exp(-abs(dist) * 3.0);
        } else {
            curtain = exp(-dist * dist * 15.0);
        }

        // Shimmer breathes along the curtain length (brightness ripples).
        curtain *= 0.5 + shimmer * 0.5;

        // Fine vertical ray striations — subtle (20% modulation).
        float rays = 0.5 + 0.5 * sin(uv.x * 80.0 + uv.y * 5.0 + t * 0.5);
        curtain *= 0.8 + rays * 0.2;

        // Palette sample: each curtain picks a slightly different colour,
        // modulated by the local fold so neighbouring strands shift hue.
        vec3 curtain_color = palette(0.3 + fi * 0.15 + fold * 0.5);

        aurora += curtain_color * curtain;
    }

    // -----------------------------------------------------------------------
    // Horizon mask — darken the lower 15% of the frame (ground).
    // -----------------------------------------------------------------------
    float ground_mask = smoothstep(0.15, 0.20, uv.y);
    aurora *= ground_mask;

    // -----------------------------------------------------------------------
    // Composite additively and tame blowout.
    // -----------------------------------------------------------------------
    color += aurora;
    color = min(color, vec3(1.2));

    fragColor = vec4(color, 1.0);
}
