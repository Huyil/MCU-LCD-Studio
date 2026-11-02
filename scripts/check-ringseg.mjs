/*
 * 圆环「分割 (角向遮罩)」自检: node scripts/check-ringseg.mjs
 *
 * 需求: 参考图是把环带按角度切成 N 段 (≈90 段 / 4° 节距 / 1° 缝), 缝径向贯穿。
 * 实现: ringSegGeom() 归一参数 + ringSegMaskDeg() 覆盖率; drawRing() 在颜色/白斑/
 *       立体感之后按遮罩把颜色压暗 (只有暗槽; 槽深 100% = 压到黑 = 原「切断」)。
 *
 * 这里验证:
 *   1) 参数夹取 (段数/缝宽/AA/开关);
 *   2) 遮罩波形: 段/缝比例、50% 缝宽 = gap、相位、负角回绕;
 *   3) 渲染: 圆环同步/理想、圆角矩形同步三路, 段内亮、缝里黑, alpha 始终不透明;
 *   4) 暗槽: 槽深 0/60/100 的颜色, 100% = 黑 (= 旧 cut 的兼容口径);
 *   5) 端帽不参与分割 (帽心在缝里也必须实心);
 *   6) 关闭分割与老工程逐像素一致。
 */
import { drawRing, ringSegGeom, ringSegMaskDeg, ringArcEndAA, ringArcGeom,
         ringRectGeom, ringRectPointAt } from '../src/ringrender.js'

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''))
  if (!cond) fails++
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps
const mod = (a, p) => ((a % p) + p) % p

/* ---- 浏览器桩: drawRing 只需要 createImageData/putImageData/drawImage/clearRect ---- */
globalThis.document = {
  createElement() {
    return {
      width: 0, height: 0,
      getContext: () => ({
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {}, drawImage: () => {}, clearRect: () => {}, fillRect: () => {},
      }),
    }
  },
}
function render(ring, w, h) {
  const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  const ctx = { createImageData: () => img, putImageData: () => {}, drawImage: () => {}, clearRect: () => {}, fillRect: () => {} }
  drawRing(ctx, { id: 'seg', x: 0, y: 0, w, h, ring })
  return img
}

/* ============================================================
 * 1) 参数夹取
 * ============================================================ */
{
  ok('segOn 关 → null (老工程零行为变化)', ringSegGeom({}) === null && ringSegGeom({ segOn: false }) === null)
  const g = ringSegGeom({ segOn: true })
  ok('默认值: 90 段 / 4° 节距 / 1° 缝 / 相位 0 / groove (暗槽) / AA 2px',
    g && g.N === 90 && near(g.P, 4) && near(g.gap, 1) && g.phase === 0 && g.mode === 'groove' && near(g.aaPx, 2) && near(g.depth, 0.6),
    g ? JSON.stringify(g) : 'null')
  const lo = ringSegGeom({ segOn: true, segCount: 1, segGapDeg: 0, segAA: 0 })
  const hi = ringSegGeom({ segOn: true, segCount: 999, segGapDeg: 999, segAA: 9 })
  ok('夹取: N=1→2, N=999→180; gap≥0.1 且 ≤P (100%=全暗); AA 0..4 (0 = 硬边)',
    lo.N === 2 && lo.gap >= 0.1 && hi.N === 180 && near(hi.gap, 2) && near(hi.body, 0) && near(hi.aaPx, 4) && near(lo.aaPx, 0),
    'lo ' + JSON.stringify(lo) + ' hi ' + JSON.stringify(hi))
  ok('模式选项已取消: 一律暗槽; 旧 segMode=cut 按 100% 槽深兼容',
    ringSegGeom({ segOn: true, segMode: 'cut' }).mode === 'groove' &&
    near(ringSegGeom({ segOn: true, segMode: 'cut' }).depth, 1) &&
    ringSegGeom({ segOn: true, segMode: 'xxx' }).mode === 'groove' && ringSegGeom({ segOn: true }).mode === 'groove')
  ok('槽深: 0..100 夹取, 默认 60% (即缝里剩 40% 亮度)',
    ringSegGeom({ segOn: true, segDepth: 0 }).depth === 0 &&
    near(ringSegGeom({ segOn: true, segDepth: 150 }).depth, 1) &&
    ringSegGeom({ segOn: true, segDepth: -5 }).depth === 0 &&
    near(ringSegGeom({ segOn: true }).depth, 0.6))
}

