/*
 * 网页 UI 导出自检: node scripts/check-uiexport.mjs
 *
 * 覆盖:
 *   1) splitFrames 垂直切帧: 丢空白条、有效帧重编号、像素内容逐字节正确
 *   2) exportAssets / exportTable 产物语法与字段
 *   3) 【关键】把导出的 .c 与固件 code/spi/app_ui.h + app_ui.c 一起真编译一次
 *      —— 证明网页导出物与固件结构体字段/顺序完全对得上 (字段名写错就编译不过)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { splitFrames, exportAssets, exportTable, grayToRgba, grayToRgbaLines, renderTextGray, exportFont, exportFontC, splitRegions, textToAssets, linesEvery, pickRow, regionRows, withTopAnchor, packFrames, formatNumText, formatNumSig, numFieldLead, numFontFromGlyphs, cVarRef, isMemberRef } from '../src/uiexport.js'
import { asciiFont, ASCII_FONT_W, ASCII_FONT_H, ASCII_MODE1_H } from '../src/asciifont.js'
import { ditherGray565, blurGray } from '../src/imageproc.js'
import { collectLayerPlan, planToFiles } from '../src/layerexport.js'
import { buildColorHeader } from '../src/colordef.js'


let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}

/* ---- 1) 造一张 16x24 的灰度图: 第 0/2 条有内容, 第 1 条全空白 ---- */
const W = 16, H = 24, BH = 8
const gray = new Uint8Array(W * H)
for (let y = 0; y < H; y++) {
  if (y >= BH && y < BH * 2) continue                    // 中间一条留空
  for (let x = 2; x < W - 2; x++) gray[y * W + x] = 200
}
const { frames, dropped } = splitFrames(gray, W, H, BH)
ok('切帧: 3 条 → 2 个有效帧', frames.length === 2, `frames=${frames.length}`)
ok('切帧: 空白条被丢弃并记录', dropped.length === 1 && dropped[0] === BH, `dropped=[${dropped}]`)
ok('切帧: 帧高 = 8, 宽度不切 = 16', frames.every(f => f.h === BH && f.px.length === W * BH))
let pxOk = true
for (const f of frames) {
  const y0 = f.y
  for (let r = 0; r < f.h; r++) for (let x = 0; x < W; x++)
    if (f.px[r * W + x] !== gray[(y0 + r) * W + x]) pxOk = false
}
ok('切帧: 像素逐字节与源图一致', pxOk)

/* bandH 不整除时最后一帧要变矮 */
const s2 = splitFrames(gray, W, H, 5)
ok('切帧: 高度不整除时末帧变矮', s2.frames.length + s2.dropped.length === Math.ceil(H / 5))

/* ---- 1b) 多行文本渲染: 用固件同一份字模, 逐字节可验 ---- */
{
  const f = asciiFont()
  const one = renderTextGray([{ text: 'A' }])
  ok('文本渲染: 单字符块 = 8x11', one.w === 8 && one.h === ASCII_MODE1_H, `${one.w}x${one.h}`)
  const gi = 'A'.charCodeAt(0) - f.first
  let same = true
  for (let r = 0; r < ASCII_MODE1_H; r++)
    for (let c = 0; c < 8; c++)
      if (one.gray[r * 8 + c] !== f.data[gi * 8 * ASCII_FONT_H + r * 8 + c]) same = false
  ok('文本渲染: 灰度值逐字节等于固件字模 A 的前 11 行', same)

  const three = renderTextGray([{ text: 'LEVEL' }, { text: '12.5', align: 1 }, { text: 'x' }], { lineGap: 2, charGap: 1 })
  ok('文本渲染: 3 行不等长 → 块宽取最长行', three.w === 5 * 8 + 4 * 1, `w=${three.w}`)
  ok('文本渲染: 行高/行距 → 总高', three.h === 3 * ASCII_MODE1_H + 2 * 2, `h=${three.h}`)
  ok('文本渲染: 每行总尺寸随行返回(右对齐行)', three.lines[1].w === 4 * 8 + 3 * 1 && three.lines[1].y === ASCII_MODE1_H + 2)
  const bad = (() => { try { renderTextGray([{ text: 'x' }], { lineGap: -1 }); return false } catch { return true } })()
  ok('文本渲染: 负行距被明确拒绝(不静默出错)', bad)
}

/* ---- 1e) 分割线 → 区域/帧 ---- */
{
  const W2 = 8, H2 = 40
  const g = new Uint8Array(W2 * H2)
  for (let y = 0; y < H2; y++) if (y % 10 !== 5) g[y * W2 + 2] = 200      // 每 10 行画一条(第 5 行留空)
  const regs = splitRegions(g, W2, H2, [{ y: 10, frame: true, color: 0xFFE0 }, { y: 25, frame: false }])
  ok('分割线: 3 个区域 (0-10 / 10-25 / 25-40)',
     regs.length === 3 && regs[0].y1 === 10 && regs[1].y0 === 10 && regs[1].y1 === 25 && regs[2].y1 === 40,
     regs.map(r => `${r.y0}-${r.y1}`).join(' '))
  /* 规格: 每条线控制它下面那个区域 → y=10 的线归 10-25 段 */
  ok('分割线: 每条线控制下一个区域 (y=10 的线归 10-25 段)',
     regs[1].frame === true && regs[1].color === 0xFFE0 && regs[0].frame === false, '')
  ok('分割线: 区域像素逐字节正确', regs[1].gray[0] === g[10 * W2 + 0] && regs[1].gray[W2 + 2] === g[11 * W2 + 2], '')
  /* 线的归属: 线那一行 = 下面那段的第一行, 上面那段到线上一行结束 (上面那段不含线这一行)
   * 单独造一张"每行一个不同值"的图, 才能从像素上分辨线归谁 */
  const gg = new Uint8Array(8 * 20)
  for (let y = 0; y < 20; y++) gg[y * 8 + 1] = y + 1
  const rr = splitRegions(gg, 8, 20, [{ y: 7, frame: true }])
  ok('分割线: 线那一行算下面那段 (上面那段到线上一行结束)',
     rr[0].y1 === 7 && rr[1].y0 === 7 && rr[0].gray[6 * 8 + 1] === 7 && rr[1].gray[1] === 8,
     `上段末行值=${rr[0].gray[6 * 8 + 1]} 下段首行值=${rr[1].gray[1]} (线在 y=7)`)
  const t = textToAssets('AB\nCD\nEF', { splits: [{ y: 0, frame: true, color: 0x07FF }, { y: 11, frame: true, color: 0xFFE0 }] })
  /* 3 行文字(33 高) + 两条线(0/11) → 区域 0-11 与 11-33, 后者高 22 */
  ok('文本+分割线: 勾选的区域各成一帧 (高 11 与 22)',
     !t.error && t.frames.length === 2 && t.frames[0].h === 11 && t.frames[1].h === 22,
     t.error || t.frames.map(f => f.name + ':' + f.h).join(' '))
  ok('文本+分割线: 帧颜色跟随分割线', t.frames[0].color === 0x07FF && t.frames[1].color === 0xFFE0, '')
}

