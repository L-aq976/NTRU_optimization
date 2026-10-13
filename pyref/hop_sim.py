"""
C2 数值核心：多跳噪声模拟 + 尾部模型
=====================================
文件：pyref/hop_sim.py

设计见 docs/C2失败概率预算_实施计划.md。核心公式（$h$ 跳链 A→B1→…→Bh）：

    f_Bh·C_Bh = f_A·C_A + p·Σ_{i=1..h} e_i·f_Bi
              = p·( g·s + F_A·M + Σ_{i=1..h} e_i·f_Bi ) + M

定义**噪声核** T_h = g·s + F_A·M + Σ e_i·f_Bi，成功判据与 C++ 的
`decrypt_with_noise` 逐位一致：center(p·T_h + M) mod q 再 mod p 必须等于 M。

三条关键性质（决定了本文件的设计）：

1) 只在小整数域做卷积：操作数上界是 e∈{-1,0,1} 与 f_B=1+3F_B（常数项 ∈ {-2,1,4}，
   其余系数 ∈ {-3,0,3}，故 ‖f_B‖∞ = 4），
   **从不碰满量程的 C_A·rk**（那才是 README §4.2 里会溢出 int32 的那个）。
   于是 FFT 批量卷积的取整误差 ≲ ε·O(n log n)·‖a‖∞‖b‖∞ ≈ 1e-11 ≪ 0.5，
   约 8 个数量级余量 ⇒ 取整无损（仍以 fft==exact 的逐位硬测兜底）。
2) Σ(g)=Σ(F_A)=Σ(e)=0 且 Σ(f_B)=1 ⇒ Σ(T_h) 是常数 ⇒ 系数零均值、方差随 h 线性增长。
3) 门限（C1）组合把 C(N,t−1) 份 partial 直接相加，每份各带一个 p·e_S 且共用同一个 f_B：

       Σ_S (C_A·share_S + p·e_S) = C_A·rk + p·Σ_{k=1..m} e_k ,   m = C(N,t−1)

   所以**门限版 = 基线把 e_i 换成 Σ_{k=1..m} e_k**：每跳仍只做一次卷积。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

try:  # CuPy 只用于 WSL/GPU；本机 Windows 没有也不影响
    import cupy as cp

    HAS_CUPY = True
except Exception:
    cp = None
    HAS_CUPY = False


# ---------------------------------------------------------------------------
# 参数集（与 src/core/params.cpp 严格一致；q=2048, p=3）
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class RingParams:
    name: str
    ring_n: int
    q: int
    p: int
    df: int
    dg: int
    dr: int
    dm0: int
    dm1: int
    paper_hops: int = 0   # 论文 Table 4 的经验跳数（仅作对照）
    teaching: bool = False  # TINY*：安全性为零，噪声 ≪ q/2，永不失败


EES: dict[str, RingParams] = {
    "EES439":  RingParams("EES439",  439, 2048, 3, 146, 130, 126, 128, 128, paper_hops=5),
    "EES1087": RingParams("EES1087", 1087, 2048, 3, 120, 362, 120, 120, 120, paper_hops=21),
    "EES1171": RingParams("EES1171", 1171, 2048, 3, 106, 390, 106, 106, 106, paper_hops=21),
    "EES1499": RingParams("EES1499", 1499, 2048, 3, 79, 499, 79, 79, 79, paper_hops=50),
    "TINY7":   RingParams("TINY7",     7, 2048, 3, 2, 2, 2, 1, 1, teaching=True),
    "TINY61":  RingParams("TINY61",   61, 2048, 3, 10, 10, 10, 5, 5, teaching=True),
}


# ---------------------------------------------------------------------------
# 后端：采样 + 循环卷积
# ---------------------------------------------------------------------------
def _pad_len(n: int) -> int:
    """线性卷积所需的 2 的幂长度（n 是素数时循环 FFT 会退化成 Bluestein，很慢）"""
    L = 1
    while L < 2 * n - 1:
        L *= 2
    return L


def _conv_fft_np(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """FFT 批量循环卷积：补零到 2 的幂做**线性**卷积再折回（x^n = 1）。

    n ∈ {439, 1087, 1171, 1499} 全是素数，直接怼循环 FFT 会让 pocketfft 走
    Bluestein（实测慢 1.4~1.9×）。补零后长度是 2 的幂，快且仍然无损：
    线性卷积的最大幅值 ≤ n·‖a‖∞‖b‖∞ ≈ 6e3，舍入误差 ≲ ε·L log L·幅值 ≈ 1e-7 ≪ 0.5。
    """
    n = A.shape[1]
    L = _pad_len(n)
    C = np.fft.irfft(np.fft.rfft(A, n=L, axis=1) * np.fft.rfft(B, n=L, axis=1), n=L, axis=1)
    lin = np.rint(C).astype(np.int64)
    out = lin[:, :n].copy()
    out[:, :n - 1] += lin[:, n:2 * n - 1]
    return out


def _conv_fft_cp(A, B):
    n = A.shape[1]
    L = _pad_len(n)
    C = cp.fft.irfft(cp.fft.rfft(A, n=L, axis=1) * cp.fft.rfft(B, n=L, axis=1), n=L, axis=1)
    lin = cp.rint(C).astype(cp.int64)
    out = lin[:, :n].copy()
    out[:, :n - 1] += lin[:, n:2 * n - 1]
    return out


def _conv_exact(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """精确 int64 循环卷积（np.roll 逐列累加）。仅用于验证与小批量。"""
    Bn, n = A.shape
    out = np.zeros((Bn, n), dtype=np.int64)
    for i in np.nonzero(A.any(axis=0))[0]:
        ai = A[:, i]
        if not ai.any():
            continue
        out += ai[:, None] * np.roll(B, int(i), axis=1)
    return out


class Backend:
    def __init__(self, name: str, xp, conv):
        self.name, self.xp, self.conv = name, xp, conv


def get_backend(name: str = "fft") -> Backend:
    if name == "auto":
        name = "cupy" if HAS_CUPY else "fft"
    if name == "exact":
        return Backend("exact", np, _conv_exact)
    if name == "cupy":
        if not HAS_CUPY:
            raise RuntimeError("CuPy 不可用：请在 WSL 里 pip install cupy-cuda12x[ctk]")
        return Backend("cupy", cp, _conv_fft_cp)
    if name == "fft":
        return Backend("fft", np, _conv_fft_np)
    raise ValueError(f"未知后端 {name!r}（可选 exact / fft / cupy / auto）")


def default_batch(backend: Backend, ring_n: int) -> int:
    """按"同时存活约 6 个 (B,n) 数组"估的批大小（元素数预算）"""
    budget = 4.0e7 if backend.name == "cupy" else 3.0e6
    return int(max(256, min(65536, budget // ring_n)))


# ---------------------------------------------------------------------------
# 采样（复现 src/core/sampler.cpp 的固定重量语义）
# ---------------------------------------------------------------------------
def sample_fixed_weight(rng, xp, B: int, n: int, plus: int, minus: int):
    """B×n 多项式：恰好 plus 个 +1、minus 个 -1，位置均匀随机，其余为 0。

    两步都只用"取前 k 小"来构造均匀子集，与 C++ 的 Fisher–Yates 同分布：
      1) 选位置：rng.random((B,n)) 的 (plus+minus) 个最小值 —— 均匀 tot-子集；
      2) 分符号：**另取一组独立的 rng.random((B,tot))** 再取前 plus 小值。

    ⚠️ 第 2 步的独立性是必须的，不能用第 1 步那个 argpartition 输出的排列：
    argpartition 只保证"前 tot 个就是 tot 个最小值"，**不保证它们在输出槽位里的
    排列与输入下标无关**（实测：给定下标 0 被选中，它落在前 plus 个槽位的概率是
    0.70 而不是 0.50）。直接按槽位分符号会让 +1 系统性偏向低下标，把
    Var(g·s 的系数) 从理论值 ~154 抬到 ~737。自检里对这条有硬断言。
    """
    tot = plus + minus
    if tot == 0:
        return xp.zeros((B, n), dtype=xp.int64)
    sel = xp.argpartition(rng.random((B, n)), tot - 1, axis=1)[:, :tot]   # 均匀 tot-子集
    # 独立随机排列（总槽位），前 plus 个槽位记为 +1，其余 -1
    order = xp.argsort(rng.random((B, tot)), axis=1)
    signs = -xp.ones((B, tot), dtype=xp.int64)
    xp.put_along_axis(signs, order[:, :plus], 1, axis=1)
    out = xp.zeros((B, n), dtype=xp.int64)
    out[xp.repeat(xp.arange(B), tot), sel.ravel()] = signs.ravel()
    return out


def const_one(xp, B: int, n: int):
    """常数多项式 1（**只有常数项是 1**，其余为 0）。

    注意 `1 + p*F` 在 numpy 里会给每个系数都加 1，那是错的 —— 环里的 "1" 是常数项。
    """
    out = xp.zeros((B, n), dtype=xp.int64)
    out[:, 0] = 1
    return out


def sample_fB(rng, xp, B: int, n: int, P: RingParams):
    """接收方密钥多项式 f_B = 1 + p·F_B（1 只加在常数项上）"""
    f = P.p * sample_fixed_weight(rng, xp, B, n, P.df, P.df)
    f[:, 0] += 1
    return f


def sample_message(rng, xp, B: int, n: int, P: RingParams):
    """明文，**mod p 表示 {0,1,...,p−1}**，与 C++ 的 `sample_message` 逐位一致。

    ⚠️ 这里必须用 mod p 表示而不是中心表示 {−1,0,1}，两者在环里等价（差 3·k，
    k 是"−1 处"的指示），但**在 Z 上不等价**：噪声核里 F_A·M 那一项会差
    3·F_A·k。C++ 的实现走的是 `mod_q(t[i], p)`，即 −1 → p−1。

    实测（用 bin/vectors_EES439_7.txt 的真实 T_1）：
        M_raw 表示  ⇒ T_1 的 std = 42.6，与真实值逐位相等 ✅
        M_cent 表示 ⇒ T_1 的 std = 40.0，与真实值不符 ❌
    差别只有 ~6%（因为 M_cent 与 k 互补、两者强反相关），但在指数敏感的尾部
    6% 的噪声尺度差约等于 60 倍的 δ 差 —— 必须按参考实现来。
    """
    return sample_fixed_weight(rng, xp, B, n, P.dm0, P.dm1) % P.p


def message_center(M, P: RingParams, xp):
    """mod p 表示 -> 中心表示 {-(p/2), ..., p/2}（对应 C++ 的 message_to_center）"""
    c = M % P.p
    return xp.where(c > P.p // 2, c - P.p, c)


def sample_sum_fixed_weight(rng, xp, B: int, n: int, plus: int, minus: int, m: int):
    """C1 门限噪声：Σ_{k=1..m} e_k（m 份独立同分布的固定重量三元多项式）"""
    E = sample_fixed_weight(rng, xp, B, n, plus, minus)
    for _ in range(m - 1):
        E = E + sample_fixed_weight(rng, xp, B, n, plus, minus)
    return E


def chain_failure_mask(T, M_raw, P: RingParams, xp) -> np.ndarray:
    """逐位复现 C++ 的 decrypt_with_noise + poly_mod_p_centered 判据。

    `M_raw` 是 mod p 表示的明文（{0,..,p−1}），解出来之后要与它**的中心表示**比
    （C++ 里是 `message_equal(P, m, decrypt(f, c))`）。

    返回 (B,) 布尔数组：True 表示该链解密失败。
    """
    v = P.p * T + M_raw                      # == f_Bh·C_Bh，此时还没 mod q
    c = v % P.q
    c = xp.where(c > P.q // 2, c - P.q, c)   # 中心代表 (-q/2, q/2]
    d = c % P.p
    d = xp.where(d > P.p // 2, d - P.p, d)   # -> {-1,0,1}
    return xp.any(d != message_center(M_raw, P, xp), axis=1)


def wilson_ci(k: int, N: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson 得分区间。**一律报区间，不报裸点估计。**"""
    if N <= 0:
        return 0.0, 1.0
    p = k / N
    den = 1.0 + z * z / N
    ctr = (p + z * z / (2 * N)) / den
    half = z * math.sqrt(p * (1 - p) / N + z * z / (4 * N * N)) / den
    return max(0.0, ctr - half), min(1.0, ctr + half)


