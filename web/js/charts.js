/* ============================================================================
 *  自绘 SVG 图表（无第三方库，无 CDN）
 *  文件：web/js/charts.js
 *
 *  规矩（与报告口径一致）：
 *    · viewBox 响应式，线 2px、点 8px；图例必现
 *    · 不用双轴；对数轴只标 10^k 或实际刻度值
 *    · 每张图都配一张 <details> 表格视图（数字可比对）
 *    · 序列颜色按实体固定：EES439 橙 / EES1171 蓝 / EES1499 青
 * ==========================================================================*/
(function (global) {
  'use strict';
  var UI = global.UI, h = UI.h, s = UI.s;

  var COLOR = {
    EES439: '#eb6834',
    EES1171: '#2a78d6',
    EES1499: '#1baf7a',
    zero: '#c2352f',
    ink: '#0f172a',
    muted: '#5b6b86',
    line: '#dbe3f0',
    grid: '#eef2f8'
  };

  var W = 760;
  var FONT = '11px ui-sans-serif, "Segoe UI", "Microsoft YaHei", sans-serif';

  function txt(x, y, str, opts) {
    opts = opts || {};
    return s('text', {
      x: x, y: y,
      'font-size': opts.size || 10.5,
      'font-family': FONT,
      fill: opts.fill || COLOR.muted,
      'text-anchor': opts.anchor || 'middle',
      'dominant-baseline': opts.baseline || 'middle',
      'font-weight': opts.weight || null,
      transform: opts.transform || null
    }, str);
  }

  function frame(height, m) {
    m = m || {};
    var svg = s('svg', {
      viewBox: '0 0 ' + W + ' ' + height,
      role: 'img',
      preserveAspectRatio: 'xMidYMid meet'
    });
    return {
      svg: svg,
      left: m.l === undefined ? 46 : m.l,
      right: m.r === undefined ? 16 : m.r,
      top: m.t === undefined ? 16 : m.t,
      bottom: m.b === undefined ? 30 : m.b,
      height: height
    };
  }

  function plotBox(f) {
    return { x0: f.left, x1: W - f.right, y0: f.top, y1: f.height - f.bottom };
  }

  function legend(items, note) {
    return h('div', { class: 'legend' }, [
      h('div', { class: 'legend__items' }, items.map(function (it) {
        return h('span', { class: 'legend__item' }, [
          h('span', { class: 'legend__swatch' + (it.shape ? ' is-' + it.shape : ''), style: 'background:' + it.color + (it.dashed ? ';opacity:.55' : '') }),
          h('span', { class: 'legend__label' }, it.label)
        ]);
      })),
      note ? h('div', { class: 'legend__note' }, note) : null
    ]);
  }

  function frameWrap(svg, extra) {
    return h('div', { class: 'chart' }, [h('div', { class: 'chart__svg' }, svg), extra || null]);
  }

  /* ------------------------------------------------- 对数刻度辅助 ---- */
  function logScale(d0, d1, x0, x1) {
    var l0 = Math.log(d0), l1 = Math.log(d1);
    return {
      pos: function (v) { return x0 + (Math.log(v) - l0) / (l1 - l0) * (x1 - x0); },
      domain: [d0, d1]
    };
  }

  function linScale(d0, d1, y0, y1) {
    return {
      pos: function (v) { return y1 - (v - d0) / (d1 - d0) * (y1 - y0); },
      domain: [d0, d1]
    };
  }

  function hLines(f, box, yScale, ticks, fmt) {
    var g = s('g');
    ticks.forEach(function (t) {
      var y = yScale.pos(t);
      g.appendChild(s('line', { x1: box.x0, x2: box.x1, y1: y, y2: y, stroke: COLOR.grid, 'stroke-width': 1 }));
      g.appendChild(txt(box.x0 - 8, y, fmt(t), { anchor: 'end', size: 10 }));
    });
    return g;
  }

  /* ==========================================================================
   *  图 1：t 个代理的成功率（分组柱）+ t−1 恒 0 的基线标记
   * ======================================================================*/
  function successChart(spec) {
    var height = 316;
    var f = frame(height, { l: 44, r: 16, t: 18, b: 52 });
    var box = plotBox(f);
    var series = spec.series;                 // [{id, color, rows:[{label,m,succT,succTm1}]}]
    var labels = series[0].rows.map(function (r) { return r.label; });
    var gw = (box.x1 - box.x0) / labels.length;
    var barW = 17, gap = 5;
    var groupW = series.length * barW + (series.length - 1) * gap;
    var y = linScale(0, 100, box.y0, box.y1);

    f.svg.appendChild(hLines(f, box, y, [0, 25, 50, 75, 100], function (t) { return t + '%'; }));

    // 100% 参考线：让"贴顶"一眼可读
    f.svg.appendChild(s('line', {
      x1: box.x0, x2: box.x1, y1: y.pos(100), y2: y.pos(100),
      stroke: COLOR.line, 'stroke-width': 1, 'stroke-dasharray': '4 3'
    }));

    labels.forEach(function (lab, gi) {
      var cx = box.x0 + gw * gi + gw / 2;
      var selected = spec.selected && spec.selected.label === lab;
      if (selected) {
        f.svg.appendChild(s('rect', {
          x: box.x0 + gw * gi + 2, y: box.y0, width: gw - 4, height: box.y1 - box.y0,
          fill: '#f2f6fd'
        }));
      }
      series.forEach(function (ser, si) {
        var row = ser.rows[gi];
        var x = cx - groupW / 2 + si * (barW + gap);
        var hgt = Math.max(0, box.y1 - y.pos(row.succT));
        var op = 1;
        // 0% 也要留一条可见的矮条：否则那根柱子既看不见也点不到
        var barH = Math.max(hgt, 3);
        var bar = s('rect', {
          x: x, y: box.y1 - barH, width: barW, height: barH,
          rx: 2, fill: ser.color, opacity: row.succT > 0 ? op : 0.55, cursor: 'pointer',
          'data-sel': row.params + '|' + row.label,
          'data-tip': row.params + ' ' + row.label + '：t 个代理 ' + row.succT.toFixed(2) + '%（m=' + row.m + '）'
        });
        f.svg.appendChild(bar);
        if (row.succT < 99.999) {
          f.svg.appendChild(txt(x + barW / 2, y.pos(row.succT) - 8, String(Math.round(row.succT)),
            { size: 9.5, fill: ser.color, weight: 600 }));
        }
      });
      // t−1 基线：恒为 0，用空心菱形标在轴上
      var zx = cx;
      f.svg.appendChild(s('path', {
        d: 'M' + zx + ' ' + (box.y1 + 7) + ' l4 4 l-4 4 l-4 -4 z',
        fill: 'none', stroke: COLOR.zero, 'stroke-width': 1.4,
        'data-tip': '所有参数集 ' + lab + '：t−1 个代理 = 0.00%（尽力而为组合，结构性失败）'
      }));
      f.svg.appendChild(txt(cx, box.y1 + 20, lab, { size: 10.5 }));
      var mAvg = series.reduce(function (a, x2) { return a + x2.rows[gi].m; }, 0) / series.length;
      f.svg.appendChild(txt(cx, box.y1 + 33, 'm=' + Math.round(mAvg), { size: 9, fill: '#93a1b8' }));
    });

    // 轴
    f.svg.appendChild(s('line', { x1: box.x0, x2: box.x1, y1: box.y1, y2: box.y1, stroke: COLOR.line, 'stroke-width': 1 }));
    f.svg.appendChild(txt(box.x0 - 8, box.y0 - 6, '', { size: 9 }));

    var lg = legend(series.map(function (ser) {
      return { color: ser.color, label: ser.id };
    }).concat([{ color: COLOR.zero, label: 't−1 个代理（恒 0.00%，轴下菱形）', shape: 'hollow' }]),
      'y = 成功率，x = 门限配置 (n,t)；m = C(n,t−1) 为子集数');

    var cols = [
      { key: 'label', label: '配置', align: 'left' },
      { key: 'm', label: 'm', align: 'right', mono: true }
    ];
    series.forEach(function (ser) {
      cols.push({ key: ser.id, label: ser.id + ' t', align: 'right', mono: true, render: function (r) { return UI.fmtPct(r.__succ[ser.id], 2); } });
    });
    cols.push({ key: 'tm1', label: 't−1', align: 'right', mono: true, render: function (r) { return UI.fmtPct(r.__succTm1, 2); } });

    var tableRows = labels.map(function (lab, gi) {
      var o = { label: lab, m: series[0].rows[gi].m, __succ: {}, __succTm1: 0 };
      series.forEach(function (ser) {
        o.__succ[ser.id] = ser.rows[gi].succT;
        o.__succTm1 = Math.max(o.__succTm1, ser.rows[gi].succTm1);
      });
      return o;
    });

    return frameWrap(f.svg, [
      lg,
      UI.detailsTable('表格视图（成功率 %）', UI.table(cols, tableRows, { compact: true }))
    ]);
  }

  /* ==========================================================================
   *  图 2：噪声放大 vs 子集数 m（对数 x）
   * ======================================================================*/
  function noiseChart(spec) {
    var height = 292;
    var f = frame(height, { l: 46, r: 58, t: 18, b: 44 });
    var box = plotBox(f);
    var series = spec.series;
    var x = logScale(1.6, 42, box.x0, box.x1);
    var y = linScale(1, 5.2, box.y0, box.y1);

    f.svg.appendChild(hLines(f, box, y, [1, 2, 3, 4, 5], function (t) { return t.toFixed(1) + '×'; }));

    [2, 3, 5, 10, 15, 35].forEach(function (t) {
      var px = x.pos(t);
      f.svg.appendChild(s('line', { x1: px, x2: px, y1: box.y0, y2: box.y1, stroke: COLOR.grid, 'stroke-width': 1 }));
      f.svg.appendChild(txt(px, box.y1 + 16, String(t), { size: 10 }));
    });
    f.svg.appendChild(s('line', { x1: box.x0, x2: box.x1, y1: box.y1, y2: box.y1, stroke: COLOR.line, 'stroke-width': 1 }));
    f.svg.appendChild(txt((box.x0 + box.x1) / 2, box.y1 + 32, 'm = C(n,t−1)（对数轴）', { size: 10 }));

    series.forEach(function (ser) {
      var pts = ser.rows.map(function (r) { return { r: r, px: x.pos(r.m), py: y.pos(r.ratio) }; });
      f.svg.appendChild(s('path', {
        d: pts.map(function (p, i) { return (i ? 'L' : 'M') + p.px + ' ' + p.py; }).join(' '),
        fill: 'none', stroke: ser.color, 'stroke-width': 2, opacity: 0.5
      }));
      pts.forEach(function (p) {
        var sel = spec.selected && spec.selected.label === p.r.label;
        f.svg.appendChild(s('circle', {
          cx: p.px, cy: p.py, r: sel ? 6.5 : 4.5,
          fill: sel ? ser.color : '#fff', stroke: ser.color, 'stroke-width': 2,
          'data-tip': p.r.params + ' ' + p.r.label + '：噪声放大 ' + p.r.ratio.toFixed(3) + '×，m=' + p.r.m
        }));
      });
      // 端点直标
      var last = pts[pts.length - 1];
      f.svg.appendChild(txt(last.px + 10, last.py, ser.id, { size: 10, anchor: 'start', fill: ser.color, weight: 600 }));
    });

    var lg = legend(series.map(function (ser) { return { color: ser.color, label: ser.id }; }),
      '噪声放大 = 门限噪声 / 基线噪声；独立噪声按 √m 增长，被 g·s + F·M 稀释 ⇒ 远小于 m');

    var cols = [
      { key: 'params', label: '参数集', align: 'left' },
      { key: 'label', label: '配置', align: 'left' },
      { key: 'm', label: 'm', align: 'right', mono: true },
      { key: 'ratio', label: '噪声放大', align: 'right', mono: true, render: function (r) { return UI.fmtRatio(r.ratio); } },
      { key: 't', label: 't 个成功', align: 'right', mono: true, render: function (r) { return UI.fmtPct(r.succT, 2); } }
    ];
    var rows = [];
    series.forEach(function (ser) { ser.rows.forEach(function (r) { rows.push(r); }); });

    return frameWrap(f.svg, [
      lg,
      UI.detailsTable('表格视图（噪声放大）', UI.table(cols, rows, { compact: true }))
    ]);
  }

  /* ==========================================================================
   *  图 3：三阶段耗时（堆叠柱，线性 ms）
   * ======================================================================*/
  function timeChart(spec) {
    var height = 322;
    var f = frame(height, { l: 52, r: 16, t: 18, b: 62 });
    var box = plotBox(f);
    var rows = spec.rows;                                     // 21 行，按参数集分组
    var maxV = 0;
    rows.forEach(function (r) { maxV = Math.max(maxV, r.partialsMs + r.shareMs + r.combineMs); });
    var top = Math.ceil(maxV / 20) * 20;
    var y = linScale(0, top, box.y0, box.y1);
    var n = rows.length;
    var slot = (box.x1 - box.x0) / n;
    var barW = Math.min(22, slot * 0.7);

    var step = top > 90 ? 40 : 20;
    var ticks = [];
    for (var t = 0; t <= top; t += step) ticks.push(t);
    f.svg.appendChild(hLines(f, box, y, ticks, function (v) { return v + ''; }));

    var stages = [
      { key: 'partialsMs', label: '部分重加密', color: '#2a78d6' },
      { key: 'shareMs', label: '分享', color: '#081E5B' },
      { key: 'combineMs', label: '组合', color: '#8fbcf5' }
    ];

    rows.forEach(function (r, i) {
      var cx = box.x0 + slot * i + slot / 2;
      var acc = 0;
      var selected = spec.selected && spec.selected.params === r.params && spec.selected.label === r.label;
      stages.forEach(function (st) {
        var v = r[st.key];
        var y1 = y.pos(acc + v), y0 = y.pos(acc);
        var hgt = y0 - y1;
        var op = selected ? 1 : 0.55;
        f.svg.appendChild(s('rect', {
          x: cx - barW / 2, y: y1, width: barW, height: Math.max(hgt, v > 0 ? 1.2 : 0),
          fill: st.color, opacity: op,
          stroke: selected ? '#081E5B' : null, 'stroke-width': selected ? 1 : null,
          cursor: 'pointer', 'data-sel': r.params + '|' + r.label,
          'data-tip': r.params + ' ' + r.label + ' · ' + st.label + '：' + UI.fmtMs(v)
        }));
        acc += v;
      });
      f.svg.appendChild(txt(cx, box.y1 + 15, r.label, { size: 9.5, transform: 'rotate(-38 ' + cx + ' ' + (box.y1 + 15) + ')', anchor: 'end' }));
    });

    // 参数集分组括号
    var groups = [];
    rows.forEach(function (r, i) {
      var g = groups[groups.length - 1];
      if (!g || g.params !== r.params) groups.push({ params: r.params, from: i, to: i });
      else g.to = i;
    });
    groups.forEach(function (g) {
      var xa = box.x0 + slot * g.from + 2, xb = box.x0 + slot * (g.to + 1) - 2;
      f.svg.appendChild(s('line', { x1: xa, x2: xb, y1: box.y1 + 48, y2: box.y1 + 48, stroke: COLOR[g.params] || COLOR.line, 'stroke-width': 2 }));
      f.svg.appendChild(txt((xa + xb) / 2, box.y1 + 56, g.params, { size: 10, fill: COLOR[g.params] }));
    });

    f.svg.appendChild(s('line', { x1: box.x0, x2: box.x1, y1: box.y1, y2: box.y1, stroke: COLOR.line, 'stroke-width': 1 }));

    var lg = legend(stages.map(function (st) { return { color: st.color, label: st.label }; }),
      '顺序：分享 → m 份部分重加密 → 组合；部分重加密随 m 线性增长且各份互相独立 ⇒ C3 的批量维');

    var cols = [
      { key: 'params', label: '参数集', align: 'left' },
      { key: 'label', label: '配置', align: 'left' },
      { key: 'm', label: 'm', align: 'right', mono: true },
      { key: 'shareMs', label: '分享', align: 'right', mono: true, render: function (r) { return r.shareMs.toFixed(3); } },
      { key: 'partialsMs', label: '部分重加密', align: 'right', mono: true, render: function (r) { return r.partialsMs.toFixed(3); } },
      { key: 'combineMs', label: '组合', align: 'right', mono: true, render: function (r) { return r.combineMs.toFixed(3); } }
    ];

    return frameWrap(f.svg, [
      lg,
      UI.detailsTable('表格视图（ms）', UI.table(cols, rows, { compact: true }))
    ]);
  }

  /* ==========================================================================
   *  图 4：零信息性 — 标准差与 q/√12 的对比（横向条）
   * ======================================================================*/
  function zeroInfoChart(zi) {
    var maxV = 700;
    var bars = [
      { label: '缺失份额 std', v: zi.missing_share.std, color: '#2a78d6', note: 'mean ' + zi.missing_share.mean },
      { label: 'rk − 缺失份额 std', v: zi.rk_minus_missing.std, color: '#081E5B', note: 'mean ' + zi.rk_minus_missing.mean },
      { label: '均匀分布 q/√12', v: zi.uniform_theory.std, color: '#1baf7a', note: '理论值' }
    ];
    var rows = bars.map(function (b) {
      return h('div', { class: 'zrow' }, [
        h('div', { class: 'zrow__label' }, b.label),
        h('div', { class: 'zrow__track' }, [
          h('div', {
            class: 'zrow__fill',
            style: 'width:' + (b.v / maxV * 100).toFixed(1) + '%;background:' + b.color,
            'data-tip': b.label + ' = ' + b.v + '（' + b.note + '）'
          })
        ]),
        h('div', { class: 'zrow__value' }, UI.fmtNum(b.v, 1))
      ]);
    });
    return h('div', { class: 'zbars' }, rows);
  }

  global.Charts = {
    COLOR: COLOR,
    successChart: successChart,
    noiseChart: noiseChart,
    timeChart: timeChart,
    zeroInfoChart: zeroInfoChart
  };
})(window);
