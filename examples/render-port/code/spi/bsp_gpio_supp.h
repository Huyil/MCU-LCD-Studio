#ifndef __BSP_GPIO_SUPP_H__
#define __BSP_GPIO_SUPP_H__

/*
 * 渲染移植包裁剪版：只保留 LCD/SPI 驱动用到的引脚别名。
 *
 * 原工程的 bsp_gpio_supp.h 还包含 ADC/按键/充电/电源等别名，并 #include
 * "bsp_adc.h"；渲染包不需要这些依赖，所以这里只保留：
 *   LCD_DC / LCD_RST / W25Q_CS / W25Q_HOLD
 *
 * 目标工程替换 bsp_gpio.h 时，把下面这些别名一并映射到自己的引脚即可。
 */

#define LCD_DC_GPIO       LCD_RS_GPIO
#define LCD_DC_Pin        LCD_RS_Pin
#define LCD_DC(i)         LCD_RS(i)          /* 数据/命令 */

#define LCD_RST_GPIO      LCD_RESET_GPIO
#define LCD_RST_Pin       LCD_RESET_Pin
#define LCD_RST(i)        LCD_RESET(i)       /* 面板复位 */

#define W25Q_CS_GPIO      W25_CS_GPIO
#define W25Q_CS_Pin       W25_CS_Pin
#define W25Q_CS(i)        W25_CS(i)          /* 外部 Flash 片选（当前未使用） */

#define W25Q_HOLD_GPIO    W25_HOLD_GPIO
#define W25Q_HOLD_Pin     W25_HOLD_Pin
#define W25Q_HOLD(i)      W25_HOLD(i)        /* 外部 Flash HOLD（当前未使用） */

#endif /* __BSP_GPIO_SUPP_H__ */
