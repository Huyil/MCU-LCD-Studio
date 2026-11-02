# MCU LCD 网页工具 —— 交接说明 (写于 2026-10-12)

给下一个会话/下一个人：这是一份"现状 + 地图 + 坑"的交接。所有结论都按**仓库当前状态**核对过，
不含过期记忆。有疑问先跑第 8 节的自检，再看对应代码。

---

## 1. 这是什么

一套"网页上画 LCD 界面 → 导出 C 代码 → 烧进 CW32L010 (M0+, 48MHz, 4KB SRAM / 64KB flash) 驱动
240×170 / 240×240 / 170×320 等屏"的工具链。两个仓库 + 一台服务器：

| 角色 | 路径 / 地址 |
|---|---|
| 网页工具（前端） | `.` （Vue 3 + Vite, 无后端） |
| 固件工程 | `../firmware` （Keil MDK + armcc AC5） |
| 本机网关 | `../gateway/server.mjs`（零依赖 Node, pm2 名 `web-gateway`, 端口 **8071**） |
| 线上入口 | 由你的部署环境决定（示例 `https://your-host.example/lcd/`） |
| 本地入口 | `npm run dev` → `http://localhost:5173/` |

线上/本地是**同一份构建产物**。

## 2. 五分钟上手

```bash
# 开发（热更新，改完直接看）
cd . && npm run dev            # Vite dev server

# 发布（构建 + 本机网关副本 + 上传服务器 + 校验）
# 部署: DEPLOY_HOST=your-host DEPLOY_PATH=/var/www/lcd bash deploy-server.sh


# 全量自检
npm run check                                    # = check:logic(逻辑项) + check:ui(1 项)
```

发布脚本会打印：源码是否比 `dist/` 新、服务器返回的 bundle 名是否 == 刚构建的（不一致直接 ✗）。
**改完一定要发布**，否则"本地 dev 是新的、线上是旧的"。

## 3. 代码地图（`./src`）

| 文件 | 职责 |
|---|---|
| `store.js` | **唯一的全局状态**（`state`）+ 所有动作（加素材/图层、导出、存档、撤销）。改动前先看这里 |
| `defaults.js` | 内置屏幕预设、代码模板、格式默认值 |
| `layerexport.js` | 图层 → 固件文件（帧表、页函数 `LCD_PageN_Enter/Exit`、动态图层、多文件拆分） |
| `uiexport.js` | 素材 → C 数组（8bit 灰度 / RGB565 / RGB888）、字模表、函数名生成 |
| `lzss.js` | 通用 LZSS 编解码（任意字节流，窗口 4095 / 匹配 3..18）+ RGB565 小端字节化 + 哈希（去重） |
| `lzsspack.js` | **新格式**素材打包：逻辑组 → 统一 `UI_Asset` 表 + `g_uiAssetBlob`；按行分片（可选）、相同帧去重、生成 `ui_assets_lzss.*` / `lzss_decode.*` / `ui_asset_draw.*`；导出页的压缩率/RAM 同源 |
| `ringrender.js` | 圆环 + 圆角矩形渲染；**内含与固件逐像素同式的整数几何**（`*Q8` 系列、覆盖率、周长参数、等效角） |
| `roundscreen.js` | 圆屏/圆角矩形屏幕的遮罩与几何 |
| `imageproc.js` | 图像管线（缩放/量化/灰度×颜色调制/裁剪） |
| `frameshoot.js` | **导出图片**（右栏导出区的独立按钮 + 各弹窗右上角 `⤓ 图片下载`）：`paintFrame` = 预览与导出**共用**的同一段像素绘制（屏幕底色 + 图层，不含网格/蒙版/告警/选框）、`drawRoundHint` 圆屏提示（圆周细线/圆外压暗/不要）、`shootFrameImage` 建 1:1 画布 + PNG 下载、`imageFileName`/`frameImageName` 文件名 |
| `fwassets.js` | 固件自带素材（图标/字模）索引 |
| `colors.js` `colors.data.js` | RGB565/888 互转 + 色名表 |
| `archive.js` | 在线存档的**纯函数**：档名清洗、工程 JSON 页面尺寸 (`meta` / 回退 presets)、同名覆盖 vs 尺寸不同自动改名、新建档名。自检 `scripts/check-archive.mjs` |
| `zip.js` | 一键导出的 ZIP 兜底：STORE(不压缩)/CRC32/UTF-8 文件名；自检 `scripts/check-zip.mjs` |
| `colordef.js` | RGB565 → `UI_COLOR_*` 宏名、收集导出用到的颜色、生成 `ui_color.h` (244 个 Color_t 名字 + 自定义色)；自检 `scripts/check-colordef.mjs` |
| 屏幕底色 | 预设字段 `screen.bg`（RGB565，默认 `0x0000` 黑，屏幕预设弹窗「背景色」改）：预览底色 / 导出图片底色 / 导出 C 的 `UI_PAGE_BG` / 圆环 AA 的淡出目标（`drawRing(ctx, inst, {bg})`）四处同一个值 |
| `components/` | `AssetPanel`(素材/多选合成多帧/当前工程↔总素材库) `ScreenStage`(模拟屏) `ExportPanel`(图层树+导出) `ArchivePanel`(★ 工程条/快速切换/未保存暂存/本地 JSON/预设入口) `ScreenDialog`(预设) `RingDialog`(圆环/圆角矩形) `TextDialog`(文字/数字/系统字) `InstanceDialog`(图片属性) `FontSplitDialog` `MultiLineDialog` `ColorPicker` |

