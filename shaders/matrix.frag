#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — matrix.frag
//
// Classic Matrix digital rain.  Vertical columns of procedural 5×5 bitmask
// glyphs fall at varying speeds across a dark background.  Three streams per
// column, additive blending, white-hot lead character, quadratic trail fade.
// Uses the active palette for text color — any palette works (forest = classic
// green, electric = rainbow, etc.).  Pure fragment shader, no textures.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

// Cell dimensions — ~48 columns on a 1920 px-wide screen
const float CELL_PX     = 40.0;
const float CELL_ASPECT = 1.4;    // height / width (monospace terminal feel)
const int   STREAMS     = 3;      // independent streams per column
const float CHAR_SPEED  = 4.0;    // glyph-change frequency (Hz)
const int   NUM_CHARS   = 16;

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
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// ---------------------------------------------------------------------------
// 5×5 glyph bitmasks  (25 bits packed in a uint)
// Bit index = row * 5 + col  —  row 0 = top, col 0 = left.
// ---------------------------------------------------------------------------

uint getChar(int idx) {
    idx = idx & 15;
    if (idx ==  0) return 0x1F8C63Fu;  // ロ  box
    if (idx ==  1) return 0x42109Fu;   // T
    if (idx ==  2) return 0x427C84u;   // +  cross
    if (idx ==  3) return 0x118FE31u;  // H
    if (idx ==  4) return 0x10843Fu;   // Γ  reverse-L
    if (idx ==  5) return 0x1F0FC3Fu;  // E
    if (idx ==  6) return 0x1F07C1Fu;  // ≡  three bars
    if (idx ==  7) return 0x1F21084u;  // ⊥  up-T
    if (idx ==  8) return 0x1151151u;  // X
    if (idx ==  9) return 0xE8C62Eu;   // O
    if (idx == 10) return 0x1F1111Fu;  // Z
    if (idx == 11) return 0xA5295Fu;   // π  gate
    if (idx == 12) return 0x421151u;   // Y
    if (idx == 13) return 0x454544u;   // ◇  diamond
    if (idx == 14) return 0xA5294Au;   // ‖  double bar
    return                0x475484u;   // ↓  arrow
}

// 1.0 if pixel (px, py) in the glyph grid is lit, else 0.0.
float charPixel(int ci, int px, int py) {
    return float((getChar(ci) >> uint(py * 5 + px)) & 1u);
}

// ---------------------------------------------------------------------------

void main() {
    vec2  fc = gl_FragCoord.xy;
    float t  = u_time * u_speed_scale;

    float cellW = CELL_PX;
    float cellH = CELL_PX * CELL_ASPECT;

    // Row 0 = top of screen, increasing downward (matches rain direction).
    float row_ft = floor((u_resolution.y - fc.y) / cellH);
    float col_f  = floor(fc.x / cellW);
    int   totalRows = int(ceil(u_resolution.y / cellH)) + 1;

    // UV inside current cell:  (0,0) = top-left, (1,1) = bottom-right.
    vec2 cellUV = vec2(fract(fc.x / cellW),
                       fract((u_resolution.y - fc.y) / cellH));

    // Map to 5×5 character grid with a small margin around each glyph.
    float margin = 0.12;
    vec2  charUV = (cellUV - margin) / (1.0 - 2.0 * margin);
    int   px     = int(floor(charUV.x * 5.0));
    int   py     = int(floor(charUV.y * 5.0));
    bool  inGlyph = charUV.x > 0.0 && charUV.x < 1.0 &&
                    charUV.y > 0.0 && charUV.y < 1.0 &&
                    px >= 0 && px <= 4 && py >= 0 && py <= 4;

    vec3 color = vec3(0.0);

    // Per-column speed multiplier: slower columns (0.3×) to fastest (1.0×).
    // All streams within a column share the same speed so they move in lockstep.
    float col_speed = mix(0.3, 1.0, hash11(col_f * 7.13));

    // --- Three additive streams per column ---

    for (int s = 0; s < STREAMS; s++) {
        float seed = col_f * 13.37 + float(s) * 47.53;

        // Per-stream parameters (deterministic from seed)
        float speed     = (2.5 + hash11(seed + 1.1) * 3.5) * col_speed;   // 2.5–6 rows/s scaled by column
        float streamLen = 8.0 + hash11(seed + 2.2) * 14.0;  // 8–22 chars
        float totalLen  = float(totalRows) + streamLen;
        float offset    = hash11(seed + 3.3) * totalLen;

        // Head position (row-from-top, wrapping)
        float headPos = mod(t * speed + offset, totalLen);

        // How far this cell is behind the head (0 = lead char).
        float d = headPos - row_ft;
        if (d < 0.0) d += totalLen;

        if (d < streamLen) {
            // Brightness: quadratic fade from head to tail
            float fade = 1.0 - d / streamLen;
            fade *= fade;

            bool isHead = d < 1.0;

            // Pick a glyph — change rate scales with column speed.
            float bucket = floor(t * CHAR_SPEED * col_speed
                                 + hash21(vec2(col_f * 3.7, row_ft * 11.3)) * 100.0);
            int ci = int(mod(hash21(vec2(col_f + 0.5,
                                         row_ft + bucket * 0.17)) * 173.0,
                             float(NUM_CHARS)));

            float pixel = inGlyph ? charPixel(ci, px, py) : 0.0;

            // Palette hue — slow drift across columns & time
            float pt   = fract(col_f * 0.073 + t * 0.015 + float(s) * 0.2);
            vec3  base = palette(pt);

            // Lead character: white-hot mix
            vec3 lit = isHead ? mix(base, vec3(1.0), 0.8) : base;
            color += lit * pixel * fade;

            // Subtle per-cell CRT glow
            float gd   = length(cellUV - 0.5) * 2.0;
            float glow = exp(-gd * gd * 4.0) * fade * 0.06;
            if (isHead) glow *= 2.5;
            color += base * glow;
        }
    }

    fragColor = vec4(color, 1.0);
}
