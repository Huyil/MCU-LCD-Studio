#ifndef PAGE0_PORT_H
#define PAGE0_PORT_H

/*
 * page0_port —— 移植包的页 0 示例驱动
 *
 * 它把“业务状态”翻译成渲染调用，故意不依赖 示例 的 motor / sys / 按键 /
 * 休眠模块。目标工程只要在状态变化时调用下面的 setter 即可。
 *
 * 初始化顺序（目标工程负责）：
 *   1. GPIO / SPI / 面板时钟等底层初始化
 *   2. LCD_Init()                      // app_lcd.c：复位、清屏、DISPON
 *   3. Page0Port_Init()                // UI_SetFields / UI_Init
 *   4. Page0Port_Enter()               // 进页 0：数字/F/R/K·RPM + 圆环
 *   5. 主循环里跑 timer_loop()          // 页 0 的 200ms 数字刷新/圆环定时器
 */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 颜色默认值：可按目标工程修改 */
#ifndef PAGE0_COLOR_BG
#define PAGE0_COLOR_BG       0x0000u
#endif
#ifndef PAGE0_COLOR_ON
#define PAGE0_COLOR_ON       0xFFFFu
#endif
#ifndef PAGE0_COLOR_OFF
#define PAGE0_COLOR_OFF      0x2104u
#endif

/* 档位上限（与 示例 的 MAX_SPEED_LEVEL 对齐；目标工程可改） */
#ifndef PAGE0_MAX_LEVEL
#define PAGE0_MAX_LEVEL      35u
#endif

/* 初始化 UI 表（不初始化面板；面板由目标工程先 LCD_Init()） */
void Page0Port_Init(void);

/* 进页 0；内部调用 LCD_UI_Goto(0)，会画数字/F/R/K·RPM 并启动圆环 */
void Page0Port_Enter(void);

/* 更新档位数字；level = 0..PAGE0_MAX_LEVEL */
void Page0Port_SetLevel(uint8_t level);

/* 更新方向选中色；dir = 0 正转(F)，1 反转(R) */
void Page0Port_SetDir(uint8_t dir);

/* 更新电池图标；id = 0 关闭，1..14 画第 id 帧 */
void Page0Port_SetBattery(uint8_t id);

/* 更新 K·RPM / PAUSE 多帧图标；paused=0 画 K·RPM，paused=1 画 PAUSE。
 * color 由调用方给（PAUSE 闪烁时传白色/淡灰）。 */
void Page0Port_SetPause(uint8_t paused, uint16_t color);

#ifdef __cplusplus
}
#endif

#endif /* PAGE0_PORT_H */
