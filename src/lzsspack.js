/*
 * lzsspack.js —— 通用 LZSS 素材打包器 (Web 侧)
 *
 * 输入是"逻辑组" (一个图层 / 一份字库 / 一张取图表):
 *   { key, label, w, h, fmt, images: [Uint8Array] }
 *     key    = C 标识符前缀 (g_uiFrame0 / g_uiFont_g_uiField0Glyph / xxxPic)
 *     images = 每帧的**原始字节** (GRAY8 1B/px; RGB565 小端 2B/px)
 *
 * 输出:
 *   · 一张统一的 UI_Asset 表 + 一个 g_uiAssetBlob;
 *   · 每组生成 UI_ASSET_<key> (首片 ID) / _N (帧数) / _C (每帧片数);
 *   · 可选分片 (chunkBytes): 按行切, 每片 ≤ chunkBytes (行宽超过粒度时退化为 1 行/片);
 *   · 解码器 lzss_decode.c/.h 与渲染桥 ui_asset_draw.c/.h。
 *
 * 通用格式: 不认识具体项目/分辨率, 没有 54×80/14 帧/2400 B 之类的硬编码;
 * 所有尺寸/帧数/格式都来自输入, 分片只影响 RAM 与压缩率。
 */
import { lzssCompress, hashBytes } from './lzss.js'

export const FMT_RGB565 = 0
export const FMT_GRAY8 = 1
export const UI_ASSET_NONE = 0xFFFF

export const fmtBpp = (fmt) => (fmt === FMT_GRAY8 ? 1 : 2)
export const fmtName = (fmt) => (fmt === FMT_GRAY8 ? 'GRAY8' : 'RGB565')

/** C 标识符: 非字母数字下划线 → '_'; 首字符是数字时补 '_'。 */
export function cIdent(s) {
  let t = String(s ?? '').replace(/[^\w]/g, '_')
  if (!t) t = '_'
  if (/^\d/.test(t)) t = '_' + t
  return t
}

const hx2 = (v) => '0x' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0')

/**
 * 只做"规划": 分配每组的首片 ID / 每帧片数 / 最大片字节数 (RAM 缓冲)。
 * 不压缩 —— 表格/字库代码需要先拿到 ID, 压缩再单独做。
 */
export function planLzss(groups, opt = {}) {
  const chunkBytes = Math.max(0, Math.round(+opt.chunkBytes || 0))
  const out = []
  const seen = new Set()
  let totalChunks = 0
  let bufferSize = 0
  let warnings = []

  for (const g of groups || []) {
    if (!g || !g.images?.length) continue
    const key = cIdent(g.key)
    if (seen.has(key)) throw new Error(`LZSS 组 key 重复: ${key}`)
    seen.add(key)
    const w = Math.max(1, Math.round(+g.w || 1))
    const h = Math.max(1, Math.round(+g.h || 1))
    const fmt = g.fmt === FMT_GRAY8 ? FMT_GRAY8 : FMT_RGB565
    const bpp = fmtBpp(fmt)
    const rowBytes = w * bpp
    const images = (g.images || []).map(im => (im instanceof Uint8Array ? im : Uint8Array.from(im || [])))
    for (const im of images) {
      if (!im || im.length !== w * h * bpp) {
        throw new Error(`LZSS 组 ${key} 的帧大小不符: 期望 ${w * h * bpp} B, 实际 ${im?.length ?? 0} B`)
      }
    }
    /* 帧分片只按行切 (为 RAM); 字模的左右条在"字库渲染"层拆 (见 store 的 font split),
     * 不把 x 偏移塞进通用帧表。 */
    let rowsPer = h, chunks = 1, maxChunkRaw = rowBytes * h
    if (chunkBytes > 0) {
      rowsPer = Math.max(1, Math.min(h, Math.floor(chunkBytes / rowBytes)))
      if (rowBytes > chunkBytes) {
        warnings.push(`${key}: 单行 ${rowBytes} B 已超过分片粒度 ${chunkBytes} B, 只能 1 行/片 (缓冲 ${rowBytes} B)`)
      }
      chunks = Math.ceil(h / rowsPer)
      maxChunkRaw = rowBytes * Math.min(rowsPer, h)
    }
    if (chunks > 255) throw new Error(`LZSS 组 ${key} 的每帧片数 ${chunks} 超过 uint8_t 上限; 请增大分片粒度`)
    if (maxChunkRaw > 0xFFFF) {
      throw new Error(`LZSS 组 ${key} 的单片 ${maxChunkRaw} B 超过 uint16 解码上限; 请启用更小的分片`)
    }
    const base = totalChunks
    totalChunks += chunks * images.length
    if (totalChunks > 0xFFFE) throw new Error(`LZSS 片数 ${totalChunks} 超过 uint16 表上限`)
    bufferSize = Math.max(bufferSize, maxChunkRaw)
    out.push({ ...g, key, w, h, fmt, bpp, rowBytes, rowsPer, chunks, base,
               images, frames: images.length, maxChunkRaw })
  }

  if (bufferSize > 0xFFFF) throw new Error(`LZSS 解码缓冲 ${bufferSize} B 超过 uint16 上限`)
  return {
    groups: out,
    totalChunks,
    bufferSize,
    chunked: chunkBytes > 0 && out.some(g => g.chunks > 1),
    chunkBytes,
    warnings,
  }
}

