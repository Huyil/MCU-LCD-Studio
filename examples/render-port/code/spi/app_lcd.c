#include "app_lcd.h"
#include "bsp_gc9a01.h"
#include "bsp_gpio.h"

/* ============================================================================
 *  面板层 (示例): 清屏 / 上电初始化 / 休眠
 *
 *  2026-09 二次清理后只剩底层原语; 页面级 UI (sys.page 调度) 在 code/lcd/ui_task.c。
 *  2026-10 移植到 示例: 去掉 bsp_timer/bsp_adc/app_sleep/multi_timer 依赖,
 *  驱动层不再拖业务模块; busy 也移到 bsp_spiHost.c 集中一份。
 *  2026-10-28 上电花屏: 清屏独立成 LCD_ClearScreen() —— 带状态、带重试;
 *  上电初始化改成 "复位 → SLPOUT → 清屏 → DISPON", 让随机 GRAM 永远不被显示;
 *  面板一睡就把标志打回 UNKNOWN, 醒来先清再开背光。
 * ============================================================================ */

/* 清屏状态 (SWD 读): 决定上层还能不能相信屏上内容 */
volatile uint8_t  g_lcdClearState = LCD_CLEAR_UNKNOWN;
volatile uint32_t g_dbgLcdClear;        /* 整屏清成功次数 */
volatile uint32_t g_dbgLcdClearFail;    /* 整屏清失败次数 (重试用尽) */

uint8_t LCD_IsCleared(void)
{
  return (uint8_t)(g_lcdClearState == LCD_CLEAR_OK);
}

/* 清一次 (不重试), 返回 LCD_IO_xxx。
 * 每次都先作废地址缓存再发 CASET/RASET: 上一次如果被超时截断, 面板的 RAM
 * 地址指针停在窗口半路, 只有重新下发窗口才能从 (0,0) 干净地开始。 */
static uint8_t lcd_clear_once(uint16_t color)
{
  LCD_AddrCacheFlush();
  return LCD_Fill(0u, 0u, LCD_W, LCD_H, color);
}

uint8_t LCD_ClearScreen(uint16_t color)
{
  uint8_t i;
  uint8_t rc = LCD_IO_BUSY;

  for (i = 0u; i < LCD_CLEAR_TRIES; i++)
  {
    /* 总线被别的绘制占着 (环/素材正在画): 让出一拍再来, 不硬插进出。
     * 上电阶段根本没别人用总线, 这里兜的是运行期误调。 */
    if (busy)
    {
      g_lcdClearState = LCD_CLEAR_BUSY;
      if ((i + 1u) < LCD_CLEAR_TRIES) HAL_Delay(LCD_CLEAR_WAIT_MS);
      continue;
    }

    rc = lcd_clear_once(color);
    if (rc == LCD_IO_OK)
    {
      g_lcdClearState = LCD_CLEAR_OK;
      g_dbgLcdClear++;
      return 0u;
    }

    /* 超时多为一次性的 SPI 抖动: 立刻整屏重来 (窗口已重新下发, 不会接着
     * 半路写); 忙则等一下。状态先记成失败, 成功了再翻成 OK。 */
    g_lcdClearState = (rc == LCD_IO_TIMEOUT) ? LCD_CLEAR_IO : LCD_CLEAR_BUSY;
  }

  g_dbgLcdClearFail++;
  return 1u;
}

/* 调试遥测 (SWD 读): LCD_Init 每完成一次 (init + 整屏 fill) +1 */
volatile uint32_t g_dbgLcdInit;

void LCD_Init(void)
{
  LCD144_Init();

  /* 面板 GRAM 上电/复位后是随机值 (GC9A01 没有内置清屏), 初始化完必须写一次
   * 全屏 fill —— 否则之后进页 0 时看到的就是一片彩色雪花 = 花屏。
   * ！不能指望 UI 的切页清屏: LCD_UI_Setup() 已把 s_page 置 -1, 之后
   *   LCD_UI_Goto(-1) 因 page == s_page 直接返回, UI_PAGE_CLEAR() 根本不会执行。
   * ！这里**不碰背光**: 上电时还不知道该不该显示 (关机不充电的页面是 -1 空白页),
   *   背光统一由显示层按页面决定 (app_disp.c 的 DSP_Init / DSP_Tick)。
   *   旧写法在这里恒 LCD_BL(1), 电池一接上就先亮一下, 再被 System_Handle()
   *   的 LCD_BL(0) 关掉 —— 现场看到的"背光闪一下后灭"。 */
  (void)LCD_ClearScreen(LCD_CLEAR_BLACK);

  /* 清完再开显示输出 (见 LCD144_Init 注释): 万一上面几次都没清成功, 至少
   * 标志是 UNKNOWN, 上层开背光前会再补一次 (DSP_Init / DSP_Tick)。 */
  LCD144_DisplayOn();

  g_dbgLcdInit++;
}

void LCD_Sleep(void)
{
  LCD144_Sleep();

  /* 面板睡过之后不再假设 GRAM 还是黑的: 睡眠期间 VDD 可能被拉低/掉电,
   * GRAM 会花成随机点。标志打回 UNKNOWN, app_disp.c 的唤醒分支看到它就先
   * 整屏清、再开背光 (清的时候背光还灭着, 看不见)。 */
  g_lcdClearState = LCD_CLEAR_UNKNOWN;
}

/* 从面板 SLPIN 唤醒 (MCU 深度休眠返回后): 不硬复位, 只重写寄存器 + SLPOUT,
 * ≈25ms。GRAM 是否可信由 g_lcdClearState 判断 (睡时已被置 UNKNOWN), 唤醒后
 * 是否整屏清由调用方决定 (app_disp.c 的 DSP_Tick)。 */
void LCD_Wake(void)
{
  LCD144_WakeUp();
}
