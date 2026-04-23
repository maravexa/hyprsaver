#version 320 es
precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// stonks.frag — procedural candlestick chart with MACD oscillator overlay.
//
// Palette positions (fixed semantic mapping — palette change shifts colors but NOT roles):
//   0.85 = bullish candle body
//   0.15 = bearish candle body
//   0.50 = MACD line + wicks (neutral)
//   0.65 = signal line
//   0.08 = grid lines

// ---------------------------------------------------------------------------
// Hash / noise
// ---------------------------------------------------------------------------
float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

// 2-octave value noise (deterministic, no sin hashing)
float noise2(float x) {
    float i = floor(x);
    float f = fract(x);
    float u = f * f * (3.0 - 2.0 * f);
    return mix(hash11(i), hash11(i + 1.0), u);
}

float fbm2(float x) {
    return noise2(x) * 0.6 + noise2(x * 2.17 + 7.3) * 0.4;
}

// ---------------------------------------------------------------------------
// Price series — cumulative centered random walk built from fbm2.
// Computed over a window starting at candle index `base_col`, running `count`
// steps.  Fills price[0..count] with close values; also fills open[], high[],
// low[].  All arrays are sized to WARM + VISIBLE.
// ---------------------------------------------------------------------------
const int VISIBLE   = 40;
const int WARM      = 70;   // EMA warm-up candles to the left of visible window
const int TOTAL     = 110;  // WARM + VISIBLE

// Step amplitude per candle — controls chart volatility
const float STEP_AMP = 0.045;

// ---------------------------------------------------------------------------
// Build the full OHLC + MACD arrays.  Called once per fragment with the same
// base_col value for every pixel in a frame, so the compiler can treat these
// as loop-invariant constants (no per-pixel iteration cost beyond TOTAL steps).
// ---------------------------------------------------------------------------
void buildOHLC(float base_col,
               out float closes[110],
               out float opens[110],
               out float highs[110],
               out float lows[110]) {
    float price = 0.0;
    for (int k = 0; k < TOTAL; k++) {
        float x     = float(k) + base_col;
        float step  = (fbm2(x * 0.31 + 17.3) * 2.0 - 1.0) * STEP_AMP;
        float noise = (fbm2(x * 1.7  + 53.1) * 2.0 - 1.0) * STEP_AMP * 0.5;
        opens[k]  = price;
        price    += step;
        closes[k] = price;
        highs[k]  = max(opens[k], closes[k]) + abs(noise) + 0.005;
        lows[k]   = min(opens[k], closes[k]) - abs(noise) - 0.005;
    }
}

// ---------------------------------------------------------------------------
// EMA helpers — iterate from index 0 to target using precomputed closes array.
// ---------------------------------------------------------------------------
float ema(float closes[110], int period, int end_idx) {
    float alpha = 2.0 / (float(period) + 1.0);
    float e = closes[0];
    for (int i = 1; i <= end_idx; i++) {
        e = alpha * closes[i] + (1.0 - alpha) * e;
    }
    return e;
}

// Build full MACD and signal arrays over TOTAL candles.
void buildMACD(float closes[110],
               out float macd[110],
               out float signal[110]) {
    float alpha12 = 2.0 / 13.0;
    float alpha26 = 2.0 / 27.0;
    float alpha9  = 2.0 / 10.0;

    float e12 = closes[0];
    float e26 = closes[0];
    macd[0]   = 0.0;
    signal[0] = 0.0;

    for (int i = 1; i < TOTAL; i++) {
        e12      = alpha12 * closes[i] + (1.0 - alpha12) * e12;
        e26      = alpha26 * closes[i] + (1.0 - alpha26) * e26;
        macd[i]  = e12 - e26;
        signal[i] = alpha9 * macd[i] + (1.0 - alpha9) * signal[i - 1];
    }
}

