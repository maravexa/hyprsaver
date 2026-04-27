#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — waterfall.frag
//
// Stylized 2D waterfall with retro quantize-and-dither post.
// Rock is implicit — the base color is vec3(0.0) and water is added on top
// as a density field (not a mask). A horizontal smoothstep envelope tapers
// water density to zero at the column edges, so black rock shows through
// with no border line to wiggle or feather. Water texture is 2-octave fbm
// with deliberate x-heavy frequency bias (7.2:1) for pronounced vertical
// streaks, mapped through a [0.50, 0.85] palette slice. Streak crests get
// an additive highlight from the same fbm, thresholded. Mist billows at the
// base from 2-octave fbm with upward drift, wider than the water column so
// it spills onto the rocks. PS1-style Bayer dither + color quantize post.
// Lightweight GPU tier (<30% util).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_speed_scale;
uniform float u_zoom_scale;

// ---------------------------------------------------------------------------
// 2D value noise (used by both water and mist fbm)
// ---------------------------------------------------------------------------
float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float vnoise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash2(i + vec2(0.0, 0.0)), hash2(i + vec2(1.0, 0.0)), u.x),
        mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x),
        u.y
    );
}

float hash3(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

// 3D value noise — trilinear smoothstep interpolation across the 8
// corners of the lattice cube containing p. Used by fbm_haze to produce
// time-evolving noise where the z coordinate represents temporal
// evolution: as z advances, features morph in place rather than
// rigidly translating.
float vnoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(
            mix(hash3(i + vec3(0.0, 0.0, 0.0)),
                hash3(i + vec3(1.0, 0.0, 0.0)), u.x),
            mix(hash3(i + vec3(0.0, 1.0, 0.0)),
                hash3(i + vec3(1.0, 1.0, 0.0)), u.x),
            u.y),
        mix(
            mix(hash3(i + vec3(0.0, 0.0, 1.0)),
                hash3(i + vec3(1.0, 0.0, 1.0)), u.x),
            mix(hash3(i + vec3(0.0, 1.0, 1.0)),
                hash3(i + vec3(1.0, 1.0, 1.0)), u.x),
            u.y),
        u.z);
}

// ---------------------------------------------------------------------------
// 3-octave fbm for water — x-heavy sampling elsewhere gives vertical streaks
// ---------------------------------------------------------------------------
float fbm_water(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
        v += a * vnoise2(p);
        p *= 2.0;
        a *= 0.5;
    }
    return v;
}

// ---------------------------------------------------------------------------
// 2-octave fbm for the hue field — slow, large-scale color variation
// ---------------------------------------------------------------------------
float fbm_hue(vec2 p) {
    return 0.67 * vnoise2(p) + 0.33 * vnoise2(p * 2.0);
}

// ---------------------------------------------------------------------------
// 2-octave fbm for mist — cheap, soft (same shape as fbm_water; kept
// separate for readability)
// ---------------------------------------------------------------------------
float fbm_mist(vec2 p) {
    return 0.67 * vnoise2(p) + 0.33 * vnoise2(p * 2.0);
}

// ---------------------------------------------------------------------------
// 2-octave fbm for the channel field — defines vertical stream structure.
// Separate function from fbm_hue/fbm_mist for semantic clarity, identical
// math.
// ---------------------------------------------------------------------------
float fbm_channel(vec2 p) {
    return 0.67 * vnoise2(p) + 0.33 * vnoise2(p * 2.0);
}

