#ifndef __bsp_spiHost_H__
#define __bsp_spiHost_H__


#include "multi_timer.h"
#include "cw32l011_spi.h"

/* 素材已内部化 (内部 Flash LZSS 统一表, 见 lzss_decode/ui_assets_lzss):
 * W25Q 通路停用 —— 文件与驱动代码保留, 需要回退外部 Flash 时恢复此宏即可。 */
/* #define USE_W25Q */

#define SPI_MASTER

/* 示例 (CW32L011) 只有一个 SPI 外设: CW_SPI (= SPI1)。
 * LCD 与 W25Q 共用这一条总线, 靠各自的 CS 互锁 —— 见下面三个取总线函数。 */
#define LCD_SPI   CW_SPI
#define W25Q_SPI  CW_SPI

/* 共用总线互锁: 取用时保证"对方 CS 一定为高" (所有访问路径都必须走这里) */
void SPI_BusTakeLCD(void);          /* W25Q_CS(1); LCD_CS(0);  */
void SPI_BusTakeW25Q(void);         /* LCD_CS(1);  W25Q_CS(0); */
void SPI_BusRelease(void);          /* LCD_CS(1);  W25Q_CS(1); */

extern volatile uint8_t busy;       /* 定义在 bsp_spiHost.c (全工程唯一一份) */

/* W25Q 流式读 (HOLD 暂停) 状态: 1 = W25Q CS 保持低, 期间 LCD 取总线只拉 HOLD,
 * 不抬 W25Q CS —— 读指针/命令序列不丢。见 bsp_w25q.c 的 W25Q_Stream*。 */
extern volatile uint8_t g_w25qStream;

void SPI_Configuration(void);
uint8_t SPI_TransmitDC(uint8_t pData,uint16_t dc,uint32_t outtime);
uint8_t SPI_TransmitU8(uint8_t* pData,uint16_t Size,uint32_t outtime);
uint8_t SPI_TransmitU16(uint8_t* pData,uint16_t SizeU16,uint32_t outtime);
uint8_t SPI_TransmitU16GrayMultiplyColor( uint8_t *pData, uint16_t SizeU16,uint16_t color565,uint32_t outtime);
/* 8bit 灰度 × 颜色叠加, 支持左右镜像, 流水线发送 (w,h 像素尺寸; mirror=1 左右翻转) */
uint8_t SPI_TransmitU8GrayMultiplyColorMirror( uint8_t *pData, uint16_t w, uint16_t h, uint16_t color565, uint8_t mirror, uint32_t outtime);
uint8_t SPI_Fill_Transmit(uint16_t Data, uint16_t SizeU16);
uint8_t SPI_PicColor_Transmit(uint8_t *pData, uint16_t SizeU16, uint16_t color);

#endif //__bsp_spiHost_H__