/* ---- 1f) 多行内容卡片链路: textToAssets → 帧素材 → 图层导出 ----
 * 弹窗 (MultiLineDialog.vue) 点「加入素材库」= textToAssets + addGrayAsset, 素材形态是
 * "单帧字库" (glyph = 整块, charset='frames'); 这里用同一形态把后半程 (图层→C) 也跑一遍。 */
{
  const t = textToAssets('LEVEL\nMOTOR 1\nSTOP', {
    mode: 1, lineGap: 2,
    splits: [{ y: 0, frame: true, color: 0xFFFF }, { y: 13, frame: false }, { y: 26, frame: true, color: 0xFFE0 }],
  })
  ok('卡片: 3 行 + 3 线 (勾 2 个) → 2 个帧素材', !t.error && t.frames.length === 2,
     t.error || t.frames.map(f => f.name + ':' + f.h).join(' '))
  ok('卡片: 帧素材灰度长度 = w×h (addGrayAsset 直接可用)',
     t.frames.every(f => f.gray.length === f.w * f.h && f.w === t.w),
     t.frames.map(f => `${f.w}x${f.h}=${f.gray.length}`).join(' '))
  const cardAssets = t.frames.map((f, i) => ({
    id: 'card' + i, name: f.name, src: 'data:image/png;base64,AA', w: f.w, h: f.h,
    font: { glyphW: f.w, glyphH: f.h, charset: 'frames', dir: 0, color: f.color },
  }))
  /* fontCells 对 charset='frames' 的切法: chars='' → count = ceil(w / glyphW) */
  ok('卡片: 单帧素材 = 1 格 (字形就是整块)', cardAssets.every(a => Math.ceil(a.w / a.font.glyphW) === 1))
  const plan2 = collectLayerPlan(
    cardAssets.map((a, i) => ({
      id: 'ci' + i, kind: 'image', name: a.name, assetId: a.id, x: 0, y: i * 20,
      w: a.w, h: a.h, fmt: 'GRAY', color: a.font.color, ext: i === 1,
    })), cardAssets, {})
  ok('卡片: 帧素材进图层计划并按"外部"分流',
     plan2.items.length === 2 && plan2.items[0].ext === false && plan2.items[1].ext === true && plan2.items[0].color === 0xFFFF,
     plan2.items.map(i => `${i.key}${i.ext ? '(ext)' : ''}`).join(' '))
  const f2 = Object.fromEntries(planToFiles(plan2, (it) => ({ gray: new Uint8Array(it.w * it.h).fill(255) }), {})
    .files.map(f => [f.name, f.text]))
  const extElems1 = Math.ceil(t.frames[1].w * t.frames[1].h / 2)   /* 外部最终形态: uint16 元素 = 字节/2 */
  ok('卡片: 导出 C 的数组长度 = 各帧像素数 (内部=字节, 外部=字节/2)',
     f2['ui_assets_int.c'].includes(`[${t.frames[0].w * t.frames[0].h}]`) &&
     f2['ui_assets_ext.c'].includes(`[${extElems1}]`) &&
     f2['ui_assets_ext.c'].includes('UI_EXT_RO'))
}

/* ---- 1g) 预览命中换算 + 按高度均分 (窄条) ----
 * 旧写法 (clientY - rect.top) / rect.height * rows 在 border-box + 1px 边框下会越往下越偏,
 * 6 倍放大时底部能偏出整整一行 —— 这里逐行验一遍。 */
{
  const rows = 37, viewH = 222, s = viewH / rows          // 6px/行, 1px 边框
  const bad = []
  for (let k = 0; k < rows; k++) {
    const mid = 1 + (k + 0.5) * s                          // 边框 1px + 第 k 行正中间
    if (pickRow(mid, viewH, rows) !== k) bad.push(k + '→' + pickRow(mid, viewH, rows))
  }
  ok('预览命中: 37 行每行正中间点到的都是那一行 (不越往下越偏)', bad.length === 0, bad.slice(0, 5).join(' '))
  ok('预览命中: 位图顶边 → 第 0 行', pickRow(1, viewH, rows) === 0, String(pickRow(1, viewH, rows)))
  ok('预览命中: 位图底边上一像素 → 最后一行', pickRow(1 + viewH - 0.5, viewH, rows) === rows - 1)
  ok('预览命中: 鼠标在框外也不会给负数/越界', pickRow(-50, viewH, rows) === 0 && pickRow(9999, viewH, rows) === rows)

  /* 按高度均分 → 2px 窄条 */
  const ys = linesEvery(37, 2)
  ok('均分: 37px 内容每 2px 一条 → 19 条 (0..36)', ys.length === 19 && ys[0] === 0 && ys[18] === 36, ys.join(','))
  const regs2 = splitRegions(new Uint8Array(8 * 37), 8, 37, ys.map(y => ({ y, frame: true, color: 0xFFFF })))
  ok('均分: 2px 窄条能成帧 (末段 1px)', regs2.length === 19 && regs2[0].h === 2 && regs2[18].h === 1 && regs2.every(r => r.frame))
  ok('均分: step<1 或 0 当 1 处理 (不会死循环)', linesEvery(5, 0).length === 5 && linesEvery(5, -3).length === 5)
}

/* ---- 1h) 区域列表视图 + 顶部锚线 ----
 * 列表显示的是"段"(区域)不是"线": regionRows 必须和 splitRegions 的划分完全一致。 */
{
  const H3 = 37
  const cases = [
    [{ y: 0, frame: true, color: 0xFFFF }, { y: 13, frame: false }, { y: 26, frame: true, color: 0xFFE0 }],
    [{ y: 13, frame: true, color: 0xFFE0 }],                    // 没有锚线 → 顶部那段没人管
    [],
    [{ y: 0, frame: false, color: 0x07FF }, { y: 37, frame: true }],   // 末段为空
  ]
  let agree = true, why = ''
  for (const sp of cases) {
    const list = regionRows(H3, sp)
    const real = splitRegions(new Uint8Array(8 * H3), 8, H3, sp)
    if (list.length !== real.length) { agree = false; why = `行数 ${list.length}≠${real.length}`; break }
    for (let i = 0; i < list.length; i++) {
      if (list[i].y0 !== real[i].y0 || list[i].y1 !== real[i].y1 || list[i].frame !== real[i].frame || list[i].color !== real[i].color) {
        agree = false
        why = `第 ${i} 段 ${list[i].y0}-${list[i].y1}/${list[i].frame}/${list[i].color} ≠ ${real[i].y0}-${real[i].y1}/${real[i].frame}/${real[i].color}`
      }
    }
    if (!agree) break
  }
  ok('区域列表: 段数/y范围/帧/颜色与 splitRegions 完全一致 (含无锚线/空/末段为空)', agree, why)
  const withAnchor = regionRows(H3, [{ y: 0, frame: true }, { y: 13, frame: false }, { y: 26, frame: true }])
  ok('区域列表: 有锚线时 3 条线 = 3 段 (一段一条线, 一一对应)',
     withAnchor.length === 3 && withAnchor.every((r, i) => r.line === i), withAnchor.map(r => r.line).join(','))
  const noAnchor = regionRows(H3, [{ y: 13, frame: true }])
  ok('区域列表: 没有锚线时 1 条线 = 2 段, 顶部那段 line=-1 (列表会提示补锚线)',
     noAnchor.length === 2 && noAnchor[0].line === -1 && noAnchor[0].y0 === 0 && noAnchor[1].line === 0)

  /* withTopAnchor: 加线时自动补 y=0 (最上面那段才有主) */
  const wa = withTopAnchor([], 11)
  ok('加线: 第一条线在 y=11 时自动补 y=0 锚线 (2 条, 升序)', wa.length === 2 && wa[0].y === 0 && wa[1].y === 11)
  const wb = withTopAnchor([{ y: 0, frame: false }], 20)
  ok('加线: 已有锚线就不重复补', wb.length === 2 && wb.filter(s => s.y === 0).length === 1)
  const wc = withTopAnchor([{ y: 5, frame: false }], 20)
  ok('加线: 老状态缺锚线 → 补上且不动原有的线',
     wc.length === 3 && wc.map(s => s.y).join(',') === '0,5,20' && wc[1].frame === false)
  ok('加线: 点在 y=0 上不会产生重复线', withTopAnchor([{ y: 0 }], 0).filter(s => s.y === 0).length === 1)
}

