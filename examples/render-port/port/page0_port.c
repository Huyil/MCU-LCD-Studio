/*
 * page0_port.c —— 页 0 示例驱动（移植包）
 *
 * 只依赖渲染层：ui_task / ui_table / app_ui / ui_asset_draw / bsp_gc9a01。
 * 不依赖 示例 的 motor / sys / 按键 / 休眠模块。
 */
#include "page0_port.h"
#include "ui_task.h"
#include "ui_table.h"
#include "app_ui.h"
#include "ui_asset_draw.h"
#include "bsp_ring.h"

/* ui_user.h 里 UI_SRC_motor_speedlevel 指向这个影子变量 */
int32_t g_uiSpeed = 1;

static uint8_t  s_dir;
static uint8_t  s_bat;
static uint8_t  s_batValid;
static uint8_t  s_pause;
static uint16_t s_pauseColor = PAGE0_COLOR_ON;
static uint8_t  s_pauseValid;

static uint8_t page0_active(void)
{
    return (uint8_t)(LCD_UI_Page() == 0);
}

void Page0Port_Init(void)
{
    g_uiSpeed = 1;
    s_dir = 0u;
    s_bat = 0u;
    s_batValid = 0u;
    s_pause = 0u;
    s_pauseColor = PAGE0_COLOR_ON;
    s_pauseValid = 0u;

    /* 圆环引擎必须先初始化 (颜色/几何/定时器默认值都在这里); 示例原先漏了这一步。 */
    Ring_Init();
    /* 设表 + UI_Init；不进任何页。面板初始化由目标工程先做。 */
    LCD_UI_Setup();
}

void Page0Port_Enter(void)
{
    LCD_UI_Goto(0);

    /* 页任务的 Enter 会把 F/R 都画成白色；这里按记忆状态补一次选中色。
     * 电池/暂停同理，只有调用方设置过才补画。 */
    if (page0_active()) {
        Page0Port_SetDir(s_dir);
        if (s_batValid) Page0Port_SetBattery(s_bat);
        if (s_pauseValid) Page0Port_SetPause(s_pause, s_pauseColor);
    }
}

void Page0Port_SetLevel(uint8_t level)
{
    if (level > PAGE0_MAX_LEVEL) level = PAGE0_MAX_LEVEL;
    g_uiSpeed = (int32_t)level;

    /* 页 0 的 200ms 定时器也会按 *src != last 兜底刷新；
     * 这里立即画一次，换档更跟手。 */
    if (page0_active()) {
        UI_DrawField(&g_uiFields[0]);
    }
}

void Page0Port_SetDir(uint8_t dir)
{
    uint16_t cf;
    uint16_t cr;

    s_dir = (uint8_t)(dir ? 1u : 0u);
    cf = s_dir ? PAGE0_COLOR_OFF : PAGE0_COLOR_ON;
    cr = s_dir ? PAGE0_COLOR_ON  : PAGE0_COLOR_OFF;

    if (!page0_active()) return;

    UI_DrawFrame(0, cf);        /* F */
    UI_DrawFrame(1, cr);        /* R */
}

void Page0Port_SetBattery(uint8_t id)
{
    UI_FRAME_REF tmp;

    if (id > 14u) return;

    s_bat = id;
    s_batValid = 1u;

    if (!page0_active()) return;

    tmp = g_uiFrame2;
    tmp.index = (uint8_t)((id == 0u) ? 255u : (uint8_t)(id - 1u));
    UI_DrawFrameRefAt(&tmp, tmp.x, tmp.y, 0xFFFFu);
}

void Page0Port_SetPause(uint8_t paused, uint16_t color)
{
    s_pause = (uint8_t)(paused ? 1u : 0u);
    s_pauseColor = color;
    s_pauseValid = 1u;

    if (!page0_active()) return;

    frames_1021((uint8_t)g_uiFrame3.x, (uint8_t)g_uiFrame3.y,
                (uint8_t)(s_pause ? 2u : 1u), color, PAGE0_COLOR_BG);
}