# ---------------------------------------------------------------------------
# 蒙特卡洛主循环
# ---------------------------------------------------------------------------
@dataclass
class HopStat:
    h: int
    samples: int
    failures: int
    delta: float
    ci_lo: float
    ci_hi: float


def simulate_curve(P: RingParams, max_hops: int, samples: int,
                   batch: int | None = None, m: int = 1, seed: int = 1,
                   backend: str = "fft", cgf_sub: int = 200_000):
    """跑 MC，返回 (stats, coeff_samples)。

    stats[h] 是 h 跳链的失败率（**共用同一条链的随机数**：同一批链在每个 h 都判一次，
    所以各 h 的估计相关，这是有意的方差缩减；每个 h 的 δ 仍然无偏）。

    coeff_samples[h] 是 T_h 单个系数的样本（每跳 cgf_sub//max_hops 个，每条链只取一个系数
    以保证近似独立），供经验 CGF / 鞍点使用 —— 与主模拟零额外卷积开销。
    """
    be = get_backend(backend)
    xp = be.xp
    rng = xp.random.default_rng(seed)
    n = P.ring_n
    if batch is None:
        batch = default_batch(be, n)

    fails = np.zeros(max_hops + 1, dtype=np.int64)
    per_hop_need = max(1, cgf_sub // max_hops) if cgf_sub > 0 else 0
    coeff = [[] for _ in range(max_hops + 1)]
    done = 0
    while done < samples:
        b = int(min(batch, samples - done))
        g = sample_fixed_weight(rng, xp, b, n, P.dg, P.dg)
        s = sample_fixed_weight(rng, xp, b, n, P.dr, P.dr)
        FA = sample_fixed_weight(rng, xp, b, n, P.df, P.df)
        M = sample_message(rng, xp, b, n, P)
        T = be.conv(g, s) + be.conv(FA, M)          # h 无关的公共部分

        for h in range(1, max_hops + 1):
            E = sample_sum_fixed_weight(rng, xp, b, n, P.dr, P.dr, m)
            fB = sample_fB(rng, xp, b, n, P)
            T = T + be.conv(E, fB)

            fail = chain_failure_mask(T, M, P, xp)
            fails[h] += int(xp.count_nonzero(fail))

            need = per_hop_need - len(coeff[h])
            if need > 0:
                rows = rng.integers(0, b, size=need)
                cols = rng.integers(0, n, size=need)
                got = T[rows, cols]
                coeff[h].append(np.asarray(xp.asnumpy(got) if be.name == "cupy" else got,
                                           dtype=np.int64))
        done += b

    stats = [None] * (max_hops + 1)
    for h in range(1, max_hops + 1):
        lo, hi = wilson_ci(int(fails[h]), samples)
        stats[h] = HopStat(h, samples, int(fails[h]), fails[h] / samples, lo, hi)
    out = [None] + [np.concatenate(coeff[h]) if coeff[h] else np.empty(0, dtype=np.int64)
                    for h in range(1, max_hops + 1)]
    return stats, out


def auto_chunk(n: int) -> int:
    """按"一个 (chunk,n) 数组 + 补零后 FFT 的临时量"估的批大小，控制进程池的内存峰值"""
    return int(max(1024, min(8192, 2_000_000 // max(1, n))))


def sample_common_part(P: RingParams, N: int, seed: int = 2, backend: str = "fft",
                       chunk: int | None = None) -> np.ndarray:
    """C0 = (g·s + F_A·M) 单个系数的样本。

    只依赖参数集（不依赖 m），所以调用方应当**每个参数集只算一次**再复用。
    """
    be = get_backend(backend)
    xp = be.xp
    rng = xp.random.default_rng(seed)
    n = P.ring_n
    if chunk is None:
        chunk = auto_chunk(n)
    outs = []
    done = 0
    while done < N:
        b = int(min(chunk, N - done))
        g = sample_fixed_weight(rng, xp, b, n, P.dg, P.dg)
        s = sample_fixed_weight(rng, xp, b, n, P.dr, P.dr)
        FA = sample_fixed_weight(rng, xp, b, n, P.df, P.df)
        M = sample_message(rng, xp, b, n, P)
        T0 = be.conv(g, s) + be.conv(FA, M)
        cols = rng.integers(0, n, size=b)          # 每条链取一个系数
        rows = xp.arange(b)
        v = T0[rows, cols]
        outs.append(np.asarray(xp.asnumpy(v) if be.name == "cupy" else v, dtype=np.int64))
        done += b
    return np.concatenate(outs) if outs else np.empty(0, dtype=np.int64)


# ---------------------------------------------------------------------------
# 经验 CGF + 鞍点（Lugannani–Rice）
# ---------------------------------------------------------------------------
def sample_increment(P: RingParams, N: int, m: int = 1, seed: int = 3,
                     backend: str = "fft", chunk: int | None = None) -> np.ndarray:
    """单跳增量 W = (Σ_{k=1..m} e_k)·f_B 的**单个系数**样本（每条链取一个系数）。

    T_h = C0 + Σ_{i=1..h} W_i，且 W_i 相互独立、与 C0 独立 —— 于是
    K_{T_h}(t) = K_{C0}(t) + h·K_W(t)，鞍点里可以直接对 h 解析放大。
    """
    be = get_backend(backend)
    xp = be.xp
    rng = xp.random.default_rng(seed)
    n = P.ring_n
    if chunk is None:
        chunk = auto_chunk(n)
    outs = []
    done = 0
    while done < N:
        b = int(min(chunk, N - done))
        E = sample_sum_fixed_weight(rng, xp, b, n, P.dr, P.dr, m)
        W = be.conv(E, sample_fB(rng, xp, b, n, P))
        cols = rng.integers(0, n, size=b)
        v = W[xp.arange(b), cols]
        outs.append(np.asarray(xp.asnumpy(v) if be.name == "cupy" else v, dtype=np.float64))
        done += b
    return np.concatenate(outs) if outs else np.empty(0)


class _CGF1:
    """单个随机变量的经验 CGF（K, K', K'' 由倾斜分布的前两阶矩给出）。

    全部走 log-sum-exp 形式（先减最大值再取指数），因为 t·X 可以到几百。
    """

    def __init__(self, X):
        self.X = np.asarray(X, dtype=np.float64).ravel()
        self.N = self.X.size
        if self.N < 100:
            raise ValueError("CGF 样本太少")

    def stats(self, t: float):
        x = t * self.X
        mx = float(x.max())
        w = np.exp(x - mx)
        sw = float(w.sum())
        K = mx + math.log(sw / self.N)
        m1 = float((w * self.X).sum() / sw)
        m2 = float((w * self.X * self.X).sum() / sw)
        return K, m1, m2 - m1 * m1

    def ess(self, t: float) -> float:
        x = t * self.X
        w = np.exp(x - float(x.max()))
        return (w.sum() ** 2) / float((w * w).sum())


class TailModel:
    """鞍点（Lugannani–Rice）尾部模型，用于把 δ 外推到 MC 测不到的 2^-40。

    用到 T_h 的**和结构**：T_h = C0 + Σ_{i≤h} W_i，C0 与 W 独立，故

        K(t) = K_C0(t) + h·K_W(t)     K'(t) = K'_C0(t) + h·K'_W(t)     等等

    两项的经验 CGF 都从样本估，在同一个 t 网格上预计算，查询时按 h 组合。
    这样**不需要**对 C0 做任何近似（早先设想的"分位数求积"是多余的）。

    可靠区间：只信"倾斜后有效样本量 ESS ≥ ess_min"的 t。这是经验 CGF 外推的
    固有限制 —— 超出就必须承认模型不可靠（见 docs 的 §7.2 风险 2）。
    """

    def __init__(self, C0, W, n_grid: int = 192, ess_min: float = 500.0):
        self.c0, self.w = _CGF1(C0), _CGF1(W)
        s = max(self.c0.X.std(), self.w.X.std(), 1e-9)
        t_hi = 0.0
        for t in np.linspace(0.0, 8.0 / s, 120):
            if t > 0 and min(self.c0.ess(t), self.w.ess(t)) < ess_min:
                break
            t_hi = float(t)
        self.t_max = t_hi
        self.ts = np.linspace(0.0, t_hi, n_grid) if t_hi > 1e-12 else np.zeros(1)
        a = [self.c0.stats(float(t)) for t in self.ts]
        b = [self.w.stats(float(t)) for t in self.ts]
        self.Ka, self.K1a, self.K2a = (np.array([x[i] for x in a]) for i in range(3))
        self.Kb, self.K1b, self.K2b = (np.array([x[i] for x in b]) for i in range(3))
        self.last_extrapolated = False   # 最近一次 saddle_log_tail 是否用了二次外推

    # -- 单条 CGF 在 t 处的 (K, K', K'')；t > t_max 时用二次外推 --------------
    def _one(self, Ks, K1s, K2s, t: float):
        if t <= self.t_max:
            return (float(np.interp(t, self.ts, Ks)),
                    float(np.interp(t, self.ts, K1s)),
                    float(np.interp(t, self.ts, K2s)))
        # 经验 CGF 只在 ESS 够大的 t 上可信。超出后按"在 t_max 处二阶匹配的二次式"
        # 延拓：K2 保持不变、K1 线性、K 二次。等价于假定 t_max 以外的尾部是高斯，
        # 但锚在实测 CGF 上（比从均值处做高斯近似准得多）。
        # 真实 W 有界，二次延拓让尾部偏重 ⇒ δ 偏保守（宁可少报跳数）。
        k = float(np.interp(self.t_max, self.ts, Ks))
        k1 = float(np.interp(self.t_max, self.ts, K1s))
        k2 = float(np.interp(self.t_max, self.ts, K2s))
        d = t - self.t_max
        return k + k1 * d + 0.5 * k2 * d * d, k1 + k2 * d, k2

    def _combined(self, h: int, t: float):
        a = self._one(self.Ka, self.K1a, self.K2a, t)
        b = self._one(self.Kb, self.K1b, self.K2b, t)
        return a[0] + h * b[0], a[1] + h * b[1], a[2] + h * b[2]

    def saddle_log_tail(self, h: int, tau: float):
        """log P(T_h > τ)，τ>0；解不出来返回 None。"""
        if tau <= 0 or self.t_max <= 1e-12:
            return None
        k1a, k1b = self.K1a[-1], self.K1b[-1]
        k2a, k2b = self.K2a[-1], self.K2b[-1]
        # t = t_max 处的 K'(t) = K1(t_max) + K2(t_max)·(t − t_max)，两根都要考虑
        hi = self.t_max
        if k1a + h * k1b <= tau:                       # 需要越过 t_max
            slope = k2a + h * k2b
            if slope <= 0:
                return None
            hi = self.t_max + (tau - (k1a + h * k1b)) / slope
        lo = 0.0
        for _ in range(80):                            # 二分：K' 单调增
            mid = 0.5 * (lo + hi)
            if self._combined(h, mid)[1] < tau:
                lo = mid
            else:
                hi = mid
        shat = 0.5 * (lo + hi)
        if shat <= 1e-12:
            return None
        self.last_extrapolated = shat > self.t_max
        K, _k1, K2 = self._combined(h, shat)
        expo = shat * tau - K
        if expo < 0 or K2 <= 0:
            return None
        sq = math.sqrt(K2)
        w = math.sqrt(2.0 * expo)
        v = shat * sq
        u = (1.0 - math.exp(-shat)) * sq
        if v <= 0 or u <= 0:
            return None
        tail = 0.5 * math.erfc(w / math.sqrt(2.0))            # = 1 − Φ(w)，无消位
        phi = math.exp(-0.5 * w * w) / math.sqrt(2.0 * math.pi)
        corr = phi * (1.0 / v - 1.0 / u)                       # LR 修正项
        if tail <= 0.0:
            return None
        return math.log(tail) + math.log1p(corr / tail)

    def log_prob_coeff(self, h: int, P: RingParams):
        """log p1(h)，p1 = P(|T_h 的单个系数| > τ)，τ = (q/2)/p。

        用 T_h 的对称性取双侧（随机变量与其反号等分布：e→−e、g→−g 都保持分布）。
        """
        tau = (P.q // 2) / P.p
        lt = self.saddle_log_tail(h, tau)
        if lt is None:
            return None
        return lt + math.log(2.0)

    def delta(self, h: int, P: RingParams, calib: float = 1.0):
        """δ(h) = 1 − (1 − p1)^n（对 n 个系数的并集界），乘标定常数 calib"""
        lp = self.log_prob_coeff(h, P)
        if lp is None:
            return None
        if lp >= 0.0:
            return 1.0
        p1 = math.exp(lp)
        return -math.expm1(P.ring_n * math.log1p(-p1)) * calib


def calibrate(model_fn, measured: list[HopStat]):
    """在可测区间对 log δ 最小二乘拟一个乘性常数，并报跨 decade 的最大残差。

    只用在 δ ∈ [1e-2, 1e-4] 这类"MC 与模型都有意义"的重叠区。
    残差若随 h 系统性漂移，说明模型形状不对 —— 必须当 blocker，不能硬拟合。
    """
    pts = []
    for st in measured:
        if st.delta <= 0:
            continue
        md = model_fn(st.h)
        if md is None or md <= 0:
            continue
        pts.append((st.h, math.log(st.delta), math.log(md)))
    if len(pts) < 3:
        return 1.0, float("nan"), 0
    logs = [a - b for _, a, b in pts]              # log calib 的逐点估计
    lc = sum(logs) / len(logs)
    resid = [abs(x - lc) / math.log(10.0) for x in logs]
    return math.exp(lc), max(resid), len(pts)


def invert_hop_budget(pred, target: float, h_lo: int = 1, h_hi: int = 4096):
    """max{ h : pred(h) <= target }；pred 返回 None 表示该 h 超出模型可靠区。

    要求 pred 单调递增；用线性扫描 + 二分混合（h 通常很小）。
    """
    best = 0
    h = h_lo
    while h <= h_hi:
        try:
            v = pred(h)
        except Exception:
            v = None
        if v is None:
            break
        if v <= target:
            best = h
            h += 1
        else:
            break
    return best


# ---------------------------------------------------------------------------
# 自检：硬断言（1/3/4）
# ---------------------------------------------------------------------------
def _selftest() -> int:
    import os
    import sys

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from ring_np import poly_mod_p_centered, parse_vectors  # noqa: E402

    bad = 0

    def check(cond, what):
        nonlocal bad
        print(("  [ OK ] " if cond else "  [FAIL] ") + what)
        if not cond:
            bad += 1

    print("=== hop_sim 自检 ===")

    # 断言 1：采样器一致性
    rng = np.random.default_rng(0)
    X = sample_fixed_weight(rng, np, 8, 101, 7, 7)
    check(X.shape == (8, 101), "形状 (B,n)")
    check(bool(np.all(X.sum(axis=1) == 0)), "Σ 每个多项式 == 0（plus == minus）")
    check(bool(np.all((X == 1).sum(axis=1) == 7)) and bool(np.all((X == -1).sum(axis=1) == 7)),
          "恰好 7 个 +1 / 7 个 -1")
    check(bool(np.all(np.isin(np.unique(X), (-1, 0, 1)))), "系数只取 {-1,0,1}")

    # f_B = 1 + p·F_B：**1 只加在常数项上**，故 Σ(f_B) = 1（§3.1 零漂移论证的基础）
    fB = 3 * sample_fixed_weight(rng, np, 8, 101, 7, 7)
    fB[:, 0] += 1
    check(bool(np.all(fB.sum(axis=1) == 1)), "Σ(1 + p·F_B) == 1（1 只在常数项）")
    check(bool(np.isin(np.unique(fB[:, 0]), (-2, 1, 4)).all()), "f_B 常数项只取 {-2, 1, 4}")
    check(bool(np.isin(np.unique(fB[:, 1:]), (-3, 0, 3)).all()), "f_B 其余系数只取 {-3, 0, 3}")

    # 断言 3：fft == exact（逐位）
    for name, P in EES.items():
        rr = np.random.default_rng(12345 + P.ring_n)
        A = sample_fixed_weight(rr, np, 64, P.ring_n, P.dr, P.dr)
        B = 1 + P.p * sample_fixed_weight(rr, np, 64, P.ring_n, P.df, P.df)
        e1 = _conv_exact(A, B)
        e2 = _conv_fft_np(A, B)
        check(np.array_equal(e1, e2), f"fft == exact（{name}, n={P.ring_n}）")

    # 断言 4：判据与 poly_mod_p_centered 的直译版一致；且与 ∞-范数代理判据同事件数
    P = EES["EES439"]
    rr = np.random.default_rng(7)
    M = sample_fixed_weight(rr, np, 512, P.ring_n, P.dm0, P.dm1)
    T = rr.integers(-400, 400, size=(512, P.ring_n), dtype=np.int64)  # 故意跨阈值
    ref = np.zeros(512, dtype=bool)
    for i in range(512):
        v = (P.p * T[i] + M[i]) % P.q
        d = poly_mod_p_centered(v, P.q, P.p)
        ref[i] = bool(np.any(d != M[i]))
    got = chain_failure_mask(T, M, P, np)
    check(np.array_equal(ref, got), "chain_failure_mask == poly_mod_p_centered 直译版")
    # 代理判据：某系数在 mod q 之前就越过 q/2（即发生回绕）。q ≡ 2 (mod p)，
    # 单次回绕会把 mod p 余数改掉 2 ≠ 0，所以回绕必致失败；仅当回绕次数 ≡ 0 (mod 3)
    # 才可能抵消，而那在 q/2 量级上不可达 —— 于是两者应当几乎同事件数。
    proxy = np.any(np.abs(P.p * T + M) > P.q // 2, axis=1)
    print(f"        ∞-范数代理判据与精确判据事件数：{int(proxy.sum())} vs {int(got.sum())}"
          f"（应接近；差异只来自 k≡0 mod 3 次回绕）")

    # 断言：系数的边缘分布 / 方差 / 对称性 —— 这是当初发现符号分配 bug 的那条断言
    rr = np.random.default_rng(99)
    for nm in ("EES439", "TINY61"):
        Q = EES[nm]
        N = 4000
        g = sample_fixed_weight(rr, np, N, Q.ring_n, Q.dg, Q.dg)
        s = sample_fixed_weight(rr, np, N, Q.ring_n, Q.dr, Q.dr)
        check(abs((g[:, 0] != 0).mean() - 2 * Q.dg / Q.ring_n) < 0.02,
              f"P(g[i]≠0) == 2·dg/n（{nm}）")
        pp, mm = (g[:, 0] == 1).mean(), (g[:, 0] == -1).mean()
        check(abs(pp - mm) < 0.02, f"P(+1) ≈ P(−1)（{nm}：{pp:.4f} vs {mm:.4f}）")
        z = _conv_fft_np(g, s)[:, 0].astype(np.float64)
        theo = 4.0 * Q.dg * Q.dr / Q.ring_n
        check(0.85 < z.var() / theo < 1.15,
              f"Var(g·s 系数) 对得上理论 4·dg·dr/n（{nm}：{z.var():.1f} vs {theo:.1f}）")
        sk = float(((z - z.mean()) ** 3).mean() / (z.std() ** 3 + 1e-12))
        check(abs(sk) < 0.15, f"g·s 系数近似对称（{nm} 偏度 {sk:+.3f}）")

    # 断言：明文用 mod p 表示 {0,..,p−1}（−1 变成 p−1），与 C++ 的 sample_message 一致。
    # 这条很关键：换成中心表示会让噪声核里的 F_A·M 项不同（见 sample_message 的注释）。
    rr = np.random.default_rng(31337)
    P0 = EES["EES439"]
    Mm = sample_message(rr, np, 2000, P0.ring_n, P0)
    check(bool(np.isin(np.unique(Mm), np.arange(P0.p)).all()),
          f"明文系数落在 [0, p) = [0, {P0.p})")
    check(bool(np.all((Mm == 1).sum(axis=1) == P0.dm0))
          and bool(np.all((Mm == P0.p - 1).sum(axis=1) == P0.dm1)),
          f"明文有 dm0={P0.dm0} 个 1、dm1={P0.dm1} 个 {P0.p - 1}（= 中心表示的 −1）")

    # 断言：单跳增量 W = e·f_B 的系数分布对称 —— 鞍点里 p1 = 2·P(T_h > τ) 靠的就是这条。
    # (e→−e 保持分布 ⇒ e·f_B 与它的反号等分布；EES 参数集另有 dm0 == dm1。)
    rr = np.random.default_rng(4242)
    for nm in ("EES439", "EES1171"):
        Q = EES[nm]
        w = sample_increment(Q, 60000, m=1, seed=9, backend="fft", chunk=4096)
        sk = float(((w - w.mean()) ** 3).mean() / (w.std() ** 3 + 1e-12))
        check(abs(sk) < 0.05, f"单跳增量 W 的系数对称（{nm} 偏度 {sk:+.4f}）")
        check(abs(w.mean()) < 0.05 * w.std(), f"W 零均值（{nm} 均值/σ={w.mean() / w.std():+.4f}）")

    # 断言 2：exact 后端 vs C++ 导出的测试向量（若文件存在）
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    vec = os.path.join(root, "bin", "vectors_EES439_7.txt")
    if os.path.exists(vec):
        v = parse_vectors(vec)
        q, p = v["Q"], v["P"]
        FB_v, CB_v, M_v = v["FB"], v["CB"], v["M"]
        one1 = (lambda a: a.reshape(1, -1))
        cen = (lambda a: np.where(a > q // 2, a - q, a))
        # 先把 f_B·C_B 归约到 mod q 再取中心代表，才是环里真正的"小多项式"
        c = cen(_conv_exact(one1(FB_v), one1(CB_v))[0] % q)
        num = c - M_v
        check(bool(np.all(num % p == 0)), "center(f_B·C_B) − M 能被 p 整除")
        T1 = num // p
        print(f"       ||center(f_B·C_B)||_inf = {int(np.max(np.abs(c)))}，"
              f"T_1 的 ||·||_inf = {int(np.max(np.abs(T1)))}")
        # 用 vectors 里的量独立复核噪声核公式。
        # 注意：导出的是 f_A（名 FA）而不是 F_A；F_A = (f_A − 1)/p，1 只在常数项。
        # 同样，导出的 M ∈ {0,1,2} 是 mod p 的**原样**表示，不是中心形式。
        fA = cen(v["FA"]).copy()
        fA[0] -= 1
        FA_v = fA // p
        check(bool(np.isin(FA_v, (-1, 0, 1)).all()) and bool((fA % p == 0).all()),
              "F_A = (f_A − 1)/p 是三元多项式")
        lhs = (_conv_exact(one1(cen(v["GA"])), one1(cen(v["S"])))[0]
               + _conv_exact(one1(FA_v), one1(M_v))[0]
               + _conv_exact(one1(cen(v["E"])), one1(cen(FB_v)))[0])
        check(np.array_equal(lhs, T1),
              "T_1 == g·s + F_A·M + e·f_B（用 C++ 导出的 vectors 独立复核噪声核公式）")
    else:
        print(f"  [skip] 找不到 {vec}，跳过 C++ 向量对拍")

    print(f"=== 自检：{'全部通过' if bad == 0 else f'{bad} 项失败'} ===")
    return 1 if bad else 0


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description="C2 多跳噪声模拟核（自检 / 曲线）")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--params", default="EES439")
    ap.add_argument("--hops", type=int, default=12)
    ap.add_argument("--samples", type=int, default=100_000)
    ap.add_argument("--m", type=int, default=1, help="C1 门限：噪声份数 C(N,t-1)")
    ap.add_argument("--backend", default="fft")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    if args.selftest:
        return _selftest()

    P = EES[args.params]
    stats, _ = simulate_curve(P, args.hops, args.samples, m=args.m,
                              seed=args.seed, backend=args.backend)
    print(f"=== {P.name}  n={P.ring_n}  m={args.m}  backend={args.backend} ===")
    print(f"{'h':>4}{'failures':>10}{'delta':>12}{'95% CI':>24}")
    for st in stats[1:]:
        print(f"{st.h:>4}{st.failures:>10}{st.delta:>12.4g}"
              f"   [{st.ci_lo:.3g}, {st.ci_hi:.3g}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