/* ---- 1i) 打包成多帧素材 (像图分割: 一张图 + dir='row' 竖排切格) ---- */
{
  const src = textToAssets('AB\nCD\nEF', {
    mode: 1, lineGap: 2,
    splits: [{ y: 0, frame: true, color: 0xFFFF }, { y: 13, frame: true, color: 0xFFE0 }, { y: 26, frame: false }],
  })
  const p1 = packFrames(src.regions, src.w)
  ok('打包: 勾了 2 段 → 1 张 2 帧素材 (不是 2 个素材)',
     p1 && p1.count === 2 && p1.cellH === 13 && p1.h === 26 && p1.w === src.w,
     p1 ? `${p1.count}帧 ${p1.w}x${p1.cellH} 总高${p1.h}` : 'null')
  ok('打包: 尺寸与图分割同一套模型 (ceil(总高/格高) = 帧数)',
     Math.ceil(p1.h / p1.cellH) === p1.count)
  let px = true
  p1.regions.forEach((r, i) => {
    for (let y = 0; y < p1.cellH; y++) for (let x = 0; x < p1.w; x++) {
      const want = y < r.h ? r.gray[y * p1.w + x] : 0
      if (p1.gray[(i * p1.cellH + y) * p1.w + x] !== want) px = false
    }
  })
  ok('打包: 每格像素 = 对应段 (矮的段下面补 0)', px)
  ok('打包: 每帧颜色记下来了 (选帧时带出)', p1.colors.join(',') === '65535,65504', p1.colors.join(','))

  /* 不等高: 未勾的那段不参与; 格高 = 参与段的最高 */
  const src2 = textToAssets('ABCDEFGH\nIJ', { mode: 1, lineGap: 3, splits: [{ y: 0, frame: true }, { y: 11, frame: true }] })
  const p2 = packFrames(src2.regions, src2.w)
  ok('打包: 段高不等时格高取最高, 矮段补 0',
     p2.cellH === 14 && p2.count === 2 && p2.h === 28, p2 ? `cellH=${p2.cellH} count=${p2.count}` : 'null')
  ok('打包: 一段都没勾 → null (不会建空素材)', packFrames(src.regions.map(r => ({ ...r, frame: false })), src.w) === null)

  /* 每帧内容框: 省 flash 的关键 —— 每帧宽高按自己的墨迹算 */
  ok('打包: 每帧带内容框 boxes (帧数对得上)', p1.boxes.length === p1.count)
  ok('打包: 内容框都在格子内', p1.boxes.every(b => b.x >= 0 && b.y >= 0 && b.x + b.w <= p1.w && b.y + b.h <= p1.cellH))
  const wide = textToAssets('WWWWWWWW\nI', { mode: 1, lineGap: 1, splits: [{ y: 0, frame: true }, { y: 11, frame: true }] })
  const pw = packFrames(wide.regions, wide.w)
  ok('打包: 宽窄不同的两帧 → 内容框宽度也不同 (各占各的, 不按最宽的算)',
     pw.boxes[0].w > pw.boxes[1].w && pw.boxes[1].w < pw.w,
     pw.boxes.map(b => b.w + 'x' + b.h).join(' / ') + ' (格宽 ' + pw.w + ')')
  const blank = packFrames(src.regions.map(r => ({ ...r, gray: new Uint8Array(r.gray.length) })), src.w)
  ok('打包: 全空的那段退回整格 (不会算出 0×0)', blank.boxes.every(b => b.w === blank.w && b.h === blank.cellH))
}

/* ---- 1j) 十六进制风格: 0X 大写 + 每行 16 (与工程 pic.c / ascii1408.c 一致) ----
 * 用户明确要求: 导出的数组 (含字库那份 g_uiFont0) 必须 0X 大写、每行 16。 */
{
  const dataLines = (txt) => txt.split('\n').filter(l => /^\s+0X/.test(l))
  const styleOk = (txt, total, perLine = 16) => {
    const ls = dataLines(txt)
    if (!ls.length) return false
    return ls.every((l, i) => {
      const n = (l.match(/0X[0-9A-F]{2}/g) || []).length
      return n === Math.min(perLine, total - i * perLine) && /^\s+(0X[0-9A-F]{2},)+$/.test(l)
    }) && ls.length === Math.ceil(total / perLine)
  }
  const fo = exportFont({})
  const fontC = exportFontC(fo)
  ok('字库 C: 0X 大写十六进制 + 每行 16 (2288 字节 = 143 行)', styleOk(fontC, fo.bytes.length),
     dataLines(fontC).length + ' 行')
  ok('字库 C: 没有十进制残留', !fontC.split('\n').some(l => /^\s+\d+,\s*\d+,/.test(l)))
  ok("字库 C: 结构体 first 与数据一致 (32, 不是 '0')",
     fontC.includes('.first = 32') && fo.bytes.slice(0, 88).every(v => v === 0))
  const asC = exportAssets([{ name: 'g_x', w: 16, h: 2, gray: new Uint8Array(32).fill(0xAB) }], { store: 'int' })
  ok('素材 C: 0X 大写十六进制 + 每行 16', styleOk(asC, 32) && asC.includes('0XAB'))
  const rnd = new Uint8Array(40).map((_, i) => (i * 7) & 0xFF)
  /* 外部素材 = 最终形态: const uint16_t + UI_EXT_RO (段名由工程的宏给, 生成物里不出现), GRAY8 打包保持内存字节序列 */
  {
    const extC = exportAssets([{ name: 'g_y', w: 8, h: 5, gray: rnd }], { store: 'ext' })
    const e0 = ((rnd[1] & 0xFF) << 8) | (rnd[0] & 0xFF)
    const eLast = ((rnd[39] & 0xFF) << 8) | (rnd[38] & 0xFF)
    ok('素材 C(外部最终形态): uint16 + UI_EXT_RO + include ui_user.h (不写段名) + 元素数 = 字节数/2',
       extC.includes(`const uint16_t g_y[20] UI_EXT_RO = {`) &&
       extC.includes('#include "ui_user.h"') && !extC.includes('ER_EXTUI') &&
       dataLines(extC).length === Math.ceil(20 / 8))
    const elems = (extC.match(/0X[0-9A-F]{4}/g) || []).map(t => parseInt(t, 16))
    const memBytes = elems.flatMap(v => [v & 0xFF, (v >> 8) & 0xFF])   /* 小端内存还原字节序 */
    ok('素材 C(外部最终形态): GRAY8 内存字节序列逐字节等于原字模',
       memBytes.length === 40 && memBytes.every((b, i) => b === rnd[i]))
  }
}

/* ---- 1k) 数字定宽格式 (必须与固件 UI_FormatNum 逐字一致; 预览就靠它) ---- */
{
  const t = (v, d, c, p) => formatNumText(v, d, c, p)
  ok('数字格式: 125/dec1/5格 → " 12.5" (右对齐补空格)', t(125, 1, 5, 0) === ' 12.5', JSON.stringify(t(125, 1, 5, 0)))
  ok('数字格式: -125/dec1/5格 → "-12.5"', t(-125, 1, 5, 0) === '-12.5')
  ok('数字格式: 补零 5/3格 → "005"', t(5, 0, 3, 1) === '005', JSON.stringify(t(5, 0, 3, 1)))
  ok('数字格式: 负数补零 -5/4格 → "-005" (零补在符号后)', t(-5, 0, 4, 1) === '-005')
  ok('数字格式: 0/dec1/4格 → " 0.0"', t(0, 1, 4, 0) === ' 0.0')
  ok('数字格式: 放不下返回 null (固件返回 -1 → 不画)', t(12345, 0, 3, 0) === null)
  ok('数字格式: cells=0 不限宽', t(-12, 1, 0, 0) === '-1.2', JSON.stringify(t(-12, 1, 0, 0)))
}

