// ============================================================================
//  门限多代理委托（本项目的核心设计点 C1）
//  文件名：src/core/threshold.h
//
//  设计要点（详见 docs/00_design.md）：
//
//  1) 为什么不能用 Shamir？
//     q = 2048 = 2^11，Z_q **不是域**；Shamir 重构系数
//     λ_i = Π_{j≠i} (0-j)/(i-j) 的分母 (i-j) 只要含因子 2 就不可逆。
//     取整数点 1..n 时，(i-j) 恒为偶数差 -> 直接失败。
//     所以改用"子集加性分享"（Ito-Saito-Nishizeki 对门限结构的经典构造）：
//       * 子集大小 = n - t + 1，共 C(n, t-1) 个子集；
//       * 每个子集分到一份随机份额，最后一份由"总和 = rk"确定；
//       * 任何 t 个代理的并集必然与每个子集相交（因为 |S| > n-t），
//         所以它们合起来持有全部份额，**重构系数全是 1** —— 不用求逆，噪声友好；
//       * 任何 t-1 个代理恰好漏掉唯一一个子集（[n]\W），该份额均匀随机
//         => 它们看到的总和与 rk 独立（信息论意义下的零信息）。
//
//  2) 噪声代价：每个子集的部分重加密各加一次 p*e（这是必须的，否则
//     部分密文 mod p 会泄露份额），所以组合后的噪声放大约 C(n, t-1) 倍。
//     这个放大因子直接进 C2 的噪声预算（可支持跳数会下降）——这就是
//     "门限化的代价曲线"，是报告的核心图之一。
//
//  3) 部分密文含有 p*e 掩码，因此即便被别的代理看到，也只能泄露
//     share mod p；而 Σ share = rk 且 f_A ≡ 1 (mod p)，故泄漏的只是
//     rk mod p = f_B^{-1} mod p，属于接收者自己的信息。该结论必须自己再推一遍
//     并写进报告（见 docs/00_design.md 的"待验证命题"）。
// ============================================================================
#pragma once

#include "params.h"
#include "ring.h"
#include "sampler.h"

#include <cstdint>
#include <vector>

namespace ntru {

// 一个子集份额：subset 为 n 位掩码，popcount(subset) = n - t + 1
struct Share {
    uint32_t subset;
    Poly value;  // [0, q)
};

struct ThresholdCtx {
    int n = 0;
    int t = 0;
    int subset_size = 0;                        // n - t + 1
    std::vector<uint32_t> subsets;              // 全部子集
    std::vector<std::vector<Share>> per_proxy;  // per_proxy[i]：代理 i 持有的份额

    int num_subsets() const { return (int)subsets.size(); }
    int find(uint32_t subset, int proxy) const;  // 返回该代理持有份额的下标，-1 表示没有
};

// 生成门限分享（rk 为待分享的重加密密钥，[0,q) 形式）
ThresholdCtx cnf_share(const Params& P, const Poly& rk, int n, int t, Rng& rng);

// 每个代理对自己持有的每份份额做一次部分重加密：partial = C_A * share + p * e
// de < 0 表示使用 P.dr
std::vector<std::vector<Poly>> proxy_partials(const Params& P, const ThresholdCtx& ctx,
                                              const Poly& cA, Rng& rng, int de = -1);

// 组合：参与集合 W（|W| = t）。对每个子集 S 取 owner = min(S ∩ W) 的 partial，求和
Poly threshold_combine(const Params& P, const ThresholdCtx& ctx,
                       const std::vector<std::vector<Poly>>& partials,
                       const std::vector<int>& W);

// 尽力而为的组合（用于实验演示"t-1 个代理不行"）：
//   |W| < t 时，把能拿到的份额都加起来，拿不到的（与 W 不相交的子集）计入 missing。
//   注意这里不是"代码拦截"，而是真的少了一份均匀随机的份额 —— 结果必然解不出明文。
Poly threshold_combine_best_effort(const Params& P, const ThresholdCtx& ctx,
                                   const std::vector<std::vector<Poly>>& partials,
                                   const std::vector<int>& W, int* missing_subsets);

// 返回与参与集合 W 不相交的子集（|W| = t-1 时恰好一个）；找不到返回 false
bool threshold_missing_subset(const ThresholdCtx& ctx, const std::vector<int>& W,
                              uint32_t* missing_mask);

struct ThresholdResult {
    Poly ct;
    int64_t noise_inf;
    bool ok;
    int subsets_used;
};

// 完整跑一遍：t 个代理各自部分重加密 + 组合 + 用 f_B 解密 + 与 m_center 比对
ThresholdResult threshold_reencrypt_checked(const Params& P, const ThresholdCtx& ctx,
                                            const Poly& cA, const Poly& fB, const Poly& m_center,
                                            const std::vector<int>& W, Rng& rng, int de = -1);

}  // namespace ntru
