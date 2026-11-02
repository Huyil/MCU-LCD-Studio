#ifndef __app_lcd_H__
#define __app_lcd_H__

/* ============================================================================
 *  面板层最小接口 (示例: CW32L011 + GC9A01 240x240 圆屏)
 *
 *  清全屏只有**一个**入口: LCD_ClearScreen()。它内部自动重试, 并把结果
 *  记在 g_lcdClearState 里 (SWD 直接读), 上层要靠这个标志决定"屏内容可不可信"。
 *  面板上电初始化 / 唤醒 / 休眠各一个函数; 显示内容由网页导出物负责
 *  (code/lcd/ui_task.c 的 LCD_UI_Setup / LCD_UI_Goto), 底层绘制原语见
 *  bsp_gc9a01.h (LCD_Fill / LCD_drawImage / LCD_drawGrayImage …)。
 *  LCD 与 W25Q 共用 CW_SPI, 互锁在 bsp_spiHost.c 的 SPI_BusTake* 里。
 * ============================================================================ */
#include "bsp_gc9a01.h"
#include "bsp_gpio.h"

/* ---- 清屏状态 (g_lcdClearState 的取值) ----
 * OK 只表示"整屏像素全部发出去了", 不表示"面板一定收到了" (面板只发不收,
 * 读不回 GRAM)。所以外面用两条防线: ① 失败自动重试; ② 面板睡过/复位过就
 * 把标志打回 UNKNOWN, 下次开背光前强制再清一次。 */
#define LCD_CLEAR_UNKNOWN  0u   /* 还没清过 / 面板睡过了: 屏内容不可信 */
#define LCD_CLEAR_OK       1u   /* 最近一次整屏清成功 */
#define LCD_CLEAR_BUSY     2u   /* LCD 总线被别的绘制占着, 一个像素都没发 */
#define LCD_CLEAR_IO       3u   /* SPI 超时, 只发出一部分像素 */

#define LCD_CLEAR_BLACK    0x0000u  /* 屏底色 (与导出物的 UI_PAGE_BG 一致) */
#define LCD_CLEAR_TRIES    3u       /* 一次清屏最多试几次 */
#define LCD_CLEAR_WAIT_MS  1u       /* 总线忙时让出多久再试 */

/* SWD 看这几个: 状态 / 成功次数 / 失败次数 / 低层截断次数 (bsp_gc9a01.c) */
extern volatile uint8_t  g_lcdClearState;
extern volatile uint32_t g_dbgLcdClear;
extern volatile uint32_t g_dbgLcdClearFail;

/* 整屏清成 color (失败自动重试)。0 = 成功, 1 = 失败 (状态见 g_lcdClearState)。
 * 清屏会把屏上内容全抹掉: 调用方要自己作废 UI/环的差分缓存
 * (UI_FieldInvalidate / Ring_ScreenInvalidate), 否则重画会漏。 */
uint8_t LCD_ClearScreen(uint16_t color);

/* 屏内容可信吗 (最近一次整屏清成功, 且之后没睡过/没复位过)。*/
uint8_t LCD_IsCleared(void);

void LCD_Init(void);                /* 冷启动: 面板初始化 → 清屏 → 开显示 (不碰背光) */
void LCD_Wake(void);                /* SLPIN 唤醒: 重写寄存器 + SLPOUT, 不硬复位 (~25ms) */
void LCD_Sleep(void);               /* 面板进休眠 (同时把清屏标志打回 UNKNOWN) */

#endif//__app_lcd_H__
