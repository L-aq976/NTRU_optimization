"""
C3 的三项工程化验证
====================
文件：pyref/threshold_gpu_check.py

验证三件事，全部用 **C++ 侧导出的真实份额**（`ntru_cli shares`），不自己造假数据：

  A. 常驻 device buffer 路径（`cyc_conv_buffered`）与普通路径**逐位一致**
  B. 多流流水线路径（`cyc_conv_pipelined`）与普通路径**逐位一致**
     （本机无 CuPy 时退化为顺序执行，验证的是"退化后仍等价"）
  C. 真实份额分发 → GPU 批量部分重加密 → 组合 → 解密，端到端能还原明文；
     并且代理 0 的每份 partial 与 C++ 的 `REFP` **逐位相等**

C 是核心：它把 C1 的份额结构和 C3 的批量算子真正接了起来。
旧接口 `threshold_partial_reencrypt` 只吃"单份份额 + 一批密文"，
而真实流程是"N 个代理 × 每个代理多份份额 × 一批密文"。

用法：
    python pyref/threshold_gpu_check.py --params TINY7 --N 3 --t 2
    python pyref/threshold_gpu_check.py --params EES439 --N 5 --t 3 --batch 64
    python pyref/threshold_gpu_check.py --file bin/shares_EES439_1_5_3.txt

后端：有 CuPy 且 `--backend cupy` 时走 GPU；否则 NumPy（结果必须逐位一致）。
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ring_np import poly_center, poly_from_list  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# ---------------------------------------------------------------------------
def parse_shares(path: str) -> dict:
    """解析 `ntru_cli shares` 导出文件。"""
    d = {"share": [], "refe": {}, "refp": {}}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k == "PARAMS":
                d[k] = v
            elif k in ("SEED", "N", "Q", "P", "NT", "T", "NSUB"):
                d[k] = int(v)
            elif k == "SHARE":
                i, mask, poly = v.split(",", 2)
                d["share"].append((int(i), int(mask),
                                   poly_from_list(poly.split(","))))
            elif k in ("REFE", "REFP"):
                idx, poly = v.split(",", 1)
                d[k.lower()][int(idx)] = poly_from_list(poly.split(","))
            else:
                d[k] = poly_from_list(v.split(","))
    return d


def build_per_proxy(v: dict) -> list:
    """把平坦的 (代理号, 子集, 份额) 列表还原成 per_proxy[i] 结构。"""
    n_proxy = v["NT"]
    buckets = [[] for _ in range(n_proxy)]
    for i, _mask, val in v["share"]:
        buckets[i].append(val)
    return buckets


def combine_parts(per_proxy, partials, W, q: int) -> tuple:
    """按 C++ threshold_combine 的规则组合：对每个子集 S 取 owner = min(S ∩ W)。

    返回 (求和结果 或 None, 缺失子集数)。None 表示存在与 W 不相交的子集
    （t-1 个代理的情形），此时组合必然失败。
    """
    masks = [[] for _ in per_proxy]
    seen = {}
    for i, mask, _val in _SHARE_CACHE:
        seen.setdefault(mask, set()).add(i)
        masks[i].append(mask)

    total = np.zeros(per_proxy[0][0].shape if per_proxy and per_proxy[0] else (0,),
                     dtype=np.int64)
    missing = 0
    for S in sorted(seen):
        owners = sorted(p for p in seen[S] if p in W)
        if not owners:
            missing += 1
            continue
        owner = owners[0]
        idx = _index_of(per_proxy, owner, S)
        total = (total + partials[owner][idx]) % q
    return (None if missing else total), missing


def _index_of(per_proxy, proxy: int, mask: int) -> int:
    """代理 proxy 持有 mask 这份份额的序号。"""
    for k, (_i, m, _v) in enumerate(_SHARE_FLAT):
        if _i == proxy and m == mask:
            return _flat_index(proxy, mask)
    raise KeyError(f"代理 {proxy} 没有子集 {mask} 的份额")


def _flat_index(proxy: int, mask: int) -> int:
    cnt = 0
    for i, m, _v in _SHARE_FLAT:
        if i == proxy:
            if m == mask:
                return cnt
            cnt += 1
    raise KeyError(f"代理 {proxy} 没有子集 {mask} 的份额")


_SHARE_FLAT = []
_SHARE_CACHE = []


def decrypt_poly(f, C, q: int, p: int) -> np.ndarray:
    """center(f·C) mod p，映射到 {-1,0,1}。支持 C 为 (n,) 或 (batch, n)。"""
    from ring_np import poly_mul_cyclic_fast
    f = np.asarray(f, dtype=np.int64) % q
    C = np.atleast_2d(np.asarray(C, dtype=np.int64) % q)
    prod = np.stack([poly_mul_cyclic_fast(f, row, q) for row in C])
    c = poly_center(prod, q) % p
    return np.where(c > p // 2, c - p, c)


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="C3 三项工程化验证（真实份额）")
    ap.add_argument("--params", default="TINY7")
    ap.add_argument("--N", type=int, default=3, help="代理数")
    ap.add_argument("--t", type=int, default=2, help="门限")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--batch", type=int, default=8, help="每份份额上的密文条数")
    ap.add_argument("--file", default=None, help="直接给 shares 文件")
    ap.add_argument("--backend", choices=["auto", "cupy", "numpy"], default="auto")
    ap.add_argument("--streams", type=int, default=4)
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = args.file
    if path is None:
        cli = None
        for c in ("bin/ntru_cli.exe", "bin/ntru_cli"):
            if os.path.exists(os.path.join(root, c)):
                cli = os.path.join(root, c)
                break
        if cli is None:
            print("找不到 bin/ntru_cli(.exe)，请先构建")
            return 2
        path = os.path.join(root, "bin", f"shares_{args.params}_{args.seed}_{args.N}_{args.t}.txt")
        r = subprocess.run([cli, "shares", args.params, str(args.seed),
                            str(args.N), str(args.t), path],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            print(r.stdout, r.stderr)
            return 1

    v = parse_shares(path)
    n, q, p = v["N"], v["Q"], v["P"]
    per_proxy = build_per_proxy(v)
    global _SHARE_FLAT, _SHARE_CACHE
    _SHARE_FLAT = v["share"]
    _SHARE_CACHE = v["share"]

    import gpu_kernel as gk
    if args.backend == "numpy":
        gk.HAS_CUPY = False
    eng = gk.GPUBatchEngine(n, q=q, variant="i32twoseg")
    backend = "cupy" if eng.kernel is not None else "numpy"

    print("=" * 78)
    print(f" C3 工程化验证 —— {v.get('PARAMS', '?')}  n={n} q={q} p={p}  "
          f"代理数 N={v['NT']} 门限 t={v['T']}  子集数={v['NSUB']}")
    print(f" 后端={backend}  每份份额上的密文条数 batch={args.batch}")
    print("=" * 78)

    # ---------- A：常驻 buffer vs 普通路径 ----------
    rng = np.random.default_rng(12345)
    A = rng.integers(0, q, size=(args.batch, n), dtype=np.int64)
    B = rng.integers(0, q, size=(args.batch, n), dtype=np.int64)
    base = eng.cyc_conv(A, B)
    buffered = eng.cyc_conv_buffered(A, B)
    ok_a = np.array_equal(base, buffered)
    print(f"  [A] 常驻 buffer 路径 == 普通路径：{'PASS' if ok_a else 'FAIL'}"
          f"  ({np.count_nonzero(base != buffered)} 处差异)")

    # ---------- B：多流流水线 ----------
    piped = eng.cyc_conv_pipelined(A, B, n_streams=args.streams)
    ok_b = np.array_equal(base, piped)
    note = "" if backend == "cupy" else "（无 CuPy，已退化为顺序执行）"
    print(f"  [B] 多流流水线 == 普通路径：{'PASS' if ok_b else 'FAIL'}"
          f"  ({np.count_nonzero(base != piped)} 处差异){note}")

    # ---------- C：真实份额 → 批量 partial → 组合 → 解密 ----------
    ca = np.asarray(v["CA"], dtype=np.int64) % q
    cA_batch = np.tile(ca, (args.batch, 1))
    per_proxy_arr = [[np.asarray(sh, dtype=np.int64) % q for sh in bucket]
                     for bucket in per_proxy]

    # C-1：代理 0 用 C++ 导出的噪声 e 重算 partial，与 REFP 逐位对拍
    ref_e = [np.asarray(v["refe"][k], dtype=np.int64) for k in sorted(v["refe"])]
    ref_p = [np.asarray(v["refp"][k], dtype=np.int64) for k in sorted(v["refp"])]
    got = eng.threshold_partial_reencrypt_shares(
        cA_batch, [per_proxy_arr[0]], p=p, noises=[ref_e])[0]
    diffs = []
    for k, (g, r) in enumerate(zip(got, ref_p)):
        g0 = g[0] % q
        r0 = np.asarray(r, dtype=np.int64) % q
        diffs.append(int(np.max(np.abs(center_diff(g0, r0, q)))))
    ok_c1 = all(d == 0 for d in diffs)
    print(f"  [C-1] GPU 批量 partial vs C++ 参考 partial：{'PASS' if ok_c1 else 'FAIL'}"
          f"  （逐份最大差 {diffs}）")

    # C-2：全部代理、全部份额一起算（这就是"接到真实份额分发流程"）
    all_partials = eng.threshold_partial_reencrypt_shares(
        cA_batch, per_proxy_arr, p=p, noises=None)
    total_shares = sum(len(b) for b in per_proxy_arr)
    print(f"  [C-2] 一次批量处理 {len(per_proxy_arr)} 个代理 / {total_shares} 份份额 / "
          f"{args.batch} 条密文 = {total_shares * args.batch} 个卷积（单次 launch 展平）")

    # C-3：用 W = 前 t 个代理组合 → 解密
    W = list(range(v["T"]))
    combined, missing = combine_parts(per_proxy_arr, all_partials, W, q)
    ok_c3 = False
    if combined is None:
        print(f"  [C-3] 组合失败：{missing} 个缺失子集（|W|={len(W)} < t={v['T']}）")
    else:
        fb = np.asarray(v["FB"], dtype=np.int64) % q
        m_center = np.asarray(v["M"], dtype=np.int64) % p
        m_center = np.where(m_center > p // 2, m_center - p, m_center)
        dec = decrypt_poly(fb, combined, q, p)
        ok_c3 = bool(np.array_equal(dec, np.tile(m_center, (dec.shape[0], 1))))
        print(f"  [C-3] t={v['T']} 个代理组合后解密还原明文：{'PASS' if ok_c3 else 'FAIL'}")

    # C-4：t-1 个代理"尽力而为"必须失败
    ok_c4 = True
    if v["T"] >= 2:
        W_bad = list(range(v["T"] - 1))
        comb_bad, miss_bad = combine_parts(per_proxy_arr, all_partials, W_bad, q)
        if comb_bad is None:
            print(f"  [C-4] t-1={v['T']-1} 个代理：{miss_bad} 个缺失子集 → 无法组合（符合预期）")
        else:
            fb = np.asarray(v["FB"], dtype=np.int64) % q
            m_center = np.asarray(v["M"], dtype=np.int64) % p
            m_center = np.where(m_center > p // 2, m_center - p, m_center)
            dec = decrypt_poly(fb, comb_bad, q, p)
            ok_c4 = not np.array_equal(dec, np.tile(m_center, (dec.shape[0], 1)))
            print(f"  [C-4] t-1 个代理尽力组合后解密：{'PASS（解不出明文）' if ok_c4 else 'FAIL（竟然解出来了）'}")

    print()
    allok = ok_a and ok_b and ok_c1 and ok_c3 and ok_c4
    print("=" * 78)
    print(f" 结论：{'全部通过' if allok else '存在失败项'} —— "
          f"A={ok_a} B={ok_b} C1={ok_c1} C3={ok_c3} C4={ok_c4}")
    print("=" * 78)
    return 0 if allok else 1


def center_diff(a: np.ndarray, b: np.ndarray, q: int) -> np.ndarray:
    """逐系数取中心代表差（模 q 意义下的最小绝对差）。"""
    d = (np.asarray(a, dtype=np.int64) - np.asarray(b, dtype=np.int64)) % q
    return np.where(d > q // 2, d - q, d)


if __name__ == "__main__":
    raise SystemExit(main())
