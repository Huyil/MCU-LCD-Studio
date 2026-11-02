/*
 * uiexport.js —— 网页 UI 内容 → 帧/表导出 (纯逻辑, 可在 node 下测试)
 *
 * 与固件侧约定见 doc/网页UI移植计划.md 与 code/spi/app_ui.h:
 *   UI_FRAME_REF { px, x, y, w, h, lineH, fmt, mirror, index }
 *                 index: 画 px 数组里的第几帧 (0 基); 255 = 网页里的 -1 (仅网页渲染)
 *                        → MCU 侧 UI_DrawFrame 只清底色, 不渲染
 *   UI_FIELD     { type, dec, align, cells, pad, mode, x, y, color, bg,
 *                  lineColor, hiLine, src, frames, nframes, last, drawn }
 *
 * 本模块只做三件事 (都不碰 DOM, 便于 node 对拍):
 *   1) splitFrames: 把一张灰度图按"用户自定义高度"沿垂直切帧, 丢弃空白条, 有效帧重新编号
 *   2) exportAssets: 生成像素数组 .c  (内部 flash / 外部存储分文件)
 *   3) exportTable : 生成 UI_FRAME_REF/UI_FIELD 表 .c/.h
 */

import { asciiFont, ASCII_FONT_W, ASCII_FONT_H, ASCII_MODE1_H } from './asciifont.js'
import { colorMacroName } from './colordef.js'

/* ---------------- 0) 多行文本 → 灰度块 ---------------- */

/**
 * 把多行文本渲染成一块 8bit 灰度掩码 (颜色在渲染时给, 掩码本身只有形状)。
 * @param lines [{ text, align? }]   每行可不等长、可各自指定对齐
 * @param opt   { mode:1|0, charGap, lineGap, align }  mode=1 → 高 11 (与 LCD_drawChar 一致)
 * @returns { gray, w, h, lines:[{ y, h, w, text }] }  每行的总尺寸一起返回 (方便导出/清底)
 */
export function renderTextGray(lines, opt = {}) {
  const f = asciiFont()
  const mode = opt.mode == null ? 1 : opt.mode
  const fh = mode ? ASCII_MODE1_H : ASCII_FONT_H
  const cg = opt.charGap || 0
  const lg = opt.lineGap || 0
  const defAlign = opt.align == null ? 0 : opt.align
  if (lg < 0 || cg < 0) throw new Error('字距/行距暂不支持负值 (重叠会破坏掩码)')

  const meta = []
  let W = 0
  for (const L of lines) {
    const t = String(L.text ?? '')
    const w = t.length ? t.length * ASCII_FONT_W + (t.length - 1) * cg : 0
    meta.push({ text: t, align: L.align == null ? defAlign : L.align, w, h: fh, y: 0 })
    if (w > W) W = w
  }
  const H = meta.length ? meta.length * fh + (meta.length - 1) * lg : 0
  const gray = new Uint8Array(W * H)

  let y = 0
  for (const L of meta) {
    L.y = y
    let x = L.align === 1 ? W - L.w : (L.align === 2 ? ((W - L.w) >> 1) : 0)
    for (const ch of L.text) {
      let gi = ch.charCodeAt(0) - f.first
      if (gi < 0 || gi >= f.count) gi = 0
      const base = gi * ASCII_FONT_W * ASCII_FONT_H
      for (let r = 0; r < fh; r++) {
        const src = base + r * ASCII_FONT_W
        const dst = (y + r) * W + x
        for (let c = 0; c < ASCII_FONT_W; c++) gray[dst + c] = f.data[src + c]
      }
      x += ASCII_FONT_W + cg
    }
    y += fh + lg
  }
  return { gray, w: W, h: H, lines: meta }
}

/* ---------------- 1) 垂直切帧 ---------------- */

/** 判断一条横条是否全空白 (阈值 0 = 只有全 0 才算空白) */
export function isBlankBand(gray, w, y0, bandH, thr = 0) {
  for (let y = y0; y < y0 + bandH; y++) {
    const off = y * w
    for (let x = 0; x < w; x++) if (gray[off + x] > thr) return false
  }
  return true
}

/**
 * 按 bandH 高度把 gray(w×h) 垂直切帧。
 * @returns {{frames: {y:number,h:number,px:Uint8Array}[], dropped: number[]}}
 *   frames 里的 px 是从原图裁出来的密实副本 (未压缩, 1B/px, 行主序)
 *   dropped 是被丢弃的空白条起始 y (报告用)
 */
export function splitFrames(gray, w, h, bandH, { dropBlank = true, thr = 0 } = {}) {
  if (!(bandH > 0)) throw new Error('bandH 必须 > 0')
  const frames = [], dropped = []
  /* 宽度不切: 只沿 y 切 */
  for (let y = 0; y < h; y += bandH) {
    const bh = Math.min(bandH, h - y)
    if (dropBlank && isBlankBand(gray, w, y, bh, thr)) { dropped.push(y); continue }
    const px = new Uint8Array(w * bh)
    for (let r = 0; r < bh; r++) px.set(gray.subarray((y + r) * w, (y + r) * w + w), r * w)
    frames.push({ y, h: bh, px })
  }
  return { frames, dropped }
}

/* ---------------- 1c) 数字字库导出 (灰度 8bit, 与 LCD_drawGrayImage 配套) ---------------- */

/**
 * 导出灰度位图字库: 从网页内置 ASCII 字模取 [first, last] 范围。
 * MCU 侧 UI_DrawNum 逐格取模, 空格由框架用底色填充。
 */
export function exportFont({ name = 'g_uiFontNum8x11', first = 32, last = 57 } = {}) {
  const f = asciiFont()
  const W = ASCII_FONT_W, H = ASCII_MODE1_H
  const bytes = []
  for (let code = first; code <= last; code++) {
    let gi = code - f.first
    if (gi < 0 || gi >= f.count) gi = 0
    const base = gi * W * ASCII_FONT_H
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) bytes.push(f.data[base + r * W + c])
  }
  return { name, first, last, count: last - first + 1, w: W, h: H, bytes }
}

/** 灰度字库的**实际导出集合** (字形区间 + 字节): 数字区域只导用得到的连续区间。
 *  packer 与 exportFontParts 必须用同一份, 否则表里的 count 和流里的字形数会错位。 */
export function fontGlyphSet(fo, opt = {}) {
  const total = Math.max(1, Math.round(fo.count) || 1)
  const last = fo.last == null ? fo.first + total - 1 : fo.last
  const w = Math.max(1, Math.round(fo.w) || 1), h = Math.max(1, Math.round(fo.h) || 1)
  const gap = Math.max(0, Math.round(fo.gap) || 0)
  let first = fo.first, count = total, bytes = fo.bytes
  if (opt.chars && bytes) {
    const want = new Set([...String(opt.chars)])
    let lo = null, hi = null
    for (const ch of want) {
      const c = ch.charCodeAt(0)
      if (c < fo.first || c > last) continue
      if (lo === null || c < lo) lo = c
      if (hi === null || c > hi) hi = c
    }
    if (lo !== null) {
      first = lo; count = hi - lo + 1
      const per = w * h
      bytes = fo.bytes.slice((lo - fo.first) * per, (lo - fo.first + count) * per)
    }
  }
  return { w, h, gap, first, count, total, last, bytes }
}

