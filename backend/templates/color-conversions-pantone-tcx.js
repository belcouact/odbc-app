/*
 * Standalone CIELAB / sRGB / Pantone FHI TCX utilities.
 * White point: D65 (Xn=95.047, Yn=100, Zn=108.883)
 * RGB space: sRGB
 * Pantone palette is supplied to nearestPantone / nearestPantones.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ColorConversions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PANTONE_TCX = [];

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const radians = degrees => degrees * Math.PI / 180;
  const degrees = radiansValue => radiansValue * 180 / Math.PI;

  function normalizeLab(L, a, b) {
    if (typeof L === "object" && L !== null) {
      return {
        L: Number(L.L ?? L.l),
        a: Number(L.a),
        b: Number(L.b)
      };
    }
    return { L: Number(L), a: Number(a), b: Number(b) };
  }

  function assertLab(lab) {
    if (![lab.L, lab.a, lab.b].every(Number.isFinite)) {
      throw new TypeError("LAB values must be finite numbers.");
    }
  }

  function labToXyz(L, a, b) {
    const lab = normalizeLab(L, a, b);
    assertLab(lab);
    let y = (lab.L + 16) / 116;
    let x = lab.a / 500 + y;
    let z = y - lab.b / 200;
    const inversePivot = value => {
      const cube = value ** 3;
      return cube > 0.008856 ? cube : (value - 16 / 116) / 7.787;
    };
    x = 95.047 * inversePivot(x);
    y = 100.000 * inversePivot(y);
    z = 108.883 * inversePivot(z);
    return { X: x, Y: y, Z: z };
  }

  function xyzToRgb(X, Y, Z) {
    if (typeof X === "object" && X !== null) ({ X, Y, Z } = X);
    let x = Number(X) / 100;
    let y = Number(Y) / 100;
    let z = Number(Z) / 100;
    if (![x, y, z].every(Number.isFinite)) throw new TypeError("XYZ values must be finite numbers.");

    let r =  3.2406 * x - 1.5372 * y - 0.4986 * z;
    let g = -0.9689 * x + 1.8758 * y + 0.0415 * z;
    let b =  0.0557 * x - 0.2040 * y + 1.0570 * z;
    const gamma = value => value > 0.0031308
      ? 1.055 * (value ** (1 / 2.4)) - 0.055
      : 12.92 * value;
    r = clamp(Math.round(255 * gamma(r)), 0, 255);
    g = clamp(Math.round(255 * gamma(g)), 0, 255);
    b = clamp(Math.round(255 * gamma(b)), 0, 255);
    return { R: r, G: g, B: b };
  }

  function labToRgb(L, a, b) {
    return xyzToRgb(labToXyz(L, a, b));
  }

  function rgbToHex(R, G, B) {
    if (typeof R === "object" && R !== null) ({ R, G, B } = R);
    const toHex = value => clamp(Math.round(Number(value)), 0, 255).toString(16).padStart(2, "0");
    return `#${toHex(R)}${toHex(G)}${toHex(B)}`;
  }

  function labToHex(L, a, b) {
    return rgbToHex(labToRgb(L, a, b));
  }

  function ciede2000(lab1, lab2, options = {}) {
    const c1 = normalizeLab(lab1), c2 = normalizeLab(lab2);
    assertLab(c1); assertLab(c2);
    const kL = Number(options.kL ?? 1), kC = Number(options.kC ?? 1), kH = Number(options.kH ?? 1);
    const C1 = Math.hypot(c1.a, c1.b), C2 = Math.hypot(c2.a, c2.b);
    const meanC = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)));
    const a1p = (1 + G) * c1.a, a2p = (1 + G) * c2.a;
    const C1p = Math.hypot(a1p, c1.b), C2p = Math.hypot(a2p, c2.b);
    const hp = (a, b) => {
      if (a === 0 && b === 0) return 0;
      const h = degrees(Math.atan2(b, a));
      return h >= 0 ? h : h + 360;
    };
    const h1p = hp(a1p, c1.b), h2p = hp(a2p, c2.b);
    const dLp = c2.L - c1.L;
    const dCp = C2p - C1p;
    let dhp;
    if (C1p * C2p === 0) dhp = 0;
    else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
    else if (h2p <= h1p) dhp = h2p - h1p + 360;
    else dhp = h2p - h1p - 360;
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(radians(dhp / 2));
    const meanLp = (c1.L + c2.L) / 2;
    const meanCp = (C1p + C2p) / 2;
    let meanHp;
    if (C1p * C2p === 0) meanHp = h1p + h2p;
    else if (Math.abs(h1p - h2p) <= 180) meanHp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) meanHp = (h1p + h2p + 360) / 2;
    else meanHp = (h1p + h2p - 360) / 2;
    const T = 1
      - 0.17 * Math.cos(radians(meanHp - 30))
      + 0.24 * Math.cos(radians(2 * meanHp))
      + 0.32 * Math.cos(radians(3 * meanHp + 6))
      - 0.20 * Math.cos(radians(4 * meanHp - 63));
    const dTheta = 30 * Math.exp(-(((meanHp - 275) / 25) ** 2));
    const RC = 2 * Math.sqrt(meanCp ** 7 / (meanCp ** 7 + 25 ** 7));
    const SL = 1 + 0.015 * ((meanLp - 50) ** 2) / Math.sqrt(20 + ((meanLp - 50) ** 2));
    const SC = 1 + 0.045 * meanCp;
    const SH = 1 + 0.015 * meanCp * T;
    const RT = -Math.sin(radians(2 * dTheta)) * RC;
    const lTerm = dLp / (kL * SL), cTerm = dCp / (kC * SC), hTerm = dHp / (kH * SH);
    return Math.sqrt(lTerm ** 2 + cTerm ** 2 + hTerm ** 2 + RT * cTerm * hTerm);
  }

  function nearestPantone(L, a, b, palette = PANTONE_TCX) {
    const query = normalizeLab(L, a, b);
    assertLab(query);
    let best = null;
    for (const color of palette) {
      const deltaE = ciede2000(query, color);
      if (best === null || deltaE < best.deltaE) {
        best = {
          id: color.id,
          tcx: `${color.id} TCX`,
          name: color.name,
          hex: color.hex,
          lab: { L: color.L, a: color.a, b: color.b },
          rgb: { R: color.R, G: color.G, B: color.B },
          deltaE
        };
      }
    }
    return best;
  }

  function nearestPantones(L, a, b, limit = 5, palette = PANTONE_TCX) {
    const query = normalizeLab(L, a, b);
    assertLab(query);
    return palette
      .map(color => ({
        id: color.id, tcx: `${color.id} TCX`, name: color.name, hex: color.hex,
        lab: { L: color.L, a: color.a, b: color.b },
        rgb: { R: color.R, G: color.G, B: color.B },
        deltaE: ciede2000(query, color)
      }))
      .sort((x, y) => x.deltaE - y.deltaE)
      .slice(0, Math.max(1, Math.trunc(limit)));
  }

  return Object.freeze({
    labToXyz, xyzToRgb, labToRgb, rgbToHex, labToHex,
    ciede2000, nearestPantone, nearestPantones, PANTONE_TCX
  });
});
