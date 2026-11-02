/* Color_t 枚举 (提取自 bsp_gc9a01.h / bsp_st7735s.h, 244 色) */
import raw from './colors.data.js'

export const COLORS = raw

/* 常用色快选 */
export const QUICK_COLORS = [
  'WHITE', 'BLACK', 'GRAY', 'GRAY_LIGHT', 'GRAY_DIM',
  'RED', 'GREEN', 'BLUE', 'YELLOW', 'CYAN', 'MAGENTA', 'ORANGE',
]

const byName = new Map(raw.map(c => [c.n, c.v]))

export function colorByName(name) {
  return byName.get(name)
}

/* 0xRRGGBB -> RGB565 */
export function rgb888To565(r, g, b) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
}

/* RGB565 -> 0xRRGGBB (还原用于预览) */
export function rgb565To888(v) {
  const r5 = (v >> 11) & 0x1F, g6 = (v >> 5) & 0x3F, b5 = v & 0x1F
  return { r: (r5 * 255 / 31) | 0, g: (g6 * 255 / 63) | 0, b: (b5 * 255 / 31) | 0 }
}

/* 精确名 → 否则按通道距离取最近枚举名 */
export function nearestColorName(v565) {
  const exact = raw.find(c => c.v === v565)
  if (exact) return exact.n
  const t = rgb565To888(v565)
  let best = null, bd = Infinity
  for (const c of raw) {
    const o = rgb565To888(c.v)
    const d = (t.r - o.r) ** 2 * 2 + (t.g - o.g) ** 2 * 4 + (t.b - o.b) ** 2 * 2
    if (d < bd) { bd = d; best = c }
  }
  return best ? best.n : 'WHITE'
}
