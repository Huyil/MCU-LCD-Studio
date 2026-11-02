/*
 * 由 MCU-LCD-Editer 导出: 页面任务 (page 是唯一的"显示内容"真值)
 *   正常页 >=0: LCD_Page<n>_Enter / Exit (+ CB 周期刷数字 + 可选的定时跳转);
 *   特殊页 -4 开机 LOGO / -2 关机充电 / -3 低电: 只有固件状态机能进 (按键进不去);
 *   -1 = 空白页: 没有内容, Goto(-1) = 出旧页 + 停刷新/停圆环 + 清屏。
 * 用法: 面板初始化后调 LCD_UI_Setup() 一次; 之后切页只用 LCD_UI_Goto(page);
 *       main loop 里跑 timer_loop() (页面定时器 / 定时跳转靠它驱动)。
 */
#include "multi_timer.h"
#include "ui_task.h"
#include "ui_table.h"                 /* g_uiFields / g_uiFrame* / 字库 的声明 */
#include "app_ui.h"
#include "ui_user.h"                 /* 你的变量声明/宏 (这个文件不会被导出覆盖) */
#include "bsp_gc9a01.h"      /* LCD_Fill / LCD_drawGrayImage (屏幕预设里的 LCD 头) */
#include "bsp_ring.h"            /* 这一套页面里有圆环: Ring_Start/Ring_Stop/Ring_SetBg */

/* 切页清屏色 = 屏幕底色 (屏幕预设里的「背景色」; 预览/导出图片/这里三者同一个值)
 * 圆环的 AA 也按它往底色淡出 */
#define UI_PAGE_BG UI_COLOR_BLACK

/* ★ 进页清屏钩子 (2026-10-14): 默认整屏擦一次 (普通切换要干净背景)。
 * 工程在 ui_user.h (导出不覆盖它) 里 #define UI_PAGE_CLEAR() 即可覆盖:
 *   · 空操作 —— 全屏擦除只在 LCD 初始化 (SPI/面板配置完) 后做一次, 切页永不
 *     整屏擦, 背景由固件自己管 (逐符号擦除 / 免擦除进页那一套);
 *   · 或换成局部擦除 / 带 TE 同步, 随工程。 */
#ifndef UI_PAGE_CLEAR
#define UI_PAGE_CLEAR()  do { LCD_Fill(0, 0, 240, 240, UI_PAGE_BG); Ring_ScreenInvalidate(); } while (0)
#endif

/* 页变了通知固件 (可选): 在 ui_user.h 里写
 *   #define UI_PAGE_CHANGED(p)  (sys.page = (int8_t)(p))
 * LOGO 页的"定时跳转"就是在这里跳的 —— 固件不知道的话, 状态机下一拍会按它自己的
 * sys.page 把画面拽回去。不定义 = 空操作。 */
#ifndef UI_PAGE_CHANGED
#define UI_PAGE_CHANGED(p) ((void)(p))
#endif


/* ===== 页面 -4 (开机LOGO): 静态 0 层 · 3000ms 后自动跳页 0 ===== */
static struct Timer g_uiJump_PageLogo;
static void LCD_PageLogo_Jump(void *arg)
{
    (void)arg;
    LCD_UI_Goto(0);                /* 定时跳转: 这一页到点自己走 */
}
void LCD_PageLogo_Enter(void)
{
    /* 定时显示: 3000ms 后自动进页 0 (第三参 = 首次延迟; repeat=0 = 一次性, 出页会取消) */
    timer_init(&g_uiJump_PageLogo, LCD_PageLogo_Jump, 3000, 0, 0);
    timer_start(&g_uiJump_PageLogo);
}
void LCD_PageLogo_Exit(void)
{
    timer_stop(&g_uiJump_PageLogo);     /* 提前离开就取消定时跳转 */
}

/* ===== 页面 -3 (低电): 静态 0 层 ===== */
void LCD_PageLowBat_Enter(void)
{
}
void LCD_PageLowBat_Exit(void)
{
    /* 这一页没有动态内容/圆环/跳转, 不用收尾 */
}

/* ===== 页面 -2 (关机充电): 静态 0 层 ===== */
void LCD_PageCharge_Enter(void)
{
}
void LCD_PageCharge_Exit(void)
{
    /* 这一页没有动态内容/圆环/跳转, 不用收尾 */
}

