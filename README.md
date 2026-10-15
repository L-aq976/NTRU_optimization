# 最终方案 · 代码骨架

> 赛题 A1-4：**基于格密码的代理重加密算法设计与优化实现**
> 项目主题：**面向多跳可用性的 NTRU 代理重加密 —— 门限多代理委托、失败概率预算与 GPU 批量实现**
> 版本：2026-10-14（骨架初版 2026-10-12）
> 现状：C1 已完成；**C2 已完成**（报告见 `docs/C2_报告.md`）；C3 仍为骨架

---

## 0. 30 秒看懂这个骨架

已经跑通的东西（在本机 Windows + MinGW-w64 g++ 上实测；**时序数字与机器相关**）：

```
$ bin/ntru_cli.exe selftest      # 21 项全部通过
$ bin/ntru_cli.exe walkthrough   # ★ 教学参数(n=7)下的完整流程预演，每一步都打印全部系数
$ bin/ntru_cli.exe smoke EES439 3 2
   KeyGen 1.73ms / Enc 0.16ms / Dec 0.16ms / ReKeyGen 0.16ms / ReEnc 0.34ms
   Enc 噪声 184 / 重加密噪声 499 / 门限(n=3,t=2) 噪声 698（相对基线 ×1.40）
$ python pyref/cross_check.py EES439 7     # C++ 与 Python 参考实现 9 项代数关系全部一致
$ python pyref/hop_sim.py --selftest       # ★ C2 数值核心的 7 类硬断言（含与 C++ 引擎逐位对拍）
$ python pyref/mc_failprob.py              # ★ C2：跑 δ(h) 曲线 + 跳数预算，落三张 CSV
```

即：**NTRU 五个算法 + 门限分享/部分重加密/组合 + 跨语言一致性校验 + C2 失败概率预算**都已经能跑。
流程讲解见 **[docs/01_加密流程预演.md](docs/01_加密流程预演.md)**（两个对象走完全程，每个数字都能手工验算）；
C2 的结论见 **[docs/C2_报告.md](docs/C2_报告.md)**。

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
│   │   ├── params.h/.cpp         参数集（EES1087/1171/1499 + APR2011_439*）+ 自检
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
│   └── fixtures/                 C2 硬断言用的测试向量（bin/ 被 gitignore，所以固化在这里）
├── pyref/
│   ├── ring_np.py                NumPy 参考：循环卷积 / 中心代表 / 向量解析
│   ├── ntru_ref_py.py            Python 参考：GF(2) 求逆 + Hensel + 解密
│   ├── cross_check.py            跨语言一致性校验（9 项代数关系）
│   ├── attack_lattice.py         ★★ 格攻击：显式构造 Λ_h（2n 维），LLL 恢复私钥
│   ├── gpu_kernel.py             ★ C3：GPU 批量卷积 + 批量部分重加密（骨架）
│   ├── hop_sim.py                ★ C2 数值核心：多跳蒙特卡洛 + 鞍点（Lugannani–Rice）尾部模型
│   └── mc_failprob.py            ★ C2：失败概率预算 / h_max(δ) 反解（已自包含）
├── bench/
│   └── results/                  C2 实测数字：c2_mc_curve.csv / c2_budget.csv / c2_threshold.csv
└── docs/
    ├── 00_design.md              设计决策与待验证命题（写报告时的底稿）
    ├── 01_加密流程预演.md         ★ 两个对象走一遍完整代码（含手工验算示例）
    ├── 02_格在哪里.md             ★★ 环 vs 格的关系 + 攻击代码逐段讲解（回答"格在哪"）
    ├── C2失败概率预算_实施计划.md  C2 的噪声模型、鞍点方案与验证计划
    ├── C2_实现进度.md             C2 进度：改动原因、验证证据、已跑出的数字
    └── C2_报告.md                 ★ C2 报告正文（可直接并入总报告）
