#include "bsp_gc9a01.h"
#include "bsp_gpio.h"
#include "bsp_w25q.h"

/* 1 = 把 HOLD 流式读的"第二块"抓到 g_w25qCap, 流结束后正常读同地址对拍。
 * 量产默认 0 (每个字模会多一次正常读); 现场诊断时改 1 + tools/w25q_hold_check.py。 */
#define W25Q_CAPTURE_TEST  0

/* 调试遥测 (SWD 读): 外部 W25Q 素材实际走到的次数 / 读失败次数。
 * g_dbgExtGrayDraw 应该在页 0 进页后 = 3 (F/R 两个灰度帧) + 数字重画次数;
 * g_dbgExtRgbDraw = 1 (电池图标); 两个 Err 都应为 0。 */
volatile uint32_t g_dbgExtGrayDraw;
volatile uint32_t g_dbgExtGrayErr;
volatile uint32_t g_dbgExtRgbDraw;
volatile uint32_t g_dbgExtRgbErr;

/* 调试遥测 (SWD 读): LCD_Fill 被 SPI 超时截断的次数 (见 LCD_Fill)。
 * 清屏失败/花屏定位时先看这个: 非 0 = 像素没发完, 屏上剩下的就是旧内容。 */
volatile uint32_t g_dbgLcdFillIo;

void HAL_Delay(uint32_t ms)
{
    while (ms > 150) {
        HAL_Delay(150);
        ms -= 150;
    }
    /* HCLK 固定 96MHz: 写常量, 避免 SystemCoreClock/1000 的变量除法 */
    SysTick->LOAD = ms * (96000000UL / 1000UL) - 1; // 1us 的 tick 数量
    SysTick->VAL = 0;  // 清零当前值
    SysTick->CTRL = SysTick_CTRL_ENABLE_Msk|SysTick_CTRL_CLKSOURCE_Msk; // 启用 SysTick，无中断

    while ((SysTick->CTRL & SysTick_CTRL_COUNTFLAG_Msk) == 0)
    {
        // 等待溢出
    }

    SysTick->CTRL = 0; // 关闭 SysTick
}

void LCD_WriteCommand(uint8_t cmd);
void LCD_WriteData(uint8_t dat);
void LCD_WirtHalfData(uint16_t halfdat);
void LCD_WaitSendFinish(uint8_t nextDC);

uint16_t hsv2rgb(float h, float s, float v)
{
  uint8_t r, g, b;

  if(s == 0)
  {
    r = g = b = v;
  }
  else
  {
    float H = h / 60.0f;
    uint8_t hi = (int)H;
    float f = H - hi;
    float p = v * (1 - s);
    float q = v * (1 - f * s);
    float t = v * (1 - (1 - f) * s);

    switch(hi)
    {
    case 0:
      r = (uint8_t)(v * 255.0f + 0.5f);
      g = (uint8_t)(t * 255.0f + 0.5f);
      b = (uint8_t)(p * 255.0f + 0.5f);
      break;

    case 1:
      r = (uint8_t)(q * 255.0f + 0.5f);
      g = (uint8_t)(v * 255.0f + 0.5f);
      b = (uint8_t)(p * 255.0f + 0.5f);
      break;

    case 2:
      r = (uint8_t)(p * 255.0f + 0.5f);
      g = (uint8_t)(v * 255.0f + 0.5f);
      b = (uint8_t)(t * 255.0f + 0.5f);
      break;

    case 3:
      r = (uint8_t)(p * 255.0f + 0.5f);
      g = (uint8_t)(q * 255.0f + 0.5f);
      b = (uint8_t)(v * 255.0f + 0.5f);
      break;

    case 4:
      r = (uint8_t)(t * 255.0f + 0.5f);
      g = (uint8_t)(p * 255.0f + 0.5f);
      b = (uint8_t)(v * 255.0f + 0.5f);
      break;

    case 5:
      r = (uint8_t)(v * 255.0f + 0.5f);
      g = (uint8_t)(p * 255.0f + 0.5f);
      b = (uint8_t)(q * 255.0f + 0.5f);
      break;

    default:
      break;
    }
  }

  return RGB888((uint16_t)r, (uint16_t)g, (uint16_t)b);
}



#define  USE_HORIZONTAL 0

/* LCD 地址窗口缓存：同位置重绘时跳过 CASET/RASET 命令序列 */
static uint8_t  addrCacheValid = 0;
static uint8_t  cache_x1, cache_y1, cache_x2, cache_y2;

void LCD144_Sleep(void)
{
  SPI_BusRelease();
  busy = 1;
  LCD_4W(1);
  SPI_BusTakeLCD();

  LCD_WriteCommand(0x10); //Sleep
  LCD_WaitSendFinish(2);
  addrCacheValid = 0;     // 休眠后地址窗口状态未知
  /* 送完 sleep-in 就把总线还给 W25Q (LCD_CS 抬回高): 否则 MCU 进深度睡眠后
   * LCD_CS 一直是低, 屏虽然睡着但片选仍被占; 唤醒时 DSP_Tick() 走 LCD_Wake()。
   * 不等 120ms: 面板 VDD 一直有电, 它自己会用 ~120ms 完成"显示清空 → 泄放
   * 电荷 → 停 DC/DC / 停振荡器", 我们这段时间不发任何 LCD 命令 (datasheet 6.2.3
   * 只要求 SLPIN 后 5ms 内别再发命令, 且 SLPIN → SLPOUT 间隔 ≥120ms —— 深睡
   * 5.5s 远大于它)。 */
  SPI_BusRelease();
  busy = 0;
}

/* 面板寄存器初始化序列 (不含硬复位 / SLPOUT / DISPON)。
 * 冷启动和 SLPIN 唤醒共用: datasheet 6.2.3 明确睡眠时 "MCU interface and memory
 * are still working", 所以睡着也能先把寄存器写回, 再发 0x11 退出睡眠。 */
