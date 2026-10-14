"""
GPU 批量部分重加密（C3 落点）
=============================
文件：pyref/gpu_kernel.py

运行环境
--------
**Windows 原生即可，不需要 WSL。** 原骨架声称"必须在 WSL 里跑，因为 Windows 侧
没有 cl.exe"，这个前提不成立：CuPy 的 RawKernel 走 NVRTC，而 NVRTC 随 pip 轮子
分发，不需要 cl.exe / nvcc / CUDA Toolkit。已在
RTX 5070 Laptop (cc 12.0 / sm_120) + driver 610.62 上实测通过。

    python -m venv <venv>
    <venv>/Scripts/python -m pip install --only-binary=:all: \
        "numpy<2.6" \
        "cupy-cuda12x" \
        "nvidia-cuda-nvrtc-cu12>=12.8" \
        "nvidia-cuda-runtime-cu12>=12.8" \
        "nvidia-cuda-cccl-cu12"

关键点：
  * `nvidia-cuda-nvrtc-cu12` 必须 >= 12.8，否则 NVRTC 不认 `compute_120`
    （Blackwell / RTX 50 系），会报 invalid value for --gpu-architecture。
  * `nvidia-cuda-runtime-cu12` 提供 `cuda_runtime.h`，缺它连 `cp.arange` 都编不了。
  * 上面这套约 180 MB。原骨架注释里的 `cupy-cuda12x[ctk]` 会拉 3–4 GB，
    对 RawKernel 是浪费。

关于"把 poly_mul_i32 的分块归约搬进核"
--------------------------------------
实测结论（bench/results/gpu_kernel_variants.csv，n=1171，batch=8192，kernel-only）：

    v1  int64 列式（原实现）            3.50 us/次   1.00x
    v2  int32 列式                      2.69 us/次   1.30x
    v3  行式 + acc 常驻 shared          4.13 us/次   0.85x  <- 反而更慢
    v4  int32 + 两段拆分去分支          2.12 us/次   1.65x  <- 采用

三点必须说清楚：

  1) **不要搬 poly_mul_i32 的行式累加器布局。** 它在 CPU 上好是因为 `acc[]` 落在
     L1 且能顺序流式读 `b`；搬到 GPU 后，行与行会写重叠的 `acc` 位置，每行之间
     必须 `__syncthreads()`（n=1171 就是 1171 次同步），同步开销超过收益 ——
     实测 v3 比原实现还慢 15%。

  2) **要搬的是"两段拆分去分支"。** poly_mul_i32 把内层 `j = k-i` 拆成
     `i=0..k`（j 递增）和 `i=k+1..n-1`（j 回绕）两段，消掉了 `if (j<0) j+=n`
     这个每次迭代都要判的分支。这一条值 1.27x，是本次最大的单项收益。

  3) **分块归约只有在换成 int32 之后才成为必需。** int64 累加时
     `n*(q-1)^2 = 1171*2047^2 ≈ 4.9e9` 离 2^63 差 9 个数量级，永远不会溢出，
     原实现里那个归约是纯多余开销（实测只占 1.2%）。反过来，int32 累加下
     `4.9e9 > 2^31-1`，**不加分块归约会静默回绕得到错误结果**。所以
     "搬归约"不是独立优化点，而是"上 int32"的附带要求。

性能口径（重要）
----------------
原 `_bench()` 用 `time.time()` 包住 `cyc_conv()`，而 `cyc_conv()` 里有
`cp.asarray` / `cp.asnumpy` —— **计时区间把 H2D/D2H 搬运也算进去了**。
batch=8192、n=1171、int64 时，搬运 36.8 ms vs kernel 30.3 ms，**搬运占 52%**。

本文件因此把口径分开：
  * `kernel_only`  —— CUDA event 计时，device buffer 预置，只测核
  * `end_to_end`   —— 含 H2D/D2H，单独报
  * 并给出 batch 扫描曲线。GPU 的收益只在批量下成立（交叉点约 batch≈2–4），
    只报一个孤立的数会得出错误结论。

基线对照（本机 i9-14900HX + MinGW g++ -O3 -march=native，同分布满量程 [0,2048)）：
    CPU poly_mul_i32 @ n=1171 = 150.06 us/次
"""

