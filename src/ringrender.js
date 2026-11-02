/*
 * 圆环部件渲染 (期1 预览)
 * 模型对齐 MCU 方案: 一张白色抗锯齿灰度环 × 颜色调制 —— 预览中即
 * 轨道色/填充色分段 + 白斑(角向高斯)乘法提亮 + 圆端帽 + 边缘 AA
 */
import { rgb565To888 } from './colors.js'

/* 8x8 Bayer 有序抖动 (与 MCU bsp_ring.c 里的 s_bayer 完全同一张表) */
const BAYER8 = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
]

/* RGB565 整数混合, 与 MCU ring_mix() 逐位一致 (含 ±0.5LSB 抖动) */
function mix565(bg, fg, v, dth) {
  const br = (bg >> 11) & 31, bg6 = (bg >> 5) & 63, bb = bg & 31
  const fr = (fg >> 11) & 31, fg6 = (fg >> 5) & 63, fb = fg & 31
  const rr = br + ((((fr - br) * v) + 128 + dth) >> 8)
  const gg = bg6 + ((((fg6 - bg6) * v) + 128 + dth) >> 8)
  const bv = bb + ((((fb - bb) * v) + 128 + dth) >> 8)
  return (((rr & 31) << 11) | ((gg & 63) << 5) | (bv & 31)) & 0xFFFF
}

/* ---- 颜色渐变 (网页预览) ----
 * 数据结构: [{ p: 0..100, c: RGB565 }, ...]; p = 沿弧从起始角到结束角的百分比。
 * 固件颜色仍是单色, 导出取首点色做平色; 这里只服务网页预览。
 * 采样前统一排序、夹到 0..100, 并补上 0%/100% 端点 —— 缺端点时用最近点的颜色延伸,
 * 这样用户只放两个点也能得到稳定结果。 */
export function ringGradStops(stops) {
  if (!Array.isArray(stops) || !stops.length) return null
  const out = []
  for (const s of stops) {
    const p = Number(s?.p)
    const c = Number(s?.c)
    if (!Number.isFinite(p) || !Number.isFinite(c)) continue
    out.push({ p: Math.max(0, Math.min(100, p)), c: Math.round(c) & 0xFFFF })
  }
  if (!out.length) return null
  out.sort((a, b) => a.p - b.p)
  if (out[0].p > 0) out.unshift({ p: 0, c: out[0].c })
  const last = out[out.length - 1]
  if (last.p < 100) out.push({ p: 100, c: last.c })
  return out.map((s) => {
    const q = rgb565To888(s.c)
    return { p: s.p, c: s.c, r: q.r, g: q.g, b: q.b }
  })
}

/* 按位置 t=0..1 取渐变 RGB (浮点, 给理想渲染与自检用) */
export function ringGradRgb(stops, t) {
  if (!Array.isArray(stops) || !stops.length) return null
  const x = Math.max(0, Math.min(1, Number(t) || 0)) * 100
  const first = stops[0]
  if (x <= first.p) return { r: first.r, g: first.g, b: first.b }
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i]
    const a = stops[i - 1]
    if (x <= b.p) {
      const d = b.p - a.p
      const k = d > 1e-9 ? (x - a.p) / d : 1
      return {
        r: a.r + (b.r - a.r) * k,
        g: a.g + (b.g - a.g) * k,
        b: a.b + (b.b - a.b) * k,
      }
    }
  }
  const z = stops[stops.length - 1]
  return { r: z.r, g: z.g, b: z.b }
}

/* 按位置 t=0..1 取渐变 RGB565 (给同步整数链用) */
export function ringGrad565(stops, t, dth = 0) {
  if (!Array.isArray(stops) || !stops.length) return 0
  const x = Math.max(0, Math.min(1, Number(t) || 0)) * 100
  const first = stops[0]
  if (x <= first.p) return first.c
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i]
    const a = stops[i - 1]
    if (x <= b.p) {
      const d = b.p - a.p
      const k = d > 1e-9 ? Math.max(0, Math.min(1, (x - a.p) / d)) : 1
      return mix565(a.c, b.c, Math.round(k * 255), dth)
    }
  }
  return stops[stops.length - 1].c
}

/* ---- 弧度范围 (起始角 → 结束角) ----
 * 圆环与圆角矩形共用同一份口径:
 *   arcEndDeg == null / ''  → 整圈 360°
 *   给了 endDeg               → span = (end - start) 按 arcDir 取正向, 折到 0..360
 *   span 恰好 0 (end == start) 视作整圈 —— 否则用户拖到同一个角会突然得到 0° 的环
 * 返回值统一用 0.5° 单位 (720 = 整圈), 与固件 RING_ANG_UNITS 同一刻度。 */
export function ringArcRange(r) {
  const dir = (r?.arcDir ?? 1) < 0 ? -1 : 1
  const startDeg = Number.isFinite(+r?.startDeg) ? +r.startDeg : -90
  const raw = r?.arcEndDeg
  const hasEnd = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(+raw)
  let spanDeg = 360
  if (hasEnd) {
    let d = dir > 0 ? (+raw - startDeg) : (startDeg - (+raw))
    d = ((d % 360) + 360) % 360
    if (d > 1e-9) spanDeg = d
  }
  const rangeU = Math.max(2, Math.min(720, Math.round(spanDeg * 2)))
  return { startDeg, endDeg: startDeg + dir * spanDeg, spanDeg, rangeU, full: rangeU >= 720, dir }
}

/* 预览拖尾长度 (0.5°): 倒计时效果按 DR1152 的时间口径折算 ——
 * 固件 RINGUI_TAIL_MS = 200ms, tailU = 720 × tailMs / countMs (与 app_ring_ui.c 的
 * ringui_trail_u(sel) 同式, 下限 10 = RINGUI_TAIL_MIN_U); 静态效果仍用设计值 tailU。
 * countMs 是整条弧走完的时间 (固件里 sel 秒 × 1000), 所以拖尾角长在倒计时过程中不变。 */
export function ringTailU(r) {
  if (r?.effect === 'countdown') {
    const total = Math.max(1000, Math.round(r.countMs ?? 10000))
    const ms = Math.max(0, Math.round(r.tailMs ?? 200))
    if (!ms) return 0
    return Math.max(10, Math.min(720, Math.round((720 * ms) / total)))
  }
  return Math.max(0, Math.min(720, Math.round(r?.tailU ?? 0)))
}

/** 左右镜像 (绕环心竖轴) 的**设计参数**变换: 起止角/弧向/白斑角/白斑转向/分段相位.
 *  镜像一次 = 把整条弧翻到另一边, 角度数字同步改; 再调用一次回到原样 (对合).
 *  只改设计参数, 不改图层位置; 固件导出的是镜像后的角度, 不需要额外的镜像开关.
 *  分段相位: 原段起点在 start + dir*(-phase + kP), 镜像后相对新起点变为
 *    phase' = -(phase + span mod P)  —— span 是整周期时就是 -phase.
 */
export function mirrorRingX(r) {
  const norm = (a) => ((Math.round(a) % 360) + 360) % 360
  const out = { ...r }
  out.startDeg = norm(180 - (r.startDeg ?? -90))
  const rawEnd = r.arcEndDeg
  if (rawEnd != null && rawEnd !== '' && Number.isFinite(+rawEnd)) out.arcEndDeg = norm(180 - (+rawEnd))
  out.arcDir = -(r.arcDir ?? 1)
  out.glintDeg = norm(180 - (r.glintDeg ?? 0))
  out.dir = -(r.dir ?? 1)
  out.mirrorX = !r.mirrorX
  if (r.segOn) {
    const N = Math.max(2, Math.round(Number(r.segCount) || 90))
    const P = 360 / N
    const span = ringArcRange(r).spanDeg
    out.segPhaseDeg = -((Number(r.segPhaseDeg) || 0) + (span % P))
  }
  return out
}

/* ============================================================
 *  分割 (角向遮罩) —— 把环带按角度切成 N 段, 段间留一条**径向贯穿**的缝。
 *  参考图口径: N ≈ 90 (4°/段), 缝 ≈ 1° (亮:缝 ≈ 3:1), 缝从内沿直通外沿。
 *
 *  这里只算「沿弧位置 → 覆盖率」, 颜色/白斑/立体感照旧先算, 遮罩最后乘 alpha
 *  (cut) 或把颜色压暗 (groove)。相位相对**弧起点** (0 = 弧起点正好是一段的开始),
 *  所以改 startDeg 时段落跟着走; 想让网格固定在屏幕 0° 上, 把 phase 设成 -startDeg。
 *
 *  纯函数: 网页理想/同步预览、自检共用同一套口径。缝边 AA 用**像素半径的精确角度**
 *  (不受板子 0.5° 角度表限制) —— 240×240 上 1° 缝只有 ~2px, 0.5° 量化会直接变成硬边。
 *  板端接缝时用同一条「像素到缝边线距离」的式子, 其余链路仍按 0.5° 表。
 * ============================================================ */
export function ringSegGeom(r) {
  if (!r || !r.segOn) return null
  const N = Math.max(2, Math.min(180, Math.round(Number(r.segCount) || 90)))
  const range = ringArcRange(r)
  const full = !!range.full || Number(range.spanDeg) >= 359.999
  const span = full ? 360 : Math.max(1e-4, Number(range.spanDeg) || 360)
  /* 弧内 N 段 + N-1 条内部缝, 总长必须正好等于 span:
   *   N*body + (N-1)*gap = span
   *   P = body + gap = (span + gap)/N      ← 段起点间距 (不是 span/N)
   *   body = P - gap = (span - (N-1)*gap)/N
   * 这样最后一段与其余段 body 完全相同, 不会出现"末端更长"。
   * 缝宽百分比按实际节距 P 计: gap = P*pct/100; 100% → body=0 → 全暗。
   */
  const pctRaw = Number(r.segGapPct)
  const hasPct = r.segGapPct !== null && r.segGapPct !== undefined &&
                 r.segGapPct !== '' && Number.isFinite(pctRaw)
  const pct = hasPct ? Math.max(0, Math.min(100, pctRaw)) : null
  let gap, P
  if (full) {
    P = 360 / N
    gap = hasPct ? P * pct / 100 : (Number(r.segGapDeg ?? 1) || 0)
    gap = Math.max(hasPct ? 1e-4 : 0.1, Math.min(P, gap))
  } else {
    if (hasPct) {
      /* gap = P*pct/100 且 P=(span+gap)/N ⇒ gap = span*pct/(100N-pct) */
      gap = span * pct / (100 * N - pct)
    } else {
      gap = Number(r.segGapDeg ?? 1) || 0
      /* gap 最多到 span/(N-1) (body=0); 再大就是全暗 */
      gap = Math.max(0.1, Math.min(span / (N - 1), gap))
    }
    P = (span + gap) / N
  }
  const body = Math.max(0, P - gap)
  const phase = Number(r.segPhaseDeg ?? 0) || 0
  /* 分割只有「暗槽」一种形态 (模式选项已取消): 槽深 100% = 压到黑 = 原来的「切断」。
   * 旧工程里存的是 segMode:'cut' 的, 按 100% 槽深兼容 —— 视觉上等价 (黑底上完全一样),
   * 但不再有单独的 alpha 切断路径。 */
  const mode = 'groove'
  const legacyCut = r.segMode === 'cut'
  /* 角向 AA: 段/缝边界与弧两端共用的**总过渡宽度** (px), 0 = 硬边, 上限 4px。
   * 与固件 Ring_SetSegAA()/RING_SEG_AA_X10 同一口径 (0.1px)。 */
  const aaRaw = r.segAA === null || r.segAA === undefined ? 2 : Number(r.segAA)
  const aaPx = Math.max(0, Math.min(4, Number.isFinite(aaRaw) ? aaRaw : 2))
  /* 暗槽深度 (segDepth): 0 = 不压暗, 100 = 压到黑 (等价于原来的切断) */
  const depth = legacyCut ? 1
    : Math.max(0, Math.min(100, Number(r.segDepth ?? 60) || 0)) / 100
  /* 档位分割线在槽里的位置 (0=段末, 5=槽中, 10=下一段起点); 与固件
   * RING_SEG_SPLIT_X10 同一口径: fillEnd = lit×P − gap×(10−split)/10。 */
  const split = Math.max(0, Math.min(10, Math.round(Number(r.segSplit ?? 5) || 0)))
  return {
    N, P, gap, body, phase, mode, aaPx, depth, split,
    open: !full, span, full,
    pct: hasPct ? pct : (P > 0 ? gap / P * 100 : 0),
    hasPct,
  }
}

/** 归一化角向遮罩 0..1: relDeg = 相对弧起点的角度; aaDeg = 段/缝边界的**总过渡宽度**.
 *
 *  段占 [0, P-gap), 缝占 [P-gap, P). 遮罩以**到最近边界的带符号距离**为自变量
 *  (段内为正, 缝内为负), 在边界两侧连续展开:
 *
 *      缝内 -aa/2 → 0       边界 0 → 0.5       段内 +aa/2 → 1
 *
 *  与固件 ring_seg_aa_color() 完全同一模型 (那边 t = 128 + sBody/(aa/2))。
 *  早先的写法只在**段内**做斜坡: 边界处 m=0.5, 跨到缝里立刻掉到 0 —— 半个像素的
 *  突变, 加大 AA 也只会让段内一侧变软, 缝的暗边依旧是硬的, 两侧一边软一边硬,
 *  看起来就是"分割线不直"。改成带符号距离后, 过渡带跨边界对称展开, 加大 AA
 *  才会同时软化缝的两侧 (这也是板端 2026-10-22 的同一处修正)。
 *
 *  50% 阈值仍严格落在边界上, 所以按 50% 量出来的缝宽始终等于 gap。
 *  aaDeg <= 0 = 关闭 AA (硬边: 段内 1 / 缝内 0, 边界取 0.5)。
 *  opts.phase: 相位 (相对弧起点).
 *
 *  注意: 开口弧的 P=(span+gap)/N, 最后一段的末端正好是弧终点, 最后一条
 *  "缝"落在弧外 —— 因此**不能再做 end-skip**。否则缝宽较大 (gap>body) 时,
 *  end-skip 会把倒数第二条缝的一部分也并进最后一段, 末端反而更长。
 *  这里的周期遮罩本身就已经给出 N-1 条内部缝。 */
export function ringSegMaskDeg(relDeg, P, gap, aaDeg, opts = {}) {
  const period = Number(P)
  if (!(period > 0)) return 1
  const g = Number(gap) || 0
  const body = period - g
  if (body <= 0) return 0                  // 缝占满整个周期 = 全暗
  if (!(g > 0)) return 1                   // 没有缝 = 整段亮
  const rel = Number(relDeg) || 0
  let u = (rel + (Number(opts?.phase) || 0)) % period
  if (u < 0) u += period
  /* 到最近边界的带符号距离: u=0 / u=body 是两条边界, 段内 > 0, 缝内 < 0 */
  const sd = (u < body)
    ? Math.min(u, body - u)
    : -Math.min(u - body, period - u)
  const aa = Number(aaDeg)
  if (!(aa > 1e-9)) return sd > 0 ? 1 : (sd < 0 ? 0 : 0.5)
  const m = 0.5 + sd / aa
  return m < 0 ? 0 : (m > 1 ? 1 : m)
}