自检在 `scripts/`（见第 8 节）；文档在 `docs/`。

## 4. 数据与状态模型

- **state**：`screen`(当前预设) · `presets` · `activePresetId` · `assets[]` · `instances[]` ·
  `pages{n: {period, jumpMs, jumpTo}}` · `exportDir{name,id}` · `exportOpts` · `ui{...}` · `cloud{...}` ·
  `assetLibrary{items, mode, synced, rev}`（总素材库，跨工程，独立 localStorage）。
- **每存档导出目录**：`exportDir.name` 存工程 JSON（给人看/换机器提示），`exportDir.id` 是本机
  IndexedDB(`lcd-layout-dirs`) 里 `FileSystemDirectoryHandle` 的键。`ExportAllButton` 只按当前
  工程的 id 取句柄，切档不会沿用上一个工程的目录；明选目录时 `rememberExportDir()` 生成新 id。
  目录里已有同名文件先弹「继续覆盖 / 修改路径 / 取消」；权限失败/不支持直接写时 `zip.js` 打一个 ZIP。
  `exportDir` 进 `projectSignatureOf()`，换目录也会标记"未保存"。
- **工程条 / 未保存**：`cloud.current`(当前档名) · `cloud.currentScreen` · `cloud.baseSig`(最近保存/读取的工程指纹) ·
  `cloud.dirty`。`projectSignature()` 用 `projectSignatureOf()` 同一套结构；`ArchivePanel` 在切换前把
  未保存工程暂存到内存 (最多 4 份)，浮层里可「返回」。
- **总素材库**：`mergeGlobalAssets()` 按 `globalAssetKey()`（src hash + font 元信息）去重，记录 `origins`；
  同一 `asset.id` 改内容（重新拆分/文字快照改字）会替换旧条目，不再新旧两条都留。
  `syncAssetsFromArchives()` 现在**只读服务器上现有的存档**，用 `buildGlobalAssetItems()` 按来源重建
  （历史条目/已删工程不再累积），当前工程以内存最新素材最后并入；旧档 `fw_*` 的「1 帧」元数据先校正。
  左栏「当前工程 / 总素材库」切换；`adoptGlobalAsset()` 复制一份进当前工程。
  落盘 key `lcd-layout-studio-global-assets-v1`，配额超了会提示。
- **文字素材**：`syncTextMaterialAssets()` 把固定文字/系统字图层渲染成 `text_layer_<inst.id>` 素材
  （`derivedText` 标记，素材栏显示「文字」）；改文字/字号/颜色原地更新，删图层且没被当图片用时自动收回。
  数字/ASCII 字库层是动态值/整表，不生成静态素材。
- **素材**：`{id,name,src(dataURL),w,h, svg?/svgText?, font?}`；`font={glyphW,glyphH,charset,dir,...}`：
  `charset:'frames'` = **多帧**（按格子切，实例上用「帧」选第几格），其余 = 字库（按字符映射）。
  **多选图片**导入时会弹二次选择：`合成为一个多帧素材` / `逐个添加`（`framesSheetMeta` +
  `mergeAssetsToFrames`，格子取最大宽高，横向拼版）。
