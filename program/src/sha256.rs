//! SHA-256 (FIPS 180-4) and Ting's domain-separated hash over it,
//! `H(tag, x) = SHA256("Ting/" ‖ u16(len(tag)) ‖ tag ‖ x)` (wiki: data/encoding).
//! The compression is a `const fn`, so the program's fixed hashes, such as its
//! templates' (TCR-1), are computed when it is compiled.

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const INIT: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

pub struct Sha256 {
    state: [u32; 8],
    block: [u8; 64],
    filled: usize,
    total: u64,
}

impl Sha256 {
    pub fn new() -> Self {
        Self {
            state: INIT,
            block: [0; 64],
            filled: 0,
            total: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.total = self.total.wrapping_add(data.len() as u64);
        while !data.is_empty() {
            let take = (64 - self.filled).min(data.len());
            self.block[self.filled..self.filled + take].copy_from_slice(&data[..take]);
            self.filled += take;
            data = &data[take..];
            if self.filled == 64 {
                compress(&mut self.state, &self.block);
                self.filled = 0;
            }
        }
    }

    pub fn finish(mut self) -> [u8; 32] {
        let bits = self.total.wrapping_mul(8);
        self.block[self.filled] = 0x80;
        self.block[self.filled + 1..].fill(0);
        if self.filled >= 56 {
            compress(&mut self.state, &self.block);
            self.block.fill(0);
        }
        self.block[56..].copy_from_slice(&bits.to_be_bytes());
        compress(&mut self.state, &self.block);
        digest(&self.state)
    }
}

const fn digest(state: &[u32; 8]) -> [u8; 32] {
    let mut out = [0; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (state[i / 4] >> (24 - 8 * (i % 4))) as u8;
        i += 1;
    }
    out
}

const fn compress(state: &mut [u32; 8], block: &[u8; 64]) {
    let mut w = [0u32; 64];
    let mut i = 0;
    while i < 16 {
        w[i] = u32::from_be_bytes([
            block[i * 4],
            block[i * 4 + 1],
            block[i * 4 + 2],
            block[i * 4 + 3],
        ]);
        i += 1;
    }
    while i < 64 {
        let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
        let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16]
            .wrapping_add(s0)
            .wrapping_add(w[i - 7])
            .wrapping_add(s1);
        i += 1;
    }
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
    i = 0;
    while i < 64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let ch = (e & f) ^ (!e & g);
        let t1 = h
            .wrapping_add(s1)
            .wrapping_add(ch)
            .wrapping_add(K[i])
            .wrapping_add(w[i]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let maj = (a & b) ^ (a & c) ^ (b & c);
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(s0.wrapping_add(maj));
        i += 1;
    }
    let v = [a, b, c, d, e, f, g, h];
    i = 0;
    while i < 8 {
        state[i] = state[i].wrapping_add(v[i]);
        i += 1;
    }
}

/// Ting's `H(tag, parts…)`, the parts concatenated.
pub fn tagged(tag: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"Ting/");
    hasher.update(&(tag.len() as u16).to_le_bytes());
    hasher.update(tag);
    for part in parts {
        hasher.update(part);
    }
    hasher.finish()
}

/// `H(tag, data)` at compile time.
pub const fn tagged_const(tag: &[u8], data: &[u8]) -> [u8; 32] {
    let head = 5 + 2 + tag.len();
    let total = head + data.len();
    let padded = (total + 9).div_ceil(64) * 64;
    let bits = (total as u64) * 8;
    let mut state = INIT;
    let mut block = [0u8; 64];
    let mut p = 0;
    while p < padded {
        block[p % 64] = if p < 5 {
            b"Ting/"[p]
        } else if p < 7 {
            (tag.len() >> (8 * (p - 5))) as u8
        } else if p < head {
            tag[p - 7]
        } else if p < total {
            data[p - head]
        } else if p == total {
            0x80
        } else if p >= padded - 8 {
            (bits >> (8 * (padded - 1 - p))) as u8
        } else {
            0
        };
        if p % 64 == 63 {
            compress(&mut state, &block);
        }
        p += 1;
    }
    digest(&state)
}
