#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — wormhole.frag
//
// Curved wormhole tunnel with three spiral arms. 3D raymarcher flying through
// a static curved axis (TunnelCenter). The curve is fixed in world space;
// we fly through it by translating z. ≤50 march steps, no lighting, no normals.
// Coloring is palette LUT spiral bands + distance fog. Lightweight GPU tier.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_speed_scale;
uniform float u_zoom_scale;

const float PI       = 3.14159265358979;
const float ARMS     = 3.0;
const int   MAX_STEPS = 50;
const float MAX_DIST  = 80.0;
const float HIT_EPS   = 0.002;

// DEBUG: visualize raymarch iteration count as grayscale.
// Set to 1 to see where the march burns budget. 0 for normal output.
#define DEBUG_ITER_COUNT 1

// Set once per frame in main(), read by Map(). Models forward flight by
// translating the world backward rather than moving the camera.
float g_z_offset;

// ---------------------------------------------------------------------------
// TunnelCenter — curved axis displacement at world-z
// Asymmetric amplitudes (x=1.2, y=3.0) and phase offset on y (+ 4.0) prevent
// both axes from zeroing simultaneously, keeping the path visibly curved.
// No time term: the curve is static; flight-through comes from g_z_offset.
// ---------------------------------------------------------------------------
vec2 TunnelCenter(float z) {
    return vec2(
        sin(z * 0.17) * 1.2,
        sin(z * 0.10 + 4.0) * 3.0
    );
}

// ---------------------------------------------------------------------------
// Map — SDF for the tunnel interior
// Inside the tube Map() is positive; we march from inside so distance shrinks
// toward the wall and the march terminates when d < HIT_EPS.
// ---------------------------------------------------------------------------
float Map(vec3 pos) {
    pos.z -= g_z_offset;
    pos.xy -= TunnelCenter(pos.z);
    float angle = atan(pos.y, pos.x) - pos.z * 0.25 + u_time * u_speed_scale * 3.7;
    float r = sin(pos.z * 0.1) * 0.5 + 3.0 + sin(angle * ARMS) * 0.3;
    return length(pos.xy) - r;
}

// ---------------------------------------------------------------------------

void main() {
    // Forward flight: translate world backward so camera stays at origin.
    g_z_offset = u_time * u_speed_scale * 10.0;

    // Camera origin: tracks tunnel center at the camera's z (half amplitude
    // keeps camera inside the tube while still revealing the wall curve).
    vec3 ro = vec3(0.0, 0.0, 0.0);
    ro.xy = TunnelCenter(-g_z_offset) * 0.5;

    // Camera target: 5 units ahead, tracking tunnel center at that z.
    // Half amplitude steers the view into the upcoming bend.
    vec3 ta = vec3(0.0, 0.0, 5.0);
    ta.xy = TunnelCenter(5.0 - g_z_offset) * 0.5;

    // Barrel-roll up vector — cheap, adds motion character without extra cost.
    float cam_angle = sin(u_time * u_speed_scale * 0.3) + u_time * u_speed_scale * 0.1;
    vec3 up = vec3(sin(cam_angle), cos(cam_angle), 0.0);

    // Build orthonormal view basis.
    vec3 fwd   = normalize(ta - ro);
    vec3 right = normalize(cross(fwd, up));
    vec3 upC   = cross(right, fwd); // already unit length

    // Ray direction from NDC — u_zoom_scale narrows/widens FOV per convention.
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    uv /= u_zoom_scale;
    vec3 rd = normalize(uv.x * right + uv.y * upC + fwd);

    // Sphere march from camera origin along rd.
    float t = 0.0;
    vec3 p = ro;
    int iter_count = 0;
    for (int i = 0; i < MAX_STEPS; i++) {
        float d = Map(p);
        t += d;
        p += d * rd;
        iter_count = i + 1;
        if (abs(d) < HIT_EPS) break;
    }

#if DEBUG_ITER_COUNT
    float iter_frac = float(iter_count) / float(MAX_STEPS);
    fragColor = vec4(vec3(iter_frac), 1.0);
    return;
#endif

    // ---------------------------------------------------------------------------
    // Shading — no normals, no lighting; palette IS the color.
    // ---------------------------------------------------------------------------
    // Ray-distance rings: ~3 cycles across typical hit range (t ≈ 3..30+).
    // Minus sign makes rings flow outward (growing t_pal over time = tunnel rush).
    float t_pal = fract(t * 0.1 - u_time * u_speed_scale * 0.7);
    vec3 col = palette(t_pal);

    // Iteration-count rim: brightens pixels where the ray grazed the wall tangentially.
    col += sqrt(float(iter_count)) * 0.005;

    // Distance fog fades the far wall to palette(0.0) — matches gridfly convention.
    float fog = 1.0 - exp(-max(t, 0.0) * 0.025);
    col = mix(col, palette(0.0), fog);

    fragColor = vec4(col, 1.0);
}
