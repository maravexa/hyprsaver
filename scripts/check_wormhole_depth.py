#!/usr/bin/env python3
"""Compare GPU Wormhole hits with an independent fine-step first-crossing oracle.

Requires NumPy and Pillow. Uses temporary shader configuration; does not change
user settings. The checked shader is loaded from source, independently of the
binary's embedded copy. Benchmark and embedded-build checks remain separate.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

import numpy as np
from PIL import Image


def center(z):
    return np.stack((np.sin(z * .17) * 1.2, np.sin(z * .10 + 4) * 3), axis=-1)


def rays(width, height, phase):
    xy = np.stack(np.meshgrid((np.arange(width) + .5 - width / 2) / height,
                             (np.arange(height) + .5 - height / 2) / height),
                  axis=-1).reshape(-1, 2)
    origin = np.r_[center(np.array(-phase * 10)) * .5, 0.]
    target = np.r_[center(np.array(5 - phase * 10)) * .5, 5.]
    forward = (target - origin) / np.linalg.norm(target - origin)
    angle = np.sin(phase * .3) + phase * .1
    up = np.array([np.sin(angle), np.cos(angle), 0])
    right = np.cross(forward, up)
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    directions = xy[:, 0, None] * right + xy[:, 1, None] * up + forward
    directions /= np.linalg.norm(directions, axis=1)[:, None]
    return origin, directions


def field(depth, phase, origin, directions):
    point = origin + np.asarray(depth)[..., None] * directions
    z = point[:, 2] - phase * 10
    return np.linalg.norm(point[:, :2] - center(z), axis=1) - (np.sin(z * .1) * .5 + 3)


def first_crossings(phase, origin, directions):
    """Uniform .025 steps, then 12 bisections; no candidate march formula."""
    result = np.full(len(directions), np.nan)
    previous = np.zeros(len(directions))
    old_field = field(previous, phase, origin, directions)
    for depth in np.arange(.025, 80.0001, .025):
        pending = np.flatnonzero(np.isnan(result))
        if not len(pending):
            break
        value = field(np.full(len(pending), depth), phase, origin, directions[pending])
        crossed = pending[(old_field[pending] < 0) & (value >= 0)]
        if len(crossed):
            low = previous[crossed].copy()
            high = np.full(len(crossed), depth)
            for _ in range(12):
                mid = (low + high) / 2
                mid_field = field(mid, phase, origin, directions[crossed])
                low = np.where(mid_field < 0, mid, low)
                high = np.where(mid_field >= 0, mid, high)
            result[crossed] = (low + high) / 2
        previous[pending] = depth
        old_field[pending] = value
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--shader', type=Path,
                        default=Path(__file__).resolve().parents[1] / 'shaders/wormhole.frag')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--software', action='store_true')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    source = args.shader.read_text()
    marker = '    fragColor = vec4(col, 1.0);'
    if source.count(marker) != 1 or 'bool hit = false;' not in source:
        parser.error('shader must expose the current hit/depth contract')
    instrumented = source.replace(marker, '''    float encoded = floor(clamp(t / MAX_DIST, 0.0, 1.0) * 65535.0 + 0.5);
    fragColor = vec4(floor(encoded / 256.0) / 255.0, mod(encoded, 256.0) / 255.0,
                     hit ? 1.0 : 0.0, 1.0);''')
    report = {'shader_sha256': hashlib.sha256(source.encode()).hexdigest(),
              'binary_sha256': hashlib.sha256(args.binary.read_bytes()).hexdigest(),
              'oracle': '.025 uniform first crossing plus 12 bisections; sampled, not proof for all rays',
              'depth_gate': .2, 'cases': [], 'failures': []}
    with tempfile.TemporaryDirectory(prefix='wormhole-depth-') as temp:
        config = Path(temp) / 'hypr/hyprsaver/shaders'
        config.mkdir(parents=True)
        (config / 'wormhole-depth.frag').write_text(instrumented)
        env = dict(os.environ, EGL_PLATFORM='surfaceless', XDG_CONFIG_HOME=temp,
                   MESA_SHADER_CACHE_DIR=str(output / 'mesa-cache'))
        if args.software:
            env['LIBGL_ALWAYS_SOFTWARE'] = '1'
        else:
            env.pop('LIBGL_ALWAYS_SOFTWARE', None)
        renderer = None
        for width, height in [(160, 90), (90, 160)]:
            folder = output / f'{width}x{height}'
            folder.mkdir()
            result = subprocess.run([
                str(args.binary.resolve()), 'render-preview', 'wormhole-depth',
                '--resolution', f'{width}x{height}', '--palette', 'rainbow', '--seed', '0',
                '--duration', '1', '--fps', '13', '--time-step', '5',
                '--frames-dir', str(folder), '-o', str(folder / 'depth.webp')],
                env=env, capture_output=True, text=True, timeout=180)
            log = result.stdout + result.stderr
            (folder / 'render.log').write_text(log)
            current = next((line.split('headless EGL: ', 1)[1] for line in log.splitlines()
                            if 'headless EGL: renderer' in line), None)
            if result.returncode or current is None or renderer not in [None, current]:
                raise RuntimeError(f'render failure or renderer changed; see {folder}/render.log')
            renderer = current
            paths = sorted((folder / 'wormhole-depth').glob('frame-*.png'))
            if len(paths) != 13:
                raise RuntimeError(f'expected 13 frames, found {len(paths)}')
            for index, phase in enumerate(range(0, 61, 5)):
                origin, directions = rays(width, height, phase)
                reference = first_crossings(phase, origin, directions)
                pixels = np.asarray(Image.open(paths[index]).convert('RGB'))[::-1].reshape(-1, 3).astype(float)
                depth = (pixels[:, 0] * 256 + pixels[:, 1]) / 65535 * 80
                hit = pixels[:, 2] > 127
                error = np.abs(depth - reference)
                row = {'resolution': f'{width}x{height}', 'phase': phase,
                       'reference_misses': int(np.isnan(reference).sum()),
                       'gpu_misses': int((~hit).sum()),
                       'wrong_first_depth_over_0_2': int((hit & (error > .2)).sum()),
                       'maximum_error': float(np.nanmax(error))}
                report['cases'].append(row)
                if row['reference_misses'] or row['gpu_misses'] or row['wrong_first_depth_over_0_2']:
                    report['failures'].append(row)
        report['renderer'] = renderer
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'cases': len(report['cases']), 'failures': len(report['failures']),
                      'renderer': renderer}))
    return 1 if report['failures'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
