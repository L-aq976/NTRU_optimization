/* ============================================================================
 *  应用外壳：导航、hash 路由、后端状态
 *  文件：web/js/app.js
 *
 *  里程碑：本期只交付「C1 门限」一页；其余页签保留入口并标注所属里程碑，
 *  路由到未交付页面时给出占位说明（不假装有数据）。
 * ==========================================================================*/
(function (global) {
  'use strict';
  var UI = global.UI, h = UI.h;

  /* 只留做完了的两页：没实现的里程碑不放进导航，免得点进去是空的 */
  var PAGES = [
    { id: 'live', label: '演示' },
    { id: 'c1', label: 'C1 数据' }
  ];

  var backend = { checked: false, ok: false, kind: null, info: null, detail: '' };

  /* 后端探测走 js/api.js：file:// 下它会立刻返回 offline，不会产生无用的 CORS 报错 */
  function probeBackend() {
    var API = global.API;
    if (!API) { backend.checked = true; backend.kind = 'offline'; renderStatus(); return; }
    API.health({ timeout: 1500 }).then(function (r) {
      backend.checked = true;
      backend.ok = !!r.ok;
      backend.kind = r.ok ? null : r.kind;
      backend.info = r.ok ? r.data : null;
      backend.detail = r.ok ? '' : (r.error || '');
      renderStatus();
    });
  }

  function renderStatus() {
    var slot = document.getElementById('status-slot');
    if (!slot) return;
    UI.clear(slot);
    if (!backend.checked) {
      slot.appendChild(UI.badge('检测后端…', 'idle'));
      return;
    }
    if (backend.ok) {
      var j = backend.info || {};
      slot.appendChild(UI.badge('后端在线 · ' + (j.version || 'ntru_demo'), 'ok',
        'pid ' + (j.pid === undefined ? '?' : j.pid) + ' · port ' + (j.port === undefined ? '?' : j.port)));
      return;
    }
    if (backend.kind === 'offline') {
      slot.appendChild(UI.badge('无后端 · 静态预览', 'warn',
        'file:// 打开：页面只用录制数据；改用 ntru_demo.exe 提供本目录即可转为在线'));
      return;
    }
    slot.appendChild(UI.badge('后端异常', 'warn', backend.detail || '健康检查失败'));
  }

  function nav(active) {
    return h('nav', { class: 'nav', attrs: { role: 'navigation' } }, PAGES.map(function (p) {
      var on = p.id === active;
      return h('a', {
        class: 'nav__item' + (on ? ' is-on' : ''),
        href: '#/' + p.id,
        attrs: { 'aria-current': on ? 'page' : null }
      }, h('span', { class: 'nav__label' }, p.label));
    }));
  }

  function shell(active, content) {
    UI.clear(document.getElementById('app')).append(
      h('header', { class: 'topbar' }, [
        h('div', { class: 'topbar__left' }, [
          h('div', { class: 'brand' }, [
            h('span', { class: 'brand__mark', attrs: { 'aria-hidden': 'true' } }, '◈'),
            h('div', { class: 'brand__text' }, [
              h('div', { class: 'brand__title' }, 'NTRU-PRE 实时演示'),
              h('div', { class: 'brand__sub' }, '门限代理重加密 · 密码竞赛作品 · 本机离线')
            ])
          ])
        ]),
        h('div', { class: 'topbar__right' }, [
          h('div', { class: 'topbar__status', id: 'status-slot' }),
          h('div', { class: 'topbar__repo' }, [
            h('span', { class: 'topbar__repoK' }, 'repo'),
            h('code', null, '最终方案/')
          ])
        ])
      ]),
      nav(active),
      h('main', { class: 'main', id: 'main' }, content)
    );
    renderStatus();
  }

  function route() {
    var hash = location.hash.replace(/^#\/?/, '') || 'live';
    var page = PAGES.find(function (p) { return p.id === hash; }) || PAGES[0];
    if (page.id === 'c1' && global.PageC1) {
      shell('c1', h('div', { id: 'c1-root' }));
      global.PageC1.bind(document.getElementById('app'));
      global.PageC1.mount(document.getElementById('c1-root'));
    } else if (global.PageLive) {
      shell('live', h('div', { id: 'live-root' }));
      global.PageLive.mount(document.getElementById('live-root'));
    } else {
      shell('live', h('div', { class: 'placeholder' },
        h('h2', null, '演示模块没加载'),
        h('p', null, 'js/page-live.js 与 js/ntru.js 需要在本页之前引入。')));
    }
    window.scrollTo(0, 0);
  }

  function boot() {
    UI.ensureTip();
    probeBackend();
    window.addEventListener('hashchange', route);
    if (!location.hash) location.replace('#/live');
    route();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
