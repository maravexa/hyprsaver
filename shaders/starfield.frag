#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — starfield.frag
//
// Hyperspace zoom tunnel. 120 stars radiate outward from a central vanishing
// point. Each star zooms from its seed position toward the screen edge,
// leaving a motion-blur tracer behind it. Close stars have large cores and
// long bright tracers; distant stars are tiny pinpricks. ~15% of stars are
// tinted by the active palette; the rest are white-ish blue. Black void.
// Fully stateless GLSL — no per-frame CPU work.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

const float ZOOM = 0.4;   // zoom-cycle frequency (cycles / second)
const int   N    = 120;   // total star count

// ---------------------------------------------------------------------------
// Hash — float → float in [0, 1)
// ---------------------------------------------------------------------------

float h11(float p) {
    p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p);
}

// ---------------------------------------------------------------------------

const int   TRACER_SAMPLES  = 16;
const float TRACER_LIFETIME = 0.5;     // seconds

void main() {
    float aspect = u_resolution.x / u_resolution.y;
    vec2  uv     = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec3  col    = vec3(0.0);   // black void

    float zoom_speed = ZOOM * u_speed_scale * u_zoom_scale;

    for (int i = 0; i < N; i++) {
        float fi = float(i);

        // Fixed seed position in UV space; x scaled by aspect for uniform coverage.
        vec2  seed_xy = vec2((h11(fi * 17.37 + 1.0) - 0.5) * aspect,
                              h11(fi * 53.19 + 2.0) - 0.5);
        float hash_d  = h11(fi * 91.73 + 3.0);   // per-star depth phase
        float hc      = h11(fi * 37.11 + 4.0);   // color selector

        // d: zoom phase in [0,1). d≈0 = born near center; d→1 = exits screen.
        float d     = fract(hash_d + u_time * zoom_speed);
        float depth = 1.0 - d;
        vec2  p     = seed_xy / max(depth, 0.001);   // project outward from center

        // Cull stars that are too far off screen.
        if (abs(p.x) > 1.6 || abs(p.y) > 1.6) continue;

        // Core: pinpoint at birth (d≈0, r≈0.001), swells as star flies outward (d→1, r≈0.015).
        float core_r    = d * 0.014 + 0.001;
        float core_dist = length(uv - p);
        float core_glow = smoothstep(core_r, core_r * 0.1, core_dist);

        // All stars sample palette at their unique hc value.
        vec3 star_color = palette(hc);

        // Core contribution.
        col += star_color * core_glow;

        // Tracer: multi-sample trail over TRACER_LIFETIME seconds.
        float tracer_accum = 0.0;
        for (int s = 1; s <= TRACER_SAMPLES; s++) {
            float age      = (float(s) / float(TRACER_SAMPLES)) * TRACER_LIFETIME;
            float past_d   = fract(hash_d + (u_time - age) * zoom_speed);
            vec2  past_pos = seed_xy / max(1.0 - past_d, 0.001);

            // Cull sample if it was off-screen at that moment.
            if (abs(past_pos.x) > 1.6 || abs(past_pos.y) > 1.6) continue;

            float dist        = length(uv - past_pos);
            float age_fade    = 1.0 - (float(s) / float(TRACER_SAMPLES)); // 1.0→0.0 oldest
            float size_at_age = past_d * 0.008;  // tracer width scales with star size at that moment
            float sample_glow = exp(-dist * dist / (size_at_age * size_at_age)) * age_fade * 0.35;
            tracer_accum += sample_glow;
        }
        tracer_accum = clamp(tracer_accum, 0.0, 1.0);

        // Tracer: same star color but dimmer.
        vec3 tracer_color = star_color * 0.65;
        col += tracer_color * tracer_accum;
    }

    fragColor = vec4(col, 1.0);
}
