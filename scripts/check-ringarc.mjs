/*
 * 圆环弧段渲染自检: node scripts/check-ringarc.mjs
 *
 * 为什么要有 (用户现场): 「递增方向 = 逆时针」+ 起始角写成 225° 时, 预览在起始角前面
 * 多填了一整块楔形 —— 看着像"圆帽画反了"。根因是相对角只做了 `while (rel < 0) rel += 2π`
 * 归一化: 起始角是度直接转弧度的 (225° = 3.93rad, 而 atan2 给的角度在 (-π, π]),
 * 逆时针再乘 -1 就得到 +395° 这种 > 2π 的值, while 拦不住, 紧接着那句"2π 回绕成 0"
 * 把它当成弧内 → 误填。
 *
 * 这里用**独立几何 oracle**逐像素对拍 (不复用 drawRing 里的判据):
 *   · 环带内 (圆: 半径区间; 圆角矩形: ringRectBand 命中)
 *   · 弧内: ((像素角 - 起始角) × 方向) mod 2π ∈ [0, 张角]
 *   · 弧外但落在两端圆帽圆内 (caps 开时)
 * 只比"明确填充"和"明确未填充"的像素 (跳开 AA 边界的半像素), 任何方向/起始角组合都不许错。
 */
import fs from 'node:fs'
import { createServer } from 'vite'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}

/* ---- 浏览器桩: drawRing 只用 createImageData / putImageData / drawImage ---- */
globalThis.document = {
  createElement() {
    return {
      width: 0, height: 0,
      getContext: () => ({
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {}, drawImage() {}, clearRect() {}, fillRect() {}, fillText() {},
      }),
    }
  },
}

const server = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
})
const { drawRing, ringRectBand, ringRectGeom, ringRectPointAt } = await server.ssrLoadModule('/src/ringrender.js')
const TWO_PI = Math.PI * 2

function render(ring, w, h) {
  const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  drawRing({ createImageData: () => img, putImageData() {}, drawImage() {}, clearRect() {}, fillRect() {} },
    { id: 'arc', x: 0, y: 0, w, h, ring })
  return img
}

/* 独立 oracle: 返回该像素"应该"是填充色还是轨道色 (null = 环带外/AA 边界, 不比) */
function expectFill(x, y, ring, w, h) {
  /* 圆心取整规则要跟 drawRing 一致 —— 圆和圆角矩形的「与 MCU 同步」都走整数路径,
   * 圆心 = floor((w-1)/2) (与导出/固件同); 只有关掉同步的理想渲染才用真正中点 (w-1)/2 */
  const mcu = ring.syncMcU !== false
  const cx = mcu ? Math.floor((w - 1) / 2) : (w - 1) / 2
  const cy = mcu ? Math.floor((h - 1) / 2) : (h - 1) / 2
  const dx = x - cx, dy = y - cy
  const startA = ((ring.startDeg ?? -90) * Math.PI) / 180
  const dir = (ring.arcDir ?? 1) < 0 ? -1 : 1
  const thetaP = (ring.value / ring.steps) * TWO_PI
  const capsOn = !!ring.caps && thetaP > 1e-9 && thetaP < TWO_PI - 1e-9
  let a, capR, st, en
  if (ring.shape === 'rect') {
    const g = ringRectGeom(w, h, ring)
    const hit = ringRectBand(dx, dy, g)
    if (!hit) return null
    a = hit.a; capR = g.ht
    const t0 = (((ring.startDeg ?? -90) + 90) / 360 + 1) % 1
    const p0 = ringRectPointAt(t0, g.hx, g.hy, g.rc)
    const p1 = ringRectPointAt(t0 + dir * ring.value / ring.steps, g.hx, g.hy, g.rc)
    st = p0; en = p1
  } else {
    const { rOut, rIn } = ring
    const r = Math.hypot(dx, dy)
    if (r > rOut - 0.6 || r < rIn + 0.6) return null       // 径向 AA 边界跳过
    a = Math.atan2(dy, dx); capR = (rOut - rIn) / 2
    const rMid = (rOut + rIn) / 2
    st = { x: rMid * Math.cos(startA), y: rMid * Math.sin(startA) }
    en = { x: rMid * Math.cos(startA + dir * thetaP), y: rMid * Math.sin(startA + dir * thetaP) }
  }
  let rel = (a - startA) * dir
  rel -= TWO_PI * Math.floor(rel / TWO_PI)
  /* 边界半像素跳过: 弧两端的射线、端帽圆周边一圈都是 AA 混合区 (颜色介于轨道/填充之间),
   * 与 oracle 的"整数判据"本来就会有 ≤1px 的差 —— 那里不比, 只比明确的内部/外部。
   * 起始边界要从两侧都跳过: rel 贴着 2π 就是"在起始射线前一点点"(量化后会算成弧内)。 */
  const pxRad = 1 / Math.max(4, ring.shape === 'rect' ? 8 : (ring.rOut + ring.rIn) / 2)
  const dStart = Math.min(rel, TWO_PI - rel)
  if (dStart < 1.5 * pxRad || Math.abs(rel - thetaP) < 1.5 * pxRad) return null
  if (rel <= thetaP) return true                            // 弧内
  if (capsOn) {
    const ds = Math.hypot(dx - st.x, dy - st.y), de = Math.hypot(dx - en.x, dy - en.y)
    if (Math.abs(ds - capR) < 2 || Math.abs(de - capR) < 2) return null   // 端帽边缘 AA 带
    if (ds < capR || de < capR) return true                 // 端帽内
  }
  return false
}

