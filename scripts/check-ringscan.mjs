/*
 * 圆环逐像素扫描导出 (ring_scan.h/.c) 自检: node scripts/check-ringscan.mjs
 *
 * 对齐 DR2120B 的 picArc / frameIndices 数据格式:
 *   · 沿圆环递增方向, 逐坐标 + RGB565 (默认高低字节交换)
 *   · 每条扫描线取 scanWidth 像素 (默认 2px, 与参考图一致)
 *   · frameIndices[L] = 第 L 档结束处最后一个像素下标 (含), [0]=0, [LEVELS]=COUNT-1
 *
 * 这里用合成图 (环带涂青) 测纯函数, 不依赖浏览器 canvas。
 */
import { scanFromImage, ringScanOpts, ringScanFiles, buildRingScan } from '../src/ringscan.js'

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''))
  if (!cond) fails++
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

const SC = { w: 240, h: 240 }
const ring = {
  shape: 'circle', rOut: 120, rIn: 98, inset: 0, aa: 1.5, steps: 70, value: 70,
  startDeg: 130, arcEndDeg: 50, arcDir: 1, trackColor: 0, fillColor: 0x07FF,
  glintOn: false, syncMcU: true, caps: false, segOn: false,
  scanWidth: 2, scanStepPx: 0.5, scanLevels: 70, scanSwap: true,
}
const inst = { id: 'scan', kind: 'ring', x: 0, y: 0, w: 240, h: 240, ring }

/* 合成屏幕图: 环带 (r 100..118) 涂青, 其余透明; 这样扫描线一定能采到色 */
function makeImage() {
  const data = new Uint8ClampedArray(SC.w * SC.h * 4)
  const cx = 119, cy = 119
  for (let y = 0; y < SC.h; y++) for (let x = 0; x < SC.w; x++) {
    const d = Math.hypot(x - cx, y - cy)
    if (d < 100 || d > 118) continue
    const i = (y * SC.w + x) * 4
    data[i] = 0; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255
  }
  return { width: SC.w, height: SC.h, data }
}

{
  const img = makeImage()
  const seq = scanFromImage(inst, SC, img)
  ok('扫描有像素, 且没有重复坐标', seq.count > 800 && new Set(seq.px.map(p => p.x + ',' + p.y)).size === seq.count,
    'count=' + seq.count)
  ok('所有坐标都在屏幕内 (0..239)', seq.px.every(p => p.x >= 0 && p.x < 240 && p.y >= 0 && p.y < 240))
  ok('颜色是高低字节交换后的青色: 0x07FF → 0xFF07',
    seq.px.every(p => p.color === 0xFF07), 'first=' + (seq.px[0] && seq.px[0].color.toString(16)))
  ok('档位表: 长度 71, 单调不减, [0]=0, [70]=COUNT-1',
    seq.frames.length === 71 && seq.frames[0] === 0 && seq.frames[70] === seq.count - 1 &&
    Array.from(seq.frames).every((v, i, a) => i === 0 || v >= a[i - 1]),
    'frames[0..3]=' + Array.from(seq.frames.slice(0, 4)).join(',') + ' ... last=' + seq.frames[70])
  ok('扫描方向递增: 第一点在 130° 附近, 最后一点在 50° 附近',
    (() => {
      const a0 = Math.atan2(seq.px[0].y - 119, seq.px[0].x - 119) * 180 / Math.PI
      const a1 = Math.atan2(seq.px[seq.px.length - 1].y - 119, seq.px[seq.px.length - 1].x - 119) * 180 / Math.PI
      const norm = (a) => ((a % 360) + 360) % 360
      const d = (a, b) => { const x = Math.abs(norm(a) - norm(b)); return Math.min(x, 360 - x) }
      return d(a0, 130) < 4 && d(a1, 50) < 4
    })(),
    'first/last angle = ' + (Math.atan2(seq.px[0].y - 119, seq.px[0].x - 119) * 180 / Math.PI).toFixed(1) + ' / ' +
    (Math.atan2(seq.px[seq.px.length - 1].y - 119, seq.px[seq.px.length - 1].x - 119) * 180 / Math.PI).toFixed(1))
  /* 第 35 档结束在弧的 50% 处: 它的最后一个像素 t 应≈0.5, 下一个像素 t>0.5 */
  const f35 = seq.frames[35]
  const t35 = seq.px[f35].t
  const tNext = seq.px[Math.min(seq.count - 1, f35 + 1)].t
  ok('档位边界按角度 (不是按像素数): 第 35 档结束在弧 50% 处',
    t35 <= 0.5 + 1e-6 && (f35 === seq.count - 1 || tNext > 0.5 - 1e-6),
    't[35]=' + t35.toFixed(4) + ' next=' + tNext.toFixed(4))
  ok('2px 线宽: 起始扫描位置有内外两个像素 (同 t, 坐标不同)',
    seq.px.length > 1 && near(seq.px[0].t, 0) && near(seq.px[1].t, 0) &&
    (seq.px[0].x !== seq.px[1].x || seq.px[0].y !== seq.px[1].y),
    'first=' + (seq.px[0] && [seq.px[0].x, seq.px[0].y, seq.px[0].t].join(',')) +
    ' second=' + (seq.px[1] && [seq.px[1].x, seq.px[1].y, seq.px[1].t].join(',')))

  const files = ringScanFiles(inst, seq, SC)
  ok('生成的 .h 带 RingScanPx / COUNT / LEVELS / frameIndices 声明',
    /typedef struct[\s\S]*RingScanPx;/.test(files.header) &&
    files.header.includes('#define RING_SCAN_COUNT   ' + seq.count) &&
    files.header.includes('#define RING_SCAN_LEVELS  70') &&
    files.header.includes('ringScanFrame[RING_SCAN_LEVELS + 1]'))
  ok('生成的 .c 带 ringScanPx 数组 + 交换后的颜色 + 档位表',
    files.source.includes('const RingScanPx ringScanPx[RING_SCAN_COUNT]') &&
    files.source.includes('0xFF07') &&
    files.source.includes('const unsigned short ringScanFrame[RING_SCAN_LEVELS + 1]'))
}