/** 字模按列切 (GRAY8): 取 img(w×h) 的 [x0, x0+cw) 列。 */
function fontCols(img, w, h, x0, cw) {
  const out = new Uint8Array(cw * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < cw; x++) out[y * cw + x] = img[y * w + x0 + x]
  }
  return out
}

/**
 * 字模专用拆分 (左右条): 每个字形按列拆成 parts 个窄图, 每片 ≤ chunkBytes。
 * 这是"字库渲染/打包"层的行为, 不污染通用帧表 (UI_Asset 不需要 x 偏移)。
 * 返回 { parts, partW, width, height, count, groups:[{ part, width, images }] }。
 * 54×80 / 2400 B → parts=2, partW=27, 两片各 2160 B (旧固件左右条口径)。
 */
export function splitFontParts(set, chunkBytes = 2400) {
  const w = Math.max(1, Math.round(+set?.w || 1))
  const h = Math.max(1, Math.round(+set?.h || 1))
  const count = Math.max(0, Math.round(+set?.count || 0))
  const bytes = set?.bytes
  if (!bytes || bytes.length !== w * h * count) {
    throw new Error(`字模数据长度不符: 期望 ${w * h * count}, 实际 ${bytes?.length ?? 0}`)
  }
  const limit = Math.min(2400, Math.max(128, Math.round(+chunkBytes || 2400)))
  const maxPartW = Math.max(1, Math.floor(limit / h))
  const parts = Math.max(1, Math.ceil(w / maxPartW))
  const partW = Math.ceil(w / parts)
  if (parts > 255) throw new Error(`字模拆分片数 ${parts} 超过 uint8_t 上限`)
  if (partW > 255) throw new Error(`字模每片宽 ${partW} 超过 uint8_t 上限`)
  const groups = []
  for (let p = 0; p < parts; p++) {
    const x0 = p * partW
    const pw = Math.min(partW, w - x0)
    const images = []
    for (let gi = 0; gi < count; gi++) {
      const g = bytes.slice(gi * w * h, (gi + 1) * w * h)
      images.push(fontCols(g, w, h, x0, pw))
    }
    groups.push({ part: p, width: pw, images })
  }
  return { parts, partW, width: w, height: h, count, groups }
}

/**
 * 压缩并生成表/blob。同一份像素 (同 w/h/fmt/y + 同内容) 只存一份,
 * 表项仍然逐片保留 (ID 必须连续), 但 off/clen 指向同一段流。
 */
