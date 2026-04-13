#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — vortex.frag
//
// Polar tunnel with wobbling mouth, depth-angular curvature, and
// wormhole-inspired ribbed-ring cartoon wall texture.
//
// Architecture:
//   - Displaced-center polar coordinates (singularity fix: the vanishing point
//     sits at the wobbled center, not the screen center).
//   - Depth-dependent angular bend: the angle used for texture lookup shifts as
//     a function of depth (1/r). At deep pixels the angle deviates ~31° from
//     shallow pixels, producing a parallax the brain reads as tunnel curvature.
//     Geometry (fog, disc) uses the original r/depth/angle, so rings remain
//     circular and the singularity fix is unaffected.
//   - Wall texture mirrors wormhole.frag exactly: sharp 0.06-width rib pulses,
//     per-ring integer-indexed palette colors (ring_idx * 0.125), subdued base
//     wall (0.3), bright ring bands (0.65), 12 angular segment dividers.
//
// Features:
//   1. Wobbling tunnel mouth — slow Lissajous drift, ≤15% of screen height.
//   2. Depth-angular curvature — far end bends away, hiding behind fog.
//   3. Ribbed ring wall texture — wormhole cartoon band shading.
//   4. Angular segment marks — 12 per ring (integer multipliers, seam-free).
//   5. Depth fog — far end fades to black; tight range enhances curve feel.
//   6. Dark vanishing-point disc — smooth black center at tunnel mouth.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_alpha;

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;

void main() {
    // ── Standard centered UV ────────────────────────────────────────────────
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    float t = u_time * u_speed_scale;

    // ── 1. Wobbling tunnel mouth (displaced center) ──────────────────────────
    // Two independent sinusoids per axis → organic, non-repeating drift.
    vec2 center = vec2(
        sin(t * 0.31) * 0.13 + sin(t * 0.17) * 0.05,
        cos(t * 0.37) * 0.10 + cos(t * 0.21) * 0.04
    );

    // ── 2. Displaced polar coordinates ──────────────────────────────────────
    // The singularity lives at (center), not at screen center.
    // r, angle, depth are used for ALL geometry (fog, disc, ring bands).
    vec2  displaced_uv = uv - center;
    float r             = length(displaced_uv);
    float angle         = atan(displaced_uv.y, displaced_uv.x);
    float depth         = 1.0 / max(r, 0.005);

    // ── 3. Depth-dependent angular bend — tunnel curvature illusion ──────────
    // Offset the angle used for TEXTURE lookup as a function of depth.
    // Deep pixels (small r → large depth) see a larger angular offset than
    // shallow pixels. The segment marks on each ring band appear at different
    // angular positions at different depths; the brain reads this parallax as
    // the tunnel curving around a bend.
    //
    // bend_amount = 0.6 → max angular deviation ≈ arctan(0.6) ≈ 31°.
    // x/y components use different frequencies so the tunnel curves in varied
    // directions (S-bend), not a uniform helix.
    // u_time terms animate the bends so the passage feels alive.
    float bend_amount  = 0.6;
    float bend_freq    = 0.15;
    float bend_phase_x = sin(depth * bend_freq         + t * 0.20) * bend_amount;
    float bend_phase_y = cos(depth * bend_freq * 0.8   + t * 0.15) * bend_amount * 0.7;

    // Scale bend by r: nearby pixels get proportional (not absolute) offset.
    vec2  bent_dir   = displaced_uv + vec2(bend_phase_x, bend_phase_y) * r;
    float bent_angle = atan(bent_dir.y, bent_dir.x);

    // ── 4. Animated scroll — viewer pulled inward ────────────────────────────
    float scroll = t * 1.8;

    // ── 5. Ribbed ring wall texture (wormhole.frag cartoon style) ────────────
    //
    // Ring bands keyed to depth + scroll. floor() gives a discrete per-ring
    // integer index — this is what creates the cartoon stepped-colour effect.
    float scroll_depth = depth + scroll * 0.28;
    float ring_phase   = fract(scroll_depth);
    float ring_idx     = floor(scroll_depth);

    // Sharp rib pulse. Narrow 0.06 window → hard cartoon ring edges.
    // Mirrors wormhole exactly: smoothstep(0.06, 0.0, abs(f - 0.5) * 2.0)
    float rib_str = smoothstep(0.06, 0.0, abs(ring_phase - 0.5) * 2.0);

    // Base wall — subdued angular + depth pattern on inter-ring surfaces.
    // Uses bent_angle so the base texture curves with the bend.
    // Mirrors wormhole: fract(angle / TAU + 0.5 + p.z * 0.04)  * 0.3
    float base_t  = fract(bent_angle / TAU + 0.5 + depth * 0.04 - t * 0.028);
    vec3  base_wall = palette(base_t) * 0.3;

    // Per-ring color: integer-indexed → distinct color per ring, not gradient.
    // Mirrors wormhole exactly: palette(fract(ring_idx * 0.125 + t * 0.05))
    vec3 ring_col = palette(fract(ring_idx * 0.125 + t * 0.05));

    // Blend: dark/subdued base ↔ bright ring. High contrast = cartoon bands.
    // Mirrors wormhole exactly: mix(wall, ring_col * 0.65, rib_str)
    vec3 wall = mix(base_wall, ring_col * 0.65, rib_str);

    // Angular segment dividers on rib bands — 12 divisions (integer: no seam).
    // Uses bent_angle so the tick marks curve with the tunnel.
    // Mirrors wormhole exactly: smoothstep(0.02, 0.0, abs(fract(...*12)-0.5)-0.45)
    float seg = smoothstep(0.02, 0.0, abs(fract(bent_angle / TAU * 12.0) - 0.5) - 0.45);
    wall += ring_col * seg * rib_str * 0.15;

    // ── 6. Depth fog — tighter range so curvature hides the far end ──────────
    // smoothstep(hi, lo, depth): 1.0 near viewer, 0.0 deep in tunnel.
    // Fog fully kicks in by depth=12 (r≈0.083) so bends curve into darkness.
    float fog = smoothstep(12.0, 5.0, depth);
    wall *= fog;

    // ── 7. Radial vignette at screen edges ───────────────────────────────────
    float vignette = 1.0 - smoothstep(0.55, 0.85, length(uv));
    wall *= vignette;

    // ── 8. Dark disc at the vanishing point ──────────────────────────────────
    // Smooth black fade at the tunnel mouth center so the 1/r singularity
    // transitions to black cleanly rather than flickering at extreme depth.
    float disc = smoothstep(0.018, 0.0, r);
    wall = mix(wall, vec3(0.0), disc);

    fragColor = vec4(clamp(wall, 0.0, 1.0), u_alpha);
}
