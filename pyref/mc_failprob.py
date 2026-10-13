"""
C2：多跳失败概率预算
====================
文件：pyref/mc_failprob.py

定位：把"经验最大跳数"升级为"给定失败概率 δ 的预算"，并反解 h_max(δ, 参数, 门限配置)。

三块工作（对应 README §5 路线图第 5 条的 TODO）：
  1) 标定：自包含的多跳蒙特卡洛（`pyref/hop_sim.py`），把 δ 测到 MC 能到的下限
     （CPU/fft 约 1e-4~1e-5；`--backend cupy` 在 WSL 里可到 1e-6）
  2) 外推：鞍点（Lugannani–Rice）尾部模型在可测区间用 MC 标定，再推到 2^-40
  3) 反解：h_max(δ) 与"门限噪声放大 m = C(N,t−1) → 可用跳数下降"的联合曲线

**本文件曾经依赖外部文件 `A1-4_选题方案/multihop_output.txt`，那份数据和生成它的
GPU 脚本都不在本仓库也不在协作机器上。现在改为自包含：默认自己生成曲线；`
--input` 仍然可以读外部表（向后兼容）。**

用法：
    python pyref/mc_failprob.py                                  # 4 个 EES 参数集，出曲线 + 预算表
    python pyref/mc_failprob.py --params EES1171 --samples 200000
    python pyref/mc_failprob.py --joint                          # 加门限联合选参表
    python pyref/mc_failprob.py --input <multihop_output.txt>    # 读外部表（老路径）
    python pyref/hop_sim.py --selftest                           # 数值核心的硬断言
"""

from __future__ import annotations

import argparse
import csv
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Windows 控制台默认 GBK，中文输出会乱码/报错；统一按 UTF-8 输出
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import hop_sim  # noqa: E402
from hop_sim import EES, HopStat, RingParams  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULT_DIR = os.path.join(REPO_ROOT, "bench", "results")


# ---------------------------------------------------------------------------
# 向后兼容：外部模拟器输出解析（原样保留）
# ---------------------------------------------------------------------------
def parse_simulator_output(path: str) -> dict:
    """
    解析 A1-4_选题方案/multihop_output.txt 里的失败概率表。
    该文件由你已有的 GPU 模拟器生成，格式为：
        h   EES439  EES1087  EES1171  EES1499
        1   0.0000  ...
    """
    curves: dict[str, dict[int, float]] = {k: {} for k in EES}
    in_table = False
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            m = re.match(r"^(\d+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)$", s)
            if m:
                h = int(m.group(1))
                for i, k in enumerate(["EES439", "EES1087", "EES1171", "EES1499"]):
                    curves[k][h] = float(m.group(i + 2))
                in_table = True
            elif in_table and not s[0].isdigit():
                # 表结束后再遇到非数字行就停
                if "怎么读" in s or "====" in s:
                    in_table = False
    return curves


def tail_extrapolate(curve: dict, target_delta: float, model: str = "interp") -> float:
    """
    由 MC 测得的 δ(h) 反解达到 target_delta 的跳数（**只用于曲线**，不碰鞍点模型）。

    模型：
      * interp（默认）：在可测区间内做 (h, ln δ) 的分段线性插值 —— 与模拟器自己的
        读数一致。**注意：它只在可测区间内有效**，不能外推到 2^-40。
      * loglinear：假设 ln δ 随 h 线性增长。可用于粗略外推，但对 EES439 这种
        重尾情形会明显失真，别当结论用。
      * saddlepoint：由本模块的鞍点模型处理（见 `analyze()`），这里不实现 —— 传入
        本函数时按 interp 处理，避免误用。

    返回 nan 表示目标超出 MC 可测区间（此时必须上尾部模型）。
    """
    hs = sorted(h for h, d in curve.items() if d > 0.0)
    if len(hs) < 2:
        return float("nan")
    xs = [h for h in hs]
    ys = [math.log(curve[h]) for h in hs]
    tgt = math.log(target_delta)

    if model == "interp":
        # δ 随 h 单调递增，所以：目标比最大可测 δ 还大 -> 取最大可测跳数；
        # 目标比最小可测 δ 还小 -> 超出可测区间，必须上尾部模型
        if target_delta >= curve[hs[-1]]:
            return float(hs[-1])
        if target_delta <= curve[hs[0]]:
            return float("nan")
        for i in range(len(xs) - 1):
            y0, y1 = ys[i], ys[i + 1]
            if y0 <= tgt <= y1:
                if y1 == y0:
                    return float(xs[i])
                t = (tgt - y0) / (y1 - y0)
                return xs[i] + t * (xs[i + 1] - xs[i])
        return float("nan")

    # loglinear：只用尾部点（δ 已经明显上升）做拟合
    tail = [h for h in hs if curve[h] > 1e-3] or hs[-3:]
    fx = [h for h in tail]
    fy = [math.log(curve[h]) for h in tail]
    mx = sum(fx) / len(fx)
    my = sum(fy) / len(fy)
    num = sum((x - mx) * (y - my) for x, y in zip(fx, fy))
    den = sum((x - mx) ** 2 for x in fx)
    if den == 0:
        return float("nan")
    b = num / den
    a = my - b * mx
    if b <= 0:
        return float("nan")
    return (tgt - a) / b if model == "loglinear" else float("nan")


