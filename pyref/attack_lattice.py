"""
格在哪里？—— 从公钥 h 恢复私钥 f 的格攻击复现
================================================
文件：pyref/attack_lattice.py

这是**"格"在代码里真正出现的地方**。其它所有算法（KeyGen/Enc/Dec/ReKeyGen/
ReEnc/门限分享）算的都是环 Z_q[x]/(x^n-1) 里的东西——那里一个格都看不到。
格出现的唯一原因是一条等价关系：

    h = p·g·f^{-1} (mod q)  <=>  f·h ≡ p·g (mod q)
                            <=>  向量 (f, p·g) 在格
        Λ_h = { (u,v) ∈ Z^{2n} : v ≡ u*h (mod q) }

而 (f, p·g) 是这个格里**特别短**的向量（f、g 系数都很小）。
于是："从公钥 h 求私钥 f"  ≡  "在 2n 维格 Λ_h 里找短向量（SVP）"，
LLL / BKZ 就是用来解 SVP 的工具——这就是格密码里那个"格"。

Λ_h 的一个基（2n 行 × 2n 列，行向量）：

        ⎡  I_n       H   ⎤      H[i][j] = h[(j - i) mod n]  （循环卷积矩阵）
        ⎣  0      q·I_n ⎦      ⇒ 格子里的向量形如 (u, u*h + q·w)

两个必须知道的事实（本脚本会实测出来）：
  1) **全 1 向量 (1,1,...,1) 永远在 Λ_h 里**：因为 g 的系数和恒为 0（dg 个 +1、
     dg 个 -1），所以 (Σg_i)·(all-ones) = 0，于是 (all-ones)·h = 0。
     它的范数只有 √n —— 比私钥还短！但它是一把**退化钥匙**：
     它 mod p 不等于常数多项式 1，解密出来的不是明文。
     ⇒ 所以判断"攻击是否成功"不能只看范数，**必须真的拿去解密**。
  2) 因此本脚本用两重判据：格向量要短，且用 u 解密 C 要能还原出 M。

用法：
    python pyref/attack_lattice.py --params TINY7  --seed 1
    python pyref/attack_lattice.py --params TINY61 --seed 1
    python pyref/attack_lattice.py --vectors bin/vectors_TINY61_1.txt

后端：优先 fpylll（WSL: pip install fpylll，快且支持 BKZ）；没有则退回 SymPy
      自带的精确 LLL（Windows/Anaconda 可用，适合百维级）。
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
# 1) 造格：NTRU 格 Λ_h 的基（2n × 2n）
# ---------------------------------------------------------------------------
def build_ntru_lattice(h, q: int) -> list:
    n = len(h)
    h = [int(x) % q for x in h]
    B = [[0] * (2 * n) for _ in range(2 * n)]
    for i in range(n):
        B[i][i] = 1
        for j in range(n):
            B[i][n + j] = h[(j - i) % n]          # 循环卷积矩阵 H
        B[n + i][n + i] = q
    return B


# ---------------------------------------------------------------------------
# 2) 格约化
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
# 3) 判据：能不能真的解密
# ---------------------------------------------------------------------------
def decrypt_with_candidate(u, C, q, p):
    """用候选 u 当私钥解密：center(u·C) mod p -> {-1,0,1}"""
    prod = poly_mul_cyclic_fast(np.asarray(u, dtype=np.int64) % q,
                                np.asarray(C, dtype=np.int64) % q, q)
    c = poly_center(prod, q) % p
    return np.where(c > p // 2, c - p, c)


def is_usable_key(u, h, C, M_center, q, p, u_bound):
    """u 可用的三个条件：系数小、u*h 不是零多项式、解密结果等于明文"""
    if max((abs(int(x)) for x in u), default=0) > u_bound:
        return False, None
    v = poly_mul_cyclic_fast(np.asarray(u, dtype=np.int64) % q,
                             np.asarray(h, dtype=np.int64) % q, q)
    vc = poly_center(v, q)
    if not np.any(vc):                     # u*h ≡ 0：退化钥匙（例如全 1 向量）
        return False, None
    dec = decrypt_with_candidate(u, C, q, p)
    ok = bool(np.array_equal(dec, M_center))
    return ok, vc


def find_keys(Bred, h, C, M_center, q, p, n, u_bound=7, combo_rows=8, coeff_range=1):
    """
    两步搜索（这是 NTRU 格攻击的标准收尾，LEL 只负责"约化"）：
      (a) 逐行检查约化基；
      (b) 对最短的 combo_rows 行做系数在 [-coeff_range, coeff_range] 的组合枚举。

    关键：**先用 `u ≡ 1 (mod p)` 过滤**。原因是 NTRU 的私钥必须满足 f ≡ 1 (mod p)，
    否则解密出来的是明文的某个线性变换而不是明文本身；而格里有大量"范数更短但
    残留类不对"的向量（最典型的就是全 1 向量 (1,...,1)：范数只有 √n，但 u mod p ≠ 1）。
    不加这个过滤，搜索既慢又找不到真钥匙。
    """
    rows = [([int(x) for x in r[:n]], [int(x) for x in r[n:]]) for r in Bred]
    rows.sort(key=lambda t: sum(x * x for x in t[0]) + sum(x * x for x in t[1]))
    U = np.array([u for u, _ in rows], dtype=np.int64)      # (2n, n)

    found = []

    def try_u(u_list):
        ok, _ = is_usable_key(u_list, h, C, M_center, q, p, u_bound)
        if ok and u_list not in found:
            found.append(u_list)

    # (a) 单行
    for u, _ in rows:
        try_u(u)

    # (b) 组合枚举（带 u ≡ 1 (mod p) 预过滤）
    k = min(combo_rows, len(rows))
    rng_c = range(-coeff_range, coeff_range + 1)
    for coeffs in itertools.product(rng_c, repeat=k):
        if not any(coeffs):
            continue
        u = np.asarray(coeffs, dtype=np.int64) @ U[:k]
        if int(u[0]) % p != 1 % p or any(int(x) % p != 0 for x in u[1:]):
            continue
        try_u([int(x) for x in u])
    return found, rows


# ---------------------------------------------------------------------------
# 4) 理论估算
# ---------------------------------------------------------------------------
def theory(n, q, df, dg, p):
    dim = 2 * n
    log2det = n * math.log2(q)
    gh = math.sqrt(dim / (2 * math.pi * math.e)) * 2 ** (log2det / dim)
    target = math.sqrt(2 * df + (p * p) * 2 * dg)
    return dict(dim=dim, log2det=log2det, gh=gh, target=target,
                lll_reach=2 ** (dim / 4), allones=math.sqrt(n))


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="NTRU 公钥格攻击复现（从 h 恢复 f）")
    ap.add_argument("--params", default=None)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--vectors", default=None)
    ap.add_argument("--backend", choices=["auto", "fpylll", "sympy"], default="auto")
    ap.add_argument("--max-dim", type=int, default=32,
                    help="超过该维数不做实际约化（SymPy 精确 LLL 在 >32 维上很慢；"
                         "WSL 里装了 fpylll 后可用 --backend fpylll --max-dim 900）")
    ap.add_argument("--combo-rows", type=int, default=8,
                    help="对最短的若干行做枚举（默认 8）")
    ap.add_argument("--coeff-range", type=int, default=1,
                    help="枚举系数范围 ±r（默认 1，即 {-1,0,1}）")
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
    h = np.asarray(v["HA"], dtype=np.int64)
    C = np.asarray(v["C"], dtype=np.int64)
    M = np.asarray(v["M"], dtype=np.int64)
    M_center = np.where(M % p > p // 2, (M % p) - p, M % p)
    f_true = [int(x) for x in poly_center(np.asarray(v["FA"], dtype=np.int64), q)]

    print("=" * 76)
    print(f" 格攻击复现：参数 {v.get('PARAMS', '?')}，n={n}, q={q}, p={p}")
    print(f" 格 Λ_h：维数 2n = {2 * n}，det = q^n = 2^{n * math.log2(q):.1f}")
    print("=" * 76)

    # df/dg：f = 1 + p*F，g = dg(+) dg(-)
    invp = pow(p, -1, q)
    Fctr = poly_center(((np.asarray(f_true) - (np.arange(n) == 0) * 1) * invp) % q, q)
    df = int(np.count_nonzero(Fctr)) // 2
    dg = int(np.count_nonzero(poly_center(np.asarray(v["GA"], dtype=np.int64), q))) // 2
    th = theory(n, q, max(df, 1), max(dg, 1), p)

    print(f"  真私钥 f（中心代表）= {f_true}")
    print(f"  df={df}, dg={dg}；目标短向量 (f, p*g) 范数 ≈ {th['target']:.2f}")
    print(f"  格的高斯启发式最短向量长度 ≈ {th['gh']:.2f}")
    print(f"  ⚠ 但格里还有一个更短的向量：全 1 向量 (1,..,1,0,..,0)，范数 = √n = {th['allones']:.2f}")
    print(f"     （因为 g 的系数和恒为 0 ⇒ (all-ones)·h = 0）——它是退化钥匙，解密不出明文")
    print()

    if 2 * n > args.max_dim:
        print(f"  [跳过实际约化] 2n = {2 * n} > --max-dim = {args.max_dim}")
        print(f"  LLL 最坏逼近因子 ≈ 2^(dim/4) = {th['lll_reach']:.3g}，"
              f"目标是 GH 的 1/{th['gh'] / th['target']:.1f}；")
        print("  维数一大，LLL 就够不着，必须 BKZ 提高块大小 —— 这就是「参数越大越安全」的含义。")
        print()
        print("  想在本机实跑大维数：WSL(Ubuntu) 里 `pip install fpylll` 后重跑：")
        print(f"      python3 pyref/attack_lattice.py --params {args.params or 'EES439'} "
              f"--backend fpylll --max-dim 2000")
        return 0

    print(f"  正在 LLL 约化（后端 {args.backend}，维数 {2 * n}）...")
    t0 = time.time()
    Bred, used = reduce_basis(build_ntru_lattice(h, q), args.backend)
    dt = time.time() - t0
    print(f"  完成：后端={used}，耗时 {dt:.2f} s")

    found, rows = find_keys(Bred, h, C, M_center, q, p, n,
                            u_bound=max(4, 2 * p + 1),
                            combo_rows=args.combo_rows,
                            coeff_range=args.coeff_range)
    print(f"  约化后最短 3 行（前 8 个坐标）：")
    for i in range(min(3, len(rows))):
        u, vv = rows[i]
        print(f"     #{i+1}  u={u[:8]}...  u*h mod q={[int(x) for x in vv[:8]]}...")
    print()

    if not found:
        print("  ✗ LLL 之后没有找到能正确解密的密钥（需要 BKZ 更大块大小）")
        return 1

    print(f"  ✓ 找到 {len(found)} 把能正确解密的密钥：")
    ok_true = False
    for i, u in enumerate(found):
        same = (u == f_true) or ([(-x) for x in u] == f_true)
        ok_true = ok_true or same
        print(f"    密钥 {i+1}: u = {u}")
        print(f"             与真私钥 f 相同？{'是 ✓（精确恢复）' if same else '否（但同样能解密 ⇒ 等价密钥）'}")
    print()
    print("  结论：环 Z_q[x]/(x^n-1) 里看不到格；但「公钥 → 私钥」这一步的困难性")
    print(f"        等价于在 {2*n} 维格 Λ_h 里找短向量，LLL/BKZ 就是攻击手段。")
    print(f"        本次：{'精确恢复了私钥' if ok_true else '恢复了等价私钥（同样能解密）'}。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
