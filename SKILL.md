# SKILL：把网页里的「系统字数字 66」搬到 MCU 上

## 适用场景

- 第一次接手本仓库，要把 **MCU LCD Studio** 网页工程导出成固件 C 代码；
- 目标是在一块 240×240（或相近）小屏上显示一个**系统字数字**（示例值 `66`）；
- 已经有面板驱动，或准备复用 `examples/render-port` 的 GC9A01 + SPI 参考实现；
- 不涉及圆环、电池、多页状态机也可以先跑通本文，之后再逐项加。

本文以仓库里的 `examples/render-port` 为**参考基线**；函数名、字段名均来自该示例和网页导出器，未验证的写法会标“需确认”。

---

## 一页流程

```text
① 网页建层
   「＋文字」→ 选「系统字库」→ 类型「数字」→ 绑定变量（建议 g_uiSpeed）
   → 设置位数 cells=2、小数 dec=0、对齐、颜色/底色
   → 【关键】把该层的存储从默认「内部」切到「LZSS」（见下方说明）
   → 画布上确认显示 66

② 导出
   右栏「导出到文件夹」；不支持目录写入时下载 ZIP
   导出前看右侧 LZSS 统计：压缩比、解码 RAM（即 UI_ASSET_BUF_SIZE）

③ 放文件
   生成物 → 工程 code/lcd/（或与示例相同的目录结构）
   示例框架 → code/spi/、code/timer/、port/
   头文件搜索路径必须包含：code/lcd、code/spi、code/timer、port

④ 初始化
   Board_Init()        // 你的时钟/GPIO/SPI，仓库里没有这个函数，是伪代码
   LCD_Init()          // 复用示例 app_lcd.c；或者换成你自己的面板初始化
   LCD_UI_Setup()      // UI_SetFields(g_uiFields, UI_FIELD_N) + UI_Init()
   LCD_UI_Goto(0)      // 清屏 + LCD_Page0_Enter()：画数字 + 启动 200ms 定时器

⑤ 调用
   g_uiSpeed = 66;
   UI_DrawField(&g_uiFields[0]);   // 立即画一次；不是 showNumber()

⑥ 主循环
   while (1) timer_loop();         // 必须持续跑：页面定时器/差分刷新都靠它
```

### 66 到底生成什么？

以示例工程的 LZSS 系统字数字层为准：

| 对象 | 位置 | 示例值 |
|---|---|---|
| `g_uiFields[]` | `ui_table.c` | 1 个 `UI_FIELD`，`.type=UI_T_NUM`、`.cells=2`、`.src=&g_uiSpeed`、`.font=&g_uiFont_g_uiField0` |
| `UI_FONT g_uiFont_g_uiField0` | `ui_font.c` | `.glyph=0`、`.w=54`、`.h=80`、`.first=48`、`.count=10`、`.parts=2`、`.partW=27`、`.assetBase=UI_ASSET_g_uiFont_g_uiField0GlyphP0` |
| 字模像素 | `ui_assets_lzss.c` | 10 个字形 × 左右 2 片，共 20 个 `UI_Asset` 表项 |
| 渲染入口 | `app_ui.c` + `ui_asset_draw.c` | `UI_DrawField()` → `UI_DrawGlyph()` → 逐片 `UI_DrawAsset()` → `LCD_drawGrayImage()` |

**结论：`UI_DrawField(&g_uiFields[0])` 就够，仓库里没有 `showNumber()`。** 但有两个前提：

1. 该数字层的存储必须是 **LZSS**。网页新建图层的默认存储是“内部”（`store:'int'`），此时导出的是 `ui_assets_int.c` 里一张连续 `uint8_t` 字模 + `ui_font.c` 里 `.glyph=...`，**不会**生成 `ui_assets_lzss.*`、`lzss_decode.*`、`ui_asset_draw.*`；而示例 `app_ui.c` 依赖 `ui_asset_draw.c` 里的 `UI_DrawGlyph/UI_DrawFrameRefAt`。内部存储路径与当前示例框架能否直接链接，**需确认**；第一次跑通请切 LZSS。
2. `g_uiSpeed` 不在生成物里。示例在 `port/page0_port.c` 定义 `int32_t g_uiSpeed`，并在 `ui_user.h` 用 `#define UI_SRC_motor_speedlevel (&g_uiSpeed)` 把表里的来源改过来。若绑定名直接写 `g_uiSpeed`，生成的 `ui_table.c` 会写 `.src=&g_uiSpeed`，生成的 `ui_user.h` 会 `extern int32_t g_uiSpeed`；若绑定名是 `motor.speedlevel`，生成的 `ui_user.h` 会写 `#define UI_SRC_motor_speedlevel (&motor.speedlevel)`，要求 `motor` 的完整结构体定义可见。

