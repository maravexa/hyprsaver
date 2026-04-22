#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — core.frag  (v0.4.4, v3)
//
// Lit alien-core orb with flowing energy emission.
//
// Architecture (unchanged from v2):
//   - Unit sphere SDF with small analytical domain warp (amp 0.08) so the
//     distance estimate stays honest and the march converges cleanly
//   - 48-step sphere march, step factor 1.0
//   - Finite-difference normals; Phong lighting through palette()
//   - Orbital camera, zoom-scaled via u_zoom_scale
//
// v3 upgrades:
//   - Veins: zero-crossing contours of a sine sum (continuous curves
//     instead of v2's multiplicative dot lattice)
//   - Atmospheric halo in the miss path (1/(1+d²) falloff on ray-to-origin
//     perpendicular distance, slow pulse)
//   - Rotating light direction
//   - Fresnel rim modulated by latitudinal sin bands
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
// Analytical domain warp — 3 sin, amplitude 0.08 (unchanged from v2)
// ---------------------------------------------------------------------------
float warp(vec3 p, float ts) {
    return 0.08 * (sin(p.x * 3.1 + ts)
                 + sin(p.y * 3.3 + ts * 1.3)
                 + sin(p.z * 2.9 + ts * 0.7));
}

// ---------------------------------------------------------------------------
// SDF: warped, breathing unit sphere
// ---------------------------------------------------------------------------
float scene(vec3 p, float ts) {
    vec3  rp     = rotY(ts * 0.20) * p;
    float pulse  = 0.5 + 0.5 * sin(ts * 1.2);
    float radius = 1.0 + pulse * 0.08;
    return length(rp) - radius + warp(rp, ts);
}

// ---------------------------------------------------------------------------
// Finite-difference normal
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
// Sphere marcher
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
// Zero-crossing contour veins with domain-warped coordinates and high-freq
// break-up. The domain warp (low-freq sines at amplitude 0.25) bends the
// contour lines into organic curves. The break-up term (high-freq dot-product
// sin) introduces fine-grained irregularity so the veins don't read as smooth
// repeating waves. Still all sines — no hash-based noise — to keep cost
// proportional.
// ---------------------------------------------------------------------------
float veins(vec3 p, float ts) {
    // Low-frequency domain warp (3 sin)
    vec3 warped = p + 0.25 * vec3(
        sin(p.y * 2.0 + ts * 0.5),
        sin(p.z * 2.0 + ts * 0.3),
        sin(p.x * 2.0 + ts * 0.7)
    );

    // Base contour field (3 sin)
    float w = sin(warped.x * 8.0 + ts * 0.9)
            + sin(warped.y * 8.0 + ts * 0.7)
            + sin(warped.z * 8.0 + ts * 1.1);

    // High-frequency break-up for fine-grained chaos (1 sin, cross-axis
    // direction so it doesn't align with base axes)
    w += 0.5 * sin(dot(p, vec3(17.0, 23.0, 19.0)) - ts * 2.5);

    // Slightly wider smoothstep than v3 — more high-freq content, more fuzz
    return 1.0 - smoothstep(0.0, 0.5, abs(w));
}

// ---------------------------------------------------------------------------

void main() {
    vec2  uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    float ts = u_time * u_speed_scale;

    // Orbital camera, zoom-scaled
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

        // Static light direction (matches donut.frag)
        vec3  light = normalize(vec3(1.0, 2.0, 1.5));
        float diff  = max(dot(n, light), 0.0);
        float spec  = pow(max(dot(reflect(-light, n), -rd), 0.0), 32.0);
        float amb   = 0.7;  // lifted from 0.15 to keep shadow palette colors vibrant

        float t_diff = diff * 0.7 + 0.3;
        vec3  base   = palette(t_diff) * (amb + diff * 0.5);  // narrower contrast

        // --- Fresnel rim with latitudinal bands (v3) ---
        float rim  = pow(1.0 - max(0.0, dot(n, -rd)), 3.0);
        float band = 0.6 + 0.4 * sin(p.y * 8.0 - ts * 1.5);
        rim *= band;

        // --- Pulsed emissive veins (v3: zero-crossing contours) ---
        float vPulse = 0.5 + 0.5 * sin(ts * 1.5);
        float v      = veins(p, ts) * (0.4 + 0.6 * vPulse);

        col  = base;
        col += vec3(spec * 0.35);
        col += palette(0.95) * rim * 1.2;
        col += palette(0.75) * v * 0.9;

        // Fog toward palette center (barely fires at r=1, kept for consistency)
        float fog = smoothstep(3.0, 18.0, dist);
        col = mix(col, palette(0.0), fog);
    } else {
        // --- Atmospheric halo (v3) ---
        // length(cross(ro, rd)) = perpendicular distance from origin to the ray
        // (exact when rd is unit — which it is here).
        float closestDist = length(cross(ro, rd));
        float halo        = 1.0 / (1.0 + closestDist * closestDist * 1.5);
        float haloPulse   = 0.8 + 0.2 * sin(ts * 1.0);

        col  = palette(0.0) * 0.10;                    // dim background base
        col += palette(0.9) * halo * 0.4 * haloPulse;  // soft outer glow
    }

    fragColor = vec4(col, 1.0);
}
