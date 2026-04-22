#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — gridwave.frag
//
// Perspective-projected ground plane grid with scrolling forward motion and
// subtle wave warping. Classic Tron/Outrun neon-vector aesthetic.
//
// Technique: pure 2D screen-space math. Pixels below the horizon line are
// inverse-projected into world-space depth via 1/y, then sampled against a
// scrolling grid. No raymarching, no SDFs — one divide + one sin per pixel.
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_speed_scale;
uniform float u_zoom_scale;

out vec4 fragColor;

void main() {
    vec2 uv = (gl_FragCoord.xy / u_resolution.xy) - 0.5;
    uv.x *= u_resolution.x / u_resolution.y;

    // Sky (above horizon) is pure black — uniform branch, free on RDNA.
    float horizon = 0.05;
    if (uv.y > -horizon) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // Perspective foreshortening: 1/y maps screen rows to world-space depth.
    // Pixels near the horizon have large depth; pixels at bottom have small depth.
    float depth = 1.0 / (-uv.y - horizon);

    // World-space grid coordinates: X converges with depth, Z scrolls forward.
    vec2 grid_uv = vec2(
        uv.x * depth,
        depth + u_time * u_speed_scale * 2.0
    );

    // Subtle low-frequency wave warping along X — organic, non-rigid feel.
    grid_uv.x += sin(grid_uv.y * 0.3 + u_time * u_speed_scale * 0.5) * 0.15;

    // Distance to nearest grid line in each axis.
    vec2 grid_dist = abs(fract(grid_uv) - 0.5);
    float line_dist = min(grid_dist.x, grid_dist.y);

    // Line width grows slightly with depth to prevent horizon aliasing.
    float line_width = 0.03 + depth * 0.002;
    float line = smoothstep(line_width, line_width * 0.3, line_dist);

    // Depth fade — lines fade to black approaching the horizon.
    float fade = 1.0 - smoothstep(5.0, 25.0, depth);
    line *= fade;

    // Depth-driven palette: near=vivid, far=black. Gamma 0.6 compresses
    // near range into vivid colors and stretches far into darker tones.
    float t_palette = pow(clamp(1.0 - depth / 25.0, 0.0, 1.0), 0.6);
    vec3 line_col = palette(t_palette);

    fragColor = vec4(line_col * line, 1.0);
}
