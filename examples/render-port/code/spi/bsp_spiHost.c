#include "bsp_spiHost.h"
#include "multi_timer.h"
#include "bsp_gpio.h"

#include "cw32l011_sysctrl.h"


#define IS_NONZERO_PARAM(PARAM) ((PARAM) != 0)

/* ============================================================================
 *  示例 (CW32L011): LCD 与 W25Q 共用同一条 SPI (CW_SPI = SPI1)
 *
 *  与 SpeedTest(CW32L010) 最大的不同: 那边 LCD/CW_SPI 与 W25Q/CW_SPI2 是两条独立
 *  外设, 所以能"边读 Flash 边写屏"; 这里只有一个 SPI, 必须靠 CS 互锁 ——
 *  任何时刻只允许一个器件的 CS 为低, 下面三个函数是全工程唯一的 CS 入口。
 * ============================================================================ */

/* SPI_ICR 是 **R1W0: 写 0 清除, 写 1 无功能** (手册 17.7.7, p461):
 *   FLUSH  W0 = 清空发送缓冲区和移位寄存器 (清完 ISR.TXE 置 1);
 *   RXNE/OV/SSF/SSR/UD/SSERR/MODF  W0 = 清零该标志, W1 = 无功能。
 * 所以"清 RXNE/OV"必须写 0: 写 0x00 一次把全部标志清掉并 flush TX
 * (手册 17.5.1.2 步骤 12 也是这么写的)。
 * ！旧写法 `ICR = SPI_ICR_RXNE | SPI_ICR_OV` (写 0x22) 位 1/5 写的是 1 = 无功能,
 *   实际只 flush 了 TX、清了 SSF/SSR/UD/SSERR/MODF; RXNE 是上面读 DR 清掉的,
 *   OV 则一直没清 (只是状态位, 没开中断, 所以没暴露出问题)。 */
#define SPI_ICR_CLEAR_ALL   (0x00000000u)

volatile uint8_t busy = 0;              /* 全工程唯一一份 (原来在 app_lcd.c 里) */
volatile uint8_t g_w25qStream = 0;      /* 1 = W25Q 流式读进行中: CS 保持低, 用 HOLD 暂停 */

/* 等 SPI 移位寄存器彻底空闲: TXE 只表示"发送缓冲空", 末字节可能仍在线上 (BUSY=1)。
 * 共用总线时这一步是必要的 —— 若在对方还在移位时拉低自己的 CS,
 * 对方会把上一个器件的尾字节当成自己的第一个字节, 命令相位被污染。 */
static void SPI_WaitIdle(void)
{
    uint32_t guard = 200000u;
    while (LCD_SPI->ISR_f.BUSY != RESET)
    {
        if (--guard == 0u) break;       /* 兜底: 不让总线卡死 */
    }
}

/* 取 LCD 总线: 先赶走 W25Q, 再选中 LCD */
void SPI_BusTakeLCD(void)
{
    SPI_WaitIdle();
    CW_SPI->CR1_f.BR = 0;   /* /2 = 48MHz: LCD 写屏走高速档 */

    /* W25Q 读会往 RX 里留一堆没人读的字节 (LCD 只发不收), 不清掉会干扰
     * 紧接着的第一笔 LCD 命令/数据 (现场: 第一个字模上半截发白)。 */
    (void)LCD_SPI->DR;                  /* 读走残留数据 (清 RXNE) */
    LCD_SPI->ICR = SPI_ICR_CLEAR_ALL;   /* 写 0: 清全部标志 + flush TX */

    if (g_w25qStream) {
        W25Q_HOLD(0);       /* 流式读暂停: CS 保持低 */
    } else {
        W25Q_HOLD(1);
        W25Q_CS(1);
    }
    LCD_CS(0);
}

