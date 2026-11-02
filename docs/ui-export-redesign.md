# UI 导出改造规格（图层驱动）

现状：导出已跟着**编辑器图层**走（`layerexport.js`）；多行内容在素材库「＋ 文本框」弹窗里编辑，
分割线在该弹窗的预览里点/拖，图层的动态值在图层列表第二行设置。

## 一、已完成（本轮）

新增 `src/layerexport.js`（纯逻辑，可 node 自检）+ `scripts/check-layerexport.mjs`（11 项断言全过）：

| 能力 | 说明 |
|---|---|
| **图层驱动导出** | `collectLayerPlan(instances, assets)` 遍历图层：`ring` 跳过（参数走 `ring_config.h`）、无素材跳过、其余每个图层一项 |
| **内/外 flash 分流** | 图层项带 `ext` 标志 → 素材分别进 `ui_assets_int.c` / `ui_assets_ext.c`；数组名跟帧表同号：`g_uiFrame0_int` / `g_uiFrame0_ext`（动态层没有帧，基名 `g_uiField0`）|
| **不需要手写表** | 自动产出 `UI_FRAME_REF` 帧表；**静态图层**生成 `UI_DrawStatic()`（逐条 `UI_DrawFrame`）；**动态图层**（带 `bind`）生成 `UI_FIELD` 表项 |
| **灰度字库** | 有数字动态区域时自动附上 `UI_FONT g_uiFontNum`（ASCII 32..57，8×11 灰度） |
| 验收 | 产物与固件真 `app_ui.c` 一起 gcc 编译运行；1 个动态区域、静态/动态都确实发生绘制 |

### 1b. 文本框弹窗（多行内容 → 分割线 → 帧素材）

素材库顶部按钮「**＋ 文本框**」打开 `src/components/MultiLineDialog.vue`（弹窗，不再往素材栏里塞常驻卡片）：

| 能力 | 说明 |
|---|---|
| 左栏 | 内容文本框（共用 `state.uiExport.text`）+ 字高/字距/行距 + 「加入素材库 (n)」 |
| 右栏 | 预览 + **分割区域列表**（一行 = 一段：`y 起–止`、高度 px、`帧` 勾选、颜色、删除、清空）|
| 预览内分割 | **点空白 = 从鼠标那一行切一段 · 按住线拖动 = 移动 · 双击线 = 删除**（细实线 = 勾了「帧」，虚线 = 只作参考）；区域按各自颜色实时渲染 |
| 顶部锚线 | 第一次分割会自动补一根 `y=0` 的锚线（它拥有最上面那段），**固定 0、不能拖/不能删**，所以顶部/底部都不用手动加线（底部那段由最后一条线拥有，天然到内容底）|
| 窄条 | 「每 N px 均分」= `linesEvery()` 从 0 到内容底均分（例：37px 填 2 → 19 段，末段 1px）；列表显示的是**区域**而不是线 |
| 命中精度 | `pickRow()` 扣掉画布 1px 边框后按位图高度换算（否则越往下越偏）；抓线容差按屏幕像素算，1~2px 窄条也点得出来 |
| 加入素材库 | 勾「帧」的段用 `uiexport.packFrames()` **打包成一张多帧素材**（与图分割同一套模型：单张图 + `dir='row'` 竖排切格，`glyphW × glyphH` 一格 = 一段，矮段补 0）；每帧颜色存在 `font.frameColors` 里 |
| 放图层 | 拖到屏幕后一个图层显示一格（`inst.frame`），属性弹窗选第几帧会自动带出那一帧的颜色；**图层尺寸默认 = 该帧的内容框**（`font.boxes`，见下）|
| 省 flash | `packFrames` 另算每帧**内容框** `boxes=[{x,y,w,h}]`（去掉四周全 0 的边）：图层默认 `w/h = 框大小`、`crop = 框原点`，位置补回框偏移（画面不变）→ **每个图层导出的数组 = 自己内容的 px 数**，宽窄各不相同（例：56×13 的格子里 "LEVEL" 只导 39×10=390B，原来 728B）|
| 颜色贯通 | `store.addInstance()` 新图层颜色默认取素材 `font.color` → 分割线颜色一路走到 `UI_DrawFrame` 的 color |
| 验收 | `scripts/check-card.mjs`（灰度→画布逐字节→新图层尺寸/颜色/帧号→图层计划）+ `scripts/check-ui-render.mjs`（vite SSR 真渲染，防 SFC 白屏）+ `check-uiexport.mjs`（`pickRow` 逐行命中、`linesEvery` 窄条、`regionRows` 与 `splitRegions` 一致、`withTopAnchor` 锚线）|

