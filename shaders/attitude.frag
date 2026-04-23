#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — attitude.frag
//
// Artificial horizon / attitude indicator with palette-driven sky and ground.
// Pure analytical geometry — SDF-based lines and arcs, no raymarching,
// no noise, no particles.
//
// Instrument frame (rotates/translates with roll and pitch):
//   Sky:    palette(0.72)
//   Ground: palette(0.28)
//   Horizon line at iuv.y == 0
//   Pitch ladder ticks at 5° intervals (±5° … ±20°)
//
// Screen frame (always fixed — these do NOT tilt with the horizon):
//   Aircraft W-symbol at screen centre
//   Roll indicator arc ±60° at radius 0.35 from centre
//   Roll pointer triangle on the arc
//
// All instrument markings: palette(0.95)
//
// GPU cost: pure 2D SDF geometry. Lightweight tier (<25% GPU).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// ---------------------------------------------------------------------------
// SDF helpers
// ---------------------------------------------------------------------------

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

// 1-pixel AA coverage for a stroke of given thickness (d = distance to centreline).
float strokeCov(float d, float thick) {
    float aa = fwidth(d);
    return 1.0 - smoothstep(thick - aa, thick + aa, d);
}

// 1-pixel AA coverage for a filled SDF (negative inside, positive outside).
float fillCov(float d) {
    float aa = fwidth(d);
    return 1.0 - smoothstep(-aa, aa, d);
}

// Horizontal pitch-ladder tick centred on (0, ty), half-width hw.
float tickCov(vec2 p, float ty, float hw, float thick) {
    float dy = p.y - ty;
    float dx = abs(p.x) - hw;
    return strokeCov(length(vec2(max(dx, 0.0), dy)), thick);
}

// Radial tick on the roll arc at angle theta_deg from +y axis (clockwise = right bank).
// Tick drawn inward from the arc by len.
float arcTickCov(vec2 p, float theta_deg, float R, float len, float thick) {
    float th  = radians(theta_deg);
    vec2  dir = vec2(sin(th), cos(th));
    return strokeCov(sdSeg(p, dir * R, dir * (R - len)), thick);
}

// ---------------------------------------------------------------------------

