/*
 * 圆环「弧度范围 + 倒计时拖尾」自检: node scripts/check-ringrange.mjs
 *
 * 用户需求 (原话): 「修改圆环代码，增加 起始角 与 结束角或弧度范围」+
 *                  「在 web 实现 DR1152 这个倒计时的圆环效果作为选项，DR1152 带有递减边缘的渐变」
 *
 * 这里不做"调用同一个函数再拿它自己的结果比对"的空转, 而是:
 *   1) 纯函数边界: ringArcRange 的顺/逆时针、跨 0°、null/空串/同角、0.5° 量化;
 *      ringTailU 的固件同式 (720 x tailMs / countMs, 下限 10);
 *   2) 逐像素 oracle: 用独立几何算「圆弧内 / 范围轨道 / 范围外透明」——
 *      圆用 atan2 相对角, 圆角矩形用周长参数 t; 只比明确像素, 跳过 AA/端帽边界;
 *   3) 端帽: 部分弧范围两端, caps 开时轨道也要有圆头 (范围外不能整段消失);
 *   4) 递减边缘: 弧末端 tailU 内颜色从填充色线性过渡到轨道色 (不是硬切);
 *   5) 整圈回归: 不填 arcEndDeg / 填 null / 填 360° 必须逐像素一致。
 */
import { createServer } from 'vite'

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''))
  if (!cond) fails++
}
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-9)
const norm360 = (a) => ((a % 360) + 360) % 360
const norm1 = (a) => ((a % 1) + 1) % 1
const circDiff = (a, b) => { const d = Math.abs(norm1(a) - norm1(b)); return Math.min(d, 1 - d) }

/* ---- 浏览器桩: drawRing 只用 createImageData / putImageData / drawImage ---- */
globalThis.document = {
  createElement() {
    return {
      width: 0, height: 0,
      getContext: () => ({
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {}, drawImage: () => {}, clearRect: () => {}, fillRect: () => {}, fillText: () => {},
      }),
    }
  },
}

const server = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
})
const M = await server.ssrLoadModule('/src/ringrender.js')
const { drawRing, ringArcRange, ringArcGeom, ringTailU, ringRectGeom, ringRectGeomQ8,
  ringRectArcGeom, ringRectPointAt, ringRectPointAtQ8, ringRectBand, ringGradStops,
  ringGradRgb, ringGrad565, mirrorRingX, ringRectCovSdf8 } = M

/* ============================================================
 * 1) ringArcRange: 起始角 → 结束角 的 0.5° 口径
 * ============================================================ */
{
  const cases = [
    ['end 缺省 (null) = 整圈', { arcEndDeg: null }, { spanDeg: 360, rangeU: 720, full: true, dir: 1, endDeg: 270 }],
    ['end = undefined = 整圈', {}, { spanDeg: 360, rangeU: 720, full: true, dir: 1, endDeg: 270 }],
    ['end = 空串 = 整圈', { arcEndDeg: '' }, { spanDeg: 360, rangeU: 720, full: true, dir: 1, endDeg: 270 }],
    ['end 非数字 = 整圈', { arcEndDeg: 'abc' }, { spanDeg: 360, rangeU: 720, full: true, dir: 1, endDeg: 270 }],
    ['270° 逆时针到 0° = 270° 弧 (DR1152 预设)', { startDeg: 270, arcDir: -1, arcEndDeg: 0 },
      { spanDeg: 270, rangeU: 540, full: false, dir: -1, endDeg: 0 }],
    ['270° 顺时针到 0° = 90° 弧', { startDeg: 270, arcDir: 1, arcEndDeg: 0 },
      { spanDeg: 90, rangeU: 180, full: false, dir: 1, endDeg: 360 }],
    ['跨 0°: 350° → 10° = 20°', { startDeg: 350, arcDir: 1, arcEndDeg: 10 },
      { spanDeg: 20, rangeU: 40, full: false, dir: 1, endDeg: 370 }],
    ['负角: -90° → 180° = 270°', { startDeg: -90, arcDir: 1, arcEndDeg: 180 },
      { spanDeg: 270, rangeU: 540, full: false, dir: 1, endDeg: 180 }],
    ['逆时针负角: 180° → -90° = 270°', { startDeg: 180, arcDir: -1, arcEndDeg: -90 },
      { spanDeg: 270, rangeU: 540, full: false, dir: -1, endDeg: -90 }],
    ['起止同角 = 整圈 (不能变成 0° 的环)', { startDeg: 0, arcDir: 1, arcEndDeg: 0 },
      { spanDeg: 360, rangeU: 720, full: true, dir: 1, endDeg: 360 }],
    ['整 360° = 整圈', { startDeg: 12, arcDir: 1, arcEndDeg: 372 },
      { spanDeg: 360, rangeU: 720, full: true, dir: 1, endDeg: 372 }],
    ['0.1° 细弧至少 2 个 0.5° 单位', { startDeg: 0, arcDir: 1, arcEndDeg: 0.1 },
      { spanDeg: 0.1, rangeU: 2, full: false, dir: 1, endDeg: 0.1 }],
    ['359° = 718 个 0.5° 单位, 不是整圈', { startDeg: 0, arcDir: 1, arcEndDeg: 359 },
      { spanDeg: 359, rangeU: 718, full: false, dir: 1, endDeg: 359 }],
    ['start 缺省 -90°: 逆时针到 0° = 270°', { arcDir: -1, arcEndDeg: 0 },
      { spanDeg: 270, rangeU: 540, full: false, dir: -1, endDeg: -360 }],
  ]
  let bad = 0, msg = ''
  for (const item of cases) {
    const name = item[0], input = item[1], want = item[2]
    const got = ringArcRange(input)
    const good = near(got.spanDeg, want.spanDeg) && got.rangeU === want.rangeU &&
      got.full === want.full && got.dir === want.dir && near(got.endDeg, want.endDeg)
    if (!good) {
      bad++
      msg = msg || (name + ': 得 ' + JSON.stringify(got) + ' 期望 ' + JSON.stringify(want))
    }
  }
  ok('ringArcRange ' + cases.length + ' 条边界 (缺省/同角/跨 0°/负角/顺逆时针/0.5° 量化)', bad === 0, msg)
}

