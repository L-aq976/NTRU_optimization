/* ============================================================================
 *  最小 DOM / 格式化助手（无第三方库）
 *  文件：web/js/ui.js
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- DOM ---- */
  function append(parent, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(parent, c); }); return; }
    if (child instanceof Node) { parent.appendChild(child); return; }
    parent.appendChild(document.createTextNode(String(child)));
  }

  /**
   * h('div', {class:'x', text:'hi', on:{click:fn}, data:{k:'v'}}, [children])
   */
  function h(tag, props, children) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'on') Object.keys(v).forEach(function (e) { el.addEventListener(e, v[e]); });
        else if (k === 'data') Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
        else if (k === 'style') el.setAttribute('style', v);
        else if (k === 'attrs') Object.keys(v).forEach(function (a) { el.setAttribute(a, v[a]); });
        else el.setAttribute(k, v);
      });
    }
    append(el, children);
    return el;
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, children) {
    var el = document.createElementNS(SVGNS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'text') el.textContent = v;
        else if (k === 'on') Object.keys(v).forEach(function (e) { el.addEventListener(e, v[e]); });
        else el.setAttribute(k, v);
      });
    }
    if (children !== null && children !== undefined) {
      [].concat(children).forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
      });
    }
    return el;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  /* ---------------------------------------------------------- 格式化 ---- */
  function fmtPct(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var d = digits === undefined ? 0 : digits;
    return v.toFixed(d) + '%';
  }

  // 耗时：小于 1 ms 给三位小数，否则两位
  function fmtMs(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (v < 0.01) return v.toFixed(4) + ' ms';
    if (v < 1) return v.toFixed(3) + ' ms';
    return v.toFixed(2) + ' ms';
  }

  function fmtNum(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return v.toFixed(digits === undefined ? 3 : digits);
  }

  function fmtRatio(v) { return fmtNum(v, 3) + '×'; }

  // 科学计数友好：整数原样，其余保留至多两位
  function fmtCompact(v) {
    if (v >= 1000) return Math.round(v).toLocaleString('zh-CN');
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toFixed(2)));
  }

  /* ------------------------------------------------------------ 徽章 ---- */
  var ICON = { ok: '✓', fail: '✗', warn: '⚠', info: 'ⓘ', demo: '◐', run: '▸', idle: '·' };

  function badge(text, kind, title) {
    return h('span', {
      class: 'badge badge--' + (kind || 'info'),
      title: title || null
    }, [
      h('span', { class: 'badge__icon', attrs: { 'aria-hidden': 'true' } }, ICON[kind] || ICON.info),
      h('span', { class: 'badge__text' }, text)
    ]);
  }

  /* ----------------------------------------------------------- 提示 ---- */
  var tipEl = null;
  function ensureTip() {
    if (tipEl) return tipEl;
    tipEl = h('div', { class: 'tip', attrs: { role: 'tooltip' } });
    document.body.appendChild(tipEl);
    document.addEventListener('mousemove', function (e) {
      var t = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!t) { tipEl.classList.remove('is-on'); return; }
      tipEl.textContent = t.getAttribute('data-tip');
      tipEl.classList.add('is-on');
      var x = e.clientX + 14, y = e.clientY + 16;
      var w = tipEl.offsetWidth, hh = tipEl.offsetHeight;
      if (x + w > window.innerWidth - 8) x = e.clientX - w - 12;
      if (y + hh > window.innerHeight - 8) y = e.clientY - hh - 12;
      tipEl.style.left = x + 'px';
      tipEl.style.top = y + 'px';
    }, { passive: true });
    document.addEventListener('mouseleave', function () { tipEl.classList.remove('is-on'); });
    window.addEventListener('scroll', function () { tipEl.classList.remove('is-on'); }, { passive: true });
    return tipEl;
  }

  function tipAttr(text) { ensureTip(); return text; }

  /* ------------------------------------------------------------ 表格 ---- */
  /**
   * columns: [{key, label, align, width, render(row)->node|string, tip}]
   */
  function table(columns, rows, opts) {
    opts = opts || {};
    var thead = h('thead', null, h('tr', null, columns.map(function (c) {
      return h('th', { class: (c.align ? 'is-' + c.align : ''), attrs: { scope: 'col' } }, c.label);
    })));
    var tbody = h('tbody');
    rows.forEach(function (r, ri) {
      var tr = h('tr', {
        class: opts.rowClass ? opts.rowClass(r, ri) : null,
        data: { idx: String(ri) },
        on: opts.onRow ? { click: function () { opts.onRow(r, ri, tr); } } : null
      }, columns.map(function (c) {
        var v = c.render ? c.render(r, ri) : r[c.key];
        var cell = h('td', { class: (c.align ? 'is-' + c.align : '') + (c.mono ? ' is-mono' : '') });
        append(cell, v);
        return cell;
      }));
      if (opts.rowTip) tr.setAttribute('data-tip', tipAttr(opts.rowTip(r)));
      tbody.appendChild(tr);
    });
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table' + (opts.compact ? ' is-compact' : '') }, [thead, tbody]));
  }

  /* ------------------------------------------------------- 折叠表格视图 ---- */
  function detailsTable(summary, node) {
    return h('details', { class: 'details' }, [
      h('summary', null, summary),
      node
    ]);
  }

  function sectionHead(eyebrow, title, desc) {
    return h('header', { class: 'card-head' }, [
      eyebrow ? h('div', { class: 'card-eyebrow' }, eyebrow) : null,
      h('div', { class: 'card-head__row' }, [
        h('h2', null, title)
      ]),
      desc ? h('p', { class: 'card-desc' }, desc) : null
    ]);
  }

  global.UI = {
    h: h, s: s, clear: clear,
    fmtPct: fmtPct, fmtMs: fmtMs, fmtNum: fmtNum, fmtRatio: fmtRatio, fmtCompact: fmtCompact,
    badge: badge, icon: ICON, tipAttr: tipAttr, ensureTip: ensureTip,
    table: table, detailsTable: detailsTable, sectionHead: sectionHead
  };
})(window);