/* ---- 1l) 数字字库: 上下纯黑行自动裁掉 (不裁左右, 字模仍等宽对齐) ---- */
{
  const gw = 4, gh = 10
  const mk = (ch, rows) => {           // rows: 有墨的行号
    const v = new Uint8Array(gw * gh)
    for (const r of rows) for (let x = 0; x < gw; x++) v[r * gw + x] = 200
    return { ch, values: v }
  }
  const g = [mk('0', [3, 4, 5, 6]), mk('1', [3, 4]), mk('-', [4, 5])]
  const f = numFontFromGlyphs(g, 'K', gw, gh, 0)
  ok('数字字库: 上下纯黑行被裁掉 (10 行 → 4 行, 记录 rowTrim)',
     f.h === 4 && f.rowTrimmed === true && f.rowTrim[0] === 3 && f.rowTrim[1] === 6, JSON.stringify(f.rowTrim))
  ok('数字字库: 裁的是整组公共行 (字模仍然对齐, 宽度不变)', f.w === gw && f.bytes.length === f.count * gw * 4)
  /* 裁完以后: '0'(原 3~6 行) → 相对 0~3 行; '-'(原 4~5 行) → 相对 1~2 行; '1'(原 3~4 行) → 相对 0~1 行 */
  const gi = (ch) => ch.charCodeAt(0) - f.first
  const at = (ch, r, x = 0) => f.bytes[gi(ch) * gw * f.h + r * gw + x]
  ok('数字字库: 裁完的字模逐字节对得上 (相对行号 = 原行号 - 3)',
     at('0', 0) === 200 && at('0', 3) === 200 && at('0', 1) === 200 &&
     at('-', 0) === 0 && at('-', 1) === 200 && at('1', 1) === 200 && at('1', 2) === 0,
     `0[0]=${at('0', 0)} -[1]=${at('-', 1)} 1[2]=${at('1', 2)}`)
  const flat = numFontFromGlyphs([mk('0', [3, 4]), mk('1', [3, 4])], 'K', gw, gh, 0)
  ok('数字字库: 整组全空时不裁 (保留原格子, 不会变成 0 高)', flat.h === 2 && flat.rowTrimmed === true)
  const empty = numFontFromGlyphs([{ ch: '0', values: new Uint8Array(gw * gh) }], 'K', gw, gh, 0)
  ok('数字字库: 全黑字库退回原高度 (不会算出 0 行)', empty.h === gh && empty.rowTrimmed === false)
}

/* ---- 1m) C 变量引用: 允许结构体成员 motor.speed / motor->speed ---- */
{
  ok('变量引用: 普通名原样', cVarRef('g_uiSpeed') === 'g_uiSpeed')
  ok('变量引用: 点号成员原样 (给固件发 &motor.speed)', cVarRef('motor.speed') === 'motor.speed')
  ok('变量引用: 箭头成员原样', cVarRef('motor->speed') === 'motor->speed' && cVarRef('a.b.c') === 'a.b.c')
  ok('变量引用: 点号两侧的空格会被去掉', cVarRef('  motor . speed  ') === 'motor.speed')
  ok('变量引用: 非法名退回合法标识符 (不会生成编不过的 C)',
     cVarRef('1bad') === 'g_1bad' && cVarRef('bad-name') === 'bad_name' && cVarRef('') === '')
  const tbl = exportTable([], [{ type: 'num', dec: 1, cells: 4, x: 0, y: 0, srcName: 'motor.speed' }], { store: 'int' })
  ok('表 C: 成员写法走 UI_SRC_* 宏 (结构体定义看不见时也能由用户在 ui_user.h 里换写法)',
     tbl.includes('.src = UI_SRC_motor_speed')) 
  ok('表 C: 同时给出带 #ifndef 的默认写法 (老 ui_user.h 也能编)',
     /#ifndef UI_SRC_motor_speed\n#define UI_SRC_motor_speed \(&motor\.speed\)\n#endif/.test(tbl))
  ok('表 C: 普通变量还是直接取地址', exportTable([], [{ type: 'num', cells: 4, x: 0, y: 0, srcName: 'g_uiSpeedX10' }], { store: 'int' }).includes('.src = &g_uiSpeedX10'))
  ok('变量引用: 成员/下标判定', isMemberRef('sys.motor.level') && isMemberRef('a->b') && !isMemberRef('g_uiSpeedX10'))
}

const store = 'int'
const assetsC = exportAssets([
  { name: 'g_uiMenuMask', w: W, h: frames[0].h, gray: frames[0].px },
], { store })
ok('素材 C: 含数组与长度', assetsC.includes('g_uiMenuMask[128]'), '')
ok('素材 C: 注明灰度 1B/px', assetsC.includes('GRAY8(1B/px)'))

/* ---- 2b) 素材字节序: RGB565 必须**高字节在前** ----
 * 固件帧表写 `.px = g_uiFrame0_int` 而类型是 `const uint16_t *` (app_ui.h 的 UI_FRAME_REF),
 * 驱动按 uint16_t 逐像素取 —— 所以 C 数组字面量必须就是那个 16 位值 (0xF800 写成 0XF8,0X00)。
 * 写成低字节在前会被小端 armcc 读回 0x00F8, 颜色整体错位而**编译期不报任何错**。
 * 这里独立按"数组 = uint16 序列"复原一遍, 而不是复述生成代码的写法。 */
{
  const px = [0xF800, 0x07E0, 0x001F, 0xFFFF, 0x0000, 0x4529]
  const c = exportAssets([{ name: 'g_order', w: px.length, h: 1, rgb: Uint16Array.from(px) }], { store: 'int' })
  const body = c.slice(c.indexOf('{') + 1, c.lastIndexOf('}'))
  const bytes = body.split(',').map(s => s.trim()).filter(s => /^0X[0-9A-F]{2}$/.test(s)).map(s => parseInt(s.slice(2), 16))
  const back = []
  for (let i = 0; i + 1 < bytes.length; i += 2) back.push((bytes[i] << 8) | bytes[i + 1])
  ok('素材 C: RGB565 高字节在前 (逐像素可复原)', bytes.length === px.length * 2 && back.join() === px.join(),
     'bytes=' + bytes.slice(0, 4).map(b => b.toString(16)).join(',') + ' → ' + back.slice(0, 2).map(b => '0x' + b.toString(16)).join(','))
  ok('素材 C: 纯红是 0XF8,0X00 (不是 0X00,0XF8)', bytes[0] === 0xF8 && bytes[1] === 0x00,
     bytes.slice(0, 2).map(b => b.toString(16)).join(','))
  const g = exportAssets([{ name: 'g_gray', w: 2, h: 1, gray: Uint8Array.from([0x12, 0x34]) }], { store: 'int' })
  ok('素材 C: 灰度素材仍是逐字节原样 (不参与字节序处理)', g.includes('0X12,0X34'))
}

const tableC = exportTable(
  [{ name: 'g_uiMenuMask', x: 20, y: 70, w: W, h: BH, lineH: BH, fmt: 1 }],
  [
    { type: 'num', dec: 1, align: 1, cells: 5, pad: 0, x: 24, y: 40, color: 0x07FF, bg: 0x0000, srcName: 'g_uiSpeedX10', fontName: 'g_uiFontNum8x11' },
    { type: 'frame', x: 20, y: 70, color: 0x8410, lineColor: 0xFFE0, hiLine: 0, srcName: 'g_uiSelIdx', frameIdx: 0, nframes: 1 },
  ], { store })
ok('表 C: 帧表与区域表都在', tableC.includes('g_uiFrame0') && tableC.includes('g_uiFields[]'))
ok('表 C: 数字字段齐全(.dec/.align/.cells/.font)', /\.dec = 1,[\s\S]*\.align = UI_ALIGN_R,[\s\S]*\.cells = 5/.test(tableC) && tableC.includes('.font = &g_uiFontNum8x11'))
ok('表 C: 数字字段带字库引用', tableC.includes('.font = &g_uiFontNum8x11'))
ok('表 C: 多行色字段 (颜色走 ui_color.h 的宏)', tableC.includes('.lineColor = UI_COLOR_YELLOW'))

/* ---- 3) 真编译: 导出物 + 固件 app_ui.c ---- */
const FW = process.env.FW_DIR || ''
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uiexp-'))
const gen = `
#include "app_ui.h"
#include "ui_color.h"
/* 参数来源由 app 提供: 声明必须在引用它们的表之前 */
int32_t g_uiSpeedX10;
int32_t g_uiSelIdx;
${exportFontC(exportFont({}))}`
+ `
${assetsC}
${tableC}
/* 桩: 记录绘制调用 */
int n_char, n_gray, n_img, n_fill;
void LCD_drawChar(uint8_t x,uint8_t y,char c,uint8_t m,uint16_t col){(void)x;(void)y;(void)c;(void)m;(void)col;n_char++;}
void LCD_drawString(uint8_t x,uint8_t y,void*s,uint8_t m,uint16_t col){(void)x;(void)y;(void)s;(void)m;(void)col;}
uint8_t LCD_Fill(uint8_t a,uint8_t b,uint8_t c,uint8_t d,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)e;n_fill++;return 0;}
uint8_t LCD_drawImage(uint8_t a,uint8_t b,uint8_t c,uint8_t d,const uint8_t*p,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)p;(void)e;n_img++;return 0;}
uint8_t LCD_drawGrayImage(uint8_t a,uint8_t b,uint8_t c,uint8_t d,const uint8_t*g,uint16_t e,uint8_t m){(void)a;(void)b;(void)c;(void)d;(void)g;(void)e;(void)m;n_gray++;return 0;}
#include <stdio.h>
int main(void){
  UI_SetFields(g_uiFields, UI_FIELD_N);
  UI_Init(); UI_DrawAll();
  printf("字段数=%d 填充=%d 灰度=%d\\n", (int)UI_FIELD_N, n_char+n_fill, n_gray);
  return (UI_FIELD_N == 2 && n_gray == 4 && (n_char+n_fill) == 2) ? 0 : 1;
}`
fs.writeFileSync(path.join(tmp, 'uigen.c'), gen)
fs.writeFileSync(path.join(tmp, 'ui_color.h'), buildColorHeader([0x07FF, 0x0000, 0x8410, 0xFFE0, 0xFFFF]))
/* 固件 app_ui.c/h 复制到同目录: 桩头文件才会优先命中 */
const hasFW = fs.existsSync(path.join(FW, 'code/spi/app_ui.c')) && fs.existsSync(path.join(FW, 'code/spi/app_ui.h'))
if (hasFW) {
  fs.copyFileSync(path.join(FW, 'code/spi/app_ui.c'), path.join(tmp, 'app_ui.c'))
  fs.copyFileSync(path.join(FW, 'code/spi/app_ui.h'), path.join(tmp, 'app_ui.h'))
}
fs.writeFileSync(path.join(tmp, 'app_lcd.h'), '#ifndef S1\n#define S1\n#include <stdint.h>\nvoid LCD_drawChar(uint8_t,uint8_t,char,uint8_t,uint16_t);\nvoid LCD_drawString(uint8_t,uint8_t,void*,uint8_t,uint16_t);\n#endif\n')
fs.writeFileSync(path.join(tmp, 'ui_user.h'), '/* 自检: 空用户头 (生成的表会 include 它) */\n#ifndef UI_EXT_RO\n#define UI_EXT_RO  __attribute__((used, section("ER_EXTUI")))\n#endif\n')
fs.writeFileSync(path.join(tmp, 'bsp_gc9a01.h'), '#ifndef S2\n#define S2\n#include <stdint.h>\nuint8_t LCD_Fill(uint8_t,uint8_t,uint8_t,uint8_t,uint16_t);\nuint8_t LCD_drawImage(uint8_t,uint8_t,uint8_t,uint8_t,const uint8_t*,uint16_t);\nuint8_t LCD_drawGrayImage(uint8_t,uint8_t,uint8_t,uint8_t,const uint8_t*,uint16_t,uint8_t);\n#endif\n')

let genOk = false, out = ''
if (hasFW) {
  try {
    execFileSync('gcc', ['-O2', '-Wall', '-I', tmp, path.join(tmp, 'uigen.c'), path.join(tmp, 'app_ui.c'), '-o', path.join(tmp, 'uigen')], { stdio: 'pipe' })
    out = execFileSync(path.join(tmp, 'uigen'), { encoding: 'utf8' }).trim()
    genOk = true
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '') + (e.message || '')
  }
  ok('导出物 + 固件 app_ui.c 真编译并运行 (字段2/填充2/灰度4)', genOk && out === '字段数=2 填充=2 灰度=4', genOk ? out : out.split('\n')[0])
} else {
  ok('导出物 + 固件 app_ui.c 真编译并运行 (SKIP: 环境缺 app_ui.c)', true, 'FW_DIR=' + FW)
}