def report(curves: dict, target: float, model: str) -> None:
    """老路径的报告（读外部表时用），保持原有输出"""
    print(f"=== 失败概率预算：目标 δ = {target:.1e}（模型：{model}）===")
    print(f"{'参数集':<9}{'MC 测到的最大 h':<18}{'h_max(δ)':<14}{'论文经验跳数':<14}{'备注'}")
    for k, cfg in EES.items():
        c = curves.get(k) or {}
        if not c:
            continue
        hs = sorted(h for h, d in c.items() if d > 0)
        hmax = tail_extrapolate(c, target, model)
        note = "在 MC 可测区间内" if not math.isnan(hmax) else "超出 MC 区间，需要鞍点/大偏差尾部模型"
        shown = f"{hmax:.1f}" if not math.isnan(hmax) else "—"
        print(f"{k:<9}{hs[-1]:<18}{shown:<14}{cfg.paper_hops:<14}{note}")


# ---------------------------------------------------------------------------
# 自包含路径：跑 MC → 建鞍点模型 → 标定 → 反解预算
# ---------------------------------------------------------------------------
def calibrate(model: hop_sim.TailModel, P: RingParams, stats,
              min_events: int = 30) -> tuple[float, float, int]:
    """在可测区间对 log δ 最小二乘拟一个乘性常数，并报跨 decade 的最大残差。

    **按事件数加权**：δ̂ 在 log 空间的方差约为 (1−δ)/(N·δ)，所以权重取
    `failures/(1−δ)`。不做这件事的话，只有 5 个事件的点（δ 本身有 ~45% 相对误差）
    会把残差、进而把标定常数带偏 —— 实测 EES1087 的残差从 0.25 decade 降到 0.01。
    同时丢掉 events < min_events 的点（它们不携带有效信息）。

    残差若随 h **系统性漂移**，说明模型形状不对，必须当 blocker
    （见 docs 的 §7.2 风险 2），不能硬拟合。
    """
    logs, wts = [], []
    for st in stats[1:]:
        if st.failures < min_events:
            continue
        md = model.delta(st.h, P)
        if md is None or md <= 0:
            continue
        logs.append(math.log(st.delta) - math.log(md))
        wts.append(st.failures / max(1e-9, 1.0 - st.delta))
    if len(logs) < 3:
        return 1.0, float("nan"), len(logs), float("nan")
    sw = sum(wts)
    lc = sum(x * w for x, w in zip(logs, wts)) / sw
    ln10 = math.log(10.0)
    resid = max(abs(x - lc) / ln10 for x in logs)
    # 漂移：标定区内 log10(δ_MC/δ_模型) 的极差。它才是**外推不确定度的主项** ——
    # 残差小只说明模型形状在可测区内对得上；如果这个比值随 h 单调漂移，
    # 说明并集界 δ≈n·p1 的紧度随 h 在变（h 大时系数趋于独立、界收紧），
    # 外推到更小的 h 时这个偏差会继续走。必须报出来，不能靠拟合抹平。
    drift = (max(logs) - min(logs)) / ln10
    return math.exp(lc), resid, len(logs), drift


def predict(model, P: RingParams, calib: float, h: int):
    """标定后的 δ(h)；模型解不出来返回 None"""
    v = model.delta(h, P)
    if v is None:
        return None
    return min(1.0, v * calib)


