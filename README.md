# 面向多跳可用性的 NTRU 代理重加密

> 赛题 **A1-4：基于格密码的代理重加密算法设计与优化实现**
> 在 NTRUReEncrypt（Nuñez–Agudo–Lopez, ASIA CCS 2015）这条环上 NTRU 代理重加密路线上，
> 补上「委托要可信几个人」和「能跳几跳」两个工程问题的答案，并给出 GPU 批量实现。

成果与结论见 **[最终报告.md](最终报告.md)**。本 README 只讲**这个项目由哪些部分组成**、**怎么跑起来**。

---

## 1. 项目概览

基线方案只有一条单代理、单跳的重加密链。本项目在它上面做三件事，三者互相咬合：

| 编号 | 创新点 | 一句话 | 代码落点 |
|---|---|---|---|
| **C1** | 门限多代理委托 | 把委托凭证 `rk = f_A·f_B^{−1}` 用子集加性分享拆给 `N` 个代理，任意 `t` 个才能完成转换、`≤ t−1` 个对 `rk` 零信息 ⇒ 腐化阈值从 1 个代理提高到 `t` 个 | `src/core/threshold.*` |
| **C2** | 多跳失败概率预算 | 把论文里的"经验跳数"变成可查询的预算 `h_max(δ, 参数集, 门限配置)`：噪声核 + 蒙特卡洛 + 鞍点（Lugannani–Rice）尾部外推，可外推到 `2^−40` | `pyref/hop_sim.py`、`pyref/mc_failprob.py` |
| **C3** | GPU 批量（部分）重加密 | 定位出只有 ReEnc 的 `C_A·rk` 是满量程 × 满量程（`n(q−1)² ≈ 4.9e9 > 2^31`），据此重写 int32 两段拆分去分支核；再接常驻 device buffer、多流重叠搬运与真实份额批量 partial | `src/core/ring.*`、`pyref/gpu_kernel.py` |

**关系**：C2 给出"噪声预算 → 可用跳数"的标尺，C1 拿这个标尺选 `(N,t)` 并付出"噪声 ×`m` 份"（`m = C(N,t−1)`）的代价，C3 把 C1 那 `t` 份相互独立的部分重加密批量喂给 GPU。

C1 的"腐化阈值 1→t"两侧都有数字：`≤ t−1` 个代理对 `rk` 零信息（信息论一侧），而从 `rk` 恢复 `f_A` 需要跨过的多密钥格攻击代价是 `2^217` 起的 LLL 缺口（攻击成本一侧，见 `pyref/attack_rk_lattice.py`）。

三者共享同一条正确性前提：解密时系数必须落在 `q/2 = 1024` 以内，否则中心代表绕回、解密失败。全部噪声数字以 `bench/results/*.csv` 为准。

---

## 2. 项目框架

### 2.1 语言分工

| 部分 | 技术 | 承担什么 |
|---|---|---|
| 核心密码引擎 | **C++17**（无第三方依赖） | 环运算、NTRU 五算法、门限、CLI、单元测试。性能数字由它产出 |
| 参考实现 | **Python 3 + NumPy** | 用独立实现校验 C++，避免"自己验自己" |
| 格攻击与成本量化 | **Python + SymPy / fpylll** | 显式构造 Λ_h 与 Λ_rk，LLL/BKZ 恢复私钥、量化攻击成本 |
| GPU 算子 | **Python + CuPy**（RawKernel/NVRTC） | 批量卷积、常驻缓冲、多流流水线；走 NVRTC 因此不需要安装 CUDA Toolkit |
| 数值实验 | **Python + CuPy/NumPy** | 多跳蒙特卡洛、尾部外推、失败概率预算 |

一句话：**C++ 负责"快"和"可交付"，Python 负责"对"和"GPU/模拟"。**

### 2.2 目录结构

```
最终方案/
├── src/
│   ├── core/                  密码引擎（C++17，无外部依赖）
│   │   ├── params.*           参数集 EES1087/1171/1499 与 APR2011_439
│   │   ├── ring.*             Z_q[x]/(x^n−1)：三层乘法 ref / int64 / int32 分块
│   │   ├── poly_inv.*         多项式求逆：GF(2) 扩展欧几里得 + Hensel 提升
│   │   ├── sampler.*          三元定重采样 / 均匀采样 / 随机源
│   │   ├── ntru.*             KeyGen / Enc / Dec（含噪声度量）
│   │   ├── pre_base.*         基线 NTRUReEncrypt：ReKeyGen / ReEnc
│   │   └── threshold.*        ★ C1：分享 / 部分重加密 / 组合
│   └── cli/main.cpp           命令行入口
├── tests/
│   ├── test_core.cpp          单元测试（独立于 CLI）
│   └── fixtures/              跨语言对拍用的测试向量
├── pyref/                     Python 参考实现与实验脚本
│   ├── ring_np.py             循环卷积 / 中心代表 / 向量解析
│   ├── ntru_ref_py.py         GF(2) 求逆 + Hensel + 解密
│   ├── cross_check.py         C++ ↔ Python 一致性校验（9 项代数关系）
│   ├── attack_lattice.py      ★★ 格攻击（公钥 h → 私钥 f）：构造 Λ_h，LLL 恢复
│   ├── attack_rk_lattice.py   ★★ 多密钥格攻击（rk → f_A）：构造 Λ_rk，量化 C1 的攻击成本
│   ├── hop_sim.py             ★ C2 数值核心：蒙特卡洛 + 鞍点尾部模型
│   ├── mc_failprob.py         ★ C2：失败概率预算 / h_max(δ) 反解
│   ├── gpu_kernel.py          ★ C3：GPU 批量卷积 / 常驻 buffer / 多流 / 真实份额批量 partial
│   └── threshold_gpu_check.py ★ C3：用真实份额验证"分发 → 批量 partial → 组合 → 解密"
├── bench/
│   ├── kernel_variants.py     C3：四种核变体同条件对比
│   └── results/               实测数据（唯一权威来源）
├── docs/                      设计底稿、流程预演、格视角、工程复盘
├── Makefile                   WSL / Linux 构建
└── build.ps1                  Windows 构建
```