- **预设存储模型（2026-10 重构，重点）**：
  · **固定/内置预设来自代码**（`defaultPresets()`，id 写死 `preset_bi_*`），**不进 localStorage**，
    每次加载都在；新增分辨率所有人刷新即有。
  · localStorage 只存三样用户数据：`custom`(自定义预设) / `overrides`(改过的内置项) /
    `hidden`(删掉的内置项 id)。落盘用 `splitPresets()`，加载用 `mergePresets()`（兼容老格式整份数组）。
  · 「补内置」= 取消隐藏；「重置」= 内置项回默认但**保留自定义**。
  · 改这块务必跑 `check-store` 的存储模型断言。
- **持久化**：localStorage 两个 key（素材一份、布局/预设/页一份，见 `store.js` 的 `KEY_ASSETS`/`KEY_LAYOUT`），
  400ms 防抖；工程可「导出/导入 JSON」；线上另有**存档**（见第 9 节）。
- **撤销/重做**：会话级快照，只含可持久化子集（不含素材大图）。

## 4b. LZSS 素材（新格式，2026-11 起）

- 图层存储三态：`inst.store = 'int' | 'ext' | 'lzss'`（旧工程的 `inst.ext` 布尔会在载入/撤回时自动迁移，
  见 `store.normalizeInstanceStores()`）。UI 在图层第二行「内部 / 外部 / LZSS」。
- LZSS 素材全部进**一张表 + 一个 blob**：`UI_Asset { off, clen, w, h, y, fmt, flags }`，
  `rawlen = w*h*(fmt==GRAY8?1:2)` 不占表项。每片独立解压，帧/字形 ID 连续；
  组宏 `UI_ASSET_<key>` / `_N` / `_C`（首片 / 帧数 / 每帧片数）。
- 帧分片是可选的：`exportOpts.lzssChunked` + `lzssChunkBytes`（默认 true / 2400），
  只影响帧/图片，按行切，表项带 `y`；`UI_ASSET_BUF_SIZE` = 实际最大片 → 导出页显示解码 RAM。
- **字模左右条在字库层拆**（`splitFontParts`）：54×80 字模 → 左右两条 27×80（各 2160 B），
  `UI_FONT` 写 `parts=2 / partW=27`；与帧分片开关无关，所以老工程 `lzssChunked:false`
  也不会把字模按 4320 B 整块算。通用 `UI_Asset` 表没有 x 偏移。
- 字库绘制：生成的 `UI_DrawGlyph(ft, ch, x, y, color, bg, mirror)` 按
  `assetBase + (part*count + idx)*assetChunks` 逐片解压，画到 `x + part*partW`。
- 生成文件：`ui_assets_lzss.c/.h`、`lzss_decode.c/.h`、`ui_asset_draw.c/.h`；
  `ui_table.c` 的 LZSS 帧写 `.px=0 / .asset / .assetChunks`，
  `ui_font.c` 的 LZSS 字库写 `.glyph=0 / .assetBase / .assetChunks`。
- **固件契约（DR2159 重写时）**：`UI_FRAME_REF` 增 `uint16_t asset; uint8_t assetChunks;`；
  `UI_FONT` 增 `uint16_t assetBase; uint8_t assetChunks, parts, partW;`；
  `app_ui.h` 的 `UI_DrawFrame` 声明改成 `uint16_t id` 版，并补 `UI_DrawFrameAt`/`UI_DrawFrameRef`；
  删掉 `app_ui.c` 旧 `UI_DrawFrame`（新实现在生成的 `ui_asset_draw.c`，否则重复定义）；
  持有 `UI_FRAME_REF *` 的动态区域改用内部 `UI_DrawFrameRef(f, color)`；
  `UI_FRAME_REF.px==0 && asset!=UI_ASSET_NONE` → 内部 `UI_DrawAsset(asset + index*assetChunks, ...)`；
  `UI_FONT.glyph==0` → 内部 `UI_DrawAsset(assetBase + (ch-first)*assetChunks, ...)`。
- **顶层只暴露 2 个函数**（`ui_asset_draw.h`）：`UI_DrawFrame(id, color)`（固定坐标）与
  `UI_DrawFrameAt(id, x, y, color)`（备用）；id = `g_uiFrames` 下标（`g_uiFrameN` 的 N）。
  raw/LZSS/index=255/mirror 都在内部处理；`UI_FIELD.frames` 指针用内部 `UI_DrawFrameRef/RefAt`。
  **只有 LZSS 工程**生成新渲染桥；未勾 LZSS 的旧导出继续用 `UI_DrawFrame(&g_uiFrameN, color)`。
  渲染桥只有 3 个 static 的 `ui_blit_gray/ui_blit_rgb/ui_fill` 对 LCD 原语，换屏改它们。
