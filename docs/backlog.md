# hyprsaver Backlog

Canonical tracking document for hyprsaver work. Items move between states as they're scheduled, completed, or deferred.

**States:**
- **Active** — committed to current sprint
- **Likely** — likely-lands in current sprint if pace holds
- **Deferred** — tracked, not currently scheduled
- **Completed** — shipped, with sprint reference

---

## Active Sprint: v0.4.6

### Committed

- [ ] Live uniform updates in preview (speed slider only)
- [ ] Benchmark automation (`bench-shaders` binary or equivalent)
- [ ] CI render preview pipeline (auto-regenerate WebP gallery on shader changes)
- [ ] Per-monitor shader/palette assignment
- [ ] Ping-pong FBO extension (engine only, no RD shader)
- [ ] Terminal shader char set expansion

### Likely-lands

- [ ] Geometry shader optimization pass (gated on bench-shaders landing)
- [ ] One new math-themed shader (Fibonacci spiral or similar)

---

## Deferred Shaders

- **Matrix & terminal small-display scaling** — both look great on full displays but don't scale well to small WebP preview thumbnails. Needs DPI-aware glyph sizing or a small-display fallback path.
- **Stonks pattern variation** — current pattern is repetitive. Needs additional variation modes or organic noise overlay.
- **Eye shader** — Sauron-style or cat-eye, looking-around motion. New shader idea.
- **Reaction-diffusion shader** — Gray-Scott or similar. Blocked on ping-pong FBO landing.

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

### GPU optimization (RDNA)

- Per-pixel particle loops are the #1 GPU killer — replace with O(1) grid/sector spatial lookup
- GPU branches inside per-pixel loops add overhead on RDNA; uniform branches are free
- Defer `sqrt`: use `dot(dv, dv)` for comparisons, single `sqrt` after loop
- `smoothstep` returning 0.0 for distant pixels is cheaper than a divergent branch
- 20 thin zoom layers outperform fewer thick layers for starfield

### Rust / build

- **Stable hashing for reproducibility**: FNV-1a or fixed-seed seahash/ahash. Never `std::hash::DefaultHasher` (not stable across Rust versions). (v0.4.5)
- **Cloud-vs-local environment asymmetry**: Claude Code cloud may have build deps local doesn't. Add `git status --ignored` check before commits in cloud sessions. (v0.4.5)
- **Shader build process**: `touch src/shaders.rs` after shader edits to force re-embedding via `include_str!()`. Do not run `cargo build` locally (linker fails on xkbcommon).
- `cargo update` works (resolution-only, doesn't build).

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

---

## Completed

### v0.4.5

- 5 new shaders: fireflies (25%), stonks (18%), attitude (28%), waterfall (32%), mobius (31%) — all Lightweight tier
- Triangle-wrap palette refactor across 11 shaders
- Preview FPS counter rework (top-left, larger, black-bordered, `I` keybind toggle)
- Palette tab dropdown parity + test palette transition button
- `render-gif` → `render-preview` (animated WebP, batch mode, deterministic palette per shader, `--skip-existing`)
- `[render_preview.palettes]` config section for shader→palette override mappings
- README shader gallery via animated WebP previews

### v0.4.4 and earlier

See git log and `CHANGELOG.md` for full history. This section is populated forward from v0.4.6 onward.

---

## Maintenance notes

- When an item moves from Active → shipped, move it to Completed under the current sprint's release version
- When an item is deferred from a sprint, move it to the appropriate Deferred section with a note about why
- When new ideas emerge mid-sprint, add to Deferred Polish or the appropriate section
- Sprint kickoffs read from this file to inform scope decisions
- Carry-forward principles section grows as new lessons codify; never shrinks without explicit decision to retire a principle
