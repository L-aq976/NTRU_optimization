/* ============================================================================
 *  浏览器内的 NTRU + CNF 门限引擎（真算，不是动画假数据）
 *  文件：web/js/ntru.js
 *
 *  逐函数对齐仓库的 src/core：
 *      f = 1 + p·F，h = p·g·f⁻¹ mod q      （ntru.cpp : keygen）
 *      C = h·s + M                          （ntru.cpp : encrypt）
 *      a = f·C mod q → 中心代表 → M = a mod p，
 *      ‖center(a)‖∞ 即 noise_inf            （ntru.cpp : decrypt_with_noise）
 *      rk = f_A·f_B⁻¹                       （pre_base.cpp : rekeygen）
 *      partial = C_A·share + p·e            （threshold.cpp : proxy_partials）
 *      ct = Σ_{S} partial(S, min(S∩W))      （threshold.cpp : threshold_combine）
 *
 *  与 C++ 的差别只有一个：q 可以不是 2^11（本页要演示"加大 q 换噪声预算"），
 *  以及 n / 权重做成参数。公式与取整规则完全照抄（含 poly_mod_p_centered 的
 *  C++ 整数除法语义），所以 q=2048 时两边应当给出同一量级的数。
 *
 *  ⚠️ n=439、q≤2^18 只够演示：系数用 double 累加，最大 q²·n < 2^53。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var NS = {};

  /* ------------------------------------------------------------ 随机源 ---- */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRng(seed) {
    var next = mulberry32(seed);
    return {
      next: next,
      below: function (k) { return Math.floor(next() * k); },
      // 定重量三元：plus 个 +1、minus 个 -1（sample_fixed_weight 的直译）
      fixedWeight: function (n, plus, minus) {
        var a = new Array(n);
        for (var i = 0; i < n; i++) a[i] = 0;
        var idx = new Array(n);
        for (var j = 0; j < n; j++) idx[j] = j;
        var m = plus + minus;
        for (var k = 0; k < m; k++) {
          var r = k + Math.floor(next() * (n - k));
          var tmp = idx[k]; idx[k] = idx[r]; idx[r] = tmp;
        }
        for (var p1 = 0; p1 < plus; p1++) a[idx[p1]] = 1;
        for (var p2 = plus; p2 < m; p2++) a[idx[p2]] = -1;
        return a;
      },
      uniformPoly: function (n, q) {
        var a = new Array(n);
        for (var i = 0; i < n; i++) a[i] = Math.floor(next() * q);
        return a;
      }
    };
  }
  NS.makeRng = makeRng;

  /* ------------------------------------------------------------ 环运算 ---- */
  function mod(x, q) {
    var v = x % q;
    return v < 0 ? v + q : v;
  }

  function zeroPoly(n) {
    var a = new Float64Array(n);
    return a;
  }

  function toModQ(a, q) {
    var n = a.length, b = new Float64Array(n);
    for (var i = 0; i < n; i++) b[i] = mod(a[i], q);
    return b;
  }

  function add(a, b, q) {
    var n = a.length, c = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var v = a[i] + b[i];
      c[i] = v >= q ? v - q : v;
    }
    return c;
  }

  function sub(a, b, q) {
    var n = a.length, c = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var v = a[i] - b[i];
      c[i] = v < 0 ? v + q : v;
    }
    return c;
  }

  // 循环卷积：c[k] = Σ_{i+j≡k} a[i]·b[j]（都在 [0,q)，累加值 < q²·n < 2^53）
  function mul(a, b, q) {
    var n = a.length, out = new Float64Array(n);
    var i, j, k, ai, bj;
    for (i = 0; i < n; i++) {
      ai = a[i];
      if (ai === 0) continue;
      for (j = 0; j < n; j++) {
        bj = b[j];
        if (bj === 0) continue;
        k = i + j;
        if (k >= n) k -= n;
        out[k] += ai * bj;
      }
    }
    for (i = 0; i < n; i++) out[i] = out[i] % q;
    return out;
  }

  function mulConst(a, k, q) {
    var n = a.length, c = new Float64Array(n);
    for (var i = 0; i < n; i++) c[i] = mod(a[i] * k, q);
    return c;
  }

  function center(a, q) {
    var n = a.length, half = Math.floor(q / 2), c = new Array(n);
    for (var i = 0; i < n; i++) {
      var v = mod(a[i], q);
      c[i] = v > half ? v - q : v;
    }
    return c;
  }

  function infNormCenter(a, q) {
    var c = center(a, q), m = 0;
    for (var i = 0; i < c.length; i++) {
      var v = c[i] < 0 ? -c[i] : c[i];
      if (v > m) m = v;
    }
    return m;
  }

  // 直译 poly_mod_p_centered（注意 C++ 里 p/2 是整数除法）
  function modPCentered(a, q, p) {
    var n = a.length, half = Math.floor(q / 2), hp = Math.floor(p / 2);
    var c = new Array(n);
    for (var i = 0; i < n; i++) {
      var v = mod(a[i], q);
      if (v > half) v -= q;
      var r = v % p;
      if (r > hp) r -= p;
      else if (r < -hp) r += p;
      c[i] = r;
    }
    return c;
  }

  function messageToCenter(m, p) {
    var c = new Array(m.length), hp = Math.floor(p / 2);
    for (var i = 0; i < m.length; i++) {
      var v = mod(m[i], p);
      if (v > hp) v -= p;
      c[i] = v;
    }
    return c;
  }

  function polyEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  NS.ring = {
    mod: mod, zero: zeroPoly, toModQ: toModQ, add: add, sub: sub, mul: mul,
    mulConst: mulConst, center: center, infNormCenter: infNormCenter,
    modPCentered: modPCentered, messageToCenter: messageToCenter, equal: polyEqual
  };

  /* ------------------------------------------------ 模 2^k 求逆（f⁻¹）---- */
  // 第一步：在 GF(2) 上解 f·g = 1（循环矩阵，用位打包的行做高斯消元）
  function solveMod2(f, n) {
    var words = (n + 31) >>> 5;
    var rows = new Array(n);
    var i, j, w;
    for (i = 0; i < n; i++) rows[i] = new Uint32Array(words + 1);

    for (i = 0; i < n; i++) {
      var row = rows[i];
      for (j = 0; j < n; j++) {
        // 系数 g[j] 在第 i 行的系数：f[(i-j) mod n] mod 2
        var idx = (i - j) % n;
        if (idx < 0) idx += n;
        if ((f[idx] & 1) !== 0) row[j >>> 5] ^= (1 << (j & 31));
      }
      if (i === 0) row[words] ^= 1;              // 右端 e_0
    }

    var col, pivot, tmp;
    for (col = 0; col < n; col++) {
      pivot = -1;
      for (i = col; i < n; i++) {
        if (rows[i][col >>> 5] & (1 << (col & 31))) { pivot = i; break; }
      }
      if (pivot < 0) return null;                // 奇异：f 在模 2 下不可逆
      if (pivot !== col) { tmp = rows[pivot]; rows[pivot] = rows[col]; rows[col] = tmp; }
      for (i = 0; i < n; i++) {
        if (i === col) continue;
        if (rows[i][col >>> 5] & (1 << (col & 31))) {
          for (w = 0; w <= words; w++) rows[i][w] ^= rows[col][w];
        }
      }
    }

    var g = new Array(n);
    for (i = 0; i < n; i++) g[i] = (rows[i][words] & 1) ? 1 : 0;
    // 自检：f·g ≡ 1 (mod 2)
    var fg = mul(toModQ(f, 2), toModQ(g, 2), 2);
    if (fg[0] !== 1) return null;
    for (i = 1; i < n; i++) if (fg[i] !== 0) return null;
    return g;
  }

  // 牛顿加倍：g 是 f 的逆 mod 2^k ⇒ g·(2 - f·g) 是逆 mod 2^2k
  function invertModPow2(f, n, q) {
    var qlog = Math.round(Math.log(q) / Math.log(2));
    if (Math.pow(2, qlog) !== q) throw new Error('q 必须是 2 的幂（当前 ' + q + '）');
    var g = solveMod2(f, n);
    if (!g) return null;

    var bits = 1;
    var cur = toModQ(g, 2);
    while (bits < qlog) {
      bits = Math.min(bits * 2, qlog);
      var m2 = Math.pow(2, bits);
      var fg2 = mul(toModQ(f, m2), cur, m2);
      // t = 2 - f·g 里的 2 是“常数项 2”，只作用在 0 号系数上：
      // t = 2·e₀ - f·g ⇒ t[0] = 2 - fg[0]，其余 t[i] = -fg[i]
      var t = new Float64Array(n);
      t[0] = mod(2 - fg2[0], m2);
      for (var i = 1; i < n; i++) t[i] = mod(-fg2[i], m2);
      cur = mul(cur, t, m2);
    }
    var check = mul(toModQ(f, q), cur, q);
    if (check[0] !== 1) return null;
    for (var k = 1; k < n; k++) if (check[k] !== 0) return null;
    return cur;
  }
  NS.invert = invertModPow2;

  /* ------------------------------------------------------------- NTRU ---- */
  NS.defaultParams = {
    name: 'EES439', n: 439, q: 2048, p: 3,
    df: 146, dg: 146, dr: 146, dm0: 130, dm1: 126
  };

  function params(over) {
    var P = {};
    var base = NS.defaultParams;
    Object.keys(base).forEach(function (k) { P[k] = base[k]; });
    Object.keys(over || {}).forEach(function (k) { P[k] = over[k]; });
    return P;
  }
  NS.params = params;

  function keygen(P, rng, maxTries) {
    var tries = 0, limit = maxTries || 200;
    while (tries < limit) {
      tries++;
      var F = rng.fixedWeight(P.n, P.df, P.df);
      var f = new Array(P.n);
      // f = 1 + p·F：这里的 1 是“多项式常数 1”，只有 0 号系数 +1，
      // 其余系数是 p·F_j（写成每个系数都 +1 会让 f ≢ 1 (mod p)，解密直接全错）
      for (var i = 0; i < P.n; i++) f[i] = P.p * F[i];
      f[0] += 1;
      var finv = invertModPow2(f, P.n, P.q);
      if (!finv) continue;
      var g = rng.fixedWeight(P.n, P.dg, P.dg);
      var h = mulConst(mul(toModQ(g, P.q), finv, P.q), P.p, P.q);
      return {
        f: toModQ(f, P.q), finv: finv, g: toModQ(g, P.q), h: h,
        F: toModQ(F, P.q), tries: tries
      };
    }
    throw new Error('keygen 失败：' + limit + ' 次采样都取不到 f⁻¹');
  }

  function sampleMessage(P, rng) {
    var t = rng.fixedWeight(P.n, P.dm0, P.dm1);
    var m = new Array(P.n);
    for (var i = 0; i < P.n; i++) m[i] = mod(t[i], P.p);
    return m;
  }

  function encrypt(P, h, m, rng) {
    var s = toModQ(rng.fixedWeight(P.n, P.dr, P.dr), P.q);
    return add(mul(h, s, P.q), toModQ(m, P.q), P.q);
  }

  function decryptWithNoise(P, f, c) {
    var a = mul(f, c, P.q);
    return { m: modPCentered(a, P.q, P.p), noise: infNormCenter(a, P.q), raw: a };
  }

  function rekeygen(P, fA, finvB) {
    return mul(fA, finvB, P.q);
  }

  /* ------------------------------------------------- CNF 门限（N 个代理）---- */
  function binom(n, k) {
    if (k < 0 || k > n) return 0;
    k = Math.min(k, n - k);
    var r = 1;
    for (var i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return Math.round(r);
  }
  NS.binom = binom;

  function popcount(x) {
    var c = 0;
    while (x) { x &= x - 1; c++; }
    return c;
  }

  function cnfShare(P, rk, N, t, rng) {
    var subsetSize = N - t + 1;
    var masks = [];
    for (var mask = 0; mask < (1 << N); mask++) {
      if (popcount(mask) === subsetSize) masks.push(mask);
    }
    var vals = [];
    var acc = zeroPoly(P.n);
    for (var i = 0; i + 1 < masks.length; i++) {
      var v = toModQ(rng.uniformPoly(P.n, P.q), P.q);
      acc = add(acc, v, P.q);
      vals.push(v);
    }
    vals.push(sub(rk, acc, P.q));                  // 最后一份由 Σ = rk 反解

    var perProxy = [];
    for (var p = 0; p < N; p++) perProxy.push([]);
    var shares = masks.map(function (mask, idx) {
      var members = [];
      for (var b = 0; b < N; b++) if (mask & (1 << b)) members.push(b);
      var sh = { index: idx, mask: mask, members: members, value: vals[idx] };
      members.forEach(function (p) { perProxy[p].push(sh); });
      return sh;
    });

    return {
      N: N, t: t, subsetSize: subsetSize, masks: masks, shares: shares,
      perProxy: perProxy, count: masks.length,
      holdings: binom(N - 1, t - 1)
    };
  }

  // 单个代理对自己持有的每份份额做一次 partial = C_A·share + p·e
  function partialsForProxy(P, ctx, cA, proxy, rng) {
    var list = ctx.perProxy[proxy];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var e = toModQ(rng.fixedWeight(P.n, P.dr, P.dr), P.q);
      var cs = mul(cA, list[i].value, P.q);
      var pe = mulConst(e, P.p, P.q);
      out.push({ subsetIndex: list[i].index, mask: list[i].mask, value: add(cs, pe, P.q) });
    }
    return out;
  }

  // 组合：每个子集 S 取 owner = min(S ∩ W) 的 partial 求和
  function combine(P, ctx, allPartials, W) {
    var acc = zeroPoly(P.n);
    var used = 0;
    var missing = 0;
    var byProxy = {};
    allPartials.forEach(function (list, proxy) { byProxy[proxy] = list; });

    ctx.shares.forEach(function (sh) {
      var owner = -1;
      for (var i = 0; i < W.length; i++) {
        if (sh.mask & (1 << W[i])) {
          if (owner < 0 || W[i] < owner) owner = W[i];
        }
      }
      if (owner < 0) { missing++; return; }
      var list = byProxy[owner] || [];
      for (var k = 0; k < list.length; k++) {
        if (list[k].subsetIndex === sh.index) {
          acc = add(acc, list[k].value, P.q);
          used++;
          return;
        }
      }
    });
    return { ct: acc, used: used, missing: missing };
  }

  NS.engine = {
    params: params,
    keygen: keygen,
    sampleMessage: sampleMessage,
    encrypt: encrypt,
    decryptWithNoise: decryptWithNoise,
    rekeygen: rekeygen,
    cnfShare: cnfShare,
    partialsForProxy: partialsForProxy,
    combine: combine,
    invert: invertModPow2,
    ring: NS.ring
  };

  global.NTRU = NS;
})(window);
