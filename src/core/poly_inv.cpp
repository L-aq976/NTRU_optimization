#include "poly_inv.h"

#include <algorithm>

namespace ntru {

// ---------------------------------------------------------------------------
// 位向量小工具
// ---------------------------------------------------------------------------
static inline bool bit_get(const Bits& b, int i) {
    return (b[i >> 6] >> (i & 63)) & 1ULL;
}
static inline void bit_set(Bits& b, int i) { b[i >> 6] |= (1ULL << (i & 63)); }
static inline void bit_flip(Bits& b, int i) { b[i >> 6] ^= (1ULL << (i & 63)); }

static int bits_deg(const Bits& b) {
    for (int w = (int)b.size() - 1; w >= 0; --w) {
        if (b[w]) {
            for (int j = 63; j >= 0; --j)
                if ((b[w] >> j) & 1ULL) return w * 64 + j;
        }
    }
    return -1;
}

static bool bits_is_zero(const Bits& b) {
    for (uint64_t w : b)
        if (w) return false;
    return true;
}

// dst ^= src << shift
static void bits_xor_shifted(Bits& dst, const Bits& src, int shift) {
    const int ws = shift >> 6, bs = shift & 63;
    for (std::size_t i = 0; i < src.size(); ++i) {
        uint64_t v = src[i];
        if (!v) continue;
        std::size_t j = i + ws;
        if (j < dst.size()) dst[j] ^= (v << bs);
        if (bs && (j + 1) < dst.size()) dst[j + 1] ^= (v >> (64 - bs));
    }
}

static Bits bits_mul_gf2(const Bits& a, const Bits& b) {
    Bits r(a.size() + b.size() + 1, 0);
    for (std::size_t i = 0; i < a.size(); ++i) {
        uint64_t w = a[i];
        while (w) {
            int bit = __builtin_ctzll(w);
            w &= (w - 1);
            bits_xor_shifted(r, b, (int)(i * 64) + bit);
        }
    }
    return r;
}

// a = q*b + r  （GF(2)[x] 上的带余除法）
static void bits_divmod(const Bits& a, const Bits& b, Bits& qq, Bits& rr) {
    rr = a;
    qq.assign(a.size(), 0);
    const int db = bits_deg(b);
    int da = bits_deg(rr);
    while (da >= db && da >= 0) {
        const int shift = da - db;
        bits_xor_shifted(rr, b, shift);
        bit_set(qq, shift);
        da = bits_deg(rr);
    }
}

// 把 x^n - 1 的倍数折叠掉：x^i (i >= n) -> x^{i-n}
static Bits bits_reduce_mod_xn_minus_1(const Bits& in, int n) {
    Bits b = in;
    for (int i = bits_deg(b); i >= n; --i) {
        if (bit_get(b, i)) {
            bit_flip(b, i);
            bit_flip(b, i - n);
        }
    }
    return b;
}

// ---------------------------------------------------------------------------
// 1) mod 2 求逆（扩展欧几里得）
// ---------------------------------------------------------------------------
bool inv_mod2_poly(const Bits& f_in, int n, Bits& out) {
    const std::size_t words = (std::size_t)(n + 64) / 64 + 1;
    Bits r0(words, 0), r1(words, 0), t0(words, 0), t1(words, 0);

    r0[0] = 1ULL;                                  // x^n - 1 = x^n + 1 (GF(2) 上 -1 = 1)
    bit_set(r0, n);
    r1 = bits_reduce_mod_xn_minus_1(f_in, n);      // 保险：先把 f 折叠到 deg < n
    bit_set(t1, 0);                                // t1 = 1

    while (!bits_is_zero(r1)) {
        Bits qq, rr;
        bits_divmod(r0, r1, qq, rr);

        r0 = r1;
        r1 = rr;

        Bits qt = bits_mul_gf2(qq, t1);
        Bits nt = t0;
        for (std::size_t i = 0; i < nt.size() && i < qt.size(); ++i) nt[i] ^= qt[i];
        nt = bits_reduce_mod_xn_minus_1(nt, n);

        t0 = t1;
        t1 = nt;
    }

    if (bits_deg(r0) != 0) return false;           // gcd(f, x^n-1) != 1
    out = bits_reduce_mod_xn_minus_1(t0, n);
    return true;
}

// ---------------------------------------------------------------------------
// 2) Hensel/Newton 提升到 mod q
// ---------------------------------------------------------------------------
bool poly_inv_mod_q(const Poly& f, int64_t q, Poly& out) {
    const int n = (int)f.size();
    if (!is_pow2(q)) return false;                 // 骨架只支持 2 的幂模数
    if (q > (int64_t)1 << 16) return false;        // 提升精度上限（q = 2^11 用不到）

    // f mod 2
    Bits fb((std::size_t)(n + 64) / 64 + 1, 0);
    for (int i = 0; i < n; ++i)
        if (f[i] & 1) bit_set(fb, i);

    Bits g2;
    if (!inv_mod2_poly(fb, n, g2)) return false;

    Poly g(n, 0);
    for (int i = 0; i < n; ++i) g[i] = bit_get(g2, i) ? 1 : 0;

    // 在 mod 2^16 下做 4 次 Newton 提升：1 -> 2 -> 4 -> 8 -> 16 位
    const int64_t M = (int64_t)1 << 16;
    Poly fm(n, 0);
    for (int i = 0; i < n; ++i) fm[i] = f[i] & (M - 1);

    for (int it = 0; it < 4; ++it) {
        Poly fg = poly_mul_fast(fm, g, M);
        // h = 2 - f*g  —— 注意 "2" 是**常数多项式**（只有第 0 个系数是 2），
        // 不能写成"每个系数都减 2"（这是 Newton 提升最容易踩的坑）
        Poly h(n, 0);
        for (int i = 0; i < n; ++i) {
            const int64_t two_i = (i == 0) ? 2 : 0;
            h[i] = mod_q(two_i - fg[i], M);
        }
        g = poly_mul_fast(g, h, M);
    }

    out.assign(n, 0);
    for (int i = 0; i < n; ++i) out[i] = g[i] & (q - 1);

    // 自检：f * out == 1 (mod q)
    Poly chk = poly_mul_fast(f, out, q);
    Poly one = poly_zero((std::size_t)n);
    one[0] = 1;
    return poly_equal(chk, one);
}

bool poly_inv_mod_2048(const Poly& f, Poly& out) { return poly_inv_mod_q(f, 2048, out); }

}  // namespace ntru
