# 基于格密码的代理重加密算法设计与优化实现（A1-4）

> 2026 第十一届全国密码技术竞赛 · 赛题 A1-4
> 作品主题：**面向多跳可用性的 NTRU 代理重加密——门限多代理委托、失败概率预算与 GPU 批量实现**
> 版本：2026-10-18
> 提交包只包含**源码、测试、实验数据与设计文档**；作品设计报告与审批签字页随平台单独提交。
> 若在完整仓库中，报告源稿为根目录的 `最终报告.md`。

---

## 0. 作品是什么

在 **NTRUReEncrypt**（Nuñez–Agudo–Lopez, ASIA CCS 2015）这条“环上 NTRU 代理重加密”路线上，针对原方案的三个工程缺陷做了三项互相咬合的工作：

| 编号 | 工作 | 解决的问题 | 主要落点 |
|---|---|---|---|
| **C1** | 门限多代理委托 | `rk = f_A·f_B^{−1}` 是单点信任，1 个代理 + 接收者即可恢复 `f_A` | `src/core/threshold.*`、`ntru_cli c1` |
| **C2** | 多跳失败概率预算 | 论文只给经验跳数，无法回答“给定失败概率还能跳几次” | `pyref/hop_sim.py`、`pyref/mc_failprob.py` |
| **C3** | GPU 批量（部分）重加密 | 旧基准把 CPU 三元与 GPU 满量程混比，得出错误的“GPU 3.7×” | `pyref/gpu_kernel.py`、`bench/kernel_variants.py` |

三项工作的关系：**C2 给出“噪声预算 → 可用跳数”的标尺，C1 用它选可用的 `(N,t)` 并付出“噪声 ×m 份”的代价，C3 把 C1 那 `m` 份相互独立的 partial 批量喂给 GPU。**

关键结果（详见 `bench/results/*.csv` 与作品设计报告）：

| 维度 | 结果 |
|---|---|
| 门限性 | `t` 个代理转换成功率 **100%**；`t−1` 个代理“尽力而为”组合成功率 **0.00%（21/21 配置）** |
| 正确性 | `selftest` **21/21**；C++ ↔ Python 逐位对拍 `max\|diff\| = 0` |
| 多跳预算 | 鞍点模型标定常数 **1.0015–1.0152**，残差 ≤ **0.095 decade**；失败概率可外推到 **2^−40** |
| 跳数预算 | `EES1499` 在 `δ=2^−40` 下仍可 **10 跳**，`EES1171` 4 跳，`EES1087` 3 跳 |
| GPU 加速 | `n=1171, batch=8192` 同分布满量程：kernel-only **2.03 µs/次（75.24×）**，端到端 **14.57 µs/次（10.47×）** |
| 交叉点 | GPU 从 **batch ≈ 2–4** 开始有收益；更小批量走 CPU |

---

## 1. 30 秒跑通

### Windows（MinGW-w64 g++）

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test   # 编译 + selftest
.\bin\ntru_cli.exe selftest                                  # 21/21
.\bin\ntru_cli.exe walkthrough                               # 教学参数 n=7，逐系数预演
python pyref\cross_check.py EES439 7                         # C++ ↔ Python 9 项代数关系
```

### WSL / Linux（正式实验推荐）

```bash
make            # 生成 bin/ntru_cli 与 bin/ntru_tests
make test       # 单元测试（tests/test_core.cpp）
./bin/ntru_cli selftest
```

`bin/` 是构建产物，不随本包提供；先构建再运行。

---

## 2. 目录结构

```
.
├── README.md                  本文件
├── Makefile                   WSL/Linux 构建
├── build.ps1                  Windows 快速构建（纯 ASCII，避免 GBK 坑）
├── src/
│   ├── core/
│   │   ├── params.h/.cpp      参数集（EES439/1087/1171/1499 + TINY7/TINY61）
│   │   ├── ring.h/.cpp        Z_q[x]/(x^n−1)：ref / int64 / int32 分块三种乘法
│   │   ├── poly_inv.h/.cpp    GF(2) 扩展欧几里得 + Hensel 提升
│   │   ├── sampler.h/.cpp     三元固定重量采样（含 CSPRNG TODO）
│   │   ├── ntru.h/.cpp        KeyGen / Enc / Dec（含噪声度量）
│   │   ├── pre_base.h/.cpp    基线 NTRUReEncrypt：ReKeyGen / ReEnc
│   │   └── threshold.h/.cpp   C1：CNF 份额分发 / 部分重加密 / 组合 / 缺口份额
│   └── cli/main.cpp           selftest / walkthrough / smoke / c1 / vectors / bench
├── tests/
│   ├── test_core.cpp          单元测试（结构测试 + 端到端测试）
│   └── fixtures/              C2 硬断言使用的固定测试向量
├── pyref/
│   ├── ring_np.py             NumPy 参考：循环卷积 / 中心代表
│   ├── ntru_ref_py.py         Python 参考：求逆 / Hensel / 解密
│   ├── cross_check.py         C++ ↔ Python 9 项代数关系对拍
│   ├── attack_lattice.py      显式构造 2n 维格 Λ_h + LLL（TINY7 上恢复私钥）
│   ├── hop_sim.py             C2 数值核心：MC + 鞍点（Lugannani–Rice）尾部模型
│   ├── mc_failprob.py         C2 预算层：δ(h) 曲线 / h_max(δ) / 门限代价
│   └── gpu_kernel.py          C3：CuPy RawKernel 四变体 + NumPy 校验路径
├── bench/
│   ├── kernel_variants.py     C3：四变体同条件对比
│   └── results/               全部实验数据（报告数字的唯一出处）
└── docs/
    ├── 00_design.md           设计底稿与代码对照
    ├── 01_加密流程预演.md      两个对象走完整流程，含手工验算
    ├── 02_格在哪里.md          环与格的关系、攻击代码逐段讲解
    └── 工程复盘.md             4 个 bug、参数核对、与作者实现的差异
