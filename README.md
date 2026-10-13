# 最终方案 · 代码骨架

> 赛题 A1-4：**基于格密码的代理重加密算法设计与优化实现**
> 项目主题：**面向多跳可用性的 NTRU 代理重加密 —— 门限多代理委托、失败概率预算与 GPU 批量实现**
> 骨架版本：2026-10-12

---

## 0. 30 秒看懂这个骨架

已经跑通的东西（在本机 Windows + MinGW g++ 上实测）：

```
$ bin/ntru_cli.exe selftest      # 21 项全部通过
$ bin/ntru_cli.exe walkthrough   # ★ 教学参数(n=7)下的完整流程预演，每一步都打印全部系数
$ bin/ntru_cli.exe smoke EES439 3 2
   KeyGen 1.18ms / Enc 0.11ms / Dec 0.10ms / ReKeyGen 0.10ms / ReEnc 0.23ms
   门限 (n=3,t=2): 子集数 3, 耗时 0.76ms, 噪声 640（相对基线 ×1.53）
$ python pyref/cross_check.py EES439 7     # C++ 与 Python 参考实现 9 项代数关系全部一致
```

即：**NTRU 五个算法 + 门限分享/部分重加密/组合 + 跨语言一致性校验**都已经能跑。
流程讲解见 **[docs/01_加密流程预演.md](docs/01_加密流程预演.md)**（两个对象走完全程，每个数字都能手工验算）。

---

## 1. 语言选择与理由

| 部分 | 语言 | 为什么 |
|---|---|---|
| 核心密码引擎（环运算、NTRU、门限、攻击脚本接口） | **C++17** | ① "优化实现"这一章必须靠它，Python 做不出性能数字；② Windows(MinGW g++) 与 WSL(gcc 13.3) 都能编，本机可即时验证；③ 你已有的 CPU 基准是 C，可以直接接进来对比 |
| 参考实现 + 跨语言校验 | **Python 3 + NumPy** | 用另一套独立实现验证 C++，比"自己验自己"可信；也方便写报告里的算法伪码对照 |
| GPU 批量算子 | **Python + CuPy(RawKernel/NVRTC)** | 已验证过：Windows 侧没有 cl.exe，nvcc 编不了；CuPy 走 NVRTC 不需要装 Toolkit，WSL 里 GPU 直通可用 |
| 蒙特卡洛（噪声/跳数预算） | **Python + CuPy** | 复用已有的 `multihop_failprob_gpu.py`（180k 链·跳/秒） |

> 一句话：**C++ 负责"快"和"可交付"，Python 负责"对"和"GPU/模拟"。**

---

## 2. 目录结构

```
最终方案/
├── README.md                  ← 本文件
├── Makefile                   ← WSL/Linux 构建（正式实验用这个）
├── build.ps1                  ← Windows 快速构建（纯 ASCII，避免 GBK 坑）
├── src/
│   ├── core/
│   │   ├── params.h/.cpp         参数集（EES439/1087/1171/1499）+ 自检
│   │   ├── ring.h/.cpp           Z_q[x]/(x^n-1)：三层乘法（ref / int64 / int32分块）
│   │   ├── poly_inv.h/.cpp       多项式求逆：GF(2) 扩展欧几里得 + Hensel 提升到 mod 2^16
│   │   ├── sampler.h/.cpp        三元固定重量采样 / 均匀采样 / 随机源（含 CSPRNG TODO）
│   │   ├── ntru.h/.cpp           NTRU 基础：KeyGen / Enc / Dec（含噪声度量）
│   │   ├── pre_base.h/.cpp       基线 NTRUReEncrypt：ReKeyGen / ReEnc
│   │   └── threshold.h/.cpp      ★ C1：门限分享 / 部分重加密 / 组合
│   ├── cli/main.cpp              selftest / walkthrough / smoke / vectors / bench
│   └── tests/                    （见 tests/test_core.cpp，独立的单元测试）
├── tests/
│   ├── test_core.cpp             单元测试（独立于 CLI）
├── pyref/
│   ├── ring_np.py                NumPy 参考：循环卷积 / 中心代表 / 向量解析
│   ├── ntru_ref_py.py            Python 参考：GF(2) 求逆 + Hensel + 解密
│   ├── cross_check.py            跨语言一致性校验（9 项代数关系）
│   ├── gpu_kernel.py             ★ C3：GPU 批量卷积 + 批量部分重加密（骨架）
│   └── mc_failprob.py            ★ C2：失败概率预算 / h_max(δ) 外推（骨架）
└── docs/
    ├── 00_design.md              设计决策与待验证命题（写报告时的底稿）
    └── 01_加密流程预演.md         ★ 两个对象走一遍完整代码（含手工验算示例）
```

★ 标记的三个文件就是三个创新点的落点：C1 = `threshold.*`，C2 = `mc_failprob.py`，C3 = `gpu_kernel.py`。

---

## 3. 构建与运行

### Windows（快速迭代，本机已可用）
```powershell
cd 最终方案
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test    # 编译 + 自检
.\bin\ntru_cli.exe smoke EES439 3 2
python pyref\cross_check.py EES439 7
```

