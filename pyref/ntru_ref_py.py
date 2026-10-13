"""
C++ 引擎的 Python 参考实现（第二部分）：多项式求逆
=====================================================
文件：pyref/ntru_ref_py.py

Python 的任意精度整数让 GF(2) 多项式运算变得极其干净：
  * GF(2)[x] 的多项式 <-> 一个整数（bit i = x^i 的系数）
  * 加减 = 异或，乘 = 移位异或，带余除法 = 移位异或循环
  * mod (x^n - 1) = 把 >= n 的位折回低 n 位

求逆两步（和 C++ 侧一致）：
  1) 在 GF(2)[x]/(x^n - 1) 上用扩展欧几里得求 f^{-1} mod 2
  2) Newton/Hensel 提升到 mod 2^16，再按 q 取模（q = 2^11 | 2^16）
"""

from __future__ import annotations

import numpy as np

from ring_np import poly_center, poly_from_list, poly_mul_cyclic_fast


# ---------------------------------------------------------------------------
# GF(2)[x] 工具（用整数表示多项式）
# ---------------------------------------------------------------------------
def _deg(a: int) -> int:
    return a.bit_length() - 1


def _divmod_gf2(a: int, b: int):
    """GF(2)[x] 带余除法，返回 (商, 余)"""
    q = 0
    r = a
    db = _deg(b)
    while r and _deg(r) >= db:
        sh = _deg(r) - db
        q ^= 1 << sh
        r ^= b << sh
    return q, r


def _mul_gf2(a: int, b: int) -> int:
    r = 0
    while b:
        if b & 1:
            r ^= a
        b >>= 1
        a <<= 1
    return r


def _reduce_xn_minus_1(a: int, n: int) -> int:
    """把 >= n 的位折回低位：x^i -> x^(i-n)"""
    while _deg(a) >= n:
        i = _deg(a)
        a ^= (1 << i) | (1 << (i - n))
    return a


def inv_mod2_poly_int(f_int: int, n: int) -> int | None:
    """
    在 GF(2)[x]/(x^n - 1) 中求逆（整数表示）
    返回 None 表示不可逆
    """
    r0 = (1 << n) | 1          # x^n - 1（GF(2) 上 -1 = +1）
    r1 = _reduce_xn_minus_1(f_int, n)
    t0, t1 = 0, 1
    while r1:
        q, r = _divmod_gf2(r0, r1)
        r0, r1 = r1, r
        t0, t1 = t1, _reduce_xn_minus_1(t0 ^ _mul_gf2(q, t1), n)
    if r0 != 1:
        return None
    return _reduce_xn_minus_1(t0, n)


# ---------------------------------------------------------------------------
# 环运算（整数多项式 -> numpy 数组）
# ---------------------------------------------------------------------------
def poly_inv_mod_q(f: np.ndarray, q: int) -> np.ndarray | None:
    """Z_q[x]/(x^n-1) 中求逆；q 必须是 2 的幂且 q <= 2^16"""
    assert q & (q - 1) == 0 and q <= (1 << 16), "q 必须是 <= 2^16 的 2 的幂"
    n = int(f.shape[0])

    f_int = 0
    for i in range(n):
        if int(f[i]) & 1:
            f_int |= 1 << i

    g2 = inv_mod2_poly_int(f_int, n)
    if g2 is None:
        return None

    # 把整数多项式转回系数数组
    g = np.zeros(n, dtype=np.int64)
    for i in range(n):
        g[i] = (g2 >> i) & 1

    M = 1 << 16
    fm = np.asarray(f, dtype=np.int64) % M

    for _ in range(4):  # 精度 1 -> 2 -> 4 -> 8 -> 16 位
        fg = poly_mul_cyclic_fast(fm, g, M)
        h = np.zeros(n, dtype=np.int64)
        # 注意 "2" 是常数多项式（只有第 0 个系数是 2）
        h[0] = (2 - int(fg[0])) % M
        h[1:] = (0 - fg[1:]) % M
        g = poly_mul_cyclic_fast(g, h, M)

    out = g % q
    chk = poly_mul_cyclic_fast(np.asarray(f, dtype=np.int64) % q, out, q)
    one = np.zeros(n, dtype=np.int64)
    one[0] = 1
    return out if np.array_equal(chk, one) else None


# ---------------------------------------------------------------------------
# NTRU 基础算法（与 C++ 侧同构）
# ---------------------------------------------------------------------------
def keygen_from_parts(n: int, q: int, p: int, F_list, g_list):
    """给定 F（三元）与 g（三元），构造 f = 1 + p*F、h = p*g*f^{-1}"""
    F = poly_from_list(F_list)
    g = poly_from_list(g_list)
    f_small = np.zeros(n, dtype=np.int64)
    f_small[0] = 1
    f_small = f_small + p * F
    f = f_small % q
    finv = poly_inv_mod_q(f, q)
    if finv is None:
        return None
    h = (p * poly_mul_cyclic_fast(g % q, finv, q)) % q
    return dict(f=f, finv=finv, g=g % q, h=h)


def decrypt_center(f: np.ndarray, c: np.ndarray, q: int, p: int) -> np.ndarray:
    """中心代表(f*c) mod p -> {-1,0,1}"""
    a = poly_mul_cyclic_fast(np.asarray(f) % q, np.asarray(c) % q, q)
    cc = poly_center(a, q) % p
    return np.where(cc > p // 2, cc - p, cc)
