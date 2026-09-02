# hyprsaver Backlog

Canonical tracking document for hyprsaver work. Items move between states as they're scheduled, completed, or deferred.

**States:**
- **Active** — committed to current sprint
- **Likely** — likely-lands in current sprint if pace holds
- **Deferred** — tracked, not currently scheduled
- **Completed** — shipped, with sprint reference

---

## Active Sprint: v0.4.8

No items are committed yet. Candidates from the completed v0.4.7 sprint are listed below.

### Candidates

- [ ] Reaction-diffusion shader on the new feedback buffers (was blocked on ping-pong FBO)
- [ ] Trails / smoke shader using `u_prev_frame`
- [ ] Re-baseline `docs/BENCHMARK_*` tiers on `bench` numbers (the historical radeontop % are ~3–4× higher than render-throughput %)

---

## Deferred Shaders

- **Matrix & terminal small-display scaling** — both look great on full displays but don't scale well to small WebP preview thumbnails. Needs DPI-aware glyph sizing or a small-display fallback path.
- **Stonks pattern variation** — current pattern is repetitive. Needs additional variation modes or organic noise overlay.
- **Eye shader** — Sauron-style or cat-eye, looking-around motion. New shader idea.
- **Reaction-diffusion shader** — Gray-Scott or similar. Unblocked in v0.4.7 by `u_prev_frame` feedback buffers.

## Deferred Infrastructure

- **Screencopy texture pipeline** — capture compositor framebuffer for shader input. Crosses privilege boundary; needs threat model + UX for permission denial. Recommend `docs/screencopy-design.md` placeholder before implementation prompt is written.
- **Rain-on-glass with real blurred desktop** — depends on screencopy pipeline.

## Deferred Polish

(Empty — items added as they emerge mid-sprint.)

---

## Carry-forward Principles

Project conventions established by prior sprints. All new work must respect them.

### GLSL / shader

- **Triangle-wrap palette sampling**: `abs(fract(x * 0.5) * 2.0 - 1.0)` not `fract(x)`. Eliminates seam on directional palettes. (v0.4.5)
- **Camera-roll for raymarched view rotation**: rotate `cam_up`/`cam_right` around `cam_forward`; keep camera position fixed on surface normal. Camera-position-orbits-surface-point causes clip-through at 90° roll. (v0.4.5)
- **Raymarch starting inside SDF**: use `abs(d) < HIT_EPS`, not `d < HIT_EPS`. Use abs-step march `t += abs(d)` for monotonic t. (v0.4.4 wormhole, v0.4.5 mobius)
- **Magenta nuclear test** before debugging shader math — verify pipeline executes first.
- **2D polar cannot produce real curved tunnels** — only viable path is 3D raymarch + TunnelCenter displacement. (v0.4.4)
- **Palette fetch only inside the footprint**: distance-test first, `palette()` only for covered pixels. Geometry −25 % with identical pixels. (v0.4.7)
- **Phyllotaxis: key on √n or angle, never raw n** — spatial neighbours differ by 34/55 in index. (v0.4.7 fibonacci)
- **Feedback shaders sample `u_prev_frame`** (`gl_FragCoord.xy / u_resolution`); black on first frame / resize / load; render unfaded, fade applied at present. (v0.4.7)

### GPU optimization (RDNA)

- Per-pixel particle loops are the #1 GPU killer — replace with O(1) grid/sector spatial lookup
- GPU branches inside per-pixel loops add overhead on RDNA; uniform branches are free
- Defer `sqrt`: use `dot(dv, dv)` for comparisons, single `sqrt` after loop
- `smoothstep` returning 0.0 for distant pixels is cheaper than a divergent branch
- 20 thin zoom layers outperform fewer thick layers for starfield
- **Measure with `hyprsaver bench` before and after** (`--frames 240 --span 30` for phase-based shaders); verify parity with a PIL diff of `render-preview` frames. (v0.4.7)

### Rust / build

