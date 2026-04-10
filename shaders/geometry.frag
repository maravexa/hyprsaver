#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — geometry.frag
//
// Wireframe polyhedron screensaver, inspired by the Windows 3D Flower Box.
// A single geometric shape rotates smoothly in the centre of the screen.
// Every 10 s the shape morphs pseudo-randomly to another: vertices lerp to
// their new positions over the last 30% of the cycle while edge topology
// cross-fades between the two shapes.  Edges are rendered as clean, hard
// lines with smoothstep anti-aliasing, coloured via the active palette.
//
// Shape roster (8 total — index 0-7):
//   0  Cube               —  8 vertices, 12 edges
//   1  Octahedron         —  6 vertices, 12 edges
//   2  Pentagonal pyramid —  6 vertices, 10 edges
//   3  Hexagonal prism    — 12 vertices, 18 edges
//   4  Octagonal prism    — 16 vertices, 24 edges
//   5  Pentagonal antiprism — 10 vertices, 20 edges
//   6  Icosahedron        — 12 vertices, 30 edges
//   7  Dodecahedron       — 20 vertices, 30 edges
//
// All vertex arrays are padded to 20 entries (cycling shorter lists).
// All edge arrays are padded to 30 entries (ivec2(-1,-1) = sentinel, skipped).
//
// u_speed_scale — animation speed multiplier (injected by prepare_shader)
// u_zoom_scale  — apparent size multiplier   (injected by prepare_shader)
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;

// ---------------------------------------------------------------------------
// Rotation matrices
// ---------------------------------------------------------------------------

mat3 rotX(float a) {
    float c = cos(a), s = sin(a);
    return mat3(1.0, 0.0, 0.0,
                0.0,   c,  -s,
                0.0,   s,   c);
}

mat3 rotY(float a) {
    float c = cos(a), s = sin(a);
    return mat3(  c, 0.0,   s,
               0.0, 1.0, 0.0,
                -s, 0.0,   c);
}

// ---------------------------------------------------------------------------
// Perspective projection
// ---------------------------------------------------------------------------
// Camera sits at z = -2.5; the polyhedron is at the origin.  Vertices on the
// unit sphere produce a maximum projected extent of 0.42 * u_zoom_scale units
// in the normalised screen space (uv.y in [-0.5, 0.5]).

vec2 project(vec3 p) {
    float cam = 2.5;
    return p.xy / (cam + p.z) * (cam * 0.42 * u_zoom_scale);
}

// ---------------------------------------------------------------------------
// 2-D point-to-segment distance
// ---------------------------------------------------------------------------

float segDist(vec2 p, vec2 a, vec2 b) {
    vec2  ab = b - a;
    float t  = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0);
    return length(p - (a + t * ab));
}

// ---------------------------------------------------------------------------
// Shared vertex-coordinate constants
// ---------------------------------------------------------------------------
//
//  S    = 1/sqrt(3)         cube / dodecahedron cube-like vertices (+-S,+-S,+-S)
//  P    = 1/sqrt(phi+2)     icosahedron "short" axis  (phi = 1.61803)
//  Q    = phi/sqrt(phi+2)   icosahedron "long"  axis
//  SD   = (1/phi)/sqrt(3)   dodecahedron short arm
//  QD   = phi/sqrt(3)       dodecahedron long  arm
//  R5   = sin(60 deg)       pentagon/prism ring radius at z=+-0.5 on unit sphere
//
//  Verify: R5^2 + 0.5^2 = 0.75 + 0.25 = 1  (unit sphere)

const float S  = 0.57735;   // 1/sqrt(3)
const float P  = 0.52573;   // 1/sqrt(phi+2),  phi = 1.61803
const float Q  = 0.85065;   // phi/sqrt(phi+2)
const float SD = 0.35682;   // (1/phi)/sqrt(3)
const float QD = 0.93417;   // phi/sqrt(3)
const float R5 = 0.86603;   // sqrt(3)/2 = sin(60 deg), ring radius at |z|=0.5

// ---------------------------------------------------------------------------
// Pseudo-random shape hash
// ---------------------------------------------------------------------------
// Maps an integer cycle index to a shape index in [0, 7] via xorshift.

