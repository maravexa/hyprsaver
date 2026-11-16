# Shader A/B sources

The Matrix, Attitude, Circuit, Fibonacci, Stonks and Mobius candidates are now
integrated into their built-in shaders. Their `*-candidate.frag` copies are kept
under separate names for repeatable A/B evaluation. The original built-in bytes
are preserved in `../shader-baselines/`.

**Wormhole is rejected and remains unchanged in the built-ins.** Its candidate
here is a retained failed experiment, not an improvement to install. The default
QA set excludes it. Two subsequent solver experiments also failed first-hit
validation; see [qualification notes](../../docs/SHADER_QA_2026-11-16.md).

Run from the repository root after building (Python 3 with Pillow required):

```sh
python3 scripts/shader_qa.py --binary target/debug/hyprsaver \
  --baseline-dir examples/shader-baselines \
  --candidates examples/shader-candidates --output /path/to/new/qa-run
python3 -m unittest discover -s scripts -p test_shader_qa.py
```

Each output directory must be new. The harness uses isolated configuration,
fixed timestamps, raw PNGs, two palettes, landscape and portrait sizes, contact
sheets, image contracts and repeated synchronized frame-time measurements.
`--software` explicitly requests llvmpipe; otherwise the report records the
renderer actually used. These measurements are throughput, not GPU utilization.

The default six-shader set can be narrowed with `--shaders`. Preserve the baseline
option when evaluating this change after integration: current built-ins already
contain the accepted variants. Future shader changes need new baseline/candidate
snapshots and contracts appropriate to their intended behavior.

AMD offscreen validation passed for all six. Stonks costs more on AMD despite
its improved software performance: +0.0762 ms/frame (+125%) at 1080p, below the
explicit 0.1 ms absolute regression floor. Mobius's half-angle distance function
removed its earlier performance hold. The measured results, limits and remaining
compositor/physical acceptance are documented in the qualification notes.