/* ============================================================
 * 2) ringTailU: 与固件 app_ring_ui.c ringui_trail_u(sel) 同式
 *    total = max(1000, countMs); u = clamp(round(720 x tailMs / total), 10, 720)
 * ============================================================ */
{
  const cases = [
    ['倒计时 10s / 200ms → 14 个 0.5° (7°)', { effect: 'countdown', countMs: 10000, tailMs: 200 }, 14],
    ['倒计时 1s / 200ms → 144', { effect: 'countdown', countMs: 1000, tailMs: 200 }, 144],
    ['countMs < 1000 按 1000 算', { effect: 'countdown', countMs: 500, tailMs: 200 }, 144],
    ['极短拖尾也保底 10', { effect: 'countdown', countMs: 100000, tailMs: 100 }, 10],
    ['拖尾 0 = 关', { effect: 'countdown', countMs: 10000, tailMs: 0 }, 0],
    ['负拖尾 = 关', { effect: 'countdown', countMs: 10000, tailMs: -5 }, 0],
    ['拖尾 >= 总时长 → 720 封顶', { effect: 'countdown', countMs: 1000, tailMs: 5000 }, 720],
    ['倒计时缺省 = 10s/200ms', { effect: 'countdown' }, 14],
    ['静态 tailU 原样', { effect: 'static', tailU: 33 }, 33],
    ['静态 tailU 负值 → 0', { effect: 'static', tailU: -5 }, 0],
    ['静态 tailU 超 720 → 720', { effect: 'static', tailU: 900 }, 720],
    ['静态缺省 → 0', { effect: 'static' }, 0],
  ]
  let bad = 0, msg = ''
  for (const item of cases) {
    const got = ringTailU(item[1])
    if (got !== item[2]) { bad++; msg = msg || (item[0] + ': 得 ' + got + ' 期望 ' + item[2]) }
  }
  ok('ringTailU ' + cases.length + ' 条 (固件同式 + 下限/封顶 + 静态原样)', bad === 0, msg)
}

/* ============================================================
 * 2b) 左右镜像: 起止角/弧向/白斑/分段相位一起翻, 再翻一次回到原样
 * ============================================================ */
{
  const src = { startDeg: 130, arcEndDeg: 50, arcDir: 1, glintDeg: 0, dir: 1,
                segOn: true, segCount: 90, segPhaseDeg: 0, mirrorX: false }
  const m = mirrorRingX(src)
  const n = mirrorRingX(m)
  const norm = a => ((a % 360) + 360) % 360
  ok('左右镜像: 130°→50° 变成 50°→130°, 弧向翻转, 跨度不变',
    norm(m.startDeg) === 50 && norm(m.arcEndDeg) === 130 && m.arcDir === -1 &&
    near(ringArcRange(m).spanDeg, ringArcRange(src).spanDeg) && m.mirrorX === true,
    JSON.stringify({ start: m.startDeg, end: m.arcEndDeg, dir: m.arcDir }))
  ok('左右镜像: 白斑角镜像 (0°→180°), 白斑转向翻转',
    norm(m.glintDeg) === 180 && m.dir === -1)
  ok('左右镜像: 再翻一次回到原值 (对合)', norm(n.startDeg) === 130 && norm(n.arcEndDeg) === 50 &&
    n.arcDir === 1 && norm(n.glintDeg) === 0 && n.dir === 1 && n.mirrorX === false)
  ok('左右镜像: 整圈 (end=null) 只翻起始角/弧向, 保持整圈',
    (() => { const x = mirrorRingX({ startDeg: -90, arcEndDeg: null, arcDir: 1 }); const y = mirrorRingX(x)
      return norm(x.startDeg) === 270 && x.arcEndDeg === null && x.arcDir === -1 &&
             norm(y.startDeg) === 270 && y.arcDir === 1 })(),
    'start=-90° 等价于 270°')
  ok('左右镜像: 分段相位按 span mod 周期 修正 (span=270°, N=90 → 周期 4°, phase -2°)',
    (() => { const x = mirrorRingX({ startDeg: 0, arcEndDeg: 270, arcDir: 1, segOn: true, segCount: 90, segPhaseDeg: 0 })
      return near(x.segPhaseDeg, -2) })())
}

/* ============================================================
 * 3) 渲染 oracle (独立几何)
 * ============================================================ */
const baseCircle = { shape: 'circle', rOut: 70, rIn: 55, aa: 2, steps: 40, startDeg: -90, value: 26,
  trackColor: 0x6B4D, fillColor: 0x07FF, glintOn: false, autoGlint: false, autoArc: false,
  syncMcU: true, caps: true, depth: 0, tailU: 0, effect: 'static' }
const baseRect = { shape: 'rect', rad: 24, radIn: null, thick: 14, inset: 8, aa: 2, steps: 40,
  startDeg: -90, value: 26, trackColor: 0x6B4D, fillColor: 0x07FF, glintOn: false,
  autoGlint: false, autoArc: false, syncMcU: true, caps: true, depth: 0, tailU: 0, effect: 'static' }

function render(ring, w, h) {
  const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  const ctx = { createImageData: () => img, putImageData: () => {}, drawImage: () => {}, clearRect: () => {}, fillRect: () => {} }
  drawRing(ctx, { id: 'range', x: 0, y: 0, w: w, h: h, ring: ring })
  return img
}

/* 圆的独立判据: 环带内 → 相对起始角 rel; rel<=sweep=填充, rel<=span=轨道, 否则透明 */
function circleWant(x, y, ring, w, h, spanDeg) {
  const rOut = ring.rOut, rIn = ring.rIn, startDeg = ring.startDeg
  const dir = ring.arcDir < 0 ? -1 : 1
  const sweep = (spanDeg * ring.value) / ring.steps
  const cx = ring.syncMcU ? Math.floor((w - 1) / 2) : (w - 1) / 2
  const cy = cx
  const dx = x - cx, dy = y - cy
  const rad = Math.hypot(dx, dy)
  if (rad > rOut - 2.5 || rad < rIn + 2.5) return null   // 同步路径的 AA 表约 2px, 带边整圈跳过
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI
  const rel = norm360((ang - startDeg) * dir)
  const rMid = (rOut + rIn) / 2, capR = (rOut - rIn) / 2
  const angNear = (a, b) => { const d = Math.abs(norm360(a - b)); return d < 1.8 || d > 358.2 }
  if (angNear(rel, 0) || angNear(rel, spanDeg) || angNear(rel, sweep)) return null
  if (ring.caps) {
    for (const d of [startDeg, startDeg + dir * sweep, startDeg + dir * spanDeg]) {
      const px = rMid * Math.cos((d * Math.PI) / 180), py = rMid * Math.sin((d * Math.PI) / 180)
      if (Math.hypot(dx - px, dy - py) < capR + 2) return null
    }
  }
  if (rel <= spanDeg + 1e-9) return rel <= sweep + 1e-9 ? 'fill' : 'track'
  return 'transparent'
}