/* 取 W25Q 总线: 先赶走 LCD, 再选中 W25Q */
void SPI_BusTakeW25Q(void)
{
    SPI_WaitIdle();
    /* W25Q 读走 24MHz (/4): 48MHz 下 1.4KB 长突发在飞线上裕量不足,
     * 实测表现是字模上半截读成 0xFF (白) / 画面局部错色。
     * LCD 写屏仍由 SPI_BusTakeLCD() 切回 48MHz。 */
    CW_SPI->CR1_f.BR = 0;   /* /2 = 48MHz (应用户要求恢复) */
    W25Q_HOLD(1);           /* W25Q 必须 HOLD 释放才能读; 每次取总线都确认一次 */
    LCD_CS(1);

    /* LCD 是"只发不收": 它的每个时钟都会在 RX 里留下一个没人读的字节,
     * 残留 RXNE/OV 不清掉的话, W25Q 读回的第一个字节会是陈旧的 LCD 字节
     * → 读命令整体错位。所以每次取 W25Q 总线都先把 RX 清干净。 */
    (void)LCD_SPI->DR;                          /* 读走残留数据 (清 RXNE) */
    LCD_SPI->ICR = SPI_ICR_CLEAR_ALL;           /* 写 0: 清 RXNE/OV + flush TX */

    W25Q_CS(0);
}

/* 释放总线: 两个片选都放开 */
void SPI_BusRelease(void)
{
    /* 抬 CS 之前必须等移位器彻底空闲 (TXE 只表示"发送缓冲空", 末字节可能还在线上):
     * 共用一条总线时提前抬 CS 会把最后一个字节截断。 */
    SPI_WaitIdle();
    LCD_CS(1);
    if (g_w25qStream) {
        /* RX 里可能还压着刚发出去的 LCD 数据; 只读 DR 不会出时钟, 也不会
         * 吃掉 W25Q 的字节。清 RX 的动作放在 W25Q_StreamRead() 入口, 那里
         * 离"真正开始读"最近, 中间再有人用总线也不会漏。 */
        W25Q_HOLD(1);       /* 恢复流式读; CS 保持低 */
    } else {
        W25Q_CS(1);
    }
}
/* (原 SpeedTest 的 SPI_TXINT_EN "中断收尾" 开关已删: 本驱动固定纯查询模式,
 *  不开 TXE 中断 —— 超时路径一律自己 SPI_BusRelease(), 不留中断尾巴。) */


uint8_t SPI_WhileTXE(uint32_t us)
{
    /* HCLK 固定 96MHz: 写常量, 避免 SystemCoreClock/1e6 的变量除法 (M0+ 无硬件除法) */
    SysTick->LOAD = us * (96000000UL / 1000000UL) - 1; // 1us 的 tick 数量
    SysTick->VAL = 0;  // 清零当前值
    SysTick->CTRL = SysTick_CTRL_ENABLE_Msk|SysTick_CTRL_CLKSOURCE_Msk; // 启用 SysTick，无中断

    while ((SysTick->CTRL & SysTick_CTRL_COUNTFLAG_Msk) == 0)
    {
      if(LCD_SPI->ISR_f.TXE)
      {
        SysTick->CTRL = 0; // 关闭 SysTick
        return 0;
      }
        // 等待溢出
    }

    SysTick->CTRL = 0; // 关闭 SysTick
    return 1;
}

uint8_t SPI_TransmitDC(uint8_t pData,uint16_t dc,uint32_t outtime)
{
  assert_param(IS_NONZERO_PARAM(outtime));
  uint32_t time_Start = millis();

  while((LCD_SPI->ISR_f.TXE) == RESET){
    if(millis() - time_Start > outtime)
    {
      SPI_BusRelease();
      return 1;
    }
  }
  
  if(dc==0)
  {
    LCD_SPI->CR1_f.WIDTH = 0x07;
    SPI_BusRelease();
//    time_Start = millis();
//    while(millis() - time_Start < 2);
  }
  
  LCD_DC(dc);
  SPI_BusTakeLCD();
  LCD_SPI->DR = (pData);
  
//  time_Start = millis();
//  while(millis() - time_Start < 2);
  return 0;
}

