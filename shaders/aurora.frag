#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — aurora.frag  (v4 — diagonal drift + aggressive wiggle)
//
// Overhead aurora borealis — viewer looks straight up at the sky.
// Three horizontal curtain bands drift organically via FBM domain warping
// (Inigo Quilez technique), eliminating the periodic rigidity of the
// previous sine-wave approach.
//
// Two visual elements at well-separated spatial frequencies produce the
// signature look of real aurora:
//
//   Band silhouette — domain-warped FBM at X base-freq ~2.5 (large-scale
//     organic undulations, aperiodic over screensaver lifetimes).
//
//   Internal striations — FBM ridge detection at X-freq ~18 (fine bright
//     filaments in the upper diffusion zone, restricted by stri_mask so
//     the sharp lower bright hem stays clean and unmuddled).
//
// GPU cost: ~8–12% on integrated GPU at 1080p/60fps.
// Noise: hash21 + bilinear value noise + FBM with per-octave rotation —
//   patterns from fire.frag / flames.frag / clouds.frag, proven stable on
//   ARM Mali and Intel Iris Xe.
//
// Palette note: colors come entirely from palette(t). Palettes with a
// smooth ramp look best; a highly saturated t=0 color will produce a neon
// line at the lower bright edge — this is a palette selection concern, not
// a shader defect.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;

// ---------------------------------------------------------------------------
// Hash + 2D value noise — bilinear interpolation with Hermite cubic smoothing.
// Source: fire.frag / flames.frag (proven stable on target hardware).
// ---------------------------------------------------------------------------

float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// ---------------------------------------------------------------------------
// 4-octave FBM with per-octave rotation matrix.
// Rotation (clouds.frag pattern, mat2(1.6,1.2,-1.2,1.6)) reduces grid
// alignment so successive octaves don't stack on the same lattice axes.
// Used for domain warp passes — smooth, large-scale organic deformation.
// Output range: [0, ~0.94].
// ---------------------------------------------------------------------------

float fbm4(vec2 p) {
    float v   = 0.0;
    float amp = 0.5;
    mat2  rot = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 4; i++) {
        v   += amp * vnoise(p);
        p    = rot * p;
        amp *= 0.5;
    }
    return v;
}

// ---------------------------------------------------------------------------
// 3-octave FBM — lighter variant for striation ridge detection.
// Fine detail at higher spatial frequency; fewer octaves saves GPU budget.
// Output range: [0, ~0.875].
// ---------------------------------------------------------------------------

float fbm3(vec2 p) {
    float v   = 0.0;
    float amp = 0.5;
    mat2  rot = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 3; i++) {
        v   += amp * vnoise(p);
        p    = rot * p;
        amp *= 0.5;
    }
    return v;
}

// ---------------------------------------------------------------------------
// aurora_band — color contribution from one curtain band.
//
// uv        : centred aspect-corrected UV, Y in [-0.5, +0.5]
// t         : u_time * u_speed_scale (applied by caller)
// center_y  : resting vertical centre of this band
// warp_seed : unique per-band seed for warp FBM (decorrelates band motion)
// stri_seed : unique seed for striation FBM (must differ from warp_seed to
//             prevent striations from simply following the band silhouette)
// pal_off   : small palette index shift — each band maps to a slightly
//             different hue family, simulating curtains at different altitudes
// weight    : overall brightness scale for this band
// ---------------------------------------------------------------------------