export function encodeLzss(plan) {
  const entries = []
  const blobs = []
  const dedupe = new Map()
  let blobLen = 0
  let rawTotal = 0

  for (const g of plan.groups) {
    let gRaw = 0, gPacked = 0
    for (let fi = 0; fi < g.frames; fi++) {
      const img = g.images[fi]
      rawTotal += img.length
      gRaw += img.length
      for (let ci = 0; ci < g.chunks; ci++) {
        const y = ci * g.rowsPer
        const rows = Math.min(g.rowsPer, g.h - y)
        const raw = img.subarray(y * g.rowBytes, (y + rows) * g.rowBytes)
        const hkey = `${g.fmt}:${g.w}:${rows}:${y}:${raw.length}:${hashBytes(raw)}`
        let off, clen
        const hit = dedupe.get(hkey)
        if (hit) {
          off = hit.off; clen = hit.clen
        } else {
          const packed = lzssCompress(raw)
          if (packed.length > 0xFFFF) {
            throw new Error(`LZSS 组 ${g.key} 的压缩片 ${packed.length} B 超过表项 uint16 上限; 请启用更小的分片`)
          }
          off = blobLen; clen = packed.length
          blobs.push(packed)
          blobLen += packed.length
          if (blobLen > 0xFFFF) throw new Error(`LZSS 压缩流总长 ${blobLen} B 超过表项 uint16 偏移上限`)
          dedupe.set(hkey, { off, clen })
        }
        gPacked += clen
        entries.push({
          off, clen, w: g.w, h: rows, y, fmt: g.fmt, flags: 0,
          key: g.key, frame: fi, chunk: ci,
          label: `${g.label || g.key}${g.frames > 1 ? ` 帧 ${fi + 1}/${g.frames}` : ''}${g.chunks > 1 ? ` 片 ${ci + 1}/${g.chunks}` : ''}`,
        })
        if (entries.length > 0xFFFF) throw new Error('LZSS 片数超过 uint16 上限')
      }
    }
    g.rawBytes = gRaw
    g.packedBytes = gPacked
    g.ratio = gRaw ? gPacked / gRaw : 1
  }

  const blob = new Uint8Array(blobLen)
  let off = 0
  for (const b of blobs) { blob.set(b, off); off += b.length }

  const rawBytes = plan.groups.reduce((s, g) => s + g.rawBytes, 0)
  const packedBytes = blobLen
  const tableBytes = entries.length * 12
  return {
    entries, blob,
    stats: {
      groups: plan.groups.length,
      blocks: entries.length,
      rawBytes,
      packedBytes,
      tableBytes,
      bufferSize: plan.bufferSize,
      totalBytes: packedBytes + tableBytes,
      ratio: rawBytes ? packedBytes / rawBytes : 1,
      savedBytes: rawBytes - packedBytes,
      dedupeSaved: plan.groups.reduce((s, g) => s + g.packedBytes, 0) - packedBytes,
      chunked: plan.chunked,
      chunkBytes: plan.chunkBytes,
      detail: plan.groups.map(g => ({
        key: g.key, label: g.label || g.key, frames: g.frames, chunks: g.chunks,
        rawBytes: g.rawBytes, packedBytes: g.packedBytes,
        ratio: g.rawBytes ? g.packedBytes / g.rawBytes : 1,
      })),
    },
  }
}

/* ------------------------------------------------------------------ C 文本 */

function groupMacros(plan) {
  const L = []
  for (const g of plan.groups) {
    const k = `UI_ASSET_${g.key}`
    L.push(`#define ${k}${' '.repeat(Math.max(1, 28 - k.length))}${String(g.base).padStart(5)}   /* ${g.label || g.key}: ${g.frames} 帧 × ${g.chunks} 片 */`)
    L.push(`#define ${k}_N${' '.repeat(Math.max(1, 26 - k.length))}${String(g.frames).padStart(5)}   /* 帧/字形数 */`)
    L.push(`#define ${k}_C${' '.repeat(Math.max(1, 26 - k.length))}${String(g.chunks).padStart(5)}   /* 每帧/每字形的片数 */`)
  }
  return L.join('\n')
}