/** 弧端点 AA (caps = false): 只给**起始角 / 结束角**这两条静态端面做向外延伸,
 *  不碰当前进度前沿 (例如 10/35 时填充末端保持硬边)。
 *
 *  rel / sweep / range 用同一单位 (圆 = 弧度; 圆角矩形 = 0..1 周长比例),
 *  period = 一圈的同一单位 (2π / 1).
 *  aa = 一个像素对应的宽度 (弧度或周长比例); 也可以是 `{ start, end }`
 *  (内部仍支持, 但 UI 只用一个「端点 AA」值)。
 *
 *  覆盖率规则 (单边、向外):
 *    带内 (0..range)          → 1        (不侵蚀高亮)
 *    越过端面 d (0..AA)       → 1 − d/AA (向边界**外**淡出)
 *    再往外                   → 0
 *  所以 50% 线落在端面外 AA/2 处, 端面本身仍满高亮, 圆弧看起来向外延伸。
 *
 *  返回 { fillScale, trackScale } —— 都是「向外延伸权重」, 调用方用 **max** 合并:
 *    · trackScale: 轨道在 range 两端的外延;
 *    · fillScale : 填充在**起点**的外延; 只有满档 (sweep ≥ range) 才同时给终点外延。
 *      未满档时当前进度前沿不给外延 → 保持硬边。
 *    整圈 (range ≥ period) 没有端点, 返回 0/0。
 */
export function ringArcEndAA(rel, sweep, range, period, aa) {
  const P = Math.max(1e-9, Number(period) || 1)
  if (range >= P - 1e-9) return { fillScale: 0, trackScale: 0 }
  const asym = aa && typeof aa === 'object'
  const wStart = Math.max(1e-6, Number(asym ? aa.start : aa) || 0)
  const wEnd = Math.max(1e-6, Number(asym ? aa.end : aa) || 0)
  /* 带 [0,range] 的向外覆盖率: 带内 1; 带外按**最近**端面淡出
   * (不能用 min(起点覆盖, 终点覆盖) —— 起点外侧离终点很远, 会被终点那侧误判为 0)。 */
  let bandCov = 1
  if (rel > range) {
    const dEnd = rel - range
    const dStart = P - rel
    bandCov = (dEnd <= dStart)
      ? Math.max(0, 1 - dEnd / wEnd)
      : Math.max(0, 1 - dStart / wStart)
  }
  const full = sweep >= range - 1e-9
  let fillScale = 0
  if (sweep > 1e-9) {
    if (full) fillScale = bandCov
    else if (rel > P - wStart) fillScale = Math.max(0, 1 - (P - rel) / wStart)  /* 只延伸起点, 前沿保持硬边 */
  }
  return { fillScale, trackScale: bandCov }
}

/* ---- 同步模式的整数几何 (与 MCU bsp_ring.c 的 ring_arc_update()/ring_arc_w() 同一套) ----
 * 纯函数, 从 drawRing 里原样抽出, 公式一字未改 —— 抽出来只为让 Node 脚本能 import 后
 * 与 C 引擎做逐像素对拍 (drawRing 仍调用同一份代码, 行为不变)。
 * cfg 直接喂 ring 部件字段: { rIn, rOut, aa, startDeg, value, steps, caps }。
 * 约定: 角度统一 0.5° 单位 (720 = 一圈), 圆帽几何用半像素单位, 边界射线用 Q14。
 * rangeU 是新增的「弧度范围」: 整圈 720; 部分弧时进度只在 [start, start+dir*rangeU] 内走,
 * 范围外透明 (track 也只在范围内画)。rangeU 缺省 = 720 → 与旧行为逐位一致。 */
export function ringArcGeom(cfg) {
  const rOut = Math.max(1, cfg.rOut), rIn = Math.max(0, Math.min(cfg.rIn, rOut - 1))
  const aa = Math.max(0.5, cfg.aa || 2)             // 边缘 AA 宽度 (px), 可调增强
  const startU = ((Math.round(cfg.startDeg ?? -90) * 2) % 720 + 720) % 720   // 0.5° 单位
  const rangeU = Math.max(0, Math.min(720, Math.round(cfg.rangeU ?? 720)))
  const stepsN = Math.max(1, cfg.steps || 40)
  const sweepU = Math.min(rangeU, Math.round(((cfg.value ?? 0) * rangeU) / stepsN))
  const unitQ14 = (u) => {
    const a = (u * 0.5 * Math.PI) / 180
    return [Math.round(Math.cos(a) * 16384), Math.round(Math.sin(a) * 16384)]
  }
  const dirSign = (cfg.arcDir ?? 1) < 0 ? -1 : 1          // +1 顺时针 (默认) / -1 逆时针
  const [q0c, q0s] = unitQ14(startU)
  const [q1c, q1s] = unitQ14(((startU + dirSign * sweepU) % 720 + 720) % 720)
  const [qRc, qRs] = unitQ14(((startU + dirSign * rangeU) % 720 + 720) % 720)
  const arcInv = sweepU > 360
  const trackInv = rangeU > 360
  const rInI = Math.round(rIn), rOutI = Math.round(rOut)
  const rmidI = rInI + rOutI                        // 半像素
  const capRI = rOutI - rInI
  const aaI = 2 * Math.max(1, Math.round(aa))       // 半像素
  const cStX = Math.round((rmidI * q0c) / 16384), cStY = Math.round((rmidI * q0s) / 16384)
  const cEnX = Math.round((rmidI * q1c) / 16384), cEnY = Math.round((rmidI * q1s) / 16384)
  const cRx = Math.round((rmidI * qRc) / 16384), cRy = Math.round((rmidI * qRs) / 16384)
  const capRI2 = capRI * capRI
  const capInI = Math.max(0, capRI - aaI), capInI2 = capInI * capInI
  /* 填充端帽: 部分弧走到范围末端时也要有末端帽; 整圈满档没有端帽 */
  const capsOn = !!cfg.caps && sweepU > 0 && (rangeU < 720 ? sweepU <= rangeU : sweepU < 720)
  /* 轨道端帽: 部分弧的起始/结束两端, 与进度无关 (进度为 0 时也要有圆头) */
  const trackCapsOn = !!cfg.caps && rangeU < 720
  /* 拖尾 (0.5° 单位, 0 = 关): 弧末端这一段权重线性渐隐 —— 与固件进度弧的「扫把拖尾」
   * (bsp_ring.c ring_rect_arc_w 的拖尾分支) 同一条整数式 v = back*255/tail。
   * 只在「部分弧」生效 (整圈没有"末端"); 末端圆帽与拖尾互斥 (固件规矩: 末端永远交给渐变收尾)。 */
  const tailU = Math.min(rangeU, Math.max(0, Math.min(720, Math.round(cfg.tailU ?? 0))))
  /* 起点帽的"支撑"比例: 剩余弧不足帽半径时帽盘缩成一个点, 弧长到 2 倍帽半径时
   * 长回整盘。按几何半径连续缩放 —— 不是把整盘乘一个透明度系数。 */
  const capHalfU = (capRI * 360) / (Math.PI * rmidI)
  const capScale = (cfg.effect === 'countdown' && tailU > 0)
    ? Math.max(0, Math.min(1, (sweepU - capHalfU) / capHalfU)) : 1
  return { startU, rangeU, sweepU, dirSign, q0c, q0s, q1c, q1s, qRc, qRs, arcInv, trackInv,
           rInI, rOutI, rmidI, capRI, aaI, cStX, cStY, cEnX, cEnY, cRx, cRy,
           capRI2, capInI, capInI2, capsOn, trackCapsOn, tailU, capHalfU, capScale }
}

/* 几何只与 cfg 有关 → 按 cfg 对象身份缓存一次 (drawRing 每帧建一个 cfg, 逐像素查表)
 * 像素 (dx,dy) 的填充权重: 0/1 的弧内判据 + (弧外) 两端圆帽的半像素 AA 权重 */
const arcGeomCache = new WeakMap()
function arcGeomOf(cfg) {
  let g = arcGeomCache.get(cfg)
  if (!g) { g = ringArcGeom(cfg); arcGeomCache.set(cfg, g) }
  return g
}

/* 支撑比例 < 1 的起点帽: 半径 = capRI * scale 的小圆盘, 圆心不变。
 * 不是把整盘乘系数压暗, 也不是按半径线切一半 —— 帽始终是圆头, 只是还没长全。 */
function arcCapWScaled(dx, dy, g, ccx, ccy, scale) {
  if (!(scale > 0)) return 0
  const r = g.capRI * scale
  const r2 = r * r
  const ax = 2 * dx - ccx, ay = 2 * dy - ccy
  const d2 = ax * ax + ay * ay
  if (d2 >= r2) return 0
  const aa = Math.max(1, g.aaI * scale)
  const inR = Math.max(0, r - aa)
  if (d2 <= inR * inR) return 1
  const w = ((r - Math.floor(Math.sqrt(d2))) * 255) / aa
  return Math.max(0, Math.min(1, w / 255))
}

/* 端帽权重 0..1 (半像素整数距离, 与固件 isqrt 口径一致) */
function arcCapW(dx, dy, g, ccx, ccy) {
  const ax = 2 * dx - ccx, ay = 2 * dy - ccy
  const d2 = ax * ax + ay * ay
  if (d2 >= g.capRI2) return 0
  return d2 <= g.capInI2 ? 1
    : Math.max(0, Math.min(255, Math.trunc(((g.capRI - Math.floor(Math.sqrt(d2))) * 255) / (g.aaI || 1)))) / 255
}

/* 整圈 (rangeU=720) 时保持旧式逐位一致: 叉积判据 + 整圈快路径。
 * 部分弧 (rangeU<720) 的进度端点不再是 360°，叉积的两半平面交集不再等价于
 * 「从 start 转过 sweep」→ 改用 atan2 的相对角判据 (与拖尾同一套 0.5° 整数角),
 * 这样 sweep 可以任意落在 0..range 内, 也不会受 180° 翻转技巧的限制。 */
export function ringArcFillW(dx, dy, cfg) {
  const g = arcGeomOf(cfg)
  if (g.sweepU === 0) return 0
  if (g.rangeU >= 720 && g.sweepU >= 720) return 1
  let ins, relU = -1
  if (g.rangeU >= 720) {
    /* 整数判据 (与 MCU 逐位一致): 两条边界射线的叉积 —— 逆时针时取向整体翻过来 */
    /* 张角 ≤180°: 两半平面取交; >180°: 取并 (取反 = 画到另一个楔形去, 端帽也就永远不出现) */
    const z0 = g.q0c * dy - g.q0s * dx
    const z1 = g.q1c * dy - g.q1s * dx
    ins = g.dirSign > 0
      ? (g.arcInv ? (z0 >= 0 || z1 <= 0) : (z0 >= 0 && z1 <= 0))
      : (g.arcInv ? (z0 <= 0 || z1 >= 0) : (z0 <= 0 && z1 >= 0))
  } else {
    const aUp = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI) * 2)
    relU = ((((aUp - g.startU) * g.dirSign) % 720) + 720) % 720
    ins = relU <= g.sweepU
  }
  let fillW = ins ? 1 : 0
  /* 拖尾: 弧末端 tailU 内权重线性递减 (与固件 ring_rect_arc_w 同一条 v = back*255/tail)。
   * 整圈不生效 (没有"末端"); 末端圆帽与拖尾互斥, 只测起点帽。 */
  if (ins && g.tailU > 0 && g.sweepU < 720) {
    if (relU < 0) {
      const aUp = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI) * 2)
      relU = ((((aUp - g.startU) * g.dirSign) % 720) + 720) % 720
    }
    const back = g.sweepU - relU
    const v = back <= 0 ? 0 : Math.min(255, Math.trunc((back * 255) / g.tailU))
    fillW = v / 255
  }
  /* 圆帽: 半像素整数距离, AA 环带内才开方。
   * 端帽对**盘内所有像素**生效 (固件 2026-10-15 同款): 帽是实体圆头,
   * 拖尾的渐隐不许吃掉它 —— 否则倒计时收尾到帽区时, 帽盘和剩下的一小段
   * 填充会被渐隐切开, 看起来像两片/半个帽。盘内取 max, 盘外仍按拖尾。
   * 收尾时有拖尾: 起点帽按支撑比例连续缩小半径 (仍是圆头), 弧长够了长回整盘。
   * 不做弦切/半帽, 也不把整盘乘系数压暗。 */
  if (g.capsOn) {
    const caps = g.tailU > 0 ? [[g.cStX, g.cStY]] : [[g.cStX, g.cStY], [g.cEnX, g.cEnY]]
    for (let k = 0; k < caps.length; k++) {
      const cw = (k === 0 && g.tailU > 0)
        ? arcCapWScaled(dx, dy, g, caps[k][0], caps[k][1], g.capScale)
        : arcCapW(dx, dy, g, caps[k][0], caps[k][1])
      if (cw > fillW) fillW = cw
    }
  }
  return fillW
}

/** 端帽覆盖权重 0..1 (0 = 不在任何帽盘内)。
 *  只回答"这个像素属于哪个帽盘、盘边 AA 多强", 不含填充/轨道权重。
 *  拖尾时只算起点帽, 并按 capScale 连续缩小半径 (弧短时不画帽); 末端帽交给渐变。
 *  画像素时用它把帽盘单独当实心 fill 层合成: 帽内底色一律 fill, alpha 用填充权重,
 *  这样盘内不会一半混轨道色、一半纯 fill (倒计时收尾到帽区时的"半个帽")。 */
export function ringArcCapW(dx, dy, cfg) {
  const g = arcGeomOf(cfg)
  if (!g.capsOn) return 0
  let w = g.tailU > 0
    ? arcCapWScaled(dx, dy, g, g.cStX, g.cStY, g.capScale)
    : arcCapW(dx, dy, g, g.cStX, g.cStY)
  if (g.tailU === 0) {
    const e = arcCapW(dx, dy, g, g.cEnX, g.cEnY)
    if (e > w) w = e
  }
  return w
}

/** 轨道权重 0..1 (部分弧): 范围内整条带 + 两端圆帽, 范围外透明。
 *  整圈返回 1 —— 旧行为 (整个环都是轨道) 逐位不变。 */
export function ringArcTrackW(dx, dy, cfg) {
  const g = arcGeomOf(cfg)
  if (g.rangeU >= 720) return 1
  let ins
  if (g.rangeU >= 720) {
    ins = true
  } else {
    const z0 = g.q0c * dy - g.q0s * dx
    const zr = g.qRc * dy - g.qRs * dx
    ins = g.dirSign > 0
      ? (g.trackInv ? (z0 >= 0 || zr <= 0) : (z0 >= 0 && zr <= 0))
      : (g.trackInv ? (z0 <= 0 || zr >= 0) : (z0 <= 0 && zr >= 0))
  }
  if (ins) return 1
  if (!g.trackCapsOn) return 0
  let w = 0
  /* 拖尾时末端不画帽 (渐变即收尾) —— 与填充端帽同一规矩; 否则轨道端帽会从
   * 渐隐的填充尾巴下面露出半个圆头 (倒计时满档时最明显)。 */
  const caps = g.tailU > 0
    ? [[g.cStX, g.cStY]]
    : [[g.cStX, g.cStY], [g.cRx, g.cRy]]
  for (const [ccx, ccy] of caps) {
    const cw = arcCapW(dx, dy, g, ccx, ccy)
    if (cw > w) w = cw
  }
  return w
}

/* ============================================================
 *  圆角矩形环 (板子 RING_SHAPE=1 与「与 MCU 同步预览」共用同一套整数几何):
 *  中心线 = 圆角矩形 (半宽 hx, 半高 hy, 圆角半径 rc)
 *   · 到中心线的有符号距离 d (外正内负) → 环带 + 边缘 AA (与圆环同一套: |d| 越接近半环厚越实)
 *   · 沿周长位置 t (0..1, 0 = 顶部中点, 顺时针) → 进度弧 / 白斑沿边框跑
 *   · 等效角 a = t*360 - 90 (度): 与圆的 atan2 同一约定 (0 = 正右, 顺时针为正)
 *     —— 这样"起始角/进度/白斑高斯/端帽"的公式一字不改就能复用。
 *  两个函数互为逆运算 (check-ringrect.mjs 做往返对拍)。
 * ============================================================ */
