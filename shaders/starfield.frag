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
// Signed distance from point q to line segment a→b.
// ---------------------------------------------------------------------------

float segDist(vec2 q, vec2 a, vec2 b) {
    vec2 ab = b - a, aq = q - a;
    float t = clamp(dot(aq, ab) / dot(ab, ab), 0.0, 1.0);
    return length(aq - ab * t);
}

// ---------------------------------------------------------------------------

void main() {
    float aspect = u_resolution.x / u_resolution.y;
    vec2  uv     = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec3  col    = vec3(0.0);   // black void

    for (int i = 0; i < N; i++) {
        float fi = float(i);

        // Fixed seed position in UV space; x scaled by aspect for uniform coverage.
        vec2  seed = vec2((h11(fi * 17.37 + 1.0) - 0.5) * aspect,
                           h11(fi * 53.19 + 2.0) - 0.5);
        float hd   = h11(fi * 91.73 + 3.0);   // per-star depth phase
        float hc   = h11(fi * 37.11 + 4.0);   // color selector

        // d: zoom phase in [0,1). depth = 1 - d: 1=far (seed pos), →0=close (flying past).
        float d     = fract(hd + u_time * ZOOM * u_speed_scale * u_zoom_scale);
        float depth = 1.0 - d;                          // always in (0, 1] since d ∈ [0,1)
        vec2  p     = seed / max(depth, 0.001);         // project outward from center

        // Cull stars that are too far off screen.
        if (abs(p.x) > 1.6 || abs(p.y) > 1.6) continue;

        // Previous frame position: depth was slightly larger (star was farther back).
        vec2  p_prev = seed / (depth + ZOOM * u_speed_scale * u_zoom_scale * 0.016);

        // Core: circular glow, radius grows as star approaches (d→1).
        float radius = d * 0.012 + 0.002;
        float core   = smoothstep(radius, 0.0, length(uv - p));

        // Tracer: gaussian glow along the segment p_prev→p.
        float td  = segDist(uv, p_prev, p);
        float trl = exp(-td * td * 800.0);
        // Fade toward tail (p_prev, t=0) — bright at head (p, t=1).
        vec2  seg     = p - p_prev;
        float t_along = dot(uv - p_prev, seg) / max(dot(seg, seg), 1e-8);
        trl *= clamp(t_along, 0.0, 1.0) * d;   // d: close stars have brighter tracers

        // Color: white-ish blue for most; palette-tinted for ~15% (hc > 0.85).
        vec3 star_col = hc > 0.85 ? palette(hc) : vec3(0.85, 0.90, 1.0);

        col += star_col * (core + trl * 0.6);
    }

    fragColor = vec4(col, 1.0);
}
