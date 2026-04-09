PREFIX ?= /usr/local
BINDIR ?= $(PREFIX)/bin
SHAREDIR ?= $(PREFIX)/share/hyprsaver

.PHONY: build release install uninstall clean

build:
	cargo build

release:
	cargo build --release

install: release
	install -Dm755 target/release/hyprsaver $(DESTDIR)$(BINDIR)/hyprsaver
	install -dm755 $(DESTDIR)$(SHAREDIR)/examples
	install -Dm644 examples/hypridle.conf $(DESTDIR)$(SHAREDIR)/examples/hypridle.conf
	install -Dm644 examples/hyprland.conf $(DESTDIR)$(SHAREDIR)/examples/hyprland.conf
	install -Dm644 examples/hyprsaver.toml $(DESTDIR)$(SHAREDIR)/examples/hyprsaver.toml
	install -Dm644 config.example.toml $(DESTDIR)$(SHAREDIR)/config.example.toml

uninstall:
	rm -f $(DESTDIR)$(BINDIR)/hyprsaver
	rm -rf $(DESTDIR)$(SHAREDIR)

clean:
	cargo clean
