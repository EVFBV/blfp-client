/* ============================================================================
 * BLFP 布局调试器（开发用）—— 正式发布版会被 CI 删除
 * 见 .github/workflows/release.yml 的 "Strip dev-only files" 步骤
 *
 * 用法：
 *   Ctrl+Shift+D      打开 / 关闭面板
 *   「选择元素」      进入拾取模式，点页面上任意部件即可选中
 *   方向键            微调选中部件（1px；按住 Shift 为 10px）
 *   Esc               退出拾取模式
 *   「导出」          生成 JSON + CSS，把内容发给我即可改到源码里
 *
 * 实现要点：位移用 CSS 的独立 translate 属性，而不是 transform。
 * transform 会和元素自身的动画/居中 transform 打架，translate 是独立合成的。
 * ========================================================================= */
(function () {
  'use strict';

  var KEY = 'blfp_layout_tuner';
  var offsets = {};          // { selector: { dx, dy } }
  var selected = null;       // 当前选中的 DOM 元素
  var picking = false;
  var open = false;
  var panel = null, selBox = null, listBox = null, outBox = null;
  var hl = null, badge = null, pickBtn = null;

  /* ---------- 存取 ---------- */
  function load() {
    try { offsets = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
    catch (e) { offsets = {}; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(offsets)); } catch (e) {}
  }

  /* ---------- 选择器 ---------- */
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    var parts = [];
    var node = el;
    // 一直向上走到带 id 的祖先，或走到 body 为止。
    // 不能按固定层数截断：截断后最左边那段等于「文档里任意一个同类元素」，
    // 会解析到别的元素上去（实测 371 个元素里有 4 个因此对不上）。
    while (node && node.nodeType === 1) {
      if (node.id) { parts.unshift('#' + node.id); break; }
      parts.unshift(stepFor(node));
      var parent = node.parentElement;
      if (!parent || parent === document.documentElement) break;
      node = parent;
    }
    return parts.join(' > ');
  }
  function stepFor(node) {
    var s = node.tagName.toLowerCase();
    // 必须用 getAttribute('class')：SVG 元素的 .className 是 SVGAnimatedString 对象，
    // String() 出来是 "[object SVGAnimatedString]"，会生成 querySelector 解析不了的选择器。
    var cls = String(node.getAttribute('class') || '').trim().split(/\s+/).filter(function (c) {
      return c && c.indexOf('lt-') !== 0;
    }).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    var parent = node.parentElement;
    if (parent) {
      var same = [];
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
      }
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    }
    return s;
  }
  function elFor(sel) {
    try { return document.querySelector(sel); } catch (e) { return null; }
  }

  /* ---------- 应用位移 ---------- */
  function applyOne(sel, off) {
    var el = elFor(sel);
    if (!el) return;
    if (!off || (!off.dx && !off.dy)) el.style.removeProperty('translate');
    else el.style.translate = off.dx + 'px ' + off.dy + 'px';
  }
  function applyAll() {
    Object.keys(offsets).forEach(function (sel) { applyOne(sel, offsets[sel]); });
  }

  /* ---------- 面板 ---------- */
  function build() {
    panel = document.createElement('div');
    panel.id = 'lt-panel';
    panel.innerHTML =
      '<header><b>布局调试器</b><button class="lt-close">×</button></header>' +
      '<div class="lt-body">' +
        '<div class="lt-row2">' +
          '<button class="lt-pick">选择元素</button>' +
          '<button class="lt-reset-sel">重置此元素</button>' +
          '<button class="lt-reset-all">全部重置</button>' +
        '</div>' +
        '<div id="lt-sel">(未选中)</div>' +
        '<div class="lt-row2">' +
          'X <input type="number" class="lt-dx" step="1" value="0">' +
          'Y <input type="number" class="lt-dy" step="1" value="0">' +
          '<button class="lt-zero">归零</button>' +
        '</div>' +
        '<div id="lt-hint">Ctrl+Shift+D 开关面板 · 点「选择元素」后点页面部件 · 方向键微调（Shift=10px）</div>' +
        '<div class="lt-row2"><button class="lt-export">导出</button><button class="lt-copy">复制结果</button></div>' +
        '<textarea id="lt-out" spellcheck="false" placeholder="点「导出」生成结果"></textarea>' +
        '<div id="lt-list"></div>' +
      '</div>';
    document.body.appendChild(panel);

    hl = document.createElement('div'); hl.id = 'lt-hl'; document.body.appendChild(hl);
    badge = document.createElement('div'); badge.id = 'lt-badge'; document.body.appendChild(badge);

    selBox = panel.querySelector('#lt-sel');
    listBox = panel.querySelector('#lt-list');
    outBox = panel.querySelector('#lt-out');
    pickBtn = panel.querySelector('.lt-pick');
    pickBtn.classList.add('lt-off');

    panel.querySelector('.lt-close').onclick = function () { setOpen(false); };
    pickBtn.onclick = function () { setPicking(!picking); };
    panel.querySelector('.lt-reset-sel').onclick = function () {
      if (!selected) return;
      delete offsets[selectorFor(selected)];
      applyOne(selectorFor(selected), null); save(); syncInputs(); renderList();
    };
    panel.querySelector('.lt-reset-all').onclick = function () {
      Object.keys(offsets).forEach(function (sel) { applyOne(sel, null); });
      offsets = {}; save(); syncInputs(); renderList();
    };
    panel.querySelector('.lt-zero').onclick = function () { nudge(0, 0, true); };
    panel.querySelector('.lt-export').onclick = function () { outBox.value = buildExport(); };
    panel.querySelector('.lt-copy').onclick = function () {
      outBox.value = outBox.value || buildExport();
      outBox.select();
      try { document.execCommand('copy'); } catch (e) {}
      if (navigator.clipboard) navigator.clipboard.writeText(outBox.value).catch(function () {});
    };
    var dxEl = panel.querySelector('.lt-dx');
    var dyEl = panel.querySelector('.lt-dy');
    dxEl.onchange = function () { setOffset(parseFloat(dxEl.value) || 0, null); };
    dyEl.onchange = function () { setOffset(null, parseFloat(dyEl.value) || 0); };

    makeDraggable(panel, panel.querySelector('header'));
  }

  function setOpen(on) {
    open = on;
    panel.classList.toggle('lt-open', on);
    if (!on) setPicking(false);
  }

  function setPicking(on) {
    picking = on;
    document.body.classList.toggle('lt-picking', on);
    pickBtn.classList.toggle('lt-on', on);
    if (!on) { hl.style.display = 'none'; badge.style.display = 'none'; }
  }

  function select(el) {
    selected = el;
    selBox.textContent = selectorFor(el) || '(未选中)';
    syncInputs();
    renderList();
  }

  function syncInputs() {
    var off = selected ? (offsets[selectorFor(selected)] || { dx: 0, dy: 0 }) : { dx: 0, dy: 0 };
    panel.querySelector('.lt-dx').value = off.dx || 0;
    panel.querySelector('.lt-dy').value = off.dy || 0;
  }

  function setOffset(dx, dy) {
    if (!selected) return;
    var sel = selectorFor(selected);
    var off = offsets[sel] || { dx: 0, dy: 0 };
    if (dx !== null) off.dx = dx;
    if (dy !== null) off.dy = dy;
    offsets[sel] = off;
    applyOne(sel, off); save(); syncInputs(); renderList();
  }

  function nudge(dx, dy, zero) {
    if (!selected) return;
    var sel = selectorFor(selected);
    var off = zero ? { dx: 0, dy: 0 } : (offsets[sel] || { dx: 0, dy: 0 });
    if (!zero) {
      off.dx = Math.round(((off.dx || 0) + dx) * 100) / 100;
      off.dy = Math.round(((off.dy || 0) + dy) * 100) / 100;
    }
    offsets[sel] = off;
    applyOne(sel, off); save(); syncInputs(); renderList();
  }

  function renderList() {
    var keys = Object.keys(offsets).filter(function (k) {
      return offsets[k] && (offsets[k].dx || offsets[k].dy);
    });
    if (!keys.length) { listBox.innerHTML = ''; return; }
    listBox.innerHTML = '';
    keys.forEach(function (sel) {
      var row = document.createElement('div');
      row.className = 'lt-item';
      var span = document.createElement('span');
      span.textContent = sel + '  (' + (offsets[sel].dx || 0) + ', ' + (offsets[sel].dy || 0) + ')';
      span.title = sel;
      var btn = document.createElement('button');
      btn.textContent = '×';
      btn.onclick = function () { delete offsets[sel]; applyOne(sel, null); save(); renderList(); };
      row.appendChild(span); row.appendChild(btn);
      listBox.appendChild(row);
    });
  }

  /* ---------- 导出 ---------- */
  function buildExport() {
    var items = Object.keys(offsets).map(function (sel) {
      return { selector: sel, dx: offsets[sel].dx || 0, dy: offsets[sel].dy || 0 };
    }).filter(function (it) { return it.dx || it.dy; });
    var css = items.map(function (it) {
      return it.selector + ' { translate: ' + it.dx + 'px ' + it.dy + 'px; }';
    }).join('\n');
    var payload = {
      tool: 'BLFP 布局调试器',
      exportedAt: new Date().toISOString(),
      viewport: window.innerWidth + 'x' + window.innerHeight,
      count: items.length,
      items: items
    };
    return '=== BLFP 布局调试器导出 ===\n' +
      '窗口: ' + payload.viewport + '   共 ' + items.length + ' 处调整\n\n' +
      '--- JSON ---\n' + JSON.stringify(payload, null, 2) + '\n\n' +
      '--- CSS ---\n' + (css || '(无)');
  }

  /* ---------- 拖拽面板 ---------- */
  function makeDraggable(box, handle) {
    var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      var r = box.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      box.style.left = (ox + e.clientX - sx) + 'px';
      box.style.top = (oy + e.clientY - sy) + 'px';
      box.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  }

  /* ---------- 事件 ---------- */
  function bind() {
    document.addEventListener('mousemove', function (e) {
      if (!picking) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || (el.closest && el.closest('#lt-panel'))) {
        hl.style.display = 'none'; badge.style.display = 'none'; return;
      }
      var r = el.getBoundingClientRect();
      hl.style.display = 'block';
      hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px';
      hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
      badge.style.display = 'block';
      badge.style.left = r.left + 'px';
      badge.style.top = Math.max(0, r.top - 20) + 'px';
      badge.textContent = selectorFor(el);
    }, true);

    document.addEventListener('click', function (e) {
      if (!picking) return;
      if (e.target.closest && e.target.closest('#lt-panel')) return;
      e.preventDefault(); e.stopPropagation();
      select(e.target);
      setPicking(false);
    }, true);

    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault(); setOpen(!open); return;
      }
      if (e.key === 'Escape' && picking) { setPicking(false); return; }
      if (!open || !selected) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      var s = e.shiftKey ? 10 : 1;
      var handled = true;
      if (e.key === 'ArrowUp') nudge(0, -s);
      else if (e.key === 'ArrowDown') nudge(0, s);
      else if (e.key === 'ArrowLeft') nudge(-s, 0);
      else if (e.key === 'ArrowRight') nudge(s, 0);
      else handled = false;
      if (handled) e.preventDefault();
    }, true);
  }

  function init() {
    load();
    build();
    bind();
    applyAll();
    renderList();
    try { console.log('[布局调试器] 已加载，按 Ctrl+Shift+D 打开面板'); } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
