#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — hypercube.frag
//
// Rotating 4D hypercube (tesseract) projected to 2D wireframe.
//
// Technique:
//   • 16 vertices — all ±1 combinations in 4D
//     (bit layout: bit0=x  bit1=y  bit2=z  bit3=w;  0 → −1, 1 → +1)
//   • 32 edges — vertex pairs differing in exactly one 4D coordinate
//   • Two simultaneous 4D rotations:
//       XW plane at speed 1  (driven by u_time × u_speed_scale)
//       YZ plane at speed φ⁻¹ ≈ 0.618 — golden ratio, non-repeating beat
//   • 4D → 3D perspective divide by (w + 2.0); denominator ≥ 2−√2 > 0
//     (XW rotation of ±1 vertices bounds |w| ≤ √2, so no singularity)
//   • 3D → 2D perspective divide by (z + 2.5); scaled to ~60 % screen height
//   • Smoothstep anti-aliased edge lines — no bloom, reduced GPU cost
//   • Edge hue driven by post-rotation w-depth for a visible 4D colour cue,
//     plus a slow palette drift so hues shift even when geometry is stable
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// 4D rotation helpers
// ---------------------------------------------------------------------------

// Rotate in XW plane: (x, w) ← (x cosθ − w sinθ,  x sinθ + w cosθ)
vec4 rot_xw(vec4 v, float a) {
    float c = cos(a), s = sin(a);
    return vec4(c*v.x - s*v.w,  v.y,  v.z,  s*v.x + c*v.w);
}

// Rotate in YZ plane: (y, z) ← (y cosθ − z sinθ,  y sinθ + z cosθ)
vec4 rot_yz(vec4 v, float a) {
    float c = cos(a), s = sin(a);
    return vec4(v.x,  c*v.y - s*v.z,  s*v.y + c*v.z,  v.w);
}

