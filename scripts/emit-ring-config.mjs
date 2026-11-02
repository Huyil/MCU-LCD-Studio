/*
 * 用**真导出器**生成一份 ring_config.h: node scripts/emit-ring-config.mjs '<json>' out.h
 *
 * 给主机自检/逐像素对拍用 (tools/ring_sim/parity.py): 圆角矩形那一支的 ring_config.h 与
 * 圆环完全不同 (RING_SHAPE + Q8 几何宏), 手写一份迟早跟导出器走偏 —— 这里直接调
 * store.buildRingConfig() (用户点「下载 ring_config.h」走的同一条路)。
 *
 * json 字段 (都可省, 有默认): { shape, w, h, rad, radIn, thick, inset, aa, startDeg, value,
 *   steps, caps, arcDir, glintOn, glintSigma, glintSpanDeg, trackColor, fillColor,
 *   tickMs, gear, dir, depth, depthStyle, lightDeg, x, y }
 */
import fs from 'node:fs'

/* ---- 浏览器 API 桩 (与 check-export-keil.mjs 同一套思路) ---- */
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null }, setItem(k, v) { this._m.set(k, String(v)) } }
globalThis.indexedDB = { open() { throw new Error('no idb in node') } }
globalThis.fetch = async () => { throw new Error('no net in node') }
globalThis.document = {
  createElement() {
    return {
      width: 0, height: 0,
      getContext: () => ({
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {}, drawImage() {}, clearRect() {}, fillRect() {}, fillText() {},
        measureText: () => ({ width: 8 }),
      }),
    }
  },
}

const { createServer } = await import('vite')
const cfg = JSON.parse(process.argv[2] || '{}')
const out = process.argv[3]
if (!out) {
  console.error("用法: node scripts/emit-ring-config.mjs '<json>' out.h")
  process.exit(2)
}

const server = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
})
const store = await server.ssrLoadModule('/src/store.js')
/* 屏幕尺寸: 默认用当前预设; 传了 screenW/screenH 就改预设 (图层可以比屏小) */
if (cfg.screenW || cfg.screenH) {
  const p0 = store.state.presets[0]
  p0.w = Math.max(8, Math.round(cfg.screenW || p0.w))
  p0.h = Math.max(8, Math.round(cfg.screenH || p0.h))
  store.state.activePresetId = p0.id
}
const inst = store.addRingInstance()
const r = inst.ring
r.shape = cfg.shape === 'rect' ? 'rect' : 'circle'
for (const k of ['rad', 'radIn', 'thick', 'inset', 'aa', 'startDeg', 'value', 'steps', 'caps', 'arcDir',
                 'glintOn', 'glintSigma', 'glintSpanDeg', 'trackColor', 'fillColor', 'tickMs', 'gear',
                 'dir', 'depth', 'depthStyle', 'lightDeg', 'rIn', 'rOut', 'glintMs',
                 /* 范围弧 / 分割 / 角向 AA (之前漏拷, 生成的配置会退回默认 90 段整圈) */
                 'arcEndDeg', 'effect', 'countMs', 'tailMs',
                 'segOn', 'segCount', 'segGapDeg', 'segGapPct', 'segPhaseDeg', 'segMode', 'segAA', 'segDepth', 'segSplit',
                 'aaEdge']) {
  if (cfg[k] !== undefined) r[k] = cfg[k]
}
inst.w = cfg.w ?? 240
inst.h = cfg.h ?? 240
inst.x = cfg.x ?? 0
inst.y = cfg.y ?? 0
fs.writeFileSync(out, store.buildRingConfig())
await server.close()
