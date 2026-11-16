#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — attitude.frag  (v2: circular gauge on black bezel)
//
// Aviation artificial-horizon gauge rendered as a circular instrument on a
// black field.  Three concentric zones:
//
//   BEZEL      (r > R_OUT):                always black
//   OUTER RING (R_RIM < r < R_OUT):        screen-fixed sky/ground reference
//                                          + white roll-scale ticks
//                                          + fixed white bank-index triangle
//   DISC       (r < R_DISC):               rotates with roll, translates with
//                                          pitch — sky/ground, horizon, pitch
//                                          ladder, accent roll pointer
//
// A 0.015-wide dark gap (R_DISC..R_RIM) separates disc from ring, matching
// typical instrument face construction.
//
// Five colour roles:
//   1. Bezel ................................. vec3(0.0)
//   2. White dial elements ................... vec3(1.0)
//        (roll-scale ticks, bank index, horizon line, pitch ladder)
//   3. Accent instrument elements ............ palette(0.05)
//        (W-symbol, moving roll pointer, centre dot)
//   4. Sky plane (both ring + disc) .......... palette(0.75)
//   5. Ground plane (both ring + disc) ....... palette(0.25)
//
// NOTE ON ACCENT SAMPLE: 0.05 is a best-guess starting point.  For palettes
// where the low-LUT end is close to the ground colour (0.25), this will look
// muddy.  Try palette(1.0), palette(0.0), or palette(0.5) as alternatives.
//
// Pure 2D SDF — no raymarching, noise, textures, or particles.
// Expected cost: Lightweight tier (<25% GPU).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// --- SDF helpers --------------------------------------------------------

