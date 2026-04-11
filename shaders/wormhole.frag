#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — wormhole.frag
//
// Curving wormhole tunnel with ring-textured walls. The camera flies forward
// along a sinusoidal centerline. Raymarched with <= 64 steps with adaptive
// step size for clean ring rendering at depth. Features:
//   1. Ribbed ring geometry — concentric ridges at regular z intervals,
//      colored with palette(fract(ring_index * 0.125 + u_time * 0.05)).
//   2. Depth fog — wall fragments beyond z 3.0 fade toward palette(0.0).
//   3. Barrel distortion — subtle fisheye applied before raymarching.
//   4. Exit light — soft glow circle at the tunnel's far end.
//   5. Interior point lights — faint lights every 2.0 z-units on centerline.
//   6. Ring anti-aliasing via fwidth() for crisp lines at all depths.
//   7. Center clamp to prevent NaN/extreme values at vanishing point.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_alpha;

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;

const float TUNNEL_R   = 1.2;    // base tunnel radius
const float RIB_DEPTH  = 0.09;   // how far ribs protrude inward
const float RIB_PERIOD = 1.0;    // one ring every 1.0 z-units
const float MAX_MARCH  = 16.0;   // max ray travel distance
const float EPSILON    = 0.003;  // surface hit threshold

// ── Tunnel centerline displacement ─────────────────────────────────────────
vec2 centerline(float z) {
    return vec2(
        sin(z * 0.25) * 0.55 + sin(z * 0.13) * 0.25,
        cos(z * 0.19) * 0.45 + cos(z * 0.09) * 0.20
    );
}

// ── Scene SDF: curved tunnel with ribbed rings ─────────────────────────────
float map(vec3 p) {
    vec2  c = centerline(p.z);
    float d = length(p.xy - c);

    // Rib ring: sharp inward bump at each integer-z boundary
    float f   = fract(p.z / RIB_PERIOD);
    float rib = smoothstep(0.06, 0.0, abs(f - 0.5) * 2.0);

    return (TUNNEL_R - RIB_DEPTH * rib) - d;
}

// ── Central-difference surface normal ──────────────────────────────────────
vec3 normal_at(vec3 p) {
    const float e = 0.002;
    float d = map(p);
    return normalize(vec3(
        map(p + vec3(e, 0.0, 0.0)) - d,
        map(p + vec3(0.0, e, 0.0)) - d,
        map(p + vec3(0.0, 0.0, e)) - d
    ));
}