### 1c. 图层第二行「值」（动态数字区域）

右栏图层列表每行下面是「值」行（`src/components/ExportPanel.vue`）：

- 勾上「值」→ `inst.bind = store.bindDefaults(inst.name)`：变量名默认由图层名生成（`Speed` → `g_uiSpeed`，中文名回退 `g_uiVal`）；
- 可改：变量名 / 小数位 / 格数 / 对齐 / 底色 / 补前导零；不勾 = 静态图层（画自己的像素）；
- 导出：`collectLayerPlan` 把 `bind` 带到 `tableForPlan` → 生成 `UI_FIELD` 数字项（`.src = &g_uiSpeed`、`.font = &g_uiFontNum`、`.dec/.cells/.align/.color/.bg`），
  该图层不再进 `UI_DrawStatic()`（由固件 1ms 任务 `UI_Tick()` 刷新）；
- **动态图层不占素材**：它自己的像素既不画也不导出（帧表里也没有它），所以勾「值」= 省下这一层的 flash；
- **画面预览按固件画法画数字**：`instanceProc` 走 `uiexport.formatNumText()`（与固件 `UI_FormatNum` 逐字一致）+
  内置 ASCII 灰度字库，按 `dec/cells/pad/bg/color` 画在图层位置；`bind.demo` = 预览值（只影响画面，不导出）；
- **「＋文字」与「T 系统字」已合并成一个弹窗**（`TextDialog.vue`，删掉 `SysFontDialog.vue`）：
  顶部固定「来源 / 字库 / 函数名」三行 —— 来源 = 字库素材（可拼字 / 刷数字）或系统字库（字号随意，适合大号数字/中文）；
  字库下拉列出**全部素材**并标出是否已拆分，没拆分的就地「拆分为字库…」（不再出现"选不了字库"）；
- **函数名 = 生成"按 ID 取图"的调用函数**（默认开，弹窗里可关并显示要花多少 flash）：
  导出物里真的带上 `const uint8_t <名字>Pic[N][M]` + `void <名字>(x, y, id, color, bg)` ——
  `id` 在范围内 → `LCD_drawGrayImage` 画第 id 张图，超范围 → `LCD_Fill` 填底色；
  弹窗预览与导出用**同一个生成器**（`uiexport.idDrawFunction()` / `cGlyphTable()`），不会两处不一致；
