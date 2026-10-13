"""
GPU 批量引擎（骨架）
====================
文件：pyref/gpu_kernel.py

定位：这是 C3（GPU 批量部分重加密）的落点。**必须在 WSL(Ubuntu) 里跑**，
      因为 Windows 侧只有 CUDA Toolkit、没有 cl.exe，nvcc 编不了；而 CuPy 走
      NVRTC，不需要装 Toolkit（你之前已经验证过这条路径）。

包含两部分：
  1) batch_cyclic_conv：x^n - 1 上的循环卷积批量核（每个 block 算一条卷积）
  2) threshold_partial_reencrypt：把 C1 的"部分重加密"做成批量算子
       partial_{S} = C_A * share_S + p * e_S

两个必须注意的正确性问题（都写在代码注释里）：
  * 满量程系数（[0,q) × [0,q)）累加会溢出 int32：
        n*(q-1)^2 = 1171*2047^2 ≈ 4.9e9 > 2^31
    所以要么用 int64 累加，要么用 int32 + 每 ≤256 项归约。
    **注意**：你原来的 CPU 基准 cpu_splitloop.c/cpu_openmp.c 用的是三元系数
    （rand()%3-1，int32 累加安全），而 GPU kernel 用的是满量程系数
    （rand()%2048）。两边口径不一致，所以"CPU 59us vs GPU 233us / 3.7x"
    这组数字不能直接引用，必须用同一分布重测。
  * 随机数：本轮骨架用 numpy/默认 RNG，正式实验必须换 CSPRNG（见 src/core/sampler.h 的 TODO）。
"""

from __future__ import annotations

import argparse
import time

import numpy as np

try:
    import cupy as cp

    HAS_CUPY = True
except Exception:  # 没装 CuPy 时退化为 NumPy 参考路径
    cp = None
    HAS_CUPY = False


CUDA_SRC = r"""
// 每条卷积一个 block；A/B 形状 (B, n)，C 形状 (B, n)
// 系数在 [0, q)，q = 2^11。用 int64 累加 + 每 redu 项归约，满量程安全。
extern "C" __global__ void cyc_conv_batch(const long long* __restrict__ A,
                                          const long long* __restrict__ B,
                                          long long* __restrict__ C,
                                          const int n,
                                          const long long mask,
                                          const int redu) {
    extern __shared__ long long sh[];
    long long* sa = sh;
    long long* sb = sh + n;
    const int bid = blockIdx.x;
    const long long* a = A + (long long)bid * n;
    const long long* b = B + (long long)bid * n;
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
        C[(long long)bid * n + k] = acc & mask;
    }
}
"""


def batch_cyclic_conv_numpy(A: np.ndarray, B: np.ndarray, q: int = 2048,
                            block: int = 256) -> np.ndarray:
    """NumPy 参考路径（用于验证 GPU 结果；慢但在本机就能跑）"""
    A = np.asarray(A, dtype=np.int64) % q
    B = np.asarray(B, dtype=np.int64) % q
    out = np.empty_like(A)
    for t in range(A.shape[0]):
        acc = np.zeros(A.shape[1], dtype=np.int64)
        for i in range(A.shape[1]):
            ai = int(A[t, i])
            if ai == 0:
                continue
            idx = (i + np.arange(A.shape[1])) % A.shape[1]
            acc[idx] = (acc[idx] + ai * B[t]) & (q - 1)
        out[t] = acc & (q - 1)
    return out


class GPUBatchEngine:
    """批量循环卷积 + 批量部分重加密"""

    def __init__(self, n: int, q: int = 2048, redu: int = 256, threads: int = 256):
        self.n = int(n)
        self.q = int(q)
        self.mask = np.int64(q - 1)
        self.redu = int(redu)
        self.threads = int(threads)
        self.kernel = None
        if HAS_CUPY:
            self.kernel = cp.RawKernel(CUDA_SRC, "cyc_conv_batch")

    def cyc_conv(self, A: np.ndarray, B: np.ndarray) -> np.ndarray:
        """批量循环卷积；A/B: (B, n) 整数数组"""
        if self.kernel is None:
            return batch_cyclic_conv_numpy(A, B, self.q)
        A64 = cp.asarray(np.asarray(A, dtype=np.int64) % self.q)
        B64 = cp.asarray(np.asarray(B, dtype=np.int64) % self.q)
        Bn = A64.shape[0]
        C = cp.empty_like(A64)
        shmem = 2 * self.n * 8
        self.kernel((Bn,), (self.threads,),
                    (A64, B64, C, np.int32(self.n), self.mask, np.int32(self.redu)),
                    shared_mem=shmem)
        cp.cuda.Stream.null.synchronize()
        return cp.asnumpy(C)

    def threshold_partial_reencrypt(self, cA_batch: np.ndarray, share: np.ndarray,
                                    p: int = 3, noise=None) -> np.ndarray:
        """
        一个代理对一批密文做"部分重加密"：
            partial = C_A * share + p * e
        cA_batch: (B, n)；share: (n,)；noise: (B, n) 或 None（None 时用 0，仅用于测速）
        """
        Bn = cA_batch.shape[0]
        share_b = np.tile(np.asarray(share, dtype=np.int64) % self.q, (Bn, 1))
        prod = self.cyc_conv(cA_batch, share_b)
        if noise is None:
            return prod % self.q
        return (prod + p * (np.asarray(noise, dtype=np.int64) % self.q)) % self.q


def _bench(n: int, batch: int, backend: str) -> None:
    rng = np.random.default_rng(0)
    A = rng.integers(0, 2048, (batch, n), dtype=np.int64)
    B = rng.integers(0, 2048, (batch, n), dtype=np.int64)
    eng = GPUBatchEngine(n, 2048)
    if backend == "numpy":
        eng.kernel = None

    t0 = time.time()
    C = eng.cyc_conv(A, B)
    dt = time.time() - t0
    print(f"[{backend}] n={n} batch={batch}: {dt:.3f} s 总 / {dt / batch * 1e6:.2f} us 每次 / "
          f"{batch / dt:,.0f} 次每秒")

    # 抽检正确性（与朴素参考对比，只查前 min(batch,4) 条，避免太慢）
    ref = batch_cyclic_conv_numpy(A[:4], B[:4], 2048)
    ok = np.array_equal(ref, C[:4])
    print(f"[{backend}] 正确性抽检（前 4 条 vs NumPy 参考）：{'通过' if ok else '不通过'}")
    if not ok:
        raise SystemExit(1)


def main() -> int:
    ap = argparse.ArgumentParser(description="GPU/NumPy 批量循环卷积骨架")
    ap.add_argument("--n", type=int, default=1171)
    ap.add_argument("--batch", type=int, default=8192)
    ap.add_argument("--backend", choices=["auto", "cupy", "numpy"], default="auto")
    args = ap.parse_args()

    backend = args.backend
    if backend == "auto":
        backend = "cupy" if HAS_CUPY else "numpy"
    print(f"CuPy 可用：{HAS_CUPY}")
    if backend == "cupy" and not HAS_CUPY:
        print("CuPy 不可用：请在 WSL 里 pip install cupy-cuda12x[ctk]")
        return 2
    _bench(args.n, args.batch, backend)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
