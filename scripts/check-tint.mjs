/*
 * 预览染色 (tintCanvas) 自检: node scripts/check-tint.mjs
 *
 * 现场 (2026-10-20): "为什么这次修改之后 编辑系统字 的预览图会失去灰度? 只有黑白两种状态了?"
 * 原因: zeroTransparent (预览用) 那条路只把 alpha 二值化、RGB 仍写满色 —— AA 边缘和光晕尾巴
 *       全被压成"有/没有"两态。
 * 修法: 亮度 v = (r/255)×(alpha/255) 压进 RGB, alpha 仍然二值 (不引入"假半透明")。
 *
 * 这里用最小画布桩把三条路都钉住:
 *   1) 普通文字画布 (白字 + alpha AA)  → 边缘保留灰度 (灰度值 ≈ 覆盖率), alpha 只有 0/255;
 *   2) 光晕画布 (不透明, RGB = 灰度)   → 按灰度压暗颜色, 0 像素透明;
 *   3) 不带 zeroTransparent 的老路径    → RGB = 纯色, alpha 原样保留 (其他调用方行为不变)。
 */
import { tintCanvas } from '../src/imageproc.js'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}

/* ---- 最小 canvas 桩: 一张 RGBA 缓冲 + 只实现这条路径用到的 2D 操作 ---- */
function parseColor(css) {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(css)
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0]
}
function mkCanvas(w0, h0) {
  let W = Math.max(0, w0 | 0), H = Math.max(0, h0 | 0)
  let buf = new Uint8ClampedArray(Math.max(1, W * H * 4))
  const cv = {
    get width() { return W },
    set width(v) { W = Math.max(0, v | 0); buf = new Uint8ClampedArray(Math.max(1, W * H * 4)) },
    get height() { return H },
    set height(v) { H = Math.max(0, v | 0); buf = new Uint8ClampedArray(Math.max(1, W * H * 4)) },
    get data() { return buf },
    getContext: () => ctx,
  }
  const ctx = {
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    drawImage(src) {
      if (src.width !== W || src.height !== H) throw new Error(`drawImage: 尺寸不一致 ${src.width}x${src.height} → ${W}x${H}`)
      buf.set(src.data)
    },
    fillRect(x, y, fw, fh) {
      if (ctx.globalCompositeOperation !== 'source-in') throw new Error('只实现 source-in')
      const [r, g, b] = parseColor(ctx.fillStyle)
      for (let yy = y; yy < y + fh; yy++) {
        for (let xx = x; xx < x + fw; xx++) {
          const i = (yy * W + xx) * 4
          if (buf[i + 3] > 0) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b }
        }
      }
    },
    getImageData(x, y, gw, gh) {
      const out = new Uint8ClampedArray(gw * gh * 4)
      for (let yy = 0; yy < gh; yy++) {
        const src0 = ((y + yy) * W + x) * 4
        out.set(buf.subarray(src0, src0 + gw * 4), yy * gw * 4)
      }
      return { width: gw, height: gh, data: out }
    },
    putImageData(img, x, y) {
      for (let yy = 0; yy < img.height; yy++) {
        const dst0 = ((y + yy) * W + x) * 4
        buf.set(img.data.subarray(yy * img.width * 4, (yy + 1) * img.width * 4), dst0)
      }
    },
  }
  return cv
}
globalThis.document = { createElement: (tag) => mkCanvas(0, 0) }
const px = (cv, i) => [cv.data[i * 4], cv.data[i * 4 + 1], cv.data[i * 4 + 2], cv.data[i * 4 + 3]]

/* 源画布: 像素 0 = 白字满覆盖; 像素 1 = 白字 50% 覆盖 (AA 边缘) */
function aaSource() {
  const cv = mkCanvas(2, 1)
  cv.data.set([255, 255, 255, 255, 255, 255, 255, 128])
  return cv
}

/* ---- 1) 普通文字画布: 灰度必须留在 RGB 里 (这就是用户说的"失去灰度") ---- */
{
  const out = tintCanvas(aaSource(), 0xFFFF, { zeroTransparent: true })
  const a = px(out, 0), b = px(out, 1)
  ok('系统字预览: 满覆盖像素 = 满色 (白字 → 255,255,255, 不透明)',
     a[0] === 255 && a[1] === 255 && a[2] === 255 && a[3] === 255, JSON.stringify(a))
  ok('系统字预览: 50% 边缘像素仍是"灰" (≈128), 不是被压成 0/255 两态',
     Math.abs(b[0] - 128) <= 2 && b[0] === b[1] && b[1] === b[2] && b[3] === 255,
     `${JSON.stringify(b)} (期望 R≈128)`)
  ok('系统字预览: alpha 只有 0/255 (不做假半透明, 棋盘格不会从字里透出来)',
     [px(out, 0)[3], px(out, 1)[3]].every(v => v === 0 || v === 255))
}

/* ---- 2) 光晕画布 (不透明 + 灰度): 按灰度压暗颜色, 0 像素透明 ---- */
{
  const glow = mkCanvas(3, 1)
  /* 灰度 255 / 64 / 0, 全部不透明 (sysGlowCanvas 的输出就是这样) */
  glow.data.set([255, 255, 255, 255, 64, 64, 64, 255, 0, 0, 0, 255])
  const out = tintCanvas(glow, 0xF800, { zeroTransparent: true })   /* 红 */
  const a = px(out, 0), b = px(out, 1), c = px(out, 2)
  ok('光晕预览: 满灰度 = 纯红', a[0] === 255 && a[1] === 0 && a[2] === 0 && a[3] === 255, JSON.stringify(a))
  ok('光晕预览: 灰度 64 → 暗红 (按灰度压暗, 光晕尾巴看得见层次)',
     Math.abs(b[0] - 64) <= 2 && b[1] === 0 && b[2] === 0 && b[3] === 255, JSON.stringify(b))
  ok('光晕预览: 灰度 0 → 完全透明 (光晕到哪儿结束一眼可见)', c[3] === 0, JSON.stringify(c))
}

/* ---- 3) 不带 zeroTransparent 的老路径 (素材拼字图染色): 纯色 + 原 alpha ---- */
{
  const out = tintCanvas(aaSource(), 0xF800)
  const a = px(out, 0), b = px(out, 1)
  ok('老路径 (素材拼字图): RGB = 纯色, alpha 原样 (半透明边缘保留)',
     a[0] === 255 && a[3] === 255 && b[0] === 255 && b[3] === 128, `${JSON.stringify(a)} ${JSON.stringify(b)}`)
}

console.log(fails ? `\n${fails} 项未通过` : '\n全部通过')
process.exit(fails ? 1 : 0)