export function genAssetsH(plan) {
  return `/* 由 MCU-LCD-Editer 导出: 通用 LZSS 素材表 (新格式) —— 请勿手改。
 *
 * 一个 UI_Asset = 一个可独立解压的"片":
 *   · 不分片时 1 帧 = 1 片 (y = 0, h = 整帧高);
 *   · 分片时按行切, y = 片在整帧里的 y 偏移, h = 片高。
 * rawlen 不占表项: rawlen = w * h * (fmt == UI_FMT_GRAY8 ? 1 : 2)。
 * 组宏: UI_ASSET_<key> = 首片 ID, _N = 帧/字形数, _C = 每帧/每字形片数。
 *
 * 固件契约:
 *   顶层绘制用 UI_DrawFrame(id, color) / UI_DrawFrameAt(id, x, y, color) (id = g_uiFrames 下标);
 *   动态区域的指针版是内部接口 UI_DrawFrameRef/RefAt;
 *   内部按下面两条分派 (UI_DrawAsset 由 ui_asset_draw.c 提供):
 *   UI_FRAME_REF 增: uint16_t asset; uint8_t assetChunks;
 *     .px == 0 && .asset != UI_ASSET_NONE → UI_DrawAsset(.asset + .index * .assetChunks, .assetChunks, ..., .mirror)
 *   UI_FONT 增: uint16_t assetBase; uint8_t assetChunks, parts, partW;
 *     .glyph == 0 → UI_DrawGlyph(ft, ch, x, y, color, bg, mirror)  (内部逐片)
 *       或 assetBase + (part * count + (ch-first)) * assetChunks, 画到 x + part*partW
 */
#ifndef UI_ASSETS_LZSS_H
#define UI_ASSETS_LZSS_H

#include <stdint.h>

#ifndef UI_FMT_RGB565
#define UI_FMT_RGB565 0
#endif
#ifndef UI_FMT_GRAY8
#define UI_FMT_GRAY8  1
#endif

#define UI_ASSET_NONE     0xFFFFu

typedef struct {
    uint16_t off;      /* g_uiAssetBlob 偏移 */
    uint16_t clen;     /* 压缩流长度 */
    uint16_t w, h;     /* 片宽/片高 (像素) */
    uint16_t y;        /* 片在整帧里的 y 偏移 (帧分片按行) */
    uint8_t  fmt;      /* UI_FMT_RGB565 / UI_FMT_GRAY8 */
    uint8_t  flags;    /* 预留 (0) */
} UI_Asset;

#define UI_ASSET_COUNT    ${plan.totalChunks}
#define UI_ASSET_BUF_SIZE ${plan.bufferSize}
#define UI_ASSET_CHUNKED  ${plan.chunked ? 1 : 0}

extern const UI_Asset g_uiAssets[UI_ASSET_COUNT];
extern const uint8_t  g_uiAssetBlob[];

/* 内部渲染接口 (ui_asset_draw.c 实现): 字库/取图表用; 业务代码用 ui_asset_draw.h 的 2 个 */
void UI_DrawAsset(uint16_t first, uint8_t chunks,
                  uint16_t x, uint16_t y, uint16_t color, uint16_t bg, uint8_t mirror);
uint8_t *UI_AssetBuffer(void);

${groupMacros(plan)}

#endif /* UI_ASSETS_LZSS_H */
`
}

export function genAssetsC(plan, enc) {
  const L = ['/* 由 MCU-LCD-Editer 导出: 通用 LZSS 素材表 + 压缩流 (新格式) —— 请勿手改。',
             ' * 表项顺序 = ID 顺序; 压缩流 g_uiAssetBlob 首尾相接。',
             ' * 依赖: ui_assets_lzss.h (仅 <stdint.h>)。 */',
             '#include <stdint.h>',
             '#include "ui_assets_lzss.h"',
             '',
             `const uint8_t g_uiAssetBlob[${enc.blob.length}] = {`]
  const blob = enc.blob
  for (let i = 0; i < blob.length; i += 16) {
    L.push('    ' + Array.from(blob.subarray(i, i + 16), hx2).join(', ') + ',')
  }
  L.push('};', '')
  L.push(`const UI_Asset g_uiAssets[UI_ASSET_COUNT] = {`)
  enc.entries.forEach((e, i) => {
    const note = `${String(i).padStart(3)}: ${e.label}`
    L.push(`    { ${String(e.off).padStart(5)}, ${String(e.clen).padStart(5)}, ${String(e.w).padStart(3)}, ${String(e.h).padStart(3)}, ${String(e.y).padStart(3)}, ${e.fmt === FMT_GRAY8 ? 'UI_FMT_GRAY8 ' : 'UI_FMT_RGB565'}, 0 }, /* ${note.replace(/\*\//g, '* /')} */`)
  })
  L.push('};', '')
  return L.join('\n')
}

