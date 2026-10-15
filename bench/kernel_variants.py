"""C3 核心实验（修正版）：四种 GPU 核同条件对比 + 正确性。
v1 = 现有实现：int64 系数 / int64 累加 / 列式 / 共享 sa,sb
v2 = int16 输入 + int32 共享 + int32 累加 + 列式 + 分块归约（必需）
v3 = 字面搬 poly_mul_i32：行式 + acc[] 常驻 shared + 每行 __syncthreads + 分块归约
v4 = 只搬 poly_mul_i32 的「两段拆分去分支」：int32 列式，但把 j=k-i 的 if(j<0) 分支去掉

要回答：
  a) int64 -> int32 值多少？
  b) 「把 poly_mul_i32 的行式累加器布局搬上 GPU」是否成立？
  c) 「两段拆分」这个改法单独值多少？
"""
import numpy as np
import cupy as cp

N, Q, MASK, REDU, THREADS = 1171, 2048, 2047, 256, 256
CPU_US = 150.06   # 本机 i9-14900HX + MinGW g++ -O3 -march=native, poly_mul_i32

V1 = r"""
extern "C" __global__ void k_v1(const long long* __restrict__ A, const long long* __restrict__ B,
                                long long* __restrict__ C, const int n, const long long mask, const int redu) {
    extern __shared__ long long sh[];
    long long* sa = sh; long long* sb = sh + n;
    const long long* a = A + (long long)blockIdx.x * n;
    const long long* b = B + (long long)blockIdx.x * n;
    for (int i = threadIdx.x; i < n; i += blockDim.x) { sa[i] = a[i]; sb[i] = b[i]; }
    __syncthreads();
    for (int k = threadIdx.x; k < n; k += blockDim.x) {
        long long acc = 0; int cnt = 0;
        for (int i = 0; i < n; ++i) {
            int j = k - i; if (j < 0) j += n;
            acc += sa[i] * sb[j];
            if (++cnt == redu) { acc &= mask; cnt = 0; }
        }
        C[(long long)blockIdx.x * n + k] = acc & mask;
    }
}
"""

V2 = r"""
extern "C" __global__ void k_v2(const short* __restrict__ A, const short* __restrict__ B,
                                int* __restrict__ C, const int n, const int mask, const int redu) {
    extern __shared__ int sh[];
    int* sa = sh; int* sb = sh + n;
    const short* a = A + (long long)blockIdx.x * n;
    const short* b = B + (long long)blockIdx.x * n;
    for (int i = threadIdx.x; i < n; i += blockDim.x) { sa[i] = (int)a[i]; sb[i] = (int)b[i]; }
    __syncthreads();
    for (int k = threadIdx.x; k < n; k += blockDim.x) {
        int acc = 0; int cnt = 0;
        for (int i = 0; i < n; ++i) {
            int j = k - i; if (j < 0) j += n;
            acc += sa[i] * sb[j];
            if (++cnt == redu) { acc &= mask; cnt = 0; }
        }
        C[(long long)blockIdx.x * n + k] = acc & mask;
    }
}
"""

V3 = r"""
extern "C" __global__ void k_v3(const short* __restrict__ A, const short* __restrict__ B,
                                int* __restrict__ C, const int n, const int mask, const int blk) {
    extern __shared__ int sh[];
    int* acc = sh;
    const short* a = A + (long long)blockIdx.x * n;
    const short* b = B + (long long)blockIdx.x * n;
    for (int t = threadIdx.x; t < n; t += blockDim.x) acc[t] = 0;
    __syncthreads();
    for (int i = 0; i < n; ++i) {
        const int ai = (int)a[i];
        const int m = n - i;
        for (int j = threadIdx.x; j < m; j += blockDim.x) acc[i + j] += ai * (int)b[j];
        for (int j = threadIdx.x; j < i; j += blockDim.x) acc[j] += ai * (int)b[m + j];
        __syncthreads();
        if ((i % blk) == blk - 1) {
            for (int t = threadIdx.x; t < n; t += blockDim.x) acc[t] &= mask;
            __syncthreads();
        }
    }
    for (int t = threadIdx.x; t < n; t += blockDim.x) C[(long long)blockIdx.x * n + t] = acc[t] & mask;
}
"""

