/* ============================================================================
 *  C1 页面：门限多代理委托
 *  文件：web/js/page-c1.js
 *
 *  数据纪律：
 *    · 成功率 / 噪声放大 / 三阶段耗时 —— 只来自 D.rows（bench/results/c1_*.csv）
 *    · 子集数 m、持有者、缺失子集、存储估算 —— 由 (n,t,W) 结构精确算出（threshold.js）
 *    · 无后端时"运行探针"= 重放录制行 + 结构推导 + 伯努利抽样演示，页面必须标出来
 * ==========================================================================*/
(function (global) {
  'use strict';
  var UI = global.UI, h = UI.h, D = global.NTRU_DATA, T = global.NTRU_THRESHOLD, C = global.Charts;
  var P = D.params;   // 参数集元数据

  var CFGS = [{ n: 2, t: 2 }, { n: 3, t: 2 }, { n: 4, t: 2 }, { n: 5, t: 2 },
              { n: 5, t: 3 }, { n: 6, t: 3 }, { n: 7, t: 4 }];

  var state = {
    params: 'EES1499',
    cfgIdx: 5,                       // (6,3)
    W: [0, 1, 2],
    showTm1: false,
    sample: true,
    selected: { params: 'EES1499', label: '(6,3)' },
    filter: 'ALL',
    onlyFull: false,
    probe: { status: 'done', stage: 3, token: 0 }
  };

  var dom = {};

  /* --------------------------------------------------------------- 工具 ---- */
  function rowsOf(p) { return D.rows[p]; }
  function curRow() { return rowsOf(state.params)[state.cfgIdx]; }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function pLabel(i) { return 'P' + (i + 1); }

  function kb(bytes) { return (bytes / 1024).toFixed(1) + ' KB'; }

  /* ====================================================== 页头 / KPI ===== */
  function hero() {
    var sum = D.summary();
    return h('section', { class: 'page-head' }, [
      h('div', { class: 'page-head__eyebrow' }, 'C1 · 门限多代理委托（Threshold Re-Encryption Delegation）'),
      h('h1', { class: 'page-head__title' }, [
        '把委托凭证 ', h('code', null, 'rk = f_A·f_B⁻¹'),
        ' 拆给 N 个代理，任意 t 个才能完成转换'
      ]),
      h('p', { class: 'page-head__lead' }, [
        'q = 2048 = 2¹¹ ⇒ ', h('strong', null, 'Z_q 不是域'),
        '，Shamir 的重构系数 λᵢ 分母 (i−j) 必含因子 2、全部不可逆 ⇒ 改用 ',
        h('strong', null, '子集加性分享（CNF / Ito–Saito–Nishizeki）'),
        '：子集大小 n−t+1、共 m = C(n,t−1) 份，',
        h('strong', null, '重构系数全是 1（不求逆、噪声友好）'),
        '。任意 t 个代理的并集必与每个子集相交；任意 t−1 个恰好漏掉唯一一份均匀随机份额。'
      ]),
      h('div', { class: 'page-head__chips' }, [
        UI.badge('t 个代理：' + sum.fullSuccess + '/' + sum.total + ' 配置 100%', 'ok'),
        UI.badge('t−1 个代理：' + sum.tm1Zero + '/' + sum.total + ' 配置 0.00%', 'fail'),
        UI.badge('噪声放大 ' + sum.ratioMin.toFixed(2) + '× – ' + sum.ratioMax.toFixed(2) + '×', 'info'),
        UI.badge('腐化阈值 1 → t', 'info')
      ]),
      h('nav', { class: 'jump' }, [
        { h: '#probe', t: '① 现场探针' },
        { h: '#sec-success', t: '② 成功率' },
        { h: '#sec-noise', t: '③④ 噪声 / 零信息' },
        { h: '#sec-time', t: '⑤ 三阶段耗时' },
        { h: '#sec-table', t: '⑥ 录制数据表' },
        { h: '#sec-notes', t: '⑦ 口径' }
      ].map(function (it) {
        return h('a', { class: 'jump__link', href: it.h }, it.t);
      }))
    ]);
  }

  function kpiRow() {
    var sum = D.summary();
    var items = [
      { k: 't 个代理成功率', v: '100%', sub: sum.fullSuccess + ' / ' + sum.total + ' 个录制配置', kind: 'ok' },
      { k: 't−1 个代理成功率', v: '0.00%', sub: sum.tm1Zero + ' / ' + sum.total + ' 个配置恒为 0（结构性）', kind: 'fail' },
      { k: '噪声放大区间', v: sum.ratioMin.toFixed(2) + '–' + sum.ratioMax.toFixed(2) + '×', sub: '而 m 最大到 35 ⇒ 远小于 m', kind: 'info' },
      { k: '100% 成功的最大 m', v: '15 / 15 / 4', sub: 'EES1499 / EES1171 / EES439', kind: 'warn' }
    ];
    return h('div', { class: 'kpi-row' }, items.map(function (it) {
      return h('div', { class: 'kpi kpi--' + it.kind }, [
        h('div', { class: 'kpi__k' }, it.k),
        h('div', { class: 'kpi__v' }, it.v),
        h('div', { class: 'kpi__sub' }, it.sub)
      ]);
    }));
  }

  /* ====================================================== 现场探针 ======= */
  function probeCard() {
    var row = curRow();
    var pset = P[state.params];
    var n = row.n, t = row.t;
    var W = state.W.slice(0, t);
    var struct = T.structure(n, t, W);
    var structTm1 = T.structure(n, t, W.slice(0, t - 1));

    var card = h('section', { class: 'card card--probe', id: 'probe' }, [
      UI.sectionHead('① 现场探针 · live probe',
        '选一个参数集与 (n,t)，再自由挑恰好 t 个代理',
        '成功率与噪声来自录制行；子集数、持有者、缺失子集由 (n,t,W) 精确推导，随 W 实时变化。'),
      badgeStrip(),
      h('div', { class: 'probe' }, [
        h('div', { class: 'probe__form' }, [
          field('参数集', segmented(ORDER_ITEMS(), state.params, 'params')),
          field('门限配置 (n,t)', cfgChips(row)),
          field('参与集合 W（恰好 t 个）', wChips(n, t, W)),
          h('div', { class: 'probe__actions' }, [
            h('button', {
              class: 'btn btn--primary' + (state.probe.status === 'running' ? ' is-busy' : ''),
              attrs: { type: 'button' },
              data: { act: 'run' }
            }, state.probe.status === 'running' ? '运行中…' : '▸ 运行探针'),
            toggle('|W| = t−1（演示缺失份额）', state.showTm1, 'tm1'),
            toggle('抽样条', state.sample, 'sample')
          ]),
          h('p', { class: 'hint' }, [
            '当前没有后端（', h('code', null, '/api/c1/run'), ' 尚未上线）：按钮重放该配置的录制行 + 重算子集结构；',
            '抽样条是按录制成功率做的伯努利演示，', h('strong', null, '不是引擎逐次输出'),
            '。接上 ', h('code', null, 'ntru_demo.exe'), ' 后同一套 UI 直接吃真 JSON。'
          ])
        ]),
        h('div', { class: 'probe__out' }, probeOutput(row, pset, struct, structTm1))
      ]),
      h('div', { class: 'probe__struct' }, subsetPanel(struct, structTm1, row, n, t, W))
    ]);

    return card;
  }

  function badgeStrip() {
    var prov = D.provenance[state.params];
    return h('div', { class: 'probe__badges' }, [
      UI.badge('录制数据 · ' + state.params, 'ok', prov.file + ' · mtime ' + prov.mtime + ' · ' + prov.trials + ' 次试验'),
      UI.badge('结构实时推导', 'info', 'm、持有者、缺失子集由 (n,t,W) 唯一确定，不含随机数'),
      UI.badge('无后端', 'warn', '/api/c1/run 未上线：成功率与噪声为录制值')
    ]);
  }

  function ORDER_ITEMS() {
    return D.order.map(function (p) {
      return { id: p, label: p, sub: 'n=' + P[p].n, color: C.COLOR[p] };
    });
  }

  function field(label, node) {
    return h('div', { class: 'field' }, [h('div', { class: 'field__label' }, label), node]);
  }

  function segmented(items, active, act) {
    return h('div', { class: 'seg' }, items.map(function (it) {
      var on = it.id === active;
      return h('button', {
        class: 'seg__btn' + (on ? ' is-on' : ''),
        attrs: { type: 'button' },
        style: on ? '--dot-color:' + (it.color || '#2a78d6') : null,
        data: { act: act, id: it.id }
      }, [
        it.color ? h('span', { class: 'seg__dot', style: 'background:' + it.color }) : null,
        h('span', { class: 'seg__label' }, it.label),
        it.sub ? h('span', { class: 'seg__sub' }, it.sub) : null
      ]);
    }));
  }

  function cfgChips(row) {
    return h('div', { class: 'seg seg--cfg' }, CFGS.map(function (c, i) {
      var on = (c.n === row.n && c.t === row.t);
      var r = rowsOf(state.params)[i];
      return h('button', {
        class: 'chip' + (on ? ' is-on' : '') + (r.succT < 99.999 ? ' is-edge' : ''),
        attrs: { type: 'button' },
        data: { act: 'cfg', idx: String(i) },
        title: r.label + '：t 个 ' + UI.fmtPct(r.succT, 2) + ' / m=' + r.m
      }, [
        h('span', { class: 'chip__label' }, r.label),
        h('span', { class: 'chip__sub' }, 'm=' + r.m)
      ]);
    }));
  }

  function wChips(n, t, W) {
    var chips = [];
    for (var i = 0; i < n; i++) {
      (function (i) {
        var on = W.indexOf(i) >= 0;
        chips.push(h('button', {
          class: 'wchip' + (on ? ' is-on' : ''),
          attrs: { type: 'button', 'aria-pressed': on ? 'true' : 'false' },
          data: { act: 'w', p: String(i) }
        }, [
          h('span', { class: 'wchip__dot' }),
          h('span', null, pLabel(i))
        ]));
      })(i);
    }
    chips.push(h('span', { class: 'wchip-count' + (W.length === t ? '' : ' is-bad') },
      state.showTm1
        ? '已选 ' + W.length + ' / ' + t + '（结构按前 ' + (t - 1) + ' 个 = t−1 计）'
        : '已选 ' + W.length + ' / ' + t));
    return h('div', { class: 'wchips' }, chips);
  }

  function toggle(label, on, act) {
    return h('label', { class: 'switch' }, [
      h('input', {
        attrs: { type: 'checkbox' }, checked: on ? 'checked' : null,
        data: { act: act },
        on: { change: function (e) { setToggle(act, e.target.checked); } }
      }),
      h('span', { class: 'switch__track' }, h('span', { class: 'switch__knob' })),
      h('span', { class: 'switch__label' }, label)
    ]);
  }

  /* --------------------------------------------------------- 探针输出 ---- */
  function probeOutput(row, pset, struct, structTm1) {
    var prov = D.provenance[state.params];
    var total = row.shareMs + row.partialsMs + row.combineMs;
    var shareOf = row.partialsMs / total;

    var metrics = h('div', { class: 'metrics' }, [
      metric('子集数 m = C(n,t−1)', String(struct.count), '结构精确值 · 每子集 1 份', 'info'),
      metric('t 个代理成功率', UI.fmtPct(row.succT, 2), prov.trials + ' 次试验录制', row.succT > 99.999 ? 'ok' : 'warn'),
      metric('t−1 个代理成功率', UI.fmtPct(row.succTm1, 2), '尽力而为组合，非代码拦截', 'fail'),
      metric('噪声放大', UI.fmtRatio(row.ratio), '门限噪声 / 基线噪声', 'info'),
      metric('单次转换耗时', UI.fmtMs(total), '分享+部分+组合', 'info')
    ]);

    var stages = h('div', { class: 'stages' }, [
      stageBar('分享', 'cnf_share', row.shareMs, total),
      stageBar('部分重加密', 'proxy_partials', row.partialsMs, total),
      stageBar('组合', 'threshold_combine', row.combineMs, total)
    ]);

    var strip = state.sample ? trialStrip(row, pset) : null;

    var running = state.probe.status === 'running';
    var runLine = h('div', { class: 'runline' + (running ? ' is-on' : '') }, [
      h('span', { class: 'runline__dot' }),
      h('span', { class: 'runline__text', data: { runtext: '1' } }, running
        ? '① cnf_share(rk, n, t)：准备中…'
        : '就绪 · 上次运行 ' + (state.probe.at || '（本次会话未运行）')),
      h('span', { class: 'runline__bar' }, h('i', { data: { runbar: '1' }, style: 'width:0%' }))
    ]);

    return h('div', null, [metrics, stages, strip, runLine,
      h('p', { class: 'hint hint--tight' }, [
        '部分重加密占总耗时 ' + (shareOf * 100).toFixed(1) + '%；' + struct.count + ' 份 partial 互相独立 ⇒ 天然是 C3 的 batch 维。',
        ' ' + pset.name + '：q=' + pset.q + '（噪声预算 q/2=' + (pset.q / 2) + '）、p=' + pset.p +
        '、df=' + pset.df + '、dg=' + pset.dg + '、dr=' + pset.dr + '。'
      ])
    ]);
  }

  function metric(k, v, sub, kind) {
    return h('div', { class: 'metric metric--' + kind }, [
      h('div', { class: 'metric__k' }, k),
      h('div', { class: 'metric__v' }, v),
      h('div', { class: 'metric__sub' }, sub)
    ]);
  }

  function stageBar(label, fn, ms, total) {
    var pct = total > 0 ? ms / total * 100 : 0;
    return h('div', { class: 'stage' }, [
      h('div', { class: 'stage__label' }, [
        h('span', null, label),
        h('code', null, fn + '()')
      ]),
      h('div', { class: 'stage__track' }, h('div', { class: 'stage__fill s-' + fn, style: 'width:' + Math.max(pct, 0.6).toFixed(2) + '%' })),
      h('div', { class: 'stage__value' }, [UI.fmtMs(ms), h('span', { class: 'stage__pct' }, pct.toFixed(1) + '%')])
    ]);
  }

  function trialStrip(row, pset) {
    var trials = D.provenance[state.params].trials;
    // 抽样条：通过数恰好等于 round(录制成功率 × trials)，位置由固定种子打散
    // —— 这样条子里的比例与上面的百分比永远自洽，不会出现"显示 10% 却有 3 个 ✓"
    var rng = mulberry32(20261012 + pset.n * 7 + row.t * 13 + row.n);
    var passes = Math.round(row.succT / 100 * trials);
    var flags = [];
    for (var k = 0; k < trials; k++) flags.push(k < passes);
    for (var m = flags.length - 1; m > 0; m--) {
      var j = Math.floor(rng() * (m + 1));
      var tmp = flags[m]; flags[m] = flags[j]; flags[j] = tmp;
    }

    var cells = flags.map(function (ok, i) {
      return h('span', {
        class: 'tcell' + (ok ? ' is-ok' : ' is-fail'),
        data: { tip: 'trial ' + (i + 1) + '：' + (ok ? '解密逐系数一致' : '噪声绕回 ⇒ 解密不一致') }
      }, ok ? '✓' : '✗');
    });
    var failCells = [];
    for (var j2 = 0; j2 < trials; j2++) {
      failCells.push(h('span', {
        class: 'tcell is-fail',
        data: { tip: 'trial ' + (j2 + 1) + '：|W| = t−1，缺一份均匀随机份额 ⇒ 解不出明文' }
      }, '✗'));
    }
    return h('div', { class: 'trials' }, [
      h('div', { class: 'trials__row' }, [
        h('div', { class: 'trials__label' }, ['|W| = t ', h('span', { class: 'trials__hint' }, '抽样演示')]),
        h('div', { class: 'trials__cells' }, cells),
        h('div', { class: 'trials__sum' }, passes + ' / ' + trials + ' 通过')
      ]),
      h('div', { class: 'trials__row' }, [
        h('div', { class: 'trials__label' }, ['|W| = t−1 ', h('span', { class: 'trials__hint' }, '录制 0.00%')]),
        h('div', { class: 'trials__cells' }, failCells),
        h('div', { class: 'trials__sum is-fail' }, '0 / ' + trials + ' 通过')
      ])
    ]);
  }

  /* ------------------------------------------------------ 子集结构面板 ---- */
  function subsetPanel(struct, structTm1, row, n, t, W) {
    var show = state.showTm1 ? structTm1 : struct;
    var pk = P[state.params];
    var bitsPerShare = 11 * pk.n;                       // q = 2^11
    var bytes = struct.expectHoldings * bitsPerShare / 8;

    var head = h('div', { class: 'subset__bar' }, [
      h('div', { class: 'subset__title' }, [
        '子集结构 · n=' + n + '，t=' + t + ' ⇒ 子集大小 s = n−t+1 = ' + struct.subsetSize,
        h('span', { class: 'subset__eq' }, [
          'm = C(' + n + ',' + (t - 1) + ') = ' + struct.count +
          ' · 每代理 C(' + (n - 1) + ',' + (t - 1) + ') = ' + struct.expectHoldings + ' 份 · 约 ' + kb(bytes),
          state.showTm1
            ? h('em', { class: 'subset__miss' }, ' · 当前 W = t−1：缺失 ' + show.missing.length + ' 个子集（已置顶）')
            : null
        ])
      ]),
      h('div', { class: 'subset__legend' }, [
        h('span', { class: 'lg' }, [h('i', { class: 'lg__dot is-w' }), '在 W 内']),
        h('span', { class: 'lg' }, [h('i', { class: 'lg__dot is-member' }), '子集成员']),
        h('span', { class: 'lg' }, [h('i', { class: 'lg__dot is-owner' }), '组合时取它（min(S∩W)）']),
        h('span', { class: 'lg' }, [h('i', { class: 'lg__dot is-missing' }), '缺失（均匀随机）'])
      ])
    ]);

    var colTemplate = '58px repeat(' + n + ', minmax(0, 1fr)) 92px';
    var headerRow = h('div', { class: 'sg sg--head', style: 'grid-template-columns:' + colTemplate }, [
      h('div', { class: 'sg__idx' }, '子集'),
      (function () {
        var cells = [];
        for (var i = 0; i < n; i++) {
          var inW = show.participants.indexOf(i) >= 0;
          cells.push(h('div', { class: 'sg__p' + (inW ? ' is-w' : '') }, [
            pLabel(i), inW ? h('em', null, 'W') : null
          ]));
        }
        return cells;
      })(),
      h('div', { class: 'sg__owner' }, '组合取')
    ]);

    // 缺失子集是这一屏的重点：置顶显示，其余保持原顺序
    var ordered = show.subsets.slice().sort(function (a, b) {
      if (a.covered !== b.covered) return a.covered ? 1 : -1;
      return a.index - b.index;
    });

    var body = h('div', { class: 'sg__body' }, ordered.map(function (sub) {
      var cells = [];
      for (var i = 0; i < n; i++) {
        var member = sub.members.indexOf(i) >= 0;
        var inW = show.participants.indexOf(i) >= 0;
        cells.push(h('div', { class: 'sg__cell' + (inW ? ' is-w' : '') }, [
          h('i', { class: 'sg__dot' + (member ? ' is-member' : '') + (member && inW ? ' is-wmember' : '') })
        ]));
      }
      var ownerCell = sub.covered
        ? h('div', { class: 'sg__owner is-ok' }, [
            h('span', { class: 'sg__ownerName' }, pLabel(sub.owner)),
            h('span', { class: 'sg__ownerTag' }, '提供 partial')
          ])
        : h('div', { class: 'sg__owner is-missing' }, [
            h('span', { class: 'sg__ownerName' }, '缺失'),
            h('span', { class: 'sg__ownerTag' }, 'mask ' + sub.mask.toString(2).padStart(n, '0'))
          ]);
      return h('div', {
        class: 'sg' + (sub.covered ? '' : ' is-missingrow'),
        style: 'grid-template-columns:' + colTemplate,
        data: { tip: 'S' + (sub.index + 1) + ' = {' + sub.labels.join(',') + '} → ' +
          (sub.covered ? 'owner = ' + pLabel(sub.owner) : '与 W 不相交 ⇒ 缺这一份') }
      }, [
        h('div', { class: 'sg__idx' }, 'S' + (sub.index + 1)),
        cells,
        ownerCell
      ]);
    }));

    var holdings = h('div', { class: 'holdings' }, [
      h('div', { class: 'holdings__title' }, '代理持仓'),
      h('div', { class: 'holdings__row' }, (function () {
        var out = [];
        for (var i = 0; i < n; i++) {
          var cnt = struct.holdings[i].length;
          var inW = show.participants.indexOf(i) >= 0;
          out.push(h('div', { class: 'holding' + (inW ? ' is-w' : '') }, [
            h('div', { class: 'holding__name' }, [pLabel(i), inW ? h('span', { class: 'holding__w' }, 'W') : null]),
            h('div', { class: 'holding__count' }, String(cnt)),
            h('div', { class: 'holding__bar' }, h('div', {
              class: 'holding__fill',
              style: 'width:' + (cnt / struct.count * 100).toFixed(1) + '%'
            }))
          ]));
        }
        return out;
      })())
    ]);

    var note = state.showTm1
      ? h('div', { class: 'callout callout--bad' }, [
          h('strong', null, '|W| = t−1：结构性不可行，不是代码拦截。'),
          ' 与 W 不相交的子集恰有 ', h('strong', null, '1'), ' 个（[n]\\W = {' +
          show.missing.map(function (x) { return x.labels.join(','); }).join(' | ') + '}），',
          '那份份额在 Z_q 上均匀随机 ⇒ 联盟手里 Σshare 与 rk 独立。于是 ',
          h('code', null, 'threshold_combine'), ' 的 |W|==t 前置不成立，必须走 ',
          h('code', null, 'threshold_combine_best_effort'), '（官方函数，不手算），缺失子集用 ',
          h('code', null, 'threshold_missing_subset'), ' 取得。'
        ])
      : h('div', { class: 'callout callout--ok' }, [
          h('strong', null, '|W| = t：每个子集都能被覆盖。'),
          ' 子集大小 s = n−t+1 > n−t ⇒ 任意 t 个代理的并集必与每个子集相交，',
          '组合系数全是 1（', h('span', { class: 'mono' }, 'Σshare = rk'), '），所以组合只需要加法，不需要求逆。'
        ]);

    return h('div', { class: 'subset' }, [head, h('div', { class: 'sgwrap' }, [headerRow, body]),
      h('div', { class: 'subset__foot' }, [holdings, note])]);
  }

  /* ======================================================== 图表区块 ===== */
  function chartSection() {
    return h('div', { class: 'chart-grid' }, [
      h('section', { class: 'card', id: 'sec-success' }, [
        UI.sectionHead('② 录制数据 · 成功率', 't 个代理逐配置成功，t−1 个恒为 0',
          '21 个录制配置：柱高 = t 个代理的成功率；轴下菱形 = t−1 个代理（全部 0.00%）。点柱子可联动下方详情。'),
        h('div', { class: 'chart-slot', id: 'slot-success' })
      ]),
      h('section', { class: 'card grid-2', id: 'sec-noise' }, [
        h('div', { class: 'grid-2__a' }, [
          UI.sectionHead('③ 噪声放大', 'm 从 2 到 35，噪声只涨 1.26–4.52×', '独立噪声按 √m 增长，又被 T 里不随 m 变化的大项稀释 ⇒ 放大远小于 m。'),
          h('div', { class: 'chart-slot', id: 'slot-noise' })
        ]),
        h('div', { class: 'grid-2__b' }, [
          UI.sectionHead('④ 零信息性', '缺失份额的 std 与 q/√12 同量级', '(n,t)=(5,3)、联盟 W={P1,P2}、1000 次试验。统计"看起来均匀"是演示，证明在信息论一侧。'),
          h('div', { class: 'chart-slot', id: 'slot-zero' }),
          h('p', { class: 'hint hint--tight' }, [
            '缺失份额 mean = ' + D.zeroInfo.missing_share.mean + '，rk−份额 mean = ' + D.zeroInfo.rk_minus_missing.mean +
            '；两者 std 与 q/√12 = ' + D.zeroInfo.uniform_theory.std + ' 同量级 ⇒ 联盟看到的量与 rk 独立。'
          ])
        ])
      ]),
      h('section', { class: 'card', id: 'sec-time' }, [
        UI.sectionHead('⑤ 三阶段耗时', '耗时几乎全在 m 份部分重加密上',
          '单核 CPU 功能基线（ms，与成功率同批试验）；分享与组合只有千分之几 ⇒ C3 的落点就是这 m 份互相独立的 partial。'),
        h('div', { class: 'chart-slot', id: 'slot-time' })
      ])
    ]);
  }

  function renderCharts() {
    guard('图表', function () { renderChartsInner(); });
  }

  function renderChartsInner() {
    var series = D.order.map(function (p) {
      return { id: p, color: C.COLOR[p], rows: D.rows[p].map(function (r) { var o = Object.assign({}, r); o.params = p; return o; }) };
    });
    var sel = state.selected;

    var s1 = document.getElementById('slot-success');
    if (s1) { UI.clear(s1).appendChild(C.successChart({ series: series, selected: sel })); }
    var s2 = document.getElementById('slot-noise');
    if (s2) { UI.clear(s2).appendChild(C.noiseChart({ series: series, selected: sel })); }
    var s3 = document.getElementById('slot-time');
    if (s3) { UI.clear(s3).appendChild(C.timeChart({ rows: D.flat, selected: sel })); }
    var s4 = document.getElementById('slot-zero');
    if (s4) { UI.clear(s4).appendChild(C.zeroInfoChart(D.zeroInfo)); }
  }

  /* ========================================================== 数据表 ===== */
  function tableSection() {
    var rows = D.flat.filter(function (r) {
      if (state.filter !== 'ALL' && r.params !== state.filter) return false;
      if (state.onlyFull && r.succT < 99.999) return false;
      return true;
    });

    var filters = h('div', { class: 'seg seg--sm' }, [{
      id: 'ALL', label: '全部 21 行', color: null
    }].concat(D.order.map(function (p) {
      return { id: p, label: p, color: C.COLOR[p] };
    })).map(function (it) {
      return h('button', {
        class: 'seg__btn' + (state.filter === it.id ? ' is-on' : ''),
        attrs: { type: 'button' }, data: { act: 'filter', id: it.id }
      }, [
        it.color ? h('span', { class: 'seg__dot', style: 'background:' + it.color }) : null,
        h('span', { class: 'seg__label' }, it.label)
      ]);
    }));

    var cols = [
      { key: 'params', label: '参数集', align: 'left', render: function (r) {
          return h('span', { class: 'cell-swatch' }, [
            h('i', { style: 'background:' + C.COLOR[r.params] }), r.params
          ]);
        } },
      { key: 'label', label: '配置', align: 'left', mono: true },
      { key: 'm', label: 'm', align: 'right', mono: true },
      { key: 'succT', label: 't 个成功', align: 'right', mono: true,
        render: function (r) { return h('span', { class: r.succT > 99.999 ? 'v-ok' : 'v-warn' }, UI.fmtPct(r.succT, 2)); } },
      { key: 'succTm1', label: 't−1 个成功', align: 'right', mono: true,
        render: function (r) { return h('span', { class: 'v-fail' }, UI.fmtPct(r.succTm1, 2)); } },
      { key: 'ratio', label: '噪声放大', align: 'right', mono: true, render: function (r) { return UI.fmtRatio(r.ratio); } },
      { key: 'shareMs', label: '分享 ms', align: 'right', mono: true, render: function (r) { return r.shareMs.toFixed(4); } },
      { key: 'partialsMs', label: '部分 ms', align: 'right', mono: true, render: function (r) { return r.partialsMs.toFixed(4); } },
      { key: 'combineMs', label: '组合 ms', align: 'right', mono: true, render: function (r) { return r.combineMs.toFixed(4); } }
    ];

    var tbl = UI.table(cols, rows, {
      rowClass: function (r) {
        return (state.selected.params === r.params && state.selected.label === r.label) ? 'is-selected' : '';
      },
      onRow: function (r) { selectRow(r); },
      rowTip: function (r) { return r.params + ' ' + r.label + ' · m=' + r.m + ' · 点这一行联动图表'; }
    });

    var provs = D.order.map(function (p) {
      var pv = D.provenance[p];
      return h('div', { class: 'provrow' }, [
        h('span', { class: 'provrow__dot', style: 'background:' + C.COLOR[p] }),
        h('code', null, pv.file),
        h('span', { class: 'provrow__meta' }, pv.bytes + ' B · mtime ' + pv.mtime + ' · ' + pv.trials + ' 次试验')
      ]);
    });

    return h('section', { class: 'card', id: 'sec-table' }, [
      UI.sectionHead('⑥ 录制数据表', '全部 21 个配置（3 参数集 × 7 配置）',
        '每行来自 bench/results/c1_*.csv；点一行把它设为图表高亮。t−1 列全为 0.00% 是这份表最硬的一列。'),
      h('div', { class: 'table-tools' }, [
        filters,
        h('label', { class: 'switch switch--sm' }, [
          h('input', {
            attrs: { type: 'checkbox' }, checked: state.onlyFull ? 'checked' : null,
            data: { act: 'onlyfull' },
            on: { change: function (e) { state.onlyFull = e.target.checked; renderTable(); } }
          }),
          h('span', { class: 'switch__track' }, h('span', { class: 'switch__knob' })),
          h('span', { class: 'switch__label' }, '只看 100% 成功')
        ]),
        h('span', { class: 'table-count' }, rows.length + ' 行')
      ]),
      tbl,
      h('div', { class: 'prov' }, [h('div', { class: 'prov__title' }, '数据来源（行数与表头与 CSV 一致）')].concat(provs))
    ]);
  }

  /* ========================================================== 口径 ====== */
  function notesSection() {
    var space = [
      { p: 'EES1499', base: '~180（18%）', max: '≤ 15（m=35 仍 90%）', cfg: '(6,3) 及以下' },
      { p: 'EES1171', base: '~250（24%）', max: '≤ 15（m=15 仍 100%）', cfg: '(6,3) 及以下' },
      { p: 'EES439', base: '~415（41%）', max: '≤ 4（m=5 已 90%、m=10 仅 10%）', cfg: '(2,2)(3,2)(4,2)' }
    ];
    var cols = [
      { key: 'p', label: '参数集', align: 'left', render: function (r) {
          return h('span', { class: 'cell-swatch' }, [h('i', { style: 'background:' + C.COLOR[r.p] }), r.p]);
        } },
      { key: 'base', label: '基线噪声（占 q/2 = 1024）', align: 'left', mono: true },
      { key: 'max', label: '100% 成功的最大 m', align: 'left', mono: true },
      { key: 'cfg', label: '典型可用 (N,t)', align: 'left', mono: true }
    ];

    return h('section', { class: 'card', id: 'sec-notes' }, [
      UI.sectionHead('⑦ 结论与口径', '怎么读这张表，以及它不主张什么',
        '界面上的每个数字都能追到 CSV 或 (n,t,W) 的结构定义；live 与录制分开标注。'),
      h('div', { class: 'notes' }, [
        h('div', { class: 'notes__col' }, [
          h('h3', null, '三条读法'),
          h('ol', { class: 'readings' }, [
            h('li', null, [
              h('strong', null, 't−1 恒 0.00% 是结构性的。'), ' 那是"尽力而为组合"（真的把能拿到的份额都加上）的结果，',
              '不是 if 判断把请求拦下来：缺的那份在 Z_q 上均匀随机，Σshare 与 rk 独立。'
            ]),
            h('li', null, [
              h('strong', null, '100% = 逐系数还原。'), ' 每个 100% 格子都跑完了"分享 → t 份 partial → 组合 → 接收者解密"，',
              '并逐系数比对明文（walkthrough 可手工核对）。'
            ]),
            h('li', null, [
              h('strong', null, '边界区看成功率，不看噪声均值。'), ' m 变大时噪声放大饱和在 ~2.4–2.5× 是 ±q/2 绕回造成的；',
              '噪声靠近 1024 时 mod 3 结构被破坏，成功率才掉下来。'
            ])
          ]),
          h('h3', null, '可用参数空间'),
          UI.table(cols, space, { compact: true })
        ]),
        h('div', { class: 'notes__col' }, [
          h('h3', null, '不主张什么（沿用 README §7）'),
          h('ul', { class: 'caveats' }, [
            h('li', null, ['不主张 NTRUReEncrypt 本身的安全性；C1 只是把"单代理持有完整委托权"提高到"需 t 个共谋"。']),
            h('li', null, [h('strong', null, '任意 t 个代理可合谋'), '还原 rk；', h('strong', null, '组合者本身未门限化'),
              '——它看到 Σ 之后的中间量，属于必须信任的位置。']),
            h('li', null, [h('code', null, 'partial'), ' 含 p·e 掩码，只泄露 share mod p；由 Σshare = rk 且 f_A ≡ 1 (mod p) ⇒ 泄露量只是 rk mod p = f_B⁻¹ mod p，属接收者自己的信息。']),
            h('li', null, ['零信息性的 1000 次统计是"看起来均匀"的演示；', h('strong', null, '证明'), '在信息论一侧（2.1.2 节），两者分开写。'])
          ]),
          h('h3', null, '数据口径'),
          h('ul', { class: 'caveats' }, [
            h('li', null, ['运行机器：', D.provenance.host, '。']),
            h('li', null, ['命令：', h('code', null, D.provenance.runner), '；试验数 20 / 10 / 10。']),
            h('li', null, ['耗时与机器强相关，换了编译器和 ', h('code', null, '-march=native'), ' 会变；成功率与噪声放大是代数性质，不随机器变。']),
            h('li', null, ['C1 的批量吞吐不在这里：单核 ms 级是功能基线，批量由 C3 的 GPU 核给出。'])
          ])
        ])
      ])
    ]);
  }

  /* ======================================================== 状态变更 ===== */
  function setParams(p) {
    state.params = p;
    var row = curRow();
    state.W = firstW(row.t, row.n);
    renderProbe();
    renderTable();
    return row;
  }

  function setCfg(i) {
    state.cfgIdx = i;
    var row = curRow();
    state.W = firstW(row.t, row.n);
    state.selected = { params: state.params, label: row.label };
    renderProbe(); renderCharts(); renderTable();
  }

  function firstW(t, n) {
    var out = [];
    for (var i = 0; i < t && i < n; i++) out.push(i);
    return out;
  }

  function toggleW(i, n, t) {
    var idx = state.W.indexOf(i);
    if (idx >= 0) {
      if (state.W.length <= 1) return;      // 至少留 1 个
      state.W.splice(idx, 1);
    } else {
      state.W.push(i);
      if (state.W.length > t) state.W.shift();   // 超过 t 就挤掉最早选的
    }
    state.W.sort(function (a, b) { return a - b; });
    if (!state.showTm1 && state.W.length !== t) state.W = firstW(t, n);
    renderProbe();
  }

  function setToggle(act, on) {
    if (act === 'tm1') state.showTm1 = on;
    else if (act === 'sample') state.sample = on;
    renderProbe();
  }

  function selectRow(r) {
    state.selected = { params: r.params, label: r.label };
    state.params = r.params;
    state.cfgIdx = D.rows[r.params].findIndex(function (x) { return x.label === r.label; });
    state.W = firstW(r.t, r.n);
    renderProbe(); renderCharts(); renderTable();
  }

  /* -------------------------------------------------------- 运行探针 ---- */
  function runProbe() {
    if (state.probe.status === 'running') return;
    var token = ++state.probe.token;
    state.probe.status = 'running';
    state.probe.stage = 0;
    renderProbe();

    var stages = [
      '① cnf_share(rk, n, t)：子集加性分享，末份由 Σshare = rk 定',
      '② proxy_partials：' + curRow().m + ' 份独立 partial（各加一次 p·e 掩码）',
      '③ threshold_combine(W)：Σ owner-partial → 接收者 f_B 解密比对'
    ];
    var step = 0;
    function tick() {
      if (token !== state.probe.token) return;
      if (step < stages.length) {
        var el = document.querySelector('[data-runtext]');
        if (el) el.textContent = stages[step];
        // 第一阶段就该看到条子动起来：+1 之后再除，避免第一格停在 0%
        progress((step + 1) / (stages.length + 1));
        step++;
        setTimeout(tick, 260);
        return;
      }
      progress(1);
      state.probe.status = 'done';
      state.probe.stage = 3;
      var d = new Date();
      state.probe.at = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
      renderProbe();
    }
    setTimeout(tick, 120);
  }

  function progress(frac) {
    var bar = document.querySelector('[data-runbar]');
    if (bar) bar.style.width = (frac * 100).toFixed(0) + '%';
  }

  /* ========================================================== 渲染 ===== */
  function guard(label, fn) {
    try { fn(); } catch (err) {
      // 界面自己吞错最容易变成"空白卡片"，这里直接摊开给人看
      if (window.console) console.error('[' + label + ']', err);
      var host = document.getElementById('page-errors');
      if (host) {
        host.appendChild(h('div', { class: 'callout callout--bad', style: 'margin-top:8px' }, [
          h('strong', null, label + ' 渲染失败：'), String(err && err.message || err)
        ]));
      }
    }
  }

  function renderProbe() {
    var mount = document.getElementById('probe-mount');
    if (!mount) return;
    guard('现场探针', function () {
      var node = probeCard();          // 先构建：抛错时保留旧内容，不会留白
      UI.clear(mount).appendChild(node);
    });
  }

  function renderTable() {
    var mount = document.getElementById('table-mount');
    if (!mount) return;
    guard('数据表', function () {
      var node = tableSection();
      UI.clear(mount).appendChild(node);
    });
  }

  function mount(root) {
    UI.ensureTip();
    dom.mount = root;

    UI.clear(root).append(
      h('div', { class: 'page' }, [
        h('div', { id: 'page-errors' }),
        hero(),
        kpiRow(),
        h('div', { id: 'probe-mount' }),
        chartSection(),
        h('div', { id: 'table-mount' }),
        notesSection(),
        h('footer', { class: 'page-foot' }, [
          'C1 · 全部数字来自 ', h('code', null, 'bench/results/c1_*.csv'),
          ' 与 ', h('code', null, 'src/core/threshold.h'),
          ' 的结构定义；后续里程碑把 ', h('code', null, '/api/c1/run'), ' 接上后同一页面即可现场跑真探针。'
        ])
      ])
    );

    renderProbe();
    renderCharts();
    renderTable();
  }

  /* 事件委托：整个页面一次绑定 */
  function bind(root) {
    root.addEventListener('click', function (e) {
      var pick = e.target.closest('[data-sel]');
      if (pick) {
        var key = pick.getAttribute('data-sel').split('|');
        var hit = D.rows[key[0]].find(function (x) { return x.label === key[1]; });
        if (hit) selectRow(Object.assign({ params: key[0] }, hit));
        return;
      }
      var t = e.target.closest('[data-act]');
      if (!t) return;
      var act = t.dataset.act;
      if (act === 'params') setParams(t.dataset.id);
      else if (act === 'cfg') setCfg(Number(t.dataset.idx));
      else if (act === 'w') toggleW(Number(t.dataset.p), curRow().n, curRow().t);
      else if (act === 'filter') { state.filter = t.dataset.id; renderTable(); }
      else if (act === 'run') runProbe();
    });
    root.addEventListener('change', function (e) {
      var t = e.target.closest('[data-act]');
      if (!t) return;
      if (t.dataset.act === 'tm1' || t.dataset.act === 'sample') setToggle(t.dataset.act, t.checked);
    });
  }

  global.PageC1 = { mount: mount, bind: bind, state: state };
})(window);