uint8_t SPI_TransmitU8(uint8_t* pData,uint16_t Size,uint32_t outtime)
{
  assert_param(IS_NONZERO_PARAM(Size));
  assert_param(IS_NONZERO_PARAM(pData));
  assert_param(IS_NONZERO_PARAM(outtime));
  uint32_t time_Start = millis();

  while((LCD_SPI->ISR_f.TXE) == RESET){
    if(millis() - time_Start > outtime)
    {
      SPI_BusRelease();
      return 1;
    }
  }
#ifndef LIB_OTHER_USER
  SPI_ITConfig(LCD_SPI, SPI_IT_TXE, DISABLE);
  SPI_BusTakeLCD();
  LCD_SPI->ICR_f.FLUSH = 0;   /* 写 0 = 清空发送缓冲+移位寄存器, 清完 TXE=1 (R1W0) */
  //if(LCD_SPI->CR1_f.WIDTH != 0x07)
  {
    LCD_SPI->CR1_f.WIDTH = 0x07;
  }
#endif
  LCD_SPI->DR = *((uint8_t *)pData);
  
  if(--Size) {
    pData += sizeof(uint8_t);
  }

  while (Size > 0U)
  {
    if(LCD_SPI->ISR_f.TXE)
    {
      LCD_SPI->DR = *((uint8_t *)pData);
      pData += sizeof(uint8_t);
      Size--;
    }else if(millis() - time_Start > outtime)
    {
      //OUTTIME
      SPI_BusRelease();
      return 1;
    }
  }
  
  
  //SPI_ITConfig(LCD_SPI, SPI_IT_TXE, ENABLE);
  while((LCD_SPI->ISR_f.TXE) == RESET){
    if(millis() - time_Start > outtime)
    {
      SPI_BusRelease();
      return 1;
    }
  }
  //SPI_BusRelease();
  return 0;
}


uint8_t SPI_TransmitU16GrayMultiplyColor(
    uint8_t  *pData,
    uint16_t  SizeU16,
    uint16_t  color565,
    uint32_t  outtime
)
{
    assert_param(SizeU16);
    assert_param(pData);
    assert_param(outtime);

    uint32_t time_Start = millis();
    uint16_t *src = (uint16_t *)pData;

    // 拆目标颜色
    uint32_t cr = (color565 >> 11) & 0x1F;
    uint32_t cg = (color565 >> 5)  & 0x3F;
    uint32_t cb =  color565        & 0x1F;

    // 等待 TXE
    while (LCD_SPI->ISR_f.TXE == RESET)
    {
        if (millis() - time_Start > outtime)
            return 1;
    }

#ifndef LIB_OTHER_USER
    SPI_ITConfig(LCD_SPI, SPI_IT_TXE, DISABLE);
    SPI_BusTakeLCD();
    LCD_SPI->ICR_f.FLUSH = 0;   /* 写 0 = 清空发送缓冲+移位寄存器, 清完 TXE=1 (R1W0) */
    LCD_SPI->CR1_f.WIDTH = 0x0F;   // 16bit
#endif

    /* ---------- 第一个像素：直接算 + 发 ---------- */
    uint16_t px = *src++;
    uint32_t g  = (px >> 5) & 0x3F;

    uint16_t out =
        ((g * cr) >> 6) << 11 |
        ((g * cg) >> 6) << 5  |
        ((g * cb) >> 6);

    LCD_SPI->DR = out;

    if (--SizeU16 == 0)
        goto SPI_END;

    /* ---------- 预取下一个像素 ---------- */
    px = *src++;
    SizeU16--;

    while (1)
    {
        // 等待发送缓冲空
        time_Start = millis();
        while (LCD_SPI->ISR_f.TXE == RESET)
        {
            if (millis() - time_Start > outtime)
                goto SPI_TIMEOUT;
        }

        // 计算当前缓存像素
        g = (px >> 5) & 0x3F;
        out =
            ((g * cr) >> 6) << 11 |
            ((g * cg) >> 6) << 5  |
            ((g * cb) >> 6);

        // 发送
        LCD_SPI->DR = out;

        if (SizeU16 == 0)
            break;

        // 立刻缓存下一像素（pipeline）
        px = *src++;
        SizeU16--;
    }

SPI_END:
    if (SPI_WhileTXE(outtime))
        goto SPI_TIMEOUT;
    SPI_BusRelease();
    return 0;

SPI_TIMEOUT:
    SPI_BusRelease();
    return 1;
}