/* 圆角矩形的独立判据: 周长参数 t (0=顶边中点, 顺时针) 的占比; 端帽同样按中心线点算 */
function rectWant(x, y, ring, w, h, spanDeg) {
  const g = ringRectGeom(w, h, ring)
  const cx = ring.syncMcU ? Math.floor((w - 1) / 2) : (w - 1) / 2
  const cy = ring.syncMcU ? Math.floor((h - 1) / 2) : (h - 1) / 2
  const dx = x - cx, dy = y - cy
  const hit = ringRectBand(dx, dy, g)
  if (!hit || hit.cov < 0.999 || Math.abs(hit.d) > g.ht - 2.5) return null   // 带边 AA 跳过
  const dir = ring.arcDir < 0 ? -1 : 1
  const sweep = (spanDeg * ring.value) / ring.steps
  const t0 = norm1((ring.startDeg + 90) / 360)
  const rangeF = spanDeg / 360, sweepF = sweep / 360
  let rel = dir > 0 ? hit.t - t0 : t0 - hit.t
  rel = norm1(rel)
  if (circDiff(rel, 0) < 0.006 || circDiff(rel, rangeF) < 0.006 || circDiff(rel, sweepF) < 0.006) return null
  if (ring.caps) {
    for (const f of [t0, t0 + dir * sweepF, t0 + dir * rangeF]) {
      const p = ringRectPointAt(f, g.hx, g.hy, g.rc)
      if (Math.hypot(dx - p.x, dy - p.y) < g.ht + 2) return null
    }
  }
  if (rel <= rangeF + 1e-9) return rel <= sweepF + 1e-9 ? 'fill' : 'track'
  return 'transparent'
}

function runCase(shape, startDeg, spanDeg, dir, caps, frac, sync) {
  const base = shape === 'circle' ? baseCircle : baseRect
  const w = shape === 'circle' ? 160 : 160
  const h = shape === 'circle' ? 160 : 120
  const ring = Object.assign({}, base, { startDeg: startDeg, arcEndDeg: startDeg + dir * spanDeg,
    arcDir: dir, caps: caps, value: Math.round(base.steps * frac), syncMcU: sync })
  const img = render(ring, w, h)
  const wantAt = shape === 'circle' ? circleWant : rectWant
  let wrongFill = 0, wrongTrack = 0, wrongAlpha = 0, first = ''
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const want = wantAt(x, y, ring, w, h, spanDeg)
    if (!want) continue
    const i = (y * w + x) * 4
    const A = img.data[i + 3], B = img.data[i + 2]
    if (want === 'transparent') {
      if (A !== 0) { wrongAlpha++; if (!first) first = '(' + x + ',' + y + ') 范围外/端帽外应透明, 实际 a=' + A }
      continue
    }
    if (A < 250) { wrongAlpha++; if (!first) first = '(' + x + ',' + y + ') 应不透明, 实际 a=' + A; continue }
    const got = B > 200 ? 'fill' : (B < 160 ? 'track' : null)
    if (got === null) { wrongAlpha++; if (!first) first = '(' + x + ',' + y + ') 颜色不明确 B=' + B; continue }
    if (got !== want) {
      if (want === 'fill') wrongFill++; else wrongTrack++
      if (!first) first = '(' + x + ',' + y + ') 该' + (want === 'fill' ? '填充' : '轨道') + '色却' + (got === 'fill' ? '填充' : '轨道')
    }
  }
  return { wrongFill: wrongFill, wrongTrack: wrongTrack, wrongAlpha: wrongAlpha, first: first }
}

{
  const starts = [0, 90, 270]
  const spans = [90, 180, 270, 359]
  const fracs = [0, 0.25, 0.5, 1]
  let cases = 0, bad = 0, firstBad = ''
  for (const sync of [true, false])
    for (const shape of ['circle', 'rect'])
      for (const start of starts)
        for (const span of spans)
          for (const dir of [1, -1])
            for (const caps of [false, true])
              for (const frac of fracs) {
                const r = runCase(shape, start, span, dir, caps, frac, sync)
                cases++
                if (r.wrongFill + r.wrongTrack + r.wrongAlpha > 0) {
                  bad++
                  if (!firstBad) firstBad = (sync ? '同步 ' : '理想 ') + shape + ' 起' + start + '° 跨' + span + '° ' +
                    (dir > 0 ? '顺' : '逆') + '针 caps=' + (caps ? 1 : 0) + ' 进度' + Math.round(frac * 100) +
                    '% → 填充错' + r.wrongFill + ' 轨道错' + r.wrongTrack + ' 透明/alpha错' + r.wrongAlpha + '; ' + r.first
                }
              }
  ok(cases + ' 组部分弧逐像素对拍 (同步/理想 × 圆/圆角矩形 × 3 起始角 × 4 跨度 × 顺逆 × 端帽 × 4 进度): 范围内填充/轨道、范围外透明',
    bad === 0, bad ? (bad + ' 组不符; 例: ' + firstBad) : '全部一致')
}