export const LZSS_DECODE_H = `/*
 * lzss_decode.h —— 通用 LZSS 解码器 (无工程常量, 无 malloc/stdio)
 *
 * 格式: control byte 管最多 8 个 token, MSB 先行;
 *   bit=0 -> literal (1 B); bit=1 -> match (2 B 小端):
 *   offset = tok >> 4 (1..4095), len = (tok & 15) + 3 (3..18)。
 * 历史就在 dst 里, 不需要额外窗口 RAM。
 */
#ifndef LZSS_DECODE_H
#define LZSS_DECODE_H

#include <stdint.h>

/* 成功返回 rawlen; 流损坏/越界/容量不足返回 0。 */
uint16_t LZSS_Decode(const uint8_t *src, uint16_t clen,
                     uint8_t *dst, uint16_t rawlen, uint16_t cap);

#endif /* LZSS_DECODE_H */
`

export const LZSS_DECODE_C = `/*
 * lzss_decode.c —— 通用 LZSS 解码器 (与 Web 的 src/lzss.js 同一格式)
 *
 * 约束: 只用 <stdint.h>; 无 malloc/stdio; 所有多字节都按字节取
 *       (M0+ 上非对齐 16 位读会 HardFault)。
 */
#include "lzss_decode.h"

uint16_t LZSS_Decode(const uint8_t *src, uint16_t clen,
                     uint8_t *dst, uint16_t rawlen, uint16_t cap)
{
    uint16_t ip = 0u;
    uint16_t op = 0u;
    uint8_t ctrl = 0u;
    uint8_t bits = 0u;

    if ((src == 0) || (dst == 0) || (rawlen == 0u) || (rawlen > cap)) {
        return 0u;
    }

    while (op < rawlen) {
        uint8_t bit;

        if (bits == 0u) {
            if (ip >= clen) {
                return 0u;
            }
            ctrl = src[ip];
            ip++;
            bits = 8u;
        }
        bit = (uint8_t)((ctrl >> 7) & 0x01u);
        ctrl = (uint8_t)(ctrl << 1);
        bits--;

        if (bit == 0u) {
            if (ip >= clen) {
                return 0u;
            }
            dst[op] = src[ip];
            ip++;
            op++;
        } else {
            uint16_t tok;
            uint16_t off;
            uint16_t len;
            uint16_t from;
            uint16_t i;

            if ((uint16_t)(clen - ip) < 2u) {
                return 0u;
            }
            tok = (uint16_t)((uint16_t)src[ip] | ((uint16_t)src[ip + 1u] << 8));
            ip = (uint16_t)(ip + 2u);
            off = (uint16_t)(tok >> 4);
            len = (uint16_t)((tok & 0x0Fu) + 3u);

            if ((off == 0u) || (off > op)) {
                return 0u;
            }
            if (((uint32_t)op + (uint32_t)len) > (uint32_t)rawlen) {
                return 0u;
            }

            from = (uint16_t)(op - off);
            for (i = 0u; i < len; i++) {
                dst[op + i] = dst[from + i];
            }
            op = (uint16_t)(op + len);
        }
    }

    return rawlen;
}
`