static void LCD144_WriteInitRegs(void)
{
  /*---------------------- GC9A01 复位/解锁扩展寄存器 ----------------------*/
  LCD_WriteCommand(0xEF);
  LCD_WriteCommand(0xEB);
  LCD_WriteData(0x14);

  LCD_WriteCommand(0xFE);
  LCD_WriteCommand(0xEF);

  LCD_WriteCommand(0xEB);
  LCD_WriteData(0x14);

  LCD_WriteCommand(0x84);
  LCD_WriteData(0x40);

  LCD_WriteCommand(0x85);
  LCD_WriteData(0xFF);

  LCD_WriteCommand(0x86);
  LCD_WriteData(0xFF);

  LCD_WriteCommand(0x87);
  LCD_WriteData(0xFF);

  LCD_WriteCommand(0x88);
  LCD_WriteData(0x0A);

  LCD_WriteCommand(0x89);
  LCD_WriteData(0x21);

  LCD_WriteCommand(0x8A);
  LCD_WriteData(0x00);

  LCD_WriteCommand(0x8B);
  LCD_WriteData(0x80);

  LCD_WriteCommand(0x8C);
  LCD_WriteData(0x01);

  LCD_WriteCommand(0x8D);
  LCD_WriteData(0x01);

  LCD_WriteCommand(0x8E);
  LCD_WriteData(0xFF);

  LCD_WriteCommand(0x8F);
  LCD_WriteData(0xFF);

  /*---------------------- 显示方向/格式 ----------------------*/
  LCD_WriteCommand(0xB6);
  LCD_WriteData(0x00);
  LCD_WriteData(0x20);

  LCD_WriteCommand(0x36); //MADCTL
  if(USE_HORIZONTAL==0)LCD_WriteData(0x08);
  else if(USE_HORIZONTAL==1)LCD_WriteData(0xC8);
  else if(USE_HORIZONTAL==2)LCD_WriteData(0x68);
  else LCD_WriteData(0xA8);

  LCD_WriteCommand(0x3A); //65k mode
  LCD_WriteData(0x05);

  LCD_WriteCommand(0x90);
  LCD_WriteData(0x08);
  LCD_WriteData(0x08);
  LCD_WriteData(0x08);
  LCD_WriteData(0x08);

  LCD_WriteCommand(0xBD);
  LCD_WriteData(0x06);

  LCD_WriteCommand(0xBC);
  LCD_WriteData(0x00);

  LCD_WriteCommand(0xFF);
  LCD_WriteData(0x60);
  LCD_WriteData(0x01);
  LCD_WriteData(0x04);

  LCD_WriteCommand(0xC3);
  LCD_WriteData(0x13);
  LCD_WriteCommand(0xC4);
  LCD_WriteData(0x13);

  LCD_WriteCommand(0xC9);
  LCD_WriteData(0x22);

  LCD_WriteCommand(0xBE);
  LCD_WriteData(0x11);

  LCD_WriteCommand(0xE1);
  LCD_WriteData(0x10);
  LCD_WriteData(0x0E);

  LCD_WriteCommand(0xDF);
  LCD_WriteData(0x21);
  LCD_WriteData(0x0c);
  LCD_WriteData(0x02);

  /*---------------------- Gamma ----------------------*/
  LCD_WriteCommand(0xF0);
  LCD_WriteData(0x45);
  LCD_WriteData(0x09);
  LCD_WriteData(0x08);
  LCD_WriteData(0x08);
  LCD_WriteData(0x26);
  LCD_WriteData(0x2A);

  LCD_WriteCommand(0xF1);
  LCD_WriteData(0x43);
  LCD_WriteData(0x70);
  LCD_WriteData(0x72);
  LCD_WriteData(0x36);
  LCD_WriteData(0x37);
  LCD_WriteData(0x6F);

  LCD_WriteCommand(0xF2);
  LCD_WriteData(0x45);
  LCD_WriteData(0x09);
  LCD_WriteData(0x08);
  LCD_WriteData(0x08);
  LCD_WriteData(0x26);
  LCD_WriteData(0x2A);

  LCD_WriteCommand(0xF3);
  LCD_WriteData(0x43);
  LCD_WriteData(0x70);
  LCD_WriteData(0x72);
  LCD_WriteData(0x36);
  LCD_WriteData(0x37);
  LCD_WriteData(0x6F);

  LCD_WriteCommand(0xED);
  LCD_WriteData(0x1B);
  LCD_WriteData(0x0B);

  LCD_WriteCommand(0xAE);
  LCD_WriteData(0x77);

  LCD_WriteCommand(0xCD);
  LCD_WriteData(0x63);

  LCD_WriteCommand(0x70);
  LCD_WriteData(0x07);
  LCD_WriteData(0x07);
  LCD_WriteData(0x04);
  LCD_WriteData(0x0E);
  LCD_WriteData(0x0F);
  LCD_WriteData(0x09);
  LCD_WriteData(0x07);
  LCD_WriteData(0x08);
  LCD_WriteData(0x03);

  LCD_WriteCommand(0xE8);
  LCD_WriteData(0x34); //4 dot inversion

  LCD_WriteCommand(0x62);
  LCD_WriteData(0x18);
  LCD_WriteData(0x0D);
  LCD_WriteData(0x71);
  LCD_WriteData(0xED);
  LCD_WriteData(0x70);
  LCD_WriteData(0x70);
  LCD_WriteData(0x18);
  LCD_WriteData(0x0F);
  LCD_WriteData(0x71);
  LCD_WriteData(0xEF);
  LCD_WriteData(0x70);
  LCD_WriteData(0x70);

  LCD_WriteCommand(0x63);
  LCD_WriteData(0x18);
  LCD_WriteData(0x11);
  LCD_WriteData(0x71);
  LCD_WriteData(0xF1);
  LCD_WriteData(0x70);
  LCD_WriteData(0x70);
  LCD_WriteData(0x18);
  LCD_WriteData(0x13);
  LCD_WriteData(0x71);
  LCD_WriteData(0xF3);
  LCD_WriteData(0x70);
  LCD_WriteData(0x70);

  LCD_WriteCommand(0x64);
  LCD_WriteData(0x28);
  LCD_WriteData(0x29);
  LCD_WriteData(0xF1);
  LCD_WriteData(0x01);
  LCD_WriteData(0xF1);
  LCD_WriteData(0x00);
  LCD_WriteData(0x07);

  LCD_WriteCommand(0x66);
  LCD_WriteData(0x3C);
  LCD_WriteData(0x00);
  LCD_WriteData(0xCD);
  LCD_WriteData(0x67);
  LCD_WriteData(0x45);
  LCD_WriteData(0x45);
  LCD_WriteData(0x10);
  LCD_WriteData(0x00);
  LCD_WriteData(0x00);
  LCD_WriteData(0x00);

  LCD_WriteCommand(0x67);
  LCD_WriteData(0x00);
  LCD_WriteData(0x3C);
  LCD_WriteData(0x00);
  LCD_WriteData(0x00);
  LCD_WriteData(0x00);
  LCD_WriteData(0x01);
  LCD_WriteData(0x54);
  LCD_WriteData(0x10);
  LCD_WriteData(0x32);
  LCD_WriteData(0x98);

  LCD_WriteCommand(0x74);
  LCD_WriteData(0x10);
  LCD_WriteData(0x85);
  LCD_WriteData(0x80);
  LCD_WriteData(0x00);
  LCD_WriteData(0x00);
  LCD_WriteData(0x4E);
  LCD_WriteData(0x00);

  LCD_WriteCommand(0x98);
  LCD_WriteData(0x3e);
  LCD_WriteData(0x07);

  LCD_WriteCommand(0x35); //Tearing Effect Line ON
  LCD_WriteCommand(0x21); //Display Inversion ON
}