from __future__ import annotations

import argparse
import csv
import os
import time

import numpy as np

try:
    import cupy as cp

    HAS_CUPY = True
except Exception:  # 没装 CuPy 时退化为 NumPy 参考路径
    cp = None
    HAS_CUPY = False


# ===========================================================================
# CUDA 源码
# ===========================================================================
CUDA_SRC = r"""
// ---------------------------------------------------------------------------
// v4（推荐）：int16 输入 / int32 共享与累加 / 列式 / 两段拆分去分支 / 分块归约
//
//   * 两段拆分（来自 poly_mul_i32）：把 j = k-i 的负索引分支消掉
//   * redu：保证 redu*(q-1)^2 + (q-1) < 2^31，q=2048 时 redu=256
//     int32 累加必须分块归约，否则 n*(q-1)^2 ≈ 4.9e9 > 2^31 会静默回绕
// ---------------------------------------------------------------------------
extern "C" __global__ void cyc_conv_i32_twoseg(const short* __restrict__ A,
                                               const short* __restrict__ B,
                                               int* __restrict__ C,
                                               const int n,
                                               const int mask,
                                               const int redu) {
    extern __shared__ int sh32[];
    int* sa = sh32;
    int* sb = sh32 + n;
    const short* a = A + (long long)blockIdx.x * n;
    const short* b = B + (long long)blockIdx.x * n;
    for (int i = threadIdx.x; i < n; i += blockDim.x) {
        sa[i] = (int)a[i];
        sb[i] = (int)b[i];
    }
    __syncthreads();
    for (int k = threadIdx.x; k < n; k += blockDim.x) {
        int acc = 0;
        int cnt = 0;
        for (int i = 0; i <= k; ++i) {                 // 段一：j = k-i
            acc += sa[i] * sb[k - i];
            if (++cnt == redu) { acc &= mask; cnt = 0; }
        }
        for (int i = k + 1; i < n; ++i) {              // 段二：j = k-i+n
            acc += sa[i] * sb[k - i + n];
            if (++cnt == redu) { acc &= mask; cnt = 0; }
        }
        C[(long long)blockIdx.x * n + k] = acc & mask;
    }
}

// ---------------------------------------------------------------------------
// v1（保留作对照）：int64 系数 / int64 累加 / 带负索引分支
// ---------------------------------------------------------------------------
extern "C" __global__ void cyc_conv_i64(const long long* __restrict__ A,
                                        const long long* __restrict__ B,
                                        long long* __restrict__ C,
                                        const int n,
                                        const long long mask,
                                        const int redu) {
    extern __shared__ long long sh64[];
    long long* sa = sh64;
    long long* sb = sh64 + n;
    const long long* a = A + (long long)blockIdx.x * n;
    const long long* b = B + (long long)blockIdx.x * n;
    for (int i = threadIdx.x; i < n; i += blockDim.x) {
        sa[i] = a[i];
        sb[i] = b[i];
    }
    __syncthreads();
    for (int k = threadIdx.x; k < n; k += blockDim.x) {
        long long acc = 0;
        int cnt = 0;
        for (int i = 0; i < n; ++i) {
            int j = k - i;
            if (j < 0) j += n;
            acc += sa[i] * sb[j];
            if (++cnt == redu) { acc &= mask; cnt = 0; }
        }
        C[(long long)blockIdx.x * n + k] = acc & mask;
    }
}
"""

VARIANTS = {
    "i32twoseg": "cyc_conv_i32_twoseg",   # 推荐
    "i64": "cyc_conv_i64",                # 原实现，对照用
}


