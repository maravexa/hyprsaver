#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — terminal.frag
//
// Scrolling terminal / build-log output effect.  Rows of monospaced "text"
// scroll upward with bursty cadence like a busy compile log.
//
// Features:
//   - Bitmap font: 30 characters (katakana-style, digits, symbols) encoded
//     as 5×6 bit patterns in uint constants.
//   - Larger cells: 12×24 px (50% bigger than original 8×16).
//   - Wider lines: 25% short, 60% medium, 15% long (up to 90% screen width).
//   - Choppy scroll: bursty pause/scroll mimicking real build output cadence.
//   - CRT scanlines, phosphor glow, blinking cursor, new-line flash.
//
// Line types (per-row, deterministic):
//   60% normal output  — palette(0.4) at 70% brightness
//   15% comment        — palette(0.2) at 40% brightness
//   10% keyword        — palette(0.7) at 100% brightness
//   10% blank          — empty row
//    5% separator      — ─── or ═══ bar, palette(0.5) at 50%
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

const float BASE_SCROLL_SPEED = 0.08;

// ---------------------------------------------------------------------------
// Bitmap font — 30 characters, each a 5×6 grid stored as a uint (30 bits).
// Bit layout: row 0 (top) is bits 0–4, row 1 is bits 5–9, etc.
// Bit 0 of each row is the leftmost column.  Max bit index = 29 (fits uint).
// ---------------------------------------------------------------------------

const int GLYPH_COUNT = 30;

// Characters: katakana-style glyphs, digits 0-9, symbols < > / = + { } ;
//
// Each glyph is encoded row-by-row, 5 bits per row, 6 rows = 30 bits.
// Row 0 (top) = bits 0-4, row 5 (bottom) = bits 25-29.
// Bit 0 in each row = leftmost pixel.

uint glyphs[30] = uint[30](
    // -- Katakana-style glyphs (indices 0-11) --
    uint(0x04423a1fu),  //  0: ア
    uint(0x1084a988u),  //  1: イ
    uint(0x1d18d41fu),  //  2: ウ
    uint(0x3e42109fu),  //  3: エ
    uint(0x089533e4u),  //  4: オ
    uint(0x23297d4au),  //  5: カ
    uint(0x084fabeau),  //  6: キ
    uint(0x0222212fu),  //  7: ク
    uint(0x08427ca5u),  //  8: ケ
    uint(0x3f08421fu),  //  9: コ
    uint(0x08457d4au),  // 10: サ
    uint(0x1d104241u),  // 11: シ
    // -- Digits 0-9 (indices 12-21) --
    uint(0x1d3ae62eu),  // 12: 0
    uint(0x3e4210c4u),  // 13: 1
    uint(0x3e26422eu),  // 14: 2
    uint(0x1d18321fu),  // 15: 3
    uint(0x108fa988u),  // 16: 4
    uint(0x1d183c3fu),  // 17: 5
    uint(0x1d18bc2eu),  // 18: 6
    uint(0x0842221fu),  // 19: 7
    uint(0x1d18ba2eu),  // 20: 8
    uint(0x1d0f462eu),  // 21: 9
    // -- Symbols (indices 22-29) --
    uint(0x00820888u),  // 22: <
    uint(0x00222082u),  // 23: >
    uint(0x00111110u),  // 24: /
    uint(0x000f83e0u),  // 25: =
    uint(0x00027c80u),  // 26: +
    uint(0x18210c4cu),  // 27: {
    uint(0x0c846106u),  // 28: }
    uint(0x00220080u)   // 29: ;
);