/* 冷启动 (电池上电 / 面板掉过电): 硬复位 + 寄存器 + SLPOUT。
 * **不含 DISPON (0x29)**: 面板一上电 GRAM 是随机值, 先让输出保持关断, 等
 * LCD_Init() 全屏清完再 LCD144_DisplayOn() —— 否则 0x29 一开就是满屏雪花,
 * 背光若还是亮的 (MCU 复位时 BL 脚悬空/上次状态) 那 20ms 会被人看见。 */
void LCD144_Init(void)
{
  busy = 1;
  LCD_4W(1);
  SPI_BusRelease();
  CW_SPI->CR1_f.WIDTH = 0x07;

  /* 硬复位: 低 20ms → 放高 120ms。
   * 旧写法只在 ODR=0 时补一次高电平: MCU 复位/重烧时 RST 可能一直是高
   * (外部上拉或上一次运行遗留), 面板根本没被复位, 扩展寄存器还停在旧状态,
   * 重新初始化就可能花屏/花点。 */
  LCD_RST(0);
  HAL_Delay(20);
  LCD_RST(1);
  HAL_Delay(120);

  LCD144_WriteInitRegs();

  LCD_WriteCommand(0x11); //Sleep out
  HAL_Delay(120);         /* 冷启动保守值: 等 DC/DC 与 VGH/VGL 建立 */

  LCD_WaitSendFinish(2);
  busy = 0;
}

/* 打开显示输出。必须在整屏清完之后调用 (见 LCD144_Init 的注释):
 * 顺序 = 复位 → 寄存器 → SLPOUT → 清 GRAM → DISPON, 任何一帧随机 GRAM
 * 都不会被显示出来。 */
void LCD144_DisplayOn(void)
{
  LCD_WriteCommand(0x29); //Display on
  HAL_Delay(20);
  LCD_WaitSendFinish(2);
}

/* 深度休眠唤醒 (面板 VDD 一直有电, 睡前只发过 0x10 SLPIN, GRAM 保留):
 * 不硬复位、不整屏清, 只把寄存器写回 + SLPOUT + DISPON。
 * 用时 ≈ 25ms —— 原路径走 LCD_Init 是 20+120(复位) + 120(SLPOUT) ≈ 300ms。
 * datasheet 6.2.4: SLPOUT 之后 5ms 就能发下一条命令 (那 120ms 是
 * "SLPIN 之后至少等 120ms 才能发 SLPOUT", 不是唤醒等待)。 */
void LCD144_WakeUp(void)
{
  busy = 1;
  LCD_4W(1);
  SPI_BusRelease();
  CW_SPI->CR1_f.WIDTH = 0x07;

  LCD144_WriteInitRegs();   /* SLPIN 中接口/寄存器仍可写 (datasheet 6.2.3) */

  LCD_WriteCommand(0x11); //Sleep out
  HAL_Delay(5);           /* datasheet 下限 */
  LCD_WriteCommand(0x29); //Display on
  HAL_Delay(20);          /* 起振 + 2 帧空白, 留余量 */

  LCD_WaitSendFinish(2);
  busy = 0;
}


