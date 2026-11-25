/* ============================================================================
 *  C1 录制数据（唯一数据来源）
 *  文件：web/js/data.js
 *
 *  这里的每一行都逐字来自仓库内的 bench/results/c1_*.csv —— 那是报告数字的
 *  唯一来源。界面上不允许出现第二个"看起来像真数据"的地方：现场探针在没有
 *  后端时只用本文件做插值/结构推导，并且必须打上"演示数据"徽章。
 *
 *  重新生成方式：把 c1_*.csv 重新跑出来后，手工同步本表（21 行，量很小）。
 * ==========================================================================*/
(function (global) {
  'use strict';

  // 参数集（q = 2048, p = 3 对整族固定；见 src/core/params.h）
  var PARAMS = {
    EES439: { name: 'EES439', n: 439, q: 2048, p: 3, df: 146, dg: 146, dr: 146,
              // 报告 3.4.5：基线噪声占 q/2 的比例（用于"余量"说明，非 CSV 字段）
              baseline_noise: 415, trials: 20,
              note: '绝对值在 APR2011_439 字段修正前测得；修正后余量更薄，边界结论不变' },
    EES1171: { name: 'EES1171', n: 1171, q: 2048, p: 3, df: 106, dg: 390, dr: 106,
               baseline_noise: 250, trials: 10, note: '' },
    EES1499: { name: 'EES1499', n: 1499, q: 2048, p: 3, df: 79, dg: 499, dr: 79,
               baseline_noise: 180, trials: 10, note: '' }
  };

  var ORDER = ['EES439', 'EES1171', 'EES1499'];

  // 列顺序与 CSV 表头一致
  var COLUMNS = ['params', 'n', 't', 'subsets', 'succ_t_pct', 'succ_t_minus_1_pct',
                 'noise_ratio', 'share_ms', 'partials_ms', 'combine_ms'];

  function row(n, t, subsets, succT, succTm1, ratio, shareMs, partialsMs, combineMs) {
    return {
      n: n, t: t, m: subsets,
      succT: succT, succTm1: succTm1, ratio: ratio,
      shareMs: shareMs, partialsMs: partialsMs, combineMs: combineMs,
      label: '(' + n + ',' + t + ')'
    };
  }

  var ROWS = {
    EES439: [
      row(2, 2, 2,  100.00, 0.00, 1.362, 0.0107, 0.2124, 0.0027),
      row(3, 2, 3,  100.00, 0.00, 1.659, 0.0137, 0.5707, 0.0037),
      row(4, 2, 4,  100.00, 0.00, 1.848, 0.0444, 1.1610, 0.0075),
      row(5, 2, 5,   90.00, 0.00, 2.029, 0.0471, 1.9236, 0.0061),
      row(5, 3, 10,  10.00, 0.00, 2.466, 0.0688, 2.9418, 0.0123),
      row(6, 3, 15,   0.00, 0.00, 2.467, 0.1386, 5.8539, 0.0189),
      row(7, 4, 35,   0.00, 0.00, 2.435, 0.3732, 13.3612, 0.0438)
    ],
    EES1171: [
      row(2, 2, 2,  100.00, 0.00, 1.352, 0.0258, 1.1764, 0.0061),
      row(3, 2, 3,  100.00, 0.00, 1.492, 0.0339, 3.4179, 0.0089),
      row(4, 2, 4,  100.00, 0.00, 1.757, 0.0700, 7.0931, 0.0129),
      row(5, 2, 5,  100.00, 0.00, 1.767, 0.0671, 11.4242, 0.0148),
      row(5, 3, 10, 100.00, 0.00, 2.476, 0.1381, 17.3609, 0.0304),
      row(6, 3, 15, 100.00, 0.00, 3.104, 0.3082, 35.7328, 0.0486),
      row(7, 4, 35,  10.00, 0.00, 3.973, 0.8399, 80.4680, 0.1099)
    ],
    EES1499: [
      row(2, 2, 2,  100.00, 0.00, 1.256, 0.0349, 1.8095, 0.0075),
      row(3, 2, 3,  100.00, 0.00, 1.355, 0.0749, 6.0721, 0.0225),
      row(4, 2, 4,  100.00, 0.00, 1.688, 0.0705, 12.3523, 0.0179),
      row(5, 2, 5,  100.00, 0.00, 1.657, 0.1652, 18.4123, 0.0189),
      row(5, 3, 10, 100.00, 0.00, 2.533, 0.2479, 28.6411, 0.0412),
      row(6, 3, 15, 100.00, 0.00, 2.758, 0.3945, 57.9616, 0.0663),
      row(7, 4, 35,  90.00, 0.00, 4.522, 1.2699, 138.7509, 0.1431)
    ]
  };

  // 文件级出处（大小/mtime 用于让页面说清"这行数字从哪来"）
  var PROVENANCE = {
    EES439:  { file: 'bench/results/c1_EES439.csv',  bytes: 455, mtime: '2026-11-21 14:01:22', trials: 20 },
    EES1171: { file: 'bench/results/c1_EES1171.csv', bytes: 478, mtime: '2026-10-13 18:49:47', trials: 10 },
    EES1499: { file: 'bench/results/c1_EES1499.csv', bytes: 480, mtime: '2026-10-13 18:49:55', trials: 10 },
    runner: 'bin/ntru_cli.exe c1 <参数集> <trials> <zero_trials>',
    host: 'Windows x64 + MinGW-w64 g++ -O3 -march=native（单核 CPU 功能基线）',
    note: '成功率每格 = trials 次独立 keygen/加密/分享/部分重加密/组合/解密的命中比例；噪声放大 = 门限噪声 / 基线噪声（同参数组内比值）'
  };

  // 零信息性统计（ntru_cli c1 末尾打印，1000 次试验，无独立 CSV）
  var ZERO_INFO = {
    n: 5, t: 3, coalition: [0, 1], trials: 1000,
    missing_per_trial: 1,
    missing_share: { mean: -53.7, std: 575.2 },
    rk_minus_missing: { mean: -31.6, std: 593.5 },
    uniform_theory: { std: 591.2, formula: 'q/√12' },
    source: 'bin/ntru_cli.exe c1 <参数集> 1000 →「零信息性检查」段'
  };

  // 全部 21 行的扁平视图，便于图表/表格统一遍历
  var FLAT = [];
  ORDER.forEach(function (p) {
    ROWS[p].forEach(function (r) {
      var c = Object.assign({}, r);
      c.params = p;
      FLAT.push(c);
    });
  });

  function summary() {
    var tot = FLAT.length;
    var full = FLAT.filter(function (r) { return r.succT >= 99.999; }).length;
    var tm1Zero = FLAT.filter(function (r) { return r.succTm1 <= 0.0001; }).length;
    var ratios = FLAT.map(function (r) { return r.ratio; });
    return {
      total: tot,
      fullSuccess: full,
      tm1Zero: tm1Zero,
      ratioMin: Math.min.apply(null, ratios),
      ratioMax: Math.max.apply(null, ratios),
      maxFail: FLAT.filter(function (r) { return r.succT < 99.999; }).length
    };
  }

  global.NTRU_DATA = {
    params: PARAMS,
    order: ORDER,
    columns: COLUMNS,
    rows: ROWS,
    flat: FLAT,
    provenance: PROVENANCE,
    zeroInfo: ZERO_INFO,
    summary: summary
  };
})(window);
