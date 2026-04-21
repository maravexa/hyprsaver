#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — gridfly.frag
//
// Phase 2: corridor flight fix, per-cell hue variation, PS1 quantization.
// Forward-flying raymarcher through an infinite grid of axis-aligned cubes.
// Space is folded via mod() into repeating 4-unit cells, one cube per cell.
// 48-step sphere march, ε=0.001, miss at t>30. Hard flat face normals
// (±X, ±Y, ±Z only — no finite-difference calcNormal) give the PS1/90s look.
// Lambertian shading + hard linear fog. Lightweight GPU tier target: <25%.
// ---------------------------------------------------------------------------

#define PS1_QUANTIZE 1

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
// Flat PS1 face normal — derived from folded cell position, no SDF evals
// ---------------------------------------------------------------------------
vec3 flatNormal(vec3 cell_pos) {
    vec3 d = abs(cell_pos);
    if (d.x > d.y && d.x > d.z) return vec3(sign(cell_pos.x), 0.0, 0.0);
    if (d.y > d.z)               return vec3(0.0, sign(cell_pos.y), 0.0);
    return vec3(0.0, 0.0, sign(cell_pos.z));
}

// ---------------------------------------------------------------------------
// Per-cell hash — maps integer cell coordinates to [0, 1)
// ---------------------------------------------------------------------------
float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

// Bayer 4×4 ordered dither matrix, centred around zero
const mat4 bayer4 = mat4(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
) / 16.0 - 0.5;

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
        vec3 hit_pos  = ro + rd * dist;
        vec3 cell_pos = mod(hit_pos - 2.0, 4.0) - 2.0;
        vec3 n        = flatNormal(cell_pos);

        // Per-cell hue: hash unfolded world-space cell ID (computed once at hit)
        vec3  cell_id   = floor(hit_pos / 4.0);
        float cell_hash = hash13(cell_id);

        vec3  light = normalize(vec3(0.6, 0.8, -0.4));
        float diff  = max(dot(n, light), 0.0);

        // cell_hash offsets palette position; diff*0.3 preserves face shading
        float t_palette = fract(cell_hash + diff * 0.3);
        col = palette(t_palette) * (0.2 + diff * 0.8);

        // PS1-style hard linear fog (fog stays at palette(0.0) — no per-cell hash)
        float fog = clamp(dist / 25.0, 0.0, 1.0);
        col = mix(col, palette(0.0), fog);
    } else {
        col = palette(0.0) * 0.15;
    }

#if PS1_QUANTIZE
    // 5-bit-per-channel (32 levels) quantization with ordered Bayer dither.
    // Applied post-fog on final color only — never inside the march loop.
    ivec2 px     = ivec2(gl_FragCoord.xy) & 3;
    float dither = bayer4[px.x][px.y] / 32.0;
    col = floor(col * 32.0 + dither + 0.5) / 32.0;
#endif

    fragColor = vec4(col, 1.0);
}