/* ============================================================
 * 2) 遮罩波形 (纯函数)
 * ============================================================ */
{
  const P = 4, gap = 1, aa = 0.5
  const at = (u) => ringSegMaskDeg(u, P, gap, aa)
  ok('缝边 50%: u=0 → 0.5, 缝中心 0, 段内 1 (边界本身半覆盖)',
    near(at(0), 0.5) && near(at(1), 1) && near(at(2), 1) && near(at(3), 0.5) && near(at(3.5), 0) && near(at(2.75), 1),
    [0, 1, 2, 3, 3.5, 2.75].map(u => u + '→' + at(u).toFixed(3)).join(' '))
  /* 过渡带跨边界对称: 距边界同样远的两侧, 覆盖率相加 = 1 (0.5±k) */
  ok('缝边 AA 跨边界对称: 两侧等距的覆盖率互补 (段内 0.75 / 缝内 0.25), 半宽处到 0/1',
    near(at(3 - 0.125), 0.75) && near(at(3 + 0.125), 0.25) &&
    near(at(3 - 0.25), 1) && near(at(3 + 0.25), 0) &&
    near(at(0 - 0.125), 0.25) && near(at(0 + 0.125), 0.75),
    '3±0.125→' + at(3 - 0.125).toFixed(3) + '/' + at(3 + 0.125).toFixed(3))
  ok('AA=0 = 硬边: 段内 1 / 缝内 0 / 边界 0.5',
    at(1) === 1 && ringSegMaskDeg(1, P, gap, 0) === 1 &&
    ringSegMaskDeg(3.2, P, gap, 0) === 0 && ringSegMaskDeg(3, P, gap, 0) === 0.5)
  ok('负角/超过一圈回绕: -3 ≡ 1 → 1, 8 ≡ 0 → 0.5, 9 ≡ 1 → 1',
    near(at(-3), 1) && near(at(8), 0.5) && near(at(9), 1) && near(at(400), 0.5))
  /* 在 0..360 上均匀采样: <0.5 的总角度 = 90 个 1° 缝 = 90° (边上的 0.5 不算) */
  let dark = 0, runs = 0, prev = false
  const N = 36000
  for (let i = 0; i < N; i++) {
    const u = (i / N) * 360
    const m = ringSegMaskDeg(u, P, gap, 0.25)
    if (m < 0.5) dark += 360 / N
    if (m >= 0.5 && !prev) runs++
    prev = m >= 0.5
  }
  ok('90 段 × 1° 缝: 暗区总角宽 ≈ 90°, 亮段数 = 90',
    near(dark, 90, 1.0) && runs === 90, '暗区 ' + dark.toFixed(3) + '°, 亮段 ' + runs)
  ok('gap 被夹到 0.9P 时仍留一条亮段', ringSegMaskDeg(0, 4, 3.6, 0.5) === 0.5 &&
    ringSegMaskDeg(1.8, 4, 3.6, 0.5) === 0 && ringSegMaskDeg(0.1, 4, 3.6, 0.5) > 0.5)
}

/* ============================================================
 * 3) 渲染: 旧 cut 数据 → 100% 槽深 (段内亮、缝里黑、alpha 始终不透明)
 * ============================================================ */
