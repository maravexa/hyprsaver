#version 320 es
precision highp float;

// ---------------------------------------------------------------------------
// hyprsaver — lattice.frag
//
// Forward-flying raymarcher through an infinite gyroid field. The gyroid is
// an inherently periodic smooth surface — no space-fold seams, no silhouette
// tearing. Organic twisted-tendril aesthetic. Palette maps hit depth directly
// against a pure black background; soft-hit antialiases silhouette edges.
// Medium GPU tier (~30–38% on HawkPoint1 at 1920×1200).
// ---------------------------------------------------------------------------

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform int   u_frame;
uniform float u_speed_scale;
uniform float u_zoom_scale;

mat2 rot(float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, s, -s, c);
}

// Gyroid SDF: thickened shell of sin(x)cos(y)+sin(y)cos(z)+sin(z)cos(x)=0.
// Division by scale is the Lipschitz correction — required for sphere marching.
float sdGyroid(vec3 p, float scale, float thickness) {
    p *= scale;
    float g = dot(sin(p), cos(p.yzx));
    return (abs(g) - thickness) / scale;
}

float scene(vec3 p) {
    return sdGyroid(p, 0.8, 0.4);
}

// Returns vec2(t, hit): hit=1.0 on surface, 0.0 on miss, fractional on near-miss.
// Step multiplier 0.6 compensates for gyroid being a non-exact SDF.
vec2 march(vec3 ro, vec3 rd) {
    float t = 0.05;
    float best_d = 1000.0;
    for (int i = 0; i < 40; i++) {
        float d = scene(ro + rd * t);
        best_d = min(best_d, d);
        if (d < 0.002) return vec2(t, 1.0);
        if (t > 20.0)  break;
        t += d * 0.6;
    }
    float hit = 1.0 - smoothstep(0.002, 0.08, best_d);
    return vec2(t, hit);
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    vec3 ro = vec3(
        sin(u_time * u_speed_scale * 0.07) * 0.8,
        cos(u_time * u_speed_scale * 0.09) * 0.8,
        u_time * u_speed_scale * 2.0
    );
    vec3 rd = normalize(vec3(uv, 1.5 / u_zoom_scale));
    rd.xy = rot(sin(u_time * u_speed_scale * 0.05) * 0.3) * rd.xy;
    rd.yz = rot(sin(u_time * u_speed_scale * 0.03) * 0.2) * rd.yz;

    vec2 result = march(ro, rd);
    float dist = result.x;
    float hit  = result.y;

    float t_palette = pow(clamp(dist / 20.0, 0.0, 1.0), 0.6);
    vec3 surface_col = palette(1.0 - t_palette);
    vec3 col = surface_col * hit;

    fragColor = vec4(col, 1.0);
}