export const UI_ASSET_DRAW_H = `/*
 * ui_asset_draw.h —— LZSS 素材渲染桥 (新格式)
 *
 * 顶层只用 2 个函数 (id = g_uiFrames 下标, 即 g_uiFrameN 的 N):
 *   UI_DrawFrame(id, color)             固定坐标: 用帧表里的 x / y
 *   UI_DrawFrameAt(id, x, y, color)     备用: 指定坐标
 * 内部自动处理 raw / LZSS / index=255 / mirror。
 *
 * 内部接口:
 *   UI_DrawFrameRef(f, color) / UI_DrawFrameRefAt(f, x, y, color)
 *     —— UI_FIELD.frames 是"帧指针数组", 动态区域内部用这两个;
 *   UI_DrawAsset(...) / UI_AssetBuffer() 声明在 ui_assets_lzss.h (字库/取图表用)。
 * 业务代码不用直接调内部接口。
 */
#ifndef UI_ASSET_DRAW_H
#define UI_ASSET_DRAW_H

#include <stdint.h>
#include "app_ui.h"

/* 顶层 2 个: id 越界直接忽略 */
void UI_DrawFrame(uint16_t id, uint16_t color);
void UI_DrawFrameAt(uint16_t id, uint16_t x, uint16_t y, uint16_t color);

/* 内部: UI_FIELD.frames (const UI_FRAME_REF *const *) 用 */
void UI_DrawFrameRef(const UI_FRAME_REF *f, uint16_t color);
void UI_DrawFrameRefAt(const UI_FRAME_REF *f, uint16_t x, uint16_t y, uint16_t color);

/* 内部: 字库绘制 (raw / LZSS 左右条都走这里; 业务代码用 UI_DrawField) */
void UI_DrawGlyph(const UI_FONT *ft, uint8_t ch, uint16_t x, uint16_t y,
                  uint16_t color, uint16_t bg, uint8_t mirror);

#endif /* UI_ASSET_DRAW_H */
`

