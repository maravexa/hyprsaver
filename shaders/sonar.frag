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

    // Sweep angle must be available before the emitter loop
    float sweep_angle = t * SWEEP_SPEED;
    float pixel_angle = atan(p.y, p.x);

    // ===== WAVE INTERFERENCE WITH PING GATING =====
    // Each emitter is silent until the sweep passes its angular position,
    // then emits a ring pulse that decays over 3 seconds, then silent again until next sweep.
    float total_wave      = 0.0;
    float total_intensity = 0.0;

    for (int i = 0; i < NUM_EMITTERS; i++) {
        vec2 epos = emitter_pos(i, t);

        // How many seconds since the sweep last crossed this emitter's angle?
        // mod(...) wraps into [0, TAU), divided by angular velocity gives seconds.
        float emitter_angle   = atan(epos.y, epos.x);
        float time_since_ping = mod(sweep_angle - emitter_angle, TAU) / SWEEP_SPEED;

        // Amplitude envelope: 1.0 at ping moment, smooth fade to 0 at 3 seconds.
        float amp = smoothstep(3.0, 0.0, time_since_ping);

        float d     = length(p - epos);
        float atten = exp(-d * 1.2);
        float phase = float(i) * 1.234;

        // Wave phase uses time_since_ping so rings expand outward from the ping moment
        // (not continuously as before). At time_since_ping=0, wavefront is at emitter;
        // expands at WAVE_SPEED thereafter.
        float wave = cos(d * RING_FREQ - time_since_ping * WAVE_SPEED + phase);

        total_wave      += wave * atten * amp;
        total_intensity += atten * amp;
    }

    float wave_n  = total_wave / max(total_intensity, 0.15);
    float wave_01 = 0.5 + 0.5 * wave_n;

    // Emphasize constructive-interference peaks only.
    float wave_intensity = smoothstep(0.35, 0.90, wave_01);

    // Leading beam — sharp bright arc at current sweep angle.
    float behind = mod(sweep_angle - pixel_angle, TAU);
    float beam   = exp(-behind * 40.0);

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

    // Waves (naturally localized near recently-pinged emitters via amp gating)
    vec3 col_wave = palette(fract(wave_01 * 0.7 + t * 0.06));
    color += col_wave * wave_intensity;

    // Leading beam (rotating arc, palette-colored)
    vec3 col_beam = palette(fract(t * 0.1));
    color += col_beam * beam * 0.9;

    // White dots at emitter positions
    color += vec3(1.0) * dots;

    fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
