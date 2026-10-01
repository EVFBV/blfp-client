/* 布局调试器的共享定义：属性分组、受管属性列表、界面清单。
   主窗口（应用样式）和调试器窗口（画控件）共用同一份，
   避免两边各写一套导致"面板上有的属性实际没生效"。 */
(function (root) {
  'use strict';

  /* 本工具会写、也需要负责清除的全部属性 */
  var MANAGED = [
    'translate', 'transform', 'z-index', 'position',
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap',
    'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'color',
    'background-color', 'border-width', 'border-style', 'border-color', 'border-radius',
    'opacity', 'box-shadow', 'display', 'visibility', 'overflow'
  ];

  /* 属性分组。virt=true 表示不是真的 CSS 属性，由工具合成（位移/缩放/旋转） */
  var GROUPS = [
    { name: '位置', props: [
      { k: 'dx', label: 'X 位移', type: 'range', min: -400, max: 400, step: 1, unit: 'px', virt: true, def: 0 },
      { k: 'dy', label: 'Y 位移', type: 'range', min: -400, max: 400, step: 1, unit: 'px', virt: true, def: 0 },
      { k: 'z-index', label: '层级', type: 'range', min: -10, max: 200, step: 1 },
      { k: 'position', label: '定位', type: 'select', opts: ['', 'static', 'relative', 'absolute', 'fixed', 'sticky'] }
    ]},
    { name: '尺寸', props: [
      { k: 'width', label: '宽', type: 'text', ph: 'auto / 200px / 50%' },
      { k: 'height', label: '高', type: 'text', ph: 'auto / 200px' },
      { k: 'min-width', label: '最小宽', type: 'text', ph: '0' },
      { k: 'max-width', label: '最大宽', type: 'text', ph: 'none' },
      { k: 'min-height', label: '最小高', type: 'text', ph: '0' },
      { k: 'max-height', label: '最大高', type: 'text', ph: 'none' }
    ]},
    { name: '间距', props: [
      { k: 'margin-top', label: '外边距 上', type: 'range', min: -100, max: 200, step: 1, unit: 'px' },
      { k: 'margin-bottom', label: '外边距 下', type: 'range', min: -100, max: 200, step: 1, unit: 'px' },
      { k: 'margin-left', label: '外边距 左', type: 'range', min: -100, max: 200, step: 1, unit: 'px' },
      { k: 'margin-right', label: '外边距 右', type: 'range', min: -100, max: 200, step: 1, unit: 'px' },
      { k: 'padding-top', label: '内边距 上', type: 'range', min: 0, max: 120, step: 1, unit: 'px' },
      { k: 'padding-bottom', label: '内边距 下', type: 'range', min: 0, max: 120, step: 1, unit: 'px' },
      { k: 'padding-left', label: '内边距 左', type: 'range', min: 0, max: 120, step: 1, unit: 'px' },
      { k: 'padding-right', label: '内边距 右', type: 'range', min: 0, max: 120, step: 1, unit: 'px' },
      { k: 'gap', label: '子元素间距', type: 'range', min: 0, max: 80, step: 1, unit: 'px' }
    ]},
    { name: '排版', props: [
      { k: 'font-size', label: '字号', type: 'range', min: 8, max: 72, step: 0.5, unit: 'px' },
      { k: 'font-weight', label: '字重', type: 'select', opts: ['', '300', '400', '500', '600', '700', '800', '900'] },
      { k: 'line-height', label: '行高', type: 'range', min: 0.8, max: 3, step: 0.05, unit: '' },
      { k: 'letter-spacing', label: '字间距', type: 'range', min: -2, max: 8, step: 0.1, unit: 'px' },
      { k: 'text-align', label: '对齐', type: 'select', opts: ['', 'left', 'center', 'right', 'justify'] },
      { k: 'color', label: '文字色', type: 'color' }
    ]},
    { name: '外观', props: [
      { k: 'background-color', label: '背景色', type: 'color' },
      { k: 'border-width', label: '边框宽', type: 'range', min: 0, max: 20, step: 1, unit: 'px' },
      { k: 'border-style', label: '边框样式', type: 'select', opts: ['', 'solid', 'dashed', 'dotted', 'none'] },
      { k: 'border-color', label: '边框色', type: 'color' },
      { k: 'border-radius', label: '圆角', type: 'range', min: 0, max: 60, step: 1, unit: 'px' },
      { k: 'opacity', label: '不透明度', type: 'range', min: 0, max: 1, step: 0.01, unit: '' },
      { k: 'box-shadow', label: '阴影', type: 'text', ph: '0 4px 12px rgba(0,0,0,.4)' }
    ]},
    { name: '变换', props: [
      { k: 'scale', label: '缩放', type: 'range', min: 0.2, max: 3, step: 0.01, unit: '×', virt: true, def: 1 },
      { k: 'rotate', label: '旋转', type: 'range', min: -180, max: 180, step: 1, unit: '°', virt: true, def: 0 }
    ]},
    { name: '显示', props: [
      { k: 'display', label: 'display', type: 'select', opts: ['', 'block', 'flex', 'inline-flex', 'inline-block', 'grid', 'none'] },
      { k: 'visibility', label: '可见性', type: 'select', opts: ['', 'visible', 'hidden'] },
      { k: 'overflow', label: '溢出', type: 'select', opts: ['', 'visible', 'hidden', 'auto', 'scroll'] }
    ]}
  ];

  /* 所有界面：普通页面 + 藏在 .hidden 里的弹窗/遮罩。
     调试器要能编辑"平时看不到"的界面（公告弹窗、更新弹窗、各类 modal），
     所以这里显式列出，选中时由主窗口临时把它显示出来。

     另外还会**自动发现**：任何 .modal-backdrop / .page，
     所以以后新增界面不用改这张表也能被调试器看到。 */
  var SCREENS = [
    { id: 'page-login', name: '登录 / 注册页', sel: '#auth-page' },
    { id: 'page-home', name: '主页', sel: '#page-home' },
    { id: 'page-host', name: '创建房间', sel: '#page-host' },
    { id: 'page-rooms', name: '房间列表', sel: '#page-rooms' },
    { id: 'page-friends', name: '好友', sel: '#page-friends' },
    { id: 'page-chat', name: '聊天', sel: '#page-chat' },
    { id: 'page-user-settings', name: '个人设置', sel: '#page-user-settings' },
    { id: 'page-settings', name: '设置', sel: '#page-settings' },
    { id: 'app-sidebar', name: '侧边导航栏', sel: '#app-sidebar' },
    { id: 'titlebar', name: '顶部标题栏', sel: '.custom-titlebar, .titlebar' },

    { id: 'modal-announcement', name: '公告弹窗', sel: '#announcement-modal', modal: true },
    { id: 'modal-update', name: '更新弹窗', sel: '#update-modal', modal: true },
    { id: 'modal-confirm', name: '确认弹窗', sel: '#confirm-modal', modal: true },
    { id: 'modal-start-host', name: '开始主机弹窗', sel: '#start-host-modal', modal: true },
    { id: 'modal-quick-host', name: '快速开房弹窗', sel: '#quick-host-modal', modal: true },
    { id: 'modal-port', name: '端口设置弹窗', sel: '#port-modal', modal: true },
    { id: 'modal-join-room', name: '加入房间弹窗', sel: '#join-room-modal', modal: true },
    { id: 'modal-room-detail', name: '房间详情弹窗', sel: '#room-detail-modal', modal: true },
    { id: 'modal-log', name: '日志查看弹窗', sel: '#log-viewer-modal', modal: true },
    { id: 'modal-diag', name: '诊断弹窗', sel: '#diag-modal', modal: true }
  ];

  /* 自动发现页面上其它界面（新增的弹窗/页面不用改表也能调） */
  function discoverScreens(doc) {
    var found = SCREENS.slice();
    var seen = {};
    found.forEach(function (s) { seen[s.sel] = true; });

    function add(sel, name, modal) {
      if (!sel || seen[sel]) return;
      var el;
      try { el = doc.querySelector(sel); } catch (e) { return; }
      if (!el) return;
      seen[sel] = true;
      found.push({ id: 'auto-' + sel.replace(/[^a-z0-9]/gi, ''), name: name, sel: sel, modal: modal });
    }

    Array.prototype.forEach.call(doc.querySelectorAll('.modal-backdrop'), function (el, i) {
      if (!el.id) return;
      var title = el.querySelector('h3, .modal-title');
      add('#' + el.id, (title && title.textContent.trim()) || ('弹窗 ' + (i + 1)), true);
    });
    Array.prototype.forEach.call(doc.querySelectorAll('.page'), function (el) {
      if (!el.id) return;
      var h = el.querySelector('.page-title, h1');
      add('#' + el.id, (h && h.textContent.trim()) || el.id, false);
    });
    return found;
  }

  root.LT_SHARED = { MANAGED: MANAGED, GROUPS: GROUPS, SCREENS: SCREENS, discoverScreens: discoverScreens };
})(typeof window !== 'undefined' ? window : globalThis);