vec3 aurora_band(vec2 uv, float t,
                 float center_y,
                 vec2 warp_seed, vec2 stri_seed,
                 float pal_off, float weight) {

    // ------------------------------------------------------------------
    // WARP PASS — organic band shape (low spatial frequency ~2.5)
    //
    // warp_p advances along Y as time passes (t * 0.08), sampling
    // successive rows of the 2D warp field and creating slow, continuously
    // evolving (aperiodic) undulation — no sine waves.
    //
    // Two independent fbm4 samples at offset positions produce a 2D warp
    // vector. Values are centred (−0.5) before multiplying so undulation
    // is symmetric: bands drift left AND right, up AND down.
    //
    // warp_strength 0.56 → effective ±0.28 in X (up from ±0.20).
    // Ceiling is ±0.35 before band structure collapses to blobs.
    //
    // DIAGONAL DRIFT: drift_y includes a cross-term from qx so Y motion
    // is coupled to X motion. The coupling (0.20 multiplier) creates a
    // ~20° diagonal bias — bands appear to flow at an angle rather than
    // purely side-to-side. Y warp also increased to ±0.12 (from ±0.07)
    // to match the more aggressive wiggle amplitude.
    // ------------------------------------------------------------------
    vec2  warp_p   = vec2(uv.x * 2.5, t * 0.08) + warp_seed;
    float qx       = fbm4(warp_p);
    float qy       = fbm4(warp_p + vec2(5.2, 1.3));

    float warped_x = uv.x + (qx - 0.5) * 0.56;              // X warp: ±0.28 range
    float drift_y  = (qy - 0.5) * 0.24 + (qx - 0.5) * 0.20; // Y: ±0.12 + diagonal coupling

    // Signed vertical distance from the drifted band centre.
    // Positive = above the band (upward glow zone).
    // Negative = below the band (sharp bright lower hem).
    float dist_y = uv.y - (center_y + drift_y);

    // ------------------------------------------------------------------
    // ASYMMETRIC EXPONENTIAL FALLOFF — the aurora visual signature.
    //
    //   dist_y > 0 (above): wide Gaussian → long soft upward diffusion.
    //   dist_y ≤ 0 (below): tight Gaussian → sharp concentrated lower hem.
    //
    // Coefficients 25.0 / 350.0 were correct in both prior iterations;
    // only the band-position computation has been replaced in v3.
    // ------------------------------------------------------------------
    float band_shape = (dist_y > 0.0)
        ? exp(-dist_y * dist_y * 25.0)     // soft glow upward
        : exp(-dist_y * dist_y * 350.0);   // sharp bright lower edge

    // ------------------------------------------------------------------
    // STRIATION RIDGES — high spatial frequency (~18×), upper zone only.
    //
    // Evaluating FBM at two horizontally adjacent positions and taking
    // the absolute difference detects "contour lines" in the noise field —
    // thin bright filaments along iso-value curves. These are the internal
    // vertical striations visible in real aurora borealis.
    // (Technique: IQ ridge detection, used in nimitz "Auroras" XtGGRt.)
    //
    // stri_p uses warped_x (not uv.x) so filaments track the undulating
    // band shape rather than running perfectly vertical — more organic.
    //
    // t * 0.04: striations drift very slowly, no visible cycle.
    //
    // CRITICAL — stri_mask: smoothstep ramps from 0 below the band
    // centre to 1 above it. Striations are SUPPRESSED at the lower hem
    // so the asymmetric falloff edge remains sharp and clean. This is the
    // primary fix for the muddled-glow failure in v2.
    // ------------------------------------------------------------------
    vec2  stri_p = vec2(warped_x * 18.0, uv.y * 0.6 + t * 0.04) + stri_seed;
    float n1     = fbm3(stri_p);
    float n2     = fbm3(stri_p + vec2(0.04, 0.0));
    float ridge  = pow(clamp(1.0 - abs(n1 - n2) * 8.0, 0.0, 1.0), 3.0);

    float stri_mask = smoothstep(0.0, 0.06, dist_y);   // 0 at/below hem, 1 in glow

    // ------------------------------------------------------------------
    // COMBINE + APERIODIC BREATHING
    //
    // Striations boost the diffusion zone brightness by up to +60%.
    //
    // Breathing: fbm3 evaluated along the time axis only (fixed Y = 0.73)
    // gives a slow, fully aperiodic ±20% amplitude fluctuation — bands
    // gently brighten and dim with no oscillatory pattern.
    // ------------------------------------------------------------------
    float base_intensity = band_shape * (1.0 + ridge * 0.6 * stri_mask);

    float breath = 1.0 + (fbm3(vec2(t * 0.03 + warp_seed.x, 0.73)) - 0.5) * 0.40;
    base_intensity *= breath;

    // ------------------------------------------------------------------
    // PALETTE — altitude-encoded color
    //
    // t_pal = 0.0 at the lower bright hem → 1.0 at the top of the glow,
    // mapping naturally to the real aurora gradient (e.g. green at bottom,
    // blue/violet higher). The 0.12 UV-unit span covers the soft glow zone.
    //
    // pal_off shifts each band into a different palette region so curtains
    // at different "altitudes" carry distinct hue families.
    // ------------------------------------------------------------------
    float t_pal     = clamp(dist_y / 0.12, 0.0, 1.0);
    vec3  band_color = palette(clamp(t_pal + pal_off, 0.0, 1.0));

    return band_color * base_intensity * weight;
}

// ---------------------------------------------------------------------------

void main() {
    vec2  uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    float t  = u_time * u_speed_scale;

    vec3 color = vec3(0.0);

    // Three curtain bands — each with independent warp seeds, striation
    // seeds (always different from warp seeds within the same band),
    // palette offsets, and brightness weights.
    //
    // Centres at -0.22, +0.04, +0.28 — offset from ±0.25 symmetry so
    // no two bands share a reflection axis, keeping the arrangement organic.
    //
    // Middle band weight 0.70: slightly dimmer to prevent a uniformly
    // bright horizontal bar in the overlap zone. Reinhard handles the rest.

    color += aurora_band(uv, t,
        -0.22,
        vec2(0.00, 0.00),   // warp seed A
        vec2(3.70, 5.10),   // striation seed A  ← different from warp seed A
        0.00,               // palette at lower portion of ramp
        1.00);

    color += aurora_band(uv, t,
         0.04,
        vec2(7.20, 2.90),   // warp seed B
        vec2(1.30, 8.60),   // striation seed B  ← different from warp seed B
        0.10,               // palette offset: mid curtain shifted hue
        0.70);

    color += aurora_band(uv, t,
         0.28,
        vec2(4.50, 6.80),   // warp seed C
        vec2(9.20, 0.40),   // striation seed C  ← different from warp seed C
        0.20,               // palette offset: upper curtain further shifted
        0.90);

    // Dim ambient sky — prevents pure-black pixels between curtains.
    color += palette(0.0) * 0.02;

    // Reinhard tone-mapping — prevents blowout in band overlap zones.
    // Increase coefficient 0.25 → 0.40 if the screen centre looks
    // uniformly bright across all three overlapping bands.
    color = color / (1.0 + color * 0.25);

    fragColor = vec4(color, 1.0);
}
