#include "threshold.h"

#include "ntru.h"

#include <algorithm>
#include <stdexcept>

namespace ntru {

int ThresholdCtx::find(uint32_t subset, int proxy) const {
    if (proxy < 0 || proxy >= (int)per_proxy.size()) return -1;
    const auto& v = per_proxy[proxy];
    for (int j = 0; j < (int)v.size(); ++j)
        if (v[j].subset == subset) return j;
    return -1;
}

static inline int popcount32(uint32_t x) {
#if defined(__GNUC__)
    return __builtin_popcount(x);
#else
    int c = 0;
    while (x) { c += (x & 1); x >>= 1; }
    return c;
#endif
}

ThresholdCtx cnf_share(const Params& P, const Poly& rk, int n, int t, Rng& rng) {
    if (n < 2 || t < 1 || t > n) throw std::invalid_argument("cnf_share: n/t 非法");
    if (n > 20) throw std::invalid_argument("cnf_share: n > 20 时子集枚举代价过高（骨架限制）");

    ThresholdCtx ctx;
    ctx.n = n;
    ctx.t = t;
    ctx.subset_size = n - t + 1;
    ctx.per_proxy.assign(n, {});

    // 枚举所有 popcount == subset_size 的子集
    for (uint32_t mask = 0; mask < (1u << n); ++mask)
        if (popcount32(mask) == ctx.subset_size) ctx.subsets.push_back(mask);
    if (ctx.subsets.empty()) throw std::invalid_argument("cnf_share: 子集为空");

    // 前 |subsets|-1 份均匀随机，最后一份由"总和 = rk"反解
    std::vector<Poly> vals;
    vals.reserve(ctx.subsets.size());
    Poly acc = poly_zero(P.n);
    for (std::size_t i = 0; i + 1 < ctx.subsets.size(); ++i) {
        Poly v = sample_uniform(P.n, P.q, rng);
        acc = poly_add(acc, v, P.q);
        vals.push_back(v);
    }
    vals.push_back(poly_sub(rk, acc, P.q));   // 最后一份

    for (std::size_t i = 0; i < ctx.subsets.size(); ++i) {
        Share sh;
        sh.subset = ctx.subsets[i];
        sh.value = vals[i];
        for (int p = 0; p < n; ++p)
            if (ctx.subsets[i] & (1u << p)) ctx.per_proxy[p].push_back(sh);
    }
    return ctx;
}

std::vector<std::vector<Poly>> proxy_partials(const Params& P, const ThresholdCtx& ctx,
                                              const Poly& cA, Rng& rng, int de) {
    const int w = (de < 0) ? P.dr : de;
    std::vector<std::vector<Poly>> out(ctx.n);
    for (int i = 0; i < ctx.n; ++i) {
        out[i].reserve(ctx.per_proxy[i].size());
        for (const Share& sh : ctx.per_proxy[i]) {
            Poly e = to_mod_q(sample_fixed_weight(P.n, w, w, rng), P.q);
            Poly cs = poly_mul_fast(cA, sh.value, P.q);   // C_A * share
            Poly pe = poly_mul_const(e, P.p, P.q);        // p * e
            out[i].push_back(poly_add(cs, pe, P.q));
        }
    }
    return out;
}

Poly threshold_combine(const Params& P, const ThresholdCtx& ctx,
                       const std::vector<std::vector<Poly>>& partials,
                       const std::vector<int>& W) {
    if ((int)W.size() != ctx.t) throw std::invalid_argument("threshold_combine: |W| 必须等于 t");

    Poly acc = poly_zero(P.n);
    for (uint32_t S : ctx.subsets) {
        // owner = min(S ∩ W)
        int owner = -1;
        for (int p : W) {
            if (S & (1u << p)) {
                if (owner < 0 || p < owner) owner = p;
            }
        }
        // 由 |S| = n-t+1 > n-t = |[n]\W| 可知 S ∩ W 必非空
        if (owner < 0) throw std::logic_error("threshold_combine: 子集与参与集合不相交（不应发生）");
        int j = ctx.find(S, owner);
        if (j < 0) throw std::logic_error("threshold_combine: 代理未持有该份额（不应发生）");
        acc = poly_add(acc, partials[owner][j], P.q);
    }
    return acc;
}

ThresholdResult threshold_reencrypt_checked(const Params& P, const ThresholdCtx& ctx,
                                            const Poly& cA, const Poly& fB, const Poly& m_center,
                                            const std::vector<int>& W, Rng& rng, int de) {
    ThresholdResult r;
    r.subsets_used = ctx.num_subsets();
    auto partials = proxy_partials(P, ctx, cA, rng, de);
    r.ct = threshold_combine(P, ctx, partials, W);
    Poly dec = decrypt_with_noise(P, fB, r.ct, r.noise_inf);
    r.ok = (dec.size() == m_center.size());
    if (r.ok) {
        for (std::size_t i = 0; i < dec.size(); ++i) {
            if (dec[i] != m_center[i]) {
                r.ok = false;
                break;
            }
        }
    }
    return r;
}

}  // namespace ntru