---

## 生成文件清单

网页导出是**按图层裁剪**的，不是每次都出全套。以“只有一个 LZSS 系统字数字层、无静态帧、无圆环”为例：

```text
ui_table.c / .h        帧表、动态区域表、UI_FRAME_N / UI_FIELD_N
ui_font.c              UI_FONT 结构体（字模像素不在这里）
ui_color.h             本次用到的颜色宏
ui_task.c / .h         页面 Enter/Exit、LCD_UI_Setup/Goto/Page
ui_assets_lzss.c / .h  g_uiAssets[] + g_uiAssetBlob[] + UI_ASSET_* / UI_ASSET_BUF_SIZE
lzss_decode.c / .h     通用 LZSS 解码
ui_asset_draw.c / .h   UI_DrawFrame/At/RefAt、UI_DrawAsset、UI_DrawGlyph
ui_assets_int.c        内部 raw 素材（本例可能只有文件头/空表）
ui_assets_ext.c        外部 raw 素材（本例通常为空壳）
ui_user.h              工程钩子，只在第一次导出生成，之后不覆盖
ring_config.h          即使没有圆环也会生成，可忽略
lcd-project.json       工程备份
lcd-font-*.ttf         自定义字库原文件（如果用了）
```

条件说明：

- `ui_assets_lzss.c/.h`、`lzss_decode.*`、`ui_asset_draw.*` **只在有 LZSS 组时生成**；
- `ui_assets_ext.c` 基本总会生成，空壳也正常；
- `ring_scan.h/.c` 仅在有圆环时生成；
- `ui_task.c` 无任务内容时可能不生成，但 66 示例会生成；
- 不是每次导出都带 `ui_assets_int.c` 里的字模：存储选“内部”时字模才会进这里。

---

## 最小可运行代码（LZSS 数字 66）

```c
#include <stdint.h>
#include "ui_task.h"        /* LCD_UI_Setup / LCD_UI_Goto / LCD_UI_Page */
#include "ui_table.h"       /* g_uiFields / g_uiFont_g_uiField0 / UI_FIELD_N */
#include "app_ui.h"         /* UI_DrawField / UI_FIELD */
#include "bsp_gc9a01.h"     /* LCD_Init / LCD_Fill / LCD_draw*（示例头） */
#include "multi_timer.h"    /* timer_loop */

/* 必须与网页里“绑定变量”一致；示例为 g_uiSpeed */
int32_t g_uiSpeed = 66;

int main(void)
{
    Board_Init();                 /* 伪代码：目标板的时钟/GPIO/SPI */

    LCD_Init();                   /* 示例 app_lcd.c：复位→寄存器→清屏→DISPON */
                                  /* 若你自己初始化面板，可改成你的函数 */

    LCD_UI_Setup();               /* 注册 g_uiFields + UI_Init，不进任何页 */
    LCD_UI_Goto(0);               /* 清屏 + 进页 0：UI_DrawField + 200ms 定时器 */

    g_uiSpeed = 66;
    UI_DrawField(&g_uiFields[0]); /* 立即画 66；Goto 里其实已画过一次 */

    for (;;) {
        timer_loop();             /* 必须持续跑；变量变了会在 200ms 回调里刷新 */
    }
}
```

说明：

- `LCD_UI_Goto(0)` 内部会 `LCD_Fill` 整屏，所以**不要**在 `Goto` 之前画数字；
- 如果先 `g_uiSpeed=66` 再 `Goto(0)`，`LCD_Page0_Enter()` 里的 `UI_DrawField` 已经会画 66，后面的显式调用可省；
- 不要用 `Page0Port_SetLevel(66)` 来显示 66：示例里 `PAGE0_MAX_LEVEL=35`，`66` 会被夹成 `35`（见 `port/page0_port.c` 和 `page0_port.h`）；
- `Page0Port_*` 的 setter 只在 `LCD_UI_Page()==0` 时才画；在 `Enter()` 之前调用只改值、不画。

---

## 函数对接表（按“必须 / 复用示例才需要 / 可选”）

### 必须：4 个 UI/业务函数 + 3 个面板原语 = 7 个