void main() {
    vec2  fc  = gl_FragCoord.xy;
    vec2  res = u_resolution.xy;
    // Wrap time to keep float precision clean after long runtimes.
    float t   = mod(u_time * u_speed_scale, 600.0);

    // Centred UV — y normalised by screen height; x scales with aspect ratio.
    vec2 uv = (fc - 0.5 * res) / res.y;

    // ---- Simulated flight motion ----
    // Compound sines give non-repetitive turbulence without explicit noise.
    float roll_deg  =  20.0*sin(t*0.27) + 10.0*sin(t*0.11);
    float pitch_deg =  12.0*sin(t*0.19) +  5.0*sin(t*0.13);
    float roll_rad  = radians(roll_deg);
    // 0.01 uv per degree of pitch; positive pitch_off moves horizon below centre.
    float pitch_off = pitch_deg * 0.01;

    // ---- Instrument-frame UV ----
    // Rotate screen UV by -roll_rad (inverse of aircraft roll) to align horizon
    // horizontally in instrument space.  Then shift vertically for pitch so that
    // nose-up pitch causes the horizon to drop below the centre mark.
    float cr = cos(roll_rad), sr = sin(roll_rad);
    vec2 iuv = vec2(cr*uv.x + sr*uv.y, -sr*uv.x + cr*uv.y);
    iuv.y += pitch_off;   // nose-up → pitch_off > 0 → horizon shifts below centre

    // ===================================================================
    // Instrument-frame layer (sky, ground, horizon, pitch ladder)
    // ===================================================================

    // ---- Sky / Ground fill ----
    vec3 sky    = palette(0.72);
    vec3 ground = palette(0.28);
    vec3 col    = mix(ground, sky, step(0.0, iuv.y));

    // ---- Horizon line ----
    col = mix(col, palette(0.95), strokeCov(abs(iuv.y), 0.005));

    // ---- Pitch ladder ----
    // k=1..4 → ticks at ±5°, ±10°, ±15°, ±20° equivalent.
    // Even k = major tick (wider, ±10° and ±20°); odd k = minor (narrower).
    {
        float tc = 0.0;
        for (int k = 1; k <= 4; k++) {
            float ty = float(k) * 0.05;
            float hw = (k % 2 == 0) ? 0.060 : 0.030;
            tc = max(tc, tickCov(iuv,  ty, hw, 0.003));
            tc = max(tc, tickCov(iuv, -ty, hw, 0.003));
        }
        col = mix(col, palette(0.95), tc);
    }

    // ===================================================================
    // Screen-frame layer (roll arc, pointer, aircraft symbol)
    // These are composited on top and do NOT rotate with the horizon.
    // ===================================================================

    // ---- Roll indicator arc ----
    // 120° arc (±60° from +y axis) centred at screen origin, radius 0.35.
    {
        const float R    = 0.35;
        const float ATHK = 0.004;

        // phi: angle from +y axis, clockwise positive → right bank = positive phi.
        float phi    = atan(uv.x, uv.y);
        float inArc  = step(abs(phi), radians(60.0));
        float arcD   = abs(length(uv) - R);
        col = mix(col, palette(0.95), inArc * strokeCov(arcD, ATHK));

        // Arc tick marks.  Major ticks (mj) at 0°, ±30°, ±60°; minor (mn) at ±10°, ±20°, ±45°.
        float mj = 0.030, mn = 0.018, tkT = 0.003;
        float tk = 0.0;
        tk = max(tk, arcTickCov(uv,   0.0, R, mj, tkT));
        tk = max(tk, arcTickCov(uv,  10.0, R, mn, tkT));
        tk = max(tk, arcTickCov(uv, -10.0, R, mn, tkT));
        tk = max(tk, arcTickCov(uv,  20.0, R, mn, tkT));
        tk = max(tk, arcTickCov(uv, -20.0, R, mn, tkT));
        tk = max(tk, arcTickCov(uv,  30.0, R, mj, tkT));
        tk = max(tk, arcTickCov(uv, -30.0, R, mj, tkT));
        tk = max(tk, arcTickCov(uv,  45.0, R, mn, tkT));
        tk = max(tk, arcTickCov(uv, -45.0, R, mn, tkT));
        tk = max(tk, arcTickCov(uv,  60.0, R, mj, tkT));
        tk = max(tk, arcTickCov(uv, -60.0, R, mj, tkT));
        col = mix(col, palette(0.95), tk);

        // Roll pointer — filled triangle pointing inward from the arc at roll_rad.
        // apex is inside the arc, base straddles the arc edge.
        vec2 pDir  = vec2(sin(roll_rad), cos(roll_rad));   // direction from centre to pointer
        vec2 pPerp = vec2(-pDir.y, pDir.x);               // perpendicular direction
        float pSz  = 0.020;
        vec2 apex  = pDir * (R - pSz * 1.2);
        vec2 base1 = pDir * R + pPerp * pSz;
        vec2 base2 = pDir * R - pPerp * pSz;
        col = mix(col, palette(0.95), fillCov(sdTri(uv, apex, base1, base2)));
    }

    // ---- Aircraft W-symbol (screen-fixed reference mark) ----
    // Two horizontal outer bars connected at the centre by a shallow V notch.
    {
        const float SZ   = 0.090;   // outer half-span
        const float GAP  = 0.028;   // half-width of inner V break
        const float DROP = 0.022;   // depth of centre V notch
        const float THK  = 0.004;   // stroke thickness

        float wd = min(
            min(sdSeg(uv, vec2(-SZ,  0.0),  vec2(-GAP,  0.0)),   // left bar
                sdSeg(uv, vec2(-GAP, 0.0),  vec2( 0.0, -DROP))),  // left arm of V
            min(sdSeg(uv, vec2( 0.0, -DROP), vec2( GAP,  0.0)),   // right arm of V
                sdSeg(uv, vec2( GAP,  0.0),  vec2( SZ,   0.0)))   // right bar
        );
        col = mix(col, palette(0.95), strokeCov(wd, THK));
    }

    fragColor = vec4(col, 1.0);
}
