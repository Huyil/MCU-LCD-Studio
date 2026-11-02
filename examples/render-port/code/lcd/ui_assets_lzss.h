/* 由 MCU-LCD-Editer 导出: 通用 LZSS 素材表 (新格式) —— 请勿手改。
 *
 * 一个 UI_Asset = 一个可独立解压的"片":
 *   · 不分片时 1 帧 = 1 片 (y = 0, h = 整帧高);
 *   · 分片时按行切, y = 片在整帧里的 y 偏移, h = 片高。
 * rawlen 不占表项: rawlen = w * h * (fmt == UI_FMT_GRAY8 ? 1 : 2)。
 * 组宏: UI_ASSET_<key> = 首片 ID, _N = 帧/字形数, _C = 每帧/每字形片数。
 *
 * 固件契约 (示例 重写时按这个改):
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

#define UI_ASSET_COUNT    36
#define UI_ASSET_BUF_SIZE 2304
#define UI_ASSET_CHUNKED  0

extern const UI_Asset g_uiAssets[UI_ASSET_COUNT];
extern const uint8_t  g_uiAssetBlob[];

/* 内部渲染接口 (ui_asset_draw.c 实现): 字库/取图表用; 业务代码用 ui_asset_draw.h 的 2 个 */
void UI_DrawAsset(uint16_t first, uint8_t chunks,
                  uint16_t x, uint16_t y, uint16_t color, uint16_t bg, uint8_t mirror);
uint8_t *UI_AssetBuffer(void);

#define UI_ASSET_g_uiFrame2             0   /* battery: 14 帧 × 1 片 */
#define UI_ASSET_g_uiFrame2_N          14   /* 帧/字形数 */
#define UI_ASSET_g_uiFrame2_C           1   /* 每帧/每字形的片数 */
#define UI_ASSET_g_uiFrame3            14   /* frames_1021: 2 帧 × 1 片 */
#define UI_ASSET_g_uiFrame3_N           2   /* 帧/字形数 */
#define UI_ASSET_g_uiFrame3_C           1   /* 每帧/每字形的片数 */
#define UI_ASSET_g_uiFont_g_uiField0GlyphP0    16   /* g_uiFont_g_uiField0 字库 P1/2: 10 帧 × 1 片 */
#define UI_ASSET_g_uiFont_g_uiField0GlyphP0_N    10   /* 帧/字形数 */
#define UI_ASSET_g_uiFont_g_uiField0GlyphP0_C     1   /* 每帧/每字形的片数 */
#define UI_ASSET_g_uiFont_g_uiField0GlyphP1    26   /* g_uiFont_g_uiField0 字库 P2/2: 10 帧 × 1 片 */
#define UI_ASSET_g_uiFont_g_uiField0GlyphP1_N    10   /* 帧/字形数 */
#define UI_ASSET_g_uiFont_g_uiField0GlyphP1_C     1   /* 每帧/每字形的片数 */

#endif /* UI_ASSETS_LZSS_H */
