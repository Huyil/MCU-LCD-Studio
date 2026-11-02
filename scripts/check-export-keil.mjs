/*
 * 一键导出 → Keil 工程真编译自检: node scripts/check-export-keil.mjs
 *
 * 为什么单开一套: 前面的检查都在测"纯函数" (collectLayerPlan / planToFiles),
 * 而用户点「一键导出」走的是 **store.exportLayer()** —— 它是另一条代码路径,
 * 生成素材文本的地方一度和帧表各写各的, 于是真实工程里出现:
 *     L6218E: Undefined symbol g_uiFont_g_uiField0 (referred from ui_table.o)
 *     L6218E: Undefined symbol g_uiFrame0_int (referred from ui_table.o)
 * 表里引用 g_uiFrame0_int, 素材文件里却叫 gImage_g_uiFrame0_int —— 纯函数检查完全看不见。
 *
 * 所以这里就按 Keil 的方式来: 用**真的 store.exportLayer()** 产出文件
 * (canvas/Image 用桩), 然后**逐个 .c 单独 gcc -c**, 再链接固件真 app_ui.c 跑一遍。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

let fails = 0
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`); if (!c) fails++ }

/* ---------------- 浏览器 API 桩 (和 check-card 同一套思路) ---------------- */
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null }, setItem(k, v) { this._m.set(k, String(v)) } }
globalThis.indexedDB = { open() { throw new Error('no idb in node') } }
globalThis.fetch = async () => { throw new Error('no net in node') }
const IMG_DIMS = new Map()
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') return {}
    const cv = {
      width: 0, height: 0, _px: null,
      getContext() {
        const ctx = {
          _font: '',
          createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: (img) => { cv._px = img.data },
          getImageData: (x, y, w, h) => {
            const d = new Uint8ClampedArray(w * h * 4)
            for (let i = 0; i < w * h; i++) {           // 桩像素: 每个像素一个可辨的值
              d[i * 4] = (i * 3) & 0xFF; d[i * 4 + 1] = (i * 7) & 0xFF; d[i * 4 + 2] = (i * 11) & 0xFF; d[i * 4 + 3] = 255
            }
            return { width: w, height: h, data: d }
          },
          drawImage() {}, clearRect() {}, fillRect() {}, fillText() {},
          measureText(t) {
            const m = /(\d+(?:\.\d+)?)px/.exec(this._font) || []
            const size = m ? parseFloat(m[1]) : 16
            return { width: String(t).length * size * 0.6, actualBoundingBoxAscent: size * 0.75 }
          },
        }
        Object.defineProperty(ctx, 'font', { get() { return this._font }, set(v) { this._font = v } })
        return ctx
      },
      toDataURL: () => 'data:image/png;base64,KEIL',
    }
    return cv
  },
}
globalThis.Image = class {
  constructor() { this.complete = true; this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0 }
  set src(v) {
    this._src = v
    const d = IMG_DIMS.get(v) || [16, 16]
    this.naturalWidth = this.width = d[0]
    this.naturalHeight = this.height = d[1]
  }
  get src() { return this._src }
}

const store = await import('../src/store.js')
const { state, addGrayAsset, addInstance, addTextInstance, bindDefaults, exportLayer, screen } = store
const { collectLayerPlan } = await import('../src/layerexport.js')
store.initPersistence?.()

/* ---------------- 搭一个"像用户工程"的画面: 灰度图标 + 彩图 + 文字层 + 数字层 ---------------- */
state.instances = []
/* 素材: 直接塞字节 (addGrayAsset 会走 canvas, 像素由上面的桩给) */
const g1 = addGrayAsset('图标', new Uint8Array(12 * 20).fill(0x80), 12, 20)
const g2 = addGrayAsset('彩图', new Uint8Array(39 * 18).fill(0x40), 39, 18)
IMG_DIMS.set(g1.src, [12, 20]); IMG_DIMS.set(g2.src, [39, 18])
const i1 = addInstance(g1.id, 190, 124, { fmt: 'GRAY' })
i1.pages = [0, 2]                               // 多页图层: 0 页和 2 页(A圆环页)都画它, 但素材只导一份
const i2 = addInstance(g2.id, 174, 102, { fmt: 'RGB565' })
i2.ext = true                                   // 图层行上的「外部」勾选
/* 文字层: 需要带 font 的字库素材 (字符集 AB) */
const fs1 = addGrayAsset('字库', new Uint8Array(16 * 11).fill(0x60), 16, 11,
  { charset: 'custom', custom: 'AB', glyphW: 8, glyphH: 11, frames: 2 })
IMG_DIMS.set(fs1.src, [16, 11])
const i3 = addTextInstance(fs1.id)
if (i3) { i3.x = 10; i3.y = 60 }
/* 圆环: 放第 2 页 → 导出成 LCD_Page2_Enter(启圆环)/Exit(停圆环) */
const rg = store.addRingInstance()
rg.page = 2
const i4 = addInstance(g1.id, 51, 62, { fmt: 'GRAY' })
i4.bind = { ...bindDefaults('Speed'), name: 'g_uiSpeedX10', dec: 1, cells: 5, demo: 125 }
/* 系统字图层 (「＋文字」→ 系统字库): 无素材, 由系统字体渲染 —— 它的尺寸/步长一致性就是老 bug */
const i5 = {
  id: 'inst_sys1', kind: 'text', page: 0, name: 'sys_1',
  sysfont: { text: 'MOTOR 12', family: 'MiSans', size: 20, weight: 400, spacing: 0, lineGap: 0, offsetY: 0 },
  x: 30, y: 90, w: 8, h: 8, fmt: 'GRAY', color: 0xFFFF, mirror: 0,
}
state.instances.push(i5)
store.updateInstance(i5.id, { sysfont: { ...i5.sysfont } })     // → syncSysSize 定尺寸 (墨迹框)
/* 系统字「ASCII 字库」层 (「＋文字」→ 系统字库 → 内容 = ASCII 字库):
 * 出的不是一张定死的图, 而是整份 0x20~0x7E 字模表 + <名字>() / <名字>Str() 两个函数 */
