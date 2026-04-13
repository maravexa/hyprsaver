#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — wormhole.frag
//
// Curving wormhole tunnel via 2D polar inverse-radius mapping.
// O(1) per fragment — no raymarching, no loops.
//
// Technique:
//   1. Offset UV by a sine-based centerline wobble (pure trig, no noise).
//   2. Convert to polar: angle = atan(y, x), radius = length(uv).
//   3. depth = 1/radius — standard inverse tunnel mapping.
//      Near screen center = far in tunnel.  Near screen edge = close to camera.
//   4. Ring pattern: fract(depth * ring_freq + t * speed) with sharp smoothstep.
//   5. Color: palette(fract(depth * color_freq + t * color_shift)).
//   6. Depth fog: fade to black as depth grows large (near center).
//   7. Center glow: bright exit-light circle at the vanishing point.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_alpha;

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;

void main() {
    vec2 fc = gl_FragCoord.xy;
    float t = u_time * u_speed_scale;

    // Normalized UV: (0,0) = screen center, aspect-corrected.
    vec2 uv = (fc - 0.5 * u_resolution.xy) / u_resolution.y;

    // ── 1. Centerline wobble ──────────────────────────────────────────────────
    // Use the raw radius of uv to approximate depth for the wobble input.
    // Clamp so wobble doesn't blow up near center.
    float r0      = length(uv);
    float d0      = 1.0 / max(r0, 0.25);    // clamped depth for wobble
    vec2  wobble  = vec2(
        sin(d0 * 0.8 + t * 0.30) * 0.30,
        cos(d0 * 1.1 + t * 0.22) * 0.28
    );
    // Fade displacement to zero near center — prevents orbiting-singularity artifact.
    wobble *= smoothstep(0.0, 0.3, r0);
    vec2  uv2  = uv - wobble;

    // ── 2. Polar conversion ───────────────────────────────────────────────────
    float r_raw  = length(uv2);
    // Clamp to 0.05: prevents 1/r explosion and eliminates the asymmetric
    // "d"-shaped artifact caused by the wobble displacement crossing zero.
    // Fragments inside this zone are rendered as exit glow (see step 7).
    float radius = max(r_raw, 0.05);
    float angle  = atan(uv2.y, uv2.x);      // -PI .. PI

    // ── 3. Depth (inverse radius) ─────────────────────────────────────────────
    float depth = 1.0 / radius;

    // ── 4. Tunnel scroll ──────────────────────────────────────────────────────
    float tunnel_speed = 0.55;
    float scroll = depth + t * tunnel_speed;

    // ── Ring pattern ─────────────────────────────────────────────────────────
    // Rings spaced evenly in depth-space; zoom forward as t increases.
    float ring_freq = 2.8;
    float ring_coord = fract(scroll * ring_freq);
    // Sharp ring edges (thin bright lines)
    float ring_str = smoothstep(0.42, 0.36, abs(ring_coord - 0.5));

    // Angular segment lines inside each ring (12 sectors)
    float seg_coord  = angle / TAU * 12.0;
    float seg_frac   = abs(fract(seg_coord) - 0.5);
    float seg_str    = smoothstep(0.45, 0.40, seg_frac) * ring_str * 0.35;

    // ── 5. Color ──────────────────────────────────────────────────────────────
    // Wall base color: slow angular + depth drift.
    float wall_t  = fract(angle / TAU + 0.5 + scroll * 0.035);
    vec3  wall    = palette(wall_t) * 0.28;

    // Ring highlight color: per-ring hue rotation.
    float ring_t  = fract(floor(scroll * ring_freq) * 0.11 + t * 0.04);
    vec3  ring_c  = palette(ring_t);

    // Compose: wall + ring lines + angular segments
    vec3 col = wall
             + ring_c * 0.70 * ring_str
             + ring_c * seg_str;

    // ── 6. Depth fog — fade distant geometry to black ─────────────────────────
    // Large depth = near screen center = far in tunnel.
    float fog = smoothstep(4.0, 10.0, depth);
    col = mix(col, vec3(0.0), fog);

    // ── 7. Center glow — exit light at vanishing point ────────────────────────
    // Use r_raw (unclamped) so the Gaussian glow peaks sharply at true center.
    float center_glow = exp(-r_raw * r_raw * 28.0);
    col += palette(0.5) * center_glow * 0.90;
    // Fragments inside the clamp zone (r_raw < 0.05) are fully fogged already;
    // blend them into a bright exit-light disc for a clean tunnel vanishing point.
    float exit_glow = smoothstep(0.05, 0.0, r_raw);
    col = mix(col, palette(0.5) * 1.5, exit_glow);

    // ── Near-camera vignette (large radius = close to viewer) ────────────────
    float vignette = smoothstep(1.0, 0.55, radius);
    col *= vignette;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
