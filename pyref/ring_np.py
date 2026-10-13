"""
C++ 引擎的 Python 参考实现（用于逐位对齐与独立复核）
=====================================================
文件：pyref/ring_np.py

约定与 C++ 侧完全一致（见 src/core/ring.h）：
  * 系数保存在 [0, q)
  * 乘法是 R = Z_q[x]/(x^n - 1) 上的循环卷积
  * 中心代表 c 满足 -q/2 < c <= q/2

这里刻意写得"笨而清楚"：它就是用来当对照的，不追求快。
"""

from __future__ import annotations

import numpy as np


def mod_q(x, q: int):
    """取模到 [0, q)（支持负数与 numpy 数组）"""
    return np.mod(x, q)


def poly_mul_cyclic(a: np.ndarray, b: np.ndarray, q: int) -> np.ndarray:
    """循环卷积（x^n - 1），参考实现：用 int64 累加 + 逐项归约"""
    a = np.asarray(a, dtype=np.int64)
    b = np.asarray(b, dtype=np.int64)
    n = a.shape[0]
    assert b.shape[0] == n
    c = np.zeros(n, dtype=np.int64)
    for i in range(n):
        ai = int(a[i])
        if ai == 0:
            continue
        # j -> (i + j) mod n
        idx = (i + np.arange(n)) % n
        c[idx] = (c[idx] + ai * b) % q
    return c


def poly_mul_cyclic_fast(a: np.ndarray, b: np.ndarray, q: int) -> np.ndarray:
    """
    更快但仍然是精确整数运算：先用 int64 做完整线性卷积，再折叠 x^n = 1。
    注意：n=1171、q=2048 时峰值 n*(q-1)^2 ≈ 4.9e9 仍在 int64 内，安全；
          q 变大时必须改成分块归约（C++ 侧的 poly_mul_i32 就是这个思路）。
    """
    a = np.asarray(a, dtype=np.int64)
    b = np.asarray(b, dtype=np.int64)
    n = a.shape[0]
    peak = int(n) * int((q - 1) ** 2)
    if peak > 2 ** 62:
        raise ValueError("poly_mul_cyclic_fast: 会溢出 int64，请改用分块归约版本")
    lin = np.convolve(a, b)  # 长度 2n-1 的线性卷积（int64）
    lin = np.mod(lin, q)
    out = lin[:n].copy()
    out[: n - 1] = (out[: n - 1] + lin[n:]) % q
    return out


def poly_center(a: np.ndarray, q: int) -> np.ndarray:
    """中心代表：(-q/2, q/2]"""
    a = np.asarray(a, dtype=np.int64) % q
    return np.where(a > q // 2, a - q, a)


def poly_inf_norm_center(a: np.ndarray, q: int) -> int:
    return int(np.max(np.abs(poly_center(a, q))))


def poly_mod_p_centered(a: np.ndarray, q: int, p: int) -> np.ndarray:
    """中心代表后 mod p，输出 {-1, 0, 1}"""
    c = poly_center(a, q) % p
    c = np.where(c > p // 2, c - p, c)
    return c


def poly_to_list(a: np.ndarray) -> list:
    return [int(x) for x in np.asarray(a).ravel()]


def poly_from_list(xs) -> np.ndarray:
    return np.asarray([int(x) for x in xs], dtype=np.int64)


def parse_vectors(path: str) -> dict:
    """读取 C++ 侧 `ntru_cli vectors` 导出的测试向量"""
    out = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k in ("PARAMS",):
                out[k] = v
            elif k in ("SEED", "N", "Q", "P"):
                out[k] = int(v)
            else:
                out[k] = poly_from_list(v.split(","))
    return out
