/* ============================================================================
 *  测试入口（Node）：node web/test/run-all.js
 *  文件：web/test/run-all.js
 *
 *  只覆盖"不需要 DOM"的两层：录制数据 / CNF 结构 / HTTP 接口契约。
 *  DOM、图表、交互那部分在 web/test/page.test.html，用真浏览器跑。
 * ==========================================================================*/
'use strict';

const SUITES = [
  { name: '逻辑层（data.js / threshold.js）', mod: require('./logic.test') },
  { name: '接口层（api.js ⇄ mock 后端）', mod: require('./api.test') },
  { name: '演示引擎（ntru.js：NTRU + CNF）', mod: require('./engine.test') }
];

let pass = 0;
const failures = [];
let current = '';

const ck = {
  section(name) {
    current = name;
    console.log('\n── ' + name);
  },
  ok(name, cond, detail) {
    if (cond) {
      pass++;
      console.log('  ✓ ' + name);
    } else {
      failures.push({ section: current, name, detail: detail || '' });
      console.log('  ✗ ' + name + (detail ? '   → ' + detail : ''));
    }
  },
  eq(name, actual, expected) {
    const same = Object.is(actual, expected) || actual === expected;
    ck.ok(name, same, same ? '' : '实际 ' + fmt(actual) + ' ≠ 期望 ' + fmt(expected));
  }
};

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

(async function main() {
  const t0 = Date.now();
  for (const suite of SUITES) {
    console.log('\n══════ ' + suite.name + ' ══════');
    try {
      await suite.mod.run(ck);
    } catch (err) {
      failures.push({ section: suite.name, name: '测试本身抛异常', detail: (err && err.stack) || String(err) });
      console.log('  ✗ 测试本身抛异常：' + (err && err.message || err));
    }
  }
  const ms = Date.now() - t0;

  console.log('\n' + '─'.repeat(58));
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  · [' + f.section + '] ' + f.name + (f.detail ? '  ' + f.detail : '')));
  }
  console.log(`SUMMARY pass=${pass} fail=${failures.length} elapsed=${ms}ms`);
  console.log(failures.length ? 'RESULT FAIL' : 'RESULT PASS');
  process.exit(failures.length ? 1 : 0);
})();
