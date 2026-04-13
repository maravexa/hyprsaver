#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — vortex.frag
//
// Polar tunnel with a wobbling mouth — a 2D polar inverse-radius mapping that
// eliminates the fixed center singularity present in wormhole.frag.
//
// Architecture: polar coordinates are computed relative to the *displaced*
// (wobbled) center rather than from screen center.  This means the 1/r
// singularity lives at the tunnel mouth — the natural vanishing point — rather
// than being permanently pinned to screen center.
//
// Features:
//   1. Wobbling tunnel mouth — slow Lissajous drift, ~15% of screen height.
//   2. Concentric ring + spiral texture receding into depth.
//   3. Depth fog — tunnel fades to black beyond a tunable depth threshold.
//   4. Palette-mapped color — depth and angle modulate the LUT lookup.
//   5. Subtle dark vanishing-point disc at the mouth to smooth the singularity.
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

    // ── 1. Wobbling tunnel mouth (displaced center) ─────────────────────────
    // Two independent sinusoids per axis give organic, non-repeating motion.
    // Amplitude kept at ≤15% of screen height to stay roughly centred.
    vec2 center = vec2(
        sin(t * 0.31) * 0.13 + sin(t * 0.17) * 0.05,
        cos(t * 0.37) * 0.10 + cos(t * 0.21) * 0.04
    );

    // ── 2. Polar coordinates from the DISPLACED center ──────────────────────
    // Key architectural decision: uv_d, not uv.  The 1/r singularity now lives
    // exactly at the tunnel mouth and naturally serves as the vanishing point.
    vec2  uv_d = uv - center;
    float r    = length(uv_d);
    float ang  = atan(uv_d.y, uv_d.x);   // [-π, π]

    // ── 3. Tunnel depth from inverse radius ─────────────────────────────────
    // max() clamp prevents division-by-zero; operates on r from displaced uv.
    float depth = 1.0 / max(r, 0.005);

    // ── 4. Animated depth offset — viewer pulled inward ─────────────────────
    float scroll = t * 1.8;

    // ── 5. Tunnel wall texture: rings + spiral ───────────────────────────────
    // depth * K  → ring density  (K=5 gives ~5 visible rings across the screen)
    // ang * N    → N-armed spiral (N=2 is subtle, N=4 is more pronounced)
    // scroll     → animates the rings scrolling inward (flying into the tunnel)
    float ring_wave  = sin(depth * 5.0 - scroll + ang * 2.5);
    float tunnel_tex = ring_wave * 0.5 + 0.5;   // remap to [0, 1]

    // Secondary fine detail layer — higher frequency, opposite spiral
    float detail     = sin(depth * 12.0 - scroll * 1.4 - ang * 1.5) * 0.5 + 0.5;
    tunnel_tex = mix(tunnel_tex, detail, 0.25);

    // ── 6. Palette lookup — depth tints far tunnel differently ───────────────
    // Slow depth drift ensures color changes as the tunnel recedes.
    float pal_t = fract(tunnel_tex + depth * 0.018 - t * 0.04);
    vec3 color  = palette(pal_t);

    // Brighten the ring crests slightly for a ribbed glowing effect
    float crest = smoothstep(0.4, 0.8, ring_wave * 0.5 + 0.5);
    color += palette(fract(pal_t + 0.3)) * crest * 0.25;

    // ── 7. Depth fog — fade to black in the deep tunnel ─────────────────────
    // smoothstep(lo, hi, depth): lo = fog onset, hi = fully black.
    // Depth values: r≈0.3 → depth≈3.3, r≈0.05 → depth≈20.
    float fog = smoothstep(18.0, 8.0, depth);   // 1.0 near, 0.0 far
    color *= fog;

    // ── 8. Radial vignette at screen edges ──────────────────────────────────
    float vignette = 1.0 - smoothstep(0.55, 0.85, length(uv));
    color *= vignette;

    // ── 9. Dark disc at the vanishing point ─────────────────────────────────
    // Optional cosmetic: smoothly darkens the very center of the tunnel mouth
    // so the infinite-depth singularity fades to black rather than flickering.
    float disc = smoothstep(0.018, 0.0, r);
    color = mix(color, vec3(0.0), disc);

    fragColor = vec4(clamp(color, 0.0, 1.0), u_alpha);
}
