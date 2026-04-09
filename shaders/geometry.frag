#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — geometry.frag
//
// Wireframe polyhedron screensaver, inspired by the Windows 3D Flower Box.
// A single geometric shape (cube → octahedron → icosahedron → dodecahedron)
// rotates smoothly in the center of the screen. Every 12 s the shape morphs
// to the next: vertices lerp to their new positions over a 4-second window
// while the edge topology crossfades between the two shapes. Edges glow with
// a Gaussian core + wide bloom, colored via the active palette. The result is
// a neon hologram floating in a dark void.
//
// Vertex data (all shapes mapped to the unit sphere, padded to 20):
//   Cube        —  8 vertices, 12 edges  (+ 18 sentinel slots)
//   Octahedron  —  6 vertices, 12 edges  (+ 18 sentinel slots)
//   Icosahedron — 12 vertices, 30 edges
//   Dodecahedron— 20 vertices, 30 edges
//
// Morph strategy: the 20-vertex arrays are always lerped pairwise. Shapes
// with fewer unique vertices pad their arrays by cycling earlier vertices, so
// during a morph the "extra" vertices of the new shape appear to grow out of
// the existing ones. Edge sets are rendered with complementary weights
// (1-morph_t for the departing shape, morph_t for the arriving shape), so
// topology changes cross-fade cleanly.
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
// in the normalised screen space (uv.y ∈ [-0.5, 0.5]).

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
//  S  = 1/sqrt(3)       — cube / dodecahedron cube-like vertices at (±S,±S,±S)
//  P  = 1/sqrt(phi+2)   — icosahedron "short" axis  (phi = golden ratio)
//  Q  = phi/sqrt(phi+2) — icosahedron "long"  axis
//  SD = (1/phi)/sqrt(3) — dodecahedron short arm
//  QD = phi/sqrt(3)     — dodecahedron long  arm
//
// All combinations produce unit-sphere vertices:
//   ||(±S,±S,±S)||  = 1      (3·S²   = 1)
//   ||(0,P,Q)||      = 1      (P²+Q²  = 1)
//   ||(0,SD,QD)||    = 1      (SD²+QD²= 1, since (1/phi)²+phi² = 3)

const float S  = 0.57735;   // 1/sqrt(3)
const float P  = 0.52573;   // 1/sqrt(phi+2),  phi = 1.61803
const float Q  = 0.85065;   // phi/sqrt(phi+2)
const float SD = 0.35682;   // (1/phi)/sqrt(3)
const float QD = 0.93417;   // phi/sqrt(3)

// ---------------------------------------------------------------------------
// Shape vertex positions
// ---------------------------------------------------------------------------
// Returns the i-th (0..19) vertex of the given shape on the unit sphere.
// Shapes with fewer than 20 unique vertices cycle their vertex list so the
// array is always length 20 — this is the "padding" that makes per-pair lerp
// meaningful across shapes with different vertex counts.

