#!/bin/sh
# Builds swap.wasm: compiles the program for wasm32v1-none, then packs it
# into a canonical module that Ting's profile accepts.
set -e
cd "$(dirname "$0")"
(cd program && cargo build --release --locked)
cargo run --quiet --release --locked --package ting-swap-tools --bin pack -- \
  program/target/wasm32v1-none/release/ting_swap_program.wasm swap.wasm
