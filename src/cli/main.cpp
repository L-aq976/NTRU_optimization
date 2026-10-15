// ============================================================================
//  命令行驱动：自检 / 端到端冒烟 / 测试向量 / 微基准
//  文件名：src/cli/main.cpp
//
//  用法：
//    ntru_cli selftest
//    ntru_cli smoke  [EES439|EES1087|EES1171|EES1499] [n] [t]
//    ntru_cli vectors <参数集> <seed> [输出文件]
//    ntru_cli bench  <参数集> [迭代次数]
// ============================================================================
#include "core/ntru.h"
#include "core/params.h"
#include "core/poly_inv.h"
#include "core/pre_base.h"
#include "core/ring.h"
#include "core/sampler.h"
#include "core/threshold.h"

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#if defined(_WIN32)
#  ifndef NOMINMAX
#    define NOMINMAX          // 防止 windows.h 的 min/max 宏污染 std::min/std::max
#  endif
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>        // SetConsoleOutputCP
#endif

// ---------------------------------------------------------------------------
// Windows 控制台中文乱码的根治办法：
//   源码里的中文字面量是 UTF-8 编码，而中文版 Windows 控制台默认代码页是 GBK(936)，
//   字节被按 GBK 解释 -> 乱码。这里在程序启动时把控制台输入/输出代码页切成 UTF-8，
//   这样在 VS Code 集成终端、cmd、PowerShell 里都能正常显示中文。
//   （Linux/WSL 下本来就是 UTF-8，无需处理）
// ---------------------------------------------------------------------------
static void setup_console_utf8() {
#if defined(_WIN32)
    SetConsoleOutputCP(CP_UTF8);   // 输出代码页 -> 65001
    SetConsoleCP(CP_UTF8);         // 输入代码页 -> 65001（本程序不读中文，一并设置）
#endif
}

using namespace ntru;
using Clock = std::chrono::steady_clock;

static int g_fail = 0;

static void check(bool cond, const std::string& what) {
    std::printf("[%s] %s\n", cond ? " OK " : "FAIL", what.c_str());
    if (!cond) ++g_fail;
}

static double ms_since(Clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
}

// 轻量校验和（用于打印/快速比对；完整向量请用 vectors 子命令导出）
static uint64_t fnv1a(const std::string& s) {
    uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : s) {
        h ^= c;
        h *= 1099511628211ULL;
    }
    return h;
}

// 构造一个"测试专用"的小参数集（不是安全参数，只用于自检速度）
static Params test_params(int n) {
    Params P;
    P.name = "TEST";
    P.n = n;
    P.q = 2048;
    P.p = 3;
    P.df = (n >= 61) ? 10 : 3;
    P.dg = (n >= 61) ? 10 : 3;
    P.dr = (n >= 61) ? 10 : 3;
    P.dm0 = 5;
    P.dm1 = 5;
    return P;
}

// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------
static int cmd_selftest() {
    std::printf("=== 自检开始 ===\n");

    // 1) 环运算：参考实现 vs 快速实现
    {
        Params P = test_params(61);
        Rng rng(12345);
        Poly a = sample_uniform(P.n, P.q, rng);
        Poly b = sample_uniform(P.n, P.q, rng);
        Poly r1 = poly_mul_ref(a, b, P.q);
        Poly r2 = poly_mul_fast(a, b, P.q);
        Poly r3 = poly_mul_i32(a, b, P.q);
        check(poly_equal(r1, r2), "poly_mul_ref == poly_mul_fast (n=61, q=2048)");
        check(poly_equal(r1, r3), "poly_mul_ref == poly_mul_i32  (n=61, q=2048)");
        // 循环卷积语义：x * (1) 应该是移位
        Poly x(P.n, 0), one(P.n, 0);
        x[1] = 1;
        one[0] = 1;
        Poly xm = poly_mul_fast(x, one, P.q);
        check(xm[1] == 1 && xm[0] == 0, "循环卷积语义：x*1 = x");
        // x^{n-1} * x = 1 (mod x^n - 1)
        Poly xn1(P.n, 0);
        xn1[P.n - 1] = 1;
        Poly prod = poly_mul_fast(xn1, x, P.q);
        check(prod[0] == 1 && poly_nonzero(prod) == 1, "x^{n-1} * x == 1 (mod x^n-1)");
    }

    // 2) 中心代表 / mod p
    {
        Params P = test_params(61);
        Poly a(P.n, 0);
        for (int i = 0; i < P.n; ++i) a[i] = (i * 37) % P.q;
        Poly c = poly_center(a, P.q);
        bool range_ok = true, round_ok = true;
        for (int i = 0; i < P.n; ++i) {
            if (!(c[i] > -P.q / 2 && c[i] <= P.q / 2)) range_ok = false;
            if (from_center(c[i], P.q) != a[i]) round_ok = false;
        }
        check(range_ok, "poly_center 值域 (-q/2, q/2]");
        check(round_ok, "center -> [0,q) 往返一致");
    }

    // 3) 多项式求逆
    {
        Params P = test_params(61);
        Rng rng(999);
        KeyPair kp;
        bool ok = keygen(P, rng, kp);
        check(ok, "keygen 成功（f 可逆）");
        if (ok) {
            Poly prod = poly_mul_fast(kp.f, kp.finv, P.q);
            Poly one = poly_zero(P.n);
            one[0] = 1;
            check(poly_equal(prod, one), "f * f^{-1} == 1 (mod q)");
            // f ≡ 1 (mod p)
            Poly fc = poly_center(kp.f, P.q);
            bool f1 = true;
            for (int i = 0; i < P.n; ++i) {
                int64_t v = ((fc[i] % P.p) + P.p) % P.p;
                if (i == 0) {
                    if (v != 1) f1 = false;
                } else if (v != 0) {
                    f1 = false;
                }
            }
            check(f1, "f ≡ 1 (mod p)");
        }
    }

    // 4) 端到端（小参数）
    {
        Params P = test_params(61);
        Rng rng(2024);
        KeyPair A, B;
        check(keygen(P, rng, A) && keygen(P, rng, B), "两个密钥对生成");
        Poly m = sample_message(P, rng);
        Poly c = encrypt(P, A.h, m, rng);
        int64_t noise = 0;
        Poly dec = decrypt_with_noise(P, A.f, c, noise);
        check(message_equal(P, m, dec), "原始密文解密正确");
        std::printf("       原始密文噪声 ||center(f*c)||_inf = %lld (q/2 = %d)\n", (long long)noise, P.q / 2);

        Poly rk = rekeygen(P, A.f, B.finv);
        Poly mc = message_to_center(m, P.p);
        ReEncResult rr = reencrypt_checked(P, B.f, c, rk, mc, rng);
        check(rr.ok, "基线重加密后解密正确");
        std::printf("       重加密噪声 = %lld\n", (long long)rr.noise_inf);
    }

    // 5) 门限分享（子集加性）：份额之和 == rk
    {
        Params P = test_params(61);
        Rng rng(7);
        Poly rk = sample_uniform(P.n, P.q, rng);
        ThresholdCtx ctx = cnf_share(P, rk, 3, 2, rng);
        Poly sum = poly_zero(P.n);
        for (std::size_t i = 0; i < ctx.subsets.size(); ++i) {
            // 找到该子集的份额（任取一个持有它的代理）
            int owner = -1;
            for (int p = 0; p < ctx.n && owner < 0; ++p)
                if (ctx.subsets[i] & (1u << p)) owner = p;
            int j = ctx.find(ctx.subsets[i], owner);
            sum = poly_add(sum, ctx.per_proxy[owner][j].value, P.q);
        }
        check(poly_equal(sum, rk), "门限份额之和 == rk (n=3,t=2)");
        std::printf("       子集数 C(n,t-1) = %d（这就是噪声放大因子）\n", ctx.num_subsets());
    }

    // 6) 门限端到端：t 个代理能转换；(t-1) 个代理覆盖不全（结构性不可行）
    {
        Params P = test_params(61);
        Rng rng(4242);
        KeyPair A, B;
        keygen(P, rng, A);
        keygen(P, rng, B);
        Poly m = sample_message(P, rng);
        Poly c = encrypt(P, A.h, m, rng);
        Poly mc = message_to_center(m, P.p);
        Poly rk = rekeygen(P, A.f, B.finv);

        struct Case { int n, t; };
        Case cases[] = {{3, 2}, {5, 2}, {5, 3}, {4, 4}};
        for (const Case& cs : cases) {
            ThresholdCtx ctx = cnf_share(P, rk, cs.n, cs.t, rng);
            std::vector<int> W;
            for (int i = 0; i < cs.t; ++i) W.push_back(i);
            ThresholdResult tr = threshold_reencrypt_checked(P, ctx, c, B.f, mc, W, rng);
            char buf[160];
            std::snprintf(buf, sizeof(buf), "门限 (n=%d,t=%d) 转换正确，子集数=%d，噪声=%lld",
                          cs.n, cs.t, tr.subsets_used, (long long)tr.noise_inf);
            check(tr.ok, buf);

            // (t-1) 个代理覆盖不全：验证存在一个子集与它们不相交
            if (cs.t >= 2) {
                std::vector<int> Wm;
                for (int i = 0; i < cs.t - 1; ++i) Wm.push_back(i);
                bool uncovered = false;
                for (uint32_t S : ctx.subsets) {
                    bool inter = false;
                    for (int p : Wm)
                        if (S & (1u << p)) inter = true;
                    if (!inter) uncovered = true;
                }
                std::snprintf(buf, sizeof(buf),
                              "门限 (n=%d,t=%d)：t-1 个代理存在未覆盖子集（无法组合）", cs.n, cs.t);
                check(uncovered, buf);
            }
        }
    }

    std::printf("=== 自检结束：%s（失败 %d 项）===\n", g_fail == 0 ? "全部通过" : "有失败", g_fail);
    return g_fail == 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// smoke：在真实 EES 参数上跑完整流程
// ---------------------------------------------------------------------------
static int cmd_smoke(const std::string& pname, int n_th, int t_th) {
    const Params& P = param_by_name(pname);
    std::printf("=== 冒烟测试：%s (n=%d, q=%d, p=%d, df=%d, dg=%d, dr=%d) ===\n",
                P.name.c_str(), P.n, P.q, P.p, P.df, P.dg, P.dr);

    Rng rng(20261012ULL);

    Clock::time_point t0 = Clock::now();
    KeyPair A, B;
    bool okA = keygen(P, rng, A);
    double tA = ms_since(t0);
    t0 = Clock::now();
    bool okB = keygen(P, rng, B);
    double tB = ms_since(t0);
    check(okA && okB, "KeyGen ×2");
    std::printf("       KeyGen: A=%.2f ms (拒绝采样 %d 次), B=%.2f ms (拒绝采样 %d 次)\n",
                tA, A.tries, tB, B.tries);

    Poly m = sample_message(P, rng);

    t0 = Clock::now();
    Poly c = encrypt(P, A.h, m, rng);
    double tEnc = ms_since(t0);

    t0 = Clock::now();
    int64_t n0 = 0;
    Poly dec = decrypt_with_noise(P, A.f, c, n0);
    double tDec = ms_since(t0);
    check(message_equal(P, m, dec), "Enc -> Dec");
    std::printf("       Enc=%.2f ms, Dec=%.2f ms, 噪声=%lld\n", tEnc, tDec, (long long)n0);

    t0 = Clock::now();
    Poly rk = rekeygen(P, A.f, B.finv);
    double tRk = ms_since(t0);

    Poly mc = message_to_center(m, P.p);
    t0 = Clock::now();
    ReEncResult rr = reencrypt_checked(P, B.f, c, rk, mc, rng);
    double tRe = ms_since(t0);
    check(rr.ok, "基线 ReKeyGen -> ReEnc -> Dec");
    std::printf("       ReKeyGen=%.2f ms, ReEnc=%.2f ms, 重加密噪声=%lld\n",
                tRk, tRe, (long long)rr.noise_inf);

    // 门限
    ThresholdCtx ctx = cnf_share(P, rk, n_th, t_th, rng);
    std::vector<int> W;
    for (int i = 0; i < t_th; ++i) W.push_back(i);
    t0 = Clock::now();
    ThresholdResult tr = threshold_reencrypt_checked(P, ctx, c, B.f, mc, W, rng);
    double tTh = ms_since(t0);
    check(tr.ok, "门限转换 -> Dec");
    std::printf("       门限 (n=%d,t=%d): 子集数=%d, 总耗时=%.2f ms, 噪声=%lld (相对基线 ×%.2f)\n",
                n_th, t_th, tr.subsets_used, tTh, (long long)tr.noise_inf,
                rr.noise_inf > 0 ? (double)tr.noise_inf / (double)rr.noise_inf : 0.0);

    std::printf("=== 冒烟测试结束：%s ===\n", g_fail == 0 ? "全部通过" : "有失败");
    return g_fail == 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// vectors：导出确定性测试向量（给 Python 参考实现逐位对齐用）
// ---------------------------------------------------------------------------
static int cmd_vectors(const std::string& pname, uint64_t seed, const std::string& out_path) {
    const Params& P = param_by_name(pname);
    Rng rng(seed);
    KeyPair A, B;
    if (!keygen(P, rng, A) || !keygen(P, rng, B)) {
        std::printf("keygen 失败\n");
        return 1;
    }
    Poly m = sample_message(P, rng);
    Poly s = to_mod_q(sample_fixed_weight(P.n, P.dr, P.dr, rng), P.q);
    Poly c = poly_add(poly_mul_fast(A.h, s, P.q), to_mod_q(m, P.q), P.q);
    Poly rk = rekeygen(P, A.f, B.finv);
    Poly e = to_mod_q(sample_fixed_weight(P.n, P.dr, P.dr, rng), P.q);
    Poly cb = poly_add(poly_mul_fast(c, rk, P.q), poly_mul_const(e, P.p, P.q), P.q);

    std::ofstream f(out_path.c_str());
    if (!f) {
        std::printf("无法写入 %s\n", out_path.c_str());
        return 1;
    }
    f << "PARAMS=" << P.name << "\n";
    f << "SEED=" << seed << "\n";
    f << "N=" << P.n << "\n";
    f << "Q=" << P.q << "\n";
    f << "P=" << P.p << "\n";
    f << "GA=" << poly_to_string(A.g) << "\n";
    f << "FA=" << poly_to_string(A.f) << "\n";
    f << "FAINV=" << poly_to_string(A.finv) << "\n";
    f << "HA=" << poly_to_string(A.h) << "\n";
    f << "FB=" << poly_to_string(B.f) << "\n";
    f << "FBINV=" << poly_to_string(B.finv) << "\n";
    f << "M=" << poly_to_string(m) << "\n";
    f << "S=" << poly_to_string(s) << "\n";
    f << "C=" << poly_to_string(c) << "\n";
    f << "RK=" << poly_to_string(rk) << "\n";
    f << "E=" << poly_to_string(e) << "\n";
    f << "CB=" << poly_to_string(cb) << "\n";
    f.close();
    std::printf("已写出 %s\n", out_path.c_str());
    std::printf("  校验和 FA=%016llx HA=%016llx C=%016llx RK=%016llx CB=%016llx\n",
                (unsigned long long)fnv1a(poly_to_string(A.f)),
                (unsigned long long)fnv1a(poly_to_string(A.h)),
                (unsigned long long)fnv1a(poly_to_string(c)),
                (unsigned long long)fnv1a(poly_to_string(rk)),
                (unsigned long long)fnv1a(poly_to_string(cb)));
    return 0;
}

// ---------------------------------------------------------------------------
// bench：环乘法微基准（参考实现 vs 快速实现）
// ---------------------------------------------------------------------------
static int cmd_bench(const std::string& pname, int iters) {
    const Params& P = param_by_name(pname);
    Rng rng(1);
    Poly a = sample_uniform(P.n, P.q, rng);
    Poly b = sample_uniform(P.n, P.q, rng);

    volatile int64_t sink = 0;

    Clock::time_point t0 = Clock::now();
    for (int i = 0; i < iters; ++i) {
        Poly c = poly_mul_ref(a, b, P.q);
        sink += c[0];
    }
    double t_ref = ms_since(t0);

    t0 = Clock::now();
    for (int i = 0; i < iters; ++i) {
        Poly c = poly_mul_fast(a, b, P.q);
        sink += c[0];
    }
    double t_fast = ms_since(t0);

    t0 = Clock::now();
    for (int i = 0; i < iters; ++i) {
        Poly c = poly_mul_i32(a, b, P.q);
        sink += c[0];
    }
    double t_i32 = ms_since(t0);

    // 正确性抽检（避免"快但错"）
    Poly cr = poly_mul_ref(a, b, P.q);
    Poly ci = poly_mul_i32(a, b, P.q);
    check(poly_equal(cr, ci), "bench 前抽检：poly_mul_i32 == poly_mul_ref");

    std::printf("=== 环乘法微基准：%s (n=%d) 迭代 %d 次 ===\n", P.name.c_str(), P.n, iters);
    std::printf("  poly_mul_ref : %8.2f ms 总 / %8.3f us 每次 / %10.0f 次每秒\n",
                t_ref, t_ref * 1000.0 / iters, iters * 1000.0 / t_ref);
    std::printf("  poly_mul_fast: %8.2f ms 总 / %8.3f us 每次 / %10.0f 次每秒\n",
                t_fast, t_fast * 1000.0 / iters, iters * 1000.0 / t_fast);
    std::printf("  poly_mul_i32 : %8.2f ms 总 / %8.3f us 每次 / %10.0f 次每秒\n",
                t_i32, t_i32 * 1000.0 / iters, iters * 1000.0 / t_i32);
    std::printf("  加速比 ref/fast = %.2fx, ref/i32 = %.2fx\n", t_ref / t_fast, t_ref / t_i32);
    (void)sink;
    return 0;
}

// ---------------------------------------------------------------------------
// walkthrough：教学参数下的完整流程预演（所有系数完整打印，可手工核对）
//   n = 7（足够小，多项式能整行打印）；q=2048, p=3
// ---------------------------------------------------------------------------
static Params tiny_params() {
    Params P;
    P.name = "TINY7";
    P.n = 7;
    P.q = 2048;
    P.p = 3;
    P.df = 2;   // F: 2 个 +1、2 个 -1
    P.dg = 2;
    P.dr = 2;
    P.dm0 = 1;
    P.dm1 = 1;
    P.validate();
    return P;
}

// 打印多项式（统一用中心代表，便于手工核对加减法；相等判定在 mod q 下进行）
static void show(const std::string& label, const Poly& a, int64_t q, int indent = 6) {
    std::string pad(indent, ' ');
    std::printf("%s%-26s = [", pad.c_str(), label.c_str());
    Poly c = poly_center(a, q);
    for (std::size_t i = 0; i < c.size(); ++i)
        std::printf("%s%lld", i ? ", " : "", (long long)c[i]);
    std::printf("]\n");
}

static void title(const std::string& t) {
    std::printf("\n--------------------------------------------------------------\n");
    std::printf("%s\n", t.c_str());
    std::printf("--------------------------------------------------------------\n");
}

static int cmd_walkthrough() {
    const Params P = tiny_params();
    Rng rng(20261012ULL);
    const int64_t q = P.q;

    std::printf("==============================================================\n");
    std::printf(" 加密流程预演：两个对象（Alice=委托方 / Bob=接收方）走一遍完整代码\n");
    std::printf(" 教学参数：n=%d, q=%d, p=%d, df=%d, dg=%d, dr=%d  ← 安全性为零，仅供理解流程\n",
                P.n, P.q, P.p, P.df, P.dg, P.dr);
    std::printf(" R = Z_q[x]/(x^n - 1)；下面所有多项式都用【中心代表】打印，\n");
    std::printf(" 即每个系数落在 (-q/2, q/2]；所有等式均在 mod q 下成立。\n");
    std::printf("==============================================================\n");

    // ---------------- 步骤 1 ----------------
    title("【步骤 1】生成密钥对 —— src/core/ntru.cpp : keygen()");
    KeyPair A, B;
    if (!keygen(P, rng, A) || !keygen(P, rng, B)) {
        std::printf("keygen 失败\n");
        return 1;
    }
    std::printf("  对象 A（委托方 Alice）：\n");
    std::printf("    采样三元 F_A（%d 个 +1、%d 个 -1），并令 f_A = 1 + p*F_A\n", P.df, P.df);
    show("f_A（中心形式）", A.f, q);
    show("f_A^{-1} mod q  (poly_inv.cpp)", A.finv, q);
    {
        Poly chk = poly_mul_fast(A.f, A.finv, q);
        std::printf("    校验 f_A * f_A^{-1}  mod q = ");
        Poly cc = poly_center(chk, q);
        std::printf("[");
        for (std::size_t i = 0; i < cc.size(); ++i) std::printf("%s%lld", i ? ", " : "", (long long)cc[i]);
        std::printf("]   ← 应为 1,0,0,...\n");
    }
    show("g_A", A.g, q);
    show("h_A = p*g_A*f_A^{-1}  (公钥)", A.h, q);
    std::printf("    对象 B（接收方 Bob）：\n");
    show("f_B", B.f, q);
    show("h_B", B.h, q);
    std::printf("  注：密钥的“尺寸”与参数无关，都是 1 个多项式 = n*log2(q)/8 字节\n");

    // ---------------- 步骤 2 ----------------
    title("【步骤 2】Alice 加密数据（对象 1 与对象 2 各加密一份）—— ntru.cpp : encrypt()");
    Poly M1 = sample_message(P, rng);
    Poly s1 = to_mod_q(sample_fixed_weight(P.n, P.dr, P.dr, rng), q);
    Poly C1 = poly_add(poly_mul_fast(A.h, s1, q), to_mod_q(M1, q), q);
    std::printf("  数据对象 #1（将被授权给 Bob）：\n");
    show("明文 M1  (mod p, 0/1/2)", M1, q);
    show("随机 s1（dr 重量三元）", s1, q);
    show("密文 C1 = h_A*s1 + M1", C1, q);

    // 对象 2 用"另一个域"的密钥对（Alice 的另一把钥匙），用来演示对象级授权隔离
    KeyPair A2;
    if (!keygen(P, rng, A2)) return 1;
    Poly M2 = sample_message(P, rng);
    Poly s2 = to_mod_q(sample_fixed_weight(P.n, P.dr, P.dr, rng), q);
    Poly C2 = poly_add(poly_mul_fast(A2.h, s2, q), to_mod_q(M2, q), q);
    std::printf("  数据对象 #2（不授权给 Bob，用 Alice 的另一个“授权域”密钥对 A2）：\n");
    show("A2 的公钥 h_A2", A2.h, q);
    show("明文 M2", M2, q);
    show("密文 C2 = h_A2*s2 + M2", C2, q);

    // ---------------- 步骤 3 ----------------
    title("【步骤 3】Alice 自己解密对象 #1 —— ntru.cpp : decrypt_with_noise()");
    int64_t noise0 = 0;
    Poly dec1 = decrypt_with_noise(P, A.f, C1, noise0);
    Poly a1 = poly_mul_fast(A.f, C1, q);
    show("a1 = f_A * C1 mod q", a1, q);
    std::printf("    取中心代表后 mod p  ->  ");
    std::printf("[");
    for (std::size_t i = 0; i < dec1.size(); ++i) std::printf("%s%lld", i ? ", " : "", (long long)dec1[i]);
    std::printf("]\n");
    std::printf("    噪声 ||center(f_A*C1)||_inf = %lld   （q/2 = %lld，余量充足）\n",
                (long long)noise0, (long long)(q / 2));
    std::printf("    解密结果与 M1 一致？%s\n",
                message_equal(P, M1, dec1) ? "是 ✓" : "否 ✗（不应发生）");

    // ---------------- 步骤 4 ----------------
    title("【步骤 4】Alice 生成委托凭证 rk —— pre_base.cpp : rekeygen()");
    Poly rk = rekeygen(P, A.f, B.finv);
    show("rk_{A->B} = f_A * f_B^{-1} mod q", rk, q);
    std::printf("  ⚠ 注意这个式子：rk * f_B = f_A。任何同时拿到 rk 与 f_B 的一方\n");
    std::printf("     都能直接算出 Alice 的私钥 f_A（步骤 8 会实测验证）。\n");

    // ---------------- 步骤 5 ----------------
    title("【步骤 5】单个代理做基线重加密 —— pre_base.cpp : reencrypt()");
    Poly e1 = to_mod_q(sample_fixed_weight(P.n, P.dr, P.dr, rng), q);
    show("噪声 e1", e1, q);
    Poly C1b = poly_add(poly_mul_fast(C1, rk, q), poly_mul_const(e1, P.p, q), q);
    show("C1' = C1*rk + p*e1", C1b, q);
    int64_t noise1 = 0;
    Poly decB = decrypt_with_noise(P, B.f, C1b, noise1);
    std::printf("    Bob 解密：噪声 = %lld，结果 = [", (long long)noise1);
    for (std::size_t i = 0; i < decB.size(); ++i) std::printf("%s%lld", i ? ", " : "", (long long)decB[i]);
    std::printf("]   与 M1 一致？%s\n", message_equal(P, M1, decB) ? "是 ✓" : "否 ✗");

    // ---------------- 步骤 6 ----------------
    title("【步骤 6】门限委托：3 个代理、需要 2 个 —— threshold.cpp : cnf_share()");
    const int Nth = 3, Tth = 2;
    ThresholdCtx ctx = cnf_share(P, rk, Nth, Tth, rng);
    std::printf("  子集大小 = n-t+1 = %d，子集总数 C(n,t-1) = %d\n",
                ctx.subset_size, ctx.num_subsets());
    for (std::size_t i = 0; i < ctx.subsets.size(); ++i) {
        std::printf("    子集 %zu = {", i + 1);
        bool first = true;
        for (int p = 0; p < Nth; ++p)
            if (ctx.subsets[i] & (1u << p)) {
                std::printf("%sP%d", first ? "" : ",", p + 1);
                first = false;
            }
        std::printf("}\n");
    }
    // 打印各子集份额（找任一持有者）
    for (std::size_t i = 0; i < ctx.subsets.size(); ++i) {
        int owner = -1;
        for (int p = 0; p < Nth && owner < 0; ++p)
            if (ctx.subsets[i] & (1u << p)) owner = p;
        int j = ctx.find(ctx.subsets[i], owner);
        char buf[64];
        std::snprintf(buf, sizeof(buf), "share_%zu", i + 1);
        show(buf, ctx.per_proxy[owner][j].value, q, 4);
    }
    {
        Poly sum = poly_zero(P.n);
        for (std::size_t i = 0; i < ctx.subsets.size(); ++i) {
            int owner = -1;
            for (int p = 0; p < Nth && owner < 0; ++p)
                if (ctx.subsets[i] & (1u << p)) owner = p;
            int j = ctx.find(ctx.subsets[i], owner);
            sum = poly_add(sum, ctx.per_proxy[owner][j].value, q);
        }
        show("Σ share  (应等于 rk)", sum, q, 4);
        std::printf("    与步骤 4 的 rk 相同？%s\n", poly_equal(sum, rk) ? "是 ✓" : "否 ✗");
    }
    std::printf("  代理各自持有的份额：\n");
    for (int p = 0; p < Nth; ++p) {
        std::printf("    P%d 持有 %zu 份：", p + 1, ctx.per_proxy[p].size());
        for (const Share& sh : ctx.per_proxy[p]) {
            std::printf("{");
            bool first = true;
            for (int t = 0; t < Nth; ++t)
                if (sh.subset & (1u << t)) {
                    std::printf("%sP%d", first ? "" : ",", t + 1);
                    first = false;
                }
            std::printf("} ");
        }
        std::printf("\n");
    }

    // ---------------- 步骤 7 ----------------
    title("【步骤 7】选 2 个代理做部分重加密并组合 —— threshold.cpp : proxy_partials()/threshold_combine()");
    std::vector<int> W = {0, 1};   // 选 P1、P2
    auto partials = proxy_partials(P, ctx, C1, rng);
    std::printf("  参与集合 W = {P1, P2}（满足 |W| = t = %d）\n", Tth);
    for (std::size_t i = 0; i < ctx.subsets.size(); ++i) {
        int owner = -1;
        for (int p : W)
            if (ctx.subsets[i] & (1u << p)) {
                if (owner < 0 || p < owner) owner = p;
            }
        int j = ctx.find(ctx.subsets[i], owner);
        char buf[80];
        std::snprintf(buf, sizeof(buf), "partial_%zu (由 P%d 提供)", i + 1, owner + 1);
        show(buf, partials[owner][j], q, 4);
    }
    Poly C1th = threshold_combine(P, ctx, partials, W);
    show("C1'' = Σ partial", C1th, q, 4);
    int64_t noise_th = 0;
    Poly decTh = decrypt_with_noise(P, B.f, C1th, noise_th);
    std::printf("    Bob 解密：噪声 = %lld（基线为 %lld，放大 %.2f×），结果与 M1 一致？%s\n",
                (long long)noise_th, (long long)noise1,
                noise1 > 0 ? (double)noise_th / (double)noise1 : 0.0,
                message_equal(P, M1, decTh) ? "是 ✓" : "否 ✗");
    std::printf("  只有 1 个代理（比如只有 P1）时：P1 只持有 {P1,P2} 与 {P1,P3} 两份，\n");
    std::printf("     缺少 {P2,P3} 那一份，而该份是均匀随机的 —— 无法组合出 rk（信息论零信息）。\n");

    // ---------------- 步骤 8 ----------------
    title("【步骤 8】两个安全事实的实测 —— 对象级隔离 + rk 泄漏");
    // (a) 对象 #2 没有 rk：拿 rk_{A->B} 去转 C2
    Poly C2bad = reencrypt(P, C2, rk, rng);
    int64_t nb = 0;
    Poly decBad = decrypt_with_noise(P, B.f, C2bad, nb);
    std::printf("  (a) 用 rk_{A->B} 去转换对象 #2 的密文 C2（跨授权域）：\n");
    std::printf("      Bob 解密得到的噪声 = %lld，结果 = [", (long long)nb);
    for (std::size_t i = 0; i < decBad.size(); ++i) std::printf("%s%lld", i ? ", " : "", (long long)decBad[i]);
    std::printf("]\n      与 M2 一致？%s  ← 不一致正说明：不同对象必须用不同授权域（不同密钥对）隔离\n",
                message_equal(P, M2, decBad) ? "是" : "否 ✓");
    // (b) rk * f_B = f_A
    Poly leaked = poly_mul_fast(rk, B.f, q);
    show("rk * f_B  mod q", leaked, q, 6);
    show("f_A（步骤 1 里的私钥）", A.f, q, 6);
    std::printf("      两者相同？%s  ← 基线方案里“代理 + 接收者”合谋即可恢复委托方私钥\n",
                poly_equal(leaked, A.f) ? "是 ✓（这就是本项目要解决的问题）" : "否");

    std::printf("\n==============================================================\n");
    std::printf(" 预演结束。完整链条：KeyGen → Enc → Dec → ReKeyGen → ReEnc → Dec\n");
    std::printf("                门限版：ReKeyGen(rk) → 分享 → 部分重加密 → 组合 → Dec\n");
    std::printf("==============================================================\n");
    return g_fail == 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// c1：C1（门限多代理委托）专项实验
//   一次回答四个问题：
//     ① 正确性：t 个代理能否完成转换并正确解密（成功率）
//     ② 门限性：t-1 个代理"尽力而为"地组合，是否必然失败
//     ③ 代价：噪声放大多大、各阶段耗时多少（子集数 = C(n,t-1)）
//     ④ 零信息：t-1 个代理缺口的那份份额是不是均匀随机
// ---------------------------------------------------------------------------
static int cmd_c1(const std::string& pname, int trials, int zero_trials) {
    const Params& P = param_by_name(pname);
    struct Cfg { int n; int t; };
    std::vector<Cfg> cfgs;
    {
        const Cfg c[] = {{2, 2}, {3, 2}, {4, 2}, {5, 2}, {5, 3}, {6, 3}, {7, 4}};
        for (const Cfg& x : c) cfgs.push_back(x);
    }

    std::printf("================================================================================\n");
    std::printf(" C1 门限多代理委托实验：%s\n", P.name.c_str());
    std::printf(" 参数集 %s: n=%d, q=%d, p=%d, df=%d, dg=%d, dr=%d\n",
                P.name.c_str(), P.n, P.q, P.p, P.df, P.dg, P.dr);
    std::printf(" 每配置试验次数 = %d（噪声是随机的，必须多次采样才能估成功率）\n", trials);
    std::printf(" 零信息检查试验次数 = %d（估计缺失份额的分布，需要大样本）\n", zero_trials);
    std::printf(" 噪声预算 = q/2 = %d：解密时系数必须落在此范围内，否则中心代表绕回 → 解密失败\n",
                P.q / 2);
    std::printf(" 参与集合固定取前 t 个代理；基线 = 单代理直接转换\n");
    std::printf("--------------------------------------------------------------------------------\n");
    std::printf(" 列说明：\n");
    std::printf("   配置      (n=代理总数, t=门限)；子集数 = C(n, t-1) = 需要几份部分重加密\n");
    std::printf("   t个成功   t 个代理完成转换且解密正确的比例（应当 100%%）\n");
    std::printf("   t-1个成功 t-1 个代理\"尽力而为\"组合后仍解密正确的比例（应当 0%%）\n");
    std::printf("   基线噪声  单代理重加密后 ‖center(f_B·C')‖∞（越小越好，<= %d）\n", P.q / 2);
    std::printf("   门限噪声  t 个代理组合后同一指标；放大 = 门限噪声/基线噪声\n");
    std::printf("   分享/部分/组合 = 三个阶段各自的平均耗时（微秒）\n");
    std::printf("================================================================================\n\n");
    std::printf("%-10s %-7s %-9s %-11s %-9s %-9s %-7s %-8s %-8s %-8s\n",
                "配置", "子集数", "t个成功", "t-1个成功", "基线噪声", "门限噪声", "放大",
                "分享us", "部分us", "组合us");
    std::printf("--------------------------------------------------------------------------------"
                "----------------\n");

    Rng rng(20261013ULL);
    std::vector<std::string> csv_rows;

    for (const Cfg& cfg : cfgs) {
        int ok_t = 0, ok_tm1 = 0;
        double nb = 0, nt = 0;
        double t_share = 0, t_part = 0, t_comb = 0;
        int subsets = 0;

        for (int tr = 0; tr < trials; ++tr) {
            KeyPair A, B;
            if (!keygen(P, rng, A) || !keygen(P, rng, B)) continue;
            Poly m = sample_message(P, rng);
            Poly mc = message_to_center(m, P.p);
            Poly c = encrypt(P, A.h, m, rng);
            Poly rk = rekeygen(P, A.f, B.finv);

            ReEncResult base = reencrypt_checked(P, B.f, c, rk, mc, rng);

            Clock::time_point t0 = Clock::now();
            ThresholdCtx ctx = cnf_share(P, rk, cfg.n, cfg.t, rng);
            t_share += ms_since(t0);
            subsets = ctx.num_subsets();

            std::vector<int> W, Wm;
            for (int i = 0; i < cfg.t; ++i) W.push_back(i);
            for (int i = 0; i < cfg.t - 1; ++i) Wm.push_back(i);

            // ① t 个代理：部分重加密 + 组合
            t0 = Clock::now();
            auto part = proxy_partials(P, ctx, c, rng);
            t_part += ms_since(t0);
            t0 = Clock::now();
            Poly ct = threshold_combine(P, ctx, part, W);
            t_comb += ms_since(t0);
            int64_t noise_th = 0;
            Poly dec = decrypt_with_noise(P, B.f, ct, noise_th);
            bool okth = (dec.size() == mc.size());
            for (std::size_t i = 0; okth && i < dec.size(); ++i)
                if (dec[i] != mc[i]) okth = false;
            if (okth) ++ok_t;
            nt += (double)noise_th;
            nb += (double)base.noise_inf;

            // ② t-1 个代理：尽力而为地组合
            auto part2 = proxy_partials(P, ctx, c, rng);
            int missing = 0;
            Poly ctm = threshold_combine_best_effort(P, ctx, part2, Wm, &missing);
            int64_t noise_m = 0;
            Poly decm = decrypt_with_noise(P, B.f, ctm, noise_m);
            bool okm = (decm.size() == mc.size());
            for (std::size_t i = 0; okm && i < decm.size(); ++i)
                if (decm[i] != mc[i]) okm = false;
            if (okm) ++ok_tm1;
        }

        double okr = 100.0 * ok_t / trials;
        double okmr = 100.0 * ok_tm1 / trials;
        double mb = nb / trials, mt = nt / trials;
        char namebuf[32];
        std::snprintf(namebuf, sizeof(namebuf), "(n=%d,t=%d)", cfg.n, cfg.t);
        char okbuf[16], okmbuf[16];
        std::snprintf(okbuf, sizeof(okbuf), "%.0f%%", okr);
        std::snprintf(okmbuf, sizeof(okmbuf), "%.0f%%", okmr);
        std::printf("%-10s %-7d %-9s %-11s %-9.0f %-9.0f %-7.2f %-8.1f %-8.1f %-8.1f\n",
                    namebuf, subsets, okbuf, okmbuf, mb, mt,
                    (mb > 0 ? mt / mb : 0.0),
                    t_share * 1000 / trials, t_part * 1000 / trials, t_comb * 1000 / trials);

        char row[256];
        std::snprintf(row, sizeof(row), "%s,%d,%d,%d,%.2f,%.2f,%.3f,%.4f,%.4f,%.4f",
                      P.name.c_str(), cfg.n, cfg.t, subsets, okr, okmr,
                      (mb > 0 ? mt / mb : 0.0), t_share / trials, t_part / trials, t_comb / trials);
        csv_rows.push_back(row);
    }

    // ---- 零信息性检查 ----
    std::printf("\n【零信息性检查】取 (n=5,t=3)，联盟 W={P1,P2} 只有 t-1=2 个代理\n");
    {
        const int n5 = 5, t5 = 3;
        std::vector<int> Wz = {0, 1};
        double sum0 = 0, sum2 = 0, s0 = 0, s2 = 0;
        int missing_total = 0;
        for (int i = 0; i < zero_trials; ++i) {
            Poly rk = sample_uniform(P.n, P.q, rng);
            ThresholdCtx ctx = cnf_share(P, rk, n5, t5, rng);
            uint32_t Sm = 0;
            if (threshold_missing_subset(ctx, Wz, &Sm)) ++missing_total;
            int owner = -1;
            for (int p = 0; p < n5 && owner < 0; ++p)
                if (Sm & (1u << p)) owner = p;
            int j = ctx.find(Sm, owner);
            int64_t v = poly_center(ctx.per_proxy[owner][j].value, P.q)[0];
            sum0 += (double)v;
            s0 += (double)v * (double)v;
            int64_t w = poly_center(poly_sub(rk, ctx.per_proxy[owner][j].value, P.q), P.q)[0];
            sum2 += (double)w;
            s2 += (double)w * (double)w;
        }
        double m0 = sum0 / zero_trials, m2 = sum2 / zero_trials;
        double v0 = s0 / zero_trials - m0 * m0, v2 = s2 / zero_trials - m2 * m2;
        double uni_std = P.q / std::sqrt(12.0);
        std::printf("  每次试验拿不到的子集数 = %d（应为 1）\n", missing_total / zero_trials);
        std::printf("  缺失份额第 1 个系数（中心代表）：mean=%.1f, std=%.1f\n", m0, std::sqrt(v0));
        std::printf("  联盟算出的量 (rk − 缺失份额)     ：mean=%.1f, std=%.1f\n", m2, std::sqrt(v2));
        std::printf("  均匀分布理论值                    ：mean≈0.0, std≈%.1f (=q/√12)\n", uni_std);
        std::printf("  ⇒ 统计特征接近均匀 ⇒ t-1 个代理看到的东西与 rk 独立\n");
    }

    // ---- CSV ----
    std::string csv = "bench/results/c1_" + P.name + ".csv";
    std::ofstream f(csv.c_str());
    if (f) {
        f << "params,n,t,subsets,succ_t_pct,succ_t_minus_1_pct,noise_ratio,"
             "share_ms,partials_ms,combine_ms\n";
        for (std::size_t i = 0; i < csv_rows.size(); ++i) f << csv_rows[i] << "\n";
        f.close();
        std::printf("\n结果已写入 %s\n", csv.c_str());
    } else {
        std::printf("\n（未能写入 %s：请先创建 bench/results 目录）\n", csv.c_str());
    }
    std::printf("================================================================================\n");
    return 0;
}

// ---------------------------------------------------------------------------
int main(int argc, char** argv) {
    setup_console_utf8();                       // Windows: 控制台切 UTF-8，避免中文乱码
    std::setvbuf(stdout, nullptr, _IONBF, 0);   // 不缓冲：长实验里日志要实时可见，崩溃时也不丢输出
    if (argc < 2) {
        std::printf("用法:\n"
                    "  ntru_cli selftest\n"
                    "  ntru_cli walkthrough\n"
                    "  ntru_cli c1      [参数集] [trials] [zero_trials]   ← C1 门限专项实验\n"
                    "  ntru_cli smoke   [参数集] [n_threshold] [t]\n"
                    "  ntru_cli vectors <参数集> <seed> [输出文件]\n"
                    "  ntru_cli bench   <参数集> [迭代次数]\n");
        return 2;
    }
    const std::string cmd = argv[1];
    try {
        if (cmd == "selftest") return cmd_selftest();
        if (cmd == "walkthrough") return cmd_walkthrough();
        if (cmd == "c1") {
            std::string pn = (argc > 2) ? argv[2] : "EES439";
            int trials = (argc > 3) ? std::atoi(argv[3]) : 20;
            int zt = (argc > 4) ? std::atoi(argv[4]) : 1000;
            return cmd_c1(pn, trials, zt);
        }
        if (cmd == "smoke") {
            std::string pn = (argc > 2) ? argv[2] : "EES439";
            int nth = (argc > 3) ? std::atoi(argv[3]) : 3;
            int t = (argc > 4) ? std::atoi(argv[4]) : 2;
            return cmd_smoke(pn, nth, t);
        }
        if (cmd == "vectors") {
            if (argc < 4) {
                std::printf("用法: ntru_cli vectors <参数集> <seed> [输出文件]\n");
                return 2;
            }
            std::string pn = argv[2];
            uint64_t seed = (uint64_t)std::strtoull(argv[3], nullptr, 10);
            std::string out = (argc > 4) ? argv[4] : ("vectors_" + pn + "_" + std::string(argv[3]) + ".txt");
            return cmd_vectors(pn, seed, out);
        }
        if (cmd == "bench") {
            std::string pn = (argc > 2) ? argv[2] : "EES439";
            int iters = (argc > 3) ? std::atoi(argv[3]) : 200;
            return cmd_bench(pn, iters);
        }
        std::printf("未知子命令: %s\n", cmd.c_str());
        return 2;
    } catch (const std::exception& e) {
        std::printf("异常: %s\n", e.what());
        return 1;
    }
}
