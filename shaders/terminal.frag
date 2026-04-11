#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — terminal.frag
//
// Scrolling terminal / build-log output effect.  Rows of monospaced "text"
// (block-glyph cells, no font atlas) scroll upward at a steady pace like a
// busy compile log or server stream.
//
// Line types (per-row, deterministic):
//   60% normal output  — palette(0.4) at 70% brightness
//   15% comment        — palette(0.2) at 40% brightness  (dimmer, sparser)
//   10% keyword        — palette(0.7) at 100% brightness (stands out)
//   10% blank          — empty row
//    5% separator      — ─── or ═══ bar, palette(0.5) at 50%
//
// Effects: CRT scanline dimming (every-other row −5%), phosphor glow
// (per-cell exp() bloom), blinking cursor at end of bottom row, brief
// 1.2× brightness flash when a new row enters the bottom.
//
// Grid: cell_size = vec2(8, 16) / u_resolution.y → ~240 cols × 68 rows
// at 1080p.  SCROLL_SPEED = 0.08 (≈ 5.4 rows/sec, steady readable pace).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

const float SCROLL_SPEED = 0.08;   // rows per second (in cell-height units)

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

void main() {
    vec2  fc = gl_FragCoord.xy;
    float t  = u_time * u_speed_scale;

    // Cell dimensions normalised to screen height so the grid is
    // resolution-independent.
    float cell_h = 16.0 / u_resolution.y;
    float cell_w =  8.0 / u_resolution.y;

    // Top-down y coordinate (0 = top, 1 = bottom).  Adding time to y makes
    // content scroll upward: a row with fixed ID moves toward smaller y_td
    // (toward the top) as time progresses.
    float y_td   = (u_resolution.y - fc.y) / u_resolution.y;
    float x_norm =  fc.x / u_resolution.y;

    float scroll_y = y_td + t * SCROLL_SPEED;
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

    // Line length 10–75, distribution biased toward 30–60.
    float skewed      = mix(r1, 0.5 + (r1 - 0.5) * 0.6, 0.5);
    float line_length = 10.0 + skewed * 65.0;

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
    // Glyph brightness for this cell
    // -----------------------------------------------------------------------

    float brightness = 0.0;
    float char_col   = col_id - indent;

    if (line_type != 3) {
        if (line_type == 4) {
            // Separator bar — ─── (single) or ═══ (double), random per row.
            if (char_col >= 0.0 && char_col < line_length) {
                float sep_style = hash11(row_id * 5.137 + 2.3);
                if (sep_style < 0.5) {
                    // ─── single horizontal bar
                    brightness = smoothstep(0.06, 0.0, abs(ly - 0.50));
                } else {
                    // ═══ double horizontal bar
                    float b1 = smoothstep(0.06, 0.0, abs(ly - 0.33));
                    float b2 = smoothstep(0.06, 0.0, abs(ly - 0.67));
                    brightness = max(b1, b2);
                }
            }
        } else if (char_col >= 0.0 && char_col < line_length) {
            // Block glyph: filled rectangle (70% × 80%) or empty space.
            float ch = hash21(vec2(
                char_col * 0.317 + row_id  * 0.071,
                row_id   * 0.431 + char_col * 0.137
            ));

            // 70% filled for normal/keyword, 50% for comment (more spaces).
            float fill_prob = (line_type == 1) ? 0.50 : 0.70;

            if (ch < fill_prob) {
                // Soft-edged rectangle centered in cell: half-extents 0.35×0.40.
                float dx = abs(lx - 0.5);
                float dy = abs(ly - 0.5);
                float bx = smoothstep(0.37, 0.32, dx);
                float by = smoothstep(0.42, 0.37, dy);
                // Per-character brightness variation [0.6, 1.0].
                float var = 0.6 + 0.4 * hash21(vec2(
                    char_col * 0.711 + 13.1,
                    row_id   * 0.531 +  7.9
                ));
                brightness = bx * by * var;
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

    float bottom_phase  = fract((1.0 + t * SCROLL_SPEED) / cell_h);
    float bottom_row_id = floor((1.0 + t * SCROLL_SPEED) / cell_h);

    // Re-derive indent + length for the cursor row so the cursor tracks the
    // actual end of that line.
    float cr1  = hash11(bottom_row_id * 1.7319 + 43.21);
    float cr2  = hash11(bottom_row_id * 2.9871 + 12.87);
    float cs   = mix(cr1, 0.5 + (cr1 - 0.5) * 0.6, 0.5);
    float c_len = 10.0 + cs * 65.0;
    float c_ind;
    if      (cr2 < 0.50) c_ind = 0.0;
    else if (cr2 < 0.80) c_ind = 2.0;
    else                 c_ind = 4.0;
    float cursor_col = c_ind + floor(c_len);   // integer column

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
    //
    // One row's on-screen lifetime = cell_h / SCROLL_SPEED seconds.
    // The flash lasts for 0.1 s → fraction = 0.1 * SCROLL_SPEED / cell_h.
    // -----------------------------------------------------------------------

    if (on_bottom) {
        float flash_frac = min(1.0, bottom_phase / (0.1 * SCROLL_SPEED / cell_h));
        color *= 1.0 + 0.2 * (1.0 - flash_frac);
    }

    // -----------------------------------------------------------------------
    // CRT scanline overlay — every other screen pixel row dimmed 5%
    // -----------------------------------------------------------------------

    color *= 1.0 - 0.05 * mod(fc.y, 2.0);

    fragColor = vec4(color, 1.0);
}
