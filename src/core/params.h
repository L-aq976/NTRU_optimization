// ============================================================================
//  参数集定义（NTRUReEncrypt / net.sf.ntru 的 EES 参数族）
//  文件名：src/core/params.h
//  说明：n 为素数，q = 2048 = 2^11，p = 3。df/dg/dr/dm0/dm1 为"权重"。
// ============================================================================
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ntru {

// ---------------------------------------------------------------------------
// 参数集：所有算法都通过它拿参数，禁止在别处硬编码数字
// ---------------------------------------------------------------------------
struct Params {
    std::string name;
    int n;      // 环维数（素数），R = Z[x]/(x^n - 1)
    int q;      // 系数模数，q = 2^11 = 2048（注意：必须能被 2 的幂整除的特性在别处有用）
    int p;      // 明文模数，p = 3
    int df;     // 私钥 F 的重量：df 个 +1、df 个 -1（f = 1 + p*F）
    int dg;     // 公钥辅助多项式 g 的重量：dg 个 +1、dg 个 -1
    int dr;     // 加密随机多项式 s 的重量：dr 个 +1、dr 个 -1
    int dm0;    // 明文 M 的 +1 个数
    int dm1;    // 明文 M 的 -1 个数

    bool q_is_pow2() const noexcept { return q > 0 && (q & (q - 1)) == 0; }
    int  log2_q() const noexcept;      // ceil(log2(q))
    void validate() const;             // 参数自检，不合法直接抛异常
};

// ---------------------------------------------------------------------------
// 内置参数集（取自 net.sf.ntru 的 EES 参数族；跳数相关数据见 mock 文档）
// ---------------------------------------------------------------------------
const Params& param_ees439();
const Params& param_ees1087();
const Params& param_ees1171();
const Params& param_ees1499();

// 按名字取参数集；未知名字抛 std::invalid_argument
const Params& param_by_name(const std::string& name);

// 用于 CLI 打印
std::string list_params();

}  // namespace ntru