/** 灰度字库 → **两块**文本 (数据与代码分文件, 别让字模把函数/结构体拖进外部 Flash):
 *   · glyph: 字模数组 —— **不带 static** (定义在别的 .c 里, ui_table.h 给 extern);
 *            ext=true → const uint16_t + UI_EXT_RO (GRAY8 字节序列打包, 放 ui_assets_ext.c);
 *            ext=false → const uint8_t (放 ui_assets_int.c);
 *   · struct: `const UI_FONT <name> = { .glyph = <name>Glyph, ... }` —— **留在 ui_font.c**
 *            (CPU 直接读 .w/.h/.glyph 这些字段, 绝不能落外部 W25Q)。
 *   没有像素数据的兜底字库 (网页内置 ASCII 8×11): 两块都留 ui_font.c, 数组保持 static。
 *  opt = { chars, why, ext, attr, lzss } —— lzss = { key } 时字形进 LZSS 表,
 *        struct 里写 .glyph = 0 / .assetBase = UI_ASSET_<key> / .assetChunks。 */
export function exportFontParts(fo, opt = {}) {
  const set = fontGlyphSet(fo, opt)
  const { w: gw, h: gh, gap, first, count, total, last, bytes } = set
  if (!bytes) {                                    /* 没有像素数据 (兜底字库) → 两块都在 ui_font.c */
    const G = [`/* 灰度位图字库: ${fo.w}x${fo.h}, 字符 ${fo.first}..${last} (${total} 个)`,
               ' * 由网页内置 ASCII 字模生成; MCU 侧经 LCD_drawGrayImage × 颜色输出 */',
               `static const uint8_t ${fo.name}Glyph[${fo.bytes.length}] = {`]
    for (let i = 0; i < fo.bytes.length; i += 16)
      G.push('    ' + fo.bytes.slice(i, i + 16).map(hx2).join(',') + ',')
    G.push('};')
    return { glyph: G.join('\n'),
             struct: `const UI_FONT ${fo.name} = { .glyph = ${fo.name}Glyph, .w = ${fo.w}, .h = ${fo.h}, .gap = ${gap}, .first = ${fo.first}, .count = ${total} };`,
             inCode: true }
  }
  if (opt.lzss) {
    const k = opt.lzss.key
    return {
      glyph: '',
      struct: `const UI_FONT ${fo.name} = { .glyph = 0, .w = ${gw}, .h = ${gh}, .gap = ${gap}, .first = ${first}, .count = ${count}, .assetBase = UI_ASSET_${k}, .assetChunks = UI_ASSET_${k}_C, .parts = ${opt.lzss.parts || 1}, .partW = ${opt.lzss.partW || gw} };`,
      inCode: false, lzss: true,
    }
  }
  const saved = (total - count) * gw * gh
  const head = [`/* 灰度位图字库: ${fo.w}x${fo.h}, 字符 ${first}..${first + count - 1} (${count} 个)`
                + (saved > 0 ? ` —— 按用到的最小集导出, 省掉 ${total - count} 个字形 ≈ ${(saved / 1024).toFixed(1)}KB` : ''),
                ` * 用到: ${opt.why || '0-9'}; 每个字形 ${gw}×${gh} = ${gw * gh}B; 总计 ${(bytes.length / 1024).toFixed(1)}KB`,
                ' * MCU 侧经 LCD_drawGrayImage × 颜色输出; 固件按 c-first 取字模 (用的是连续区间)',
                ` * 数组放 ${opt.ext ? 'ui_assets_ext.c' : 'ui_assets_int.c'}; UI_FONT 结构体在 ui_font.c (CPU 直接读字段) */`]
  const G = [...head]
  if (opt.ext) {
    /* 外部最终形态: uint16 元素 + UI_EXT_RO (内存字节序列 = 原字模字节序列) */
    G.push(`const uint16_t ${fo.name}Glyph[${Math.ceil(bytes.length / 2)}] ${opt.attr || EXT_ATTR_MACRO} = {`)
    const vals = packBytesKeepSeq(bytes)
    for (let i = 0; i < vals.length; i += 8)
      G.push('    ' + vals.slice(i, i + 8).map(hx4).join(',') + ',')
  } else {
    G.push(`const uint8_t ${fo.name}Glyph[${bytes.length}] = {`)
    for (let i = 0; i < bytes.length; i += 16)
      G.push('    ' + bytes.slice(i, i + 16).map(hx2).join(',') + ',')
  }
  G.push('};')
  return { glyph: G.join('\n'),
           struct: `const UI_FONT ${fo.name} = { .glyph = ${fo.name}Glyph, .w = ${fo.w}, .h = ${fo.h}, .gap = ${gap}, .first = ${first}, .count = ${count} };`,
           inCode: false }
}

/** 灰度字库 → 一个文件 (数组 + UI_FONT 结构体)。自包含用 (老调用/自检);
 *  导出物走 exportFontParts: 数组进 assets 文件, 结构体留 ui_font.c。 */
export function exportFontC(fo, opt = {}) {
  const p = exportFontParts(fo, opt)
  return p.glyph + '\n' + p.struct
}

/* ---------------- 1d) 分割线 → 区域/帧 ----------------
 * splits: [{ y, frame, color }] 按 y 升序; **每条线控制它到吓一条线之间的区域**;
 * 最后一条线到内容底部为最后一个区域。
 * 返回 [{ y0, y1, h, frame, color, gray }] —— 勾了 frame 的区域会单独成帧 (可导出为素材)。
 */
export function splitRegions(gray, w, h, splits = [], defColor = 0xFFFF) {
  const ys = splits.map(s => Math.max(0, Math.min(h, Math.round(s.y)))).sort((a, b) => a - b)
  const bounds = [0, ...ys, h]
  const out = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const y0 = bounds[i], y1 = bounds[i + 1]
    if (y1 <= y0) continue
    const sp = splits.find(s => Math.round(s.y) === y0) || {}
    const rh = y1 - y0
    const g = new Uint8Array(w * rh)
    for (let r = 0; r < rh; r++) g.set(gray.subarray((y0 + r) * w, (y0 + r) * w + w), r * w)
    out.push({ y0, y1, h: rh, frame: !!sp.frame, color: sp.color == null ? defColor : sp.color, gray: g })
  }
  return out
}

/** 按固定高度均分生成分割线 (切帧高度模式): 每 step px 一条, 从 y=0 开始。
 *  非整除时最后一段自然变矮 (例: h=37, step=2 → 末段 1px)。 */
export function linesEvery(h, step, max = 400) {
  const n = Math.max(1, Math.round(step) || 1)
  const out = []
  for (let y = 0; y < h && out.length < max; y += n) out.push(y)
  return out
}

/** 加线时保证"顶部锚线"存在: 只要开始分割, 最上面那段也必须有人管 (线在 y=0 → 拥有 [0, 下一条线))。
 *  返回**新的**分割线数组 (不改原数组), 已按 y 升序。 */