/* 8bit 灰度像素 × 目标颜色叠加, 输出 RGB565, 支持左右镜像 + 流水线.
   流水线: 先发首像素, 在 SPI 忙(TXE 判定前)预计算下一像素颜色, 隐藏乘法延迟. */
uint8_t SPI_TransmitU8GrayMultiplyColorMirror(
    uint8_t  *pData,
    uint16_t  w,
    uint16_t  h,
    uint16_t  color565,
    uint8_t   mirror,
    uint32_t  outtime
)
{
    assert_param(w);
    assert_param(h);
    assert_param(pData);
    assert_param(outtime);

    uint32_t time_Start = millis();
    uint32_t total = (uint32_t)w * h;

    /* 拆目标颜色通道 */
    uint32_t cr = (color565 >> 11) & 0x1F;   /* 5bit */
    uint32_t cg = (color565 >> 5)  & 0x3F;   /* 6bit */
    uint32_t cb =  color565        & 0x1F;   /* 5bit */

    /* 等待 TXE */
    while (LCD_SPI->ISR_f.TXE == RESET) {
        if (millis() - time_Start > outtime)
            return 1;
    }

#ifndef LIB_OTHER_USER
    SPI_ITConfig(LCD_SPI, SPI_IT_TXE, DISABLE);
    SPI_BusTakeLCD();
    LCD_SPI->ICR_f.FLUSH = 0;   /* 写 0 = 清空发送缓冲+移位寄存器, 清完 TXE=1 (R1W0) */
    LCD_SPI->CR1_f.WIDTH = 0x0F;   /* 16bit 输出 */
#endif

    /* 行游标: 镜像时每行从右往左读 */
    const uint8_t *rowbase = pData;
    uint32_t col = 0;
    const uint8_t *src = (mirror) ? (rowbase + (w - 1)) : rowbase;

    /* 8bit 灰度 → RGB565 满量程映射 (白灰度=原色, 黑=0)。
     * 每像素 3 次乘法在 M0+ 上是 ~20 周期, 一帧 43×59 字模 ×2 个数字就上万次;
     * 改成 256 项查表 (只在颜色变化时重建一次, 512B RAM)。 */
    #define GM_OUT(g) ((uint16_t)((((g)*cr + 128) >> 8) << 11 | \
                                  (((g)*cg + 128) >> 8) << 5  | \
                                   ((g)*cb + 128) >> 8))

    static uint16_t s_grayLut[256];
    static uint16_t s_grayLutColor = 0xFFFFu;
    static uint8_t  s_grayLutValid;

    if ((s_grayLutValid == 0u) || (s_grayLutColor != color565))
    {
        uint32_t i;
        for (i = 0u; i < 256u; i++) s_grayLut[i] = GM_OUT(i);
        s_grayLutColor = color565;
        s_grayLutValid = 1u;
    }

    /* 首像素: 先发送, 随后在 SPI 忙时预计算下一像素颜色 */
    uint32_t g = *src;
    uint16_t out = s_grayLut[g];
    LCD_SPI->DR = out;
    if (mirror) src--; else src++;
    col++;
    if (--total == 0) goto done;

    while (total > 0U)
    {
        /* 行尾换行 */
        if (col == w) {
            col = 0;
            rowbase += w;
            src = (mirror) ? (rowbase + w - 1) : rowbase;
        }

        /* 在 TXE 判定前预计算下一像素颜色 (SPI 忙时) */
        g = *src;
        out = s_grayLut[g];
        if (mirror) src--; else src++;
        col++;

        /* 等待上一像素发完。
         * ！这里**不能**每像素调 millis() 做超时 (原来是 time_Start=millis() + 循环里
         *   millis() 各一次): 96MHz 下 2 次 millis() ≈ 1.6µs, 比 16bit 像素本身
         *   (0.33µs @48MHz) 还贵 —— 43×59 字模的 LCD 段实测 4.6ms 主要就是它。
         *   改成计数兜底: 200000 次空转 ≈ 数 ms, 语义等价, 每次发送成功后重置。 */
        {
            uint32_t guard = 200000u;
            while (LCD_SPI->ISR_f.TXE == RESET) {
                if (--guard == 0u) { SPI_BusRelease(); return 1; }
            }
        }
        LCD_SPI->DR = out;
        if (--total == 0) break;
    }

