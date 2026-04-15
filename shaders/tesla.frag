#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — tesla.frag
//
// Tesla coil / electric arc screensaver.
// One fixed center electrode at (0.0, 0.0) and three triangle electrodes
// that orbit it as a rigid body: base positions (-0.45,-0.27), (0.45,-0.27),
// (0.0,0.45), scaled at runtime to fit within the screen, then rotated slowly
// by u_time * 0.15 * u_speed_scale.
// Between each pair a fractal-lightning arc is rendered using 4-octave jagged
// (C0-continuous) noise displacement. Arcs restrike every 0.1 s — the seed
// is floor(t * 10.0) — so they flicker like real tesla coils. Each triangle
// ↔ triangle arc has up to two branch arcs (≈30 % probability each). 6 arcs
// total: A↔B, B↔C, A↔C, A↔center, B↔center, C↔center. The center node is
// 6× the size of the triangle nodes.
//
// Colour: palette(t) where t ∈ [0.5, 1.0] — outer glow at 0.5, core at 1.0.
// Electrode nodes: bright discs with radial haloes pulsing at each restrike.
// Background: palette(0.1) at 5 % opacity.
// Uniforms: u_speed_scale controls animation speed; u_zoom_scale zooms the
// whole scene.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_alpha;

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

// ---------------------------------------------------------------------------
// Jagged (C0-continuous) piecewise-linear noise.
// Linear interpolation between adjacent hash values gives angular kinks —
// the angular look that distinguishes lightning from smooth curves.
// ---------------------------------------------------------------------------

float jagged(float t, float seed) {
    float fi = floor(t);
    float f  = fract(t);
    float a  = hash11(seed + fi       * 17.31);
    float b  = hash11(seed + (fi + 1.0) * 17.31);
    return mix(a, b, f) * 2.0 - 1.0;
}

// 4-octave fractal displacement at parameter t along an arc.
// Frequencies 2, 4, 8, 16 (matching levels 1-4 of midpoint subdivision).
// Tapers smoothly to zero at t=0 and t=1 so the arc stays pinned to electrodes.
float arc_disp(float t, float seed, float disp0) {
    float v    = 0.0;
    float amp  = disp0;
    float freq = 2.0;
    for (int i = 0; i < 4; i++) {
        v    += jagged(t * freq, seed + float(i) * 37.59) * amp;
        amp  *= 0.5;
        freq *= 2.0;
    }
    // Taper: full displacement in the middle, pinned at endpoints.
    return v * smoothstep(0.0, 0.08, t) * smoothstep(1.0, 0.92, t);
}

// ---------------------------------------------------------------------------
// Distance from pixel uv to the fractal arc from A → B.
// Finds the closest parametric point on the arc (clamped to [0,1]), displaces
// it in the perpendicular direction, and returns the Euclidean distance.
// This is an approximation (exact only for nearly-straight arcs) but is
// visually indistinguishable and branch-free.
// ---------------------------------------------------------------------------

float arc_dist(vec2 uv, vec2 A, vec2 B, float seed, float disp0) {
    vec2  ab  = B - A;
    float len = length(ab);
    if (len < 0.0001) return 1e6;

    vec2 dir  = ab / len;
    vec2 perp = vec2(-dir.y, dir.x);
    float t   = clamp(dot(uv - A, dir) / len, 0.0, 1.0);

    vec2 closest = A + dir * (t * len) + perp * arc_disp(t, seed, disp0);
    return length(uv - closest);
}

// ---------------------------------------------------------------------------
// Glow from distance d: a sharp spike (core) plus a wide soft halo.
// ---------------------------------------------------------------------------

float arc_glow(float d, float core_w, float halo_w) {
    float spike = core_w / (d + core_w * 0.25);
    spike = spike * spike;
    float halo = halo_w / (d + halo_w);
    halo  = halo * halo * 0.22;
    return spike + halo;
}

