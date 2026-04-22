# Dependency Audit — hyprsaver v0.4.4 pre-sprint baseline

## 1. Executive Summary

226 crates in lock file (25 direct, 200 transitive, 1 self). 223/226 are MIT-compatible
(Green). Three crates carry non-standard licenses: `option-ext` (MPL-2.0, Yellow),
`epaint_default_fonts` (OFL-1.1 + UFL-1.0 for bundled fonts, acceptable), and
`unicode-ident` (Unicode-3.0, permissive). Zero CVEs. One unmaintained-crate advisory
(`instant` via `notify`, no patched version upstream). Fourteen duplicate-version groups,
all Windows target crates or Wayland ecosystem version skew — none actionable without
upstream changes. **Verdict: MIT-clean for redistribution, ship it.**

---

## 2. License Inventory

Full table omitted for brevity. Summary by classification:

| Classification | Count | Notes |
|----------------|-------|-------|
| **Green** (MIT-compatible) | 223 | MIT, Apache-2.0, BSD-*, ISC, Zlib, CC0-1.0, Unlicense, 0BSD |
| **Yellow** (compatible with caveats) | 1 | `option-ext` 0.2.0 — MPL-2.0 |
| **Red** (non-standard, needs exception) | 2 | `epaint_default_fonts` 0.29.1, `unicode-ident` 1.0.24 |

Dominant licenses: `Apache-2.0 OR MIT` (majority), `MIT` (Wayland stack). Unique SPDX
identifiers in tree: 15 (10 Green + MPL-2.0 + OFL-1.1 + LicenseRef-UFL-1.0 +
Unicode-3.0 + LGPL-2.1-or-later as alternative in `r-efi` — moot since MIT is available).

---

## 3. License Concerns

### option-ext 0.2.0 — MPL-2.0 (Yellow)

**Pull path:** `dirs` → `dirs-sys` → `option-ext`

MPL-2.0 is file-level copyleft. Requirement: if you distribute the MPL-2.0 source files,
they must remain under MPL-2.0. The crate source is publicly available on crates.io; the
hyprsaver binary is MIT-licensed and unaffected. **Recommendation: accept.** No code
change to hyprsaver's sources is required. Note it in AUR/crates.io package metadata.

### epaint_default_fonts 0.29.1 — OFL-1.1 AND LicenseRef-UFL-1.0 (Red classifier)

**Pull path:** `egui` → `epaint` → `epaint_default_fonts`

This crate embeds Inter, Hack, and Ubuntu Mono fonts. OFL-1.1 (SIL Open Font License)
and UFL-1.0 (Ubuntu Font License) both permit embedding fonts in compiled binaries.
Neither requires open-sourcing the host program. The "Red" classification is a tooling
artifact: these are OSI-recognised font licenses, not copyleft. **Recommendation:
accept.** `[[licenses.exceptions]]` entry in `deny.toml` documents the decision.

### unicode-ident 1.0.24 — Unicode-3.0 (Red classifier)

**Pull path:** `proc-macro2` → `unicode-ident` (build-time only)

`Unicode-3.0` covers only the bundled Unicode data tables; the Rust code is MIT OR
Apache-2.0. Unicode-3.0 is OSI-approved and substantively equivalent to BSD-3-Clause for
data files. **Recommendation: accept.** `[[licenses.exceptions]]` entry in `deny.toml`
documents the decision. Build-time only — not present in the runtime binary.

---

## 4. Security Advisories

No CVEs. Zero vulnerabilities found in Cargo.lock as of **2026-04-22**.

One informational advisory:

| ID | Crate | Version | Kind | Patched? |
|----|-------|---------|------|----------|
| RUSTSEC-2024-0384 | `instant` | 0.1.13 | unmaintained | No |

**Pull path:** `notify` → `notify-types` → `instant`

**Reachability:** `notify` is used for shader hot-reload (`FileSystemWatcher` on the
shader directory). `instant` provides `Instant::now()` abstraction for WASM; on Linux the
Wayland daemon path calls the native `std::time::Instant` directly — `instant`'s code is
compiled in but the WASM shim is never invoked. **Assessment: unreachable in daemon
mode; low risk.**

The advisory is suppressed in `deny.toml` with an explanatory comment. The upstream fix
depends on `notify-types` dropping `instant`; no action available to hyprsaver directly.
Monitor notify for a release that removes `notify-types → instant`.

---

## 5. Unmaintained Crates

| Crate | Version | Advisory | Recommendation |
|-------|---------|----------|----------------|
| `instant` | 0.1.13 | RUSTSEC-2024-0384 | **Monitor** — no patched version; blocked on notify upstream |