export function withTopAnchor(splits, y, color = 0xFFFF) {
  const list = (splits || []).map(s => ({ ...s }))
  const ny = Math.max(0, Math.round(y))
  if (!list.some(s => Math.round(s.y) === ny)) list.push({ y: ny, frame: true, color })
  if (!list.some(s => Math.round(s.y) === 0)) list.push({ y: 0, frame: true, color })
  list.sort((a, b) => a.y - b.y)
  return list
}

/** 分割线 → **区域列表视图** (给弹窗下方列表用, 一行 = 一段):
 *  [{ line, y0, y1, h, frame, color }]; line = 管着这段的那条线在 splits 里的下标,
 *  -1 = 顶部那段没人管 (还没有 y=0 的锚线)。与 splitRegions 的划分严格一致。 */
export function regionRows(h, splits = []) {
  const idx = (splits || [])
    .map((s, i) => ({ i, y: Math.max(0, Math.min(h, Math.round(s.y))) }))
    .sort((a, b) => a.y - b.y)
  const out = []
  let prev = 0, owner = -1
  const push = (y0, y1, line) => {
    if (y1 <= y0) return
    const sp = line < 0 ? {} : (splits[line] || {})
    out.push({
      line, y0, y1, h: y1 - y0,
      frame: !!sp.frame,
      color: sp.color == null ? 0xFFFF : sp.color,
    })
  }
  for (const cur of idx) {
    push(prev, cur.y, owner)      // 上一段: 由上一条线拥有 (owner 还是上一条)
    prev = cur.y
    owner = cur.i                 // 这根线拥有它下面那段
  }
  push(prev, h, owner)
  return out
}

/** 预览命中: 鼠标 y (相对画布**边框盒**顶, CSS px) → 内容像素行 (floor = 鼠标所在的那一行)。
 *  画布有 1px 边框, 位图只画在 [border, border+bitmapH) 里; 直接用 rect.height 换算会越往下越偏,
 *  所以这里显式扣掉边框、并按"位图高度"换算 (调用方传 viewH = 位图显示高度)。
 *  越界钳在 [0, rows] (等于 rows 表示落在最底边, 那条线管不到内容)。 */
export function pickRow(clientY, viewH, rows, border = 1) {
  if (!(viewH > 0) || !(rows > 0)) return -1
  const y = (clientY - border) / viewH * rows
  return Math.max(0, Math.min(rows, Math.floor(y)))
}

/** 内置 ASCII 灰度字库 (8×11, ASCII 32..57) 的"字库描述"。
 *  导出名固定 g_uiFontNum8x11 —— 只在"数字图层没自带字库"时兜底出现,
 *  特意不叫 g_uiFontNum, 免得跟工程里自己的同名字库撞车 (duplicate symbol)。
 *  没有指定字库时数字预览/导出用它兜底。 */
export function builtinNumFont(name = 'g_uiFontNum8x11') {
  const fo = exportFont({ name })
  return { name: fo.name, w: fo.w, h: fo.h, first: fo.first, count: fo.count, bytes: new Uint8Array(fo.bytes) }
}

/** 从字库素材里挑出"要用的那些字"拼一份字库描述。
 *  默认挑数字用得到的 (' ', '-', '.', '0'..'9'); opt.chars 可以换成**任意字符集**
 *  (系统字「ASCII 字库」就是拿它拼 0x20..0x7E 那 95 个字形)。
 *  取实际存在的字符里最小~最大字符码, 中间缺的补 0 (固件按 码-first 查表)。
 *  这样字号跟着字库走 (大字库 → 大数字), 导出的字节也只有这一小段。 */
export function numFontFromGlyphs(glyphs, key = '', w = 8, h = 11, gap = 0, opt = {}) {
  if (!glyphs?.length) return null
  const byCh = new Map(glyphs.map(g => [g.ch, g]))
  const want = opt.chars == null ? ' -.0123456789' : String(opt.chars)
  const codes = [...want].map(c => c.charCodeAt(0)).filter(c => byCh.has(String.fromCharCode(c)))
  if (!codes.length) return null
  const first = Math.min(...codes), last = Math.max(...codes)
  const count = last - first + 1
  const gw = Math.max(1, Math.round(w)), gh = Math.max(1, Math.round(h))
  /* 上下纯黑行自动裁掉: 一组字模里"谁都没墨"的行不留 ——
   * 整组一起裁 (不是每个字各裁各的), 所以字模之间的对齐不变, 只是上下不再有空白行。
   * 典型场景: 字库拆分时字高留大了 (9×42 的格子, 实际字迹只有 20 行), 或系统字的行框比字迹高。 */
  let r0 = gh, r1 = -1
  for (let c = first; c <= last; c++) {
    const g = byCh.get(String.fromCharCode(c))
    if (!g?.values) continue
    for (let r = 0; r < gh; r++) {
      if (r >= r0 && r <= r1) continue
      for (let x = 0; x < gw; x++) {
        if (g.values[r * gw + x]) { if (r < r0) r0 = r; if (r > r1) r1 = r; break }
      }
    }
  }
  if (r1 < r0) { r0 = 0; r1 = gh - 1 }          // 整组全空 → 不裁 (保留原格子)
  const kh = r1 - r0 + 1
  /* opt.trimCols: 左右也按"谁都没墨"裁 (默认关 = 逐字节老行为)。
   * 只在**开了光晕**时用 —— 光晕是唯一会让格子比可见字迹宽出东西的东西:
   *   格子按 pad = ceil(3σ) 四周外扩, 但光晕在 3σ 处已经衰减到 0 (round 后就是 0)。
   *   行本来就被裁到可见范围 (上下贴住), 列不裁就左右各留一段纯黑 ——
   *   现场读作"字体很宽却又不长高", 正是上下贴、左右空的不对称。
   * 与行裁剪同口径: **整组一起裁**, 字模之间的相对位置不变。
   * 裁掉的是"肉眼与 5bit 屏都看不见的尾巴", 不是光晕本身。 */
  let c0 = 0, c1 = gw - 1
  if (opt.trimCols) {
    c0 = gw; c1 = -1
    for (let c = first; c <= last; c++) {
      const g = byCh.get(String.fromCharCode(c))
      if (!g?.values) continue
      for (let x = 0; x < gw; x++) {
        if (x >= c0 && x <= c1) continue
        for (let r = r0; r <= r1; r++) {
          if (g.values[r * gw + x]) { if (x < c0) c0 = x; if (x > c1) c1 = x; break }
        }
      }
    }
    if (c1 < c0) { c0 = 0; c1 = gw - 1 }        // 整组全空 → 不裁 (保留原格子)
  }
  const kw = c1 - c0 + 1
  const bytes = new Uint8Array(count * kw * kh)
  /* 逐字一份 (rows) —— 字模表 (2D 数组) 与字节序列都从这一份来, 不会两处算得不一样 */
  const rows = []
  for (let c = first; c <= last; c++) {
    const g = byCh.get(String.fromCharCode(c))
    const row = new Uint8Array(kw * kh)
    if (g?.values) {
      for (let r = 0; r < kh; r++) {
        for (let x = 0; x < kw; x++) {
          const v = g.values[(r + r0) * gw + (x + c0)] || 0
          row[r * kw + x] = v
          bytes[(c - first) * kw * kh + r * kw + x] = v
        }
      }
    }
    rows.push(row)
  }
  return {
    name: 'g_uiFont' + (key ? '_' + key : ''), w: kw, h: kh, gap: Math.max(0, Math.round(gap) || 0),
    first, count, bytes, rows, rowTrim: [r0, r1], rowTrimmed: kh < gh,
    colTrim: [c0, c1], colTrimmed: kw < gw,
  }
}

