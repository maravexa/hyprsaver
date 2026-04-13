#!/bin/bash
cargo build --release
sudo install -Dm755 target/release/hyprsaver /usr/local/sbin/hyprsaver