/** 圆角矩形 SDF (内部为负, 外部为正) —— 外框/内框/中心线都用它 */
function sdfRoundRect(dx, dy, hw, hh, r) {
  const qx = Math.abs(dx) - (hw - r), qy = Math.abs(dy) - (hh - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

function rectGeom(hx, hy, rc) {
  const r = Math.max(0, Math.min(rc || 0, Math.min(hx, hy)))
  const ex = Math.max(0, hx - r), ey = Math.max(0, hy - r)
  const per = 4 * (ex + ey) + 2 * Math.PI * r
  return { r, ex, ey, per, q: (Math.PI / 2) * r }
}

/** 点 (相对中心 dx,dy) → { d, t, a }: 到中心线距离 / 周长位置 0..1 / 等效角(弧度) */
export function ringRectPath(dx, dy, hx, hy, rc) {
  const { r, ex, ey, per, q } = rectGeom(hx, hy, rc)
  const ax = Math.abs(dx), ay = Math.abs(dy)
  const qx = Math.max(ax - ex, 0), qy = Math.max(ay - ey, 0)
  const d = sdfRoundRect(dx, dy, hx, hy, r)
  let s
  if (r > 1e-9 && qx > 1e-9 && qy > 1e-9) {           // 四个角弧 (θ 在折叠空间里 0..90°)
    const th = Math.atan2(qy, qx)
    if (dx >= 0 && dy < 0)       s = ex + (q - r * th)                                  // 右上: θ 90°→0°
    else if (dx >= 0)            s = ex + q + 2 * ey + r * th                            // 右下: θ 0°→90°
    else if (dy >= 0)            s = ex + 2 * q + 2 * ey + 2 * ex + (q - r * th)         // 左下: θ 90°→0°
    else                         s = ex + 3 * q + 2 * ey + 2 * ex + 2 * ey + r * th      // 左上: θ 0°→90°
  } else {
    /* 不在角上: 取四条直边里垂足最近的那条 (核心矩形内部同样适用) */
    const px = Math.max(-ex, Math.min(ex, dx))         // 上/下边的垂足 x
    const py = Math.max(-ey, Math.min(ey, dy))         // 左/右边的垂足 y
    const cand = [
      { d2: (dx - px) ** 2 + (dy + hy) ** 2, s: px >= 0 ? px : per + px },              // 上边
      { d2: (dx - px) ** 2 + (dy - hy) ** 2, s: ex + 2 * q + 2 * ey + (ex - px) },      // 下边
      { d2: (dx - hx) ** 2 + (dy - py) ** 2, s: ex + q + (py + ey) },                   // 右边
      { d2: (dx + hx) ** 2 + (dy - py) ** 2, s: ex + 3 * q + 2 * ey + 2 * ex + (ey - py) }, // 左边
    ]
    let best = cand[0]
    for (const c of cand) if (c.d2 < best.d2) best = c
    s = best.s
  }
  const t = per > 0 ? (((s % per) + per) % per) / per : 0
  return { d, t, a: t * Math.PI * 2 - Math.PI / 2 }
}

/**
 * 圆角矩形环的参数推导 (drawRing 与对话框/自检共用一份):
 *   输入: 图层外框 w×h, 环参数 { rad = **外圆角半径**, thick = 环厚, inset = **留边**(总, px) },
 *   输出: 中心线几何 { hx, hy, rc, ht } + 三个可见半径 (radOut / radMid / radIn)。
 *   外圆角下限 = 环厚 + 1 → **内圆角自动 ≥ 1** (内外都是圆角, 不会出现内尖角)。
 */
export function ringRectGeom(w, h, r) {
  const thick = Math.max(1, Math.round(r.thick ?? 12))
  const ht = thick / 2
  /* 留边 (总, px): 环带外沿离图层外框的余量 —— 图层外框一般就是屏幕尺寸, 留边在内部算。
   * 圆环/圆角矩形/导出三处必须同一个数 → 统一走 ringInsetPx() (老工程读 fitPad / pad*2) */
  const inset = ringInsetPx(r)
  const ow = Math.max(4, w - inset), oh = Math.max(4, h - inset)         // 环带外沿的框
  const halfMax = Math.min(ow, oh) / 2
  /* 外圆角: 下限 = 环厚+1 (否则内角没地方圆), 上限 = 半宽/半高 (胶囊形) */
  const radOut = Math.max(Math.min(thick + 1, halfMax), Math.min(r.rad ?? 24, halfMax))
  /* 内圆角: 留空 = 外圆角 − 环厚 (同心圆角, 环带等厚)。可单独调:
   *   调大 → 内角更圆, 但角上环带会变薄; 调小 → 内角更方 (0 = 直角内角), 角上更厚 */
  const rin = r.radIn == null || r.radIn === '' ? NaN : Number(r.radIn)
  /* 上限不只是 radOut: 内框自己也有半宽/半高 (ow/2−thick), 圆角半径不能超过它 ——
   * 网页理想渲染的 SDF (sdfRoundRect) 内部就是这么夹的, 这里先夹住,
   * 中心线 rc / 周长参数 s / 导出宏 RING_I_RC 才跟真实形状一致 */
  const rinCap = Math.max(0, Math.min(ow / 2 - thick, oh / 2 - thick))
  const radIn = Math.max(0, Math.min(Number.isFinite(rin) ? Math.round(rin) : radOut - thick, Math.min(radOut, rinCap)))
  const radMid = Math.max(0, (radOut + radIn) / 2)                       // 中心线圆角 (周长参数/白斑/端帽)
  const hx = Math.max(0.5, ow / 2 - ht), hy = Math.max(0.5, oh / 2 - ht)
  return { hx, hy, rc: radMid, ht, aa: Math.max(0.5, r.aa || 2), thick, ow, oh, radOut, radMid, radIn }
}

/** 「留边」(总, px) → 实际扣多少: 新字段 inset 优先; 老工程读 fitPad / pad*2。
 * 三个都没有 = 0 (不能默认 8: 自检/对拍里那些临时 ring 对象没这个字段, 一扣就整体偏 4px)。 */
export function ringInsetPx(r) {
  if (!r) return 0
  const v = r.inset ?? r.fitPad ?? (r.pad != null ? r.pad * 2 : 0)
  return Math.max(0, Math.round(v || 0))
}

/** 一圈的弧长 (px): 圆环 = 2π·中径; 圆角矩形 = 周长。白斑步进按它折算成角度。 */
export function ringLapPx(w, h, r) {
  if (r?.shape === 'rect') {
    const g = ringRectGeom(w, h, r)
    return Math.max(1, 4 * ((g.hx - g.rc) + (g.hy - g.rc)) + 2 * Math.PI * g.rc)
  }
  const insetPx = ringInsetPx(r)
  const rMid = ((r?.rIn ?? 0) + (r?.rOut ?? 2)) / 2 - insetPx / 2
  return Math.max(1, 2 * Math.PI * Math.max(1, rMid))
}

/** 板子上白斑每帧走多少弧长 (px/步): 档位 gear × 0.5° → 折算成一圈弧长 lapPx 上的距离。
 *  网页「弧长 (预览)」填成这个值, 预览的转速就与板子一致 (纯函数, 自检直接测)。 */
export function ringStepPx(w, h, r) {
  const gear = Math.max(1, Math.min(40, Math.round(r?.gear ?? 2)))
  const lap = ringLapPx(w, h, r)
  return (gear * 0.5 / 360) * lap
}

/** 圆角矩形环的逐点命中: { cov(0..1 边缘AA), a(等效角), d, t } 或 null (带外)
 *  g = { hx, hy, rc, ht(半环厚), aa } —— drawRing 与 check-ringrect.mjs 共用这一份。 */
export function ringRectBand(dx, dy, g) {
  const dOut = sdfRoundRect(dx, dy, g.ow / 2, g.oh / 2, g.radOut)                  // 外边界 (内负)
  if (dOut > g.aa) return null
  const dIn = sdfRoundRect(dx, dy, Math.max(0, g.ow / 2 - g.thick), Math.max(0, g.oh / 2 - g.thick), g.radIn)
  if (dIn < -g.aa) return null                                                     // 内孔里
  const cov = Math.min(Math.min(1, Math.max(0, -dOut / g.aa)), Math.min(1, Math.max(0, dIn / g.aa)))
  if (cov <= 0) return null
  const rp = ringRectPath(dx, dy, g.hx, g.hy, g.rc)                                // 周长参数走中心线
  return { cov, a: rp.a, d: rp.d, t: rp.t }
}

/* ============================================================
 *  圆角矩形环的**板子同式整数几何** (固件 RING_SHAPE=1 用同一套, 这是能逐像素对拍的前提)
 *
 *   · 定长 Q8: 中心线 hx/hy/rc/半厚 ht → 外框 (hx+ht, hy+ht, rc+ht) / 内框 (hx−ht, hy−ht, rc−ht)
 *   · 每行求外/内 x 半宽 (xo/xi, Q8): 直边段 = 常数, 圆角段 = HX−RC + isqrt(RC² − k²)
 *     → 环带 = [−xo, −xi] ∪ [xi, xo] (内框在该行为空时只剩一段)
 *   · 边缘抗锯齿 = 像素区间 [x−0.5, x+0.5] 与带区间的重叠 (Q8, 0..255)
 *   · 进度弧 / 白斑用**周长参数 s** (t=0 在顶边中点, 顺时针), 等效角 aU = s·720/per (0.5° 单位)
 *     —— 与网页矩形同约定, 于是白斑能直接复用现有增益表, 且不需要逐像素 atan2
 *   · 角上的角度用 ringAtan2U() (与白斑同一个整数 atan2 表): 两端算出来一模一样
 * ============================================================ */
/** 整数开方 (Q16 入 → Q8 出; 与固件 ring_isqrt 同语义: floor) */
export function isqrtQ16(v) {
  if (v <= 0) return 0
  let x = Math.floor(Math.sqrt(v))
  while ((x + 1) * (x + 1) <= v) x++
  while (x * x > v) x--
  return x
}

export function ringRectGeomQ8(w, h, r) {
  const g = ringRectGeom(w, h, r)
  const q = (v) => Math.max(0, Math.round(v * 256))
  const hx = q(g.hx), hy = q(g.hy), rc = q(g.rc), ht = Math.max(1, q(g.ht))
  /* 带 = **外框圆角矩形 − 内框圆角矩形** (与网页 SDF 同一模型: 内外圆角各自独立,
   * 所以角上的厚度与直边不同 —— 不能用"中心线 ± 半厚"去推, 那会差 (radOut−(rc+ht)) 像素) */
  const oHx = q(g.ow / 2), oHy = q(g.oh / 2), oRc = q(g.radOut)
  /* 内框半径也要夹到 min(iHx,iHy) —— 与网页理想渲染的 SDF (sdfRoundRect 内部夹) 同一个形状;
   * 不夹的话 radIn > 内框半高 时行跨度会算出"自交"的边界 (角上多出/少掉一圈像素) */
  const iHx = q(Math.max(0, g.ow / 2 - g.thick)), iHy = q(Math.max(0, g.oh / 2 - g.thick))
  const iRc = Math.min(q(g.radIn), Math.min(iHx, iHy))
  /* 周长 (Q8) + 1/周长 (Q16) —— 板子上用乘法代替除法算 aU = s·720/per */
  const per = 4 * ((hx - rc) + (hy - rc)) + Math.round(2 * Math.PI * rc)
  const invPer = per > 0 ? Math.round((720 * 65536) / per) : 0
  /* AA 宽度 (覆盖率斜坡): 与导出宏 RING_COV_AA_X10 同一个整数推导 ——
   * store.js 写的是 round(aa*10), 板子上 aa_px = (X10+5)/10 (整数除法), 这里必须一字不差 */
  const aaPx = Math.max(1, Math.floor((Math.round((r?.aa || 2) * 10) + 5) / 10))
  const aaQ8 = aaPx * 256
  return { hx, hy, rc, ht, oHx, oHy, oRc, iHx, iHy, iRc, per, invPer,
           aa: Math.max(1, q(g.aa)), aaPx, aaQ8, invAa: Math.floor(65536 / aaQ8),
           /* 角上单位外法线用 (立体感): oRc 的倒数 (Q16), 与固件 (65536/RING_O_RC) 同一个整数除 */
           invORc: oRc > 0 ? Math.floor(65536 / oRc) : 0 }
}

/** 圆角矩形 (Q8 几何) 的带符号距离 Q8 —— 与 IQ 的 rounded-box SDF 同式, **负值 = 在框内**,
 *  数值 = 离边界多远 (px×256)。与固件 ring_rect_dist() 逐位同式 (对拍脚本盯着这一点)。
 *  只有**角上** (qx,qy 都 > 0) 才需要开方, 直边段只是一次比较。
 *  平方先 >>2 再相加: 大屏 (oHx 到 40960) 时 qx²+qy² 会超 int32, 预缩的精度损失 < 1/256px。 */
export function ringRectDistQ8(dxQ8, dyQ8, hx, hy, R) {
  const qx = Math.abs(dxQ8) - (hx - R), qy = Math.abs(dyQ8) - (hy - R)
  const px = qx > 0 ? qx : 0, py = qy > 0 ? qy : 0
  if (px > 0 && py > 0) return 2 * isqrtQ16(((px * px) >> 2) + ((py * py) >> 2)) - R
  return (qx > qy ? qx : qy) - R
}

/** 环带 (外框 − 内框) 的覆盖率 0..255 —— 用**到最近边界的垂直距离**做斜坡,
 *  与圆环板子上那条公式同一约定 (gen_tables.py: v = min(r+0.5−R_IN, R_OUT+0.5−r)/aa):
 *    m ≤ −0.5px → 0;  m = 0 (正好在边界上) → 64 (aa=2);  m ≥ aa−0.5px → 255
 *
 *  为什么不能用"行跨度重叠" (以前的实现): 那只在边界竖直时才是面积覆盖 —— 角弧是斜的,
 *  覆盖率只沿 x 渐变, 弧线看起来就是一格格的台阶 ("圆弧的曲线看起来还不够平滑", 用户现场);
 *  上下长边更糟: 整行都算带内 → 硬边胖 1px。改成按距离之后, 斜坡方向自动跟着边界法线走,
 *  弧和直边、左边右边完全一样平滑 (与圆环的观感也统一了)。 */
export function ringRectCovSdf8(dxQ8, dyQ8, G) {
  const dOut = ringRectDistQ8(dxQ8, dyQ8, G.oHx, G.oHy, G.oRc)      /* IQ: 负 = 在外框内 */
  if (dOut >= 128) return 0                                         /* 外框外 0.5px 以上: 全透明 */
  const dIn = ringRectDistQ8(dxQ8, dyQ8, G.iHx, G.iHy, G.iRc)       /* IQ: 负 = 在孔内 */
  const m = (-dOut < dIn) ? -dOut : dIn                             /* 离带边界多远 (带内为正) */
  if (m <= -128) return 0
  if (m >= G.aaQ8 - 128) return 255
  return ((m + 128) * G.invAa) >> 8
}

/** 某一行 (dy, Q8, 相对中心) 的外/内 x 半宽 (Q8)。
 *  注意 |dy| > oHy 的整行都在外框之外 → xo = 0 (不能靠 isqrt 的 0 兜底:
 *  oHx−oRc 是个正数, 会把行外的像素也算成带内 —— 板子那边同一个判据)
 *  —— 现在它只用来给固件算"这一行从哪个 x 扫到哪个 x" (网页逐像素扫, 不需要);
 *  行的实际起止要用 dy ∓0.5px 两次的并集 (软边会多出半行), 见固件 ring_rect_span_rng()。 */
export function ringRectSpanQ8(dyQ8, G) {
  const ay = Math.abs(dyQ8)
  let xo, xi
  if (ay > G.oHy) xo = 0
  else if (ay <= G.oHy - G.oRc) xo = G.oHx
  else {
    const k = ay - (G.oHy - G.oRc)
    xo = G.oHx - G.oRc + isqrtQ16(G.oRc * G.oRc - k * k)
  }
  if (ay > G.iHy) xi = 0
  else if (ay <= G.iHy - G.iRc) xi = G.iHx
  else {
    const k = ay - (G.iHy - G.iRc)
    xi = G.iHx - G.iRc + isqrtQ16(G.iRc * G.iRc - k * k)
  }
  return { xo, xi }
}

/* ---------- 整数 π: 角弧长度与直角弧都用它 (两端一字不差的关键) ----------
 *   π/360 ≈ 143/16384 (Q14) —— 误差 1.6e-5, 在 Q8 长度上远小于 1/256 px。
 *   (固件同一式: arc = (rc * th * 143) >> 14, th 为 0.5° 单位) */
export const RECT_PI_Q14 = 143
/** 半径 rc (Q8) 上, 角度 thU (0.5° 单位) 对应的弧长 (Q8) */
export function rectArcQ8(rcQ8, thU) { return (rcQ8 * thU * RECT_PI_Q14) >> 14 }

/* cos 表 (Q14, 0..90° 每 0.5°): 与固件 ringCosQ14 (gen_tables.py 生成) 同一张 */
const RECT_COS_Q14 = (() => {
  const t = new Int16Array(181)
  for (let i = 0; i <= 180; i++) t[i] = Math.round(Math.cos((i * 0.5 * Math.PI) / 180) * 16384)
  return t
})()
/** 第一象限单位向量 (Q14) → [cos, sin], thU = 0..180 (0.5° 单位) */
function rectUnitQ14(thU) {
  if (thU < 0) thU = 0
  if (thU > 180) thU = 180
  return [RECT_COS_Q14[thU], RECT_COS_Q14[180 - thU]]
}

/** 倒数表容量用的"等效半径" (px): 矩形几何的最大像素刻度。
 *  固件那一侧由导出宏 RING_R_OUT 承担同一角色 (gen_tables.py 出 RING_RECIP_N = R_OUT+12)。 */
export function ringRectTableR(G) {
  return Math.max(2, Math.ceil(Math.max(G.oHx, G.oHy) / 256) + 2)
}

/* 整数 atan (第一象限, Q8 入 → 0..180 = 0..90°): 与固件 ring_atan_u_q8() 逐位同式。
 * 倒数表按"像素刻度"索引 (maj>>8), 被除数保留 4 位亚像素 (min>>4) —— M0+ 没有除法器,
 * 这样既不用除法也不丢精度 (角度误差 < 0.05° → 折算到周长 < 0.01px)。 */
const rectAtanTabCache = new Map()
function rectAtanTables(G) {
  const n = ringRectTableR(G)
  let t = rectAtanTabCache.get(n)
  if (t) return t
  const atanTab = new Int32Array(257)
  for (let i = 0; i <= 256; i++) atanTab[i] = Math.round((Math.atan(i / 256) * 180) / Math.PI * 2)
  const recipN = n + 12
  const recip = new Int32Array(recipN)
  for (let k = 1; k < recipN; k++) recip[k] = Math.min(65535, Math.round(65536 / k))
  t = { atanTab, recip, recipN }
  rectAtanTabCache.set(n, t)
  return t
}
export function ringAtanUQ8(ayQ8, axQ8, tb) {
  const maj = axQ8 >= ayQ8 ? axQ8 : ayQ8
  const min = axQ8 >= ayQ8 ? ayQ8 : axQ8
  let mh = (maj + 128) >> 8                     /* 四舍五入到像素刻度: 太小会让倒数表落到 0 */
  if (mh < 1) mh = 1
  if (mh >= tb.recipN) mh = tb.recipN - 1
  let t = ((min >> 4) * tb.recip[mh]) >> 12      /* ≈ min*256/maj */
  if (t > 256) t = 256
  const b = tb.atanTab[t]
  return axQ8 >= ayQ8 ? b : 180 - b
}

/** 像素 (dx,dy, 整数, 相对中心) 的**周长参数** s (Q8, 从顶边中点顺时针) */
export function ringRectPathSQ8(dxQ8, dyQ8, G) {
  const ax = Math.abs(dxQ8), ay = Math.abs(dyQ8)
  const ex = Math.max(0, G.hx - G.rc), ey = Math.max(0, G.hy - G.rc)
  const qx = Math.max(ax - ex, 0), qy = Math.max(ay - ey, 0)
  const hq = rectArcQ8(G.rc, 180)                          /* 直角弧长 = 中心线圆角的 π/2 弧 */
  if (G.rc > 0 && qx > 0 && qy > 0) {                      /* 四个角弧 */
    const arc = rectArcQ8(G.rc, ringAtanUQ8(qy, qx, rectAtanTables(G)))
    if (dxQ8 >= 0 && dyQ8 < 0) return ex + (hq - arc)                                    /* 右上 */
    if (dxQ8 >= 0)             return ex + hq + 2 * ey + arc                             /* 右下 */
    if (dyQ8 >= 0)             return ex + 2 * hq + 2 * ey + 2 * ex + (hq - arc)         /* 左下 */
    return ex + 3 * hq + 2 * ey + 2 * ex + 2 * ey + arc                                  /* 左上 */
  }
  /* 直边: 取四条边里垂足最近的那条。d2 用 Q8>>2 尺度比较 —— 板子那边是 32 位乘加,
   * 不缩放在 320 宽的屏上会溢出 (差 4 个 Q8 单位 = 0.016px 的近似平局对 s 没有可见影响)。 */
  const px = Math.max(-ex, Math.min(ex, dxQ8))
  const py = Math.max(-ey, Math.min(ey, dyQ8))
  const h = (v) => Math.abs(v) >> 2
  const cand = [
    { d2: h(dxQ8 - px) ** 2 + h(dyQ8 + G.hy) ** 2, s: px >= 0 ? px : G.per + px },
    { d2: h(dxQ8 - px) ** 2 + h(dyQ8 - G.hy) ** 2, s: ex + 2 * hq + 2 * ey + (ex - px) },
    { d2: h(dxQ8 - G.hx) ** 2 + h(dyQ8 - py) ** 2, s: ex + hq + (py + ey) },
    { d2: h(dxQ8 + G.hx) ** 2 + h(dyQ8 - py) ** 2, s: ex + 3 * hq + 2 * ey + 2 * ex + (ey - py) },
  ]
  let best = cand[0]
  for (const c of cand) if (c.d2 < best.d2) best = c
  return best.s                                             /* 各分支天然落在 [0, per), 不用取模 */
}

/** 周长参数 s (Q8) → 等效角 aU (0..719, 0.5° 单位): aU = s·720/per (乘法, 无除法) */
export function ringRectAngleU(sQ8, G) {
  if (!G.per) return 0
  let a = (sQ8 * G.invPer) >> 16      /* 乘法代替除法: a ≈ s·720/per */
  if (a >= 720) a = 719               /* invPer 取整会让"最后一格"算出 720 → 夹住, 免得绕回 0 */
  if (a < 0) a = 0
  return a
}

/** 周长位置 t (0..1) → 中心线上的点 { x, y } (端帽圆心 / 弧端点用) */
export function ringRectPointAt(t, hx, hy, rc) {
  const { r, ex, ey, per, q } = rectGeom(hx, hy, rc)
  let s = ((((t % 1) + 1) % 1) * per)
  if (s <= ex) return { x: s, y: -hy }
  s -= ex
  if (r > 1e-9 && s <= q) { const th = s / r; return { x: ex + r * Math.sin(th), y: -ey - r * Math.cos(th) } }
  s -= q
  if (s <= 2 * ey) return { x: hx, y: -ey + s }
  s -= 2 * ey
  if (r > 1e-9 && s <= q) { const th = s / r; return { x: ex + r * Math.cos(th), y: ey + r * Math.sin(th) } }
  s -= q
  if (s <= 2 * ex) return { x: ex - s, y: hy }
  s -= 2 * ex
  if (r > 1e-9 && s <= q) { const th = s / r; return { x: -ex - r * Math.sin(th), y: ey + r * Math.cos(th) } }
  s -= q
  if (s <= 2 * ey) return { x: -hx, y: ey - s }
  s -= 2 * ey
  if (r > 1e-9 && s <= q) { const th = s / r; return { x: -ex - r * Math.cos(th), y: -ey - r * Math.sin(th) } }
  s -= q
  return { x: -ex + s, y: -hy }
}

/** 周长参数 s (Q8) → 中心线上的点 (Q8, 相对中心): ringRectPathSQ8 的逆 (端帽圆心用)。
 *  只在参数更新时调用 (每帧不跑), 所以允许取模/查 cos 表。与固件 ring_rect_point_q8() 同式。 */
export function ringRectPointAtQ8(sQ8, G) {
  const { hx, hy, rc } = G
  const ex = Math.max(0, hx - rc), ey = Math.max(0, hy - rc)
  const hq = rectArcQ8(rc, 180)
  /* 弧长 → 角度 (0.5° 单位): θU = s·180/hq。只在参数更新时调用, 用真除法最准;
   * 固件那一侧 hq 是编译期常数 → armcc 会把 /hq 编成乘法, 两端同式同值。 */
  const at = (s) => rectUnitQ14(hq > 0 ? Math.floor((s * 180) / hq) : 0)
  let s = ((sQ8 % G.per) + G.per) % G.per
  if (s <= ex) return { x: s, y: -hy }                        /* 顶边右半 (s = x) */
  s -= ex
  if (rc > 0 && s <= hq) { const [c, sn] = at(s); return { x: ex + ((rc * sn) >> 14), y: -ey - ((rc * c) >> 14) } }
  s -= hq
  if (s <= 2 * ey) return { x: hx, y: -ey + s }               /* 右边 */
  s -= 2 * ey
  if (rc > 0 && s <= hq) { const [c, sn] = at(s); return { x: ex + ((rc * c) >> 14), y: ey + ((rc * sn) >> 14) } }
  s -= hq
  if (s <= 2 * ex) return { x: ex - s, y: hy }                /* 底边 (从右往左) */
  s -= 2 * ex
  if (rc > 0 && s <= hq) { const [c, sn] = at(s); return { x: -ex - ((rc * sn) >> 14), y: ey + ((rc * c) >> 14) } }
  s -= hq
  if (s <= 2 * ey) return { x: -hx, y: ey - s }               /* 左边 (从下往上) */
  s -= 2 * ey
  if (rc > 0 && s <= hq) { const [c, sn] = at(s); return { x: -ex - ((rc * c) >> 14), y: -ey - ((rc * sn) >> 14) } }
  s -= hq
  return { x: -ex + s, y: -hy }                               /* 顶边左半 (s = per + x) */
}

/** 进度弧的整数参数 (每实例每帧算一次): 弧区间 + 两个端帽圆心 (半像素整数) */
export function ringRectArcGeom(G, r) {
  /* 起始角: startDeg 与圆环同一约定 (0 = 正右, 顺时针为正), 而 aU 的 0 在**顶边中点**
   * → 差 180 个 0.5° 单位 (固件那一侧: startU = (ring.arcStart + 180) mod 720) */
  const startU = (((Math.round((r.startDeg ?? -90) * 2) + 180) % 720) + 720) % 720
  const steps = Math.max(1, r.steps || 40)
  /* 弧度范围与圆环同一口径: 整圈 720 / 部分弧 = 起始→结束的正向跨度 */
  const rangeU = ringArcRange(r).rangeU
  const sweepU = Math.min(rangeU, Math.round(((r.value ?? 0) * rangeU) / steps))
  const dirSign = (r.arcDir ?? 1) < 0 ? -1 : 1
  const capsOn = !!r.caps && sweepU > 0 && (rangeU < 720 ? sweepU <= rangeU : sweepU < 720)
  const trackCapsOn = !!r.caps && rangeU < 720
  const aa2 = 2 * Math.max(1, Math.round(G.aa / 256))          /* AA 宽 (半像素整数), 与圆环同式 */
  const capR = (G.ht * 2 + 128) >> 8                           /* 端帽半径 = 环厚 (半像素整数) */
  const sOf = (aU) => Math.floor((aU * G.per + 360) / 720)     /* aU → s (Q8), 只在更新时算 */
  const s0 = sOf(startU)
  const s1 = sOf((((startU + dirSign * sweepU) % 720) + 720) % 720)
  const sR = sOf((((startU + dirSign * rangeU) % 720) + 720) % 720)
  const p0 = ringRectPointAtQ8(s0, G), p1 = ringRectPointAtQ8(s1, G), pR = ringRectPointAtQ8(sR, G)
  const hp = (v) => Math.round(v / 128)                        /* Q8 → 半像素整数 (与圆环同尺度) */
  /* 弧区间用**路径长度** (sweepS) 而不是等效角: s 的量化是 1/256px (等效角是 ~1.2px/格),
   * 而且镜像时 per−s 严格对称 —— 起始角在正上方时顺/逆时针能逐像素互为镜像。
   * 白斑仍旧用等效角 aU (增益表按 0.5° 索引)。
   * 拖尾长度 (tailS) 与 sweepS 同一换算: 固件按时间算 (RINGUI_TAIL_MS), 网页直接给等效长度。
   * 整圈 (sweepU=720) 不生效 (没有"末端"); 上界夹到 sweepS (全弧都是尾巴 = 整条渐隐)。 */
  const sweepS = Math.floor((sweepU * G.per + 360) / 720)
  const rangeS = Math.floor((rangeU * G.per + 360) / 720)
  const tailUi = Math.max(0, Math.min(720, Math.round(r.tailU ?? 0)))
  /* 拖尾恒为设计长度, 不再夹到 sweepS (固件 2026-10-15 同款): 夹短会把
   * 渐变外沿钉在弧端固定位置, 收尾到帽区时看起来先停住、再突然刷掉一块。
   * 弧比拖尾还短时整段都渐隐, 起点帽由 ringRectArcW 按 capScale 缩半径。 */
  const tailS = (tailUi > 0 && sweepU < 720)
    ? Math.floor((tailUi * G.per + 360) / 720) : 0
  /* 起点帽的支撑比例: 剩余路径不足帽半径时帽盘缩成一个点, 长到 2 倍帽半径时整盘回来 */
  const capScale = (r.effect === 'countdown' && tailS > 0)
    ? Math.max(0, Math.min(1, (sweepS / 128 - capR) / capR)) : 1
  /* 起点切向 (半像素单位): 端帽收尾时用它把帽盘切成沿轨迹的一条 */
  const p0b = ringRectPointAtQ8(s0 + 1, G)
  const tvx = (p0b.x - p0.x) / 128, tvy = (p0b.y - p0.y) / 128
  const tvl = Math.hypot(tvx, tvy) || 1
  return { startU, rangeU, rangeS, sweepU, sweepS, tailS,
           sStart: s0, sRangeEnd: sR, per: G.per, dirSign, capsOn, trackCapsOn,
           aa2, capR, capR2: capR * capR, capIn2: Math.max(0, capR - aa2) ** 2, capScale,
           t0x: tvx / tvl, t0y: tvy / tvl,
           c0x: hp(p0.x), c0y: hp(p0.y), c1x: hp(p1.x), c1y: hp(p1.y),
           cRx: hp(pR.x), cRy: hp(pR.y) }
}

/** 端帽权重 0..255 (半像素整数距离; 与固件 isqrt 口径一致) */
function rectCapW(dx, dy, AG, ccx, ccy) {
  const ax = 2 * dx - ccx, ay = 2 * dy - ccy
  const d2 = ax * ax + ay * ay
  if (d2 >= AG.capR2) return 0
  if (d2 <= AG.capIn2) return 255
  const d = Math.floor(Math.sqrt(d2))                      /* 半像素距离 (floor = 固件 isqrt) */
  const v = Math.trunc(((AG.capR - d) * 255) / (AG.aa2 || 1))
  return v < 0 ? 0 : (v > 255 ? 255 : v)
}

/** 起点帽按支撑比例缩小半径后的权重 0..255: 仍是圆头, 不做半帽/弦切。
 *  scale=0 → 0; scale=1 时与 rectCapW 同值。 */
function rectCapWScaled(dx, dy, AG, ccx, ccy, scale) {
  if (!(scale > 0)) return 0
  const r = AG.capR * scale
  const r2 = r * r
  const ax = 2 * dx - ccx, ay = 2 * dy - ccy
  const d2 = ax * ax + ay * ay
  if (d2 >= r2) return 0
  const aa = Math.max(1, AG.aa2 * scale)
  const inR = Math.max(0, r - aa)
  if (d2 <= inR * inR) return 255
  const d = Math.floor(Math.sqrt(d2))
  const v = Math.trunc(((r - d) * 255) / aa)
  return v < 0 ? 0 : (v > 255 ? 255 : v)
}

/** 像素的进度弧填充权重 0..255 (含两端圆帽 AA) —— 与固件 ring_rect_arc_w() 逐位同式。
 *  arc 归属在**路径位置 s** 上判 (不是等效角): 量化更细, 且镜像严格对称。 */
export function ringRectArcW(sQ8, dx, dy, AG) {
  if (AG.sweepU === 0) return 0
  if (AG.rangeU >= 720 && AG.sweepU >= 720) return 255
  let rel = AG.dirSign > 0 ? sQ8 - AG.sStart : AG.sStart - sQ8
  if (rel < 0) rel += AG.per
  let w = 0
  if (rel <= AG.sweepS) {
    /* 拖尾 (扫把): 弧末端 tailS 内权重沿路径线性递减 —— 固件 bsp_ring.c ring_rect_arc_w
     * 的拖尾分支同一条整数式 v = back*255/tailS (0 = 末端 .. 255 = 拖尾起端)。
     * tailS = 0 时走不到这一支, 与旧式逐位一致 (对拍脚本不受影响)。 */
    if (AG.tailS > 0 && rel > AG.sweepS - AG.tailS) {
      const v = Math.trunc(((AG.sweepS - rel) * 255) / AG.tailS)
      w = v < 0 ? 0 : (v > 255 ? 255 : v)
    } else {
      w = 255
    }
  }
  if (!AG.capsOn) return w
  /* 端帽对**盘内所有像素**生效 (不再要求弧外): 帽是实体圆头, 拖尾的渐隐
   * 不许吃掉它 —— 这是收尾到帽区时不出现"断开/两片"的唯一正确办法。
   * 盘外仍按拖尾/平头取值, 所以渐变外沿 = 弧端 + 设计拖尾, 随进度连续移动。 */
  const test = (ccx, ccy) => {
    const cw = rectCapW(dx, dy, AG, ccx, ccy)
    if (cw > w) w = cw
  }
  if (AG.tailS > 0) {
    /* 起点帽: 按支撑比例连续缩小半径 (仍是圆头), 不是沿轨迹切一半 */
    const cw = rectCapWScaled(dx, dy, AG, AG.c0x, AG.c0y, AG.capScale)
    if (cw > w) w = cw
  } else {
    test(AG.c0x, AG.c0y)
    test(AG.c1x, AG.c1y)   /* 无拖尾: 两端都是实体圆帽 */
  }
  return w
}

/** 端帽覆盖权重 0..255 (矩形版; 拖尾时只算起点帽, 沿轨迹擦除)。 */
export function ringRectCapW(dx, dy, AG) {
  if (!AG.capsOn) return 0
  let w = AG.tailS > 0
    ? rectCapWScaled(dx, dy, AG, AG.c0x, AG.c0y, AG.capScale)
    : rectCapW(dx, dy, AG, AG.c0x, AG.c0y)
  if (AG.tailS === 0) {
    const e = rectCapW(dx, dy, AG, AG.c1x, AG.c1y)
    if (e > w) w = e
  }
  return w
}

/** 轨道权重 0..255 (部分弧): 范围内的整条路径 + 两端圆帽。整圈 → 255 (旧行为不变)。 */
export function ringRectTrackW(sQ8, dx, dy, AG) {
  if (AG.rangeU >= 720) return 255
  let rel = AG.dirSign > 0 ? sQ8 - AG.sStart : AG.sStart - sQ8
  if (rel < 0) rel += AG.per
  if (rel <= AG.rangeS) return 255
  if (!AG.trackCapsOn) return 0
  let w = 0
  const test = (ccx, ccy) => { const cw = rectCapW(dx, dy, AG, ccx, ccy); if (cw > w) w = cw }
  test(AG.c0x, AG.c0y)
  if (AG.tailS === 0) test(AG.cRx, AG.cRy)   /* 拖尾: 末端交给渐变, 不画轨道端帽 */
  return w
}

/** 白斑增益 0..255: 用等效角 aU 直接查板子那张增益表 (矩形不需要逐像素 atan2)。
 *  aU 的 0 在顶边中点, 而 glintDeg 与圆环同一约定 (0 = 正右) → 差 180 个 0.5° 单位。 */
export function ringRectGain8(aU, glintDeg, spanU, tb) {
  const gU = ((((Math.round(glintDeg ?? 0) * 2) + 180) % 720) + 720) % 720
  let d = aU - gU
  if (d > 360) d -= 720
  if (d < -360) d += 720
  const ad = d < 0 ? -d : d
  return ad <= spanU ? tb.gain[ad] : 0
}

/** 预览动效开关 → { arc, glint } (两个独立开关; 纯函数, 自检直接测):
 *   autoArc   「自动动画」  : 进度值 0→档位 循环扫 (网页预览)
 *   autoGlint 「光斑动画」  : 白斑沿路径转 (网页预览)
 * 老工程兼容: 只存了 autoGlint (当初"一个开关管两件事"那版) → 当成两个都开;
 * 想只开一个: 在弹窗里各勾一次 (会写全两个字段)。 */
export function ringAnimFlags(r) {
  const legacyBoth = r && r.autoArc === undefined && r.autoGlint === true
  const countdown = !!(r && r.effect === 'countdown')
  return { arc: countdown || legacyBoth || !!(r && r.autoArc), glint: legacyBoth || !!(r && r.autoGlint) }
}

/* 运行时动画 (非响应式, 不触发持久化 —— 否则 100ms 突变会永久压制 400ms 防抖保存)
 *   animAngles: 白斑相位 (度)   animArcs: 进度动画值 (档位, 只影响显示, 不改导出值) */
const animAngles = new Map()
const animArcs = new Map()
export function setRingAnimAngle(id, deg) { animAngles.set(id, deg) }
export function getRingAnimAngle(id, fallback = 0) { return animAngles.has(id) ? animAngles.get(id) : fallback }
export function setRingAnimValue(id, v) { animArcs.set(id, v) }
export function getRingAnimValue(id, fallback = 0) { return animArcs.has(id) ? animArcs.get(id) : fallback }
export function dropRingAnim(id) { animAngles.delete(id); animArcs.delete(id) }

/* 板子的径向覆盖率表 (gen_tables.py 同一公式, 按参数缓存一次):
 *   i = (r² − R_IN²) >> 5,  cov = clamp(min(r+0.5−R_IN, R_OUT+0.5−r)/AA, 0, 1) × 255
 * 板子 ring_cov() 就是查这张表; 「与 MCU 同步预览」必须查同一张, 否则带边 AA 深浅对不上。 */
const covTableCache = new Map()
function ringCovTable(rIn, rOut, aa) {
  const key = rIn + '|' + rOut + '|' + aa
  let t = covTableCache.get(key)
  if (t) return t
  const rInI = Math.round(rIn), rOutI = Math.round(rOut)
  const n = ((rOutI * rOutI - rInI * rInI) >> 5) + 2
  t = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(rInI * rInI + i * 32)
    let v = Math.min(r + 0.5 - rInI, rOutI + 0.5 - r) / aa
    v = v < 0 ? 0 : (v > 1 ? 1 : v)
    t[i] = Math.round(v * 255)
  }
  covTableCache.set(key, t)
  return t
}
export function ringCovAt(r2, rIn, rOut, aa) {
  const t = ringCovTable(rIn, rOut, aa)
  const rInI = Math.round(rIn)
  let i = (r2 - rInI * rInI) >> 5
  if (i < 0) i = 0
  if (i >= t.length) i = t.length - 1
  return t[i]
}

/* ============================================================
 *  板子的整数角度/增益链路 (「与 MCU 同步」时逐像素照抄, 目的就是位级一致):
 *    ringAtan2U()  = bsp_ring.c 的 ring_tab_atan2(): atan 表 + 倒数表, 0.5° 单位 0..719
 *    gain 表       = gen_tables.py 的高斯 + 最后 2° 锥形收尾
 *  板子上 M0+ 没除法器, 角度是"查表 + 乘法"算出来的, 与浮点 atan2 差最多 0.25°;
 *  在 ±span 硬截断那一圈就会一个像素差一级颜色 —— 想"预览即板子"就得连这个也照抄。
 * ============================================================ */
const tabCache = new Map()
export function ringTables(sigmaDeg, spanDeg, rOut) {
  const key = sigmaDeg + '|' + spanDeg + '|' + rOut
  let t = tabCache.get(key)
  if (t) return t
  const atanTab = new Int32Array(257)
  for (let i = 0; i <= 256; i++) atanTab[i] = Math.round(Math.atan(i / 256) * 180 / Math.PI * 2)
  const recipN = Math.round(rOut) + 12
  const recip = new Int32Array(recipN)
  for (let n = 1; n < recipN; n++) recip[n] = Math.min(65535, Math.round(65536 / n))
  const nGain = Math.round(spanDeg * 2) + 1
  const gain = new Int32Array(nGain)
  for (let i = 0; i < nGain; i++) {
    gain[i] = Math.round(255 * Math.exp(-((i * 0.5) ** 2) / (2 * sigmaDeg * sigmaDeg)))
  }
  const taper = 4                                   /* 最后 2° 线性压到 0 (gen_tables.py 同) */
  if (taper > 1) {
    for (let k = 0; k < taper; k++) {
      const i = nGain - taper + k
      if (i >= 0 && i < nGain) gain[i] = Math.round(gain[i] * (taper - 1 - k) / (taper - 1))
    }
  }
  t = { atanTab, recip, recipN, gain, nGain }
  tabCache.set(key, t)
  return t
}

/* 整数 atan2 → 0.5° 单位 (0..719), 与 ring_tab_atan2() 逐行同式 */
function ringAtan2U(dy, dx, tb) {
  const ax = dx < 0 ? -dx : dx
  const ay = dy < 0 ? -dy : dy
  if (ax === 0 && ay === 0) return 0
  let b, phi
  if (ay <= ax) {
    const maj = ax < tb.recipN ? ax : tb.recipN - 1
    let t = (ay * tb.recip[maj]) >> 8
    if (t > 256) t = 256
    b = tb.atanTab[t]
    phi = b
  } else {
    const maj = ay < tb.recipN ? ay : tb.recipN - 1
    let t = (ax * tb.recip[maj]) >> 8
    if (t > 256) t = 256
    b = tb.atanTab[t]
    phi = 180 - b
  }
  if (dx < 0) phi = 360 - phi
  if (dy < 0) phi = -phi
  phi += 720
  if (phi >= 720) phi -= 720
  if (phi >= 720) phi -= 720
  return phi
}

/* ============================================================
 *  立体感 (仅网页预览, 板子那支只有平色): 把环带断面当成半根圆柱 —— 断面法线随"离中心线的位置"转,
 *  再和方向光点乘, 高光自然落在光来的那一侧; 圆角矩形的直边/拐角因为 φ 不同,
 *  高光走向会跟着拐 (这就是"高光位置不一样"的来源)。
 *    u   = 有符号距离 / 半厚 (-1 内沿 .. +1 外沿)
 *    psi = u · 90°   断面法线角 (外沿朝外, 内沿朝内)
 *    n   = (sinψ·cosφ, sinψ·sinφ, cosψ)
 *    lum = n · L    (L = 方位角 lightA + 固定仰角)
 *  返回 -1..1: >0 往白提亮, <0 往黑压暗。
 *  ============================================================ */
function shadeFactor(u, phi, style, lightA, strength) {
  if (!(strength > 0)) return 0
  const psi = Math.max(-1, Math.min(1, u)) * (Math.PI / 2)
  const cp = Math.cos(psi), sp = Math.sin(psi)
  const Lx = Math.cos(lightA), Ly = Math.sin(lightA), Lz = 1.0     /* 仰角 45° */
  const nrm = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz)
  const cross = cp * (style === 'groove' ? -1 : 1)                 /* 凹陷 = 断面反过来 */
  const dir = sp * (Lx * Math.cos(phi) + Ly * Math.sin(phi))       /* 径向分量 */
  const lum = (Lz * cross + dir) / nrm
  return Math.max(-1, Math.min(1, lum)) * strength * 0.6           /* 0.6: 别把颜色打到死白/死黑 */
}

