/*
 * 圆屏几何自检 (零依赖: node scripts/check-roundscreen.mjs)
 *
 * 覆盖 roundscreen.js 的判定契约:
 *   1) 优化扫描 (逐行区间) 与暴力扫描结果一致
 *   2) 恰好撑满圆屏的圆环不再误报 (历史 bug: 索引当坐标 + 半径减 2px)
 *   3) 真实溢出 (圆环超径 / 偏移 / 方图四角) 仍然报警
 */
import { roundGeom, insideRound, forEachOutsidePixel, OUT_ALPHA_MIN, OUT_DARK_MAX }
  from '../src/roundscreen.js'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}

/* ---- 1. 优化扫描 vs 暴力扫描 (含 0.5px 偏移) ---- */
function brute(data, w, h, ox, oy, geom) {
  let n = 0
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const si = (py * w + px) * 4
      if (data[si + 3] < OUT_ALPHA_MIN) continue
      if (data[si] + data[si + 1] + data[si + 2] <= OUT_DARK_MAX) continue
      if (insideRound(px + ox, py + oy, geom)) continue
      n++
    }
  }
  return n
}
let seed = 12345
const rand = n => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n)
let mismatch = 0
for (let t = 0; t < 300; t++) {
  const w = 1 + rand(70), h = 1 + rand(70)
  const ox = (rand(200) - 100) / 2, oy = (rand(200) - 100) / 2
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rand(60); data[i * 4 + 1] = rand(60); data[i * 4 + 2] = rand(60)
    data[i * 4 + 3] = rand(260) - 5
  }
  const geom = roundGeom({ w: 16 + rand(240), h: 16 + rand(240) })
  if (forEachOutsidePixel(data, w, h, ox, oy, geom, null) !== brute(data, w, h, ox, oy, geom)) mismatch++
}
ok('优化扫描 == 暴力扫描 (300 组随机用例)', mismatch === 0, `mismatch=${mismatch}`)

/* ---- 2/3. 圆环与方图场景 ---- */
/* 复刻 ringrender.drawRing 的几何/覆盖度 (只保留 alpha 判定所需部分) */
function ringBuffer(w, h, rOut, rIn, aa = 2) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy
      if (d2 > rOut * rOut || d2 < rIn * rIn) continue
      const dist = Math.sqrt(d2)
      let cov = Math.min(dist - rIn, rOut - dist) / aa
      if (cov <= 0) continue
      if (cov > 1) cov = 1
      const i = (y * w + x) * 4
      data[i] = 106; data[i + 1] = 105; data[i + 2] = 106; data[i + 3] = cov * 255
    }
  }
  return data
}
const geom240 = roundGeom({ w: 240, h: 240 })

const buf240 = ringBuffer(240, 240, 120, 86)          // addRingInstance 默认: Ø240 居中
ok('默认 Ø240 圆环居中 → 0 个圆外像素 (修复前 1487)',
  forEachOutsidePixel(buf240, 240, 240, 0, 0, geom240, null) === 0)
ok('Ø241 撑满 (rOut=120.5 > 半径 120) → 应报出圈',
  forEachOutsidePixel(ringBuffer(241, 241, 120.5, 86), 241, 241, -0.5, -0.5, geom240, null) > 0)
ok('Ø240 圆环右移 10px → 应报出圈',
  forEachOutsidePixel(buf240, 240, 240, 10, 0, geom240, null) > 0)

const sq = new Uint8ClampedArray(240 * 240 * 4)
for (let i = 0; i < 240 * 240; i++) { sq[i * 4] = 200; sq[i * 4 + 1] = 200; sq[i * 4 + 2] = 200; sq[i * 4 + 3] = 255 }
const sqOut = forEachOutsidePixel(sq, 240, 240, 0, 0, geom240, null)
const expect = 240 * 240 - Math.PI * 120 * 120
ok('撑满方图四角出圈 (≈ 面积差)', Math.abs(sqOut - expect) < 400, `now=${sqOut} expect≈${expect.toFixed(0)}`)