---

## 6. Duplicate Versions

`cargo deny check` flagged **14 duplicate-version groups** (all warnings, no failures):

**Linux-relevant duplicates (ecosystem version skew):**

| Crate | Versions | Root cause |
|-------|----------|------------|
| `bitflags` | 1.3.2, 2.11.1 | `inotify`/`kqueue` (via `notify`) pins 1.x; rest of ecosystem is 2.x |
| `rustix` | 0.38.44, 1.1.4 | `calloop`/`smithay-client-toolkit` pin 0.38; `wayland-backend`/`polling` use 1.x |
| `linux-raw-sys` | 0.4.15, 0.12.1 | Follows the rustix split above |
| `memmap2` | 0.8.0, 0.9.10 | `xkbcommon` pins 0.8; `smithay-client-toolkit` uses 0.9 |
| `redox_syscall` | 0.5.18, 0.7.4 | `parking_lot_core` (egui) pins 0.5; `libredox` (dirs/notify) uses 0.7 |

**Windows target crates (9 groups, no impact on Linux builds):**

`windows-sys` (4 versions: 0.48/0.52/0.59/0.61 pinned by dirs-sys, glutin/notify,
rustix-0.38, and clap/anstream respectively), plus corresponding `windows-targets` and
`windows_*` arch variants. Worst offender by version count.

**All duplicates are blocked on upstream upgrades.** None are resolvable by changing
hyprsaver's own `Cargo.toml`. The rustix 0.38→1.x skew will resolve when
smithay-client-toolkit 0.20 releases.

---

## 7. `cargo deny check` Output

```
warning[duplicate]: found 2 duplicate entries for crate 'bitflags'
warning[duplicate]: found 2 duplicate entries for crate 'linux-raw-sys'
warning[duplicate]: found 2 duplicate entries for crate 'memmap2'
warning[duplicate]: found 2 duplicate entries for crate 'redox_syscall'
warning[duplicate]: found 2 duplicate entries for crate 'rustix'
warning[duplicate]: found 4 duplicate entries for crate 'windows-sys'
warning[duplicate]: found 2 duplicate entries for crate 'windows-targets'
warning[duplicate]: found 2 duplicate entries for crate 'windows_aarch64_gnullvm'
warning[duplicate]: found 2 duplicate entries for crate 'windows_aarch64_msvc'
warning[duplicate]: found 2 duplicate entries for crate 'windows_i686_gnu'
warning[duplicate]: found 2 duplicate entries for crate 'windows_i686_msvc'
warning[duplicate]: found 2 duplicate entries for crate 'windows_x86_64_gnu'
warning[duplicate]: found 2 duplicate entries for crate 'windows_x86_64_gnullvm'
warning[duplicate]: found 2 duplicate entries for crate 'windows_x86_64_msvc'

advisories ok, bans ok, licenses ok, sources ok
```

---

## 8. Recommendations

| Priority | Action | Rationale |
|----------|--------|-----------|
| P2 | Monitor `notify` releases for removal of `instant` (RUSTSEC-2024-0384) | No patched version; blocked on upstream; low risk |
| P2 | When updating `egui` past 0.29, re-run `cargo deny check` to verify `epaint_default_fonts` exception still applies | Font crate versions track egui minor |
| P2 | When `smithay-client-toolkit` 0.20 releases, upgrade to collapse the rustix/linux-raw-sys/bitflags duplicate pairs | Will reduce lock file from ~226 to ~220 crates |
| P2 | Before adding the `gif` crate for GIF export: run `cargo deny check` after adding it to `Cargo.toml`; if it passes, the dep is compliant; if it fails on a license, consult the License Concerns section above for the accept/exception decision framework |

No P0 or P1 issues. Nothing blocks the v0.4.4 sprint.

**Re-running the audit:** `cargo deny check` — takes ~5 seconds, no compilation required.
Full advisory re-scan: `cargo audit`. Both tools are already installed.

---

## 9. Baseline Metrics

| Metric | Value |
|--------|-------|
| Total direct dependencies | 25 |
| Total transitive dependencies | 200 |
| Total crates in lock file | 226 |
| Unique license identifiers in tree | 15 |
| CVEs / security advisories | 0 |
| Informational advisories (unmaintained) | 1 |
| Duplicate-version groups | 14 |
| Date of audit | 2026-04-22 |
| Advisory DB commit | fded92d037ef9810c6d1717e6226d8daa6a2afcc |
| Tools | cargo-deny 0.19.4, cargo-audit 0.22.1, cargo-license 0.7.0 |
