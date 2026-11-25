/* ============================================================================
 *  逻辑层测试：data.js（录制数据） / threshold.js（CNF 结构）
 *  文件：web/test/logic.test.js
 *
 *  最关键的一条是「data.js 与 bench/results/c1_*.csv 逐字段对拍」：
 *  页面上的数字不能有第二种说法，所以先把数据源钉死，再谈别的。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { REPO_ROOT, csvRows } = require('./mock-server');

const WEB = path.resolve(__dirname, '..');
const CSV_COLUMNS = ['params', 'n', 't', 'subsets', 'succ_t_pct', 'succ_t_minus_1_pct',
  'noise_ratio', 'share_ms', 'partials_ms', 'combine_ms'];

function loadWindow(file) {
  const sandbox = { window: {}, console };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.window;
}

function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function subsetsOfSize(n, size) {
  const out = [];
  for (let mask = 0; mask < (1 << n); mask++) {
    let c = 0;
    for (let x = mask; x; x &= x - 1) c++;
    if (c === size) out.push(mask);
  }
  return out;
}

function membersOf(mask, n) {
  const out = [];
  for (let i = 0; i < n; i++) if (mask & (1 << i)) out.push(i);
  return out;
}

async function run(ck) {
  const D = loadWindow(path.join(WEB, 'js', 'data.js')).NTRU_DATA;
  const T = loadWindow(path.join(WEB, 'js', 'threshold.js')).NTRU_THRESHOLD;

  /* ---------------------------------------------- 1. 数据与 CSV 对拍 ---- */
  ck.section('data.js ↔ bench/results/c1_*.csv');

  const csvByParams = {};
  D.order.forEach((p) => {
    const rel = D.provenance[p].file;
    const rows = csvRows(path.join(REPO_ROOT, rel));
    csvByParams[p] = rows;
    ck.eq(`${p}: CSV 行数`, rows.length, 7);
    ck.eq(`${p}: data.js 行数`, D.rows[p].length, rows.length);
    ck.eq(`${p}: 表头`, Object.keys(rows[0]).join(','), CSV_COLUMNS.join(','));
  });

  let fieldChecks = 0;
  let fieldBad = [];
  D.order.forEach((p) => {
    csvByParams[p].forEach((raw, i) => {
      const mine = D.rows[p][i];
      const pairs = [
        ['n', mine.n, Number(raw.n)],
        ['t', mine.t, Number(raw.t)],
        ['subsets', mine.m, Number(raw.subsets)],
        ['succ_t_pct', mine.succT, Number(raw.succ_t_pct)],
        ['succ_t_minus_1_pct', mine.succTm1, Number(raw.succ_t_minus_1_pct)],
        ['noise_ratio', mine.ratio, Number(raw.noise_ratio)],
        ['share_ms', mine.shareMs, Number(raw.share_ms)],
        ['partials_ms', mine.partialsMs, Number(raw.partials_ms)],
        ['combine_ms', mine.combineMs, Number(raw.combine_ms)]
      ];
      pairs.forEach(([name, a, b]) => {
        fieldChecks++;
        if (!Object.is(a, b)) fieldBad.push(`${p} 第 ${i + 1} 行 ${name}: data.js=${a} csv=${b}`);
      });
    });
  });
  ck.ok('逐字段一致（21 行 × 9 列）', fieldBad.length === 0, fieldBad.slice(0, 6).join(' | '));
  ck.eq('对比字段总数', fieldChecks, 189);

  /* ------------------------------------------------- 2. 出处元信息 ---- */
  ck.section('出处元信息（字节数 / mtime）');
  D.order.forEach((p) => {
    const prov = D.provenance[p];
    const st = fs.statSync(path.join(REPO_ROOT, prov.file));
    ck.eq(`${p}: 字节数`, prov.bytes, st.size);
    ck.eq(`${p}: mtime`, prov.mtime, fmtLocal(st.mtime));
    ck.ok(`${p}: trials 是正整数`, Number.isInteger(prov.trials) && prov.trials > 0);
  });

  /* ------------------------------------------------------ 3. 汇总数 ---- */
  ck.section('summary() 派生指标');
  const s = D.summary();
  ck.eq('配置总数', s.total, 21);
  ck.eq('100% 成功配置数', s.fullSuccess, 15);
  ck.eq('t−1 恒为 0 的配置数', s.tm1Zero, 21);
  ck.eq('未满 100% 的配置数', s.maxFail, 6);
  ck.eq('噪声放大下界', s.ratioMin, 1.256);
  ck.eq('噪声放大上界', s.ratioMax, 4.522);
  const flatLen = D.flat.length;
  ck.eq('flat 长度', flatLen, 21);
  ck.ok('flat 每行都带 params', D.flat.every((r) => typeof r.params === 'string'));

  /* ------------------------------------------- 4. 录制数据的内部一致 ---- */
  ck.section('录制数据内部自洽');
  D.flat.forEach((r) => {
    const key = `${r.params} ${r.label}`;
    if (r.m !== T.binom(r.n, r.t - 1)) ck.ok(`${key}: m = C(n,t−1)`, false);
    if (!(r.succT >= 0 && r.succT <= 100)) ck.ok(`${key}: 成功率在 0..100`, false);
    if (r.succTm1 !== 0) ck.ok(`${key}: t−1 成功率应为 0`, false);
    if (!(r.ratio >= 1)) ck.ok(`${key}: 噪声放大 ≥ 1`, false);
    if (!(r.partialsMs >= 0 && r.shareMs >= 0 && r.combineMs >= 0)) ck.ok(`${key}: 耗时为非负`, false);
  });
  ck.ok('m / 区间 / t−1 全部满足（无单条失败）', true);

  /* ------------------------------------------- 5. 结构：|W| = t 全覆盖 ---- */
  ck.section('CNF 结构：|W| = t');
  let stChecks = 0;
  D.order.forEach((p) => {
    D.rows[p].forEach((cfg) => {
      const n = cfg.n, t = cfg.t;
      const struct0 = T.structure(n, t, Array.from({ length: t }, (_, i) => i));
      ck.eq(`${p} ${cfg.label}: 子集数`, struct0.count, cfg.m);
      ck.eq(`${p} ${cfg.label}: 子集大小`, struct0.subsetSize, n - t + 1);
      ck.eq(`${p} ${cfg.label}: 期望子集数`, struct0.expectCount, T.binom(n, t - 1));
      ck.eq(`${p} ${cfg.label}: 每代理份数`, struct0.expectHoldings, T.binom(n - 1, t - 1));

      const holdingsTotal = struct0.holdings.reduce((a, h) => a + h.length, 0);
      ck.eq(`${p} ${cfg.label}: 份额持有总数`, holdingsTotal, struct0.count * struct0.subsetSize);
      ck.ok(`${p} ${cfg.label}: 每代理份数一致`,
        struct0.holdings.every((h) => h.length === struct0.expectHoldings));

      // 所有 t 元组合：必须全覆盖，且 owner = min(S ∩ W)
      let bad = 0;
      subsetsOfSize(n, t).forEach((Wmask) => {
        const W = membersOf(Wmask, n);
        const st = T.structure(n, t, W);
        stChecks++;
        if (st.missing.length !== 0) bad++;
        st.subsets.forEach((sub) => {
          const inter = sub.members.filter((x) => W.indexOf(x) >= 0);
          const expectOwner = inter.length ? Math.min.apply(null, inter) : -1;
          if (sub.owner !== expectOwner) bad++;
        });
      });
      ck.ok(`${p} ${cfg.label}: ${T.binom(n, t)} 个 W 全部覆盖且 owner 正确`, bad === 0, 'bad=' + bad);
    });
  });
  ck.ok('t 元组合遍历数 > 0', stChecks > 0, 'checks=' + stChecks);

  /* --------------------------------------- 6. 结构：|W| = t−1 缺一份 ---- */
  ck.section('CNF 结构：|W| = t−1（缺一份）');
  D.order.forEach((p) => {
    D.rows[p].forEach((cfg) => {
      const n = cfg.n, t = cfg.t;
      const W = Array.from({ length: t - 1 }, (_, i) => i);
      const st = T.structure(n, t, W);
      const label = `${p} ${cfg.label}`;
      ck.eq(`${label}: 缺失子集个数`, st.missing.length, 1);
      const wMask = W.reduce((a, i) => a | (1 << i), 0);
      const expectMissing = ((1 << n) - 1) ^ wMask;
      ck.eq(`${label}: 缺失子集 = [n]\\W`, st.missing[0].mask, expectMissing);
      ck.ok(`${label}: 缺失子集大小 = n−t+1`, st.missing[0].members.length === n - t + 1);
      ck.eq(`${label}: 其余子集都 covered`, st.subsets.filter((x) => x.covered).length, st.count - 1);
    });
  });

  /* --------------------------------------------------- 7. 边界与换算 ---- */
  ck.section('边界与组合数');
  const wide = T.structure(8, 4, [0, 1, 2, 3]);
  ck.eq('n=8,t=4 子集数 = C(8,3)', wide.count, 56);
  ck.ok('n=8,t=4 子集数 ≤ 200（探针上限）', wide.count <= 200);
  const tiny = T.structure(2, 2, [0, 1]);
  ck.eq('n=2,t=2 子集大小', tiny.subsetSize, 1);
  ck.eq('n=2,t=2 子集数', tiny.count, 2);
  ck.eq('C(6,2)', T.binom(6, 2), 15);
  ck.eq('C(7,3)', T.binom(7, 3), 35);
  ck.eq('C(5,0)', T.binom(5, 0), 1);
  ck.eq('C(5,6)', T.binom(5, 6), 0);
  ck.eq('popcount(0b101101)', T.popcount(0b101101), 4);

  // 存储估算：与报告 3.4.5 的 "(7,4) n=439 时 20 份 ≈ 12 KB" 对齐
  const st439 = T.structure(7, 4, [0, 1, 2, 3]);
  const kb = (st439.expectHoldings * 11 * 439) / 8 / 1024;
  ck.ok('存储估算 ≈ 12 KB（n=439,(7,4)）', kb > 11 && kb < 13, kb.toFixed(2) + ' KB');
}

module.exports = { run };
