/*
 * 通用 LZSS 素材自检 (零依赖: node scripts/check-lzsspack.mjs)
 *
 * 覆盖:
 *   1) codec: 任意字节 round-trip + 截断/越界负测试;
 *   2) 规划: 组 ID / 帧数 / 片数 / 缓冲大小 (分片与不分片);
 *   3) 压缩: 表项逐片解压 == 原始字节; 相同帧去重 (off 相同);
 *   4) 生成物: 头宏 / 表偏移 / 解码器 / 渲染桥; 不再出现 DR2159 固定布局;
 *   5) 导出对接: 图层 store=lzss → key 无 _ext/_int, 帧表 .asset,
 *      仅尺寸/原始帧在 LZSS 工程里写 UI_ASSET_NONE;
 *   6) 字库/取图表: UI_FONT.assetBase、UI_DrawAsset 调用。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { lzssCompress, lzssDecompress } from '../src/lzss.js'
import { planLzss, encodeLzss, lzssFiles, splitFontParts, FMT_GRAY8, FMT_RGB565 } from '../src/lzsspack.js'
import { collectLayerPlan, tableForPlan, tableHeaderFor, planHasLzss, frameFunctionBlocks } from '../src/layerexport.js'
import { exportFont, exportFontParts, fontGlyphSet, idDrawFunction, asciiStrFunction } from '../src/uiexport.js'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`)
  if (!cond) fails++
}

/* ---------------- 1) codec ---------------- */
{
  const cases = [
    new Uint8Array(0),
    Uint8Array.from([0]),
    Uint8Array.from({ length: 300 }, (_, i) => i & 0xFF),
    Uint8Array.from({ length: 5000 }, (_, i) => (i * 37 + (i >> 3)) & 0xFF),
    new Uint8Array(4096),                                   // 全 0: 长匹配
  ]
  for (const raw of cases) {
    const packed = lzssCompress(raw)
    const back = lzssDecompress(packed, raw.length)
    ok(`codec round-trip ${raw.length} B`, !!back && back.length === raw.length && back.every((v, i) => v === raw[i]))
  }
  const packed = lzssCompress(Uint8Array.from({ length: 100 }, (_, i) => i))
  ok('codec: 截断流返回 null', lzssDecompress(packed.subarray(0, packed.length - 1), 100) === null)
  ok('codec: rawlen+1 返回 null', lzssDecompress(packed, 101) === null)
}

/* ---------------- 2) 规划 + 3) 压缩 ---------------- */
const mk = (w, h, fmt, n = 1, seed = 1) => ({
  key: `g${w}x${h}_${fmt}`, label: `${w}x${h}`, w, h, fmt,
  images: Array.from({ length: n }, (_, fi) => {
    const len = w * h * (fmt === FMT_GRAY8 ? 1 : 2)
    const a = new Uint8Array(len)
    for (let i = 0; i < len; i++) a[i] = (i * 13 + fi * 7 + seed) & 0xFF
    return a
  }),
})
const groups = [
  mk(54, 80, FMT_GRAY8, 2, 3),
  mk(48, 24, FMT_RGB565, 3, 5),
  mk(1, 1, FMT_GRAY8, 1, 7),
  mk(200, 9, FMT_RGB565, 1, 11),
]

for (const chunkBytes of [0, 2400, 256]) {
  const plan = planLzss(groups, { chunkBytes })
  const enc = encodeLzss(plan)
  const tag = chunkBytes ? `分片 ${chunkBytes}` : '不分片'
  ok(`${tag}: 片数 = Σ帧×片`, plan.totalChunks === enc.entries.length)
  ok(`${tag}: 首片 ID 连续`, plan.groups.every((g, i) => i === 0 || g.base === plan.groups[i - 1].base + plan.groups[i - 1].chunks * plan.groups[i - 1].frames))
  ok(`${tag}: 缓冲 = 最大片`, plan.bufferSize === Math.max(...enc.entries.map(e => e.w * e.h * (e.fmt === FMT_GRAY8 ? 1 : 2))))
  let allOk = true
  for (const e of enc.entries) {
    const rawlen = e.w * e.h * (e.fmt === FMT_GRAY8 ? 1 : 2)
    const dec = lzssDecompress(enc.blob.subarray(e.off, e.off + e.clen), rawlen)
    if (!dec) { allOk = false; break }
    const g = plan.groups.find(x => x.key === e.key)
    const chunk = g.images[e.frame].subarray(e.y * g.rowBytes, (e.y + e.h) * g.rowBytes)
    if (dec.length !== chunk.length || !dec.every((v, i) => v === chunk[i])) { allOk = false; break }
  }
  ok(`${tag}: 每片解压 == 源切片`, allOk)
  ok(`${tag}: 表项偏移/长度非零`, enc.entries.every(e => e.clen > 0))
  ok(`${tag}: 压缩流不膨胀 (随机数据允许 ≤20% 开销)`, enc.stats.packedBytes <= enc.stats.rawBytes * 1.2, `${enc.stats.packedBytes}/${enc.stats.rawBytes}`)
}

