// ============================================================================
//  单元测试（独立于 CLI，失败返回非零；CI/脚本友好）
//  文件名：tests/test_core.cpp
//
//  构建见 Makefile 的 test 目标，或：
//    g++ -O3 -std=c++17 -Isrc src/core/*.cpp tests/test_core.cpp -o bin/ntru_tests
// ============================================================================
#include "core/ntru.h"
#include "core/params.h"
#include "core/poly_inv.h"
#include "core/pre_base.h"
#include "core/ring.h"
#include "core/sampler.h"
#include "core/threshold.h"

#include <cstdint>
#include <cstdio>
#include <vector>

#if defined(_WIN32)
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#endif

using namespace ntru;

static int g_fail = 0;
static int g_pass = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        if (cond) {                                                        \
            ++g_pass;                                                      \
        } else {                                                           \
            std::printf("[FAIL] %s:%d  %s\n", __FILE__, __LINE__, #cond);   \
            ++g_fail;                                                      \
        }                                                                  \
    } while (0)

static Params small_params(int n) {
    Params P;
    P.name = "TEST";
    P.n = n;
    P.q = 2048;
    P.p = 3;
    P.df = 10;
    P.dg = 10;
    P.dr = 10;
    P.dm0 = 5;
    P.dm1 = 5;
    P.validate();
    return P;
}

// ---------------------------------------------------------------------------
static void test_ring() {
    Params P = small_params(61);
    Rng rng(1);
    for (int t = 0; t < 5; ++t) {
        Poly a = sample_uniform(P.n, P.q, rng);
        Poly b = sample_uniform(P.n, P.q, rng);
        Poly r = poly_mul_ref(a, b, P.q);
        CHECK(poly_equal(r, poly_mul_fast(a, b, P.q)));
        CHECK(poly_equal(r, poly_mul_i32(a, b, P.q)));
    }
    // 加法/减法/取负的代数性质
    Poly a = sample_uniform(P.n, P.q, rng);
    Poly b = sample_uniform(P.n, P.q, rng);
    CHECK(poly_equal(poly_add(a, b, P.q), poly_add(b, a, P.q)));
    CHECK(poly_equal(poly_sub(a, b, P.q), poly_neg(poly_sub(b, a, P.q), P.q)));
    // 中心代表往返
    Poly c = poly_center(a, P.q);
    for (int i = 0; i < P.n; ++i) CHECK(from_center(c[i], P.q) == a[i]);
}

static void test_inverse() {
    for (int trial = 0; trial < 3; ++trial) {
        Params P = small_params(61);
        Rng rng(100 + trial);
        KeyPair kp;
        CHECK(keygen(P, rng, kp));
        Poly prod = poly_mul_ref(kp.f, kp.finv, P.q);
        Poly one = poly_zero(P.n);
        one[0] = 1;
        CHECK(poly_equal(prod, one));
    }
}

static void test_pre_roundtrip() {
    Params P = small_params(61);
    Rng rng(2024);
    KeyPair A, B;
    CHECK(keygen(P, rng, A));
    CHECK(keygen(P, rng, B));
    Poly m = sample_message(P, rng);
    Poly mc = message_to_center(m, P.p);
    Poly c = encrypt(P, A.h, m, rng);
    CHECK(message_equal(P, m, decrypt(P, A.f, c)));

    Poly rk = rekeygen(P, A.f, B.finv);
    ReEncResult rr = reencrypt_checked(P, B.f, c, rk, mc, rng);
    CHECK(rr.ok);
    CHECK(rr.noise_inf < P.q / 2);
}

