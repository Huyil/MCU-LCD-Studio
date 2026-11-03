# Render port example

一个可直接对照的页 0 示例：系统字数字、F/R 方向、电池、K·RPM/PAUSE 和圆环。

![示例界面](../../docs/screenshot-main.png)

它同时提供 **UI 框架 + 屏幕驱动 + SPI 驱动 + 页面定时器**，用于说明网页导出物在 MCU 侧怎么接起来。示例驱动是参考实现，换 MCU/屏幕时按目标工程替换。

## 目录

```text
examples/render-port/
├─ code/lcd/                     Web 导出物 + 通用渲染
│  ├─ ui_assets_lzss.c/.h        LZSS 素材表 + 压缩流
│  ├─ lzss_decode.c/.h           通用 LZSS 解码
│  ├─ ui_asset_draw.c/.h         渲染桥：Frame/Ref/Asset/Glyph
│  ├─ ui_assets_int.c            内部 raw 素材（F/R）
│  ├─ ui_font.c                  字库描述 + battery()/frames_1021()
│  ├─ ui_table.c/.h              帧表/动态区域表
│  ├─ ui_task.c/.h               页 0 任务
│  ├─ ui_color.h                 颜色宏
│  ├─ ui_user.h                  工程钩子（可改）
│  └─ ring_config.h              圆环参数
├─ code/spi/
│  ├─ app_ui.c/.h                UI_DrawField 差分渲染
│  ├─ bsp_gc9a01.c/.h            LCD_Fill/drawImage/drawGrayImage/Ring
│  ├─ bsp_spiHost.c/.h           SPI 发送原语
│  ├─ app_lcd.c/.h               面板初始化/清屏/休眠
│  ├─ bsp_ring.c/.h              圆环引擎
│  ├─ ring_tables.h / ring_grad.h   示例引擎自带，不由网页导出
│  ├─ ring_seg_spans.h              圆环每段逐行几何（网页一键导出生成；也可用 tools/gen_ring_spans.py）
│  ├─ bsp_gpio.h                 引脚宏（目标工程替换）
│  └─ bsp_w25q.h                 空桩
├─ code/timer/multi_timer.c/.h   页面定时器
├─ port/page0_port.c/.h          业务适配示例
└─ source/                       可选的 Web 工程源文件
```

## 最小接入

把 `code/lcd`、`code/spi`、`code/timer`、`port` 加入工程，并保证头文件路径包含：

```text
code/lcd
code/spi
code/timer
port
```

初始化：

```c
Board_Init();          /* 目标板：时钟/GPIO/SPI */
LCD_Init();            /* app_lcd.c：复位、清屏、DISPON */
Page0Port_Init();      /* Ring_Init() + LCD_UI_Setup() */
Page0Port_Enter();     /* LCD_UI_Goto(0) */

while (1) {
    timer_loop();      /* 页面刷新、圆环、动画 */
}
```

## 显示数字 66

示例数字层绑定 `g_uiSpeed`，`ui_table.c` 里是 `g_uiFields[0]`，字库是 `g_uiFont_g_uiField0`：

```c
g_uiSpeed = 66;
UI_DrawField(&g_uiFields[0]);
```

**不要**用 `Page0Port_SetLevel(66)`：示例的 `PAGE0_MAX_LEVEL=35`，会被夹成 35。`UI_DrawField` 就是数字的渲染入口；不需要额外的 `showNumber()`。它内部按字符调用 `UI_DrawGlyph`，再按 `parts/partW` 解压左右两条字模。

## 其他区域

```c
Page0Port_SetDir(0);                 /* 0 = F，1 = R */
Page0Port_SetBattery(8);             /* 0 = 擦除，1..14 = 帧 */
Page0Port_SetPause(1, 0xFFFF);       /* 1 = PAUSE，0 = K·RPM */
```

## 需要对接的接口

| 层 | 接口 | 说明 |
|---|---|---|
| 业务 | `Page0Port_*` | 示例适配层，可换成自己的业务 |
| UI | `LCD_UI_Setup` / `LCD_UI_Goto` | 注册表 + 进页 |
| UI | `UI_DrawField` | 数字/动态区域 |
| UI | `UI_DrawFrame` / `UI_DrawFrameRefAt` | 静态帧 / 多帧 |
| UI | `timer_loop` | 页面定时器 |
| 面板 | `LCD_Init` | 初始化 |
| 面板 | `LCD_Fill` | 填充/清屏 |
| 面板 | `LCD_drawImage` | RGB565 |
| 面板 | `LCD_drawGrayImage` | GRAY8 + 乘色/镜像 |
| SPI | `SPI_BusTakeLCD` / `SPI_BusRelease` | 总线占用/释放 |
| SPI | `SPI_TransmitDC` | DC 电平 + 命令/数据 |
| SPI | `SPI_TransmitU8` / `SPI_TransmitU16` | 命令/像素 |
| SPI | `SPI_TransmitU8GrayMultiplyColorMirror` | GRAY8 + 乘色 + 镜像 |
| SPI | `SPI_TransmitU16GrayMultiplyColor` / `SPI_Fill_Transmit` | RGB565 乘色 / 批量填充 |

## 换屏 / 换 MCU

通常只改：

- `code/spi/bsp_gc9a01.c/.h`：面板初始化、窗口命令、像素发送；
- `code/spi/bsp_spiHost.c/.h`：SPI 总线；
- `code/spi/bsp_gpio.h`：CS/DC/RST/BL 引脚；
- `code/spi/app_lcd.c/.h`：清屏/休眠/唤醒；
- `code/timer/multi_timer.c`：1ms 时基（示例读 `CW_BTIM1`）；
- `port/page0_port.c`：业务状态来源。