/* ---- 4) 预览工具不炸 ---- */
ok('灰度预览(单色)', grayToRgba(frames[0].px, W, BH, 0x00ff00).length === W * BH * 4)
ok('灰度预览(逐行着色)', grayToRgbaLines(frames[0].px, W, BH, 4, [0xffffff, 0xffe0]).length === W * BH * 4)

fs.rmSync(tmp, { recursive: true, force: true })
/* ---- 字库按需导出: 用不到的字形 ('.' '-' '/') 不进 flash ---- */
{
  const { neededNumChars } = await import('../src/layerexport.js')
  const f = (dec, neg, demo = 0) => ({ bind: { type: 'num', dec, neg, demo } })
  ok('按需字库: dec=0 且不为负 → 只要 0-9 (不带 . / -)',
     neededNumChars([f(0, false)]).chars === '0123456789', neededNumChars([f(0, false)]).why)
  ok('按需字库: 有小数位 → 带上点号', neededNumChars([f(2, false)]).chars === '.0123456789')
  ok('按需字库: 勾了可能为负 → 带上负号', neededNumChars([f(0, true)]).chars === '-0123456789')
  ok('按需字库: demo 是负数 → 自动带负号 (免得固件画不出负号)',
     neededNumChars([f(1, false, -5)]).chars === '-.0123456789')
  ok('按需字库: 斜杠永远不导 (数字格式化用不到)',
     !neededNumChars([f(3, true, -5)]).chars.includes('/'))

  /* 真裁剪: 造 13 个字形 (每个 4x5: 45='-' 46='.' 47='/' 48..57='0'..'9'), 看导出的计数与字节数 */
  const { exportFontC } = await import('../src/uiexport.js')
  const W = 4, H = 5, N = 13, per = W * H
  const form = (fo, chars) => exportFontC(fo, { chars, why: 'test' })
  const bytes = new Uint8Array(per * N).fill(7)
  const fo = { name: 'g_t', w: W, h: H, gap: 1, first: 45, count: N, bytes }
  const t10 = form(fo, '0123456789')
  ok('按需字库: 只要数字 → 10 个字形 (first=48, count=10, 数组 200B) + 注释写明省了多少',
     t10.includes('.first = 48, .count = 10') && t10.includes('Glyph[200]') && /省掉 3 个字形/.test(t10),
     t10.split('\n')[0])
  const t13 = form(fo, '-.0123456789')
  ok('按需字库: 全要用时仍是 13 个字形 (first=45, count=13)', t13.includes('.first = 45, .count = 13'))
  const t11 = form(fo, '.0123456789')
  /* 区间必须连续 (固件按 c-first 索引, 不连续要额外映射表) → 中间那个用不到的 '/' 会一起带上 */
  ok('按需字库: 要点号不要负号 → first=46 起连续区间 12 个 (含中间用不到的 \'/\')',
     t11.includes('.first = 46, .count = 12') && t11.includes('Glyph[240]'))
}

