/* ============================================================================
 *  HTTP API 客户端（对应实施计划 §2 的端点表）
 *  文件：web/js/api.js
 *
 *  这一层只做四件事：拼 URL、带 token、超时、把各种失败归一成 {ok:false,kind}。
 *  页面永远不需要 try/catch：拿到的对象一定有 ok，失败时 kind ∈
 *    offline   —— file:// 打开，没有同源后端（不是错误，是静态预览）
 *    http      —— 后端回了非 2xx
 *    contract  —— 回了 2xx 但 body 不是合法 JSON / 不是 {ok:...}
 *    timeout | network
 *
 *  后端还没上线时，所有调用都返回 offline，页面据此走"录制数据"路径。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var DEFAULT_TIMEOUT = 4000;

  /** 测试用覆盖点：给了就用它当 base（不带尾斜杠） */
  function base() {
    if (typeof global.__NTRU_API_BASE__ === 'string' && global.__NTRU_API_BASE__) {
      return String(global.__NTRU_API_BASE__).replace(/\/+$/, '');
    }
    var loc = global.location || {};
    if (loc.protocol === 'file:') return null;   // 同源后端不可能存在
    return '';                                    // 相对路径 = 同源
  }

  function token() {
    var doc = global.document;
    if (!doc || !doc.querySelector) return '';
    var el = doc.querySelector('meta[name="demo-token"]');
    return el ? (el.getAttribute('content') || '') : '';
  }

  function withQuery(path, params) {
    var pairs = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === null || v === undefined || v === '') return;
      pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    if (!pairs.length) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + pairs.join('&');
  }

  function fail(kind, message, extra) {
    var out = { ok: false, kind: kind, error: message };
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  /**
   * opt: {params, timeout, requireToken, raw}
   */
  function getJSON(path, opt) {
    opt = opt || {};
    var b = base();
    if (b === null) {
      return Promise.resolve(fail('offline', 'file:// 页面没有同源后端，走静态预览'));
    }
    var params = opt.params || {};
    var tk = token();
    if (opt.requireToken !== false && tk) params.token = tk;
    var url = b + withQuery(path, params);

    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      if (ctl) ctl.abort();
    }, opt.timeout || DEFAULT_TIMEOUT);

    return fetch(url, {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        clearTimeout(timer);
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
        if (!res.ok) {
          var detail = body && body.error ? body.error : null;
          return fail('http', 'HTTP ' + res.status, {
            status: res.status,
            code: detail && detail.code || null,
            field: detail && detail.field || null,
            data: body
          });
        }
        if (opt.raw) return { ok: true, status: res.status, data: body, text: text };
        if (!body || typeof body !== 'object') {
          return fail('contract', '响应不是 JSON 对象', { status: res.status, text: String(text).slice(0, 200) });
        }
        if (body.ok === false) {
          var err = body.error || {};
          return fail('contract', err.message || '后端返回 ok:false', {
            status: res.status, code: err.code || null, field: err.field || null, data: body
          });
        }
        return { ok: true, status: res.status, data: body };
      });
    }).catch(function (err) {
      clearTimeout(timer);
      if (timedOut) return fail('timeout', '请求超时');
      var m = err && err.message || String(err);
      if (/Failed to fetch|NetworkError|ECONNREFUSED|fetch failed/i.test(m)) {
        return fail('network', '连不上后端');
      }
      return fail('network', m);
    });
  }

  /* ------------------------------------------------------------ 端点 ---- */
  var API = {
    base: base,
    getJSON: getJSON,

    health: function (opt) {
      return getJSON('/api/health', Object.assign({ requireToken: false }, opt || {}));
    },
    env: function (refresh) {
      return getJSON('/api/env', { requireToken: false, params: refresh ? { refresh: 1 } : {} });
    },
    token: function () {
      return getJSON('/api/token', { requireToken: false });
    },
    flow: function (q) {
      return getJSON('/api/flow', { params: q || {} });
    },
    c1Run: function (q) {
      return getJSON('/api/c1/run', { params: q || {} });
    },
    results: function (name) {
      return getJSON('/api/results/' + String(name).replace(/^\/+/, ''), { requireToken: false });
    },
    cancel: function () {
      return getJSON('/api/cancel', {});
    }
  };

  global.API = API;
})(window);
