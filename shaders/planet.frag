#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — planet.frag
//
// Raymarched unit sphere with aurora borealis bands wrapping latitude lines.
// Three sine-wave bands at frequencies 3, 5, 7 are perturbed by 3-D value
// noise to produce the characteristic wavy curtain look. Each band has a
// Gaussian intensity envelope. Additive palette-mapped blending per band.
// Fresnel rim on the very dark sphere base. Hash-based star field background.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_alpha;

// ── 3-D value noise (approximates simplex visual character) ─────────────────
float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}
float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i),             hash(i + vec3(1,0,0)), f.x),
                   mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                   mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}

// ── SDF: unit sphere at origin ──────────────────────────────────────────────
float sdf(vec3 p) { return length(p) - 1.0; }

// ── Central-difference surface normal ───────────────────────────────────────
vec3 calcNormal(vec3 p) {
    const float e = 0.001;
    return normalize(vec3(
        sdf(p + vec3(e, 0.0, 0.0)) - sdf(p - vec3(e, 0.0, 0.0)),
        sdf(p + vec3(0.0, e, 0.0)) - sdf(p - vec3(0.0, e, 0.0)),
        sdf(p + vec3(0.0, 0.0, e)) - sdf(p - vec3(0.0, 0.0, e))
    ));
}

// ── Sphere marcher: 64 steps, ε = 0.001 ─────────────────────────────────────
float march(vec3 ro, vec3 rd) {
    float t = 0.1;
    for (int i = 0; i < 64; i++) {
        float d = sdf(ro + rd * t);
        if (d < 0.001) return t;
        if (t > 20.0)  break;
        t += d;
    }
    return 20.0;
}

// ── Cheap star field using fract(sin(dot(uv, large_primes))) ────────────────
float starfield(vec2 uv) {
    vec2  g = floor(uv * 250.0);
    float h = fract(sin(dot(g, vec2(127.1, 311.7))) * 43758.5453);
    float b = fract(sin(dot(g, vec2(269.5, 183.3))) * 12345.6789);
    return h > 0.9904 ? b * 0.7 + 0.3 : 0.0;
}

// ── Main ────────────────────────────────────────────────────────────────────
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // Camera orbits at radius 3.0, Y bob ±0.3
    float t   = u_time * u_speed_scale;
    float cam = t * 0.10;
    float cy  = 0.3 * sin(t * 0.07);
    float cr  = 3.0 / u_zoom_scale;
    vec3  ro  = vec3(sin(cam) * cr, cy, cos(cam) * cr);
    vec3  fwd = normalize(-ro);
    vec3  rgt = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
    vec3  up  = cross(rgt, fwd);
    vec3  rd  = normalize(fwd + uv.x * rgt + uv.y * up);

    float dist = march(ro, rd);
    vec3  col  = vec3(0.0);

    if (dist < 20.0) {
        vec3  p = ro + rd * dist;
        vec3  n = calcNormal(p);

        // Base: very dark palette(0.0) + subtle Fresnel rim
        float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
        col = palette(0.0) * 0.04 + palette(0.15) * rim * 0.25;

        // Latitude from normal Y, perturbed by noise for wavy curtain look
        float nz  = vnoise(p * 2.5 + vec3(0.0, t * 0.15, 0.0)) * 2.0 - 1.0;
        float lat = n.y + nz * 0.28;

        // Band 1 — freq 3.0, speed 0.20; Gaussian envelope centered at band peak
        float b1 = sin(lat * 3.0 + t * 0.20);
        float g1 = exp(-(b1 - 1.0) * (b1 - 1.0) * 4.0);
        col += palette(abs(fract(b1 * 0.5 + 0.5 + t * 0.02) * 2.0 - 1.0))        * g1 * 0.65;

        // Band 2 — freq 5.0, speed 0.15
        float b2 = sin(lat * 5.0 + t * 0.15 + 1.2);
        float g2 = exp(-(b2 - 1.0) * (b2 - 1.0) * 4.0);
        col += palette(abs(fract(b2 * 0.5 + 0.5 + t * 0.02 + 0.33) * 2.0 - 1.0)) * g2 * 0.50;

        // Band 3 — freq 7.0, speed 0.25
        float b3 = sin(lat * 7.0 + t * 0.25 + 2.4);
        float g3 = exp(-(b3 - 1.0) * (b3 - 1.0) * 4.0);
        col += palette(abs(fract(b3 * 0.5 + 0.5 + t * 0.02 + 0.66) * 2.0 - 1.0)) * g3 * 0.40;

    } else {
        // Background: black with faint star dots
        col = vec3(starfield(uv)) * 0.75;
    }

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