/* ---- 数字区域的对齐 (numFieldLead): 必须与固件 code/spi/app_ui.c 的 UI_DrawField 逐像素一致 ----
 * 判据来自 tools/num_align 那份主机自检 (同一组数字), 两边算出来必须一样。
 * 现场背景: 网页设了 align=居中, 而固件永远左对齐 → 单个数字停在第二格, 与预览不一致。 */
{
  const font = { w: 59, h: 76, gap: 0 }
  const B = (align, cells, pad) => ({ align, cells, pad })
  ok('对齐: cells=2 单位数居中 → 首字偏移 (118-59+1)/2 = 30',
     numFieldLead(B(2, 2, 0), font, 1) === 30)
  ok('对齐: 两位数字铺满 → 0', numFieldLead(B(2, 2, 0), font, 2) === 0)
  ok('对齐: 右 → 59 (第 2 格)', numFieldLead(B(1, 2, 0), font, 1) === 59)
  ok('对齐: 左 → 0', numFieldLead(B(0, 2, 0), font, 1) === 0)
  ok('对齐: 补零与右对齐绑定 (align 不参与)', numFieldLead(B(2, 2, 1), font, 1) === 59)
  ok('对齐: cells=3 单位数居中 → 59 (两侧各留一段)', numFieldLead(B(2, 3, 0), font, 1) === 59)
  ok('对齐: 放不下 (3 位进 2 格) → null (固件此时不画)', numFieldLead(B(2, 2, 0), font, 3) === null)
  ok('有效串 (无补位): 5 → "5" / -3 → "-3" / 12.5 → "12.5"',
     formatNumSig(5, 0) === '5' && formatNumSig(-3, 0) === '-3' && formatNumSig(125, 1) === '12.5')
  ok('定宽串 (老口径不变): cells=2 pad=0 → " 5" / pad=1 → "05"',
     formatNumText(5, 0, 2, 0) === ' 5' && formatNumText(5, 0, 2, 1) === '05')
}


/* ---- GRAY 字模的 RGB565 预抖动: **两条造字路都必须走它** ----
 * 为什么: 板子把灰度 × 颜色后直接截断进 RGB565 (红/蓝 5 位 = 32 级), 一条 AA 渐变只剩
 *   32 级, 现场读作"边缘锯齿/色带"; 抖动把量化台阶的 contour 打散成细网点。
 * 现场背景: "字库素材"那条路 (fontGlyphValues) 早接了, "系统字"那条路 (numFontForSys,
 *   数字层用系统字渲染时走这里) 漏了 → 中间大数字边缘锯齿 (2026-10-13 现场复现)。
 * 判据:
 *   · 0/255 是 no-op (二值掩膜逐字节不变)
 *   · 烘过抖动的中间灰度**必然全是 8 的倍数** (R/B 5 位步长) ← 导出物外侧也可这么验
 *   · 8×8 块内均值守恒 (无系统偏差)
 *   · 源码级护栏: 两条路都得调用 ditherGray565 (防止再漏一条)
 */
{
  const srctxt = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')
  const bodyOf = (name) => {
    const i = srctxt.indexOf(`export function ${name}(`)
    if (i < 0) return ''
    const j = srctxt.indexOf('\nexport ', i + 10)
    return srctxt.slice(i, j < 0 ? srctxt.length : j)
  }
  ok('抖动: fontGlyphValues (字库素材路) 走 ditherGray565',
     bodyOf('fontGlyphValues').includes('ditherGray565'))
  ok('抖动: numFontForSys (系统字路) 走 ditherGray565',
     bodyOf('numFontForSys').includes('ditherGray565'))

  const bin = ditherGray565(Uint8Array.from([0, 255]), 2, 1)
  ok('抖动: 0/255 是 no-op', bin[0] === 0 && bin[1] === 255)

  const ramp = new Uint8Array(64)
  for (let i = 0; i < 64; i++) ramp[i] = i * 4                 // 0,4,..252 一条斜坡
  const dr = ditherGray565(ramp, 64, 1)
  /* ！顶端会被夹紧: g 接近 255 时 floor 出来的 256 会被钳回 255 (面板对 248/255 输出同值),
   *   所以判据是"0 / 8 的倍数 / 255" —— 中间态不允许出现 8 的非倍数。 */
  ok('抖动: 中间灰度只能落到 0 / 8 的倍数 / 255 (板子截断不再产生误差)',
     [...dr].every(v => v === 0 || v === 255 || v % 8 === 0))
  /* 真实字模 '0' 顶行 (与 LCD_New/ui_font.c 一致): 也必须落到 8 的倍数 */
  const row = [6, 60, 109, 143, 173, 189, 197, 199, 189, 173, 145, 109, 62, 10]
  const drow = ditherGray565(Uint8Array.from(row), row.length, 1)
  ok('抖动: 真实字模顶行 (6,60,109,143,..) 也落到 8 的倍数',
     [...drow].every(v => v % 8 === 0))

  const mean = a => [...a].reduce((s, v) => s + v, 0) / a.length
  let meanOk = true
  for (const g of [24, 60, 100, 160, 200, 240]) {
    const f = new Uint8Array(16 * 16).fill(g)                  // 16×16 = 4 个完整 8×8 块
    if (Math.abs(mean(ditherGray565(f, 16, 16)) - g) > 1) meanOk = false
  }
  ok('抖动: 8×8 块内均值守恒 (±1, 无系统偏差)', meanOk)
}

/* ---- 导出前字体核定: 两个"出文件"的入口都必须过闸 ----
 * 现场背景: 硬刷新后内置字体没到位, canvas 静默用回退字体画并把画布缓存住 →
 *   导出物里 ui_font.c 变成回退字体的字模与字宽 (实测每格 53 vs 真字体 59)。
 * 判据: ① 两个入口组件都调用 ensureFontsReady ② 核定里用 document.fonts.check 复核
 *   ③ 只卡**内置**字体 (用户选的系统字体网页 load 不了, 必须放行, 否则永远导不出)
 *   ④ 判定"画过回退字体"后要清缓存 ⑤ renderSysFontCanvas 确实会标记这件事 */
{
  const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
  const allBtn = read('../src/components/ExportAllButton.vue')
  const panel = read('../src/components/ExportPanel.vue')
  const st = read('../src/store.js')
  ok('字体核定: 「一键导出到文件夹」过闸', allBtn.includes('ensureFontsReady'))
  ok('字体核定: 「复制全部 / 下载 .c」过闸', panel.includes('ensureFontsReady'))
  const i = st.indexOf('export async function ensureFontsReady(')
  const body = i < 0 ? '' : st.slice(i, i + 1600)
  ok('字体核定: 除 load 外用 document.fonts.check 复核', body.includes('fontsAvailable'))
  ok('字体核定: 只卡内置字体 (系统字体放行, 否则用户永远导不出)', body.includes('isBuiltinFamily'))
  ok('字体核定: 判定画过回退字体后清缓存', body.includes('refreshFontMetrics'))
  ok('字体核定: renderSysFontCanvas 会标记"画过回退字体"', st.includes('sysFontSuspect = true'))
}