```

★ 标记的文件是创新点落点：C1 = `threshold.*`，C2 = `hop_sim.py` + `mc_failprob.py`，C3 = `gpu_kernel.py`。

\* 代码里沿用旧名 `EES439`；该组参数来自 ntru 的 **`APR2011_439`**（EES 族**没有** 439）。
它的字段曾被错读、已于 2026-10-14 修正，见 `docs/C2_实现进度.md` §4.5(b)。
★★ 标记的两个文件回答"**格密码体现在哪**"：算法算环、难度靠格，`attack_lattice.py` 是唯一显式写出格矩阵的地方。

---

## 3. 构建与运行

### Windows（快速迭代，本机已可用）
```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test    # 编译 + 自检
.\bin\ntru_cli.exe smoke EES439 3 2
python pyref\cross_check.py EES439 7
python pyref\hop_sim.py --selftest                            # C2 数值核心自检
```

### WSL / Linux（正式实验，推荐）
```bash
make                 # 编译 bin/ntru_cli 与 bin/ntru_tests（在仓库根目录执行）
make test            # 单元测试
make run             # EES439 冒烟
make bench           # 环乘法微基准
python3 pyref/cross_check.py EES439 7
python3 pyref/gpu_kernel.py --backend cupy --n 1171 --batch 8192   # 需要 CuPy
```

### C2：多跳失败概率预算（纯 Python，不需要编译）
```bash
python pyref/hop_sim.py --selftest                   # 7 类硬断言（含与 C++ 引擎逐位对拍）
python pyref/mc_failprob.py                          # 4 个参数集：δ(h) 曲线 + 跳数预算 + 三张 CSV
python pyref/mc_failprob.py --params EES1171 --samples 200000
python pyref/mc_failprob.py --m-list 1,3,5,10,15     # 门限（C1）代价曲线：m = C(N,t−1)
python pyref/mc_failprob.py --m-list 1,5,15 --jobs 16  # 并行度（默认 8）
python pyref/mc_failprob.py --cgf-sweep 50000,200000,800000   # 尾部外推的收敛性检查
```
**调参提示**：`--cgf-samples` **不要往下调**（实测 20 万以上才收敛）；`--samples` 决定 MC 能测到的
δ 下限（3 万样本约 `3e-5`）；`--jobs` 只在配置之间并行，单个配置内部仍是单线程。

### 已实测的性能基线（本机 Windows/MinGW，**仅作参考**）
| n | poly_mul_ref | poly_mul_fast(int64) | poly_mul_i32(分块) |
|---|---|---|---|
| 439 | 394 µs | 96 µs | 21.5 µs |
| 1171 | 2831 µs | 543 µs | **148–153 µs** |

> 注：`poly_mul_i32` 每次调用的 3 次 `std::vector` 分配开销实测可忽略
> （提出分配后 152.5µs vs 148.4µs，属噪声，见 `poly_mul_i32_scratch`）。
> 旧表里的 289µs 是 MinGW 8.1 的数，本机新编译器快近一倍。

---

## 4. 两条必须知道的口径问题

### 4.1 你原来的 CPU 与 GPU 基准口径不一致 ⚠️

> 注：下表提到的 `bench/cpu_*.c`、`bench/gpu_kernel_v1.py` 等文件**不在本仓库内**（属于早期的另一份基准代码）。
> 这里保留结论，是为了说明"重测时口径必须统一"这条方法学要求。

| 文件 | 系数分布 | 累加类型 | 是否满量程安全 |
|---|---|---|---|
| `bench/cpu_schoolbook.c` / `cpu_splitloop.c` / `cpu_openmp.c` | **三元** `rand()%3-1` | int32 | 只对三元安全 |
| `bench/gpu_kernel_v1.py` / `v2.py` / `gpu_transfer.py` | **满量程** `randint(0,2048)` | int64 / int32+归约 | 是 |

结论：**"CPU 59 µs vs GPU 233 µs、GPU 3.7×" 这组数字比较的是两种不同负载**（三元 vs 满量程），
而且旧 GPU 基准把 H2D/D2H 搬运也算进了计时区间。**同机同分布（满量程 [0,2048)）重测后，该结论被推翻**：

| n=1171，每次卷积 | CPU `poly_mul_i32` | GPU (C3, kernel-only) | GPU (C3, 端到端) |
|---|---|---|---|
| batch=8192 | ~150 µs | **2.03 µs（75×）** | 14.6 µs（10.5×） |

GPU 优势只在批量下成立：batch=1 时 kernel-only 78µs、端到端约 211µs，交叉点约在
batch≈2–4。完整曲线见 `bench/results/gpu_kernel_sweep_i32twoseg.csv`。

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
- [x] **格在哪里的实证**：`pyref/attack_lattice.py` 显式构造 2n 维格 Λ_h + LLL，
      在 TINY7 上**精确恢复私钥**（0.29 s）；真实参数给出"LLL 差 2^219 倍"的量化说明（见 `docs/02_格在哪里.md`）
- [x] **C2 失败概率预算**：`pyref/hop_sim.py` + `pyref/mc_failprob.py` 自包含跑出 δ(h) 曲线，
      用鞍点（Lugannani–Rice）模型外推到 `2^-40` 并反解 `h_max(δ, 参数, 门限配置)`；
      门限（C1）的 `m = C(N,t−1)` 耦合已计入，产出"腐化阈值 ↑ → 可用跳数 ↓"代价曲线。
      噪声核公式已用 C++ 引擎导出的测试向量 **逐位对拍**（`tests/fixtures/`，见 `docs/C2_实现进度.md`）。
      **结论与局限见 [docs/C2_报告.md](docs/C2_报告.md)**（与论文 Table 4 对拍：4 个参数集里 3 个一致）

### 下一步（按优先级）
1. **CSPRNG**：把 `Rng` 换成 `getrandom`/`BCryptGenRandom`（`sampler.h` 里有 TODO）。正式密钥生成**不能**用 `mt19937_64`。
2. **rk 攻击（多密钥格）**：`attack_lattice.py` 目前做的是"公钥 h → 私钥 f"；
   下一步要做"**从 `rk = f_A·f_B^{-1}` 恢复 `f_A`**"（Liu–Pan–Zhang 2019/083 与 2024 版），
   它是"腐化阈值从 1 提到 t"这个主张的量化依据。WSL 里装 fpylll 后可跑大维数 + BKZ。
3. **C1 的完整论证**：把 `docs/00_design.md` 里"待验证命题"逐条推完（尤其 partial 的 mod p 泄漏）。
4. **C3**：把 `poly_mul_i32` 的分块归约搬进 CuPy 核（`gpu_kernel.py` 已给骨架），并用**同分布**重测 CPU/GPU。
5. **C2 剩余两项**（主体已完成，见 `docs/C2_报告.md`）：
   ① **`--backend cupy` 在 WSL 里实测** —— 现在 δ 的实测下限约 `3e-5`，进一步降低需要 GPU 与 `~1e7` 样本；
   ② **EES1087 与论文 Table 4 的口径差异** —— 参数、噪声分布、`f = 1+p·F` 约定、解密判据均已逐项核对无误；
   换用论文自己的"平均可支撑跳数"定义时结论会反转（EES1087 反而吻合、另外三个偏高 30~40%）。
   **两种口径尚未统一，报告里应并列给出而不是择一断言**。定性需要复现其原始实验流程。
6. **参数安全估计**：用 lattice-estimator / BKZ 成本模型把 `(n,q,df,dg)` 换成安全位数（`docs/02_格在哪里.md` §5）。
7. **[x]** `bench/results/*.csv` 已建：C2 的三张表 + C3 的 `gpu_kernel_sweep_i32twoseg.csv`、
   `gpu_kernel_sweep_i64.csv`、`gpu_kernel_variants.csv`（+ `bench/kernel_variants.py` 复现脚本）。

---

## 6. 环境坑（记录一下，省得再踩）
- **Windows PowerShell 5.1 按 ANSI 读 .ps1**：脚本里别写中文（`build.ps1` 已改成纯 ASCII）。
- **Python 读子进程输出**要显式 `encoding="utf-8"`，否则 GBK 解码崩溃（`cross_check.py` 已处理）。
- **q = 2048 不能做 NTT**：`(Z/2048)^×` 阶为 1024 < n，不存在 n 阶单位根；要 NTT 必须走 CRT + NTT 友好素数。
- **WSL2 内存约 7.6 GB**：编译/跑大实验时注意内存；GPU 侧 H2D 只有 0.8–2.1 GB/s（端到端吞吐要单独报）。
- **`-march=native`**：Windows MinGW 8.1 与 WSL gcc 13.3 都支持，但两者的自动向量化质量不同，性能数字必须注明编译器。
- **⚠️ Windows 上必须加 `-static-libstdc++ -static-libgcc`**（`build.ps1` 已加）。
  Git for Windows 自带一份**较旧的** `libstdc++-6.dll` 并把它排在 PATH 前面，动态链接的 exe 运行时会绑到**那一份**，
  与编译时那套 MinGW-w64（g++ 16.2）的头文件 ABI 不一致 → 访问违例。
  **症状很有迷惑性**：`selftest` / `smoke` / `bench` 全都正常，**只有 `vectors` 段错误** ——
  因为它是唯一构造 `std::ofstream` 的子命令，崩的位置在 `basic_ofstream` 构造函数里，看起来像源码 bug。
  排查：`g++ -g -O2 ... && gdb -batch -ex run -ex bt --args ...`；栈里会看到
  两个 DLL 的来路不同：一个来自 Git for Windows 自带的 MinGW，一个来自独立安装的 MinGW-w64。

---