const baseCircle = {
  shape: 'circle', rOut: 70, rIn: 54, aa: 1.5, steps: 40, value: 40, startDeg: 0,
  trackColor: 0x0000, fillColor: 0x07FF, glintOn: false, autoGlint: false, autoArc: false,
  syncMcU: true, caps: false, depth: 0, tailU: 0, effect: 'static', arcEndDeg: null,
  segOn: true, segCount: 90, segGapDeg: 1, segPhaseDeg: 0, segMode: 'cut', segAA: 0.2,
}
function sampleAt(img, ring, w, h, deg, r) {
  const cx = ring.syncMcU ? Math.floor((w - 1) / 2) : (w - 1) / 2
  const cy = ring.syncMcU ? Math.floor((h - 1) / 2) : (h - 1) / 2
  const a = (deg * Math.PI) / 180
  const x = Math.round(cx + r * Math.cos(a)), y = Math.round(cy + r * Math.sin(a))
  const i = (y * w + x) * 4
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3], x, y }
}
{
  const rMid = (baseCircle.rOut + baseCircle.rIn) / 2
  for (const sync of [true, false]) {
    const ring = { ...baseCircle, syncMcU: sync }
    const img = render(ring, 160, 160)
    const bar = sampleAt(img, ring, 160, 160, 1.5, rMid)   // 段内
    const gap = sampleAt(img, ring, 160, 160, 3.5, rMid)   // 缝内
    const edge = sampleAt(img, ring, 160, 160, 0, rMid)    // 段首边缘 (50%)
    ok('槽深 100% / 旧 cut (' + (sync ? '同步' : '理想') + '): 段内亮、缝里黑、alpha 不透明',
      bar.a >= 250 && bar.b > 200 && gap.a >= 250 && gap.b <= 8 &&
      (!sync || (edge.b > 20 && edge.b < 235)),
      'bar a/b=' + bar.a + '/' + bar.b + ' / gap a/b=' + gap.a + '/' + gap.b + ' / edge b=' + edge.b)
    /* 整条环带里同时存在亮段与黑缝 (不是整圈全亮/全黑) */
    let full = 0, dark = 0
    for (let deg = 0; deg < 360; deg += 1) {
      const s = sampleAt(img, ring, 160, 160, deg, rMid)
      if (s.a >= 250 && s.b > 200) full++
      else if (s.a >= 250 && s.b < 24) dark++
    }
    ok('槽深 100% / 旧 cut (' + (sync ? '同步' : '理想') + '): 圆周采样同时有亮段与黑缝 (90 段量级)',
      full > 170 && dark > 40 && full + dark > 260,
      '亮 ' + full + ' / 黑 ' + dark + ' / 共 360')
    /* 缝边必须是渐变 (中间亮度), 不是 0/255 硬切 */
    let aaCount = 0
    for (let deg = 0; deg < 360; deg += 0.25) {
      const s = sampleAt(img, ring, 160, 160, deg, rMid)
      if (s.a >= 250 && s.b > 8 && s.b < 200) aaCount++
    }
    ok('槽深 100% / 旧 cut (' + (sync ? '同步' : '理想') + '): 缝边有中间亮度 (角向 AA, 不是硬切)',
      aaCount > 20, '中间亮度采样 ' + aaCount)
  }
}

/* ============================================================
 * 4) 渲染: 暗槽 (alpha 保留, 颜色压暗)
 * ============================================================ */
{
  const rMid = (baseCircle.rOut + baseCircle.rIn) / 2
  for (const sync of [true, false]) {
    const ring = { ...baseCircle, syncMcU: sync, segMode: 'groove' }
    const img = render(ring, 160, 160)
    const bar = sampleAt(img, ring, 160, 160, 1.5, rMid)
    const gap = sampleAt(img, ring, 160, 160, 3.5, rMid)
    ok('圆环暗槽 (' + (sync ? '同步' : '理想') + '): 缝里 alpha 仍不透明, 亮度压到 ~40%',
      gap.a > 200 && gap.b > 0 && bar.b > 0 && gap.b < bar.b * 0.45,
      'bar a/b=' + bar.a + '/' + bar.b + ', gap a/b=' + gap.a + '/' + gap.b)
  }
}

/* 槽深 0 = 不压暗, 100 = 压到黑 (alpha 保持) */
{
  const rMid = (baseCircle.rOut + baseCircle.rIn) / 2
  const mk = (depth) => render({ ...baseCircle, segMode: 'groove', segDepth: depth }, 160, 160)
  const flat = mk(0), black = mk(100)
  const g0 = sampleAt(flat, baseCircle, 160, 160, 3.5, rMid)
  const b0 = sampleAt(flat, baseCircle, 160, 160, 1.5, rMid)
  const g100 = sampleAt(black, baseCircle, 160, 160, 3.5, rMid)
  const b100 = sampleAt(black, baseCircle, 160, 160, 1.5, rMid)
  ok('暗槽槽深: 0% → 缝里颜色 = 段内颜色; 100% → 缝里压到黑, alpha 不变',
    g0.a > 200 && g0.b === b0.b && g100.a > 200 && g100.b <= 8 && b100.b > 0,
    'depth0 gap/bar B=' + g0.b + '/' + b0.b + ', depth100 gap B=' + g100.b + ' (a=' + g100.a + ')')
}

