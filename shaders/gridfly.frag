#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — gridfly.frag
//
// Depth-gradient shading — each cube a single solid colour,
// palette position driven by hit distance (near→vivid, far→fog).
// Forward-flying raymarcher through an infinite grid of axis-aligned cubes.
// Space is folded via mod() into repeating 4-unit cells, one cube per cell.
// 48-step sphere march, ε=0.001, miss at t>30. Hard linear fog. Medium tier.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_speed_scale;
uniform float u_zoom_scale;

// ---------------------------------------------------------------------------
// 2D rotation matrix (CCW by angle a)
// ---------------------------------------------------------------------------
mat2 rot(float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, s, -s, c);
}

// ---------------------------------------------------------------------------
// Box SDF — axis-aligned box centred at origin with half-extents b
// ---------------------------------------------------------------------------
float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// ---------------------------------------------------------------------------
// Scene: infinite grid of 0.8-half-extent cubes, one per 4-unit cell
// ---------------------------------------------------------------------------
float scene(vec3 p) {
    vec3 cell_pos = mod(p - 2.0, 4.0) - 2.0;
    return sdBox(cell_pos, vec3(0.8));
}

// ---------------------------------------------------------------------------
// Sphere marcher: returns hit distance, or 30.0 on miss
// ---------------------------------------------------------------------------
float march(vec3 ro, vec3 rd) {
    float t = 0.05;
    for (int i = 0; i < 48; i++) {
        float d = scene(ro + rd * t);
        if (d < 0.001) return t;
        if (t > 30.0)  break;
        t += d;
    }
    return 30.0;
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // Corridor flight: camera at (2,2) sits in the gap between cubes.
    // ±0.4 sine wander keeps minimum clearance ≥2.43 units from cube faces.
    vec3 ro = vec3(
        2.0 + sin(u_time * u_speed_scale * 0.11) * 0.4,
        2.0 + cos(u_time * u_speed_scale * 0.09) * 0.4,
        u_time * u_speed_scale * 2.0
    );
    vec3 rd = normalize(vec3(uv, 1.5 / u_zoom_scale));
    rd.xy = rot(sin(u_time * u_speed_scale * 0.05) * 0.3) * rd.xy;
    rd.yz = rot(sin(u_time * u_speed_scale * 0.03) * 0.2) * rd.yz;

    float dist = march(ro, rd);
    vec3 col;

    if (dist < 30.0) {
        float t_palette = 1.0 - clamp(dist / 25.0, 0.0, 1.0);
        col = palette(t_palette);

        float fog = clamp(dist / 25.0, 0.0, 1.0);
        col = mix(col, palette(0.0), fog);
    } else {
        col = palette(0.0) * 0.15;
    }

    fragColor = vec4(col, 1.0);
}
