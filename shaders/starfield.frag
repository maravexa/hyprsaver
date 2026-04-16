#version 320 es
precision highp float;

// hyprsaver — starfield.frag  (Cartesian grid + radial motion, v2)

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;

float h11(float p) {
    p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p);
}

vec2 hash22(vec2 p) {
    p = fract(p * vec2(0.1031, 0.1030));
    p += dot(p, p.yx + 33.33);
    return fract((p.xx + p.yx) * p.xy);
}

void main() {
    vec2  res = u_resolution;
    vec2  uv  = (gl_FragCoord.xy - 0.5 * res) / res.y;

    vec3 col = vec3(0.0);

    // Back-to-front: far (0), mid (1), near (2)
    for (int layer = 0; layer < 3; layer++) {
        float grid_scale, layer_speed, min_size, max_size, max_tail;
        if (layer == 0) {
            grid_scale = 12.0; layer_speed = 0.5;  min_size = 0.5; max_size = 1.5; max_tail = 0.06;
        } else if (layer == 1) {
            grid_scale =  7.0; layer_speed = 1.0;  min_size = 1.5; max_size = 4.0; max_tail = 0.15;
        } else {
            grid_scale =  4.0; layer_speed = 1.8;  min_size = 3.0; max_size = 8.0; max_tail = 0.25;
        }

        vec2 cell_id = floor(uv * grid_scale);

        for (int dx = -1; dx <= 1; dx++) {
            for (int dy = -1; dy <= 1; dy++) {
                vec2  nb   = cell_id + vec2(float(dx), float(dy));
                float seed = float(layer) * 137.531 + nb.x * 17.37 + nb.y * 53.19;

                // Cell-centred base position with random jitter (±0.35 cell widths)
                vec2 jitter  = (hash22(nb + float(layer) * vec2(37.1, 61.7)) - 0.5) * 0.7;
                vec2 base_uv = (nb + 0.5 + jitter) / grid_scale;

                float dist_c = length(base_uv);
                if (dist_c < 0.08) continue;    // dead zone — no stars near screen centre

                vec2  rdir      = base_uv / dist_c;
                float cyc_speed = layer_speed * (0.2 + dist_c * 1.5);
                float t_raw     = h11(seed + 2.22) + u_time * u_speed_scale * cyc_speed;
                float phase     = fract(t_raw);
                float cycle_n   = floor(t_raw);

                // Per-cycle base perturbation prevents visible pattern repetition
                vec2 pjitter = (hash22(vec2(cycle_n, seed)) - 0.5) * 0.1;
                base_uv     += pjitter / grid_scale;
                dist_c       = length(base_uv);
                if (dist_c < 0.001) continue;
                rdir = base_uv / dist_c;

                // u_zoom_scale controls warp-tunnel depth (max radial travel per cycle)
                float max_disp = 0.5 / grid_scale * u_zoom_scale;
                vec2  star_pos = base_uv + rdir * (phase * max_disp);

                // Size ramps from pinpoint at phase=0, scales with perspective distance
                float size_ramp = smoothstep(0.0, 0.25, phase);
                float persp     = 0.5 + dist_c * 1.2;
                float core_r    = (min_size + (max_size - min_size) * size_ramp * persp)
                                  / min(res.x, res.y);

                // Head dot
                float head_dist = length(uv - star_pos);
                float star_dot  = 1.0 - smoothstep(core_r * 0.7, core_r, head_dist);

                // Tail — extends inward toward screen centre along radial ray
                float tail_grow = smoothstep(0.0, 0.3, phase);
                float tail_len  = min(max_tail * dist_c * 2.0 * tail_grow, max_tail);
                float tail_wid  = core_r * 1.5;
                float tail_in   = 0.0;

                float sdist = length(star_pos);
                if (tail_len > 0.001 && sdist > 0.001) {
                    // Lateral distance from uv to radial ray through star_pos
                    float lat    = abs(star_pos.x * uv.y - star_pos.y * uv.x) / sdist;
                    // Projection of uv onto radial direction; behind=0 at star head
                    float proj   = dot(uv, star_pos) / sdist;
                    float behind = sdist - proj;
                    float mask   = step(0.0, behind) * step(behind, tail_len);
                    float lfal   = 1.0 - smoothstep(0.0, tail_wid, lat);
                    float lfade  = 1.0 - behind / tail_len;
                    tail_in = lfal * lfade * tail_grow * mask;
                }

                col += palette(h11(seed + 3.33)) * max(star_dot, tail_in);
            }
        }
    }

    fragColor = vec4(col, 1.0);
}