def choose_max_hops(P: RingParams, args, cap: int = 80, stop_delta: float = 0.99) -> int:
    """先用小样本探一次，找到 δ 饱和的位置，避免在"全失败"区白跑。

    δ(h) 单调增；EES439 在 h=15 就已经 100% 失败，跑到 80 纯属浪费。
    探针用 1500 样本（只需要知道"哪里饱和"，不需要精确的 δ），比正式跑便宜一个量级。

    cap 必须够大：**EES1499 在 h=40 时 δ 才 1.86%**，论文的 50 跳锚点还没够着。
    cap 只影响探针的固定开销（cap × 1500 跳），正式跑的跳数由饱和点决定。
    """
    pilot = min(1500, args.samples)
    stats, _ = hop_sim.simulate_curve(P, cap, pilot, batch=args.batch, m=args.m,
                                      seed=args.seed + 7, backend=args.backend, cgf_sub=0)
    last = 1
    for st in stats[1:]:
        last = st.h
        if st.delta >= stop_delta:
            break
    return min(cap, last + 1)


def analyze(P: RingParams, args, C0=None) -> dict:
    """跑一个 (参数集, m) 配置。

    `C0` 只依赖参数集（不依赖 m），所以由调用方算一次后传进来复用 ——
    20 万样本的 C0 估计在 n=1499 上要 20+ 秒，每个 m 重算是纯浪费。
    """
    max_hops = args.max_hops if args.max_hops > 0 else choose_max_hops(P, args)
    stats, _ = hop_sim.simulate_curve(
        P, max_hops, args.samples, batch=args.batch, m=args.m,
        seed=args.seed, backend=args.backend, cgf_sub=0)
    if C0 is None:
        C0 = hop_sim.sample_common_part(P, args.cgf_samples, seed=args.seed + 101,
                                        backend=args.backend)
    W = hop_sim.sample_increment(P, args.cgf_samples, m=args.m, seed=args.seed + 202,
                                 backend=args.backend)
    model = hop_sim.TailModel(C0, W, ess_min=args.ess_min)
    calib, resid, npts, drift = calibrate(model, P, stats, min_events=args.calib_min_events)
    # 不回传 C0/W 这些大数组（进程池走 IPC，传了大数组会白白复制几 MB）
    return dict(P=P, stats=stats, model=model, calib=calib, resid=resid, npts=npts,
                drift=drift, max_hops=max_hops)


# ---------------------------------------------------------------------------
# 进程池：配置之间彼此独立，32 核的机器没理由串行跑
# ---------------------------------------------------------------------------
def _worker_common(backend: str, pname: str, cgf_samples: int, seed: int):
    """Phase A：算某个参数集的 C0（可被该参数集的所有 m 复用）"""
    return hop_sim.sample_common_part(EES[pname], cgf_samples, seed=seed + 101,
                                      backend=backend)


def _worker_job(spec: dict, C0):
    """Phase B：跑单个 (参数集, m) 配置"""
    args = argparse.Namespace(**spec["args"])
    args.m = spec["m"]
    P = EES[spec["params"]]
    res = analyze(P, args, C0=C0)
    res["m"] = spec["m"]
    return res


# ---------------------------------------------------------------------------
# CGF 样本数敏感性：深尾外推的主要不确定度来源
# ---------------------------------------------------------------------------
def cgf_sweep(P: RingParams, args, sizes) -> int:
    """固定住 MC 曲线，只改 CGF 样本数，看深尾数字怎么动。

    这是 `docs/C2_实现进度.md` §5 那条结论（"20 万以上收敛"）的**可复现来源** ——
    δ(1) 完全靠经验 CGF 的二次延拓，延拓的锚点 t_max 受样本量限制；
    如果换样本数结果就大幅漂移，那么报出来的 h_max 就没有意义。
    """
    print(f"=== CGF 样本数敏感性（{P.name}，MC 曲线固定 seed={args.seed}）===")
    max_hops = args.max_hops if args.max_hops > 0 else choose_max_hops(P, args)
    stats, _ = hop_sim.simulate_curve(P, max_hops, args.samples, batch=args.batch,
                                      m=args.m, seed=args.seed, backend=args.backend,
                                      cgf_sub=0)
    d_model = {}
    print(f"{'CGF 样本数':>12}{'t_max':>9}{'δ(1)':>11}{'δ(2)':>11}{'δ(3)':>11}"
          f"{'h_max(2^-40)':>14}{'h_max(1e-6)':>13}")
    for n in sizes:
        C0 = hop_sim.sample_common_part(P, n, seed=args.seed + 101, backend=args.backend)
        W = hop_sim.sample_increment(P, n, m=args.m, seed=args.seed + 202,
                                     backend=args.backend)
        model = hop_sim.TailModel(C0, W, ess_min=args.ess_min)
        calib, _, _, _ = calibrate(model, P, stats, min_events=args.calib_min_events)
        pred = lambda h: predict(model, P, calib, h)      # noqa: E731
        d_model[n] = pred
        fmt = lambda h: (f"{pred(h):.2g}" if pred(h) is not None else "—")  # noqa: E731
        print(f"{n:>12}{model.t_max:>9.4f}{fmt(1):>11}{fmt(2):>11}{fmt(3):>11}"
              f"{hop_sim.invert_hop_budget(pred, 2.0 ** -40):>14}"
              f"{hop_sim.invert_hop_budget(pred, 1e-6):>13}", flush=True)

    # 相邻样本数之间，h_max 是否已经不再变
    hs = [hop_sim.invert_hop_budget(d_model[n], 2.0 ** -40) for n in sizes]
    print(f"\n  h_max(2^-40) 随样本数的轨迹：{dict(zip(sizes, hs))}")
    if len(set(hs[-2:])) == 1:
        print("  → 最后两档一致，认为已收敛；报告里应把这个样本数写进口径。")
    else:
        print("  ⚠️ 最后两档仍在变，深尾数字不可用 —— 请加大 --cgf-samples 再试。")
    return 0


