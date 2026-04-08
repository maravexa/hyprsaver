#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — raymarcher.frag
//
// Raymarched torus scene. A torus (major radius 0.8, minor radius 0.3)
// rotates slowly on XY and XZ axes. 64-step sphere-marching with ε = 0.001.
// Lighting is Phong (ambient + Lambertian diffuse + specular). Surface color
// maps ndotl through the palette. Fog uses palette(0.0) as the fog color so
// distant geometry fades to the palette center. Camera orbits slowly with a
// gentle Y bob.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// Rotation helpers
// ---------------------------------------------------------------------------
mat3 rotXY(float a) {
    float c = cos(a), s = sin(a);
    return mat3( c, s, 0.0,
                -s, c, 0.0,
                0.0, 0.0, 1.0);
}

mat3 rotXZ(float a) {
    float c = cos(a), s = sin(a);
    return mat3( c, 0.0, s,
                0.0, 1.0, 0.0,
                -s, 0.0, c);
}

// ---------------------------------------------------------------------------
// SDF: torus at origin, major radius R, minor radius r
// ---------------------------------------------------------------------------
float sdTorus(vec3 p, float R, float r) {
    vec2 q = vec2(length(p.xz) - R, p.y);
    return length(q) - r;
}

float scene(vec3 p) {
    vec3 q = rotXZ(u_time * u_speed_scale * 0.23) * rotXY(u_time * u_speed_scale * 0.17) * p;
    return sdTorus(q, 0.8, 0.3);
}

// ---------------------------------------------------------------------------
// Finite-difference surface normal
// ---------------------------------------------------------------------------
vec3 calcNormal(vec3 p) {
    const float e = 0.001;
    return normalize(vec3(
        scene(p + vec3(e, 0.0, 0.0)) - scene(p - vec3(e, 0.0, 0.0)),
        scene(p + vec3(0.0, e, 0.0)) - scene(p - vec3(0.0, e, 0.0)),
        scene(p + vec3(0.0, 0.0, e)) - scene(p - vec3(0.0, 0.0, e))
    ));
}

// ---------------------------------------------------------------------------
// Sphere marcher: returns hit distance, or 20.0 on miss
// ---------------------------------------------------------------------------
float march(vec3 ro, vec3 rd) {
    float t = 0.1;
    for (int i = 0; i < 64; i++) {
        float d = scene(ro + rd * t);
        if (d < 0.001) return t;
        if (t > 20.0)  break;
        t += d;
    }
    return 20.0;
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // Orbiting camera with gentle Y bob
    float camAngle  = u_time * u_speed_scale * 0.20;
    float camY      = 0.8 + 0.30 * sin(u_time * u_speed_scale * 0.13);
    float camRadius = 2.5 / u_zoom_scale;
    vec3  ro        = vec3(sin(camAngle) * camRadius, camY, cos(camAngle) * camRadius);

    // Build camera basis from look-at
    vec3 fwd = normalize(vec3(0.0) - ro);
    vec3 rgt = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
    vec3 up  = cross(rgt, fwd);
    vec3 rd  = normalize(fwd + uv.x * rgt + uv.y * up);

    float dist = march(ro, rd);
    vec3  col;

    if (dist < 20.0) {
        vec3 p = ro + rd * dist;
        vec3 n = calcNormal(p);

        vec3  light = normalize(vec3(1.0, 2.0, 1.5));
        float diff  = max(dot(n, light), 0.0);
        float spec  = pow(max(dot(reflect(-light, n), -rd), 0.0), 32.0);
        float amb   = 0.15;

        // Map diffuse → palette t: dark areas sample near 0, lit areas near 1.
        float t = diff * 0.7 + 0.3;
        col = palette(t) * (amb + diff) + vec3(spec * 0.45);

        // Fog: blend toward palette center color at distance.
        float fog = smoothstep(3.0, 18.0, dist);
        col = mix(col, palette(0.0), fog);
    } else {
        // Background: very dim palette center color.
        col = palette(0.0) * 0.10;
    }

    fragColor = vec4(col, 1.0);
}
