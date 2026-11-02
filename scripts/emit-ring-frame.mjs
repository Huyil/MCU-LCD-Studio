/*
 * 渲染一帧给「网页 ↔ 固件逐像素对拍」用 (node scripts/emit-ring-frame.mjs '<json>' out.bin)
 *
 * 与 parity.c 同一组参数、同一块画布: 240×240, 圆环图层放在 (0,0),
 * 走「与 MCU 同步预览」那条整数路径 (syncMcU: true) —— 圆心取整、覆盖率、弧权重、
 * 增益量化、Bayer 抖动全部按板子的算法。
 *
 * 形状:
 *   shape = 'circle' (默认): rOut/rIn; 对称
 *   shape = 'rect':           rad/radIn/thick/inset (+ w/h) —— 几何由网页 ringRectGeomQ8() 派生;
 *                             传了 geomQ8 就**逐项核对**网页算出来的与固件导出的宏一致,
 *                             不一致直接报错退出 (免得"两边参数不同却算通过")
 *
 * 输出: 240×240 小端 RGB565 原始字节 (与 parity.c 一模一样)。
 */
import fs from 'node:fs'

globalThis.document = {
  createElement() {
    return {
      width: 0, height: 0,
      getContext: () => ({
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {}, drawImage() {}, clearRect() {}, fillRect() {},
      }),
    }
  },
}

const { drawRing, ringRectGeomQ8 } = await import('../src/ringrender.js')

const cfg = JSON.parse(process.argv[2])
const out = process.argv[3]
if (!cfg || !out) {
  console.error("用法: node scripts/emit-ring-frame.mjs '<json>' out.bin")
  process.exit(2)
}
const w = cfg.w || 240, h = cfg.h || 240
const isRect = cfg.shape === 'rect'
const ring = {
  shape: isRect ? 'rect' : 'circle',
  rOut: cfg.rOut, rIn: cfg.rIn, aa: cfg.aa,
  rad: cfg.rad, radIn: cfg.radIn, thick: cfg.thick, inset: cfg.inset,
  steps: cfg.steps ?? 40, value: cfg.value ?? 0, startDeg: cfg.startDeg ?? -90,
  caps: !!cfg.caps, arcDir: cfg.arcDir ?? 1,
  trackColor: cfg.trackColor ?? 0x6B4D, fillColor: cfg.fillColor ?? 0x07FF,
  glintOn: !!cfg.glintOn, glintDeg: cfg.glintDeg ?? 0,
  glintSigma: cfg.glintSigma ?? 14, glintSpanDeg: cfg.glintSpanDeg ?? 42,
  depth: cfg.depth ?? 0, depthStyle: cfg.depthStyle ?? 'ridge', lightDeg: cfg.lightDeg ?? -45,
  syncMcU: true,                       // 关键: 走板子那条整数路径
  autoGlint: false,                    // 关掉预览动画的值覆盖
}

/* 矩形: 先核对几何 —— 网页 ringRectGeomQ8() 必须与固件导出的宏逐项相同 */
if (isRect && cfg.geomQ8) {
  const G = ringRectGeomQ8(w, h, ring)
  const map = { hx: G.hx, hy: G.hy, rc: G.rc, ht: G.ht, oHx: G.oHx, oHy: G.oHy, oRc: G.oRc,
                iHx: G.iHx, iHy: G.iHy, iRc: G.iRc, per: G.per, invPer: G.invPer }
  const tol = cfg.geomTol ?? 1        /* 固件那侧的设计参数是从 Q8 反推的 → 放宽 ±1 (0.004px) */
  for (const k of Object.keys(map)) {
    if (cfg.geomQ8[k] === undefined) continue
    if (Math.abs(cfg.geomQ8[k] - map[k]) > tol) {
      console.error(`几何不一致: ${k} 固件 ${cfg.geomQ8[k]} ≠ 网页 ${map[k]} (ring_config.h 与网页参数不是同一份)`)
      process.exit(3)
    }
  }
}

const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
drawRing({ createImageData: () => img, putImageData() {}, drawImage() {}, clearRect() {}, fillRect() {} },
  { id: 'parity', x: 0, y: 0, w, h, ring })

/* 画布是 RGB565 展开出来的 8bit (v*255/31 等), 反算回 565 是精确的 */
const buf = Buffer.alloc(w * h * 2)
for (let i = 0; i < w * h; i++) {
  const r5 = Math.round(img.data[i * 4] * 31 / 255)
  const g6 = Math.round(img.data[i * 4 + 1] * 63 / 255)
  const b5 = Math.round(img.data[i * 4 + 2] * 31 / 255)
  const v = ((r5 << 11) | (g6 << 5) | b5) & 0xFFFF
  buf.writeUInt16LE(v, i * 2)
}
fs.writeFileSync(out, buf)
