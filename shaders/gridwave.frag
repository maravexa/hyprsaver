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

    float horizon = 0.05;

    // Vertical wave: displace screen-Y before perspective projection.
    // This actually moves the ground plane up and down (unlike perturbing the
    // grid sampling coordinate, which only shifts which lines are drawn).
    // Amplitude 0.08 is in screen-space units (screen height = 1.0).
    float wave = sin(-uv.y * 3.0 + u_time * u_speed_scale * 0.4) * 0.08;
    float warped_y = uv.y + wave;

    // Sky check uses warped_y — horizon line now wavy, selling the 3D effect
    if (warped_y > -horizon) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // Perspective foreshortening on the warped Y
    float depth = 1.0 / (-warped_y - horizon);

    // World-space grid coordinates: X converges with depth, Z scrolls forward.
    vec2 grid_uv = vec2(
        uv.x * depth,
        depth + u_time * u_speed_scale * 2.0
    );

    // Lateral sway warping; vertical wave handled by screen-Y displacement above
    grid_uv.x += sin(grid_uv.y * 0.3 + u_time * u_speed_scale * 0.5) * 0.55;

    // Distance to nearest grid line in each axis.
    vec2 grid_dist = abs(fract(grid_uv) - 0.5);
    float line_dist = min(grid_dist.x, grid_dist.y);

    // Line width grows slightly with depth to prevent horizon aliasing.
    float line_width = 0.03 + depth * 0.002;
    float line = smoothstep(line_width, line_width * 0.3, line_dist);

    // Kill lines before they reach aliasing range.
    // smoothstep(3.0, 12.0, depth) fades faster and earlier, hiding jitter zone
    float fade = 1.0 - smoothstep(3.0, 12.0, depth);

    // Procedural AA: when adjacent pixels sample wildly different grid cells,
    // fwidth(grid_uv) is large. Clamp line brightness when this exceeds ~0.5 units.
    vec2 grid_deriv = fwidth(grid_uv);
    float aa_factor = 1.0 - smoothstep(0.3, 1.0, max(grid_deriv.x, grid_deriv.y));

    line *= fade * aa_factor;

    // Depth-driven palette with time-based cycling.
    // Gamma 0.6 compresses near range into vivid palette positions.
    // Time scroll slides the entire palette range over time — every grid cell
    // cycles through all palette positions every ~20 seconds.
    float t_palette = pow(clamp(1.0 - depth / 25.0, 0.0, 1.0), 0.6);
    t_palette = abs(fract(t_palette + u_time * u_speed_scale * 0.05) * 2.0 - 1.0);
    vec3 line_col = palette(t_palette);

    fragColor = vec4(line_col * line, 1.0);
}
