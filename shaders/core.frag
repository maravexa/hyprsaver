#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — core.frag
//
// Lightweight alien-core: shell-only raymarched SDF (outer shell r≈3, inner
// core r≈1.5) with procedural bi-planar 2D noise for surface lumpiness.
// 48-step march, pre-computed per-pixel rotation/pulse/breath (all
// deformation happens once per pixel, never per step). Noise-driven
// "energy veining" brightens the surface through palette(). Vignette.
//
// Derived from an Alien Core concept by GLKITTY (2016), heavily reduced:
// no filament links, no 3D/texture noise, no per-step deformation, 48
// steps instead of 1024.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// 2D hash + value noise
// ---------------------------------------------------------------------------
float h2(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}

float n2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h2(i),                 h2(i + vec2(1.0, 0.0)), f.x),
               mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y);
}

// ---------------------------------------------------------------------------
// Bi-planar projection: two 2D noise lookups blended by surface normal
// direction. Gives a 3D-ish lumpy surface without 3D noise or textures.
// ---------------------------------------------------------------------------
float lump(vec3 p, float ts) {
    vec3 np = normalize(p);
    float a = n2(np.xy + ts * 0.05);
    float b = n2(np.yz + ts * 0.05 + 0.77);
    a = mix(a, 0.5, abs(np.x));
    b = mix(b, 0.5, abs(np.z));
    return a + b - 0.4;
}

// ---------------------------------------------------------------------------
// Y-axis rotation
// ---------------------------------------------------------------------------
mat3 rotY(float a) {
    float c = cos(a), s = sin(a);
    return mat3( c, 0.0, -s,
                0.0, 1.0, 0.0,
                 s, 0.0,  c);
}

// ---------------------------------------------------------------------------
// SDF: shell-only (outer shell r≈3 + inner core r≈1.5, noise-perturbed).
// NO filament links (original had 5 smin'd links — dominant cost driver).
// ---------------------------------------------------------------------------
float map(vec3 p, float ts) {
    float n = 1.5 * lump(p, ts);
    float outer = (3.0 - length(p)) + n;
    float inner = (length(p) - 1.5) + n;
    return min(outer, inner);
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv  = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec3 ray = normalize(vec3(uv, 1.0));

    // Global time scaling (project convention)
    float ts = u_time * u_speed_scale;

    // Camera origin scaled by zoom (project convention)
    vec3 ro = vec3(0.0, 0.0, -3.0 / u_zoom_scale);

    // --- Pre-march deformation: computed ONCE per pixel, never per step ---
    float pulse  = sin(ts * 0.5);
    mat3  rot    = rotY(ts * 0.33);
    float breath = 1.0 + pulse * 0.15;
    float ybob   = pulse * 0.3;

    // --- 48-step sphere march, step factor 0.7 ---
    float dist = 0.0;
    vec3  p    = vec3(0.0);
    int   hit  = 47;
    for (int r = 0; r < 48; r++) {
        p = ro + ray * dist;
        p = rot * p;
        p.y += ybob;
        p *= breath;
        float d = map(p, ts);
        if (d < 0.01) { hit = r; break; }
        dist += d * 0.7;
        hit = r;
    }

    // Iteration-based AO
    float iter = float(hit) / 48.0;
    float ao   = 1.0 - (1.0 - iter) * (1.0 - iter);

    // Surface mask: center-weighted, animated breathing
    float mask = max(0.0, 1.0 - length(p) * 0.5);
    mask *= abs(sin(ts * -1.5 + length(p) + p.x) - 0.2);

    // Palette drive: AO dominates, mask adds detail, dist adds depth tint
    float palIdx = clamp(ao * 0.6 + mask * 0.3 + dist * 0.03, 0.0, 1.0);
    vec3  col    = palette(palIdx);

    // Noise-driven veining (multiplicative highlight)
    float veining = max(0.0, lump(p, ts) * 4.0 - 2.6) * mask;
    col *= (1.0 + veining);

    // Vignette
    vec2 vuv = gl_FragCoord.xy / u_resolution.xy;
    vuv *= 1.0 - vuv.yx;
    col *= pow(vuv.x * vuv.y * 20.0, 0.25);

    fragColor = vec4(col, 1.0);
}