/* 4b) 角向 AA 宽度是**运行期参数**: 同一条缝, AA 越大, 缝边的中间亮度像素越多。
 *     用宽缝 (20 段 / 8° 缝) + 100% 槽深把过渡带完整铺在像素网格上,
 *     避免 240px 上 1° 缝的采样抖动。 */
{
  const rMid = (baseCircle.rOut + baseCircle.rIn) / 2
  const ringA = (aa) => ({ ...baseCircle, segCount: 20, segGapDeg: 8, segAA: aa, segMode: 'groove', segDepth: 100 })
  const midCount = (ring) => {
    const img = render(ring, 160, 160)
    let n = 0
    for (let deg = 0; deg < 360; deg += 0.05) {
      const s = sampleAt(img, ring, 160, 160, deg, rMid)
      if (s.a >= 250 && s.b > 8 && s.b < 200) n++
    }
    return n
  }
  const c0 = midCount(ringA(0)), c08 = midCount(ringA(0.8)), c20 = midCount(ringA(2))
  ok('抗锯齿 AA 宽度: 0px(硬边) < 0.8px < 2.0px 的中间亮度采样数单调增加',
    c0 < c08 && c08 < c20 && c0 > 0,
    'AA 0 → ' + c0 + ' / 0.8 → ' + c08 + ' / 2.0 → ' + c20 + ' 个中间亮度采样')
  /* 过渡带跨边界对称: 在缝边两侧等距取点, 覆盖率互补 (亮度和 ≈ 255) */
  const ring = ringA(2)
  const img = render(ring, 160, 160)
  const rMid2 = rMid
  const dDeg = (0.5 / rMid2) * 180 / Math.PI     // 0.5px 对应的角宽
  const edgeDeg = 10                               // P=18, gap=8 → body 末端在 10°
  const inside = sampleAt(img, ring, 160, 160, edgeDeg - dDeg, rMid2).b
  const outside = sampleAt(img, ring, 160, 160, edgeDeg + dDeg, rMid2).b
  ok('抗锯齿 AA 跨边界对称: 缝边两侧 0.5px 处亮度互补 (和 ≈ 255)',
    Math.abs(inside + outside - 255) < 90, '内侧 ' + inside + ' + 外侧 ' + outside + ' = ' + (inside + outside))
}

/* ============================================================
 * 5) 端帽不参与分割: 帽心落在缝里也必须实心
 * ============================================================ */
{
  const rMid = (baseCircle.rOut + baseCircle.rIn) / 2
  const ring = { ...baseCircle, startDeg: 3.5, arcEndDeg: 183.5, value: 40, caps: true, segMode: 'cut' }
  const img = render(ring, 160, 160)
  const AG = ringArcGeom({ ...ring, rangeU: 360 })
  const cx = Math.floor(159 / 2), cy = cx
  const x = cx + AG.cStX / 2, y = cy + AG.cStY / 2
  const i = (Math.round(y) * 160 + Math.round(x)) * 4
  const a = img.data[i + 3]
  ok('分割不切端帽: 起点帽心在 3.5° (缝里), 帽盘仍实心',
    a > 200, '帽心 (' + Math.round(x) + ',' + Math.round(y) + ') a=' + a)
}

