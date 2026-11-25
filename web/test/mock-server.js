/* ============================================================================
 *  测试替身：按「实施计划 §2」实现的最小 HTTP 后端
 *  文件：web/test/mock-server.js
 *
 *  ⚠️ 这不是 bin/ntru_demo.exe 的替代品，只用来验证前端的接口契约：
 *     · 端点、状态码、错误体结构、token 闸门、clamp 规则
 *     · /api/results/c1 的 {source,file,mtime,columns,rows} 形状
 *     · /api/c1/run 的字段（结构永远给，指标只对"已录制配置"给，其余明确 null）
 *     · 静态文件：路径穿越拒绝 + 扩展名白名单 + nosniff
 *
 *  用法：
 *    const mock = require('./mock-server');
 *    const { port, token, close } = await mock.start();       // 0 = 随机端口
 * ==========================================================================*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

/* ---------------------------------------------------------------- 工具 ---- */
function loadWindowModule(file) {
  const sandbox = { window: {}, console };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.window;
}

function csvRows(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function err(res, status, code, message, field) {
  const e = { code, message };
  if (field) e.field = field;
  json(res, status, { ok: false, error: e });
}

function binom(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

/* -------------------------------------------------------------- 数据集 ---- */
const D = loadWindowModule(path.join(WEB_ROOT, 'js', 'data.js')).NTRU_DATA;
const T = loadWindowModule(path.join(WEB_ROOT, 'js', 'threshold.js')).NTRU_THRESHOLD;

const CSV_COLUMNS = ['params', 'n', 't', 'subsets', 'succ_t_pct', 'succ_t_minus_1_pct',
  'noise_ratio', 'share_ms', 'partials_ms', 'combine_ms'];
const NUMERIC = new Set(['n', 't', 'subsets', 'succ_t_pct', 'succ_t_minus_1_pct',
  'noise_ratio', 'share_ms', 'partials_ms', 'combine_ms']);
const BOOLEAN = new Set(['correct', 'extrapolated']);

function resultsPayload(name) {
  if (name !== 'c1') return null;
  const files = D.order.map((p) => {
    const prov = D.provenance[p];
    const abs = path.join(REPO_ROOT, prov.file);
    const st = fs.statSync(abs);
    const rows = csvRows(abs).map((raw) => {
      const row = {};
      CSV_COLUMNS.forEach((c) => {
        if (!(c in raw)) return;
        const v = raw[c];
        if (v === '' ) { row[c] = null; return; }
        if (BOOLEAN.has(c)) { row[c] = v === 'True' || v === 'true' || v === '1'; return; }
        row[c] = NUMERIC.has(c) ? Number(v) : v;
      });
      return row;
    });
    return {
      source: 'bench/results',
      file: prov.file,
      mtime: st.mtime.toISOString(),
      columns: CSV_COLUMNS,
      rows
    };
  });
  return {
    ok: true,
    source: 'csv',
    dataset: name,
    columns: CSV_COLUMNS,
    files,
    // 扁平视图，便于页面一次画完
    rows: files.reduce((acc, f) => acc.concat(f.rows), [])
  };
}

/* --------------------------------------------------------------- 路由 ---- */
function handleAPI(req, res, url, ctx) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/health') {
    return json(res, 200, {
      ok: true, version: 'mock-0.1.0', port: ctx.port, pid: process.pid,
      repo_root: REPO_ROOT, build_time: 'test-fixture', backend: 'mock'
    });
  }
  if (p === '/api/token') return json(res, 200, { ok: true, token: ctx.token });

  if (p === '/api/env') {
    return json(res, 200, {
      ok: true, cached: q.get('refresh') !== '1',
      candidates: [
        { exe: 'py -3', ok: false, reason: '本机 Python 缺失（测试替身）' },
        { exe: 'wsl.exe -d Ubuntu -- python3', ok: true, version: '3.12', numpy: true, cupy: false, gpu: null }
      ],
      chosen: 'wsl.exe -d Ubuntu -- python3'
    });
  }

  if (p === '/api/flow') {
    const seed = Number(q.get('seed') || 20261012);
    const n = Number(q.get('n') || 3);
    const t = Number(q.get('t') || 2);
    if (!(n >= 2 && n <= 7)) return err(res, 400, 'bad_param', 'n 必须在 2..7', 'n');
    if (!(t >= 2 && t <= n)) return err(res, 400, 'bad_param', 't 必须在 2..n', 't');
    return json(res, 200, {
      ok: true, seed, params: { name: 'TINY7', n: 7, q: 2048, p: 3, df: 2, dg: 2, dr: 2 },
      representation: { form: 'centered', range: [-1023, 1024] },
      threshold: { n, t, num_subsets: binom(n, t - 1) },
      invariants: { all_ok: true },
      timings_ms: { total: 0 },
      note: 'mock：只给形状，多项式数值请由 C++ 引擎产生'
    });
  }

  if (p === '/api/c1/run') {
    if (q.get('token') !== ctx.token) return err(res, 403, 'forbidden', '计算端点需要启动 token');
    const params = q.get('params') || 'EES1499';
    if (!D.params[params]) return err(res, 400, 'bad_param', '未知参数集: ' + params, 'params');

    const nRaw = Number(q.get('n') || 3);
    const tRaw = Number(q.get('t') || 2);
    if (!Number.isInteger(nRaw) || !Number.isInteger(tRaw)) return err(res, 400, 'bad_param', 'n/t 必须是整数');
    const n = Math.min(Math.max(nRaw, 2), 8);          // clamp 到 2..8
    const t = Math.min(Math.max(tRaw, 2), n);
    if (binom(n, t - 1) > 200) return err(res, 400, 'too_many_subsets', 'C(n,t-1) > 200', 'n');

    const trials = Math.min(Math.max(Number(q.get('trials') || 1) || 1, 1), 5);
    let W = (q.get('w') || '').split(',').filter((s) => s !== '').map(Number);
    if (!W.length) W = Array.from({ length: t }, (_, i) => i);
    W = W.filter((x) => Number.isInteger(x) && x >= 0 && x < n);
    const inW = new Set(W);
    if (W.length !== t) return err(res, 400, 'bad_param', '|W| 必须等于 t', 'w');

    const struct = T.structure(n, t, W);
    const recorded = D.rows[params].find((r) => r.n === n && r.t === t) || null;

    return json(res, 200, {
      ok: true,
      params, n, t, w: W, trials,
      subsets: struct.count,
      subset_size: struct.subsetSize,
      holdings_per_proxy: struct.expectHoldings,
      metrics_source: recorded ? 'recorded' : 'unrecorded',
      succ_t_pct: recorded ? recorded.succT : null,
      succ_t_minus_1_pct: recorded ? recorded.succTm1 : null,
      noise_ratio: recorded ? recorded.ratio : null,
      share_ms: recorded ? recorded.shareMs : null,
      partials_ms: recorded ? recorded.partialsMs : null,
      combine_ms: recorded ? recorded.combineMs : null,
      per_proxy: Array.from({ length: n }, (_, i) => ({
        proxy: i, label: 'P' + (i + 1), holdings: struct.holdings[i].length, in_w: inW.has(i)
      })),
      subsets_detail: struct.subsets.map((s) => ({
        index: s.index, mask: s.mask, members: s.members, owner: s.owner
      }))
    });
  }

  const r = p.match(/^\/api\/results\/([A-Za-z0-9_\/-]+)$/);
  if (r) {
    const payload = resultsPayload(r[1]);
    if (!payload) return err(res, 404, 'not_found', '未知数据集: ' + r[1]);
    return json(res, 200, payload);
  }

  if (p === '/api/cancel') {
    if (q.get('token') !== ctx.token) return err(res, 403, 'forbidden', '需要 token');
    return json(res, 200, { ok: true, cancelled: false, note: 'mock 没有长任务' });
  }

  return err(res, 404, 'not_found', 'unknown endpoint: ' + p);
}

