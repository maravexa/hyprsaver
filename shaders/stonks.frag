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
const float P_MIN = -2.0;
const float P_MAX =  2.0;
const float M_MIN = -1.0;
const float M_MAX =  1.0;

// ---------------------------------------------------------------------------
// Phase-based trend and volatility (block hashing, O(1) per pixel)
// ---------------------------------------------------------------------------
float hash11(float n) {
    return fract(sin(n * 127.1) * 43758.5453);
}

const float BLOCK_LEN    = 9.0;
const int   TREND_BLOCKS = 12;

void phaseAt(float col_abs, out float trend_dir, out float vol_mult) {
    float block = floor(col_abs / BLOCK_LEN);
    float h_t   = hash11(block * 1.13);
    float h_v   = hash11(block * 2.71 + 17.0);
    trend_dir   = floor(h_t * 3.0) - 1.0;           // -1, 0, +1
    vol_mult    = 0.3 + floor(h_v * 3.0) * 0.35;    // 0.3, 0.65, 1.0
}

float cumulativeTrend(float col_abs) {
    float block    = floor(col_abs / BLOCK_LEN);
    float in_block = col_abs - block * BLOCK_LEN;
    float sum      = 0.0;
    for (int i = 1; i < TREND_BLOCKS; i++) {
        float b  = block - float(i);
        float h  = hash11(b * 1.13);
        float td = floor(h * 3.0) - 1.0;
        // Fade out oldest blocks in window to prevent pan jumps at window edge
        float w  = 1.0 - smoothstep(float(TREND_BLOCKS) - 3.0, float(TREND_BLOCKS), float(i));
        sum += td * 0.08 * BLOCK_LEN * w;
    }
    float h_curr  = hash11(block * 1.13);
    float td_curr = floor(h_curr * 3.0) - 1.0;
    sum += td_curr * 0.08 * in_block;
    return sum;
}

// ---------------------------------------------------------------------------
// O(1) candle data — direct sine evaluation, no per-pixel loops.
// Close of candle N == open of candle N+1 (continuity by construction).
// ---------------------------------------------------------------------------
void candleAt(float col_abs, out float o, out float c, out float h, out float l) {
    float trend_dir, vol_mult;
    phaseAt(col_abs, trend_dir, vol_mult);

    float noise_o = sin(col_abs * 0.55) * 1.1 + sin(col_abs * 0.13 + 1.7) * 0.55;
    float noise_c = sin((col_abs + 1.0) * 0.55) * 1.1 + sin((col_abs + 1.0) * 0.13 + 1.7) * 0.55;

    float trend_base = cumulativeTrend(col_abs);

    o = noise_o * vol_mult + trend_base;
    c = noise_c * vol_mult + trend_base + trend_dir * 0.08;

    float wick_top = max(0.0, sin(col_abs * 2.3 + 4.1) * 0.20 * vol_mult);
    float wick_bot = max(0.0, sin(col_abs * 1.9 + 7.7) * 0.20 * vol_mult);
    h = max(o, c) + wick_top;
    l = min(o, c) - wick_bot;
}

float macd_at(float col_abs) {
    float trend_dir, vol_mult;
    phaseAt(col_abs, trend_dir, vol_mult);
    return (sin(col_abs * 0.22) * 0.5 + sin(col_abs * 0.09 + 2.3) * 0.3) * vol_mult + trend_dir * 0.15;
}

float signal_at(float col_abs) {
    float trend_dir, vol_mult;
    phaseAt(col_abs, trend_dir, vol_mult);
    return (sin(col_abs * 0.18) * 0.45 + sin(col_abs * 0.07 + 2.1) * 0.28) * vol_mult + trend_dir * 0.13;
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

    // Viewport pan: follow cumulative trend so chart drifts with bull/bear phases
    float pan_y = cumulativeTrend(scroll_int + float(VISIBLE) * 0.5) * 0.7;
    o -= pan_y;
    c -= pan_y;
    h -= pan_y;
    l -= pan_y;

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