/* ============================================================
 * 4) 范围两端轨道端帽: 部分弧 + 进度 0 时, 范围两端也必须有圆头
 * ============================================================ */
{
  const cx = Math.floor(159 / 2), cy = cx
  const sample = (img, deg, rMid) => {
    const x = cx + Math.round(rMid * Math.cos((deg * Math.PI) / 180))
    const y = cy + Math.round(rMid * Math.sin((deg * Math.PI) / 180))
    return img.data[(y * 160 + x) * 4 + 3]
  }
  const rMid = (baseCircle.rOut + baseCircle.rIn) / 2
  const mk = (caps) => render(Object.assign({}, baseCircle, { startDeg: 270, arcEndDeg: 0, arcDir: -1, value: 0, caps: caps }), 160, 160)
  const on = mk(true), off = mk(false)
  const sOn = sample(on, 274, rMid), sOff = sample(off, 274, rMid)
  const eOn = sample(on, 356, rMid), eOff = sample(off, 356, rMid)
  const farStart = sample(on, 290, rMid), farEnd = sample(on, 340, rMid)
  ok('圆环部分弧轨道端帽: caps 开 → 范围起点/终点外侧 4° 有轨道圆头, 再远 20° 透明',
    sOn > 50 && eOn > 50 && sOff === 0 && eOff === 0 && farStart === 0 && farEnd === 0,
    '起点 a=' + sOn + ' (caps关 ' + sOff + '), 终点 a=' + eOn + ' (caps关 ' + eOff + '), 远侧 ' + farStart + '/' + farEnd)

  const g = ringRectGeom(160, 120, baseRect)
  const per = 4 * ((g.hx - g.rc) + (g.hy - g.rc)) + 2 * Math.PI * g.rc
  const t0 = norm1((270 + 90) / 360)
  const rectAt = (img, t) => {
    const p = ringRectPointAt(t, g.hx, g.hy, g.rc)
    const x = 79 + Math.round(p.x), y = 59 + Math.round(p.y)
    return img.data[(y * 160 + x) * 4 + 3]
  }
  const mkR = (caps) => render(Object.assign({}, baseRect, { startDeg: 270, arcEndDeg: 0, arcDir: -1, value: 0, caps: caps }), 160, 120)
  const onR = mkR(true), offR = mkR(false)
  const delta = 2.5 / per
  const rStartOn = rectAt(onR, norm1(t0 + delta)), rStartOff = rectAt(offR, norm1(t0 + delta))
  const rEndOn = rectAt(onR, norm1(0.25 - delta)), rEndOff = rectAt(offR, norm1(0.25 - delta))
  const rFar = rectAt(onR, norm1(t0 + 0.04))
  ok('圆角矩形部分弧轨道端帽: caps 开 → 路径端点外侧有轨道圆头, caps 关/更远 → 透明',
    rStartOn > 50 && rEndOn > 50 && rStartOff === 0 && rEndOff === 0 && rFar === 0,
    '起点 a=' + rStartOn + ' (caps关 ' + rStartOff + '), 终点 a=' + rEndOn + ' (caps关 ' + rEndOff + '), 远侧 ' + rFar)

  /* 理想模式 (syncMcU=false): 没有 MCU 整型几何可用, 范围端帽不能因此消失。
   * 理想模式圆心是半像素 (w-1)/2, 采样时也按半像素算。 */
  const cxi = (160 - 1) / 2
  const sampleI = (img, deg) => {
    const x = Math.round(cxi + rMid * Math.cos((deg * Math.PI) / 180))
    const y = Math.round(cxi + rMid * Math.sin((deg * Math.PI) / 180))
    return img.data[(y * 160 + x) * 4 + 3]
  }
  const mkI = (caps) => render(Object.assign({}, baseCircle, {
    syncMcU: false, startDeg: 270, arcEndDeg: 0, arcDir: -1, value: 0, caps: caps }), 160, 160)
  const onI = mkI(true), offI = mkI(false)
  const sOnI = sampleI(onI, 274), sOffI = sampleI(offI, 274)
  const eOnI = sampleI(onI, 356), eOffI = sampleI(offI, 356)
  const farI = sampleI(onI, 310)
  ok('理想模式圆环部分弧轨道端帽: caps 开 → 范围两端外侧也有轨道圆头, caps 关/更远 → 透明',
    sOnI > 50 && eOnI > 50 && sOffI === 0 && eOffI === 0 && farI === 0,
    '起点 a=' + sOnI + ' (caps关 ' + sOffI + '), 终点 a=' + eOnI + ' (caps关 ' + eOffI + '), 远侧 ' + farI)

  const rectAtI = (img, t) => {
    const p = ringRectPointAt(t, g.hx, g.hy, g.rc)
    const x = Math.round(79.5 + p.x), y = Math.round(59.5 + p.y)
    return img.data[(y * 160 + x) * 4 + 3]
  }
  const mkRI = (caps) => render(Object.assign({}, baseRect, {
    syncMcU: false, startDeg: 270, arcEndDeg: 0, arcDir: -1, value: 0, caps: caps }), 160, 120)
  const onRI = mkRI(true), offRI = mkRI(false)
  const rStartOnI = rectAtI(onRI, norm1(t0 + delta)), rStartOffI = rectAtI(offRI, norm1(t0 + delta))
  const rEndOnI = rectAtI(onRI, norm1(0.25 - delta)), rEndOffI = rectAtI(offRI, norm1(0.25 - delta))
  const rFarI = rectAtI(onRI, norm1(t0 + 0.04))
  ok('理想模式圆角矩形部分弧轨道端帽: caps 开 → 路径端点外侧也有轨道圆头, caps 关/更远 → 透明',
    rStartOnI > 50 && rEndOnI > 50 && rStartOffI === 0 && rEndOffI === 0 && rFarI === 0,
    '起点 a=' + rStartOnI + ' (caps关 ' + rStartOffI + '), 终点 a=' + rEndOnI + ' (caps关 ' + rEndOffI + '), 远侧 ' + rFarI)
}


