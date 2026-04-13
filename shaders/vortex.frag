#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — vortex.frag
//
// Polar tunnel with wobbling mouth, depth-dependent curvature, and
// wormhole-inspired ribbed-ring wall texture.
//
// Architecture: two-pass displaced-center polar coordinates.
//   Pass 1: compute initial depth from the wobbled center (singularity fix).
//   Pass 2: apply a depth-dependent curve_offset so deep pixels see a shifted
//           vanishing point — the brain reads this parallax as tunnel curvature.
//
// Wall texture adapted from wormhole.frag's ribbed-ring style:
//   - fract(depth) ring banding with floor()-indexed per-ring palette colors
//   - smoothstep rib pulses for sharp ring edges (cartoon/mechanical feel)
//   - 8-segment angular dividers on each rib band (all angle multipliers integer)
//   - Subdued inter-ring base wall blended against bright ring color
//
// Features:
//   1. Wobbling tunnel mouth — slow Lissajous drift, ~15% of screen height.
//   2. Depth-dependent curvature — far tunnel bends away, hiding its far end.
//   3. Ribbed ring wall texture — concentric bands with per-ring palette colors.
//   4. Angular segment marks — 8 tick marks per ring (integer multipliers only).
//   5. Depth fog — far end fades to palette(0.0); tight range for curvature feel.
//   6. Dark vanishing-point disc — smooth singularity at the tunnel mouth.
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
    // Two independent sinusoids per axis give organic, non-repeating motion.
    // Amplitude kept at ≤15% of screen height to stay roughly centred.
    vec2 center = vec2(
        sin(t * 0.31) * 0.13 + sin(t * 0.17) * 0.05,
        cos(t * 0.37) * 0.10 + cos(t * 0.21) * 0.04
    );

    // ── 2. Pass 1 — initial polar coords for curvature depth estimate ────────
    // The singularity lives at (center), not at screen center.
    vec2  pre_uv    = uv - center;
    float r_pre     = length(pre_uv);
    float depth_pre = 1.0 / max(r_pre, 0.005);

    // ── 3. Depth-dependent curve offset — visible tunnel curvature ───────────
    // Each depth level sees a slightly different vanishing point.  The brain
    // interprets the resulting parallax shift between concentric rings as the
    // tunnel curving away into the distance.
    //
    // The smoothstep blend ensures the tunnel mouth (low depth) is stable while
    // the far end (high depth) bends — so the viewer feels the tunnel curve
    // around a corner rather than the whole scene wobbling.
    vec2 curve_offset = vec2(
        sin(depth_pre * 0.4  + t * 0.25) * 0.12,
        cos(depth_pre * 0.35 + t * 0.18) * 0.08
    );
    curve_offset *= smoothstep(1.0, 8.0, depth_pre);

    // ── 4. Pass 2 — final polar coords with curvature applied ───────────────
    vec2  curved_uv = uv - center - curve_offset;
    float r          = length(curved_uv);
    float angle      = atan(curved_uv.y, curved_uv.x);
    float depth      = 1.0 / max(r, 0.005);

    // ── 5. Animated scroll — viewer pulled inward ────────────────────────────
    // Adding scroll to the depth phase shifts ring boundaries toward lower
    // depth (screen edge) over time, creating the illusion of forward motion.
    float scroll = t * 1.8;

    // ── 6. Ribbed ring wall texture (adapted from wormhole.frag) ─────────────
    // Ring bands from the scrolled depth; floor() gives a discrete per-ring
    // index — the source of the cartoon/mechanical colour-stepping effect.

    float scroll_depth = depth + scroll * 0.28;
    float ring_phase   = fract(scroll_depth);
    float ring_idx     = floor(scroll_depth);

    // Rib strength: narrow smoothstep pulse centred on each ring boundary.
    // Mirrors wormhole's: smoothstep(0.06, 0.0, abs(ring_frc - 0.5) * 2.0)
    float rib_str = smoothstep(0.07, 0.0, abs(ring_phase - 0.5) * 2.0);

    // Base wall — subdued angular + depth pattern on inter-ring surfaces.
    // Mirrors wormhole's: fract(angle / TAU + 0.5 + p.z * 0.04)
    float base_t    = fract(angle / TAU + 0.5 + depth * 0.038 - t * 0.028);
    vec3  base_wall  = palette(base_t) * 0.28;

    // Per-ring color: each ring gets a slowly-evolving palette entry keyed to
    // its integer index — creates the distinct colour bands of the wormhole look.
    // Mirrors wormhole's: palette(fract(ring_idx * 0.125 + t * 0.05))
    vec3  ring_col = palette(fract(ring_idx * 0.13 + t * 0.05));

    // Blend: inter-ring zones are dark/subdued; ring bands glow with ring_col.
    vec3 wall = mix(base_wall, ring_col * 0.70, rib_str);

    // Angular segment marks on rib bands — 8 divisions around the circumference.
    // Multiplier 8 is an integer → fract(angle/TAU * 8) is seamless at ±π.
    // Mirrors wormhole's 12-segment divider pattern with 8 for a chunkier feel.
    float seg_phase = abs(fract(angle / TAU * 8.0) - 0.5) - 0.41;
    float seg       = smoothstep(0.025, 0.0, seg_phase);
    wall += ring_col * seg * rib_str * 0.22;

    // Spiral accent in inter-ring zones — single spiral arm (4 is integer).
    // Stays subtle: blended only where rib_str is low (between rings).
    float spiral  = sin(depth * 6.0 + scroll - angle * 4.0) * 0.5 + 0.5;
    wall += palette(fract(base_t + spiral * 0.22)) * (1.0 - rib_str) * 0.11;

    // ── 7. Depth fog — tighter range so curvature hides the far end ──────────
    // smoothstep(hi, lo, depth): 1.0 near viewer, 0.0 deep in tunnel.
    // Clamping at depth≈12 (r≈0.083) means bends curve into dark fog.
    float fog = smoothstep(12.0, 5.0, depth);
    wall *= fog;

    // ── 8. Radial vignette at screen edges ───────────────────────────────────
    float vignette = 1.0 - smoothstep(0.55, 0.85, length(uv));
    wall *= vignette;

    // ── 9. Dark disc at the vanishing point ──────────────────────────────────
    // Smoothly darkens the very center of the tunnel mouth so the 1/r
    // singularity fades to black rather than flickering at extreme depth.
    float disc = smoothstep(0.018, 0.0, r);
    wall = mix(wall, vec3(0.0), disc);

    fragColor = vec4(clamp(wall, 0.0, 1.0), u_alpha);
}
