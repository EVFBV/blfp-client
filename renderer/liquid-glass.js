/* ============================================================
 * Liquid Glass 引擎 — 移植自 liunian.js.org 液态玻璃实现
 * 原理：canvas 生成折射位移图 + 镜面高光图 → SVG 滤镜链
 *   feColorMatrix(明暗) → feGaussianBlur → feDisplacementMap(折射)
 *   → feColorMatrix(增饱和) → feComposite/feBlend(镜面高光)
 * ============================================================ */
(function () {
  'use strict';

  /* ---- bezelHeightFn：边缘高度曲线（默认 Tu.fn） ---- */
  const defaultBezelFn = (t) => Math.pow(1 - Math.pow(1 - t, 4), 1 / 4);

  /* ---- gu：边缘折射剖面（斯涅尔定律） ---- */
  function bezelProfile(thickness = 200, bezelWidth = 50, refractiveIndex = 1.5, N = 128) {
    const inv = 1 / refractiveIndex;
    function refract(a, l) {
      const u = l;
      const c = 1 - inv * inv * (1 - u * u);
      if (c < 0) return null;
      const h = Math.sqrt(c);
      return [-(inv * u + h) * a, inv - (inv * u + h) * l];
    }
    return Array.from({ length: N }, (_, i) => {
      const u = i / N;
      const c0 = defaultBezelFn(u);
      const h = u < 1 ? 1e-4 : -1e-4;
      const d = (defaultBezelFn(u + h) - c0) / h;
      const m = Math.sqrt(d * d + 1);
      const y = [-d / m, -1 / m];
      const v = refract(y[0], y[1]);
      if (v) {
        const x = c0 * bezelWidth + thickness;
        return v[0] * (x / v[1]);
      }
      return 0;
    });
  }

  /* ---- yu：折射位移图（R=x位移 G=y位移，128=中性） ---- */
  function displacementMap(cw, ch, w, h, radius, bezelWidth, maxAbs, profile, dpr) {
    dpr = dpr || 1;
    const c = Math.round(cw * dpr), hh = Math.round(ch * dpr);
    const img = new ImageData(c, hh);
    new Uint32Array(img.data.buffer).fill(4278222976); /* 0xFF808000 LE = R128 G128 B0 A255 */
    const m = radius * dpr, y = bezelWidth * dpr;
    const v = m * m, g = (m + 1) * (m + 1), x = (m - y) * (m - y);
    const p = w * dpr, P = h * dpr;
    const T = p - m * 2, A = P - m * 2;
    const V = (c - p) / 2, b = (hh - P) / 2;
    for (let M = 0; M < P; M++) {
      for (let C = 0; C < p; C++) {
        const O = ((b + M) * c + V + C) * 4;
        const q0 = C < m, qt = C >= p - m, et = M < m, gt = M >= P - m;
        const yt = q0 ? C - m : qt ? C - m - T : 0;
        const R = et ? M - m : gt ? M - m - A : 0;
        const B = yt * yt + R * R;
        if (B <= g && B >= x) {
          const fal = B < v ? 1 : 1 - (Math.sqrt(B) - Math.sqrt(v)) / (Math.sqrt(g) - Math.sqrt(v));
          const Z = Math.sqrt(B);
          const de = m - Z;
          const Rr = yt / Z, Er = R / Z;
          const Lr = (de / y * profile.length) | 0;
          const Rn = profile[Lr] !== undefined ? profile[Lr] : 0;
          const Fr = -Rr * Rn / maxAbs, kr = -Er * Rn / maxAbs;
          img.data[O] = 128 + Fr * 127 * fal;
          img.data[O + 1] = 128 + kr * 127 * fal;
          img.data[O + 2] = 0;
          img.data[O + 3] = 255;
        }
      }
    }
    return img;
  }

  /* ---- xu：镜面高光图（60° 方向光 + 环带剖面） ---- */
  function specularMap(w, h, radius, depth = 50, angle = Math.PI / 3, dpr) {
    dpr = dpr || 1;
    const a = Math.round(w * dpr), l = Math.round(h * dpr);
    const img = new ImageData(a, l);
    new Uint32Array(img.data.buffer).fill(0);
    const c = radius * dpr, hh = depth * dpr;
    const f = [Math.cos(angle), Math.sin(angle)];
    const m = c * c, y = (c + dpr) * (c + dpr), v = (c - hh) * (c - hh);
    const g = a - c * 2, x = l - c * 2;
    for (let p = 0; p < l; p++) {
      for (let P = 0; P < a; P++) {
        const T = (p * a + P) * 4;
        const A = P < c, V = P >= a - c, b = p < c, M = p >= l - c;
        const C = A ? P - c : V ? P - c - g : 0;
        const O = b ? p - c : M ? p - c - x : 0;
        const q = C * C + O * O;
        if (q <= y && q >= v) {
          const et = Math.sqrt(q);
          const gt = c - et;
          const yt = q < m ? 1 : 1 - (et - Math.sqrt(m)) / (Math.sqrt(y) - Math.sqrt(m));
          const R = C / et, B = -O / et;
          const dol = Math.abs(R * f[0] + B * f[1]) * Math.sqrt(1 - (1 - gt / (1 * dpr)) ** 2);
          const Z = 255 * dol;
          const de = Z * dol * yt;
          img.data[T] = Z;
          img.data[T + 1] = Z;
          img.data[T + 2] = Z;
          img.data[T + 3] = de;
        }
      }
    }
    return img;
  }

  /* ---- ImageData → dataURL ---- */
  function toDataURL(img) {
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    cv.getContext('2d').putImageData(img, 0, 0);
    return cv.toDataURL();
  }

  /* ---- 滤镜参数（跟设置页滑块联动） ---- */
  const params = {
    thickness: 200,      /* 玻璃厚度 */
    bezelWidth: 50,      /* 折射边带宽度 */
    refraction: 0.28,    /* 折射强度（缩放） */
    specularOpacity: 0.55,/* 镜面高光不透明度 */
    saturation: 4,       /* 镜面饱和度 */
    blur: 1,             /* 滤镜内模糊 */
    mapSize: 256,        /* 位移图尺寸（拉伸到元素） */
    radius: 56,          /* 圆角半径基准 */
  };

  let filterSVG = null;

  /* ---- 构建并注入 SVG 滤镜 ---- */
  function build() {
    const profile = bezelProfile(params.thickness, params.bezelWidth, 1.5, 128);
    const maxAbs = Math.max(...profile.map(Math.abs)) || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const S = params.mapSize;
    const dispURL = toDataURL(displacementMap(S, S, S, S, params.radius, params.bezelWidth, maxAbs, profile, dpr));
    const specURL = toDataURL(specularMap(S, S, params.radius, 50, Math.PI / 3, dpr));
    const dark = !document.documentElement.dataset.theme || document.documentElement.dataset.theme !== 'light';
    const bright = dark
      ? '0.9 0 0 0 -0.3 0 0.9 0 0 -0.3 0 0 0.9 0 -0.3 0 0 0 1 0'
      : '1.03 0 0 0 0.2 0 1.03 0 0 0.2 0 0 1.03 0 0.2 0 0 0 1 0';
    const scale = maxAbs * params.refraction;

    if (filterSVG) filterSVG.remove();
    filterSVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    filterSVG.setAttribute('width', '0');
    filterSVG.setAttribute('height', '0');
    filterSVG.style.position = 'fixed';
    filterSVG.style.pointerEvents = 'none';
    filterSVG.innerHTML =
      '<defs><filter id="lg-refract-filter" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">' +
      '<feColorMatrix in="SourceGraphic" type="matrix" values="' + bright + '" result="brightened"/>' +
      '<feGaussianBlur in="brightened" stdDeviation="' + params.blur + '" result="blurred"/>' +
      '<feImage href="' + dispURL + '" x="0" y="0" width="100%" height="100%" result="disp_map" preserveAspectRatio="none"/>' +
      '<feDisplacementMap in="blurred" in2="disp_map" scale="' + scale + '" xChannelSelector="R" yChannelSelector="G" result="displaced"/>' +
      '<feColorMatrix in="displaced" type="saturate" values="' + params.saturation + '" result="displaced_saturated"/>' +
      '<feImage href="' + specURL + '" x="0" y="0" width="100%" height="100%" result="specular" preserveAspectRatio="none"/>' +
      '<feComposite in="displaced_saturated" in2="specular" operator="in" result="specular_saturated"/>' +
      '<feComponentTransfer in="specular" result="specular_faded"><feFuncA type="linear" slope="' + params.specularOpacity + '"/></feComponentTransfer>' +
      '<feBlend in="specular_saturated" in2="displaced" mode="normal" result="with_sat"/>' +
      '<feBlend in="specular_faded" in2="with_sat" mode="normal"/>' +
      '</filter></defs>';
    document.body.appendChild(filterSVG);
  }

  /* ---- 对外 API ---- */
  window.LiquidGlass = {
    update(next) {
      Object.assign(params, next || {});
      build();
    },
    rebuild: build,
    params,
  };

  /* ---- 初始化 ---- */
  function ready() { try { build(); } catch (e) { console.warn('[LG] init failed', e); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();

  /* ---- 主题切换时重建（明暗矩阵不同） ---- */
  new MutationObserver(() => { try { build(); } catch (e) {} })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();