/* 字模左右条: 54×80 → 27×80 + 27×80, 各 2160 B (旧固件口径; 不靠帧表 x 偏移) */
{
  const bytes = new Uint8Array(54 * 80 * 10)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17) & 255
  const sp = splitFontParts({ w: 54, h: 80, count: 10, bytes }, 2400)
  ok('字模左右条: 54×80 → parts=2 / partW=27', sp.parts === 2 && sp.partW === 27)
  ok('字模左右条: 两片各 10 个 27×80 图 (2160 B/图)',
     sp.groups.length === 2 && sp.groups.every(g => g.width === 27 && g.images.length === 10 && g.images[0].length === 27 * 80))
  ok('字模左右条: 左/右片内容 = 原字模对应列',
     sp.groups[0].images[0][0] === bytes[0] && sp.groups[1].images[0][0] === bytes[27])
  const one = splitFontParts({ w: 28, h: 40, count: 2, bytes: new Uint8Array(28 * 40 * 2) }, 2400)
  ok('小字模不拆: 28×40 → parts=1', one.parts === 1 && one.partW === 28 && one.groups.length === 1)
}

/* 去重: 同一帧重复两次 → 表项两份, off 相同, blob 只存一份 */
{
  const g = mk(20, 20, FMT_GRAY8, 2, 9)
  g.images[1] = g.images[0].slice()
  const plan = planLzss([g], { chunkBytes: 0 })
  const enc = encodeLzss(plan)
  ok('去重: 两份表项指向同一 off', enc.entries.length === 2 && enc.entries[0].off === enc.entries[1].off)
  ok('去重: 只存一份流', enc.blob.length === enc.entries[0].clen)
  ok('去重: dedupeSaved > 0', enc.stats.dedupeSaved > 0)
}

/* 单行超过分片粒度 → 1 行/片, 缓冲 = 行字节, 有告警 */
{
  const plan = planLzss([mk(200, 3, FMT_RGB565)], { chunkBytes: 128 })
  ok('分片粒度 < 行宽: 退化为 1 行/片', plan.groups[0].chunks === 3 && plan.bufferSize === 400)
  ok('分片粒度 < 行宽: 给出告警', plan.warnings.length === 1)
}

