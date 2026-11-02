# 移植到内部 Flash + LZSS 素材：给移植智能体的交接建议

> 适用基线：**旧的外部 Flash 版本**（`ui_assets_ext.c` / `UI_EXT_RO` / W25Q 指针表）。
> 目标：换成当前 Web 导出的 **内部 Flash + LZSS 统一素材表 + 字模 parts**。
> 更新日期：2026-11-02。

---

## 0. 先定性

旧基线是 **“外部 Flash 指针 + 固定字模”**；新导出是 **“内部 Flash + LZSS 表 + 字模 parts”**。

不要尝试把旧的 asset 层一点点改成新格式。**asset 层整体替换**，保留页面 / 任务 / 圆环 / LCD 驱动 / 按键这些逻辑。

---

## 1. 旧基线里不要照搬的东西

| 旧基线 | 为什么不能留 |
|---|---|
| `ui_assets_ext.c` + `UI_EXT_RO` + `0x01000000` 指针 | 新 LZSS 素材是内部 `const`，不在外部 Flash；继续用外部段会把 blob/表拖到 W25Q |
| `app_ui.c` 里的 `UI_DrawFrame(const UI_FRAME_REF*, color)` | 新顶层是 `UI_DrawFrame(uint16_t id, color)`；旧实现遇到 `.px == 0` 直接 `return`，LZSS 帧会全空白 |
| `ui_draw_glyph()` 里的 `ASSET_FONT_*` / 固定 27×80 左右条 | 新字模用 `parts / partW`，不同字号/字库片数不同 |
| `asset_lzss.c` / `asset_blocks.h` / `ui_assets_packed.c` / 34 块固定布局 | 新格式是任意 `UI_Asset` 表 + `lzss_decode.c/.h`；两套不能共存 |
| `g_uiFrame2_ext` / 直接读电池数组 | 新电池是 `UI_ASSET_*`，走 `UI_DrawFrameRef` / `UI_DrawFrame` |
| 硬编码 `2400 / 27 / 80 / 14 帧` | 新固件只认表里的 `w/h/y/parts/partW`；硬编码会在换字号时错位 |
| W25Q 的素材地址分派 | 新解码缓冲是内部 SRAM（`0x2000...`），`LCD_drawImage` 的 RAM 直通分支即可；不要把 LZSS 缓冲当外部地址 |

---

## 2. 必须新增的固件契约

### 2.1 `UI_FRAME_REF` 追加字段

```c
typedef struct {
    const void *px;
    uint16_t x, y, w, h;
    uint8_t  lineH, fmt, mirror, index;
    uint16_t asset;        /* LZSS 首片 ID；非 LZSS 写 UI_ASSET_NONE */
    uint8_t  assetChunks;  /* 每帧片数；非 LZSS 写 0 */
} UI_FRAME_REF;
```

### 2.2 `UI_FONT` 追加字段

```c
typedef struct {
    const void *glyph;     /* 非 0 = raw 连续数组；0 = LZSS 字库 */
    uint8_t w, h, gap, first, count;
    uint16_t assetBase;    /* LZSS 字库：第 0 片 */
    uint8_t assetChunks;   /* 每片再分几块（通常 1） */
    uint8_t parts;         /* 每个字形几片（54×80 → 2） */
    uint8_t partW;         /* 每片宽（54×80 → 27；最后一片可能更窄） */
} UI_FONT;
```

### 2.3 顶层 / 内部 API（`ui_asset_draw.h`）

```c
/* 顶层 2 个：id = g_uiFrames 下标，即 g_uiFrameN 的 N */
void UI_DrawFrame(uint16_t id, uint16_t color);
void UI_DrawFrameAt(uint16_t id, uint16_t x, uint16_t y, uint16_t color);

/* 内部：UI_FIELD.frames 是指针数组，动态区域用这两个 */
void UI_DrawFrameRef(const UI_FRAME_REF *f, uint16_t color);
void UI_DrawFrameRefAt(const UI_FRAME_REF *f, uint16_t x, uint16_t y, uint16_t color);

/* 内部：字库绘制（raw / LZSS 左右条都走它） */
void UI_DrawGlyph(const UI_FONT *ft, uint8_t ch, uint16_t x, uint16_t y,
                  uint16_t color, uint16_t bg, uint8_t mirror);
```

### 2.4 `UI_Asset` 表（`ui_assets_lzss.h`）

```c
typedef struct {
    uint16_t off, clen;
    uint16_t w, h, y;   /* 帧分片只按行；没有 x 偏移 */
    uint8_t  fmt;       /* UI_FMT_RGB565 / UI_FMT_GRAY8 */
    uint8_t  flags;
} UI_Asset;
```

