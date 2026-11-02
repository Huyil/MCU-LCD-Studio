/*
 * 圆环「逐像素扫描」导出 (对齐 参考工程 的 picArc / frameIndices 数据格式)
 *
 * 需求 (用户原话): 「沿着圆环递增方向, 逐坐标和像素颜色导出, 最后还有一份分档位的
 * 映射表, 用于区分每个刻度」—— 即:
 *   const ArcPX_PIC picArc[N] = { {x,y,RGB565}, ... };   // 沿递增方向的一串像素
 *   const unsigned short frameIndices[LEVELS+1] = ...;   // 每档最后一个像素的下标
 *
 * 本模块只做「已渲染好的 240×240 画布 → 有序像素序列 + 档位表」, 不碰 DOM:
 *   · 圆环: 以中径为中心, 沿角度递增方向扫描, 横向取 scanWidth 像素 (默认 2px)
 *   · 圆角矩形: 以中心线周长参数 t 递增, 沿法线方向取 scanWidth 像素
 *   · 颜色: 画布 RGBA 与黑底混合 → RGB565; 默认按 LCD_drawPx 的字节序做高低交换
 *     (参考工程 的 picArc 就是交换过的: 0x07E0 绿 → 0xE007)
 *   · frameIndices[L] = 第 L 档结束处最后一个像素下标 (含); L=1..LEVELS,
 *     frameIndices[0]=0, 满档 = COUNT-1 —— 引擎点第 L 档时画 0..frameIndices[L] 即可。
 *
 * 纯函数 scanFromImage() 可直接被 Node 自检调用; buildRingScan() 负责在浏览器里
 * 建离屏画布、调 drawRing、读回 ImageData, 再生成 .h/.c 文本。
 */
import { drawRing, ringArcRange, ringRectGeom, ringRectPointAt, ringLapPx, ringInsetPx } from './ringrender.js'
import { rgb888To565 } from './colors.js'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** 扫描参数归一化 (与 UI/导出共用) */
export function ringScanOpts(r) {
  const rawW = Number(r?.scanWidth ?? 2)
  const rawStep = Number(r?.scanStepPx ?? 0.5)
  const width = clamp(Math.round(Number.isFinite(rawW) ? rawW : 2), 1, 64)
  const stepPx = clamp(Number.isFinite(rawStep) ? rawStep : 0.5, 0.1, 8)
  const levels = clamp(Math.round(Number(r?.scanLevels) || Number(r?.steps ?? 40) || 40), 2, 720)
  const swap = r?.scanSwap !== false
  return { width, stepPx, levels, swap }
}

/** 圆环/圆角矩形的扫描中心 (与 drawRing 的圆心取整规则一致) */
function scanCenter(inst) {
  const r = inst.ring
  const sync = r?.syncMcU !== false
  const w = Math.max(2, Math.round(inst.w)), h = Math.max(2, Math.round(inst.h))
  const lx = sync ? Math.floor((w - 1) / 2) : (w - 1) / 2
  const ly = sync ? Math.floor((h - 1) / 2) : (h - 1) / 2
  return { cx: (Number(inst.x) || 0) + lx, cy: (Number(inst.y) || 0) + ly, sync }
}

/** 采样一个屏幕像素 → RGB565 (已按需要交换字节); alpha=0/纯黑返回 0 */
function pixel565(img, w, h, x, y, swap) {
  if (x < 0 || y < 0 || x >= w || y >= h) return 0
  const i = (y * w + x) * 4
  const a = img.data[i + 3]
  if (!a) return 0
  const k = a / 255
  const r = Math.round(img.data[i] * k)
  const g = Math.round(img.data[i + 1] * k)
  const b = Math.round(img.data[i + 2] * k)
  let c = rgb888To565(r, g, b)
  if (!c) return 0
  if (swap) c = ((c & 0xFF) << 8) | (c >> 8)
  return c
}

/**
 * 纯扫描: 输入已渲染的屏幕 ImageData (RGBA), 输出
 *   { px: [{x,y,color,t}], frames: Uint16Array, count, levels, opts, ... }
 * t = 沿弧进度 0..1 (递增方向); 颜色已按 swap 处理.
 */
