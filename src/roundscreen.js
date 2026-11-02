/*
 * 圆屏几何 + 圆外像素扫描 (纯函数: 不依赖 store / 不持有 DOM 状态)
 *
 * 坐标约定与 canvas 一致: 像素 (i, j) 的中心在连续坐标 (i+0.5, j+0.5)。
 * ringrender.js 内部圆心 (w-1)/2 也等于连续坐标 w/2, 两者同一约定 ——
 * 早期实现把像素索引直接当坐标 (少了 0.5) 再用 "半径减 2px" 兜底,
 * 导致恰好撑满圆屏的圆环被误判出圈; 这里统一为像素中心判定, 无需容差。
 */

export const OUT_ALPHA_MIN = 10   // 低于此 alpha 视为透明 (LCD 黑底)
export const OUT_DARK_MAX = 0     // R+G+B ≤ 此值视为纯黑 (0 = 只忽略真正的全黑 0,0,0)

/* 空值 → 默认值 (预设里 maskR/maskCx/maskCy 为空 = 自动) */
const numOr = (v, dflt) => {
  if (v === null || v === undefined || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

/**
 * 圆屏可用像素区几何 (屏幕连续坐标)。
 *
 * 可用区是**预设数据**, 不写死: 真实圆屏的可用圆常比内切圆小 1~2px 或有偏移,
 * 于是每个屏幕预设可带三个可选字段 (缺省/空 = 自动):
 *   maskR  可用圆半径 (px, 允许小数)   → 默认 min(w,h)/2 (内切圆)
 *   maskCx 可用圆心 x (px, 允许小数)   → 默认 w/2 (屏幕中心)
 *   maskCy 可用圆心 y (px, 允许小数)   → 默认 h/2
 * 判定规则: 像素中心落在圆内即视为可用 (等价于覆盖率 ≥ 50%, 与 LCD 寻址方式一致)。
 */
export function roundGeom(sc) {
  const w = Math.max(1, Math.round(+sc?.w) || 1)
  const h = Math.max(1, Math.round(+sc?.h) || 1)
  return {
    cx: numOr(sc?.maskCx, w / 2),
    cy: numOr(sc?.maskCy, h / 2),
    r: Math.max(0.5, numOr(sc?.maskR, Math.min(w, h) / 2)),
    w, h,
  }
}

/* 像素中心 (px+0.5, py+0.5) 是否落在圆内 */
export function insideRound(px, py, geom) {
  const dx = px + 0.5 - geom.cx
  const dy = py + 0.5 - geom.cy
  return dx * dx + dy * dy <= geom.r * geom.r
}

/**
 * 遍历缓冲区中"落在圆外且可见"的像素 (alpha ≥ OUT_ALPHA_MIN 且非纯黑)。
 *
 * @param data   RGBA 数据 (Uint8ClampedArray)
 * @param bufW   缓冲区宽 (px)
 * @param bufH   缓冲区高 (px)
 * @param ox     缓冲区左上角在屏幕中的 x (可为 0.5: 圆环支持半像素定位)
 * @param oy     缓冲区左上角在屏幕中的 y
 * @param geom   roundGeom() 的结果
 * @param cb     可选回调 (si, px, py), si = 该像素 RGBA 起始下标
 * @param bgRgb  可选屏幕底色 [r,g,b]: 与底色相同的像素不算"内容" (底色可配之后,
 *               圆外铺的就是底色 —— 不排掉的话换成非黑底色, 整个圆外都会被标红)
 * @returns 命中的圆外像素数
 *
 * 只遍历每行可能出圈的列区间 (圆外的部分在两侧), 不做整幅全扫描。
 */
export function forEachOutsidePixel(data, bufW, bufH, ox, oy, geom, cb, bgRgb = null) {
  const { cx, cy, r } = geom
  const r2 = r * r
  const bg = Array.isArray(bgRgb) ? bgRgb : null
  let count = 0
  const take = (si, px, py) => {
    if (data[si + 3] < OUT_ALPHA_MIN) return
    if (data[si] + data[si + 1] + data[si + 2] <= OUT_DARK_MAX) return
    /* ±2: 565 → 888 取整误差, 让"底色的 AA 边"也归到底色里 */
    if (bg && Math.abs(data[si] - bg[0]) <= 2 &&
        Math.abs(data[si + 1] - bg[1]) <= 2 && Math.abs(data[si + 2] - bg[2]) <= 2) return
    count++
    if (cb) cb(si, px, py)
  }
  for (let py = 0; py < bufH; py++) {
    const dy = oy + py + 0.5 - cy
    const rem = r2 - dy * dy
    if (rem <= 0) {                                  // 整行都在圆外
      for (let px = 0; px < bufW; px++) take((py * bufW + px) * 4, px, py)
      continue
    }
    const half = Math.sqrt(rem)
    // 出圈列: px + 0.5 + ox - cx < -half  或  > half
    const lEnd = Math.min(bufW - 1, Math.ceil(cx - half - 0.5 - ox) - 1)
    for (let px = 0; px <= lEnd; px++) take((py * bufW + px) * 4, px, py)
    const rStart = Math.max(0, Math.floor(cx + half - 0.5 - ox) + 1)
    for (let px = rStart; px < bufW; px++) take((py * bufW + px) * 4, px, py)
  }
  return count
}
