#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — mobius.frag
//
// Race along a twisted Möbius ribbon against the void.
// Camera is elevated above the strip's surface normal, looking slightly
// down so the ribbon occupies the lower portion of the frame.  A slow
// secondary roll (ROLL_SPEED rad/sec) rotates the camera around the
// forward axis, adding visual variety on top of the natural half-twist
// rhythm.  The half-twist flips the palette gradient after each full 2π
// loop — the signature Möbius property.  Background is pure black
// vec3(0.0): intentional aesthetic exception, not palette-derived.
//
// SDF uses a local torus-frame decomposition:
//   theta = atan(p.y, p.x) gives the nearest u parameter.
//   In the (radial-R, z) plane the ribbon width direction is
//   (cos(theta/2), sin(theta/2)), matching the parametric Möbius form.
// Abs-step march: t += max(|d|, MIN_STEP) guarantees monotonic progress
// even when d < 0 (camera started inside the thin ribbon volume).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_speed_scale;
uniform float u_zoom_scale;

const int   MAX_STEPS      = 48;
const float MAX_DIST       = 20.0;
const float HIT_EPS        = 0.001;
const float MIN_STEP       = 0.001;
const float R              = 1.5;    // major radius of ring
const float W              = 0.3;    // ribbon half-width
const float THICKNESS      = 0.018;  // SDF ribbon thickness (half)
const float SPEED          = 1.2;    // radians / sec camera advance (3× v2)
const float ELEVATION      = 0.3;    // off-surface elevation (in rolled_up direction)
const float DIP_ANGLE      = 0.15;   // radians downward tilt toward strip (~8.6°)
const float ROLL_SPEED     = 0.1;    // rad/sec slow camera roll around forward axis
const float TAU            = 6.283185307;
const float BANDS_PER_LOOP = 8.0;   // colour bands around the full 2π loop

// ---------------------------------------------------------------------------
// mobiusSDF — signed distance to the Möbius ribbon.
// Works in the (dr, dz) = (rxy−R, p.z) half-plane at angle theta.
// Width direction in that plane: (cos(theta/2), sin(theta/2)).
// Perp direction (ribbon thickness): (−sin(theta/2), cos(theta/2)).
// Returns negative inside the ribbon volume, positive outside.
// ---------------------------------------------------------------------------
float mobiusSDF(vec3 p) {
    float rxy   = max(length(p.xy), 0.001);
    float theta = atan(p.y, p.x);
    float ch    = cos(theta * 0.5);
    float sh    = sin(theta * 0.5);
    float dr    = rxy - R;
    // Project (dr, p.z) onto ribbon axes
    float v     =  dr * ch + p.z * sh;   // along ribbon width  in [-W, W]
    float perp  = -dr * sh + p.z * ch;   // through ribbon thickness
    float v_ex  = max(abs(v) - W, 0.0);  // excess past edge (0 inside width)
    return sqrt(perp * perp + v_ex * v_ex) - THICKNESS;
}

void main() {
    float u_cam = u_time * u_speed_scale * SPEED;

    // ---------------------------------------------------------------------------
    // Camera: elevated above the surface, looking slightly down, with a slow
    // secondary roll around the forward axis.
    //
    // Surface frame at u_cam, v=0:
    //   tangent   = dP/du|_{v=0} = (−sin u, cos u, 0)  (unit)
    //   wdir_cam  = dP/dv|_{v=0} = (cos(u/2)·cos u, cos(u/2)·sin u, sin(u/2))
    //               — ribbon width / binormal direction
    //   snorm_cam = surface normal = (cos u·sin(u/2), sin u·sin(u/2), −cos(u/2))
    //
    // Roll rotates the (snorm_cam, wdir_cam) plane around the tangent axis,
    // so rolled_up sweeps from normal → binormal → −normal → −binormal over
    // one full roll cycle.  DIP_ANGLE tilts the look direction downward so the
    // strip sits in the lower portion of the frame at roll=0.
    // ---------------------------------------------------------------------------
    float ch_cam = cos(u_cam * 0.5);
    float sh_cam = sin(u_cam * 0.5);
    float cu     = cos(u_cam);
    float su     = sin(u_cam);

    vec3 strip_pos = vec3(R * cu, R * su, 0.0);
    vec3 wdir_cam  = vec3(ch_cam * cu, ch_cam * su,  sh_cam);  // binormal
    vec3 snorm_cam = vec3(cu * sh_cam, su * sh_cam, -ch_cam);  // surface normal
    vec3 tangent   = vec3(-su, cu, 0.0);                        // ring tangent (unit)

    // Slow roll: rotate camera's up vector around the forward (tangent) axis
    float roll_rad = u_time * ROLL_SPEED;
    vec3 rolled_up = cos(roll_rad) * snorm_cam + sin(roll_rad) * wdir_cam;

    // Elevate camera off surface and tilt look direction slightly downward
    vec3 ro          = strip_pos + ELEVATION * rolled_up;
    vec3 cam_forward = normalize(tangent - DIP_ANGLE * rolled_up);

    // Re-orthogonalize camera frame (prevents gimbal issues near roll ±90°)
    vec3 right   = normalize(cross(cam_forward, rolled_up));
    vec3 cam_up  = normalize(cross(right, cam_forward));

    // Ray direction from NDC
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    uv /= u_zoom_scale;
    vec3 rd = normalize(uv.x * right + uv.y * cam_up + cam_forward);

    // ---------------------------------------------------------------------------
    // Abs-step sphere march — monotonic progress regardless of d sign.
    // Start t=0.02 to step past any self-intersection at the elevated camera.
    // ---------------------------------------------------------------------------
    float t = 0.02;
    vec3  p = ro + t * rd;
    bool  hit = false;
    for (int i = 0; i < MAX_STEPS; i++) {
        float d = mobiusSDF(p);
        if (abs(d) < HIT_EPS) { hit = true; break; }
        if (t > MAX_DIST) break;
        float step = max(abs(d), MIN_STEP);
        t += step;
        p += step * rd;
    }

    // ---------------------------------------------------------------------------
    // Shading — palette along strip length (u axis); black void elsewhere.
    // ---------------------------------------------------------------------------
    vec3 col;
    if (hit) {
        // Recover v at hit point for edge darkening (same projection as SDF)
        float rxy_h = max(length(p.xy), 0.001);
        float th_h  = atan(p.y, p.x);
        float ch_h  = cos(th_h * 0.5);
        float sh_h  = sin(th_h * 0.5);
        float v_hit = (rxy_h - R) * ch_h + p.z * sh_h;

        // Gradient along strip length (u axis) — bands run perpendicular to travel
        float u_n = fract(th_h / TAU * BANDS_PER_LOOP + 0.5);
        col = palette(u_n);

        // Soft edge darkening — ribbon looks like a solid ribbon, not a flat slab
        float edge = 1.0 - smoothstep(0.85, 1.0, abs(v_hit) / W);
        col *= 0.75 + 0.25 * edge;
    } else {
        col = vec3(0.0);   // pure black void — not palette-derived
    }

    fragColor = vec4(col, 1.0);
}