V4 = r"""
extern "C" __global__ void k_v4(const short* __restrict__ A, const short* __restrict__ B,
                                int* __restrict__ C, const int n, const int mask, const int redu) {
    extern __shared__ int sh[];
    int* sa = sh; int* sb = sh + n;
    const short* a = A + (long long)blockIdx.x * n;
    const short* b = B + (long long)blockIdx.x * n;
    for (int i = threadIdx.x; i < n; i += blockDim.x) { sa[i] = (int)a[i]; sb[i] = (int)b[i]; }
    __syncthreads();
    for (int k = threadIdx.x; k < n; k += blockDim.x) {
        int acc = 0; int cnt = 0;
        // 段一：i = 0..k  ->  j = k-i （递增访问 sb，无负索引）
        for (int i = 0; i <= k; ++i) {
            acc += sa[i] * sb[k - i];
            if (++cnt == redu) { acc &= mask; cnt = 0; }
        }
        // 段二：i = k+1..n-1  ->  j = k-i+n
        for (int i = k + 1; i < n; ++i) {
            acc += sa[i] * sb[k - i + n];
            if (++cnt == redu) { acc &= mask; cnt = 0; }
        }
        C[(long long)blockIdx.x * n + k] = acc & mask;
    }
}
"""

def ref_cyclic(a, b, n, q):
    lin = np.convolve(a.astype(np.int64), b.astype(np.int64))
    lin = np.mod(lin, q)
    out = lin[:n].copy()
    out[:n-1] = (out[:n-1] + lin[n:]) % q
    return out

def make16(batch, seed=7):
    rng = np.random.default_rng(seed)
    return (rng.integers(0, Q, (batch, N), dtype=np.int16),
            rng.integers(0, Q, (batch, N), dtype=np.int16))

k = {v: cp.RawKernel(src, f"k_{v}") for v, src in
     [("v1", V1), ("v2", V2), ("v3", V3), ("v4", V4)]}

# dtype 必须和核签名严格一致：
#   输入 v1 = int64, v2/v3/v4 = int16   （RawKernel 不校验，传错就是静默越界/错数据）
#   输出 v1 = int64, v2/v3/v4 = int32
DT    = {"v1": np.int64, "v2": np.int16, "v3": np.int16, "v4": np.int16}
DTOUT = {"v1": np.int64, "v2": np.int32, "v3": np.int32, "v4": np.int32}
SHMEM = {"v1": 2*N*8,    "v2": 2*N*4,    "v3": N*4,      "v4": 2*N*4}

def launch(v, batch, dA, dB, dC):
    if v == "v1":
        k[v]((batch,), (THREADS,), (dA, dB, dC, np.int32(N), np.int64(MASK), np.int32(REDU)),
             shared_mem=SHMEM[v])
    else:
        k[v]((batch,), (THREADS,), (dA, dB, dC, np.int32(N), np.int32(MASK), np.int32(REDU)),
             shared_mem=SHMEM[v])

print(f"n={N} q={Q} redu/BLK={REDU} threads={THREADS}")
print(f"shmem: v1={SHMEM['v1']}B  v2={SHMEM['v2']}B  v3={SHMEM['v3']}B  v4={SHMEM['v4']}B")
ok_ovf = N*(Q-1)**2 > 2**31-1
print(f"int32 溢出: n*(q-1)^2={N*(Q-1)**2:,} > 2^31-1={2**31-1:,} -> "
      f"{'是，int32 必须分块归约' if ok_ovf else '否'}\n")

