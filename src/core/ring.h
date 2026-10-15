// ============================================================================
//  环运算：R = Z_q[x]/(x^n - 1)
//  文件名：src/core/ring.h
//
//  约定（重要，跨语言对齐时也用这套）：
//    * 多项式系数一律保存在 [0, q) 区间（负值写成 q-1 这种形式）
//    * "中心代表" c 满足 -q/2 < c <= q/2，由 poly_center() 得到
//    * 乘法是 x^n - 1 上的循环卷积（不是截断卷积！）
// ============================================================================
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ntru {

using Poly = std::vector<int64_t>;

// ---------------------------------------------------------------------------
// 标量工具
// ---------------------------------------------------------------------------
inline int64_t mod_q(int64_t x, int64_t q) noexcept {
    int64_t r = x % q;
    return r < 0 ? r + q : r;
}

inline bool is_pow2(int64_t x) noexcept { return x > 0 && (x & (x - 1)) == 0; }

// 把中心代表 c ∈ (-q/2, q/2] 映射回 [0, q)
inline int64_t from_center(int64_t c, int64_t q) noexcept { return mod_q(c, q); }

// ---------------------------------------------------------------------------
// 多项式基础操作
// ---------------------------------------------------------------------------
Poly poly_zero(std::size_t n);
int  poly_deg(const Poly& a);          // 最高非零系数下标；全零返回 -1
bool poly_is_zero(const Poly& a);
bool poly_equal(const Poly& a, const Poly& b);
std::size_t poly_nonzero(const Poly& a);

Poly poly_add(const Poly& a, const Poly& b, int64_t q);
Poly poly_sub(const Poly& a, const Poly& b, int64_t q);
Poly poly_neg(const Poly& a, int64_t q);
Poly poly_mul_const(const Poly& a, int64_t k, int64_t q);

// 参考实现：逐项归约，绝对不溢出，但慢（只用于对照与测试）
Poly poly_mul_ref(const Poly& a, const Poly& b, int64_t q);

// 快速实现：拆循环（利于自动向量化）+ int64 累加 + 分块归约
Poly poly_mul_fast(const Poly& a, const Poly& b, int64_t q);

// 优化实现（SIMD 友好，性能工程的起点）：
//   行式（输出平稳）循环 + int16 系数 + int32 累加 + 每 BLK 项一次归约，
//   BLK 由 q 决定：BLK*(q-1)^2 必须 < 2^30。仅当 q 是 2 的幂且 q <= 2048 时可用。
//   参考：NTRUReEncrypt_GPU/bench/cpu_splitloop.c（同一套循环结构）
Poly poly_mul_i32(const Poly& a, const Poly& b, int64_t q);

// 复用外部 scratch 的版本：避免每次调用分配 aa/bb/acc 三个临时数组，
// 用于基准测试的公平计时（与 GPU kernel-only 的"预置 device buffer"口径对齐）。
Poly poly_mul_i32_scratch(const Poly& a, const Poly& b, int64_t q,
                          std::vector<int16_t>& aa, std::vector<int16_t>& bb,
                          std::vector<int32_t>& acc);

// 中心代表与范数
Poly    poly_center(const Poly& a, int64_t q);              // 输出 (-q/2, q/2]
int64_t poly_inf_norm_center(const Poly& a, int64_t q);     // 中心代表的无穷范数

// 模 p（先取中心代表再 mod p），输出 [0, p)
Poly poly_mod_p(const Poly& a, int64_t q, int64_t p);
// 输出 {-1, 0, 1}（便于和明文直接比较）
Poly poly_mod_p_centered(const Poly& a, int64_t q, int64_t p);

// 序列化（跨语言对齐用）："1,2047,0,..."
std::string poly_to_string(const Poly& a);
Poly        poly_from_string(const std::string& s);

// 小统计（报告里会用到）
int64_t poly_sum_center(const Poly& a, int64_t q);

}  // namespace ntru