/* ============================================================
 * 4b) 倒计时圆帽: 范围外的半边不能混入轨道色 (否则看起来像半个帽)
 *     轨道红 + 填充青, 满档 + 拖尾; 起点帽圆盘里只允许出现填充色。
 * ============================================================ */
{
  const ring = Object.assign({}, baseCircle, {
    startDeg: 130, arcEndDeg: 50, arcDir: 1, value: 70, steps: 70,
    caps: true, tailU: 14, effect: 'countdown', trackColor: 0xF800, fillColor: 0x07FF,
  })
  const img = render(ring, 160, 160)
  const AG = ringArcGeom(Object.assign({}, ring, { rangeU: ringArcRange(ring).rangeU }))
  const px = 79 + AG.cStX / 2, py = 79 + AG.cStY / 2
  let red = 0, aa = 0, lit = 0
  for (let y = Math.floor(py - 10); y <= Math.ceil(py + 10); y++)
    for (let x = Math.floor(px - 10); x <= Math.ceil(px + 10); x++) {
      const i = (y * 160 + x) * 4, a = img.data[i + 3]
      if (a <= 10) continue
      lit++
      if (a > 30 && a < 235) aa++
      if (img.data[i] > 20) red++
    }
  ok('圆环倒计时起点帽: 范围外半边只有填充色, 不混轨道红 (不再出现半个帽)',
    lit > 0 && aa > 20 && red === 0,
    '帽内亮像素 ' + lit + ', 其中 AA 边缘 ' + aa + ', 混入轨道红的像素 ' + red)

  const rr = Object.assign({}, baseRect, {
    startDeg: 130, arcEndDeg: 50, arcDir: 1, value: 70, steps: 70,
    caps: true, tailU: 14, effect: 'countdown', trackColor: 0xF800, fillColor: 0x07FF,
  })
  const rimg = render(rr, 160, 120)
  const RG = ringRectArcGeom(ringRectGeomQ8(160, 120, rr), rr)
  const rpx = 79 + RG.c0x / 2, rpy = 59 + RG.c0y / 2
  let rred = 0, raa = 0, rlit = 0
  for (let y = Math.floor(rpy - 10); y <= Math.ceil(rpy + 10); y++)
    for (let x = Math.floor(rpx - 10); x <= Math.ceil(rpx + 10); x++) {
      const i = (y * 160 + x) * 4, a = rimg.data[i + 3]
      if (a <= 10) continue
      rlit++
      if (a > 30 && a < 235) raa++
      if (rimg.data[i] > 20) rred++
    }
  ok('圆角矩形倒计时起点帽: 范围外半边只有填充色, 不混轨道红 (同一口径)',
    rlit > 0 && raa > 20 && rred === 0,
    '帽内亮像素 ' + rlit + ', 其中 AA 边缘 ' + raa + ', 混入轨道红的像素 ' + rred)

  /* 4c) 满圈端帽: 帽盘 AA 边界必须仍然不透明 —— 帽是"填充层盖在轨道层上",
   *     帽边按权重混向轨道色; 若把帽边的 alpha 也降成权重, 它就会向页面底色(黑)
   *     淡出, 在轨道色上留下**一圈黑边** (DR1152 现场: 圆帽旁边有黑色区域).
   *     判据: 环带内部、帽盘 AA 环上的像素 alpha 必须 = 255. */
  {
    const ring = Object.assign({}, baseCircle, {
      startDeg: -90, arcEndDeg: null, arcDir: -1, value: 26, steps: 40,
      caps: true, trackColor: 0x6B4D, fillColor: 0xF81F, aa: 3, tailU: 0,
    })
    const img = render(ring, 160, 160)
    const AG = ringArcGeom(Object.assign({}, ring, { rangeU: ringArcRange(ring).rangeU }))
    const capRp = AG.capRI / 2                       /* 帽半径 (px) */
    const rIn = baseCircle.rIn, rOut = baseCircle.rOut
    const aa = ring.aa
    let n = 0, bad = 0, badMsg = ''
    for (const [ccx, ccy] of [[AG.cStX, AG.cStY], [AG.cEnX, AG.cEnY]]) {
      const cx0 = 79 + ccx / 2, cy0 = 79 + ccy / 2
      for (let k = 0; k < 96; k++) {
        const th = (k * Math.PI) / 48
        const x = Math.round(cx0 + Math.cos(th) * (capRp - 1))
        const y = Math.round(cy0 + Math.sin(th) * (capRp - 1))
        const rr = Math.hypot(x - 79, y - 79)
        if (rr < rIn + aa + 1 || rr > rOut - aa - 1) continue   /* 只取带内, 避开径向 AA */
        n++
        const a = img.data[(y * 160 + x) * 4 + 3]
        if (a !== 255) { bad++; if (!badMsg) badMsg = '(' + x + ',' + y + ') a=' + a }
      }
    }
    ok('圆环满圈端帽: 帽盘 AA 边在带内保持不透明 (不向黑底淡出/不留黑圈)',
      n > 20 && bad === 0, '采样 ' + n + ' 点, 半透明 ' + bad + (badMsg ? ' — ' + badMsg : ''))
  }
  {
    const ring = Object.assign({}, baseRect, {
      startDeg: -90, arcEndDeg: null, arcDir: -1, value: 26, steps: 40,
      caps: true, trackColor: 0x6B4D, fillColor: 0xF81F, aa: 3, tailU: 0,
    })
    const img = render(ring, 160, 120)
    const G = ringRectGeomQ8(160, 120, ring)
    const AG = ringRectArcGeom(G, Object.assign({}, ring, { rangeU: ringArcRange(ring).rangeU }))
    const capRp = AG.capR / 2
    let n = 0, bad = 0, badMsg = ''
    for (const [ccx, ccy] of [[AG.c0x, AG.c0y], [AG.c1x, AG.c1y]]) {
      const cx0 = 79 + ccx / 2, cy0 = 59 + ccy / 2
      for (let k = 0; k < 96; k++) {
        const th = (k * Math.PI) / 48
        const x = Math.round(cx0 + Math.cos(th) * (capRp - 1))
        const y = Math.round(cy0 + Math.sin(th) * (capRp - 1))
        if (ringRectCovSdf8((x - 79) * 256, (y - 59) * 256, G) !== 255) continue  /* 避开带边 AA */
        n++
        const a = img.data[(y * 160 + x) * 4 + 3]
        if (a !== 255) { bad++; if (!badMsg) badMsg = '(' + x + ',' + y + ') a=' + a }
      }
    }
    ok('圆角矩形满圈端帽: 帽盘 AA 边在带内保持不透明 (同一口径)',
      n > 20 && bad === 0, '采样 ' + n + ' 点, 半透明 ' + bad + (badMsg ? ' — ' + badMsg : ''))
  }

  /* 拖尾覆盖范围末端时, 轨道端帽必须一起擦掉: 否则渐隐的填充尾巴下面会露出
   * 另外半个轨道色圆头 (倒计时满档最明显) —— 用户报的「又出现另一半圆帽」。 */
  const rMid = (ring.rOut + ring.rIn) / 2
  let outLit = 0, outMsg = ''
  for (const dd of [2, 4]) {
    const a = ((410 + dd) * Math.PI) / 180
    const x = Math.round(79 + rMid * Math.cos(a))
    const y = Math.round(79 + rMid * Math.sin(a))
    const al = img.data[(y * 160 + x) * 4 + 3]
    if (al > 10) { outLit++; outMsg += '(' + x + ',' + y + ') a=' + al + ' ' }
  }
  ok('圆环倒计时末端帽: 拖尾覆盖时范围外不再露出轨道端帽',
    outLit === 0, outMsg || '末帽圆盘外侧 2°/4° 均透明')

  const G = ringRectGeomQ8(160, 120, rr)
  let routLit = 0, routMsg = ''
  for (const d of [512, 768]) {
    const p = ringRectPointAtQ8(RG.sRangeEnd + d, G)
    const x = Math.round(79 + p.x / 256)
    const y = Math.round(59 + p.y / 256)
    const al = rimg.data[(y * 160 + x) * 4 + 3]
    if (al > 10) { routLit++; routMsg += '(' + x + ',' + y + ') a=' + al + ' ' }
  }
  ok('圆角矩形倒计时末端帽: 拖尾覆盖时范围外不再露出轨道端帽',
    routLit === 0, routMsg || '末帽位置 2px/3px 外侧均透明')

  /* 收尾到帽区: 弧短于一个帽半径时不再画帽 (支撑比例把帽半径缩到 0),
   * 帽区只剩轨道底色 + 残弧, 不能出现实心圆帽点。
   * 0.5/70 时帽盘里不应有实心 fill; 帽心是轨道红 (残弧 AA 可能略混青),
   * 前沿前方/后方 4° 都是轨道红。 */
  const capStats = (img2, cx0, cy0, rad) => {
    const st = { n: 0, vis: 0, fill: 0, lit: 0, dark: 0, min: 255, max: 0, red: 0 }
    for (let y = Math.floor(cy0 - rad); y <= Math.ceil(cy0 + rad); y++)
      for (let x = Math.floor(cx0 - rad); x <= Math.ceil(cx0 + rad); x++) {
        if ((x - cx0) ** 2 + (y - cy0) ** 2 > rad * rad) continue
        const i = (y * 160 + x) * 4, a = img2.data[i + 3]
        st.n++
        if (a > 20) st.vis++
        if (a > 30 && img2.data[i] < 40 && img2.data[i + 1] > 150 && img2.data[i + 2] > 150) st.fill++
        if (a > 200) st.lit++
        if (a < 20) st.dark++
        if (a < st.min) st.min = a
        if (a > st.max) st.max = a
        if (a > 30 && img2.data[i] > 20) st.red++
      }
    return st
  }
  const nearRing = Object.assign({}, ring, { value: 0.5 })
  const nImg = render(nearRing, 160, 160)
  const nAG = ringArcGeom(Object.assign({}, nearRing, { rangeU: ringArcRange(nearRing).rangeU }))
  const ncx = 79 + nAG.cStX / 2, ncy = 79 + nAG.cStY / 2
  const nSt = capStats(nImg, ncx, ncy, nAG.capRI / 2 - 2.5)
  const rMidN = (nearRing.rOut + nearRing.rIn) / 2
  const atDeg = (deg) => {
    const x = Math.round(79 + rMidN * Math.cos((deg * Math.PI) / 180))
    const y = Math.round(79 + rMidN * Math.sin((deg * Math.PI) / 180))
    const i = (y * 160 + x) * 4
    return { r: nImg.data[i], g: nImg.data[i + 1], b: nImg.data[i + 2], a: nImg.data[i + 3] }
  }
  const nCenter = atDeg(130), nAhead = atDeg(134), nBehind = atDeg(126)
  ok('圆环倒计时收尾到帽区: 弧短于帽半径时不画帽, 帽区只剩轨道与残弧 (不是均匀圆帽点)',
    nSt.fill < 3 && nSt.n > 40 &&
    nCenter.a > 220 && nCenter.r > 150 && nCenter.g < 120 && nCenter.b < 120 &&
    nAhead.r > 180 && nAhead.g < 80 && nAhead.b < 80 &&
    nBehind.r > 180 && nBehind.g < 80 && nBehind.b < 80,
    '帽盘 ' + nSt.n + ' px, 实心 fill ' + nSt.fill + ', 非填充 ' + (nSt.n - nSt.fill) +
    ', alpha ' + nSt.min + '..' + nSt.max + ', 帽心 rgba=' + [nCenter.r, nCenter.g, nCenter.b, nCenter.a].join(',') +
    ', 前沿刚过 4° rgba=' + [nAhead.r, nAhead.g, nAhead.b, nAhead.a].join(',') +
    ', 后 4° rgba=' + [nBehind.r, nBehind.g, nBehind.b, nBehind.a].join(','))

  const nearRect = Object.assign({}, rr, { value: 0.5 })
  const nrImg = render(nearRect, 160, 120)
  const nrAG = ringRectArcGeom(ringRectGeomQ8(160, 120, nearRect), nearRect)
  const rcx = 79 + nrAG.c0x / 2, rcy = 59 + nrAG.c0y / 2
  const nrSt = capStats(nrImg, rcx, rcy, nrAG.capR / 2 - 2.5)
  const atTan = (s) => {
    const x = Math.round(rcx + s * nrAG.t0x), y = Math.round(rcy + s * nrAG.t0y)
    const i = (y * 160 + x) * 4
    return { r: nrImg.data[i], g: nrImg.data[i + 1], b: nrImg.data[i + 2], a: nrImg.data[i + 3] }
  }
  const nrF = atTan(5), nrB = atTan(-5)
  const rcC = atTan(0), rcA = rcC.a
  ok('圆角矩形倒计时收尾到帽区: 弧短于帽半径时不画帽 (同一口径)',
    nrSt.fill < 3 && nrSt.n > 30 &&
    rcA > 220 && rcC.r > 150 && rcC.g < 120 && rcC.b < 120 &&
    nrF.r > 180 && nrF.g < 80 && nrF.b < 80 &&
    nrB.r > 180 && nrB.g < 80 && nrB.b < 80,
    '帽盘 ' + nrSt.n + ' px, 实心 fill ' + nrSt.fill + ', 非填充 ' + (nrSt.n - nrSt.fill) +
    ', alpha ' + nrSt.min + '..' + nrSt.max + ', 帽心 rgba=' + [rcC.r, rcC.g, rcC.b, rcC.a].join(',') +
    ', 前沿 +5px rgba=' + [nrF.r, nrF.g, nrF.b, nrF.a].join(',') +
    ', 后 5px rgba=' + [nrB.r, nrB.g, nrB.b, nrB.a].join(','))

  /* 连续性: 倒计时从 0 到满档, 帽区可见面积必须单调长出来, 不能在 0 处突然跳半个帽 */
  const capVis = (cfg, val, isRect) => {
    const im = render(Object.assign({}, cfg, { value: val }), isRect ? 160 : 160, isRect ? 120 : 160)
    const g = isRect
      ? ringRectArcGeom(ringRectGeomQ8(160, 120, Object.assign({}, cfg, { value: val })), Object.assign({}, cfg, { value: val }))
      : ringArcGeom(Object.assign({}, cfg, { value: val, rangeU: ringArcRange(cfg).rangeU }))
    const cx = 79 + (isRect ? g.c0x : g.cStX) / 2
    const cy = (isRect ? 59 : 79) + (isRect ? g.c0y : g.cStY) / 2
    return capStats(im, cx, cy, (isRect ? g.capR : g.capRI) / 2 - 2.5).fill
  }
  const seqC = [0, 0.1, 0.5, 1, 2, 5, 70].map(v => capVis(ring, v, false))
  const seqR = [0, 0.1, 0.5, 1, 2, 5, 70].map(v => capVis(rr, v, true))
  const mono = (a) => a.every((v, i) => i === 0 || v >= a[i - 1])
  const noCapEarly = (a) => a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 0
  const grows = (a) => a[4] > 0 && a[4] < a[5] && a[5] === a[6]
  ok('倒计时帽区连续性: 0→满档可见面积单调增长, 短弧无帽, 长弧长回整帽',
    noCapEarly(seqC) && grows(seqC) && mono(seqC) &&
    noCapEarly(seqR) && grows(seqR) && mono(seqR),
    '圆环 ' + seqC.join('→') + '; 圆角矩形 ' + seqR.join('→'))
}

