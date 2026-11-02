#ifndef UI_USER_H
#define UI_USER_H

/*
 * ui_user.h —— 移植包模板（不是 示例 原版）
 *
 * 这个文件是 Web 导出器“第一次生成后就不再覆盖”的工程钩子文件。
 * 移植到新工程时，按目标工程自己的变量/清屏策略修改这里；其余
 * ui_*.c/.h 都是生成物或通用渲染代码，不需要动。
 */
#include <stdint.h>

/* ---- 数字区域的来源变量 ----
 * ui_table.c 里 g_uiFields[0] 的 .src 会展开成 UI_SRC_motor_speedlevel。
 * UI_FIELD.src 必须是 const int32_t *，所以目标工程要给一个 int32_t 影子变量。
 * 本移植包在 port/page0_port.c 里定义了 g_uiSpeed，并通过
 * Page0Port_SetLevel() 更新它。 */
extern int32_t g_uiSpeed;
#define UI_SRC_motor_speedlevel (&g_uiSpeed)

/* ---- 外部素材段属性 ----
 * 本包全部素材在内部 Flash，不需要 ER_EXTUI 段；留空即可。
 * 回退外部 Flash 时再恢复 __attribute__((used, section("ER_EXTUI")))。 */
#ifndef UI_EXT_RO
#define UI_EXT_RO
#endif

/* ---- 进页清屏钩子 ----
 * 不定义时，ui_task.c 的默认实现是整屏 LCD_Fill（适合空白/充电/低电页）。
 * 如果页 0 也不想闪，可以在这里覆盖成“只清非页 0”的策略，例如：
 *
 *   extern uint8_t g_uiClearOnGoto;
 *   #define UI_PAGE_CLEAR() do { \
 *           if (g_uiClearOnGoto) { \
 *               (void)LCD_ClearScreen(LCD_CLEAR_BLACK); \
 *               Ring_ScreenInvalidate(); \
 *           } \
 *       } while (0)
 *
 * 注意：定义前要确保 LCD_ClearScreen / Ring_ScreenInvalidate 已可见。
 */

#endif /* UI_USER_H */
