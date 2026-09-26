/* ============================================================================
 * BLFP 布局调试器（开发用）—— 正式发布版会被 CI 删除
 * 见 .github/workflows/release.yml 的 "Strip dev-only files" 步骤
 *
 * 用法：
 *   Ctrl+Shift+D    打开 / 关闭面板
 *   「选择元素」     点页面上任意部件选中
 *   「拖动移动」     直接拖动部件改位置（也可 Alt+拖动，不用切模式）
 *   方向键          微调位置 1px（Shift = 10px）
 *   Esc             退出当前模式
 *   「导出」         生成 JSON + CSS，发给我即可改到源码里
 *
 * 能调的东西：
 *   位置 / 尺寸 / 间距 / 排版 / 外观 / 变换 / 显示 七组常用属性，
 *   外加一个自由 CSS 输入框 —— 任何 CSS 声明都能直接写，不受上面分组限制。
 *
 * 实现要点：
 *   位移用 CSS 的独立 translate 属性，缩放旋转用 transform，两者互不覆盖；
 *   所有由本工具写过的属性都记在 MANAGED 里，重置时逐个 removeProperty，
 *   不会残留、也不会误删页面原有的行内样式。
 * ========================================================================= */
(function () {
  'use strict';

  var KEY = 'blfp_layout_tuner';
  var overrides = {};        // selector -> { dx, dy, scale, rotate, styles:{} }
  var selected = null;
  var picking = false, dragMode = false;
  var open = false;
  var filter = '';

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

  /* 属性分组。virt=true 表示不是真的 CSS 属性，由工具合成 */
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

  /* ---------- 存取 ---------- */
  function load() {
    try { overrides = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
    catch (e) { overrides = {}; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(overrides)); } catch (e) {}
  }
  function getOv(sel, create) {
    if (!overrides[sel] && create) overrides[sel] = { dx: 0, dy: 0, scale: 1, rotate: 0, styles: {} };
    var ov = overrides[sel];
    if (ov) { if (!ov.styles) ov.styles = {}; if (ov.scale == null) ov.scale = 1; if (ov.rotate == null) ov.rotate = 0; }
    return ov;
  }
  function isDirty(ov) {
    if (!ov) return false;
    if (ov.dx || ov.dy || (ov.scale && ov.scale !== 1) || ov.rotate) return true;
    return Object.keys(ov.styles || {}).some(function (k) { return ov.styles[k]; });
  }

  /* ---------- 选择器 ---------- */
  function stepFor(node) {
    var s = node.tagName.toLowerCase();
    // 必须用 getAttribute('class')：SVG 元素的 .className 是 SVGAnimatedString 对象
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
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    var parts = [];
    var node = el;
    // 一直向上走到带 id 的祖先或 body 为止，不能按层数截断（截断后最左段会匹配到别的元素）
    while (node && node.nodeType === 1) {
      if (node.id) { parts.unshift('#' + node.id); break; }
      parts.unshift(stepFor(node));
      var parent = node.parentElement;
      if (!parent || parent === document.documentElement) break;
      node = parent;
    }
    return parts.join(' > ');
  }
  function elFor(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }

  /* ---------- 应用 ---------- */
  function applyTo(el, ov) {
    if (!el) return;
    for (var i = 0; i < MANAGED.length; i++) el.style.removeProperty(MANAGED[i]);
    if (!ov) return;
    var dx = ov.dx || 0, dy = ov.dy || 0;
    if (dx || dy) el.style.translate = dx + 'px ' + dy + 'px';
    var t = [];
    if (ov.scale && ov.scale !== 1) t.push('scale(' + ov.scale + ')');
    if (ov.rotate) t.push('rotate(' + ov.rotate + 'deg)');
    if (t.length) el.style.transform = t.join(' ');
    var s = ov.styles || {};
    Object.keys(s).forEach(function (k) {
      var v = s[k];
      if (v === '' || v == null) return;
      try { el.style.setProperty(k, String(v)); } catch (e) {}
    });
  }
  function applyAll() {
    Object.keys(overrides).forEach(function (sel) { applyTo(elFor(sel), overrides[sel]); });
  }
  function refreshSelected() {
    if (!selected) return;
    var sel = selectorFor(selected);
    var ov = getOv(sel, false);
    applyTo(selected, ov);
    if (!isDirty(ov)) delete overrides[sel];
    save(); syncInputs(); renderList();
  }

  /* ---------- 自由 CSS 文本 <-> 对象 ---------- */
  function serializeStyles(s) {
    return Object.keys(s || {}).filter(function (k) { return s[k]; })
      .map(function (k) { return k + ': ' + s[k] + ';'; }).join('\n');
  }
  function parseDecls(text) {
    var out = {};
    String(text || '').split(/[;\n]/).forEach(function (line) {
      var i = line.indexOf(':');
      if (i < 0) return;
      var k = line.slice(0, i).trim().toLowerCase();
      var v = line.slice(i + 1).trim();
      if (k && v) out[k] = v;
    });
    return out;
  }

  /* ---------- 面板 ---------- */
  var panel, selBox, listBox, outBox, cssBox, groupsBox, pickBtn, dragBtn;

  function build() {
    panel = document.createElement('div');
    panel.id = 'lt-panel';
    panel.innerHTML =
      '<header><b>布局调试器</b><button class="lt-mini lt-close">×</button></header>' +
      '<div class="lt-body">' +
        '<div class="lt-row2">' +
          '<button class="lt-pick">选择元素</button>' +
          '<button class="lt-drag">拖动移动</button>' +
          '<button class="lt-mini lt-reset-sel">重置此元素</button>' +
          '<button class="lt-mini lt-reset-all">全部重置</button>' +
        '</div>' +
        '<div id="lt-sel">(未选中：点「选择元素」后点页面上的部件)</div>' +
        '<div class="lt-row2"><input type="text" class="lt-filter" placeholder="筛选属性，如 圆角 / font / margin">' +
          '<button class="lt-mini lt-clear-filter">×</button></div>' +
        '<div id="lt-groups"></div>' +
        '<div class="lt-row3"><label>自由 CSS</label><span class="lt-hint2" style="color:#7d8299;font-size:11px">任意声明，每行一条</span></div>' +
        '<textarea id="lt-css" spellcheck="false" placeholder="color: #fff;&#10;text-shadow: 0 0 8px #3b6eff;&#10;backdrop-filter: blur(8px);"></textarea>' +
        '<div class="lt-row2"><button class="lt-export">导出</button><button class="lt-copy">复制结果</button></div>' +
        '<textarea id="lt-out" spellcheck="false" placeholder="点「导出」生成结果"></textarea>' +
        '<div id="lt-hint">Ctrl+Shift+D 开关 · Alt+拖动直接移动部件 · 方向键微调（Shift=10px）· Esc 退出模式</div>' +
        '<div id="lt-list"></div>' +
      '</div>';
    document.body.appendChild(panel);

    var hl = document.createElement('div'); hl.id = 'lt-hl'; document.body.appendChild(hl);
    var badge = document.createElement('div'); badge.id = 'lt-badge'; document.body.appendChild(badge);

    selBox = panel.querySelector('#lt-sel');
    listBox = panel.querySelector('#lt-list');
    outBox = panel.querySelector('#lt-out');
    cssBox = panel.querySelector('#lt-css');
    groupsBox = panel.querySelector('#lt-groups');
    pickBtn = panel.querySelector('.lt-pick');
    dragBtn = panel.querySelector('.lt-drag');

    panel.querySelector('.lt-close').onclick = function () { setOpen(false); };
    pickBtn.onclick = function () { setPicking(!picking); };
    dragBtn.onclick = function () { setDragMode(!dragMode); };
    panel.querySelector('.lt-reset-sel').onclick = function () {
      if (!selected) return;
      delete overrides[selectorFor(selected)];
      applyTo(selected, null); save(); syncInputs(); renderList();
    };
    panel.querySelector('.lt-reset-all').onclick = function () {
      Object.keys(overrides).forEach(function (sel) { applyTo(elFor(sel), null); });
      overrides = {}; save(); syncInputs(); renderList();
    };
    panel.querySelector('.lt-filter').oninput = function (e) { filter = e.target.value; renderGroups(); };
    panel.querySelector('.lt-clear-filter').onclick = function () {
      filter = ''; panel.querySelector('.lt-filter').value = ''; renderGroups();
    };
    panel.querySelector('.lt-export').onclick = function () { outBox.value = buildExport(); };
    panel.querySelector('.lt-copy').onclick = function () {
      outBox.value = outBox.value || buildExport();
      outBox.select();
      try { document.execCommand('copy'); } catch (e) {}
      if (navigator.clipboard) navigator.clipboard.writeText(outBox.value).catch(function () {});
    };
    cssBox.onchange = function () {
      if (!selected) return;
      var ov = getOv(selectorFor(selected), true);
      // 文本框内容与工具序列化的结果一致时直接跳过：
      // 否则一次无意义的 blur 就会把结构化控件刚设好的样式整片清掉。
      if (cssBox.value === serializeStyles(ov.styles)) return;
      ov.styles = parseDecls(cssBox.value);
      refreshSelected();
    };

    makeDraggable(panel, panel.querySelector('header'));
    renderGroups();
  }

  function renderGroups() {
    var ov = selected ? getOv(selectorFor(selected), false) : null;
    groupsBox.innerHTML = '';
    GROUPS.forEach(function (g) {
      var items = g.props.filter(function (p) {
        if (!filter) return true;
        var f = filter.toLowerCase();
        return p.label.toLowerCase().indexOf(f) >= 0 || p.k.indexOf(f) >= 0;
      });
      if (!items.length) return;
      var dirty = items.some(function (p) { return hasVal(ov, p); });
      var det = document.createElement('details');
      det.className = 'lt-group' + (dirty ? ' lt-dirty' : '');
      det.open = !!filter || dirty || g.name === '位置';
      var sum = document.createElement('summary');
      sum.textContent = g.name + (dirty ? ' ●' : '');
      det.appendChild(sum);
      var rows = document.createElement('div');
      rows.className = 'lt-rows';
      items.forEach(function (p) { rows.appendChild(makeRow(p)); });
      det.appendChild(rows);
      groupsBox.appendChild(det);
    });
  }

  function rawVal(ov, p) {
    if (!ov) return '';
    if (p.virt) return ov[p.k];
    return (ov.styles || {})[p.k] || '';
  }
  function hasVal(ov, p) {
    var v = rawVal(ov, p);
    if (p.virt) return v != null && v !== p.def;
    return !!v;
  }
  function setVal(p, value) {
    if (!selected) return;
    var ov = getOv(selectorFor(selected), true);
    if (p.virt) {
      ov[p.k] = (value === '' || value == null) ? p.def : value;
    } else {
      if (value === '' || value == null) delete ov.styles[p.k];
      else ov.styles[p.k] = value;
    }
    refreshSelected();
  }

  function makeRow(p) {
    var ov = selected ? getOv(selectorFor(selected), false) : null;
    var row = document.createElement('div');
    row.className = 'lt-row3';
    var lab = document.createElement('label');
    lab.textContent = p.label;
    lab.title = p.virt ? p.label : p.k;
    row.appendChild(lab);
    var ctl = document.createElement('div');
    ctl.className = 'lt-ctl';

    if (p.type === 'range') {
      var v = rawVal(ov, p);
      var cur = (v === '' || v == null) ? p.def : parseFloat(v);
      if (isNaN(cur)) cur = p.def;
      var rng = document.createElement('input');
      rng.type = 'range'; rng.min = p.min; rng.max = p.max; rng.step = p.step; rng.value = cur;
      var num = document.createElement('input');
      num.type = 'number'; num.step = p.step; num.value = cur;
      rng.oninput = function () { num.value = rng.value; setVal(p, rng.value + (p.unit === 'px' ? 'px' : '')); };
      num.onchange = function () { rng.value = num.value; setVal(p, num.value + (p.unit === 'px' ? 'px' : '')); };
      ctl.appendChild(rng); ctl.appendChild(num);
      if (p.unit) { var u = document.createElement('span'); u.textContent = p.unit; u.style.color = '#7d8299'; ctl.appendChild(u); }
    } else if (p.type === 'select') {
      var sel = document.createElement('select');
      p.opts.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o; op.textContent = o === '' ? '(默认)' : o;
        sel.appendChild(op);
      });
      var cv = rawVal(ov, p);
      sel.value = (cv === '' || cv == null) ? '' : String(cv);
      if (sel.selectedIndex < 0) sel.value = '';
      sel.onchange = function () { setVal(p, sel.value); };
      ctl.appendChild(sel);
    } else if (p.type === 'color') {
      var cvv = rawVal(ov, p);
      var hex = toHex(cvv);
      var col = document.createElement('input');
      col.type = 'color'; col.value = hex || '#3b6eff';
      var txt = document.createElement('input');
      txt.type = 'text'; txt.value = cvv || ''; txt.placeholder = '留空 = 默认';
      col.oninput = function () { txt.value = col.value; setVal(p, col.value); };
      txt.onchange = function () { setVal(p, txt.value); col.value = toHex(txt.value) || col.value; };
      ctl.appendChild(col); ctl.appendChild(txt);
    } else {
      var tv = rawVal(ov, p);
      var ti = document.createElement('input');
      ti.type = 'text'; ti.value = (tv === '' || tv == null) ? '' : String(tv);
      ti.placeholder = p.ph || '留空 = 默认';
      ti.onchange = function () { setVal(p, ti.value); };
      ctl.appendChild(ti);
    }

    var clr = document.createElement('button');
    clr.className = 'lt-mini'; clr.textContent = '×'; clr.title = '清除这一项';
    clr.onclick = function () { setVal(p, p.virt ? p.def : ''); };
    ctl.appendChild(clr);

    row.appendChild(ctl);
    return row;
  }

  function toHex(v) {
    if (!v) return '';
    var s = String(v).trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s;
    if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    var m = s.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      var p = m[1].split(',').map(function (x) { return parseFloat(x); });
      if (p.length >= 3 && p.slice(0, 3).every(function (x) { return x >= 0 && x <= 255; })) {
        return '#' + p.slice(0, 3).map(function (x) {
          var h = Math.round(x).toString(16); return h.length < 2 ? '0' + h : h;
        }).join('');
      }
    }
    return '';
  }

  function setOpen(on) { open = on; panel.classList.toggle('lt-open', on); if (!on) { setPicking(false); setDragMode(false); } }
  function setPicking(on) {
    picking = on;
    if (on) dragMode = false;
    document.body.classList.toggle('lt-picking', picking);
    document.body.classList.toggle('lt-dragging', dragMode);
    pickBtn.classList.toggle('lt-on', picking);
    dragBtn.classList.toggle('lt-on', dragMode);
    if (!picking) hideHl();
  }
  function setDragMode(on) {
    dragMode = on;
    if (on) picking = false;
    document.body.classList.toggle('lt-dragging', dragMode);
    document.body.classList.toggle('lt-picking', picking);
    dragBtn.classList.toggle('lt-on', dragMode);
    pickBtn.classList.toggle('lt-on', picking);
    if (!dragMode) hideHl();
  }
  function hideHl() {
    var hl = document.getElementById('lt-hl'), bd = document.getElementById('lt-badge');
    if (hl) hl.style.display = 'none';
    if (bd) bd.style.display = 'none';
  }

  function select(el) {
    selected = el;
    selBox.textContent = selectorFor(el) || '(未选中)';
    renderGroups(); syncInputs(); renderList();
  }

  function syncInputs() {
    var ov = selected ? getOv(selectorFor(selected), false) : null;
    cssBox.value = ov ? serializeStyles(ov.styles) : '';
    renderGroups();
  }

  function renderList() {
    var keys = Object.keys(overrides).filter(function (k) { return isDirty(overrides[k]); });
    listBox.innerHTML = '';
    if (!keys.length) return;
    var head = document.createElement('div');
    head.id = 'lt-hint';
    head.textContent = '已调整 ' + keys.length + ' 个部件：';
    listBox.appendChild(head);
    keys.forEach(function (sel) {
      var ov = overrides[sel];
      var n = Object.keys(ov.styles || {}).filter(function (k) { return ov.styles[k]; }).length;
      var bits = [];
      if (ov.dx || ov.dy) bits.push('位移 ' + (ov.dx || 0) + ',' + (ov.dy || 0));
      if (ov.scale && ov.scale !== 1) bits.push('缩放 ' + ov.scale);
      if (ov.rotate) bits.push('旋转 ' + ov.rotate + '°');
      if (n) bits.push(n + ' 项样式');
      var row = document.createElement('div');
      row.className = 'lt-item';
      var span = document.createElement('span');
      span.textContent = sel;
      span.title = sel + '  →  ' + bits.join(' · ');
      var b1 = document.createElement('button');
      b1.className = 'lt-mini'; b1.textContent = '定位';
      b1.onclick = function () { var el = elFor(sel); if (el) { select(el); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } };
      var b2 = document.createElement('button');
      b2.className = 'lt-mini'; b2.textContent = '×';
      b2.onclick = function () { applyTo(elFor(sel), null); delete overrides[sel]; save(); renderList(); };
      row.appendChild(span); row.appendChild(b1); row.appendChild(b2);
      listBox.appendChild(row);
    });
  }

  /* ---------- 导出 ---------- */
  function buildExport() {
    var items = Object.keys(overrides).filter(function (k) { return isDirty(overrides[k]); }).map(function (sel) {
      var ov = overrides[sel];
      var css = {};
      if (ov.dx || ov.dy) css['translate'] = (ov.dx || 0) + 'px ' + (ov.dy || 0) + 'px';
      var t = [];
      if (ov.scale && ov.scale !== 1) t.push('scale(' + ov.scale + ')');
      if (ov.rotate) t.push('rotate(' + ov.rotate + 'deg)');
      if (t.length) css['transform'] = t.join(' ');
      Object.keys(ov.styles || {}).forEach(function (k) { if (ov.styles[k]) css[k] = ov.styles[k]; });
      return { selector: sel, css: css };
    });
    var cssText = items.map(function (it) {
      var body = Object.keys(it.css).map(function (k) { return '  ' + k + ': ' + it.css[k] + ';'; }).join('\n');
      return it.selector + ' {\n' + body + '\n}';
    }).join('\n\n');
    var payload = {
      tool: 'BLFP 布局调试器',
      exportedAt: new Date().toISOString(),
      viewport: window.innerWidth + 'x' + window.innerHeight,
      count: items.length,
      items: items
    };
    return '=== BLFP 布局调试器导出 ===\n' +
      '窗口: ' + payload.viewport + '   共 ' + items.length + ' 个部件\n\n' +
      '--- JSON ---\n' + JSON.stringify(payload, null, 2) + '\n\n' +
      '--- CSS ---\n' + (cssText || '(无)');
  }

  /* ---------- 拖拽面板 ---------- */
  function makeDraggable(box, handle) {
    var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      var r = box.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      box.style.left = (ox + e.clientX - sx) + 'px';
      box.style.top = (oy + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  }

  /* ---------- 事件 ---------- */
  function bind() {
    document.addEventListener('mousemove', function (e) {
      if (!picking) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      var hl = document.getElementById('lt-hl'), bd = document.getElementById('lt-badge');
      if (!el || (el.closest && el.closest('#lt-panel'))) { hl.style.display = 'none'; bd.style.display = 'none'; return; }
      var r = el.getBoundingClientRect();
      hl.style.display = 'block';
      hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px';
      hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
      bd.style.display = 'block';
      bd.style.left = r.left + 'px';
      bd.style.top = Math.max(0, r.top - 20) + 'px';
      bd.textContent = selectorFor(el);
    }, true);

    document.addEventListener('click', function (e) {
      if (!picking) return;
      if (e.target.closest && e.target.closest('#lt-panel')) return;
      e.preventDefault(); e.stopPropagation();
      select(e.target);
      setPicking(false);
    }, true);

    /* Alt+拖动 或 拖动模式：直接拖着部件改位移 */
    var dragging = null, dsx = 0, dsy = 0, dbase = { dx: 0, dy: 0 };
    document.addEventListener('mousedown', function (e) {
      if (!(dragMode || e.altKey) || e.button !== 0) return;
      if (e.target.closest && e.target.closest('#lt-panel')) return;
      e.preventDefault(); e.stopPropagation();
      var el = e.target;
      select(el);
      var ov = getOv(selectorFor(el), true);
      dragging = el; dsx = e.clientX; dsy = e.clientY;
      dbase = { dx: ov.dx || 0, dy: ov.dy || 0 };
      document.body.classList.add('lt-dragging');
    }, true);
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      e.preventDefault();
      var ov = getOv(selectorFor(dragging), true);
      ov.dx = Math.round(dbase.dx + e.clientX - dsx);
      ov.dy = Math.round(dbase.dy + e.clientY - dsy);
      applyTo(dragging, ov);
      syncInputs(); renderList();
    }, true);
    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = null; save(); syncInputs(); renderList();
      if (!dragMode) document.body.classList.remove('lt-dragging');
    }, true);

    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) { e.preventDefault(); setOpen(!open); return; }
      if (e.key === 'Escape') { if (picking) setPicking(false); if (dragMode) setDragMode(false); return; }
      if (!open || !selected) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      var s = e.shiftKey ? 10 : 1;
      var ov = getOv(selectorFor(selected), true);
      var hit = true;
      if (e.key === 'ArrowUp') ov.dy = (ov.dy || 0) - s;
      else if (e.key === 'ArrowDown') ov.dy = (ov.dy || 0) + s;
      else if (e.key === 'ArrowLeft') ov.dx = (ov.dx || 0) - s;
      else if (e.key === 'ArrowRight') ov.dx = (ov.dx || 0) + s;
      else hit = false;
      if (hit) { e.preventDefault(); applyTo(selected, ov); save(); syncInputs(); renderList(); }
    }, true);
  }

  function init() {
    load(); build(); bind(); applyAll(); renderList();
    try { console.log('[布局调试器] 已加载，按 Ctrl+Shift+D 打开'); } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
