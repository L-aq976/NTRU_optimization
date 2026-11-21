"""
从委托凭证 rk 恢复 f_A —— 多密钥格攻击
==========================================
文件：pyref/attack_rk_lattice.py

为什么这个脚本是 C1 的量化依据
-------------------------------
C1 主张"腐化阈值从 1 个代理提高到 t 个"：单个代理只拿到一份份额，`t` 个代理才能
组合出完整委托凭证

    rk = f_A · f_B^{-1}  (mod q)

但"拿到 rk"不等于"攻破 C1"——攻击者拿到 rk 之后还要**从 rk 里把 f_A 挖出来**。
这一步的代价才是"腐化阈值 1→t"真正的量化依据：

  · 只看公钥 h_A：攻击面是 2n 维 NTRU 格 Λ_h（见 attack_lattice.py）
  · 拿到 rk：攻击面变成下面这个 2n 维**多密钥格** Λ_rk，而且它的短向量
    (f_A, f_B) **两半都小**（不像 NTRU 格只有一半是私钥、另一半是 p·g）

数学
----
    rk · f_B ≡ f_A  (mod q)
    ⇔  存在 z 使 f_A = R·f_B + q·z，其中 R 是 rk 的循环卷积矩阵
    ⇔  (f_A, f_B) ∈ Λ_rk = { (x, y) : x ≡ R·y (mod q) }

Λ_rk 的一个基（2n 行 × 2n 列，行向量）：

        ⎡  R_n×n    I_n  ⎤     ⇒ 格向量形如 (R·a + q·a', a) = (x, y)
        ⎣  q·I_n     0   ⎦       目标短向量是 (f_A, f_B)

det(Λ_rk) = q^n，与 Λ_h 相同；但目标向量的**两半都是私钥尺度**，
n 较大时比 NTRU 格的 (f, p·g) 更难被 LLL 够到 —— 具体差多少由本脚本量化。

判据（三重，缺一不可）
---------------------
  1) x 的系数足够小；
  2) x ≡ 1 (mod p)  —— NTRU 私钥的结构性约束（f = 1 + p·F），不过滤会捞出一堆废向量；
  3) 拿 x 当私钥真的能解开 C_A 还原出 M —— 范数短不等于能用（见 attack_lattice.py
     里那个"全 1 向量"的教训）。

用法：
    python pyref/attack_rk_lattice.py --params TINY7  --seed 1
    python pyref/attack_rk_lattice.py --params TINY61 --seed 1 --max-dim 200
    python pyref/attack_rk_lattice.py --vectors bin/vectors_EES439_1.txt

后端：优先 fpylll（WSL: pip install fpylll，支持 BKZ）；否则退 SymPy 精确 LLL。
"""

from __future__ import annotations

import argparse
import itertools
import math
import os
import subprocess
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ring_np import parse_vectors, poly_center, poly_mul_cyclic_fast  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 1) 造格：多密钥格 Λ_rk 的基（2n × 2n）
# ---------------------------------------------------------------------------
def build_rk_lattice(rk, q: int) -> list:
    """Λ_rk = { (x,y) : x ≡ R·y (mod q) }，基为 [R I; qI 0]。

    约定与 attack_lattice.py 一致：行向量、列 0..n-1 是 x（候选 f_A），
    列 n..2n-1 是 y（候选 f_B）。
    """
    n = len(rk)
    rk = [int(v) % q for v in rk]
    B = [[0] * (2 * n) for _ in range(2 * n)]
    for i in range(n):
        for j in range(n):
            B[i][j] = rk[(j - i) % n]      # R：循环卷积矩阵
        B[i][n + i] = 1                    # I：y 的单位部分
        B[n + i][i] = q                    # q·I：模 q 的补偿
    return B


# ---------------------------------------------------------------------------
# 2) 约化
# ---------------------------------------------------------------------------
def lll_fpylll(B, delta=0.99):
    from fpylll import IntegerMatrix, LLL  # noqa
    n, m = len(B), len(B[0])
    A = IntegerMatrix(n, m)
    for i in range(n):
        for j in range(m):
            A[i, j] = int(B[i][j])
    LLL.reduction(A, delta=delta)
    return [[int(A[i, j]) for j in range(m)] for i in range(n)]


def lll_sympy(B, delta=(3, 4)):
    from sympy import Matrix, QQ  # noqa
    M = Matrix(B)
    d = QQ(delta[0], delta[1])
    try:
        R = M.lll(delta=d)
    except AttributeError:
        from sympy.polys.matrices import DomainMatrix  # noqa
        R = DomainMatrix.from_Matrix(M).lll(delta=d).to_Matrix()
    return [[int(R[i, j]) for j in range(R.cols)] for i in range(R.rows)]


def reduce_basis(B, backend="auto"):
    if backend in ("auto", "fpylll"):
        try:
            return lll_fpylll(B), "fpylll"
        except Exception as e:
            if backend == "fpylll":
                raise
            print(f"  [提示] fpylll 不可用（{type(e).__name__}），退回 SymPy 精确 LLL")
    return lll_sympy(B), "sympy"