/* 板子的立体感断面表 (gen_tables.py 同一公式, 按参数缓存):
 *   索引 i = (r² − R_IN²) >> 5, r = sqrt(R_IN² + i·32), u = (r − 中径)/半厚 → ψ = u·90°
 *   A[i] = cosψ·样式·强度·0.6·归一化 (Q8)   B[i] = sinψ·同系数 (Q8)
 *   Nx[i] = 65536·Lx/r, Ny[i] = 65536·Ly/r (Q16) —— 逐像素算径向分量用, 无除法无开方 */
const shadeTableCache = new Map()
function ringShadeTables(rIn, rOut, depth, style, lightDeg) {
  const key = [rIn, rOut, depth, style, lightDeg].join('|')
  let t = shadeTableCache.get(key)
  if (t) return t
  const rInI = Math.round(rIn), rOutI = Math.round(rOut)
  const n = ((rOutI * rOutI - rInI * rInI) >> 5) + 2
  const strength = Math.max(0, Math.min(100, depth)) / 100
  const sgn = style === 'groove' ? -1 : 1
  const la = (lightDeg * Math.PI) / 180
  const Lx = Math.cos(la), Ly = Math.sin(la), Lz = 1
  const invN = 1 / Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz)
  const rMid = 0.5 * (rIn + rOut), halfT = Math.max(0.5, 0.5 * (rOut - rIn))
  const A = new Int16Array(n), B = new Int16Array(n), Nx = new Int16Array(n), Ny = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(rInI * rInI + i * 32)
    const u = Math.max(-1, Math.min(1, (r - rMid) / halfT))
    const psi = (u * Math.PI) / 2
    const k = strength * 0.6 * invN
    A[i] = Math.round(Math.cos(psi) * sgn * k * 256)
    B[i] = Math.round(Math.sin(psi) * k * 256)
    Nx[i] = Math.round((65536 * Lx) / r)
    Ny[i] = Math.round((65536 * Ly) / r)
  }
  t = { A, B, Nx, Ny, n }
  shadeTableCache.set(key, t)
  return t
}