- 旧「压缩素材（DR2159 固定布局）」全局开关/文件（`assetpack.js`、`assetdecoder.js`、
  `ui_assets_packed.c`、`asset_blocks.h`、`asset_lzss.c/.h`）已移除；导出到旧目录时从 Keil 移除旧文件。
- 自检：`node scripts/check-lzsspack.mjs`（codec round-trip、分片/去重、表/ID、C 文本、字库/取图函数）。

## 5. 导出管线（网页 → 固件）

`ExportPanel` → `store.exportLayer()` 产出：

| 文件 | 内容 |
|---|---|
| `ring_config.h` | 圆环/圆角矩形的**全部参数 + 编译期开关**（见第 6 节） |
| `ui_color.h` | 颜色名 → `UI_COLOR_*` 宏（244 个 Color_t 名字 + 自定义色；每次导出重写） |
| `ui_table.c/h` | 图层表、页函数（`LCD_PageN_Enter/Exit`）、字段表 |
| `ui_assets_int.c` / `ui_assets_ext.c` | 内/外 flash 的像素数组 |
| `ui_font.c` | 数字字模（**8bit 灰度**；行行程打包功能已按用户要求撤掉） |
| `ui_task.c/h` | 页面任务骨架（进/出页、定时跳转、周期刷新） |
| `ui_user.h` | 只生成一次，用户自己写业务的地方 |

固件侧对应：`code/lcd/*`（网页导出直接落这里）、`code/spi/{bsp_ring,app_ui,bsp_gc9a01}.c/h`（引擎，手写）。
Keil 工程里网页产物单独一组 **`WebUI_Export`**。

## 6. 与固件的"逐像素一致"契约（最容易踩的地方）

网页的「**与 MCU 同步预览**」勾上后，预览与板子**逐字节相同**。靠的是这些约定，改任何一边都要同步另一边：

- 圆心取整 `cx = floor((w-1)/2)`（240 屏 = 119，不是 119.5）；圆角矩形同理。
- 覆盖率查表（不是浮点）：`ringCovR2` / 网页 `ringCovTable`；AA 斜坡、边缘覆盖两处同式。
- 角度用**整数 atan2 表**（`ring_tables.h` ↔ `ringAtanU*`）；白斑增益表带 2° 锥度。
- 立体感（断面方向光）用烘焙表 `ringShadeA/B/Nx/Ny` ↔ 网页 `ringShadeTables`；**吃 Bayer 抖动**。
- 圆角矩形：Q8 整数几何 —— 每行外/内跨度(`isqrt`)、覆盖率 = 像素区间与带区间重叠 `(ov*255)>>8`、
  周长参数 s（顶边中点 = 0，顺时针）、等效角 `aU = s·720/per`（乘法代替除法，夹 719）。
  固件函数：`ring_rect_span/span_rng/cov/dist/shade/s/angle_u/arc_w/gain/run_s/bisect/update`。
- **编译期开关**（都在 `ring_config.h`，全部 `#ifndef` 包裹，方便主机 `-D` 覆盖）：
  `RING_SHAPE`(0 圆 / 1 圆角矩形，**两套代码互不复用**，另一套一个字节都不编) ·
  `RING_GLINT_DEF`(白斑总开关，关掉则代码+专用表+1.5KB 窗口缓冲都不编) ·
  `RING_ARC_DIR_DEF`(±1 弧向) · `RING_DEPTH_DEF`(0 = 平色) · `RING_DEPTH_STYLE_DEF` ·
  `RING_LIGHT_DEG_DEF` · `RING_XY_T`(坐标/段长按导出尺寸自动选 8/16 位)。
- **一个工程只支持一个环**（板子上是单例引擎：一套窗口缓冲 + 一个 BTIM）。素材栏的「◯ 圆环」
  在已有环时禁用；要换形状就在这个环的弹窗里改「形状」。多环会有警告。
- 运行期可改颜色/进度/转速：`Ring_SetArc/SetColor/SetBg/SetProgress/SetGear/SetSpeed/
  SetInterval/SetDir/SetStartDeg/SetCaps/SetArcDir/SetGlint`（`Ring_SetArc` 会立刻重画整条环带
  ≈13k 像素 ≈9ms@24MHz，别放每帧里）。