/** 二维字模表 (每行一个字模) → C 文本: const uint8_t <name>[N][M] = { {..}, .. };
 *  0X 大写十六进制、每行 per 个, 与工程 pic.c / ascii1408.c 同风格。 */
/** 字模表 (文字层 / ASCII 字库层): 二维字节表, 每行一个字形。
 *  attr = UI_EXT_RO 时同样可放外部 (驱动按地址自动分流, 与其它像素数据一致);
 *  ！调用方 (idDrawFunction / asciiStrFunction) 用 `name[id]` 取行, 所以**保持二维形状**,
 *    ui_table.h 里 extern 时带行字节数 (与这里 list[0].length 同源)。 */
export function cGlyphTable(name, rows, per = 16, attr = '') {
  const list = (rows || []).filter(Boolean)
  if (!list.length) return `/* ${name}: 空字库 */`
  const m = list[0].length
  const L = [`const uint8_t ${name}[${list.length}][${m}]${attr ? ' ' + attr : ''} = {`]
  for (const r of list) {
    const inner = []
    for (let i = 0; i < r.length; i += per) {
      inner.push('        ' + Array.from(r.slice(i, i + per)).map(hx2).join(',') + (i + per < r.length ? ',' : ''))
    }
    L.push('    {' + (inner.length > 1 ? '\n' + inner.join('\n') + '\n    ' : inner[0].trim()) + '},')
  }
  L.push('};')
  return L.join('\n')
}

/**
 * ASCII 字库"格子"的上下参数 (纯函数, 自检直接测)。
 *
 * 为什么单拎出来: 字库格子必须**容得下完整字迹**(最高字迹 asc + 最深降部 desc) —— 系统字画布
 * 原来只有 size 高, 而内置字体实测 asc+desc ≈ 1.04~1.18em, 于是 j/g/y/p/q 的尾巴被画布底边切掉
 * (2026-10-14 现场: "某些字的底部被截断, 比如 jgy")。
 * 上下 (offsetY, CSS px) 的语义也在这里定死:
 *   · off < 0 (上移) → 只**从字底收紧** |off| px (裁掉降部尾巴, 字库更矮 = 省 flash);
 *     基线不动 ⇒ **字顶一行都不会被切** (以前是直接平移基线, -1 就把字顶切了);
 *   · off > 0 (下移) → 格子加高 |off| px, 字迹顶部留白 (基线跟着下移), 同样不切任何东西。
 * @param asc 最高字迹到基线的距离 (设备像素, 与 SS 同尺度)
 * @param desc 最深降部 (设备像素)
 * @param offsetY 上下微调 (CSS px)
 * @param ss 超采样倍数 (store.js 的 SS)
 * @returns { inkH, off, boxH, baseline }  boxH 单位 CSS px, baseline 单位设备像素
 */
export function asciiCellBox(asc, desc, offsetY = 0, ss = 4) {
  const A = Math.max(1, Math.round(+asc || 0))
  const D = Math.max(0, Math.round(+desc || 0))
  const inkH = Math.max(1, Math.ceil((A + D) / Math.max(1, ss)))
  /* 收紧到 1px 为止; 下移给个上限 (别写出一个几 KB 的空格子) */
  const off = Math.max(-(inkH - 1), Math.min(64, Math.round(+offsetY || 0)))
  return { inkH, off, boxH: Math.max(1, inkH + off), baseline: A + Math.max(0, off) * Math.max(1, ss) }
}

/** 按 ID 取图的调用函数 (与「＋文字」弹窗里预览的那段完全一致):
 *  外部给 id → 内部一次 drawGrayImage; id 超范围 → 用底色 FILL 填掉这一格。
 *  coord16: 画布/图层最大边缘 > 255 → 坐标参数 uint16_t (uint8_t 会静默截断)。
 *  ascii=true: 这是字符字库 (id = 字符码 - first), 注释里写明, 免得固件侧猜 id 是什么。 */
export function idDrawFunction(name, { count = 1, w = 8, h = 11, table = null, coord16 = false, ascii = false, first = 32, lzss = null } = {}) {
  const t = table || name + 'Pic'
  const CT = coord16 ? 'uint16_t' : 'uint8_t'
  const head = ascii
    ? `/* ${name}: ASCII 字库按 id 取字模 (id = 字符码 - ${first}, 即空格 = 0, 'A' = ${'A'.charCodeAt(0) - first})\n`
      + ` * id 超出 0..${Math.max(0, count - 1)} 时用底色 FILL 填掉这一格; 打字符串更顺手的是 ${name}Str() */\n`
    : `/* ${name}: 外部给 id, 内部取第 id 张图 (内部就是一次 drawGrayImage);\n`
      + ` * id 超出 0..${Math.max(0, count - 1)} 时用底色 FILL 填掉这一格 */\n`
  const call = lzss
    ? `UI_DrawAsset((uint16_t)(UI_ASSET_${lzss.key} + (uint16_t)id * UI_ASSET_${lzss.key}_C), UI_ASSET_${lzss.key}_C, x, y, color, bg, 0)`
    : `LCD_drawGrayImage(x, y, ${w}, ${h}, ${t}[id], color, 0)`
  return head
    + `void ${name}(${CT} x, ${CT} y, uint8_t id, uint16_t color, uint16_t bg)\n{\n`
    + `    if (id < ${count}) ${call};\n`
    + `    else                       LCD_Fill(x, y, x + ${w}, y + ${h}, bg);\n}`
}

/**
 * ASCII 字库的"打字符串"函数 (<字库名>Str): 固件给一整串 → 逐字取模 drawGrayImage,
 * 步进 = 字宽 + 字距 (与字库描述一致), 越界/空格跳过。
 *
 * ！空格必须**跳过不画**: drawGrayImage 是"灰度×颜色", 全 0 的字模会把这格刷成黑,
 *   而不是"保留原背景" (与固件 UI_DrawField 处理数字空格时用底色 Fill 同一个道理)。
 */