/* 同步模式的立体感: 与板子 ring_shade() 逐位同式 (查表 + 乘加, Q8), 返回混合后的 RGB565 */
function ringShade565(col, r2, dx, dy, tb, rIn, dth) {
  const rInI = Math.round(rIn)
  let i = (r2 - rInI * rInI) >> 5
  if (i < 0) i = 0
  if (i >= tb.n) i = tb.n - 1
  const t = ((tb.Nx[i] * dx + tb.Ny[i] * dy) >> 8)
  let k = tb.A[i] + ((tb.B[i] * t) >> 8)
  if (k > 255) k = 255
  if (k < -255) k = -255
  if (k > 0) return mix565(col, 0xFFFF, k, dth)
  if (k < 0) return mix565(col, 0x0000, -k, dth)
  return col
}

/* ============================================================
 *  圆角矩形环的立体感 —— 与圆环**同一套断面光照**, 只把"径向"换成"带宽方向":
 *    · 断面参数 = 离外边界的深度 d (Q8): 表按 2×半厚 预烘 → u = (d − ht)/ht ∈ [−1,1],
 *      ψ = u·90° (半圆柱断面), A[i] = cosψ·sgn·k, B[i] = sinψ·k  (k = 强度×0.6/|L|)
 *    · 光在屏幕面内的分量 L 投影到**该像素处带边界的单位外法线** n̂ 上:
 *      t = 256·(L·n̂) = (Nx·n̂x + Ny·n̂y) >> 16,  Nx/Ny = Lx/Ly (Q16)
 *      —— 圆环那边除以像素自身半径得到 n̂, 这里 n̂ 由圆角矩形几何直接给出
 *    · k = A[i] + (B[i]·t)>>8 ∈ [−256,256]: k>0 往白提亮, k<0 往黑压暗
 * 与 gen_tables.py 的矩形断面表、bsp_ring.c 的 ring_rect_shade() 同式 (对拍逐像素比)。
 * ============================================================ */