ok('全透明缓冲 → 0', forEachOutsidePixel(new Uint8ClampedArray(240 * 240 * 4), 240, 240, 0, 0, geom240, null) === 0)
ok('insideRound 圆心像素在圆内', insideRound(119, 119, geom240) && insideRound(120, 120, geom240))

/* ---- 4. 可用像素区 (每个屏幕预设可配 maskR/maskCx/maskCy) ---- */
ok('默认可用区 = 内切圆 (圆心 120,120 / 半径 120)',
  geom240.cx === 120 && geom240.cy === 120 && geom240.r === 120)
const gIn = roundGeom({ w: 240, h: 240, maskR: 118 })          // 真实可用圆比内切圆小 2px
const nIn = forEachOutsidePixel(buf240, 240, 240, 0, 0, gIn, null)
ok('可用半径 118: 撑满圆环 (Ø240) 应报出圈', nIn > 0, `n=${nIn}`)
const gOff = roundGeom({ w: 240, h: 240, maskCx: 122, maskCy: 120 })
const nOff = forEachOutsidePixel(buf240, 240, 240, 0, 0, gOff, null)
ok('可用圆心右移 2px: 撑满圆环应报出圈', nOff > 0, `n=${nOff}`)
ok('空字符串/非法值回退为自动',
  roundGeom({ w: 240, h: 240, maskR: '', maskCx: null, maskCy: 'x' }).r === 120 &&
  roundGeom({ w: 240, h: 240, maskR: '', maskCx: null, maskCy: 'x' }).cx === 120)

/* ---- 5. 纯黑阈值 = 0: 只忽略真正的全黑 (0,0,0) ---- */
const g4 = roundGeom({ w: 4, h: 4 })          // 像素 (0,0) 中心 (0.5,0.5) 落在圆外
const one = (r, g, b, a = 255) => new Uint8ClampedArray([r, g, b, a])
ok('圆外像素 (0,0,0) → 不计入', forEachOutsidePixel(one(0, 0, 0), 1, 1, 0, 0, g4, null) === 0)
ok('圆外像素 (1,0,0) → 计入 (阈值不是 <30)', forEachOutsidePixel(one(1, 0, 0), 1, 1, 0, 0, g4, null) === 1)
ok('圆外像素 (10,10,10) → 计入', forEachOutsidePixel(one(10, 10, 10), 1, 1, 0, 0, g4, null) === 1)
ok('圆外像素 alpha<10 → 不计入', forEachOutsidePixel(one(255, 255, 255, 5), 1, 1, 0, 0, g4, null) === 0)

/* ---- 6. 屏幕底色: 底色 = 可配 (默认黑), 圆外铺的底色不算"内容" ----
 * 不排掉的话, 把背景色改成白/灰后整个圆外都会被当成出圈内容标红。 */
const bgWhite = [255, 255, 255]
ok('圆外像素 = 屏幕底色 (白) → 不计入 (传了 bgRgb)',
   forEachOutsidePixel(one(255, 255, 255), 1, 1, 0, 0, g4, null, bgWhite) === 0)
ok('圆外像素 = 屏幕底色的 ±2 取整误差 → 仍不计入',
   forEachOutsidePixel(one(253, 255, 254), 1, 1, 0, 0, g4, null, bgWhite) === 0 &&
   forEachOutsidePixel(one(255, 253, 255), 1, 1, 0, 0, g4, null, bgWhite) === 0)
ok('圆外像素 ≠ 底色 (白底上一个灰字) → 仍计入',
   forEachOutsidePixel(one(120, 120, 120), 1, 1, 0, 0, g4, null, bgWhite) === 1)
ok('不传 bgRgb 时行为不变 (老调用方: 只有纯黑算底色)',
   forEachOutsidePixel(one(255, 255, 255), 1, 1, 0, 0, g4, null) === 1)

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
