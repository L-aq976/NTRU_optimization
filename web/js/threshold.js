/* ============================================================================
 *  CNF 子集加性分享的结构计算（纯结构，不含任何随机数）
 *  文件：web/js/threshold.js
 *
 *  只复现 src/core/threshold.h/.cpp 里"谁持有哪份份额、组合时取谁的"这一层：
 *    · 子集大小 s = n - t + 1，子集数 m = C(n, t-1)（与 C(n, s) 相等）
 *    · 代理 i 持有所有包含 i 的子集份额，共 C(n-1, t-1) 份
 *    · 组合时每个子集 S 取 owner = min(S ∩ W) 的那份 partial
 *    · |W| = t-1 时恰有 1 个子集与 W 不相交（= [n]\W），那份份额缺失
 *
 *  ⚠️ 这里不计算任何多项式/噪声：partial 的数值只能由 C++ 引擎给出。
 *     本文件的输出用于画"结构图"和"缺失子集"，它们由 (n,t,W) 唯一确定。
 * ==========================================================================*/
(function (global) {
  'use strict';

  function popcount(x) {
    var c = 0;
    while (x) { x &= x - 1; c++; }
    return c;
  }

  function binom(n, k) {
    if (k < 0 || k > n) return 0;
    k = Math.min(k, n - k);
    var r = 1;
    for (var i = 0; i < k; i++) r = r * (n - i) / (i + 1);
    return Math.round(r);
  }

  // 枚举大小恰为 size 的全部掩码（n ≤ 20 时可行；界面限制 n ≤ 8）
  function masksOfSize(n, size) {
    var out = [];
    for (var mask = 0; mask < (1 << n); mask++) {
      if (popcount(mask) === size) out.push(mask);
    }
    return out;
  }

  function membersOf(mask, n) {
    var out = [];
    for (var i = 0; i < n; i++) if (mask & (1 << i)) out.push(i);
    return out;
  }

  function label(i) { return 'P' + (i + 1); }

  /* 构造结构：
   *   n, t        —— 代理总数、门限
   *   W           —— 参与集合（代理下标数组），|W| 应等于 t 或 t-1
   * 返回：
   *   subsetSize, count, subsets[{index,mask,members,labels,owner,covered}]
   *   holdings[n][...subsetIndex]
   *   missing      —— 与 W 不相交的子集（|W|=t 时为空数组）
   *   participants —— 排序后的 W
   */
  function structure(n, t, W) {
    var subsetSize = n - t + 1;
    var masks = masksOfSize(n, subsetSize);
    var inW = {};
    (W || []).forEach(function (p) { inW[p] = true; });

    var holdings = [];
    for (var i = 0; i < n; i++) holdings.push([]);

    var missing = [];
    var subsets = masks.map(function (mask, index) {
      var members = membersOf(mask, n);
      var inter = members.filter(function (p) { return inW[p]; });
      var owner = inter.length ? Math.min.apply(null, inter) : -1;
      members.forEach(function (p) { holdings[p].push(index); });
      if (owner < 0) missing.push({ index: index, mask: mask, members: members, labels: members.map(label) });
      return {
        index: index,
        mask: mask,
        members: members,
        labels: members.map(label),
        owner: owner,
        covered: owner >= 0
      };
    });

    return {
      n: n, t: t,
      subsetSize: subsetSize,
      count: subsets.length,
      expectCount: binom(n, t - 1),
      expectHoldings: binom(n - 1, t - 1),
      subsets: subsets,
      holdings: holdings,
      missing: missing,
      participants: (W || []).slice().sort(function (a, b) { return a - b; }),
      wSize: (W || []).length
    };
  }

  global.NTRU_THRESHOLD = {
    popcount: popcount,
    binom: binom,
    structure: structure,
    label: label
  };
})(window);
