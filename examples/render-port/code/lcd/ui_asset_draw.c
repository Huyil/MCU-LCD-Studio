/* 由 MCU-LCD-Editer 导出: LZSS 素材渲染桥 (新格式) —— 请勿手改。
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
 * 默认走 bsp_gc9a01.h 的 LCD_drawGrayImage / LCD_drawImage / LCD_Fill。
 * RAM: g_uiAssetBuf[UI_ASSET_BUF_SIZE] = 2304 B (4 字节对齐)。
 */
#include <stdint.h>
#include "ui_asset_draw.h"   /* 先 include: app_ui.h 里的 UI_FMT_* 先定义, 避免重复 */
#include "ui_assets_lzss.h"
#include "lzss_decode.h"
#include "ui_user.h"

/* g_uiFrames[] 在 ui_table.c 定义; 这里只做 id → 帧表条目 */
#define UI_FRAME_N 4
#if UI_FRAME_N > 0
extern const UI_FRAME_REF *const g_uiFrames[UI_FRAME_N];
#endif

#ifndef UI_ASSET_LCD_HEADER
#define UI_ASSET_LCD_HEADER "bsp_gc9a01.h"
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
