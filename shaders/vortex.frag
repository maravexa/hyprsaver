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
//   - Depth-dependent angular bend: angle_offset is added directly to angle
//     for texture lookup, and grows with depth (not multiplied by r).  Deep
//     pixels (large depth = small r) receive a larger angular offset, so the
//     segment marks on far ring bands appear at different angular positions than
//     near ring bands — the brain reads this parallax as tunnel curvature.
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
    // Add an angular offset directly to angle (NOT to the UV vector).
    //
    // Previous attempts used  displaced_uv + bend * r  which cancels at depth:
    // large depth means small r, so bend * r → 0 exactly where it should peak.
    // This approach adds the offset directly to angle and scales it by depth
    // (implicitly, via sin/cos of depth), so the bend GROWS the deeper you look.
    //
    // Two sinusoidal bends at slightly different frequencies produce an S-curve
    // that varies over time (animated by t terms), so the tunnel feels alive.
    // smoothstep(1.0, 6.0, depth) ramps the offset up gradually so the near-
    // field ring bands stay stable and the curvature builds into the mid-field.
    //
    // bent_angle is used ONLY for texture lookup — fog, disc, and all geometry
    // still use the original angle / r / depth (singularity fix preserved).
    float bend1       = sin(depth * 0.15 + t * 0.25) * 0.8;
    float bend2       = cos(depth * 0.22 + t * 0.18) * 0.5;
    float angle_offset = (bend1 + bend2) * smoothstep(1.0, 6.0, depth) * 0.45;
    float bent_angle  = angle + angle_offset;

    // ── 4. Animated scroll — viewer pulled inward ────────────────────────────
    float scroll = t * 1.8;

    // ── 5. Ribbed ring wall texture (wormhole.frag cartoon style) ────────────
    //
    // Ring bands keyed to depth + scroll. floor() gives a discrete per-ring
    // integer index — this is what creates the cartoon stepped-colour effect.
    //
    // Extreme curvature test — rings should be wildly distorted.
    // * 3.0 gives ring_warp amplitude of ±1.755 at max angle_offset, shifting
    // rings by nearly 3.5 ring widths across the tunnel diameter.
    float ring_warp = sin(bent_angle) * angle_offset * 3.0;
    float scroll_depth = depth + scroll * 0.28 + ring_warp;
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
    vec3 ring_col = palette(fract(ring_idx * 0.125 + t * 0.05 + angle_offset * 0.08));

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
    //
    // fog_warp: angular variation of the fog threshold — one side of the tunnel
    // appears deeper (darker) than the other. This is an INDEPENDENT visual cue
    // for curvature on top of the ring_warp phase shift above. The brain reads
    // asymmetric darkness-with-depth as the tunnel turning.
    float fog_warp = sin(bent_angle) * angle_offset * 0.3;
    float fog = smoothstep(12.0 + fog_warp * 3.0, 5.0, depth);
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