| 函数 | 精确签名 | 作用 / 注意 |
|---|---|---|
| `LCD_UI_Setup` | `void LCD_UI_Setup(void)` | 设表 + `UI_Init()`；面板初始化后调用一次 |
| `LCD_UI_Goto` | `void LCD_UI_Goto(int8_t page)` | 切页；`0` 为页 0；内部清屏→Enter→启动定时器 |
| `UI_DrawField` | `void UI_DrawField(UI_FIELD *fld)` | 数字/动态区域入口；传 `&g_uiFields[0]`；内部逐格差分 |
| `timer_loop` | `void timer_loop(void)` | 主循环必须持续调用；依赖 1ms tick（见下） |
| `LCD_Fill` | `uint8_t LCD_Fill(uint8_t xsta,uint8_t ysta,uint8_t xend,uint8_t yend,uint16_t color)` | `xend/yend` 为**开区间**；`Goto` 清屏、数字补底、清字格都用它 |
| `LCD_drawGrayImage` | `uint8_t LCD_drawGrayImage(uint8_t x,uint8_t y,uint8_t w,uint8_t h,const uint8_t *gray,uint16_t color,uint8_t mirror)` | GRAY8 字模 × 颜色；`mirror=1` 左右翻转 |
| `LCD_drawImage` | `uint8_t LCD_drawImage(uint8_t x,uint8_t y,uint8_t w,uint8_t h,const void *pic,uint16_t color)` | RGB565；**链接期也需要**：`app_ui.c`/`ui_asset_draw.c` 里有引用，即使当前没有 RGB 素材。可先实现空桩 |

注意：`timer_loop()` 不是“有函数就行”，它必须真的每 1ms 前进。示例的 `code/timer/multi_timer.c` 直接读 `CW_BTIM1->CNT`，并提供 `millis()`；换 MCU 时**这个文件也要移植**（SysTick 或任意 1ms 时基），不能只改 `bsp_gc9a01.c`。

### 复用示例才需要：4 个（+1 个可选）

| 函数 | 精确签名 | 何时需要 |
|---|---|---|
| `LCD_Init` | `void LCD_Init(void)` | 复用示例 `app_lcd.c` 时需要；自己初始化面板时不需要 |
| `UI_DrawFrame` | `void UI_DrawFrame(uint16_t id,uint16_t color)` | 有静态帧（F/R、图标）且由页面绘制时需要；纯数字 66 不需要 |
| `UI_DrawFrameAt` | `void UI_DrawFrameAt(uint16_t id,uint16_t x,uint16_t y,uint16_t color)` | 需要换坐标画静态帧时；可选 |
| `UI_DrawFrameRefAt` | `void UI_DrawFrameRefAt(const UI_FRAME_REF *f,uint16_t x,uint16_t y,uint16_t color)` | 电池/多帧、手动改 `frame.index` 时需要；纯 66 不需要 |
| `battery` / `frames_1021` | `void battery(uint8_t x,uint8_t y,uint8_t id,uint16_t color,uint16_t bg)` 等 | 只有导出了多帧图标才生成/需要 |

`UI_DrawFrame` / `UI_DrawFrameRefAt` 由 `ui_asset_draw.c` 提供，不属于“移植者要手写的函数”；但如果你用示例的 `app_ui.c`，必须把 `ui_asset_draw.c` 一起加入工程。

### SPI：只有复用 `bsp_gc9a01.c` 才需要

示例 `bsp_gc9a01.c`（`USE_W25Q` 关闭时）实际调用 **8 个** SPI 函数：

```text
SPI_BusTakeLCD() / SPI_BusRelease()
SPI_TransmitDC(data, dc, timeout)
SPI_TransmitU8(buf, size, timeout)
SPI_TransmitU16(buf, sizeU16, timeout)
SPI_TransmitU16GrayMultiplyColor(buf, sizeU16, color, timeout)
SPI_TransmitU8GrayMultiplyColorMirror(buf, w, h, color, mirror, timeout)
SPI_Fill_Transmit(color, sizeU16)
```

另外还依赖：`extern volatile uint8_t busy;`、`millis()`、`CW_SPI->CR1_f.WIDTH`、`LCD_DC/LCD_RST` 宏、`HAL_Delay()`（示例在 `bsp_gc9a01.c` 里用 SysTick 自己实现）。
`SPI_BusTakeW25Q()` 只在 `USE_W25Q` 打开时使用。