/******************************************************************************
      函数说明：设置起始和结束地址
      入口数据：x1,x2 设置列的起始和结束地址
                y1,y2 设置行的起始和结束地址
      返回值：  无
      注意：GC9A01 为 240x240，CASET/RASET 使用 16bit 坐标（高字节在前）
******************************************************************************/
void LCD_Address_Set(uint8_t x1,uint8_t y1,uint8_t x2,uint8_t y2)
{
  /* 地址缓存：同边界跳过 CASET/RASET，但仍需发送 RAMWR */
  if (!(addrCacheValid && cache_x1 == x1 && cache_y1 == y1
                     && cache_x2 == x2 && cache_y2 == y2))
  {

  cache_x1 = x1; cache_y1 = y1; cache_x2 = x2; cache_y2 = y2;
  addrCacheValid = 1;

  uint8_t pox[8];
  pox[0] = x1 >> 8; pox[1] = x1 & 0xFF;
  pox[2] = x2 >> 8; pox[3] = x2 & 0xFF;
  pox[4] = y1 >> 8; pox[5] = y1 & 0xFF;
  pox[6] = y2 >> 8; pox[7] = y2 & 0xFF;

  uint8_t pXcmd=0x2a;
  uint8_t pYcmd=0x2b;
  LCD_WaitSendFinish(0);//等待完成后写DC=0
  CW_SPI->CR1_f.WIDTH = 0x07;
  SPI_TransmitU8(&pXcmd, 1, 1000);

  LCD_WaitSendFinish(1);
  SPI_TransmitU8(pox,4,4000);

  LCD_WaitSendFinish(0);//等待完成后写DC=0
  SPI_TransmitU8(&pYcmd, 1, 1000);

  LCD_WaitSendFinish(1);
  SPI_TransmitU8(pox+4,4,4000);

  }
  LCD_WaitSendFinish(0);//等待完成后写DC=0
  LCD_WriteCommand(0x2c);//储存器写

  LCD_WaitSendFinish(1);

}


__inline void LCD_WriteCommand(uint8_t cmd)
{
  SPI_TransmitDC(cmd, 0, 1000);
}

__inline void LCD_WriteData(uint8_t dat)
{
  SPI_TransmitDC(dat, 1, 1000);
}

void LCD_WaitSendFinish(uint8_t nextDC)
{
  uint32_t time_Start = millis();
  uint32_t outtime = 1000;
  while((CW_SPI->ISR_f.TXE) == RESET){
    if(millis() - time_Start > outtime)
    {
      CW_SPI->SSI=(1);
      return;
    }
  }

  if(nextDC == 0)
  {
    LCD_DC(0); //COMM
    SPI_BusTakeLCD(); //片选
  }else if(nextDC == 1)
  {
    LCD_DC(1); //DATA
    SPI_BusTakeLCD(); //片选
  }else if(nextDC == 2)
  {
    SPI_BusRelease();
  }
}

/* 跨文件调用：使地址窗口缓存失效（休眠/断电/全屏填充后） */
void LCD_AddrCacheFlush(void)
{
    addrCacheValid = 0;
}

/* 热路径专用：轻量 DC 切换（TXE 已知就绪，仅自旋计数器兜底） */
static __inline void LCD_WaitDC_Fast(uint8_t nextDC)
{
    uint32_t spin = 4000;
    while (CW_SPI->ISR_f.TXE == RESET && --spin);
    if (nextDC == 0)      { LCD_DC(0); SPI_BusTakeLCD(); }
    else if (nextDC == 1) { LCD_DC(1); SPI_BusTakeLCD(); }
    else                  { SPI_BusRelease(); }
}


uint8_t pox[8];
uint8_t cmdX = 0x2A;
uint8_t cmdY = 0x2B;
uint8_t memWrite = 0x2C;
// 极简优化单点绘制，数据提前准备
uint8_t LCD_drawPx(uint8_t x, uint8_t y, uint16_t color)
{
    busy = 1;
    addrCacheValid = 0;   // 单点绘制改变地址窗口，缓存立即失效
    // GC9A01 240x240 无偏移，CASET/RASET 16bit 坐标
    pox[0] = x >> 8; pox[1] = x & 0xFF;
    pox[2] = x >> 8; pox[3] = x & 0xFF;
    pox[4] = y >> 8; pox[5] = y & 0xFF;
    pox[6] = y >> 8; pox[7] = y & 0xFF;

    // 发送 X 地址
    SPI_TransmitDC(cmdX,0,1000);

    LCD_WaitDC_Fast(1);
    SPI_TransmitU8(pox, 4, 4000);

    // 发送 Y 地址
    LCD_WaitDC_Fast(0);
    SPI_TransmitU8(&cmdY, 1, 1000);

    LCD_WaitDC_Fast(1);
    SPI_TransmitU8(pox+4, 4, 4000);

    // 存储器写命令
    LCD_WaitDC_Fast(0);
    SPI_TransmitU8(&memWrite, 1, 1000);

    // 发送像素数据
    LCD_WaitDC_Fast(1);
    SPI_TransmitU8((uint8_t*)&color, 2, 4000);
    busy = 0;
    return 0;
}

/* 水平连续 n 像素: 一次地址窗口写完, 省掉每像素的 CASET/RASET 开销。
 * color565 为逻辑 RGB565 (与 LCD_Fill 一致, 内部按屏字节序发送, 调用方无需交换)。
 * n=1 时等价于 LCD_drawPx。 */
uint8_t LCD_drawPxRun(uint8_t x, uint8_t y, uint8_t n, uint16_t color565)
{
    if (n == 0 || x >= LCD_W) return 1;
    if ((int)x + n > LCD_W) n = (uint8_t)(LCD_W - x);   /* 越界裁剪, 不能整条丢弃 */
    return LCD_Fill(x, y, (uint8_t)(x + n), (uint8_t)(y + 1), color565);
}


/* ============================================================
 *  圆环逐点渲染专用通路 —— 与旧 LCD_xxx 完全隔离
 *    LCD_RingBegin()   整帧独占 (busy=1), 期间旧 LCD_xxx 全部返回 1
 *    LCD_RingPx(x,y,c) 写一个像素 (1x1 窗口), color565 = 逻辑 RGB565
 *    LCD_RingEnd()     释放, 并让旧地址缓存失效
 *
 *  只影响圆环, 旧代码一行没动。与旧通路的两点差别:
 *   1. 每次切 DC/CS 前等 TXE=1 且 BUSY=0 —— SPI 手册明确要求, 否则末字节
 *      被截断 (屏幕上就是一个个错色点/残留点);
 *   2. 1x1 窗口逐点写: 宽窗口批量写会被面板行扫描读到半写状态 → 横向扫描纹。
 * ============================================================ */
