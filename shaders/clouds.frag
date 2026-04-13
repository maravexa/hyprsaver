#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — clouds.frag
//
// Slowly drifting procedural clouds over a tinted sky. Uses plain value-noise
// fBm (5 octaves, smooth — no abs()/turbulence, no domain warping) evaluated at
// three different spatial scales to produce a parallax depth effect: a dim,
// fine-grained background layer drifts at half speed behind the main foreground
// clouds. A smoothstep contrast adjustment carves out distinct cloud vs sky
// regions; the palette provides the mood (sunset, overcast, synthwave...).
//
// This is a Tier-1 fBm application — one of the lightest shaders in the set
// (3 fBm calls × 5 octaves = 15 noise lookups per fragment).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Hash + 2D value noise (smoothstep-interpolated lattice).
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

// ---------------------------------------------------------------------------
// Standard 5-octave fBm. Per-octave rotation matrix reduces grid alignment so
// successive octaves don't line up on the same axes.
// ---------------------------------------------------------------------------

float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    mat2 rot = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 5; i++) {
        value += amplitude * noise(p);
        p = rot * p;
        amplitude *= 0.5;
    }
    return value;
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // Slow horizontal drift + very slow vertical drift.
    vec2 movement = vec2(u_time * 0.04 * u_speed_scale, u_time * 0.01);

    // --- Background layer: higher frequency, half speed, spatially offset ---
    vec2 bg_offset = vec2(50.0, 30.0);
    float bg_clouds = fbm(uv * 6.0 + movement * 0.5 + bg_offset);
    bg_clouds = smoothstep(0.35, 0.65, bg_clouds) * 0.4;
    vec3 bg_color = palette(0.3 + bg_clouds * 0.3);

    // --- Foreground layer (unchanged) ---
    // Two fBm layers at different scales for depth.
    float clouds1 = fbm(uv * 2.0 + movement);
    float clouds2 = fbm(uv * 4.0 + movement * 1.5 + vec2(10.0, 10.0));

    // Combine: large cloud shapes with finer detail.
    float cloud = clouds1 * 0.7 + clouds2 * 0.3;

    // Contrast adjustment to create distinct cloud vs sky areas.
    cloud = smoothstep(0.3, 0.7, cloud);

    // Color: sky is palette(0.05) dimmed, clouds span palette(0.5..1.0).
    vec3 sky_color   = palette(0.05) * 0.3;
    vec3 cloud_color = palette(0.5 + cloud * 0.5);

    // Composite: sky base → background clouds (dim/slow) → foreground clouds.
    vec3 color = sky_color;
    color = mix(color, bg_color, bg_clouds);
    color = mix(color, cloud_color, cloud);

    fragColor = vec4(color, 1.0);
}
