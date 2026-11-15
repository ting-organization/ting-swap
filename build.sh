#!/bin/sh
# Builds swap.wasm and htlc.wasm: compiles each program for wasm32v1-none,
# then packs it into a canonical module that Ting's profile accepts.
set -e
cd "$(dirname "$0")"
(cd program && cargo build --release --locked)
(cd htlc && cargo build --release --locked)
cargo run --quiet --release --locked --package ting-swap-tools --bin pack -- \
  program/target/wasm32v1-none/release/ting_swap_program.wasm swap.wasm
cargo run --quiet --release --locked --package ting-swap-tools --bin pack -- \
  htlc/target/wasm32v1-none/release/ting_swap_htlc.wasm htlc.wasm