- **数字是「文字」的一种**（入口在「＋文字」弹窗，不在图层行）：
  - `TextDialog` 里选「内容 = 固定文本 / **数字 (变量)**」；数字模式下填 变量名 / 小数位 / 格数 / 对齐 /
    补前导零 / 底色 / 预览值，预览按 `formatNumText()`（与固件 `UI_FormatNum` 一致）画，放不下会红字提示；
  - **数字字模上下黑行自动裁掉**（`numFontFromGlyphs()`）: 一组字模里"谁都没墨"的**整行**不留 ——
    整组一起裁（不是每个字各裁各的），所以字模之间的对齐不变、宽度也不变，只是上下不再有空白行
    （典型：字库拆分时字高留大了，9×42 的格子实际字迹只有 20 行；或系统字的行框比字迹高）。
    裁完的字高会记录在 `rowTrim` 里，图层高度/预览/导出跟着用裁过的高度；整组全空则不裁（保留原格子）;
  - **数字的字号跟着所选字库走**：字库字格多大, 数字就多大 (16×22 的字库 → 16×22 的数字);
    导出时按 '-'..'9' 从字库里挑出数字用得到的那些字拼一份 `UI_FONT` (缺的补 0), 字段引用它;
    没有字库素材 (帧素材/普通图) 才退回内置 ASCII 8×11 —— 见 `uiexport.numFontFromGlyphs()` + `store.numFontFor()`;
  - **变量名支持结构体成员**: `motor.speed` / `motor->speed` 原样导出成 `&motor.speed`
    （`uiexport.cVarRef()` 校验；非法名退回合法标识符）;
  - **页面组合**: **每个图层**（静态图/文字/数字都算）在右栏图层行的设置行填「页」= `inst.page`;
    新建图层默认就是 `main`（**默认所有内容都在同一页**），旧存档没填的也按 `main` 处理;
    导出成 `ui_task.c` 里的**一页一组**:
    - `LCD_<Page>_Enter()` = 进页面的**初始化显示内容**: 先把这一页的静态图层按 z 序 `UI_DrawFrame` 画一遍,
      再把这一页的数字 `UI_DrawField` 各画一遍, 最后启动这一页的定时器;
    - `LCD_<Page>_CB(void *arg)` = 周期到点, 把这一页的数字重刷一遍 (**整个页面共用一个周期**);
      周期与**定时跳转**都在右栏图层列表上方的「**页面**」块里设置
      （`state.pages = { 页号: { period, jumpMs, jumpTo } }`），**数字层自己不再带周期**;
    - `LCD_<Page>_Exit()` = 出页面 `timer_stop`（有跳转的页还要 `timer_stop` 掉跳转定时器）;
    - `LCD_UI_Setup()` = 面板初始化后一次 (停干净 → 设表 → `UI_Init`), **不进任何页**;
    - `ui_task.h` 按页面自动声明这些函数; 只有静态层的页也有 `Enter`, 没有 `CB`/`Exit`;
  - **变量模式不带头/尾字符串** —— 前后字体/字号可能不同, 要加标签请单独放文字/图片层（`prefix`/`suffix` 已移除）;
  - **内置字体 + 字重**: 网页自带 **MiSans / HarmonyOS Sans SC / OPPO Sans 4.0**（原始 TTF 是全字库
    7~22MB/个，已按 4346 常用字——ASCII + GB2312 一级字库 + 常用标点——子集转 woff2，约 0.5MB/个，
    见 `src/assets/fonts/` 与 `src/style.css` 的 `@font-face`；OPPO 是可变字体一个文件覆盖 100~700）;
    **默认字体 = `MiSans`**（`store.DEFAULT_FONT`）; **字重按 PS 叫法**（Light / Regular / Medium /
    DemiBold / Bold…，`store.weightName()` 给任意数值取最近的样式名）：
    静态字体（MiSans 5 档、HarmonyOS SC 4 档）给**下拉选样式**，只有这些文件；
    **可变字体（OPPO Sans 4.0，`wght 100~700`）给滑块 + 数字，连续无极调节**（`fontInfo().variable` /
    `weightRangeOf()`）；粗体勾选 = 字重 700 的快捷方式;
    调字体前会 `await ensureFont()` 等字体加载完再画（并清渲染缓存），否则第一张会画成后备字体;
  - **换字体自动改名**: 名字还是"自动生成的样子"（`str_N` / `txt_N` / 任意**旧字体前缀**_N）时，
    换字体就跟着改成新前缀（`microsoft_yahei_1` → `misans_1`）；手动改过的名字不动;
  - **系统字的字距 / 行距**: 文字模式有「字距」「行距」（文本里按 Enter 换行 = 多行，行距生效）;
    **字距允许负数**（字挤在一起）: 文字模式直接负步进排版; 数字模式因为固件 `UI_FONT.gap` 是 `uint8_t`,
    负数改成**把字模格子收窄**（右侧裁掉, 与固件按格画一致），正数才写 `gap`;
    图层宽度 = `格数×字宽 + (格数-1)×字距`，预览同步;
  - **预览**: 透明底 + 只染字色（不再是一整块黑底），标题栏同时显示 **导出尺寸**（固件真正占的格子）
    和 **内容尺寸**（`imageproc.inkBox()` 去掉四周空白后的字迹大小）；数字模式**额外给一条 `-.0~9` 字模预览**
    （就是导出给固件的那份，用来检查字体/字号/字距）；
  - **负字距的边界**: 文字模式是**一次画完整行**，负字距 = 字叠字（安全的并集）；数字模式是固件**逐格画**
    （每格一张图，后面盖前面，无法真正重叠），所以负字距只能**收窄格子**，并且下限被夹在"最宽字迹"上
    （`inkBox()` 量出来的宽度），再负也只到那里 —— 界面里显示的是**有效字距**;
  - **系统字也能做数字**: 来源选「系统字库」时数字用系统字渲染出来 —— 按当前字号把 `-` `.` `0`~`9`
    自动渲染成灰度字模导出成 `UI_FONT`（空格不占字模，固件用底色填），**不会出现固件拿到空字库画不出东西**;
    字号 24px → 数字格就是 15×24（跟着字号走），导出物里自带 `g_uiFont…` 并被字段引用;
  - **导出 `ui_task.c` + `ui_task.h`** (`layerexport.taskCodeFor()`):
    `#include "multi_timer.h"` + 每个 task 一个 `struct Timer` + `void LCD_<Task>_CB(void *arg)`
    (每次周期 `UI_DrawField` 刷数字) + 配了跳转的页多一个一次性 `LCD_Page<n>_Jump`
    (到点 `LCD_UI_Goto(jumpTo)`) + **一键初始化** `void LCD_UI_Setup(void)`
    (`ui_exit_all` → 设表 → `UI_Init`; 之后由固件 `LCD_UI_Goto(页号)` 决定显示哪一页);
    头/尾的灰度图跟着进 `ui_assets_int/ext.c`;
  - 验收: 生成的 `ui_task.c` 与固件真 `app_ui.c` 一起 **gcc 编译并运行**, 用同签名的 multi_timer 桩手动"到点"触发回调:
    断言 1 个 task / 周期 200ms / 首次回调画 6 次(头+尾+4 数字) / 第二次只画 4 次(头尾不重画);
  - 图层行对数字层**只显示只读状态**（`数字 g_uiSpeed · 1 位小数 · 5 格 · 右`，双击图层去改），
    不再就地编辑 —— 图片/帧图层因此永远不会被"变成数字"；