def parse_target(text: str) -> float:
    """支持 2^-40 / 1e-6 / 0.01 这类写法"""
    t = text.strip()
    m = re.fullmatch(r"2\s*\^\s*(-?\d+)", t)
    if m:
        return 2.0 ** int(m.group(1))
    return float(t)


def print_curve(res: dict) -> None:
    P, stats, model, calib = res["P"], res["stats"], res["model"], res["calib"]
    print(f"\n=== {P.name}  n={P.ring_n}  m={res.get('m', 1)}  "
          f"t_max={model.t_max:.4f}  h≤{res.get('max_hops', '?')}  calib={calib:.3f} ===")
    print(f"    CGF 可靠区上限 t_max={model.t_max:.4f}；标定用 {res['npts']} 点，"
          f"最大残差 {res['resid']:.3f} decade，漂移 {res['drift']:.3f} decade")
    if res["drift"] > 0.05:
        print(f"    ⚠️ 标定区内有 {res['drift']:.2f} decade 的**系统性漂移**（δ_MC/δ_模型 随 h 变），"
              f"外推到更小 h 的数值应加这一量级的不确定度")
    print(f"{'h':>3}{'failures':>10}{'δ(MC)':>12}{'95% CI':>22}{'δ(模型)':>12}{'比值':>8}{'外推':>6}")
    for st in stats[1:]:
        md = model.delta(st.h, P)
        if st.delta > 0 and md:
            ratio = f"{md / st.delta:.3f}"
        else:
            ratio = "—"
        ci = f"[{st.ci_lo:.2g}, {st.ci_hi:.2g}]"
        mds = f"{md:.3g}" if md else "—"
        print(f"{st.h:>3}{st.failures:>10}{st.delta:>12.4g}{ci:>22}{mds:>12}"
              f"{ratio:>8}{'是' if model.last_extrapolated else '否':>6}")
    if stats[-1] and stats[-1].delta < 0.5:
        print(f"  ⚠️ 最大跳数 {stats[-1].h} 处 δ={stats[-1].delta:.3g} < 0.5，曲线可能还没走完"
              f" —— 想看得更全请加 --max-hops")


def print_budget(res: dict, targets) -> None:
    P, model, calib = res["P"], res["model"], res["calib"]
    print(f"\n--- {P.name} 的跳数预算（论文经验跳数 = {P.paper_hops or '—'}）---")
    print(f"{'目标 δ':>12}{'h_max(鞍点模型)':>18}{'h_max(MC 插值)':>18}")
    curve = {st.h: st.delta for st in res["stats"][1:] if st.delta > 0}
    d1 = predict(model, P, calib, 1)
    for tgt in targets:
        hm = hop_sim.invert_hop_budget(lambda h: predict(model, P, calib, h), tgt)
        hmi = tail_extrapolate(curve, tgt, "interp")
        shown = f"{hmi:.1f}" if not math.isnan(hmi) else "—（超可测区）"
        note = ""
        if hm == 0 and d1 is not None:
            note = f"   ← 连 1 跳都超预算（δ(1)≈{d1:.2g}）"
        print(f"{tgt:>12.2g}{hm:>18}{shown:>18}{note}")
    if d1 is not None:
        print(f"  参考：模型外推的 1 跳失败率 δ(1) ≈ {d1:.2g}，2 跳 ≈ "
              f"{(predict(model, P, calib, 2) or float('nan')):.2g}"
              f"（都低于 MC 可直接测量的下限，纯靠鞍点外推）")


