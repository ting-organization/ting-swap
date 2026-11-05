//! Packs a linked module for deployment: drops custom sections and every export
//! but `invoke` and `memory`, and re-encodes everything in its shortest form
//! (wiki: vm/profile, one encoding).
use wasm_encoder::reencode::{self, Reencode};

struct Pack;

impl Reencode for Pack {
    type Error = std::convert::Infallible;

    fn parse_custom_section(
        &mut self,
        _: &mut wasm_encoder::Module,
        _: wasmparser::CustomSectionReader<'_>,
    ) -> Result<(), reencode::Error<Self::Error>> {
        Ok(())
    }

    fn parse_export(
        &mut self,
        exports: &mut wasm_encoder::ExportSection,
        export: wasmparser::Export<'_>,
    ) -> Result<(), reencode::Error<Self::Error>> {
        if export.name == "invoke" || export.name == "memory" {
            reencode::utils::parse_export(self, exports, export)?;
        }
        Ok(())
    }
}

/// The packed module, checked against Ting's execution profile.
pub fn pack(linked: &[u8]) -> Result<Vec<u8>, String> {
    let mut module = wasm_encoder::Module::new();
    reencode::utils::parse_core_module(&mut Pack, &mut module, wasmparser::Parser::new(0), linked)
        .map_err(|e| format!("cannot re-encode the module: {e}"))?;
    let packed = module.finish();
    ting_core::vm::profile::validate(&packed)
        .map_err(|e| format!("the module is outside Ting's profile: {e}"))?;
    Ok(packed)
}