/* 关掉字节交换: 同一张图应为 0x07FF */
{
  const seq = scanFromImage(inst, SC, makeImage(), { swap: false })
  ok('swap=false 时颜色保持普通 RGB565 (0x07FF)', seq.count > 800 && seq.px.every(p => p.color === 0x07FF))
}

/* 空图: 不崩, count=0, 档位表仍有 levels+1 项 */
{
  const empty = { width: 240, height: 240, data: new Uint8ClampedArray(240 * 240 * 4) }
  const seq = scanFromImage(inst, SC, empty)
  ok('空图: count=0 且档位表长度正确', seq.count === 0 && seq.frames.length === 71)
}

/* 参数: 档位空 = steps; 线宽/步长夹取 */
{
  const o = ringScanOpts({ steps: 70, scanLevels: null, scanWidth: 0, scanStepPx: 0 })
  ok('参数归一化: 档位空→steps, 线宽≥1, 步长≥0.1',
    o.levels === 70 && o.width === 1 && o.stepPx === 0.1)
}

/* 圆角矩形: 全屏涂色, 扫描沿周长走通 (至少采到色, 且档位表到满档) */
{
  const rinst = { ...inst, ring: { ...ring, shape: 'rect', rad: 24, radIn: null, thick: 14, inset: 8, startDeg: -90, arcEndDeg: null } }
  const all = new Uint8ClampedArray(SC.w * SC.h * 4)
  for (let i = 0; i < all.length; i += 4) { all[i] = 0; all[i + 1] = 255; all[i + 2] = 255; all[i + 3] = 255 }
  const seq = scanFromImage(rinst, SC, { width: 240, height: 240, data: all })
  ok('圆角矩形: 沿周长扫描有像素, 档位表到满档',
    seq.count > 300 && seq.frames[70] === seq.count - 1,
    'count=' + seq.count)
}

/* 浏览器路径: buildRingScan 建画布 → drawRing → getImageData → 扫描 → 文件 */
{
  class FakeCtx {
    constructor(c) { this.c = c }
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } }
    putImageData(img) { this.c._img = img }
    getImageData(x, y, w, h) {
      if (!this.c._img || this.c._img.width !== w || this.c._img.height !== h)
        this.c._img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
      return this.c._img
    }
    clearRect() {
      const w = this.c.width, h = this.c.height
      if (w && h) this.c._img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
    }
    drawImage(src, dx, dy) {
      const w = this.c.width, h = this.c.height
      if (!w || !h) return
      if (!this.c._img) this.c._img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
      const s = src._img
      if (!s) return
      for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
        const tx = dx + x, ty = dy + y
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue
        const si = (y * s.width + x) * 4, di = (ty * w + tx) * 4
        const a = s.data[si + 3] / 255
        const d = this.c._img.data
        d[di] = Math.round(s.data[si] * a + d[di] * (1 - a))
        d[di + 1] = Math.round(s.data[si + 1] * a + d[di + 1] * (1 - a))
        d[di + 2] = Math.round(s.data[si + 2] * a + d[di + 2] * (1 - a))
        d[di + 3] = Math.round(a * 255 + d[di + 3] * (1 - a))
      }
    }
  }
  class FakeCanvas {
    constructor() { this.width = 0; this.height = 0; this._ctx = null; this._img = null }
    getContext() { return this._ctx || (this._ctx = new FakeCtx(this)) }
  }
  globalThis.document = { createElement: () => new FakeCanvas() }
  const res = buildRingScan(inst, SC)
  ok('buildRingScan 浏览器链路: 渲染 → 读取 → 扫描 → 生成 .h/.c',
    !!res && res.count > 800 && /RingScanPx ringScanPx/.test(res.source) &&
    res.source.includes('0xFF07') && res.source.includes('ringScanFrame'),
    res ? 'count=' + res.count + ', levels=' + res.levels : 'null')
  delete globalThis.document
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过')
process.exit(fails ? 1 : 0)
