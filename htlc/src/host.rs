//! The host functions of module `ting` this program uses, and safe wrappers
//! around them (Ting wiki: vm/host).
use alloc::vec::Vec;
use core::arch::wasm32;

#[link(wasm_import_module = "ting")]
unsafe extern "C" {
    fn input(out: *mut u8, capacity: u32) -> u32;
    fn context(selector: u32, out: *mut u8, capacity: u32) -> u32;
    fn storage_get(key: *const u8, out: *mut u8, capacity: u32) -> u32;
    fn storage_set(key: *const u8, value: *const u8, len: u32);
    fn storage_delete(key: *const u8);
    fn code_hash(target: *const u8, out: *mut u8, capacity: u32) -> u32;
    fn call(target: *const u8, input: *const u8, len: u32, budget: *const u8, flags: u32) -> u32;
    fn call_result(out: *mut u8, capacity: u32) -> u32;
    fn emit(payload: *const u8, len: u32);
    #[link_name = "return"]
    fn host_return(result: *const u8, len: u32);
    fn revert(result: *const u8, len: u32);
}

/// What a caller holds back from a child's budget (wiki: programs/conventions,
/// the budget reserve), in C, S, D, G.
const RESERVE: [u64; 4] = [500_000, 64, 65_536, 65_536];

const ABSENT: u32 = u32::MAX;

pub const ORDINARY: u32 = 0;
pub const READ_ONLY: u32 = 1;

pub fn read_input() -> Vec<u8> {
    let len = unsafe { input(core::ptr::null_mut(), 0) } as usize;
    let mut out = Vec::with_capacity(len);
    unsafe {
        input(out.as_mut_ptr(), len as u32);
        out.set_len(len);
    }
    out
}

fn context_bytes<const N: usize>(selector: u32) -> [u8; N] {
    let mut out = [0; N];
    unsafe { context(selector, out.as_mut_ptr(), N as u32) };
    out
}

pub fn chain_id() -> [u8; 32] {
    context_bytes(0)
}

pub fn self_id() -> [u8; 32] {
    context_bytes(2)
}

/// The calling ContractId, or none at top level.
pub fn caller() -> Option<[u8; 32]> {
    let tagged: [u8; 33] = context_bytes(3);
    if tagged[0] != 1 {
        return None;
    }
    let mut id = [0; 32];
    id.copy_from_slice(&tagged[1..]);
    Some(id)
}

/// The block timestamp.
pub fn now() -> u64 {
    u64::from_le_bytes(context_bytes(5))
}

/// Reads a record into `out` in one access: its length, or none when absent.
/// A record longer than `out` is not copied, and its length says so.
pub fn get_into(key: &[u8; 32], out: &mut [u8]) -> Option<usize> {
    let len = unsafe { storage_get(key.as_ptr(), out.as_mut_ptr(), out.len() as u32) };
    (len != ABSENT).then_some(len as usize)
}

pub fn set(key: &[u8; 32], value: &[u8]) {
    unsafe { storage_set(key.as_ptr(), value.as_ptr(), value.len() as u32) }
}

pub fn delete(key: &[u8; 32]) {
    unsafe { storage_delete(key.as_ptr()) }
}

/// The CodeHash of the contract `target`, or none when there is no such contract.
pub fn code_of(target: &[u8; 32]) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    let len = unsafe { code_hash(target.as_ptr(), out.as_mut_ptr(), 32) };
    (len == 32).then_some(out)
}

/// Calls `target` with everything left but the standard reserve, and returns
/// the child's status and result. 0 is success.
pub fn call_child(target: &[u8; 32], input: &[u8], flags: u32) -> (u32, Vec<u8>) {
    let left: [u8; 32] = context_bytes(8);
    let mut budget = [0u8; 32];
    for i in 0..4 {
        let mut word = [0; 8];
        word.copy_from_slice(&left[i * 8..i * 8 + 8]);
        let Some(child) = u64::from_le_bytes(word).checked_sub(RESERVE[i]) else {
            fail(b"insufficient budget");
        };
        budget[i * 8..i * 8 + 8].copy_from_slice(&child.to_le_bytes());
    }
    let status = unsafe {
        call(
            target.as_ptr(),
            input.as_ptr(),
            input.len() as u32,
            budget.as_ptr(),
            flags,
        )
    };
    if status == 128 {
        fail(b"insufficient budget");
    }
    let len = unsafe { call_result(core::ptr::null_mut(), 0) } as usize;
    let mut result = Vec::with_capacity(len);
    unsafe {
        call_result(result.as_mut_ptr(), len as u32);
        result.set_len(len);
    }
    (status, result)
}

pub fn emit_event(payload: &[u8]) {
    unsafe { emit(payload.as_ptr(), payload.len() as u32) }
}

pub fn finish(result: &[u8]) -> ! {
    unsafe { host_return(result.as_ptr(), result.len() as u32) };
    wasm32::unreachable()
}

pub fn fail(reason: &[u8]) -> ! {
    unsafe { revert(reason.as_ptr(), reason.len() as u32) };
    wasm32::unreachable()
}
