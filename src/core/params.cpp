#include "params.h"

#include <cmath>
#include <sstream>
#include <stdexcept>

namespace ntru {

int Params::log2_q() const noexcept {
    int k = 0;
    int64_t v = 1;
    while (v < q) {
        v <<= 1;
        ++k;
    }
    return k;
}

void Params::validate() const {
    std::ostringstream err;
    if (n <= 2) err << "n 必须 >= 3（实际 " << n << "）";
    if (q <= 2) err << "; q 必须 > 2（实际 " << q << "）";
    if (p <= 1) err << "; p 必须 > 1（实际 " << p << "）";
    if (df <= 0 || 2 * df >= n) err << "; df 非法（实际 " << df << "）";
    if (dg <= 0 || 2 * dg > n) err << "; dg 非法（实际 " << dg << "）";
    if (dr <= 0 || 2 * dr > n) err << "; dr 非法（实际 " << dr << "）";
    if (dm0 < 0 || dm1 < 0 || dm0 + dm1 > n) err << "; 明文权重非法";
    // f = 1 + p*F 要能取反，要求系数落在 [0, q)
    if (1 + p * df >= q) err << "; p*df 过大，f 系数超出 [0,q)";
    if (err.str().size()) throw std::invalid_argument("参数集 " + name + " 非法: " + err.str());
}

// ---------------------------------------------------------------------------
// EES 参数族：q = 2048, p = 3
// 与 A1-4_选题方案/multihop_failprob_gpu.py 中使用的参数一致
// ---------------------------------------------------------------------------
static Params make_ees(const char* name, int n, int df, int dg, int dr, int dm0, int dm1) {
    Params P;
    P.name = name;
    P.n = n;
    P.q = 2048;
    P.p = 3;
    P.df = df;
    P.dg = dg;
    P.dr = dr;
    P.dm0 = dm0;
    P.dm1 = dm1;
    return P;
}

const Params& param_ees439() {
    static const Params P = make_ees("EES439", 439, 146, 130, 126, 128, 128);
    return P;
}
const Params& param_ees1087() {
    static const Params P = make_ees("EES1087", 1087, 120, 362, 120, 120, 120);
    return P;
}
const Params& param_ees1171() {
    static const Params P = make_ees("EES1171", 1171, 106, 390, 106, 106, 106);
    return P;
}
const Params& param_ees1499() {
    static const Params P = make_ees("EES1499", 1499, 79, 499, 79, 79, 79);
    return P;
}

const Params& param_tiny7() {
    static const Params P = make_ees("TINY7", 7, 2, 2, 2, 1, 1);
    return P;
}
const Params& param_tiny61() {
    static const Params P = make_ees("TINY61", 61, 10, 10, 10, 5, 5);
    return P;
}

const Params& param_by_name(const std::string& name) {
    if (name == "EES439") return param_ees439();
    if (name == "EES1087") return param_ees1087();
    if (name == "EES1171") return param_ees1171();
    if (name == "EES1499") return param_ees1499();
    if (name == "TINY7") return param_tiny7();
    if (name == "TINY61") return param_tiny61();
    throw std::invalid_argument("未知参数集: " + name + "（可选 " + list_params() + "）");
}

std::string list_params() {
    return "EES439 | EES1087 | EES1171 | EES1499 | TINY7 | TINY61（后两个安全性为零，仅教学/测试）";
}

}  // namespace ntru
