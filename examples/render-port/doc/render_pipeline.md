# 示例 渲染流程（移植包说明）

> 来源：2026-11-02 固件（内部 Flash + 通用 LZSS 素材表）。
> 本文件只描述“一帧内容从哪个入口进来、经过哪些层、最后从哪个硬件口出去”。

## 1. 一句话

没有全屏 framebuffer；`timer_loop()` 里的定时任务/按键事件是入口，经
**页面任务 → 表驱动 UI → LZSS 素材桥 → GC9A01 原语 → SPI1** 直接流式写屏。
圆环和清屏是两条旁路。

## 2. 分层

```text
数据源
├─ g_uiFields[0].src = &g_uiSpeed      ← 目标工程更新
├─ g_uiFrames[] / g_uiFrame0..3        ← ui_table.c
├─ g_uiAssets[] / g_uiAssetBlob        ← ui_assets_lzss.c (LZSS)
├─ g_uiFrame0_int / g_uiFrame1_int     ← ui_assets_int.c (raw)
└─ g_uiFont_g_uiField0                 ← ui_font.c (LZSS parts=2/partW=27)

入口/调度
main()
└─ while (1) timer_loop()
   ├─ 100ms  DSP_Tick()                 // 页状态机 + 脏标记落屏（目标工程实现）
   ├─ 30ms   ring_anim_cb()             // 圆环追赶（目标工程实现）
   ├─ 200ms  LCD_Page0_CB()             // 页 0 数字轮询（ui_task.c）
   └─ 10ms   key/encoder → DSP_SetLevel/SetDir/SetPause → DSP_Refresh
        │
        ▼
页面层  ui_task.c
  LCD_UI_Goto / LCD_Page0_Enter / Exit / UI_PAGE_CLEAR
        │
        ▼
UI 框架  app_ui.c
  UI_DrawField / UI_DrawFrame(id) / UI_DrawLine
        │
        ▼
素材渲染桥  ui_asset_draw.c
  UI_DrawFrameRefAt / UI_DrawAsset / UI_DrawGlyph
  g_uiAssetBuf[2304] (4 字节对齐)
        │
        ▼
解码/素材  lzss_decode.c + ui_assets_lzss.c + ui_assets_int.c
        │
        ▼
面板原语  bsp_gc9a01.c
  LCD_Fill / LCD_drawImage / LCD_drawGrayImage / LCD_Ring*
        │
        ▼
SPI 总线  bsp_spiHost.c
  SPI_BusTakeLCD / SPI_TransmitU8/U16 / SPI_Fill_Transmit
        │
        ▼
硬件出口
  SPI1: PB03 SCK / PB05 MOSI (AF3, 48MHz)
  GPIO: PB07 CS / PC13 DC / PB06 RST / PC14 BL
  面板: GC9A01 240x240 GRAM
```

## 3. 单次绘制展开

```text
UI_DrawField(&g_uiFields[0])                     UI_DrawFrame(id) / UI_DrawFrameRefAt(f)
├─ ui_num_sig()                                  ├─ index == 255 → ui_fill → LCD_Fill
├─ 对齐/逐格差分                                  ├─ px != 0 → ui_blit_raw
│  (lastCh / lastCells / lastStartX)             │  └─ LCD_drawGrayImage / LCD_drawImage
└─ ui_draw_glyph → UI_DrawGlyph                  └─ asset != NONE → UI_DrawAsset
   ├─ raw 字模 → ui_blit_gray                       ├─ LZSS_Decode → g_uiAssetBuf
   └─ LZSS 字模 (parts=2, partW=27)                  └─ ui_blit_gray / ui_blit_rgb
      └─ UI_DrawAsset → LZSS_Decode                     → LCD_drawGrayImage / LCD_drawImage
         → g_uiAssetBuf → ui_blit_gray
```

业务层对应：

```text
数字    Page0Port_SetLevel → g_uiSpeed → g_uiFields[0] → UI_DrawField → UI_DrawGlyph (LZSS)
F/R     Page0Port_SetDir   → UI_DrawFrame(0/1) → UI_DrawFrameRefAt → raw px
电池    Page0Port_SetBattery → tmp.index=id-1 → UI_DrawFrameRefAt → UI_DrawAsset (LZSS RGB565)
K·RPM   LCD_Page0_Enter    → UI_DrawFrame(3) → UI_DrawAsset (LZSS GRAY8)
PAUSE   Page0Port_SetPause → frames_1021(id=1/2) → UI_DrawAsset
```

## 4. 面板/SPI 出口

```text
LCD_drawGrayImage / LCD_drawImage / LCD_Fill
├─ busy 检查
├─ LCD_Address_Set(x, y, x2, y2)       // CASET 0x2A / RASET 0x2B, 带地址缓存
├─ SPI_BusTakeLCD()                    // CS=0, 48MHz, 清 RX/OV
├─ 像素流
│  ├─ LCD_drawImage  → SPI_TransmitU16 / SPI_TransmitU16GrayMultiplyColor
│  ├─ LCD_drawGrayImage → SPI_TransmitU8GrayMultiplyColorMirror
│  └─ LCD_Fill       → SPI_Fill_Transmit
├─ LCD_WaitSendFinish(2)               // TXE=1 且 BUSY=0
├─ SPI_BusRelease()                    // CS=1
└─ 硬件: SPI1(PB03/PB05) → GC9A01 GRAM
         DC=PC13, CS=PB07, RST=PB06, BL=PC14
```

## 5. 旁路：圆环 / 清屏 / 背光

```text
圆环
Ring_Start / Ring_ApplySeg / Ring_Redraw / Ring_Tick
├─ ring_config.h 几何/段数/角度
├─ Ring_ApplySeg
│  ├─ 增量: ring_paint_delta (只画变化的 2 段)
│  └─ 退化: Ring_ApplyArc (首帧/换色/整弧)
└─ ring_render / ring_paint_*
   → LCD_RingBegin()
   → LCD_RingRun(x, y, n, px)          // 逐行窗口
      ├─ CASET/RASET/RAMWR (SPI_TransmitU8)
      └─ SPI_TransmitU16(px, n)
   → LCD_RingEnd() → SPI_BusRelease()
   → GC9A01 GRAM

清屏
LCD_ClearScreen()                       // 最多重试 3 次
└─ lcd_clear_once()
   └─ LCD_Fill(0, 0, 240, 240, color)
      └─ SPI_Fill_Transmit → GC9A01 GRAM
   → g_lcdClearState = OK / BUSY / IO

背光
LCD_BL(1/0) → PC14
```

## 6. 容易误解的点

- `UI_Tick()`、`UI_DrawStatic()`、`UI_DrawAll()` 是导出器生成的通用接口，
  但 示例 实际没有调用；调度是页面定时器 + 目标工程的 `DSP_Tick`。
- 没有全屏 framebuffer：只存在 `g_uiAssetBuf[2304]` 和圆环内部缓冲。
- 数字去重发生在 `UI_DrawField` 的逐格差分（`lastCh[]`），不是解码缓存。
- 灰度乘色在 `SPI_TransmitU8GrayMultiplyColorMirror()` 里用 256 项 LUT 完成；
  RGB565 电池用 `color=0xFFFF` 原样发送。
- `USE_W25Q` 必须保持关闭；本包不包含 W25Q 驱动。