int selectShape(int seed) {
    uint s = uint(seed);
    s ^= s << 13u;
    s ^= s >> 17u;
    s ^= s << 5u;
    return int(s % 8u);
}

// ---------------------------------------------------------------------------
// Shape vertex positions
// ---------------------------------------------------------------------------
// Returns the i-th (0..19) vertex of the given shape on the unit sphere.
// Shapes with fewer than 20 unique vertices cycle their vertex list so the
// array is always length 20.

vec3 shapeVert(int shape, int i) {

    if (shape == 0) {
        // ── Cube — 8 unique vertices, cycled to fill 20 ─────────────────
        const vec3 v[20] = vec3[20](
            vec3(-S, -S, -S), vec3( S, -S, -S), vec3( S,  S, -S), vec3(-S,  S, -S),
            vec3(-S, -S,  S), vec3( S, -S,  S), vec3( S,  S,  S), vec3(-S,  S,  S),
            vec3(-S, -S, -S), vec3( S, -S, -S), vec3( S,  S, -S), vec3(-S,  S, -S),
            vec3(-S, -S,  S), vec3( S, -S,  S), vec3( S,  S,  S), vec3(-S,  S,  S),
            vec3(-S, -S, -S), vec3( S, -S, -S), vec3( S,  S, -S), vec3(-S,  S, -S)
        );
        return v[i];
    }

    if (shape == 1) {
        // ── Octahedron — 6 axial vertices, cycled to fill 20 ────────────
        const vec3 v[20] = vec3[20](
            vec3( 1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0),
            vec3( 0.0, 1.0, 0.0), vec3( 0.0,-1.0, 0.0),
            vec3( 0.0, 0.0, 1.0), vec3( 0.0, 0.0,-1.0),
            vec3( 1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0),
            vec3( 0.0, 1.0, 0.0), vec3( 0.0,-1.0, 0.0),
            vec3( 0.0, 0.0, 1.0), vec3( 0.0, 0.0,-1.0),
            vec3( 1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0),
            vec3( 0.0, 1.0, 0.0), vec3( 0.0,-1.0, 0.0),
            vec3( 0.0, 0.0, 1.0), vec3( 0.0, 0.0,-1.0),
            vec3( 1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0)
        );
        return v[i];
    }

    if (shape == 2) {
        // ── Pentagonal pyramid — apex at north pole, 5-vertex base ───────
        // apex = v0 = (0,0,1).  Base at z=-0.5, r=R5 (unit sphere).
        // Angles: 0, 72, 144, 216, 288 degrees.
        // v1-v5; padded by cycling to v0-v4 twice more (indices 6-19).
        const vec3 v[20] = vec3[20](
            vec3( 0.00000,  0.00000,  1.0),                     // v0 apex
            vec3( R5,       0.00000, -0.5),                     // v1
            vec3( 0.26762,  0.82362, -0.5),                     // v2
            vec3(-0.70063,  0.50904, -0.5),                     // v3
            vec3(-0.70063, -0.50904, -0.5),                     // v4
            vec3( 0.26762, -0.82362, -0.5),                     // v5
            // cycle 0-5:
            vec3( 0.00000,  0.00000,  1.0),
            vec3( R5,       0.00000, -0.5),
            vec3( 0.26762,  0.82362, -0.5),
            vec3(-0.70063,  0.50904, -0.5),
            vec3(-0.70063, -0.50904, -0.5),
            vec3( 0.26762, -0.82362, -0.5),
            // cycle 0-5 again:
            vec3( 0.00000,  0.00000,  1.0),
            vec3( R5,       0.00000, -0.5),
            vec3( 0.26762,  0.82362, -0.5),
            vec3(-0.70063,  0.50904, -0.5),
            vec3(-0.70063, -0.50904, -0.5),
            vec3( 0.26762, -0.82362, -0.5),
            // final two:
            vec3( 0.00000,  0.00000,  1.0),
            vec3( R5,       0.00000, -0.5)
        );
        return v[i];
    }

    if (shape == 3) {
        // ── Hexagonal prism — top hex at z=+0.5, bottom at z=-0.5 ───────
        // r = R5 so all 12 vertices lie on the unit sphere.
        // Top v0-v5 at angles 0,60,120,180,240,300 deg.
        // Bottom v6-v11 same angles.  Padded to 20 (cycle v0-v7).
        const vec3 v[20] = vec3[20](
            // top ring
            vec3( R5,      0.0,     0.5),  // v0
            vec3( 0.43301, 0.75,    0.5),  // v1
            vec3(-0.43301, 0.75,    0.5),  // v2
            vec3(-R5,      0.0,     0.5),  // v3
            vec3(-0.43301,-0.75,    0.5),  // v4
            vec3( 0.43301,-0.75,    0.5),  // v5
            // bottom ring
            vec3( R5,      0.0,    -0.5),  // v6
            vec3( 0.43301, 0.75,   -0.5),  // v7
            vec3(-0.43301, 0.75,   -0.5),  // v8
            vec3(-R5,      0.0,    -0.5),  // v9
            vec3(-0.43301,-0.75,   -0.5),  // v10
            vec3( 0.43301,-0.75,   -0.5),  // v11
            // cycle v0-v7 as padding:
            vec3( R5,      0.0,     0.5),
            vec3( 0.43301, 0.75,    0.5),
            vec3(-0.43301, 0.75,    0.5),
            vec3(-R5,      0.0,     0.5),
            vec3(-0.43301,-0.75,    0.5),
            vec3( 0.43301,-0.75,    0.5),
            vec3( R5,      0.0,    -0.5),
            vec3( 0.43301, 0.75,   -0.5)
        );
        return v[i];
    }

    if (shape == 4) {
        // ── Octagonal prism — top oct at z=+0.5, bottom at z=-0.5 ───────
        // r = R5.  Angles: 0,45,90,135,180,225,270,315 deg.
        // v0-v7 top, v8-v15 bottom.  Padded to 20 (cycle v0-v3).
        const float R8 = 0.61237; // R5 * cos(45 deg) = R5 * sqrt(2)/2
        const vec3 v[20] = vec3[20](
            // top ring
            vec3( R5,  0.0,  0.5),   // v0
            vec3( R8,  R8,   0.5),   // v1
            vec3( 0.0, R5,   0.5),   // v2
            vec3(-R8,  R8,   0.5),   // v3
            vec3(-R5,  0.0,  0.5),   // v4
            vec3(-R8, -R8,   0.5),   // v5
            vec3( 0.0,-R5,   0.5),   // v6
            vec3( R8, -R8,   0.5),   // v7
            // bottom ring
            vec3( R5,  0.0, -0.5),   // v8
            vec3( R8,  R8,  -0.5),   // v9
            vec3( 0.0, R5,  -0.5),   // v10
            vec3(-R8,  R8,  -0.5),   // v11
            vec3(-R5,  0.0, -0.5),   // v12
            vec3(-R8, -R8,  -0.5),   // v13
            vec3( 0.0,-R5,  -0.5),   // v14
            vec3( R8, -R8,  -0.5),   // v15
            // cycle v0-v3 as padding:
            vec3( R5,  0.0,  0.5),
            vec3( R8,  R8,   0.5),
            vec3( 0.0, R5,   0.5),
            vec3(-R8,  R8,   0.5)
        );
        return v[i];
    }

    if (shape == 5) {
        // ── Pentagonal antiprism — two pentagons rotated 36 deg apart ────
        // Top at z=+0.5 angles 0,72,144,216,288 deg (v0-v4).
        // Bottom at z=-0.5 angles 36,108,180,252,324 deg (v5-v9).
        // Padded to 20 (cycle v0-v9).
        const vec3 v[20] = vec3[20](
            // top pentagon
            vec3( R5,       0.00000,  0.5),  // v0  0 deg
            vec3( 0.26762,  0.82362,  0.5),  // v1  72 deg
            vec3(-0.70063,  0.50904,  0.5),  // v2  144 deg
            vec3(-0.70063, -0.50904,  0.5),  // v3  216 deg
            vec3( 0.26762, -0.82362,  0.5),  // v4  288 deg
            // bottom pentagon (rotated 36 deg)
            vec3( 0.70063,  0.50904, -0.5),  // v5  36 deg
            vec3(-0.26762,  0.82362, -0.5),  // v6  108 deg
            vec3(-R5,       0.00000, -0.5),  // v7  180 deg
            vec3(-0.26762, -0.82362, -0.5),  // v8  252 deg
            vec3( 0.70063, -0.50904, -0.5),  // v9  324 deg
            // cycle v0-v9:
            vec3( R5,       0.00000,  0.5),
            vec3( 0.26762,  0.82362,  0.5),
            vec3(-0.70063,  0.50904,  0.5),
            vec3(-0.70063, -0.50904,  0.5),
            vec3( 0.26762, -0.82362,  0.5),
            vec3( 0.70063,  0.50904, -0.5),
            vec3(-0.26762,  0.82362, -0.5),
            vec3(-R5,       0.00000, -0.5),
            vec3(-0.26762, -0.82362, -0.5),
            vec3( 0.70063, -0.50904, -0.5)
        );
        return v[i];
    }

    if (shape == 6) {
        // ── Icosahedron — 12 golden-ratio vertices, padded to 20 ─────────
        const vec3 v[20] = vec3[20](
            vec3( 0.0,  P,  Q), vec3( 0.0, -P,  Q),
            vec3( 0.0,  P, -Q), vec3( 0.0, -P, -Q),
            vec3(  P,   Q, 0.0), vec3( -P,  Q, 0.0),
            vec3(  P,  -Q, 0.0), vec3( -P, -Q, 0.0),
            vec3(  Q,  0.0,  P), vec3( -Q, 0.0,  P),
            vec3(  Q,  0.0, -P), vec3( -Q, 0.0, -P),
            // repeat 0-7 as padding:
            vec3( 0.0,  P,  Q), vec3( 0.0, -P,  Q),
            vec3( 0.0,  P, -Q), vec3( 0.0, -P, -Q),
            vec3(  P,   Q, 0.0), vec3( -P,  Q, 0.0),
            vec3(  P,  -Q, 0.0), vec3( -P, -Q, 0.0)
        );
        return v[i];
    }

    // ── Dodecahedron — 20 vertices, no padding needed ────────────────────
    const vec3 v[20] = vec3[20](
        vec3(  S,  S,  S), vec3(  S,  S, -S), vec3(  S, -S,  S), vec3(  S, -S, -S),
        vec3( -S,  S,  S), vec3( -S,  S, -S), vec3( -S, -S,  S), vec3( -S, -S, -S),
        vec3( 0.0,  SD,  QD), vec3( 0.0, -SD,  QD),
        vec3( 0.0,  SD, -QD), vec3( 0.0, -SD, -QD),
        vec3(  SD,  QD, 0.0), vec3( -SD,  QD, 0.0),
        vec3(  SD, -QD, 0.0), vec3( -SD, -QD, 0.0),
        vec3(  QD, 0.0,  SD), vec3( -QD, 0.0,  SD),
        vec3(  QD, 0.0, -SD), vec3( -QD, 0.0, -SD)
    );
    return v[i];
}