```

> 代码中沿用旧名 `EES439`；该组参数实际来自 **`APR2011_439`**（EES 族没有 439）。

---

## 3. 构建与运行

### 3.1 Windows（MinGW-w64 g++）

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1          # 只编译
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test    # 编译 + selftest
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Smoke   # 编译 + smoke
```

必须使用 `-static-libstdc++ -static-libgcc`（脚本已加）。Git for Windows 自带的旧 `libstdc++-6.dll` 会排在 PATH 前面，动态链接会让 `vectors` 子命令在构造 `ofstream` 时崩溃。

### 3.2 WSL / Linux

```bash
make            # 编译 CLI 与测试
make test       # 单元测试
make selftest   # CLI selftest
make run        # EES439 冒烟
make bench      # 环乘法微基准
```

### 3.3 CLI 子命令

```text
ntru_cli selftest
ntru_cli walkthrough
ntru_cli smoke     <参数集> <N> <t>
ntru_cli c1        <参数集> <trials> <zero_trials>   # C1 门限专项实验
ntru_cli vectors   <参数集> <seed> [输出文件]
ntru_cli bench     <参数集> [迭代次数]
```

---

## 4. 复现实验

### 4.1 C1：正确性、门限性与零信息

```powershell
.\bin\ntru_cli.exe c1 EES439  20 1000
.\bin\ntru_cli.exe c1 EES1171 10 500
.\bin\ntru_cli.exe c1 EES1499 10 500
```

输出写入 `bench/results/c1_*.csv`。每条记录包含：

- `succ_t_pct`：`t` 个代理一次转换并逐系数还原明文的成功率；
- `succ_t_minus_1_pct`：`t−1` 个代理“尽力而为”组合后的成功率（应为 0）；
- `noise_ratio`：门限噪声 / 基线噪声；
- `share_ms` / `partials_ms` / `combine_ms`：三阶段平均耗时。

`c1` 命令末尾还会跑零信息性检查：联盟 `W={P1,P2}` 缺少的份额数应恒为 1，缺失份额与 `rk − 缺失份额` 的均值/标准差应接近均匀分布（`mean≈0, std≈q/√12`）。

### 4.2 C2：失败概率预算

```bash
python pyref/hop_sim.py --selftest                          # 7 类硬断言
python pyref/mc_failprob.py                                 # 4 个参数集，三张 CSV
python pyref/mc_failprob.py --params EES1499 --samples 30000
python pyref/mc_failprob.py --m-list 1,3,5,10,15,35,56      # C1 × C2 门限代价
python pyref/mc_failprob.py --cgf-sweep 50000,200000,800000 # 尾部外推收敛性
```

输出：

- `bench/results/c2_mc_curve.csv`：`δ(h)` 曲线与 MC 置信区间；
- `bench/results/c2_budget.csv`：`h_max(δ)`、标定常数、残差/漂移；
- `bench/results/c2_threshold.csv`：门限配置 `m = C(N,t−1)` 的代价曲线。

口径：每条曲线 30000 条链、CGF 样本 20 万、`seed=1`、后端 `fft`（CPU/NumPy）。3 万样本的 MC 实测下限约 `3e−5`，更低概率依赖鞍点外推。

### 4.3 C3：GPU 批量（部分）重加密

需要 CuPy + NVRTC（`nvidia-cuda-nvrtc-cu12 >= 12.8`，否则不认 `compute_120`）：

```bash
python pyref/gpu_kernel.py --backend cupy --n 1171 --batch 8192 --variant i32twoseg --cpu-us 150.06
python pyref/gpu_kernel.py --backend cupy --n 1171 --sweep --variant all
python bench/kernel_variants.py
```

输出：

- `bench/results/gpu_kernel_variants.csv`：四变体同条件对比；
- `bench/results/gpu_kernel_sweep_i32twoseg.csv`：batch 扫描 + 端到端计时；
- `bench/results/gpu_kernel_sweep_i64.csv`：int64 基线扫描。

---

## 5. 关键结果与口径

### 5.1 C1 门限性（EES439）

