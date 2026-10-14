# 测试 fixture

## `vectors_EES439_7.txt`

**是什么**：C++ 引擎跑一遍完整流程后导出的**全部中间量**
（`GA / FA / FAINV / HA / FB / FBINV / M / S / C / RK / E / CB`），
由 `ntru_cli vectors EES439 7 <输出路径>` 生成。

**为什么入库**：它是 `python pyref/hop_sim.py --selftest` 里那条
**"`T_1 == g·s + F_A·M + e·f_B` 与 C++ 引擎逐位对拍"**断言的输入 ——
而 `bin/` 是 gitignore 的，新克隆的仓库里不会有这个文件。
不入库的话那条断言会被**静默跳过**，而它恰恰是当初抓出
"明文必须用 mod p 表示"那个 bug 的工具（见 `docs/C2_实现进度.md` §2.3(d)）。

**怎么重新生成**（内容由 seed 决定，完全可复现）：

```bash
# Windows：先按 README §6 用 -static-libstdc++ 重建 ntru_cli，否则 vectors 必段错误
./bin/ntru_cli.exe vectors EES439 7 tests/fixtures/vectors_EES439_7.txt
# WSL：make && ./bin/ntru_cli vectors EES439 7 tests/fixtures/vectors_EES439_7.txt
```

**校验和**（`ntru_cli` 自己打印的，用于确认没被改坏）：

```
FA=afbe17dcb70918b2  HA=693976b7da576845  C=90ff2809dd430e1a
RK=c19f6809cf8aeba5  CB=d621ce39043a02c1
```

**另一重保险**：`--selftest` 不只看校验和，还用这些向量**独立重算**噪声核公式并逐位比对 ——
文件若被改动，那条断言会直接失败，不会静默通过。

> ⚠️ **注意路径**：在 Git Bash 里把 `/tmp/xxx.txt` 传给原生 exe 时，
> ofstream 有时打不开（路径转换问题）—— 用仓库内的**相对路径**最稳。
