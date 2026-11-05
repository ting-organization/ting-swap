//! `pack <linked.wasm> <out.wasm>`: the deployable module (see the library).
use std::{env, fs, process};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: pack <linked.wasm> <out.wasm>");
        process::exit(2);
    }
    let linked = fs::read(&args[1]).expect("read the linked module");
    let packed = ting_swap_tools::pack(&linked).unwrap_or_else(|e| {
        eprintln!("pack: {e}");
        process::exit(1);
    });
    fs::write(&args[2], &packed).expect("write the packed module");
    let code_hash = ting_core::hash::hash("code", &packed);
    println!(
        "{}: {} bytes, CodeHash {}",
        args[2],
        packed.len(),
        ting_core::hash::hex(&code_hash)
    );
}
