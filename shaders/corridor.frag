#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — corridor.frag
//
// Forward-flying raymarched tour of an infinite cube grid rendered as a
// receding corridor tunnel. Palette maps hit distance directly — no lighting,
// no normals, no per-cube logic. Rays that exhaust the march cap render as
// the horizon color, baking the infinite-tunnel look into the shading model.
// Lightweight GPU tier (<25% on HawkPoint1 at 1920×1200).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_speed_scale;
uniform float u_zoom_scale;

// 2D rotation
mat2 rot(float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, s, -s, c);
}

// Axis-aligned box SDF
float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// Infinite cube grid via space fold — half-extent 0.8, cell size 4.0
float scene(vec3 p) {
    vec3 cell_pos = mod(p - 2.0, 4.0) - 2.0;
    return sdBox(cell_pos, vec3(0.8));
}

// Returns vec2(distance, hit_fraction): hit_fraction=1.0 on clean hit, 0.0 on miss,
// fractional on near-miss for antialiased silhouettes against the black background.
vec2 march(vec3 ro, vec3 rd) {
    float t = 0.05;
    float best_d = 1000.0;
    for (int i = 0; i < 32; i++) {
        float d = scene(ro + rd * t);
        best_d = min(best_d, d);
        if (d < 0.001) return vec2(t, 1.0);
        if (t > 18.0)  break;
        t += d;
    }
    // Soft hit: rays that got within 0.05 units at closest approach
    // receive fractional hit values, producing antialiased silhouettes.
    float hit = 1.0 - smoothstep(0.001, 0.05, best_d);
    return vec2(t, hit);
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    vec3 ro = vec3(
        2.0 + sin(u_time * u_speed_scale * 0.11) * 0.4,
        2.0 + cos(u_time * u_speed_scale * 0.09) * 0.4,
        u_time * u_speed_scale * 2.0
    );
    vec3 rd = normalize(vec3(uv, 1.5 / u_zoom_scale));
    rd.xy = rot(sin(u_time * u_speed_scale * 0.05) * 0.3) * rd.xy;
    rd.yz = rot(sin(u_time * u_speed_scale * 0.03) * 0.2) * rd.yz;

    vec2 result = march(ro, rd);
    float dist = result.x;
    float hit  = result.y;

    // Palette for cube hits, black for misses.
    // pow(., 0.6) compresses near-field into vivid palette range.
    // Multiply by soft hit: 1.0 = full color, 0.0 = black, fractional = antialiased edge.
    float t_palette = pow(clamp(dist / 18.0, 0.0, 1.0), 0.6);
    vec3 cube_col = palette(1.0 - t_palette);
    vec3 col = cube_col * hit;

    // Screen-space silhouette darkening.
    // fwidth(dist) = |dFdx(dist)| + |dFdy(dist)|, measures how rapidly hit
    // distance changes between adjacent pixels. On flat faces fwidth is small
    // (sub-pixel variation). At silhouettes it jumps by units as rays hit
    // different cubes. Darken high-variance pixels to produce outlines.
    float edge = smoothstep(0.5, 2.0, fwidth(dist));
    col *= 1.0 - edge * 0.85;

    fragColor = vec4(col, 1.0);
}
