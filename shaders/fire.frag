#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — fire.frag
//
// Stateless procedural fire using turbulence fBm with one level of domain
// warping (Inigo Quilez technique, Book of Shaders turbulence variant).
//
// The organic, spiky flame shape comes entirely from abs()-based value-noise
// fBm evaluated on coordinates that have themselves been distorted by another
// fBm pass. A simple height mask confines the fire to the lower portion of
// the screen; palette() turns intensity into color.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Hash + 2D value noise (smoothstep-interpolated lattice).
// ---------------------------------------------------------------------------

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// ---------------------------------------------------------------------------
// Turbulence fBm — abs()-variant for sharp valleys / spiky flame tips.
// Takes vec3: p.xy is the noise sample position, p.z advances each octave
// to give temporal variety.
// ---------------------------------------------------------------------------

float fbm(vec3 p) {
    float value     = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
        value    += amplitude * abs(noise(p.xy));
        p.xy      = p.xy * 2.02 + vec2(1.3, 1.7);
        p.z      += 0.5;
        amplitude *= 0.5;
    }
    return value;
}

// ---------------------------------------------------------------------------
// Fire intensity with one level of domain warping (IQ technique).
// ---------------------------------------------------------------------------

float fire(vec2 uv, float time) {
    // 3D coords: x stretched, y scrolls up, z evolves with time.
    vec3 p = vec3(uv.x * 2.0, uv.y * 1.5 - time * 1.5, time * 0.5);

    // Warp p by another fbm evaluation (two orthogonal lookups).
    vec3 q = vec3(
        fbm(p + vec3(0.0, 0.0, time * 0.3)),
        fbm(p + vec3(5.2, 1.3, time * 0.3)),
        time
    );

    return fbm(p + q * 0.5);
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;

    // Height mask: full intensity at the base, fades out above 70%.
    float mask = smoothstep(0.75, 0.25, uv.y);
    mask *= 1.0 - smoothstep(0.55, 0.75, uv.y);

    float intensity = fire(uv, u_time * u_speed_scale) * mask * 2.5;

    // Power curve for realistic deep-red → hot-tip color ramp.
    float palette_t = pow(clamp(intensity, 0.0, 1.0), 0.65);

    // Hot ember bed at the very bottom — maps to palette(0.85-1.0).
    float ember = smoothstep(0.2, 0.0, uv.y);
    palette_t = max(palette_t, ember * 0.95);

    vec3 color = palette(palette_t);
    fragColor = vec4(color, 1.0);
}
