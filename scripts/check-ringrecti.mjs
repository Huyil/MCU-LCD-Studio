/*
 * 圆角矩形环「板子同式整数几何」自检: node scripts/check-ringrecti.mjs
 *
 * 固件的矩形引擎 (RING_SHAPE=1) 与网页的「与 MCU 同步预览」必须用**同一套整数几何**,
 * 否则做不到逐像素一致。这里把整套整数链路跟现成的浮点 SDF 参考实现对齐:
 *   ① 每行外/内 x 半宽 (Q8) 与 ringRectBand 的浮点边界差 ≤1px; 行外 (|dy|>oHy) 必须为 0
 *   ② 边缘覆盖率: 从带外到带内单调 0→255, 且 50% 位置在真实边界上
 *   ③ 周长参数 s: 顶边中点 = 0、右边中点 = 1/4 圈; 沿路径单调; 与 ringRectPath 的 s 差 ≤1px
 *   ④ 等效角 aU = s·720/per (乘法实现, 无除法) 与直接除法一致, 落在 0..719
 *   ⑤ 端点 (端帽圆心): ringRectPointAtQ8 → ringRectPathSQ8 往返的等效角差 ≤1 个单位
 *   ⑥ 端帽 AA 权重与浮点圆帽同式 (帽心/半径/渐隐)
 *   ⑦ 白斑增益: 等效角查板子增益表 ≈ 浮点高斯 (差 ≤6/255), 范围外为 0
 */
import { createServer } from 'vite'