static void test_threshold_structure() {
    Params P = small_params(61);
    Rng rng(7);
    const int cases[][2] = {{3, 2}, {4, 2}, {5, 2}, {5, 3}, {6, 4}, {4, 4}};
    for (const auto& cs : cases) {
        const int n = cs[0], t = cs[1];
        Poly rk = sample_uniform(P.n, P.q, rng);
        ThresholdCtx ctx = cnf_share(P, rk, n, t, rng);

        // (a) 份额之和 == rk
        Poly sum = poly_zero(P.n);
        for (uint32_t S : ctx.subsets) {
            int owner = -1;
            for (int p = 0; p < n && owner < 0; ++p)
                if (S & (1u << p)) owner = p;
            int j = ctx.find(S, owner);
            CHECK(j >= 0);
            sum = poly_add(sum, ctx.per_proxy[owner][j].value, P.q);
        }
        CHECK(poly_equal(sum, rk));

        // (b) 任何 t 个代理覆盖全部子集
        std::vector<int> W;
        for (int i = 0; i < t; ++i) W.push_back(i);
        bool cover = true;
        for (uint32_t S : ctx.subsets) {
            bool inter = false;
            for (int p : W)
                if (S & (1u << p)) inter = true;
            if (!inter) cover = false;
        }
        CHECK(cover);

        // (c) 任何 t-1 个代理必然漏掉某个子集
        std::vector<int> Wm;
        for (int i = 0; i < t - 1; ++i) Wm.push_back(i);
        bool uncovered = false;
        for (uint32_t S : ctx.subsets) {
            bool inter = false;
            for (int p : Wm)
                if (S & (1u << p)) inter = true;
            if (!inter) uncovered = true;
        }
        CHECK(uncovered);
    }
}

static void test_threshold_end2end() {
    const int cases[][2] = {{3, 2}, {5, 2}, {5, 3}};
    for (const auto& cs : cases) {
        Params P = small_params(61);
        Rng rng(4242 + cs[0] * 10 + cs[1]);
        KeyPair A, B;
        CHECK(keygen(P, rng, A));
        CHECK(keygen(P, rng, B));
        Poly m = sample_message(P, rng);
        Poly mc = message_to_center(m, P.p);
        Poly c = encrypt(P, A.h, m, rng);
        Poly rk = rekeygen(P, A.f, B.finv);

        ThresholdCtx ctx = cnf_share(P, rk, cs[0], cs[1], rng);
        std::vector<int> W;
        for (int i = 0; i < cs[1]; ++i) W.push_back(i);
        ThresholdResult tr = threshold_reencrypt_checked(P, ctx, c, B.f, mc, W, rng);
        CHECK(tr.ok);
        CHECK(tr.subsets_used == (int)ctx.subsets.size());
    }
}

// 真实参数上的往返（EES439，n=439）
static void test_real_params() {
    const Params& P = param_ees439();
    P.validate();
    Rng rng(5);
    KeyPair A, B;
    CHECK(keygen(P, rng, A));
    CHECK(keygen(P, rng, B));
    Poly m = sample_message(P, rng);
    Poly mc = message_to_center(m, P.p);
    Poly c = encrypt(P, A.h, m, rng);
    CHECK(message_equal(P, m, decrypt(P, A.f, c)));
    Poly rk = rekeygen(P, A.f, B.finv);
    ReEncResult rr = reencrypt_checked(P, B.f, c, rk, mc, rng);
    CHECK(rr.ok);

    ThresholdCtx ctx = cnf_share(P, rk, 3, 2, rng);
    std::vector<int> W = {0, 1};
    ThresholdResult tr = threshold_reencrypt_checked(P, ctx, c, B.f, mc, W, rng);
    CHECK(tr.ok);
}

int main() {
#if defined(_WIN32)
    SetConsoleOutputCP(CP_UTF8);   // Windows 控制台切 UTF-8，避免中文乱码
#endif
    std::printf("=== 单元测试开始 ===\n");
    test_ring();
    test_inverse();
    test_pre_roundtrip();
    test_threshold_structure();
    test_threshold_end2end();
    test_real_params();
    std::printf("=== 通过 %d 项，失败 %d 项 ===\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