// ---------------------------------------------------------------------------

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // Zoom: u_zoom_scale > 1 zooms in (features appear larger).
    uv /= u_zoom_scale;

    float t = u_time * u_speed_scale;

    // Arc restrike every 0.1 s — seed changes make arcs fully re-randomise.
    float seed_t = floor(t * 10.0);

    // ---------------------------------------------------------------------------
    // Electrode positions
    // ---------------------------------------------------------------------------

    // Center node: fixed at origin, does not rotate.
    vec2 node_center = vec2(0.0, 0.0);

    // Three triangle nodes orbit the center as a rigid body.
    float orbit_angle = t * 0.15;
    mat2 rot = mat2(cos(orbit_angle), -sin(orbit_angle),
                    sin(orbit_angle),  cos(orbit_angle));

    // Constrain orbit so the nodes never clip off the screen edge.
    // UV space: height spans -0.5..0.5; width spans -(aspect/2)..(aspect/2).
    // The triangle's circumradius is length(vec2(0.45,0.27)) ≈ 0.5248, which
    // exceeds the half-height (0.5) and clips when any node rotates upward.
    float half_width  = (u_resolution.x / u_resolution.y) * 0.5;
    float half_height = 0.5;
    float padding          = 0.05;  // gap from screen edge (UV units)
    float node_visual_rad  = 0.03;  // visual radius of each electrode disc
    float max_orbit_radius = min(half_width, half_height) - padding - node_visual_rad;

    // Scale the triangle uniformly so its farthest vertex sits at max_orbit_radius.
    float base_max_dist = length(vec2(0.45, 0.27));  // circumradius of base triangle
    float orbit_scale   = min(1.0, max_orbit_radius / base_max_dist);

    vec2 e0 = rot * vec2(-0.45, -0.27) * orbit_scale;
    vec2 e1 = rot * vec2( 0.45, -0.27) * orbit_scale;
    vec2 e2 = rot * vec2( 0.0,   0.45) * orbit_scale;

    // Pixel-size metrics (resolution-independent).
    float px     = 1.0 / u_resolution.y;
    float core_w = 3.5  * px;
    float halo_w = 16.0 * px;
    float disp0  = 0.038;   // base midpoint-displacement amplitude (UV units)

    // Per-arc random seeds (re-randomised every 0.1 s via seed_t).
    float s01 = hash11(seed_t * 17.31 + 1.0) * 300.0;
    float s12 = hash11(seed_t * 17.31 + 2.0) * 300.0;
    float s20 = hash11(seed_t * 17.31 + 3.0) * 300.0;
    float s0c = hash11(seed_t * 17.31 + 4.0) * 300.0;
    float s1c = hash11(seed_t * 17.31 + 5.0) * 300.0;
    float s2c = hash11(seed_t * 17.31 + 6.0) * 300.0;

    float intensity = 0.0;

    // ---------------------------------------------------------------------------
    // Arc e0 → e1
    // ---------------------------------------------------------------------------
    intensity += arc_glow(arc_dist(uv, e0, e1, s01, disp0), core_w, halo_w);

    // Branch A (~30 % chance)
    if (hash11(seed_t * 3.71 + 0.11) < 0.3) {
        float bt   = 0.25 + hash11(seed_t * 5.13 + 0.11) * 0.50;
        vec2  bori = mix(e0, e1, bt);
        vec2  bend = bori + vec2(hash11(seed_t *  7.97 + 0.11) - 0.5,
                                  hash11(seed_t * 11.33 + 0.11) - 0.5) * 0.18;
        float bs   = hash11(seed_t * 13.71 + 0.11) * 200.0;
        intensity += arc_glow(arc_dist(uv, bori, bend, bs, disp0 * 0.55),
                               core_w * 0.55, halo_w * 0.55) * 0.40;
    }
    // Branch B (~30 % chance)
    if (hash11(seed_t * 3.71 + 0.22) < 0.3) {
        float bt   = 0.25 + hash11(seed_t * 5.13 + 0.22) * 0.50;
        vec2  bori = mix(e0, e1, bt);
        vec2  bend = bori + vec2(hash11(seed_t *  7.97 + 0.22) - 0.5,
                                  hash11(seed_t * 11.33 + 0.22) - 0.5) * 0.18;
        float bs   = hash11(seed_t * 13.71 + 0.22) * 200.0;
        intensity += arc_glow(arc_dist(uv, bori, bend, bs, disp0 * 0.55),
                               core_w * 0.55, halo_w * 0.55) * 0.40;
    }

    // ---------------------------------------------------------------------------
    // Arc e1 → e2
    // ---------------------------------------------------------------------------
    intensity += arc_glow(arc_dist(uv, e1, e2, s12, disp0), core_w, halo_w);

    if (hash11(seed_t * 3.71 + 0.33) < 0.3) {
        float bt   = 0.25 + hash11(seed_t * 5.13 + 0.33) * 0.50;
        vec2  bori = mix(e1, e2, bt);
        vec2  bend = bori + vec2(hash11(seed_t *  7.97 + 0.33) - 0.5,
                                  hash11(seed_t * 11.33 + 0.33) - 0.5) * 0.18;
        float bs   = hash11(seed_t * 13.71 + 0.33) * 200.0;
        intensity += arc_glow(arc_dist(uv, bori, bend, bs, disp0 * 0.55),
                               core_w * 0.55, halo_w * 0.55) * 0.40;
    }
    if (hash11(seed_t * 3.71 + 0.44) < 0.3) {
        float bt   = 0.25 + hash11(seed_t * 5.13 + 0.44) * 0.50;
        vec2  bori = mix(e1, e2, bt);
        vec2  bend = bori + vec2(hash11(seed_t *  7.97 + 0.44) - 0.5,
                                  hash11(seed_t * 11.33 + 0.44) - 0.5) * 0.18;
        float bs   = hash11(seed_t * 13.71 + 0.44) * 200.0;
        intensity += arc_glow(arc_dist(uv, bori, bend, bs, disp0 * 0.55),
                               core_w * 0.55, halo_w * 0.55) * 0.40;
    }

    // ---------------------------------------------------------------------------
    // Arc e2 → e0
    // ---------------------------------------------------------------------------
    intensity += arc_glow(arc_dist(uv, e2, e0, s20, disp0), core_w, halo_w);

    if (hash11(seed_t * 3.71 + 0.55) < 0.3) {
        float bt   = 0.25 + hash11(seed_t * 5.13 + 0.55) * 0.50;
        vec2  bori = mix(e2, e0, bt);
        vec2  bend = bori + vec2(hash11(seed_t *  7.97 + 0.55) - 0.5,
                                  hash11(seed_t * 11.33 + 0.55) - 0.5) * 0.18;
        float bs   = hash11(seed_t * 13.71 + 0.55) * 200.0;
        intensity += arc_glow(arc_dist(uv, bori, bend, bs, disp0 * 0.55),
                               core_w * 0.55, halo_w * 0.55) * 0.40;
    }
    if (hash11(seed_t * 3.71 + 0.66) < 0.3) {
        float bt   = 0.25 + hash11(seed_t * 5.13 + 0.66) * 0.50;
        vec2  bori = mix(e2, e0, bt);
        vec2  bend = bori + vec2(hash11(seed_t *  7.97 + 0.66) - 0.5,
                                  hash11(seed_t * 11.33 + 0.66) - 0.5) * 0.18;
        float bs   = hash11(seed_t * 13.71 + 0.66) * 200.0;
        intensity += arc_glow(arc_dist(uv, bori, bend, bs, disp0 * 0.55),
                               core_w * 0.55, halo_w * 0.55) * 0.40;
    }

    // ---------------------------------------------------------------------------
    // Arcs to center: e0 → center, e1 → center, e2 → center (dimmer than main arcs)
    // ---------------------------------------------------------------------------
    intensity += arc_glow(arc_dist(uv, e0, node_center, s0c, disp0),
                           core_w * 0.8, halo_w * 0.8) * 0.65;
    intensity += arc_glow(arc_dist(uv, e1, node_center, s1c, disp0),
                           core_w * 0.8, halo_w * 0.8) * 0.65;
    intensity += arc_glow(arc_dist(uv, e2, node_center, s2c, disp0),
                           core_w * 0.8, halo_w * 0.8) * 0.65;

    // ---------------------------------------------------------------------------
    // Electrode node glows — bright disc + radial halo, pulsing at each restrike.
    // The pulse is a brief flash that decays exponentially within the 0.1 s window.
    // ---------------------------------------------------------------------------
    float restrike_phase = fract(t * 10.0);
    float pulse = 1.0 + 1.5 * exp(-restrike_phase * 12.0);

    // Triangle electrodes (radius 0.03).
    vec2 elec[3];
    elec[0] = e0;
    elec[1] = e1;
    elec[2] = e2;
    for (int i = 0; i < 3; i++) {
        float ed   = length(uv - elec[i]);
        float disc = smoothstep(0.030, 0.012, ed);
        float halo = 0.025 / (ed + 0.012);
        intensity += (disc * 2.5 + halo * halo * 0.5) * pulse;
    }

    // Center electrode: 6× larger — all spatial params scaled proportionally.
    {
        float ed   = length(uv - node_center);
        float disc = smoothstep(0.108, 0.042, ed);   // 0.018*6, 0.007*6
        float halo = 0.090 / (ed + 0.048);            // 0.015*6 / (ed + 0.008*6)
        intensity += (disc * 1.5 + halo * halo * 0.35) * pulse;
    }

    // ---------------------------------------------------------------------------
    // Colour mapping
    // core → palette(1.0), outer glow → palette(0.5), background → palette(0.1)×5%
    // ---------------------------------------------------------------------------
    vec3 bg    = palette(0.1) * 0.05;
    float pal_t = mix(0.5, 1.0, clamp(intensity / 2.0, 0.0, 1.0));
    vec3 col   = palette(pal_t) * min(intensity * 0.9, 1.8) + bg;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