- **图层行的「帧 ◀ n ▶ /总数」**= 这一层**显示第几帧**（多帧素材才有；换帧自动按那一帧的内容框/颜色，走撤回栈）；
  数字层会把帧选择置灰并说明"数字层不画帧"；
- 验收：`scripts/check-card.mjs` 断言默认值、计划里的 bind、表里的字段与"不重复静态绘制"；`check-layerexport.mjs` 把这类表与固件真 `app_ui.c` 一起 gcc 编译运行。

### 1d. 旧弹窗已删除

- 右栏标题栏的「UI 帧/表导出…」按钮与 `src/components/UiExportDialog.vue` **已删**（文本编辑早已移到「＋ 文本框」，
  「存储」变成图层行的「内部 / 外部 / LZSS」三选一按钮，「每行颜色」变成分割线颜色，「数字区域」变成图层第二行「值」）；
- 右栏现在只剩：复制全部 / 下载 .c / **一键导出到文件夹**（图层驱动）/ 复制 ring。

### 1e. 右栏排版（本轮清理）

- **屏幕预设收进弹窗**：右栏只留一个「⚙ 屏幕预设 · <当前预设>」按钮（固定不滚动），
  尺寸/圆屏可用区/默认格式/预设管理都在 `ScreenDialog.vue` 里，滚动区从「指令模板」开始;