`ui_assets_*`、`ui_table`、`ui_font`、`lzss_decode`、`ui_asset_draw` 是导出物/通用代码，不随屏幕变化。

## 重新导出

`source/lcd-project.json` 是网页工程源文件。改完重新导出后，替换 `code/lcd` 下的：

```text
ui_assets_lzss.c/.h  ui_assets_int.c  ui_font.c  ui_table.c/.h
ui_color.h  ui_task.c/.h  ring_config.h
ring_seg_spans.h        （仅「圆环 + 分段」时生成，见下）
```

如果启用了圆环逐像素扫描，导出物里还会多出 `ring_scan.h/.c`，一并加入工程。

> 目录说明：网页把所有文件写进导出目录（默认 `code/lcd`），所以 `ring_seg_spans.h` 会落在 `ring_config.h` 旁边；本示例把它放在 `code/spi`。`code/lcd` 和 `code/spi` 都在头文件搜索路径里，两种位置都能编译，**不要同时放两份**。

`ring_tables.h` / `ring_grad.h` 是示例圆环引擎自带的表，**不由网页导出**；换圆环参数时按引擎的生成方式处理，不要指望一键导出覆盖它们。

`ring_seg_spans.h` 是**换档增量重画**（`RING_FAST_SEG`）用的逐段几何表（每段每行的段体/缝跨度），现在**也由网页「一键导出」直接生成**，纯网页用户不用装 Python：

- 生成条件：`RING_SHAPE == 0`（圆环）且 `RING_SEG_ON == 1`，并且分段相位为 0；
- 与 `ring_config.h` 在**同一次导出**里生成，9 个几何指纹（CX/CY/R_IN/R_OUT/START/RANGE/N/PITCH/BODY）逐项一致；
- 圆角矩形（`RING_SHAPE=1`）、无圆环、分段关闭、分段相位非 0、表内 x/y 超过 `uint8`（0..255）、环完全在屏幕外时**跳过**，导出面板会显示原因，不会写半套；
- 注意：只要还是「圆环 + 分段」，`bsp_ring.c` 默认 `RING_FAST_SEG=1` 就会 `#include` 这张表。上面这些情况（圆角矩形/分段关除外）跳过时，必须把 `RING_FAST_SEG` 设为 0，否则编译会报找不到 `ring_seg_spans.h`；
- 表大小 = 行数 × 5B + (N+1) × 2B。示例 70 段、1042 行 = **5352 B**（约 5.2KB），常见配置在 4~7KB（段数/环厚更大时按公式增长）；导出面板的「圆环查表」会直接显示这个 Flash 代价。
- 网页版按**实际屏幕尺寸**扫描；参考 Python 脚本把扫描范围写死成 240×240。非 240 屏请以网页导出为准（`RingSegRow` 的 x/y 仍是 `uint8`，实际坐标超过 255 时会跳过）。

仍然可以用 Python 生成同一张表（两条路径数据区逐字节一致，网页版只多一行出处说明）：

```bash
python tools/gen_ring_spans.py            # 改完 ring_config.h 必须重跑
python tools/gen_ring_spans.py --check    # 只校验是否过期（可挂到预编译 / CI）
```

忘了重跑不会画出错位的环：`bsp_ring.c` 里有编译期指纹校验，参数对不上直接 `#error`。
不想要这张表就把 `bsp_ring.c` 里的开关改成 `RING_FAST_SEG 0`（或编译时 `-DRING_FAST_SEG=0`），退回逐像素扇区重画：省下这张表的 Flash，代价是换档时重画变慢。

**引擎不随导出器生成**：`bsp_ring.c` / `bsp_ring.h`、`ring_tables.h`、`ring_grad.h` 以及低层 `LCD_Ring*` 仍要从本示例工程拷贝；网页导出器只生成参数（`ring_config.h`）、查表（`ring_seg_spans.h`）和扫描表（`ring_scan.h/.c`）。

## 圆环主机接口（生成物实际用到的函数）

| 类别 | 数量 | 函数 |
|---|---|---|
| 生成 `ui_task.c` 直接调用（必须） | 4 | `Ring_SetBg` / `Ring_Start` / `Ring_Stop` / `Ring_ScreenInvalidate` |
| 板级初始化（必须，但不在生成物里） | 1 | `Ring_Init()`：上电后调用一次；本示例已由 `Page0Port_Init()` 调用，接到 `Board_Init()` / `LCD_Init()` 之后即可 |
| 应用按需（可选，`bsp_ring.h` 公开 API 共 34 个，除上面 5 个外其余 29 个） | 29 | 常用：`Ring_SetGear` / `Ring_SetProgress` / `Ring_ApplySeg` / `Ring_ApplyArc` / `Ring_SetArc` / `Ring_SetColor` / `Ring_SetGlint` / `Ring_SetDir` / `Ring_SetDim` / `Ring_SetLitNoPaint` |
| 低层 LCD 原语（由示例驱动提供） | 3 | `LCD_RingBegin` / `LCD_RingRun` / `LCD_RingEnd`（`bsp_gc9a01.c/.h`，被 `bsp_ring.c` 调用，应用不用直接调） |

- `Ring_ApplySeg(track, fill, lit, trail)` 是按「亮段数」驱动的入口，也是查表快路径的触发点；只有亮段变化 ≤8 且新旧值都 >2 时才走表，其余情况自动退回扇区/整弧重画，所以这张表**只影响速度，不影响能不能画**。
- 低层 3 个原语属于屏幕驱动（SPI 窗口 + 连续像素），换屏时由新的驱动实现，导出器不生成它们。

**不要覆盖** `code/lcd/ui_user.h` 和 `port/page0_port.c`。
