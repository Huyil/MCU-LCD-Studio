# LZSS 素材格式与固件接入

本文是 Web 导出物在 MCU 侧的格式说明。第一次接入建议直接看 [`examples/render-port`](../examples/render-port)，那份示例已经把这些接口跑通。

## 1. 一张表 + 一个 blob

所有 LZSS 素材共用：

```c
typedef struct {
    uint16_t off;      /* g_uiAssetBlob 偏移 */
    uint16_t clen;     /* 压缩流长度 */
    uint16_t w, h;     /* 片宽/片高 */
    uint16_t y;        /* 片在整帧里的 y 偏移（帧分片按行） */
    uint8_t  fmt;      /* UI_FMT_RGB565 / UI_FMT_GRAY8 */
    uint8_t  flags;    /* 预留 */
} UI_Asset;

extern const UI_Asset g_uiAssets[];
extern const uint8_t  g_uiAssetBlob[];
```

- 表项 12 B；`off/clen` 是 `uint16_t`，整个 blob 必须小于 64 KB；
- `rawlen = w * h * (fmt == UI_FMT_GRAY8 ? 1 : 2)`，不占表项；
- `UI_ASSET_BUF_SIZE` 是实际最大片，解码缓冲按它开，且 4 字节对齐；
- 帧/图片分片只按行；字模左右条在字库层拆，不进入通用帧表。

## 2. 帧结构

```c
typedef struct {
    const void *px;
    uint16_t x, y, w, h;
    uint8_t  lineH, fmt, mirror, index;
    uint16_t asset;        /* LZSS 首片；非 LZSS = UI_ASSET_NONE */
    uint8_t  assetChunks;  /* 每帧片数；非 LZSS = 0 */
} UI_FRAME_REF;
```

`UI_DrawFrameRefAt()` 的分派顺序：

```c
if (f->index == 255u) { 只清底色; return; }
if (f->px) { raw 数组; return; }
if (f->asset != UI_ASSET_NONE && f->assetChunks) {
    UI_DrawAsset(f->asset + f->index * f->assetChunks, f->assetChunks, ...);
    return;
}
/* 其余 = 仅尺寸，不画 */
```

`index == 255` 只表示“只清底色”；LZSS 帧的 `.px` 是 0，不能因为 `!px` 就直接返回。

## 3. 字库结构

```c
typedef struct {
    const void *glyph;     /* 非 0 = raw；0 = LZSS */
    uint8_t w, h, gap, first, count;
    uint16_t assetBase;    /* 第 0 片 */
    uint8_t assetChunks;   /* 每片再分几块 */
    uint8_t parts;         /* 每个字形几片 */
    uint8_t partW;         /* 每片宽；最后一片可能更窄 */
} UI_FONT;
```

`UI_DrawGlyph()` 按 part-major 取片：

```c
parts = ft->parts ? ft->parts : 1;
for (p = 0; p < parts; p++) {
    UI_DrawAsset(ft->assetBase + (p * ft->count + (ch - ft->first)) * ft->assetChunks,
                 ft->assetChunks, x + p * ft->partW, y, color, bg, mirror);
}
```

54×80 系统字默认 `parts=2, partW=27`；不要硬编码 27/80/2400。

## 4. 渲染接口

顶层：

```c
void UI_DrawFrame(uint16_t id, uint16_t color);
void UI_DrawFrameAt(uint16_t id, uint16_t x, uint16_t y, uint16_t color);
```

`id` 是 `g_uiFrames` 下标，即 `g_uiFrameN` 的 `N`；`ui_table.h` 提供 `UI_FRAME_N`。

内部：

```c
void UI_DrawFrameRef(const UI_FRAME_REF *f, uint16_t color);
void UI_DrawFrameRefAt(const UI_FRAME_REF *f, uint16_t x, uint16_t y, uint16_t color);
void UI_DrawAsset(uint16_t first, uint8_t chunks, uint16_t x, uint16_t y,
                  uint16_t color, uint16_t bg, uint8_t mirror);
void UI_DrawGlyph(const UI_FONT *ft, uint8_t ch, uint16_t x, uint16_t y,
                  uint16_t color, uint16_t bg, uint8_t mirror);
```

- 静态页用 `UI_DrawFrame(id)`；
- `UI_FIELD.frames` 指针数组用 `UI_DrawFrameRef/RefAt`；
- 数字用 `UI_DrawField(&g_uiFields[i])`，业务层不用直接调 `UI_DrawGlyph`。

## 5. 解码器

```c
uint16_t LZSS_Decode(const uint8_t *src, uint16_t clen,
                     uint8_t *dst, uint16_t rawlen, uint16_t cap);
```

成功返回 `rawlen`，失败返回 0；无 malloc、无 stdio，历史在 `dst` 里，不需要额外窗口 RAM。

## 6. 生成文件

```text
ui_assets_lzss.c/.h     表 + blob + UI_ASSET_* 宏
ui_asset_draw.c/.h      渲染桥 / 解码缓冲
lzss_decode.c/.h        通用解码器
ui_table.c/.h           帧表 / 动态区域 / UI_FRAME_N
ui_font.c               字库描述 + battery()/frames_1021()
ui_color.h              颜色宏
```

`ui_assets_lzss.h` 里的 `UI_ASSET_<key>` / `_N` / `_C` 由导出器生成，不要手写。

## 7. 常见错误

| 现象 | 原因 |
|---|---|
| LZSS 帧全空白 | `UI_DrawFrameRefAt` 里 `if (!f->px) return;` 没改成检查 `.asset` |
| 多帧一直画第 0 帧 | raw 没按 `index` 偏移；LZSS 没加 `index * assetChunks` |
| 字模左右错位/被切 | 没按 `parts/partW` 循环，或最后一片宽度用了 `partW` |
| 数字不刷新 | 没调 `UI_DrawField`，或主循环没跑 `timer_loop()` |
| 解码越界/花屏 | `UI_ASSET_BUF_SIZE` 小于最大片，或缓冲没 4 字节对齐 |
| 链接重复 | 旧 `UI_DrawFrame` / 旧 `Asset_Decode` 没从工程移除 |

## 8. 最小接入

直接看 [`examples/render-port/README.md`](../examples/render-port/README.md)：

```c
LCD_Init();
Page0Port_Init();
Page0Port_Enter();
g_uiSpeed = 66;
UI_DrawField(&g_uiFields[0]);
while (1) timer_loop();
```