/* ---------------- 4) 生成物 ---------------- */
{
  const plan = planLzss(groups, { chunkBytes: 2400 })
  const enc = encodeLzss(plan)
  const files = lzssFiles(plan, enc, { lcdHeader: 'bsp_gc9a01.h' })
  const by = Object.fromEntries(files.map(f => [f.name, f.text]))
  for (const n of ['ui_assets_lzss.h', 'ui_assets_lzss.c', 'lzss_decode.h', 'lzss_decode.c', 'ui_asset_draw.h', 'ui_asset_draw.c']) {
    ok(`生成文件: ${n}`, !!by[n] && by[n].length > 100)
  }
  ok('头文件: UI_FMT 0/1', /#define UI_FMT_RGB565 0/.test(by['ui_assets_lzss.h']) && /#define UI_FMT_GRAY8\s+1/.test(by['ui_assets_lzss.h']))
  ok('头文件: 缓冲/片数宏', by['ui_assets_lzss.h'].includes(`#define UI_ASSET_BUF_SIZE ${plan.bufferSize}`) && by['ui_assets_lzss.h'].includes(`#define UI_ASSET_COUNT    ${plan.totalChunks}`))
  ok('头文件: 每组 _N/_C 宏', plan.groups.every(g => by['ui_assets_lzss.h'].includes(`#define UI_ASSET_${g.key}_N`) && by['ui_assets_lzss.h'].includes(`#define UI_ASSET_${g.key}_C`)))
  ok('数据文件: 表项数 = 片数', (by['ui_assets_lzss.c'].match(/^    \{\s*\d+,\s*\d+,/gm) || []).length === enc.entries.length)
  ok('数据文件: blob 长度声明', by['ui_assets_lzss.c'].includes(`const uint8_t g_uiAssetBlob[${enc.blob.length}]`))
  ok('解码器: 无工程常量', !/2400|54|80|14|DR2159/.test(by['lzss_decode.c'] + by['lzss_decode.h']))
  ok('渲染桥: 按 fmt 分派', by['ui_asset_draw.c'].includes('UI_FMT_GRAY8') && by['ui_asset_draw.c'].includes('ui_blit_rgb'))
  ok('渲染桥: 支持 mirror', by['ui_asset_draw.c'].includes('uint8_t mirror') && by['ui_assets_lzss.h'].includes('uint8_t mirror'))
  ok('渲染桥: 顶层 2 函数 (id 版)', by['ui_asset_draw.h'].includes('UI_DrawFrame(uint16_t id') && by['ui_asset_draw.h'].includes('UI_DrawFrameAt(uint16_t id') && by['ui_asset_draw.h'].includes('UI_DrawFrameRef(const UI_FRAME_REF *f'))
  ok('渲染桥: 4 字节对齐缓冲', by['ui_asset_draw.c'].includes('__attribute__((aligned(4)))'))
  ok('渲染桥: RAM = 表里的缓冲', by['ui_asset_draw.c'].includes(`g_uiAssetBuf[UI_ASSET_BUF_SIZE]`) && by['ui_assets_lzss.h'].includes(`#define UI_ASSET_BUF_SIZE ${plan.bufferSize}`))
}

/* ---------------- 5) 导出对接: 帧 ---------------- */
{
  const inst = { id: 'i1', assetId: 'a1', name: 'lz', x: 1, y: 2, w: 10, h: 11, fmt: 'GRAY', store: 'lzss', frame: 0, page: 0 }
  const plan = collectLayerPlan([inst], [{ id: 'a1', w: 10, h: 11 }])
  const it = plan.items[0]
  ok('图层 store=lzss: key 不带 _ext/_int', it.key === 'g_uiFrame0', it.key)
  ok('图层 store=lzss: ext=false, store=lzss', it.ext === false && it.store === 'lzss')
  it.lzss = { key: it.key, base: 0, chunks: 2, frames: 1 }
  const c = tableForPlan(plan)
  ok('帧表: .px = 0', /\.px = 0,/.test(c))
  ok('帧表: .asset = UI_ASSET_g_uiFrame0', c.includes('.asset = UI_ASSET_g_uiFrame0'))
  ok('帧表: .assetChunks = UI_ASSET_g_uiFrame0_C', c.includes('.assetChunks = UI_ASSET_g_uiFrame0_C'))
  ok('帧表: include 新格式头', c.includes('#include "ui_assets_lzss.h"'))
  ok('帧表: 不再 extern 该帧数组', !tableHeaderFor(plan).includes('extern const uint8_t g_uiFrame0[]'))
  ok('planHasLzss: 识别帧', planHasLzss(plan))

  /* 混合工程: 原始帧在 LZSS 工程里必须写 UI_ASSET_NONE, 否则 .px=0 会被当成解压 */
  const inst2 = { id: 'i2', assetId: 'a2', name: 'raw', x: 0, y: 0, w: 2, h: 2, fmt: 'GRAY', store: 'int', frame: 0, page: 0 }
  const plan2 = collectLayerPlan([inst, inst2], [{ id: 'a1', w: 10, h: 11 }, { id: 'a2', w: 2, h: 2 }])
  plan2.items[0].lzss = { key: plan2.items[0].key, base: 0, chunks: 1, frames: 1 }
  const c2 = tableForPlan(plan2)
  ok('混合工程: 原始帧 .asset = UI_ASSET_NONE', c2.includes('.asset = UI_ASSET_NONE'))
  ok('混合工程: 原始帧仍 .px = g_uiFrame1_int', c2.includes('.px = g_uiFrame1_int'))
}

/* ---------------- 6) 字库 / 取图表 ---------------- */
{
  const f = exportFont({ name: 'g_uiFontX', first: 48, last: 57 })
  const set = fontGlyphSet(f, { chars: '0123456789' })
  ok('字库集合: 10 字形 × 8×11', set.count === 10 && set.w === 8 && set.h === 11 && set.bytes.length === 880)
  const p = exportFontParts(f, { chars: '0123456789', lzss: { key: 'g_uiFontXGlyph' } })
  ok('字库 LZSS: glyph = 0', p.struct.includes('.glyph = 0'))
  ok('字库 LZSS: assetBase/assetChunks', p.struct.includes('.assetBase = UI_ASSET_g_uiFontXGlyph') && p.struct.includes('.assetChunks = UI_ASSET_g_uiFontXGlyph_C'))
  const p2 = exportFontParts(f, { chars: '0123456789', lzss: { key: 'g_uiFontXGlyphP0', parts: 2, partW: 27 } })
  ok('字库 LZSS: parts/partW (左右条)', p2.struct.includes('.parts = 2') && p2.struct.includes('.partW = 27'))
  ok('字库 LZSS: 不再输出字模数组', p.glyph === '' && p.lzss === true)

  const fn = idDrawFunction('foo', { count: 95, w: 8, h: 11, ascii: true, first: 32, lzss: { key: 'fooPic' } })
  ok('取图函数 LZSS: 调 UI_DrawAsset', fn.includes('UI_DrawAsset') && fn.includes('UI_ASSET_fooPic_C'))
  ok('取图函数 LZSS: 传 mirror=0', fn.includes('bg, 0)'))
  const str = asciiStrFunction('foo', { first: 32, count: 95, w: 8, h: 11, lzss: { key: 'fooPic' } })
  ok('ASCII Str LZSS: 逐字调 foo()', str.includes('foo(x, y, (uint8_t)(c - 32u), color, 0xFFFFu);'))
}

/* ---------------- 7) 生成物真编译 (主机 gcc) ---------------- */
{
  let gccOk = true
  try { execFileSync('gcc', ['--version'], { stdio: 'ignore' }) } catch { gccOk = false }
  if (!gccOk) {
    ok('生成 C 真编译 (SKIP: 没有 gcc)', true)
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lzssgen-'))
    const g = [
      { key: 'g_uiFrame0', label: 'gray', w: 54, h: 80, fmt: FMT_GRAY8,
        images: [Uint8Array.from({ length: 54 * 80 }, (_, i) => (i * 29 + 1) & 255)] },
      { key: 'g_uiFrame1', label: 'rgb', w: 48, h: 24, fmt: FMT_RGB565,
        images: [Uint8Array.from({ length: 48 * 24 * 2 }, (_, i) => (i * 31 + 2) & 255)] },
      { key: 'g_uiFont', label: 'font', w: 8, h: 11, fmt: FMT_GRAY8,
        images: Array.from({ length: 10 }, (_, k) => Uint8Array.from({ length: 8 * 11 }, (_, i) => (i * 7 + k * 3) & 255)) },
    ]
    const pl = planLzss(g, { chunkBytes: 2400 })
    const en = encodeLzss(pl)
    for (const f of lzssFiles(pl, en, { lcdHeader: 'bsp_gc9a01.h', frameCount: 3 })) fs.writeFileSync(path.join(tmp, f.name), f.text)
    fs.writeFileSync(path.join(tmp, 'app_ui.h'), `#ifndef APP_UI_H
#define APP_UI_H
#include <stdint.h>
#define UI_FMT_RGB565 0
#define UI_FMT_GRAY8 1
typedef struct { const void *px; uint16_t x,y,w,h; uint8_t lineH,fmt,mirror,index; uint16_t asset; uint8_t assetChunks; } UI_FRAME_REF;
typedef struct { const void *glyph; uint8_t w,h,gap,first,count; uint16_t assetBase; uint8_t assetChunks,parts,partW; } UI_FONT;
#endif
`)
    fs.writeFileSync(path.join(tmp, 'ui_user.h'), '#ifndef UI_USER_H\n#define UI_USER_H\n#endif\n')
    fs.writeFileSync(path.join(tmp, 'bsp_gc9a01.h'), `#ifndef BSP_H
#define BSP_H
#include <stdint.h>
int LCD_Fill(uint8_t,uint8_t,uint8_t,uint8_t,uint16_t);
int LCD_drawImage(uint8_t,uint8_t,uint8_t,uint8_t,const uint8_t*,uint16_t);
int LCD_drawGrayImage(uint8_t,uint8_t,uint8_t,uint8_t,const uint8_t*,uint16_t,uint8_t);
#endif
`)
    fs.writeFileSync(path.join(tmp, 'main.c'), `#include <stdio.h>
#include <stdint.h>
#include "ui_assets_lzss.h"
#include "ui_asset_draw.h"
int nfill,nimg,ngray;
int LCD_Fill(uint8_t a,uint8_t b,uint8_t c,uint8_t d,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)e;nfill++;return 0;}
int LCD_drawImage(uint8_t a,uint8_t b,uint8_t c,uint8_t d,const uint8_t*p,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)p;(void)e;nimg++;return 0;}
int LCD_drawGrayImage(uint8_t a,uint8_t b,uint8_t c,uint8_t d,const uint8_t*g,uint16_t e,uint8_t m){(void)a;(void)b;(void)c;(void)d;(void)g;(void)e;(void)m;ngray++;return 0;}
static const uint8_t rawpx[16] = {0};
static const UI_FRAME_REF frame0 = { rawpx, 7, 8, 2, 3, 0, UI_FMT_GRAY8, 0, 0, UI_ASSET_NONE, 0 };
static const UI_FRAME_REF frame1 = { 0, 1, 2, 48, 24, 0, UI_FMT_RGB565, 0, 0,
                                     UI_ASSET_g_uiFrame1, UI_ASSET_g_uiFrame1_C };
static const UI_FRAME_REF frame2 = { rawpx, 0, 0, 2, 3, 0, UI_FMT_GRAY8, 0, 255, UI_ASSET_NONE, 0 };
const UI_FRAME_REF *const g_uiFrames[3] = { &frame0, &frame1, &frame2 };
int main(void){
  UI_DrawAsset(UI_ASSET_g_uiFrame0, UI_ASSET_g_uiFrame0_C, 1, 2, 0xFFFF, 0, 0);
  UI_DrawAsset(UI_ASSET_g_uiFrame1, UI_ASSET_g_uiFrame1_C, 3, 4, 0xFFFF, 0, 0);
  UI_DrawAsset((uint16_t)(UI_ASSET_g_uiFont + 9*UI_ASSET_g_uiFont_C), UI_ASSET_g_uiFont_C, 5, 6, 0x1234, 0, 0);
  UI_DrawAsset(UI_ASSET_COUNT, 1, 0, 0, 0xFFFF, 0, 0);
  /* 字库绘制: parts=1 的路径 */
  {
    static const UI_FONT ft = { 0, 8, 11, 0, 48, 10,
                                UI_ASSET_g_uiFont, UI_ASSET_g_uiFont_C, 1, 8 };
    UI_DrawGlyph(&ft, '0', 5, 6, 0x1234, 0, 0);
  }

  /* 顶层 1: 固定坐标 id=0 (+ raw 数组路径) */
  UI_DrawFrame(0, 0xFFFF);
  /* 顶层 2: 指定坐标 id=1 (+ LZSS 帧路径) */
  UI_DrawFrameAt(1, 9, 10, 0xFFFF);
  /* index = 255: 只清底色 (id=2) */
  UI_DrawFrame(2, 0xFFFF);
  /* 越界 id: 直接忽略 */
  UI_DrawFrame(99, 0xFFFF);
  printf("fill=%d img=%d gray=%d buf=%u\\n", nfill, nimg, ngray, (unsigned)UI_ASSET_BUF_SIZE);
  return (nfill==1 && nimg==2 && ngray==5) ? 0 : 1;
}
`)
    let cc = '', run = '', out = ''
    try {
      execFileSync('gcc', ['-O2', '-Wall', '-Wextra', '-I', tmp,
        path.join(tmp, 'ui_assets_lzss.c'), path.join(tmp, 'lzss_decode.c'),
        path.join(tmp, 'ui_asset_draw.c'), path.join(tmp, 'main.c'), '-o', path.join(tmp, 't')],
        { stdio: 'pipe' })
      cc = 'ok'
      out = execFileSync(path.join(tmp, 't'), { encoding: 'utf8' }).trim()
      run = 'ok'
    } catch (e) {
      cc = (e.stdout || '') + (e.stderr || '') + (e.message || '')
    }
    ok('生成 C 真编译', cc === 'ok', String(cc).split('\n')[0])
    ok('生成 C 真运行 (顶层 2 函数 + 字库 + 清底 + 越界)', run === 'ok' && out === 'fill=1 img=2 gray=5 buf=' + pl.bufferSize, out)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/* 多帧取帧函数 LZSS: 逐帧 base + (id-1)*_C, 传 mirror=0 */
{
  const it = { key: 'g_uiFrame2', w: 48, h: 24, allFrames: { fn: 'battery', count: 14, gray: false, lzss: true },
               lzss: { key: 'g_uiFrame2', base: 0, chunks: 1, frames: 14 }, ext: false }
  const c = frameFunctionBlocks({ items: [it] }, false)
  ok('多帧函数 LZSS: 用 UI_ASSET + _C', c.includes('UI_ASSET_g_uiFrame2 + (uint16_t)(id - 1u) * UI_ASSET_g_uiFrame2_C') && c.includes('bg, 0)'))
}

console.log(fails ? `\n${fails} FAIL` : '\nALL PASS')
process.exit(fails ? 1 : 0)
