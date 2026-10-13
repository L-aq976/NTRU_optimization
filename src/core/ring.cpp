#include "ring.h"

#include <algorithm>
#include <sstream>
#include <stdexcept>

namespace ntru {

Poly poly_zero(std::size_t n) { return Poly(n, 0); }

int poly_deg(const Poly& a) {
    for (int i = (int)a.size() - 1; i >= 0; --i)
        if (a[i] != 0) return i;
    return -1;
}

bool poly_is_zero(const Poly& a) {
    for (int64_t v : a)
        if (v != 0) return false;
    return true;
}

bool poly_equal(const Poly& a, const Poly& b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (a[i] != b[i]) return false;
    return true;
}

std::size_t poly_nonzero(const Poly& a) {
    std::size_t c = 0;
    for (int64_t v : a)
        if (v != 0) ++c;
    return c;
}

Poly poly_add(const Poly& a, const Poly& b, int64_t q) {
    Poly c(a.size());
    for (std::size_t i = 0; i < a.size(); ++i) c[i] = mod_q(a[i] + b[i], q);
    return c;
}

Poly poly_sub(const Poly& a, const Poly& b, int64_t q) {
    Poly c(a.size());
    for (std::size_t i = 0; i < a.size(); ++i) c[i] = mod_q(a[i] - b[i], q);
    return c;
}

Poly poly_neg(const Poly& a, int64_t q) {
    Poly c(a.size());
    for (std::size_t i = 0; i < a.size(); ++i) c[i] = (a[i] == 0) ? 0 : q - a[i];
    return c;
}

Poly poly_mul_const(const Poly& a, int64_t k, int64_t q) {
    Poly c(a.size());
    for (std::size_t i = 0; i < a.size(); ++i) c[i] = mod_q(a[i] * mod_q(k, q), q);
    return c;
}

// ---------------------------------------------------------------------------
// 参考实现：每一项单独归约 —— 慢但绝不溢出，用作正确性基准
// ---------------------------------------------------------------------------
Poly poly_mul_ref(const Poly& a, const Poly& b, int64_t q) {
    const int n = (int)a.size();
    Poly c(n, 0);
    for (int i = 0; i < n; ++i) {
        const int64_t ai = a[i];
        if (ai == 0) continue;
        for (int j = 0; j < n; ++j) {
            int k = i + j;
            if (k >= n) k -= n;                       // x^n = 1（循环卷积）
            c[k] = (c[k] + ai * b[j]) % q;
        }
    }
    return c;
}

// ---------------------------------------------------------------------------
// 快速实现：
//   把内层循环按 j = k-i 的两段拆开，避免 k-i<0 的分支，让 GCC 自动向量化；
//   用 int64 累加，并按块做模归约（q 为 2 的幂时用位与，否则用取模）。
//   参考：NTRUReEncrypt_GPU/bench/cpu_splitloop.c（同一套思路）
// ---------------------------------------------------------------------------
Poly poly_mul_fast(const Poly& a, const Poly& b, int64_t q) {
    const int n = (int)a.size();
    Poly c(n, 0);
    const bool pow2 = is_pow2(q);
    const int64_t mask = q - 1;

    // 分块大小：保证 chunk * (q-1)^2 不超过 2^62
    const int64_t qm1 = q - 1;
    int64_t per = qm1 * qm1;
    if (per <= 0) per = 1;                            // 防御：q 过大时下面退化为逐项归约
    int64_t max_terms = (int64_t)4611686018427387904LL / per;  // ~2^62
    if (max_terms < 1) max_terms = 1;
    int chunk = (int)std::min<int64_t>(max_terms, (int64_t)n);
    if (chunk < 1) chunk = 1;

    for (int k = 0; k < n; ++k) {
        int64_t acc = 0;
        int cnt = 0;
        // 第一段：i = 0..k  ->  j = k-i
        for (int i = 0; i <= k; ++i) {
            acc += a[i] * b[k - i];
            if (++cnt == chunk) { acc = pow2 ? (acc & mask) : (acc % q); cnt = 0; }
        }
        // 第二段：i = k+1..n-1  ->  j = k-i+n
        for (int i = k + 1; i < n; ++i) {
            acc += a[i] * b[k - i + n];
            if (++cnt == chunk) { acc = pow2 ? (acc & mask) : (acc % q); cnt = 0; }
        }
        c[k] = pow2 ? (acc & mask) : (acc % q);
    }
    return c;
}

// ---------------------------------------------------------------------------
// 优化实现（SIMD 友好）：行式循环 + int16 系数 + int32 累加 + 分块归约
//
//   for each i:  acc[(i+j) mod n] += a[i]*b[j]      （拆成两段连续区间）
//   每累加 BLK 项后把 acc 归约一次（acc &= q-1），保证 int32 不溢出。
//   这是性能工作的起点：CUDA/OpenMP/寄存器分块都在这个结构上做。
// ---------------------------------------------------------------------------
Poly poly_mul_i32(const Poly& a, const Poly& b, int64_t q) {
    const int n = (int)a.size();
    if (!is_pow2(q) || q > 2048)
        throw std::invalid_argument("poly_mul_i32: 仅支持 q 为 2 的幂且 q <= 2048");

    const int32_t mask = (int32_t)(q - 1);
    const int64_t qm1 = q - 1;
    int64_t blk64 = ((int64_t)1 << 30) / (qm1 * qm1);  // 保证 BLK*(q-1)^2 < 2^30
    int BLK = (int)(blk64 < n ? blk64 : n);
    if (BLK < 1) BLK = 1;

    std::vector<int16_t> aa(n), bb(n);
    for (int i = 0; i < n; ++i) {
        aa[i] = (int16_t)a[i];
        bb[i] = (int16_t)b[i];
    }
    std::vector<int32_t> acc(n, 0);

    for (int i = 0; i < n; ++i) {
        const int32_t ai = aa[i];
        if (ai == 0) continue;
        const int m = n - i;                       // 第一段：j = 0..m-1 -> 下标 i+j
        for (int j0 = 0; j0 < m; j0 += BLK) {
            const int j1 = (j0 + BLK < m) ? (j0 + BLK) : m;
            int32_t* ap = acc.data() + i + j0;
            const int16_t* bp = bb.data() + j0;
            const int len = j1 - j0;
            for (int j = 0; j < len; ++j) ap[j] += ai * (int32_t)bp[j];
            for (int j = 0; j < len; ++j) ap[j] &= mask;
        }
        for (int j0 = 0; j0 < i; j0 += BLK) {      // 第二段：j = m..n-1 -> 下标 j-m
            const int j1 = (j0 + BLK < i) ? (j0 + BLK) : i;
            int32_t* ap = acc.data() + j0;
            const int16_t* bp = bb.data() + m + j0;
            const int len = j1 - j0;
            for (int j = 0; j < len; ++j) ap[j] += ai * (int32_t)bp[j];
            for (int j = 0; j < len; ++j) ap[j] &= mask;
        }
    }

    Poly c(n, 0);
    for (int k = 0; k < n; ++k) c[k] = acc[k] & mask;
    return c;
}

// ---------------------------------------------------------------------------
// 中心代表 / 范数 / 模 p
// ---------------------------------------------------------------------------
Poly poly_center(const Poly& a, int64_t q) {
    Poly c(a.size());
    const int64_t half = q / 2;
    for (std::size_t i = 0; i < a.size(); ++i) {
        int64_t v = a[i] % q;
        if (v > half) v -= q;                         // 值域 (-q/2, q/2]
        c[i] = v;
    }
    return c;
}

int64_t poly_inf_norm_center(const Poly& a, int64_t q) {
    Poly c = poly_center(a, q);
    int64_t m = 0;
    for (int64_t v : c) m = std::max<int64_t>(m, v < 0 ? -v : v);
    return m;
}

Poly poly_mod_p(const Poly& a, int64_t q, int64_t p) {
    Poly c = poly_center(a, q);
    for (auto& v : c) v = mod_q(v, p);
    return c;
}

Poly poly_mod_p_centered(const Poly& a, int64_t q, int64_t p) {
    Poly c(a.size());
    const int64_t half = q / 2;
    for (std::size_t i = 0; i < a.size(); ++i) {
        int64_t v = a[i] % q;
        if (v > half) v -= q;
        int64_t r = v % p;
        if (r > p / 2) r -= p;                        // 映射到 (-p/2, p/2]
        else if (r < -(p / 2)) r += p;
        c[i] = r;
    }
    return c;
}

int64_t poly_sum_center(const Poly& a, int64_t q) {
    Poly c = poly_center(a, q);
    int64_t s = 0;
    for (int64_t v : c) s += v;
    return s;
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------
std::string poly_to_string(const Poly& a) {
    std::ostringstream os;
    for (std::size_t i = 0; i < a.size(); ++i) {
        if (i) os << ',';
        os << a[i];
    }
    return os.str();
}

Poly poly_from_string(const std::string& s) {
    Poly a;
    std::stringstream ss(s);
    std::string tok;
    while (std::getline(ss, tok, ',')) {
        if (tok.empty()) continue;
        a.push_back(std::stoll(tok));
    }
    return a;
}

}  // namespace ntru
