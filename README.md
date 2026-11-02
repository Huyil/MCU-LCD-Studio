# MCU LCD Studio（LCD Layout Studio）

**中文简介**
面向 MCU 小屏（GC9A01、ST7735S 等）的**网页版屏幕布局与 C 代码导出工具**：导入图片、文字、系统字和圆环，拖到 1:1 模拟屏上排版，实时导出 UI 表、字库、页面任务与可选 LZSS 压缩素材。纯前端 Vue 3 + Vite，不需要后端；工程可存为 JSON，也可在配套存档服务可用时保存到服务器。

**English**
A browser-based layout and C-code generator for small MCU LCDs (GC9A01, ST7735S and similar). Import images, text, system fonts and ring gauges; arrange them on a 1:1 simulated screen; export UI tables, fonts, page tasks and optional LZSS-compressed assets. The app is a pure front-end Vue 3 + Vite project with no backend. Projects can be saved as JSON, or to a server when a compatible archive service is available. Licensed under MIT.

仓库 / Repository: <https://github.com/Huyil/MCU-LCD-Studio>

---

## 目录

- [1. 这是什么](#1-这是什么)
- [2. 快速开始](#2-快速开始)
- [3. 界面与基本工作流](#3-界面与基本工作流)
- [4. 素材库与多帧画板](#4-素材库与多帧画板)
- [5. 文字、数字、系统字与 ASCII 字库](#5-文字数字系统字与-ascii-字库)
- [6. 图层、页面与导出物](#6-图层页面与导出物)
- [7. 素材存储：内部 / 外部 / LZSS](#7-素材存储内部--外部--lzss)
- [8. LZSS 格式（移植者）](#8-lzss-格式移植者)
- [9. 系统字逐字微调](#9-系统字逐字微调)
- [10. 圆环引擎](#10-圆环引擎)
- [11. 屏幕预设与圆屏](#11-屏幕预设与圆屏)
- [12. 工程存档、一键导出与导出图片](#12-工程存档一键导出与导出图片)
- [13. 颜色宏与指令模板](#13-颜色宏与指令模板)
- [14. 测试与自检](#14-测试与自检)
- [15. 已知限制与常见坑](#15-已知限制与常见坑)
- [16. 代码地图、文档与许可](#16-代码地图文档与许可)

---

## 1. 这是什么

这个工具解决的是「小屏 UI 从设计稿到固件 C 代码」之间那段重复劳动：

- 在网页上按真实像素排版（图片、多帧图标、文字、数字、系统字、圆环、圆角矩形）；
- 实时生成 `UI_FRAME_REF` 帧表、`UI_FIELD` 数字表、`UI_FONT` 字库、页面任务和素材数组；
- 像素可以放**内部 Flash**、**外部 Flash**，或压进**统一 LZSS 素材表**；
- 一键写进固件源码目录，或打包成 ZIP；工程本身可存 JSON / 在线存档。

读者可以分两层看：

| 读者 | 先看 |
|---|---|
| 用网页做界面的人 | 第 2–6、9–13 节 |
| 把导出物接进固件的人 | 第 6–8、10、14 节，以及 [`docs/ui-export-redesign.md`](docs/ui-export-redesign.md) |

---

## 2. 快速开始

```bash
git clone https://github.com/Huyil/MCU-LCD-Studio.git
cd MCU-LCD-Studio

pnpm install
pnpm dev            # http://127.0.0.1:5180
```

生产构建：

```bash
pnpm build          # 产物在 dist/，是纯静态文件
pnpm preview        # 本地预览构建产物
```

`npm install` / `npm run dev` 也可以，仓库自带的是 `pnpm-lock.yaml`。

浏览器要求：

- 普通编辑与下载：现代 Chrome / Edge / Firefox 均可；
- **直接写入文件夹**（一键导出）需要 File System Access API：Chrome / Edge，且页面在 `https://` 或 `localhost` 下；
- 不满足时会自动退回 **ZIP 下载**，功能不受影响。

---

## 3. 界面与基本工作流

| 区域 | 作用 |
|---|---|
| 左 · 素材库 | 「当前工程 / 总素材库」切换、导入图片、多帧画板、`＋文字`、`◯ 圆环`；拖动缩略图到屏幕放置，单击打开微调 |
| 中 · 模拟屏 | 1:1 像素仿真（量化后效果）；网格 / 缩放 / 坐标读数；点选、拖动、双击微调；圆屏蒙版与出圈警告 |
| 右 · 导出 / 存档 | 工程条；一键导出到文件夹；复制 / 下载 C 代码；导出图片；页面与图层列表；实时导出预览 |

常用快捷键：

| 操作 | 键 |
|---|---|
| 移动选中图层 | 方向键（`Shift` = 10 px） |
| 删除 | `Delete` / `Backspace` |
| 复制图层 | `Ctrl/Cmd + D` |
| 复制选中对象 / 参数 | `Ctrl/Cmd + C`（多帧画板内可 `Ctrl/Cmd + V` 新建图层） |
| 撤回 / 重做 | `Ctrl/Cmd + Z` / `Ctrl/Cmd + Shift + Z`（或 `Ctrl/Cmd + Y`） |

注意：焦点在输入框 / 文本域里时，浏览器原生复制粘贴优先，快捷键不会抢。

---

## 4. 素材库与多帧画板

### 4.1 当前工程与总素材库

- **当前工程**：只显示这个工程里的素材；
- **总素材库**：跨工程汇总。第一次切过去且存档服务可用时会自动同步一次，也可以手动点「同步在线存档素材」；
- 同步只读取**服务器上现有的存档**并据此重建，不会无限累积已删工程的历史条目；当前工程最后并入；
- 总库里单击 / 拖动 = 先把素材复制进当前工程，再放置；已在当前工程的会标「已在工程」；
- 总库只存在本浏览器（localStorage），配额不足会提示，可清空；清空不影响已加入工程的副本。

### 4.2 导入与多帧素材

- 导入单张图片 = 一个普通素材；
- 一次选多张图片会先问：**合成为一个多帧素材** / **逐个添加**；
- 多帧素材是**一张横向拼版图**，按格子切帧（`font.charset = 'frames'`），卡片上显示的是**单帧尺寸 + 帧数**，不是整条拼版尺寸；
- 普通素材：单击打开放置 / 微调窗，拖动直接放到屏幕；
- 多帧素材：单击不弹窗，**双击打开多帧画板**，拖动直接放置；放到屏幕后是一个普通图片图层，用图层行的「帧」选第几帧；
- 默认素材库**只保留字体**（数字字模、小数字、ASCII）；LOGO / 电池 / 方向 / BLE / KRPM 等图片默认素材已清理，需要时请从自己的素材库导入，或从工程素材里取。字体帧数仍来自元数据，不靠图片宽度猜。

### 4.3 多帧画板

「多帧画板」用来把多张图 / 多段文字做成**一张多帧素材**：

- 每帧是一块同样尺寸的小画布，可以放多张图片、多段文字（各自有位置 / 可见性）；
- 支持帧排序、增删帧、逐帧播放、上一帧残影、1×/2×/4× 缩放、自动尺寸；
- 支持「加入素材库」或直接放到屏幕；
- 导出仍是**一张多帧素材**：图层行选帧，勾「导出所有帧」时导出一个连续数组 + 按 id 取帧的函数。

> **这不是字库。** 多帧画板产物是普通图片帧组（例如 KRPM 那种 2 帧图标），没有字符码表，也不参与字模拆条。要做「一个字符一格、按字符码取模」请走第 5 节的字库 / 系统字流程。

### 4.4 文字快照

用「＋文字」建出的**固定文字 / 系统字图层**会自动生成一份「文字」素材快照，改文字原地更新，删图层且没被当图片用时自动收回。数字层和 ASCII 字库层是动态 / 整表内容，不生成静态快照。

---

## 5. 文字、数字、系统字与 ASCII 字库

所有文字内容都在同一个「＋文字」弹窗里，顶部先选**来源**：

| 来源 | 适合 | 说明 |
|---|---|---|
| 字库素材 | 已拆分的位图字库 | 一个字一格，可拼字或刷数字 |
| 系统字库 | 大号数字、中文、任意字号 | 用浏览器字体渲染，字号随意 |

内容有三种：

| 内容 | 导出形态 | 说明 |
|---|---|---|
| 固定文本 | 一张静态图片（可选再加按 id 取图的字模表） | 所见即所得；可关闭「函数名」省 Flash |
| 数字（变量） | `UI_FIELD` + `UI_FONT` | 这一层自己的像素**不导出**，固件用字库画变量；最省 Flash |
| ASCII 字库 | 95 个字形（0x20–0x7E）的 GRAY8 字模表 + 两个函数 | 仅系统字来源可用；固件可打任意字符串 |

### 5.1 数字（变量）

- 变量名默认由图层名生成（`Speed` → `g_uiSpeed`，中文名回退 `g_uiVal`）；
- 可设小数位、格数、对齐、补前导零、底色、预览值；
- 预览与固件 `UI_FormatNum` 同口径；放不下会提示；
- 字模取自所选字库（字库格多大，数字就多大）；没有字库素材时退回内置 8×11 ASCII 字库；
- 数字字模会整组裁掉上下全空行，字高记录在 `rowTrim`，预览 / 导出跟着用；
- 变量名支持结构体成员：`motor.speed` / `motor->speed` 原样导出成 `&motor.speed`（固件侧需保证该地址可见，见第 6.2 节）；
- 负字距在数字模式下只能收窄格子，下限是「最宽字迹」；文字模式下可以真正叠字。

### 5.2 系统字

- 内置字体：**MiSans**（默认）、**HarmonyOS Sans SC**、**OPPO Sans 4.0**（可变字重）；
- 也可加载本地 `.ttf / .otf / .woff / .woff2`；自定义字体会随工程 JSON / 在线存档保存，并在一键导出时带上原文件；
- 字重按 PS 叫法（Light / Regular / Medium / DemiBold / Bold…）；可变字体可用滑杆连续调；
- 支持字距（可为负）、行距、边缘斜坡 σ、光晕 σ；改字体后会自动等字体加载完再画，避免把回退字体的字模烘进导出物；
- **逐字微调**见第 9 节。

### 5.3 ASCII 字库

选「系统字库 + ASCII 字库」时，会按当前字体 / 字号把 `0x20`–`0x7E` 共 95 个字符渲染成一张二维字模表，并额外生成：

```c
void <名字>(x, y, id, color, bg);              /* id = 字符码 − 0x20 */
void <名字>Str(x, y, "任意串", color);          /* 逐字取模；空格 / 越界跳过 */
```

这一层显示的示例文本仍会作为普通静态图导出；真正给固件用的是整份字模表。

---

## 6. 图层、页面与导出物

### 6.1 图层行

右栏每个图层有两到三行：

- **第一行**：类型（图 / 文 / T / ◯）、名字、数字 / ASCII / 组标记、几何、`⌂` 归零、`🔒` 锁定、`⚙` 属性；
- **第二行**：
  - **页**：按钮组，一个图层可以同时在多页（素材只导一份）；
  - **仅尺寸**：只导出坐标 / 尺寸，帧表 `.px = 0`；
  - **仅素材**：不进页，素材照常导出，画不画由固件决定；
  - **内部 / 外部 / LZSS**：三选一（见第 7 节）；
  - **帧**：`-1` = 仅网页渲染（固件 `.index = 255`，只清底色）；`0..N-1` = 画第几帧（`0` = 第 1 帧）；
- **第三行**：数字层的只读状态，或 ASCII 层的 `Str()` 状态。

图层顺序即 z 序（底 → 顶）；支持方向键移动、`Del` 删除、`Ctrl/Cmd + D` 复制、撤回 / 重做。

### 6.2 页面模型

页号是「这一层属于哪一页」的唯一真值，也是生成的函数名后缀：

| 页号 | 含义 | 说明 |
|---|---|---|
| `0..9` | 正常页 | 按键切页按序号循环；空页也会导出（进去是清屏） |
| `-1` | 关机空白 | 放不了图层；`LCD_UI_Goto(-1)` = 出旧页 + 停刷新 + 清屏 |
| `-2` | 关机充电 | 特殊页，只有固件状态机能进 |
| `-3` | 低电 | 特殊页 |
| `-4` | 开机 LOGO | 特殊页，通常配「定时跳转」自动进正常页 |

- 每页可设**数字刷新周期**（整页共用一个）和**定时跳转**（进页后 N ms 自动 `LCD_UI_Goto(目标页)`）；
- 页可以「隐藏」：板子上进去只清屏，不画内容也不自动跳页；特殊页只能隐藏，不能删除；
- 生成的切页 API：`LCD_UI_Setup()`（面板初始化后一次，不进页）、`LCD_UI_Goto(page)`、`LCD_UI_NextPage(cur)`、`LCD_UI_Page()`；
- 定时器由固件 main loop 的 `timer_loop()` 驱动，不需要额外的 1 ms 轮询；
- 如果固件自己维护 `sys.page`，在 `ui_user.h` 里加 `#define UI_PAGE_CHANGED(p) (sys.page = (int8_t)(p))`，否则定时跳转后固件状态会和屏幕对不上；
- 数字表绑定变量必须是 `int32_t`（或通过宏指向一个 `int32_t`）；`.src` 是静态初始化，只能写 `&对象` / `&对象.成员`，不能写函数调用。结构体成员写法由 `ui_user.h` 里的 `UI_SRC_*` 宏负责让结构体类型可见。

### 6.3 导出文件清单

一键导出生成的文件（数量随工程内容变化）：

| 文件 | 何时生成 | 内容 |
|---|---|---|
| `ui_color.h` | 总是 | 本工程用到的 `UI_COLOR_*` 颜色宏 |
| `ui_table.c` / `ui_table.h` | 总是 | 帧表、`UI_FIELD` 表、`UI_DrawStatic()`、声明、`UI_FRAME_N` / `g_uiFrames[]` |
| `ui_assets_int.c` | 总是 | 内部 Flash 素材（`const uint8_t[]`；可能为空） |
| `ui_assets_ext.c` | 总是 | 外部 Flash 素材（`const uint16_t[] + UI_EXT_RO`；可能为空） |
| `ui_font.c` | 有字库 / 取图表时 | `UI_FONT` 结构体、文字层 / ASCII 取图与取帧函数 |
| `ui_task.c` / `ui_task.h` | 有图层时 | 每页 `LCD_<Page>_Enter/_Exit/_CB`、定时跳转、`LCD_UI_*` |
| `ring_config.h` | 总是 | 圆环 / 圆角矩形参数与编译期开关 |
| `ring_scan.h` / `ring_scan.c` | 有圆环时 | 可选的逐像素扫描表（沿弧坐标 + 档位映射） |
| `ui_assets_lzss.c/.h` | 有 LZSS 素材时 | 统一 `UI_Asset` 表 + `g_uiAssetBlob` |
| `lzss_decode.c/.h` | 有 LZSS 素材时 | 通用 LZSS 解码器 |
| `ui_asset_draw.c/.h` | 有 LZSS 素材时 | 渲染桥（顶层 2 个函数 + 内部接口） |
| `ui_user.h` | **只生成一次** | 你的变量声明 / LCD 头 / `UI_EXT_RO` 等宏；之后永不覆盖 |
| `lcd-project.json` | 一键导出时 | 工程备份（内嵌自定义字库） |
| `lcd-font-<name>.<ext>` | 有自定义字体时 | 实际被引用的字体原文件 |

字模**数据**在 `ui_assets_int.c` / `ui_assets_ext.c`，字模**代码**在 `ui_font.c`，属性表在 `ui_table.c`。`ui_font.c` 是新加的 `.c` 时，记得在 Keil 里右键分组 → Add Existing Files，否则会报 `Undefined symbol g_uiFont_xxx`。

### 6.4 图片属性 / 微调

双击普通图片图层（或从素材库单击）打开属性弹窗：

- **位置**：X / Y 精确输入、步进、九宫格对齐、居中；圆屏预设下多一个「圆内」，把当前图层缩到可用圆内；
- **尺寸**：目标像素宽 / 高、锁定比例、逐级减半 + 高质量插值缩放；
- **格式**：`RGB565` / `RGB888` / `Gray`，切换后右栏模板跟着变；
- **颜色**：从工程 `Color_t` 枚举（244 色）选或自定义，导出 `{color}` / `{colorHex}` / `{colorName}`；另有镜像、裁切窗口、多帧选帧；
- 弹窗内实时预览量化 / 调制后的效果，可单独复制或下载这一份 C 数组。

---

## 7. 素材存储：内部 / 外部 / LZSS

图层第二行的「内部 / 外部 / LZSS」是**三选一互斥**：

| 选择 | 值 | 像素去向 | 生成物 |
|---|---|---|---|
| 内部 | `store = 'int'` | 内部 Flash，`const uint8_t[]` | `ui_assets_int.c` |
| 外部 | `store = 'ext'` | 外部 Flash，`const uint16_t[] + UI_EXT_RO` | `ui_assets_ext.c` |
| LZSS | `store = 'lzss'` | 统一压缩表 + `g_uiAssetBlob` | `ui_assets_lzss.c/.h` |

- 旧工程的 `inst.ext` 布尔会在载入 / 撤回 / 导入工程时自动迁移成 `inst.store`（`normalizeInstanceStores()`），不需要手工改 JSON；
- 外部素材的 `UI_EXT_RO` 宏定义在工程自己的 `ui_user.h` 里（例如 `__attribute__((used, section("ER_EXTUI")))`），导出不覆盖这个文件；
- LZSS 图层**不再生成独立素材数组**，帧表里写 `.px = 0`、`.asset = UI_ASSET_<key>`、`.assetChunks = <片数>`；`仅尺寸` 层写 `UI_ASSET_NONE` / `0`；
- 同一个工程可以混用内部 / 外部 / LZSS，渲染桥同时支持 raw 和压缩两条路。

> **LZSS 统计口径（重要）**：右栏「导出到文件夹」下方的 LZSS 概览，只累计**走 LZSS 的素材**——LZSS 图层的像素、LZSS 字库 / 取图表、字模左右条。**内部 / 外部 raw、`ui_table` / `ui_task` 代码、解码器 / 渲染桥、工程 JSON 都不计入。** 因此即使这里显示几十 KB，也不能当成整个导出包或固件增量的体积；它只是 LZSS 这一部分（压缩字节 + 单独列出的表字节）。

---

## 8. LZSS 格式（移植者）

### 8.1 一张表 + 一个 blob

LZSS 素材全部进同一张 `UI_Asset` 表：

```c
/* ui_assets_lzss.h */
typedef struct {
    uint16_t off;      /* g_uiAssetBlob 偏移 */
    uint16_t clen;     /* 压缩流长度 */
    uint16_t w, h;     /* 片宽 / 片高（像素） */
    uint16_t y;        /* 片在整帧里的 y 偏移（帧分片只按行） */
    uint8_t  fmt;      /* UI_FMT_RGB565 = 0 / UI_FMT_GRAY8 = 1 */
    uint8_t  flags;    /* 预留，当前为 0 */
} UI_Asset;            /* 12 B / 项 */
```

- `rawlen = w * h * (fmt == UI_FMT_GRAY8 ? 1 : 2)`，不占表项；
- 表项顺序 = ID 顺序；每一片都可以独立解压，取第 N 帧 / 第 N 个字形不需要从头解；
- **没有 x 偏移**：帧分片只按行切，表项用 `y` / `h` 描述这一片在整帧里的位置；
- 每组生成三个宏：

```c
#define UI_ASSET_<key>    <首片 ID>
#define UI_ASSET_<key>_N  <帧数 / 字形数>
#define UI_ASSET_<key>_C  <每帧 / 每字形的片数>
```

- `UI_ASSET_NONE = 0xFFFF`；`UI_ASSET_COUNT`、`UI_ASSET_BUF_SIZE` 也在生成的头文件里，**不要自己数**；
- 相同帧 / 相同片会自动去重：多个表项可以指向同一段压缩流（`off/clen` 相同）；
- `off` / `clen` 是 `uint16_t`，所以**整个 blob 必须小于 64 KB**；单片压缩流超过 `uint16_t`、每帧片数超过 `uint8_t` 时导出会直接报错。

### 8.2 分片解码与 RAM

`exportOpts` 里两个开关：

| 字段 | 默认 | 作用 |
|---|---|---|
| `lzssChunked` | `true` | 是否按行分片 |
| `lzssChunkBytes` | `2400` | 每片目标字节数（最小 128） |

- 分片只影响**帧 / 图片**：按整行切，每片 ≤ `lzssChunkBytes`；如果单行本身就超过粒度，退化为 1 行 / 片，并给出警告；
- 关掉分片 = 一帧一块，RAM 变大、块数和绘制调用更少；
- `UI_ASSET_BUF_SIZE` = **实际最大片**，不是固定 2400；导出页显示的就是这个值；
- 解码缓冲是生成代码里的 `static uint8_t g_uiAssetBuf[UI_ASSET_BUF_SIZE] __attribute__((aligned(4)))`，**4 字节对齐**（RGB565 片会被 LCD 的 RAM 直传通路按 16 位读）。

导出页的 LZSS 概览（350 ms 防抖，拖拽时不算）显示：组数 / 块数、原始字节 → 压缩字节、节省百分比、表字节、解码 RAM、去重节省、逐项压缩率。再强调一次：**这些数字只覆盖 LZSS 部分**。

### 8.3 字模左右条

字模的左右条在**字库层**拆，不塞进通用帧表：

- `splitFontParts(set, chunkBytes)`：每个字形按列拆成 `parts` 片，每片 ≤ `min(2400, max(128, chunkBytes))`；
- 例：54×80 的字形按 2400 B 上限拆成 **27×80 + 27×80**，两片各 2160 B；
- 这个拆分**与帧分片开关无关**：即使 `lzssChunked = false`，字模也不会按 4320 B 整块算；
- `UI_FONT` 增加：

```c
typedef struct {
    const void *glyph;      /* 非 0 = raw 连续数组；0 = LZSS 字库 */
    uint8_t w, h, gap, first, count;
    uint16_t assetBase;     /* LZSS：第 0 片 */
    uint8_t assetChunks;    /* 每片再分几块（通常 1，但不要假设） */
    uint8_t parts;          /* 每个字形几片 */
    uint8_t partW;          /* 每片宽；最后一片可能更窄 */
} UI_FONT;
```

LZSS 字库按 **part-major** 排列：先放第 0 片的全部字形，再放第 1 片……第 `ch` 个字的第 `p` 片 ID 为：

```c
assetBase + (p * count + (ch - first)) * assetChunks
```

渲染时逐片解压，画到 `x + p * partW`；最后一片的宽度以表项 `w` 为准，不要用 `partW` 硬算。

通用 `UI_Asset` 表里没有「字模的第几片」字段，也没有 x 偏移；字模拆分只存在于 `UI_FONT` 的 `parts/partW` 和打包器的分组里。

### 8.4 生成的 LZSS 文件

| 文件 | 作用 |
|---|---|
| `ui_assets_lzss.c` | `g_uiAssetBlob[]` + `g_uiAssets[]` |
| `ui_assets_lzss.h` | `UI_Asset`、`UI_FMT_*`、`UI_ASSET_*`、`UI_ASSET_BUF_SIZE`、`UI_DrawAsset` 声明 |
| `lzss_decode.c/.h` | 通用解码器，无工程常量、无 malloc / stdio |
| `ui_asset_draw.c/.h` | 渲染桥：顶层 2 个函数 + 内部 `UI_DrawAsset` / `UI_DrawGlyph` |

已移除、不再生成：`ui_assets_packed.c`、`asset_blocks.h`、`asset_lzss.c/.h`，以及旧的固定块布局。

> 从旧目录导出时，如果这些旧文件还在，导出状态栏会提醒；请同时从 Keil 工程里移除它们，否则会出现重复定义 / 布局冲突。

### 8.5 渲染桥 API

`ui_asset_draw.h` 暴露的接口：

```c
/* 顶层业务代码只用这两个；id = g_uiFrames 下标，也就是 g_uiFrameN 的 N */
void UI_DrawFrame(uint16_t id, uint16_t color);                       /* 用帧表里的 x / y */
void UI_DrawFrameAt(uint16_t id, uint16_t x, uint16_t y, uint16_t color); /* 指定坐标 */

/* 内部：UI_FIELD.frames 是指针数组，动态区域用这两个 */
void UI_DrawFrameRef(const UI_FRAME_REF *f, uint16_t color);
void UI_DrawFrameRefAt(const UI_FRAME_REF *f, uint16_t x, uint16_t y, uint16_t color);

/* 内部：字库绘制；raw 和 LZSS 左右条都走它 */
void UI_DrawGlyph(const UI_FONT *ft, uint8_t ch, uint16_t x, uint16_t y,
                  uint16_t color, uint16_t bg, uint8_t mirror);
```

- `UI_DrawFrame(id, ...)` 内部自动处理 raw / LZSS / `index == 255`（只清底色）/ mirror；
- 动态区域的 `UI_FIELD.frames` 是 `const UI_FRAME_REF *const *`，不能直接传给 id 版，要用 `UI_DrawFrameRef / RefAt`；
- 渲染桥里只有 3 个 `static` 函数直接对接 LCD：`ui_blit_gray` / `ui_blit_rgb` / `ui_fill`。换屏只改这 3 个；
- **只有工程里存在 LZSS 素材时**才生成 `ui_asset_draw.*`，并把生成的 `UI_DrawStatic` / 页面任务改成 `UI_DrawFrame(id, color)`；
- 没有任何 LZSS 素材时，导出仍生成旧的指针版 `UI_DrawFrame(&g_uiFrameN, color)`，不生成渲染桥，现有固件可以继续编译。

### 8.6 固件侧需要补什么

| 位置 | 需要 |
|---|---|
| `UI_FRAME_REF` | 追加 `uint16_t asset; uint8_t assetChunks;`（`.px = 0` 且 `.asset != UI_ASSET_NONE` 时走解压） |
| `UI_FONT` | 追加 `uint16_t assetBase; uint8_t assetChunks, parts, partW;` |
| `ui_table.h` | 提供 `UI_FRAME_N` 和 `extern const UI_FRAME_REF *const g_uiFrames[UI_FRAME_N];` |
| `app_ui.h` | 声明 `UI_DrawFrame(uint16_t id, ...)` / `UI_DrawFrameAt` / 内部 `UI_DrawFrameRef(At)` / `UI_DrawGlyph` |
| `app_ui.c` | **删掉旧的 `UI_DrawFrame(const UI_FRAME_REF *, ...)` 实现**（新实现在 `ui_asset_draw.c`，否则重复定义） |
| `UI_DrawField` / 电池等 | 持有 `UI_FRAME_REF *` 的地方改用 `UI_DrawFrameRef(f, color)` |
| 解码器 | 使用 `lzss_decode.c/.h` 的 `LZSS_Decode(src, clen, dst, rawlen, cap)`，不要再使用 `Asset_Decode` |
| 缓冲 | `g_uiAssetBuf` 必须 4 字节对齐，大小取 `UI_ASSET_BUF_SIZE`，不要写死 2400 |
| 尺寸 | 表项 `off/clen` 是 `uint16_t`，整个 blob < 64 KB；`UI_ASSET_BUF_SIZE` 由实际最大片决定 |

移植顺序（摘要）：

1. 用最新网页重新导出一份（逐字微调已经烘进像素，不要拿旧 `ui_font.c` / `ui_table.c` 当输入）；
2. 在 `app_ui.h` 里**追加**结构体字段和函数声明（追加到末尾，旧 raw 初始化器仍可编译）；
3. 把 `ui_assets_lzss.c/.h`、`lzss_decode.c/.h`、`ui_asset_draw.c/.h` 加进工程；同时移除旧 `ui_assets_packed.c`、`asset_blocks.h`、`asset_lzss.c/.h`；
4. 删掉 `app_ui.c` 里旧的 `UI_DrawFrame` 实现；
5. 把动态区域 / 电池等指针调用改成 `UI_DrawFrameRef`；
6. 把 `ui_draw_glyph` 的压缩分支改成 `UI_DrawGlyph`；raw 字库也走它，不要留两条路；
7. 先做 host 端解码 round-trip，再上板看数字 / 电池 / 多帧；
8. 编译报错按第 8.7 节排查。

更完整的移植说明、字段定义和错误对照见 [`docs/porting-lzss-internal-flash.md`](docs/porting-lzss-internal-flash.md)。

### 8.7 最常见的坑

| 现象 | 原因 |
|---|---|
| LZSS 帧全空白 | 固件还在 `if (!f->px) return;`。`.px == 0` 不等于没东西，要先看 `.asset` |
| `redefinition of 'UI_DrawFrame'` | `app_ui.c` 里的旧实现没删 |
| `UI_FRAME_REF has no member named 'asset'` | 结构体没追加字段 |
| `undefined reference to 'UI_DrawFrameRef'` | `ui_asset_draw.c` 没加进工程，或还在用指针版调用 |
| `undefined reference to 'LZSS_Decode'` | `lzss_decode.c` 没加进工程 |
| `duplicate symbol Asset_Decode` | 旧 `asset_lzss.c` 还在工程里 |
| 字模左右错位 / 被切 | 没按 `parts/partW` 画，或最后一片宽度用了 `partW` 而不是表项 `w` |
| 明明有 LZSS，生成的却是指针版调用 | 工程里没有任何一层选 LZSS；或导出的是旧文件 |
| 多帧只画第 0 帧 | raw 路径没按 `.index` 算偏移；LZSS 路径没按 `.index * .assetChunks` 跳片 |
| 解码 RAM 比预期大 | 用了不分片，或某一行本身就超过分片粒度；看导出页警告 |

---

## 9. 系统字逐字微调

系统字层（数字 / ASCII / 固定文本）标题栏、`⤓ 图片下载` 左侧有「**逐字微调…**」：

- 每个字符可以在自己的格子里左右偏移 **-32..+32 px**，专门修系统字常见的 1 px 抖动（例如数字 2/3 交替时整格左右跳）；
- **最终格子尺寸 = 所有字形叠加区域的最大尺寸**：偏移把字挤出原格子时，格子会向左 / 右扩，而不是裁掉；
- 「自动对中」把每个字的字迹中心对到格子中心，一次修一整组；「全部清零」恢复原样；也可以单字 `-1 / +1 / 归零`；
- 偏移存在 `sysfont.glyphDx`（工程 JSON / 图层配置里），下次还能继续调；旧字段 `digitDx` 仍会读取；
- **偏移在导出时已经烘进字模 / 图片像素**：C 代码里没有 `glyphDx` 字段，固件不需要运行期偏移；改完偏移必须**重新导出**一次，导出物不会自己跟着 JSON 变；
- 数字 / ASCII 能直接看到字模叠加预览；固定文本没有独立字模表，偏移作用在整串渲染上。

---

## 10. 圆环引擎

网页里的圆环 / 圆角矩形与固件使用同一套整数几何（覆盖率查表、整数 atan2、Q8 距离、周长参数），勾选「按 MCU 的真实算法预览」时可以逐像素对拍。

| 能力 | 说明 |
|---|---|
| 形状 | 圆形 / 圆角矩形（外圆角、环厚、内缩、内圆角自动或手填） |
| 进度弧 | 起始角 / 结束角、顺 / 逆时针、平口端帽 |
| 颜色 | 轨道色 / 进度色；渐变目前**只在网页预览生效**，导出取第一档颜色（固件仍是单色） |
| 白斑 | 开关、宽度、亮度、沿路径旋转；白斑方向与进度方向独立 |
| 立体感 | 断面方向光，强度 / 凸起或凹陷 / 光源方位角；0 = 平色 |
| 抗锯齿 | 边缘 AA、沟槽 AA、端点 AA；分割段 / 槽深 / 相位 |
| 倒计时 | 静态进度 / 倒计时递减 + 拖尾 |
| 导出 | `ring_config.h`（参数 + 编译期开关）；可选 `ring_scan.h/.c` 逐像素扫描表 |

- **一个工程只支持一个环**：板子上是单例引擎（一套窗口缓冲 + 一个定时器）。素材栏的「◯ 圆环」在已有环时禁用；要换形状就在这个环的弹窗里改；
- `ring_config.h` 里的开关都是 `#ifndef` 包裹的编译期默认值，方便主机侧用 `-D` 覆盖；几何 / AA / 白斑开关改了要重新导出再编译；
- 运行期可改颜色、进度、转速、方向、白斑等（`Ring_Set*`），但改不了形状 / 几何；
- 圆环参数不参与图层导出，也不会进 `ui_table.c`；它只通过「哪一页有圆环」影响页面的 `Enter / Exit`；
- `ring_config.h` 仍然是**数值**，不走 `UI_COLOR_*` 颜色宏（主机脚本 / 对拍直接读）。

几何细节和固件逐像素契约见 [`docs/ui-export-redesign.md`](docs/ui-export-redesign.md)。

---

## 11. 屏幕预设与圆屏

内置 10 条预设（每条都可改，也可另存自定义预设）：

| 预设 | 尺寸 | 说明 |
|---|---|---|
| `1.28R-240x240-` | 240×240 | GC9A01 圆屏 |
| `1.2-128x128` | 128×128 | ST7735S 方屏；+32 偏移由驱动的 `LCD_Address_Set` 处理，导出坐标仍是 0–127 |
| `1.9吋` | 170×320 / 320×170 | 横竖各一条 |
| `1.14吋` | 135×240 / 240×135 | 横竖各一条 |
| `3.2吋` | 240×320 / 320×240 | 横竖各一条 |
| 240×170 | 240×170 / 170×240 | 横竖各一条 |

屏幕预设弹窗里可改：

- 宽 × 高、是否圆屏、圆屏可用区（留空 = 内切圆，也可手填圆心 / 半径）；
- **背景色**：预览底色、导出图片底色、导出 C 的 `UI_PAGE_BG`、圆环 AA 的淡出目标，四处同一个值；
- 默认格式、Gray 打包方式（`u8` = 8 bit 灰度数组；`g565` = 装进 G 字段的 `uint16_t`）、RGB888 是否用宏；
- 三套指令模板（RGB565 / RGB888 / GRAY）与头 / 尾代码；
- 预设管理：新建 / 复制 / 删除 / 补内置 / 重置内置。内置预设每次加载都会从代码合并，自定义预设和改过的内置项单独保存。

圆屏相关：

- 预览会把圆外区域压暗，并给四角出圈的图层红色警告；
- 图片属性弹窗里可点「圆内」，把当前图层缩到可用圆内；
- 导出图片可选「圆周细线 / 圆外压暗 / 不要」，只影响 PNG，不影响预览蒙版。

---

## 12. 工程存档、一键导出与导出图片

### 12.1 工程条

右栏顶部只有一行工程条：

```text
★ 当前工程名  ● 240×240  [JSON⤓] [JSON⤒] [保存] [⚙] [⌄]
```

- **★ / 工程名 / ⌄** 打开浮层，不占常驻高度；
- **在线存档**（可选）：一行一份，点行 = 快速切换；右侧可复制直链 / 删除。需要同源的存档服务；没有服务时用工程 JSON；
- **未保存 / 切换前暂存**：切走前自动把当前未保存工程暂存一份（本页内存，最多 4 份），浮层里可「返回」；刷新页面会丢；
- **保存 / 另存**：档名 + 保存 / ＋新建。同名保存时：尺寸相同 → 确认后覆盖；**尺寸不同（含圆屏标记）** → 自动改名 `<档名>-<宽>x<高>[-圆]`，原档不会被覆盖；
- **＋新建** 用 `lcd-日期-宽x高[-圆]` 生成不撞车的档名并保存；
- **JSON⤓ / JSON⤒**：导出 / 导入整套工程（素材、图层、页面、屏幕预设、自定义字库、导出目录记录）；导入会替换当前工程，可撤回。

浏览器会自动把工程保存在 localStorage；在线存档 / 工程 JSON 是跨机器备份手段。

### 12.2 一键导出到文件夹

「一键导出到文件夹」把第 6.3 节的文件一次写进**当前存档自己的**导出目录：

- **每个存档独立目录**：目录名和本机句柄跟着工程走；切换存档后不会沿用上一个工程的目录。目录下方有「选择…」可随时换；
- 目录句柄存在浏览器 IndexedDB；换机器 / 清缓存后失效，会按工程 JSON 里的目录名提示重新选择（不会猜路径）。选完记得保存工程，让 JSON 更新；
- **覆盖前二次确认**：目标目录已有同名文件时，先列出文件，三选一 **继续覆盖 / 修改路径… / 取消**；`ui_user.h` 这类只生成一次的文件始终不覆盖；
- **只带当前用到的字库**：`lcd-font-*` 和工程 JSON 的 `fonts` 只包含当前工程实际引用的自定义字体；加载过但没用到的字体不导出；
- **权限失败 / 不支持写文件夹 → ZIP 兜底**：打成一个 `<前缀>-YYYYMMDD-HHMM.zip` 下载，不再散落一堆文件；只有 ZIP 本身失败才退回逐个下载；
- 写入完成后状态栏会列出：写入数量、新出现的 `.c`（需要手动加进 Keil）、保留下来的 `once` 文件、LZSS 体积 / 解码缓冲、旧文件提醒。

### 12.3 导出图片

| 位置 | 导出什么 | 尺寸 |
|---|---|---|
| 右栏 · 导出图片 | 当前预览窗口那一帧（屏幕底色 + 所有图层） | 屏幕分辨率 1:1 |
| 图片属性 / 微调弹窗 | 这张素材 | 素材原始尺寸（多帧 = 整条拼版） |
| 帧管理弹窗 | 整条素材；每格另有 `⤓` | 素材尺寸 / 格子尺寸 |
| 字库拆分弹窗 | 拆出来的所有格子排成一条 | 格子尺寸 |
| 文字 / 数字弹窗 | 当前预览（拼字图 / 显示区那一条 / ASCII 16 列整表） | 原始像素 |
| 多帧画板 | 当前帧 | 画布尺寸 |
| 圆环弹窗 | 实时预览那只圆环（圆外透明） | 圆环自身尺寸 |

导出的都是**屏幕 / 素材本身的像素**，不含网格、选中框、对齐线、警告等编辑辅助。屏幕底色在「屏幕预设 → 背景色」里改。

---

## 13. 颜色宏与指令模板

### 13.1 颜色宏 `ui_color.h`

每次导出都会生成 `ui_color.h`，把 RGB565 颜色变成按名字的 `#define`：

- **只列本工程实际用到 / 模板里引用的颜色**（通常几条到十几条），不是全 244 色表；完整 `Color_t` 表仍在固件头文件里；
- 表里没有精确名字的自定义色追加为 `UI_COLOR_RGB565_1234`；
- 导出的 `.color` / `.bg` / `.lineColor` / `UI_PAGE_BG` / `UI_DrawFrame(..., 颜色)` 都引用宏，不再写死 `0xFFFF`；`ui_table.h` 自动 `#include "ui_color.h"`；
- 模板里 `{color}` = `UI_COLOR_*`，`{colorHex}` = 原值 `0xXXXX`，`{colorName}` = 最近的枚举名；
- `ring_config.h` 例外：它是圆环引擎的参数文件，主机脚本 / 对拍直接读，仍是数值。

### 13.2 指令模板与通配符

模板跟着**屏幕预设**走，入口是工程条里的 `⚙`（不在右栏常驻）。每行一条，按图层顺序输出。常用通配符：

```text
{x} {y} {w} {h}       实例几何（实时）      {pic} / {name}   数组名 / 图层名
{color}               UI_COLOR_* 宏        {colorHex}       0xXXXX RGB565
{colorName}           最近 Color_t 枚举名   {mirror} {i}     镜像 / 序号
{len} {lenBytes}      数组元素数 / 字节数   {sw} {sh}        屏幕宽高
{fmt}                 格式
TEXT 专用:            {gw} {gh} {idx} {ch} {text}
TEXTFN 专用:          {charset}
```

默认模板（可按屏改）：

| 格式 | 模板 | 素材数组 |
|---|---|---|
| RGB565 | `LCD_drawImage({x}, {y}, {w}, {h}, {pic}, 0xFFFF);` | 内部 `const uint8_t[]`（RGB565 高字节在前）/ 外部 `const uint16_t[]` |
| RGB888 | 同上（`RGB888(R,G,B)` 宏在编译期压成 565） | 同上 |
| GRAY | `LCD_drawGrayImage({x}, {y}, {w}, {h}, {pic}, {color}, {mirror});` | `const uint8_t[]` 8 bit 灰度 |

若屏幕预设的 Gray 打包方式选 `g565`，则改用 `LCD_drawImage(...)`，灰度值装在 G 字段里。

---

## 14. 测试与自检

```bash
npm run check          # = check:logic + check:ui
npm run check:logic    # 纯逻辑 / 导出自检（约 20 项）
npm run check:ui       # 用 Vite SSR 真渲染各面板，防 SFC 白屏
npm run check:lzsspack # 只跑通用 LZSS 自检
npm run build          # 生产构建
```

`check:logic` 覆盖：

- 圆屏几何、圆环弧段 / 范围 / 分割 / 扫描 / 圆角矩形整数几何；
- 在线存档命名与尺寸判定、ZIP 兜底、颜色宏、store 行为（撤回、预设存储、导出目录、字库过滤）；
- 图层导出、素材导出、多文件独立编译、一键导出物**用 gcc 逐个 `.c` 编译 + 链接运行**；
- 多行内容卡片、光晕、等距、导出图片、预览染色；
- **LZSS**：编解码 round-trip、分片 / 去重、表与 ID、生成 C 文本、字库 / 取图函数。

`check:export-keil.mjs` 需要 PATH 里有 `gcc`（它会把生成物真的编译并运行一遍）；没有 gcc 时这一项会失败。

LZSS 的专项自检是 `scripts/check-lzsspack.mjs`；旧的 `check-assetpack.mjs` 已删除。`check-export-keil.mjs` 里也有 LZSS 集成用例（表项数 / 统计 / RAM / 渲染桥 / 字库）。

---

## 15. 已知限制与常见坑

- **分片只按行**：帧 / 图片不能按列或任意矩形分片；字模左右条是字库层的特例，不在通用帧表里。
- **LZSS blob < 64 KB**：`off/clen` 是 `uint16_t`；素材很多时要拆工程或减少压缩素材。
- **字模 `glyphDx` 不在 C 里**：改完逐字微调必须重新导出；不要在固件里再补一层运行期 dx。
- **圆环渐变只用于网页预览**：`ring_config.h` 取第一档颜色，固件是单色。
- **一个工程一个环**：多环的其余参数会被忽略。
- **`ui_user.h` 只生成一次**：之后的导出不会覆盖它；删掉它才会重新生成，里面的手工修改会丢。
- **旧压缩文件要手动移出 Keil**：`ui_assets_packed.c`、`asset_blocks.h`、`asset_lzss.c/.h` 不再生成，但可能还躺在旧目录里。
- **在线存档是可选能力**：没有配套存档服务时，保存 / 快速切换不可用，请用工程 JSON；本地 localStorage 仍然自动保存。
- **文件夹直写需要 Chromium 内核 + 安全上下文**：否则自动 ZIP；ZIP 文件名里的日期是本机时间。
- **数字层的负字距只能收窄格子**：固件逐格画，不能真正叠字；文字模式才可以。
- **`ui_font.c` 是新文件**：Keil 不会自动编译，需手动加入分组。

---

## 16. 代码地图、文档与许可

### 16.1 代码地图

| 路径 | 职责 |
|---|---|
| `src/store.js` | 全局状态 + 所有动作（素材、图层、页面、存档、导出、撤回） |
| `src/layerexport.js` | 图层 → 帧表 / 页面任务 / 字库代码 |
| `src/uiexport.js` | 像素 → C 数组、字模表、取图函数、模板 |
| `src/lzss.js` / `src/lzsspack.js` | 通用 LZSS 编解码 / 统一素材表打包 |
| `src/ringrender.js` / `src/ringscan.js` | 圆环与圆角矩形的整数几何 / 扫描表 |
| `src/frameshoot.js` | 预览帧与弹窗图片导出（PNG） |
| `src/colordef.js` | RGB565 → `UI_COLOR_*`、`ui_color.h` |
| `src/archive.js` / `src/zip.js` | 存档命名 / 尺寸判定、ZIP 兜底 |
| `src/components/` | 三栏面板与各编辑弹窗 |
| `scripts/check-*.mjs` | 零依赖自检（Node 直接跑） |

### 16.2 文档

- [`docs/ui-export-redesign.md`](docs/ui-export-redesign.md)：图层驱动导出、页面模型、多文件规则、固件接线；
- [`docs/porting-lzss-internal-flash.md`](docs/porting-lzss-internal-flash.md)：从旧素材层迁到「内部 Flash + LZSS 表 + 字模 parts」的移植建议、字段定义、错误对照。

### 16.3 许可

本项目以 **MIT License** 发布。仓库：<https://github.com/Huyil/MCU-LCD-Studio>

欢迎提 Issue / PR；提交前请跑 `npm run check`。
