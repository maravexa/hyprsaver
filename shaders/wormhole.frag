#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — wormhole.frag (v2)
//
// Curving wormhole tunnel with ring-textured walls.
//
// The original wormhole used a 48-step SDF raymarcher to fly the camera along
// a sinusoidal centerline. This rewrite preserves the centerline() curve math
// exactly but replaces the expensive raymarcher with a 2D polar pipeline
// (same technique as the former vortex shader).
//
// Curve technique:
//   centerline(z) gives the XY offset of the tunnel axis at depth z. The
//   camera follows this path (cam_xy = centerline(cam_z)). In 2D polar space
//   the curvature manifests as two effects:
//     1. Wobbling tunnel mouth — the displaced polar origin tracks the camera's
//        look-ahead direction: center = centerline(cam_z+3) - cam_xy, scaled to
//        ≤ 15% screen height. This shifts the vanishing point as the path bends.
//     2. Depth-angular bend — at apparent depth d the tunnel center is at
//        centerline(cam_z + d*scale). The angle of that XY offset (atan2) is
//        added to the texture lookup angle, so far rings appear angularly
//        shifted relative to near rings — the brain reads this as curvature.
//
// Rendering pipeline (2D polar, O(1) per pixel):
//   - Displaced-center polar coords (singularity at wobbling center, not origin)
//   - Centerline-driven angular bend applied only to texture lookup (bent_angle)
//   - Ribbed ring texture: sharp 0.06-width rib pulses, per-ring integer-indexed
//     palette colors (ring_idx * 0.125), 12 angular segment dividers
//   - Dark disc at the vanishing point — eliminates the old center glow artifact
//   - Radial vignette at screen edges
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_alpha;

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;

// ── Tunnel centerline (preserved verbatim from the raymarched version) ─────
// Two sine/cosine harmonics per axis → smoothly curving path that never
// doubles back on itself (z is the parameter / travel distance).
vec2 centerline(float z) {
    return vec2(
        sin(z * 0.25) * 0.55 + sin(z * 0.13) * 0.25,
        cos(z * 0.19) * 0.45 + cos(z * 0.09) * 0.20
    );
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    float t = u_time * u_speed_scale;

    // ── Camera position along the centerline ──────────────────────────────
    float cam_z  = t * 1.2;
    vec2  cam_xy = centerline(cam_z);

    // ── 1. Wobbling tunnel mouth — displaced polar center ─────────────────
    // The look-ahead vector (3 units forward) gives the direction the tunnel
    // is heading from the camera's viewpoint. Scaling to ~14% screen height
    // keeps the singularity well within the screen without clipping.
    vec2 look_ahead = centerline(cam_z + 3.0) - cam_xy;
    vec2 center     = look_ahead * 0.18;

    // ── 2. Displaced polar coordinates ───────────────────────────────────
    // Singularity lives at (center), not at screen origin.
    vec2  displaced_uv = uv - center;
    float r             = length(displaced_uv);
    float angle         = atan(displaced_uv.y, displaced_uv.x);
    float depth         = 1.0 / max(r, 0.005);

    // ── Animated scroll — viewer pulled inward ────────────────────────────
    float scroll = t * 1.2;

    // ── 3. Centerline-driven angular bend — tunnel curvature illusion ─────
    // Sample the centerline at an apparent tunnel depth (capped at 15 to
    // prevent probe_z from oscillating wildly near the centre singularity).
    // The XY offset of the centerline relative to the camera, converted to an
    // angle, tells us how much the tunnel has bent by that depth. Adding this
    // to the texture-lookup angle makes far rings appear to shift angularly,
    // which the visual system interprets as the tunnel curving away.
    //
    // ONLY bent_angle is used for texture lookups. Geometry (r, depth, disc)
    // always uses the original angle so the singularity fix is unaffected.
    float probe_depth  = min(depth, 15.0);
    float probe_z      = cam_z + probe_depth * 0.7 * u_zoom_scale;
    vec2  c_probe      = centerline(probe_z) - cam_xy;
    float angle_offset = atan(c_probe.y, c_probe.x)
                         * smoothstep(0.8, 5.0, depth) * 0.55;
    float bent_angle   = angle + angle_offset;

    // ── 4. Ribbed ring wall texture ────────────────────────────────────────
    // Ring bands keyed to depth + scroll. Two sinusoidal harmonics warp the
    // ring boundaries slightly, adding the impression of tubes tilting around
    // the curve. Integer-multiplier angles keep the seams closed.
    float curve1    = sin(angle * 1.0 + depth * 0.4 + t * 0.25) * 0.6;
    float curve2    = sin(angle * 2.0 + depth * 0.25 + t * 0.15) * 0.15;
    float ring_warp = (curve1 + curve2) * smoothstep(0.3, 1.5, depth);

    float scroll_depth = depth + scroll * 0.28 + ring_warp;
    float ring_phase   = fract(scroll_depth);
    float ring_idx     = floor(scroll_depth);

    // Sharp rib pulse — narrow 0.06 window → hard cartoon ring edges.
    // Mirrors the original wormhole: smoothstep(0.06, 0.0, abs(f-0.5)*2.0)
    float rib_str = smoothstep(0.06, 0.0, abs(ring_phase - 0.5) * 2.0);

    // Base wall — subdued angular + depth pattern on inter-ring surfaces.
    // Uses bent_angle so the base texture curves with the tunnel bend.
    float base_t    = fract(bent_angle / TAU + 0.5 + depth * 0.04 - t * 0.028);
    vec3  base_wall = palette(base_t) * 0.3;

    // Per-ring colour: integer-indexed → distinct colour per ring, not gradient.
    // Mirrors original: palette(fract(ring_idx * 0.125 + t * 0.05))
    vec3 ring_col = palette(fract(ring_idx * 0.125 + t * 0.05 + angle_offset * 0.08));

    // Blend: dark/subdued base ↔ bright ring. High contrast = cartoon bands.
    vec3 wall = mix(base_wall, ring_col * 0.65, rib_str);

    // Angular segment dividers on rib bands — 12 divisions (integer: seam-free).
    // Uses bent_angle so the tick marks curve with the tunnel.
    float seg = smoothstep(0.02, 0.0, abs(fract(bent_angle / TAU * 12.0) - 0.5) - 0.45);
    wall += ring_col * seg * rib_str * 0.15;

    // ── 5. Radial vignette at screen edges ────────────────────────────────
    float vignette = 1.0 - smoothstep(0.55, 0.85, length(uv));
    wall *= vignette;

    // ── 6. Dark disc at the vanishing point ───────────────────────────────
    // Smooth black fade at the tunnel mouth so the 1/r singularity transitions
    // to black cleanly — eliminates the center glow artifact of the old version.
    float disc = smoothstep(0.018, 0.0, r);
    wall = mix(wall, vec3(0.0), disc);

    fragColor = vec4(clamp(wall, 0.0, 1.0), u_alpha);
}