export const RECT_SHADE_SHIFT = 5                  /* 断面表一档 = 32/256 px = 1/8 px */
export function ringRectShadeTables(htQ8, depth, style, lightDeg) {
  const key = ['rect', htQ8, depth, style, lightDeg].join('|')
  let t = shadeTableCache.get(key)
  if (t) return t
  const half = Math.max(32, htQ8)                  /* 半厚 (Q8), 至少 1/8 px 免得表退化成 1 格 */
  const strength = Math.max(0, Math.min(100, depth)) / 100
  const sgn = style === 'groove' ? -1 : 1
  const la = (lightDeg * Math.PI) / 180
  const Lx = Math.cos(la), Ly = Math.sin(la), Lz = 1
  const invN = 1 / Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz)
  const k = strength * 0.6 * invN
  const n = ((2 * half) >> RECT_SHADE_SHIFT) + 2
  const A = new Int16Array(n), B = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const d = i << RECT_SHADE_SHIFT
    const u = Math.max(-1, Math.min(1, (d - half) / half))
    const psi = (u * Math.PI) / 2
    A[i] = Math.round(Math.cos(psi) * sgn * k * 256)
    B[i] = Math.round(Math.sin(psi) * k * 256)
  }
  t = { A, B, n, Nx: Math.round(65536 * Lx), Ny: Math.round(65536 * Ly) }
  shadeTableCache.set(key, t)
  return t
}

/** 像素 (dx,dy) 处带边界的**单位外法线** (Q8, 256 = 1): 直边段是轴向, 角上从角心放射。
 *  圆角矩形是凸的 → 外法线只需看外框; 与固件 ring_rect_normal() 同式。 */
export function ringRectNormalQ8(dxQ8, dyQ8, G) {
  const ax = Math.abs(dxQ8), ay = Math.abs(dyQ8)
  const ex = G.oHx - G.oRc, ey = G.oHy - G.oRc
  const sx = dxQ8 < 0 ? -1 : 1, sy = dyQ8 < 0 ? -1 : 1
  if (G.oRc > 0 && G.invORc > 0 && ax > ex && ay > ey) {
    const rx = (ax - ex) * sx, ry = (ay - ey) * sy
    return { nx: (rx * G.invORc) >> 8, ny: (ry * G.invORc) >> 8 }
  }
  if (ax > ex) return { nx: 256 * sx, ny: 0 }
  return { nx: 0, ny: 256 * sy }
}

/** 同步模式的立体感 (圆角矩形): dQ8 = 离外边界的深度 (Q8, 0..2×半厚), n̂ = 单位外法线 (Q8) */
export function ringRectShade565(col, dQ8, nx, ny, tb, dth) {
  let i = dQ8 >> RECT_SHADE_SHIFT
  if (i < 0) i = 0
  if (i >= tb.n) i = tb.n - 1
  const t = ((tb.Nx * nx) + (tb.Ny * ny)) >> 16
  let k = tb.A[i] + ((tb.B[i] * t) >> 8)
  if (k > 255) k = 255
  if (k < -255) k = -255
  if (k > 0) return mix565(col, 0xFFFF, k, dth)
  if (k < 0) return mix565(col, 0x0000, -k, dth)
  return col
}

/* 相对起始角的位置 (0..2π), 已按方向翻好符号。
 *
 * 为什么不能只写 `while (rel < 0) rel += 2π`:
 *   起始角是**度**直接转弧度的 (可能写成 225° = 3.93rad, 而 atan2 给出的角在 (-π, π]),
 *   于是 (a - startA) 能到 ±7rad; 逆时针再乘 -1 就成了 +395° 这种 > 2π 的值,
 *   `while (rel < 0)` 拦不住, 紧接着那句"起始边界: 2π 回绕成 0"就把它当成 0 = 弧内
 *   → 起始角前那一整块楔形被误填 (用户报的: 逆时针预览有问题, 看着像圆帽画反了)。
 * 用 floor 取模兜住任意大小/正负的输入。 */
function relAngle(a, startA, dir) {
  let rel = (a - startA) * dir
  rel -= Math.PI * 2 * Math.floor(rel / (Math.PI * 2))
  if (rel >= Math.PI * 2 - 1e-9) rel = 0
  return rel
}