export function asciiStrFunction(name, { first = 32, count = 95, w = 8, h = 11, gap = 0, table = null, coord16 = false, lzss = null } = {}) {
  const t = table || name + 'Pic'
  const CT = coord16 ? 'uint16_t' : 'uint8_t'
  const last = first + count - 1
  const step = w + Math.max(0, Math.round(gap) || 0)
  const hex = (v) => '0x' + v.toString(16).toUpperCase().padStart(2, '0')
  /* LZSS: 字模不在数组里, 逐字走 <名字>(id) —— 内部再解压/绘制。
   * bg = 0xFFFF: 不填底色 (空格/越界本来就不画, 保留背景)。 */
  const draw = lzss
    ? `${name}(x, y, (uint8_t)(c - ${first}u), color, 0xFFFFu);`
    : `LCD_drawGrayImage(x, y, ${w}, ${h}, ${t}[c - ${first}u], color, 0);`
  return `/* ${name}Str: 打 ASCII 串 (${hex(first)}..${hex(last)}, ${count} 个字模, 字库 ${t})\n`
    + ` * 逐字 ${lzss ? '解压/绘制 (LZSS 字库)' : 'drawGrayImage'}, 步进 ${step}px (= ${w} 字宽 + ${Math.max(0, Math.round(gap) || 0)} 字距);\n`
    + ` * 空格与范围外的字符跳过 —— 不画, 保留原有背景 (全 0 字模会刷成黑) */\n`
    + `void ${name}Str(${CT} x, ${CT} y, const char *str, uint16_t color)\n{\n`
    + `    for (; *str; str++, x += ${step})\n`
    + `    {\n`
    + `        uint8_t c = (uint8_t)*str;\n`
    + `        if (c < ${first}u || c > ${last}u || c == ' ') continue;\n`
    + `        ${draw}\n`
    + `    }\n}`
}

/** 数字区域的排版 (纯函数): 定宽 cells 格 × 字库字宽 (含字距); 高 = 字库字高。
 *  头/尾字符串不在这里 —— 变量模式只用字库画数字, 前后要加东西请单独放一个文字/图片层。 */
export function numLayout(bind, font) {
  const gw = Math.max(1, Math.round(font?.w) || 8)
  const gh = Math.max(1, Math.round(font?.h) || 11)
  const gap = Math.max(0, Math.round(font?.gap) || 0)          // 字间距 (固件 UI_FONT.gap)
  const cells = Math.max(1, Math.round(+bind?.cells || 1))
  const dw = cells * gw + (cells - 1) * gap
  return { dw, w: dw, h: gh, gw, gh, gap, cells }
}

/** 数字区域更新任务的默认周期 (ms) */
export const UI_TASK_PERIOD_DEF = 200

/** 数字 → 定宽字符串 (与固件 code/spi/app_ui.c 的 UI_FormatNum 逐字一致)。
 *  value 是**放大 dec 位后的整数** (12.5 → value=125, dec=1); pad=1 补前导零 (补在符号后),
 *  pad=0 前面补空格; cells 格放不下返回 null (固件这时返回 -1 → 不画, 保持上次内容)。 */
export function formatNumText(value, dec = 0, cells = 0, pad = 0) {
  const s = formatNumSig(value, dec)
  const sign = s[0] === '-' ? '-' : ''
  const body = sign ? s.slice(1) : s
  if (cells > 0) {
    if (s.length > cells) return null
    const fill = (pad ? '0' : ' ').repeat(cells - s.length)
    return sign + fill + body
  }
  return s
}

/** 数字 → **无补位**的有效串 ("60" / "-3" / "12.5") —— 对齐排布要拿它算宽度。
 *  ！与固件 code/spi/app_ui.c 的 ui_num_sig() 同一口径 (符号在最后生成 → 放到最前)。 */
export function formatNumSig(value, dec = 0) {
  dec = Math.max(0, Math.min(6, Math.round(dec) || 0))
  const v0 = Math.round(Number(value) || 0)
  const neg = v0 < 0
  let v = Math.abs(v0)
  let s = ''
  if (dec) {
    const p = Math.pow(10, dec)
    s = '.' + String(v % p).padStart(dec, '0')
    v = Math.floor(v / p)
  }
  return (neg ? '-' : '') + String(v) + s
}

/**
 * 数字区域的对齐偏移: 首字符相对图层 x 的**像素**偏移。
 *  ！与固件 code/spi/app_ui.c 的 UI_DrawField() 是同一份规则 (改一处必须改另一处):
 *      sig = 有效串(无补位)   cw = 字宽+字距   boxW = cells*cw - gap (显示区总宽)
 *      contentW = n*cw - gap
 *      左(0): 0   中(2): (boxW-contentW+1)/2  ← **像素级**居中: 单个数字落在两格中间
 *      右(1): boxW-contentW   补零(pad=1): 与右对齐绑定 (老口径)
 *  n > cells → 返回 null (固件此时一个字都不画, 保持上次内容)。
 */
export function numFieldLead(bind, font, n) {
  const gw = Math.max(1, Math.round(font?.w) || 8)
  const gap = Math.max(0, Math.round(font?.gap) || 0)
  const cells = Math.max(1, Math.round(+bind?.cells || 1))
  if (!(n >= 1) || n > cells) return null
  const d = (cells - n) * (gw + gap)               /* boxW - contentW (字距约掉) */
  if (bind?.pad) return d                          /* 补零 = 右对齐 */
  const a = bind?.align || 0
  if (a === 2) return Math.round(d / 2)            /* 居中: 像素级 */
  if (a === 1) return d                            /* 右 */
  return 0                                        /* 左 */
}

/** 一段灰度的**内容外框** (去掉四周全 0 的边); 全空返回 null */
export function contentBox(gray, w, h, thr = 0) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (gray[row + x] > thr) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < x0 || y1 < y0) return null
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/**
 * 把勾了「帧」的区域**打包成一张多帧素材** (与图分割同一套模型: 一张图 + dir='row' 竖排切格)。
 * 每格 w×cellH (cellH 默认取最高的那段), 矮的那段用 0 补在下面; 高的不会发生。
 * 放图层时用 inst.frame 选第几帧, MCU 侧一格就是一张图。
 *
 * 另外算出每帧的**内容框** boxes (去掉四周空边): 图层默认只占内容框大小,
 * 于是每个图层导出的数组 = 自己内容的 px 数 (宽窄各不相同) —— 这是省 flash 的关键。
 * @returns { w, h, cellH, count, gray, regions, colors, boxes } | null
 */
export function packFrames(regions, w, { cellH = 0 } = {}) {
  const list = (regions || []).filter(r => r.frame)
  if (!list.length || !(w > 0)) return null
  const ch = Math.max(1, Math.round(cellH) || Math.max(...list.map(r => r.h)))
  const gray = new Uint8Array(w * ch * list.length)
  list.forEach((r, i) => {
    const n = Math.min(ch, r.h)
    for (let y = 0; y < n; y++) gray.set(r.gray.subarray(y * w, y * w + w), (i * ch + y) * w)
  })
  return {
    w, h: ch * list.length, cellH: ch, count: list.length, gray, regions: list,
    colors: list.map(r => (r.color == null ? 0xFFFF : r.color)),   // 每帧的渲染颜色 (图层选帧时带上)
    // 每帧内容框; 全空的那段退回整格 (至少还看得见是空的)
    boxes: list.map(r => contentBox(r.gray, w, r.h) || { x: 0, y: 0, w, h: ch }),
  }
}

