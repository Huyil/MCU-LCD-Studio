/* 由 MCU-LCD-Editer 导出: 帧表 + 动态区域表 + 静态绘制 (纯"属性", 字模数据在 ui_font.c)
 * 与 code/spi/app_ui.h 的 UI_FRAME_REF / UI_FIELD 一一对应
 * 素材数组 (g_uiFrame0_ext / g_uiFrame0_int ...) 在 ui_assets_int.c / ui_assets_ext.c 里, 本文件只引用
 * 用法: 面板初始化后 LCD_UI_Setup() 一次 (设表 + UI_Init), 切页用 LCD_UI_Goto(page);
 *       刷新由 ui_task.c 的页面任务负责
 */
#include "app_ui.h"
#include "ui_table.h"
#include "ui_assets_lzss.h"   /* LZSS 素材 ID / UI_ASSET_NONE */
#include "ui_user.h"                 /* 你的变量声明/宏 (这个文件不会被导出覆盖) */

/* 区域表里这几个来源是"成员/下标"写法: 结构体定义要可见才能取地址。
 * 写法在 ui_user.h 里给 (那个文件不会被导出覆盖); 没给就用下面的默认写法。 */
#ifndef UI_SRC_motor_speedlevel
#define UI_SRC_motor_speedlevel (&motor.speedlevel)
#endif
const UI_FRAME_REF g_uiFrame0 = {
    .px = g_uiFrame0_int, .x = 69, .y = 200, .w = 23, .h = 32,
    .lineH = 0, .fmt = UI_FMT_GRAY8, .mirror = 0,
    .index = 0, .asset = UI_ASSET_NONE, .assetChunks = 0
};
const UI_FRAME_REF g_uiFrame1 = {
    .px = g_uiFrame1_int, .x = 142, .y = 201, .w = 25, .h = 32,
    .lineH = 0, .fmt = UI_FMT_GRAY8, .mirror = 0,
    .index = 0, .asset = UI_ASSET_NONE, .assetChunks = 0
};
const UI_FRAME_REF g_uiFrame2 = {
    .px = 0, .x = 96, .y = 205, .w = 48, .h = 24,
    .lineH = 0, .fmt = UI_FMT_RGB565, .mirror = 0,
    .index = 0, .asset = UI_ASSET_g_uiFrame2, .assetChunks = UI_ASSET_g_uiFrame2_C
};
const UI_FRAME_REF g_uiFrame3 = {
    .px = 0, .x = 85, .y = 163, .w = 70, .h = 29,
    .lineH = 0, .fmt = UI_FMT_GRAY8, .mirror = 0,
    .index = 0, .asset = UI_ASSET_g_uiFrame3, .assetChunks = UI_ASSET_g_uiFrame3_C
};

const UI_FRAME_REF *const g_uiFrames[4] = {
    &g_uiFrame0, &g_uiFrame1, &g_uiFrame2, &g_uiFrame3
};

UI_FIELD g_uiFields[] = {
    {
        .type = UI_T_NUM, .dec = 0, .align = UI_ALIGN_C,
        .cells = 2, .pad = 0,
        .x = 66, .y = 74, .color = UI_COLOR_WHITE,
        .bg = UI_COLOR_BLACK, .lineColor = UI_COLOR_WHITE, .hiLine = 255,
        .src = UI_SRC_motor_speedlevel, .font = &g_uiFont_g_uiField0,
        .frames = 0, .nframes = 0
    },
};

/* 静态图层绘制: 由图层列表自动生成 (进页面调用一次) */
void UI_DrawStatic(void)
{
    UI_DrawFrame(0, UI_COLOR_WHITE);
    UI_DrawFrame(1, UI_COLOR_RGB565_2104);
    UI_DrawFrame(3, UI_COLOR_WHITE);        /* frames_1021 · 第 1/2 帧 (选帧走 .index) */
    /* 不进这里 (帧表条目仍在, 固件按需 UI_DrawFrame 自取): g_uiFrame2 (battery · 仅尺寸+仅素材) */
}