export function drawRing(ctx, inst, opts = {}) {
  const r = inst.ring
  if (!r) return
  /* 边缘 AA 往"页面底色"淡出: 底色 = 屏幕预设的「背景色」(缺省黑)。opts.bg 不传 = 0,
   * 与老行为逐像素一致 (check-ringseg / check-mcu-parity 的对拍基准就是黑底)。 */
  const bg565 = (Number(opts.bg) || 0) & 0xFFFF
  const segG = ringSegGeom(r)
  const w = Math.max(2, Math.round(inst.w)), h = Math.max(2, Math.round(inst.h))
  const img = ctx.createImageData(w, h)
  const d = img.data
  const aa = Math.max(0.5, r.aa || 2)        // 边缘 AA 宽度 (px), 可调增强
  /* 弧两端平口的角向 AA 宽度 (px): **一个值管两端** (沟槽另有 r.segAA)。
   *   aaEdge 缺省 = 2px (与旧行为一致); 0 = 端点硬边。
   *   只在「平口」(caps=false) 生效, 端帽是圆头, 不需要端面斜坡。
   * 与段/缝的「沟槽 AA」(r.segAA) 分开: 用户要的是"沟槽与端点"两类, 不是左右两端。 */
  const endAA = (v) => {
    const x = Number(v)
    return (v === null || v === undefined || !Number.isFinite(x)) ? 2 : Math.max(0, Math.min(6, x))
  }
  const aaEdgePx = endAA(r.aaEdge ?? r.aaStart ?? r.aaEnd)
  /* 「留边」(总, px): 环带外沿离图层外框的余量 —— 圆角矩形在 ringRectGeom() 里扣,
   * 圆环在这里扣: 整条带向内收 inset/2, **厚度不变** (内外径一起挪)。
   * 不扣的话外沿正好压在圆屏可用圆上, 圆屏 mask/AA 会把外圈切出锯齿。 */
  const insetPx = ringInsetPx(r)
  const rOut = Math.max(1, (r.rOut ?? 2) - insetPx / 2)
  const rIn = Math.max(0, Math.min((r.rIn ?? 0) - insetPx / 2, rOut - 1))

  /* 形状: 'rect' = 圆角矩形环 (板子 RING_SHAPE=1 同一套整数几何, 也能"与 MCU 同步") */
  const isRect = r.shape === 'rect'
  /* 「与 MCU 同步」= 走板子上那条整数路径 (逐像素对拍脚本 scripts/check-mcu-parity.mjs 验它)。
   * 圆心也必须跟导出/固件同一个取整规则: 导出写的是 floor(x + (w-1)/2) = floor((w-1)/2)
   * (240 屏 = 119, 固件 RING_CX=119) —— 理想预览才用真正的中点 119.5。 */
  const rectSync = isRect && r.syncMcU !== false
  const mcuSync = r.syncMcU !== false && !isRect
  const cx = (mcuSync || rectSync) ? Math.floor((w - 1) / 2) : (w - 1) / 2
  const cy = (mcuSync || rectSync) ? Math.floor((h - 1) / 2) : (h - 1) / 2
  const rg = ringRectGeom(w, h, r)
  const { hx, hy, ht } = rg                                        // 中心线半宽/半高, 半环厚
  const rrc = rg.rc                                               // 中心线圆角半径 (内外圆角的中值)
  const rectG = rg
  const arcDir = (r.arcDir ?? 1) < 0 ? -1 : 1     // 进度递增方向: +1 顺时针 (默认) / -1 逆时针
  /* 拖尾 (0.5° 单位, 0 = 关): 弧末端渐隐 —— 与固件进度弧的「扫把拖尾」同一条线性式。
   * 网页由 effect/tailMs 驱动; 导出 RING_ARC_TAIL_MS_DEF 是设计记录,
   * 固件倒计时实际仍用 app_ring_ui.c 的 RINGUI_TAIL_MS 自行算长度。 */
  const tailU = ringTailU(r)
  /* 弧度范围: null = 整圈; 数值 = 起始角→结束角的部分弧。
   * track (轨道) 只画在范围内, 范围外完全透明 —— 整圈时 rangeU=720, 下面所有分支退化成旧行为。 */
  const range = ringArcRange(r)
  const rangeRad = (range.spanDeg * Math.PI) / 180
  const rangeU = range.rangeU
  /* 矩形周长等效角的 0 在顶边中点 (见 ringRectArcGeom 的 startU):
   * 与 startDeg (0 = 正右) 差 180 个 0.5° 单位。渐变位置用它反推。 */
  const rectStartU720 = (((Math.round((r.startDeg ?? -90) * 2) + 180) % 720) + 720) % 720

  const track = rgb565To888((r.trackColor ?? 0x6B4D) & 0xFFFF)
  const fill = rgb565To888((r.fillColor ?? 0x07FF) & 0xFFFF)
  /* 网页渐变: 每条颜色轨道各自一组停靠点; 没配渐变时 trackGrad/fillGrad 为 null,
   * 下面的取色与旧路径逐像素等价 (导出仍是单色, 见 store.js)。 */
  const trackGrad = ringGradStops(r.trackGrad)
  const fillGrad = ringGradStops(r.fillGrad)
  const gradOn = !!(trackGrad || fillGrad)
  const steps = Math.max(1, r.steps || 40)
  /* 两个预览动效开关 (都只在网页起作用, 导出 ring_config.h 用的始终是 r.value 设计值):
   *   autoArc   = 「自动动画」  进度值 0→档位 循环扫
   *   autoGlint = 「光斑动画」  白斑沿路径转
   * 看 ringAnimFlags() (纯函数, 自检直接测它) */
  const anim = ringAnimFlags(r)
  /* 设计值已经是满档 (value = steps) 时直接画满环, 不让「自动动画」的 0→满扫循环
   * 把它在某几帧覆盖成 0 (用户现场: 预览位置 35/35 时圆环会闪没)。 */
  const designFull = (Number(r.value) || 0) >= steps
  const valueNow = designFull ? steps : (anim.arc ? getRingAnimValue(inst.id, r.value ?? 0) : (r.value ?? 0))
  /* 档位 → 填充末端: 与固件 Ring_SegSweep() 同源。
   * lit = round(value×N/steps); fillEnd = lit×P − gap×(10−split)/10 (split 0..10),
   * 再按固件的 0.5° 网格向上取整 (ceil)。不开分割时退回线性 value/steps。 */
  let thetaP
  if (segG) {
    const lit = Math.max(0, Math.min(segG.N, Math.round((valueNow / steps) * segG.N)))
    let units
    if (lit >= segG.N) {
      units = range.rangeU
    } else if (lit <= 0) {
      units = 0
    } else {
      /* 与导出/固件同一套整数网格: P/GAP 先按 0.0001° 导出精度, 再转 Q8;
       * fillEnd = lit×P − gap×(10−split)/10 (C 的整数除法 = floor)。
       * 最后按 Ring_SegSweep() 的 0.5° 向上取整。 */
      const pQ8 = Math.round((Math.round(segG.P * 10000) / 10000) * 256)
      const gQ8 = Math.round((Math.round(segG.gap * 10000) / 10000) * 256)
      const back = Math.floor((gQ8 * (10 - segG.split)) / 10)
      const endQ8 = lit * pQ8 - back
      units = Math.ceil(endQ8 / 128)
    }
    units = Math.max(0, Math.min(range.rangeU, units))
    thetaP = (units * 0.5 * Math.PI) / 180
  } else {
    thetaP = Math.min(1, Math.max(0, valueNow / steps)) * rangeRad
  }

  /* ---- 同步模式的整数几何: 与 MCU ring_arc_update()/ring_arc_w() 同一套 ----
   * 几何与逐像素权重见模块顶部的 ringArcGeom()/ringArcFillW() (纯函数, 可对拍) */
  const arcCfg = { rIn, rOut, aa, startDeg: r.startDeg, value: valueNow, steps: r.steps, caps: r.caps, arcDir, tailU, rangeU, effect: r.effect }
  const startA = ((r.startDeg ?? -90) * Math.PI) / 180

  const glintOn = !!r.glintOn
  /* 只有「光斑动画」开着才用动画相位: 关掉要马上回到设计角 glintDeg (否则会停在上次那一格) */
  const gDeg = (anim.glint && animAngles.has(inst.id)) ? animAngles.get(inst.id) : (r.glintDeg ?? 0)
  const gAngle = (gDeg * Math.PI) / 180
  const sigma = Math.max(1, r.glintSigma || 14) * Math.PI / 180
  /* 与 MCU 同步 (默认): 白斑高斯按 0.5° 量化查表 + 8bit 增益 + ±SPAN 硬截断,
   * 颜色走 RGB565 整数混合 + 8x8 Bayer 抖动 —— 预览即板子。
   * 关掉则回到旧的"理想"连续高斯 (仅作设计参考, 与板子有可见差异)。
   * 圆角矩形只能走理想路径 (MCU 引擎还不支持这个形状)。 */
  const sync = mcuSync   /* 逆时针板子也支持了 (RING_ARC_DIR_DEF / Ring_SetArcDir) → 一样走同步渲染 */
  const sigDeg = Math.max(1, r.glintSigma || 14)
  const spanDeg = Math.max(1, r.glintSpanDeg != null ? r.glintSpanDeg : Math.round(sigDeg * 3))
  const spanU = Math.round(spanDeg * 2)                       /* ±范围 (0.5° 单位) */
  const tb = sync ? ringTables(sigDeg, spanDeg, rOut) : null  /* 板子那两张表 (同步模式才建) */
  /* 圆角矩形环的板子同式整数链路: Q8 几何 + 弧参数 + 白斑增益表。
   * 「倒数表容量」用 ringRectTableR() —— 与导出宏 RING_R_OUT / gen_tables.py 同一公式。 */
  const rectGq = rectSync ? ringRectGeomQ8(w, h, r) : null
  const rectAG = rectSync ? ringRectArcGeom(rectGq, { ...r, value: valueNow, arcDir, tailU }) : null
  const tbRect = rectSync ? ringTables(sigDeg, spanDeg, ringRectTableR(rectGq)) : null
  /* 立体感 (只在网页预览, 不导出): depth = 强度 0..1, 0 = 平色 (与板子一致) */
  const depth = Math.max(0, Math.min(100, r.depth ?? 0)) / 100   /* 默认 0 = 平色 (老工程预览不受影响) */
  const depthStyle = r.depthStyle === 'groove' ? 'groove' : 'ridge'
  const lightA = ((r.lightDeg ?? -45) * Math.PI) / 180
  const rMidPx = (rIn + rOut) / 2, halfTPx = Math.max(0.5, (rOut - rIn) / 2)
  /* 立体感: 同步模式走板子的整数断面表; 理想模式用下面的浮点断面光照 */
  const shadeTab = (sync && depth > 0) ? ringShadeTables(rIn, rOut, r.depth ?? 0, depthStyle, r.lightDeg ?? -45) : null
  /* 圆角矩形的断面表 (同步模式 + 立体感开着才建): 按半厚 2×ht 预烘, 网页与板子同一张 */
  const shadeRect = (rectSync && depth > 0)
    ? ringRectShadeTables(rectGq.ht, r.depth ?? 0, depthStyle, r.lightDeg ?? -45) : null

  const caps = !!r.caps && thetaP > 0.001 && thetaP < Math.PI * 2 - 0.001
  /* 部分弧的「范围」两端也要有轨道圆头 (与同步模式的 trackCapsOn 同一口径):
   * 进度为 0 时只剩轨道, 关掉「与 MCU 同步」不能把两端画成方口。 */
  const rangeCapsOn = !!r.caps && rangeU < 720
  /* 端帽圆心 = 弧两端的中心线点 (圆形按半径算, 圆角矩形按周长位置算) */
  const capR = isRect ? ht : (rOut - rIn) / 2
  let stX, stY, endX, endY, rangeEndX, rangeEndY
  if (isRect) {
    const t0 = (((r.startDeg ?? -90) + 90) / 360 + 1) % 1
    const p0 = ringRectPointAt(t0, hx, hy, rrc)
    const p1 = ringRectPointAt(t0 + arcDir * (valueNow / steps) * (range.spanDeg / 360), hx, hy, rrc)
    const pR = ringRectPointAt(t0 + arcDir * (range.spanDeg / 360), hx, hy, rrc)
    stX = cx + p0.x; stY = cy + p0.y
    endX = cx + p1.x; endY = cy + p1.y
    rangeEndX = cx + pR.x; rangeEndY = cy + pR.y
  } else {
    const rMid = (rIn + rOut) / 2
    stX = cx + rMid * Math.cos(startA); stY = cy + rMid * Math.sin(startA)
    endX = cx + rMid * Math.cos(startA + arcDir * thetaP); endY = cy + rMid * Math.sin(startA + arcDir * thetaP)
    rangeEndX = cx + rMid * Math.cos(startA + arcDir * rangeRad)
    rangeEndY = cy + rMid * Math.sin(startA + arcDir * rangeRad)
  }

  /* 渐变采样位置: 范围内按相对弧长; 范围外的端帽取离得近的那一端 (0 或 1)。
   * 圆和圆角矩形都先归一成弧度 relNow, 这里只做比例换算。 */
  const gradTAt = (rel, inRange, px, py) => {
    if (inRange) return Math.max(0, Math.min(1, rel / Math.max(1e-9, rangeRad)))
    const ds = (px - stX) * (px - stX) + (py - stY) * (py - stY)
    const de = (px - rangeEndX) * (px - rangeEndX) + (py - rangeEndY) * (py - rangeEndY)
    return ds <= de ? 0 : 1
  }

  // 直径 = 硬几何边界: AA 渐隐完全向带内 (外径/内径不随 aa 增大而外溢)
  const rOutMax2 = rOut * rOut
  const rInMin2 = rIn * rIn
  const TWO_PI = Math.PI * 2

  /* 分割遮罩的定位基准: 弧起点 (圆用精确角度 rel; 矩形用周长参数 t0)。
   * 相位相对弧起点, 所以 0 = 弧起点正好是一段的开始。 */
  const segRectT0 = ((((r.startDeg ?? -90) + 90) / 360 + 1) % 1)
  const segRectPerPx = isRect ? ringLapPx(w, h, r) : 0


  for (let y = 0; y < h; y++) {
    const dy = y - cy, dy2 = dy * dy
    /* 矩形整数路径: 覆盖率 = 到最近边界的垂直距离做斜坡 (ringRectCovSdf8) —— 逐像素扫,
     * 弧/直边/上下长边一律是"边界法线方向"的 1 段渐变 (与圆环同一条公式) */
    const dyQ8 = rectSync ? dy * 256 : 0
    for (let x = 0; x < w; x++) {
      const dx = x - cx
      let a = 0, cov = 0, fillW = 0, dSigned = 0, halfT = halfTPx, endCov = 1, endFillExt = false, frontExt = false
      let inRange = true, trackW = 1, relNow = 0
      /* 分割: segRel = 相对弧起点的位置(°); segAA = 缝边过渡角宽(°); segCap = 本像素在端帽里
       * (帽盘不参与分割, 否则圆帽会被切成碎块); aU = 圆的 0.5° 整数角 (同步/白斑共用) */
      let segM = 1, segRel = 0, segAA = 0, segCap = false, aU = 0
      if (rectSync) {
        /* ---- 圆角矩形环: 板子同式整数链路 (与固件 RING_SHAPE=1 逐像素一致) ----
         * 弧/白斑走**周长参数 s → 等效角 aU**;
         * 颜色 = mix(track,fill,w) → mix(·,白,gain) → mix(黑,·,cov) + Bayer 抖动, 与圆环同一链 */
        const cov8r = ringRectCovSdf8(dx * 256, dyQ8, rectGq)
        if (!cov8r) continue
        const sQ8r = ringRectPathSQ8(dx * 256, dyQ8, rectGq)
        let w8 = ringRectArcW(sQ8r, dx, dy, rectAG)
        /* 部分弧: 范围外的轨道权重为 0 → 不画 (整圈时恒 255, 旧像素一个不变) */
        let tw8 = ringRectTrackW(sQ8r, dx, dy, rectAG)
        /* 矩形同步路径保持板端行为 (端面收边另有逻辑), 不做端点 AA 外延。 */
        if (!w8 && !tw8) continue
        /* 分割位置 (周长参数 s, Q8): 相位相对弧起点, 所以换起始角时段落跟着走 */
        if (segG) {
          let relS = rectAG.dirSign > 0 ? sQ8r - rectAG.sStart : rectAG.sStart - sQ8r
          if (relS < 0) relS += rectAG.per
          segRel = (relS / rectAG.per) * 360
          segAA = (segG.aaPx * 256 / rectAG.per) * 360
        }
        /* 当前像素是否在弧范围内 (按路径位置 s 判, 与 ringRectArcW 同一口径)。
         * 渐变下面的 inRange 只在 gradOn 时算, 这里必须无条件算: 范围外的填充端帽
         * 颜色要用 fill, 不能再 mix(track, fill, w8), 否则圆帽会留下半个轨道色。 */
        if (rectAG.rangeU < 720) {
          let relS = rectAG.dirSign > 0 ? sQ8r - rectAG.sStart : rectAG.sStart - sQ8r
          if (relS < 0) relS += rectAG.per
          inRange = relS <= rectAG.rangeS
        }
        /* 范围外的轨道端帽也保持实心 (与理想路径的 rangeCapsOn 同一口径) */
        if (!inRange && tw8 > 0) segCap = true
        /* 渐变位置: 矩形按周长等效角 aU 反推相对起点的弧长比例。
         * aU 同时给白斑用, 避免重复算一次 winding。 */
        const aU = (gradOn || glintOn) ? ringRectAngleU(sQ8r, rectGq) : 0
        if (gradOn) {
          const relU = (((aU - rectStartU720) * arcDir) % 720 + 720) % 720
          relNow = (relU * Math.PI) / 360
          inRange = relNow <= rangeRad + 1e-9
        }
        const gain8r = glintOn ? ringRectGain8(aU, gDeg, spanU, tbRect) : 0
        const dth = (BAYER8[((y & 7) << 3) | (x & 7)] - 32) * 4
        const gT = gradOn ? gradTAt(relNow, inRange, x, y) : 0
        const track565Now = trackGrad ? ringGrad565(trackGrad, gT, 0) : ((r.trackColor ?? 0x6B4D) & 0xFFFF)
        const fill565Now = fillGrad ? ringGrad565(fillGrad, gT, 0) : ((r.fillColor ?? 0x07FF) & 0xFFFF)
        /* 端帽仍是"填充层盖在轨道层上": 帽盘内部 w8=255 → 纯 fill; 帽盘 AA 边
         * 按 w8 从轨道色过渡到填充色。**不能**在帽区直接取 fill 再把 alpha 降成
         * w8 —— 那会让帽边向页面底色(常为黑)淡出, 在轨道色上留一圈黑边
         * (用户现场: "圆帽旁边有黑色区域")。轨道覆盖到的地方 alpha 必须保持实心。 */
        const cap8 = ringRectCapW(dx, dy, rectAG)
        if (cap8 > 0) segCap = true
        /* 范围内: 填充层盖在轨道层上 (帽边按 w8 混向轨道色, 不会露出一圈黑);
         * 范围外且落在帽盘里: 帽盘本身是实心 fill (不能混轨道端帽的红, 否则半个帽);
         * 其余范围外像素 (轨道端帽/残弧) 照旧按轨道色合成 */
        const base = (!inRange && cap8 > 0)
          ? fill565Now
          : (tw8 ? mix565(track565Now, fill565Now, w8, 0) : fill565Now)
        let lit = mix565(base, 0xFFFF, gain8r, 0)
        /* 立体感 (网页预览与板子同一套): 断面光照作用在"带色 + 白斑"上, 再按覆盖率淡出
         * —— 顺序与圆环一致 (白斑先叠, 断面光照后叠) */
        if (shadeRect) {
          const dOutS = ringRectDistQ8(dx * 256, dyQ8, rectGq.oHx, rectGq.oHy, rectGq.oRc)
          const nr = ringRectNormalQ8(dx * 256, dyQ8, rectGq)
          lit = ringRectShade565(lit, -dOutS, nr.nx, nr.ny, shadeRect, dth)
        }
        /* 覆盖 = 轨道 ∪ 填充 (填充盖在轨道上): tw8=255 时保持 255,
         * 范围外只剩端帽时才按 w8 向底色淡出 —— 与颜色同源, 端帽 AA 只衰减一次 */
        const aw8 = tw8 + (((255 - tw8) * w8 + 127) / 255 | 0)
        if (segG && !segCap) segM = ringSegMaskDeg(segRel, segG.P, segG.gap, segAA, { phase: segG.phase })
        let a8 = (cov8r * aw8 + 127) / 255 | 0
        if (segG && segG.mode === 'cut') a8 = (a8 * segM + 0.5) | 0
        if (segG && segG.mode === 'groove') {
          lit = mix565(lit, 0x0000, Math.round((1 - segM) * segG.depth * 255), dth)
        }
        const out = mix565(bg565, lit, a8, dth)
        const i = (y * w + x) * 4
        d[i] = ((out >> 11) & 31) * 255 / 31
        d[i + 1] = ((out >> 5) & 63) * 255 / 63
        d[i + 2] = (out & 31) * 255 / 31
        d[i + 3] = a8
        continue
      }
      if (isRect) {
        const hit = ringRectBand(dx, dy, rectG)
        if (!hit) continue                            // 环带外 (含 AA 余量)
        cov = hit.cov                                 // 内外边缘对称渐隐
        a = hit.a
        dSigned = hit.d; halfT = ht                   // 立体感要用: 到中心线的有符号距离
        const rel = relAngle(a, startA, arcDir)      /* 圆角矩形也要跟着递增方向反向 */
        relNow = rel
        /* 分割: 矩形沿**周长参数 t** 等分 (不能按等效角, 直边/拐角的角速度不一样) */
        if (segG) {
          const dt = ((((hit.t - segRectT0) * arcDir) % 1) + 1) % 1
          /* 端点外侧用"带符号"的相对角: 起点外一圈按负角延续沟槽格, 而不是绕回 359° */
          const rangeDeg = (rangeRad * 180) / Math.PI
          segRel = dt * 360
          if (segRel > (rangeDeg + 360) / 2) segRel -= 360
          segAA = segRectPerPx > 0 ? (segG.aaPx / segRectPerPx) * 360 : 0.5
        }
        inRange = rel <= rangeRad + 1e-9
        fillW = (thetaP > 1e-9 && rel <= thetaP) ? 1 : 0
        trackW = inRange ? 1 : 0
        /* 平口 (caps 关) 两端 AA: 圆角矩形按周长参数 t 的像素距离, 与圆的角宽同一条斜坡 */
        if (!r.caps && segRectPerPx > 0) {
          const relT = ((((hit.t - segRectT0) * arcDir) % 1) + 1) % 1
          const perPx = Math.max(1e-6, segRectPerPx)
          const e = ringArcEndAA(relT, thetaP / TWO_PI, rangeRad / TWO_PI, 1,
                                 aaEdgePx / perPx)
          const ec = Math.max(e.fillScale, e.trackScale)
          /* 只有"端面外延"才改颜色权重/标记: 带内 ec=1 (fillScale/trackScale=1),
           * 满档时全弧都在带内 —— 不能把整圈都当成端点, 否则沟槽会被清掉。 */
          if (ec > 0.999999) {
            endCov = 1
          } else if (ec > 0) {
            endCov = ec
            if (e.fillScale > 0) { fillW = Math.max(fillW, 1); endFillExt = true }
            if (e.trackScale > 0) trackW = Math.max(trackW, 1)
          }
        }
      } else {
        const d2 = dx * dx + dy2
        if (d2 > rOutMax2 || d2 < rInMin2) continue   // 快速排除圆环带外
        if (sync) {
          /* 板子上"带内就画", 覆盖率查表 —— 边界那一圈 (r = R_OUT/R_IN) 表里有值(≈80/255),
           * 用浮点覆盖率算会在这儿直接归零 → 预览比板子少一圈暗边 */
          cov = 1
        } else {
          const dist = Math.sqrt(d2)
          // 径向边缘 AA: 从边界 0 → 带内 aa 像素处 1
          cov = Math.min(dist - rIn, rOut - dist) / aa
          if (cov <= 0) continue
          if (cov > 1) cov = 1
        }
        // 角度 → 相对起始角
        a = Math.atan2(dy, dx)
        if (depth > 0) dSigned = Math.sqrt(d2) - rMidPx
        const rel = relAngle(a, startA, arcDir)  // 逆时针: 反向量
        relNow = rel
        inRange = rel <= rangeRad + 1e-9
        /* 白斑的整数角 (只在开白斑时算); 分割不再用 0.5° 量化 ——
         * 240px 上 1° 缝只有 ~2px, 必须用像素半径折算的精确角度做 AA。 */
        if (sync && glintOn) aU = ringAtan2U(dy, dx, tb)
        if (segG) {
          /* 端点外侧用"带符号"的相对角: 起点外按负角继续分段图案 (先补沟槽格再 AA) */
          const rangeDeg = (rangeRad * 180) / Math.PI
          segRel = (rel * 180) / Math.PI
          if (segRel > (rangeDeg + 360) / 2) segRel -= 360
          segAA = (segG.aaPx / Math.max(1, Math.sqrt(d2))) * 180 / Math.PI
        }
        if (sync) {
          fillW = ringArcFillW(dx, dy, arcCfg)
          trackW = ringArcTrackW(dx, dy, arcCfg)
        } else {
          fillW = (thetaP > 1e-9 && rel <= thetaP) ? 1 : 0
          trackW = inRange ? 1 : 0
        }
        /* 平口 (caps 关) 两端 AA: 整圈只淡填充两端 (轨道在下面), 部分弧整条带淡出.
         * 角宽随半径折算 (px → 弧度), 起点/终点各用自己的宽度, 屏幕上才是固定 px 斜坡. */
        if (!r.caps) {
          const rpx = Math.max(1, Math.sqrt(d2))
          const e = ringArcEndAA(rel, thetaP, rangeRad, TWO_PI,
                                 aaEdgePx / rpx)
          const ec = Math.max(e.fillScale, e.trackScale)
          /* 带内 ec=1 (满档时整弧都是带内): 不能当成端点外延, 否则沟槽会被清掉。
           * 只有 ec<1 的外延像素才改颜色权重并标记 endFillExt。 */
          if (ec > 0.999999) {
            endCov = 1
          } else if (ec > 0) {
            endCov = ec
            if (e.fillScale > 0) { fillW = Math.max(fillW, 1); endFillExt = true }
            if (e.trackScale > 0) trackW = Math.max(trackW, 1)
          }
        }
        /* 未满档的进度前沿: 与固件 2026-10-22 这一版一致, 也做一段向外 AA
         * (颜色用前沿处的段/槽色, 只向外淡出, 不侵蚀已亮段体)。 */
        if (segG && aaEdgePx > 0 && thetaP > 1e-9 && thetaP < rangeRad - 1e-9) {
          const rpx = Math.max(1, Math.sqrt(d2))
          const wf = aaEdgePx / rpx
          const d = rel - thetaP
          if (d >= 0 && d < wf) {
            endCov = Math.min(endCov, 1 - d / wf)
            fillW = Math.max(fillW, 1)
            frontExt = true
          }
        }
        if (sync && !fillW && !trackW) continue      // 部分弧范围外 (AA 带外): 连轨道都不画
      }

      /* 渐变位置: 范围端帽/拖尾只改权重, 不改 relNow/inRange, 在这里算一次即可 */
      const gradT = gradOn ? gradTAt(relNow, inRange, x, y) : 0

      /* 拖尾 (理想模式) 先做, 端帽后做: 与固件一样, 帽盘要盖在渐隐之上,
       * 不能反过来被拖尾乘暗 (否则收尾到帽区会断开)。 */
      const tailRad = (tailU * 0.5 * Math.PI) / 180
      if (!sync && tailU > 0 && fillW > 0 && thetaP > 1e-9 && thetaP < TWO_PI - 1e-9) {
        const relT = relAngle(a, startA, arcDir)
        if (relT > thetaP - tailRad) {
          const k = (thetaP - relT) / tailRad
          fillW *= k < 0 ? 0 : (k > 1 ? 1 : k)
        }
      }
      // 圆端帽 (两端圆头, 沿路径延伸; 端帽边界同样硬边, AA 向内渐隐)
      // 同步模式不在这儿画: 端帽已经由 ringArcFillW()/ringRectArcW() 按板子的整数几何算过了,
      // 再叠一层浮点端帽只会在 AA 边缘多出板子上没有的像素
      if (!sync && caps) {
        const capWAt = (px, py, rad) => {
          const rr = rad == null ? capR : rad
          const cw = (rr - Math.hypot(x - px, y - py)) / aa
          return cw <= 0 ? 0 : (cw >= 1 ? 1 : cw)
        }
        /* 有拖尾时起点帽按"圆环的一部分"处理: 剩余弧不足帽半径时帽盘缩成一个点,
         * 弧长到 2 倍帽半径时长回整盘 (仍是圆头, 不做半帽/弦切)。
         * 末端交给渐变。 */
        if (caps && thetaP > 1e-9) {
          const capHalfRad = capR / rMidPx
          const capScale = (r.effect === 'countdown' && tailU > 0)
            ? Math.max(0, Math.min(1, (thetaP - capHalfRad) / capHalfRad))
            : 1
          const cc = Math.max(
            tailU > 0 ? 0 : capWAt(endX, endY),
            capWAt(stX, stY, capR * capScale),
          )
          if (cc > 0) segCap = true
          if (cc > fillW) fillW = cc
        }
      }
      /* 范围端帽 (理想模式): 范围两端是轨道的一部分, 与同步模式的 trackCapsOn 对齐。
       * 进度未走到范围末端时这里只是给轨道收边; 走到末端时 fillW=1 会盖过它。 */
      if (!sync && rangeCapsOn) {
        const capWAt = (px, py) => {
          const cw = (capR - Math.hypot(x - px, y - py)) / aa
          return cw <= 0 ? 0 : (cw >= 1 ? 1 : cw)
        }
        /* 拖尾时末端不画帽 —— 否则轨道端帽会从渐隐的填充尾巴下露出半个圆头 */
        const cw = Math.max(capWAt(stX, stY), tailU > 0 ? 0 : capWAt(rangeEndX, rangeEndY))
        if (cw > 0) segCap = true
        if (cw > trackW) trackW = cw
      }

      /* 分割遮罩: 端帽盘保持实心 (不切帽), 其余位置按角度周期算覆盖率 */
      if (segG && !segCap) {
        segM = ringSegMaskDeg(segRel, segG.P, segG.gap, segAA, { phase: segG.phase })
      }
      /* 端点外延 = 该端自己那一段的沟槽格: 强制定为 groove (不是纯 fill 亮条),
       * 颜色由当前端的渐变色压暗得到; 外面再用 endCov 淡出。 */
      if (endFillExt) segM = 0.5
      /* 进度前沿: 固件在槽中点分割时前沿落在槽里 → 用槽色; split=10 (下段起点) 才用 50/50 */
      if (frontExt) segM = (segG && segG.split >= 10) ? 0.5 : 0

      /* 部分弧: 范围外只剩填充端帽或轨道端帽 —— 前者底色用 fill (不能拿 track 去混,
       * 否则帽外缘一圈发暗), 后者用 track (fillW=0 → 插值结果就是 track)。 */
      if (!sync && !inRange && fillW === 0 && trackW === 0) continue
      /* 渐变取色: 轨道与填充各自沿弧长采样, 再按原来的 fillW 做 track→fill 插值。
       * 没有渐变时 gTrack/gFill 就是原来的平色, 浮点值完全一致。 */
      const gTrack = trackGrad ? ringGradRgb(trackGrad, gradT) : track
      const gFill = fillGrad ? ringGradRgb(fillGrad, gradT) : fill
      let cr, cg, cb
      if (!inRange && fillW > 0) {
        cr = gFill.r; cg = gFill.g; cb = gFill.b
      } else if (inRange || trackW > 0) {
        cr = gTrack.r + (gFill.r - gTrack.r) * fillW
        cg = gTrack.g + (gFill.g - gTrack.g) * fillW
        cb = gTrack.b + (gFill.b - gTrack.b) * fillW
      } else {
        cr = gFill.r; cg = gFill.g; cb = gFill.b
      }

      /* 立体感: 理想模式用浮点断面光照 (圆和圆角矩形共用); 同步模式在下面走板子的整数表 */
      const shade = (depth > 0 && !sync) ? shadeFactor(dSigned / halfT, a, depthStyle, lightA, depth) : 0

      // 白斑: 沿路径的高斯提亮 (乘法把亮度拉高 → 向白插值)
      let gain8 = 0                                  // 0..255, 同步模式下与 MCU ringGain[] 同值
      if (glintOn) {
        let da = a - gAngle
        if (da > Math.PI) da -= TWO_PI
        else if (da < -Math.PI) da += TWO_PI
        if (sync) {
          /* 整数链路: 角度查表算 (0.5° 单位) → 角差折到 ±360 → 增益查表 + ±span 硬截断
           * (aU 已在上面按 seg/glint 需要算好) */
          /* 用 gDeg (动画相位) 而不是静态 r.glintDeg: 否则「与 MCU 同步」(默认开) 时
           * 主预览的光斑不会转 —— 只有关掉同步的理想渲染才会动。没有动画时 gDeg === glintDeg,
           * 所以逐像素对拍 (parity) 一个像素都不变。 */
          const gU = ((Math.round(gDeg * 2) % 720) + 720) % 720
          let dU = aU + 720 - gU
          if (dU >= 720) dU -= 720
          if (dU > 360) dU -= 720
          const adU = dU < 0 ? -dU : dU
          gain8 = adU <= spanU ? tb.gain[adU] : 0
        } else {
          const g = Math.exp(-(da * da) / (2 * sigma * sigma))
          if (g > 0.01) { cr += (255 - cr) * g; cg += (255 - cg) * g; cb += (255 - cb) * g }
        }
      }

      const i = (y * w + x) * 4
      let covA = cov * 255                                 // 画布 alpha (同步模式下面换成板子查表值)
      /* 分割 (切断): 理想路径直接乘 alpha; 同步路径在下面用 a8 乘 (同一效果, 位宽不同) */
      if (segG && segG.mode === 'cut' && !sync) covA *= segM
      if (sync) {
        /* 完全按 MCU 的顺序与位宽算: base=lerp565(track,fill,fillW)
         *   → mix565(base, fg, gain8) → mix565(bg, .., cov8), 每步带同一抖动量 */
        const dth = (BAYER8[((y & 7) << 3) | (x & 7)] - 32) * 4
        /* 覆盖率也查板子那张表 (ring_cov(): 索引 = (r²−R_IN²)>>5) —— 理想 float 覆盖率
         * 与它最多差 40/255, 带边 AA 一眼能看出深浅不同 */
        const cov8 = ringCovAt(dx * dx + dy2, rIn, rOut, aa)
        const w8 = Math.max(0, Math.min(255, Math.round(fillW * 255)))
        const tw8 = Math.max(0, Math.min(255, Math.round(trackW * 255)))
        /* 帽盘 = 填充层盖在轨道层上: 盘内 w8=255 → 纯 fill; 盘边按 w8 从轨道色
         * 过渡到填充色。**不能**在帽区直接取 fill 再把 alpha 降成 w8 —— 那会让
         * 帽边向页面底色(常为黑)淡出, 在轨道色上留一圈黑边 (DR1152 现场)。 */
        const capW = ringArcCapW(dx, dy, arcCfg)
        if (capW > 0) { segCap = true; segM = 1 }
        /* 范围外只剩轨道端帽时也保持实心 (与理想路径的 rangeCapsOn 同一口径) */
        if (!inRange && trackW > 0 && fillW === 0) { segCap = true; segM = 1 }
        /* 覆盖 = 轨道 ∪ 填充 (填充盖在轨道上): tw8=255 时保持 255,
         * 范围外只剩端帽时才按 w8 向底色淡出 */
        const aw8 = tw8 + (((255 - tw8) * w8 + 127) / 255 | 0)
        /* 覆盖率的 alpha 必须带端帽权重 aw8: 部分弧的圆帽边界靠它做抗锯齿。
         * 但帽是「填充层盖在轨道层上」: 帽边颜色按 w8 混向轨道色, alpha 不能同时
         * 再乘一次 w8 —— 否则颜色权重 × alpha 权重二次衰减, 帽边向页面底色(黑)
         * 淡出, 在轨道色上留一圈黑边 (DR1152 现场的「圆帽旁边黑色区域」)。
         * 轨道覆盖到的地方 aw8=255; 只有范围外只剩帽盘时才按 w8 向底色淡出。 */
        let a8 = (cov8 * aw8 + 127) / 255 | 0
        if (segG && segG.mode === 'cut') a8 = (a8 * segM + 0.5) | 0
        covA = a8                                          // 与颜色同源: 板子上就是这一个覆盖率
        /* 轨道存在 → 旧式 track→fill 插值 (尾迹淡出时露出的是轨道, 不是透明);
         * 范围外只有填充端帽 → 底色直接用 fill, 别混进 track */
        const track565Now = trackGrad ? ringGrad565(trackGrad, gradT, 0) : ((r.trackColor ?? 0x6B4D) & 0xFFFF)
        const fill565Now = fillGrad ? ringGrad565(fillGrad, gradT, 0) : ((r.fillColor ?? 0x07FF) & 0xFFFF)
        /* 范围内: 填充盖在轨道上; 范围外且落在帽盘里: 纯 fill (不混轨道端帽的红);
         * 其余范围外像素 (轨道端帽/残弧) 照旧按轨道色合成 */
        const base = (!inRange && capW > 0)
          ? fill565Now
          : (tw8 ? mix565(track565Now, fill565Now, w8, 0) : fill565Now)
        let lit = mix565(base, 0xFFFF, gain8, 0)            // 白斑 = 向白插值 (MCU 默认 fg=白)
        /* 立体感: 作用在"带色"上, 再按覆盖率淡出 —— 与板子 ring_shade() 的位置和整数式一致 */
        if (shadeTab) lit = ringShade565(lit, dx * dx + dy2, dx, dy, shadeTab, rIn, dth)
        /* 分割 (暗槽): 环带不断, 缝位置把颜色压暗到 25%; 端帽/段内 segM=1 → 不变 */
        if (segG && segG.mode === 'groove') {
          lit = mix565(lit, 0x0000, Math.round((1 - segM) * segG.depth * 255), dth)
        }
        /* 端点外延: 颜色乘 endCov 向页面底色淡出 (alpha 保持 a8, 不再二次衰减) */
        const out = mix565(bg565, lit, (a8 * endCov) | 0, dth)
        d[i] = ((out >> 11) & 31) * 255 / 31
        d[i + 1] = ((out >> 5) & 63) * 255 / 63
        d[i + 2] = (out & 31) * 255 / 31
      } else {
        if (shade > 0) { cr += (255 - cr) * shade; cg += (255 - cg) * shade; cb += (255 - cb) * shade }
        else if (shade < 0) { const k = 1 + shade; cr *= k; cg *= k; cb *= k }
        /* 分割 (暗槽): 环带不断, 缝位置压暗到 25% —— 比"切断"更接近 3D 渲染里的凹槽 */
        if (segG && segG.mode === 'groove') {
          const k = 1 - segG.depth * (1 - segM)
          cr *= k; cg *= k; cb *= k
        }
        d[i] = cr; d[i + 1] = cg; d[i + 2] = cb
      }
      /* 理想模式的 alpha = 带覆盖 × max(轨道可见度, 填充度); 范围端帽的 AA 也在这里体现 */
      d[i + 3] = sync ? covA : covA * Math.max(trackW, fillW) * endCov
    }
  }
  // 画到实例位置 (x/y = 包围盒左上角, 与图片一致; 复位 0,0 即铺满屏)
  const off = document.createElement('canvas')
  off.width = w; off.height = h
  off.getContext('2d').putImageData(img, 0, 0)
  const dx = inst.x, dy = inst.y
  /* ！clear=false: 整帧合成 (预览/导出图片) 时**不许擦** —— 那会把已经画好的底色和下层图层
   *   擦成透明洞 (导出 PNG 里就是一块透明矩形)。清自己的包围盒只在"往同一张画布反复重画"
   *   的场合才需要 (RingDialog 的预览), 那里保持默认 true。 */
  if (opts.clear !== false) ctx.clearRect(dx, dy, w, h)
  ctx.drawImage(off, dx, dy)
}