/* ============================================================
 * 6) 圆角矩形 (同步): 沿周长 s 的缝同样有效
 * ============================================================ */
{
  const ring = {
    shape: 'rect', rad: 24, radIn: null, thick: 14, inset: 8, aa: 1.5, steps: 40, value: 40,
    startDeg: -90, arcEndDeg: null, trackColor: 0x0000, fillColor: 0x07FF,
    glintOn: false, autoGlint: false, autoArc: false, syncMcU: true, caps: false,
    depth: 0, tailU: 0, effect: 'static',
    segOn: true, segCount: 90, segGapDeg: 1, segPhaseDeg: 0, segMode: 'cut', segAA: 0.2,
  }
  const g = ringRectGeom(160, 120, ring)
  const cx = Math.floor(159 / 2), cy = Math.floor(119 / 2)
  /* 同一张图里采样, 不要每次重画 */
  const img = render(ring, 160, 120)
  const at = (deg) => {
    const p = ringRectPointAt(mod(deg / 360, 1), g.hx, g.hy, g.rc)
    const x = Math.round(cx + p.x), y = Math.round(cy + p.y)
    const i = (y * 160 + x) * 4
    return { a: img.data[i + 3], b: img.data[i + 2], x, y }
  }
  const bar = at(1.5), gap = at(3.5)
  ok('圆角矩形 (同步): 周长 1.5° 段内亮, 3.5° 缝里黑 (100% 槽深)',
    bar.a >= 250 && bar.b > 200 && gap.a >= 250 && gap.b <= 8,
    'bar a/b=' + bar.a + '/' + bar.b + ' @(' + bar.x + ',' + bar.y + '), gap a/b=' + gap.a + '/' + gap.b + ' @(' + gap.x + ',' + gap.y + ')')
}

/* ============================================================
 * 6b) 端点 AA: 只给起始角/结束角, 单边向外, 不碰进度前沿
 * ============================================================ */
{
  const P = Math.PI * 2, w = 0.1
  const e = (rel, sweep, range) => ringArcEndAA(rel, sweep, range, P, w)
  /* 整圈 (range = period) 没有端点 */
  ok('整圈没有端点 AA: fill/track 外延都是 0',
    e(0, Math.PI, P).fillScale === 0 && e(0, Math.PI, P).trackScale === 0)

  /* 部分弧, 满档: 起点/终点的带内都是 1, 带外按最近端面淡出 */
  ok('端点 AA (满档): 带内满覆盖, 端面外 0.05 → 0.5, 0.2 → 0',
    e(0, Math.PI, Math.PI).fillScale === 1 && e(Math.PI, Math.PI, Math.PI).fillScale === 1 &&
    near(e(Math.PI + 0.05, Math.PI, Math.PI).trackScale, 0.5) &&
    near(e(P - 0.05, Math.PI, Math.PI).trackScale, 0.5) &&
    e(Math.PI + 0.2, Math.PI, Math.PI).trackScale === 0,
    'end+0.05 ' + e(Math.PI + 0.05, Math.PI, Math.PI).trackScale.toFixed(3) +
    ' / start-0.05 ' + e(P - 0.05, Math.PI, Math.PI).trackScale.toFixed(3))

  /* 未满档: 填充前沿 (π/2) 不给外延; 起点仍给; 结束角只给轨道 */
  const front = e(Math.PI / 2 + 0.05, Math.PI / 2, Math.PI)
  const startOut = e(P - 0.05, Math.PI / 2, Math.PI)
  const endOut = e(Math.PI + 0.05, Math.PI / 2, Math.PI)
  ok('端点 AA (10/35 这类未满档): 填充前沿硬边, 只有起点/结束角外延',
    front.fillScale === 0 && front.trackScale === 1 &&
    near(startOut.fillScale, 0.5) && near(startOut.trackScale, 0.5) &&
    endOut.fillScale === 0 && near(endOut.trackScale, 0.5),
    '前沿 fill ' + front.fillScale + ' / 起点 fill ' + startOut.fillScale +
    ' / 结束角 fill ' + endOut.fillScale + ' track ' + endOut.trackScale.toFixed(3))
}