- `rawlen = w * h * (fmt == UI_FMT_GRAY8 ? 1 : 2)`，不占表项；
- `UI_ASSET_BUF_SIZE` = 实际最大片（不是固定 2400）；
- `UI_ASSET_COUNT`、`UI_ASSET_<key>` / `_N` / `_C` 全部从生成头文件读，不要自己数；
- 表项 12 B；`off/clen` 是 `uint16_t`，整个 blob 必须 < 64 KB。

### 2.5 解码器

```c
uint16_t LZSS_Decode(const uint8_t *src, uint16_t clen,
                     uint8_t *dst, uint16_t rawlen, uint16_t cap);
```

不要再用 `Asset_Decode` / `asset_blocks.h`。

### 2.6 `ui_table.h`

生成物里还会带：

```c
#define UI_FRAME_N  <静态帧数>
extern const UI_FRAME_REF *const g_uiFrames[UI_FRAME_N];
```

`UI_FRAME_N` 是 `UI_DrawFrame(id)` 的越界依据，**不要自己另数**。

---

## 3. 移植顺序（建议）

1. **先用最新 Web 重新导出一份**（LZSS + 当前的逐字微调 `glyphDx`），不要拿旧外部 Flash 工程的 `ui_font.c/ui_table.c` 当输入。
2. `app_ui.h` 里**追加**上面字段和函数声明（追加到结构体末尾，旧 raw 初始化器可继续编译）。
3. 把生成的 `ui_assets_lzss.c/.h`、`lzss_decode.c/.h`、`ui_asset_draw.c/.h` 加进 Keil；同时从工程移除旧 `asset_lzss.c`、`asset_blocks.h`、`ui_assets_packed.c`。
4. **删掉 `app_ui.c` 里旧的 `UI_DrawFrame` 实现**（新实现在 `ui_asset_draw.c`，留着会重复定义）。
5. 把 `UI_DrawField` / 其它持有 `UI_FRAME_REF *` 的地方改成 `UI_DrawFrameRef(f, color)`；静态页 / `UI_DrawStatic` 已经是 `UI_DrawFrame(N, color)`。
6. 把 `ui_draw_glyph` 的压缩字库分支改成 `UI_DrawGlyph(ft, ch, x, y, color, bg, mirror)`；raw 字库也走它，别留两条路。
7. `dsp_draw_bat` / `battery()` 改用生成的 `battery()` 或 `UI_DrawFrameRef`，不要再直接读 `g_uiFrame2_ext`。
8. 编译；按第 5 节的报错清单逐个清。
9. host 端做 decode round-trip；再上板看数字 / 电池 / 多帧。

---

## 4. 最容易踩的 5 个点

### 4.1 `.px == 0` 不是“没东西”

旧 `UI_DrawFrame` 写的是：

```c
if (!f->px) return;
```

新帧表里 LZSS 帧就是 `.px = 0, .asset = UI_ASSET_xxx`。正确顺序必须是：

```c
void UI_DrawFrameRefAt(const UI_FRAME_REF *f, uint16_t x, uint16_t y, uint16_t color)
{
    if (f == 0) return;

    /* 仅网页渲染：只清底色 */
    if (f->index == 255u) {
        ui_fill(x, y, f->w, f->h, UI_BG_COLOR);
        return;
    }

    /* 原始数组（内部 / 外部 Flash） */
    if (f->px != 0) {
        ui_blit_raw(f, x, y, color);
        return;
    }

    /* LZSS：.asset 指向首片，.index 选第几帧，步长 = .assetChunks */
    if ((f->asset != UI_ASSET_NONE) && (f->assetChunks != 0u)) {
        UI_DrawAsset((uint16_t)(f->asset + (uint16_t)f->index * (uint16_t)f->assetChunks),
                     f->assetChunks, x, y, color, 0xFFFFu, f->mirror);
        return;
    }

    /* 其余 (.px == 0 且没有 asset) = 仅尺寸：不画 */
}
```

**这是最优先要改的一处；不改，所有 LZSS 帧都是空白。**

### 4.2 `index` 不是只用来判 255

- raw：`px + index * w * h * bpp`；
- LZSS：`asset + index * assetChunks`；
- `index == 255`：只清 `UI_BG_COLOR`。

旧的 raw 实现常常忽略 `index`，多帧会一直画第 0 帧。

### 4.3 字模不要写死 27/80/两条

`UI_DrawGlyph` 的取值公式：

```c
parts = ft->parts ? ft->parts : 1u;
for (p = 0u; p < parts; p++) {
    UI_DrawAsset((uint16_t)(ft->assetBase +
                            ((uint16_t)p * ft->count + (uint16_t)(ch - ft->first)) * ft->assetChunks),
                 ft->assetChunks,
                 (uint16_t)(x + (uint16_t)p * ft->partW), y,
                 color, bg, mirror);
}
```

- 最后一片宽度以表项为准（可能不是 `partW`）；
- `assetChunks` 通常 1，但不要假设；
- 54×80 时 `parts=2, partW=27`，不是硬编码。