// ---------------------------------------------------------------------------
// Minimum distance from point p to line segment [a, b]
// ---------------------------------------------------------------------------
float seg_dist(vec2 p, vec2 a, vec2 b) {
    vec2 ab = b - a;
    vec2 pa = p - a;
    float t = clamp(dot(pa, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
    return length(pa - ab * t);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
void main() {
    // Centered, aspect-corrected UV; y ∈ [−0.5, 0.5] = full screen height.
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // Rotation angles: XW and YZ planes at incommensurable speeds (halved for a
    // relaxed pace — 0.5 and 0.5/φ ≈ 0.309 rad/s).
    float ta = u_time * u_speed_scale * 0.5;                 // XW plane
    float tb = u_time * u_speed_scale * 0.3090169944;        // YZ plane (1/φ, halved)

    // ------------------------------------------------------------------
    // 16 tesseract vertices — all ±1 combinations in 4D.
    // Index bit layout: bit0=x  bit1=y  bit2=z  bit3=w  (0 → −1, 1 → +1)
    // ------------------------------------------------------------------
    vec4 verts[16];
    verts[ 0] = vec4(-1.,-1.,-1.,-1.);  verts[ 1] = vec4( 1.,-1.,-1.,-1.);
    verts[ 2] = vec4(-1., 1.,-1.,-1.);  verts[ 3] = vec4( 1., 1.,-1.,-1.);
    verts[ 4] = vec4(-1.,-1., 1.,-1.);  verts[ 5] = vec4( 1.,-1., 1.,-1.);
    verts[ 6] = vec4(-1., 1., 1.,-1.);  verts[ 7] = vec4( 1., 1., 1.,-1.);
    verts[ 8] = vec4(-1.,-1.,-1., 1.);  verts[ 9] = vec4( 1.,-1.,-1., 1.);
    verts[10] = vec4(-1., 1.,-1., 1.);  verts[11] = vec4( 1., 1.,-1., 1.);
    verts[12] = vec4(-1.,-1., 1., 1.);  verts[13] = vec4( 1.,-1., 1., 1.);
    verts[14] = vec4(-1., 1., 1., 1.);  verts[15] = vec4( 1., 1., 1., 1.);

    // ------------------------------------------------------------------
    // Rotate all 16 vertices in 4D, then project to 2D.
    // Cache projected screen position and post-rotation w-depth per vertex.
    //
    // After XW rotation of a ±1 vertex, |w| ≤ √2 ≈ 1.414, so the 4D→3D
    // denominator (w + 2.0) stays in [0.586, 3.414] — never zero.
    // ------------------------------------------------------------------
    vec2  pt[16];
    float wd[16];

    for (int i = 0; i < 16; i++) {
        vec4 v = rot_xw(verts[i], ta);
             v = rot_yz(v,         tb);
        wd[i] = v.w;
        // 4D → 3D perspective (viewer at w = −2)
        vec3 p3 = v.xyz / (v.w + 2.0);
        // 3D → 2D perspective (viewer at z = −2.5), scaled to ~60 % screen height
        pt[i] = p3.xy / (p3.z + 2.5) * (0.45 * u_zoom_scale);
    }

    // ------------------------------------------------------------------
    // 32 edges — vertex pairs differing in exactly one coordinate.
    //   Edges  0– 7: x dimension (bit 0)    Edges  8–15: y dimension (bit 1)
    //   Edges 16–23: z dimension (bit 2)    Edges 24–31: w dimension (bit 3)
    // ------------------------------------------------------------------
    ivec2 edges[32];
    // x-edges (bit 0 flipped: i and i^1)
    edges[ 0]=ivec2( 0, 1); edges[ 1]=ivec2( 2, 3);
    edges[ 2]=ivec2( 4, 5); edges[ 3]=ivec2( 6, 7);
    edges[ 4]=ivec2( 8, 9); edges[ 5]=ivec2(10,11);
    edges[ 6]=ivec2(12,13); edges[ 7]=ivec2(14,15);
    // y-edges (bit 1 flipped: i and i^2)
    edges[ 8]=ivec2( 0, 2); edges[ 9]=ivec2( 1, 3);
    edges[10]=ivec2( 4, 6); edges[11]=ivec2( 5, 7);
    edges[12]=ivec2( 8,10); edges[13]=ivec2( 9,11);
    edges[14]=ivec2(12,14); edges[15]=ivec2(13,15);
    // z-edges (bit 2 flipped: i and i^4)
    edges[16]=ivec2( 0, 4); edges[17]=ivec2( 1, 5);
    edges[18]=ivec2( 2, 6); edges[19]=ivec2( 3, 7);
    edges[20]=ivec2( 8,12); edges[21]=ivec2( 9,13);
    edges[22]=ivec2(10,14); edges[23]=ivec2(11,15);
    // w-edges (bit 3 flipped: i and i^8)
    edges[24]=ivec2( 0, 8); edges[25]=ivec2( 1, 9);
    edges[26]=ivec2( 2,10); edges[27]=ivec2( 3,11);
    edges[28]=ivec2( 4,12); edges[29]=ivec2( 5,13);
    edges[30]=ivec2( 6,14); edges[31]=ivec2( 7,15);

    // ------------------------------------------------------------------
    // Accumulate neon glow from all 32 edges
    // ------------------------------------------------------------------
    vec3 col = vec3(0.0);

    for (int e = 0; e < 32; e++) {
        int i = edges[e].x;
        int j = edges[e].y;

        float d = seg_dist(uv, pt[i], pt[j]);

        // Palette t: average post-rotation w-depth (4D colour cue) shifted by a
        // slow time drift.  wd ∈ [−√2, √2] → (wd_i + wd_j) ∈ [−2√2, 2√2];
        // multiplying by 0.15 and adding 0.5 centres t near 0.5, fract wraps.
        float t_pal = fract((wd[i] + wd[j]) * 0.15 + 0.5 + ta * 0.02);
        vec3  ecol  = palette(t_pal);

        // Smoothstep anti-aliased edge — no exp() bloom, lower GPU cost.
        // line_width ~0.003 ≈ 3 px on a 1080p screen (UV units = screen height).
        float line_width = 0.003;
        float intensity = 1.0 - smoothstep(line_width * 0.5, line_width, d);
        col += intensity * ecol;
    }

    // Reinhard tonemapping — prevents bright edge intersections from overexposing.
    col = col / (1.0 + col);
    // Approximate sRGB gamma correction (γ ≈ 2.2, power ≈ 0.45)
    col = pow(col, vec3(0.45));

    // Deep-space background: near-black with a faint blue undertone
    vec3 bg = vec3(0.005, 0.005, 0.02);
    fragColor = vec4(max(bg, col), 1.0);
}