/* 等 TXE=1 且 BUSY=0 (手册: 两个都满足才算发送完毕); 计数器兜底防死等 */
static void lcd_ring_flush(void)
{
    uint32_t guard = 0;
    while((CW_SPI->ISR_f.TXE) == RESET) {
        if(++guard > 20000u) return;
    }
    guard = 0;
    while((CW_SPI->ISR_f.BUSY) != RESET) {
        if(++guard > 20000u) return;
    }
}

void LCD_RingBegin(void)
{
    busy = 1;                /* 占住 LCD */
    addrCacheValid = 0;      /* 圆环自己改窗口, 旧缓存作废 */
}

void LCD_RingEnd(void)
{
    lcd_ring_flush();
    SPI_BusRelease();
    addrCacheValid = 0;      /* 交回旧通路时重新发地址 */
    busy = 0;
}

/* 写一行连续 n 个像素 (一次窗口, n 个 16bit): 圆环两阶段出图的"写屏"阶段用。
 * 一次事务写完一整段, 出图时间从 ~8ms 压到 ~1ms, 面板扫描追不上 → 不再剪切。 */
uint8_t LCD_RingRun(uint16_t x, uint16_t y, uint8_t n, const uint16_t* px)
{
    uint8_t pox[8];
    uint16_t xe = (uint16_t)(x + n - 1);
    if (n == 0) return 1;
    /* 16 位坐标拆高低字节 (x,y ≤ 255 时与老写法完全相同 → 240×240 圆屏逐字节不变) */
    pox[0] = (uint8_t)(x >> 8);  pox[1] = (uint8_t)x;
    pox[2] = (uint8_t)(xe >> 8); pox[3] = (uint8_t)xe;
    pox[4] = (uint8_t)(y >> 8);  pox[5] = (uint8_t)y;
    pox[6] = 0;                  pox[7] = (uint8_t)y;

    lcd_ring_flush();
    LCD_WriteCommand(0x2a);                 /* CASET */
    lcd_ring_flush();
    LCD_DC(1); SPI_BusTakeLCD();
    SPI_TransmitU8(pox, 4, 4000);

    lcd_ring_flush();
    LCD_WriteCommand(0x2b);                 /* RASET */
    lcd_ring_flush();
    LCD_DC(1); SPI_BusTakeLCD();
    SPI_TransmitU8(pox + 4, 4, 4000);

    lcd_ring_flush();
    LCD_WriteCommand(0x2c);                 /* RAMWR */
    lcd_ring_flush();
    LCD_DC(1); SPI_BusTakeLCD();
    CW_SPI->CR1_f.WIDTH = 0x0F;
    SPI_TransmitU16((uint8_t*)px, (uint16_t)n, 30000);
    lcd_ring_flush();                       /* 等整段真正发完再放 CS */
    SPI_BusRelease();
    CW_SPI->CR1_f.WIDTH = 0x07;
    return 0;
}

uint8_t LCD_drawImage(uint8_t x, uint8_t y, uint8_t w, uint8_t h, const void* pic, uint16_t color)
{
  if(busy)
  {
    return 1;
  }
  busy = 1;


  /* 指针区间分派 (三段式):
   *   [0x00000000, 0x00010000]  内部 Flash const (ROM 表) → RAM 直传
   *   (0x00010000, 0x20000000)  W25Q 外部 Flash (基址 0x01000000) → W25Q 读
   *   [0x20000000, ...)         SRAM 缓冲 (如 OTA g_page_buf) → RAM 直传
   * 旧代码仅用 >0x10000 判断, 会把 SRAM 指针误判为 W25Q, 导致预览渲染错乱 */
  #ifdef USE_W25Q
  if((uint32_t)pic > 0x10000 && (uint32_t)pic < 0x20000000)
  {
    if(0xFFFF!= color)
      return LCD_drawImageFromW25Q_Overlap_ColorMul(x,y,w,h,(const uint8_t*)pic,color);
    return LCD_drawImageFromW25Q_Overlap(x,y,w,h,(const uint8_t*)pic);
  }
  #endif

  LCD_Address_Set(x, y, x+w-1, y+h-1); //设置显示范围
  CW_SPI->CR1_f.WIDTH = 0x0F;
  if(color != 0xFFFF)
    SPI_TransmitU16GrayMultiplyColor((uint8_t*)pic,w*h,color,30000);
  else SPI_TransmitU16((uint8_t*)pic,w*h,30000);
  LCD_WaitSendFinish(2);
  CW_SPI->CR1_f.WIDTH = 0x07;

  busy = 0;
  return 0;
}

/* 8bit 灰度图 × 目标颜色 绘制, 支持左右镜像 (mirror=1 左右翻转) */
uint8_t LCD_drawGrayImage(uint8_t x, uint8_t y, uint8_t w, uint8_t h, const uint8_t* gray, uint16_t color, uint8_t mirror)
{
  if(busy || gray == 0 || w == 0 || h == 0)
  {
    return 1;
  }

  /* 指针区间分派: 外部 W25Q 素材 (0x01000000 段) 不能当 RAM 解引用 ——
   * 走逐行读 Flash + 逐行写屏 (LCD 与 W25Q 共用一条 SPI)。 */
  #ifdef USE_W25Q
  if((uint32_t)gray > 0x10000u && (uint32_t)gray < 0x20000000u)
  {
    return LCD_drawGrayImageFromW25Q(x, y, w, h, gray, color, mirror);
  }
  #endif

  busy = 1;

  LCD_Address_Set(x, y, x+w-1, y+h-1); //设置显示范围
  CW_SPI->CR1_f.WIDTH = 0x0F;
  SPI_TransmitU8GrayMultiplyColorMirror((uint8_t*)gray, w, h, color, mirror, 30000);
  LCD_WaitSendFinish(2);
  CW_SPI->CR1_f.WIDTH = 0x07;

  busy = 0;
  return 0;
}