- **图层行两行制**：第一行只有身份（类型标签 + 名字 + `数字` 标记 + 几何）和三个图标按钮（`⌂` 归零 / `🔒` 锁定 / `⚙` 属性），
  第二行是这一层的设置（`页` 输入 + `内部/外部/LZSS` 三选一 + 多帧素材的 `帧 ◀ n ▶ /N`），不再把七八个控件挤在一行。

## 二、遗留（可选，都不影响使用）

### 1. 主模拟屏上拖分割线
- 分割线现在在**文本框弹窗的预览**里点/拖/双击（见 1b）；若还想在中间主模拟屏上直接拖，可把同一套
  pointer 逻辑挂到 `ScreenStage`，数据仍共用 `state.uiExport.splits`。

### 2. `store.exportAllFiles()` 纯函数遗留 —— 已清掉
- 旧的"文本一次性导出"（`exportAllFiles` → `buildUiExport`：把多行文本竖排成一张带 `lineH` 的素材，
  再生成 `UI_T_FRAME` + `lineColor`/`hiLine` 的菜单项）**没有任何界面入口**，已连同
  `scripts/check-exportall.mjs` 一起删除。多行文本不再与输出形态有任何关系。

## 三、约定不变

- 内部/外部只由 **Keil 的文件编译位置**决定，固件只调 `LCD_drawImage` / `LCD_drawGrayImage`（地址自动分流）；
- 圆环独立：参数走 `ring_config.h`（「复制 ring」/一键导出），不参与图层导出；
- 一键导出目标目录固定为固件仓库的 `code/lcd/`。

## 四、导出的文件（9 个，各 .c 独立编译）

| 文件 | 谁生成的 | 说明 |
|---|---|---|
| `ring_config.h` | 圆环参数 | 不参与图层导出 |
| `ui_assets_int.c` / `ui_assets_ext.c` | 每个静态图层一个数组 | **不加 static**（别的 .c 要引用） |
| `ui_table.h` | 每次导出重写 | 表/帧/字库/素材数组/文字函数的**声明**（多文件工程的粘合剂）|
| `ui_font.c` | 每次导出重写 | **字模数据**：数字字库 + 文字层字模表/取图函数（动辄几千行）|
| `ui_table.c` | 每次导出重写 | **纯属性**：帧表 + 区域表 + `UI_DrawStatic()`（几十行，报错位置好找）|
| `ui_task.c` / `ui_task.h` | 每次导出重写 | 每页 `LCD_<Page>_Enter/_Exit/_CB`(+定时跳转) + `LCD_UI_Setup/Goto/NextPage` + 每页事实宏 |
| `ui_user.h` | **只生成一次，永不覆盖** | 用户自己的变量声明 / LCD 头 / `UI_SRC_*` 宏 |

字模与属性分开存（`ui_font.c` / `ui_table.c`）：字库几千行会把属性表顶到很后面，
`ui_table.c(978): error` 这种报错位置就没人找得到；拆开后属性表始终几十行。

**新文件要加进 Keil 工程**（右键分组 → Add Existing Files）：`ui_font.c` 是新加的 `.c`，
Keil 不会自动编译它 —— 不然报 `L6218E: Undefined symbol g_uiFont_xxx (referred from ui_table.o)`。
一键导出的状态栏会把"本次新出现的 .c"列出来提醒。

### 数组命名 = 帧表号 + `_int` / `_ext`（2026-10-21）

- 静态图层的素材数组叫 `g_uiFrame<N>_int` / `g_uiFrame<N>_ext`，`N` 就是 `g_uiFrame<N>` 的帧表下标
  （z 序，跳过圆环/数字层）。**看帧表第几帧，就知道去哪个数组拿像素**，不再按"内部/外部各自从 0 编号"。
- 动态数字层不占帧表，基名用 `g_uiField<N>`（它的字库/宏名也从这里派生），不会和素材数组撞名。
- 「导出所有帧」的层也**只用一个数组名**（例如电池 `g_uiFrame4_ext`）：数组里是 N 帧连续像素，
  帧表 `.index` 选第几帧，`ui_font.c` 里的取帧函数按 `id` 做数组偏移。以前叫 `<key>_fr`，
  和帧表号对不上；现在统一成帧表名，固件侧按帧表名找数组即可。