# ===========================================================================
# 精确参考实现（CPU / NumPy）
# ===========================================================================
def cyclic_conv_ref(A: np.ndarray, B: np.ndarray, q: int = 2048) -> np.ndarray:
    """循环卷积 x^n - 1 的精确参考：int64 线性卷积后折叠。

    比原骨架里的 O(n^2) Python 双层循环快几个数量级，且是全批量精确对拍，
    因此可以拿它当正确性 oracle（原骨架只抽查前 4 条）。
    """
    A = np.asarray(A, dtype=np.int64) % q
    B = np.asarray(B, dtype=np.int64) % q
    n = A.shape[1]
    peak = n * (q - 1) ** 2
    if peak > 2 ** 62:
        raise ValueError(f"cyclic_conv_ref: n*(q-1)^2 = {peak:.3e} 会溢出 int64")
    out = np.empty_like(A)
    for t in range(A.shape[0]):
        lin = np.convolve(A[t], B[t])
        lin = np.mod(lin, q)
        row = lin[:n].copy()
        row[:n - 1] = (row[:n - 1] + lin[n:]) % q
        out[t] = row
    return out


def _block_terms(q: int, n: int) -> int:
    """分块归约的 BLK：与 poly_mul_i32 一致，保证 BLK*(q-1)^2 + (q-1) < 2^31。"""
    qm1 = q - 1
    blk = ((1 << 30) // (qm1 * qm1)) if qm1 > 0 else n
    return max(1, min(int(blk), n))


# ===========================================================================
# 引擎
# ===========================================================================
class GPUBatchEngine:
    """批量循环卷积 + 批量部分重加密。

    variant: "i32twoseg"（推荐）或 "i64"（原实现，对照）
    """

    def __init__(self, n: int, q: int = 2048, threads: int = 256,
                 variant: str = "i32twoseg", redu: int | None = None):
        if not (q > 0 and (q & (q - 1)) == 0):
            raise ValueError(f"q={q} 必须是 2 的幂")
        if variant == "i32twoseg" and q - 1 > 32767:
            raise ValueError(f"q={q} 超出 int16 系数上限（q-1 必须 <= 32767）")
        if variant not in VARIANTS:
            raise ValueError(f"未知 variant: {variant}")

        self.n = int(n)
        self.q = int(q)
        self.mask = self.q - 1
        self.threads = int(threads)
        self.variant = variant
        self.redu = int(redu) if redu else _block_terms(self.q, self.n)

        # 核所需的输入/输出 dtype —— RawKernel 不做校验，传错会静默出错
        if variant == "i32twoseg":
            self.in_dtype, self.out_dtype = np.int16, np.int32
            self.shmem = 2 * self.n * 4
        else:
            self.in_dtype, self.out_dtype = np.int64, np.int64
            self.shmem = 2 * self.n * 8

        self.kernel = cp.RawKernel(CUDA_SRC, VARIANTS[variant]) if HAS_CUPY else None

    # ---------------- 设备侧 ----------------
    def to_device(self, A: np.ndarray, B: np.ndarray):
        A = np.asarray(A) % self.q
        B = np.asarray(B) % self.q
        dA = cp.asarray(A.astype(self.in_dtype))
        dB = cp.asarray(B.astype(self.in_dtype))
        dC = cp.empty(dA.shape, dtype=self.out_dtype)
        return dA, dB, dC

    def launch(self, dA, dB, dC) -> None:
        batch = dA.shape[0]
        args = (dA, dB, dC, np.int32(self.n))
        if self.variant == "i32twoseg":
            args += (np.int32(self.mask), np.int32(self.redu))
        else:
            args += (np.int64(self.mask), np.int32(self.redu))
        self.kernel((batch,), (self.threads,), args, shared_mem=self.shmem)

    def launch_kernel_only(self, dA, dB, dC, reps: int = 1) -> float:
        """返回 kernel-only 秒数（CUDA event 计时，不含搬运）"""
        e0, e1 = cp.cuda.Event(), cp.cuda.Event()
        e0.record()
        for _ in range(reps):
            self.launch(dA, dB, dC)
        e1.record()
        e1.synchronize()
        return cp.cuda.get_elapsed_time(e0, e1) / reps / 1000.0

    # ---------------- 对外接口 ----------------
    def cyc_conv(self, A: np.ndarray, B: np.ndarray) -> np.ndarray:
        """批量循环卷积；A/B: (batch, n)。无 CuPy 时走 NumPy 参考路径。"""
        if self.kernel is None:
            return cyclic_conv_ref(A, B, self.q)
        dA, dB, dC = self.to_device(A, B)
        self.launch(dA, dB, dC)
        cp.cuda.Stream.null.synchronize()
        return cp.asnumpy(dC).astype(np.int64)

    def threshold_partial_reencrypt(self, cA_batch: np.ndarray, share: np.ndarray,
                                    p: int = 3, noise=None) -> np.ndarray:
        """一个代理对一批密文做部分重加密：partial = C_A * share + p * e"""
        Bn = cA_batch.shape[0]
        share_b = np.tile(np.asarray(share, dtype=np.int64) % self.q, (Bn, 1))
        prod = self.cyc_conv(cA_batch, share_b)
        if noise is None:
            return prod % self.q
        return (prod + p * (np.asarray(noise, dtype=np.int64) % self.q)) % self.q


# ===========================================================================
# 基准
# ===========================================================================
def bench(n: int, batches, backend: str, variant: str, q: int = 2048,
          seed: int = 0, cpu_us: float | None = None, csv_path: str | None = None):
    """同分布（满量程 [0,q)）扫描 batch，kernel-only 与端到端分开报。"""
    eng = GPUBatchEngine(n, q=q, variant=variant)
    if backend == "numpy":
        eng.kernel = None

    rng = np.random.default_rng(seed)
    rows = []
    print(f"backend={backend} variant={variant} n={n} q={q} "
          f"redu={eng.redu} threads={eng.threads} shmem={eng.shmem}B "
          f"in={np.dtype(eng.in_dtype).name} out={np.dtype(eng.out_dtype).name}")
    print(f"系数分布：满量程 [0,{q})  （与 ntru_cli bench 的 sample_uniform 同口径）\n")

    hdr = (f"{'batch':>7} {'kernel_only':>12} {'us/conv':>9} {'H2D':>10} {'D2H':>10} "
           f"{'end_to_end':>11} {'e2e us/conv':>12}")
    if cpu_us:
        hdr += f" {'vs CPU(k)':>10} {'vs CPU(e2e)':>12}"
    print(hdr)
    print("-" * len(hdr))

    for batch in batches:
        A = rng.integers(0, q, (batch, n), dtype=np.int64)
        B = rng.integers(0, q, (batch, n), dtype=np.int64)
        if backend == "numpy":
            t0 = time.perf_counter()
            eng.cyc_conv(A, B)
            dt = time.perf_counter() - t0
            kt, h2d, d2h, e2e = dt, 0.0, 0.0, dt
        else:
            dA, dB, dC = eng.to_device(A, B)
            reps = 3 if batch >= 4096 else (8 if batch >= 512 else 20)
            for _ in range(2):                       # warmup
                eng.launch(dA, dB, dC)
            cp.cuda.Stream.null.synchronize()
            kt = eng.launch_kernel_only(dA, dB, dC, reps)

            cp.cuda.Stream.null.synchronize()
            t0 = time.perf_counter()
            hA = cp.asarray(A.astype(eng.in_dtype))
            hB = cp.asarray(B.astype(eng.in_dtype))
            cp.cuda.Stream.null.synchronize()
            h2d = time.perf_counter() - t0

            cp.cuda.Stream.null.synchronize()
            t0 = time.perf_counter()
            cp.asnumpy(dC)
            cp.cuda.Stream.null.synchronize()
            d2h = time.perf_counter() - t0

            cp.cuda.Stream.null.synchronize()
            t0 = time.perf_counter()
            dA2, dB2, dC2 = eng.to_device(A, B)
            eng.launch(dA2, dB2, dC2)
            cp.cuda.Stream.null.synchronize()
            cp.asnumpy(dC2)
            e2e = time.perf_counter() - t0

        row = dict(batch=batch, kernel_only_s=kt, h2d_s=h2d, d2h_s=d2h, e2e_s=e2e)
        rows.append(row)
        line = (f"{batch:>7} {kt*1e6:>10.1f}us {kt/batch*1e6:>7.2f}us "
                f"{h2d*1e3:>8.2f}ms {d2h*1e3:>8.2f}ms {e2e*1e3:>9.2f}ms {e2e/batch*1e6:>10.2f}us")
        if cpu_us:
            line += f" {cpu_us/(kt/batch*1e6):>9.1f}x {cpu_us/(e2e/batch*1e6):>11.1f}x"
        print(line)

    # ---------------- 正确性（全批量精确对拍，n 用真实参数） ----------------
    cb = min(8, batches[-1] if batches else 8)
    Ac = rng.integers(0, q, (cb, n), dtype=np.int64)
    Bc = rng.integers(0, q, (cb, n), dtype=np.int64)
    ref = cyclic_conv_ref(Ac, Bc, q)
    got = eng.cyc_conv(Ac, Bc)
    ok = np.array_equal(ref, got)
    print(f"\n正确性（batch={cb}, n={n}, 全批量 vs cyclic_conv_ref）：{'PASS' if ok else 'FAIL'}")
    if not ok:
        bad = np.argwhere(ref != got)[0]
        print(f"  首个不符 idx={tuple(int(x) for x in bad)} ref={ref[tuple(bad)]} got={got[tuple(bad)]}")

    # ---------------- CSV ----------------
    if csv_path:
        os.makedirs(os.path.dirname(csv_path), exist_ok=True)
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["backend", "variant", "n", "q", "redu", "threads", "batch",
                        "kernel_only_us_total", "kernel_only_us_per_conv",
                        "h2d_ms", "d2h_ms", "e2e_ms", "e2e_us_per_conv",
                        "cpu_us_per_conv", "speedup_kernel_only", "speedup_e2e", "correct"])
            for r in rows:
                pc = r["kernel_only_s"] / r["batch"] * 1e6
                ec = r["e2e_s"] / r["batch"] * 1e6
                w.writerow([backend, variant, n, q, eng.redu, eng.threads, r["batch"],
                            f"{r['kernel_only_s']*1e6:.2f}", f"{pc:.3f}",
                            f"{r['h2d_s']*1e3:.3f}", f"{r['d2h_s']*1e3:.3f}",
                            f"{r['e2e_s']*1e3:.3f}", f"{ec:.3f}",
                            f"{cpu_us:.2f}" if cpu_us else "",
                            f"{cpu_us/pc:.2f}" if cpu_us else "",
                            f"{cpu_us/ec:.2f}" if cpu_us else "", ok])
        print(f"CSV -> {csv_path}")
    return rows, ok


