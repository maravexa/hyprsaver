#version 320 es
precision highp float;

// -----------------------------------------------------------------------
// Debug visualization mode. Set to 0 for normal rendering.
//   1 = hit distance as grayscale (black=near, white=far)
//   2 = iteration count as grayscale (black=few, white=max 48)
//   3 = reconstructed face normal as RGB (each axis maps to a color channel)
//   4 = cell ID hashed to color (each cube gets its own hue)
// -----------------------------------------------------------------------
#define DEBUG_MODE 0

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

#if DEBUG_MODE == 3
vec3 debug_normal(vec3 p) {
    const float e = 0.001;
    vec2 h = vec2(e, 0.0);
    return normalize(vec3(
        scene(p + h.xyy) - scene(p - h.xyy),
        scene(p + h.yxy) - scene(p - h.yxy),
        scene(p + h.yyx) - scene(p - h.yyx)
    ));
}
#endif

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

#if DEBUG_MODE == 2
vec2 march_debug(vec3 ro, vec3 rd) {
    float t = 0.05;
    for (int i = 0; i < 48; i++) {
        float d = scene(ro + rd * t);
        if (d < 0.001) return vec2(t, float(i));
        if (t > 30.0)  return vec2(30.0, float(i));
        t += d;
    }
    return vec2(30.0, 48.0);
}
#endif

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

#if DEBUG_MODE == 0
    // ===== Normal rendering =====
    float dist = march(ro, rd);
    vec3 col;
    if (dist < 30.0) {
        vec3 hit_pos = ro + rd * dist;
        vec3 cell_id = floor((hit_pos + 2.0) / 4.0);
        float cube_dist = cell_id.z * 4.0 - ro.z;
        float t_palette = 1.0 - clamp(cube_dist / 25.0, 0.0, 1.0);
        col = palette(t_palette);
        float fog = clamp(dist / 25.0, 0.0, 1.0);
        col = mix(col, palette(0.0), fog);
    } else {
        col = palette(0.0) * 0.15;
    }
    fragColor = vec4(col, 1.0);

#elif DEBUG_MODE == 1
    // ===== Mode 1: hit distance as grayscale =====
    // Black = near (0 units), white = far (30 units = miss horizon)
    float dist = march(ro, rd);
    float g = clamp(dist / 30.0, 0.0, 1.0);
    fragColor = vec4(vec3(g), 1.0);

#elif DEBUG_MODE == 2
    // ===== Mode 2: iteration count as grayscale =====
    // Black = converged fast, white = hit 48-iteration cap
    vec2 result = march_debug(ro, rd);
    float g = result.y / 48.0;
    fragColor = vec4(vec3(g), 1.0);

#elif DEBUG_MODE == 3
    // ===== Mode 3: face normal as RGB =====
    // X-axis = red, Y-axis = green, Z-axis = blue
    // Positive and negative axes produce distinct colors via the 0.5 remap
    float dist = march(ro, rd);
    if (dist < 30.0) {
        vec3 hit_pos = ro + rd * dist;
        vec3 n = debug_normal(hit_pos);
        fragColor = vec4(n * 0.5 + 0.5, 1.0);
    } else {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    }

#elif DEBUG_MODE == 4
    // ===== Mode 4: cell ID hashed to color =====
    // Each cube gets a unique hue from its integer cell coordinates
    float dist = march(ro, rd);
    if (dist < 30.0) {
        vec3 hit_pos = ro + rd * dist;
        vec3 cell_id = floor((hit_pos + 2.0) / 4.0);
        // Simple hash — deterministic, distinct for adjacent cubes
        vec3 h = fract(sin(cell_id * vec3(12.9898, 78.233, 37.719)) * 43758.5453);
        fragColor = vec4(h, 1.0);
    } else {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    }

#endif
}
