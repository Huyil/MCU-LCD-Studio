/*
 * 从固件源码导入素材 → src/fwassets.js  (网页内置"固件素材库")
 *
 *   node scripts/import-fw-assets.mjs [固件根目录]
 *
 * 思路与 DR2120B/tools/ota_gui.py 的 extract_c_array() 一致: 直接解析 MCU 工程里的
 * C 数组 (pic.c / ascii1408.c / pic_battery.c), 保证网页素材与设备内置**逐字节一致**。
 * 之后固件侧可以删掉这些字库 (素材改由网页导出)。
 *
 * 数据是 Image2Lcd 导出的 16bit RGB565 (2B/px, 小端), 多帧数组的第 0 维是帧数。
 * 尺寸来自 pic.c 里的 Picture 结构 {x,y,w,h,px,size,color,mirror} 与数组元素个数。
 */
import fs from 'node:fs'
import path from 'node:path'

const FW = process.argv[2] || process.env.FW_DIR || ''
if (!FW) {
  console.error('用法: node scripts/import-fw-assets.mjs <固件工程根目录>  (或设置 FW_DIR)')
  process.exit(1)
}

/* 素材表: 与 DR2120B/tools/ota_gui.py 的 DEFAULT_PATTERN_SOURCE 一致
 * 尺寸取自带 Image2Lcd 头的数组长度 (w*h*bpp) 与 pic.c 的 Picture 结构 */
const ASSETS = [
  /* 2026-11: 默认素材库只保留字体; LOGO / KRPM / 方向 / BLE / 电池等图片默认素材已清理。
   * 需要这些图标时由用户从自己的素材库导入, 不再内置。 */
  { id: 'fonts',    file: 'code/spi/pic.c',       sym: 'gImage_fonts',     w: 28,  h: 40,  frames: 10, bpp: 16, label: '数字 28x40 (0~9)', font: { glyphW: 28, glyphH: 40, charset: 'custom', custom: '0123456789' } },
  { id: 'font1210', file: 'code/spi/ascii1408.c', sym: 'gImage_font1210',  w: 10,  h: 12,  frames: 16, bpp: 16, label: '数字 10x12 (16)', font: { glyphW: 10, glyphH: 12, charset: 'frames' } },
  { id: 'ascii',    file: 'code/spi/ascii1408.c', sym: 'gImage_ascii0814', w: 8,   h: 14,  frames: 95, bpp: 16, label: 'ASCII 8x14 (95 字符)', font: { glyphW: 8, glyphH: 14, charset: 'ascii', start: 32 } },
]


/** 从 C 源文本里取出某个数组的全部字节值 (0x.. 形式)
 *  按花括号配对取数组体 —— 嵌套 { } 时不能只找第一个 "};" */
function extractCArray(text, sym) {
  /* 必须锚定"定义"而不是 &sym[0] 这类取地址用法 */
  const decl = new RegExp('const\\s+unsigned\\s+char\\s+' + sym + '\\s*\\[')
  const dm = decl.exec(text)
  if (!dm) throw new Error(`找不到数组定义 ${sym}`)
  const at = dm.index + dm[0].length - 1
  const open = text.indexOf('{', at)
  if (open < 0) throw new Error(`${sym} 没有初始化体`)
  let depth = 0, end = -1
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) throw new Error(`${sym} 花括号不配对`)
  // 先剥掉 C 注释: 有些数组紧跟一条 0X08,... 形式的注释, 会被误当数据
  const body = text.slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
  const vals = []
  const re = /0[xX]([0-9A-Fa-f]{1,2})(?![0-9A-Fa-f])/g
  let m
  while ((m = re.exec(body))) vals.push(parseInt(m[1], 16))
  if (!vals.length) throw new Error(`${sym} 里没解析到 0x.. 字节 (格式变了?)`)
  return vals
}

const out = []
let total = 0
const manifest = []
for (const a of ASSETS) {
  const p = path.join(FW, a.file)
  const text = fs.readFileSync(p, 'utf8')
  const vals = extractCArray(text, a.sym)
  const per = a.w * a.h * (a.bpp / 8)
  /* 源数据可能不足整帧: 补零并报警 (不改动源工程, 但要让使用者知道) */
  let v = vals
  if (vals.length % per !== 0) {
    const miss = per - (vals.length % per)
    console.log(`  ⚠ ${a.sym}: ${vals.length} 字节不是整帧 (${per}B/帧), 末帧缺 ${miss} 字节 → 已补零`)
    v = vals.concat(new Array(miss).fill(0))
  }
  const got = v.length / per
  if (got !== a.frames) console.log(`  注: ${a.sym} 实际 ${got} 帧 (表里写 ${a.frames}) → 以实际为准`)
  const frames = []
  for (let i = 0; i < got; i++) frames.push(v.slice(i * per, (i + 1) * per))
  const b64 = Buffer.from(v).toString('base64')
  out.push(`  { id: '${a.id}', label: ${JSON.stringify(a.label)}, w: ${a.w}, h: ${a.h}, frames: ${frames.length}, bpp: ${a.bpp}, b64: '${b64}' },`)
  manifest.push(`${a.sym} → ${a.id} (${a.w}x${a.h} x${frames.length}, ${a.bpp}bpp, ${v.length}B)`)
  total += v.length
}