export function scanFromImage(inst, sc, img, opts = {}) {
  const ring = inst.ring
  if (!ring) return null
  const o = { ...ringScanOpts(ring), ...opts }
  const levels = clamp(Math.round(o.levels), 2, 720)
  const width = clamp(Math.round(o.width), 1, 64)
  const W = Math.max(2, Math.round(sc.w)), H = Math.max(2, Math.round(sc.h))
  const { cx, cy } = scanCenter(inst)
  const range = ringArcRange(ring)
  const isRect = ring.shape === 'rect'
  const dir = range.dir
  const spanF = range.spanDeg / 360
  const seen = new Set()
  const px = []
  /* scanWidth 个采样点沿带宽方向均布 (宽度 2 → 中径 ±0.5px; 宽度 3 → -1/0/+1) */
  const offs = []
  for (let k = 0; k < width; k++) offs.push((k + 0.5) - width / 2)
  const pushAt = (x, y, t) => {
    const ix = Math.round(x), iy = Math.round(y)
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return
    const key = iy * W + ix
    if (seen.has(key)) return
    const c = pixel565(img, W, H, ix, iy, o.swap)
    if (!c) return
    seen.add(key)
    px.push({ x: ix, y: iy, color: c, t })
  }

  if (isRect) {
    const g = ringRectGeom(Math.max(2, Math.round(inst.w)), Math.max(2, Math.round(inst.h)), ring)
    const per = Math.max(1, ringLapPx(Math.max(2, Math.round(inst.w)), Math.max(2, Math.round(inst.h)), ring))
    const t0 = ((((Number(ring.startDeg) || 0) + 90) / 360) + 1) % 1
    const stepsN = Math.max(2, Math.ceil((per * spanF) / o.stepPx))
    for (let i = 0; i <= stepsN; i++) {
      const u = i / stepsN
      const t = ((t0 + dir * u * spanF) % 1 + 1) % 1
      const p = ringRectPointAt(t, g.hx, g.hy, g.rc)
      const p2 = ringRectPointAt((t + 1e-4) % 1, g.hx, g.hy, g.rc)
      let dx = p2.x - p.x, dy = p2.y - p.y
      const len = Math.hypot(dx, dy) || 1
      const nx = dy / len, ny = -dx / len          // 外法线 (t 增大方向在右侧)
      for (const off of offs) pushAt(cx + p.x + nx * off, cy + p.y + ny * off, u)
    }
  } else {
    const inset = ringInsetPx(ring)
    const rOut = Math.max(1, (ring.rOut ?? 2) - inset / 2)
    const rIn = Math.max(0, Math.min((ring.rIn ?? 0) - inset / 2, rOut - 1))
    const rMid = (rIn + rOut) / 2
    const startA = ((Number(ring.startDeg) || 0) * Math.PI) / 180
    const spanA = (range.spanDeg * Math.PI) / 180
    const stepA = o.stepPx / Math.max(1, rMid)
    const stepsN = Math.max(2, Math.ceil(spanA / stepA))
    for (let i = 0; i <= stepsN; i++) {
      const u = i / stepsN
      const a = startA + dir * u * spanA
      const ca = Math.cos(a), sa = Math.sin(a)
      for (const off of offs) pushAt(cx + (rMid + off) * ca, cy + (rMid + off) * sa, u)
    }
  }

  if (!px.length) return { px, frames: new Uint16Array(levels + 1), count: 0, levels, opts: o, range, isRect }
  /* 档位表: 每档结束角/路径位置的最后一个像素下标 (含) */
  const frames = new Uint16Array(levels + 1)
  let p = 0
  for (let L = 1; L <= levels; L++) {
    const u = L / levels
    while (p < px.length && px[p].t <= u + 1e-9) p++
    frames[L] = Math.max(0, Math.min(px.length - 1, p - 1))
  }
  frames[0] = 0
  frames[levels] = px.length - 1
  return { px, frames, count: px.length, levels, opts: o, range, isRect }
}

const hx4 = (v) => '0x' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')