export function genDrawC(plan, opt = {}) {
  const lcdHeader = String(opt.lcdHeader || 'bsp_gc9a01.h').replace(/[^\w./-]/g, '') || 'bsp_gc9a01.h'
  const frameCount = Math.max(0, Math.min(65535, Math.round(+opt.frameCount || 0)))
  return `/* 由 MCU-LCD-Editer 导出: LZSS 素材渲染桥 (新格式) —— 请勿手改。
 *
 * 顶层 API (业务代码只用这两个, id = g_uiFrames 下标 / g_uiFrameN 的 N):
 *   UI_DrawFrame(2, color);                 // 固定坐标 (帧表 g_uiFrame2 的 x/y)
 *   UI_DrawFrameAt(2, x, y, color);         // 备用: 指定坐标
 * 内部自动处理: raw 数组 / LZSS 表 / index=255 (仅网页渲染 → 清底色) / mirror。
 *
 * 动态区域内部 (UI_FIELD.frames 指针) 用 UI_DrawFrameRef / UI_DrawFrameRefAt。
 *
 * 本文件同时提供 UI_DrawFrame 的实现。如果工程 app_ui.c 里已有同名函数,
 * 用本文件替换它 (或删掉旧定义), 否则会重复定义。
 *
 * 换屏只改下面 3 个 static 函数 (ui_blit_gray / ui_blit_rgb / ui_fill):
 * 默认走 ${lcdHeader} 的 LCD_drawGrayImage / LCD_drawImage / LCD_Fill。
 * RAM: g_uiAssetBuf[UI_ASSET_BUF_SIZE] = ${plan.bufferSize} B (4 字节对齐)。
 */
#include <stdint.h>
#include "ui_asset_draw.h"   /* 先 include: app_ui.h 里的 UI_FMT_* 先定义, 避免重复 */
#include "ui_assets_lzss.h"
#include "lzss_decode.h"
#include "ui_user.h"

/* g_uiFrames[] 在 ui_table.c 定义; 这里只做 id → 帧表条目 */
#define UI_FRAME_N ${frameCount}
#if UI_FRAME_N > 0
extern const UI_FRAME_REF *const g_uiFrames[UI_FRAME_N];
#endif

#ifndef UI_ASSET_LCD_HEADER
#define UI_ASSET_LCD_HEADER "${lcdHeader}"
#endif
#include UI_ASSET_LCD_HEADER

#ifndef UI_BG_COLOR
#define UI_BG_COLOR 0x0000u
#endif

/* ---- 换屏改这 3 个 ---------------------------------------------------------- */
static void ui_blit_gray(uint16_t x, uint16_t y, uint16_t w, uint16_t h,
                         const uint8_t *buf, uint16_t color, uint8_t mirror)
{
    LCD_drawGrayImage((uint8_t)x, (uint8_t)y, (uint8_t)w, (uint8_t)h, buf, color, mirror);
}

static void ui_blit_rgb(uint16_t x, uint16_t y, uint16_t w, uint16_t h,
                        const uint8_t *buf, uint16_t color)
{
    LCD_drawImage((uint8_t)x, (uint8_t)y, (uint8_t)w, (uint8_t)h, buf, color);
}

static void ui_fill(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint16_t color)
{
    LCD_Fill((uint8_t)x, (uint8_t)y, (uint8_t)(x + w), (uint8_t)(y + h), color);
}
/* --------------------------------------------------------------------------- */

/* 4 字节对齐: RGB565 片会被 LCD_drawImage 的 RAM 直传通路按 uint16 读 */
static uint8_t g_uiAssetBuf[UI_ASSET_BUF_SIZE] __attribute__((aligned(4)));

uint8_t *UI_AssetBuffer(void)
{
    return g_uiAssetBuf;
}

void UI_DrawAsset(uint16_t first, uint8_t chunks,
                  uint16_t x, uint16_t y, uint16_t color, uint16_t bg, uint8_t mirror)
{
    uint16_t i;

    if (chunks == 0u) {
        return;
    }
    for (i = 0u; i < (uint16_t)chunks; i++) {
        const UI_Asset *a;
        uint16_t bpp;
        uint32_t rawlen32;
        uint16_t rawlen;

        if ((uint16_t)(first + i) >= UI_ASSET_COUNT) {
            return;
        }
        a = &g_uiAssets[(uint16_t)(first + i)];
        bpp = (a->fmt == UI_FMT_GRAY8) ? 1u : 2u;
        rawlen32 = (uint32_t)a->w * (uint32_t)a->h * (uint32_t)bpp;
        if ((rawlen32 == 0u) || (rawlen32 > 0xFFFFu)) {
            return;
        }
        rawlen = (uint16_t)rawlen32;
        if ((rawlen > UI_ASSET_BUF_SIZE) ||
            (LZSS_Decode(&g_uiAssetBlob[a->off], a->clen, g_uiAssetBuf, rawlen, UI_ASSET_BUF_SIZE) == 0u)) {
            if (bg != 0xFFFFu) {
                ui_fill(x, (uint16_t)(y + a->y), a->w, a->h, bg);
            }
            return;
        }
        if (a->fmt == UI_FMT_GRAY8) {
            ui_blit_gray(x, (uint16_t)(y + a->y), a->w, a->h, g_uiAssetBuf, color, mirror);
        } else {
            ui_blit_rgb(x, (uint16_t)(y + a->y), a->w, a->h, g_uiAssetBuf, color);
        }
    }
}

/* 字库绘制: raw 连续数组 / LZSS 左右条都走这里, 调用方不需要知道字形拆了几片。
 *  LZSS 布局: assetBase 起, part-major (part0 的全部字形, 然后 part1...),
 *  第 glyph 个字形的第 p 片 = assetBase + (p * count + glyph) * assetChunks。 */
void UI_DrawGlyph(const UI_FONT *ft, uint8_t ch, uint16_t x, uint16_t y,
                  uint16_t color, uint16_t bg, uint8_t mirror)
{
    uint8_t idx, parts, p;

    if ((ft == 0) || (ch < ft->first)) {
        return;
    }
    idx = (uint8_t)(ch - ft->first);
    if (idx >= ft->count) {
        if (bg != 0xFFFFu) {
            ui_fill(x, y, ft->w, ft->h, bg);
        }
        return;
    }
    /* 原始字库: glyph 指向 count 个连续 w*h 字节 (内部 uint8 / 外部 uint16 打包都能按字节读) */
    if (ft->glyph != 0) {
        const uint8_t *px = (const uint8_t *)ft->glyph + (uint32_t)idx * ft->w * ft->h;
        ui_blit_gray(x, y, ft->w, ft->h, px, color, mirror);
        return;
    }
    /* LZSS 字库: 每字形 parts 片; 每片的宽度在表项里 (最后一片可能更窄) */
    parts = (ft->parts != 0u) ? ft->parts : 1u;
    for (p = 0u; p < parts; p++) {
        UI_DrawAsset((uint16_t)(ft->assetBase + ((uint16_t)p * ft->count + idx) * ft->assetChunks),
                     ft->assetChunks, (uint16_t)(x + (uint16_t)p * ft->partW), y,
                     color, bg, mirror);
    }
}

/* raw 数组: .index 选第几帧 (帧与帧在数组里连续), 偏移按字节算 */
static void ui_blit_raw(const UI_FRAME_REF *f, uint16_t x, uint16_t y, uint16_t color)
{
    const uint8_t *px = (const uint8_t *)f->px;
    uint32_t stride;

    if (px == 0) {
        return;
    }
    if (f->fmt == UI_FMT_GRAY8) {
        stride = (uint32_t)f->w * (uint32_t)f->h;
        ui_blit_gray(x, y, f->w, f->h, px + (uint32_t)f->index * stride, color, f->mirror);
    } else {
        stride = (uint32_t)f->w * (uint32_t)f->h * 2u;
        ui_blit_rgb(x, y, f->w, f->h, px + (uint32_t)f->index * stride, color);
    }
}

void UI_DrawFrameRefAt(const UI_FRAME_REF *f, uint16_t x, uint16_t y, uint16_t color)
{
    if (f == 0) {
        return;
    }
    /* 仅网页渲染: 只清这一块底色 (与老 UI_DrawFrame 同语义) */
    if (f->index == 255u) {
        ui_fill(x, y, f->w, f->h, UI_BG_COLOR);
        return;
    }
    /* 原始数组 (内部/外部 Flash) */
    if (f->px != 0) {
        ui_blit_raw(f, x, y, color);
        return;
    }
    /* LZSS: .asset 指向首片, .index 选第几帧, 步长 = .assetChunks 片 */
    if ((f->asset != UI_ASSET_NONE) && (f->assetChunks != 0u)) {
        UI_DrawAsset((uint16_t)(f->asset + (uint16_t)f->index * (uint16_t)f->assetChunks),
                     f->assetChunks, x, y, color, 0xFFFFu, f->mirror);
    }
    /* 其余 (.px == 0 且没有 asset) = 仅尺寸: 不画 */
}

void UI_DrawFrameRef(const UI_FRAME_REF *f, uint16_t color)
{
    if (f == 0) {
        return;
    }
    UI_DrawFrameRefAt(f, f->x, f->y, color);
}

/* ---- 顶层 2 个: id → g_uiFrames[id] ---- */
#if UI_FRAME_N > 0
void UI_DrawFrameAt(uint16_t id, uint16_t x, uint16_t y, uint16_t color)
{
    if (id < UI_FRAME_N) {
        UI_DrawFrameRefAt(g_uiFrames[id], x, y, color);
    }
}

void UI_DrawFrame(uint16_t id, uint16_t color)
{
    if (id < UI_FRAME_N) {
        const UI_FRAME_REF *f = g_uiFrames[id];
        if (f != 0) {
            UI_DrawFrameRefAt(f, f->x, f->y, color);
        }
    }
}
#else
/* 本工程没有静态帧 (只有字库): 顶层调用当作 no-op, 保证符号存在 */
void UI_DrawFrameAt(uint16_t id, uint16_t x, uint16_t y, uint16_t color)
{
    (void)id; (void)x; (void)y; (void)color;
}

void UI_DrawFrame(uint16_t id, uint16_t color)
{
    (void)id; (void)color;
}
#endif
`
}

/** 一次性返回全部新格式文件。 */
export function lzssFiles(plan, enc, opt = {}) {
  if (!plan || !plan.totalChunks) return []
  return [
    { name: 'ui_assets_lzss.h', text: genAssetsH(plan) },
    { name: 'ui_assets_lzss.c', text: genAssetsC(plan, enc) },
    { name: 'lzss_decode.h', text: LZSS_DECODE_H },
    { name: 'lzss_decode.c', text: LZSS_DECODE_C },
    { name: 'ui_asset_draw.h', text: UI_ASSET_DRAW_H },
    { name: 'ui_asset_draw.c', text: genDrawC(plan, opt) },
  ]
}