## 7. 当前状态（截至 2026-10-12）

- 网页 HEAD `73bead0`（+ 本文档）；固件 HEAD `14f5280`（圆环相关最后提交 `ca4e212`）。
- 圆环 **和圆角矩形** 都已上板（`RING_SHAPE`），含：进度弧（顺/逆时针）、端帽、白斑、
  断面立体感、边缘 AA、逐像素对拍；矩形白斑/立体感/分层增量刷新都有对应自检。
- 字库：**只有 8bit 灰度**（1bit/4bit 行行程打包实验已按用户要求完全撤回，
  `UI_FONT` 里没有 `pack/off` 字段）。数字取字走 `LCD_drawGrayImage` 一条路。
- 系统字多了「**ASCII 字库**」内容选项（2026-10-14）：来源=系统字库时，内容可选
  固定文本 / 数字(变量) / ASCII 字库。选 ASCII = 用该字体/字号把 0x20~0x7E 共 95 个字符
  渲染成一张 2D 字模表（`<名字>Pic[95][w*h]`，恒 GRAY8，字符序=码序），另出两个函数：
  `<名字>(x,y,id,color,bg)`（id = 字符码−0x20）与 `<名字>Str(x,y,"任意串",color)`
  （逐字 drawGrayImage，**空格/越界跳过** —— 全 0 字模画下去是黑不是透明）。
  这一层显示的示例文本照旧当普通素材导出成静态图。造字走 `store.asciiFontForSys`
  （与数字字库同一口径：固定基线/等宽格居中/边缘斜坡 σ/565 预抖动/整组裁上下空行）。
  格子高度 = **完整字迹 asc+desc**（`uiexport.asciiCellBox`，纯函数可测）—— 内置字体实测
  asc+desc = 1.04~1.18em，按字号当画布高会把 j/g/y/p/q 的尾巴切掉（2026-10-14 现场）。
  `上下` 语义：<0 只从字底收紧（裁降部尾巴、省 flash，**字顶一行不动**）；>0 格子加高、字迹下移；
  普通系统字文字层没给 `cfg.boxH` 时，`renderSysFontCanvas` 会按字迹自动兜住偏移（不再切字顶）。
- 预设：内置 10 条（1.28R 圆 / 1.2 方 / 1.9 / 1.14 / 3.2 吋横竖 / **240x170 横竖**）。
- 部署：`deploy-server.sh`；线上 nginx 已给 `/lcd/` 加 `Cache-Control: no-cache`、
  `/lcd/assets/` 加 `immutable`（见第 9 节）。

### 2026-10-21 导出命名 / 内置多帧素材

- 素材数组名改为**跟帧表同号**：`g_uiFrame0_int` / `g_uiFrame0_ext`（动态层基名 `g_uiField0`）；
  「导出所有帧」也只用一个数组名（不再有 `<key>_fr`）。帧表 `.px` 与 `ui_table.h` 的 extern 同名。
- 修内置多帧素材被登记成 1 帧的问题（`installBuiltinAssets` 不再用 `Image.width` 推帧数）：
  电池图标恢复 10 帧、方向 3 帧、BLE 5 帧、数字字库 10/16 帧、ASCII 95 字模；
  打开老工程时自动修复已存成 1 帧的 `fw_*` 素材。回归在 `check-store`（内置元数据）+
  `check-layerexport`（帧表/数组同名）。

## 8. 自检与验收（改完必跑）

**网页**：
```bash
cd . && npm run check
# check:logic = roundscreen, ringarc, ringrecti(矩形整数几何), ringrange, ringseg, ringscan,
#               aspect, archive, zip(ZIP 兜底), colordef(颜色宏), store(含预设存储模型/exportDir),
#               uiexport, layerexport, multifile, export-keil(真编译导出物), card, glow, even,
#               frameimage(导出图片), tint
# check:ui    = 各弹窗控件/文案/接线断言 (含模拟屏「导出图片」/右栏三组布局)
```
**固件**（主机跑，不需要板子）：
```bash
cd ../firmware
bash tools/ui_test/run.sh            # UI 框架（表驱动/变化才刷/数字格式化）
bash tools/ui_test/check_export.sh   # 导出物能被真编译器编译 + 链接检查
cd tools/ring_sim && make check      # = 圆形各组 + check-parity(网页↔固件逐像素)
make check-rect                      # 矩形各组: arcdir / glint / layer / aa / shade / parity
make check-parity RECT_DESIGN='{"shape":"rect",...}'   # 换一组几何对拍
```
**armcc 子集编译**：`bash tools/ui_test/armcc_all.sh`（当前 48 个 .c，期望 **0 error 0 warning**；
它自动收集 `code/*` 与 `Libraries/sgl/source/**` 的头文件路径，改了目录结构要跟着改）。
全工程真编译还是走 Keil（`MDK/*.uvprojx`）。