done:
    if (SPI_WhileTXE(outtime)) {
        SPI_BusRelease();
        return 1;
    }
    SPI_BusRelease();
    return 0;
}

uint8_t SPI_TransmitU16(uint8_t* pData,uint16_t SizeU16,uint32_t outtime)
{
  assert_param(IS_NONZERO_PARAM(SizeU16));
  assert_param(IS_NONZERO_PARAM(pData));
  assert_param(IS_NONZERO_PARAM(outtime));
  
  uint32_t time_Start = millis();
  uint16_t *txData = (uint16_t *)pData;
  
  while((LCD_SPI->ISR_f.TXE) == RESET){
    if(millis() - time_Start > outtime)
    {
      SPI_BusRelease();
      return 1;
    }
  }

#ifndef LIB_OTHER_USER
  SPI_ITConfig(LCD_SPI, SPI_IT_TXE, DISABLE);
  SPI_BusTakeLCD();
  LCD_SPI->ICR_f.FLUSH = 0;   /* 写 0 = 清空发送缓冲+移位寄存器, 清完 TXE=1 (R1W0) */
  
  //if(LCD_SPI->CR1_f.WIDTH != 0x0F)
  {
    LCD_SPI->CR1_f.WIDTH = 0x0F;
  }
#endif
  
  LCD_SPI->DR = *txData;

  if(--SizeU16) {
    time_Start = millis();
    txData ++;
  }
  
  /* 同上: 轮询里不再调 millis() (每字节一次差不多要 0.8µs), 用计数兜底超时 */
  {
    uint32_t guard = 200000u;
    while (SizeU16 > 0U)
    {
      if(LCD_SPI->ISR_f.TXE)
      {
        LCD_SPI->DR = *txData;
        txData ++;
        SizeU16--;
        guard = 200000u;
      }else if(--guard == 0u)
      {
        //OUTTIME
        SPI_BusRelease();
        return 1;
      }
    }
  }
  
    if(SPI_WhileTXE(outtime))
    {
      SPI_BusRelease();
      return 1;
    }
    SPI_BusRelease();
  return 0;
}


