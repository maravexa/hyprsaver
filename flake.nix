{
  description = "A Wayland-native screensaver for Hyprland — fractal shaders on wlr-layer-shell overlays";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, rust-overlay }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;

      pkgsFor = system: import nixpkgs {
        inherit system;
        overlays = [ rust-overlay.overlays.default ];
      };

      # Libraries needed to compile hyprsaver.
      buildInputsFor = pkgs: with pkgs; [
        wayland
        wayland-protocols
        libGL
        libxkbcommon
        mesa
      ];

      # Libraries which hyprsaver may need to locate dynamically at runtime.
      #
      # In particular, libwayland-client.so is loaded with dlopen(), so
      # ordinary ELF dependencies are not sufficient to make the loader
      # find it on NixOS.
      runtimeLibsFor = pkgs: with pkgs; [
        wayland
        libGL
        libxkbcommon
        mesa
      ];

      nativeBuildInputsFor = pkgs: with pkgs; [
        pkg-config
        cmake
      ];

    in {

      packages = forAllSystems (system:
        let
          pkgs = pkgsFor system;
        in {
          default = pkgs.rustPlatform.buildRustPackage {
            pname = "hyprsaver";
            version =
              (builtins.fromTOML (builtins.readFile ./Cargo.toml))
              .package.version;

            src = ./.;

            cargoLock.lockFile = ./Cargo.lock;

            nativeBuildInputs =
              (nativeBuildInputsFor pkgs) ++ [
                pkgs.patchelf
              ];

            buildInputs = buildInputsFor pkgs;

            # Used by pkg-config while compiling.
            PKG_CONFIG_PATH = with pkgs;
              lib.makeSearchPathOutput "dev" "lib/pkgconfig" [
                wayland
                mesa
                libxkbcommon
              ];

            postInstall = ''
              # Install example configs and assets.
              install -dm755 $out/share/hyprsaver/examples

              cp -r examples/palettes \
                $out/share/hyprsaver/examples/

              install -Dm644 examples/hyprsaver.toml \
                $out/share/hyprsaver/examples/hyprsaver.toml

              # Install man page if present.
              if [ -f doc/hyprsaver.1 ]; then
                install -Dm644 doc/hyprsaver.1 \
                  $out/share/man/man1/hyprsaver.1
              fi
            '';

            # hyprsaver uses dlopen() for Wayland/GL libraries.
            #
            # These libraries therefore don't necessarily appear in the
            # executable's normal ELF NEEDED entries. Add their Nix store
            # library directories to the ELF runtime search path instead
            # of relying on LD_LIBRARY_PATH.
            postFixup = ''
              patchelf \
                --add-rpath ${pkgs.lib.makeLibraryPath (runtimeLibsFor pkgs)} \
                $out/bin/hyprsaver
            '';

            meta = with pkgs.lib; {
              description =
                "A Wayland-native screensaver for Hyprland — fractal shaders on wlr-layer-shell overlays";

              longDescription = ''
                hyprsaver renders GLSL fragment shaders as fullscreen overlays
                on every connected monitor using the wlr-layer-shell Wayland
                protocol. It is designed to complement hyprlock and hypridle.
              '';

              homepage = "https://github.com/maravexa/hyprsaver";
              license = licenses.mit;
              maintainers = [ ];
              platforms = platforms.linux;
              mainProgram = "hyprsaver";
            };
          };
        }
      );

      devShells = forAllSystems (system:
        let
          pkgs = pkgsFor system;
        in {
          default = pkgs.mkShell {
            nativeBuildInputs =
              (nativeBuildInputsFor pkgs) ++ [
                (pkgs.rust-bin.stable.latest.default.override {
                  extensions = [
                    "rust-src"
                    "rustfmt"
                    "clippy"
                    "rust-analyzer"
                  ];
                })
              ];

            buildInputs = buildInputsFor pkgs;

            PKG_CONFIG_PATH = with pkgs;
              lib.makeSearchPathOutput "dev" "lib/pkgconfig" [
                wayland
                mesa
                libxkbcommon
              ];

            # Useful for development binaries which use dlopen().
            # The packaged executable does NOT depend on this because
            # its RPATH is patched above.
            shellHook = ''
              export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath (runtimeLibsFor pkgs)}:''${LD_LIBRARY_PATH:-}"

              echo "hyprsaver dev shell — $(rustc --version 2>/dev/null || echo 'rustc not on PATH yet')"
            '';
          };
        }
      );

      overlays.default = final: _prev: {
        hyprsaver = self.packages.${final.system}.default;
      };
    };
}