/* 6b-2) 端点 AA 一个值管两端; 沟槽 AA 不影响端点 */
{
  const rMid = (baseCircle.rOut + baseCircle.rIn) / 2
  const base = { ...baseCircle, segOn: false, caps: false, syncMcU: false,
                 startDeg: 0, arcEndDeg: 180, value: 40, steps: 40, aa: 1.5,
                 segAA: 0, aaEdge: 0 }
  const hard = render(base, 160, 160)
  const soft = render({ ...base, aaEdge: 6 }, 160, 160)
  const A = (img, deg) => sampleAt(img, base, 160, 160, deg, rMid).a
  const hOutS = A(hard, 358), sOutS = A(soft, 358)   // 起点外 2°
  const hOutE = A(hard, 182), sOutE = A(soft, 182)   // 结束角外 2°
  ok('端点 AA 一个值同时作用起点/终点: 两端外侧都出现向外延伸',
    sOutS > hOutS + 10 && sOutE > hOutE + 10 &&
    Math.abs(sOutS - sOutE) <= 24,
    '起点外 ' + hOutS + '→' + sOutS + ' / 结束角外 ' + hOutE + '→' + sOutE)

  const seg = render({ ...base, segOn: true, segAA: 4 }, 160, 160)
  ok('沟槽 AA 不改变端点: segAA=4 / aaEdge=0 时端点外侧仍是 0',
    A(seg, 358) === hOutS && A(seg, 182) === hOutE,
    '端点外 ' + A(seg, 358) + '/' + A(seg, 182) + ' vs 硬边 ' + hOutS + '/' + hOutE)
}

{
  const rMid = (baseCircle.rOut + baseCircle.rIn) / 2
  for (const sync of [true, false]) {
    const ring = { ...baseCircle, syncMcU: sync, caps: false, segOn: false,
      startDeg: 0, arcEndDeg: 180, value: 40, steps: 40, aaEdge: 1.5 }
    const img = render(ring, 160, 160)
    const at = (deg) => sampleAt(img, ring, 160, 160, deg, rMid)
    /* 同步路径: alpha 保持不透明, 端面外是"颜色向底色淡出" (板子上没有 alpha);
     * 理想路径: 真正的 alpha 淡出。两种都看同一个可见量: 同步看亮度, 理想看 alpha。 */
    const vis = (p) => sync ? p.b : p.a
    const s0 = at(0), s180 = at(180)
    const inside0 = at(1.5), inside180 = at(178.5)
    const justOut0 = at(-0.7), justOut180 = at(180.7)
    const farOut0 = at(-2), farOut180 = at(182)
    ok('圆环端点 AA (' + (sync ? '同步' : '理想') + '): 端面满覆盖, 外侧才淡出 (不侵蚀高亮)',
      vis(s0) >= 250 && vis(s180) >= 250 &&
      vis(inside0) >= 250 && vis(inside180) >= 250 &&
      vis(justOut0) > 20 && vis(justOut0) < 235 && vis(justOut180) > 20 && vis(justOut180) < 235 &&
      vis(farOut0) < 20 && vis(farOut180) < 20,
      '端面 ' + vis(s0) + '/' + vis(s180) + ' · 内侧 ' + vis(inside0) + '/' + vis(inside180) +
      ' · 外侧 0.7° ' + vis(justOut0) + '/' + vis(justOut180) + ' · 2° ' + vis(farOut0) + '/' + vis(farOut180))
  }
}

{
  const ring = { shape: 'rect', rad: 24, radIn: null, thick: 14, inset: 8, aa: 1.5,
    steps: 40, value: 40, startDeg: -90, arcEndDeg: 90, trackColor: 0x0000, fillColor: 0x07FF,
    glintOn: false, autoGlint: false, autoArc: false, syncMcU: false, caps: false,
    depth: 0, tailU: 0, effect: 'static', segOn: false, aaEdge: 1.5 }
  const img = render(ring, 160, 120)
  const g = ringRectGeom(160, 120, ring)
  const cx = Math.floor(159 / 2), cy = Math.floor(119 / 2)
  const at = (t) => {
    const p = ringRectPointAt(t, g.hx, g.hy, g.rc)
    const x = Math.round(cx + p.x), y = Math.round(cy + p.y)
    return img.data[(y * 160 + x) * 4 + 3]
  }
  const a0 = at(0), aMid = at(0.01), aEnd = at(0.5), aOut = at(0.505)
  ok('圆角矩形端点 AA (理想): 起点/终点处在过渡带内, 内侧实心, 外侧淡出',
    a0 > 80 && aEnd > 80 && aMid >= 250 && aOut < 120,
    't=0 ' + a0 + ', t=0.01 ' + aMid + ', t=0.5 ' + aEnd + ', t=0.505 ' + aOut)
}

