#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — wormhole.frag
//
// Curved wormhole tunnel. 3D raymarcher flying through a static curved axis
// (TunnelCenter). The curve is fixed in world space; we fly through it by
// translating z. ≤64 conservative march iterations, no lighting, no normals.
// Coloring is hybrid gradient bands + wireframe ring highlights + distance fog.
// Lightweight GPU tier.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_speed_scale;
uniform float u_zoom_scale;

const int   MAX_STEPS = 64;
const float MAX_DIST  = 80.0;
// World-z reconstruction loses precision at bends later in the flight.
// 5e-5 avoids float32 stalls while keeping near-tangent first-hit errors small.
const float HIT_EPS   = 0.00005;

#define PS1_QUANTIZE 1

// Set once per frame in main(). Models forward flight by
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

    // The radial field is negative inside; abs(field) is not a distance
    // bound along a curved axis and can skip the first wall near a bend.
    // Global bounds on q' and q'' along this ray. The radial curvature
    // bound requires |q| >= 2; clip its step to preserve that condition.
    float zspeed = abs(rd.z);
    float vmax = length(rd.xy) + length(vec2(0.204, 0.3)) * zspeed;
    float lipschitz = vmax + 0.05 * zspeed;
    float curvature = length(vec2(0.03468, 0.03)) * zspeed * zspeed
                    + vmax * vmax * 0.5 + 0.005 * zspeed * zspeed;
    float t = 0.0;
    vec3 p = ro;
    int iter_count = 0;
    bool hit = false;
    for (int i = 0; i < MAX_STEPS; i++) {
        float z = p.z - g_z_offset;
        vec2 q = p.xy - TunnelCenter(z);
        float qlen = length(q);
        float d = qlen - (sin(z * 0.1) * 0.5 + 3.0);
        iter_count = i + 1;
        if (abs(d) < HIT_EPS) { hit = true; break; }
        if (t > MAX_DIST) break;
        vec2 center_slope = vec2(0.204 * cos(z * 0.17),
                                 0.3 * cos(z * 0.1 + 4.0));
        float slope = dot(q / max(qlen, 0.000001), rd.xy - center_slope * rd.z)
                    - 0.05 * cos(z * 0.1) * rd.z;
        float safe_step = max(-d / lipschitz, 0.0);
        // Rationalize the positive-slope root to avoid subtracting nearly
        // equal float32 values at the wall (which previously stalled rays).
        float discriminant = sqrt(max(slope * slope - 2.0 * curvature * d, 0.0));
        float quadratic_step = slope >= 0.0
            ? (-2.0 * d) / max(slope + discriminant, 0.000001)
            : (discriminant - slope) / curvature;
        float room = max(qlen - 2.0, 0.0) / vmax;
        float advance = qlen > 2.0 ? max(safe_step, min(quadratic_step, room)) : safe_step;
        advance *= 0.9999;
        t += advance;
        p = ro + t * rd;
    }

    // ---------------------------------------------------------------------------
    // Shading — no normals, no lighting; palette IS the color.
    // ---------------------------------------------------------------------------
    float phase = t * 0.1 + u_time * u_speed_scale * 0.7;
    float t_pal = fract(phase);

    // Gradient bands
    vec3 col = palette(t_pal);

    // Wireframe ring highlight — bright thin line at band boundaries (4% width)
    float to_line = abs(t_pal - 0.5);
    float ring_line = smoothstep(0.48, 0.5, to_line);
    col += ring_line * vec3(0.4);

    // Iteration-count rim: brightens pixels where the ray grazed the wall tangentially.
    col += sqrt(float(iter_count)) * 0.005;

    // Distance fog fades the far wall to palette(0.0). t is monotonic-positive
    // with abs-step march, so no max(t, 0.0) guard needed.
    float fog = 1.0 - exp(-t * 0.025);
    col = mix(col, palette(0.0), hit ? fog : 1.0);

    col = clamp(col, 0.0, 1.0);

#if PS1_QUANTIZE
    const mat4 bayer4 = mat4(
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0
    ) / 16.0 - 0.5;

    ivec2 px = ivec2(gl_FragCoord.xy) & 3;
    float dither = bayer4[px.x][px.y] / 32.0;
    col = floor(col * 32.0 + dither + 0.5) / 32.0;
#endif

    fragColor = vec4(col, 1.0);
}