/* ---- 字库「边缘斜坡 σ」: 治大字号斜边/圆弧的台阶 (浏览器给的字形 AA 只有 ~1px) ----
 * 判据:
 *   · σ=0 严格 no-op (一个字节都不动) —— 默认绝不改变现有观感
 *   · σ>0 必须**真的把斜坡摊宽** (过渡像素数明显变多), 且不改变整体明暗 (均值守恒)
 *   · 输出是 0..255 整数 (导出成 C 数组, 不能有小数/越界)
 *   · 两条造字路都要走它; **σ>0 与 565 预抖动互斥** (2026-10-16 现场):
 *     抖动把边缘灰度重量化到 8 的整数倍, 而 σ 摊出的斜坡上总有半档值 (真机 124 = 15.5×8)
 *     → Bayer 逐行推成 120/128, 笔直竖边变成周期 2 行梳齿 ("1" 右边缘 73 行翻转 17 次)。
 *     字模没有大面积平坦渐变, 抖动买不到抗色带收益 ⇒ σ>0 时只 blurGray, σ=0 时才 ditherGray565。
 *   · σ 是**每层/每个字库自己的**配置 (系统字: 对话框里的 cfg.rampSigma; 字库素材: asset.font.rampSigma),
 *     不是工程级导出选项 —— 2026-10-13 现场纠偏: 不同层可能要不同宽度, 而且它属于"这个字库"的属性 */
{
  const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
  const st = read('../src/store.js')
  const panel = read('../src/components/ExportPanel.vue')
  const textDlg = read('../src/components/TextDialog.vue')
  const fontDlg = read('../src/components/FontSplitDialog.vue')
  const bodyOf = (name) => {
    const i = st.indexOf(`export function ${name}(`)
    if (i < 0) return ''
    const j = st.indexOf('\nexport ', i + 10)
    return st.slice(i, j < 0 ? i + 5000 : j)
  }
  ok('斜坡: 不在工程级导出选项里 (每层自己设)', !/exportOpts[^\n]*rampSigma/.test(st) && !panel.includes('exportOpts.rampSigma'))
  const sysBody = bodyOf('numFontForSys'), assetBody = bodyOf('fontGlyphValues')
  ok('斜坡: 系统字路读这一层自己的 cfg.rampSigma', sysBody.includes('cfg.rampSigma'))
  ok('斜坡: 字库素材路读这个字库自己的 f.rampSigma', assetBody.includes('f.rampSigma'))
  ok('斜坡: 「字库素材」那条路 (fontGlyphValues) 走 blurGray', assetBody.includes('blurGray('))
  ok('斜坡: 「系统字」那条路 (numFontForSys) 走 blurGray', sysBody.includes('blurGray('))
  ok('斜坡: 系统字路 σ>0 时不抖动 (互斥, 防直边梳齿)',
     /if \(ramp > 0\)[^\n]*blurGray\([^\n]*\n\s*else if \([^\n]*ditherGray565\(/.test(sysBody))
  ok('斜坡: 字库素材路 σ>0 时同样不抖动 (互斥)',
     /if \(fmt === 'GRAY' && ramp > 0\)[^\n]*blurGray\([^\n]*\n\s*else if \([^\n]*ditherGray565\(/.test(assetBody))
  /* 数值回归: 硬竖边 → 只模糊 = 每列逐行恒定 (笔直); 模糊后再叠 565 抖动 = 出现逐行交替 (梳齿) */
  {
    const W = 16, H = 16
    const hard = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) hard[y * W + x] = x < 8 ? 255 : 0
    const spread = a => {
      let s = 0
      for (let x = 0; x < W; x++) {
        const c = []
        for (let y = 0; y < H; y++) c.push(a[y * W + x])
        s = Math.max(s, Math.max(...c) - Math.min(...c))
      }
      return s
    }
    const blurred = blurGray(hard, W, H, 0.7)
    ok('斜坡: σ 模糊后不做抖动 → 直边逐行恒定 (笔直)', spread(blurred) === 0, `spread=${spread(blurred)}`)
    ok('斜坡: σ 模糊后再叠 565 抖动 → 直边出现逐行交替 (现场那道梳齿)',
       spread(ditherGray565(blurred, W, H)) > 0, `spread=${spread(ditherGray565(blurred, W, H))}`)
  }
  ok('斜坡: 系统字对话框有开关 (draft.rampSigma) 且写进这一层的 cfg',
     textDlg.includes('v-model.number="draft.rampSigma"') && textDlg.includes('rampSigma: Math.max(0, Math.min(2'))
  ok('斜坡: 字模分割对话框有开关 (f.rampSigma) 且写进这个字库的 font 配置',
     fontDlg.includes('v-model.number="f.rampSigma"') && /font: \{[\s\S]{0,220}?rampSigma:/.test(fontDlg))

  /* 纯函数行为: 用一条"台阶边"字模验 */
  const gw = 16, gh = 16
  const edge = new Uint8Array(gw * gh)
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) edge[y * gw + x] = x < 8 ? 0 : 255
  const zero = blurGray(edge, gw, gh, 0)
  ok('斜坡: σ=0 严格 no-op (逐字节相同)', [...zero].every((v, i) => v === edge[i]))
  const soft = blurGray(edge, gw, gh, 0.7)
  const inter = a => [...a].filter(v => v > 0 && v < 255).length
  ok('斜坡: σ=0 台阶边没有过渡像素', inter(edge) === 0)
  ok('斜坡: σ=0.7 把台阶摊成过渡 (≥2 列梯度)', inter(soft) >= 2 * gh - 4)
  const mean = a => [...a].reduce((s, v) => s + v, 0) / a.length
  ok('斜坡: 均值守恒 (±1, 不整体变亮/变暗)', Math.abs(mean(edge) - mean(soft)) <= 1)
  ok('斜坡: 输出全是 0..255 整数', [...soft].every(v => Number.isInteger(v) && v >= 0 && v <= 255))
  const ramp = new Uint8Array(gw * gh)
  for (let i = 0; i < ramp.length; i++) ramp[i] = i % 256
  const softRamp = blurGray(ramp, gw, gh, 0.7)
  ok('斜坡: 连续渐变上 σ=0.7 的过渡像素不减少 (只会更宽)',
     inter(softRamp) >= inter(ramp))
}

/* ---- ASCII 字库 (系统字「内容 = ASCII 字库」): 任意字符集的字库描述 + 打字符串函数 ----
 * 判据:
 *   · numFontFromGlyphs 的字符集可换 (opt.chars): 默认仍是数字那 13 个, 传 ASCII 就出 95 个,
 *     rows (逐字) 与 bytes (连续) 是同一份数据 (导出走 2D 表, 固件按 w*h 步进取)
 *   · asciiStrFunction 生成的函数: 逐字 drawGrayImage、步进 = 字宽+字距、**空格与越界跳过**
 *     (空格字模全 0, 画下去是黑不是"保留背景" —— 与固件 UI_DrawField 处理数字空格同一口径)
 *   · 系统字 ASCII 那条造字路 (store.asciiFontForSys) 也必须走 blurGray (σ) / ditherGray565 (仅 σ=0)
 */
{
  const { asciiStrFunction, idDrawFunction } = await import('../src/uiexport.js')
  const srctxt = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')
  const bodyOf = (name) => {
    const i = srctxt.indexOf(`export function ${name}(`)
    if (i < 0) return ''
    const j = srctxt.indexOf('\nexport ', i + 10)
    return srctxt.slice(i, j < 0 ? srctxt.length : j)
  }

  const gw = 4, gh = 6
  const CHARS = (() => { let s = ''; for (let c = 0x20; c <= 0x7E; c++) s += String.fromCharCode(c); return s })()
  const glyphs = [...CHARS].map((ch, i) => {
    const v = new Uint8Array(gw * gh)
    for (let p = 0; p < v.length; p++) v[p] = (i * 7 + p) & 0xFF
    return { ch, values: v }
  })
  const f = numFontFromGlyphs(glyphs, 'ASC', gw, gh, 0, { chars: CHARS })
  ok('ASCII 字库: opt.chars 能把字符集换成整份 0x20~0x7E (95 个, first=32, count=95)',
     f.count === 95 && f.first === 32 && f.rows.length === 95, `count=${f.count} first=${f.first}`)
  ok('ASCII 字库: rows (逐字) 与 bytes (连续) 是同一份数据',
     f.bytes.length === 95 * f.w * f.h &&
     f.rows.every((r, i) => r.length === f.w * f.h &&
       [...r].every((v, k) => v === f.bytes[i * f.w * f.h + k])))
  ok('ASCII 字库: 默认 (不传 opt.chars) 还是数字那一段字模, 不会把整份 ASCII 都带上',
     (() => { const d = numFontFromGlyphs(glyphs, 'ASC', gw, gh, 0)
       return d.count < 95 && d.first === 0x20 && d.first + d.count - 1 === 0x39 })(),
     JSON.stringify(numFontFromGlyphs(glyphs, 'ASC', gw, gh, 0).count))

  const fn = asciiStrFunction('mix', { first: 32, count: 95, w: 9, h: 14, gap: 1 })
  ok('ASCII 字库: Str() 签名/步进 = 字宽+字距 (9+1=10)',
     fn.includes('void mixStr(uint8_t x, uint8_t y, const char *str, uint16_t color)') &&
     fn.includes('x += 10)') && fn.includes('mixPic[c - 32u]'))
  ok('ASCII 字库: Str() 跳过空格与范围外字符 (否则全 0 字模会把背景刷黑)',
     fn.includes("c == ' ') continue;") && fn.includes('c < 32u || c > 126u'))
  ok('ASCII 字库: 坐标超 255 时 Str() 也用 uint16_t (与 id 版同一判定)',
     asciiStrFunction('mix', { count: 95, first: 32, coord16: true })
       .includes('void mixStr(uint16_t x, uint16_t y, const char *str, uint16_t color)'))
  const idFn = idDrawFunction('mix', { count: 95, w: 9, h: 14, ascii: true, first: 32 })
  ok('ASCII 字库: 按 id 取图的函数注释写明 id = 字符码 - 32 (固件不用猜)',
     idFn.includes('id = 字符码 - 32') && idFn.includes("'A' = 33") && idFn.includes('mixStr()'))
  ok('ASCII 字库: 普通文字层的 id 函数注释不变 (老工程导出物不受影响)',
     idDrawFunction('str1', { count: 2, w: 8, h: 11 }).includes('id 超出 0..1 时用底色 FILL')
     && !idDrawFunction('str1', { count: 2 }).includes('字符码'))

  const asciiBody = bodyOf('asciiFontForSys')
  ok('ASCII 造字路: 走 blurGray (边缘斜坡 σ), σ>0 时不做 565 抖动 (互斥)',
     asciiBody.includes('blurGray(') && asciiBody.includes('ditherGray565(') &&
     /if \(ramp > 0\)[^\n]*blurGray\([^\n]*\n\s*else if \([^\n]*ditherGray565\(/.test(asciiBody))
  ok('ASCII 造字路: 读这一层自己的 cfg.rampSigma / 用 numFontFromGlyphs 拼 95 个字模',
     asciiBody.includes('cfg.rampSigma') && asciiBody.includes('numFontFromGlyphs(') &&
     /\{ chars: ASCII_PRINTABLE, trimCols: pad > 0 \}/.test(asciiBody))
  ok('ASCII 字库常量: 95 = 0x7E-0x20+1, 与对话框/导出用的是同一个数',
     /export const ASCII_COUNT = 0x7E - 0x20 \+ 1/.test(srctxt) &&
     /export const ASCII_PRINTABLE = \(\(\) =>/.test(srctxt))

  /* ---- 字库格子高度: 必须容下"最高字迹 + 最深降部", 否则 j/g/y/p/q 的尾巴被切 ----
   * 现场 (2026-10-14): 画布只有 size 高, 而内置字体实测 asc+desc = 1.04~1.18em
   * (`$`/`(` 最高约 0.87em, j/g/y 最深约 0.28em) → 字底被裁掉一整圈像素。 */
  {
    const { asciiCellBox } = await import('../src/uiexport.js')
    const SS = 4, size = 20
    /* MiSans 400 实测: asc 0.842em, desc 0.255em (设备像素 = ×SS) */
    const asc = Math.round(0.842 * size * SS)      // 67
    const desc = Math.round(0.255 * size * SS)     // 20
    const b0 = asciiCellBox(asc, desc, 0, SS)
    ok('格子高度: = 完整字迹 (asc+desc) 向上取整, 不再等于字号 (字号 20 → 格子 22)',
       b0.inkH === Math.ceil((asc + desc) / SS) && b0.inkH === 22 && b0.boxH === 22,
       JSON.stringify(b0))
    ok('格子高度: 字迹完整落在格子里 (基线 - asc ≥ 0 且 基线 + desc ≤ 格子×SS)',
       b0.baseline - asc >= 0 && b0.baseline + desc <= b0.boxH * SS,
       `baseline=${b0.baseline} box=${b0.boxH * SS}`)
    const up = asciiCellBox(asc, desc, -1, SS)
    ok('上下 = -1: 只从字底收紧 1px, **字顶一行不动** (基线不变)',
       up.boxH === 21 && up.baseline === b0.baseline && up.baseline - asc >= 0 &&
       up.baseline + desc > up.boxH * SS, JSON.stringify(up))
    const down = asciiCellBox(asc, desc, 2, SS)
    ok('上下 = +2: 格子加高 2px + 字迹下移 2px (上留白), 上下都不切',
       down.boxH === 24 && down.baseline === b0.baseline + 2 * SS &&
       down.baseline - asc >= 0 && down.baseline + desc <= down.boxH * SS, JSON.stringify(down))
    let topOk = true, bottomOk = true
    for (let off = -6; off <= 6; off++) {
      const b = asciiCellBox(asc, desc, off, SS)
      if (b.baseline - asc < 0) topOk = false
      if (off >= 0 && b.baseline + desc > b.boxH * SS) bottomOk = false
    }
    ok('上下: 任意偏移都不会切字顶 (=-6..+6 全扫一遍)', topOk)
    ok('上下: 非负偏移不会切字底', bottomOk)
    ok('上下: 收到 1px 为止 / 上限 64 (不会写出空格子)', 
       asciiCellBox(asc, desc, -999, SS).boxH === 1 && asciiCellBox(asc, desc, 999, SS).boxH === 22 + 64)

    /* 源码级护栏: 两条路都必须走这套格子 */
    ok('格子: asciiFontForSys 量 asc+desc 并把 boxH/baseline 交给渲染',
       asciiBody.includes('sysInkFor(') && asciiBody.includes('asciiCellBox(') &&
       asciiBody.includes('boxH, baseline'))
    ok('格子: 量字迹时读的是 actualBoundingBoxDescent (只量 ascent 就是老 bug)',
       (() => {
         const i = srctxt.indexOf('function sysInkFor(')
         const seg = i < 0 ? '' : srctxt.slice(i, i + 900)
         return seg.includes('actualBoundingBoxAscent') && seg.includes('actualBoundingBoxDescent')
       })())
    const renderBody = srctxt.slice(srctxt.indexOf('export function renderSysFontCanvas('),
                                    srctxt.indexOf('/* 本地字体文件管理'))
    ok('格子: renderSysFontCanvas 支持 cfg.boxH/cfg.baseline (字库格子由调用方定)',
       renderBody.includes('cfg.boxH') && renderBody.includes('cfg.baseline'))
    ok('格子: 没给 boxH 的画布 (普通系统字文字层) 按字迹兜住上下偏移 —— 上下=-1 不再切字顶',
       renderBody.includes('padTop') && renderBody.includes('padBottom') &&
       /padTop \+ offDev \+ ascent/.test(renderBody))
  }
}

process.exit(fails ? 1 : 0)