const js = `/*
 * fwassets.js —— 从 MCU 固件源码导入的内置素材库 (网页默认素材库)
 *
 * 由 scripts/import-fw-assets.mjs 生成, 数据取自 DR2120B 工程 (与 tools/ota_gui.py 的
 * DEFAULT_PATTERN_SOURCE 同一批素材), **逐字节与设备内置一致**:
${manifest.map(m => ' *   ' + m).join('\n')}
 *
 * 共 ${total} 字节, ${ASSETS[0].bpp}bit RGB565 (2B/px, 小端; 与 Image2Lcd 导出格式一致)。
 * 多帧素材等尺寸排列 (frames 帧, 每帧 w*h)。
 * 浏览器用 fwAssetDataURL/fwStripDataURL 取 dataURL; node 用 fwAssetBytes 取原始字节。
 */
const ASSETS = [
${out.join('\n')}
]

let cache = null
function decode() {
  if (cache) return cache
  cache = ASSETS.map(a => {
    let bin
    if (typeof atob === 'function') bin = atob(a.b64)
    else bin = Buffer.from(a.b64, 'base64').toString('binary')
    const data = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
    return { ...a, data }
  })
  return cache
}

export function fwAssets() { return decode() }
export function fwAsset(id) { return decode().find(a => a.id === id) || null }
export const FW_ASSET_TOTAL = ${total}

/** 原始字节 (RGB565 小端 / 灰度), 单位: 字节 */
export function fwAssetBytes(id, frame = 0) {
  const a = fwAsset(id)
  if (!a) return null
  const per = a.w * a.h * (a.bpp / 8)
  return a.data.subarray(frame * per, (frame + 1) * per)
}

/** 取一帧的 RGBA 像素 (浏览器/编辑器预览用; 支持 8bit 灰度与 16bit RGB565) */
export function fwAssetRGBA(id, frame = 0, color = 0xFFFFFF, bg = 0x000000) {
  const a = fwAsset(id)
  if (!a) return null
  const px = fwAssetBytes(id, frame)
  const out = new Uint8ClampedArray(a.w * a.h * 4)
  const br = (bg >> 16) & 255, bgc = (bg >> 8) & 255, bb = bg & 255
  if (a.bpp === 8) {
    const cr = (color >> 16) & 255, cg = (color >> 8) & 255, cb = color & 255
    for (let i = 0; i < a.w * a.h; i++) {
      const t = px[i] / 255
      out[i * 4] = br + (cr - br) * t; out[i * 4 + 1] = bgc + (cg - bgc) * t
      out[i * 4 + 2] = bb + (cb - bb) * t; out[i * 4 + 3] = 255
    }
  } else {
    for (let i = 0; i < a.w * a.h; i++) {
      const v = px[i * 2] | (px[i * 2 + 1] << 8)
      out[i * 4] = ((v >> 11) & 31) * 255 / 31
      out[i * 4 + 1] = ((v >> 5) & 63) * 255 / 63
      out[i * 4 + 2] = (v & 31) * 255 / 31
      out[i * 4 + 3] = 255
    }
  }
  return out
}

/** 浏览器: 单帧 dataURL */
export function fwAssetDataURL(id, frame = 0, color = 0xFFFFFF, bg = 0x000000) {
  const a = fwAsset(id)
  if (!a || typeof document === 'undefined') return null
  const cv = document.createElement('canvas')
  cv.width = a.w; cv.height = a.h
  const ctx = cv.getContext('2d')
  const img = ctx.createImageData(a.w, a.h)
  img.data.set(fwAssetRGBA(id, frame, color, bg))
  ctx.putImageData(img, 0, 0)
  return cv.toDataURL('image/png')
}

/** 浏览器: 多帧横向拼成一条 (编辑器把"字库"素材当横向字条处理) */
export function fwStripDataURL(id, color = 0xFFFFFF, bg = 0x000000) {
  const a = fwAsset(id)
  if (!a || typeof document === 'undefined') return null
  const cv = document.createElement('canvas')
  cv.width = a.w * a.frames; cv.height = a.h
  const ctx = cv.getContext('2d')
  const img = ctx.createImageData(cv.width, a.h)
  const d = img.data
  for (let f = 0; f < a.frames; f++) {
    const rgba = fwAssetRGBA(id, f, color, bg)
    for (let y = 0; y < a.h; y++) {
      const src = y * a.w * 4
      const dst = (y * cv.width + f * a.w) * 4
      d.set(rgba.subarray(src, src + a.w * 4), dst)
    }
  }
  ctx.putImageData(img, 0, 0)
  return cv.toDataURL('image/png')
}

/** 进编辑器的登记表: 每组素材一个"字库型"素材 (含 glyph 尺寸与字符集) */
export const FW_BUILTIN = ASSETS.map(a => ({
  id: a.id,
  name: '固件·' + a.label + (a.frames > 1 ? ' [字库]' : ''),
  font: a.font
    ? { ...a.font, frames: a.frames, dir: 0 }
    : { glyphW: a.w, glyphH: a.h, charset: 'frames', frames: a.frames, dir: 0 },
}))
`
const dst = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'fwassets.js')
fs.writeFileSync(dst, js)
console.log('已导入 ' + manifest.length + ' 组素材, 共 ' + total + ' 字节:')
for (const m of manifest) console.log('  ' + m)
console.log('→ ' + dst)
