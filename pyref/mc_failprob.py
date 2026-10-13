"""
C2：多跳失败概率预算（骨架）
============================
文件：pyref/mc_failprob.py

定位：把"经验最大跳数"升级为"给定失败概率 δ 的预算"，并反解 h_max(δ, 参数)。

三块工作：
  1) 标定：大样本蒙特卡洛（复用你已有的 CuPy 模拟器
     A1-4_选题方案/multihop_failprob_gpu.py，它已跑出 180k 链·跳/秒）
  2) 外推：纯 MC 到不了 2^-40，需要尾部模型（大偏差/鞍点近似）+ MC 标定
  3) 反解：h_max(δ) 与"门限噪声放大倍率 → 可用跳数下降"的联合曲线

本文件只实现"从曲线到预算"的部分（已经可用），大样本 MC 仍走你原来的 GPU 脚本。
"""

from __future__ import annotations

import argparse
import math
import os
import re
from dataclasses import dataclass


@dataclass
class Config:
    name: str
    n: int
    q: int
    df: int
    dg: int
    paper_hops: int


EES = {
    "EES439": Config("EES439", 439, 2048, 146, 130, 5),
    "EES1087": Config("EES1087", 1087, 2048, 120, 362, 21),
    "EES1171": Config("EES1171", 1171, 2048, 106, 390, 21),
    "EES1499": Config("EES1499", 1499, 2048, 79, 499, 50),
}


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


def tail_extrapolate(curve: dict[int, float], target_delta: float,
                     model: str = "interp") -> float:
    """
    由 MC 测得的 δ(h) 反解达到 target_delta 的跳数。

    模型（**这一块是 C2 需要你自己论证的部分**）：
      * interp（默认）：在可测区间内做 (h, ln δ) 的分段线性插值 —— 与模拟器自己的
        读数一致（例：EES1171 在 δ=1e-2 处给 14，与 multihop_output.txt 的
        "h(δ≤0.01)" 列一致）。**注意：它只在可测区间内有效**，不能外推到 2^-40。
      * loglinear：假设 ln δ 随 h 线性增长。可用于粗略外推，但对 EES439 这种
        重尾情形会明显失真，别当结论用。
      * saddlepoint（TODO）：对 T_h 的系数分布做鞍点近似/大偏差速率函数，
        再用 MC 在可测区间标定常数 —— 这是能得到 2^-40 量级预算的正确工具。

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


def main() -> int:
    ap = argparse.ArgumentParser(description="多跳失败概率预算（骨架）")
    ap.add_argument("--input", default=None,
                    help="已有的模拟器输出（默认找 ../../A1-4_选题方案/multihop_output.txt）")
    ap.add_argument("--target", type=float, default=2 ** -40,
                    help="目标失败概率（默认 2^-40）")
    ap.add_argument("--model", choices=["interp", "loglinear"], default="interp")
    args = ap.parse_args()

    path = args.input
    if path is None:
        here = os.path.dirname(os.path.abspath(__file__))
        cand = os.path.join(here, "..", "..", "A1-4_选题方案", "multihop_output.txt")
        path = os.path.normpath(cand)
    if not os.path.exists(path):
        print(f"找不到模拟器输出 {path}\n"
              f"请先跑：python A1-4_选题方案/multihop_failprob_gpu.py（WSL + CuPy）")
        return 2

    print(f"读取 {path}")
    curves = parse_simulator_output(path)
    report(curves, args.target, args.model)
    print("\n对照：模拟器自己在 multihop_output.txt 里给出的 h(δ≤1e-2) 为 "
          "EES439=5 / EES1087=11 / EES1171=14 / EES1499=26")
    print("\nTODO(C2)：")
    print("  1) 把 MC 样本量提到 1e8~1e9（GPU），把 δ 量测到 1e-6")
    print("  2) 实现鞍点/大偏差速率函数并在可测区间用 MC 标定，替换 interp 做外推")
    print("  3) 把门限化的噪声放大（C1，子集数 C(n,t-1)）计入预算，输出联合选参表")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