实测输出（2026-10-12）：
```
make check        → 全部通过；当前工程是圆角矩形, 圆环专用组自动跳过 (会打印一行提示)
make check-rect   → 40 PASS / 0 FAIL
tools/ui_test/armcc_all.sh → 编译 48 个 .c 文件: 全部 0 error 0 warning
npm run check     → 12 项"全部通过", 451 条 PASS, 0 FAIL
```

## 9. 运维细节

公开仓库不包含部署地址、服务器路径或密钥。部署使用通用脚本：

```bash
DEPLOY_HOST=your-host.example DEPLOY_PATH=/var/www/lcd DEPLOY_URL=https://your-host.example/lcd/ \
  bash deploy-server.sh
```

在线存档后端是可选的同源 `/api/lcd-projects/`；公开部署默认不启用，`X-LCD-Key` 通过运行时配置提供。
**"本地新、服务器旧"几乎总是浏览器缓存了旧 index.html** → 硬刷新（Ctrl+F5）一次。

## 10. 已知待办 / 坑

1. `src/components/RingDialog.vue:17` 注释仍写着"圆角矩形 = 网页预览版"，**已过时**（板上早支持了）。
2. `docs/rect-engine-plan.md` 是**历史计划**（当时矩形还没上板）；实现已远超它，只作参考。
3. 圆角矩形与圆弧的**带厚在角上不等于直边**（内外圆角各自独立，与网页 SDF 同模型）；
   要等厚环就把内圆角设成 `外圆角 − 厚度`。
4. 白斑、立体感、弧向都是**编译期**开关：改了要在网页导出（写进 `ring_config.h`）再编译，
   不是运行期改 `Ring_SetGlint` 就能开的（运行期只能关/开已编译进来的白斑）。
5. 一个工程一个环（第 6 节）；将来要"不同页不同环"得改成按页配置（当时评估过方案，未做）。
6. 圆屏遮罩/圆角矩形屏幕的遮罩参数在预设里；换屏先看 `ScreenDialog` 的预设行。
7. 固件仓库里有用户自己的未提交产物（`MDK/Objects/*`、`code/lcd/ui_task.*` 等）——**不要顺手提交/回滚**。
8. 网页侧"素材/字库/环"的改动路径很多（`store.js` 一处改错会静默影响导出）→ 改完必须 `npm run check`，
   它会把导出物真编译一遍（`check-export-keil`）。

## 11. 交接自检清单（5 分钟）

```bash
npm run check                              # 期望: 全部"全部通过", 0 FAIL
FW_DIR=../firmware npm run check:logic      # 有固件 fixture 时会额外真编译
```
这些过了 = 环境是好的，可以开始改。

### 2026-10-22 圆环角向 AA（运行期可调）

- `ringSegMaskDeg()` 改为**带符号距离**的对称过渡：边界处 0.5，向段内/缝内各
  `AA/2`；修掉旧实现“段内软、缝内硬”的半像素跳变（分割线看起来不直的主因）。
- `segAA` 语义统一为**总过渡宽度**（px，0 = 硬边，上限 4），默认 2.0；
  RingDialog「分割 → AA」为滑杆 + 0/1.5/2.0 快捷键，导出表新增 `RING_SEG_AA_X10` 行。
- 固件 `bsp_ring.c`：段/缝边界与弧两端共用 `RING_SEG_AA_X10`，不再是编译期常量；
  新增 `Ring_SetSegAA()/Ring_GetSegAA()`，改完立即整弧重画。`host_ring_render`
  第 4 个参数 = AA（0.1px），可出 AA 扫描图。
- 对照图 `ring-seg-preview/aa-sweep.png`；固件仓库 `doc/preview/ring_aa_sweep.png`。