const i5b = {
  id: 'inst_ascii1', kind: 'image', page: 0, name: 'asc_1', ascii: true,
  sysfont: { text: 'ABC', family: 'MiSans', size: 20, weight: 400, spacing: 0, lineGap: 0, offsetY: 0 },
  x: 120, y: 150, w: 8, h: 8, fmt: 'GRAY', color: 0xFFFF, mirror: 0,
}
state.instances.push(i5b)
store.updateInstance(i5b.id, { sysfont: { ...i5b.sysfont } })
/* 隐藏页: 关机充电页 (-2) 加一层再**隐藏** —— 生成代码必须能编过, 且 Enter 是空壳 (只清屏等新状态) */
{
  const i6 = addInstance(g1.id, 8, 8, { fmt: 'GRAY' })
  i6.page = -2
  state.pages = { ...(state.pages || {}), '-2': { hidden: true } }
}
screen.value.pages = screen.value.pages || {}

const out = exportLayer()
const byName = Object.fromEntries(out.files.map(f => [f.name, f.text]))
ok('一键导出含工程备份 lcd-project.json (内嵌字库)', !!byName['lcd-project.json'])
ok('一键导出含 ui_color.h, ui_table.h include 它 (颜色宏)',
   !!byName['ui_color.h'] && /#include "ui_color\.h"/.test(byName['ui_table.h']) &&
   /#define UI_COLOR_WHITE\s+0xFFFF/.test(byName['ui_color.h']))
ok('ui_color.h 只列当前用到的颜色, 不是全 244 色表',
   !/UI_COLOR_BLUE_SKY/.test(byName['ui_color.h']) &&
   (byName['ui_color.h'].match(/^#define UI_COLOR_(?!H\b)/gm) || []).length < 30)
ok('生成代码颜色用 UI_COLOR_* 宏, 不再写死 0xXXXX',
   /\.color = UI_COLOR_/.test(byName['ui_table.c']) &&
   /UI_DrawFrame\(&g_uiFrame0, UI_COLOR_/.test(byName['ui_table.c']) &&
   /#define UI_PAGE_BG UI_COLOR_/.test(byName['ui_task.c']) &&
   !/\.color = 0x/.test(byName['ui_table.c']))
/* 每个图层在计划里的数组名 (g_uiFrame0_int / g_uiFrame0_ext ...) —— 断言里要按它核对 */
const keys = Object.fromEntries(collectLayerPlan(state.instances, state.assets, {}).items.map(it => [it.id, it.key]))

/* ---------------- 1b) LZSS 素材 (新格式) 导出链路 ---------------- */
{
  const old1 = { store: i1.store, ext: i1.ext }
  const old2 = { store: i2.store, ext: i2.ext }
  i1.store = 'lzss'; i1.ext = false
  i2.store = 'lzss'; i2.ext = false
  const lz = exportLayer({ lzssChunked: true, lzssChunkBytes: 2400 })
  const by = Object.fromEntries(lz.files.map(f => [f.name, f.text]))
  const k1 = lz.plan.items.find(x => x.id === i1.id).key
  const k2 = lz.plan.items.find(x => x.id === i2.id).key
  ok('LZSS 导出: 生成 6 个新格式文件',
    ['ui_assets_lzss.c', 'ui_assets_lzss.h', 'lzss_decode.c', 'lzss_decode.h',
     'ui_asset_draw.c', 'ui_asset_draw.h'].every(n => !!by[n]))
  ok('LZSS 导出: 原素材数组不再出现在 int/ext',
    !by['ui_assets_int.c'].includes(keys[i1.id]) && !by['ui_assets_ext.c'].includes(keys[i2.id]) &&
    !by['ui_assets_int.c'].includes(k1) && !by['ui_assets_ext.c'].includes(k2))
  ok('LZSS 导出: 帧表 .px = 0 + .asset/.assetChunks',
    by['ui_table.c'].includes('.px = 0,') && by['ui_table.c'].includes('UI_DrawFrame(0,') && by['ui_table.c'].includes(`UI_ASSET_${k1}`) &&
    by['ui_table.c'].includes(`UI_ASSET_${k1}_C`) && by['ui_table.c'].includes(`UI_ASSET_${k2}`))
  ok('LZSS 导出: 表项数/统计/RAM',
    lz.stat.lzss && lz.stat.lzss.blocks === 2 && lz.stat.lzss.rawBytes === 12 * 20 + 39 * 18 * 2 &&
    lz.stat.lzss.packedBytes > 0 && lz.stat.lzss.bufferSize === 39 * 18 * 2)
  ok('LZSS 导出: 渲染桥顶层 2 函数',
    by['ui_asset_draw.h'].includes('UI_DrawFrame(') && by['ui_asset_draw.h'].includes('UI_DrawFrameAt(') &&
    by['ui_asset_draw.c'].includes('UI_DrawFrameRefAt(const UI_FRAME_REF *f') &&
    by['ui_asset_draw.c'].includes('UI_DrawFrameAt(uint16_t id'))
  ok('LZSS 导出: 不再生成旧固定布局文件',
    !by['ui_assets_packed.c'] && !by['asset_blocks.h'] && !by['asset_lzss.c'])
  i1.store = old1.store; i1.ext = old1.ext
  i2.store = old2.store; i2.ext = old2.ext
}

/* 数字字库也走 LZSS: UI_FONT.glyph = 0 + assetBase/assetChunks, 字模不再有独立数组 */
{
  const old = { store: i4.store, ext: i4.ext }
  i4.store = 'lzss'; i4.ext = false
  const lz = exportLayer({ lzssChunked: true, lzssChunkBytes: 2400 })
  const by = Object.fromEntries(lz.files.map(f => [f.name, f.text]))
  ok('LZSS 字库: UI_FONT 写 glyph=0 + assetBase/assetChunks',
    by['ui_font.c'].includes('.glyph = 0') &&
    by['ui_font.c'].includes('.assetBase = UI_ASSET_g_uiFontNum8x11Glyph') &&
    by['ui_font.c'].includes('.assetChunks = UI_ASSET_g_uiFontNum8x11Glyph_C'))
  ok('LZSS 字库: 不再导出独立字模数组/声明',
    !by['ui_assets_int.c'].includes('g_uiFontNum8x11Glyph[') &&
    !by['ui_table.h'].includes('extern const uint8_t g_uiFontNum8x11Glyph[]'))
  ok('LZSS 字库: 字形进了统一表 (组数 +1, 块数增加)',
    lz.stat.lzss && lz.stat.lzss.groups >= 1 && lz.stat.lzss.blocks >= 10 &&
    lz.stat.lzss.detail.some(g => g.key === 'g_uiFontNum8x11Glyph' && g.frames > 0))
  i4.store = old.store; i4.ext = old.ext
}

/* 54×80 字模 (系统字/自定义字库): 在字库层拆左右条, 不靠帧表 x 偏移 */
{
  const big = addGrayAsset('DSEG54', new Uint8Array(108 * 80).fill(0x80), 108, 80,
    { charset: 'custom', custom: '01', glyphW: 54, glyphH: 80, frames: 2 })
  const bi = addInstance(big.id, 40, 40, { fmt: 'GRAY' })
  bi.w = 54; bi.h = 80
  bi.bind = { type: 'num', name: 'g_uiBig', dec: 0, cells: 1, align: 1, demo: 8 }
  bi.store = 'lzss'; bi.ext = false
  const lz = exportLayer({ lzssChunked: false, lzssChunkBytes: 2400 })
  const by = Object.fromEntries(lz.files.map(f => [f.name, f.text]))
  ok('54×80 字模: UI_FONT 写 parts=2 / partW=27',
    /\.parts = 2/.test(by['ui_font.c']) && /\.partW = 27/.test(by['ui_font.c']))
  ok('54×80 字模: 左右条各成一组 (GlyphP0/P1), 不撑大帧表',
    /\.parts = 2/.test(by['ui_font.c']) &&
    lz.stat.lzss.detail.some(g => g.key.endsWith('GlyphP0')) &&
    lz.stat.lzss.detail.some(g => g.key.endsWith('GlyphP1')) &&
    !/uint16_t x, y;/.test(by['ui_assets_lzss.h']))
  ok('54×80 字模: 解码缓冲 = 2160 B (不是 4320), 即使帧分片关掉',
    lz.stat.lzss.bufferSize === 54 * 40 * 1 || lz.stat.lzss.bufferSize === 2160,
    String(lz.stat.lzss.bufferSize))
  state.instances = state.instances.filter(i => i.id !== bi.id)
  state.assets = state.assets.filter(a => a.id !== big.id)
}

/* 系统字逐字微调: 数字/ASCII 字模 + 固定文本都走 cfg.glyphDx */
{
  const base = { family: 'MiSans', size: 20, weight: 400, bold: false, spacing: 0,
                 offsetY: 0, lineGap: 0, rampSigma: 0, evenSpacing: true }
  const f0 = store.numFontForSys({ ...base })
  const f1 = store.numFontForSys({ ...base, glyphDx: { '0': 1 } })
  ok('系统字微调: 数字字模的应用 glyphDx (字节变化, 格子不缩)',
    !!f0 && !!f1 && f1.w >= f0.w && f0.bytes.some((v, i) => v !== f1.bytes[i]))
  const a0 = store.asciiFontForSys({ ...base })
  const a1 = store.asciiFontForSys({ ...base, glyphDx: { A: 1 } })
  ok('系统字微调: ASCII 字模的应用 glyphDx',
    !!a0 && !!a1 && a1.w >= a0.w && a0.bytes.some((v, i) => v !== a1.bytes[i]))
  const c0 = store.renderSysFontCanvas({ ...base, text: '23' })
  const c1 = store.renderSysFontCanvas({ ...base, text: '23', glyphDx: { '2': 1 } })
  ok('系统字微调: 固定文本也会按逐字偏移加宽画布',
    !!c0 && !!c1 && c1.width >= c0.width)
}

/* ---------------- 1) 跨文件符号一致性: 表引用的名字必须真的被定义 ---------------- */
{
  /* 「仅尺寸」的层 .px = 0 (不映射任何数组) → 不参与"必须有定义"的检查 */
  const refs = [...byName['ui_table.c'].matchAll(/\.px = (\w+),/g)].map(m => m[1]).filter(n => n !== '0')
  const defs = (byName['ui_assets_int.c'] + byName['ui_assets_ext.c'])
  const missing = refs.filter(n => !new RegExp(`^const uint(?:8|16)_t ${n}\\[`, 'm').test(defs))
  ok('帧表 .px 引用的每个数组都在素材文件里有定义 (名字一致)',
    refs.length >= 2 && missing.length === 0, missing.length ? '缺: ' + missing.join(',') : refs.join(','))
  const fonts = [...byName['ui_table.c'].matchAll(/\.font = &(\w+)/g)].map(m => m[1])
  const fmissing = fonts.filter(n => !new RegExp(`^const UI_FONT ${n} =`, 'm').test(byName['ui_font.c'] || ''))
  ok('区域表 .font 引用的字库都在 ui_font.c 里有定义',
    fonts.length >= 1 && fmissing.length === 0, fmissing.length ? '缺: ' + fmissing.join(',') : fonts.join(','))
  ok('素材数组名不带 gImage_ 前缀 (与帧表同源, 以前这里对不上 → 链接报 undefined)',
    !/gImage_\w+\[\d+\]/.test(byName['ui_assets_int.c'] + byName['ui_assets_ext.c']))
  ok('灰度素材 = 1B/px, 彩图素材 = 2B/px (与 UI_FRAME_REF.fmt 对应; 外部=uint16 + UI_EXT_RO 最终形态)',
    new RegExp(`const uint8_t ${keys[i1.id]}\\[${12 * 20}\\]`).test(byName['ui_assets_int.c']) &&
    new RegExp(`const uint16_t ${keys[i2.id]}\\[${39 * 18}\\] UI_EXT_RO`).test(byName['ui_assets_ext.c']) &&
    !byName['ui_assets_ext.c'].includes('ER_EXTUI'),
    (byName['ui_assets_int.c'].match(/const uint\d+_t \w+\[\d+\]/g) || []).join(' ') + ' | ' +
    (byName['ui_assets_ext.c'].match(/const uint\d+_t \w+\[\d+\]/g) || []).join(' '))
  {
    const defs = {}
    for (const m of (byName['ui_assets_int.c'] + byName['ui_assets_ext.c']).matchAll(/^const uint(8|16)_t (\w+)\[(\d+)\]/gm))
      defs[m[2]] = m[1] === '8' ? +m[3] : +m[3] * 2      /* uint16 最终形态: 元素数×2 = 字节数 */
    const bad = []
    const frames = [...byName['ui_table.c'].matchAll(/const UI_FRAME_REF (\w+) = \{\s*\.px = (\w+), \.x = -?\d+, \.y = -?\d+, \.w = (\d+), \.h = (\d+),\s*\.lineH = \d+, \.fmt = (UI_FMT_\w+), \.mirror = \d+,\s*\.index = \d+\s*\};/g)]
    for (const [, fn, px, w, h, fmt] of frames) {
      if (px === '0') continue            /* 「仅尺寸」: .px = 0, 这一层没有数组可对账 */
      const bpp = fmt === 'UI_FMT_RGB565' ? 2 : 1
      const need = +w * +h * bpp
      if (defs[px] !== need) bad.push(`${fn}: ${px}[${defs[px]}] ≠ ${w}×${h}×${bpp}B = ${need}`)
    }
    ok('每帧的数组长度 = w×h×字节数 (行步长一致; 系统字曾经在这里错位 → 字形向右倾斜)',
       frames.length >= 4 && bad.length === 0, bad.join(' | ') || `${frames.length} 帧全部对齐`)
  }
  {
    const bad = []
    for (const inst of state.instances) {
      if (inst.kind === 'ring' || inst.bind) continue          /* 圆环/数字层不导出像素 */
      const pr = store.instanceProc(inst)
      if (!pr || !pr.values) continue
      if (pr.w !== Math.round(inst.w) || pr.h !== Math.round(inst.h))
        bad.push(`${inst.name || inst.id}: proc ${pr.w}×${pr.h} vs 图层 ${Math.round(inst.w)}×${Math.round(inst.h)}`)
    }
    ok('每个静态层的 proc 尺寸 = 图层尺寸 (系统字/文字层都算) —— 帧表与素材数组同源',
       bad.length === 0, bad.join(' | ') || '全部一致')
  }
  /* 多页图层: 素材只出一份; 0 页与 2 页的 Enter 画的是**同一个帧符号** (与帧下标无关, 免得
   * 以后加图层就要改断言) */
  const frameOf = (lbl) => {
    const i = byName['ui_task.c'].indexOf('void LCD_' + lbl + '_Enter(void)')
    if (i < 0) return null
    const seg = byName['ui_task.c'].slice(i, byName['ui_task.c'].indexOf('\n}', i))
    const m = seg.match(/UI_DrawFrame\((?:&(g_uiFrame\d+)|(\d+))/)
    return m ? (m[1] || ('g_uiFrame' + m[2])) : null
  }
  ok('多页图层 (pages:[0,2]): 素材/帧只一份, 两个页面的 Enter 都画它',
     (byName['ui_assets_int.c'].match(new RegExp(`const uint8_t ${keys[i1.id]}\\[`, 'g')) || []).length === 1 &&
     frameOf('Page0') != null && frameOf('Page0') === frameOf('Page2'))
  ok('ui_font.c 里的字库与文字函数都在 (数字层要字库, 文字层要取图函数)',
    /^const UI_FONT \w+ =/m.test(byName['ui_font.c'] || '') && /void \w+\(uint8_t x, uint8_t y, uint8_t id/.test(byName['ui_font.c'] || ''))
}

/* ---------------- 1z) 系统字「ASCII 字库」: 整份 0x20~0x7E 字模 + 打字符串函数 ---------------- */
{
  const font = byName['ui_font.c'] || ''
  const hdr = byName['ui_table.h'] || ''
  /* 字模表是像素数据 → 在素材文件里 (ui_font.c 只剩函数); 这一层没勾外部 → int 文件 */
  const dataAll = (byName['ui_assets_int.c'] || '') + (byName['ui_assets_ext.c'] || '')
  const m = dataAll.match(/const uint8_t asc_1Pic\[(\d+)\]\[(\d+)\]/)
  const iA = state.instances.find(i => i.id === 'inst_ascii1')
  const t = store.asciiTableFor(iA)
  ok('ASCII 字库: 字模表是整份 0x20~0x7E 的 95 行 (字符序 = 码序)',
    !!m && +m[1] === 95 && !!t && t.first === 32 && t.count === 95 && t.rows.length === 95,
    m ? `${m[0]}` : '没找到 asc_1Pic')
  ok('ASCII 字库: 每个字模字节数 = 字宽×字高 (行步长一致)',
    !!m && !!t && +m[2] === t.w * t.h && t.bytes === 95 * t.w * t.h,
    m && t ? `${m[2]} vs ${t.w}×${t.h}` : '')
  /* ！格子高度必须由**字迹**定 (asc+desc), 不是字号: 桩里的 measureText 给 ascent = 0.75×size、
   *   没有 descent → 格子 = ceil(0.75×20) = 15, 而老代码是"画布 = size = 20" (字底被切)。
   *   真字体 (MiSans asc 0.842em + desc 0.255em) 在 20px 下就是 22 行。 */
  ok('ASCII 字库: 格子高度按字迹算 (桩: 0.75×20=15 行), 不再等于字号 20 (字底不再被切)',
    !!t && t.h === 15 && !!m && +m[2] === t.w * 15, t ? `h=${t.h}` : '')
  ok('ASCII 字库: 出 <名字>Str() 打字符串 (逐字 drawGrayImage, 步进 = 字宽+字距)',
    /void asc_1Str\(uint8_t x, uint8_t y, const char \*str, uint16_t color\)/.test(font) &&
    /asc_1Pic\[c - 32u\]/.test(font) && /x \+= \d+\)/.test(font))
  ok('ASCII 字库: 空格跳过 (全 0 字模会把底色刷成黑, 必须 continue 不画)',
    /c == ' '\) continue;/.test(font) && /c < 32u \|\| c > 126u/.test(font))
  ok('ASCII 字库: 按 id 取图那个函数也在, 且注释写明 id = 字符码 - 32',
    /void asc_1\(uint8_t x, uint8_t y, uint8_t id, uint16_t color, uint16_t bg\)/.test(font) &&
    /id = 字符码 - 32/.test(font))
  ok('ASCII 字库: ui_table.h 声明两个函数 (别的 .c 独立编译也看得见)',
    hdr.includes('void asc_1(uint8_t x, uint8_t y, uint8_t id, uint16_t color, uint16_t bg);') &&
    hdr.includes('void asc_1Str(uint8_t x, uint8_t y, const char *str, uint16_t color);'))
  ok('ASCII 字库层显示的示例文本仍作为静态帧导出 (帧表不悬空)',
    [...byName['ui_table.c'].matchAll(/\.px = (\w+),/g)].map(x => x[1]).includes(keys['inst_ascii1']))
}

/* ---------------- 1a) 页面 = 序号 (调用顺序) + 圆环按页启停 ---------------- */
{
  ok('页 = 0,1,2 序号: 圆环在第 2 页 → LCD_Page2_Enter 启圆环 / Exit 停圆环',
    /void LCD_Page2_Enter\(void\)[\s\S]*Ring_SetBg\(UI_PAGE_BG\)[\s\S]*Ring_Start\(RING_GEAR_DEF, RING_DIR_DEF\)/.test(byName['ui_task.c']) &&
    /void LCD_Page2_Exit\(void\)\s*\{\s*Ring_Stop\(\);/.test(byName['ui_task.c']) &&
    byName['ui_task.c'].includes('#include "bsp_ring.h"'))
  ok('页数 (LCD_PAGE_N) = >=0 的正常页数 = 3, 空页也有 Enter/Exit',
    /#define LCD_PAGE_N\s+3/.test(byName['ui_task.h']) &&
    /void LCD_Page1_Enter\(void\)/.test(byName['ui_task.c']))
  ok('切页 API: LCD_UI_Setup(不进页) + LCD_UI_Goto(int8_t, 出旧页 → 清屏钩子 → 进新页) + Page/NextPage',
    byName['ui_task.h'].includes('void LCD_UI_Setup(void);') &&
    byName['ui_task.h'].includes('void LCD_UI_Goto(int8_t page);') &&
    byName['ui_task.h'].includes('int8_t LCD_UI_Page(void);') &&
    byName['ui_task.h'].includes('int8_t LCD_UI_NextPage(int8_t cur);') &&
    !byName['ui_task.h'].includes('LCD_UI_Init') &&
    /void LCD_UI_Goto\(int8_t page\)[\s\S]*UI_PAGE_CLEAR\(\);/.test(byName['ui_task.c']) &&
    /#ifndef UI_PAGE_CLEAR[\s\S]*LCD_Fill\(0, 0, 240, 240, UI_PAGE_BG\)[\s\S]*#endif/.test(byName['ui_task.c']))
  ok('ring_config.h 带上这一页的启动档位/方向 (RING_GEAR_DEF / RING_DIR_DEF)',
    /#define RING_GEAR_DEF\s+2\b/.test(byName['ring_config.h'] || '') && /#define RING_DIR_DEF\s+1\b/.test(byName['ring_config.h'] || ''))
  /* 只看 #define 行: 文件头的注释里会提到"预览动画字段没导出"这件事本身 */
  const ringDefs = (byName['ring_config.h'] || '').split('\n').filter(l => /^\s*#\s*define\b/.test(l)).join('\n')
  ok('RING_GLINT_DEF 包在 #ifndef 里 (主机自检 -D 覆盖它, 编译期总开关两种模式各编一遍)',
    /#ifndef RING_GLINT_DEF\s*\n#define RING_GLINT_DEF/.test(byName['ring_config.h'] || ''))
  ok('ring_config.h 带上白斑开关 (RING_GLINT_DEF=1), 且不含任何预览动画宏',
    /#define RING_GLINT_DEF\s+1\b/.test(ringDefs) &&
    !/autoGlint|autoArc|glintArcPx|syncMcU/.test(ringDefs))
  ok('圆环不进帧表 (它是引擎, 不是素材)',
    !/g_uiFrame\d = \{[\s\S]*ring/.test(byName['ui_table.c']) && !/extern const uint8_t \[\];/.test(byName['ui_table.h']))
}

/* ---------------- 1b) 多行文本只是网页侧的便利: 输出里没有"多行/菜单"语义 ---------------- */
{
  /* 像「文本框」那样打包出来的多帧素材 (竖排切格 + 每帧内容框) */
  const cellW = 20, cellH = 8, n = 3
  const strip = new Uint8Array(cellW * cellH * n).fill(0x33)
  const boxes = [0, 1, 2].map(k => ({ x: 2, y: k * cellH + 1, w: 10, h: 6 }))
  const fr = addGrayAsset('多行', strip, cellW, cellH * n,
    { charset: 'frames', dir: 'row', glyphW: cellW, glyphH: cellH, frames: n, boxes })
  IMG_DIMS.set(fr.src, [cellW, cellH * n])
  const inst = addInstance(fr.id, 30, 30, { fmt: 'GRAY' })
  state.instances = [inst]
  const o = exportLayer()
  const bn = Object.fromEntries(o.files.map(f => [f.name, f.text]))
  const key = collectLayerPlan(state.instances, state.assets, {}).items[0].key
  ok('多帧素材的图层: 导出的是那一帧自己的一张图 (内容框大小 10×6)',
    new RegExp(`const uint8_t ${key}\\[${10 * 6}\\]`).test(bn['ui_assets_int.c']), key)
  ok('输出里没有"多行素材/菜单"语义: lineH = 0 (不会让固件按行切/高亮行)',
    /\.lineH = 0,/.test(bn['ui_table.c']) && !/\.lineColor = 0x/.test(bn['ui_table.c']) &&
    !/\.hiLine = [0-9]/.test(bn['ui_table.c']))
  ok('多行文本框的打包素材仍然可用 (素材库侧便利), 但导出只认放上屏幕的那一张',
    /const uint8_t /.test(bn['ui_assets_int.c']) && o.stat.layers === 1)
}

/* ---------------- 2) 真编译: 每个 .c 单独编, 再链接固件 app_ui.c 跑 ---------------- */
const FW = process.env.FW_DIR || ''
if (!fs.existsSync(path.join(FW, 'code/spi/app_ui.c'))) {
  console.log(`SKIP  真编译 (找不到固件 ${FW}, 可用 FW_DIR=... 指定)`)
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uikeil-'))
  const w = (n, s) => fs.writeFileSync(path.join(tmp, n), s)
  for (const f of out.files) w(f.name, f.text)
  /* 用户会在 ui_user.h 里补的东西: 变量声明 (自动清单) 已经在了, 这里补个真实定义在 main.c */
  w('multi_timer.h', `#ifndef MT_H\n#define MT_H\n#include <stdint.h>\nstruct Timer { void (*timeout_cb)(void*); void *arg; uint32_t repeat; uint8_t run; };\nvoid timer_init(struct Timer*, void (*)(void*), uint32_t, uint32_t, uint8_t);\nint timer_start(struct Timer*);\nint timer_stop(struct Timer*);\nvoid timer_ticks(void);\nvoid timer_loop(void);\n#endif\n`)
  w('multi_timer.c', `#include "multi_timer.h"
#define N 8
static struct Timer *reg[N]; static int nreg;
void timer_init(struct Timer*t, void(*cb)(void*), uint32_t d, uint32_t r, uint8_t f){(void)d;(void)f;t->timeout_cb=cb;t->repeat=r;t->run=0;}
int timer_start(struct Timer*t){int i;for(i=0;i<nreg;i++)if(reg[i]==t)return 0;if(nreg<N)reg[nreg++]=t;t->run=1;return 0;}
int timer_stop(struct Timer*t){t->run=0;return 0;}
void timer_ticks(void){}
void timer_loop(void){}
int uiTest_count(void){return nreg;}
uint32_t uiTest_period(int i){return i<nreg?reg[i]->repeat:0;}
int uiTest_run(int i){return i<nreg?reg[i]->run:0;}
int uiTest_fire(int i){if(i>=nreg)return -1;if(reg[i]->timeout_cb)reg[i]->timeout_cb(reg[i]->arg);return 0;}
`)
  w('app_lcd.h', '#ifndef S1\n#define S1\n#include <stdint.h>\nvoid LCD_drawChar(uint8_t,uint8_t,char,uint8_t,uint16_t);\nvoid LCD_drawString(uint8_t,uint8_t,void*,uint8_t,uint16_t);\n#endif\n')
  w('ring_config.h', '#ifndef RC_STUB\n#define RC_STUB\n#define RING_GEAR_DEF 2\n#define RING_DIR_DEF  1\n#endif\n')
  w('bsp_ring.h', '#ifndef BR_STUB\n#define BR_STUB\n#include <stdint.h>\n#include "ring_config.h"\nvoid Ring_Start(uint8_t gear, int8_t dir);\nvoid Ring_Stop(void);\nvoid Ring_SetBg(uint16_t c);\nvoid Ring_ScreenInvalidate(void);\nvoid Ring_SetDir(int8_t d);\nvoid Ring_SetProgress(uint8_t v, uint8_t s);\n#endif\n')
  w('bsp_gc9a01.h', '#ifndef S2\n#define S2\n#include <stdint.h>\nuint8_t LCD_Fill(uint8_t,uint8_t,uint8_t,uint8_t,uint16_t);\nuint8_t LCD_drawImage(uint8_t,uint8_t,uint8_t,uint8_t,const uint8_t*,uint16_t);\nuint8_t LCD_drawGrayImage(uint8_t,uint8_t,uint8_t,uint8_t,const uint8_t*,uint16_t,uint8_t);\n#endif\n')
  fs.copyFileSync(path.join(FW, 'code/spi/app_ui.c'), path.join(tmp, 'app_ui.c'))
  fs.copyFileSync(path.join(FW, 'code/spi/app_ui.h'), path.join(tmp, 'app_ui.h'))
  w('main.c', `#include <stdio.h>
#include "ui_task.h"
#include "ui_table.h"
int32_t g_uiSpeedX10 = 125;                 /* 用户工程里定义的数字来源 */
int n_gray=0,n_img=0,n_fill=0;
/* 圆环引擎桩: 记录启停, 用来验证"进哪一页启圆环/出哪一页停圆环" */
int ring_start=0, ring_stop=0, ring_bg=-1, ring_gear=-1, ring_dir=0;
void Ring_Start(uint8_t g,int8_t d){ring_start++;ring_gear=g;ring_dir=d;}
void Ring_Stop(void){ring_stop++;}
void Ring_SetBg(uint16_t c){ring_bg=c;}
int ring_inval=0; void Ring_ScreenInvalidate(void){ring_inval++;}
void Ring_SetDir(int8_t d){(void)d;}
void Ring_SetProgress(uint8_t v,uint8_t s){(void)v;(void)s;}
uint8_t LCD_Fill(uint8_t a,uint8_t b,uint8_t c,uint8_t d,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)e;n_fill++;return 0;}
uint8_t LCD_drawImage(uint8_t a,uint8_t b,uint8_t c,uint8_t d,const uint8_t*p,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)p;(void)e;n_img++;return 0;}
uint8_t LCD_drawGrayImage(uint8_t a,uint8_t b,uint8_t c,uint8_t d,const uint8_t*g,uint16_t e,uint8_t m){(void)a;(void)b;(void)c;(void)d;(void)g;(void)e;(void)m;n_gray++;return 0;}
void LCD_drawChar(uint8_t a,uint8_t b,char c,uint8_t d,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)e;}
void LCD_drawString(uint8_t a,uint8_t b,void*c,uint8_t d,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)e;}
int uiTest_count(void); uint32_t uiTest_period(int); int uiTest_run(int); int uiTest_fire(int);
int main(void){
  int g0, g1, f1, f2;
  LCD_UI_Setup();                            /* 设表 + UI_Init: 不进任何页 */
  LCD_UI_Goto(0);                            /* 进第 0 页: 画静态 + 数字, 起周期定时器 */
  g0 = n_gray;
  uiTest_fire(0);
  g1 = n_gray;
  f1 = n_fill;
  g_uiSpeedX10 = 999;                        /* 值变了 → 下一次 tick 应该重画 */
  uiTest_fire(0);
  f2 = n_fill;
  printf("%d %d %d %d %d\\n", uiTest_count(), (int)uiTest_period(0), g0, g1 - g0, f2 - f1);
  /* 切页: 0 → 2 (圆环页) → 0, 圆环应该启一次停一次; 切页要清屏 */
  int f3 = n_fill;
  LCD_UI_Goto(2);
  printf("goto2 %d %d %d %d %d\\n", (int)LCD_UI_Page(), ring_start, ring_stop, ring_bg, n_fill - f3);
  LCD_UI_Goto(0);
  printf("goto0 %d %d %d\\n", (int)LCD_UI_Page(), ring_start, ring_stop);
  LCD_UI_Goto(0);                                 /* 同一页再调: 应该什么都不做 */
  printf("same %d %d\\n", ring_start, ring_stop);
  /* -1 = 空白页: 出页 + 清屏 + 停刷新 (周期定时器要停) */
  int f4 = n_fill;
  LCD_UI_Goto(-1);
  printf("blank %d %d %d\\n", (int)LCD_UI_Page(), uiTest_run(0), n_fill - f4);
  /* 按键切页: 只在 >=0 的正常页里循环 (0→1, 2→0, 空白/特殊页→0) */
  printf("next %d %d %d\\n", (int)LCD_UI_NextPage(0), (int)LCD_UI_NextPage(2), (int)LCD_UI_NextPage(-1));
  /* ASCII 字库: 真的打一串 —— 3 个字符里空格必须**跳过**(不画), 所以只出 2 次灰度绘制 */
  n_gray = 0;
  asc_1Str(0, 0, "A B", 0xFFFF);
  printf("ascii %d\\n", n_gray);
  return 0;
}
`)
  const compile = (src, tag) => {
    try {
      execFileSync('gcc', ['-std=gnu99', '-O1', '-Wall', '-I', tmp, '-c', path.join(tmp, src), '-o', path.join(tmp, tag + '.o')], { stdio: 'pipe' })
      return null
    } catch (e) { return String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 3).join(' | ') }
  }
  const objs = []
  let err = null
  const list = [['ui_assets_int.c', 'ai'], ['ui_assets_ext.c', 'ae']]
  if (byName['ui_font.c']) list.push(['ui_font.c', 'ft'])
  if (byName['ring_scan.c']) list.push(['ring_scan.c', 'rs'])   // 扫描表也必须能单独编译
  list.push(['ui_table.c', 'tb'], ['ui_task.c', 'tk'], ['app_ui.c', 'ui'], ['multi_timer.c', 'mt'], ['main.c', 'mn'])
  for (const [src, tag] of list) {
    const e = compile(src, tag)
    if (e && !err) err = `${src}: ${e}`
    else if (!e) objs.push(path.join(tmp, tag + '.o'))
  }
  ok('一键导出的每个 .c 单独编译 (Keil 多文件工程那种) 全部通过 + 没有 undefined 符号', !err, err || `${objs.length} 个目标文件`)
  let out2 = ''
  if (!err) {
    try {
      execFileSync('gcc', [...objs, '-o', path.join(tmp, 'g')], { stdio: 'pipe' })
      out2 = execFileSync(path.join(tmp, 'g'), { encoding: 'utf8' }).trim()
    } catch (e) { err = String(e.stderr || e.message).split('\n').slice(0, 4).join(' | ') }
  }
  ok('链接 + 运行 (真的调 LCD_UI_Setup/LCD_UI_Goto / 周期回调)', !err && out2.split(/\n/)[0].split(/\s+/)[0] === '1', err || out2.replace(/\n/g, ' | '))
  if (!err) {
    const lines = out2.split('\n')
    const g2 = (lines[1] || '').split(/\s+/)
    const g0 = (lines[2] || '').split(/\s+/)
    const same = (lines[3] || '').split(/\s+/)
    const blank = (lines[4] || '').split(/\s+/)
    const next = (lines[5] || '').split(/\s+/)
    ok('切页到圆环页 (2): 启圆环一次 + 底色对齐 + 清一次屏',
      g2[0] === 'goto2' && g2[1] === '2' && g2[2] === '1' && g2[3] === '0' && g2[4] === '0' && Number(g2[5]) >= 1,
      lines.slice(1, 4).join(' / '))
    ok('切回 0 页: 停圆环一次 (当前页回到 0)',
      g0[0] === 'goto0' && g0[1] === '0' && g0[2] === '1' && g0[3] === '1')
    ok('已经在目标页时 LCD_UI_Goto 什么都不做 (不会重复启停)',
      same[0] === 'same' && same[1] === '1' && same[2] === '1')
    ok('Goto(-1): 变空白页 + 停掉周期刷新 + 清一次屏 (关机不再有刷新)',
      blank[0] === 'blank' && blank[1] === '-1' && blank[2] === '0' && Number(blank[3]) >= 1,
      lines[4] || '')
    ok('按键切页 LCD_UI_NextPage: 只在 >=0 里循环 (0→1, 2→0, 负数→0)',
      next[0] === 'next' && next[1] === '1' && next[2] === '0' && next[3] === '0',
      lines[5] || '')
    const asc = (lines[6] || '').split(/\s+/)
    ok('ASCII 字库 Str() 真跑通: "A B" 出 2 次灰度绘制 (空格跳过, 不刷黑)',
      asc[0] === 'ascii' && asc[1] === '2', lines[6] || '')
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

/* ---------------- 2b) 直链 /lcd/<档名> 的解析 ---------------- */
{
  const f = store.archiveNameFromUrl
  ok('直链解析: /lcd/<档名> (带不带 .json 都行; 中文; 其它路径不算档名)',
    f('/lcd/lcd-2026-09-11') === 'lcd-2026-09-11' &&
    f('/lcd/lcd-2026-09-11.json') === 'lcd-2026-09-11' &&
    f('/lcd/lcd-2026-09-11/') === 'lcd-2026-09-11' &&
    f('/lcd/%E6%B5%8B%E9%80%9F') === '测速' &&
    f('/lcd/') === '' && f('/lcd/index.html') === '' && f('/') === '' && f('/lcd/a/b') === '' && f('') === '')
}

/* ---------------- 3) 工程 JSON 往返: 页面设置 (周期 / 定时跳转) 不能丢 ---------------- */
{
  const snap = { a: state.assets, i: state.instances, p: state.pages, ap: state.activePresetId }
  state.pages = { 0: { period: 200, jumpMs: 800, jumpTo: 1 }, '-3': { period: 500 } }
  const json = store.exportProject()
  state.pages = {}
  store.importProject(json)
  ok('工程 JSON 往返: 页面设置 (周期 / 定时跳转) 一起存档、读回',
     state.pages?.[0]?.jumpMs === 800 && state.pages?.[0]?.jumpTo === 1 && state.pages?.['-3']?.period === 500)
  state.assets = snap.a; state.instances = snap.i; state.pages = snap.p; state.activePresetId = snap.ap
}

console.log(fails ? `\n有失败: ${fails} 项` : '\n全部通过')
process.exit(fails ? 1 : 0)