### 内置多帧素材的帧数必须来自元数据

`fwassets.js` 的 `FW_BUILTIN` 自带 `font.frames`（电池 10、方向 3、BLE 5、数字字库 10/16、ASCII 95）。
旧版 `installBuiltinAssets()` 用 `new Image().width` 推帧数，而 `img.src` 刚赋值时 `width` 还是 0，
于是所有内置多帧素材都被登记成 **1 帧 × 一格宽**（电池 12×20 而不是 12×20×10）——
属性弹窗里勾「导出所有帧」只有 1 帧，一键导出自然看不到电池素材。

现在 `fwBuiltinAssetMeta()` 直接按元数据给出 `w = glyphW × frames`，并在打开老工程时
就地修复已经被存成 1 帧的 `fw_*` 素材（只修 `frames=1 && w=glyphW` 的旧形态，用户自己拆过的字库不动）。

**素材文本只有一个来源**：`store.exportLayer()` 走 `uiexport.exportAssets()`，与帧表同源。
以前这里有第二套生成器（`buildCArrayText` + `gImage_` 前缀、`unsigned short` 类型），
于是表里引用 `g_uiFrame0_int`、素材里却定义 `gImage_g_uiFrame0_int` → 链接必 undefined。
现在像素统一归一成固件认的两种格式：GRAY8(1B/px) 与 RGB565(2B/px)，数组一律 `const uint8_t[]`
（`u16g` / `macro888` / `u32` 都折算到 RGB565；`grayPack='g565'` 的屏幕预设下帧表 fmt 也跟着变 RGB565）。

### 变量绑定的两种写法

| 绑的名字 | 生成器写什么 | 用户要做什么 |
|---|---|---|
| `g_uiSpeedX10`（普通变量）| `.src = &g_uiSpeedX10` | `ui_user.h` 里已自动列好 `extern int32_t`；类型不是 `int32_t` 就改成真实类型 |
| `sys.motor.level`（成员/下标）| `.src = UI_SRC_sys_motor_level` | 在 `ui_user.h` 里让这个宏的写法成立（见下） |

成员写法走宏，是因为 `&sys.motor.level` 要求**结构体完整定义在那一刻可见**；固件里结构体
常常只定义在自己的 `.c` 里，头文件里只有不完整声明 → Keil 报 `#70: incomplete type is not allowed`。
`ui_user.h` 里三选一：① `#include` 带结构体定义的头；② 自己写一份 `struct X {…}; extern struct X x;`；
③ 宏指向一个自己的 `int32_t` 变量（`c` 里周期更新）。

### 多行文本 = 网页侧的便利，与输出无关

「文本框」的多行输入只是"一次做几张素材"的便利：默认**每段裁掉四周空白后各成一个独立素材**
（一段一张图，拖上去就是一帧；勾选「打包成一张多帧素材」才竖排合成一张，那是素材库里按帧切换用）。
导出侧因此**没有"多行素材/菜单"语义**：`UI_FRAME_REF.lineH = 0`，不生成 `lineColor`/`hiLine` 菜单项
（`exportTable` 仍保留 `UI_T_FRAME`/`UI_T_LIST` 的支持，留给手写表用，网页不再生成）。

兜底字库（数字图层没自带字库时的内置 8×11）导出名固定 `g_uiFontNum8x11`，
特意不叫 `g_uiFontNum`，免得跟工程里自己的同名 `UI_FONT` 撞车（duplicate symbol）。

**硬规则**：`.src` 是静态初始化的常量地址，只能是 `&对象` / `&对象.成员`，**不能写函数调用**
（会报 `initializer element is not constant`）；源也必须是 `int32_t`（固件按 4 字节读，
绑 `uint8_t` 成员会读到垃圾）。

多文件的三条硬规则（都由自检 `scripts/check-multifile.mjs` 把关，它按 Keil 的方式
**逐个 `.c` 单独 `gcc -c`** 再链接运行）：

