#include "sampler.h"

#include <algorithm>
#include <numeric>
#include <stdexcept>
#include <vector>

namespace ntru {

Rng Rng::from_entropy() {
    std::random_device rd;
    uint64_t s = ((uint64_t)rd() << 32) ^ (uint64_t)rd();
    return Rng(s);
}

uint32_t Rng::uniform_below(uint32_t bound) {
    if (bound == 0) throw std::invalid_argument("uniform_below(0)");
    // 拒绝采样保证无偏（避免 % bound 的偏差 —— 对密码实现是硬要求）
    const uint64_t limit = (uint64_t)0xFFFFFFFFFFFFFFFFULL - ((uint64_t)0xFFFFFFFFFFFFFFFFULL % bound);
    uint64_t x;
    do {
        x = next_u64();
    } while (x >= limit);
    return (uint32_t)(x % bound);
}

Poly sample_fixed_weight(int n, int plus, int minus, Rng& rng) {
    if (plus < 0 || minus < 0 || plus + minus > n)
        throw std::invalid_argument("sample_fixed_weight: 重量非法");
    Poly a(n, 0);
    std::vector<int> idx(n);
    std::iota(idx.begin(), idx.end(), 0);
    // Fisher-Yates 部分洗牌：只需要前 plus+minus 个位置
    for (int i = 0; i < plus + minus; ++i) {
        uint32_t j = i + rng.uniform_below((uint32_t)(n - i));
        std::swap(idx[i], idx[j]);
    }
    for (int i = 0; i < plus; ++i) a[idx[i]] = 1;
    for (int i = plus; i < plus + minus; ++i) a[idx[i]] = -1;
    return a;
}

Poly sample_message(const Params& P, Rng& rng) {
    Poly t = sample_fixed_weight(P.n, P.dm0, P.dm1, rng);
    Poly m(P.n, 0);
    for (int i = 0; i < P.n; ++i) m[i] = mod_q(t[i], P.p);
    return m;
}

Poly sample_uniform(int n, int64_t q, Rng& rng) {
    Poly a(n, 0);
    for (int i = 0; i < n; ++i) a[i] = (int64_t)rng.uniform_below((uint32_t)q);
    return a;
}

Poly to_mod_q(const Poly& a, int64_t q) {
    Poly b(a.size(), 0);
    for (std::size_t i = 0; i < a.size(); ++i) b[i] = mod_q(a[i], q);
    return b;
}

Poly message_to_center(const Poly& m, int64_t p) {
    Poly c(m.size(), 0);
    for (std::size_t i = 0; i < m.size(); ++i) {
        int64_t v = mod_q(m[i], p);
        if (v > p / 2) v -= p;
        c[i] = v;
    }
    return c;
}

}  // namespace ntru
