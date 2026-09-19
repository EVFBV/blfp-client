/* ============================================================
 * LG Components — liunian.js.org 液态玻璃开关 & 滑块 1:1 移植
 * Switch: 轨道 160x67 / 拇指 146x92 / lip 边缘 / 弹簧物理
 * Slider: 轨道 330x60 / 拇指 90x60 / convex_squircle 边缘
 * 拇指滤镜: feImage(像素精确) + feDisplacementMap + 镜面高光
 * ============================================================ */
(function () {
  'use strict';

  var uid = 0;
  var filterRegistry = {};   /* id -> maxAbs */

  /* ---------- 边缘高度函数（bezelType） ---------- */
  var BEZEL_FNS = {
    lip: function (t) { return Math.pow(1 - Math.pow(1 - t, 4), 1 / 4); },
    convex_squircle: function (t) { return Math.sqrt(1 - Math.pow(1 - t, 2)); }
  };

  /* ---------- 弹簧引擎（framer-motion 等效） ---------- */
  function spring(initial, stiffness, damping, onUpdate) {
    var cur = initial, vel = 0, target = initial, raf = null, last = 0;
    function step(t) {
      var dt = Math.min((t - last) / 1000, 0.064); last = t;
      var a = -stiffness * (cur - target) - damping * vel;
      vel += a * dt; cur += vel * dt;
      if (Math.abs(cur - target) < 0.0005 && Math.abs(vel) < 0.0005) {
        cur = target; onUpdate(cur); raf = null; return;
      }
      onUpdate(cur); raf = requestAnimationFrame(step);
    }
    return {
      set: function (v) {
        target = v;
        if (raf === null) { last = performance.now(); raf = requestAnimationFrame(step); }
      },
      jump: function (v) {
        if (raf !== null) cancelAnimationFrame(raf);
        raf = null; cur = target = v; onUpdate(v);
      },
      get: function () { return cur; }
    };
  }

  /* ---------- gu: 边缘折射剖面（斯涅尔定律） ---------- */
  function bezelProfile(thickness, bezelWidth, fn, ri) {
    var inv = 1 / ri, N = 128, out = [];
    function refract(a, l) {
      var u = l, c = 1 - inv * inv * (1 - u * u);
      if (c < 0) return null;
      var h = Math.sqrt(c);
      return [-(inv * u + h) * a, inv - (inv * u + h) * l];
    }
    for (var i = 0; i < N; i++) {
      var u = i / N;
      var c0 = fn(u);
      var h2 = u < 1 ? 1e-4 : -1e-4;
      var d = (fn(u + h2) - c0) / h2;
      var m = Math.sqrt(d * d + 1);
      var y = [-d / m, -1 / m];
      var v = refract(y[0], y[1]);
      if (v) { var x = c0 * bezelWidth + thickness; out.push(v[0] * (x / v[1])); }
      else out.push(0);
    }
    return out;
  }

  /* ---------- yu: 折射位移图 ---------- */
  function displacementMap(w, h, radius, bezelWidth, maxAbs, profile) {
    var img = new ImageData(w, h);
    var data = img.data;
    var m = radius, y = bezelWidth;
    var v = m * m, g = (m + 1) * (m + 1), x = (m - y) * (m - y);
    var T = w - m * 2, A = h - m * 2;
    for (var M = 0; M < h; M++) {
      for (var C = 0; C < w; C++) {
        var O = (M * w + C) * 4;
        data[O] = 128; data[O + 1] = 128; data[O + 2] = 0; data[O + 3] = 255;
        var q0 = C < m, qt = C >= w - m, et = M < m, gt = M >= h - m;
        var yt = q0 ? C - m : qt ? C - m - T : 0;
        var R = et ? M - m : gt ? M - m - A : 0;
        var B = yt * yt + R * R;
        if (B <= g && B >= x && B > 0.0001) {
          var fal = B < v ? 1 : 1 - (Math.sqrt(B) - Math.sqrt(v)) / (Math.sqrt(g) - Math.sqrt(v));
          var Z = Math.sqrt(B);
          var de = m - Z;
          var Rr = yt / Z, Er = R / Z;
          var Lr = (de / y * profile.length) | 0;
          var Rn = profile[Lr] !== undefined ? profile[Lr] : 0;
          var Fr = -Rr * Rn / maxAbs, kr = -Er * Rn / maxAbs;
          data[O] = 128 + Fr * 127 * fal;
          data[O + 1] = 128 + kr * 127 * fal;
        }
      }
    }
    return img;
  }

  /* ---------- xu: 镜面高光图（60° 方向光） ---------- */
  function specularMap(w, h, radius, depth) {
    var img = new ImageData(w, h);
    var data = img.data;
    var c = radius, hh = depth;
    var f = [Math.cos(Math.PI / 3), Math.sin(Math.PI / 3)];
    var m = c * c, y = (c + 1) * (c + 1), v = (c - hh) * (c - hh);
    var g = w - c * 2, x = h - c * 2;
    for (var p = 0; p < h; p++) {
      for (var P = 0; P < w; P++) {
        var T = (p * w + P) * 4;
        var A = P < c, V = P >= w - c, b = p < c, M = p >= h - c;
        var C = A ? P - c : V ? P - c - g : 0;
        var O = b ? p - c : M ? p - c - x : 0;
        var q = C * C + O * O;
        if (q <= y && q >= v && q > 0.0001) {
          var et = Math.sqrt(q);
          var gt = c - et;
          var yt = q < m ? 1 : 1 - (et - Math.sqrt(m)) / (Math.sqrt(y) - Math.sqrt(m));
          var R = C / et, B = -O / et;
          var dol = Math.abs(R * f[0] + B * f[1]) * Math.sqrt(Math.max(0, 1 - (1 - gt) * (1 - gt)));
          var Z = 255 * dol;
          var de = Z * dol * yt;
          data[T] = Z; data[T + 1] = Z; data[T + 2] = Z; data[T + 3] = de;
        }
      }
    }
    return img;
  }

  function toURL(img) {
    var cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    cv.getContext('2d').putImageData(img, 0, 0);
    return cv.toDataURL();
  }

  /* ---------- 构建拇指滤镜（像素精确 feImage，同模板） ---------- */
  function ensureFilter(id, o) {
    var old = document.getElementById(id);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var fn = BEZEL_FNS[o.bezelType] || BEZEL_FNS.lip;
    var profile = bezelProfile(o.glassThickness, o.bezelWidth, fn, o.refractiveIndex);
    var maxAbs = 0;
    for (var i = 0; i < profile.length; i++) maxAbs = Math.max(maxAbs, Math.abs(profile[i]));
    if (!maxAbs) maxAbs = 1;
    filterRegistry[id] = maxAbs;
    var dispURL = toURL(displacementMap(o.w, o.h, o.radius, o.bezelWidth, maxAbs, profile));
    var specURL = toURL(specularMap(o.w, o.h, o.radius, Math.min(50, Math.round(o.radius * 0.8))));
    var scale = maxAbs * (o.scaleRatio || 0.4);
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('id', id);
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.display = 'none';
    svg.innerHTML = '<defs><filter id="' + id + '" color-interpolation-filters="sRGB">' +
      '<feGaussianBlur in="SourceGraphic" stdDeviation="' + o.blur + '" result="blurred"/>' +
      '<feImage href="' + dispURL + '" x="0" y="0" width="' + o.w + '" height="' + o.h + '" result="disp_map"/>' +
      '<feDisplacementMap in="blurred" in2="disp_map" scale="' + scale + '" xChannelSelector="R" yChannelSelector="G" result="displaced"/>' +
      '<feColorMatrix in="displaced" type="saturate" values="' + o.specularSaturation + '" result="dsat"/>' +
      '<feImage href="' + specURL + '" x="0" y="0" width="' + o.w + '" height="' + o.h + '" result="specular"/>' +
      '<feComposite in="dsat" in2="specular" operator="in" result="spec_sat"/>' +
      '<feComponentTransfer in="specular" result="spec_faded"><feFuncA type="linear" slope="' + o.specularOpacity + '"/></feComponentTransfer>' +
      '<feBlend in="spec_sat" in2="displaced" mode="normal" result="with_sat"/>' +
      '<feBlend in="spec_faded" in2="with_sat" mode="normal"/>' +
      '</filter></defs>';
    document.body.appendChild(svg);
    return maxAbs;
  }

  function setFilterRatio(id, ratio) {
    var maxAbs = filterRegistry[id];
    if (!maxAbs) return;
    var el = document.getElementById(id);
    if (!el) return;
    var dm = el.querySelector('feDisplacementMap');
    if (dm) dm.setAttribute('scale', String(maxAbs * ratio));
  }

  function perfOff() {
    return document.body.classList.contains('perf-off') || document.body.classList.contains('perf-low');
  }

  /* ==================== 开关（Switch 1:1） ==================== */
  function createLGSwitch(host, opts) {
    opts = opts || {};
    var k = opts.scale || 0.55;                 /* 尺寸缩放，1=模板原尺寸 */
    var W = 160 * k, H = 67 * k;                /* 轨道 */
    var tw = 146 * k, th = 92 * k, tr = 46 * k; /* 拇指 */
    var bezel = Math.max(3, Math.round(19 * k));
    var thick = Math.max(6, Math.round(47 * k));
    var F = 0.65, R2 = 0.9;                    /* 拇指缩放范围 */
    var v = (93 - 54 * F) * k;                 /* 行程 */
    var checked = !!opts.checked;
    var onChange = opts.onChange || function () {};
    var pressed = false;

    var filterId = 'lg-sw-' + (++uid);
    var useFilter = false;
    if (!perfOff() && typeof ImageData === 'function') {
      try {
        ensureFilter(filterId, {
          w: Math.round(tw), h: Math.round(th), radius: Math.round(tr),
          bezelWidth: bezel, glassThickness: thick, refractiveIndex: 1.5,
          bezelType: 'lip', blur: 0.2, specularOpacity: 0.5, specularSaturation: 6,
          scaleRatio: 0.4 + 0.5 * (checked ? 1 : 0)
        });
        useFilter = true;
      } catch (e) { useFilter = false; }
    }

    var root = document.createElement('div');
    root.className = 'lg-switch';
    root.style.cssText = 'position:relative;width:' + W + 'px;height:' + H + 'px;border-radius:' + (H / 2) + 'px;cursor:pointer;flex-shrink:0;overflow:visible;';

    var thumb = document.createElement('div');
    var left0 = (-25.55 + (67 - 92 * F) / 2) * k;
    thumb.style.cssText = 'position:absolute;width:' + tw + 'px;height:' + th + 'px;border-radius:' + tr + 'px;' +
      'top:' + (H / 2) + 'px;left:' + left0 + 'px;transform-origin:center;z-index:2;will-change:transform,background-color;';
    if (useFilter) {
      thumb.style.backdropFilter = 'url(#' + filterId + ')';
      thumb.style.webkitBackdropFilter = 'url(#' + filterId + ')';
    } else {
      thumb.style.backdropFilter = 'blur(' + (2 * k) + 'px) saturate(1.6)';
    }
    root.appendChild(thumb);

    /* 状态弹簧 */
    var xS = spring(checked ? v : 0, 1000, 80, render);
    var sS = spring(checked ? R2 : F, 2000, 80, render);
    var aS = spring(checked ? 0.1 : 1, 2000, 80, render);
    var cS = spring(checked ? 1 : 0, 1000, 80, render);

    function trackColor(e) {
      var r = Math.round(148 + (59 - 148) * e);
      var g = Math.round(148 + (191 - 148) * e);
      var b = Math.round(159 + (78 - 159) * e);
      var a = 0.4667 + (0.9333 - 0.4667) * e;
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(3) + ')';
    }

    function render() {
      thumb.style.transform = 'translate(' + xS.get() + 'px, -50%) scale(' + sS.get() + ')';
      thumb.style.backgroundColor = 'rgba(255, 255, 255, ' + aS.get().toFixed(3) + ')';
      thumb.style.boxShadow = '0 ' + (4 * k) + 'px ' + (22 * k) + 'px rgba(0,0,0,0.1)' +
        (pressed ? ', inset ' + (2 * k) + 'px ' + (7 * k) + 'px ' + (24 * k) + 'px rgba(0,0,0,0.09), inset -' + (2 * k) + 'px -' + (7 * k) + 'px ' + (24 * k) + 'px rgba(255,255,255,0.09)' : '');
      root.style.backgroundColor = trackColor(cS.get());
    }
    render();

    function setChecked(val, silent) {
      checked = val;
      xS.set(checked ? v : 0);
      sS.set(checked ? R2 : F);
      aS.set(checked ? 0.1 : 1);
      cS.set(checked ? 1 : 0);
      if (useFilter) setFilterRatio(filterId, 0.4 + 0.5 * (checked ? 1 : 0));
      if (!silent) onChange(checked);
    }

    /* 拖拽 + 点击 */
    var dragX0 = 0, moved = false, dragging = false;
    function px(e) { return e.touches ? e.touches[0].clientX : e.clientX; }
    function down(e) {
      dragging = true; moved = false; dragX0 = px(e); pressed = true; render();
      e.preventDefault();
    }
    function move(e) {
      if (!dragging) return;
      var dx = px(e) - dragX0;
      if (Math.abs(dx) > 4) moved = true;
      var raw = (checked ? v : 0) + dx;
      var shown = raw < 0 ? raw * 0.6 : (raw > v ? v + (raw - v) * 0.4 : raw); /* 橡皮筋 */
      xS.jump(shown);
      e.preventDefault();
    }
    function up() {
      if (!dragging) return;
      dragging = false; pressed = false;
      if (moved) setChecked(xS.get() > v / 2);
      else setChecked(!checked);
      render();
    }
    root.addEventListener('mousedown', down);
    root.addEventListener('touchstart', down, { passive: false });
    window.addEventListener('mousemove', move);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('mouseup', up);
    window.addEventListener('touchend', up);

    host.appendChild(root);
    return {
      set: function (val) { if (val !== checked) setChecked(val, true); },
      get checked() { return checked; }
    };
  }

  /* ==================== 滑块（Slider 1:1） ==================== */
  function createLGSlider(host, opts) {
    opts = opts || {};
    var k = (opts.width || 240) / 330;
    var W = 330 * k, H = 60 * k;                 /* 容器 */
    var thTrack = 14 * k;                        /* 轨道高 */
    var tw2 = 90 * k, th2 = 60 * k, r2 = 30 * k; /* 拇指 */
    var bezel = Math.max(2, Math.round(16 * k));
    var thick = Math.max(5, Math.round(80 * k));
    var min = opts.min !== undefined ? opts.min : 0;
    var max = opts.max !== undefined ? opts.max : 100;
    var pct = ((opts.value !== undefined ? opts.value : min) - min) / (max - min || 1) * 100;
    var onChange = opts.onChange || function () {};
    var pressed = false, hovered = false;

    var filterId = 'lg-sl-' + (++uid);
    var useFilter = false;
    if (!perfOff() && typeof ImageData === 'function') {
      try {
        ensureFilter(filterId, {
          w: Math.round(tw2), h: Math.round(th2), radius: Math.round(r2),
          bezelWidth: bezel, glassThickness: thick, refractiveIndex: 1.45,
          bezelType: 'convex_squircle', blur: 0, specularOpacity: 0.4, specularSaturation: 7,
          scaleRatio: 0.4
        });
        useFilter = true;
      } catch (e) { useFilter = false; }
    }

    var root = document.createElement('div');
    root.className = 'lg-slider';
    root.style.cssText = 'position:relative;width:' + W + 'px;height:' + H + 'px;flex:1;min-width:120px;touch-action:none;';

    var track = document.createElement('div');
    track.style.cssText = 'position:absolute;left:0;top:' + ((H - thTrack) / 2) + 'px;width:' + W + 'px;height:' + thTrack + 'px;border-radius:' + (thTrack / 2) + 'px;background:#89898F66;cursor:pointer;';
    var fill = document.createElement('div');
    fill.style.cssText = 'height:100%;width:' + pct + '%;border-radius:' + (6 * k) + 'px;background:#0377F7;';
    var fillWrap = document.createElement('div');
    fillWrap.style.cssText = 'width:100%;height:100%;overflow:hidden;border-radius:inherit;';
    fillWrap.appendChild(fill);
    track.appendChild(fillWrap);

    var thumb = document.createElement('div');
    thumb.style.cssText = 'position:absolute;width:' + tw2 + 'px;height:' + th2 + 'px;top:0;border-radius:' + r2 + 'px;cursor:pointer;z-index:2;transform-origin:center;will-change:transform,background-color;';
    if (useFilter) {
      thumb.style.backdropFilter = 'url(#' + filterId + ')';
      thumb.style.webkitBackdropFilter = 'url(#' + filterId + ')';
    } else {
      thumb.style.backdropFilter = 'blur(' + (2 * k) + 'px) saturate(1.6)';
    }
    root.appendChild(track);
    root.appendChild(thumb);

    /* 拇指行程: center ∈ [tw2/2, W - tw2/2] */
    var leftMin = 0, leftMax = W - tw2;
    function valueToPct(p) { return Math.max(0, Math.min(100, p)); }
    function pctToX(p) { return leftMin + (leftMax - leftMin) * (p / 100); }

    var xS = spring(pctToX(pct), 1000, 80, render);
    var sS = spring(0.6, 2000, 80, render);
    var aS = spring(1, 2000, 80, render);

    function render() {
      thumb.style.transform = 'translateX(' + xS.get() + 'px) scale(' + sS.get() + ')';
      thumb.style.backgroundColor = 'rgba(255, 255, 255, ' + aS.get().toFixed(3) + ')';
      thumb.style.boxShadow = '0 ' + (3 * k) + 'px ' + (14 * k) + 'px rgba(0,0,0,0.1)';
      var p = valueToPct((xS.get() + tw2 / 2 - tw2 / 2 - leftMin) / ((leftMax - leftMin) || 1) * 100);
      /* 直接由 x 换算填充 */
      var pp = valueToPct((xS.get() - leftMin) / ((leftMax - leftMin) || 1) * 100);
      fill.style.width = pp + '%';
    }
    render();

    function setActive() {
      var on = pressed || hovered;
      sS.set(on ? 1 : 0.6);
      aS.set(on ? 0.1 : 1);
      if (useFilter) setFilterRatio(filterId, 0.4 + 0.5 * (on ? 1 : 0));
    }

    function emit() {
      var pp = valueToPct((xS.get() - leftMin) / ((leftMax - leftMin) || 1) * 100);
      onChange(min + (max - min) * pp / 100);
    }

    var dragX0 = 0, x0 = 0, dragging = false;
    function px(e) { return e.touches ? e.touches[0].clientX : e.clientX; }
    function down(e) {
      dragging = true; pressed = true; setActive();
      dragX0 = px(e); x0 = xS.get();
      e.preventDefault();
    }
    function move(e) {
      if (!dragging) return;
      var dx = px(e) - dragX0;
      var nx = Math.max(leftMin - 6, Math.min(leftMax + 6, x0 + dx));
      xS.jump(nx);
      emit();
      e.preventDefault();
    }
    function up() {
      if (!dragging) return;
      dragging = false; pressed = false; setActive();
    }
    thumb.addEventListener('mousedown', down);
    thumb.addEventListener('touchstart', down, { passive: false });
    window.addEventListener('mousemove', move);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('mouseup', up);
    window.addEventListener('touchend', up);
    thumb.addEventListener('mouseenter', function () { hovered = true; setActive(); });
    thumb.addEventListener('mouseleave', function () { hovered = false; setActive(); });
    /* 点击轨道跳转 */
    track.addEventListener('mousedown', function (e) {
      var rect = root.getBoundingClientRect();
      var cx = e.clientX - rect.left - tw2 / 2;
      xS.set(Math.max(leftMin, Math.min(leftMax, cx)));
      emit();
    });

    host.appendChild(root);
    return {
      set: function (val) {
        var p = valueToPct(((val !== undefined ? val : min) - min) / (max - min || 1) * 100);
        xS.set(pctToX(p));
      }
    };
  }

  /* ==================== 增强设置页控件 ==================== */
  function enhanceControls() {
    /* 开关 */
    document.querySelectorAll('label.switch').forEach(function (sw) {
      if (sw.dataset.lgEnhanced) return;
      var input = sw.querySelector('input[type=checkbox]');
      if (!input) return;
      sw.dataset.lgEnhanced = '1';
      sw.style.display = 'none';
      var holder = document.createElement('span');
      holder.style.cssText = 'display:inline-flex;align-items:center;margin-left:auto;';
      sw.parentNode.insertBefore(holder, sw.nextSibling);
      var comp = null;
      comp = createLGSwitch(holder, {
        checked: input.checked,
        scale: 0.55,
        onChange: function (val) {
          if (input.checked !== val) {
            input.checked = val;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
      input.addEventListener('change', function () { if (comp) comp.set(input.checked); });
    });
    /* 滑块 */
    document.querySelectorAll('input[type=range]').forEach(function (rng) {
      if (rng.dataset.lgEnhanced) return;
      if (rng.closest('.lg-slider') || rng.closest('.lg-switch')) return;
      rng.dataset.lgEnhanced = '1';
      var min = Number(rng.min) || 0;
      var max = Number(rng.max) || 100;
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;width:100%;';
      rng.parentNode.replaceChild(wrap, rng);
      wrap.appendChild(rng);
      rng.style.display = 'none';
      var comp = createLGSlider(wrap, {
        value: Number(rng.value) || 0,
        min: min, max: max,
        width: Math.max(160, Math.min(300, rng.offsetWidth && rng.offsetWidth > 40 ? rng.offsetWidth : 220)),
        onChange: function (val) {
          var v = Math.round(val * 100) / 100;
          if (String(v) !== rng.value) {
            rng.value = String(v);
            rng.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      });
      rng.addEventListener('input', function () { comp.set(Number(rng.value)); });
    });
  }

  window.LGComponents = { enhance: enhanceControls, createLGSwitch: createLGSwitch, createLGSlider: createLGSlider };

  function boot() {
    try { enhanceControls(); } catch (e) { console.warn('[LG] enhance failed', e); }
    setTimeout(function () { try { enhanceControls(); } catch (e) {} }, 1200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