**如果目标工程自己实现 `LCD_Fill/LCD_drawImage/LCD_drawGrayImage`（直接操作自己的 SPI），则一个 `SPI_*` 函数都不需要实现。** 生成物只调用 `LCD_*`；`SPI_*` 是示例面板驱动的内部实现细节。

### 可选 / 一般不用

`UI_DrawStatic()`、`UI_Tick()`、`UI_DrawAll()`、`UI_FieldInvalidate()`、`UI_SetFields()`、`UI_Init()`：导出器/框架提供，示例页面任务没有直接调用。清屏后若自己重画，才需要 `UI_FieldInvalidate`。

---

## 关键常量 / 内存

| 项 | 含义 / 数值 |
|---|---|
| `UI_ASSET_BUF_SIZE` | **最大单片的原始字节数**，不是所有素材总和。示例 `2304`（电池 48×24 RGB565）；纯 54×80 字模单条为 `27×80=2160` |
| `g_uiAssetBuf` | `ui_asset_draw.c` 内的静态解码缓冲，`__attribute__((aligned(4)))`；RGB565 会被按 `uint16_t` 读，**不能改成 2 字节对齐** |
| LZSS blob | `UI_Asset.off/clen` 都是 `uint16_t`，因此 `g_uiAssetBlob[]` 必须 **< 64 KB**；示例 `18474 B` |
| `parts / partW` | 54×80 字模 → `parts=2, partW=27`；最后一片宽度以 `UI_Asset.w` 为准，**不要硬编码 27** |
| `index == 255` | 仅网页渲染：`UI_DrawFrameRefAt` 只清底色（`UI_BG_COLOR`，默认 `0x0000`，可在 `ui_user.h` 覆盖），不画图案 |
| `cells` | 数字定宽格数；示例 2。`UI_FIELD.lastCh[8]` / `UI_DrawField` 的 `disp[8]` 上限是 8，**cells > 8 会被静默截断**（需确认是否支持） |
| 坐标 | 生成物会按最大边缘选 `uint8_t` 或 `uint16_t`；但 `UI_DrawField` 内部多处仍转 `uint8_t`，240×240 安全，>255 画布需自行检查/修改 |
| `UI_PAGE_BG` | 切页清屏色，来自屏幕预设的底色；示例为黑 |

---

## 常见错误

1. **LZSS 帧/字模全空白**
   - 旧 `UI_DrawFrame` 里 `if (!f->px) return;`：LZSS 帧 `.px=0`，必须先判 `index==255`、再判 `.px`、最后走 `.asset`；
   - 没有把生成的 `ui_asset_draw.c` 加入工程，或用了旧的同名实现（重复定义/旧逻辑）；
   - `UI_ASSET_BUF_SIZE` 小于该片 `w*h*bpp`，`UI_DrawAsset` 会直接填底色退出；
   - blob 超过 64 KB 导致 `off` 溢出。

2. **数字不刷新**
   - 没跑 `timer_loop()`，或 1ms 时基没移植（`multi_timer.c` 还读 `CW_BTIM1`）；
   - 当前页不是 0（`LCD_UI_Page()!=0`），`Page0Port_*` 的 setter 会直接 return；
   - 先 `UI_DrawField` 再 `LCD_UI_Goto`，被进页清屏擦掉；
   - 值位数超过 `cells`，`UI_DrawField` 里 `n > fld->cells` 直接 return（保持旧画面）；
   - `lastCh/lastCells/lastStartX` 被清屏/换页后没作废，需 `UI_FieldInvalidate()` 或重新 `UI_Init()`。

3. **字体被截 / 左右错位 / 只画半截**
   - 固件写死“27×80 两条”而没有按 `parts/partW` 循环；
   - 最后一片按 `partW` 画，而表项 `w` 更窄；
   - `UI_ASSET_BUF_SIZE` 只按一条算，或解码缓冲被别的素材复用覆盖；
   - 改了字号但没重新导出，`UI_FONT` 与 `UI_Asset` 表不匹配。

4. **SPI 花屏 / 白屏 / 最后一点错色**
   - `LCD_Fill` 返回值被忽略：SPI 超时只发了一半像素，屏上剩旧内容；
   - 收尾只等 TXE、没等 BUSY=0 就改 `WIDTH`/DC/CS；
   - `LCD_drawImage`/`LCD_Fill` 重入时 `busy` 没保护，或清屏后地址缓存没作废；
   - RGB565 字节序与面板要求相反（字模/图标成对错色）；
   - 示例 `HAL_Delay` 用 SysTick 轮询，和 RTOS/其他 SysTick 用户冲突；`CW_SPI` 是 CW32 专有寄存器，换 MCU 必须替换。

