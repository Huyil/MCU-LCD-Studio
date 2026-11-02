/*************************************************************
 * bsp_gpio.h  -  由 MCU GPIO 配置工具自动生成
 * 芯片: CW32L011      封装: LQFP32/QFN32
 * 生成日期: 2026-10-20
 *************************************************************/

#ifndef __BSP_GPIO_H__
#define __BSP_GPIO_H__

#include "cw32l011_gpio.h"
#include "cw32l011_sysctrl.h"

#define GPIOA ((GPIO_TypeDef*) GPIOA_BASE)
#define GPIOB ((GPIO_TypeDef*) GPIOB_BASE)
#define GPIOC ((GPIO_TypeDef*) GPIOC_BASE)

/*============================================================*/
/* 引脚信号定义                                                */
/*============================================================*/

// ---- 输出信号 ----
#define VM_PWM_GPIO  GPIOA
#define VM_PWM_Pin   GPIO_PIN_2   /* PA02 调压PWM (输出·推挽) -> ATIM_CH4N (AF7) */
#define W25_CS_GPIO  GPIOA
#define W25_CS_Pin   GPIO_PIN_4   /* PA04 (输出·推挽) */
#define W25_WP_GPIO  GPIOA
#define W25_WP_Pin   GPIO_PIN_5   /* PA05 (输出·推挽) */
#define COMP_V_GPIO  GPIOA
#define COMP_V_Pin   GPIO_PIN_6   /* PA06 升压开关-运放 (输出·推挽) */
#define PWR_EN_GPIO  GPIOA
#define PWR_EN_Pin   GPIO_PIN_7   /* PA07 升压开关-IC (输出·推挽) */
#define MOTOR_P_GPIO  GPIOA
#define MOTOR_P_Pin   GPIO_PIN_8   /* PA08 电机芯片IN+ (输出·推挽) -> ATIM_CH1 (AF6) */
#define MOTOR_N_GPIO  GPIOA
#define MOTOR_N_Pin   GPIO_PIN_9   /* PA09 电机芯片IN- (输出·推挽) -> ATIM_CH2 (AF7) */
#define LCD_SCL_GPIO  GPIOB
#define LCD_SCL_Pin   GPIO_PIN_3   /* PB03 (输出·推挽) -> SPI_SCK (AF3) */
#define LCD_SDA_GPIO  GPIOB
#define LCD_SDA_Pin   GPIO_PIN_5   /* PB05 (输出·推挽) -> SPI_MOSI (AF3) */
#define LCD_RESET_GPIO  GPIOB
#define LCD_RESET_Pin   GPIO_PIN_6   /* PB06 (输出·推挽) */
#define LCD_CS_GPIO  GPIOB
#define LCD_CS_Pin   GPIO_PIN_7   /* PB07 (输出·推挽) 上拉 */
#define LCD_RS_GPIO  GPIOC
#define LCD_RS_Pin   GPIO_PIN_13   /* PC13 (输出·推挽) */
#define LCD_BL_GPIO  GPIOC
#define LCD_BL_Pin   GPIO_PIN_14   /* PC14 背光 只需电平控制 (输出·推挽) */
#define W25_HOLD_GPIO  GPIOC
#define W25_HOLD_Pin   GPIO_PIN_15   /* PC15 (输出·推挽) 上拉 */

// ---- 输入信号 ----
#define A_GPIO  GPIOA
#define A_Pin   GPIO_PIN_0   /* PA00 编码器INA (输入) 上拉 -> GTIM2_CH1 (AF6) */
#define B_GPIO  GPIOA
#define B_Pin   GPIO_PIN_1   /* PA01 编码器INB (输入) 上拉 -> GTIM2_CH2 (AF6) */
#define R_GPIO  GPIOA
#define R_Pin   GPIO_PIN_11   /* PA11 按键R (输入) 上拉 */
#define F_GPIO  GPIOA
#define F_Pin   GPIO_PIN_12   /* PA12 按键F (输入) 上拉 */
#define PAUSE_GPIO  GPIOA
#define PAUSE_Pin   GPIO_PIN_15   /* PA15 按键暂停 长按开关机 (输入) 上拉 */
#define W25_MISO_GPIO  GPIOB
#define W25_MISO_Pin   GPIO_PIN_4   /* PB04 (输入) -> SPI_MISO (AF3) */

// ---- 模拟信号 ----
#define BATT_CEK_GPIO  GPIOA
#define BATT_CEK_Pin   GPIO_PIN_3   /* PA03 上拉1.5M 下拉499K 1nF 电池电压检测 (模拟输入) */
#define MOTOR_I_GPIO  GPIOA
#define MOTOR_I_Pin   GPIO_PIN_10   /* PA10 电流检测 (模拟输入) */
#define CH_STAT_GPIO  GPIOB
#define CH_STAT_Pin   GPIO_PIN_0   /* PB00 充电信号使用ADC检测主控休眠前改成数字输入边沿检测用于唤醒 (模拟输入) */