// ---------------------------------------------------------------------------
// Edge connectivity
// ---------------------------------------------------------------------------
// Returns the e-th (0..29) edge of the given shape as a pair of vertex indices.
// Shapes with fewer than 30 edges pad with ivec2(-1,-1) (skipped in the loop).

ivec2 shapeEdge(int shape, int e) {

    if (shape == 0) {
        // ── Cube: 12 real edges + 18 sentinels ───────────────────────────
        const ivec2 edges[30] = ivec2[30](
            ivec2(0,1), ivec2(1,2), ivec2(2,3), ivec2(3,0),
            ivec2(4,5), ivec2(5,6), ivec2(6,7), ivec2(7,4),
            ivec2(0,4), ivec2(1,5), ivec2(2,6), ivec2(3,7),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1)
        );
        return edges[e];
    }

    if (shape == 1) {
        // ── Octahedron: 12 real edges + 18 sentinels ─────────────────────
        const ivec2 edges[30] = ivec2[30](
            ivec2(4,0), ivec2(4,1), ivec2(4,2), ivec2(4,3),
            ivec2(5,0), ivec2(5,1), ivec2(5,2), ivec2(5,3),
            ivec2(0,2), ivec2(2,1), ivec2(1,3), ivec2(3,0),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1)
        );
        return edges[e];
    }

    if (shape == 2) {
        // ── Pentagonal pyramid: 10 real edges + 20 sentinels ─────────────
        // v0=apex, v1-v5=base ring
        // Base ring: (1,2),(2,3),(3,4),(4,5),(5,1) — 5 edges
        // Lateral:   (0,1),(0,2),(0,3),(0,4),(0,5) — 5 edges
        const ivec2 edges[30] = ivec2[30](
            ivec2(1,2), ivec2(2,3), ivec2(3,4), ivec2(4,5), ivec2(5,1),
            ivec2(0,1), ivec2(0,2), ivec2(0,3), ivec2(0,4), ivec2(0,5),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1)
        );
        return edges[e];
    }

    if (shape == 3) {
        // ── Hexagonal prism: 18 real edges + 12 sentinels ────────────────
        // Top ring v0-v5, bottom ring v6-v11
        // Top: (0,1),(1,2),(2,3),(3,4),(4,5),(5,0) — 6
        // Bot: (6,7),(7,8),(8,9),(9,10),(10,11),(11,6) — 6
        // Pillars: (0,6),(1,7),(2,8),(3,9),(4,10),(5,11) — 6
        const ivec2 edges[30] = ivec2[30](
            ivec2(0,1), ivec2(1,2), ivec2(2,3), ivec2(3,4), ivec2(4,5), ivec2(5,0),
            ivec2(6,7), ivec2(7,8), ivec2(8,9), ivec2(9,10), ivec2(10,11), ivec2(11,6),
            ivec2(0,6), ivec2(1,7), ivec2(2,8), ivec2(3,9), ivec2(4,10), ivec2(5,11),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1)
        );
        return edges[e];
    }

    if (shape == 4) {
        // ── Octagonal prism: 24 real edges + 6 sentinels ─────────────────
        // Top v0-v7, bottom v8-v15
        // Top ring: 8 edges, bottom ring: 8 edges, pillars: 8 edges
        const ivec2 edges[30] = ivec2[30](
            ivec2(0,1), ivec2(1,2), ivec2(2,3), ivec2(3,4),
            ivec2(4,5), ivec2(5,6), ivec2(6,7), ivec2(7,0),
            ivec2(8,9), ivec2(9,10), ivec2(10,11), ivec2(11,12),
            ivec2(12,13), ivec2(13,14), ivec2(14,15), ivec2(15,8),
            ivec2(0,8), ivec2(1,9), ivec2(2,10), ivec2(3,11),
            ivec2(4,12), ivec2(5,13), ivec2(6,14), ivec2(7,15),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1)
        );
        return edges[e];
    }

    if (shape == 5) {
        // ── Pentagonal antiprism: 20 real edges + 10 sentinels ───────────
        // Top v0-v4, bottom v5-v9
        // Top ring: (0,1),(1,2),(2,3),(3,4),(4,0) — 5
        // Bottom:   (5,6),(6,7),(7,8),(8,9),(9,5) — 5
        // Lateral (each top vertex connects to 2 bottom):
        //   (0,5),(0,9),(1,5),(1,6),(2,6),(2,7),(3,7),(3,8),(4,8),(4,9) — 10
        const ivec2 edges[30] = ivec2[30](
            ivec2(0,1), ivec2(1,2), ivec2(2,3), ivec2(3,4), ivec2(4,0),
            ivec2(5,6), ivec2(6,7), ivec2(7,8), ivec2(8,9), ivec2(9,5),
            ivec2(0,5), ivec2(0,9), ivec2(1,5), ivec2(1,6),
            ivec2(2,6), ivec2(2,7), ivec2(3,7), ivec2(3,8),
            ivec2(4,8), ivec2(4,9),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1)
        );
        return edges[e];
    }

    if (shape == 6) {
        // ── Icosahedron: 30 real edges ────────────────────────────────────
        const ivec2 edges[30] = ivec2[30](
            ivec2(0,1), ivec2(0,4), ivec2(0,5), ivec2(0,8), ivec2(0,9),
            ivec2(1,6), ivec2(1,7), ivec2(1,8), ivec2(1,9),
            ivec2(2,3), ivec2(2,4), ivec2(2,5), ivec2(2,10), ivec2(2,11),
            ivec2(3,6), ivec2(3,7), ivec2(3,10), ivec2(3,11),
            ivec2(4,5), ivec2(4,8), ivec2(4,10),
            ivec2(5,9), ivec2(5,11),
            ivec2(6,7), ivec2(6,8), ivec2(6,10),
            ivec2(7,9), ivec2(7,11),
            ivec2(8,10), ivec2(9,11)
        );
        return edges[e];
    }

    // ── Dodecahedron: 30 real edges ───────────────────────────────────────
    const ivec2 edges[30] = ivec2[30](
        ivec2(0, 8), ivec2(0,12), ivec2(0,16),
        ivec2(1,10), ivec2(1,12), ivec2(1,18),
        ivec2(2, 9), ivec2(2,14), ivec2(2,16),
        ivec2(3,11), ivec2(3,14), ivec2(3,18),
        ivec2(4, 8), ivec2(4,13), ivec2(4,17),
        ivec2(5,10), ivec2(5,13), ivec2(5,19),
        ivec2(6, 9), ivec2(6,15), ivec2(6,17),
        ivec2(7,11), ivec2(7,15), ivec2(7,19),
        ivec2( 8, 9), ivec2(10,11), ivec2(12,13),
        ivec2(14,15), ivec2(16,18), ivec2(17,19)
    );
    return edges[e];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