5. **RAM 不够**
   - `UI_ASSET_BUF_SIZE` 是**最大单片**，换大图/大字体会线性增长；不要为了省事写死 2400；
   - 除了解码缓冲，还要留 `UI_FIELD`、`g_uiFrames`、页面定时器和栈；
   - 圆环开启时另有内部缓冲（示例注释提到 ~1.5 KB 级），纯数字 66 不涉及。

---

## 验证清单

- [ ] 网页该数字层存储为 **LZSS**（或确认内部存储路径与你的 `app_ui.c` 匹配）；
- [ ] 导出物包含 `ui_table.c/.h`、`ui_font.c`、`ui_assets_lzss.*`、`lzss_decode.*`、`ui_asset_draw.*`；
- [ ] `ui_table.c` 里 `g_uiFields[0].cells==2`、`.src` 指向你实际定义的 `int32_t` 变量；
- [ ] `ui_font.c` 的 `w/h/first/count/parts/partW` 与网页一致；
- [ ] `UI_ASSET_BUF_SIZE >= max(w*h*bpp)`，`g_uiAssetBlob` 小于 64 KB；
- [ ] 编译时没有重复定义 `UI_DrawFrame` / 未定义 `UI_DrawGlyph` / `LZSS_Decode`；
- [ ] 上电顺序：面板初始化 → `LCD_UI_Setup()` → `LCD_UI_Goto(0)` → 主循环 `timer_loop()`；
- [ ] 屏上稳定显示 `66`；改成 `67` 后只重画个位，不出现整块闪烁；
- [ ] 切页/清屏后再进页 0，数字能重画；
- [ ] `g_dbgLcdFillIo`（示例）保持 0，或至少能解释非 0 的原因。

---

## 不要改生成物

每次重新导出都会覆盖，改了也留不住：

```text
ui_table.c / ui_table.h
ui_font.c
ui_color.h
ui_task.c / ui_task.h
ui_assets_lzss.c / ui_assets_lzss.h
ui_assets_int.c / ui_assets_ext.c
lzss_decode.c / lzss_decode.h
ui_asset_draw.c / ui_asset_draw.h
ring_config.h / ring_scan.c / ring_scan.h
```

可以改、且不会被覆盖的工程文件：

```text
ui_user.h          （只在第一次导出时生成）
port/page0_port.c  （示例适配层，按你的业务改）
app_ui.c / app_ui.h（通用框架；升级导出格式时才动）
bsp_gc9a01.c/.h、bsp_spiHost.c/.h、bsp_gpio.h、app_lcd.c/.h（换屏/换 MCU 时改）
multi_timer.c/.h   （换 1ms 时基时改）
```

**绝对不要**把 `27`、`80`、`2304`、`2400` 写死到业务代码里；这些值随字号/素材变化，以 `UI_FONT`、`UI_Asset`、`UI_ASSET_BUF_SIZE` 为准。

---

## 附：走流程时发现的文档差异（不改 README，仅记录）

- README 第 4.1/4.3 节把 LZSS 文件写成默认结果；实际新图层默认“内部”，需手动切 LZSS；内部存储不会生成 `ui_assets_lzss.*` / `ui_asset_draw.*`。
- README 的 `Page0Port_SetLevel(66)` 会被示例的 `PAGE0_MAX_LEVEL=35` 夹成 35。
- README 说“业务/UI 层最少 6 个函数”，但纯 66 只需 4 个（Setup/Goto/DrawField/timer_loop）；`UI_DrawFrame/UI_DrawFrameRefAt` 是静态帧/多帧才需要。
- README 的 SPI 表未列 `SPI_TransmitDC`；示例实际依赖 8 个 SPI 函数，且只实现 `LCD_*` 时 SPI 层可以完全不要。
- README 说换 MCU 只改 `bsp_gc9a01`/`bsp_spiHost`/`bsp_gpio`/`app_lcd`，遗漏了 `multi_timer.c` 的 `CW_BTIM1` 和 `bsp_gc9a01.c` 里的 SysTick `HAL_Delay`。
- `examples/render-port/README.md` 第 119–121 行把 `ring_tables.h`/`ring_grad.h` 列在 `code/lcd`，实际在 `code/spi`；且仓库内没有生成这两张表的 `gen_tables.py`。