/* ============================================================
 * 5) 递减边缘: tailU 内填充色 → 轨道色线性过渡 (不是硬切)
 * ============================================================ */
{
  const span = 270, tailU = 60
  const ring = Object.assign({}, baseCircle, { startDeg: 180, arcEndDeg: 90, arcDir: 1, value: 40,
    caps: true, tailU: tailU, effect: 'static' })
  const img = render(ring, 160, 160)
  const cx = Math.floor(159 / 2), cy = cx, rMid = (ring.rOut + ring.rIn) / 2
  const atRel = (rel) => {
    const deg = 180 + rel
    const x = cx + Math.round(rMid * Math.cos((deg * Math.PI) / 180))
    const y = cy + Math.round(rMid * Math.sin((deg * Math.PI) / 180))
    const i = (y * 160 + x) * 4
    return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] }
  }
  const tailDeg = tailU * 0.5
  const p1 = atRel(span - tailDeg * 0.9), p2 = atRel(span - tailDeg * 0.5), p3 = atRel(span - tailDeg * 0.1)
  ok('圆环递减边缘: 拖尾起端≈填充色, 中段居中, 末端≈轨道色, 全程不透明',
    p1.a === 255 && p3.a === 255 && p1.b > 200 && p1.b > p2.b && p2.b > p3.b && p3.b < 140,
    'B: ' + p1.b + ' > ' + p2.b + ' > ' + p3.b + ' (填充 255 / 轨道 107; 拖尾 ' + tailDeg + '°)')

  /* 渐变 + 拖尾要叠加: 拖尾权重乘在「同一弧长位置」的渐变取色上,
   * 不是把渐变拍平后再混。填充 红→蓝, 轨道 绿→黄, 末端因此由蓝渐变到黄。 */
  const gradRing = Object.assign({}, ring, {
    fillGrad: [{ p: 0, c: 0xF800 }, { p: 100, c: 0x001F }],
    trackGrad: [{ p: 0, c: 0x07E0 }, { p: 100, c: 0xFFE0 }],
  })
  const gimg = render(gradRing, 160, 160)
  const atG = (rel) => {
    const deg = 180 + rel
    const x = cx + Math.round(rMid * Math.cos((deg * Math.PI) / 180))
    const y = cy + Math.round(rMid * Math.sin((deg * Math.PI) / 180))
    const i = (y * 160 + x) * 4
    return { r: gimg.data[i], g: gimg.data[i + 1], b: gimg.data[i + 2], a: gimg.data[i + 3] }
  }
  const gp1 = atG(span - tailDeg * 0.9), gp2 = atG(span - tailDeg * 0.5), gp3 = atG(span - tailDeg * 0.1)
  ok('渐变 + 递减边缘: 拖尾按同一弧长采样, 起端蓝、末端黄、中段双向混合',
    gp1.a === 255 && gp3.a === 255 &&
    gp1.b > 180 && gp1.g < 80 && gp3.g > 180 && gp3.b < 80 &&
    gp2.b > 50 && gp2.b < 210 && gp2.g > 50 && gp2.g < 210 &&
    gp1.b > gp2.b && gp2.b > gp3.b && gp1.g < gp2.g && gp2.g < gp3.g,
    'RGB: 起端 (' + gp1.r + ',' + gp1.g + ',' + gp1.b + ') / 中段 (' +
    gp2.r + ',' + gp2.g + ',' + gp2.b + ') / 末端 (' + gp3.r + ',' + gp3.g + ',' + gp3.b + ')')

  const g = ringRectGeom(160, 120, baseRect)
  const t0 = norm1((180 + 90) / 360)
  const rectImg = render(Object.assign({}, baseRect, { startDeg: 180, arcEndDeg: 90, arcDir: 1, value: 40,
    caps: true, tailU: tailU, effect: 'static' }), 160, 120)
  const atFrac = (f) => {
    const p = ringRectPointAt(norm1(t0 + 0.75 - tailU / 720 * f), g.hx, g.hy, g.rc)
    const x = 79 + Math.round(p.x), y = 59 + Math.round(p.y)
    const i = (y * 160 + x) * 4
    return { b: rectImg.data[i + 2], a: rectImg.data[i + 3] }
  }
  const q1 = atFrac(0.9), q2 = atFrac(0.5), q3 = atFrac(0.1)
  ok('圆角矩形递减边缘: 同一条线性拖尾 (路径长度口径)',
    q1.a === 255 && q3.a === 255 && q1.b > 200 && q1.b > q2.b && q2.b > q3.b && q3.b < 140,
    'B: ' + q1.b + ' > ' + q2.b + ' > ' + q3.b)
}