### WSL / Linux（正式实验，推荐）
```bash
cd 最终方案
make                 # 编译 bin/ntru_cli 与 bin/ntru_tests
make test            # 单元测试
make run             # EES439 冒烟
make bench           # 环乘法微基准
python3 pyref/cross_check.py EES439 7
python3 pyref/gpu_kernel.py --backend cupy --n 1171 --batch 8192   # 需要 CuPy
```

### 已实测的性能基线（本机 Windows/MinGW，**仅作参考**）
| n | poly_mul_ref | poly_mul_fast(int64) | poly_mul_i32(分块) |
|---|---|---|---|
| 439 | 560 µs | 91 µs | — |
| 1171 | 3199 µs | 643 µs | **289 µs** |

---

## 4. 两条必须知道的口径问题

### 4.1 你原来的 CPU 与 GPU 基准口径不一致 ⚠️

| 文件 | 系数分布 | 累加类型 | 是否满量程安全 |
|---|---|---|---|
| `bench/cpu_schoolbook.c` / `cpu_splitloop.c` / `cpu_openmp.c` | **三元** `rand()%3-1` | int32 | 只对三元安全 |
| `bench/gpu_kernel_v1.py` / `v2.py` / `gpu_transfer.py` | **满量程** `randint(0,2048)` | int64 / int32+归约 | 是 |

结论：**"CPU 59 µs vs GPU 233 µs；批量 104k/s vs 391k/s；GPU 3.7×" 这组数字比较的是两种不同负载**
（三元乘法的代价远低于满量程 mod q 乘法，而且 `if(!ai) continue` 还跳掉了 1/3 的行）。
本项目必须用**同分布**重测，把这张表重做一遍——这既是必须做的修正，也是报告里可以写的一条方法学贡献。

### 4.2 哪些乘法是满量程的？

| 算法 | 表达式 | 操作数分布 | int32 累加是否安全 |
|---|---|---|---|
| Enc | `h*s` | h 满量程 × s 三元 | 安全（n·(q−1) ≈ 2.4e6） |
| Dec | `f*c` | f 小（±1,±2,±4）× c 满量程 | 安全（≈ 9.6e6） |
| ReKeyGen | `f_A*f_B^{-1}` | 小 × 满量程 | 安全 |
| **ReEnc** | **`C_A*rk`** | **满量程 × 满量程** | **不安全：n·(q−1)² ≈ 4.9e9 > 2^31** |

也就是说：**只有 ReEnc 那条卷积需要"分块归约"**，而它恰好是性能热点。`poly_mul_i32()` 就是为它准备的（int16 系数 + int32 累加 + 每 BLK 项归约，BLK 由 q 反推）。这是 C3 优化的第一个着力点。

---

## 5. 当前状态与下一步

### 已完成（可运行、已验证）
- [x] 环运算三层实现，`ref == fast == i32` 有测试保证
- [x] 多项式求逆（mod 2 扩展欧几里得 + Hensel），KeyGen 拒绝采样
- [x] NTRU Enc/Dec 与基线 ReKeyGen/ReEnc，噪声度量
- [x] **C1 门限**：CNF/子集加性分享、部分重加密、组合；`(n,t)` 覆盖性与 `t-1` 不可组合性有测试
- [x] 跨语言（C++ ↔ Python）9 项代数关系一致
- [x] 测试向量导出（`vectors` 子命令）+ 单元测试 + 冒烟 + 微基准

### 下一步（按优先级）
1. **CSPRNG**：把 `Rng` 换成 `getrandom`/`BCryptGenRandom`（`sampler.h` 里有 TODO）。正式密钥生成**不能**用 `mt19937_64`。
2. **攻击复现（加分项）**：用 `fpylll` 从 `rk` 恢复 `f_A`，量化"基线 1 个代理即可、门限版需要 t 个代理"。
3. **C1 的完整论证**：把 `docs/00_design.md` 里"待验证命题"逐条推完（尤其 partial 的 mod p 泄漏）。
4. **C3**：把 `poly_mul_i32` 的分块归约搬进 CuPy 核（`gpu_kernel.py` 已给骨架），并用**同分布**重测 CPU/GPU。
5. **C2**：MC 样本量提到 1e8+，把 `tail_extrapolate` 的 loglinear 换成鞍点/大偏差模型。
6. 每完成一步，把数字写进 `bench/results/*.csv`（还没建，下一步补）。

---

## 6. 环境坑（记录一下，省得再踩）
- **Windows PowerShell 5.1 按 ANSI 读 .ps1**：脚本里别写中文（`build.ps1` 已改成纯 ASCII）。
- **Python 读子进程输出**要显式 `encoding="utf-8"`，否则 GBK 解码崩溃（`cross_check.py` 已处理）。
- **q = 2048 不能做 NTT**：`(Z/2048)^×` 阶为 1024 < n，不存在 n 阶单位根；要 NTT 必须走 CRT + NTT 友好素数。
- **WSL2 内存约 7.6 GB**：编译/跑大实验时注意内存；GPU 侧 H2D 只有 0.8–2.1 GB/s（端到端吞吐要单独报）。
- **`-march=native`**：Windows MinGW 8.1 与 WSL gcc 13.3 都支持，但两者的自动向量化质量不同，性能数字必须注明编译器。