/*============================================================*/
/* 功能操作宏                                                  */
/*============================================================*/
#define A_READ()  ((A_GPIO->IDR & A_Pin) ? 1u : 0u)   /* 编码器INA */
#define B_READ()  ((B_GPIO->IDR & B_Pin) ? 1u : 0u)   /* 编码器INB */
#define VM_PWM(i)  ((i)?(VM_PWM_GPIO->BSRR = VM_PWM_Pin):(VM_PWM_GPIO->BRR = VM_PWM_Pin))   /* 调压PWM */
#define W25_CS(i)  ((i)?(W25_CS_GPIO->BSRR = W25_CS_Pin):(W25_CS_GPIO->BRR = W25_CS_Pin))
#define W25_WP(i)  ((i)?(W25_WP_GPIO->BSRR = W25_WP_Pin):(W25_WP_GPIO->BRR = W25_WP_Pin))
#define COMP_V(i)  ((i)?(COMP_V_GPIO->BSRR = COMP_V_Pin):(COMP_V_GPIO->BRR = COMP_V_Pin))   /* 升压开关-运放 */
#define PWR_EN(i)  ((i)?(PWR_EN_GPIO->BSRR = PWR_EN_Pin):(PWR_EN_GPIO->BRR = PWR_EN_Pin))   /* 升压开关-IC */
#define MOTOR_P(i)  ((i)?(MOTOR_P_GPIO->BSRR = MOTOR_P_Pin):(MOTOR_P_GPIO->BRR = MOTOR_P_Pin))   /* 电机芯片IN+ */
#define MOTOR_N(i)  ((i)?(MOTOR_N_GPIO->BSRR = MOTOR_N_Pin):(MOTOR_N_GPIO->BRR = MOTOR_N_Pin))   /* 电机芯片IN- */
#define R_READ()  ((R_GPIO->IDR & R_Pin) ? 1u : 0u)   /* 按键R */
#define F_READ()  ((F_GPIO->IDR & F_Pin) ? 1u : 0u)   /* 按键F */
#define PAUSE_READ()  ((PAUSE_GPIO->IDR & PAUSE_Pin) ? 1u : 0u)   /* 按键暂停 长按开关机 */
#define LCD_SCL(i)  ((i)?(LCD_SCL_GPIO->BSRR = LCD_SCL_Pin):(LCD_SCL_GPIO->BRR = LCD_SCL_Pin))
#define W25_MISO_READ()  ((W25_MISO_GPIO->IDR & W25_MISO_Pin) ? 1u : 0u)
#define LCD_SDA(i)  ((i)?(LCD_SDA_GPIO->BSRR = LCD_SDA_Pin):(LCD_SDA_GPIO->BRR = LCD_SDA_Pin))
#define LCD_RESET(i)  ((i)?(LCD_RESET_GPIO->BSRR = LCD_RESET_Pin):(LCD_RESET_GPIO->BRR = LCD_RESET_Pin))
#define LCD_CS(i)  ((i)?(LCD_CS_GPIO->BSRR = LCD_CS_Pin):(LCD_CS_GPIO->BRR = LCD_CS_Pin))
#define LCD_RS(i)  ((i)?(LCD_RS_GPIO->BSRR = LCD_RS_Pin):(LCD_RS_GPIO->BRR = LCD_RS_Pin))
#define LCD_BL(i)  ((i)?(LCD_BL_GPIO->BSRR = LCD_BL_Pin):(LCD_BL_GPIO->BRR = LCD_BL_Pin))   /* 背光 只需电平控制 */
#define W25_HOLD(i)  ((i)?(W25_HOLD_GPIO->BSRR = W25_HOLD_Pin):(W25_HOLD_GPIO->BRR = W25_HOLD_Pin))

/*============================================================*/
/* 功能分类汇总 (引脚组合宏, 按端口)                            */
/*============================================================*/
#define OUT_PP_Pin  (0|VM_PWM_Pin|W25_CS_Pin|W25_WP_Pin|COMP_V_Pin|PWR_EN_Pin|MOTOR_P_Pin|MOTOR_N_Pin)   // PA02, PA04, PA05, PA06, PA07, PA08, PA09
#define IN_Pin  (0|A_Pin|B_Pin|R_Pin|F_Pin|PAUSE_Pin)   // PA00, PA01, PA11, PA12, PA15
#define ADC_Pin  (0|BATT_CEK_Pin|MOTOR_I_Pin)   // PA03, PA10
#define NC_Pin  (0)                 // 无未使用引脚
#define IN_UP_Pin  (0|A_Pin|B_Pin|R_Pin|F_Pin|PAUSE_Pin)   // PA00, PA01, PA11, PA12, PA15 (上拉)
#define OUT_PP_BPin  (0|LCD_SCL_Pin|LCD_SDA_Pin|LCD_RESET_Pin|LCD_CS_Pin)   // PB03, PB05, PB06, PB07
#define IN_BPin  (0|W25_MISO_Pin)   // PB04
#define ADC_BPin  (0|CH_STAT_Pin)   // PB00
#define NC_BPin  (0|GPIO_PIN_1)                 // PB01
#define OUT_PP_Up_BPin  (0|LCD_CS_Pin)   // PB07 (上拉)
#define OUT_PP_CPin  (0|LCD_RS_Pin|LCD_BL_Pin|W25_HOLD_Pin)   // PC13, PC14, PC15
#define NC_CPin  (0)                 // 无未使用引脚
#define OUT_PP_Up_CPin  (0|W25_HOLD_Pin)   // PC15 (上拉)

// ---- SWD 调试口 (不初始化) ----
#define SWD_Pin  (GPIO_PIN_13|GPIO_PIN_14)   // PA13, PA14

void GPIO_Configuration(void);

#include "bsp_gpio_supp.h"   /* 工程自有别名层 (导出物覆盖本文件后需手工补回这一行) */

#endif
