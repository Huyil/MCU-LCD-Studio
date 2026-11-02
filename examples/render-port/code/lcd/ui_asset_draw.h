/*
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
