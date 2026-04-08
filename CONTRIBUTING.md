# Contributing to hyprsaver

## Getting Started

Fork the repository, create a feature branch, and submit a pull request. For anything larger than a small bug fix, open an issue first to discuss the approach.

Before submitting:

```sh
cargo fmt
cargo clippy -- -D warnings
cargo test
```

## Shader and Palette Contributions

These have the lowest barrier to entry:

- **New built-in shader**: add a `.frag` file to `shaders/`, add a `pub const BUILTIN_*` entry in `src/shaders.rs`, register it in the `BUILTIN_SHADERS` array.
- **New built-in palette**: add a constant in `src/palette.rs` and include it in the `builtin_palettes()` function.

A new shader is just a `.frag` file plus two lines of Rust. If you have made something beautiful, please share it.

## Project Layout

```
src/
  main.rs       — CLI, signal handling, startup
  config.rs     — TOML config + serde defaults
  wayland.rs    — Layer-shell surfaces, EGL, input events
  renderer.rs   — glow OpenGL ES, uniforms
  shaders.rs    — load/compile, hot-reload, Shadertoy shim
  palette.rs    — cosine gradients, LUT palettes, PaletteManager
shaders/        — built-in GLSL fragment shaders (embedded via include_str!)
examples/       — palette_test.frag, examples/palettes/
build.rs        — generates examples/palettes/fire.png at build time
```

## Release Checklist

Follow these steps in order when cutting a new release:

### 1. Bump the version

Edit `Cargo.toml`:

```toml
[package]
version = "0.X.Y"
```

Run `cargo build` once so `Cargo.lock` is updated, then commit both files:

```sh
cargo build
git add Cargo.toml Cargo.lock
git commit -m "chore: bump version to 0.X.Y"
```

### 2. Update CHANGELOG.md

Add a section at the top:

```markdown
## [0.X.Y] — YYYY-MM-DD

### Added
- ...

### Changed
- ...

### Fixed
- ...
```

Commit:

```sh
git add CHANGELOG.md
git commit -m "docs: update CHANGELOG for 0.X.Y"
```

### 3. Tag the release

```sh
git tag -s v0.X.Y -m "Release v0.X.Y"
git push origin main --tags
```

The signed tag triggers the GitHub Actions release workflow, which builds
Linux binaries (`.deb`, `.rpm`, `.tar.zst`) and attaches them to the GitHub
Release.

### 4. Publish to crates.io

```sh
# Dry-run first — catches missing files, bad metadata, etc.
cargo publish --dry-run

# If clean, publish for real
cargo publish
```

> **Note**: `cargo publish` requires a crates.io API token. Set it with
> `cargo login` or the `CARGO_REGISTRY_TOKEN` environment variable.

### 5. Update the AUR package

Edit `PKGBUILD`:

1. Set `pkgver=0.X.Y`
2. Reset `pkgrel=1`
3. Update `sha256sums` — download the crate tarball and hash it:

```sh
curl -L "https://crates.io/api/v1/crates/hyprsaver/0.X.Y/download" \
     -o hyprsaver-0.X.Y.crate
sha256sum hyprsaver-0.X.Y.crate
```

Test the PKGBUILD locally:

```sh
makepkg -si
```

Push the updated PKGBUILD to the AUR:

```sh
# In your AUR clone of hyprsaver:
cp /path/to/repo/PKGBUILD .
makepkg --printsrcinfo > .SRCINFO
git add PKGBUILD .SRCINFO
git commit -m "Update to 0.X.Y"
git push
```

### 6. Update the Nix flake lock (optional but recommended)

```sh
nix flake update
git add flake.lock
git commit -m "flake: update flake.lock for 0.X.Y"
git push
```

---

## Dependency Policy

- All dependencies must be from crates.io — no path or git dependencies in
  published releases.
- Keep the dependency count low. Prefer standard library or existing deps
  before adding new ones.
- Pin major versions in `Cargo.toml`; let semver handle minor/patch.

## License

By contributing, you agree that your contributions will be licensed under the
MIT license (see [LICENSE](LICENSE)).