uint8_t LCD_Fill(uint8_t xsta, uint8_t ysta, uint8_t xend, uint8_t yend, uint16_t color)
{
  uint16_t n;
  uint8_t  rc;

  if(xend <= xsta || yend <= ysta || busy)
  {
    return LCD_IO_BUSY;
  }

  busy = 1;

  n = (uint16_t)((uint16_t)(xend - xsta) * (uint16_t)(yend - ysta));
  LCD_Address_Set(xsta, ysta, (uint8_t)(xend - 1u), (uint8_t)(yend - 1u)); //设置显示范围
  CW_SPI->CR1_f.WIDTH = 0x0F;
  /* ！返回值不能丢 (2026-10-28): SPI 超时 = 只发出一部分像素, 窗口里剩下的
   * 还是面板旧内容。以前这里 (void) 掉, 上电清屏被截断也报"成功", 花屏
   * 永远只能猜。现在把结果原样交给上层 (app_lcd.c 的 LCD_ClearScreen)。 */
  rc = SPI_Fill_Transmit(color, n);

  /* 收尾三件事 —— 原先全缺, 就是"LCD_Fill 之后白屏"的根因:
   *   1) 等最后一个像素真正移出 (TXE 只表示发送缓冲空, BUSY=0 才算发完)。
   *      只等 TXE 就改 WIDTH/DC 的话, 最后一个 16bit 字还在线上, 面板会把
   *      它的尾巴当成命令/参数, 整个命令流错位 → 白屏/花屏;
   *   2) 抬 CS, 让下一次取总线从干净的帧边界开始;
   *   3) 恢复 8bit 帧宽, 否则后续命令会按 16bit 发出去。
   * 顺序不能反: 必须先 BUSY=0 再改 WIDTH。 */
  LCD_WaitSendFinish(2);
  CW_SPI->CR1_f.WIDTH = 0x07;
  busy = 0;

  if (rc != 0u)
  {
    /* 超时: 面板的 GRAM 地址指针停在窗口半路 (不是下一次 CASET/RASET 之后
     * 的已知位置), 地址缓存一律作废, 让下一笔重发窗口, 绝不"从半路接着写"。 */
    LCD_AddrCacheFlush();
    g_dbgLcdFillIo++;
    return LCD_IO_TIMEOUT;
  }
  return LCD_IO_OK;
}


/* 示例: 无 DMA 通路 —— 保留符号 (别处可能引用), 实现成 LCD_Fill 的薄包装 */
uint8_t LCD_Fill_DMA(uint8_t xsta, uint8_t ysta, uint8_t xend, uint8_t yend, uint16_t color)
{
    return LCD_Fill(xsta, ysta, xend, yend, color);
}

#ifdef USE_W25Q

/* ----------------------------------------------------------------------------
 *  外部 Flash 素材的绘制路径 (示例: LCD 与 W25Q 共用一条 SPI)
 *
 *  SpeedTest(CW32L010) 里 LCD 与 W25Q 各占一条 SPI, 所以能"边从 W25Q 读字节、
 *  边往 LCD 写像素"; 这里只有一个 SPI, 不可能交错, 只能逐行两阶段:
 *      ① 取 W25Q 总线, 把一整行 (w*2 字节) 读进 RAM 行缓冲;
 *      ② 释放总线, 取 LCD 总线, 把这一行发进面板。
 *
 *  行缓冲: RGB565 = 2B/px, 最宽 LCD_W=240 → 480B。
 *
 *  地址语义: W25Q_ReadBytes() 的 addr 是**芯片相对偏移** (函数内部会 & W25Q_ADDR_MASK),
 *  不是 0x01000000 起的绝对地址 —— 所以这里先把落在外部 Flash 段里的绝对指针掩成
 *  偏移, 之后按行累加也都在偏移域里算。
 *
 *  字节序: 外部素材里 RGB565 是**小端**存放 (低字节在前, 与 SpeedTest 的字节流一致);
 *  SPI 按 16bit MSB-first 发送, 所以 buf[2i+1] 先上线 —— 缓冲区保持小端,
 *  面板就正好收到"高字节在前"的 RGB565。
 * ---------------------------------------------------------------------------- */
/* 外部 Flash 绘制的中转缓冲: 一次读多行、一次窗口写多行。
 * 480B(1 行 RGB) 时字库 56x76 要 76 次 CASET/RASET + SPI 事务;
 * 1440B 时 56px 宽 = 25 行/次 -> 4 次, 48px RGB = 15 行/次 -> 2 次。
 * 这是 .bss 静态缓冲, 不占 1.5KB 栈; 当前 RAM 余量足够。 */
/* 外部素材"读一块 → 写一块"的分块缓冲。
 * 2026-10-28: 6 行 (1440B) → 10 行 (2400B)。目的: 48px 宽的电池图标
 * 一行 96B, 2400/96 = 25 行 ≥ 24 行 → **整帧一次窗口写完**, 不再分两块,
 * 消除了关机充电页电池图标每次换帧的那条横向撕裂。
 * 代价 +960B RAM, 已把 W25Q_DIAG 的调试缓冲 (848B) 默认关掉抵消。 */
#define LCD_EXT_CHUNK_BYTES  (LCD_W * 10)
/* 非 static: W25Q_DIAG_SHARE_BUF=1 时调试抓取要直接引用它 (见 bsp_w25q.c) */
uint8_t g_lcdRowBuf[LCD_EXT_CHUNK_BYTES];

