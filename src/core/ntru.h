// ============================================================================
//  NTRU 基础算法（论文 §3.1 的 KeyGen / Enc / Dec）
//  文件名：src/core/ntru.h
//
//  本骨架采用的实例化（与论文 §3.2 一致，细节在 docs/00_design.md 说明）：
//      F  : 三元，df 个 +1、df 个 -1
//      f  = 1 + p*F          （=> f ≡ 1 (mod p)，这是重加密正确性的必要条件）
//      g  : 三元，dg 个 +1、dg 个 -1
//      h  = p * g * f^{-1}   (mod q)
//      Enc: C = h*s + M      （s 为 dr 重量三元；M ∈ R/p）
//      Dec: a = f*C mod q -> 取中心代表 -> M = a mod p
// ============================================================================
#pragma once

#include "params.h"
#include "ring.h"
#include "sampler.h"

#include <cstdint>

namespace ntru {

struct KeyPair {
    Poly f;       // 私钥（[0, q) 形式）
    Poly finv;    // f^{-1} mod q（缓存：ReKeyGen 必须用它）
    Poly g;       // 辅助多项式
    Poly h;       // 公钥
    int  tries;   // 拒绝采样次数（统计用；f 不可逆时会重采）
};

// 生成密钥对；超过 max_tries 次仍无法取逆返回 false
bool keygen(const Params& P, Rng& rng, KeyPair& kp, int max_tries = 500);

// C = h*s + M（m 为 mod p 系数 {0,..,p-1}，内部按 [0,q) 处理）
Poly encrypt(const Params& P, const Poly& h, const Poly& m, Rng& rng);

// 解密：中心代表(f*C) mod p，返回 {-1,0,1}
Poly decrypt(const Params& P, const Poly& f, const Poly& c);

// 解密并顺带输出噪声无穷范数 ||center(f*C)||_inf（做失败概率/噪声预算实验用）
Poly decrypt_with_noise(const Params& P, const Poly& f, const Poly& c, int64_t& noise_inf);

// 明文比较（都按中心形式比）
bool message_equal(const Params& P, const Poly& m_modp, const Poly& decrypted_center);

}  // namespace ntru
