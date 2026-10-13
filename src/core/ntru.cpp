#include "ntru.h"

#include "poly_inv.h"

namespace ntru {

bool keygen(const Params& P, Rng& rng, KeyPair& kp, int max_tries) {
    const int n = P.n;
    kp.tries = 0;
    for (int t = 0; t < max_tries; ++t) {
        ++kp.tries;
        // F: df 个 +1、df 个 -1  =>  f(1) = 1 + p*(df - df) = 1（奇数，才可能 mod 2 可逆）
        Poly F = sample_fixed_weight(n, P.df, P.df, rng);
        Poly f_small(n, 0);
        for (int i = 0; i < n; ++i) f_small[i] = (i == 0 ? 1 : 0) + P.p * F[i];

        Poly f = to_mod_q(f_small, P.q);
        Poly finv;
        if (!poly_inv_mod_q(f, P.q, finv)) continue;   // f 不可逆 -> 重采

        Poly g = to_mod_q(sample_fixed_weight(n, P.dg, P.dg, rng), P.q);
        // h = p * g * f^{-1} mod q
        Poly gf = poly_mul_fast(g, finv, P.q);
        Poly h = poly_mul_const(gf, P.p, P.q);

        kp.f = f;
        kp.finv = finv;
        kp.g = g;
        kp.h = h;
        return true;
    }
    return false;
}

Poly encrypt(const Params& P, const Poly& h, const Poly& m, Rng& rng) {
    Poly s = to_mod_q(sample_fixed_weight(P.n, P.dr, P.dr, rng), P.q);
    Poly hs = poly_mul_fast(h, s, P.q);
    return poly_add(hs, to_mod_q(m, P.q), P.q);
}

Poly decrypt_with_noise(const Params& P, const Poly& f, const Poly& c, int64_t& noise_inf) {
    Poly a = poly_mul_fast(f, c, P.q);
    noise_inf = poly_inf_norm_center(a, P.q);
    return poly_mod_p_centered(a, P.q, P.p);
}

Poly decrypt(const Params& P, const Poly& f, const Poly& c) {
    int64_t dummy = 0;
    return decrypt_with_noise(P, f, c, dummy);
}

bool message_equal(const Params& P, const Poly& m_modp, const Poly& decrypted_center) {
    Poly a = message_to_center(m_modp, P.p);
    if (a.size() != decrypted_center.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (a[i] != decrypted_center[i]) return false;
    return true;
}

}  // namespace ntru
