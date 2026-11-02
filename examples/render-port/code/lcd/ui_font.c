/* 由 MCU-LCD-Editer 导出: 数字字库 (UI_FONT 结构体) + 文字层字模与取图函数
 * ！字模**数组**不在这里: 纯像素数据按图层的「外部」选择并进 ui_assets_int.c / ui_assets_ext.c
 *   (数据与代码分对象 —— 字模进外部 Flash 时才不会把函数/结构体一起拖过去)。
 * 与 code/spi/app_ui.h 的 UI_FONT 一一对应; 声明在 ui_table.h 里
 */
#include "app_ui.h"
#include "ui_table.h"
#include "ui_user.h"                 /* 你的变量声明/宏 (这个文件不会被导出覆盖) */
#include "ui_assets_lzss.h"   /* LZSS 字库/取图表 ID */
#include "ui_asset_draw.h"   /* UI_DrawFrame/At (顶层) */
#include "bsp_gc9a01.h"      /* 文字层函数用的 LCD_drawGrayImage / LCD_Fill */

const UI_FONT g_uiFont_g_uiField0 = { .glyph = 0, .w = 54, .h = 80, .gap = 0, .first = 48, .count = 10, .assetBase = UI_ASSET_g_uiFont_g_uiField0GlyphP0, .assetChunks = UI_ASSET_g_uiFont_g_uiField0GlyphP0_C, .parts = 2, .partW = 27 };

/* battery: 多帧图标 (导出所有 14 帧, LZSS 组 g_uiFrame2) —— MCU 按 id 调用:
 *   id = 0 关闭 (填底色 bg); id = 1..14 画第 id 帧; 其余值不动。 */
void battery(uint8_t x, uint8_t y, uint8_t id, uint16_t color, uint16_t bg)
{
    if (id == 0u) { LCD_Fill(x, y, (uint8_t)(x + 48), (uint8_t)(y + 24), bg); return; }
    if (id > 14u) return;                          /* 超范围: 保持原画面不动 */
    UI_DrawAsset((uint16_t)(UI_ASSET_g_uiFrame2 + (uint16_t)(id - 1u) * UI_ASSET_g_uiFrame2_C),
                 (uint8_t)UI_ASSET_g_uiFrame2_C, x, y, color, bg, 0);
}

/* frames_1021: 多帧图标 (导出所有 2 帧, LZSS 组 g_uiFrame3) —— MCU 按 id 调用:
 *   id = 0 关闭 (填底色 bg); id = 1..2 画第 id 帧; 其余值不动。 */
void frames_1021(uint8_t x, uint8_t y, uint8_t id, uint16_t color, uint16_t bg)
{
    if (id == 0u) { LCD_Fill(x, y, (uint8_t)(x + 70), (uint8_t)(y + 29), bg); return; }
    if (id > 2u) return;                          /* 超范围: 保持原画面不动 */
    UI_DrawAsset((uint16_t)(UI_ASSET_g_uiFrame3 + (uint16_t)(id - 1u) * UI_ASSET_g_uiFrame3_C),
                 (uint8_t)UI_ASSET_g_uiFrame3_C, x, y, color, bg, 0);
}


