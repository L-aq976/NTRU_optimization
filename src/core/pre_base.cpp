#include "pre_base.h"

#include "ntru.h"

namespace ntru {

Poly rekeygen(const Params& P, const Poly& fA, const Poly& fBinv) {
    return poly_mul_fast(fA, fBinv, P.q);
}

Poly reencrypt(const Params& P, const Poly& cA, const Poly& rk, Rng& rng, int de) {
    const int w = (de < 0) ? P.dr : de;
    Poly e = to_mod_q(sample_fixed_weight(P.n, w, w, rng), P.q);
    Poly crk = poly_mul_fast(cA, rk, P.q);
    Poly pe = poly_mul_const(e, P.p, P.q);
    return poly_add(crk, pe, P.q);
}

ReEncResult reencrypt_checked(const Params& P, const Poly& fB, const Poly& cA, const Poly& rk,
                              const Poly& m_center, Rng& rng, int de) {
    ReEncResult r;
    r.ct = reencrypt(P, cA, rk, rng, de);
    Poly dec = decrypt_with_noise(P, fB, r.ct, r.noise_inf);
    if (m_center.size() == dec.size()) {
        r.ok = true;
        for (std::size_t i = 0; i < dec.size(); ++i) {
            if (dec[i] != m_center[i]) {
                r.ok = false;
                break;
            }
        }
    } else {
        r.ok = false;
    }
    return r;
}

}  // namespace ntru