// Sample a glyph: returns 1.0 if the pixel at (col, row) is filled.
// col in [0..4], row in [0..5].
float sampleGlyph(int glyph_id, int col, int row) {
    if (glyph_id < 0 || glyph_id >= GLYPH_COUNT) return 0.0;
    if (col < 0 || col > 4 || row < 0 || row > 5) return 0.0;
    int bit = row * 5 + col;
    return ((glyphs[glyph_id] >> uint(bit)) & 1u) == 1u ? 1.0 : 0.0;
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

float hash21(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}

// ---------------------------------------------------------------------------
// Choppy scroll — bursty pause/scroll pattern
// ---------------------------------------------------------------------------

float choppyScroll(float t) {
    float chunk_rate = 3.0;
    float chunk_id = floor(t * chunk_rate);
    float chunk_frac = fract(t * chunk_rate);

    // Accumulated scroll: sum contributions from past chunks.
    // We integrate over chunks. Each chunk either scrolls at normal speed
    // or is paused. We compute the total scroll offset.
    float scroll = 0.0;
    float total_chunks = chunk_id;

    // For efficiency, approximate: count how many chunks were "scroll" vs "pause"
    // by iterating recent chunks. We only need the integral for smooth motion.
    // Instead, compute a running offset: each chunk contributes 1/chunk_rate seconds
    // of either scrolling or pausing.
    float chunk_duration = 1.0 / chunk_rate;

    // We can't iterate all past chunks, so we use a trick:
    // Compute a deterministic fraction of "active" chunks up to chunk_id.
    // Use the hash to decide per-chunk, but accumulate analytically.

    // Approximate: 70% of chunks scroll → effective speed = 0.70 * BASE_SCROLL_SPEED
    // But we add local variation for the current chunk transition.
    float base_offset = chunk_id * chunk_duration * BASE_SCROLL_SPEED * 0.70;

    // Current chunk: is it scrolling or paused?
    float h = hash11(chunk_id * 7.31 + 3.14);
    float is_scrolling = step(0.30, h);  // 70% chance scrolling

    // Next chunk for smooth transition
    float h_next = hash11((chunk_id + 1.0) * 7.31 + 3.14);
    float next_scrolling = step(0.30, h_next);

    // Smoothstep transition over ~0.05s at chunk boundaries
    float transition_width = 0.15;  // fraction of chunk
    float smooth_state;
    if (chunk_frac < transition_width) {
        // Transition from previous chunk
        float h_prev = hash11((chunk_id - 1.0) * 7.31 + 3.14);
        float prev_scrolling = step(0.30, h_prev);
        smooth_state = mix(prev_scrolling, is_scrolling, smoothstep(0.0, transition_width, chunk_frac));
    } else if (chunk_frac > (1.0 - transition_width)) {
        // Transition to next chunk
        smooth_state = mix(is_scrolling, next_scrolling, smoothstep(1.0 - transition_width, 1.0, chunk_frac));
    } else {
        smooth_state = is_scrolling;
    }

    float current_contribution = chunk_frac * chunk_duration * BASE_SCROLL_SPEED * smooth_state;
    scroll = base_offset + current_contribution;

    return scroll;
}

// ---------------------------------------------------------------------------

void main() {
    vec2  fc = gl_FragCoord.xy;
    float t  = u_time * u_speed_scale;

    // Cell dimensions — 50% larger than original (12×24 vs 8×16),
    // normalised to screen height for resolution independence.
    float cell_h = 24.0 / u_resolution.y;
    float cell_w = 12.0 / u_resolution.y;

    // Compute max columns available on screen
    float screen_w_cells = (u_resolution.x / u_resolution.y) / cell_w;

    // Top-down y coordinate (0 = top, 1 = bottom).
    float y_td   = (u_resolution.y - fc.y) / u_resolution.y;
    float x_norm =  fc.x / u_resolution.y;

    // Choppy scroll offset
    float scroll_offset = choppyScroll(t);
    float scroll_y = y_td + scroll_offset;

    float row_id   = floor(scroll_y / cell_h);
    float col_id   = floor(x_norm   / cell_w);

    // Sub-cell local coords [0, 1]: ly 0 = cell top, lx 0 = cell left.
    float ly = fract(scroll_y / cell_h);
    float lx = fract(x_norm   / cell_w);

    // -----------------------------------------------------------------------
    // Per-row properties — deterministic from row_id
    // -----------------------------------------------------------------------

    float r1 = hash11(row_id * 1.7319 + 43.21);
    float r2 = hash11(row_id * 2.9871 + 12.87);
    float r3 = hash11(row_id * 3.5123 + 98.76);

    // Line length — weighted distribution:
    //   25% short  (15–30 cols)
    //   60% medium (30–60 cols)
    //   15% long   (60–90% of screen width)
    float line_length;
    if (r1 < 0.25) {
        // Short lines: 15-30 columns
        float t_short = r1 / 0.25;
        line_length = 15.0 + t_short * 15.0;
    } else if (r1 < 0.85) {
        // Medium lines: 30-60 columns
        float t_med = (r1 - 0.25) / 0.60;
        line_length = 30.0 + t_med * 30.0;
    } else {
        // Long lines: 60-90% of screen width
        float t_long = (r1 - 0.85) / 0.15;
        float min_long = screen_w_cells * 0.60;
        float max_long = screen_w_cells * 0.90;
        line_length = min_long + t_long * (max_long - min_long);
    }

    // Indent: 0 (50%), 2 (30%), 4 (20%) columns.
    float indent;
    if      (r2 < 0.50) indent = 0.0;
    else if (r2 < 0.80) indent = 2.0;
    else                indent = 4.0;

    // Line type thresholds (spec: 60/15/10/10/5).
    int line_type;   // 0=normal  1=comment  2=keyword  3=blank  4=separator
    if      (r3 < 0.10) line_type = 3;
    else if (r3 < 0.15) line_type = 4;
    else if (r3 < 0.30) line_type = 1;
    else if (r3 < 0.40) line_type = 2;
    else                line_type = 0;

    // -----------------------------------------------------------------------
    // Glyph rendering for this cell
    // -----------------------------------------------------------------------

    float brightness = 0.0;
    float char_col   = col_id - indent;

    if (line_type != 3) {
        if (line_type == 4) {
            // Separator bar — ─── (single) or ═══ (double), random per row.
            if (char_col >= 0.0 && char_col < line_length) {
                float sep_style = hash11(row_id * 5.137 + 2.3);
                if (sep_style < 0.5) {
                    brightness = smoothstep(0.06, 0.0, abs(ly - 0.50));
                } else {
                    float b1 = smoothstep(0.06, 0.0, abs(ly - 0.33));
                    float b2 = smoothstep(0.06, 0.0, abs(ly - 0.67));
                    brightness = max(b1, b2);
                }
            }
        } else if (char_col >= 0.0 && char_col < line_length) {
            // Select a glyph for this cell via hash
            float ch = hash21(vec2(
                char_col * 0.317 + row_id  * 0.071,
                row_id   * 0.431 + char_col * 0.137
            ));

            // Fill probability: 70% for normal/keyword, 50% for comment
            float fill_prob = (line_type == 1) ? 0.50 : 0.70;

            if (ch < fill_prob) {
                // Pick which glyph to render
                int glyph_id = int(floor(hash21(vec2(
                    row_id * 0.731 + char_col * 0.419,
                    char_col * 0.293 + row_id * 0.617
                )) * float(GLYPH_COUNT)));
                glyph_id = clamp(glyph_id, 0, GLYPH_COUNT - 1);

                // Map local cell coords to glyph grid position.
                // Padding: glyph occupies the inner portion of the cell
                // with ~14% padding on each side.
                float pad_x = 1.0 / 7.0;  // ~14% padding each side
                float pad_y = 1.0 / 8.0;  // ~12% padding each side

                float gx = (lx - pad_x) / (1.0 - 2.0 * pad_x);  // [0,1] within glyph area
                float gy = (ly - pad_y) / (1.0 - 2.0 * pad_y);

                if (gx >= 0.0 && gx <= 1.0 && gy >= 0.0 && gy <= 1.0) {
                    int gcol = int(floor(gx * 5.0));
                    int grow = int(floor(gy * 6.0));
                    gcol = clamp(gcol, 0, 4);
                    grow = clamp(grow, 0, 5);

                    float pixel = sampleGlyph(glyph_id, gcol, grow);

                    // Soften edges slightly with sub-pixel smoothing
                    float sx = fract(gx * 5.0);
                    float sy = fract(gy * 6.0);
                    float edge_soft = smoothstep(0.0, 0.15, sx) * smoothstep(1.0, 0.85, sx)
                                    * smoothstep(0.0, 0.15, sy) * smoothstep(1.0, 0.85, sy);

                    // Per-character brightness variation [0.6, 1.0].
                    float var = 0.6 + 0.4 * hash21(vec2(
                        char_col * 0.711 + 13.1,
                        row_id   * 0.531 +  7.9
                    ));

                    brightness = pixel * edge_soft * var;
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Color by line type
    // -----------------------------------------------------------------------

    vec3  text_color;
    float bright_scale;

    if      (line_type == 0) { text_color = palette(0.4); bright_scale = 0.70; }
    else if (line_type == 1) { text_color = palette(0.2); bright_scale = 0.40; }
    else if (line_type == 2) { text_color = palette(0.7); bright_scale = 1.00; }
    else if (line_type == 4) { text_color = palette(0.5); bright_scale = 0.50; }
    else                     { text_color = vec3(0.0);    bright_scale = 0.00; }

    vec3 color = text_color * brightness * bright_scale;

    // -----------------------------------------------------------------------
    // Phosphor glow — exp() approximation of 1-px Gaussian spread
    // -----------------------------------------------------------------------

    if (brightness > 0.01) {
        float d2   = (lx - 0.5) * (lx - 0.5) + (ly - 0.5) * (ly - 0.5);
        float glow = exp(-d2 * 14.0) * 0.20 * bright_scale;
        color += text_color * glow;
    }

    // -----------------------------------------------------------------------
    // Cursor — blinking block at the end of the bottom visible row
    // -----------------------------------------------------------------------

    float bottom_scroll = 1.0 + scroll_offset;
    float bottom_row_id = floor(bottom_scroll / cell_h);

    // Re-derive line_length for the cursor row.
    float cr1  = hash11(bottom_row_id * 1.7319 + 43.21);
    float cr2  = hash11(bottom_row_id * 2.9871 + 12.87);
    float c_len;
    if (cr1 < 0.25) {
        c_len = 15.0 + (cr1 / 0.25) * 15.0;
    } else if (cr1 < 0.85) {
        c_len = 30.0 + ((cr1 - 0.25) / 0.60) * 30.0;
    } else {
        float min_l = screen_w_cells * 0.60;
        float max_l = screen_w_cells * 0.90;
        c_len = min_l + ((cr1 - 0.85) / 0.15) * (max_l - min_l);
    }
    float c_ind;
    if      (cr2 < 0.50) c_ind = 0.0;
    else if (cr2 < 0.80) c_ind = 2.0;
    else                 c_ind = 4.0;
    float cursor_col = c_ind + floor(c_len);

    float blink     = step(0.5, fract(t * 1.5));
    bool on_bottom  = abs(row_id - bottom_row_id) < 0.5;
    bool on_cursor  = abs(col_id - cursor_col)    < 0.5;

    if (on_bottom && on_cursor) {
        float cx = smoothstep(0.48, 0.44, abs(lx - 0.5));
        float cy = smoothstep(0.48, 0.44, abs(ly - 0.5));
        color = mix(color, palette(0.9) * blink, cx * cy * 0.9);
    }

    // -----------------------------------------------------------------------
    // New-line flash — bottom row is 1.2× bright for ~0.1 s after it enters
    // -----------------------------------------------------------------------

    if (on_bottom) {
        float bottom_phase = fract(bottom_scroll / cell_h);
        float flash_frac = min(1.0, bottom_phase / (0.1 * BASE_SCROLL_SPEED / cell_h));
        color *= 1.0 + 0.2 * (1.0 - flash_frac);
    }

    // -----------------------------------------------------------------------
    // CRT scanline overlay — every other screen pixel row dimmed 5%
    // -----------------------------------------------------------------------

    color *= 1.0 - 0.05 * mod(fc.y, 2.0);

    fragColor = vec4(color, 1.0);
}
