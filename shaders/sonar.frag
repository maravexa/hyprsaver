#version 320 es
precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// sonar.glsl — multi-source wavefront interference with rotating sweep.
// Reads as sonar scope: contacts appear and fade, sweep reveals them.

// ---------------------------------------------------------------------------
// Fast hash functions (Dave Hoskins style)
// https://www.shadertoy.com/view/4djSRW
// ---------------------------------------------------------------------------
float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const int   NUM_EMITTERS = 6;
const float RING_FREQ    = 12.0;   // wave rings per unit distance
const float WAVE_SPEED   = 2.5;    // ring expansion speed
const float SWEEP_SPEED  = 0.25;   // radians/sec of sweep rotation
const float PI           = 3.14159265;
const float TAU          = 6.28318530;

// ---------------------------------------------------------------------------
// Emitter paths — slow Lissajous drift, bounded to [-0.6, 0.6]
// ---------------------------------------------------------------------------
vec2 emitter_pos(int i, float t) {
    float fi = float(i);
    return vec2(
        0.6 * sin(t * 0.08 + fi * 1.237),
        0.5 * cos(t * 0.11 + fi * 2.413)
    );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
void main() {
    float t = u_time * u_speed_scale;

    // Aspect-preserved coordinates, centred at origin
    vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // ===== WAVE INTERFERENCE =====
    float total_wave      = 0.0;
    float total_intensity = 0.0;

    for (int i = 0; i < NUM_EMITTERS; i++) {
        vec2  epos  = emitter_pos(i, t);
        float d     = length(p - epos);
        float atten = exp(-d * 1.2);

        float phase = float(i) * 1.234;
        float wave  = cos(d * RING_FREQ - t * WAVE_SPEED + phase);

        total_wave      += wave * atten;
        total_intensity += atten;
    }

    // Normalise wave to prevent brightness drift
    float wave_n  = total_wave / max(total_intensity, 0.15);
    float wave_01 = 0.5 + 0.5 * wave_n;  // remap to [0, 1]

    float wave_intensity = smoothstep(0.35, 0.90, wave_01);

    // ===== SWEEP (visibility gate for everything colored) =====
    float sweep_angle = t * SWEEP_SPEED;
    float pixel_angle = atan(p.y, p.x);

    // "behind" = radians since this pixel was last swept (0 = just swept, ~TAU = about to be swept)
    float behind = mod(sweep_angle - pixel_angle, TAU);

    // Leading beam — sharp bright line at the current sweep angle
    float beam = exp(-behind * 40.0);

    // Trail — softer fade behind the beam, for wave visibility
    float trail = exp(-behind * 3.0);

    // ===== EMITTER DOTS (white, sharp, no glow) =====
    float dots = 0.0;
    for (int i = 0; i < NUM_EMITTERS; i++) {
        vec2  epos = emitter_pos(i, t);
        float d    = length(p - epos);
        dots += smoothstep(0.010, 0.006, d);
    }
    dots = clamp(dots, 0.0, 1.0);

    // ===== COMPOSE =====
    vec3 color = vec3(0.0);

    // Trail reveals colored wave interference. Outside trail, pure black.
    vec3 col_wave = palette(fract(wave_01 * 0.7 + t * 0.06));
    color += col_wave * wave_intensity * trail;

    // Leading beam — bright palette-cycling arc.
    vec3 col_beam = palette(fract(t * 0.1));
    color += col_beam * beam * 0.9;

    // Emitter dots — pure white, sharp edges, always visible.
    color += vec3(1.0) * dots;

    fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