/* ============================================================
 * 6) 整圈回归: 不填 / null / 360° 必须逐像素一致 (老工程零变化)
 * ============================================================ */
{
  const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n }
  const imgA = render(Object.assign({}, baseCircle, { value: 26 }), 160, 160).data
  const imgB = render(Object.assign({}, baseCircle, { value: 26, arcEndDeg: null }), 160, 160).data
  const imgC = render(Object.assign({}, baseCircle, { value: 26, arcEndDeg: 270 }), 160, 160).data   // -90° → 270° = 整圈
  ok('整圈回归: 不填 arcEndDeg / null / 同角 270° 三种写法逐像素一致', diff(imgA, imgB) === 0 && diff(imgA, imgC) === 0,
    '差异 ' + diff(imgA, imgB) + ' / ' + diff(imgA, imgC) + ' 字节')
}


/* ============================================================
 * 7) 颜色渐变: 停靠点归一化 / 采样 / 多停靠点 / 无渐变回归
 * ============================================================ */
{
  const gs = ringGradStops([{ p: 80, c: 0x001F }, { p: 20, c: 0xF800 }])
  const goodNorm = gs && gs.length === 4 &&
    gs[0].p === 0 && gs[0].c === 0xF800 &&
    gs[1].p === 20 && gs[1].c === 0xF800 &&
    gs[2].p === 80 && gs[2].c === 0x001F &&
    gs[3].p === 100 && gs[3].c === 0x001F
  ok('ringGradStops: 排序 + 缺 0/100 端点用最近点颜色补齐', goodNorm,
    gs ? gs.map(s => s.p + '%=' + s.c.toString(16)).join(' ') : 'null')

  const clamped = ringGradStops([{ p: -5, c: 0x07E0 }, { p: 120, c: 0xFFE0 }])
  ok('ringGradStops: p 夹到 0..100, 非法 p/c 跳过',
    clamped && clamped.length === 2 && clamped[0].p === 0 && clamped[1].p === 100 &&
    (ringGradStops([]) === null) && (ringGradStops(null) === null) &&
    (ringGradStops([null, { p: 'x', c: 1 }, { p: 10, c: 'bad' }]) === null))

  const g2 = ringGradStops([{ p: 0, c: 0xF800 }, { p: 100, c: 0x001F }])
  const mid = ringGradRgb(g2, 0.5)
  ok('ringGradRgb: 0% 红 → 100% 蓝, 中点为 (127.5,0,127.5)',
    near(mid.r, 127.5, 1) && near(mid.g, 0, 1) && near(mid.b, 127.5, 1),
    JSON.stringify(mid))
  const lo = ringGradRgb(g2, -1), hi = ringGradRgb(g2, 2)
  ok('ringGradRgb: t 夹到 0..1, 端外取端点色',
    lo.r === 255 && lo.b === 0 && hi.r === 0 && hi.b === 255)

  const cm = ringGrad565(g2, 0.5)
  ok('ringGrad565: 中点 RGB565 = 0x8010 (mix565 整数插值)', cm === 0x8010,
    '0x' + cm.toString(16))
  ok('ringGrad565: 两端精确等于停靠点色',
    ringGrad565(g2, 0) === 0xF800 && ringGrad565(g2, 1) === 0x001F)

  const g3 = ringGradStops([{ p: 0, c: 0xF800 }, { p: 50, c: 0x07E0 }, { p: 100, c: 0x001F }])
  const q1 = ringGradRgb(g3, 0.25), q2 = ringGradRgb(g3, 0.5), q3 = ringGradRgb(g3, 0.75)
  ok('多停靠点: 0/50/100 三点在 25%/50%/75% 处按相邻段插值',
    near(q1.r, 127.5, 1) && near(q1.g, 127.5, 1) && near(q1.b, 0, 1) &&
    q2.r === 0 && q2.g === 255 && q2.b === 0 &&
    near(q3.r, 0, 1) && near(q3.g, 127.5, 1) && near(q3.b, 127.5, 1),
    JSON.stringify([q1, q2, q3]))
}