// Turbulence fbm with time-evolving 3D noise. Classical Perlin turbulence
// math (abs of signed noise) preserved — sharp valleys / ridged features.
//
// Critical addition: p.z scales by 1.7 per octave while p.xy scales by
// 2.0. This differential means fine-detail octaves evolve faster in
// time than broad-shape octaves, mimicking real fluid turbulence where
// small eddies dissipate faster than large structures. 1.7 is slightly
// less than the spatial 2.0 factor — detail evolves meaningfully faster
// than broad shapes but not so chaotically that it looks like noise.
float fbm_haze(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
        v += a * abs(vnoise3(p) * 2.0 - 1.0);
        p.xy *= 2.0;
        p.z *= 1.7;
        a *= 0.5;
    }
    return v;
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    // uv.y = 0.0 at bottom, 1.0 at top
    float t = u_time * u_speed_scale;

    vec2 hue_uv = vec2(uv.x * 2.0, uv.y * 0.5 + t * 0.25);
    float hue = fbm_hue(hue_uv);
    float palette_t = clamp(hue * 1.2 - 0.1, 0.0, 1.0);

    // Water density envelope: solid core in x ∈ [0.25, 0.75] (50% of screen),
    // smooth falloff to zero at x ∈ [0.10, 0.90]. No alpha mask — where
    // density is zero, black rock shows through by default.
    float water_density = 1.0 - smoothstep(0.25, 0.40, abs(uv.x - 0.5));

    // Channel field — DOUBLED x-freq (4.0 → 8.0) produces ~4–6 channels
    // across the column instead of 2. Drift rate halved (0.08 → 0.04) to
    // keep lateral migration visually similar despite higher x-freq; at
    // 8.0 x-freq, a drift of 0.08 would race channels sideways too fast.
    //
    // Smoothstep window NARROWED (0.35, 0.55) → (0.35, 0.45). The narrower
    // window makes channel edges near-binary instead of soft-feathered, so
    // "stream" pixels reach full density instead of stopping at ~75%. That
    // in turn lets streak contrast read properly within streams.
    vec2 channel_uv = vec2(uv.x * 8.0 + t * 0.04, uv.y * 0.5);
    float channel = fbm_channel(channel_uv);
    float channel_factor = smoothstep(0.35, 0.45, channel);
    water_density *= channel_factor;

    // Streak-tearing — high-frequency gap field carving narrow slits
    // BETWEEN individual water strands within a stream. This is distinct
    // from the channel field (which defines stream vs. rock at the scale
    // of whole streams); tearing operates at the scale of individual
    // strands of water within a stream.
    //
    // Real wide waterfalls look like many discrete strands with narrow
    // vertical gaps between them, not a continuous sheet with brightness
    // variation. This mechanism produces the strand structure directly.
    //
    // Tear shape TIGHTENED: x-freq raised (35→50), y-freq lowered (8→6).
    // New aspect ratio 50:6 ≈ 8.3:1 tall:wide, up from 4.4:1. Features are
    // narrow and tall — slits, not blobs.
    //
    // Tear density REDUCED FURTHER: threshold window (0.10, 0.20) → (0.05, 0.12).
    // Now roughly 5% of pixels become full tears with a narrow 0.05-0.12
    // antialiased edge. Tears read as occasional punctuation of the sheet
    // rather than a constant perforation pattern.
    //
    // Aspect ratio preserved at 50:6 — slit shape from previous iteration
    // was correct, only density was excessive.
    //
    // Time coefficient RAISED (0.6 → 1.44) to match streak scroll rate.
    // Screen-space scroll rate = t_coef / y_freq = 1.44 / 6.0 = 0.24, matching
    // streaks at 1.68 / 7.0 = 0.24. Tears now travel WITH the water rather
    // than appearing to lag behind it.
    vec2 tear_uv = vec2(uv.x * 50.0, uv.y * 6.0 + t * 1.44);
    float tear = vnoise2(tear_uv);
    float tear_factor = smoothstep(0.05, 0.12, tear);
    water_density *= tear_factor;

    // Hue field — y-freq SLASHED (2.0 → 0.5) so color varies almost
    // exclusively across x, not y. Each stream is now mostly a single
    // color top-to-bottom, matching how real water reads (water itself is
    // not rainbow-laddered; only lighting and depth shift color).
    //
    // x-freq slightly reduced (2.5 → 2.0) for broader color regions across
    // the column: 1–2 dominant color zones instead of 2–3.
    //
    // Palette stretch MODERATED (1.5 * hue - 0.25) → (1.2 * hue - 0.1).
    // Effective palette slice ~[0.08, 0.92] instead of [0, 1]. Still wide
    // enough for multi-color bands, but extreme palette endpoints (which
    // dominate via saturation on rainbow) are excluded.

    // Streak texture — high frequency, fast downward flow. Drives brightness.
    //
    // Streak y-freq RAISED FURTHER (4.5 → 7.0). Aspect ratio 18:7 ≈ 2.6:1
    // produces dense streak structure within streams — multiple bright/dim
    // cycles visible top-to-bottom per stream, not 2-3 broad gradients.
    //
    // Time coefficient COMPENSATED (1.08 → 1.68) to preserve current scroll
    // rate. Screen-space scroll rate = t_coef / y_freq:
    //   Before: 1.08 / 4.5 = 0.24 screen heights per time unit
    //   After:  1.68 / 7.0 = 0.24 screen heights per time unit (identical)
    vec2 water_uv = vec2(uv.x * 18.0, uv.y * 7.0 + t * 1.68);
    float w = fbm_water(water_uv);

    // Within-stream pulse — single-octave low-frequency sample that scrolls
    // with the water. Provides broad intensity variation at a scale larger
    // than individual streaks but smaller than the channel field, so each
    // stream visibly waxes and wanes in brightness as water flows past.
    //
    // Kept as a bare vnoise2 call (not an fbm) to hold cost to a single
    // noise sample — the variation we want here is slow and smooth, no
    // need for multi-octave detail.
    //
    //   x-freq 9.0  → half the streak x-freq; broad pulse regions span
    //                  multiple streaks
    //   y-freq 1.5  → half the streak y-freq base; pulse regions are tall
    //   t * 0.5     → scrolls with water (slightly slower than streaks at
    //                  0.6; gives parallax)
    vec2 pulse_uv = vec2(uv.x * 9.0, uv.y * 1.5 + t * 0.5);
    float pulse = vnoise2(pulse_uv);

    // Apply to water_density. Floor at 0.6 so streams never fully extinguish
    // from pulse alone — full extinction is the channel field's job.
    water_density *= mix(0.6, 1.0, pulse);

    // Dim-streak floor DROPPED (0.15 → 0.05). New contrast range 20:1, up
    // from 6.7:1. Dim streak regions are now near-black while bright
    // regions reach full palette intensity. This makes streak structure
    // unambiguous — you can see discrete bright streaks against dark
    // surrounding water, rather than subtle brightness variation.
    //
    // Dim pixels stay "water" (density is unchanged); they're just very
    // dark water. Rock-vs-water distinction remains the responsibility of
    // the channel and tear fields.
    vec3 water_col = palette(palette_t) * mix(0.05, 1.0, w);

    // Additive composition: rock is implicit (vec3(0.0)); water and
    // highlight are scaled by water_density so they fade to zero at the
    // column edges with no visible border.
    vec3 col = vec3(0.0);
    col += water_col * water_density;

    // Highlight threshold LOWERED (0.65, 0.85) → (0.50, 0.75). A 3-octave
    // fbm rarely reaches 0.85; the old threshold triggered in roughly the
    // top 8% of fbm values, making highlights uncommon. New threshold
    // triggers in roughly the top 30%, so crests are visible frequently.
    //
    // Multiplier REDUCED (0.8 → 0.5) — base streak brightness now reaches
    // ~0.9 at peak w, so 0.5 extra on top keeps the total within a
    // reasonable overshoot range before the final clamp.
    col += water_col * smoothstep(0.50, 0.75, w) * water_density * 0.5;

    // Overhead atmospheric mist — turbulence fbm with Beer's law composition.
    // Falling mist coordinate. Base frequency RAISED 25.0 → 40.0 for finer
    // features (~2.5% of screen width per feature, down from 4%). Time
    // coefficients HALVED for slower motion overall:
    //   y-drift: 3.00 → 0.75. New scroll rate = 0.75 / 40.0 = 0.019
    //            screen-heights/time-unit (was 0.12, now 16% of previous —
    //            note this is also affected by the freq change; halving the
    //            time coefficient AND raising freq compounds to slower drift)
    //   z-evolution: 0.5 → 0.25. Half the previous evolution rate.
    vec3 overhead_p = vec3(
        uv.x * 40.0,
        uv.y * 40.0 + t * 0.75,
        t * 0.25
    );
    float overhead_raw = fbm_haze(overhead_p);

    // Envelopes unchanged.
    float overhead_h_dist = abs(uv.x - 0.5);
    float overhead_h_env = smoothstep(0.40, 0.30, overhead_h_dist);

    float overhead_v_env =
          smoothstep(0.0, 0.05, uv.y)
        * smoothstep(1.0, 0.90, uv.y);

    // Wisp threshold TIGHTENED (0.35, 0.45) → (0.45, 0.55). Higher lower
    // bound means fewer pixels qualify as wisp. Result: sparser, more
    // punctuated mist coverage instead of broad continuous regions.
    float overhead_wisp = smoothstep(0.45, 0.55, overhead_raw);

    float overhead_density = overhead_wisp * overhead_h_env * overhead_v_env;

    // Beer's law: exp(-density * k) gives transmittance. k=3.0 → at peak
    // density, water is 5% visible through the wisp.
    // Mist color INHERITS hue field via palette_t. On multi-color palettes
    // like rainbow, this produces a horizontal mist color gradient matching
    // the water below it — mist atop a green stream is greenish, mist atop
    // a blue stream is bluish. On gradient palettes, mist color varies
    // smoothly with the hue field's spatial pattern.
    //
    // mix(palette(palette_t), palette(0.95), 0.4) blends the local hue with
    // a 40% pull toward the palette-endpoint "haze" color — gives the mist
    // some atmospheric uniformity while preserving palette inheritance.
    vec3 overhead_color = mix(palette(palette_t), palette(0.95), 0.4);
    float overhead_transmittance = exp(-overhead_density * 3.0);
    col = col * overhead_transmittance
        + overhead_color * (1.0 - overhead_transmittance);

    // Rising impact mist — turbulence fbm with more aggressive Beer's law
    // coefficient (4.5) for near-total obscuration at plume core.
    // Rising mist coordinate. Base frequencies RAISED 30/15 → 45/22.5 for
    // finer features (preserves 2:1 aspect ratio for plume verticality).
    // Time coefficients DRASTICALLY REDUCED to 10% of previous rates:
    //   y-drift: -9.00 → -0.90. New upward scroll = -0.90/22.5 = -0.04
    //            screen-heights/time-unit (was -0.60). Plume motion now
    //            gentle and meandering, not racing.
    //   z-evolution: 1.0 → 0.10. Slow morphing — features change shape
    //            over a ~10 second timescale at the lowest octave, matching
    //            real impact-mist convection which is calmer than expected.
    vec3 rising_p = vec3(
        uv.x * 45.0,
        uv.y * 22.5 - t * 0.90,
        t * 0.10
    );
    float rising_raw = fbm_haze(rising_p);

    // Envelopes unchanged.
    float rising_h_dist = abs(uv.x - 0.5);
    float rising_h_env = smoothstep(0.35, 0.25, rising_h_dist);

    float rising_v_env =
          exp(-uv.y * 4.0)
        * (1.0 - smoothstep(0.40, 0.55, uv.y));

    // Wisp threshold TIGHTENED (0.30, 0.40) → (0.40, 0.50). Same logic as
    // overhead — sparser coverage. Rising mist still has wider coverage
    // than overhead (lower threshold values) because it's the dominant
    // effect at the impact zone, but no longer fills its envelope densely.
    float rising_wisp = smoothstep(0.40, 0.50, rising_raw);

    float rising_density = rising_wisp * rising_h_env * rising_v_env;

    // Beer's law: k=4.5 → transmittance ≈ 0.011 at peak density (near-total
    // obscuration at impact zone, hiding water-ground transition).
    // Rising mist color also inherits hue field, with slightly stronger
    // pull toward palette endpoint (0.5 vs 0.4 for overhead). Reasoning:
    // rising mist is dense at impact zone where convection mixes air —
    // real impact mist has a more uniform "white-haze" appearance than
    // gentle ambient atmospheric haze. The 50/50 blend gives both palette
    // inheritance and atmospheric uniformity.
    vec3 rising_color = mix(palette(palette_t), palette(0.95), 0.5);
    float rising_transmittance = exp(-rising_density * 4.5);
    col = col * rising_transmittance
        + rising_color * (1.0 - rising_transmittance);

    // Mist at the base (bottom 30%). Uniform early-out across most RDNA
    // wavefronts — saves fbm_mist on ~70% of pixels.
    if (uv.y < 0.30) {
        float x_dist = abs(uv.x - 0.5);

        // Horizontal envelope: extends past the wider water column onto rock
        float mist_half_width = 0.45 - uv.y * 0.4;
        float horizontal = 1.0 - smoothstep(0.0, mist_half_width, x_dist);

        // Vertical envelope: strong at base, decays upward.
        // Taper to zero at the branch boundary (uv.y = 0.30) so the quantize
        // post-process has no density step to amplify into a visible line.
        float vertical = exp(-uv.y * 6.0) * (1.0 - smoothstep(0.0, 0.30, uv.y));

        // Mist drifts UP: -t in y sample direction
        // Bottom mist scroll rate REDUCED to 25% of previous (0.25 → 0.0625).
        // New upward scroll: 0.0625/4.0 = 0.0156 screen-heights per time unit.
        // Slower drift reads as heavier, denser mist rather than kinetic spray.
        vec2 mist_uv = vec2(uv.x * 3.0, uv.y * 4.0 - t * 0.0625);
        float mist_noise = fbm_mist(mist_uv);

        float mist_density = horizontal * vertical * mist_noise;
        col += palette(0.95) * mist_density * 0.6;
    }

    col = clamp(col, 0.0, 1.0);

    // PS1-style quantize + 4×4 Bayer dither — copied verbatim from wormhole.frag
    const mat4 bayer4 = mat4(
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0
    ) / 16.0 - 0.5;
    ivec2 px     = ivec2(gl_FragCoord.xy) & 3;
    float dither = bayer4[px.x][px.y] / 32.0;
    col = floor(col * 32.0 + dither + 0.5) / 32.0;
    fragColor = vec4(col, 1.0);
}
