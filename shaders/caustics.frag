#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — caustics.frag
//
// Underwater caustic light patterns — the rippling light you see on the floor
// of a sunlit pool. Implemented via sine-wave summation (Option A): four wave
// layers with different direction vectors, frequencies, and speeds are
// multiplied together. Where wave peaks coincide the product spikes to create
// the characteristic sharp, branching caustic lines.
//
// A slow large-scale brightness modulation simulates the water surface gently
// heaving — some areas briefly focus more light than others. The intensity
// maps to palette(t) so any palette works: ocean gives blue-green caustics on
// a deep-blue floor, ember gives amber-on-black thermal shimmer, etc.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Rotate a 2D vector by angle θ (radians).
// ---------------------------------------------------------------------------

vec2 rot2(vec2 v, float a) {
    float s = sin(a);
    float c = cos(a);
    return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

// ---------------------------------------------------------------------------
// Single caustic wave layer.
//   uv        : centred, aspect-correct coordinates
//   direction : unit-ish direction vector for the wave front
//   frequency : spatial frequency (cycles per screen-height unit)
//   speed     : temporal speed multiplier
//   t         : current time
// Returns abs(sin(dot(uv, dir)*freq + t*speed)) — range [0, 1].
// ---------------------------------------------------------------------------

float wave_layer(vec2 uv, vec2 direction, float frequency, float speed, float t) {
    return abs(sin(dot(uv, direction) * frequency + t * speed));
}

// ---------------------------------------------------------------------------

void main() {
    float aspect = u_resolution.x / u_resolution.y;
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    float t = u_time * u_speed_scale * 0.35;   // calm, slow animation

    // Four wave layers — different directions, frequencies, speeds.
    // Directions are not normalised so we can vary the effective scale per axis.

    // Layer 1 — diagonal, primary frequency.
    vec2 d1 = vec2(1.0, 0.6);
    float w1 = wave_layer(uv, d1, 7.0, 1.0, t);

    // Layer 2 — rotated ~70°, slightly higher frequency.
    vec2 d2 = rot2(d1, 1.22);   // ~70 degrees
    float w2 = wave_layer(uv, d2, 9.0, 1.4, t);

    // Layer 3 — rotated ~130°, lower frequency, opposite drift.
    vec2 d3 = rot2(d1, 2.27);   // ~130 degrees
    float w3 = wave_layer(uv, d3, 6.0, -0.8, t);

    // Layer 4 — near-vertical, fine detail.
    vec2 d4 = vec2(0.2, 1.0);
    float w4 = wave_layer(uv, d4, 11.0, 1.7, t);

    // Multiply layers — product spikes only where all waves peak together,
    // creating the sparse, branching caustic line network.
    float raw = w1 * w2 * w3 * w4;

    // Sharpen: raise to a power to make the lines crisp.
    float caustic = pow(raw, 1.5);

    // ---------------------------------------------------------------------------
    // Large-scale water-surface heave — slow brightness modulation.
    // Two overlapping low-frequency sine waves create a gently drifting bright
    // patch that simulates the water surface focusing light differently over time.
    // ---------------------------------------------------------------------------
    float heave_a = 0.5 + 0.5 * sin(uv.x * 1.8 + uv.y * 1.2 + t * 0.4);
    float heave_b = 0.5 + 0.5 * sin(uv.x * 1.1 - uv.y * 2.1 - t * 0.27);
    float heave   = 0.75 + 0.25 * (heave_a * heave_b);   // range [0.75, 1.0]

    caustic *= heave;
    caustic  = clamp(caustic, 0.0, 1.0);

    // ---------------------------------------------------------------------------
    // Colour mapping.
    // Background is palette(0.0) — not pure black — so the floor has a tinted hue.
    // Caustic lines lerp toward palette(caustic) for bright concentrated light.
    // ---------------------------------------------------------------------------
    vec3 bg_col     = palette(0.0);
    vec3 caustic_col = palette(caustic);

    // Blend: background shows through in dark regions, caustic color in bright.
    vec3 col = mix(bg_col * 0.35, caustic_col, smoothstep(0.1, 0.6, caustic));

    // Subtle vignette.
    float vignette = 1.0 - dot(uv, uv) * 0.5;
    col *= clamp(vignette, 0.0, 1.0);

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