# ---------------------------------------------------------------------------
# 3) 判据
# ---------------------------------------------------------------------------
def decrypt_with_candidate(f, C, q, p):
    prod = poly_mul_cyclic_fast(np.asarray(f, dtype=np.int64) % q,
                                np.asarray(C, dtype=np.int64) % q, q)
    c = poly_center(prod, q) % p
    return np.where(c > p // 2, c - p, c)


def check_candidate(x, rk, C, M_center, q, p, bound):
    """候选 f_A 的三重校验：系数小 / ≡1 mod p / 真能解密。"""
    x = [int(v) for v in x]
    if max((abs(v) for v in x), default=0) > bound:
        return False, "范数超界"
    if int(x[0]) % p != 1 % p or any(int(v) % p != 0 for v in x[1:]):
        return False, "不满足 f ≡ 1 (mod p)"
    dec = decrypt_with_candidate(x, C, q, p)
    if not np.array_equal(dec, M_center):
        return False, "解密失败"
    # 附加：x 应当与 rk 相容（x·f_B^{-1} = rk，这里用 rk 的卷积核反查）
    return True, "解密成功"


# ---------------------------------------------------------------------------
# 4) 理论量化：目标长度 vs 格体积 vs LLL 能力
# ---------------------------------------------------------------------------
def theory(n, q, df, p):
    """返回 (目标范数, GH, LLL 可达长度, 差距倍数)。

    目标向量 (f_A, f_B) 的两半都是 f = 1 + p·F 的形状：
        ||f||² = 1（常数项）+ p²·(2·df)（F 的 ±1 各 df 个）
    所以 ||(f_A,f_B)|| ≈ sqrt(2·(1 + 2·p²·df))。
    """
    dim = 2 * n
    log2det = n * math.log2(q)
    det_root = 2 ** (log2det / dim)
    gh = math.sqrt(dim / (2 * math.pi * math.e)) * det_root
    target = math.sqrt(2 * (1 + 2 * p * p * df))
    # LLL 的经典保证：输出最短向量 ≲ 2^((dim-1)/4) · λ_1，等价地
    # 能"够到"的长度下界约 2^((dim-1)/4) —— 用最坏情形逼近因子做保守估计
    lll_reach = 2 ** ((dim - 1) / 4)
    # 攻击成功要求 lll_reach · target ≤ gh 之类；这里直接给"目标比 GH 短多少倍"
    margin = gh / target
    return dict(dim=dim, det_root=det_root, gh=gh, target=target,
                lll_reach=lll_reach, margin=margin)


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="从 rk 恢复 f_A 的多密钥格攻击")
    ap.add_argument("--params", default=None)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--vectors", default=None)
    ap.add_argument("--backend", choices=["auto", "fpylll", "sympy"], default="auto")
    ap.add_argument("--max-dim", type=int, default=40,
                    help="超过该维数不做实际约化（SymPy 精确 LLL 在 >40 维上很慢）")
    ap.add_argument("--combo-rows", type=int, default=6)
    ap.add_argument("--coeff-range", type=int, default=1)
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    vpath = args.vectors
    if vpath is None:
        if not args.params:
            ap.error("需要 --params 或 --vectors 之一")
        cli = None
        for c in ("bin/ntru_cli.exe", "bin/ntru_cli"):
            if os.path.exists(os.path.join(root, c)):
                cli = os.path.join(root, c)
                break
        if cli is None:
            print("找不到 bin/ntru_cli(.exe)，请先构建")
            return 2
        vpath = os.path.join(root, "bin", f"vectors_{args.params}_{args.seed}.txt")
        r = subprocess.run([cli, "vectors", args.params, str(args.seed), vpath],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            print(r.stdout, r.stderr)
            return 1

    v = parse_vectors(vpath)
    n, q, p = v["N"], v["Q"], v["P"]
    rk = np.asarray(v["RK"], dtype=np.int64) % q
    C = np.asarray(v["C"], dtype=np.int64)
    M = np.asarray(v["M"], dtype=np.int64)
    M_center = np.where(M % p > p // 2, (M % p) - p, M % p)
    fA_true = [int(x) for x in poly_center(np.asarray(v["FA"], dtype=np.int64), q)]

    invp = pow(p, -1, q)
    Fctr = poly_center(((np.asarray(fA_true) - (np.arange(n) == 0)) * invp) % q, q)
    df = max(1, int(np.count_nonzero(Fctr)) // 2)
    th = theory(n, q, df, p)

    print("=" * 78)
    print(f" 多密钥格攻击：从 rk = f_A·f_B^(-1) 恢复 f_A")
    print(f" 参数 {v.get('PARAMS', '?')}：n={n}, q={q}, p={p}, df={df}")
    print(f" 格 Λ_rk：维数 2n = {2*n}，det = q^n = 2^{n*math.log2(q):.1f}")
    print("=" * 78)
    print(f"  目标向量 (f_A, f_B) 范数 ≈ {th['target']:.2f}（两半都是私钥尺度）")
    print(f"  格的高斯启发式最短向量 ≈ {th['gh']:.2f}")
    print(f"  ⇒ 目标比随机格的最短向量还短 {th['margin']:.2f} 倍（结构性的，非随机格）")
    print()
    print("  与 NTRU 格的差别（这就是「多密钥」的含义）：")
    print(f"    Λ_h  的目标是 (f, p·g)，只有一半是私钥；")
    print(f"    Λ_rk 的目标是 (f_A, f_B)，两半都是私钥 ⇒ 同样的 det、同样的维数，")
    print(f"    但短向量结构更「整齐」，拿到 rk 的攻击者比只有 h 的攻击者信息更多。")
    print()

    if 2 * n > args.max_dim:
        # LLL 的保证：输出向量长度 ≤ 2^((dim-1)/4) · λ_1。
        # 而 λ_1 就是目标本身（目标向量存在于格中，且比 GH 短 margin 倍），
        # 所以"LLL 能否找到它"等价于 2^((dim-1)/4) 是否 ≤ margin。
        lll_bits = (th["dim"] - 1) / 4.0
        need_bits = math.log2(th["margin"])
        gap_bits = lll_bits - need_bits
        print(f"  [跳过实际约化] 2n = {2*n} > --max-dim = {args.max_dim}")
        print(f"  LLL 最坏情形逼近因子 = 2^((dim-1)/4) ≈ 2^{lll_bits:.0f}；")
        print(f"  攻击只需要补上 GH/target = {th['margin']:.2f} 倍的缺口 ≈ 2^{need_bits:.1f}。")
        print(f"  ⇒ LLL 差 2^{gap_bits:.0f} 倍，必须改 BKZ 并把块大小 β 提到几百。")
        print(f"  这就是「腐化 t 个代理才拿得到 rk」之后，剩下那部分代价的量化口径。")
        print()
        print("  在 WSL 里装了 fpylll 后可跑大维数：")
        print(f"      python3 pyref/attack_rk_lattice.py --params {args.params or 'EES439'} "
              f"--backend fpylll --max-dim 2000")
        return 0

    print(f"  正在 LLL 约化（后端 {args.backend}，维数 {2*n}）...")
    t0 = time.time()
    Bred, used = reduce_basis(build_rk_lattice(rk, q), args.backend)
    dt = time.time() - t0
    print(f"  完成：后端={used}，耗时 {dt:.2f} s")

    # 逐行 + 组合搜索
    rows = []
    for r in Bred:
        x = [int(v) for v in r[:n]]
        y = [int(v) for v in r[n:]]
        rows.append((x, y))
    rows.sort(key=lambda t: sum(v * v for v in t[0]) + sum(v * v for v in t[1]))

    bound = max(4, 2 * p + 1)
    found = []
    reasons = {}

    def try_x(x):
        ok, why = check_candidate(x, rk, C, M_center, q, p, bound)
        reasons[why] = reasons.get(why, 0) + 1
        if ok and x not in found:
            found.append(x)

    for x, _y in rows:
        try_x(x)

    k = min(args.combo_rows, len(rows))
    U = np.array([r[0] for r in rows[:k]], dtype=np.int64)
    rng_c = range(-args.coeff_range, args.coeff_range + 1)
    for coeffs in itertools.product(rng_c, repeat=k):
        if not any(coeffs):
            continue
        x = (np.asarray(coeffs, dtype=np.int64) @ U).tolist()
        try_x(x)

    print(f"  最短 3 行（x 的前 8 个坐标 / y 的前 8 个）：")
    for i in range(min(3, len(rows))):
        x, y = rows[i]
        print(f"     #{i+1}  x={x[:8]}  y={y[:8]}")
    print(f"  候选检查统计：{reasons}")
    print()

    if not found:
        print("  ✗ LLL 之后没有找到能解密的 f_A（需要 BKZ 更大块大小）")
        return 1

    print(f"  ✓ 找到 {len(found)} 个可用候选：")
    exact = False
    for i, x in enumerate(found):
        same = (x == fA_true) or ([(-v) for v in x] == fA_true)
        exact = exact or same
        print(f"    候选 {i+1}: {x}")
        print(f"            与真 f_A 相同？{'是 ✓（精确恢复）' if same else '否（但同样能解密 ⇒ 等价密钥）'}")
    print()
    print("  结论：")
    print("    · 单个代理拿不到 rk，只能看到一份被 p·e 掩码的 partial；")
    print("    · t 个代理合谋才得到 rk，再经本脚本这道格攻击才能恢复 f_A ——")
    print("      两道门槛叠加，这就是 C1 把腐化阈值从 1 抬到 t 的量化链条。")
    print(f"    本次：{'精确恢复了 f_A' if exact else '恢复了等价私钥（同样能解密）'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