/** 生成 ring_scan.h / ring_scan.c 文本 (对齐 参考工程 的 ArcPX_PIC / picArc / frameIndices 思路) */
export function ringScanFiles(inst, seq, sc = { w: 240, h: 240 }) {
  const r = inst.ring
  const o = seq.opts
  const coord16 = Math.max(sc.w, sc.h) > 255
  const cx = Math.round(scanCenter(inst).cx), cy = Math.round(scanCenter(inst).cy)
  const range = seq.range
  const count = seq.count
  const levels = seq.levels
  const guard = 'RING_SCAN_H'
  const h = []
  h.push('/*')
  h.push(' * ring_scan.h —— 圆环逐像素扫描表 (由网页 MCU-LCD-Editer 自动生成, 请勿手改)')
  h.push(' *')
  h.push(' * 沿圆环**递增方向**逐坐标 + RGB565 颜色; 颜色已按 LCD_drawPx 的字节序做高低交换')
  h.push(' * (与 参考工程 的 picArc 一致: 0x07E0 绿 → 0xE007)。')
  h.push(' *')
  h.push(' * frameIndices[L] = 第 L 档结束处最后一个像素下标 (含):')
  h.push(' *   frameIndices[0] = 0, frameIndices[LEVELS] = COUNT-1;')
  h.push(' *   点亮第 L 档 = 从 0 画到 frameIndices[L] (含); 跨过该下标即一档。')
  h.push(' *')
  h.push(' * 扫描参数: 形状 ' + (seq.isRect ? '圆角矩形' : '圆环') +
         '; 中心 (' + cx + ',' + cy + '); 起始 ' + range.startDeg.toFixed(2) + '°' +
         '; 跨度 ' + range.spanDeg.toFixed(2) + '°; 方向 ' + (range.dir > 0 ? '顺时针' : '逆时针'))
  h.push(' *           线宽 ' + o.width + 'px; 步长 ' + o.stepPx + 'px; 档位 ' + levels +
         (o.swap ? '; 颜色已交换字节' : '; 颜色未交换'))
  h.push(' */')
  h.push('#ifndef ' + guard)
  h.push('#define ' + guard)
  h.push('')
  h.push('#define RING_SCAN_COUNT   ' + count)
  h.push('#define RING_SCAN_LEVELS  ' + levels)
  h.push('#define RING_SCAN_CX      ' + cx)
  h.push('#define RING_SCAN_CY      ' + cy)
  h.push('#define RING_SCAN_START_DEG ' + range.startDeg.toFixed(2))
  h.push('#define RING_SCAN_SPAN_DEG  ' + range.spanDeg.toFixed(2))
  h.push('#define RING_SCAN_DIR     ' + range.dir)
  h.push('#define RING_SCAN_SHAPE   ' + (seq.isRect ? 1 : 0))
  h.push('#define RING_SCAN_WIDTH   ' + o.width)
  h.push('#define RING_SCAN_STEP_PX ' + o.stepPx)
  h.push('#define RING_SCAN_SWAP    ' + (o.swap ? 1 : 0))
  h.push('#define RING_SCAN_COORD16 ' + (coord16 ? 1 : 0))
  h.push('')
  h.push('/* 与 参考工程 pic.h 的 ArcPX_PIC 同布局 (x,y,color); 屏幕 >255 时坐标自动用 16 位 */')
  h.push('#if RING_SCAN_COORD16')
  h.push('typedef struct { unsigned short x, y; unsigned short color; } RingScanPx;')
  h.push('#else')
  h.push('typedef struct { unsigned char  x, y; unsigned short color; } RingScanPx;')
  h.push('#endif')
  h.push('')
  h.push('extern const RingScanPx ringScanPx[RING_SCAN_COUNT];')
  h.push('extern const unsigned short ringScanFrame[RING_SCAN_LEVELS + 1];')
  h.push('')
  h.push('#endif /* ' + guard + ' */')
  h.push('')

  const c = []
  c.push('/*')
  c.push(' * ring_scan.c —— 由网页 MCU-LCD-Editer 生成; 数据顺序 = 沿圆环递增方向逐像素。')
  c.push(' * 颜色字段已经是 LCD_drawPx 需要的字节序 (高/低交换)。')
  c.push(' */')
  c.push('#include "ring_scan.h"')
  c.push('')
  c.push('const RingScanPx ringScanPx[RING_SCAN_COUNT] = {')
  for (let i = 0; i < seq.px.length; i += 8) {
    const line = seq.px.slice(i, i + 8).map(p => '{' + p.x + ',' + p.y + ',' + hx4(p.color) + '},')
    c.push('    ' + line.join(' '))
  }
  c.push('};')
  c.push('')
  c.push('/* 每档结束下标 (含); [0]=0, [LEVELS]=COUNT-1 */')
  c.push('const unsigned short ringScanFrame[RING_SCAN_LEVELS + 1] = {')
  for (let i = 0; i < seq.frames.length; i += 16) {
    c.push('    ' + Array.from(seq.frames.slice(i, i + 16)).join(', ') + ',')
  }
  c.push('};')
  c.push('')
  return { header: h.join('\n'), source: c.join('\n'), count, levels, coord16 }
}

/** 浏览器侧: 满档渲染圆环到屏幕画布 → getImageData → 扫描 → 生成文件 */
export function buildRingScan(inst, sc, overrides = {}) {
  const r = inst.ring
  if (!r) return null
  const W = Math.max(2, Math.round(sc?.w || 240))
  const H = Math.max(2, Math.round(sc?.h || 240))
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')
  if (!ctx || typeof ctx.getImageData !== 'function') return null
  /* 满档 + 关白斑/动画: 扫描表是静态设计数据, 不能被当前 value/光斑污染 */
  const ring = { ...r, value: Math.max(0, Math.round(r.steps ?? 40)), glintOn: false,
                 autoGlint: false, autoArc: false, effect: 'static', tailU: 0 }
  drawRing(ctx, { ...inst, x: Number(inst.x) || 0, y: Number(inst.y) || 0, w: Math.round(inst.w), h: Math.round(inst.h), ring })
  let img
  try { img = ctx.getImageData(0, 0, W, H) } catch { return null }
  const seq = scanFromImage(inst, { w: W, h: H }, img, { ...ringScanOpts(r), ...overrides })
  if (!seq || !seq.count) return null
  const files = ringScanFiles(inst, seq, { w: W, h: H })
  return { ...files, seq }
}
