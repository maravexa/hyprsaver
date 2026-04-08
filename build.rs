// build.rs — generate example palette assets at build time.

fn main() {
    println!("cargo:rerun-if-changed=examples/palettes/fire.png");
    generate_fire_palette();
}

/// Generate a 256×1 fire gradient PNG in examples/palettes/.
/// black → deep-red → orange → bright yellow-white.
fn generate_fire_palette() {
    let path = std::path::Path::new("examples/palettes/fire.png");
    if path.exists() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all("examples/palettes") {
        eprintln!("cargo:warning=Cannot create examples/palettes: {e}");
        return;
    }

    // Build 256 RGBA pixels.
    let mut pixels: Vec<u8> = Vec::with_capacity(256 * 4);
    for i in 0u32..256 {
        let t = i as f32 / 255.0;
        let (r, g, b) = fire_color(t);
        pixels.push((r * 255.0).clamp(0.0, 255.0) as u8);
        pixels.push((g * 255.0).clamp(0.0, 255.0) as u8);
        pixels.push((b * 255.0).clamp(0.0, 255.0) as u8);
        pixels.push(255u8); // alpha
    }

    match image::RgbaImage::from_raw(256, 1, pixels) {
        Some(img) => {
            if let Err(e) = img.save(path) {
                eprintln!("cargo:warning=Failed to save fire.png: {e}");
            }
        }
        None => eprintln!("cargo:warning=Failed to build fire.png pixel buffer"),
    }
}

/// Fire gradient: dim ember-red (t=0) → deep red → orange → bright yellow-white (t=1).
/// The first sample is deliberately non-zero so LUT tests can verify the file was loaded.
fn fire_color(t: f32) -> (f32, f32, f32) {
    if t < 0.25 {
        // Dim ember-red → deep red
        let u = t / 0.25;
        (0.10 + u * 0.60, 0.0, 0.0)
    } else if t < 0.55 {
        // Deep red → orange
        let u = (t - 0.25) / 0.30;
        (0.7 + u * 0.3, u * 0.35, 0.0)
    } else if t < 0.80 {
        // Orange → bright yellow
        let u = (t - 0.55) / 0.25;
        (1.0, 0.35 + u * 0.55, u * 0.05)
    } else {
        // Yellow → near-white
        let u = (t - 0.80) / 0.20;
        (1.0, 0.90 + u * 0.10, 0.05 + u * 0.70)
    }
}