// ---------------------------------------------------------------------------
// Smooth line drawing — returns intensity for a horizontal/any-angle line.
// Uses fwidth-aware AA in screen-pixel space.
// ---------------------------------------------------------------------------
float lineSDF(float val, float ref_val, float px_per_unit) {
    float dist_px = abs(val - ref_val) * px_per_unit;
    return smoothstep(1.8, 0.3, dist_px);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    float t  = u_time * u_speed_scale;

    // Scroll: one new candle every 1.5 seconds
    float scroll_t   = t / 1.5;
    float scroll_int = floor(scroll_t);       // integer candle offset
    float scroll_frac = fract(scroll_t);      // sub-candle smooth scroll fraction

    // base_col is the leftmost candle index of our warm-up window
    float base_col = scroll_int - float(WARM);

    // Candle geometry
    float chart_h   = 0.80;   // top 80% for candle chart
    float macd_h    = 0.18;   // bottom 18% for MACD
    float gap_h     = 0.02;   // separator gap

    float candle_w  = 1.0 / float(VISIBLE);  // width per candle in UV space
    float body_frac = 0.65;
    float wick_frac = 0.12;

    // Which visible candle column does this pixel belong to?
    // Offset by scroll_frac for smooth scrolling
    float uv_x_scrolled = uv.x + scroll_frac * candle_w;
    float col_f  = uv_x_scrolled / candle_w;
    int   col_vis = int(floor(col_f));         // 0..VISIBLE-1 for visible; can be VISIBLE during scroll
    float col_phase = fract(col_f);            // horizontal position within this candle column

    int col_arr = col_vis + WARM;              // index into our arrays

    // Guard: skip if out of array bounds
    if (col_arr < 0 || col_arr >= TOTAL) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // Build data arrays (loop is over TOTAL=110 iters, all uniform per frame)
    float closes[110];
    float opens[110];
    float highs[110];
    float lows[110];
    buildOHLC(base_col, closes, opens, highs, lows);

    float macd_arr[110];
    float sig_arr[110];
    buildMACD(closes, macd_arr, sig_arr);

    // -----------------------------------------------------------------------
    // Find visible price range for Y mapping
    // -----------------------------------------------------------------------
    float p_min =  1e9;
    float p_max = -1e9;
    for (int k = WARM; k < TOTAL; k++) {
        p_min = min(p_min, lows[k]);
        p_max = max(p_max, highs[k]);
    }
    float p_range = p_max - p_min;
    // 10% margin top+bottom
    p_min -= p_range * 0.10;
    p_max += p_range * 0.10;
    p_range = p_max - p_min;

    // MACD range
    float m_min =  1e9;
    float m_max = -1e9;
    for (int k = WARM; k < TOTAL; k++) {
        m_min = min(m_min, min(macd_arr[k], sig_arr[k]));
        m_max = max(m_max, max(macd_arr[k], sig_arr[k]));
    }
    float m_range = m_max - m_min;
    if (m_range < 0.001) m_range = 0.001;
    m_min -= m_range * 0.15;
    m_max += m_range * 0.15;
    m_range = m_max - m_min;

    // -----------------------------------------------------------------------
    // UV → price / MACD space mapping helpers
    // -----------------------------------------------------------------------
    // Chart region: uv.y in [gap_h + macd_h, 1.0]
    float chart_bottom = gap_h + macd_h;
    float chart_uv_y   = (uv.y - chart_bottom) / chart_h;   // 0=bottom of chart,1=top

    // MACD region: uv.y in [0, macd_h]
    float macd_uv_y    = uv.y / macd_h;

    // Map chart_uv_y → price
    float price_at_y   = p_min + chart_uv_y * p_range;

    // Map macd_uv_y → MACD value
    float macd_at_y    = m_min + macd_uv_y * m_range;

    // Map price → chart_uv_y (for current candle)
    float open_y  = (opens[col_arr]  - p_min) / p_range;
    float close_y = (closes[col_arr] - p_min) / p_range;
    float high_y  = (highs[col_arr]  - p_min) / p_range;
    float low_y   = (lows[col_arr]   - p_min) / p_range;
    bool  bullish = closes[col_arr] >= opens[col_arr];

    // Horizontal extents
    float body_half = body_frac * 0.5;
    float wick_half = wick_frac * 0.5;
    bool  in_body   = col_phase >= (0.5 - body_half) && col_phase <= (0.5 + body_half);
    bool  in_wick   = col_phase >= (0.5 - wick_half) && col_phase <= (0.5 + wick_half);

    // -----------------------------------------------------------------------
    // Pixel color accumulation
    // -----------------------------------------------------------------------
    vec3 col = vec3(0.0);
    float alpha = 1.0;

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
        // min body height of 2px so flat candles are visible
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
            col += palette(0.50) * 0.75;
        }
    }

    // ---- MACD line ----
    if (in_macd) {
        float px_per_unit = macd_h * u_resolution.y / m_range;

        // MACD line at macd_arr[col_arr]
        float macd_val = (macd_arr[col_arr] - m_min) / m_range;
        float d_macd   = abs(macd_uv_y - macd_val) * macd_h * u_resolution.y;
        float macd_glow = smoothstep(2.5, 0.3, d_macd);
        col += palette(0.50) * macd_glow;

        // Signal line at sig_arr[col_arr]
        float sig_val = (sig_arr[col_arr] - m_min) / m_range;
        float d_sig   = abs(macd_uv_y - sig_val) * macd_h * u_resolution.y;
        float sig_glow = smoothstep(2.5, 0.3, d_sig);
        col += palette(0.65) * sig_glow * 0.85;

        // Faint zero-line
        float zero_val = (0.0 - m_min) / m_range;
        float d_zero   = abs(macd_uv_y - zero_val) * macd_h * u_resolution.y;
        float zero_glow = smoothstep(1.2, 0.1, d_zero);
        col += palette(0.08) * zero_glow * 0.15;
    }

    fragColor = vec4(clamp(col, 0.0, 1.0), u_alpha);
}