/* 像素采样: 只取环带中线上、离端帽足够远的点 */
function sampleRing(img, ring, w, h, relDeg, startDeg) {
  const cx = ring.syncMcU ? Math.floor((w - 1) / 2) : (w - 1) / 2
  const cy = ring.syncMcU ? Math.floor((h - 1) / 2) : (h - 1) / 2
  const rMid = (ring.rIn + ring.rOut) / 2
  const a = ((startDeg + relDeg) * Math.PI) / 180
  const x = Math.max(0, Math.min(w - 1, Math.round(cx + rMid * Math.cos(a))))
  const y = Math.max(0, Math.min(h - 1, Math.round(cy + rMid * Math.sin(a))))
  const i = (y * w + x) * 4
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] }
}

function gradientPixelChecks(sync) {
  const ring = Object.assign({}, baseCircle, {
    syncMcU: sync, startDeg: 0, arcEndDeg: 270, arcDir: 1, value: 20, caps: true,
    fillGrad: [{ p: 0, c: 0xF800 }, { p: 100, c: 0x001F }],
    trackGrad: [{ p: 0, c: 0x07E0 }, { p: 100, c: 0xFFE0 }],
  })
  const img = render(ring, 160, 160)
  const f1 = sampleRing(img, ring, 160, 160, 20, 0)
  const f2 = sampleRing(img, ring, 160, 160, 100, 0)
  const t1 = sampleRing(img, ring, 160, 160, 170, 0)
  const t2 = sampleRing(img, ring, 160, 160, 245, 0)
  const fillOK = f1.a === 255 && f2.a === 255 && f1.r > 200 && f1.b < 60 &&
    f2.r < 190 && f2.b > 80 && f1.r > f2.r && f1.b < f2.b
  const trackOK = t1.a === 255 && t2.a === 255 && t1.g > 220 && t2.g > 220 &&
    t1.r < 190 && t2.r > t1.r
  return { ring, img, f1, f2, t1, t2, ok: fillOK && trackOK }
}

{
  for (const sync of [true, false]) {
    const r = gradientPixelChecks(sync)
    ok('渐变渲染 (' + (sync ? '同步' : '理想') + '): 填充沿弧 红→蓝, 轨道沿弧 绿→黄, 全程不透明',
      r.ok, '填充 ' + JSON.stringify(r.f1) + ' → ' + JSON.stringify(r.f2) +
      ', 轨道 ' + JSON.stringify(r.t1) + ' → ' + JSON.stringify(r.t2))
  }


/* 圆角矩形渐变: 沿周长采样 (独立 t 参数), 检查起点色、填充/轨道各自沿弧插值 */
function rectGradAt(img, ring, w, h, f) {
  const g = ringRectGeom(w, h, ring)
  const cx = ring.syncMcU ? Math.floor((w - 1) / 2) : (w - 1) / 2
  const cy = ring.syncMcU ? Math.floor((h - 1) / 2) : (h - 1) / 2
  const dir = ring.arcDir < 0 ? -1 : 1
  const spanF = ringArcRange(ring).spanDeg / 360
  const t0 = norm1((ring.startDeg + 90) / 360)
  const p = ringRectPointAt(norm1(t0 + dir * f * spanF), g.hx, g.hy, g.rc)
  let best = null
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const x = Math.max(0, Math.min(w - 1, Math.round(cx + p.x) + ox))
    const y = Math.max(0, Math.min(h - 1, Math.round(cy + p.y) + oy))
    const i = (y * w + x) * 4
    const px = { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] }
    if (!best || px.a > best.a) best = px
  }
  return best
}
function rectGradientChecks(start, dir) {
  const ring = Object.assign({}, baseRect, {
    startDeg: start, arcEndDeg: start + dir * 270, arcDir: dir, value: 20, caps: true, syncMcU: true,
    fillGrad: [{ p: 0, c: 0xF800 }, { p: 100, c: 0x001F }],
    trackGrad: [{ p: 0, c: 0x07E0 }, { p: 100, c: 0xFFE0 }],
  })
  const img = render(ring, 160, 120)
  return [0.08, 0.35, 0.65, 0.92].map(f => rectGradAt(img, ring, 160, 120, f))
}
{
  for (const [start, dir] of [[0, 1], [270, -1]]) {
    const s = rectGradientChecks(start, dir)
    const [f1, f2, t1, t2] = s
    const good = f1.a === 255 && f1.r > 210 && f1.b < 50 &&
      f2.a === 255 && f2.r < 220 && f2.b > 60 && f1.r > f2.r && f1.b < f2.b &&
      t1.a === 255 && t2.a === 255 && t1.g > 220 && t2.g > 220 &&
      t1.r < 200 && t2.r > 210 && t2.r > t1.r
    ok('圆角矩形渐变 (' + start + '° ' + (dir > 0 ? '顺' : '逆') + '): 起点红, 填充红→蓝, 轨道绿→黄',
      good, '填充 ' + JSON.stringify(f1) + ' → ' + JSON.stringify(f2) +
      ', 轨道 ' + JSON.stringify(t1) + ' → ' + JSON.stringify(t2))
  }
}

  /* 同一颜色两点渐变必须逐像素等于平色 (老工程/导出路径零变化) */
  const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n }
  for (const sync of [true, false]) {
    const flat = Object.assign({}, baseCircle, { syncMcU: sync, value: 26 })
    const dup = Object.assign({}, flat, {
      fillGrad: [{ p: 0, c: flat.fillColor }, { p: 100, c: flat.fillColor }],
      trackGrad: [{ p: 0, c: flat.trackColor }, { p: 100, c: flat.trackColor }],
    })
    const n = diff(render(flat, 160, 160).data, render(dup, 160, 160).data)
    ok('渐变回归 (' + (sync ? '同步' : '理想') + '): 首尾同色的渐变与平色逐像素一致', n === 0, '差异 ' + n + ' 字节')
  }
}

await server.close()
console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过')
process.exit(fails ? 1 : 0)
