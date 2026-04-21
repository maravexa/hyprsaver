#version 320 es
precision highp float;

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

    // ===== RADIAL SWEEP =====
    float sweep_angle = t * SWEEP_SPEED;
    float pixel_angle = atan(p.y, p.x);
    // recency: 0 = just swept, → 1 = nearly full rotation since swept
    float recency = mod((sweep_angle - pixel_angle) / TAU + 1.0, 1.0);
    float sweep   = exp(-recency * 6.0);  // exponential trailing decay

    // ===== EMITTER BLIPS =====
    float blip_glow = 0.0;
    for (int i = 0; i < NUM_EMITTERS; i++) {
        vec2  epos = emitter_pos(i, t);
        float d    = length(p - epos);
        blip_glow += exp(-d * 35.0);  // tight bright point
    }

    // ===== COMPOSE =====
    // Base: dim wave pattern always present
    vec3 col_wave  = palette(fract(wave_01 * 0.7 + t * 0.02)) * 0.25;

    // Sweep-enhanced: waves much brighter where sweep is passing.
    // Sweep multiplies the existing wave rather than painting its own color —
    // contacts ARE the waves, the sweep just reveals them.
    vec3 col_sweep = palette(fract(wave_01 * 0.7 + t * 0.02 + 0.3))
                   * sweep * wave_01 * 1.3;

    // Blips: bright palette-cycling points at emitter centres
    vec3 col_blip  = palette(fract(t * 0.1)) * blip_glow * 1.8;

    vec3 color = col_wave + col_sweep + col_blip;

    fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