/* ===== 页面 0: 静态 3 层 + 数字 1 个 (周期 200ms) + 圆环 1 个 ===== */
static struct Timer g_uiTmr_Page0;
static void LCD_Page0_CB(void *arg)
{
    (void)arg;
    {
        int32_t v = (g_uiFields[0].src != 0) ? *(g_uiFields[0].src) : 0;
        if ((g_uiFields[0].drawn == 0u) || (v != g_uiFields[0].last))
        {
            UI_DrawField(&g_uiFields[0]);        /* motor.speedlevel */
        }
    }
}
void LCD_Page0_Enter(void)
{
    /* 初始化显示内容: 按图层 z 序 (静态帧 / 数字混排 —— 与网页预览同一套叠加顺序) */
    UI_DrawField(&g_uiFields[0]);        /* motor.speedlevel */
    UI_DrawFrame(0, UI_COLOR_WHITE);
    UI_DrawFrame(1, UI_COLOR_RGB565_2104);
    UI_DrawFrame(3, UI_COLOR_WHITE);
    /* 这一页有圆环: 先对齐底色再启动 (参数在 ring_config.h) */
    Ring_SetBg(UI_PAGE_BG);
    Ring_Start(RING_GEAR_DEF, RING_DIR_DEF);
    timer_init(&g_uiTmr_Page0, LCD_Page0_CB, 200, 200, 0);
    timer_start(&g_uiTmr_Page0);
}
void LCD_Page0_Exit(void)
{
    Ring_Stop();                     /* 先停圆环, 免得它的中断还在往屏上画 */
    timer_stop(&g_uiTmr_Page0);
}

static int8_t s_page = -1;        /* -1 = 还没进过任何页 (就是空白页) */

int8_t LCD_UI_Page(void)
{
    return s_page;
}

/* 出当前页: 停刷新 / 停圆环 / 停跳转 (幂等; 不画面) */
static void ui_exit_all(void)
{
    switch (s_page) {
    case -4: LCD_PageLogo_Exit(); break;
    case -3: LCD_PageLowBat_Exit(); break;
    case -2: LCD_PageCharge_Exit(); break;
    case 0: LCD_Page0_Exit(); break;
    default: break;                  /* -1: 没有旧页 */
    }
}

/* 进目标页: 画内容 + 启刷新/圆环/跳转 (不处理旧页) */
static void ui_enter(int8_t page)
{
    switch (page) {
    case -4: LCD_PageLogo_Enter(); break;
    case -3: LCD_PageLowBat_Enter(); break;
    case -2: LCD_PageCharge_Enter(); break;
    case 0: LCD_Page0_Enter(); break;
    default: break;                  /* -1: 空白页, 没有内容 */
    }
}

/* 切页: 出旧页 → 清屏 → 进新页。
 * page = 0..LCD_PAGE_N-1 正常页; -2 关机充电; -3 低电; -1/越界 = 空白页 (不进任何页)。 */
void LCD_UI_Goto(int8_t page)
{
    if (page >= LCD_PAGE_N) page = -1;              /* 正常页越界 → 空白 */
    if (page < -1) {                                /* 负数是保留给特殊页的 */
        switch (page) {
        case -4: break;                       /* 开机LOGO */
        case -3: break;                       /* 低电 */
        case -2: break;                       /* 关机充电 */
        default: page = -1; break;                  /* 没导出 / 不认识 → 空白 */
        }
    }
    if (page == s_page) return;                     /* 已经是这一页 (含 -1 → -1) */
    ui_exit_all();                                  /* 停刷新 + 停圆环 + 停跳转 */
    UI_PAGE_CLEAR();                                /* 进页清屏 (钩子: 默认整屏擦, ui_user.h 可覆盖成空操作/局部擦) */
    s_page = page;
    ui_enter(page);
    UI_PAGE_CHANGED(s_page);                        /* 通知固件: 定时跳转后 sys.page 跟着走 */
}

/* 按键切页: 只在 >=0 的正常页里循环 (特殊页只有固件状态机能进) */
int8_t LCD_UI_NextPage(int8_t cur)
{
    static const int8_t user[] = { 0 };
    uint8_t i;
    if (cur < 0 || cur >= LCD_PAGE_N) return user[0];       /* 特殊页/空白 → 回第一页 */
    for (i = 0; i < sizeof(user) / sizeof(user[0]); i++)
        if (user[i] == cur) return user[(i + 1) % (sizeof(user) / sizeof(user[0]))];
    return user[0];
}

/* 全局一次: 设表 + UI_Init; **不进任何页** (面板每次重新初始化后调一次) */
void LCD_UI_Setup(void)
{
    ui_exit_all();                                  /* 上一次还在跑的刷新/圆环/跳转先停干净 */
    UI_SetFields(g_uiFields, UI_FIELD_N);
    UI_Init();
    s_page = -1;
}