uint8_t SPI_Fill_Transmit(uint16_t Data, uint16_t SizeU16)
{
  assert_param(IS_NONZERO_PARAM(SizeU16));
  
  uint32_t outtime = 2000UL*SizeU16;
  uint32_t time_Start = millis();
  uint16_t pxColor = Data;
  
#ifndef LIB_OTHER_USER
  while((LCD_SPI->ISR_f.TXE) == RESET){
    if(millis() - time_Start > outtime)
    {
      SPI_BusRelease();
      return 1;
    }
  }
  
  SPI_ITConfig(LCD_SPI, SPI_IT_TXE, DISABLE);
  SPI_BusTakeLCD();
  LCD_SPI->ICR_f.FLUSH = 0;   /* 写 0 = 清空发送缓冲+移位寄存器, 清完 TXE=1 (R1W0) */
  
  LCD_SPI->DR = Data;      /* 首个像素 */
  SizeU16--;               /* 修复: 原实现首像素 + SizeU16 次循环 = 多写 1 个像素 */
#endif

  while (SizeU16 > 0U)
  {
    if(LCD_SPI->ISR_f.TXE)
    {
      LCD_SPI->DR = pxColor;
      SizeU16--;
    }else if(millis() - time_Start > outtime)
    {
      //OUTTIME
      SPI_BusRelease();
      return 1;
    }
  }
  
  return 0;
}

uint8_t SPI_PicColor_Transmit(uint8_t *pData, uint16_t SizeU16, uint16_t color)
{
  assert_param(IS_NONZERO_PARAM(SizeU16));
  assert_param(IS_NONZERO_PARAM(pData));
  
  // 定义RGB565解码宏
  #define R565(rgb)  (((rgb) >> 11) & 0x1F)
  #define G565(rgb)  (((rgb) >> 5) & 0x3F)
  #define B565(rgb)  ((rgb) & 0x1F)

  #define ZR565(rgb)   (((rgb) >> 3) & 0x1F)
  #define ZG565(rgb)   ((((rgb) <<3)&0x38)|(((rgb) >> 13)&0x07))
  #define ZB565(rgb)   ((rgb>>8) & 0x1F)
    
  // 定义RGB565编码宏
  #define RGB565(r, g, b)  ((((r) & 0x1F) << 11) | (((g) & 0x3F) << 5) | ((b) & 0x1F))

  uint16_t px;
  uint16_t pxcolor;
  uint32_t time_Start = millis();
  uint32_t outtime = 1000*SizeU16;
  
  px = *((uint16_t *)pData);
  pxcolor = RGB565(R565(px) * R565(color) >> 5, G565(px) * G565(color) >> 6, B565(px) * B565(color) >> 5);
  
  while((LCD_SPI->ISR_f.TXE) == RESET){
    if(millis() - time_Start > outtime)
    {
      SPI_BusRelease();
      return 1;
    }
  }
  
  #ifndef LIB_OTHER_USER
  SPI_ITConfig(LCD_SPI, SPI_IT_TXE, DISABLE);
  //if(LCD_SPI->CR1_f.WIDTH != 0x0F)
  {
    LCD_SPI->CR1_f.WIDTH = 0x0F;
  }
  #endif
  
  LCD_SPI->DR = pxcolor;
  
  if(--SizeU16) {
    px++;
    pxcolor = RGB565(R565(px) * R565(color) >> 5, G565(px) * G565(color) >> 6, B565(px) * B565(color) >> 5);
  }
  
  while(SizeU16 > 0U)
  {
    if(LCD_SPI->ISR_f.TXE)
    {
      LCD_SPI->DR = pxcolor;
      px++;
      pxcolor = RGB565(R565(px) * R565(color) >> 5, G565(px) * G565(color) >> 6, B565(px) * B565(color) >> 5);
      SizeU16--;
    }else if(millis() - time_Start > outtime)
    {
      //OUTTIME
      SPI_BusRelease();
      return 1;
    }
  }
  
  
    while((LCD_SPI->ISR_f.TXE) == RESET){
      if(millis() - time_Start > outtime)
      {
        SPI_BusRelease();
        return 1;
      }
    }
    time_Start = millis();
    while(millis() - time_Start>0);
    SPI_BusRelease();
  return 0;
}


/* 本驱动全部为**纯查询 (polling)** 收发, 不开 SPI 中断:
 * SPI1_IRQHandler 由 USER/src/interrupts_cw32l011.c 提供 (工程自有的中断向量文件),
 * 本文件**不再**定义它 (否则 L6200E: Symbol SPI1_IRQHandler multiply defined)。 */
