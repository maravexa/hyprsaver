#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — core.frag  (v0.4.4, v2 pivot)
//
// Lit alien-core orb: sphere SDF with small-amplitude analytical domain warp,
// Phong lighting driven through palette(), Fresnel rim glow, pulsed
// sin-based emissive veins. Orbital camera (donut-style), zoom-scaled.
//
// Architecture follows donut.frag: well-conditioned SDF, finite-difference
// normals, palette-driven diffuse. Cost lives in lighting, not in resolving
// a poorly conditioned raymarch. v1's shell-and-core topology was retired
// because it requires 1024 steps to resolve and collapsed at 48.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

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
// Analytical domain warp — 3 sin, no noise, no texture.
// Amplitude deliberately small (0.08) so the SDF stays a reliable distance
// estimate and sphere marching converges cleanly.
// ---------------------------------------------------------------------------
float warp(vec3 p, float ts) {
    return 0.08 * (sin(p.x * 3.1 + ts)
                 + sin(p.y * 3.3 + ts * 1.3)
                 + sin(p.z * 2.9 + ts * 0.7));
}

// ---------------------------------------------------------------------------
// SDF: warped, breathing unit sphere. Slow Y-rotation so veins drift.
// ---------------------------------------------------------------------------
float scene(vec3 p, float ts) {
    vec3  rp     = rotY(ts * 0.20) * p;
    float pulse  = 0.5 + 0.5 * sin(ts * 1.2);
    float radius = 1.0 + pulse * 0.08;
    return length(rp) - radius + warp(rp, ts);
}

// ---------------------------------------------------------------------------
// Finite-difference normal (matches donut's pattern)
// ---------------------------------------------------------------------------
vec3 calcNormal(vec3 p, float ts) {
    const float e = 0.001;
    return normalize(vec3(
        scene(p + vec3(e, 0.0, 0.0), ts) - scene(p - vec3(e, 0.0, 0.0), ts),
        scene(p + vec3(0.0, e, 0.0), ts) - scene(p - vec3(0.0, e, 0.0), ts),
        scene(p + vec3(0.0, 0.0, e), ts) - scene(p - vec3(0.0, 0.0, e), ts)
    ));
}

// ---------------------------------------------------------------------------
// Sphere marcher: 48 steps, step factor 1.0 (SDF is well-conditioned)
// ---------------------------------------------------------------------------
float march(vec3 ro, vec3 rd, float ts) {
    float t = 0.1;
    for (int i = 0; i < 48; i++) {
        float d = scene(ro + rd * t, ts);
        if (d < 0.001) return t;
        if (t > 20.0)  break;
        t += d;
    }
    return 20.0;
}

// ---------------------------------------------------------------------------
// Emissive vein pattern — 3 sin multiplied, smoothstep'd to sharp highlights
// ---------------------------------------------------------------------------
float veins(vec3 p, float ts) {
    float v = sin(p.x * 6.0 + ts * 0.6)
            * sin(p.y * 6.0 + ts * 0.4)
            * sin(p.z * 6.0 + ts * 0.8);
    return smoothstep(0.25, 0.75, v);
}

// ---------------------------------------------------------------------------

void main() {
    vec2  uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    float ts = u_time * u_speed_scale;

    // Orbital camera with gentle Y bob (donut pattern), zoom-scaled
    float camAngle  = ts * 0.15;
    float camY      = 0.3 * sin(ts * 0.23);
    float camRadius = 3.0 / u_zoom_scale;
    vec3  ro        = vec3(sin(camAngle) * camRadius, camY, cos(camAngle) * camRadius);

    vec3 fwd = normalize(-ro);
    vec3 rgt = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
    vec3 up  = cross(rgt, fwd);
    vec3 rd  = normalize(fwd + uv.x * rgt + uv.y * up);

    float dist = march(ro, rd, ts);
    vec3  col;

    if (dist < 20.0) {
        vec3 p = ro + rd * dist;
        vec3 n = calcNormal(p, ts);

        // Phong base (matches donut)
        vec3  light = normalize(vec3(1.0, 2.0, 1.5));
        float diff  = max(dot(n, light), 0.0);
        float spec  = pow(max(dot(reflect(-light, n), -rd), 0.0), 32.0);
        float amb   = 0.15;

        float t_diff = diff * 0.7 + 0.3;
        vec3  base   = palette(t_diff) * (amb + diff);

        // Fresnel rim: bright where surface faces away from camera
        float rim = pow(1.0 - max(0.0, dot(n, -rd)), 3.0);

        // Pulsed emissive veins
        float vPulse = 0.5 + 0.5 * sin(ts * 1.5);
        float v      = veins(p, ts) * (0.4 + 0.6 * vPulse);

        col  = base;
        col += vec3(spec * 0.35);
        col += palette(0.95) * rim * 1.2;   // rim takes hottest palette index
        col += palette(0.75) * v * 0.9;     // veins take mid-bright index

        // Fog toward palette center (matches donut; barely fires at r=1)
        float fog = smoothstep(3.0, 18.0, dist);
        col = mix(col, palette(0.0), fog);
    } else {
        // Background: very dim palette center
        col = palette(0.0) * 0.10;
    }

    fragColor = vec4(col, 1.0);
}