// Distance from p to line segment a→b.
float sdSeg(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

// Signed distance to filled triangle (negative = inside).
float sdTri(vec2 p, vec2 a, vec2 b, vec2 c) {
    vec2 e0 = b-a, e1 = c-b, e2 = a-c;
    vec2 v0 = p-a, v1 = p-b, v2 = p-c;
    vec2 pq0 = v0 - e0*clamp(dot(v0,e0)/dot(e0,e0), 0.0, 1.0);
    vec2 pq1 = v1 - e1*clamp(dot(v1,e1)/dot(e1,e1), 0.0, 1.0);
    vec2 pq2 = v2 - e2*clamp(dot(v2,e2)/dot(e2,e2), 0.0, 1.0);
    float s = sign(e0.x*e2.y - e0.y*e2.x);
    vec2 d  = min(min(vec2(dot(pq0,pq0), s*(v0.x*e0.y-v0.y*e0.x)),
                      vec2(dot(pq1,pq1), s*(v1.x*e1.y-v1.y*e1.x))),
                      vec2(dot(pq2,pq2), s*(v2.x*e2.y-v2.y*e2.x)));
    return -sqrt(d.x)*sign(d.y);
}

float strokeCov(float d, float thick) {
    float aa = fwidth(d);
    return 1.0 - smoothstep(thick - aa, thick + aa, d);
}

float fillCov(float d) {
    float aa = fwidth(d);
    return 1.0 - smoothstep(-aa, aa, d);
}

// Horizontal pitch-ladder tick centred on (0, ty) in the current frame.
float tickCov(vec2 p, float ty, float hw, float thick) {
    float dy = p.y - ty;
    float dx = abs(p.x) - hw;
    return strokeCov(length(vec2(max(dx, 0.0), dy)), thick);
}

// Radial tick on a circle of radius R at angle theta_deg from +y axis
// (clockwise = right bank), extending INWARD by `len`.
float arcTickCov(vec2 p, float theta_deg, float R, float len, float thick) {
    float th  = radians(theta_deg);
    vec2  dir = vec2(sin(th), cos(th));
    return strokeCov(sdSeg(p, dir * R, dir * (R - len)), thick);
}

// ------------------------------------------------------------------------

void main() {
    vec2  fc  = gl_FragCoord.xy;
    vec2  res = u_resolution.xy;
    float t   = mod(u_time * u_speed_scale, 600.0);

    // Centred UV — y normalised by screen height.
    vec2  uv  = (fc - 0.5 * res) / res.y;
    float r   = length(uv);
    float aaR = fwidth(r);

    // --- Simulated flight motion ----------------------------------------
    // Compound sines give non-repetitive motion without explicit noise.
    float roll_deg  =  20.0*sin(t*0.27) + 10.0*sin(t*0.11);
    float pitch_deg =  12.0*sin(t*0.19) +  5.0*sin(t*0.13);
    float roll_rad  = radians(roll_deg);
    float pitch_off = pitch_deg * 0.01;

    float cr = cos(roll_rad), sr = sin(roll_rad);

    // --- Instrument-frame UV (rotate by -roll, shift by pitch) ----------
    vec2 iuv = vec2(cr*uv.x + sr*uv.y, -sr*uv.x + cr*uv.y);
    iuv.y   += pitch_off;

    // --- Gauge geometry -------------------------------------------------
    const float R_OUT  = 0.45;    // outer edge of ring (bezel boundary)
    const float R_RIM  = 0.37;    // inner edge of ring
    const float R_DISC = 0.355;   // outer edge of rotating disc

    // --- Colour roles ---------------------------------------------------
    vec3 sky    = palette(0.92);
    vec3 ground = palette(0.08);
    vec3 accent = palette(0.50);   // see header note on tuning
    vec3 white  = vec3(1.0);
    vec3 bezel  = vec3(0.0);

    // Start with bezel (fills everywhere; overwritten inside the gauge).
    vec3 col = bezel;

    // ===================================================================
    // OUTER RING — fixed sky/ground reference + white roll scale
    // ===================================================================
    float inOuter = 1.0 - smoothstep(R_OUT - aaR, R_OUT + aaR, r);
    float inRim   =       smoothstep(R_RIM - aaR, R_RIM + aaR, r);
    float inRing  = inOuter * inRim;

    // Screen-fixed sky/ground split at y == 0.
    vec3 ringCol = mix(ground, sky, step(0.0, uv.y));
    col = mix(col, ringCol, inRing);

    // Roll-scale tick marks (inward from R_OUT).
    {
        const float R   = R_OUT;
        const float TKT = 0.0035;
        const float LMJ = 0.050;   // major tick length
        const float LMN = 0.028;   // minor tick length

        float tk = 0.0;
        // Major: 0°, ±30°, ±60°, ±90°
        tk = max(tk, arcTickCov(uv,   0.0, R, LMJ, TKT));
        tk = max(tk, arcTickCov(uv,  30.0, R, LMJ, TKT));
        tk = max(tk, arcTickCov(uv, -30.0, R, LMJ, TKT));
        tk = max(tk, arcTickCov(uv,  60.0, R, LMJ, TKT));
        tk = max(tk, arcTickCov(uv, -60.0, R, LMJ, TKT));
        tk = max(tk, arcTickCov(uv,  90.0, R, LMJ, TKT));
        tk = max(tk, arcTickCov(uv, -90.0, R, LMJ, TKT));
        // Minor: ±10°, ±20°, ±45°
        tk = max(tk, arcTickCov(uv,  10.0, R, LMN, TKT));
        tk = max(tk, arcTickCov(uv, -10.0, R, LMN, TKT));
        tk = max(tk, arcTickCov(uv,  20.0, R, LMN, TKT));
        tk = max(tk, arcTickCov(uv, -20.0, R, LMN, TKT));
        tk = max(tk, arcTickCov(uv,  45.0, R, LMN, TKT));
        tk = max(tk, arcTickCov(uv, -45.0, R, LMN, TKT));
        col = mix(col, white, tk * inRing);
    }

    // Fixed bank-index triangle at top of ring, apex pointing inward.
    {
        const float BI_SZ = 0.018;
        vec2 apex  = vec2(0.0,    R_RIM + BI_SZ * 0.15);   // tip near inner rim
        vec2 base1 = vec2(-BI_SZ, R_RIM + BI_SZ * 1.35);
        vec2 base2 = vec2( BI_SZ, R_RIM + BI_SZ * 1.35);
        col = mix(col, white, fillCov(sdTri(uv, apex, base1, base2)));
    }

    // ===================================================================
    // INNER DISC — rotates with roll, translates with pitch
    // ===================================================================
    float inDisc = 1.0 - smoothstep(R_DISC - aaR, R_DISC + aaR, r);

    // Sky/ground fill in instrument space.
    vec3 discCol = mix(ground, sky, step(0.0, iuv.y));
    col = mix(col, discCol, inDisc);

    // Horizon line.
    col = mix(col, white, inDisc * strokeCov(abs(iuv.y), 0.0045));

    // Pitch ladder — k=1..4 → ticks at ±5°, ±10°, ±15°, ±20°
    // (iuv.y = ±0.05 … ±0.20).  Even k is major (wider), odd k is minor.
    {
        float tc = 0.0;
        for (int k = 1; k <= 4; k++) {
            float ty = float(k) * 0.05;
            float hw = (k % 2 == 0) ? 0.055 : 0.028;
            tc = max(tc, tickCov(iuv,  ty, hw, 0.003));
            tc = max(tc, tickCov(iuv, -ty, hw, 0.003));
        }
        col = mix(col, white, tc * inDisc);
    }

    // Moving roll pointer — accent triangle at the top of the disc in
    // instrument space.  Because the disc rotates with roll, this sweeps
    // across the fixed outer roll scale.
    //
    // "Up in instrument space" → screen uv = Rotate(+roll_rad) * (0, 1)
    //    = (-sin roll_rad, cos roll_rad) = (-sr, cr)
    // Perpendicular (CW 90°) = (cr, sr).  Independent of pitch_off.
    {
        const float RP_SZ    = 0.015;
        const float RP_INSET = 0.012;
        vec2 up = vec2(-sr, cr);
        vec2 pt = vec2( cr, sr);
        vec2 apex  = up * (R_DISC - RP_INSET);
        vec2 base1 = up * (R_DISC - RP_INSET - RP_SZ * 1.3) + pt * RP_SZ;
        vec2 base2 = up * (R_DISC - RP_INSET - RP_SZ * 1.3) - pt * RP_SZ;
        col = mix(col, accent, fillCov(sdTri(uv, apex, base1, base2)));
    }

    // ===================================================================
    // Screen-fixed top layer — aircraft W-symbol + centre dot (accent)
    // ===================================================================
    {
        const float SZ   = 0.090;   // outer half-span
        const float GAP  = 0.028;   // half-width of inner V break
        const float DROP = 0.022;   // depth of centre V notch
        const float THK  = 0.005;

        float wd = min(
            min(sdSeg(uv, vec2(-SZ,  0.0),  vec2(-GAP,  0.0)),
                sdSeg(uv, vec2(-GAP, 0.0),  vec2( 0.0, -DROP))),
            min(sdSeg(uv, vec2( 0.0, -DROP), vec2( GAP,  0.0)),
                sdSeg(uv, vec2( GAP,  0.0),  vec2( SZ,   0.0)))
        );
        col = mix(col, accent, strokeCov(wd, THK));
    }

    // Centre accent dot.
    col = mix(col, accent, fillCov(length(uv) - 0.008));

    fragColor = vec4(col, 1.0);
}