vec3 shapeVert(int shape, int i) {

    if (shape == 0) {
        // ── Cube — 8 unique vertices, cycled to fill 20 ─────────────────
        const vec3 v[20] = vec3[20](
            vec3(-S, -S, -S), vec3( S, -S, -S), vec3( S,  S, -S), vec3(-S,  S, -S),
            vec3(-S, -S,  S), vec3( S, -S,  S), vec3( S,  S,  S), vec3(-S,  S,  S),
            // cycle 0-7:
            vec3(-S, -S, -S), vec3( S, -S, -S), vec3( S,  S, -S), vec3(-S,  S, -S),
            vec3(-S, -S,  S), vec3( S, -S,  S), vec3( S,  S,  S), vec3(-S,  S,  S),
            // cycle 0-3 again:
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
            // cycle 0-5 twice more:
            vec3( 1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0),
            vec3( 0.0, 1.0, 0.0), vec3( 0.0,-1.0, 0.0),
            vec3( 0.0, 0.0, 1.0), vec3( 0.0, 0.0,-1.0),
            vec3( 1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0),
            vec3( 0.0, 1.0, 0.0), vec3( 0.0,-1.0, 0.0),
            vec3( 0.0, 0.0, 1.0), vec3( 0.0, 0.0,-1.0),
            // final two:
            vec3( 1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0)
        );
        return v[i];
    }

    if (shape == 2) {
        // ── Icosahedron — 12 golden-ratio vertices, padded to 20 ─────────
        // Three mutually orthogonal golden rectangles (0,±1,±phi)/r each
        // contribute 4 vertices.  Indices 12-19 repeat vertices 0-7.
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
    // Eight cube-like vertices (±S,±S,±S) plus three sets of "stretched"
    // vertices that lie along each axis pair.
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
// Shapes with fewer than 30 edges use ivec2(-1,-1) as a sentinel for unused
// slots; the main loop skips those on ea.x >= 0.

ivec2 shapeEdge(int shape, int e) {

    if (shape == 0) {
        // ── Cube: 12 real edges + 18 sentinels ───────────────────────────
        const ivec2 edges[30] = ivec2[30](
            ivec2(0,1), ivec2(1,2), ivec2(2,3), ivec2(3,0),       // bottom face
            ivec2(4,5), ivec2(5,6), ivec2(6,7), ivec2(7,4),       // top face
            ivec2(0,4), ivec2(1,5), ivec2(2,6), ivec2(3,7),       // vertical pillars
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
        // v0=(1,0,0) v1=(-1,0,0) v2=(0,1,0) v3=(0,-1,0) v4=(0,0,1) v5=(0,0,-1)
        const ivec2 edges[30] = ivec2[30](
            ivec2(4,0), ivec2(4,1), ivec2(4,2), ivec2(4,3),       // top apex → ring
            ivec2(5,0), ivec2(5,1), ivec2(5,2), ivec2(5,3),       // bot apex → ring
            ivec2(0,2), ivec2(2,1), ivec2(1,3), ivec2(3,0),       // equatorial ring
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1), ivec2(-1,-1),
            ivec2(-1,-1), ivec2(-1,-1)
        );
        return edges[e];
    }

    if (shape == 2) {
        // ── Icosahedron: 30 real edges ────────────────────────────────────
        // Each of the 12 vertices has degree 5; 12·5/2 = 30 edges total.
        // Enumerated by traversing each vertex in order and listing new edges only.
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
    // Degree-3 graph on 20 vertices; 20·3/2 = 30 edges total.
    // Cube-like vertices (0-7) each connect to their three elongated neighbours.
    // Adjacent elongated pairs share one additional edge each.
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
    // Aspect-correct screen coordinates: uv.y ∈ [-0.5, 0.5].
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;

    float t = u_time * u_speed_scale;

    // ── Shape cycle ────────────────────────────────────────────────────────
    // Each shape holds for HOLD seconds then morphs to the next over MORPH s.
    //   0 = cube   →  1 = octahedron  →  2 = icosahedron  →  3 = dodecahedron  → 0
    const float HOLD  = 8.0;
    const float MORPH = 4.0;
    const float PHASE = HOLD + MORPH;   // 12 s per shape
    const float CYCLE = PHASE * 4.0;   // 48 s full loop

    float phase_t = mod(t, CYCLE);
    int   shape_a = int(phase_t / PHASE) % 4;
    int   shape_b = (shape_a + 1) % 4;
    float frac    = fract(phase_t / PHASE);          // position within current 12 s
    float morph_t = smoothstep(HOLD / PHASE, 1.0, frac);  // 0→1 during last MORPH s

    // ── Rotation ───────────────────────────────────────────────────────────
    // Two-axis tumble at incommensurate rates for aperiodic motion.
    mat3 rot = rotY(t * 0.23) * rotX(t * 0.17);

    // ── Project lerped vertex positions to 2-D ─────────────────────────────
    // For each of the 20 padded vertex slots, lerp between the two shapes'
    // positions, rotate, then project to screen space.
    vec2 pts[20];
    for (int i = 0; i < 20; i++) {
        vec3 va = shapeVert(shape_a, i);
        vec3 vb = shapeVert(shape_b, i);
        vec3 v  = rot * mix(va, vb, morph_t);
        pts[i]  = project(v);
    }

    // ── Accumulate edge glow ───────────────────────────────────────────────
    // Each edge contributes a tight Gaussian core (neon wire) plus a wider
    // soft bloom (holographic haze).  Shape-A edges fade out as shape-B edges
    // fade in, controlled by morph_t.  Color rotates slowly through the
    // palette, offset per edge index so adjacent edges have distinct hues.

    vec3  col      = vec3(0.0);
    float base_hue = t * 0.06;   // full palette cycle ≈ 16.7 s

    for (int i = 0; i < 30; i++) {
        float edge_hue = base_hue + float(i) * (1.0 / 30.0);

        // Shape-A edge (fade out)
        ivec2 ea = shapeEdge(shape_a, i);
        if (ea.x >= 0) {
            float d  = segDist(uv, pts[ea.x], pts[ea.y]);
            float ga = exp(-d * d * 2400.0)              // sharp neon core
                     + exp(-d * d * 180.0) * 0.30;       // soft bloom halo
            col += palette(edge_hue) * ga * (1.0 - morph_t);
        }

        // Shape-B edge (fade in)
        ivec2 eb = shapeEdge(shape_b, i);
        if (eb.x >= 0) {
            float d  = segDist(uv, pts[eb.x], pts[eb.y]);
            float gb = exp(-d * d * 2400.0)
                     + exp(-d * d * 180.0) * 0.30;
            col += palette(edge_hue) * gb * morph_t;
        }
    }

    // Reinhard tone-map: compress overlapping-edge hot spots without clipping.
    col = col / (col + 1.0);

    fragColor = vec4(col, 1.0);
}