uint8_t LCD_drawImageFromW25Q_Overlap(uint8_t x, uint8_t y, uint8_t w, uint8_t h, const uint8_t* pic)
{
    uint32_t base;
    uint16_t row, rowBytes, chunkMax;
    uint8_t  recovered = 0;             /* 已做 W25Q 恢复则整帧重试一次 */

    if (w == 0u || h == 0u || w > LCD_W) { busy = 0; return 1; }

    g_dbgExtRgbDraw++;
    base     = ((uint32_t)pic) & W25Q_ADDR_MASK;
    rowBytes = (uint16_t)(w * 2u);
    chunkMax = (uint16_t)(sizeof(g_lcdRowBuf) / rowBytes);
    if (chunkMax == 0u) chunkMax = 1u;

retry:
    for (row = 0u; row < h; row = (uint16_t)(row + chunkMax))
    {
        uint16_t nr = (uint16_t)(h - row);
        if (nr > chunkMax) nr = chunkMax;

        /* ---- 阶段1: 从 W25Q 一次读 nr 行 (共用总线时减少来回切换) ---- */
        SPI_BusTakeW25Q();
        if (W25Q_ReadBytes(base + (uint32_t)row * rowBytes,
                           g_lcdRowBuf, (uint32_t)nr * rowBytes) != 0)
        {
            SPI_BusRelease();
            goto recover;
        }
        SPI_BusRelease();

        /* ---- 阶段2: 一个窗口一次写 nr 行 (减少 CASET/RASET 与撕裂窗口) ---- */
        LCD_Address_Set(x, (uint8_t)(y + row), (uint8_t)(x + w - 1u),
                        (uint8_t)(y + row + nr - 1u));
        CW_SPI->CR1_f.WIDTH = 0x0F;
        SPI_TransmitU16(g_lcdRowBuf, (uint16_t)(w * nr), 30000);
        LCD_WaitSendFinish(2);
        CW_SPI->CR1_f.WIDTH = 0x07;
    }

    busy = 0;
    return 0;

recover: /* 读失败/超时: 软复位 W25Q, 整帧重试一次 (照 SpeedTest 的 recover 思路) */
    SPI_BusRelease();
    CW_SPI->CR1_f.WIDTH = 0x07;
    if (recovered) { g_dbgExtRgbErr++; busy = 0; return 2; }   /* 重试后仍失败 */
    recovered = 1;                          /* 重试期间 busy 保持 1 (进来前由 LCD_drawImage 置位) */
    W25Q_CheckAndRecover();
    goto retry;
}

uint8_t LCD_drawImageFromW25Q_Overlap_ColorMul(
    uint8_t x, uint8_t y,
    uint8_t w, uint8_t h,
    const uint8_t* pic,
    uint16_t color565
)
{
    uint32_t base;
    uint16_t row, col, rowBytes, chunkMax;
    uint8_t  recovered = 0;
    uint32_t cr, cg, cb;                /* 目标颜色分量 */

    if (w == 0u || h == 0u || w > LCD_W) { busy = 0; return 1; }

    base     = ((uint32_t)pic) & W25Q_ADDR_MASK;   /* 芯片相对偏移, 见上面的地址语义 */
    rowBytes = (uint16_t)(w * 2u);
    chunkMax = (uint16_t)(sizeof(g_lcdRowBuf) / rowBytes);
    if (chunkMax == 0u) chunkMax = 1u;

    cr = (color565 >> 11) & 0x1Fu;
    cg = (color565 >> 5)  & 0x3Fu;
    cb =  color565        & 0x1Fu;

retry:
    for (row = 0u; row < h; row = (uint16_t)(row + chunkMax))
    {
        uint16_t nr = (uint16_t)(h - row);
        uint16_t np;
        if (nr > chunkMax) nr = chunkMax;
        np = (uint16_t)(w * nr);

        /* ---- 阶段1: 一次读 nr 行 ---- */
        SPI_BusTakeW25Q();
        if (W25Q_ReadBytes(base + (uint32_t)row * rowBytes,
                           g_lcdRowBuf, (uint32_t)nr * rowBytes) != 0)
        {
            SPI_BusRelease();
            goto recover;
        }
        SPI_BusRelease();

        /* ---- 逐像素与 color565 相乘 (灰度正片 × 颜色; 0xFFFF = 原样输出) ----
         * 取灰度与原 SpeedTest 同函数一致: 取像素的 bit10..5 (6bit)。 */
        for (col = 0u; col < np; col++)
        {
            uint16_t lo = g_lcdRowBuf[col * 2u];
            uint16_t hi = g_lcdRowBuf[col * 2u + 1u];
            uint16_t px = (uint16_t)((hi << 8) | lo);
            uint16_t out;

            if (color565 == 0xFFFFu)
            {
                out = px;                       /* 原样输出 */
            }
            else
            {
                uint32_t g = (px >> 5) & 0x3Fu;
                out = (uint16_t)((((g * cr) >> 6) << 11) |
                                 (((g * cg) >> 6) << 5)  |
                                  ((g * cb) >> 6));
            }
            g_lcdRowBuf[col * 2u]      = (uint8_t)(out & 0xFFu);          /* 低字节 → 后上线 */
            g_lcdRowBuf[col * 2u + 1u] = (uint8_t)((out >> 8) & 0xFFu);   /* 高字节 → 先上线 */
        }

        /* ---- 阶段2: 一个窗口一次写 nr 行 ---- */
        LCD_Address_Set(x, (uint8_t)(y + row), (uint8_t)(x + w - 1u),
                        (uint8_t)(y + row + nr - 1u));
        CW_SPI->CR1_f.WIDTH = 0x0F;
        SPI_TransmitU16(g_lcdRowBuf, np, 30000);
        LCD_WaitSendFinish(2);
        CW_SPI->CR1_f.WIDTH = 0x07;
    }

    busy = 0;
    return 0;

recover:
    SPI_BusRelease();
    CW_SPI->CR1_f.WIDTH = 0x07;
    if (recovered) { busy = 0; return 2; }
    recovered = 1;                          /* 重试期间 busy 保持 1 */
    W25Q_CheckAndRecover();
    goto retry;
}