# ---------- 正确性 ----------
CB = 4
A16, B16 = make16(CB)
refC = np.stack([ref_cyclic(A16[t], B16[t], N, Q) for t in range(CB)])
print("=== 正确性（batch=4, n=1171, 归约真的触发）===")
correct = {}
for v in ["v1", "v2", "v3", "v4"]:
    dA = cp.asarray(A16.astype(DT[v])); dB = cp.asarray(B16.astype(DT[v]))
    dC = cp.empty((CB, N), dtype=DTOUT[v])
    label = {"v1": "v1 int64 列式", "v2": "v2 int32 列式", "v3": "v3 行式shared-acc", "v4": "v4 int32 两段去分支"}[v]
    try:
        launch(v, CB, dA, dB, dC)
        cp.cuda.Stream.null.synchronize()
        C = cp.asnumpy(dC).astype(np.int64)
        correct[v] = bool(np.array_equal(refC, C))
        extra = ""
        if not correct[v]:
            bad = np.argwhere(refC != C)[0]
            extra = f"  idx={tuple(int(x) for x in bad)} ref={refC[tuple(bad)]} got={C[tuple(bad)]}"
        print(f"  {label:22s} {'PASS' if correct[v] else 'FAIL'}{extra}")
    except Exception as e:
        correct[v] = False
        print(f"  {label:22s} ERROR {type(e).__name__}: {str(e)[:160]}")

# ---------- 性能 ----------
print("\n=== kernel-only（CUDA event, 预置 device buffer, 带 warmup）===")
BATCHES = [1, 16, 64, 256, 1024, 4096, 8192]
rows = []
for batch in BATCHES:
    A, B = make16(batch)
    out = {}
    for v in ["v1", "v2", "v3", "v4"]:
        dA = cp.asarray(A.astype(DT[v])); dB = cp.asarray(B.astype(DT[v]))
        dC = cp.empty((batch, N), dtype=DTOUT[v])
        for _ in range(2):
            launch(v, batch, dA, dB, dC)
        cp.cuda.Stream.null.synchronize()
        reps = 3 if batch >= 4096 else (8 if batch >= 512 else 20)
        e0, e1 = cp.cuda.Event(), cp.cuda.Event()
        e0.record()
        for _ in range(reps):
            launch(v, batch, dA, dB, dC)
        e1.record(); e1.synchronize()
        out[v] = cp.cuda.get_elapsed_time(e0, e1) / reps / 1000.0
    rows.append((batch, out))

h = f"{'batch':>7} | {'v1 int64':>10} {'v2 int32':>10} {'v3 行式':>10} {'v4 两段':>10} | {'v2/v1':>6} {'v3/v1':>6} {'v4/v1':>6}"
print(h); print("-"*len(h))
for batch, out in rows:
    print(f"{batch:>7} | {out['v1']*1e6:>8.1f}us {out['v2']*1e6:>8.1f}us {out['v3']*1e6:>8.1f}us {out['v4']*1e6:>8.1f}us | "
          f"{out['v1']/out['v2']:>5.2f}x {out['v1']/out['v3']:>5.2f}x {out['v1']/out['v4']:>5.2f}x")

print(f"\n=== 每次卷积 us/conv（CPU poly_mul_i32 = {CPU_US}us）===")
h2 = f"{'batch':>7} | {'v1':>9} {'v2':>9} {'v3':>9} {'v4':>9} | {'CPU/v2':>7} {'CPU/v3':>7} {'CPU/v4':>7}"
print(h2); print("-"*len(h2))
for batch, out in rows:
    pc = {v: out[v]/batch*1e6 for v in out}
    print(f"{batch:>7} | {pc['v1']:>7.2f}us {pc['v2']:>7.2f}us {pc['v3']:>7.2f}us {pc['v4']:>7.2f}us | "
          f"{CPU_US/pc['v2']:>6.1f}x {CPU_US/pc['v3']:>6.1f}x {CPU_US/pc['v4']:>6.1f}x")

# ---------- CSV ----------
import csv, os
res = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
os.makedirs(res, exist_ok=True)
with open(os.path.join(res, "gpu_kernel_variants.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["variant", "batch", "kernel_total_us", "us_per_conv", "cpu_us_per_conv", "speedup_vs_cpu", "correct_batch4"])
    for batch, out in rows:
        for v in ["v1", "v2", "v3", "v4"]:
            pc = out[v]/batch*1e6
            w.writerow([v, batch, f"{out[v]*1e6:.2f}", f"{pc:.3f}", f"{CPU_US:.2f}", f"{CPU_US/pc:.2f}", correct.get(v)])
print(f"\nCSV -> {os.path.join(res, 'gpu_kernel_variants.csv')}")