function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.indexOf('\0') >= 0) return err(res, 400, 'bad_path', 'NUL 字节');
  if (rel.indexOf('..') >= 0 || rel.indexOf('\\') >= 0) return err(res, 403, 'bad_path', '拒绝 .. 与反斜杠');

  const abs = path.join(WEB_ROOT, rel.replace(/^\/+/, ''));
  const norm = path.resolve(abs);
  if (norm !== WEB_ROOT && !norm.startsWith(WEB_ROOT + path.sep)) {
    return err(res, 403, 'bad_path', '越出 web_root');
  }
  const ext = path.extname(norm).toLowerCase();
  if (!MIME[ext]) return err(res, 403, 'bad_ext', '扩展名不在白名单: ' + ext);
  let buf;
  try { buf = fs.readFileSync(norm); } catch (e) { return err(res, 404, 'not_found', '文件不存在'); }
  res.writeHead(200, {
    'Content-Type': MIME[ext],
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(buf);
}

/* --------------------------------------------------------------- 启动 ---- */
function start(opts) {
  opts = opts || {};
  const token = opts.token || 'TESTTOKEN';
  return new Promise((resolve, reject) => {
    const ctx = { token, port: 0 };
    const server = http.createServer((req, res) => {
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) {
        return err(res, 400, 'bad_request', 'bad url');
      }
      if (req.method !== 'GET') return err(res, 405, 'method', 'only GET');
      if (url.pathname.startsWith('/api/')) return handleAPI(req, res, url, ctx);
      return handleStatic(req, res, url);
    });
    server.on('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      ctx.port = server.address().port;
      resolve({
        port: ctx.port,
        token,
        base: 'http://127.0.0.1:' + ctx.port,
        server,
        close: () => new Promise((r2) => server.close(r2))
      });
    });
  });
}

module.exports = { start, WEB_ROOT, REPO_ROOT, csvRows, splitCsvLine };
