// ============================================================================
//  基线 NTRUReEncrypt（论文 §3.2）：ReKeyGen / ReEnc
//  文件名：src/core/pre_base.h
//
//    rk_{A->B} = f_A * f_B^{-1} mod q        （单向、非交互）
//    C_B       = C_A * rk + p * e            （p*e 用来挡住接收者反推 f_A）
//
//  已知安全性问题（报告里必须写清，不能回避）：
//    * rk * f_B = f_A —— 代理与接收者一合谋就直接拿到委托方私钥；
//    * rk 是"小多项式除以小多项式"的形状，可用多密钥 NTRU 格攻击恢复私钥
//      （Liu-Pan-Zhang, ePrint 2019/083；及其 2024 年多项式时间版本）。
//  本项目的目标不是"修好它"，而是把单点信任改成 t-of-n 门限（见 threshold.h）。
// ============================================================================
#pragma once

#include "params.h"
#include "ring.h"
#include "sampler.h"

#include <cstdint>

namespace ntru {

// rk_{A->B} = f_A * f_B^{-1} mod q
Poly rekeygen(const Params& P, const Poly& fA, const Poly& fBinv);

// C_B = C_A * rk + p * e；de < 0 表示用 P.dr 作为噪声重量
Poly reencrypt(const Params& P, const Poly& cA, const Poly& rk, Rng& rng, int de = -1);

struct ReEncResult {
    Poly ct;
    int64_t noise_inf;   // ||center(f_B * C_B)||_inf
    bool ok;             // 解密结果是否与原文一致
};

// 完整跑一遍：重加密 + 用 f_B 解密 + 与 m_center 比对
ReEncResult reencrypt_checked(const Params& P, const Poly& fB, const Poly& cA, const Poly& rk,
                              const Poly& m_center, Rng& rng, int de = -1);

}  // namespace ntru
