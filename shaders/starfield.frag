#version 320 es
precision highp float;

// hyprsaver — starfield.frag  (zoom-layer sparse grid, v4)

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

float h11(float p) {
    p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p);
}

float h21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec2 h22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 starLayer(vec2 uv, float zoom, float layer_seed) {
    vec2 scaled_uv = uv / zoom;

    float grid_scale = 12.0;
    vec2 grid_uv    = scaled_uv * grid_scale;
    vec2 cell_id    = floor(grid_uv);
    vec2 cell_local = fract(grid_uv) - 0.5;

    vec3 col = vec3(0.0);

    for (int dx = -1; dx <= 1; dx++) {
        for (int dy = -1; dy <= 1; dy++) {
            vec2 neighbor = cell_id + vec2(float(dx), float(dy));

            float exists = h21(neighbor + layer_seed);
            if (exists < 0.95) continue;

            vec2 star_offset = h22(neighbor + layer_seed + 7.77) - 0.5;
            star_offset *= 0.7;

            vec2 delta = cell_local - vec2(float(dx), float(dy)) - star_offset;
            delta /= grid_scale;

            vec2 star_uv       = (neighbor + 0.5 + star_offset) / grid_scale * zoom;
            float dist_from_center = length(star_uv);

            float streak_amount = dist_from_center * zoom * 3.0;
            streak_amount = min(streak_amount, 8.0);

            vec2 radial_dir = (dist_from_center > 0.001)
                ? star_uv / dist_from_center
                : vec2(0.0, 1.0);
            float radial_comp  = dot(delta, radial_dir);
            float tangent_comp = abs(delta.x * radial_dir.y - delta.y * radial_dir.x);

            float aniso_dist = length(vec2(
                radial_comp / max(1.0 + streak_amount, 1.0),
                tangent_comp
            ));

            float size_hash = h21(neighbor + layer_seed + 3.33);
            float base_size = (0.002 + size_hash * 0.004) * zoom;

            float glow = 1.0 - smoothstep(0.0, base_size, aniso_dist);
            glow *= glow;

            float hue = h21(neighbor + layer_seed + 5.55);
            col += palette(hue) * glow;
        }
    }

    return col;
}

void main() {
    vec2 uv  = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;
    vec3 col = vec3(0.0);

    float speeds[4]  = float[](0.06, 0.08, 0.10, 0.07);
    float offsets[4] = float[](0.0, 0.37, 0.71, 0.19);

    for (int i = 0; i < 4; i++) {
        float phase = fract(u_time * u_speed_scale * speeds[i] + offsets[i]);
        if (phase > 0.92) continue;
        float zoom = mix(0.2, 4.0, phase);
        float fade = smoothstep(0.0, 0.25, phase);

        float layer_seed = float(i) * 137.531 + 42.0;
        col += starLayer(uv, zoom, layer_seed) * fade;
    }

    fragColor = vec4(col, 1.0);
}