1. `.c` 里的 `#include` 必须在**最前面** —— `ui_table.c` 的字库块第一行就是 `const UI_FONT …`，
   include 排在后面会报 `identifier "UI_FONT" is undefined`（用户实际踩过：`ui_table.c(948)`）；
2. 表长 `UI_FIELD_N` 在头里是**数字**（别的 .c 里 `g_uiFields` 是不完整类型，`sizeof` 用不了）；
3. 素材数组去掉 `static`，并写进 `ui_table.h` 的 `extern const uint8_t g_uiFrame0_int[];`。

有文字层（按 ID 取图函数）时 `ui_table.c` 会带上屏幕预设里的 LCD 头（函数体里要调
`LCD_drawGrayImage` / `LCD_Fill`）。

## 五、页号模型：`page` 是唯一的"显示内容"真值

- 图层与**圆环**都用 `inst.page` 填**页号**：页号 = 生成的函数名后缀。
  正常页 `0..9`（`LCD_Page0_Enter/Exit/CB`），空页号也留位 → `LCD_PAGE_N = >=0 的页数`；
  负数留给**特殊页**（只有固件状态机能进，按键永远进不去）：

  | 页号 | 含义 | 生成物 |
  |---|---|---|
  | `-1` | 关机空白（没有内容）| 无；`Goto(-1)` = 出旧页 + 停刷新/停圆环 + 清屏 |
  | `-2` | 关机充电 | `LCD_PageCharge_Enter/Exit/CB` |
  | `-3` | 低电 | `LCD_PageLowBat_Enter/Exit/CB` |
  | `-4` | 开机 LOGO（一般配"定时跳转"自动进正常页）| `LCD_PageLogo_Enter/Exit/CB` |

  网页里 `-1` 放不了图层；`-2/-3` 只有画了内容才会生成对应函数与 `case`。
- **一个图层可以同时在多页**：图层行的「页」写 `0,1` → `inst.pages = [0,1]`（单页仍旧用 `inst.page`）。
  导出时**素材/帧只出一份**，但每一页的 `Enter` 都会画它 —— 多页不额外花 flash；
  圆环同样支持多页（每页 `Enter` 启 / `Exit` 停）；数字层多页时每页一条自己的刷新定时器（周期按页设置）。
- **定时跳转**：页设置里可配 `jumpMs`（0 = 不跳）与 `jumpTo`；`Enter` 起一个一次性定时器，
  到点 `LCD_UI_Goto(jumpTo)`，`Exit` 里 `timer_stop` 取消（提前离开就不跳）。
  LOGO 页就是"一个普通页 + 定时跳转"（例：800ms → 主页面），固件里没有 LOGO 专用逻辑。
- **圆环形状**：`圆环`（默认，预览=板子逐像素一致）与**`圆角矩形`**（网页预览版：光斑/进度弧沿
  圆角矩形的周长跑，参数 = 尺寸 W×H + 外圆角 + 内圆角(空=自动) + 环厚 + 内缩 + 「撑满屏幕」留边(默认 8) + 进度递增方向(顺/逆时针)；
  白斑的环绕方向是 `dir`(正转/反转)，步进按一圈弧长折算；**MCU 引擎 `bsp_ring.c` 目前只会画圆形**，
  导出的 `ring_config.h` 会按内切圆等效 + 文件头写明，`warnings` 里也会提示）。
- 圆环不再是"被跳过的引擎实例"：它进计划但 `kind='ring'`，**不产素材/帧**，只把
  「哪一页有圆环」告诉导出——那一页的 `Enter` 就是 `Ring_SetBg(UI_PAGE_BG); Ring_Start(...)`，
  `Exit` 是 `Ring_Stop()`。启动档位/方向在圆环对话框里填，导出成 `RING_GEAR_DEF` / `RING_DIR_DEF`。
