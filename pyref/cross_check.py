"""
跨语言一致性校验：C++ 引擎 与 Python 参考实现
==============================================
文件：pyref/cross_check.py

流程：
  1) 调用 C++ CLI 导出测试向量（ntru_cli vectors <参数集> <seed> <文件>）
  2) 用 **Python 自己实现** 的模 q 循环卷积，逐条验证代数关系：
       f * f^{-1} = 1 ;  f = 1 (mod p) ;  h*f = p*g ;  c = h*s + m ;
       rk = f_A * f_B^{-1} ;  c_B = c*rk + p*e ;  Dec(f_B, c_B) = m
  3) 任一条不成立即非零退出

用法（在 最终方案 目录下）：
    python pyref/cross_check.py [参数集] [seed]
    # 例：python pyref/cross_check.py EES439 7
"""

from __future__ import annotations

import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Windows 控制台默认 GBK，中文输出会乱码/报错；统一按 UTF-8 输出
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from ntru_ref_py import decrypt_center  # noqa: E402
from ring_np import (  # noqa: E402
    parse_vectors,
    poly_center,
    poly_mod_p_centered,
    poly_mul_cyclic_fast,
    poly_to_list,
)

GREEN = "\033[32m"
RED = "\033[31m"
RESET = "\033[0m"

_fail = 0
_pass = 0


def check(cond: bool, what: str) -> None:
    global _fail, _pass
    if cond:
        _pass += 1
        print(f"{GREEN}[ OK ]{RESET} {what}")
    else:
        _fail += 1
        print(f"{RED}[FAIL]{RESET} {what}")


def find_cli(root: str) -> str:
    for cand in ("bin/ntru_cli.exe", "bin/ntru_cli"):
        p = os.path.join(root, cand)
        if os.path.exists(p):
            return p
    raise SystemExit("找不到 bin/ntru_cli(.exe)，请先构建（build.ps1 或 make）")


def run_vectors(cli: str, params: str, seed: int, out_path: str) -> None:
    # 注意：必须显式指定 utf-8，Windows 默认用 GBK 解码子进程输出会炸
    r = subprocess.run([cli, "vectors", params, str(seed), out_path],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.stdout:
        sys.stdout.write(r.stdout)
    if r.returncode != 0:
        if r.stderr:
            sys.stderr.write(r.stderr)
        raise SystemExit(f"ntru_cli vectors 失败（exit={r.returncode}）")


def main() -> int:
    params = sys.argv[1] if len(sys.argv) > 1 else "EES439"
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 7

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cli = find_cli(root)
    vec_path = os.path.join(root, "bin", f"vectors_{params}_{seed}.txt")
    os.makedirs(os.path.dirname(vec_path), exist_ok=True)

    print(f"=== 跨语言校验：{params}, seed={seed} ===")
    run_vectors(cli, params, seed, vec_path)
    v = parse_vectors(vec_path)

    n, q, p = v["N"], v["Q"], v["P"]
    FA, FAINV, HA, GA = v["FA"], v["FAINV"], v["HA"], v["GA"]
    FB, FBINV = v["FB"], v["FBINV"]
    M, S, C = v["M"], v["S"], v["C"]
    RK, E, CB = v["RK"], v["E"], v["CB"]

    one = np.zeros(n, dtype=np.int64)
    one[0] = 1

    # 1) f * f^{-1} = 1
    check(np.array_equal(poly_mul_cyclic_fast(FA, FAINV, q), one),
          "f_A * f_A^{-1} == 1 (mod q)")
    check(np.array_equal(poly_mul_cyclic_fast(FB, FBINV, q), one),
          "f_B * f_B^{-1} == 1 (mod q)")

    # 2) f = 1 (mod p)，且 f 由 F 三元构成（f = 1 + p*F，F 的系数只能取 0/±1）
    invp = pow(p, -1, q)  # p=3 与 2048 互素
    F_rec = ((poly_center(FA, q) - one) * invp) % q
    F_ctr = poly_center(F_rec, q)
    check(bool(np.all(np.isin(F_ctr, (-1, 0, 1)))), "f_A 可由 f = 1 + p*F 还原出三元 F")
    check(bool(np.all(poly_center(FA, q) % p == (one % p))), "f_A ≡ 1 (mod p)")
    nz = int(np.count_nonzero(F_ctr))
    print(f"       F 非零系数个数 = {nz}（EES 参数族里应为 2*df）")

    # 3) h * f = p * g
    lhs = poly_mul_cyclic_fast(HA, FA, q)
    rhs = (p * GA) % q
    check(np.array_equal(lhs, rhs), "h_A * f_A == p * g_A (mod q)")

    # 4) c = h * s + m
    check(np.array_equal(poly_mul_cyclic_fast(HA, S, q) + M % q,
                         C % q), "c == h_A*s + m (mod q)")

    # 5) rk = f_A * f_B^{-1}
    check(np.array_equal(poly_mul_cyclic_fast(FA, FBINV, q), RK),
          "rk == f_A * f_B^{-1} (mod q)")

    # 6) c_B = c * rk + p * e
    check(np.array_equal((poly_mul_cyclic_fast(C, RK, q) + p * E) % q, CB % q),
          "c_B == c*rk + p*e (mod q)")

    # 7) 解密
    dec = decrypt_center(FB, CB, q, p)
    want = poly_mod_p_centered(M, q, p)
    check(np.array_equal(dec, want), "Dec(f_B, c_B) == m")

    # 8) 噪声与 q/2 的距离（顺带打印，供噪声预算实验用）
    a = poly_mul_cyclic_fast(FB, CB, q)
    noise = int(np.max(np.abs(poly_center(a, q))))
    print(f"       重加密后噪声 ||center(f_B*c_B)||_inf = {noise}  (q/2 = {q // 2})")

    print(f"=== 通过 {_pass} 项，失败 {_fail} 项 ===")
    return 0 if _fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