function compare(ring, w, h) {
  const img = render(ring, w, h)
  let wrongFill = 0, wrongTrack = 0, first = ''
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    const A = img.data[i + 3], B = img.data[i + 2]
    if (A < 250) continue                                   // 只看全不透明 (覆盖 = 1)
    const got = B > 200 ? true : (B < 160 ? false : null)    // 填 = 0x07FF (B=255), 轨道 = 0x6B4D (B=107)
    if (got === null) continue
    const want = expectFill(x, y, ring, w, h)
    if (want === null) continue
    if (got && !want) { wrongFill++; if (!first) first = `(${x},${y}) 该轨道色却填了` }
    if (!got && want) { wrongTrack++; if (!first) first = `(${x},${y}) 该填却没填` }
  }
  return { wrongFill, wrongTrack, first }
}

const baseCircle = { shape: 'circle', rOut: 70, rIn: 55, aa: 2, steps: 40, startDeg: -90, value: 26,
  trackColor: 0x6B4D, fillColor: 0x07FF, glintOn: false, syncMcU: true, caps: true, depth: 0 }
const baseRect = { shape: 'rect', rad: 24, radIn: null, thick: 14, inset: 8, aa: 2, steps: 40,
  startDeg: -90, value: 26, trackColor: 0x6B4D, fillColor: 0x07FF, glintOn: false, syncMcU: true, caps: true, depth: 0 }

let cases = 0, bad = 0, worst = null
for (const [name, base, w, h] of [['圆', baseCircle, 160, 160], ['圆角矩形', baseRect, 160, 120]]) {
  for (const arcDir of [1, -1]) for (const caps of [false, true]) {
    for (const startDeg of [-90, -45, 0, 90, 135, 180, 225, 270]) {
      for (const value of [1, 5, 13, 26, 39]) {
        const ring = { ...base, arcDir, caps, startDeg, value }
        const r = compare(ring, w, h)
        cases++
        if (r.wrongFill + r.wrongTrack > 0) {
          bad++
          if (!worst) worst = `${name} dir=${arcDir > 0 ? 'CW' : 'CCW'} caps=${caps ? 1 : 0} start=${startDeg}° 值=${value}/40 → 多填 ${r.wrongFill}, 漏填 ${r.wrongTrack} ${r.first}`
        }
      }
    }
  }
}
ok(`${cases} 种组合 (圆/圆角矩形 × 顺逆时针 × 8 个起始角 × 5 个档位值 × 端帽开关): 弧段范围逐像素与几何 oracle 一致`,
  bad === 0, bad ? `${bad} 种不符; 例: ${worst}` : '全部一致')

/* 用户现场那一条单列出来 (回归点名) */
{
  const ring = { ...baseCircle, arcDir: -1, caps: true, startDeg: 225, value: 1 }
  const r = compare(ring, 160, 160)
  ok('点名回归: 逆时针 + 起始角 225° + 圆端帽 (曾经在起始角前多填一块楔形)',
    r.wrongFill + r.wrongTrack === 0, r.wrongFill + r.wrongTrack ? `${r.wrongFill} 多填 / ${r.wrongTrack} 漏填 — ${r.first}` : '')
}
{
  const ring = { ...baseRect, arcDir: -1, caps: true, startDeg: 225, value: 8 }
  const r = compare(ring, 160, 120)
  ok('点名回归: 圆角矩形 + 逆时针 (以前根本没按方向反向)',
    r.wrongFill + r.wrongTrack === 0, r.wrongFill + r.wrongTrack ? `${r.wrongFill} 多填 / ${r.wrongTrack} 漏填 — ${r.first}` : '')
}