void main() {
    // Aspect-correct screen coordinates: uv.y in [-0.5, 0.5].
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;

    float t = u_time * u_speed_scale;

    // ── Shape cycle ────────────────────────────────────────────────────────
    // Each cycle is 10 s.  The shape holds for the first 70% (7 s) then morphs
    // to the pseudo-random next shape over the remaining 30% (3 s).
    const float CYCLE_DUR = 10.0;

    float cycle_f   = t / CYCLE_DUR;
    int   cur_cycle = int(floor(cycle_f));
    float morph_t   = smoothstep(0.7, 1.0, fract(cycle_f));

    // Hash-based shape selection — deterministic per session, appears random.
    int shape_a = selectShape(cur_cycle);
    int shape_b = selectShape(cur_cycle + 1);
    // Guarantee shape_b != shape_a.
    if (shape_b == shape_a) {
        shape_b = (shape_a + 1) % 8;
    }

    // ── Rotation ───────────────────────────────────────────────────────────
    mat3 rot = rotY(t * 0.23) * rotX(t * 0.17);

    // ── Project lerped vertex positions to 2-D ─────────────────────────────
    vec2 pts[20];
    for (int i = 0; i < 20; i++) {
        vec3 va = shapeVert(shape_a, i);
        vec3 vb = shapeVert(shape_b, i);
        vec3 v  = rot * mix(va, vb, morph_t);
        pts[i]  = project(v);
    }

    // ── Accumulate edge intensity ──────────────────────────────────────────
    // Each edge contributes a hard line with smoothstep anti-aliasing.
    // Shape-A edges fade out as shape-B edges fade in via morph_t.

    const float LINE_WIDTH = 0.009;

    vec3  col      = vec3(0.0);
    float base_hue = t * 0.06;   // full palette cycle ~16.7 s

    for (int i = 0; i < 30; i++) {
        float edge_hue = base_hue + float(i) * (1.0 / 30.0);

        // Shape-A edge (fade out)
        ivec2 ea = shapeEdge(shape_a, i);
        if (ea.x >= 0) {
            float d  = segDist(uv, pts[ea.x], pts[ea.y]);
            float ga = 1.0 - smoothstep(0.0, LINE_WIDTH, d);
            col += palette(edge_hue) * ga * (1.0 - morph_t);
        }

        // Shape-B edge (fade in)
        ivec2 eb = shapeEdge(shape_b, i);
        if (eb.x >= 0) {
            float d  = segDist(uv, pts[eb.x], pts[eb.y]);
            float gb = 1.0 - smoothstep(0.0, LINE_WIDTH, d);
            col += palette(edge_hue) * gb * morph_t;
        }
    }

    // Reinhard tone-map: compress overlapping-edge intersections without clipping.
    col = col / (col + 1.0);

    fragColor = vec4(col, 1.0);
}