/* 6c) 分割点 (RING_SEG_SPLIT_X10): 0=段末 / 5=槽中 / 10=下段起点,
 *     填充末端与固件 Ring_SegSweep() 的 0.5° 向上取整同源 */
{
  const base = { shape: 'circle', rOut: 220, rIn: 180, inset: 0, aa: 2,
    steps: 35, value: 1, startDeg: 0, arcEndDeg: 290, arcDir: 1,
    trackColor: 0x0000, fillColor: 0x07FF, glintOn: false, autoGlint: false, autoArc: false,
    syncMcU: false, caps: false, depth: 0, tailU: 0, effect: 'static',
    segOn: true, segCount: 70, segGapDeg: 1.6667, segGapPct: null, segPhaseDeg: 0,
    segMode: 'groove', segAA: 0, aaEdge: 0, segDepth: 30 }
  const lastFill = (split) => {
    const ring = { ...base, segSplit: split }
    const img = render(ring, 480, 480)
    let last = 0
    for (let deg = 5; deg <= 10.01; deg += 0.1) {
      const s = sampleAt(img, ring, 480, 480, deg, 200)
      if (s.b > 20) last = deg
    }
    return last
  }
  const l0 = lastFill(0), l5 = lastFill(5), l10 = lastFill(10)
  ok('分割点: 0/5/10 → 填充末端 ≈ 7.0 / 8.0 / 8.5° (与 MCU 0.5° 网格同源)',
    near(l0, 7.0, 0.7) && near(l5, 8.0, 0.7) && near(l10, 8.5, 0.7) && l0 < l5 && l5 <= l10,
    'split0 ' + l0.toFixed(1) + '° / split5 ' + l5.toFixed(1) + '° / split10 ' + l10.toFixed(1) + '°')
}

/* 6d) 进度前沿也做向外 AA (与固件 2026-10-22 版一致): 10/35 前沿外能看到填充色淡出 */
{
  const base = { shape: 'circle', rOut: 108, rIn: 90, inset: 0, aa: 2,
    steps: 35, value: 10, startDeg: 0, arcEndDeg: 290, arcDir: 1,
    trackColor: 0x0000, fillColor: 0x07FF, glintOn: false, autoGlint: false, autoArc: false,
    syncMcU: false, caps: false, depth: 0, tailU: 0, effect: 'static',
    segOn: true, segCount: 70, segGapDeg: 1.6667, segGapPct: null, segPhaseDeg: 0,
    segMode: 'groove', segAA: 0, aaEdge: 0, segDepth: 30, segSplit: 5 }
  const hard = render(base, 240, 240)
  const soft = render({ ...base, aaEdge: 4 }, 240, 240)
  const B = (img, deg) => sampleAt(img, base, 240, 240, deg, 99).b
  /* 10/35 → lit=20 → 前沿 82.5° (槽中) */
  ok('进度前沿 AA: aaEdge=4 时 10/35 前沿外 1.5° 有填充色淡出, 3.5° 外归零',
    B(soft, 84) > 20 && B(hard, 84) < 10 && B(soft, 86) < 10,
    '84° ' + B(hard, 84) + '→' + B(soft, 84) + ' · 86° ' + B(hard, 86) + '→' + B(soft, 86))
}

/* ============================================================
 * 7) 关闭分割 = 老路径逐像素一致
 * ============================================================ */
{
  const a = render({ ...baseCircle, segOn: false, syncMcU: true }, 160, 160).data
  const b = render({ ...baseCircle, segOn: undefined, syncMcU: true }, 160, 160).data
  let n = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++
  ok('segOn 关 / 缺省: 逐像素一致 (老工程零变化)', n === 0, '差异 ' + n + ' 字节')
}