### 2026-10-22 圆环分割 UI：取消模式 + 抗锯齿滑杆 + 预览缩放

- 「切断/暗槽」选项删除，只留槽深（100% = 压黑 = 原切断）；旧 `segMode:'cut'`
  在打开弹窗时迁成 `groove + 100%`，导出固定 `MODE=1`。
- `segAA` 改名「沟槽 AA」，滑杆 0..4px + 数字框 + 硬边；槽深同样滑杆 + 数字 + 压黑。
- 实时预览支持 1×..6× 缩放（只走按钮；不抢 Ctrl+滚轮，避免和页面缩放冲突），放大后滚动平移，≥2× 像素化显示。

### 2026-10-22 沟槽 AA / 端点 AA + 基本页布局

- AA 分「沟槽 AA」（`segAA`，0..4px）与「端点 AA」（`aaEdge`，0..6px，一个值管
  起始角/结束角两端，只在平口生效），不是拆左右起点/终点。端点 AA 单边向外、
  不侵蚀高亮；未满档时进度前沿保持硬边。端点外延用该端自己的沟槽色（起点第 0 段、
  结束角最后一段），先把沟槽格延续出去再淡出，不是一条纯 fill 亮条。
- 导出 `RING_SEG_AA_X10` + `RING_AA_EDGE_X10`；固件
  `Ring_SetSegAA(x10)` / `Ring_SetEdgeAA(edgeX10)` 各自运行期可调。
- 「快速范围」卡片删除；「分割」卡片挪到「基本」页几何下方。
- self-check：`check-ringseg` 端点/沟槽分离断言、`check-ui-render` 布局/控件断言。

### 2026-10-23 档位分割点 RING_SEG_SPLIT_X10

- 网页新增 `segSplit`（0..10，默认 5）与导出 `RING_SEG_SPLIT_X10`；预览
  `fillEnd` 改为 `lit×P − gap×(10−split)/10`，并按固件 0.5° 网格向上取整。
- 固件 `Ring_SegSweep()`/`ring_fill_end_set()` 读同一个宏（默认 5 = 槽中）；
  低档不再切进下一段 body。
- 端点 AA 与板子同步：静态端点 body/groove 各半；进度前沿也做向外 AA。

### 2026-10-23 字库随工程保存 / 一键导出带 JSON+字体 / 导出区重排

- **自定义字库随保存上传**：`store.js` 维护 `fontData`（IndexedDB 里的原始字体字节），
  `exportProject()` 增加 `fonts: [{id,name,ext,data(base64)}]`；`importProject()` 收到后
  重建 `FontFace` + 写回 IndexedDB。保存按钮（在线存档）因此自动带上字库，换机器打开
  工程不会只剩字体名。
- **一键导出**额外写入 `lcd-project.json`（内嵌字库）和每个自定义字体的原文件
  `lcd-font-<name>.<ext>`；`ExportAllButton` 支持 `{data}` 二进制条目（不再一律按 UTF-8 写）。
- **UI**：`导入/导出 JSON` 从 ★ 浮层挪到工程条主行（`JSON⤓` / `JSON⤒`）；「保存图片 +
  圆屏提示」收进独立的「导出图片」卡片，放在导出动作区下方，不再和一键导出并排。
- 自检：`check-store` 钉 `fonts` 字段、`check-export-keil` 钉 `lcd-project.json`、
  `check-ui-render` 钉 JSON 入口在主条 + 导出图片分组。

### 2026-10-23 总素材库按服务器现有存档重建 / 文字图层进素材栏

- **总库不再累积历史**：`syncAssetsFromArchives()` 读取 `cloud.list` 的每一份存档，
  交给 `buildGlobalAssetItems(sources, prevItems)` 重建条目；只保留本次来源 + 当前工程，
  已删工程/旧版本不再残留。条目 id/`addedAt` 按内容 key 继承，列表不整片跳。
  旧档里按 1 帧存下来的 `fw_*` 先经 `normalizeGlobalAsset()` 按固件元数据校正，
  与多帧版本合并成一条（服务器实测 4 份存档 → 22 个唯一素材）。
- **增量合并也不留旧版**：`mergeGlobalAssets()` 遇到同一 `asset.id` 但内容 key 变了
  （重新拆字库、文字快照改字）会替换旧条目，而不是新旧两条都留。