/* 白斑: 「与 MCU 同步」(默认开) 也必须跟着**动画相位**转 —— 以前同步分支读的是静态
 * glintDeg, 于是主预览里光斑一动不动 (只有关掉同步才动)。这里用亮像素的重心角验证。 */
{
  const M2 = await server.ssrLoadModule('/src/ringrender.js')
  const ring = { ...baseCircle, glintOn: true, glintDeg: 0, glintSigma: 8, glintSpanDeg: 24,
                 value: 40, caps: false }
  const brightCentroid = (deg) => {
    M2.setRingAnimAngle('arc', deg)
    const img = render({ ...ring, autoGlint: true }, 160, 160)
    const cx = Math.floor(159 / 2), cy = cx          /* 160 屏: 同步路径圆心 floor((160-1)/2)=79 */
    let sx = 0, sy = 0, n = 0
    for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
      const i = (y * 160 + x) * 4
      if (img.data[i + 3] < 250) continue
      const sum = img.data[i] + img.data[i + 1] + img.data[i + 2]
      if (sum > 560) { sx += x - cx; sy += y - cy; n++ }     /* 白斑提亮后接近白 */
    }
    if (!n) return null
    let a = Math.atan2(sy / n, sx / n) * 180 / Math.PI
    return { a: ((a % 360) + 360) % 360, n }
  }
  const a0 = brightCentroid(0), a90 = brightCentroid(90)
  const near = (v, want) => v != null && Math.min(Math.abs(v - want), 360 - Math.abs(v - want)) < 12
  ok('同步预览的白斑跟着动画相位走 (0° 在正右)', near(a0 && a0.a, 0), a0 ? `重心 ${a0.a.toFixed(1)}° (${a0.n} 像素)` : '没找到亮斑')
  ok('同步预览的白斑跟着动画相位走 (90° 在正下)', near(a90 && a90.a, 90), a90 ? `重心 ${a90.a.toFixed(1)}° (${a90.n} 像素)` : '没找到亮斑')
  M2.dropRingAnim('arc')
}

/* 预览动效两个开关各自独立 (用户要求把「自动动画」拆成 自动动画 + 光斑动画):
 *   autoArc   进度值 0→档位 扫        autoGlint  白斑沿路径转
 * 关掉「光斑动画」必须**立刻回到设计角** glintDeg (不能停在上次动画那一格) */
{
  const M3 = await server.ssrLoadModule('/src/ringrender.js')
  const base = { ...baseCircle, glintOn: true, glintDeg: 0, glintSigma: 14, glintSpanDeg: 42, value: 10, steps: 40 }
  const px = (ring) => render(ring, 160, 160).data
  const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n }
  /* render() 内部固定用 id 'arc' → 动画相位也挂在 'arc' 上 */
  M3.setRingAnimAngle('arc', 90)
  M3.setRingAnimValue('arc', 30)
  const off = px({ ...base, autoGlint: false, autoArc: false })
  const glintOnly = px({ ...base, autoGlint: true, autoArc: false })
  const arcOnly = px({ ...base, autoGlint: false, autoArc: true })
  const both = px({ ...base, autoGlint: true, autoArc: true })
  ok('动效开关: 只开「光斑动画」→ 白斑转 (画面变), 进度仍是设计值',
     diff(glintOnly, off) > 0)
  ok('动效开关: 只开「自动动画」→ 进度扫 (画面变), 白斑不动', diff(arcOnly, off) > 0)
  ok('动效开关: 两个都开 = 两个效果叠加 (各自独立, 不互相抵消)', diff(both, off) > diff(glintOnly, off))
  ok('动效开关: 关掉「光斑动画」立刻回到设计角 (不留上次动画相位)',
     diff(px({ ...base, autoGlint: false, autoArc: false }), off) === 0)
  M3.dropRingAnim('arc')
}

await server.close()
console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