# ---------------------------------------------------------------------------
# CSV 输出（口径纪律：每行都带参数集+环维数+后端+样本数+种子+CI+m）
# ---------------------------------------------------------------------------
def write_csv(path: str, header: list, rows: list,
              key_cols: list | None = None, append: bool = False) -> None:
    """写 CSV。`append=True` 时按 `key_cols` 合并：同 key 的旧行被新行替换，其余保留。

    这样"只重跑一个参数集"不会把别的参数集的结果冲掉（否则每次改点东西就得全量重跑）。
    """
    if not rows:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    n_new = len(rows)
    if append and key_cols and os.path.exists(path):
        with open(path, "r", encoding="utf-8", newline="") as f:
            old = list(csv.reader(f))
        if old and old[0] == header:
            idx = [header.index(c) for c in key_cols]
            newkeys = {tuple(str(r[i]) for i in idx) for r in rows}
            kept = [r for r in old[1:] if tuple(str(r[i]) for i in idx) not in newkeys]
            rows = kept + [list(map(str, r)) for r in rows]
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in rows:
            w.writerow(r)
    print(f"  已写入 {os.path.relpath(path, REPO_ROOT)}（本次 {n_new} 行，"
          f"文件共 {len(rows)} 行）")


def curve_rows(res: dict, args) -> list:
    P = res["P"]
    rows = []
    for st in res["stats"][1:]:
        md = res["model"].delta(st.h, P)
        rows.append([P.name, P.ring_n, args.backend, args.seed, args.samples,
                     args.m, "mc", st.h, st.samples, st.failures,
                     f"{st.delta:.6g}", f"{st.ci_lo:.6g}", f"{st.ci_hi:.6g}",
                     f"{(md if md else float('nan')):.6g}",
                     res["model"].last_extrapolated])
    return rows


def budget_rows(res: dict, args, targets) -> list:
    P, model, calib = res["P"], res["model"], res["calib"]
    curve = {st.h: st.delta for st in res["stats"][1:] if st.delta > 0}
    rows = []
    for tgt in targets:
        hm = hop_sim.invert_hop_budget(lambda h: predict(model, P, calib, h), tgt)
        hmi = tail_extrapolate(curve, tgt, "interp")
        rows.append([P.name, P.ring_n, args.m, args.backend, args.samples, args.seed,
                     "saddlepoint", f"{tgt:.3g}", hm,
                     "" if math.isnan(hmi) else f"{hmi:.1f}", f"{calib:.4f}",
                     (f"{res['resid']:.3f}" if res["npts"] >= 3 else ""),
                     (f"{res['drift']:.3f}" if res["npts"] >= 3 else ""),
                     P.paper_hops, "自包含:hop_sim"])
    return rows


# ---------------------------------------------------------------------------
# 门限（C1）联合选参表
# ---------------------------------------------------------------------------
# m = C(N, t−1) 是门限化后每跳多出的噪声份数。注意 C++ 骨架限制 N ≤ 20
# （src/core/threshold.cpp:30）。几个常见的代理配置对应的 m：
#   (3,2)→3  (4,2)→4  (5,2)→5  (5,3)→10  (6,3)→15  (7,4)→35  (8,4)→56  (10,5)→210
DEFAULT_M_LIST = "1,3,5,10,15"


