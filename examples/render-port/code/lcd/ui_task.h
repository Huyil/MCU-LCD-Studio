#ifndef UI_TASK_H
#define UI_TASK_H

#include <stdint.h>

/* 页号约定 (负数只给特殊页, 按键永远进不去):
 *   -1 = 关机空白 (没有内容; Goto(-1) = 出旧页 + 停刷新 + 清屏)
 *   -2 = 关机充电 / -3 = 低电 / -4 = 开机 LOGO: 网页画了内容才生成 LCD_Page*_*
 *   >=0 = 正常页: 0..LCD_PAGE_N-1, 按键只在这之间循环 */
#define LCD_PAGE_N         1      /* >=0 的正常页数 */
#define LCD_PAGE_CHARGE  (-2)
#define LCD_PAGE_LOWBAT  (-3)
#define LCD_PAGE_LOGO    (-4)

/* 每页"会不会画内容 / 有没有定时跳转 / 有没有被隐藏":
 *   LCD_HAS_PAGE_n / LCD_HAS_LOGO_PAGE…  1 = 这一页会画内容 (隐藏页 = 0)
 *   LCD_PAGE_n_HIDDEN / LCD_HIDDEN_*_PAGE 1 = 被隐藏: LCD_UI_Goto() 进去只清屏, 等新的状态
 * 隐藏页仍然是**合法页号** (状态机照样能进退), 只是不画任何东西、也不会自动跳页 ——
 * 用来"先不显示"关机充电页 / 开机 LOGO / 低电页。要不要进这一页由固件状态机决定:
 *   #if !LCD_HAS_LOWBAT_PAGE && !LCD_HIDDEN_LOWBAT_PAGE   → 干脆别进 (老行为: 跳过)
 *   #if LCD_HIDDEN_LOWBAT_PAGE                            → 进去清屏等新状态 (黑屏, 不下电) */
/* 每页"有没有内容 / 有没有定时跳转" —— 固件据此决定特殊页要不要走
 * (网页没导出 LOGO 页 / 充电页 → 跳过它, 或退回空白页 -1) */
#define LCD_HAS_PAGE_0       1      /* 页 0 会不会画内容 (隐藏页 = 0) */
#define LCD_PAGE_0_HIDDEN    0      /* 1 = 这一页被隐藏: 进去只清屏, 等固件给新状态 */
#define LCD_PAGE_0_JUMP_MS   0      /* 0 = 这一页不会自己跳走 (隐藏页恒 0) */
#define LCD_HAS_LOGO_PAGE      1      /* 页 -4 (开机LOGO) 会不会画内容 */
#define LCD_HIDDEN_LOGO_PAGE   0      /* 1 = 被隐藏: 进去只清屏等新状态 */
#define LCD_PAGE_LOGO_JUMP_MS  3000      /* 0 = 这一页不会自己跳走 (隐藏页恒 0) */
#define LCD_PAGE_LOGO_JUMP_TO  0
#define LCD_HAS_LOWBAT_PAGE      1      /* 页 -3 (低电) 会不会画内容 */
#define LCD_HIDDEN_LOWBAT_PAGE   0      /* 1 = 被隐藏: 进去只清屏等新状态 */
#define LCD_PAGE_LOWBAT_JUMP_MS  0      /* 0 = 这一页不会自己跳走 (隐藏页恒 0) */
#define LCD_HAS_CHARGE_PAGE      1      /* 页 -2 (关机充电) 会不会画内容 */
#define LCD_HIDDEN_CHARGE_PAGE   0      /* 1 = 被隐藏: 进去只清屏等新状态 */
#define LCD_PAGE_CHARGE_JUMP_MS  0      /* 0 = 这一页不会自己跳走 (隐藏页恒 0) */

/* 全局一次: 设区域表 + UI_Init; **不进任何页** (面板每次重新初始化后调一次) */
void LCD_UI_Setup(void);

/* 切页: 出旧页 (停刷新/停圆环/停跳转) → 清屏 → 进新页。
 * page = 0..LCD_PAGE_N-1 正常页; -2 关机充电; -3 低电; -1/越界 = 空白页 (不进任何页)。
 * 已经是这一页则什么都不做。 */
void LCD_UI_Goto(int8_t page);

/* 当前页号 (空白 = -1) */
int8_t LCD_UI_Page(void);

/* 按键切页: 只在 >=0 的正常页里循环 (特殊页只有固件状态机能进) */
int8_t LCD_UI_NextPage(int8_t cur);

/* 每页一对 (一般不用直接调, 用 LCD_UI_Goto) */
void LCD_PageLogo_Enter(void);      /* 进页面 (开机LOGO): 画初始化显示内容 + 启动刷新 + 3000ms 后自动跳页 0 */
void LCD_PageLogo_Exit(void);       /* 出页面: 停刷新 + 停跳转 */
void LCD_PageLowBat_Enter(void);      /* 进页面 (低电): 画初始化显示内容 + 启动刷新 */
void LCD_PageLowBat_Exit(void);       /* 出页面: 停刷新 */
void LCD_PageCharge_Enter(void);      /* 进页面 (关机充电): 画初始化显示内容 + 启动刷新 */
void LCD_PageCharge_Exit(void);       /* 出页面: 停刷新 */
void LCD_Page0_Enter(void);      /* 进页面: 画初始化显示内容 + 启动刷新 + 启圆环 */
void LCD_Page0_Exit(void);       /* 出页面: 停刷新 + 停圆环 */

#endif /* UI_TASK_H */
