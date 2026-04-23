#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — mobius.frag
//
// Race along a twisted Möbius ribbon against the void.
// Camera rides the strip at v=0, elevated slightly in the surface-normal
// direction, looking forward along the ring. The half-twist manifests as
// a palette-gradient flip after each full 2π loop — the signature Möbius
// property. Background is pure black vec3(0.0): intentional aesthetic
// exception, not palette-derived.
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
const float SPEED          = 0.4;    // radians / sec camera advance
const float LOOK_AHEAD     = 0.7;    // radians ahead for look-at target
const float ELEV           = 0.15;   // elevation above surface in surf-normal dir
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
    // Camera: rides the center line (v=0) elevated by ELEV in the surface normal.
    // surf_normal = cross(∂P/∂u, ∂P/∂v)|_{v=0}
    //             = (cos(u)·sin(u/2),  sin(u)·sin(u/2),  −cos(u/2))
    // wdir (ribbon width direction):
    //             = (cos(u/2)·cos(u),  cos(u/2)·sin(u),  sin(u/2))
    // wdir ⊥ ring tangent always, so cross(fwd, wdir) is safe as up-hint.
    // ---------------------------------------------------------------------------
    float ch_cam = cos(u_cam * 0.5);
    float sh_cam = sin(u_cam * 0.5);
    float cu     = cos(u_cam);
    float su     = sin(u_cam);

    vec3 strip_pos  = vec3(R * cu, R * su, 0.0);
    vec3 wdir_cam   = vec3(ch_cam * cu, ch_cam * su,  sh_cam);
    vec3 snorm_cam  = vec3(cu * sh_cam, su * sh_cam, -ch_cam);

    vec3 ro = strip_pos + ELEV * snorm_cam;

    // Look-ahead target on center circle
    float u_look = u_cam + LOOK_AHEAD;
    vec3 ta = vec3(R * cos(u_look), R * sin(u_look), 0.0);

    // Orthonormal view basis
    vec3 fwd    = normalize(ta - ro);
    vec3 right  = normalize(cross(fwd, wdir_cam));
    vec3 cam_up = cross(right, fwd);   // recomputed for clean ortho basis

    // Ray direction from NDC
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    uv /= u_zoom_scale;
    vec3 rd = normalize(uv.x * right + uv.y * cam_up + fwd);

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