- **文字进当前工程素材**：`syncTextMaterialAssets()` 在 `initPersistence()` 里按
  `textMaterialSignature()` 防抖触发（也监听 `_imgTick` 兜字体/图片解码）；固定文字层 →
  `text_layer_<inst.id>` 快照，`derivedText` 标记，素材栏显示「文字」标签。
  改文字/字号/颜色原地更新；删图层且快照没被当图片用时收回；数字/ASCII 不生成。
- 自检：`check-store` 钉重建/同 id 替换/内置帧数校正/文字素材签名；
  `check-ui-render` 钉「文字」标签与同步按钮文案。

### 2026-10-23 每存档导出目录 / 覆盖确认 / ZIP 兜底 / 右栏重排

- **导出目录跟着存档走**：工程 JSON 新增 `exportDir{name,id}`；句柄存 IndexedDB
  (`lcd-layout-dirs`)，`ExportAllButton` 按当前存档的 id 取，切档绝不复用上一个工程的 handle。
  `「选择…」` = 明选目录并生成这个存档专属的新 id；换机器/清缓存后按 name 提示重选。
- **覆盖前二次确认**：写目录前先扫同名文件；有则弹窗列文件，三选一
  **继续覆盖 / 修改路径… / 取消**（`askOverwrite/answerOverwrite`）。`ui_user.h` 等 `once`
  文件始终不覆盖；改路径后对新目录再扫一遍。
- **ZIP 兜底**：浏览器不支持写文件夹、权限申请失败、写入异常 → `zip.js` 打一个
  `lcd-<存档名>-日期.zip` 下载；只有 ZIP 自己失败才逐个下载。ZIP 用 STORE + CRC32 +
  UTF-8 文件名，零依赖。
- **字库只导出用到的**：`usedFontFamilies()` 收集系统字图层的 `sysfont.family` + 多帧画板
  `frameGroupDoc.frames[].layers[]` 里 `source='system'` 文字层的 `family`；`filterUsedCustomFonts()`
  只留有原文件字节且被引用的，同名的只留一份。`exportLayer()` 的 `lcd-font-*` 与
  `exportProject().fonts` 都走 `usedCustomFontFiles()`，加载过但没用到的字体不再进导出目录/存档。
- **右栏重排**：`.actions` 按「导出到文件夹 / 复制·下载 / 保存图片」三组（小标题 + 虚线分隔），
  导出预览单独放进 `.preview-block`，与滚动区（页面/图层）分开；长状态文字 `max-height`
  内部滚动，不再把下面的按钮顶走。
- 自检：`check-store` 钉 `exportDir` JSON 往返/指纹、字库只取引用项；`check-zip` 钉
  CRC/头/EOCD/中文名；`check-ui-render` 钉三组布局、覆盖三按钮、ZIP 文案与「文字」标签。

### 2026-10-23 颜色改为按名字 define (ui_color.h)

- **不再写死 0xXXXX**：`colordef.js` 的 `colorMacroName()` 把 RGB565 映射成
  `UI_COLOR_WHITE` / `UI_COLOR_CYAN` 等（表里没名字的自定义色 → `UI_COLOR_RGB565_1234`）。
- **导出新增 `ui_color.h`**：`buildColorHeader()` **只写本工程实际用到 / 模板里引用到的
  颜色**（默认保留 BLACK/WHITE 兜底；完整 244 色表仍在固件 `Color_t` / `colors.data.js`）；
  `ui_table.h` 自动 `#include "ui_color.h"`，所以 `ui_table.c` / `ui_font.c` / `ui_task.c`
  都看得到宏。模板/头尾里手写的 `UI_COLOR_XXX` 也会被 `collectUsedColors()` 扫到，不会裁掉。
- **替换范围**：`UI_FIELD` 的 `.color/.bg/.lineColor`、`UI_PAGE_BG`、
  `UI_DrawFrame(..., 颜色)`、模板 `{color}` 全部走宏；新增 `{colorHex}` 保留原值。
  `plan.screen.bg` 现在真的带上预设底色（以前 `exportLayer` 只填 w/h，`UI_PAGE_BG` 永远是黑）。
- **ring_config.h 例外**：它仍是数值 —— `gen_tables.py`/主机对拍直接读，不走 UI 颜色宏。
- 自检：`check-colordef` 钉宏名/收集/头文件；`check-export-keil` 真编译生成物并断言
  `.color = UI_COLOR_*`、`UI_PAGE_BG UI_COLOR_*`、没有 `.color = 0x`。