def main() -> int:
    ap = argparse.ArgumentParser(description="多跳失败概率预算（C2，自包含）")
    ap.add_argument("--input", default=None,
                    help="（可选）外部模拟器输出；给了就只做老路径的插值报告")
    ap.add_argument("--target", type=parse_target, default=2.0 ** -40,
                    help="目标失败概率，支持 2^-40 / 1e-6（默认 2^-40）")
    ap.add_argument("--model", choices=["interp", "loglinear", "saddlepoint", "auto"],
                    default="auto", help="尾部模型（auto = 有 MC 就用鞍点）")
    ap.add_argument("--params", default="EES439,EES1087,EES1171,EES1499",
                    help="逗号分隔；可选 " + " / ".join(EES))
    ap.add_argument("--samples", type=int, default=40000, help="每条曲线的链数")
    ap.add_argument("--cgf-samples", type=int, default=200000,
                    help="估计经验 CGF 的样本数（**不要往下调**：实测 5 万不够、20 万以上才收敛）")
    ap.add_argument("--ess-min", type=float, default=500.0, help="CGF 可靠区间的 ESS 下限")
    ap.add_argument("--max-hops", type=int, default=0,
                    help="0 = 自动（先小样本探到 δ 饱和处）")
    ap.add_argument("--calib-min-events", type=int, default=30,
                    help="参与标定的点至少要有的失败事件数")
    ap.add_argument("--m", type=int, default=1, help="C1 噪声份数 m = C(N,t-1)，默认 1（基线）")
    ap.add_argument("--backend", default="fft", choices=["fft", "exact", "cupy", "auto"])
    ap.add_argument("--batch", type=int, default=None)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--jobs", type=int, default=8,
                    help="并行进程数（配置之间彼此独立）。内存吃紧就调小；1 = 串行")
    ap.add_argument("--targets", default="1e-3,1e-6,2^-20,2^-40",
                    help="预算表里要反解的若干个目标 δ")
    ap.add_argument("--m-list", default=None,
                    help="逗号分隔的噪声份数 m，跑门限（C1）对照表，如 1,3,5,10,15")
    ap.add_argument("--joint", action="store_true",
                    help="等价于 --m-list 1,3,5,10,15（只挑有代表性的配置，全网格要跑 70+ 次）")
    ap.add_argument("--proxy", default="", help="只跑单个门限配置，如 5:3 表示 N=5,t=3")
    ap.add_argument("--cgf-sweep", default=None,
                    help="逗号分隔的 CGF 样本数，跑收敛性检查，如 50000,200000,800000")
    ap.add_argument("--append", action="store_true",
                    help="按 (params,m[,target]) 合并进已有 CSV，而不是整表覆盖 —— 只重跑一部分时用")
    ap.add_argument("--no-write", action="store_true", help="不写 bench/results/*.csv")
    args = ap.parse_args()
    targets = [parse_target(t) for t in args.targets.split(",") if t.strip()]

    # 后端先探一次：CuPy 缺失时给一句人话，而不是让它在 worker 里抛栈
    try:
        hop_sim.get_backend(args.backend)
    except (RuntimeError, ValueError) as e:
        print(f"后端 {args.backend} 不可用：{e}")
        return 2

    # ---- 老路径：读外部表（向后兼容） ----
    if args.input:
        if not os.path.exists(args.input):
            print(f"找不到模拟器输出 {args.input}\n"
                  f"提示：不给 --input 时本脚本会**自己生成曲线**（自包含）。")
            return 2
        print(f"读取 {args.input}")
        report(parse_simulator_output(args.input), args.target, args.model)
        return 0

    # ---- 自包含路径 ----
    names = [s.strip() for s in args.params.split(",") if s.strip()]
    for nm in names:
        if nm not in EES:
            print(f"未知参数集 {nm}（可选 {' / '.join(EES)}）")
            return 2

    # ---- 收敛性检查：只改 CGF 样本数，MC 曲线不动 ----
    if args.cgf_sweep:
        sizes = [int(x) for x in args.cgf_sweep.split(",")]
        rc = 0
        for nm in names:
            rc |= cgf_sweep(EES[nm], args, sizes)
        return rc

    # 组装任务：(参数集名, m, 标签)
    threshold_mode = bool(args.proxy or args.m_list or args.joint)
    if args.proxy:
        N, t = (int(x) for x in args.proxy.replace(":", ",").split(","))
        job_specs = [(nm, math.comb(N, t - 1), f"N={N},t={t}") for nm in names]
    elif args.m_list or args.joint:
        mlist = [int(x) for x in (args.m_list or DEFAULT_M_LIST).split(",")]
        job_specs = [(nm, m, f"m={m}") for nm in names for m in mlist]
    else:
        job_specs = [(nm, args.m, "baseline")]

    base_args = dict(vars(args))
    specs = [dict(params=nm, m=m, tag=tag, args=base_args) for nm, m, tag in job_specs]
    uniq_params = sorted({nm for nm, _, _ in job_specs})
    njobs = max(1, min(args.jobs, len(specs)))

    # C0 只依赖参数集 -> 每个参数集算一次，供它的所有 m 复用
    print(f"共 {len(specs)} 个配置，{len(uniq_params)} 个参数集，并行度 {njobs}", flush=True)
    if njobs == 1:
        c0s = {}
        for nm in uniq_params:
            c0s[nm] = _worker_common(args.backend, nm, args.cgf_samples, args.seed)
            print(f"  C0 就绪：{nm}", flush=True)
        results = []
        for i, s in enumerate(specs, 1):
            print(f"  [{i}/{len(specs)}] 跑 {s['params']} {s['tag']} ...", flush=True)
            results.append(_worker_job(s, c0s[s["params"]]))
    else:
        from concurrent.futures import ProcessPoolExecutor
        results = []
        with ProcessPoolExecutor(max_workers=njobs) as ex:
            futs = {nm: ex.submit(_worker_common, args.backend, nm,
                                  args.cgf_samples, args.seed) for nm in uniq_params}
            c0s = {nm: f.result() for nm, f in futs.items()}
            print(f"  C0 就绪（{len(uniq_params)} 个参数集）", flush=True)
            job_futs = [ex.submit(_worker_job, s, c0s[s["params"]]) for s in specs]
            for i, (s, f) in enumerate(zip(specs, job_futs), 1):
                results.append(f.result())
                print(f"  [{i}/{len(specs)}] {s['params']} {s['tag']} 完成", flush=True)

    all_curve, all_budget, all_joint = [], [], []
    base_hmax = {}
    for (nm, m, tag), res in zip(job_specs, results):
        P = res["P"]
        args.m = m                      # curve_rows / budget_rows 会读 args.m
        print(f"\n########## {P.name} {tag} ##########")
        print_curve(res)
        print_budget(res, targets)
        all_curve += curve_rows(res, args)
        rows = budget_rows(res, args, targets)
        if m == 1:
            base_hmax[P.name] = {r[7]: r[8] for r in rows}   # target_delta -> h_max
            all_budget += rows
            if threshold_mode:                 # 基线也进对照表，表格才自洽
                for r in rows:
                    all_joint.append([P.name, P.ring_n, 1, r[6], r[7], r[8], 0,
                                      r[9], r[10], r[11], r[12], "baseline(m=1)"])
        else:
            for r in rows:
                b = base_hmax.get(P.name, {}).get(r[7])
                all_joint.append([P.name, P.ring_n, m, r[6], r[7], r[8],
                                  (b - r[8]) if b is not None else "",
                                  r[9], r[10], r[11], r[12], tag])

    if all_joint:
        print("\n=== 门限（C1）对照表：噪声份数 m → 可用跳数 ===")
        print(f"{'参数集':>9}{'m':>6}{'目标 δ':>11}{'h_max':>8}{'比基线少':>11}{'备注':>14}")
        for r in all_joint:
            print(f"{r[0]:>9}{r[2]:>6}{r[4]:>11}{r[5]:>8}{str(r[6]):>11}{r[11]:>14}")
        print("  读法：m = C(N,t−1) 是门限化后每跳多出的噪声份数；"
              "'比基线少'就是提高腐化阈值要付的跳数代价。")

    if not args.no_write:
        print("\n=== 结果落盘 ===")
        write_csv(os.path.join(RESULT_DIR, "c2_mc_curve.csv"),
                  ["params", "ring_n", "backend", "seed", "samples", "m", "method", "h",
                   "samples_h", "failures", "delta_mc", "ci_lo", "ci_hi", "delta_model",
                   "extrapolated"], all_curve,
                  key_cols=["params", "m"], append=args.append)
        write_csv(os.path.join(RESULT_DIR, "c2_budget.csv"),
                  ["params", "ring_n", "m", "backend", "samples", "seed", "model",
                   "target_delta", "h_max_saddle", "h_max_mc_interp", "calib_const",
                   "max_resid_decades", "drift_decades", "paper_hops", "note"], all_budget,
                  key_cols=["params", "m", "target_delta"], append=args.append)
        if all_joint:
            write_csv(os.path.join(RESULT_DIR, "c2_threshold.csv"),
                      ["params", "ring_n", "m", "model", "target_delta", "h_max",
                       "hops_lost_vs_baseline", "h_max_mc_interp", "calib_const",
                       "max_resid_decades", "drift_decades", "note"], all_joint,
                      key_cols=["params", "m", "target_delta"], append=args.append)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