- 生成的切页 API：
  - `LCD_UI_Setup()` = `ui_exit_all()`（停刷新/停圆环/停跳转）→ `UI_SetFields` → `UI_Init`，
    **不进任何页**（面板每次重新初始化后调一次）；
  - `LCD_UI_Goto(int8_t page)` = 出旧页 → 清屏 → 进新页；`>=0` 正常页 / `-2` 充电 / `-3` 低电 /
    `-1` 或越界 = 空白页（不进任何页）。同页直接返回；
  - `LCD_UI_NextPage(cur)` = 按键切页，**只在 `>=0` 的正常页里循环**；
  - `LCD_UI_Page()` = 当前页（空白 = `-1`）；
  - `UI_PAGE_CHANGED(page)` 宏（在 `ui_user.h` 里覆盖，默认空操作）在每次切页后通知固件 ——
    **定时跳转是在导出物内部跳的**，固件不跟着更新 `sys.page` 的话，下一拍会把画面拽回去。
- `ui_task.h` 里还有每页"事实"宏，供固件决定特殊页要不要走（网页没导出就跳过）：
  `LCD_HAS_PAGE_<n>` / `LCD_PAGE_<n>_JUMP_MS` / `LCD_PAGE_<n>_JUMP_TO`（正常页）与
  `LCD_HAS_LOGO_PAGE` / `LCD_HAS_CHARGE_PAGE` / `LCD_HAS_LOWBAT_PAGE`（特殊页，带各自的 `*_JUMP_MS/_TO`）。
- 网页导出前的自检（`pageIssuesFor`）会提示：跳转目标页不存在、`-1` 页放了图层、
  LOGO 页（-4）有内容却没配定时跳转。

### 圆环底图必须"补画"（现场问题：色环要等白斑转一圈才正常）

`Ring_Start()` 里的 `ring_paint_arc()`（整条色环）在 LCD 正忙（`busy=1`，例如切页清屏/别的传输
还没写完）时会直接跳过；跳过之后只剩白斑在转，环带要被白斑"蹭"满一整圈才看着正常。
`bsp_ring.c` 现在把没画成的底图记在 `s_arcDirty` 上，**下一帧 `Ring_Tick()` 先整条补上**再继续动画
（忙就一直等，绝不画半截）。回归自检：固件仓库 `make -C tools/ring_sim check-arc`。

## 六、固件侧接线（导出物怎么用起来）

导出物是**多文件各自编译**的一组 `.c`，固件只要接三个点：

| 位置 | 调什么 | 说明 |
|---|---|---|
| 面板初始化之后（`LCD_Init()` 成功）| `LCD_UI_Setup()` | 停干净旧刷新 + 设区域表 + `UI_Init()`；**不进页** |
| 决定显示什么（开机/关机/充电/低电）| `LCD_UI_Goto(sys.page)` | `>=0` 正常页 / `-2` 充电 / `-3` 低电 / `-1` = 空白；含清屏与圆环启停 |
| 按键切页 | `LCD_UI_Goto(LCD_UI_NextPage(LCD_UI_Page()))` | 只在 `>=0` 里循环，特殊页进不去 |
| main 主循环 | `timer_loop()`（已在跑）| 页面周期回调 `LCD_Page<n>_CB` 与**定时跳转**都靠它驱动，不需要 1ms 轮询 `UI_Tick()` |

`ui_user.h` 里建议加一行，让定时跳转/按键切页把页号同步回固件：

```c
#define UI_PAGE_CHANGED(p)   (sys.page = (int8_t)(p))
```

关键点：**表里绑的变量要有人更新**。`UI_FIELD.src` 指向 `int32_t` 变量（或成员），
固件每次改变量即可，刷新由页面定时器负责（例：按键改档位时 `motor.speed = motor.speedlevel;`）。

固件侧自检：`bash tools/ui_test/check_export.sh`（在固件仓库里）——
按 Keil 的方式逐个 `.c` 单独编译 → 链接（查未定义符号，L6218E 那类）→ 用桩定时器跑一遍
`LCD_UI_Setup()` / `LCD_UI_Goto()` 和周期回调。
