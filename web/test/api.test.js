/* ============================================================================
 *  接口契约测试：web/js/api.js ⇄ mock 后端
 *  文件：web/test/api.test.js
 *
 *  两件事分开测：
 *    (a) 后端契约 —— 端点/状态码/错误体/clamp/token/数据集形状（直接 fetch）
 *    (b) 客户端契约 —— 失败归一（offline / http / contract / network）、
 *        token 注入、超时、离线不抛异常（用 js/api.js 本身）
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const mock = require('./mock-server');

const WEB = path.resolve(__dirname, '..');

/** 在 Node 里加载浏览器 IIFE 形式的 api.js，返回 window.API */
function loadAPI(base, opts) {
  opts = opts || {};
  const code = fs.readFileSync(path.join(WEB, 'js', 'api.js'), 'utf8');
  const win = {
    location: { protocol: opts.protocol || 'http:', href: (base || '') + '/index.html' },
    __NTRU_API_BASE__: base || '',
    document: opts.token
      ? { querySelector: (sel) => (sel.indexOf('demo-token') >= 0 ? { getAttribute: () => opts.token } : null) }
      : undefined
  };
  const factory = new Function('window', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout',
    code + '\nreturn window.API;');
  return factory(win, global.fetch, global.AbortController, global.setTimeout, global.clearTimeout);
}

async function fetchJSON(url, init) {
  const res = await fetch(url, init);
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = { __raw: text.slice(0, 120) }; }
  return { status: res.status, headers: res.headers, body, text };
}

