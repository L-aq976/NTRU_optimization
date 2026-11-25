/* ============================================================================
 *  引擎测试：web/js/ntru.js（浏览器里现算的那套 NTRU + CNF）
 *  文件：web/test/engine.test.js
 *
 *  这一层最容易被写错，所以逐条钉住：
 *    · f⁻¹ 的模 2^k 求逆（牛顿提升）
 *    · f ≡ 1 (mod p)、h = p·g·f⁻¹、加解密往返
 *    · CNF：Σshare = rk、|W|=t 全覆盖、|W|=t−1 恰好缺 1 份
 *    · 噪声随份数增长、以及"q 太小就绕回、q 够大就成功"这条主线
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.resolve(__dirname, '..');

function loadNTRU() {
  const sandbox = { window: {}, console };
  vm.runInNewContext(fs.readFileSync(path.join(WEB, 'js', 'ntru.js'), 'utf8'), sandbox,
    { filename: path.join(WEB, 'js', 'ntru.js') });
  return sandbox.window.NTRU;
}

function subsetsOfSize(n, size) {
  const out = [];
  for (let m = 0; m < (1 << n); m++) {
    let c = 0;
    for (let x = m; x; x &= x - 1) c++;
    if (c === size) out.push(m);
  }
  return out;
}

function runPipeline(NS, opts) {
  const E = NS.engine, R = NS.ring;
  const P = NS.params({ q: opts.q });
  const rng = NS.makeRng(opts.seed);
  const A = E.keygen(P, rng);
  const B = E.keygen(P, rng);
  const m = E.sampleMessage(P, rng);
  const C1 = E.encrypt(P, A.h, m, rng);
  const rk = E.rekeygen(P, A.f, B.finv);
  const ctx = E.cnfShare(P, rk, opts.N, opts.T, rng);
  const parts = [];
  for (let i = 0; i < opts.N; i++) parts.push(E.partialsForProxy(P, ctx, C1, i, rng));
  const W = [];
  for (let i = 0; i < opts.wSize; i++) W.push(i);
  const comb = E.combine(P, ctx, parts, W);
  const dec = E.decryptWithNoise(P, B.f, comb.ct);
  const expect = R.messageToCenter(m, P.p);
  return {
    P, A, B, m, C1, rk, ctx, parts, W, comb, dec,
    ok: R.equal(dec.m, expect) && comb.missing === 0,
    msgOk: R.equal(dec.m, expect),
    budget: Math.floor(P.q / 2),
    expect
  };
}

async function run(ck) {
  const NS = loadNTRU();
  const E = NS.engine, R = NS.ring;

  /* -------------------------------------------------- 1. 模 2^k 求逆 ---- */
  ck.section('f⁻¹ mod 2^k（牛顿提升）');
  const invCases = [
    { n: 7, d: 2, q: 64, seeds: 20 },
    { n: 61, d: 10, q: 2048, seeds: 8 },
    { n: 439, d: 146, q: 2048, seeds: 4 }
  ];
  // 注意：随机三元 f 有一定概率在模 2 下就不可逆（x^n−1 在 GF(2) 上会分解），
  // C++ 的 keygen 也是"采样 → 取逆失败 → 重采"。这里照同样口径验：
  //   · 不可逆 ⇒ 必须返回 null（不许返回错的逆）
  //   · 可逆   ⇒ f·f⁻¹ 必须等于 1
  let invBad = [], invNull = 0, invOk = 0;
  invCases.forEach(function (c) {
    for (let s = 1; s <= c.seeds; s++) {
      const rng = NS.makeRng(s);
      const F = rng.fixedWeight(c.n, c.d, c.d);
      const f = new Array(c.n);
      for (let i = 0; i < c.n; i++) f[i] = 3 * F[i];
      f[0] += 1;                                  // f = 1 + p·F（常数 1 只加在 0 号）
      const g = NS.invert(f, c.n, c.q);
      if (!g) { invNull++; continue; }
      const chk = R.mul(R.toModQ(f, c.q), g, c.q);
      let good = chk[0] === 1;
      for (let i = 1; i < c.n; i++) if (chk[i] !== 0) good = false;
      if (good) invOk++; else invBad.push(`n=${c.n} seed=${s}: 返回了错的逆`);
    }
  });
  ck.ok('可逆的 f：f·f⁻¹ ≡ 1（32 例）', invBad.length === 0, invBad.slice(0, 3).join(' | '));
  ck.ok('确实有样本可逆（不是全返回 null）', invOk >= 20, 'ok=' + invOk + ' null=' + invNull);

  // keygen 自带重采，必须总能拿到可用的密钥对
  let kgBad = 0;
  for (let s = 1; s <= 12; s++) {
    try {
      const k = E.keygen(NS.params({ n: 61, q: 2048, df: 10, dg: 10, dr: 10 }), NS.makeRng(s));
      const chk = R.mul(k.f, k.finv, 2048);
      let good = chk[0] === 1;
      for (let i = 1; i < 61; i++) if (chk[i] !== 0) good = false;
      if (!good) kgBad++;
    } catch (e) { kgBad++; }
  }
  ck.eq('keygen 重采后 12/12 拿到可用密钥', kgBad, 0);

  const bogusInverse = NS.invert([1, 1, 0, 0, 0, 0, 0], 7, 8);
  ck.eq('不可逆的 f（1+x，n=7）返回 null', bogusInverse, null);

  /* ------------------------------------------------------ 2. 密钥代数 ---- */
  ck.section('密钥代数（n=439, q=2048）');
  const P0 = NS.params({ q: 2048 });
  const rng0 = NS.makeRng(20261012);
  const K = E.keygen(P0, rng0);
  const one = new Array(P0.n).fill(0); one[0] = 1;

  ck.ok('f·f⁻¹ ≡ 1', R.equal(R.mul(K.f, K.finv, P0.q), R.zero(P0.n).map(function (v, i) {
    return i === 0 ? 1 : 0;
  })));
  const g = R.mulConst(R.mul(K.g, K.finv, P0.q), P0.p, P0.q);
  ck.ok('h = p·g·f⁻¹', R.equal(K.h, g));

  const fCentered = R.center(K.f, P0.q);
  let fModP = fCentered.every(function (v) { return ((v % P0.p) + P0.p) % P0.p === (v === fCentered[0] ? 1 : 0); });
  ck.ok('f ≡ 1 (mod p)（0 号系数 ≡ 1，其余 ≡ 0）', fModP);
  ck.ok('f 的其余系数都是 p 的倍数', fCentered.slice(1).every(function (v) { return v % P0.p === 0; }));

  const m0 = E.sampleMessage(P0, rng0);
  const fM = R.mul(K.f, R.toModQ(m0, P0.q), P0.q);
  ck.ok('f·M ≡ M (mod p)', R.equal(R.modPCentered(fM, P0.q, P0.p), R.messageToCenter(m0, P0.p)));

  /* ---------------------------------------------------- 3. 加解密往返 ---- */
  ck.section('加解密往返（q=2^16，足够大的预算）');
  const rt = (function () {
    const P = NS.params({ q: 65536 });
    const rng = NS.makeRng(7);
    const A = E.keygen(P, rng);
    const m = E.sampleMessage(P, rng);
    const C = E.encrypt(P, A.h, m, rng);
    const d = E.decryptWithNoise(P, A.f, C);
    return { ok: R.equal(d.m, R.messageToCenter(m, P.p)), noise: d.noise, budget: Math.floor(P.q / 2) };
  })();
  ck.eq('Alice 自解一致', rt.ok, true);
  ck.ok('单次加解密噪声 < q/2', rt.noise < rt.budget, rt.noise + ' / ' + rt.budget);

  const wrongKey = (function () {
    const P = NS.params({ q: 65536 });
    const rng = NS.makeRng(11);
    const A = E.keygen(P, rng);
    const B = E.keygen(P, rng);
    const m = E.sampleMessage(P, rng);
    const C = E.encrypt(P, A.h, m, rng);
    const d = E.decryptWithNoise(P, B.f, C);      // 用错私钥
    return R.equal(d.m, R.messageToCenter(m, P.p));
  })();
  ck.eq('用别人的 f 解密 → 不一致', wrongKey, false);

  /* ------------------------------------------------------- 4. 份额结构 ---- */
  ck.section('CNF 份额结构（N=9, t=6）');
  const rng1 = NS.makeRng(20261012);
  const rk = R.toModQ(rng1.uniformPoly(439, 2048), 2048);
  const ctx = E.cnfShare(P0, rk, 9, 6, rng1);

  ck.eq('子集大小 = N−t+1', ctx.subsetSize, 4);
  ck.eq('子集数 = C(9,5)', ctx.count, 126);
  ck.eq('每节点持有 = C(8,5)', ctx.holdings, 56);
  ck.eq('每节点持有数一致', ctx.perProxy.every(function (l) { return l.length === 56; }), true);
  ck.eq('份额数 = 枚举出的 4 元子集数', ctx.shares.length, subsetsOfSize(9, 4).length);

  let acc = R.zero(P0.n);
  ctx.shares.forEach(function (s) { acc = R.add(acc, s.value, P0.q); });
  ck.ok('Σ 全部份额 = rk', R.equal(acc, rk));

  const masks = ctx.shares.map(function (s) { return s.mask; });
  ck.eq('子集互不相同', new Set(masks).size, masks.length);

  /* --------------------------------------------- 5. 组合：|W|=t 全覆盖 ---- */
  ck.section('组合：|W| = t 与 |W| = t−1');
  const rng2 = NS.makeRng(20261012);
  const pipe6 = runPipeline(NS, { q: 65536, seed: 20261012, N: 9, T: 6, wSize: 6 });
  ck.eq('|W|=6 组合用到 126 份', pipe6.comb.used, 126);
  ck.eq('|W|=6 缺失 0 份', pipe6.comb.missing, 0);
  ck.eq('|W|=6 解密一致', pipe6.ok, true);
  ck.ok('|W|=6 噪声 < q/2', pipe6.dec.noise < pipe6.budget, pipe6.dec.noise + ' / ' + pipe6.budget);

  const pipe5 = runPipeline(NS, { q: 65536, seed: 20261012, N: 9, T: 6, wSize: 5 });
  ck.eq('|W|=5 只用到 125 份', pipe5.comb.used, 125);
  ck.eq('|W|=5 恰好缺 1 份', pipe5.comb.missing, 1);
  ck.eq('|W|=5 解密不一致', pipe5.msgOk, false);
  ck.eq('|W|=5 那份缺的子集 = 补集',
    pipe5.ctx.shares.filter(function (s) {
      return !pipe5.W.some(function (p) { return s.mask & (1 << p); });
    }).length, 1);

  /* ------------------------------------------- 6. q 与噪声预算（主线）---- */
  ck.section('q 与噪声预算：小 q 绕回、大 q 成功');
  const q2048 = runPipeline(NS, { q: 2048, seed: 20261012, N: 9, T: 6, wSize: 6 });
  const q16k = runPipeline(NS, { q: 16384, seed: 20261012, N: 9, T: 6, wSize: 6 });

  ck.eq('q=2048 时 9-of-6 失败', q2048.ok, false);
  // 绕回后 center() 会把真值折回 (−q/2, q/2]，所以读数只会逼近、不会超过 q/2
  ck.ok('q=2048 时噪声逼近 q/2 上限（≥95%）',
    q2048.dec.noise >= q2048.budget * 0.95, q2048.dec.noise + ' / ' + q2048.budget);
  ck.eq('q=16384 时 9-of-6 成功', q16k.ok, true);
  ck.ok('q=16384 时噪声有余量', q16k.dec.noise < q16k.budget, q16k.dec.noise + ' / ' + q16k.budget);
  ck.ok('不同 q 下噪声量级可比（3400–6000）',
    q16k.dec.noise > 2000 && q16k.dec.noise < 7000, String(q16k.dec.noise));

  // 单代理基线：q=2048 也能过 —— 这条是"1 个代理 vs 6 个代理"的对照
  const baseline = (function () {
    const P = NS.params({ q: 2048 });
    const rng = NS.makeRng(20261012);
    const A = E.keygen(P, rng), B = E.keygen(P, rng);
    const m = E.sampleMessage(P, rng);
    const C1 = E.encrypt(P, A.h, m, rng);
    const rk = E.rekeygen(P, A.f, B.finv);
    const e = R.toModQ(rng.fixedWeight(P.n, P.dr, P.dr), P.q);
    const ct = R.add(R.mul(C1, rk, P.q), R.mulConst(e, P.p, P.q), P.q);
    const d = E.decryptWithNoise(P, B.f, ct);
    return { ok: R.equal(d.m, R.messageToCenter(m, P.p)), noise: d.noise };
  })();
  ck.eq('q=2048 下单代理（1 份）仍然成功', baseline.ok, true);
  ck.ok('单代理噪声远小于 126 份', baseline.noise < q16k.dec.noise / 4,
    baseline.noise + ' vs ' + q16k.dec.noise);

  /* ------------------------------------------------------ 7. 确定性 ---- */
  ck.section('确定性（同种子 ⇒ 同密钥）');
  const a1 = E.keygen(NS.params({ q: 2048 }), NS.makeRng(99));
  const a2 = E.keygen(NS.params({ q: 2048 }), NS.makeRng(99));
  const a3 = E.keygen(NS.params({ q: 2048 }), NS.makeRng(100));
  ck.eq('同种子 f 相同', R.equal(a1.f, a2.f), true);
  ck.eq('同种子 h 相同', R.equal(a1.h, a2.h), true);
  ck.eq('换种子 f 不同', R.equal(a1.f, a3.f), false);

  /* -------------------------------------------------------- 8. 性能 ---- */
  ck.section('性能（Node，n=439）');
  const t0 = Date.now();
  runPipeline(NS, { q: 16384, seed: 424242, N: 9, T: 6, wSize: 6 });
  const ms = Date.now() - t0;
  ck.ok('整条链路（含 126 份 partial）< 3000 ms', ms < 3000, ms + ' ms');
}

module.exports = { run };
