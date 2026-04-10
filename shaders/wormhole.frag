#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — wormhole.frag
//
// Fly-through a gently curving wormhole tunnel.  The centreline wanders in
// 3-D space driven by smooth sine-hash noise so the tube bends left/right and
// up/down as you travel.  Concentric ring segments on the walls are coloured
// with depth-dependent palette phase.  Faint point lights cast halos at
// regular depth intervals.  A pale "exit light" glows at the far end.
//
// Technique:
//   1. Barrel-distort screen UV for a fisheye/VR feel.
//   2. Estimate pixel depth z₀ = R·zoom / |uv|.
//   3. Displace the screen origin by the perspective-projected centreline
//      offset (world-space ±0.4 units divided by z₀).
//   4. Re-derive depth and polar coords in the shifted frame.
//   5. Compose ring texture + depth fog + point lights + exit glow.
//
// Uniforms injected by prepare_shader(): u_speed_scale, u_zoom_scale,
//   u_alpha, out vec4 fragColor, palette(float).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_alpha;

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;

// ---------------------------------------------------------------------------
// Smooth 1-D value noise — sine-hash, cubic interpolation.
// Returns [0, 1].  Use (noise(x) - 0.5) * 2.0 for a [-1, 1] range.
// ---------------------------------------------------------------------------
float hash1(float n) {
    return fract(sin(n) * 43758.5453123);
}

float noise(float x) {
    float i = floor(x);
    float f = fract(x);
    float u = f * f * (3.0 - 2.0 * f);    // cubic smoothstep — no random jitter
    return mix(hash1(i), hash1(i + 1.0), u);
}

void main() {
    // -----------------------------------------------------------------------
    // Aspect-correct UV centred at the screen midpoint.
    // -----------------------------------------------------------------------
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    // Barrel (fisheye) distortion — r² × 0.1 radial stretch at screen edges.
    float r2 = dot(uv, uv);
    uv *= 1.0 + r2 * 0.1;

    float t    = u_time * u_speed_scale;
    float zoom = u_zoom_scale;

    // -----------------------------------------------------------------------
    // Step 1: Initial depth estimate from the undisplaced UV.
    //   Projection: z₀ = R·zoom / |uv|   (R = 0.8, nominal tunnel radius)
    // -----------------------------------------------------------------------
    float dist0 = length(uv) + 0.001;          // screen-space dist from origin
    float z0    = 0.8 * zoom / dist0;           // perspective depth along Z axis
    float fly0  = z0 + t * 0.5;                // add forward-flight offset

    // -----------------------------------------------------------------------
    // Step 2: Curving centreline — smooth noise displacement at depth fly0.
    //   (noise − 0.5) × 0.8 → symmetric ±0.4 world-space units.
    //   Divide by z₀ to project into screen space (perspective-correct).
    // -----------------------------------------------------------------------
    float np = fly0 * 0.3 + t * 0.1;           // noise phase (matches spec formula)
    vec2 world_offset = vec2(
        (noise(np)         - 0.5) * 0.8,        // x: ±0.4 world units
        (noise(np + 100.0) - 0.5) * 0.8         // y: independent noise lane
    );
    vec2 uv_c = uv - world_offset / z0;         // shift UV to tunnel centre

    // -----------------------------------------------------------------------
    // Step 3: Polar coordinates in the tunnel-centred frame.
    // -----------------------------------------------------------------------
    float r   = length(uv_c) + 0.001;
    float ang = atan(uv_c.y, uv_c.x);

    float z       = 0.8 * zoom / r;            // refined depth from shifted UV
    float forward = z + t * 0.5;               // depth + flight

    // -----------------------------------------------------------------------
    // Pulsing tunnel radius: ±0.05 varying with depth and time.
    // Expressed as a modulation on the vignette edge (see compositing below).
    // -----------------------------------------------------------------------
    float pulse = 0.05 * sin(z * 2.3 + t * 1.6);

    // -----------------------------------------------------------------------
    // Wall texture: concentric rings × angular stripes × depth weave.
    // -----------------------------------------------------------------------
    float ring_f    = forward / TAU;
    float ring_idx  = floor(ring_f);            // integer ring group index
    float ring_frac = fract(ring_f);

    float s_t = fract(ang / TAU + 0.5 + t * 0.07);   // angular pos + slow twist

    float rings   = sin(ring_frac * TAU)                             * 0.5 + 0.5;
    float stripes = sin(s_t * TAU * 8.0)                             * 0.5 + 0.5;
    float weave   = sin((forward + s_t * 3.0) * (TAU * 0.5) + t * 0.4) * 0.5 + 0.5;
    float pattern = rings * 0.5 + stripes * 0.3 + weave * 0.2;

    // Depth-dependent colour: palette(ring_index / 8.0 + depth_phase).
    float depth_phase = t * 0.02;
    float col_t    = fract(ring_idx / 8.0 + depth_phase + pattern * 0.3);
    vec3  wall_col = palette(col_t);

    // -----------------------------------------------------------------------
    // Depth fog: far objects (large z, small r) fade toward palette(0.0).
    // -----------------------------------------------------------------------
    float fog_factor = smoothstep(0.0, 0.65, r);       // 0 near centre, 1 at edges
    wall_col = mix(palette(0.0), wall_col, fog_factor);

    // -----------------------------------------------------------------------
    // Point lights at regular depth intervals — soft glow on walls as you pass.
    // -----------------------------------------------------------------------
    const float LIGHT_PERIOD = 19.0;                    // ~3 tunnel-radius spacings
    float light_idx  = floor(forward / LIGHT_PERIOD);
    float light_frac = fract(forward / LIGHT_PERIOD);
    float light_glow = exp(-abs(light_frac - 0.5) * 12.0) * 0.5;
    vec3  light_col  = palette(fract(light_idx * 0.137 + 0.3));
    // Apply only on the tunnel walls (not the deep centre).
    wall_col += light_col * light_glow * smoothstep(0.05, 0.5, r);

    // -----------------------------------------------------------------------
    // Exit light: palette(0.5) glow circle visible at the tunnel's far end.
    // Based on undistorted screen distance so it stays centred.
    // -----------------------------------------------------------------------
    float exit_glow = exp(-dist0 * 5.5) * 1.2;
    vec3  exit_col  = palette(0.5);

    // -----------------------------------------------------------------------
    // Edge vignette centred on the shifted UV (porthole follows the curve).
    // Boundary pulses ±0.1 in screen space for the "radius pulsing" effect.
    // -----------------------------------------------------------------------
    float vig_edge = 0.65 + pulse * 2.0;
    float vignette = smoothstep(vig_edge + 0.2, vig_edge - 0.1, r);

    vec3 col = wall_col * vignette + exit_col * exit_glow;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