def main() -> int:
    ap = argparse.ArgumentParser(
        description="GPU/NumPy 批量循环卷积 —— kernel-only 与端到端分开报")
    ap.add_argument("--n", type=int, default=1171)
    ap.add_argument("--q", type=int, default=2048)
    ap.add_argument("--batch", type=int, default=8192,
                    help="单点模式下的 batch")
    ap.add_argument("--sweep", action="store_true",
                    help="扫描 batch（推荐，GPU 收益只在批量下成立）")
    ap.add_argument("--backend", choices=["auto", "cupy", "numpy"], default="auto")
    ap.add_argument("--variant", choices=sorted(VARIANTS) + ["all"], default="i32twoseg")
    ap.add_argument("--cpu-us", type=float, default=None,
                    help="CPU 单次卷积耗时(us)，用于算加速比；本机 poly_mul_i32@1171 = 150.06")
    ap.add_argument("--csv", type=str, default=None)
    args = ap.parse_args()

    backend = args.backend
    if backend == "auto":
        backend = "cupy" if HAS_CUPY else "numpy"
    print(f"CuPy 可用：{HAS_CUPY}")
    if backend == "cupy" and not HAS_CUPY:
        print("CuPy 不可用：pip install cupy-cuda12x nvidia-cuda-nvrtc-cu12>=12.8 "
              "nvidia-cuda-runtime-cu12>=12.8 nvidia-cuda-cccl-cu12")
        return 2

    batches = ([1, 16, 64, 256, 1024, 4096, 8192] if args.sweep else [args.batch])
    variants = sorted(VARIANTS) if args.variant == "all" else [args.variant]

    for i, v in enumerate(variants):
        if len(variants) > 1:
            print(f"\n{'='*72}\n### variant = {v}\n{'='*72}")
        csvp = args.csv
        if csvp and len(variants) > 1:
            root, ext = os.path.splitext(csvp)
            csvp = f"{root}_{v}{ext}"
        bench(args.n, batches, backend, v, q=args.q,
              cpu_us=args.cpu_us, csv_path=csvp)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