void SPI_Configuration(void)
{
    __SYSCTRL_SPI_CLK_ENABLE();

    /* 示例 网表 (LCD 与 W25Q 共用 SPI1, 引脚来自 PCBA/bsp_gpio.h 导出物):
     *   PB03 = LCD_SCL / W25_CLK   → SPI1_SCK  (AF3)
     *   PB04 = W25_MISO            → SPI1_MISO (AF3)
     *   PB05 = LCD_SDA / W25_MOSI  → SPI1_MOSI (AF3)
     * 这三个引脚的 AF3 已由 GPIO_Configuration() 按网表配好 (bsp_gpio.c),
     * 这里绝不能再调 PA05_AFx_SPI1SCK() 之类的旧引脚配置 ——
     * PA05 现在是 W25_WP, 配成 AF 会让写保护信号跟着 SPI 时钟乱跳。
     * 片选/DC/RST/背光/HOLD/WP 都是普通 IO:
     *   PA04=W25_CS / PA05=W25_WP / PA06=COMP_V / PA07=PWR_EN / PA08=MOTOR_P
     *   PA09=MOTOR_N / PA15=PAUSE / PB06=LCD_RESET / PB07=LCD_CS
     *   PC13=LCD_RS(DC) / PC14=LCD_BL / PC15=W25_HOLD */

    SPI_InitTypeDef SPI_InitStructure = {0};

    /* 两线全双工主机: W25Q 读需要 RX; LCD 写只发不听, 收到的字节直接丢弃。
     * 全双工下 HDOE 必须为 0 (半双工输出使能), 否则 MISO 收不到 W25Q 数据。 */
    SPI_InitStructure.SPI_Direction = SPI_Direction_2Lines_FullDuplex;    // 全双工
    SPI_InitStructure.SPI_Mode = SPI_Mode_Master;                         // 主机模式
    SPI_InitStructure.SPI_DataSize = SPI_DataSize_8b;                     // 帧数据长度为8bit
    SPI_InitStructure.SPI_CPOL = SPI_CPOL_Low;                            // 时钟空闲电平为低
    SPI_InitStructure.SPI_CPHA = SPI_CPHA_1Edge;                          // 第一个边沿采样
    SPI_InitStructure.SPI_NSS = SPI_NSS_Soft;                             // 片选信号由SSI寄存器控制
    /* PCLK = 96MHz (HSI 96MHz, PCLK_DIV1): _2 = 48MHz (2026-10-20 应用户要求提速)。
     * GC9A01 的 SPI 上限通常 >=100MHz, W25Q32 为 104MHz; 48MHz 在器件规格内,
     * 但共用 SPI + 飞线/排线的边沿质量决定实际能不能跑:
     *   - 若出现雪花 / W25Q 读错 / 偶发花屏, 先降回 _4 (24MHz) 验证;
     *   - 外部字库/掩膜读失败会累加到 g_dbgExtGrayErr / g_dbgExtRgbErr。 */
    SPI_InitStructure.SPI_BaudRatePrescaler = SPI_BaudRatePrescaler_2;
    SPI_InitStructure.SPI_FirstBit = SPI_FirstBit_MSB;                    // 最高有效位 MSB 收发在前
    SPI_InitStructure.SPI_Speed = SPI_Speed_High;

    /* 初始化前两个片选都放开 (都不选中), HOLD 释放 */
    LCD_CS(1);
    W25Q_CS(1);
    W25Q_HOLD(1);

    LCD_SPI->CR3_f.HDOE = 0;   // 全双工: 关闭半双工输出使能, 保留 MISO 输入
    SPI_Init(LCD_SPI, &SPI_InitStructure);
    SPI_Cmd(LCD_SPI, ENABLE);
}