/* 示例: 无 DMA 通路 —— 保留符号, 直接走 RAM 中转的逐行两阶段实现 */
uint8_t LCD_drawImageFromW25Q_DMA(uint8_t x, uint8_t y, uint8_t w, uint8_t h, const uint8_t* pic)
{
    return LCD_drawImageFromW25Q_Overlap(x, y, w, h, pic);
}

/* ----------------------------------------------------------------------------
 *  外部 W25Q 的 **8bit 灰度**素材绘制 (字库 / 灰度掩膜 / 图标)
 *
 *  ui_assets_ext.c 把灰度字节按内存字节序打包成 uint16 元素 (小端: 低字节先),
 *  这里按**字节**读 w 个/行再乘色写屏 —— 不能按 16 位值读, 否则字节成对交换,
 *  板上表现为"图案左右成对错位"(示例 踩过, 见 code/lcd/README.md)。
 *
 *  LCD 与 W25Q 共用一条 SPI: 逐行两阶段 (读一行进 RAM → 写一行到面板),
 *  与 LCD_drawImageFromW25Q_Overlap 同一套总线互锁。mirror 在乘色发送时按行翻转。
 * ---------------------------------------------------------------------------- */
/* 字模绘制耗时探针 (SWD 读): W25Q 流读 vs LCD 窗口写, 定位数字刷新慢在哪一段 */
extern uint32_t Prof_NowUs(void);
volatile uint32_t g_profGrayReadUs, g_profGrayReadMax;
volatile uint32_t g_profGrayLcdUs,  g_profGrayLcdMax;
volatile uint32_t g_profGrayChunks;

uint8_t LCD_drawGrayImageFromW25Q(uint8_t x, uint8_t y, uint8_t w, uint8_t h,
                                  const uint8_t* gray, uint16_t color, uint8_t mirror)
{
    uint32_t base;
    uint16_t row, chunkMax;
    uint8_t  recovered = 0;
#if W25Q_CAPTURE_TEST
    uint8_t  chunkIdx;
#endif

    if (gray == 0 || w == 0u || h == 0u || w > LCD_W || busy)
    {
        return 1;
    }
    if ((uint16_t)x + w > LCD_W || (uint16_t)y + h > LCD_H)
    {
        return 1;
    }

    g_dbgExtGrayDraw++;
    base = ((uint32_t)gray) & W25Q_ADDR_MASK;   /* 芯片相对偏移 (不是绝对地址) */
    chunkMax = (uint16_t)(sizeof(g_lcdRowBuf) / w);   /* 480B / w 行 */
    if (chunkMax == 0u) chunkMax = 1u;

retry:
    busy = 1;
#if W25Q_CAPTURE_TEST
    chunkIdx = 0u;
#endif

    /* HOLD 流式读 (抓第二块用于对拍): 整个字模一次 0x03+地址, LCD 写时 HOLD 暂停 */
    if (W25Q_StreamBegin(base) != 0)
    {
        W25Q_StreamEnd();
        goto recover;
    }

    for (row = 0u; row < h; row = (uint16_t)(row + chunkMax))
    {
        uint16_t nr = (uint16_t)(h - row);
        if (nr > chunkMax) nr = chunkMax;

        /* ---- 阶段1: 从 W25Q 流式读 nr 行灰度字节 ---- */
        {
            uint32_t _t0 = Prof_NowUs();
            uint32_t _d;

            if (W25Q_StreamRead(g_lcdRowBuf, (uint32_t)nr * w) != 0)
            {
                W25Q_StreamEnd();
                goto recover;
            }
            _d = Prof_NowUs() - _t0;
            g_profGrayReadUs += _d;
            if (_d > g_profGrayReadMax) g_profGrayReadMax = _d;
        }

#if W25Q_CAPTURE_TEST
        /* 抓第二块 (第一次 HOLD 暂停之后读到的数据) 供 OpenOCD 对拍 */
        if (chunkIdx == 1u)
            W25Q_CaptureChunk(base + (uint32_t)row * w, g_lcdRowBuf, (uint32_t)nr * w);
#endif
#if W25Q_CAPTURE_TEST
        chunkIdx++;
#endif

        /* ---- 阶段2: 一个窗口一次写 nr 行 (8bit 灰度 × color565 → RGB565) ---- */
        {
            uint32_t _t0 = Prof_NowUs();
            uint32_t _d;

            LCD_Address_Set(x, (uint8_t)(y + row), (uint8_t)(x + w - 1u),
                            (uint8_t)(y + row + nr - 1u));
            CW_SPI->CR1_f.WIDTH = 0x0F;
            SPI_TransmitU8GrayMultiplyColorMirror(g_lcdRowBuf, w, nr, color, mirror, 30000);
            LCD_WaitSendFinish(2);
            CW_SPI->CR1_f.WIDTH = 0x07;
            _d = Prof_NowUs() - _t0;
            g_profGrayLcdUs += _d;
            if (_d > g_profGrayLcdMax) g_profGrayLcdMax = _d;
            g_profGrayChunks++;
        }
    }

    W25Q_StreamEnd();
#if W25Q_CAPTURE_TEST
    W25Q_CaptureVerify();       /* 正常读同一地址, 与 HOLD 抓到的第二块逐字节比 */
#endif
    busy = 0;
    return 0;

recover:
    W25Q_StreamEnd();
    CW_SPI->CR1_f.WIDTH = 0x07;
    if (recovered) { g_dbgExtGrayErr++; busy = 0; return 2; }
    recovered = 1;                          /* 重试期间 busy 保持 1 */
    W25Q_CheckAndRecover();
    goto retry;
}

#endif