/** 文本 + 分割线 → 可直接加入素材库的条目 (勾了"作为一帧"的区域各一条; 另附整段一条) */
export function textToAssets(text, opt = {}) {
  const r = renderTextGray(String(text ?? '').split('\n').map(t => ({ text: t })), {
    mode: opt.mode, charGap: opt.charGap, lineGap: opt.lineGap,
  })
  if (!r.w || !r.h) return { error: '内容为空' }
  const regions = splitRegions(r.gray, r.w, r.h, opt.splits || [])
  const frames = regions.filter(x => x.frame).map((x, i) => ({
    name: (opt.prefix || '内容') + ' ' + (i + 1),
    w: r.w, h: x.h, lineH: x.h, gray: x.gray, color: x.color, y0: x.y0,
  }))
  return { w: r.w, h: r.h, gray: r.gray, regions, frames, error: null }
}

/* ---------------- 2) 素材导出 ---------------- */

/* 与工程 pic.c / ascii1408.c 同风格: 0X 大写十六进制, 每行 16 个 */
const hx2 = (v) => '0X' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0')
/* 素材数组**不加 static**: 定义在 ui_assets_*.c, 由 ui_table.c 的帧表引用
 * (ui_table.h 里有对应的 extern 声明) —— 各 .c 单独编译时必须能看到。 */
const cArr = (name, data, per = 16) => {
  const L = [`const uint8_t ${name}[${data.length}] = {`]
  for (let i = 0; i < data.length; i += per)
    L.push('    ' + Array.from(data.slice(i, i + per)).map(hx2).join(',') + ',')
  L.push('};')
  return L.join('\n')
}

/* ---- 外部 Flash 的"最终形态"导出 (2026-10-13, 对齐 参考工程 固件侧约定) ----
 * 外部素材以 const uint16_t + `UI_EXT_RO` 发射 —— **段名不再出现在生成代码里**:
 *   · `UI_EXT_RO` 是工程侧的宏 (写在导出物目录里那份**不被覆盖**的 ui_user.h 里),
 *     形如 `#define UI_EXT_RO __attribute__((used, section("ER_EXTUI")))`;
 *   · 想换段名/改投放规则只改那个宏, 导出器一行都不用动;
 *   · 链接器经 .sct 把它摆到外部 Flash 绝对地址 (W25Q @ 0x01000000 起), 帧表里
 *     `.px = g_uiFrameN_ext` 的值**在链接时自动就是外部绝对地址** —— 不需要固件侧改名/指针/重打包。
 * ！`used` 必须保留 (否则素材可能被链接器回收); 宏默认值里带着它, 工程改宏时别丢。
 *
 * ！字节序口径 (与固件驱动"按什么粒度读"一一对应, 踩过两次的坑):
 *   · RGB565 (2B/px): 驱动按 **16 位值**读 → 元素就是逻辑像素值 (0xF800 就是红);
 *   · GRAY8  (1B/px): 驱动**逐字节**读 (W25Q 灰度通路一行行读字节) → 元素打包必须
 *     **保持内存字节序列**: 字节对 (b0,b1) → 元素 0Xb1b0 (小端内存里还原成 b0,b1)。
 *     与 RGB565 恰好互为字节交换, 判据是素材自己的 fmt, 不是进制。 */
const hx4 = (v) => '0X' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')
/* 段名的**唯一**落点 = 工程 ui_user.h 里的 UI_EXT_RO; 这里只留一份文档用/兜底用的名字。 */
export const EXT_SECTION = 'ER_EXTUI'
/* 生成代码里写的属性宏名 (生成物只写宏, 不写段名) */
export const EXT_ATTR_MACRO = 'UI_EXT_RO'
/** 工程 ui_user.h 里那份宏的默认定义 (新工程第一次导出时写进 ui_user.h; 老工程有就用自己的) */
export const extAttrDefine = (macro = EXT_ATTR_MACRO, section = EXT_SECTION) =>
  `#ifndef ${macro}\n#define ${macro}  __attribute__((used, section("${section}")))\n#endif`

/** 字节序列 (GRAY8) → uint16 元素列表: 保持内存字节顺序; 奇数长度末尾补 0。 */
export function packBytesKeepSeq(bytes) {
  const out = []
  for (let i = 0; i + 1 < bytes.length; i += 2) out.push(((bytes[i + 1] & 0xFF) << 8) | (bytes[i] & 0xFF))
  if (bytes.length % 2) out.push(bytes[bytes.length - 1] & 0xFF)
  return out
}
/** 外部素材数组 (最终形态): const uint16_t name[N] UI_EXT_RO (宏由工程 ui_user.h 给) */
export function cArrExt(name, u16vals, macro = EXT_ATTR_MACRO, per = 8) {
  const L = [`const uint16_t ${name}[${u16vals.length}] ${macro} = {`]
  for (let i = 0; i < u16vals.length; i += per)
    L.push('    ' + u16vals.slice(i, i + per).map(hx4).join(',') + ',')
  L.push('};')
  return L.join('\n')
}

/** 素材是否需要彩色 (返回 true = RGB565, false = 灰度) */
export function needColor(pixels) {
  for (let i = 0; i < pixels.length; i++) if (pixels[i].rgb) return true
  return false
}

/**
 * 生成素材文件。
 * @param assets [{name, w, h, gray?:Uint8Array, rgb?:Uint16Array}]
 * @param opt {store:'int'|'ext', guard:string, uitable:boolean, extra:string}
 *        uitable=true → 带上 ui_table.h (图层驱动导出会一起生成它, 数组声明在那里);
 *        单文件场景 (弹窗里复制/下载一份素材) 没有这个头, 就别 include。
 *        store='ext' 时还会 include ui_user.h (UI_EXT_RO 宏的定义处, 工程自有、导出不覆盖)。
 *        extra = 额外数据块 (数字字库的字模数组: 按图层的「外部」选择并进这个文件),
 *        排在数组之后、文件尾注释之前。
 */
