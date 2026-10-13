// ============================================================================
//  采样器：三元固定重量多项式、均匀多项式、随机源封装
//  文件名：src/core/sampler.h
//
//  约定：
//    * sample_* 返回"中心形式"的小系数 {-1, 0, +1}（明文除外）
//    * sample_message 返回 mod p 的系数 {0, 1, ..., p-1}
//    * 参与环运算前请用 to_mod_q() 映射到 [0, q)
// ============================================================================
#pragma once

#include "params.h"
#include "ring.h"

#include <cstdint>
#include <random>

namespace ntru {

// ---------------------------------------------------------------------------
// 随机源
//
// 骨架默认用 std::mt19937_64（给定种子时可完全复现，便于跨语言对齐测试）。
//
// TODO(安全): 正式实验（尤其是"真实密钥"）必须换成密码学安全随机源，
//   例如 Linux 的 getrandom(2) / Windows 的 BCryptGenRandom / RDRAND。
//   参考：NTRUReEncrypt 参考实现里 generateSeed() 固定返回 {1,2,3,4}，
//   那是**只用于基准测试**的确定性实现，绝对不能照抄到真实密钥生成里。
// ---------------------------------------------------------------------------
class Rng {
public:
    explicit Rng(uint64_t seed) : st_(seed) {}
    static Rng from_entropy();                      // 用 std::random_device 取种子
    uint64_t next_u64() { return st_(); }
    uint32_t uniform_below(uint32_t bound);         // 无偏（拒绝采样）
    void seed(uint64_t s) { st_.seed(s); }

private:
    std::mt19937_64 st_;
};

// ---------------------------------------------------------------------------
// 采样
// ---------------------------------------------------------------------------
// 固定重量三元多项式：随机位置放 plus 个 +1、minus 个 -1，其余为 0
Poly sample_fixed_weight(int n, int plus, int minus, Rng& rng);

// 明文（mod p）：dm0 个 +1、dm1 个 -1，其余 0；返回值已映射到 [0, p)
Poly sample_message(const Params& P, Rng& rng);

// 均匀多项式，系数 ∈ [0, q)
Poly sample_uniform(int n, int64_t q, Rng& rng);

// 中心形式小系数 -> [0, q)
Poly to_mod_q(const Poly& a, int64_t q);

// 明文 {0,..,p-1} -> 中心形式 {0, +1, -1}（p = 3 时 2 映射为 -1）
Poly message_to_center(const Poly& m, int64_t p);

}  // namespace ntru