| 配置 (N,t) | 子集数 m | t 个成功 | t−1 个成功 | 噪声放大 |
|---|---|---|---|---|
| (2,2) | 2 | 100% | 0% | 1.424× |
| (3,2) | 3 | 100% | 0% | 1.643× |
| (4,2) | 4 | 100% | 0% | 1.855× |
| (5,2) | 5 | 75% | 0% | 2.190× |
| (5,3) | 10 | 0% | 0% | 2.256× |

完整三组参数集见 `bench/results/c1_*.csv`。`t−1` 个代理在全部 21 个配置上成功率恒为 **0.00%**，且缺口份额统计上均匀。

### 5.2 C2 跳数预算

| 参数集 | δ=1e−3 | δ=1e−6 | δ=2^−40 | 标定常数 | 最大残差 |
|---|---|---|---|---|---|
| EES1499 | 30 | 19 | 10 | 1.0152 | 0.042 dec |
| EES1171 | 13 | 8 | 4 | 1.0022 | 0.075 dec |
| EES1087 | 9 | 5 | 3 | 1.0015 | 0.038 dec |
| EES439 | 2 | 1 | 0 | 1.0018 | 0.091 dec |

门限代价：在 `δ=1e−3` 下，EES1499 可支撑 `(6,3)`（m=15），EES1171 可支撑 `(5,3)`（m=10）。

### 5.3 C3 性能

`n=1171, q=2048, batch=8192`，输入满量程 `[0,2048)`（与 CPU `poly_mul_i32` 同分布）：

| 变体 | kernel-only | 端到端（含 H2D/D2H） |
|---|---|---|
| v1（int64） | 3.50 µs/次（42.8×） | 20.35 µs/次（7.37×） |
| v4（int32 两段拆分） | **2.03 µs/次（75.24×）** | **14.57 µs/次（10.47×）** |

CPU 对照：`poly_mul_i32 @ n=1171` 在 i9-14900HX + MinGW `g++ -O3 -march=native` 上 **150.06 µs/次**。四变体内部，v4 比 v1 快 **1.65×**（同条件 batch=8192）。

**必须区分的两个口径**：

- **kernel-only**：只计核函数，输入已在 device 上；
- **端到端**：含 `cp.asarray` / `cp.asnumpy` 搬运。

**必须统一的操作数分布**：只有 ReEnc 的 `C_A·rk` 是满量程 × 满量程（`n(q−1)² ≈ 4.9e9 > 2^31`），必须 int32 分块归约；旧基准拿 CPU 三元 vs GPU 满量程，结论不可比。

---

## 6. 环境与已知坑

- **Windows PowerShell 5.1 按 ANSI 读 `.ps1`**：`build.ps1` 保持纯 ASCII。
- **Windows 必须静态链接 libstdc++/libgcc**：否则 `vectors` 子命令会在 `basic_ofstream` 构造函数中崩溃。
- **Python 读子进程输出**要显式 `encoding="utf-8"`，否则 GBK 解码崩溃（`cross_check.py` 已处理）。
- **`q = 2048` 不能做 NTT**：`(Z/2048)^×` 的阶为 1024 < n，不存在 n 阶单位根。
- **CUDA**：`nvidia-cuda-nvrtc-cu12 >= 12.8` 才支持 `compute_120`（Blackwell / RTX 50 系）；GPU 计时需注明是否含搬运。
- **性能数字与机器/编译器相关**：报告中的时序均标注了 CPU/GPU 型号与编译选项。

---

## 7. 边界与后续

**不主张的内容**（与作品设计报告一致）：

- 不主张 NTRUReEncrypt 本身“安全”：该方案已有反应攻击与 2024 年多项式时间密钥恢复；
- 不主张“抗合谋”：`t` 个代理合谋仍可重构 `rk`，与接收者联手即得 `f_A`；
- `partial` 的严格表述是“被新鲜小多项式掩码隐藏”，不是精确的 mod p 投影；
- 组合者未被门限化，其视野等同基线单代理。

**后续工作**：

1. 把 `sampler.h` 里的 `Rng` 换成 CSPRNG（`getrandom` / `BCryptGenRandom`）；
2. 补 `rk` 的多密钥格攻击实验，量化“腐化阈值 1→t”；
3. C2：用 `--backend cupy` 把 MC 样本提到 `1e7+`，把实测下限从 `3e−5` 推到 `1e−6`；
4. C1：给 `threshold_combine_best_effort` / `threshold_missing_subset` 补单元测试；
5. 用 lattice-estimator / BKZ 成本模型把 `(n,q,df,dg)` 换算成安全位数。

---

## 8. 数据与文档

- **实验数据**：`bench/results/*.csv`，报告中的每个数字都对应其中一行；时序数字与机器相关。
- **设计文档**：`docs/01_加密流程预演.md`（可手工验算的完整流程）、`docs/02_格在哪里.md`（环/格关系与攻击代码）、`docs/工程复盘.md`（踩坑记录）。
- **测试向量**：`tests/fixtures/vectors_EES439_7.txt` 是固定 fixture；`bin/vectors_*.txt` 是运行时生成物，不随包提供。
- **作品设计报告**：随竞赛平台单独提交；本包不包含报告正文与签字页。
