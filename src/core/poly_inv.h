// ============================================================================
//  多项式求逆：Z_q[x]/(x^n - 1) 中求 f^{-1}，q = 2^k
//  文件名：src/core/poly_inv.h
//
//  两步走（NTRU 参考实现的标准做法）：
//    1) 在 GF(2)[x]/(x^n - 1) 上用扩展欧几里得求 f^{-1} mod 2
//       —— 注意 x^n - 1 = (x - 1)(x^{n-1}+...+1) 在 GF(2) 上可约，
//          所以 f 未必可逆，必须做拒绝采样（本函数返回 false 表示不可逆）
//    2) Hensel/Newton 提升：g <- g*(2 - f*g)，精度每步翻倍，从 mod 2 提到 mod 2^16
//       （q = 2^11 | 2^16，所以最后按 q 取模即为 f^{-1} mod q）
// ============================================================================
#pragma once

#include "ring.h"

#include <cstdint>
#include <vector>

namespace ntru {

// GF(2)[x] 多项式用位向量表示（bit i 表示 x^i 的系数）
using Bits = std::vector<uint64_t>;

// 在 GF(2)[x]/(x^n - 1) 中求逆；不可逆返回 false
bool inv_mod2_poly(const Bits& f, int n, Bits& out);

// 在 Z_q[x]/(x^n - 1) 中求逆（q 必须是 2 的幂，且 k <= 16）；不可逆返回 false
bool poly_inv_mod_q(const Poly& f, int64_t q, Poly& out);

// 便捷封装：q = 2048
bool poly_inv_mod_2048(const Poly& f, Poly& out);

}  // namespace ntru