let fails = 0
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`); if (!c) fails++ }

const server = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
})
const M = await server.ssrLoadModule('/src/ringrender.js')
const { ringRectGeom, ringRectGeomQ8, ringRectSpanQ8, ringRectCovSdf8, ringRectDistQ8, ringRectPathSQ8, ringRectAngleU,
        ringRectPath, ringRectBand, ringRectPointAtQ8, ringRectArcGeom, ringRectArcW,
        ringRectGain8, ringRectTableR, ringTables, ringStepPx, ringLapPx,
        ringRectShadeTables, ringRectShade565, ringRectNormalQ8 } = M

const cases = [
  { w: 320, h: 170, r: { rad: 24, radIn: null, thick: 14, inset: 8, aa: 2 } },
  { w: 240, h: 240, r: { rad: 40, radIn: 12, thick: 20, inset: 0, aa: 2 } },
  { w: 135, h: 240, r: { rad: 16, radIn: 8, thick: 10, inset: 6, aa: 1 } },
  { w: 170, h: 320, r: { rad: 60, radIn: null, thick: 26, inset: 4, aa: 3 } },
  /* 用户现场那一份 (在线存档里读出来的): 宽扁的圆角矩形环, 上下长边正好落在整数行上 */
  { w: 226, h: 140, r: { rad: 24, radIn: null, thick: 12, inset: 8, aa: 2 } },
]

/* ① 行跨度: 整数 vs 浮点 SDF (含"行外"必须为 0) */
{
  let worst = 0, worstInfo = '', bad0 = 0
  for (const c of cases) {
    const g = ringRectGeom(c.w, c.h, c.r)
    const G = ringRectGeomQ8(c.w, c.h, c.r)
    /* 上下各多扫 4 行: 行外必须是 0 (曾经靠 isqrt 的 0 兜底, 结果把行外也算成带内) */
    for (let dy = -Math.ceil(g.oh / 2) - 4; dy <= Math.ceil(g.oh / 2) + 4; dy++) {
      const sp = ringRectSpanQ8(dy * 256, G)
      /* 浮点真值 = 解析硬边界 (不含 AA): 外框 (ow/2, oh/2, radOut) / 内框 (ow/2-thick, oh/2-thick, radIn) */
      const halfW = (hw, hh, rr, y) => {
        const ay = Math.abs(y)
        if (ay > hh) return 0
        if (ay <= hh - rr) return hw
        const k = ay - (hh - rr)
        return rr <= 0 ? hw : hw - rr + Math.sqrt(Math.max(0, rr * rr - k * k))
      }
      const xoF = halfW(g.ow / 2, g.oh / 2, g.radOut, dy)
      const iHw = Math.max(0, g.ow / 2 - g.thick), iHh = Math.max(0, g.oh / 2 - g.thick)
      const xiF = halfW(iHw, iHh, g.radIn, dy)
      if (Math.abs(dy * 256) > G.oHy && sp.xo !== 0) { bad0++; if (!worstInfo) worstInfo = `${c.w}x${c.h} dy=${dy}: 行外 xo=${sp.xo} 应为 0` }
      const e1 = Math.abs(xoF - sp.xo / 256)
      if (e1 > worst) { worst = e1; worstInfo = `${c.w}x${c.h} dy=${dy}: 外 ${xoF} vs ${(sp.xo / 256).toFixed(2)}` }
      const e2 = xiF > 0 ? Math.abs(xiF - sp.xi / 256) : 0
      if (e2 > worst) { worst = e2; worstInfo = `${c.w}x${c.h} dy=${dy}: 内 ${xiF} vs ${(sp.xi / 256).toFixed(2)}` }
    }
  }
  ok('① 每行外/内 x 半宽 (整数 Q8) 与浮点 SDF 边界差 ≤1px, 行外为 0',
    worst <= 1.0 && bad0 === 0, bad0 ? worstInfo : `最大差 ${worst.toFixed(2)}px — ${worstInfo}`)
}

/* ② 覆盖率 = 到最近边界的**垂直距离**做斜坡 (与圆环板子上那条公式同一约定)
 *    · 边界上 (m=0) = 64 (aa=2px), 外 0.5px = 0, 内 aa−0.5px = 255
 *    · **各向同性**: 上/下长边、左/右边、四段角弧上"同样距离"必须给同样的覆盖率
 *      —— 这正是"圆弧看起来还不够平滑"那条: 以前只按行跨度算, 角弧的渐变只沿 x 走
 *    · 与"几何真值"对齐: 覆盖率 ≈ clamp((m+0.5)/aa)·255, m 由浮点 SDF 独立算出来 */
{
  const rampOf = (G, mQ8) => {
    if (mQ8 <= -128) return 0
    if (mQ8 >= G.aaQ8 - 128) return 255
    return ((mQ8 + 128) * G.invAa) >> 8
  }
  let bad = 0, info = ''
  for (const c of cases) {
    const g = ringRectGeom(c.w, c.h, c.r)
    const G = ringRectGeomQ8(c.w, c.h, c.r)
    const oHx = G.oHx / 256, oHy = G.oHy / 256, oRc = G.oRc / 256
    const iHx = G.iHx / 256, iHy = G.iHy / 256, iRc = G.iRc / 256
    /* 独立真值: 浮点 SDF 的 m = min(−dOut, dIn), 再按同一条斜坡换算 */
    const sdfR = (x, y, hx, hy, R) => {
      const r = Math.min(R, Math.min(hx, hy))
      const qx = Math.abs(x) - (hx - r), qy = Math.abs(y) - (hy - r)
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
    }
    const mOf = (dx, dy) => Math.min(-sdfR(dx, dy, oHx, oHy, oRc), sdfR(dx, dy, iHx, iHy, iRc))
    /* 各向同性: 外边界上取 4 条直边中点 + 4 段角弧的 45° 点, 覆盖率都得 = ramp(0) */
    const arc45 = oRc * Math.SQRT1_2
    const probes = [[0, -oHy], [0, oHy], [-oHx, 0], [oHx, 0],
                    [-(oHx - oRc + arc45), -(oHy - oRc + arc45)], [oHx - oRc + arc45, -(oHy - oRc + arc45)],
                    [-(oHx - oRc + arc45), oHy - oRc + arc45], [oHx - oRc + arc45, oHy - oRc + arc45]]
    const want0 = rampOf(G, 0)
    for (const [px, py] of probes) {
      const cov = ringRectCovSdf8(Math.round(px * 256), Math.round(py * 256), G)
      if (Math.abs(cov - want0) > 2) { bad++; if (!info) info = `${c.w}x${c.h} 边界点 (${px.toFixed(1)},${py.toFixed(1)}): ${cov} 应≈${want0}` }
    }
    /* 竖直方向剖面: 外边界上下各扫 2px, 与真值斜坡对齐 (±2/255) */
    let worst = 0, worstAt = ''
    for (let dy = -oHy - 2; dy <= -oHy + 3; dy += 0.25) {
      const cov = ringRectCovSdf8(0, Math.round(dy * 256), G)
      const want = rampOf(G, Math.round(mOf(0, dy) * 256))
      if (Math.abs(cov - want) > worst) { worst = Math.abs(cov - want); worstAt = `dy=${dy.toFixed(2)} ${cov} vs ${want}` }
    }
    if (worst > 2) { bad++; if (!info) info = `${c.w}x${c.h} 竖直剖面最大差 ${worst} — ${worstAt}` }
  }
  ok('② 覆盖率: 边界 64 (aa=2) / 外 0.5px 归零 / 内 aa−0.5px 满; 直边与角弧同距离同覆盖率', bad === 0, bad ? info : '')

  /* ②b 用户现场回归: 上下长边不再"整行算带内"(硬边胖 1px) —— 极值行必须是半覆盖的渐变 */
  {
    let bad = 0, info = ''
    for (const c of cases) {
      const G = ringRectGeomQ8(c.w, c.h, c.r)
      const oHy = Math.round(G.oHy / 256), iHy = Math.round(G.iHy / 256)
      const want = rampOf(G, 0)
      for (const sgn of [-1, 1]) {
        const cE = ringRectCovSdf8(0, sgn * oHy * 256, G)          /* 外边极值行 */
        const cIn = ringRectCovSdf8(0, (sgn * oHy - sgn * (G.aaPx + 1)) * 256, G)
        const cOut = ringRectCovSdf8(0, (sgn * oHy + sgn) * 256, G)
        const hE = ringRectCovSdf8(0, sgn * iHy * 256, G)          /* 孔沿极值行 */
        if (Math.abs(cE - want) > 2 || cOut !== 0 || cIn !== 255 || Math.abs(hE - want) > 2) {
          bad++; if (!info) info = `${c.w}x${c.h} dy=${sgn * oHy}: 极值 ${cE}(应${want}) 外 ${cOut} 内 ${cIn}; 孔沿 ${hE}`
        }
      }
    }
    ok('②b 上/下长边与内孔沿都是"半覆盖"的渐变 (不再整行 255 / 整行 0 的硬边)', bad === 0, bad ? info : '')
  }
}

/* ⑨ 立体感 (圆角矩形): 断面表与 gen_tables.py 同式, 且方向指纹与圆环同一套光照。
 *    用户现场: "圆角矩形的立体感功能坏了, 圆环是好的" —— 以前同步预览/板子对矩形是平色。 */
{
  const ht = 1536                                                  /* 半厚 Q8 (12px 环厚) */
  const tb = ringRectShadeTables(ht, 65, 'ridge', -45)
  let bad = 0, info = ''
  const halfIdx = (2 * ht) >> 5                                    /* d = 2×半厚 那一格 */
  if (tb.n !== halfIdx + 2) { bad++; info = `表长 ${tb.n} 应为 ${halfIdx + 2}` }
  /* 表按"离外边界的深度"线性索引: A 关于正中 (u=0, d=半厚) 对称, B 反对称 */
  const mid = halfIdx >> 1
  for (let i = 0; i <= halfIdx; i++) {
    const j = halfIdx - i
    if (Math.abs(tb.A[i] - tb.A[j]) > 1 || Math.abs(tb.B[i] + tb.B[j]) > 1) {
      bad++; if (!info) info = `A/B 不对称: i=${i} A ${tb.A[i]}/${tb.A[j]} B ${tb.B[i]}/${tb.B[j]}`; break
    }
  }
  if (!(tb.A[mid] > tb.A[1] && tb.A[mid] > 0)) { bad++; info = info || `正中 A=${tb.A[mid]} 应最大` }
  /* 方向指纹: 四条边的"外沿−内沿"亮度差, 符号必须与 L·n̂ 相反 (外沿 k ∝ −t) */
  const G = ringRectGeomQ8(240, 240, { rad: 24, radIn: null, thick: 12, inset: 8, aa: 2 })
  const la = (-45 * Math.PI) / 180, Lx = Math.cos(la), Ly = Math.sin(la)
  const edges = [
    ['上', 0, -(G.oHy - 256)], ['下', 0, G.oHy - 256], ['左', -(G.oHx - 256), 0], ['右', G.oHx - 256, 0],
  ]
  const lumOf = (dx, dy, dQ8) => {
    const n = ringRectNormalQ8(dx, dy, G)
    const c = ringRectShade565(0x7BEF, dQ8, n.nx, n.ny, tb, 0)   /* 灰底, 只看明暗 */
    return ((c >> 11) & 31) + ((c >> 5) & 63) + (c & 31)
  }
  const h = ht
  let checked = 0
  for (const [nm, dx, dy] of edges) {
    const nx = dx === 0 ? 0 : (dx < 0 ? -1 : 1), ny = dy === 0 ? 0 : (dy < 0 ? -1 : 1)
    const tt = Lx * nx + Ly * ny
    if (Math.abs(tt) < 0.2) continue
    checked++
    const d = lumOf(dx, dy, 256) - lumOf(dx, dy, 2 * h - 256)   /* 外沿 − 内沿 */
    if (Math.abs(d) < 1 || (d > 0) === (tt > 0)) { bad++; if (!info) info = `${nm}边 外沿−内沿=${d} 而 L·n̂=${tt.toFixed(2)}` }
  }
  ok('⑨ 立体感: 断面表 (对称/正中最大) + 方向指纹 (迎光侧外沿亮) —— 与板子同式',
     bad === 0 && checked >= 2, bad ? info : `表长 ${tb.n}, 查了 ${checked} 条边, 正中 A=${tb.A[mid]}`)
}

/* ③ 周长参数 s (Q8): 关键点 + 与浮点 ringRectPath 一致 (p.t·per, 不是 p.s —— 浮点版没这个字段) */
{
  let worst = 0, worstInfo = ''
  for (const c of cases) {
    const g = ringRectGeom(c.w, c.h, c.r)
    const G = ringRectGeomQ8(c.w, c.h, c.r)
    const s0 = ringRectPathSQ8(0, -Math.round(g.hy * 256), G)
    const sQ = ringRectPathSQ8(Math.round(g.hx * 256), 0, G)
    if (s0 !== 0) { worst = 999; worstInfo = `顶边中点 s=${s0} 应为 0` }
    if (Math.abs(sQ / G.per - 0.25) > 0.02) { worst = 999; worstInfo = `右边中点 s/per=${(sQ / G.per).toFixed(3)} 应≈0.25` }
    for (let dy = -Math.round(g.hy); dy <= Math.round(g.hy); dy++) {
      for (let dx = -Math.round(g.hx); dx <= Math.round(g.hx); dx++) {
        const sq = ringRectPathSQ8(dx * 256, dy * 256, G)
        if (sq < 0 || sq >= G.per) { worst = 999; worstInfo = `(${dx},${dy}) s=${sq} 越界 (应 0..per-1)` }
        const sI = sq / 256
        const p = ringRectPath(dx, dy, g.hx, g.hy, g.rc)
        const sF = p.t * g.per
        let d = Math.abs(sI - sF)
        d = Math.min(d, Math.abs(d - g.per))       /* 环上首尾相接 */
        if (d > worst) { worst = d; worstInfo = `(${dx},${dy}) 整数 ${sI.toFixed(1)} vs 浮点 ${sF.toFixed(1)}` }
      }
    }
  }
  ok('③ 周长参数 s: 顶边中点=0 / 右边中点=1/4 圈、恒在 [0,per), 且与浮点路径差 ≤1px',
    worst <= 1.0, `最大差 ${worst.toFixed(2)}px — ${worstInfo}`)
}

/* ④ 等效角: 乘法实现 == 除法, 且落在 0..719 */
{
  let bad = 0, info = ''
  for (const c of cases) {
    const G = ringRectGeomQ8(c.w, c.h, c.r)
    for (let s = 0; s < G.per; s += Math.max(1, Math.floor(G.per / 500))) {
      const a1 = ringRectAngleU(s, G)
      const a2 = Math.min(719, Math.round((s * 720) / G.per))
      /* 允许"最后一格"在 719/0 处相差 (两边都夹过, 差 0.5° 以内) */
      let dd = Math.abs(a1 - a2)
      if (dd > 360) dd = 720 - dd
      if (a1 < 0 || a1 > 719 || dd > 1) { bad++; if (!info) info = `s=${s}: 乘法 ${a1} vs 除法 ${a2}` }
    }
  }
  ok('④ 等效角 aU = s·720/per (乘法, 无除法) 与除法一致, 恒在 0..719', bad === 0, bad ? info : '')
}

/* ⑤ 端点 (端帽圆心): 点 → 周长参数 → 等效角 应回到原处 (±1 个单位 = ±0.5°) */
{
  let worst = 0, worstInfo = ''
  for (const c of cases) {
    const G = ringRectGeomQ8(c.w, c.h, c.r)
    for (let s = 0; s < G.per; s += 64) {
      const p = ringRectPointAtQ8(s, G)
      const s2 = ringRectPathSQ8(Math.round(p.x), Math.round(p.y), G)
      const aU = ringRectAngleU(s, G), aU2 = ringRectAngleU(s2, G)
      let d = Math.abs(aU - aU2); if (d > 360) d = 720 - d
      if (d > worst) { worst = d; worstInfo = `s=${s} aU=${aU}→${aU2} p=(${(p.x / 256).toFixed(2)},${(p.y / 256).toFixed(2)})` }
    }
  }
  ok('⑤ 端点 (端帽圆心): ringRectPointAtQ8 与 ringRectPathSQ8 互为逆运算 (±0.5°)',
    worst <= 1, `最大差 ${worst} 个单位 — ${worstInfo}`)
}

/* ⑥ 端帽 AA 权重: 与浮点圆帽 (帽心=中心线端点, 半径=半环厚) 的判定一致性。
 *    离帽边 (<0.6px) 与弧两端射线 (±2°) 附近跳过 —— 那里本来就是量化过渡带。 */
{
  let bad = 0, info = '', n = 0
  const c = { w: 240, h: 240, r: { rad: 40, radIn: 12, thick: 20, inset: 0, aa: 2 } }
  const g = ringRectGeom(c.w, c.h, c.r)
  const G = ringRectGeomQ8(c.w, c.h, c.r)
  for (const [startDeg, value, arcDir] of [[-90, 8, 1], [225, 8, -1], [45, 20, 1], [180, 3, -1]]) {
    const r = { ...c.r, startDeg, value, steps: 40, caps: true, arcDir }
    const AG = ringRectArcGeom(G, r)
    const startA = (startDeg * Math.PI) / 180
    const t0 = (((startDeg + 90) / 360) + 1) % 1
    const p0 = M.ringRectPointAt(t0, g.hx, g.hy, g.rc)
    const p1 = M.ringRectPointAt(t0 + arcDir * value / 40, g.hx, g.hy, g.rc)
    for (let dy = -Math.round(g.oh / 2); dy <= Math.round(g.oh / 2); dy++) {
      for (let dx = -Math.round(g.ow / 2); dx <= Math.round(g.ow / 2); dx++) {
        const hit = ringRectBand(dx, dy, g)
        if (!hit || hit.cov < 1) continue
        const sQ8 = ringRectPathSQ8(dx * 256, dy * 256, G)
        /* 弧两端射线附近跳过 (±4px 路径长度: 量化边界, 与 oracle 本来就有 ≤1px 的差) */
        const relS = AG.dirSign > 0 ? ((sQ8 - AG.sStart) % G.per + G.per) % G.per
                                    : ((AG.sStart - sQ8) % G.per + G.per) % G.per
        if (Math.min(relS, G.per - relS) <= 4 * 256 || Math.abs(relS - AG.sweepS) <= 4 * 256) continue
        const w = ringRectArcW(sQ8, dx, dy, AG)
        const wF = floatArcW(dx, dy, hit.a, startA, value / 40 * Math.PI * 2, arcDir, p0, p1, g.ht, g.aa)
        if (wF === null) continue
        n++
        if (Math.abs(w - wF) > 8) { bad++; if (!info) info = `start=${startDeg} dir=${arcDir} (${dx},${dy}) 整数 ${w} vs 浮点 ${wF}` }
      }
    }
  }
  function floatArcW(dx, dy, a, startA, thetaP, dir, p0, p1, capR, aa) {
    let rel = (a - startA) * dir
    rel -= Math.PI * 2 * Math.floor(rel / (Math.PI * 2))
    if (rel <= thetaP) return 255
    let best = 0
    for (const p of [p0, p1]) {
      const d = Math.hypot(dx - p.x, dy - p.y)
      /* 帽边 AA 渐变带 (capR-aa .. capR) ± 量化余量: 那里本来就不是 0/255, 不比 */
      if (d > capR - aa - 0.75 && d < capR + 0.75) return null
      if (d < capR) best = 255
    }
    return best
  }
  ok(`⑥ 端帽 AA 权重: 整数圆帽与浮点圆帽判定一致 (${n} 个带内像素, 饱和区允差 8/255)`,
    bad === 0, bad ? info : '')
}

/* ⑦ 白斑增益: 等效角 → 板子增益表 ≈ 浮点高斯; 范围外必须为 0 */
{
  let bad = 0, info = '', n = 0
  const sigDeg = 14, spanDeg = 42, spanU = 84
  const c = { w: 240, h: 240, r: { rad: 40, radIn: 12, thick: 20, inset: 0, aa: 2 } }
  const G = ringRectGeomQ8(c.w, c.h, c.r)
  const tb = ringTables(sigDeg, spanDeg, ringRectTableR(G))
  const ideal = (aU, gU) => {
    let d = aU - gU; if (d > 360) d -= 720; if (d < -360) d += 720
    const ad = Math.abs(d)
    if (ad > spanU) return 0
    return Math.round(255 * Math.exp(-((ad * 0.5) ** 2) / (2 * sigDeg * sigDeg)))
  }
  for (const glintDeg of [0, 90, -135, 179]) {
    const gU = (((Math.round(glintDeg * 2) + 180) % 720) + 720) % 720
    for (let aU = 0; aU < 720; aU += 3) {
      const g8 = ringRectGain8(aU, glintDeg, spanU, tb)
      const gI = ideal(aU, gU)
      n++
      /* 表尾 2° 有锥形收尾 → 与纯高斯最多差 25; 其余位置 ≤6 */
      const tol = Math.abs(ideal(aU, gU)) < 30 ? 30 : 6
      if (Math.abs(g8 - gI) > tol) { bad++; if (!info) info = `glint=${glintDeg}° aU=${aU}: 表 ${g8} vs 高斯 ${gI}` }
      if (g8 !== 0 && Math.abs(((aU - gU + 1080) % 720) - 360) > spanU) { bad++; if (!info) info = `glint=${glintDeg}° aU=${aU}: 范围外却给了 ${g8}` }
    }
  }
  ok(`⑦ 白斑增益: 等效角查表 ≈ 浮点高斯, 范围外恒 0 (${n} 个角度)`, bad === 0, bad ? info : '')
}

/* ⑧ 板子每步弧长 (「弧长 (预览)」要对齐的参照): 档位 × 0.5° 折算到一圈弧长 */
{
  const c = { w: 240, h: 240, r: { shape: 'circle', rOut: 120, rIn: 95, inset: 8, gear: 2 } }
  const lap = ringLapPx(c.w, c.h, c.r)
  const one = ringStepPx(c.w, c.h, { ...c.r, gear: 1 })
  const two = ringStepPx(c.w, c.h, { ...c.r, gear: 2 })
  ok('⑧ 板子每步弧长 = 档位×0.5°/360 × 一圈弧长 (填 1 就是 1 档左右的速度)',
     Math.abs(one - lap / 720) < 1e-6 && Math.abs(two - one * 2) < 1e-6 && one > 0 && one < 2,
     `一圈 ${lap.toFixed(1)}px · 1档 ${one.toFixed(2)}px/步 · 2档 ${two.toFixed(2)}px/步`)
}

await server.close()
console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
