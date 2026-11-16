#!/usr/bin/env python3
"""Deterministic shader A/B captures and repeated synchronized throughput checks.
Requires Pillow. Outputs are local; no compositor, configuration or network changes.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import statistics
import subprocess
import tempfile

from PIL import Image, ImageChops, ImageDraw, ImageStat

SHADERS = ['matrix', 'attitude', 'circuit', 'fibonacci', 'stonks', 'mobius']
RESOLUTIONS = ['320x180', '800x480', '1920x1080', '480x800']

def run(command, env, log):
    result = subprocess.run(command, env=env, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=300)
    log.write_text(result.stdout)
    if result.returncode:
        raise RuntimeError(f'{command[1]} failed ({result.returncode}); see {log}')
    return result.stdout

def measurements(paths):
    images = [Image.open(p).convert('RGB') for p in paths]
    stats = []
    for image in images:
        gray = image.convert('L')
        hist = gray.histogram()
        count = image.width * image.height
        stats.append({'coverage': sum(hist[9:]) / count,
                      'contrast': ImageStat.Stat(gray).stddev[0]})
    changes = [sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3
               for a, b in zip(images, images[1:])]
    return {'min_coverage': min(s['coverage'] for s in stats),
            'min_contrast': min(s['contrast'] for s in stats),
            'mean_temporal_delta': statistics.mean(changes)}, images

def compare_pair(shader, before, after):
    """Contract checks specific to the intended changes, not aesthetic approval."""
    result = {}
    if shader == 'circuit':
        maximum = max(max(v[1] for v in ImageChops.difference(a, b).getextrema())
                      for a, b in zip(before, after))
        result = {'max_channel_delta': maximum, 'passed': maximum <= 1,
                  'contract': 'optimization preserves pixels within one channel level'}
    elif shader == 'mobius':
        def coverage(im):
            return sum(im.convert('L').histogram()[9:]) / (im.width * im.height)
        old = min(map(coverage, before)); new = min(map(coverage, after))
        result = {'baseline_min_coverage': old, 'candidate_min_coverage': new,
                  'passed': new >= old + 0.05,
                  'contract': 'minimum visible strip coverage improves by five percentage points'}
    elif shader == 'fibonacci':
        added = max(max(v[1] for v in ImageChops.subtract(b, a).getextrema())
                    for a, b in zip(before, after))
        removed = max(max(v[1] for v in ImageChops.subtract(a, b).getextrema())
                      for a, b in zip(before, after))
        result = {'max_added_channel_level': added, 'max_removed_channel_level': removed,
                  'passed': added <= 1 and removed > 1,
                  'contract': 'remove the overlay without adding new bright structures'}
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--shaders', nargs='+', default=SHADERS)
    parser.add_argument('--resolutions', nargs='+', default=RESOLUTIONS)
    parser.add_argument('--palettes', nargs='+', default=['rainbow', 'forest'])
    parser.add_argument('--candidates', type=Path)
    parser.add_argument('--baseline-dir', type=Path,
                        help='Load preserved NAME.frag baselines instead of the current built-ins')
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--bench-frames', type=int, default=48)
    parser.add_argument('--bench-resolution', default='480x270')
    parser.add_argument('--software', action='store_true', help='Force llvmpipe; never a hardware acceptance result')
    args = parser.parse_args()
    if args.repeats < 3 or args.bench_frames < 1:
        parser.error('at least 3 repeats and 1 benchmark frame required')
    names = args.shaders + ([s+'-candidate' for s in args.shaders] if args.candidates else [])
    if any(not re.fullmatch(r'[a-z0-9_-]+', name) for name in names + args.palettes):
        parser.error('shader and palette names must use lowercase letters, digits, underscores or hyphens')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False) # Never overwrite an earlier evidence run.
    binary = args.binary.resolve()
    report = {'schema': 1, 'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'host': platform.node(), 'platform': platform.platform(), 'software_requested': args.software,
              'measurement': 'synchronized wall-clock render throughput, not GPU timer/utilization',
              'settings': {'resolutions': args.resolutions, 'palettes': args.palettes, 'times': [0, 10, 20, 30],
                           'bench_resolution': args.bench_resolution, 'bench_frames': args.bench_frames,
                           'repeats': args.repeats, 'bench_span': 60, 'warmup': 6},
              'baseline': 'preserved files' if args.baseline_dir else 'built-ins',
              'sources': {}, 'visuals': {}, 'comparisons': {}, 'benchmarks': {}, 'warnings': [], 'failures': []}
    with tempfile.TemporaryDirectory(prefix='hyprsaver-qa-') as temp:
        env = dict(os.environ, XDG_CONFIG_HOME=temp, EGL_PLATFORM='surfaceless',
                   MESA_SHADER_CACHE_DIR=str(output/'mesa-cache'))
        if args.software:
            env['LIBGL_ALWAYS_SOFTWARE'] = '1'
        if args.baseline_dir or args.candidates:
            shader_dir = Path(temp)/'hypr/hyprsaver/shaders'
            shader_dir.mkdir(parents=True)
        if args.baseline_dir:
            for shader in args.shaders:
                source = args.baseline_dir/(shader+'.frag')
                shutil.copyfile(source, shader_dir/source.name)
                report['sources'][source.name] = hashlib.sha256(source.read_bytes()).hexdigest()
        if args.candidates:
            for shader in args.shaders:
                source = args.candidates/(shader+'-candidate.frag')
                shutil.copyfile(source, shader_dir/source.name)
                report['sources'][source.name] = hashlib.sha256(source.read_bytes()).hexdigest()
        renderer = None
        for resolution in args.resolutions:
            for palette in args.palettes:
                folder = output/resolution/palette
                folder.mkdir(parents=True)
                for shader in names:
                    cmd = [str(binary), 'render-preview', shader, '--resolution', resolution,
                           '--palette', palette, '--seed', '0', '--duration', '1', '--fps', '4',
                           '--time-step', '10', '--frames-dir', str(folder), '-o', str(folder/(shader+'.webp'))]
                    log = run(cmd, env, folder/(shader+'.log'))
                    current = next((line.split('headless EGL: ', 1)[1] for line in log.splitlines() if 'headless EGL: renderer' in line), None)
                    if current is None or (renderer is not None and current != renderer):
                        raise RuntimeError('renderer identity missing or changed during run')
                    renderer = current
                    paths = sorted((folder/shader).glob('frame-*.png'))
                    if len(paths) != 4:
                        raise RuntimeError(f'{shader}: expected four raw frames, got {len(paths)}')
                    stats, images = measurements(paths)
                    key = f'{shader}/{resolution}/{palette}'
                    report['visuals'][key] = stats
                    # Deliberately broad smoke gates. Sparse circuit/matrix and black
                    # Mobius backgrounds are intentional. Artistic review is separate.
                    if stats['min_coverage'] < 0.002 or stats['min_contrast'] < 0.5:
                        report['failures'].append(f'{key}: nearly blank or flat capture')
                    if stats['mean_temporal_delta'] < 0.05:
                        report['failures'].append(f'{key}: no measurable temporal variation')
                    sheet = Image.new('RGB', (4*320, 200), '#202020')
                    draw = ImageDraw.Draw(sheet)
                    for i, im in enumerate(images):
                        im.thumbnail((320, 175))
                        sheet.paste(im, (320*i+(320-im.width)//2, 22+(175-im.height)//2))
                        draw.text((320*i+4, 4), f'{shader} / {i*10}s', fill='white')
                    sheet.save(folder/(shader+'-contact.png'))
                if args.candidates:
                    for shader in args.shaders:
                        raw_before = [Image.open(f).convert('RGB') for f in sorted((folder/shader).glob('frame-*.png'))]
                        raw_after = [Image.open(f).convert('RGB') for f in sorted((folder/(shader+'-candidate')).glob('frame-*.png'))]
                        comparison = compare_pair(shader, raw_before, raw_after)
                        if comparison:
                            key = f'{shader}/{resolution}/{palette}'
                            report['comparisons'][key] = comparison
                            if not comparison['passed']:
                                report['failures'].append(f'{key}: shader-specific comparison contract failed')
                        before = Image.open(folder/(shader+'-contact.png'))
                        after = Image.open(folder/(shader+'-candidate-contact.png'))
                        sheet = Image.new('RGB', (1280, 400))
                        sheet.paste(before, (0, 0)); sheet.paste(after, (0, 200))
                        sheet.save(folder/(shader+'-comparison.png'))
        report['renderer'] = renderer
        samples = {shader: [] for shader in names}
        bench = output/'bench'; bench.mkdir()
        for repeat in range(args.repeats):
            # Reverse order on alternating runs to reduce systematic warmup/order bias.
            order = names if repeat % 2 == 0 else list(reversed(names))
            result_path = bench/f'run-{repeat}.json'
            run([str(binary), 'bench', *order, '--resolution', args.bench_resolution,
                 '--frames', str(args.bench_frames), '--span', '60', '--warmup', '6',
                 '--palette', 'rainbow', '--monitors', '1', '--json', str(result_path)],
                env, bench/f'run-{repeat}.log')
            rows = json.loads(result_path.read_text())
            if len(rows) != len(names) or {r['shader'] for r in rows} != set(names):
                raise RuntimeError('incomplete or duplicate benchmark rows')
            for row in rows:
                value = row['frame_ms']
                if row['error'] or not math.isfinite(value) or value <= 0:
                    raise RuntimeError(f'invalid benchmark sample: {row}')
                samples[row['shader']].append(value)
        for shader, values in samples.items():
            median = statistics.median(values)
            mad = statistics.median(abs(v-median) for v in values)
            report['benchmarks'][shader] = {'samples_ms': values, 'median_ms': median, 'mad_ms': mad}
        if args.candidates:
            for shader in args.shaders:
                base = report['benchmarks'][shader]
                candidate = report['benchmarks'][shader+'-candidate']
                delta = candidate['median_ms'] - base['median_ms']
                threshold = max(base['median_ms']*0.15, 3*(base['mad_ms']+candidate['mad_ms']), 0.1)
                candidate['change_pct'] = 100*delta/base['median_ms']
                if delta > threshold:
                    report['warnings'].append(f'{shader}: candidate throughput regression {candidate["change_pct"]:.1f}% exceeds noise/15% threshold')
        (output/'report.json').write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps({'report': str(output/'report.json'), 'renderer': renderer,
                          'failures': report['failures'], 'warnings': report['warnings']}, indent=2))
        return bool(report['failures'] or report['warnings'])

if __name__ == '__main__':
    raise SystemExit(main())