> `attack_lattice.py`（`h → f`）与 `attack_rk_lattice.py`（`rk → f_A`）是两个显式写出格矩阵的地方 —— 算法算的是环，难度靠的是格，见 `docs/02_格在哪里.md`。
> 代码里沿用旧名 `EES439`，该组参数实际来自 `APR2011_439`（EES 族没有 439）。

---

## 3. 快速启动

### 3.1 环境要求

- **C++**：g++ ≥ 8.1，需支持 C++17 与 OpenMP（MinGW-w64 或 WSL 的 gcc 均可）
- **Python**：3.9+，`numpy`；跑 GPU 路径另需 `cupy`（可选 `sympy` 作格归约的纯 Python 后备）
- 所有命令都在**仓库根目录**执行（实验脚本把结果写到相对路径 `bench/results/`）

### 3.2 Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1        # 只编译
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test   # 编译 + 自检
.\bin\ntru_cli.exe smoke EES439 3 2                          # 冒烟
```

`build.ps1` 已固定 `-static-libstdc++ -static-libgcc`，**不要去掉**：Git for Windows 自带的旧 `libstdc++-6.dll` 会抢在 PATH 前面，动态链接会导致 `vectors` 子命令崩溃。

### 3.3 WSL / Linux（正式实验推荐）

```bash
make            # 编译 bin/ntru_cli 与 bin/ntru_tests
make test       # 单元测试
make run        # EES439 冒烟
make bench      # 环乘法微基准
```

### 3.4 确认环境正常

依次跑，全部通过即可认为环境就绪：

| 命令 | 预期 |
|---|---|
| `bin/ntru_cli.exe selftest` | 21 项全过 |
| `bin/ntru_tests.exe`（或 `make test`） | 165 项全过 |
| `bin/ntru_cli.exe walkthrough` | 教学参数 `n=7` 的完整流程预演，逐系数打印，数字可手工验算 |
| `python pyref/cross_check.py EES439 7` | C++ 与 Python 参考实现 9 项代数关系一致 |
| `python pyref/hop_sim.py --selftest` | C2 数值核心全部断言通过（含与 C++ 引擎逐位对拍） |
| `python pyref/attack_lattice.py --params TINY7 --seed 1` | 在 14 维格上 LLL 精确恢复私钥 |
| `python pyref/attack_rk_lattice.py --params TINY7 --seed 1` | 从 `rk` 经多密钥格精确恢复 `f_A` |
| `python pyref/threshold_gpu_check.py --params TINY7 --N 3 --t 2` | 真实份额分发 → 批量 partial → 组合 → 解密，5 组断言全过 |

### 3.5 跑三个实验

```bash
# C1：门限多代理委托（7 个 (N,t) 配置，结果写 bench/results/c1_<参数集>.csv）
bin/ntru_cli.exe c1 EES439 200 100

# C2：多跳失败概率预算（4 个参数集，产出三张 CSV）
python pyref/mc_failprob.py
python pyref/mc_failprob.py --m-list 1,3,5,10,15      # 门限代价曲线：m = C(N,t−1)
python pyref/mc_failprob.py --params EES1171 --samples 200000

# C3：GPU 批量卷积（kernel-only 与端到端分开报）
python pyref/gpu_kernel.py --sweep --variant all
python bench/kernel_variants.py

# C3：真实份额分发 → GPU 批量部分重加密 → 组合 → 解密（需先有 bin/ntru_cli）
python pyref/threshold_gpu_check.py --params EES439 --N 5 --t 3 --batch 32
```

执行说明：

- `c1` 与 `mc_failprob.py` 会**重写** `bench/results/` 下对应的 CSV —— 那些文件是报告数据的来源，别在没备份时随手覆盖。
- C3 两条命令在没有 `cupy` 的环境里会自动退回 NumPy：此时能验证**正确性**，但计时没有 GPU 意义（kernel-only 会退到几百 µs 量级）。
- C2 调参：`--cgf-samples` 不要往下调（实测 20 万以上才收敛）；`--samples` 决定 MC 能测到的 δ 下限（3 万样本约 `3e-5`）；`--jobs` 只在配置之间并行。

---

## 4. 文档入口

| 想了解 | 看哪里 |
|---|---|
| 结论、性能数据、与论文的对比、边界声明 | **[最终报告.md](最终报告.md)** |
| 两个对象走一遍完整加密/重加密/门限流程（可手工验算） | [docs/01_加密流程预演.md](docs/01_加密流程预演.md) |
| "格密码体现在哪"：环与格的关系、攻击代码逐段讲解 | [docs/02_格在哪里.md](docs/02_格在哪里.md) |
| 设计决策与代码对照表 | [docs/00_design.md](docs/00_design.md) |
| 踩过的坑、参数核对、与作者实现的差异 | [docs/工程复盘.md](docs/工程复盘.md) |

---

## 5. 数据口径

三条规矩，报告和 README 里的数字都遵守：

1. **性能数字必须注明编译器与是否 `-march=native`** —— 不同工具链的自动向量化差异可达数倍。
2. **kernel-only 与端到端分开报** —— 后者含 H2D/D2H 搬运，GPU 优势只在批量下成立。
3. **CPU 与 GPU 必须在同分布下比较** —— 三元系数与满量程系数的成本完全不同，跨分布的数字没有可比性。
