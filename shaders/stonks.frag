#version 320 es
precision mediump float;

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// stonks.frag — procedural candlestick chart with MACD oscillator overlay.
//
// Palette positions (fixed semantic mapping — palette change shifts colors but NOT roles):
//   0.85 = bullish candle body
//   0.15 = bearish candle body
//   0.50 = MACD line (neutral)
//   0.65 = signal line
//   0.08 = grid lines

const int   VISIBLE = 40;

// Fixed price and MACD bounds (sine amplitude envelopes + ~10% margin)
const float P_MIN = -2.5;
const float P_MAX =  2.5;
const float M_MIN = -0.95;
const float M_MAX =  0.95;

// ---------------------------------------------------------------------------
// O(1) candle data — direct sine evaluation, no per-pixel loops.
// Close of candle N == open of candle N+1 (continuity by construction).
// ---------------------------------------------------------------------------
void candleAt(float col_abs, out float o, out float c, out float h, out float l) {
    float amp_mod = 0.6 + sin(col_abs * 0.04) * 0.4;   // slow envelope, range 0.2..1.0

    float noise_o = (sin(col_abs * 0.55) * 1.1
                  +  sin(col_abs * 0.13 + 1.7) * 0.55
                  +  sin(col_abs * 0.037 + 3.1) * 0.6
                  +  sin(col_abs * 1.73 + 0.4) * 0.20) * amp_mod;

    float noise_c = (sin((col_abs + 1.0) * 0.55) * 1.1
                  +  sin((col_abs + 1.0) * 0.13 + 1.7) * 0.55
                  +  sin((col_abs + 1.0) * 0.037 + 3.1) * 0.6
                  +  sin((col_abs + 1.0) * 1.73 + 0.4) * 0.20) * amp_mod;

    o = noise_o;
    c = noise_c;

    float wick_top = max(0.0, sin(col_abs * 2.3 + 4.1) * 0.20 * amp_mod);
    float wick_bot = max(0.0, sin(col_abs * 1.9 + 7.7) * 0.20 * amp_mod);
    h = max(o, c) + wick_top;
    l = min(o, c) - wick_bot;
}

float macd_at(float col_abs) {
    return sin(col_abs * 0.22) * 0.5 + sin(col_abs * 0.09 + 2.3) * 0.3;
}

float signal_at(float col_abs) {
    return sin(col_abs * 0.18) * 0.45 + sin(col_abs * 0.07 + 2.1) * 0.28;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
void main() {
    vec2  uv = gl_FragCoord.xy / u_resolution.xy;
    float t  = u_time * u_speed_scale;

    // Scroll: one new candle every 1.5 seconds
    float scroll_t    = t / 1.5;
    float scroll_int  = floor(scroll_t);
    float scroll_frac = fract(scroll_t);

    // Candle geometry
    float chart_h   = 0.80;
    float macd_h    = 0.18;
    float gap_h     = 0.02;

    float candle_w  = 1.0 / float(VISIBLE);
    float body_frac = 0.65;
    float wick_frac = 0.12;

    // Which visible candle column does this pixel belong to?
    float uv_x_scrolled = uv.x + scroll_frac * candle_w;
    float col_f     = uv_x_scrolled / candle_w;
    int   col_vis   = int(floor(col_f));
    float col_phase = fract(col_f);

    // Absolute candle index — no warm-up offset needed (no arrays)
    float col_abs = scroll_int + float(col_vis);

    // Fetch O(1) candle data
    float o, c, h, l;
    candleAt(col_abs, o, c, h, l);
    bool bullish = c >= o;

    float p_range = P_MAX - P_MIN;
    float m_range = M_MAX - M_MIN;

    // -----------------------------------------------------------------------
    // UV → price / MACD space
    // -----------------------------------------------------------------------
    float chart_bottom = gap_h + macd_h;
    float chart_uv_y   = (uv.y - chart_bottom) / chart_h;
    float macd_uv_y    = uv.y / macd_h;

    float open_y  = (o - P_MIN) / p_range;
    float close_y = (c - P_MIN) / p_range;
    float high_y  = (h - P_MIN) / p_range;
    float low_y   = (l - P_MIN) / p_range;

    float body_half = body_frac * 0.5;
    float wick_half = wick_frac * 0.5;
    bool  in_body   = col_phase >= (0.5 - body_half) && col_phase <= (0.5 + body_half);
    bool  in_wick   = col_phase >= (0.5 - wick_half) && col_phase <= (0.5 + wick_half);

    // -----------------------------------------------------------------------
    // Pixel color accumulation
    // -----------------------------------------------------------------------
    vec3 col = vec3(0.0);

    bool in_chart = uv.y >= chart_bottom;
    bool in_macd  = uv.y < macd_h;

    // ---- Grid lines (subtle horizontal, chart region only) ----
    if (in_chart) {
        float grid_count = 5.0;
        float grid_phase = fract(chart_uv_y * grid_count);
        float d_grid     = min(grid_phase, 1.0 - grid_phase) / grid_count * chart_h * u_resolution.y;
        float grid_glow  = smoothstep(1.5, 0.1, d_grid);
        col += palette(0.08) * grid_glow * 0.12;
    }

    // ---- Candle body ----
    if (in_chart && in_body) {
        float body_lo = min(open_y, close_y);
        float body_hi = max(open_y, close_y);
        float min_h = 2.0 / (chart_h * u_resolution.y);
        if (body_hi - body_lo < min_h) {
            body_lo -= min_h * 0.5;
            body_hi += min_h * 0.5;
        }
        if (chart_uv_y >= body_lo && chart_uv_y <= body_hi) {
            float pal_t = bullish ? 0.85 : 0.15;
            col += palette(pal_t);
        }
    }

    // ---- Wick (only where NOT covered by body) ----
    if (in_chart && in_wick) {
        float body_lo = min(open_y, close_y);
        float body_hi = max(open_y, close_y);
        bool in_body_range = chart_uv_y >= body_lo && chart_uv_y <= body_hi;
        if (!in_body_range && chart_uv_y >= low_y && chart_uv_y <= high_y) {
            float pal_t = bullish ? 0.85 : 0.15;
            col += palette(pal_t) * 0.75;
        }
    }

    // ---- MACD + signal lines ----
    if (in_macd) {
        float macd_val_raw = macd_at(col_abs);
        float sig_val_raw  = signal_at(col_abs);

        float macd_val  = (macd_val_raw - M_MIN) / m_range;
        float d_macd    = abs(macd_uv_y - macd_val) * macd_h * u_resolution.y;
        float macd_glow = smoothstep(2.5, 0.3, d_macd);
        col += palette(0.50) * macd_glow;

        float sig_val  = (sig_val_raw - M_MIN) / m_range;
        float d_sig    = abs(macd_uv_y - sig_val) * macd_h * u_resolution.y;
        float sig_glow = smoothstep(2.5, 0.3, d_sig);
        col += palette(0.65) * sig_glow * 0.85;

        // Faint zero-line
        float zero_val  = (0.0 - M_MIN) / m_range;
        float d_zero    = abs(macd_uv_y - zero_val) * macd_h * u_resolution.y;
        float zero_glow = smoothstep(1.2, 0.1, d_zero);
        col += palette(0.08) * zero_glow * 0.15;
    }

    fragColor = vec4(clamp(col, 0.0, 1.0), u_alpha);
}