### 4.4 `glyphDx` 不在 C 里

Web 的逐字微调已经**烘进字模字节**：`ui_font.c` / `ui_assets_lzss.c` 的像素就是调好的。C 里没有 `glyphDx` 字段，固件不用加运行期偏移。

如果上板还看到 2/3 跳 1px，先确认导出前 TextDialog 点了**保存 / 应用**，再重新导出；不要在固件里再补一层 dx。

### 4.5 RAM / Flash 预算

DR2159 v2 当前：

| 素材 | 尺寸 | 片 |
|---|---|---|
| 数字字模 54×80 | 每片 27×80 = 2160 B | `parts=2, partW=27` |
| 电池 48×24 RGB565 | 2304 B | 整帧 |
| `frames_1021` 70×29 | 2030 B | 整帧 |
| **`UI_ASSET_BUF_SIZE`** | **2304 B** | 静态、4 字节对齐 |

不是固定 2400。如果换更大的图 / 字号，`UI_ASSET_BUF_SIZE` 会长；Web 导出页会显示实际 RAM。不要为了“省事”把缓冲写死 2400 再靠裁图绕过。

---

## 5. 常见编译 / 链接错误对照

| 报错 | 原因 |
|---|---|
| `redefinition of 'UI_DrawFrame'` | 旧 `app_ui.c` 里的实现没删 |
| `UI_FRAME_REF has no member named 'asset'` | `app_ui.h` 没加字段 |
| `UI_FONT has no member named 'parts'` | 同上 |
| `undefined reference to 'UI_DrawFrameRef'` | `ui_asset_draw.c` 没加入工程，或动态区域还在调 `UI_DrawFrame(f, ...)` |
| `undefined reference to 'UI_DrawAsset'` | `ui_asset_draw.c` 没加入工程 |
| `undefined reference to 'LZSS_Decode'` | `lzss_decode.c` 没加入工程 |
| `UI_ASSET_xxx undeclared` | 没 include `ui_assets_lzss.h`，或文件没导出 |
| `duplicate symbol Asset_Decode` | 旧 `asset_lzss.c` 还在工程里 |
| LZSS 帧全空白 | `UI_DrawFrameRefAt` 还在 `if (!f->px) return;` |
| 字体左右错位 / 被切 | 没按 `parts/partW` 画，或最后一片宽度用了 `partW` 而不是表项 `w` |

---

## 6. 验收清单

- [ ] `UI_DrawFrame(id)` 的 id 覆盖 `0..UI_FRAME_N-1`，越界不崩；
- [ ] raw 帧、LZSS 帧、`index=255`、`index` 多帧四种情况都画对；
- [ ] 数字 2/3 交替无 1px 位移（`glyphDx` 已烘进字模）；
- [ ] 电池 14 帧、`frames_1021` 多帧、仅素材 / 仅尺寸层都正常；
- [ ] `LZSS_Decode` 对每块 `rawlen = w*h*bpp` 解码成功，host 端与源字节逐字节相等；
- [ ] `UI_ASSET_BUF_SIZE`、4 字节对齐、栈余量、内部 Flash 余量都复核；
- [ ] 旧 `asset_lzss.c/asset_blocks.h/ui_assets_packed.c` 已从 Keil 移除，`ui_assets_ext.c` 不再承载 LZSS 素材；
- [ ] 混合工程（raw 内部 / 外部 + LZSS）仍能编过，raw 路径没被新逻辑带坏。

---

## 7. 生成物清单（Web 一键导出）

LZSS 工程应包含：

| 文件 | 作用 |
|---|---|
| `ui_assets_lzss.c` | `g_uiAssetBlob[]` + `g_uiAssets[]`（表） |
| `ui_assets_lzss.h` | `UI_Asset`、`UI_FMT_*`、`UI_ASSET_*`、`UI_ASSET_BUF_SIZE` |
| `lzss_decode.c/.h` | 通用 LZSS 解码（无工程常量） |
| `ui_asset_draw.c/.h` | 渲染桥：顶层 2 函数 + 内部 `UI_DrawAsset/UI_DrawGlyph` |
| `ui_table.c/.h` | 帧表 `.asset/.assetChunks`、`UI_FRAME_N`、`g_uiFrames[]` |
| `ui_font.c` | LZSS 字库：`.glyph = 0` + `.assetBase/.assetChunks/.parts/.partW` |

不再生成：`ui_assets_packed.c`、`asset_blocks.h`、`asset_lzss.c/.h`、旧固定布局的 34 块。

---

## 8. 如果只能先做一件事

先把 `UI_DrawFrameRefAt` 里 `px == 0` 的分支改成检查 `.asset`。  
否则所有 LZSS 帧都是空白，后面调什么都没意义。