/* ============================================================
 * 8) 部分弧: 弧内 N 段 / 70 段 = 69 条内部缝 / 百分比缝宽 0.01%
 * ============================================================ */
{
  const r = { segOn: true, segCount: 70, segGapPct: 23.33, startDeg: 120, arcEndDeg: 60,
              arcDir: 1, segMode: 'groove', segAA: 0.8, segDepth: 70 }
  const g = ringSegGeom(r)
  const gapExp = 300 * 23.33 / (100 * 70 - 23.33)
  const pExp = (300 + gapExp) / 70
  const bodyExp = pExp - gapExp
  ok('70段/300°: P=(300+gap)/70, body=P-gap, 缝宽=P×23.33%',
    g && g.open && near(g.span, 300, 1e-6) && near(g.P, pExp, 1e-6) &&
    near(g.gap, gapExp, 1e-6) && near(g.body, bodyExp, 1e-6),
    g ? `P=${g.P.toFixed(4)} gap=${g.gap.toFixed(4)} body=${g.body.toFixed(4)} span=${g.span}` : 'null')

  let dark = 0, runs = 0, prev = false, runStart = 0
  const lens = []
  const S = 300, M = 300000
  for (let i = 0; i <= M; i++) {
    const rel = i / M * S
    const m = ringSegMaskDeg(rel, g.P, g.gap, 0.02, { phase: g.phase })
    if (m < 0.5) dark += S / M
    if (m >= 0.5 && !prev) { runs++; runStart = rel }
    if (m < 0.5 && prev) lens.push(rel - runStart)
    prev = m >= 0.5
  }
  if (prev) lens.push(S - runStart)
  ok('70 段 → 亮段 70 / 内部缝 69, 暗区总宽≈69×gap',
    runs === 70 && near(dark, 69 * g.gap, 0.25),
    `亮段 ${runs}, 暗区 ${dark.toFixed(3)}° (期望 ${(69 * g.gap).toFixed(3)}°)`)
  ok('所有段 body 等长 (末端不再偏长)',
    lens.length === 70 && Math.max(...lens) - Math.min(...lens) < 0.05,
    `body ${Math.min(...lens).toFixed(4)}..${Math.max(...lens).toFixed(4)}° (期望 ${g.body.toFixed(4)}°)`)
  ok('首尾不留缝: 弧终点附近 mask=1',
    ringSegMaskDeg(g.span - 0.1, g.P, g.gap, 0.02, { phase: g.phase }) === 1)

  /* 大缝宽回归: 旧 end-skip 会把倒数第二条缝并进末段 (gap>body 时末段更长) */
  const g60 = ringSegGeom({ ...r, segGapPct: 60 })
  let runs60 = 0, prev60 = false, st60 = 0
  const lens60 = []
  for (let i = 0; i <= M; i++) {
    const rel = i / M * S
    const m = ringSegMaskDeg(rel, g60.P, g60.gap, 0.02, { phase: g60.phase })
    if (m >= 0.5 && !prev60) { runs60++; st60 = rel }
    if (m < 0.5 && prev60) lens60.push(rel - st60)
    prev60 = m >= 0.5
  }
  if (prev60) lens60.push(S - st60)
  ok('大缝宽 (60%): 70 段仍等长, 末段不再变长',
    runs60 === 70 && lens60.length === 70 && Math.max(...lens60) - Math.min(...lens60) < 0.05 &&
    near(lens60[69], g60.body, 0.03),
    `末段 ${lens60[69].toFixed(3)}° / body ${g60.body.toFixed(3)}° / 范围 ${Math.min(...lens60).toFixed(3)}..${Math.max(...lens60).toFixed(3)}`)

  const g2 = ringSegGeom({ ...r, segGapPct: 0.01 })
  const gap2Exp = 300 * 0.01 / (100 * 70 - 0.01)
  ok('0.01% 缝宽 = P×0.0001 (支持 0.01% 步进)',
    g2 && near(g2.gap, gap2Exp, 1e-9),
    g2 ? `gap=${g2.gap.toFixed(6)}°` : 'null')

  const g100 = ringSegGeom({ ...r, segGapPct: 100 })
  let allDark = true
  for (let i = 0; i <= 3000; i++) {
    if (ringSegMaskDeg(i / 3000 * 300, g100.P, g100.gap, 0.02, { phase: g100.phase }) >= 0.5) { allDark = false; break }
  }
  ok('缝宽 100% → body=0, 整段全暗', g100 && near(g100.body, 0, 1e-9) && allDark,
    g100 ? `body=${g100.body.toFixed(6)}°` : 'null')
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过')
process.exit(fails ? 1 : 0)
