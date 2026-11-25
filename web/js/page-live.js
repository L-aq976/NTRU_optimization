/* ============================================================================
 *  门限委托 · 现场演示（9 个节点 / 任意 6 个）
 *  文件：web/js/page-live.js
 *
 *  这一页的每个数字都是浏览器里现算的（js/ntru.js：n=439, p=3, q 可调），
 *  动画只负责把过程摊开给人看：
 *     密钥 → 加密 → rk → 拆成 126 份 → 发给 9 个节点 → 选 6 个
 *     → 各节点算 partial → 组合 → Bob 解密 → 噪声仪表判定
 *
 *  q 的用法：同一套流程，q 小则 ‖center(f_B·ct)‖∞ 撞上 q/2 绕回 ⇒ 解密失败；
 *  q 增大预算随之变大 ⇒ 126 份噪声也装得下。这是本页唯一允许"调参"的地方。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var UI = global.UI, h = UI.h, NS = global.NTRU;
  if (!UI || !NS) return;
  var E = NS.engine, R = NS.ring;

  var QS = [2048, 4096, 8192, 16384, 65536, 262144];
  var N_NODES = 9, THRESHOLD = 6;

  /* 部署形态 B（用户指定的 4/4/1）：
   *   A 的 4 个代理挂在 A 的网关（一台 GPU 机器，批量算这 4 个代理的 partial）
   *   B 的 4 个代理挂在 B 的网关（同上）
   *   中立平台只占 1 个代理，另外充当密文舞台（组合者）
   * 一台机器最多代表 t−1 = 5 个代理仍零信息（4 个覆盖 121/126 份，5 个覆盖 125/126 份）；
   * 9 个全放一台就等价于 Σshare = rk，门限直接作废。
   */
  var DOMAINS = [
    { key: 'A', name: 'A 网关', idx: [0, 1, 2, 3], gpu: true },
    { key: 'P', name: '中立平台', idx: [8], gpu: false },
    { key: 'B', name: 'B 网关', idx: [4, 5, 6, 7], gpu: true }
  ];
  // 参与集合的取法：先把 A 的 4 个拿满，再平台 1 个，最后 B 的 —— 默认 6 个跨三方
  var PARTICIPANT_ORDER = [0, 1, 2, 3, 8, 4, 5, 6, 7];

  var st = {
    q: 2048,
    seed: 20261012,
    speed: 1,
    running: false,
    paused: false,          // 整步暂停：只在步骤边界生效
    waiters: [],            // 停在边界时排队的继续回调
    abort: false,
    tok: 0,
    phase: -1,
    stageData: null,
    inspect: { kind: 'msg', label: '明文 M' }
  };

  var dom = {};

  /* ------------------------------------------------------------- 工具 ---- */
  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, Math.max(0, ms / st.speed)); });
  }

  function pct(a, b) { return b ? (a / b * 100) : 0; }

  function fmt(v, d) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toFixed(d === undefined ? 0 : d);
  }

  function signed(a, k) {
    return Array.prototype.slice.call(a, 0, k || 6).map(function (v) {
      return (v > 0 ? '+' : '') + v;
    }).join(' ');
  }

  function log(tag, msg, kind) {
    var d = new Date();
    var t = ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2) +
      '.' + ('00' + d.getMilliseconds()).slice(-3);
    st.logs.push({ t: t, tag: tag, msg: msg, kind: kind || '' });
    if (st.logs.length > 60) st.logs.shift();
    renderLog();
  }

  function renderLog() {
    if (!dom.log) return;
    UI.clear(dom.log).append.apply(dom.log, st.logs.map(function (l) {
      return h('div', { class: 'logline' + (l.kind ? ' is-' + l.kind : '') }, [
        h('span', { class: 'logline__t' }, l.t),
        h('span', { class: 'logline__tag' }, l.tag),
        h('span', { class: 'logline__m' }, l.msg)
      ]);
    }));
    dom.log.scrollTop = dom.log.scrollHeight;
  }

  /* ------------------------------------------------------------- 舞台 ---- */
  function domainEl(key) {
    return document.querySelector('.domain[data-domain="' + key + '"]');
  }

  function pulseDomain(key) {
    var el = domainEl(key);
    if (!el) return;
    el.classList.remove('is-flash');
    void el.offsetWidth;
    el.classList.add('is-flash');
  }

  function nodeEl(i) {
    return dom.nodes[i];
  }

  var NODE_STATES = ['is-idle', 'is-keyed', 'is-in', 'is-out', 'is-busy', 'is-done'];

  function setNode(i, cls) {
    var el = nodeEl(i);
    if (!el) return;
    NODE_STATES.forEach(function (c) { el.classList.remove(c); });
    // 允许一次给多个状态（"is-in is-done"），按空白拆开逐个加
    String(cls || '').split(/\s+/).forEach(function (c) {
      if (c) el.classList.add(c);
    });
  }

  function resetNodes() {
    for (var i = 0; i < N_NODES; i++) {
      setNode(i, 'is-idle');
      var meta = nodeEl(i).querySelector('.node__meta');
      if (meta) meta.textContent = '待命';
      nodeEl(i).querySelector('.node__ring').style.setProperty('--fill', '0%');
    }
  }

  function setHoldings(i, n) {
    var el = nodeEl(i);
    var meta = el.querySelector('.node__meta');
    if (meta) meta.textContent = n + ' 份';
    el.querySelector('.node__ring').style.setProperty('--fill', '100%');
  }

  // 从一个元素飞到另一个元素（chip 形数据包）
  function fly(fromEl, toEl, label, cls, ms) {
    return new Promise(function (resolve) {
      if (!fromEl || !toEl) return resolve();
      var s = dom.stage.getBoundingClientRect();
      var a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
      var x0 = a.left + a.width / 2 - s.left, y0 = a.top + a.height / 2 - s.top;
      var x1 = b.left + b.width / 2 - s.left, y1 = b.top + b.height / 2 - s.top;
      var dur = Math.max(120, (ms || 620) / st.speed);
      var chip = h('div', { class: 'fly ' + (cls || '') }, label);
      chip.style.left = x0 + 'px';
      chip.style.top = y0 + 'px';
      dom.flight.appendChild(chip);
      requestAnimationFrame(function () {
        chip.style.transition = 'transform ' + dur + 'ms cubic-bezier(.35,0,.25,1), opacity ' + dur + 'ms';
        chip.style.transform = 'translate(' + (x1 - x0) + 'px,' + (y1 - y0) + 'px)';
        chip.style.opacity = '0.05';
      });
      setTimeout(function () { chip.remove(); resolve(); }, dur + 60);
    });
  }

  function pulse(el) {
    if (!el) return;
    el.classList.remove('is-flash');
    void el.offsetWidth;
    el.classList.add('is-flash');
  }

  /* ------------------------------------------------------------ 暂停 ---- */
  // 只允许在“步骤边界”暂停：每一步（含 9 份份额的分发、一次网关的批量 partial）都跑完才停
  function gate() {
    if (!st.paused) return Promise.resolve();
    var p = new Promise(function (res) { st.waiters.push(res); });
    syncPauseUI();            // 此刻 st.phase = 刚做完的那一步，标签最准
    return p;
  }

  function pauseFlow() {
    if (!st.running) return;
    st.paused = true;
    syncPauseUI();
  }

  function resumeFlow() {
    st.paused = false;
    var w = st.waiters.splice(0);
    w.forEach(function (f) { f(); });
    syncPauseUI();
  }

  function stepOnce() {
    if (!st.running || !st.paused) return;
    var f = st.waiters.shift();
    if (f) f();                       // 放行一个步骤；paused 仍为 true，下一步会再停
    syncPauseUI();
  }

  function syncPauseUI() {
    var pb = document.querySelector('[data-act="pause"]');
    if (pb) {
      pb.textContent = st.paused ? '▶ 继续' : '⏸ 暂停';
      pb.disabled = !st.running;
      pb.classList.toggle('is-on', st.paused);
    }
    var sb = document.querySelector('[data-act="step"]');
    if (sb) sb.disabled = !(st.running && st.paused);
    // 暂停时：已经跑完的那一步标成“完成”，别让它继续显示成“正在跑”
    if (dom.steps && st.phase >= 0) {
      var li = dom.steps.children[st.phase];
      if (li) {
        li.classList.toggle('is-done', st.paused);
        li.classList.toggle('is-on', !st.paused);
      }
    }
    var tag = document.getElementById('pauseTag');
    if (tag) {
      var next = STEPS[st.phase + 1];
      tag.className = 'pausetag' + (st.paused ? ' is-on' : '');
      tag.textContent = st.paused
        ? '已暂停（当前这一步会做完）· 下一步：' + (next ? next.label : '结束')
        : '';
    }
  }

  /* --------------------------------------------------------- 步骤与状态 ---- */
  var STEPS = [
    { key: 'keygen', label: '生成两对密钥' },
    { key: 'enc', label: '加密 M → C₁' },
    { key: 'rk', label: '委托凭证 rk' },
    { key: 'share', label: '拆成 126 份份额' },
    { key: 'select', label: '选出 6 个节点' },
    { key: 'partial', label: '部分重加密（126 份）' },
    { key: 'combine', label: '组合成 ct' },
    { key: 'decrypt', label: 'Bob 解密' }
  ];

  function setPhase(i) {
    st.phase = i;
    if (!dom.steps) return;
    Array.prototype.forEach.call(dom.steps.children, function (li, idx) {
      li.classList.toggle('is-on', idx === i);
      li.classList.toggle('is-done', idx < i);
    });
    var bar = dom.progress;
    if (bar) bar.style.width = (Math.max(0, Math.min(1, (i + 1) / STEPS.length)) * 100) + '%';
  }

  /* ------------------------------------------------------------ 仪表盘 ---- */
  function gauge(noise, budget, state) {
    if (!dom.gaugeVal) return;   // 之前这段写成 dom.gauge（从未赋值）→ 仪表永远不动
    var capped = noise >= budget - 1;
    var ratio = Math.min(1, noise / (budget || 1));
    dom.gaugeFill.style.width = (ratio * 100).toFixed(1) + '%';
    dom.gaugeFill.className = 'gauge__fill' + (state === 'fail' ? ' is-bad' : state === 'ok' ? ' is-ok' : '');
    dom.gaugeVal.textContent = capped ? '≥ ' + noise + '（q/2 上限）' : String(noise);
    dom.gaugeBudget.textContent = String(budget);
    dom.gaugeTag.textContent = state === 'fail' ? '绕回' : state === 'ok' ? '在预算内' : '待测';
    dom.gaugeTag.className = 'gauge__tag' + (state === 'fail' ? ' is-bad' : state === 'ok' ? ' is-ok' : '');
  }

  function verdict(kind, title, detail) {
    if (!dom.verdict) return;
    UI.clear(dom.verdict);
    dom.verdict.className = 'verdict is-' + kind;
    dom.verdict.appendChild(h('div', { class: 'verdict__icon' }, kind === 'ok' ? '✓' : kind === 'bad' ? '✗' : '◷'));
    dom.verdict.appendChild(h('div', { class: 'verdict__body' }, [
      h('div', { class: 'verdict__title' }, title),
      h('div', { class: 'verdict__detail' }, detail)
    ]));
  }

  /* ------------------------------------------------------------- 主页 ---- */
  function mount(root) {
    dom = {};
    UI.clear(root).append(
      h('section', { class: 'live' }, [
        h('header', { class: 'live__head' }, [
          h('div', { class: 'live__intro' }, [
            h('div', { class: 'live__eyebrow' }, '门限代理重加密 · 现场演示'),
            h('h1', { class: 'live__title' }, [
              '把 ', h('code', null, 'rk = f_A·f_B⁻¹'),
              ' 拆给 9 个节点，任意 ', h('b', null, '6'), ' 个才能完成转换'
            ]),
            h('p', { class: 'live__lead' }, [
              '部署形态 ', h('b', null, '4 / 4 / 1'), '：A 的 4 个代理挂在 A 的网关、B 的 4 个挂在 B 的网关（各一台 GPU 机器），',
              '中立平台 1 个兼做密文舞台。子集大小 4、共 ', h('b', null, 'C(9,5)=126'), ' 份，每节点持 56 份；',
              '任取 ', h('b', null, '6'), ' 个才能合成，任何一方都凑不够。',
              '系数都是浏览器里现算的；暂停只在步骤边界生效，每步不可中断。'
            ])
          ]),
          h('div', { class: 'live__actcol' }, [
            h('div', { class: 'live__act' }, [
              h('button', { class: 'btn btn--run', attrs: { type: 'button' }, data: { act: 'run' } },
                h('span', { class: 'btn__ico' }, '▶'), '开始演示'),
              h('button', {
                class: 'btn btn--ghost', attrs: { type: 'button', disabled: 'disabled' },
                data: { act: 'pause' }, title: '在下一个步骤边界暂停（当前步骤会做完）'
              }, '⏸ 暂停'),
              h('button', {
                class: 'btn btn--ghost', attrs: { type: 'button', disabled: 'disabled' },
                data: { act: 'step' }, title: '暂停时点它：只放行下一个步骤'
              }, '⏭ 单步'),
              h('button', { class: 'btn btn--ghost', attrs: { type: 'button' }, data: { act: 'reset' } }, '↺ 重置'),
              speedPicker()
            ]),
            h('div', { class: 'pausetag', id: 'pauseTag', attrs: { role: 'status' } })
          ])
        ]),
        h('div', { class: 'live__bar' }, [
          h('div', { class: 'live__barItem live__barItem--q' }, [
            h('span', { class: 'live__barK' }, '模数 q'),
            h('div', { class: 'qpick' }, QS.map(function (q) {
              return h('button', {
                class: 'qpick__btn' + (q === st.q ? ' is-on' : ''),
                attrs: { type: 'button' },
                data: { act: 'q', q: String(q) },
                title: 'q = ' + q + '，噪声预算 q/2 = ' + (q / 2)
              }, [
                h('span', { class: 'qpick__pow' }, '2^' + Math.round(Math.log(q) / Math.log(2))),
                h('span', { class: 'qpick__val' }, String(q))
              ]);
            })),
            h('span', { class: 'live__barHint' }, '9-of-6 的门限噪声实测 ≈ 3400–5500 ⇒ q 至少 2^14')
          ]),
          h('div', { class: 'live__barItem' }, [
            h('span', { class: 'live__barK' }, '种子'),
            h('input', {
              class: 'seedInput', attrs: { type: 'number', value: String(st.seed), min: '1' },
              data: { act: 'seed' }
            }),
            h('span', { class: 'live__barHint' }, '同一种子 ⇒ 同样的密钥与份额')
          ]),
          h('div', { class: 'live__barItem live__barItem--facts' }, [
            h('span', { class: 'fact' }, ['n = ', h('b', null, '439')]),
            h('span', { class: 'fact' }, ['p = ', h('b', null, '3')]),
            h('span', { class: 'fact' }, ['q/2 = ', h('b', { data: { qhalf: '1' } }, String(st.q / 2))])
          ])
        ]),
        h('div', { class: 'live__main' }, [
          stage(),
          sidebar()
        ]),
        h('p', { class: 'live__note' }, [
          h('b', null, '算力归属：'),
          'A 网关一次 batch = 4 代理 × 56 份 = ', h('b', null, '224'),
          ' 次卷积，B 网关与平台各 56 次（本次合计 126 份）。单次转换只有 126 次卷积，上 GPU 不划算——',
          '实测 batch=1 时端到端只有 0.72×、batch≥16 才有 9.45×、batch=8192 时 kernel-only 2.03 µs/次（75×）。',
          '所以方案 B 的收益来自“同一网关对一批密文”：batch = 代理数 × 56 × 密文条数。',
          h('span', { class: 'live__noteWarn' }, '演示里的算术仍由浏览器完成，GPU 说的是部署形态，不是这一页真的调了显卡。')
        ]),
        inspector()
      ])
    );

    dom.stage = root.querySelector('#stage');
    dom.flight = root.querySelector('#flight');
    // 新的 4/4/1 布局里 DOM 顺序是 P1..P4, P9, P5..P8 ——
    // 必须按 data-node（代理下标）建索引，否则份额/高亮会张冠李戴
    dom.nodes = [];
    Array.prototype.forEach.call(root.querySelectorAll('.node'), function (el) {
      dom.nodes[Number(el.dataset.node)] = el;
    });
    dom.alice = root.querySelector('#alice');
    dom.bob = root.querySelector('#bob');
    dom.core = root.querySelector('#core');
    dom.steps = root.querySelector('#steps');
    dom.progress = root.querySelector('#progressFill');
    dom.log = root.querySelector('#log');
    dom.gaugeFill = root.querySelector('#gaugeFill');
    dom.gaugeVal = root.querySelector('#gaugeVal');
    dom.gaugeBudget = root.querySelector('#gaugeBudget');
    dom.gaugeTag = root.querySelector('#gaugeTag');
    dom.verdict = root.querySelector('#verdict');
    dom.inspectBody = root.querySelector('#inspectBody');

    bind(root);
    resetAll();
  }

  function speedPicker() {
    return h('div', { class: 'speed' }, [1, 2, 4].map(function (s) {
      return h('button', {
        class: 'speed__btn' + (s === st.speed ? ' is-on' : ''),
        attrs: { type: 'button' }, data: { act: 'speed', s: String(s) }
      }, s + '×');
    }));
  }

  function stage() {
    var domains = DOMAINS.map(function (d) {
      var nodes = d.idx.map(function (i) {
        return h('div', {
          class: 'node is-idle node--' + d.key.toLowerCase(),
          data: { node: String(i) },
          title: 'P' + (i + 1) + '（' + d.name + '）：持有 56 份份额'
        }, [
          h('div', { class: 'node__ring' }),
          h('div', { class: 'node__dot' }, 'P' + (i + 1)),
          h('div', { class: 'node__meta' }, '待命')
        ]);
      });
      return h('div', {
        class: 'domain domain--' + d.key.toLowerCase(),
        data: { domain: d.key },
        title: d.gpu ? d.name + '：4 个代理共用一台 GPU 机器批算 partial' : d.name + '：1 个代理 + 组合者'
      }, [
        h('div', { class: 'domain__tag' }, [
          h('span', { class: 'domain__name' }, d.name),
          h('span', { class: 'domain__sub' }, d.idx.length + ' 个'),
          d.gpu ? h('span', { class: 'domain__gpu' }, 'GPU') : null
        ]),
        h('div', { class: 'dgrid' + (d.idx.length === 1 ? ' dgrid--one' : '') }, nodes)
      ]);
    });

    return h('div', { class: 'stage', id: 'stage' }, [
      h('div', { class: 'stage__label stage__label--alice' }, '发送方 · Alice'),
      h('div', { class: 'actor actor--alice', id: 'alice' }, [
        h('div', { class: 'actor__role' }, 'A'),
        h('div', { class: 'actor__name' }, 'Alice'),
        h('div', { class: 'actor__sub' }, 'f_A / h_A')
      ]),
      h('div', { class: 'actor actor--bob', id: 'bob' }, [
        h('div', { class: 'actor__role' }, 'B'),
        h('div', { class: 'actor__name' }, 'Bob'),
        h('div', { class: 'actor__sub' }, 'f_B / h_B')
      ]),
      h('div', { class: 'stage__label stage__label--bob' }, '接收方 · Bob'),
      h('div', { class: 'domains' }, domains),
      h('div', { class: 'core', id: 'core' }, [
        h('div', { class: 'core__title' }, '密文舞台（中立平台）'),
        h('div', { class: 'core__slot' }, '待运行')
      ]),
      h('div', { class: 'flight', id: 'flight' })
    ]);
  }

  function sidebar() {
    return h('aside', { class: 'side' }, [
      h('div', { class: 'side__block' }, [
        h('div', { class: 'side__title' }, '运行进度'),
        h('div', { class: 'progress' }, h('div', { class: 'progress__fill', id: 'progressFill' })),
        h('ol', { class: 'steps', id: 'steps' }, STEPS.map(function (s) {
          return h('li', { class: 'step' }, [
            h('span', { class: 'step__dot' }),
            h('span', { class: 'step__label' }, s.label)
          ]);
        }))
      ]),
      h('div', { class: 'side__block' }, [
        h('div', { class: 'side__title' }, '噪声预算 ‖center(f_B·ct)‖∞'),
        h('div', { class: 'gauge' }, [
          h('div', { class: 'gauge__track' }, h('div', { class: 'gauge__fill', id: 'gaugeFill' })),
          h('div', { class: 'gauge__nums' }, [
            h('span', { class: 'gauge__val', id: 'gaugeVal' }, '—'),
            h('span', { class: 'gauge__sep' }, '/'),
            h('span', { class: 'gauge__budget', id: 'gaugeBudget' }, String(st.q / 2)),
            h('span', { class: 'gauge__tag', id: 'gaugeTag' }, '待测')
          ])
        ])
      ]),
      h('div', { class: 'verdict is-idle', id: 'verdict' }, [
        h('div', { class: 'verdict__icon' }, '◷'),
        h('div', { class: 'verdict__body' }, [
          h('div', { class: 'verdict__title' }, '等待开始'),
          h('div', { class: 'verdict__detail' }, '点「开始演示」跑一遍 9 → 6 的完整链路')
        ])
      ]),
      h('div', { class: 'side__block side__block--log' }, [
        h('div', { class: 'side__title' }, '运行日志'),
        h('div', { class: 'log', id: 'log' })
      ])
    ]);
  }

  function inspector() {
    return h('div', { class: 'inspect' }, [
      h('div', { class: 'inspect__head' }, [
        h('div', { class: 'inspect__title' }, '系数检查器'),
        h('div', { class: 'inspect__hint' }, '点节点 / 密文舞台 / Alice / Bob 看对应多项式（439 个系数，中心代表）')
      ]),
      h('div', { class: 'inspect__body', id: 'inspectBody' }, [
        h('div', { class: 'inspect__empty' }, '还没有数据')
      ])
    ]);
  }

  /* --------------------------------------------------------- 检查器渲染 ---- */
  function renderInspect() {
    var body = dom.inspectBody || document.getElementById('inspectBody');
    if (!body || !st.stageData) return;
    var d = st.stageData, k = st.inspect;
    var poly = null, note = '';
    if (k.kind === 'msg') { poly = d.m; note = '明文 M（∈ R/p，{0,1,2}）'; }
    else if (k.kind === 'c1') { poly = d.C1; note = 'Alice 的密文 C₁ = h_A·s₁ + M'; }
    else if (k.kind === 'rk') { poly = d.rk; note = '委托凭证 rk = f_A·f_B⁻¹'; }
    // 份额/partial 是“点哪个节点就看哪个”，存在 st.inspect 里，不在 stageData 上
    else if (k.kind === 'share') { poly = k.share; note = k.shareNote; }
    else if (k.kind === 'partial') { poly = k.partial; note = k.partialNote; }
    else if (k.kind === 'ct') { poly = d.ct; note = '组合结果 ct = Σ owner-partial'; }
    else if (k.kind === 'dec') { poly = d.decRaw; note = 'center(f_B·ct)，逐系数 |v| 与 q/2 比'; }
    else if (k.kind === 'fA') { poly = d.A.f; note = 'Alice 私钥 f_A（≡ 1 mod p）'; }
    else if (k.kind === 'fB') { poly = d.B.f; note = 'Bob 私钥 f_B'; }

    if (!poly) { UI.clear(body); body.appendChild(h('div', { class: 'inspect__empty' }, '该对象还没生成')); return; }

    var centered = R.center(poly, st.q);
    var maxAbs = 1;
    centered.forEach(function (v) { var a = Math.abs(v); if (a > maxAbs) maxAbs = a; });

    UI.clear(body);
    body.appendChild(h('div', { class: 'inspect__meta' }, [
      h('span', { class: 'inspect__label' }, note),
      h('span', { class: 'inspect__stats' }, '‖v‖∞ = ' + maxAbs + ' · 前 8 个系数 ' + signed(centered, 8))
    ]));

    var W = 894, H = 70, mid = H / 2;
    var svg = UI.s('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'inspect__svg', preserveAspectRatio: 'none' });
    svg.appendChild(UI.s('line', { x1: 0, x2: W, y1: mid, y2: mid, stroke: '#dfe6f2', 'stroke-width': 1 }));
    var bw = W / centered.length;
    centered.forEach(function (v, i) {
      var hgt = Math.max(0.8, Math.abs(v) / maxAbs * (mid - 3));
      svg.appendChild(UI.s('rect', {
        x: (i * bw).toFixed(2), y: (v >= 0 ? mid - hgt : mid).toFixed(2),
        width: Math.max(0.7, bw - 0.25).toFixed(2), height: hgt.toFixed(2),
        fill: v >= 0 ? '#2a78d6' : '#eb6834'
      }));
    });
    body.appendChild(svg);

    var legend = h('div', { class: 'inspect__legend' }, [
      h('span', null, [h('i', { class: 'sw sw--pos' }), '正系数']),
      h('span', null, [h('i', { class: 'sw sw--neg' }), '负系数']),
      h('span', { class: 'inspect__count' }, centered.length + ' 个系数，高度按 ‖v‖∞ 归一')
    ]);
    body.appendChild(legend);
  }

  function inspect(kind, extra) {
    st.inspect = Object.assign({ kind: kind }, extra || {});
    renderInspect();
  }

  /* ------------------------------------------------------------- 绑定 ---- */
  function bind(root) {
    root.addEventListener('click', function (e) {
      var q = e.target.closest('[data-act]');
      if (q) {
        var act = q.dataset.act;
        if (act === 'run') { runAll(); return; }
        if (act === 'reset') { resetAll(); return; }
        if (act === 'pause') {
          if (st.paused) resumeFlow(); else pauseFlow();
          return;
        }
        if (act === 'step') { stepOnce(); return; }
        if (act === 'q') {
          if (st.running) return;
          st.q = Number(q.dataset.q);
          refreshQ();
          resetAll();
          return;
        }
        if (act === 'speed') {
          st.speed = Number(q.dataset.s);
          Array.prototype.forEach.call(root.querySelectorAll('.speed__btn'), function (b) {
            b.classList.toggle('is-on', Number(b.dataset.s) === st.speed);
          });
          return;
        }
        if (act === 'raise') {
          var next = Number(q.dataset.q) || 16384;
          st.q = next;
          refreshQ();
          runAll();
          return;
        }
        if (act === 'try5') { runWith(5); return; }
        if (act === 'again') { runAll(); return; }
        return;
      }

      var node = e.target.closest('.node');
      if (node && st.stageData) { inspectNode(Number(node.dataset.node)); return; }
      if (e.target.closest('#core') && st.stageData) { inspect(st.stageData.coreDefault || 'ct'); return; }
      if (e.target.closest('#alice') && st.stageData) { inspect('fA'); return; }
      if (e.target.closest('#bob') && st.stageData) { inspect('fB'); return; }
    });

    root.addEventListener('change', function (e) {
      if (e.target.dataset.act !== 'seed') return;
      var v = Number(e.target.value);
      if (!isFinite(v) || v < 1) return;
      st.seed = Math.floor(v);
      resetAll();
      log('seed', '种子设为 ' + st.seed, 'muted');
    });
  }

  function inspectNode(i) {
    var d = st.stageData;
    if (!d) return;
    if (!d.perProxyPartials || !d.perProxyPartials[i] || !d.perProxyPartials[i].length) {
      inspect('share', { share: d.perProxyShares[i][0].value, shareNote: 'P' + (i + 1) + ' 的最早一份份额（第 ' + (d.perProxyShares[i][0].mask.toString(2).padStart(N_NODES, '0')) + ' 号子集）' });
      return;
    }
    var p = d.perProxyPartials[i][0];
    inspect('partial', {
      partial: p.value,
      partialNote: 'P' + (i + 1) + ' 对子集 ' + p.mask.toString(2).padStart(N_NODES, '0') + ' 的 partial = C₁·share + p·e'
    });
  }

  function refreshQ() {
    Array.prototype.forEach.call(document.querySelectorAll('.qpick__btn'), function (b) {
      b.classList.toggle('is-on', Number(b.dataset.q) === st.q);
    });
    var qh = document.querySelector('[data-qhalf]');
    if (qh) qh.textContent = String(st.q / 2);
    gauge(0, st.q / 2, 'idle');
  }

  function resetAll() {
    st.abort = true;
    st.tok++;
    st.running = false;
    st.paused = false;
    st.waiters = [];
    st.stageData = null;
    st.logs = [];
    st.phase = -1;
    setPhase(-1);
    resetNodes();
    if (dom.core) {
      UI.clear(dom.core);
      dom.core.appendChild(h('div', { class: 'core__title' }, '密文舞台（中立平台）'));
      dom.core.appendChild(h('div', { class: 'core__slot' }, 'q = ' + st.q + '，待运行'));
    }
    gauge(0, st.q / 2, 'idle');
    verdict('idle', '等待开始', '点「开始演示」跑一遍 9 → 6 的完整链路');
    if (dom.log) UI.clear(dom.log);
    var body = dom.inspectBody;
    if (body) { UI.clear(body); body.appendChild(h('div', { class: 'inspect__empty' }, '还没有数据')); }
    var runBtn = document.querySelector('[data-act="run"]');
    if (runBtn) runBtn.classList.remove('is-busy');
    syncPauseUI();
  }

  /* ------------------------------------------------------------- 运行 ---- */
  function coreSlot(text, cls) {
    if (!dom.core) return;
    UI.clear(dom.core);
    dom.core.appendChild(h('div', { class: 'core__title' }, '密文舞台（中立平台）'));
    dom.core.appendChild(h('div', { class: 'core__slot' + (cls ? ' is-' + cls : '') }, text));
  }

  function runAll() {
    if (st.running) return;
    runWith(THRESHOLD);
  }

  // wSize = 参与集合 |W|；注意分享的门限 t 永远是 THRESHOLD(=6)，
  // 对照跑只改“到场几个节点”，不改方案本身（否则就变成 5-of-9 的另一个方案了）
  async function runWith(wSize) {
    if (st.running) return;
    st.running = true;
    st.abort = false;
    st.paused = false;
    st.waiters = [];
    var tok = ++st.tok;
    syncPauseUI();
    var runBtn = document.querySelector('[data-act="run"]');
    if (runBtn) runBtn.classList.add('is-busy');
    st.logs = [];
    renderLog();
    verdict('run', wSize === THRESHOLD
      ? '正在运行：9 个节点，需要 ' + THRESHOLD + ' 个'
      : '对照运行：只给 ' + wSize + ' 个节点（门限仍是 ' + THRESHOLD + '）', 'q = ' + st.q + ' · seed = ' + st.seed);

    gauge(0, Math.floor(st.q / 2), 'idle');
    var P = NS.params({ q: st.q });
    var rng = NS.makeRng(st.seed);
    var t0 = Date.now();

    try {
      /* ① 密钥 --------------------------------------------------------- */
      await gate();
      setPhase(0);
      resetNodes();
      coreSlot('keygen…');
      log('keygen', 'P = { n=' + P.n + ', q=' + P.q + ', p=' + P.p + ', df=dg=dr=' + P.df + ' }');
      await sleep(260);
      var A = E.keygen(P, rng);
      var B = E.keygen(P, rng);
      st.stageData = { P: P, A: A, B: B };
      log('keygen', 'Alice: f_A ' + signed(R.center(A.f, P.q), 4) + ' …（f ≡ 1 mod p）', 'ok');
      log('keygen', 'Bob  : f_B ' + signed(R.center(B.f, P.q), 4) + ' …', 'ok');
      log('keygen', 'h_A = p·g·f_A⁻¹ mod q，h_B 同理', 'muted');
      coreSlot('f_A, h_A, f_B, h_B ✓', 'ok');
      pulse(dom.alice); pulse(dom.bob);

      /* ② 加密 --------------------------------------------------------- */
      await gate();
      setPhase(1);
      await sleep(200);
      var m = E.sampleMessage(P, rng);
      var C1 = E.encrypt(P, A.h, m, rng);
      st.stageData.m = m; st.stageData.C1 = C1;
      await fly(dom.alice, dom.core, 'C₁', 'fly--ct', 620);
      coreSlot('C₁ = h_A·s₁ + M', 'info');
      log('encrypt', 'C₁ = h_A·s₁ + M，前 4 个系数 ' + signed(R.center(C1, P.q), 4), 'ok');
      var dA = E.decryptWithNoise(P, A.f, C1);
      var expect = R.messageToCenter(m, P.p);
      var aliceOk = R.equal(dA.m, expect);
      log('encrypt', 'Alice 自查 f_A·C₁ → 明文' + (aliceOk ? '一致 ✓' : '不一致 ✗') + '（噪声 ' + dA.noise + '）', aliceOk ? 'ok' : 'bad');
      inspect('msg');

      /* ③ rk ----------------------------------------------------------- */
      await gate();
      setPhase(2);
      await sleep(200);
      var rk = E.rekeygen(P, A.f, B.finv);
      st.stageData.rk = rk;
      await fly(dom.alice, dom.core, 'rk', 'fly--rk', 620);
      log('rk', 'rk = f_A·f_B⁻¹，前 4 个系数 ' + signed(R.center(rk, P.q), 4), 'ok');

      /* ④ 拆份额 ------------------------------------------------------- */
      await gate();
      setPhase(3);
      await sleep(160);
      var ctx = E.cnfShare(P, rk, N_NODES, THRESHOLD, rng);
      st.stageData.ctx = ctx;
      log('share', 'cnf_share：子集大小 ' + ctx.subsetSize + '，共 m = C(' + N_NODES + ',' + (THRESHOLD - 1) + ') = ' + ctx.count + ' 份');
      log('share', '每节点持有 C(' + (N_NODES - 1) + ',' + (THRESHOLD - 1) + ') = ' + ctx.holdings + ' 份；最后一份由 Σshare = rk 反解', 'muted');

      for (var i = 0; i < N_NODES; i++) {
        if (st.abort || tok !== st.tok) return;
        setNode(i, 'is-keyed');
        await fly(dom.core, nodeEl(i), ctx.perProxy[i].length + ' 份', 'fly--share', 300);
        setHoldings(i, ctx.perProxy[i].length);
        await sleep(60);
      }
      var acc = R.zero(P.n);
      ctx.shares.forEach(function (s) { acc = R.add(acc, s.value, P.q); });
      var sumOk = R.equal(acc, R.toModQ(rk, P.q));
      log('share', '自检 Σ 全部 ' + ctx.count + ' 份份额 = rk：' + (sumOk ? '成立 ✓' : '不成立 ✗'), sumOk ? 'ok' : 'bad');
      st.stageData.perProxyShares = ctx.perProxy;

      /* ⑤ 选 W --------------------------------------------------------- */
      await gate();
      setPhase(4);
      await sleep(220);
      var W = PARTICIPANT_ORDER.slice(0, Math.min(wSize, N_NODES));
      st.stageData.W = W;
      for (var j = 0; j < N_NODES; j++) {
        setNode(j, W.indexOf(j) >= 0 ? 'is-in' : 'is-out');
      }
      var byOwner = DOMAINS.map(function (d) {
        var c = d.idx.filter(function (i) { return W.indexOf(i) >= 0; }).length;
        return c ? d.name + '×' + c : null;
      }).filter(Boolean).join(' + ');
      log('select', 'W = {' + W.map(function (x) { return 'P' + (x + 1); }).join(', ') + '} = ' + byOwner +
        ' = ' + W.length + ' 个（需要 ' + THRESHOLD + ' 个）', 'ok');
      await sleep(200);

      /* ⑥ 部分重加密：按“一台机器算它名下那几个代理”批量来 ------------- */
      await gate();
      setPhase(5);
      var parts = [];
      for (var z = 0; z < N_NODES; z++) parts.push([]);
      var convs = 0;
      for (var di = 0; di < DOMAINS.length; di++) {
        if (st.abort || tok !== st.tok) return;
        var dm = DOMAINS[di];
        var members = dm.idx.filter(function (i) { return W.indexOf(i) >= 0; });
        if (!members.length) {
          log('partial', dm.name + '：本次没有代理参与，跳过', 'muted');
          continue;
        }
        members.forEach(function (i) { setNode(i, 'is-busy'); });
        pulseDomain(dm.key);
        await sleep(40);
        for (var k = 0; k < members.length; k++) {
          parts[members[k]] = E.partialsForProxy(P, ctx, C1, members[k], rng);
        }
        st.stageData.perProxyPartials = parts;
        members.forEach(function (i) { setNode(i, 'is-in is-done'); });
        var batch = members.length * ctx.holdings;
        convs += batch;
        await fly(domainEl(dm.key) || dom.core, dom.core, dm.name + ' · ' + batch + ' 次卷积', 'fly--part', 340);
        log('partial', dm.name + '（' + members.map(function (i) { return 'P' + (i + 1); }).join('/') +
          '）：batch = ' + members.length + ' 代理 × ' + ctx.holdings + ' 份 = ' + batch + ' 次卷积' +
          (dm.gpu ? '（部署时这一批交给该网关的 GPU）' : ''), 'muted');
      }
      coreSlot('126 份 partial 就绪 · 共 ' + convs + ' 次卷积', 'ok');

      /* ⑦ 组合 --------------------------------------------------------- */
      await gate();
      setPhase(6);
      await sleep(200);
      var comb = E.combine(P, ctx, parts, W);
      st.stageData.ct = comb.ct;
      coreSlot('ct = Σ owner-partial（' + comb.used + ' 份）', 'info');
      log('combine', '每个子集取 owner = min(S∩W) 的 partial，共 ' + comb.used + ' 份相加 → ct');
      if (comb.missing) log('combine', '缺 ' + comb.missing + ' 份（与 W 不相交的子集）', 'bad');

      /* ⑧ 解密 --------------------------------------------------------- */
      await gate();
      setPhase(7);
      await sleep(200);
      await fly(dom.core, dom.bob, 'ct', 'fly--ct', 640);
      var d = E.decryptWithNoise(P, B.f, comb.ct);
      st.stageData.decRaw = d.raw;
      var ok = R.equal(d.m, expect) && comb.missing === 0;
      var budget = Math.floor(P.q / 2);
      gauge(d.noise, budget, ok ? 'ok' : 'fail');
      log('decrypt', '‖center(f_B·ct)‖∞ = ' + d.noise + '，q/2 = ' + budget +
        (d.noise >= budget - 1 ? '（已触及上限 ⇒ 绕回）' : '（余量 ' + fmt((1 - d.noise / budget) * 100, 1) + '%）'),
        ok ? 'ok' : 'bad');
      log('decrypt', '解出的明文前 4 项 ' + signed(d.m, 4) + ' / 期望 ' + signed(expect, 4), ok ? 'ok' : 'bad');
      inspect('dec');

      /* ⑨ 结论 --------------------------------------------------------- */
      var ms = Date.now() - t0;
      if (ok) {
        verdict('ok', '成功：6 个节点完成转换，Bob 逐系数还原明文',
          '噪声 ' + d.noise + ' < q/2 = ' + budget + '（占 ' + fmt(pct(d.noise, budget), 1) + '%）· 组合 ' + comb.used +
          ' 份 · 全程 ' + ms + ' ms');
        log('done', '✓ 门限转换成功（' + ms + ' ms）', 'ok');
        if (wSize === THRESHOLD) offerTry5();
      } else if (comb.missing > 0) {
        gauge(d.noise, budget, 'idle');
        if (dom.gaugeTag) { dom.gaugeTag.textContent = '不适用（缺份）'; }
        verdict('bad', '失败（结构性）：缺 ' + comb.missing + ' 份均匀随机份额',
          '参与集合只有 ' + wSize + ' 个 < t = ' + THRESHOLD + '，[N]\\W 那个子集没人提供 partial；' +
          '组合结果与 rk 无关 —— 不是代码拦截，是信息不够。');
        log('done', '✗ 结构性失败：缺 ' + comb.missing + ' 份（|W| = ' + wSize + ' < t = ' + THRESHOLD + '）', 'bad');
      } else {
        // 实测：n=439、126 份 partial 的门限噪声在 3400–5500 之间，
        // 所以 q/2 至少要 8192 ⇒ q ≥ 2^14 才算有余量（2^13 会时好时坏）
        var need = 16384;
        var next = QS.find(function (x) { return x >= need; }) || QS[QS.length - 1];
        verdict('bad', '失败（噪声绕回）：已顶到 q/2 上限',
          '126 份 partial 的噪声把 f_B·ct 推过了 q/2 = ' + budget + '，center() 绕回、mod 3 结构被破坏。' +
          '实测 9-of-6 的噪声在 3400–5500，把 q 提到 ' + next + '（预算 ' + (next / 2) + '）就装得下。');
        log('done', '✗ 噪声绕回（q/2 = ' + budget + '，实测噪声需要 ~3400–5500）', 'bad');
        if (st.q < next) offerRaise(next);
      }
      st.stageData.coreDefault = 'ct';
    } catch (err) {
      log('error', String(err && err.message || err), 'bad');
      verdict('bad', '运行出错', String(err && err.message || err));
    } finally {
      st.running = false;
      st.paused = false;
      st.waiters = [];
      syncPauseUI();
      var b2 = document.querySelector('[data-act="run"]');
      if (b2) b2.classList.remove('is-busy');
    }
  }

  function offerRaise(nextQ) {
    var body = dom.verdict && dom.verdict.querySelector('.verdict__body');
    if (!body) return;
    body.appendChild(h('button', {
      class: 'btn btn--tiny', attrs: { type: 'button' }, data: { act: 'raise', q: String(nextQ) }
    }, '把 q 提到 ' + nextQ + ' 再跑一次 →'));
  }

  function offerTry5() {
    var body = dom.verdict && dom.verdict.querySelector('.verdict__body');
    if (!body) return;
    body.appendChild(h('button', {
      class: 'btn btn--tiny', attrs: { type: 'button' }, data: { act: 'try5' }
    }, '对照：只给 5 个节点再跑一次 →'));
  }

  global.PageLive = { mount: mount };
})(window);
