#ifndef UI_TABLE_H
#define UI_TABLE_H

/* ui_table.h —— ui_table.c 导出的表/字库/函数的声明 (每次导出重写, 别改这个文件)
 * ui_task.c 与 ui_table.c 各自独立编译, 靠这个头互相看得见 */

#include "app_ui.h"
#include "ui_assets_lzss.h"   /* LZSS 素材 ID / UI_ASSET_NONE */
#include "ui_color.h"          /* UI_COLOR_* 颜色宏 (每次导出重写) */

/* 帧: 每个静态图层一帧 (定义在 ui_table.c); .index = 画 px 数组里第几帧 (0 基), 255 = 仅网页渲染 (只清底色) */
extern const UI_FRAME_REF g_uiFrame0;
extern const UI_FRAME_REF g_uiFrame1;
extern const UI_FRAME_REF g_uiFrame2;
extern const UI_FRAME_REF g_uiFrame3;
#define UI_FRAME_N 4
extern const UI_FRAME_REF *const g_uiFrames[UI_FRAME_N];

/* 动态区域表 (定义在 ui_table.c) */
extern UI_FIELD g_uiFields[];
#define UI_FIELD_N 1

/* 数字字库: UI_FONT 结构体在 ui_font.c; 字模数组在 ui_assets_int.c / ui_assets_ext.c */
extern const UI_FONT g_uiFont_g_uiField0;

/* 坐标类型自动判定 (导出器计算): 本导出最大边缘 = 240px → 坐标参数用 uint8_t
 * ！uint8_t 会静默截断 (x=256..319 变 0..63), 编译期一个字都不报 —— 这个 #if 就是兜底哨兵 */
#define UI_EXP_COORD_MAX  240u
#if (UI_EXP_COORD_MAX > 65535u)
#error "UI_EXP_COORD_MAX 超出 uint16_t: 画布或图层太大"
#endif
#if (UI_EXP_COORD_MAX > 255u)
#define UI_COORD_16  1      /* 坐标参数一律 uint16_t (与导出器判定一致) */
#endif

/* 多帧图标 (导出所有帧): 数组声明在下面「素材数组」块 (key 与帧表条目同名); 函数在 ui_font.c
 *   id: 0=关闭(填底色), 1..N=第 id 帧 —— MCU 侧业务代码按状态给 id */
void battery(uint8_t x, uint8_t y, uint8_t id, uint16_t color, uint16_t bg);
void frames_1021(uint8_t x, uint8_t y, uint8_t id, uint16_t color, uint16_t bg);

/* 进页面画一次: 把静态图层按 z 序全画一遍 (定义在 ui_table.c) */
void UI_DrawStatic(void);

/* 素材数组 (定义在 ui_assets_int.c / ui_assets_ext.c)
 * ！外部素材是"最终形态" const uint16_t + 段属性 (ui_assets_ext.c), 内部素材 uint8_t */
extern const uint8_t g_uiFrame0_int[];
extern const uint8_t g_uiFrame1_int[];

#endif /* UI_TABLE_H */