async function run(ck) {
  const srv = await mock.start({ port: 0 });
  const base = srv.base;
  const token = srv.token;

  try {
    /* ------------------------------------------------------- (a) 后端 ---- */
    ck.section('契约：/api/health');

    const health = await fetchJSON(base + '/api/health');
    ck.eq('health 状态码', health.status, 200);
    ck.eq('health ok', health.body.ok, true);
    ck.ok('health 带 version/port/pid',
      typeof health.body.version === 'string' && typeof health.body.port === 'number' && typeof health.body.pid === 'number');
    ck.ok('health 不回 token', !('token' in health.body));
    ck.eq('health content-type', health.headers.get('content-type'), 'application/json; charset=utf-8');
    ck.eq('health nosniff', health.headers.get('x-content-type-options'), 'nosniff');

    ck.section('契约：/api/results/c1');
    const resC1 = await fetchJSON(base + '/api/results/c1');
    ck.eq('results 状态码', resC1.status, 200);
    ck.eq('results 行数（扁平）', resC1.body.rows.length, 21);
    ck.eq('results 表头', resC1.body.columns.join(','),
      'params,n,t,subsets,succ_t_pct,succ_t_minus_1_pct,noise_ratio,share_ms,partials_ms,combine_ms');
    ck.eq('results 文件数', resC1.body.files.length, 3);
    const f0 = resC1.body.files[0];
    ck.ok('files[] 带 source/file/mtime', typeof f0.source === 'string' && typeof f0.file === 'string' && !isNaN(Date.parse(f0.mtime)));
    ck.ok('数值列已转 number', typeof f0.rows[0].noise_ratio === 'number' && typeof f0.rows[0].subsets === 'number');
    const row1499_74 = resC1.body.rows.find((r) => r.params === 'EES1499' && r.n === 7 && r.t === 4);
    ck.ok('抽查 EES1499 (7,4)', row1499_74 && row1499_74.succ_t_pct === 90 && row1499_74.noise_ratio === 4.522);
    ck.eq('未注册数据集 → 404', (await fetchJSON(base + '/api/results/nope')).status, 404);

    ck.section('契约：/api/c1/run（token / clamp / 结构）');
    const noToken = await fetchJSON(base + '/api/c1/run?params=EES1499&n=6&t=3');
    ck.eq('无 token → 403', noToken.status, 403);
    ck.eq('403 错误码', noToken.body.error.code, 'forbidden');

    const okRun = await fetchJSON(base + '/api/c1/run?params=EES1499&n=6&t=3&trials=3&w=0,1,2&token=' + token);
    ck.eq('录制配置状态码', okRun.status, 200);
    ck.eq('录制配置 metrics_source', okRun.body.metrics_source, 'recorded');
    ck.eq('子集数', okRun.body.subsets, 15);
    ck.eq('每代理份数', okRun.body.holdings_per_proxy, 10);
    ck.eq('t 个成功率', okRun.body.succ_t_pct, 100);
    ck.eq('噪声放大', okRun.body.noise_ratio, 2.758);
    ck.eq('per_proxy 长度', okRun.body.per_proxy.length, 6);
    ck.eq('per_proxy 持有数', okRun.body.per_proxy[0].holdings, 10);
    ck.eq('subsets_detail 长度', okRun.body.subsets_detail.length, 15);
    ck.ok('subsets_detail owner 合法',
      okRun.body.subsets_detail.every((s) => s.owner === -1 || (s.owner >= 0 && s.owner < 6)));

    const clamp = await fetchJSON(base + '/api/c1/run?params=EES1499&n=9&t=4&trials=99&token=' + token);
    ck.eq('n=9 被 clamp 到 8', clamp.body.n, 8);
    ck.eq('trials=99 被 clamp 到 5', clamp.body.trials, 5);
    ck.eq('未录制配置仍给子集数 C(8,3)', clamp.body.subsets, 56);
    ck.eq('未录制配置指标为 null', clamp.body.succ_t_pct, null);
    ck.eq('未录制配置标注', clamp.body.metrics_source, 'unrecorded');

    const badW = await fetchJSON(base + '/api/c1/run?params=EES1499&n=6&t=3&w=0,1&token=' + token);
    ck.eq('|W| ≠ t → 400', badW.status, 400);
    ck.eq('|W| 错误字段名', badW.body.error.field, 'w');

    const badParams = await fetchJSON(base + '/api/c1/run?params=NOPE&n=3&t=2&token=' + token);
    ck.eq('未知参数集 → 400', badParams.status, 400);
    ck.eq('未知参数集字段名', badParams.body.error.field, 'params');

    const tooMany = await fetchJSON(base + '/api/c1/run?params=EES1499&n=8&t=2&w=0,1&token=' + token);
    ck.ok('C(n,t−1) ≤ 200 或明确 400', [200, 400].indexOf(tooMany.status) >= 0);

    ck.section('契约：静态文件安全');
    const idx = await fetchJSON(base + '/');
    ck.eq('/ → 200', idx.status, 200);
    ck.ok('/ 返回 HTML 且声明 utf-8',
      (idx.headers.get('content-type') || '').indexOf('text/html') === 0 && idx.text.indexOf('charset="utf-8"') > 0);
    const trav = await fetchJSON(base + '/%2e%2e/src/core/params.h');
    ck.ok('../ 路径被拒（403/404）', [403, 404].indexOf(trav.status) >= 0, 'status=' + trav.status);
    const badExt = await fetchJSON(base + '/js/../../bin/ntru_cli.exe');
    ck.ok('越界 / 非白名单扩展名被拒', [403, 404].indexOf(badExt.status) >= 0, 'status=' + badExt.status);
    const jsFile = await fetchJSON(base + '/js/data.js');
    ck.eq('js MIME', jsFile.headers.get('content-type'), 'application/javascript; charset=utf-8');

    /* ----------------------------------------------------- (b) 客户端 ---- */
    ck.section('客户端：api.js 失败归一');

    const API = loadAPI(base, { token: token });
    const h1 = await API.health();
    ck.eq('health → ok', h1.ok, true);
    ck.ok('health.data.ok', h1.data && h1.data.ok === true);

    const r1 = await API.results('c1');
    ck.eq('results → 21 行', r1.ok && r1.data.rows.length, 21);

    const c1ok = await API.c1Run({ params: 'EES1499', n: 6, t: 3, trials: 2 });
    ck.eq('c1Run 自动带 token → 200', c1ok.ok, true);
    ck.eq('c1Run 指标', c1ok.data && c1ok.data.noise_ratio, 2.758);

    const noTokClient = loadAPI(base, {});           // 故意不带 token
    const c1fail = await noTokClient.c1Run({ params: 'EES1499', n: 6, t: 3 });
    ck.eq('不带 token → kind=http', c1fail.kind, 'http');
    ck.eq('不带 token → status 403', c1fail.status, 403);
    ck.eq('不带 token → code', c1fail.code, 'forbidden');
    ck.eq('不带 token → ok:false', c1fail.ok, false);

    const bad = await API.c1Run({ params: 'EES1499', n: 6, t: 3, w: [0, 1] });
    ck.eq('参数错误 → status 400', bad.status, 400);
    ck.eq('参数错误 → code bad_param', bad.code, 'bad_param');
    ck.eq('参数错误 → 不抛异常，给出 kind', bad.kind, 'http');

    const miss = await API.results('nope');
    ck.eq('404 → kind=http', miss.kind, 'http');
    ck.eq('404 → status', miss.status, 404);

    const offline = loadAPI('', { protocol: 'file:' });
    const off = await offline.health();
    ck.eq('file:// → kind=offline', off.kind, 'offline');
    ck.eq('file:// → ok:false', off.ok, false);
    const offC1 = await offline.c1Run({ params: 'EES1499', n: 6, t: 3 });
    ck.eq('file:// 下 c1Run 也是 offline', offC1.kind, 'offline');

    const dead = loadAPI('http://127.0.0.1:1', {});   // 没人监听
    const deadRes = await dead.health({ timeout: 800 });
    ck.ok('连不上 → kind ∈ {network, timeout}', ['network', 'timeout'].indexOf(deadRes.kind) >= 0, deadRes.kind);
    ck.eq('连不上 → ok:false', deadRes.ok, false);

    const noBase = loadAPI(base, { token: token });
    const raw = await noBase.getJSON('/api/health', { raw: true, requireToken: false });
    ck.ok('raw 模式拿到 text', raw.ok && typeof raw.text === 'string' && raw.text.indexOf('{') === 0);

  } finally {
    await srv.close();
  }
}

module.exports = { run };