- **Stable hashing for reproducibility**: FNV-1a or fixed-seed seahash/ahash. Never `std::hash::DefaultHasher` (not stable across Rust versions). (v0.4.5)
- **Cloud-vs-local environment asymmetry**: Claude Code cloud may have build deps local doesn't. Add `git status --ignored` check before commits in cloud sessions. (v0.4.5)
- **Shader build process**: `touch src/shaders.rs` after shader edits to force re-embedding via `include_str!()`. Do not run `cargo build` in Claude Code cloud sessions (linker fails on xkbcommon); local Arch sessions build fine — always run fmt/clippy/test there before committing. (v0.4.6)
- **Toolchain drift**: months between sessions means a newer stable Rust; new clippy lints (e.g. `float_literal_f32_fallback` in 1.97) break CI's `-D warnings`. Run clippy locally first thing after a long gap. (v0.4.6)
- `cargo update` works (resolution-only, doesn't build).

### Wayland / daemon

- **Never block the event loop on the compositor**: EGL swap interval 0, render a surface only after its previous frame callback fired (1 s fallback). A hidden output must idle, not wedge. (v0.4.6, #348)
- **Signals must work even when the loop is stuck**: watchdog force-exit after `fade_out_ms` + 3 s; second signal exits immediately. The exclusive keyboard grab is the blast radius — a stuck process locks the whole session. (v0.4.6)
- **External PRs**: fork PRs get no CI until approved. Fetch the commit, merge it through a local branch, run fmt/clippy/test locally, then let CI on `main` cover deny/audit/MSRV. (v0.4.6)

### Workflow / process

- **GPU util tiers**: Lightweight <33%, Medium <50%, Heavy <66%, Ultra >66%. Shared language for all perf decisions.
- **Prompt discipline**: tightly scoped, one concern per prompt, explicit "Do NOT" lists, verification step, failed approaches documented.
- **Slip-guards**: 2-attempt cap on high-risk items, then diagnosis-only report before further iteration.
- **A/B testing**: new shader variants → new filenames, not overwriting baselines.
- **Diagnosis before fixes** when multiple iterations fail.

### Release / packaging

- `cargo publish` modifies `Cargo.lock` locally — must commit before tagging
- Release sequence: bump `Cargo.toml` → `cargo update` → commit both → push → tag → push tag → wait 2–3 min for CDN → `updpkgsums` → regenerate `.SRCINFO` → push to AUR
- AUR uses `master` branch; GitHub uses `main`; raw README URLs use `main`
- `.SRCINFO` regenerated with `makepkg --printsrcinfo > .SRCINFO`
- **Finish the sequence in one sitting.** v0.4.5 was bumped in `Cargo.toml`/`CHANGELOG.md` (2026-04-28) but never tagged or published; it shipped four months later inside v0.4.6. (v0.4.6)

---

## Completed

### v0.4.7 (2026-09-01)

- `hyprsaver bench` headless GPU benchmark (ms/frame, budget %, tiers, `--span`, `--markdown`, `--json`)
- Geometry optimization: palette fetch gated on line distance, unused vertices skipped — 1.88 → 1.41 ms/frame, pixel-identical
- `fibonacci` shader (phyllotaxis, 36 built-ins) + gallery preview
- Terminal font 30 → 72 glyphs; `scripts/gen_terminal_glyphs.py` is the source of truth
- `u_prev_frame` feedback ping-pong buffers in the renderer (engine only)
- Gallery CI workflow (llvmpipe, deploys generated previews to GitHub Pages)
- Headless EGL logs the renderer string; `docs/BENCHMARK_0.4.7.md`

### v0.4.6 (2026-09-01)

- Live speed slider in preview (#344) — was listed as open for this sprint
- Wedged-daemon fix for #348: EGL swap interval 0, per-surface frame-callback pacing with 1 s fallback, shutdown watchdog (`fade_out_ms` + 3 s; second signal exits immediately)
- Fractional scaling (#346) via wp-fractional-scale-v1 + wp_viewporter — external PR #347, plus first-frame viewport fix
- `[behavior] exclusive_keyboard` config option
- Codebase-audit refactors (#345): shared `EglState`, `PlaylistCursor`, table-driven uniform injection, registration desync test
- Rust 1.97 clippy fix (`float_literal_f32_fallback`)
- Docs/packaging drift: README roadmap + defaults, benchmark link, `PKGBUILD` version, lock file refresh
- **Dropped from the sprint:** "Per-monitor shader/palette assignment" — already shipped in v0.2.0 (`[[monitor]]` blocks, `resolve_monitor_config()` in `wayland.rs`)

### v0.4.5

- 5 new shaders: fireflies (25%), stonks (18%), attitude (28%), waterfall (32%), mobius (31%) — all Lightweight tier
- Triangle-wrap palette refactor across 11 shaders
- Preview FPS counter rework (top-left, larger, black-bordered, `I` keybind toggle)
- Palette tab dropdown parity + test palette transition button
- `render-gif` → `render-preview` (animated WebP, batch mode, deterministic palette per shader, `--skip-existing`)
- `[render_preview.palettes]` config section for shader→palette override mappings
- README shader gallery via animated WebP previews

### v0.4.4 and earlier

See git log and `CHANGELOG.md` for full history. This section is populated forward from v0.4.6 onward (v0.4.5 above was back-filled).

---

## Maintenance notes

- When an item moves from Active → shipped, move it to Completed under the current sprint's release version
- When an item is deferred from a sprint, move it to the appropriate Deferred section with a note about why
- When new ideas emerge mid-sprint, add to Deferred Polish or the appropriate section
- Sprint kickoffs read from this file to inform scope decisions
- Carry-forward principles section grows as new lessons codify; never shrinks without explicit decision to retire a principle