// ── Main ───────────────────────────────────────────────────────────────────
void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    float t = u_time * u_speed_scale;

    // ── 3. Barrel distortion — subtle fisheye at edges ─────────────────────
    vec2 uv_d = uv * (1.0 + dot(uv, uv) * 0.1);

    // ── Camera flying along the centerline ─────────────────────────────────
    float cam_z  = t * 1.2;
    vec2  cam_xy = centerline(cam_z);
    vec3  ro     = vec3(cam_xy, cam_z);

    // Look-ahead target for forward direction
    float ahead = 3.0;
    vec3 target  = vec3(centerline(cam_z + ahead), cam_z + ahead);

    vec3 fwd = normalize(target - ro);
    vec3 rgt = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
    vec3 up  = cross(rgt, fwd);

    // Gentle camera roll for immersion
    float roll = sin(t * 0.17) * 0.1;
    float cr = cos(roll), sr = sin(roll);
    vec3 rgt2 = rgt * cr + up * sr;
    vec3 up2  = -rgt * sr + up * cr;

    // Ray direction — u_zoom_scale narrows the FOV (zoom in)
    vec3 rd = normalize(fwd * u_zoom_scale + uv_d.x * rgt2 + uv_d.y * up2);

    // ── Raymarch with adaptive step size (64 steps max) ────────────────────
    // Step size decreases with depth so distant rings get more samples,
    // preventing aliasing/Moiré at the vanishing point.
    float ray_t = 0.0;
    bool  hit   = false;
    vec3  p;

    for (int i = 0; i < 64; i++) {
        p = ro + rd * ray_t;
        float d = map(p);
        if (d < EPSILON) { hit = true; break; }

        // Adaptive step: shrink step as depth increases for finer sampling
        // at distant ring geometry. base_step = d * 0.6 (conservative),
        // scaled down by 1/(1 + depth*0.3).
        float adaptive = d * 0.6 / (1.0 + ray_t * 0.3);
        // Clamp minimum step to avoid infinite loops
        ray_t += max(adaptive, EPSILON * 0.5);

        if (ray_t > MAX_MARCH) break;
    }

    vec3 fog_color = palette(0.0);
    vec3 col       = vec3(0.0);

    if (hit) {
        vec3  n     = normal_at(p);
        float z_cam = length(p - ro);   // distance from camera to hit

        // ── 7. Center clamp — prevent NaN at vanishing point ──────────────
        vec2  c     = centerline(p.z);
        float r_raw = length(p.xy - c);
        float r     = max(r_raw, 0.001);   // clamp minimum radius

        // ── 1. Wall detail: ribbed ring geometry & coloring ────────────────
        float ring_idx = floor(p.z / RIB_PERIOD);

        // ── 6. Ring anti-aliasing via fwidth() ────────────────────────────
        float ring_coord = p.z / RIB_PERIOD;
        float ring_frc   = fract(ring_coord);
        float fw_ring    = fwidth(ring_coord);
        // Anti-aliased rib strength: smooth transition over pixel-width band
        float rib_raw    = abs(ring_frc - 0.5) * 2.0;
        float rib_str    = 1.0 - smoothstep(0.0 - fw_ring, 0.06 + fw_ring, rib_raw);

        float angle = atan(p.y - c.y, p.x - c.x);

        // Base wall: subdued palette pattern from angle + depth
        float wt   = fract(angle / TAU + 0.5 + p.z * 0.04);
        vec3  wall = palette(wt) * 0.3;

        // Ring colour: slow per-ring colour rotation
        vec3 ring_col = palette(fract(ring_idx * 0.125 + t * 0.05));
        wall = mix(wall, ring_col * 0.65, rib_str);

        // Angular segment lines on ribs — 12 segments around circumference
        float seg_coord = angle / TAU * 12.0;
        float fw_seg    = fwidth(seg_coord);
        float seg = 1.0 - smoothstep(0.45 - fw_seg, 0.45 + fw_seg, abs(fract(seg_coord) - 0.5));
        wall += ring_col * seg * rib_str * 0.15;

        // ── 5. Interior point lights ───────────────────────────────────────
        float lighting = 0.0;
        float base_lz  = floor(p.z / 2.0) * 2.0;
        for (int li = -1; li <= 2; li++) {
            float lz  = base_lz + float(li) * 2.0;
            vec3  lp  = vec3(centerline(lz), lz);
            float dl  = length(p - lp);
            lighting += 1.0 / (1.0 + dl * dl * 2.0);
        }

        // Combine diffuse-like shading with point-light contribution
        float ndot = max(dot(n, -rd), 0.0);
        wall *= 0.2 + ndot * 0.25 + lighting * 0.65;

        // ── 2. Depth fog — earlier onset for cleaner vanishing point ───────
        // Start fog at z_cam 3.0, fully fogged by 6.0 (was 4.0→8.0).
        wall = mix(wall, fog_color, smoothstep(3.0, 6.0, z_cam));

        col = wall;

    } else {
        // ── 4. Exit light — soft glow at the tunnel's far end ──────────────
        vec3  far_p = ro + rd * MAX_MARCH;
        vec2  far_c = centerline(far_p.z);
        // Center clamp for exit light too
        float r     = max(length(far_p.xy - far_c), 0.001) / TUNNEL_R;
        float glow  = exp(-r * r * 4.0);
        col = palette(0.5) * glow * 0.45;

        // Light fog tint on the exit glow
        col = mix(col, fog_color, 0.3);
    }

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
