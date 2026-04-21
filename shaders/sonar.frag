#version 320 es
precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// sonar.frag — static sonar-scope backdrop + rotating sweep + blip contacts.

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
const float SWEEP_SPEED  = 0.25;   // radians/sec of sweep rotation
const float PI           = 3.14159265;
const float TAU          = 6.28318530;
const float RING_DENSITY = 5.0;    // backdrop concentric rings per unit distance
const float BLIP_SIZE    = 0.025;  // blip radius in screen units
const float BLIP_DECAY   = 3.0;    // seconds for blip to fully fade

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
    float t  = u_time * u_speed_scale;
    vec2  p  = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    float d           = length(p);
    float pixel_angle = atan(p.y, p.x);
    float sweep_angle = t * SWEEP_SPEED;

    // ===== STATIC BACKDROP =====
    // Crosshair along x=0 and y=0 axes
    float cross = max(
        smoothstep(0.004, 0.001, abs(p.x)),
        smoothstep(0.004, 0.001, abs(p.y))
    );

    // Concentric rings — thin bright lines at regular radii
    float ring_phase = fract(d * RING_DENSITY);
    float sonar_rings = smoothstep(0.08, 0.02,
        min(ring_phase, 1.0 - ring_phase));

    // Fade backdrop away from center (gives "scope viewport" feel)
    float backdrop_falloff = smoothstep(1.2, 0.3, d);
    float backdrop = max(cross, sonar_rings) * backdrop_falloff;

    // ===== ROTATING SWEEP =====
    float behind = mod(sweep_angle - pixel_angle, TAU);
    float beam   = exp(-behind * 40.0);   // sharp leading edge
    float trail  = exp(-behind * 3.0);    // softer fade behind

    // ===== BLIPS (emitter nodes, ping-triggered) =====
    float total_blip = 0.0;
    for (int i = 0; i < NUM_EMITTERS; i++) {
        vec2 epos = emitter_pos(i, t);

        // Time in seconds since sweep last passed this emitter's angle
        float emitter_angle   = atan(epos.y, epos.x);
        float time_since_ping = mod(sweep_angle - emitter_angle, TAU) / SWEEP_SPEED;

        // Amplitude: 1.0 at ping moment, smoothly fades to 0 at BLIP_DECAY seconds
        float amp = smoothstep(BLIP_DECAY, 0.0, time_since_ping);

        // Blip shape — sharp circular dot at emitter position
        float d_to_emitter = length(p - epos);
        float blip = smoothstep(BLIP_SIZE, BLIP_SIZE * 0.4, d_to_emitter);

        total_blip += blip * amp;
    }
    total_blip = clamp(total_blip, 0.0, 1.0);

    // ===== COMPOSE =====
    vec3 color = vec3(0.0);

    // Dim always-visible backdrop in palette color
    vec3 backdrop_col = palette(fract(t * 0.03));
    color += backdrop_col * backdrop * 0.20;

    // Sweep trail brightens backdrop pattern as it passes (classic radar look)
    color += backdrop_col * backdrop * trail * 0.8;

    // Bright palette-colored leading beam
    vec3 beam_col = palette(fract(t * 0.08));
    color += beam_col * beam * 0.9;

    // White blips — only visible where emitters have been recently pinged
    color += vec3(1.0) * total_blip;

    fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