export function exportAssets(assets, { store = 'int', guard = 'UI_ASSETS_INT_C', uitable = false, perLine = 16, attr = EXT_ATTR_MACRO, extra = '' } = {}) {
  const L = [`/* 由 MCU-LCD-Editer 导出: UI 素材 (${store === 'int' ? '内部 flash' : `外部存储 (${attr}, 最终形态)`})`, '']
  L.push(' * 灰度素材 1B/px: 颜色由渲染时给; 多行素材用 lineH 逐行给色 (菜单)')
  if (store === 'ext') {
    L.push(` * ！最终形态: const uint16_t + ${attr} (工程 ui_user.h 里的宏, 内含 used/段名) —— 链接器经 .sct`)
    L.push(' *   把它摆到外部 Flash 绝对地址, 帧表 .px 的值链接时自动就是外部地址, 覆盖即用。')
    L.push(' *   RGB565 元素 = 逻辑像素值; GRAY8 元素打包保持内存字节序列 (驱动逐字节读)。 */')
  } else {
    L.push(' * 本文件与其他 ui_assets 文件一起编译; 内部/外部由 Keil 的编译位置决定 */')
  }
  L.push(`#include "app_ui.h"`)
  if (uitable) L.push(`#include "ui_table.h"      /* 数组声明: 让编译器对一下签名 (类型/长度不一致会报错) */`)
  /* 外部素材的属性走 UI_EXT_RO —— 宏在工程 ui_user.h 里 (导出只生成一次, 之后不覆盖) */
  if (store === 'ext') L.push(`#include "ui_user.h"      /* ${attr}: 段属性宏 (工程自有, 改段名只改这里) */`)
  L.push('')
  for (const a of assets) {
    if (a.rgb) {
      /* ！字节序: **高字节在前** (big-endian)。
       *   固件侧帧表写的是 `.px = g_uiFrame0_int` 但类型是 `const uint16_t *` (见 app_ui.h 的
       *   UI_FRAME_REF), 驱动 LCD_drawImage 就按 uint16_t 逐个取像素 —— 也就是说
       *   C 数组字面量必须**就是**那个 16 位值: 0xF800 必须写成 0XF8,0X00。
       *   写成低字节在前 (0X00,0XF8) 会被 armcc 以 little-endian 读回 0x00F8,
       *   红色变暗青 —— 而且**编译期一个字都不报**。
       *   参考: 固件侧 tools/img2c.py 的 to_rgb565() 也是这个口径
       *   ("RGB565 的字节序按驱动约定 = 逻辑 RGB565 (0xF800 = 红)")。 */
      if (store === 'ext') {
        /* 最终形态: 元素就是 16 位像素值, 地址交给链接器/.sct (属性走 UI_EXT_RO 宏) */
        L.push(cArrExt(a.name, Array.from(a.rgb), attr))
      } else {
        const u16 = new Uint8Array(a.rgb.length * 2)
        a.rgb.forEach((v, i) => { u16[i * 2] = v >> 8; u16[i * 2 + 1] = v & 0xFF })
        L.push(cArr(a.name, u16, perLine))
      }
    } else if (store === 'ext') {
      /* GRAY8 最终形态: 打包保持内存字节序列 (驱动逐字节读, 不能按值配对) */
      L.push(cArrExt(a.name, packBytesKeepSeq(a.gray), attr))
    } else {
      L.push(cArr(a.name, a.gray, perLine))
    }
    L.push(`/* ${a.name}: ${a.w}x${a.h} ${a.rgb ? 'RGB565(2B/px)' : 'GRAY8(1B/px)'} */`)
    L.push('')
  }
  /* 数字字库的字模 (extra): 与素材同样按图层的「外部」选择落在这个文件里 */
  if (extra && String(extra).trim()) {
    L.push('')
    L.push(String(extra).trimEnd())
  }
  L.push(`/* end ${guard} */`)
  return L.join('\n') + '\n'     /* 尾换行: Keil AC5 会报 warning #1-D (last line without a newline) */
}

/* ---------------- 3) 帧表/区域表导出 ---------------- */

const esc = (s) => String(s).replace(/[^\w]/g, '_')
/** C 变量引用: 允许结构体成员写法 motor.speed / motor->speed / a.b.c (点、箭头两侧可有空格)。
 *  合法的原样输出 (前面加 & 就是取地址); 不合法的退回下划线替换, 保证生成的 C 不会编不过。 */
export function cVarRef(name) {
  const raw = String(name ?? '').trim()
  if (!raw) return ''
  if (/^[A-Za-z_][A-Za-z0-9_]*(\s*(?:\.|->)\s*[A-Za-z_][A-Za-z0-9_]*)*$/.test(raw))
    return raw.replace(/\s*(->|\.)\s*/g, '$1')
  let s = raw.replace(/[^\w]/g, '_')
  if (!/^[A-Za-z_]/.test(s)) s = 'g_' + s        // 数字开头 / 全是符号 → 补个前缀, 保证是合法标识符
  return s
}

/** 成员/下标写法 → 宏名 (motor.speed → UI_SRC_motor_speed)。 */
export function srcMacroName(name) {
  let s = String(name ?? '').trim().replace(/[^\w]/g, '_').replace(/^_+/, '')
  if (!s) s = 'x'
  if (/^\d/.test(s)) s = 'x' + s
  return 'UI_SRC_' + s
}
/** 名字里有没有"成员/下标/箭头"这种需要结构体完整定义的写法 */
export const isMemberRef = (name) => /[.\->\[\]]/.test(String(name ?? '').trim())

/**
 * 区域表里"数值来源"那一格怎么写 (.src = …)。
 *
 *   普通变量 `g_uiSpeedX10`  → `&g_uiSpeedX10`  (声明由 ui_user.h 自动列好)
 *   成员/下标 `motor.speed`  → `UI_SRC_motor_speed`
 *
 * 为什么要宏: `&motor.speed` 要求**结构体的完整定义在这一刻可见**。固件里结构体常常
 * 只定义在自己的 .c 里 (头文件里只有 `extern struct X x;` 这种不完整声明) → Keil 直接
 * 报 `#70: incomplete type is not allowed`。走宏之后写法归用户 (ui_user.h, 不会被覆盖),
 * 可以写包含头、也能换成取值函数。
 */
export function srcExprFor(name) {
  const raw = String(name ?? '').trim()
  if (!raw) return '0'
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return '&' + raw
  return srcMacroName(raw)
}
/** 计划里所有成员写法 → 去重后的宏定义块 (带 #ifndef: ui_user.h 里给了就用它的) */
export function srcMacroDefs(names) {
  const seen = new Map()
  for (const raw of names || []) {
    const t = String(raw ?? '').trim()
    if (!t || !isMemberRef(t)) continue
    const m = srcMacroName(t)
    if (!seen.has(m)) seen.set(m, t.replace(/\s*(->|\.)\s*/g, '$1'))
  }
  if (!seen.size) return ''
  const L = ['/* 区域表里这几个来源是"成员/下标"写法: 结构体定义要可见才能取地址。',
             ' * 写法在 ui_user.h 里给 (那个文件不会被导出覆盖); 没给就用下面的默认写法。 */']
  for (const [m, expr] of seen) {
    L.push(`#ifndef ${m}`)
    L.push(`#define ${m} (&${expr})`)
    L.push('#endif')
  }
  return L.join('\n') + '\n\n'
}

/**
 * @param frames [{name, x, y, w, h, lineH, fmt, mirror, index}]  fmt: 0=RGB565 1=GRAY8
 *        index: 0..N-1 = 画 px 数组里的第几帧 (0 基, px 是数组首地址, 偏移由固件算);
 *               255 = 网页里的 -1 (仅网页渲染) → MCU 侧只清底色, 不渲染
 * @param fields [{type,dec,align,cells,pad,mode,x,y,color,bg,lineColor,hiLine,
 *                 srcName, srcExpr, frameIdx, nframes}]
 * @param opt {name:'ui_table', store:'int'|'ext', head:boolean}
 *        head=false → 不写注释/头文件 (调用方自己在文件最前面写,
 *        因为生成的 .c 里字模块排在表前面, include 必须在最顶部)
 */
export function exportTable(frames, fields, { name = 'ui_table', store = 'int', head = true, lzss = false } = {}) {
  const L = head ? [`/* 由 MCU-LCD-Editer 导出: UI 帧表 + 动态区域表 (${store})`,
              ' * 与 code/spi/app_ui.h 的 UI_FRAME_REF / UI_FIELD 一一对应',
              ' * 用法: UI_SetFields(g_uiFields, UI_FIELD_N); UI_Init(); UI_DrawAll();',
              ' *       1ms 任务里调 UI_Tick() 即可 (值变才刷, 一次最多刷一个区域) */',
              '#include "app_ui.h"',
              ...(lzss ? ['#include "ui_assets_lzss.h"   /* LZSS 素材 ID / UI_ASSET_NONE */'] : []),
              '#include "ui_user.h"      /* 你的变量声明 (这个文件不会被导出覆盖) */', ''] : []
  /* 成员写法 (motor.speed) 的来源宏: 用户没在 ui_user.h 里给就用默认的直接取地址 */
  const mdefs = srcMacroDefs(fields.map(f => f.srcName))
  if (mdefs) L.push(mdefs.trimEnd())   /* ...后面 join 会补一个空行 */
  /* 帧表 */
  frames.forEach((f, i) => {
    L.push(`const UI_FRAME_REF g_uiFrame${i} = {`)
    /* .px 允许"数组 + 整数偏移"表达式 (老导出物的大数组选帧);
     * 新口径不烘偏移: .px = 数组首地址, 选帧走 .index (固件按 index 算偏移)。
     * 「仅尺寸」的层: .px = 0 —— 这一层只提供坐标/尺寸, 不映射到任何数组。 */
    const pxExpr = (f.pxZero || f.lzss) ? '0'
      : (/^[\w+ ]+$/.test(f.name) ? f.name.trim() : esc(f.name))
    /* .index = 0..N-1 画第几帧; 255 = 网页里的 -1 (仅网页渲染) → MCU 侧清底色 */
    const fi = Number.isFinite(+f.index) ? Math.round(+f.index) : 0
    L.push(`    .px = ${pxExpr}, .x = ${f.x}, .y = ${f.y}, .w = ${f.w}, .h = ${f.h},`)
    L.push(`    .lineH = ${f.lineH || 0}, .fmt = ${f.fmt ? 'UI_FMT_GRAY8' : 'UI_FMT_RGB565'}, .mirror = ${f.mirror || 0},`)
    if (lzss) {
      /* 新格式: .asset 指向 LZSS 首片, .index 选第几帧 (帧步长 = _C 片)。
       * 非 LZSS / 仅尺寸的条目一律 UI_ASSET_NONE, 固件只在 .px == 0 且
       * .asset != UI_ASSET_NONE 时才走解压绘制。 */
      const asset = f.lzss ? `UI_ASSET_${f.lzss.key}` : 'UI_ASSET_NONE'
      const chunks = f.lzss ? `UI_ASSET_${f.lzss.key}_C` : '0'
      L.push(`    .index = ${(fi < 0 || fi >= 255) ? 255 : fi}, .asset = ${asset}, .assetChunks = ${chunks}`)
    } else {
      L.push(`    .index = ${(fi < 0 || fi >= 255) ? 255 : fi}`)
    }
    L.push('};')
  })
  L.push('')
  if (frames.length) {
    L.push(`const UI_FRAME_REF *const g_uiFrames[${frames.length}] = {`)
    L.push('    ' + frames.map((_, i) => `&g_uiFrame${i}`).join(', '))
    L.push('};')
    L.push('')
  }
  /* 区域表 (空表兜底: armcc AC5 拒绝空初始化列表 #1514 → 1 个全零占位元素,
   *   UI_FIELD_N 仍为 0, 运行期一次都不会碰它) */
  if (!fields.length) {
    L.push('UI_FIELD g_uiFields[1] = { { 0 } };   /* 占位: armcc 不认空初始化列表 */')
  } else {
    L.push('UI_FIELD g_uiFields[] = {')
    for (const f of fields) {
      const t = f.type === 'num' ? 'UI_T_NUM' : (f.type === 'list' ? 'UI_T_LIST' : 'UI_T_FRAME')
      L.push('    {')
      L.push(`        .type = ${t}, .dec = ${f.dec || 0}, .align = ${['UI_ALIGN_L', 'UI_ALIGN_R', 'UI_ALIGN_C'][f.align || 0]},`)
      L.push(`        .cells = ${f.cells || 0}, .pad = ${f.pad ? 1 : 0},`)
      L.push(`        .x = ${f.x}, .y = ${f.y}, .color = ${colorMacroName(f.color == null ? 0xFFFF : f.color)},`)
      L.push(`        .bg = ${colorMacroName(f.bg == null ? 0xFFFF : f.bg)}, .lineColor = ${colorMacroName(f.lineColor == null ? 0xFFFF : f.lineColor)}, .hiLine = ${f.hiLine == null ? 0xFF : f.hiLine},`)
      L.push(`        .src = ${f.srcExpr || srcExprFor(f.srcName)}, .font = ${f.fontName ? '&' + esc(f.fontName) : '0'},`)
      L.push(`        .frames = ${f.nframes ? 'g_uiFrames' : '0'}, .nframes = ${f.nframes || 0}`)
      L.push('    },')
    }
    L.push('};')
  }
  /* head=false 时表长在 ui_table.h 里以数字给出 (别的 .c 里 g_uiFields 是不完整类型, sizeof 用不了) */
  if (head) L.push(`#define UI_FIELD_N (sizeof(g_uiFields) / sizeof(g_uiFields[0]))`)
  return L.join('\n')
}

/** 把 8bit 灰度渲染成 RGBA 便于 canvas 显示; color 为 0xRRGGBB */
export function grayToRgba(gray, w, h, color = 0xffffff, bg = 0x000000) {
  const out = new Uint8ClampedArray(w * h * 4)
  const cr = (color >> 16) & 0xFF, cg = (color >> 8) & 0xFF, cb = color & 0xFF
  const br = (bg >> 16) & 0xFF, bgc = (bg >> 8) & 0xFF, bb = bg & 0xFF
  for (let i = 0; i < w * h; i++) {
    const a = gray[i] / 255
    out[i * 4]     = br + (cr - br) * a
    out[i * 4 + 1] = bgc + (cg - bgc) * a
    out[i * 4 + 2] = bb + (cb - bb) * a
    out[i * 4 + 3] = 255
  }
  return out
}

/** 逐行着色预览 (菜单: 每行一个颜色) */
export function grayToRgbaLines(gray, w, h, lineH, colors, bg = 0x000000) {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const c = colors[Math.min(colors.length - 1, Math.floor(y / lineH))] ?? 0xffffff
    const cr = (c >> 16) & 0xFF, cg = (c >> 8) & 0xFF, cb = c & 0xFF
    const br = (bg >> 16) & 0xFF, bgc = (bg >> 8) & 0xFF, bb = bg & 0xFF
    for (let x = 0; x < w; x++) {
      const i = y * w + x, a = gray[i] / 255
      out[i * 4]     = br + (cr - br) * a
      out[i * 4 + 1] = bgc + (cg - bgc) * a
      out[i * 4 + 2] = bb + (cb - bb) * a
      out[i * 4 + 3] = 255
    }
  }
  return out
}
