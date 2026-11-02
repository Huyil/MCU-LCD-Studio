/*
 * app_ui.h —— 表驱动的 UI 框架 (网页导出物的消费端)
 *
 * 设计: 网页负责排版/切帧/生成素材与参数表, MCU 只保留这一套通用渲染。
 *   · 静态内容: 进页面时画一次 (直接调 UI_DrawFrame(id, color) / UI_DrawLine)
 *   · 动态内容: 一张 UI_FIELD 表 + 1ms 的 UI_Tick(), "值变没变"在函数内判断,
 *               一次 tick 最多刷一个区域, 避免多区域挤在一帧里造成卡顿
 *
 * 三条渲染路径 (见 doc/网页UI移植计划.md 冻结规格):
 *   字库(1bit/灰度字模) / 灰度 GRAY8(1B/px, 渲染时着色) / 彩色 RGB565(2B/px)
 *   灰度与彩色都支持整体乘法着色: color == 0xFFFF 表示原样输出。
 *   2026-11-02 起网页导出统一走内部 Flash 的通用 LZSS 素材表
 *   (ui_assets_lzss.c / lzss_decode.c / ui_asset_draw.c), 不再依赖外部 W25Q。
 */
#ifndef __APP_UI_H__
#define __APP_UI_H__

#include <stdint.h>
#include "bsp_gc9a01.h"     /* LCD_Fill / LCD_drawImage / LCD_drawGrayImage 原型 */

/* 数字区域"隐藏"开关: 非 0 时数字区域不显示数值 (导出物/别的模块可能 extern 引用,
 * 本文件保留符号; 定义在 app_ui.c)。 */
extern int32_t g_uiHideDigits;

/* ---------------- 素材格式 ---------------- */
#define UI_FMT_RGB565   0       /* px 为 uint16 RGB565, 2B/px */
#define UI_FMT_GRAY8    1       /* px 为 8bit 灰度掩码, 1B/px  */

/* 一块素材/一帧; 多行时用 lineH 按行切 (每行可单独指定颜色)
 *
 * ！px 用 const void * 而不是 const uint8_t * (2026-10-20):
 *   网页导出物把**内部 Flash 素材**写成 const uint8_t[]，把**外部 W25Q 素材**
 *   写成 const uint16_t[] (最终形态, 灰度字节按内存字节序打包) —— 同一个
 *   UI_FRAME_REF 要同时接住两种指针。C 里只有 void * 能无损接收两者;
 *   真正的读取粒度由 fmt 决定 (跟驱动按字节还是按 16 位值读一致)。 */
typedef struct {
    const void *px;
    uint16_t x, y;
    uint16_t w, h;
    uint8_t  lineH;             /* 0 = 单块; >0 = 多行素材, 每行高 lineH */
    uint8_t  fmt;               /* UI_FMT_* */
    uint8_t  mirror;
    uint8_t  index;             /* px 数组里画第几帧 (0 基); 255 = 网页的 -1 (仅网页渲染) */
    uint16_t asset;             /* LZSS 首片 ID (UI_ASSET_NONE = 非 LZSS) */
    uint8_t  assetChunks;       /* 每帧片数; 0 = 非 LZSS */
} UI_FRAME_REF;

/* 帧 = -1 (仅网页渲染) 时 MCU 侧只清底色 —— 纯色, 不区分图案 (工程可在 ui_user.h 覆盖) */
#ifndef UI_BG_COLOR
#define UI_BG_COLOR     0x0000u
#endif

/* ---------------- 灰度位图字库 ----------------
 * 字模是 8bit 灰度 (1B/px), 渲染时经 LCD_drawGrayImage × 颜色输出 ——
 * 旧的点阵字库函数(LCD_drawChar/drawString)已移除, 字库统一走这里。
 * 字模数据由网页导出 (可用固件原 ASCII 字模, 也可用任意图片分割的字库)。 */
typedef struct {
    const void *glyph;      /* count 个字模顺序排列, 每个 w*h 字节; 内部 uint8_t[] / 外部 uint16_t[] 都走这里 */
    uint8_t w, h;           /* 单字尺寸 */
    uint8_t gap;            /* 字距 (px) */
    uint8_t first;          /* 首字符码 (数字一般是 '0') */
    uint8_t count;          /* 字模个数 */
    /* LZSS 字库 (glyph == 0 时生效): 每个字形 parts 片, 每片宽 partW (最后一片可能更窄) */
    uint16_t assetBase;     /* 首片 ID (UI_ASSET_<key>GlyphP0) */
    uint8_t  assetChunks;   /* 每字形片数 */
    uint8_t  parts;         /* 横向分片数 (1 = 不分片) */
    uint8_t  partW;         /* 每片宽 (px) */
} UI_FONT;

/* ---------------- 动态区域 ---------------- */
#define UI_T_NUM    0           /* 数字: 定宽 + 固定小数位 + 对齐, 用字库画 */
#define UI_T_FRAME  1           /* 位图/帧: 内容由 src 指向的下标选择 (可为常量) */
#define UI_T_LIST   2           /* 列表下标: 内容 = 列表[*src], 如字符串/帧列表 */

#define UI_ALIGN_L  0
#define UI_ALIGN_R  1
#define UI_ALIGN_C  2

typedef struct {
    uint8_t  type;              /* UI_T_* */
    uint8_t  dec;               /* 数字: 固定小数位 (0..6) */
    uint8_t  align;             /* UI_ALIGN_* */
    uint8_t  cells;             /* 数字: 定宽字符格数 (不足补空格/前导零) */
    uint8_t  pad;               /* 数字: 1 = 补前导零, 0 = 补空格 */
    uint16_t x, y;
    uint16_t color;             /* 0xFFFF = 用素材本色 */
    uint16_t bg;                /* 数字补空格/清底用底色; 0xFFFF = 不填 */
    uint16_t lineColor;         /* 多行素材: 当前高亮行颜色 (0xFFFF = 不用) */
    uint8_t  hiLine;            /* 多行素材: 高亮行号 (0xFF = 无) */
    const int32_t *src;         /* 数值/下标来源; NULL = 常量 0 */
    const UI_FONT *font;                /* type = NUM: 数字用的灰度字库 */
    const UI_FRAME_REF *const *frames;  /* 帧/列表数组 (type != NUM) */
    uint16_t nframes;
    int32_t  last;              /* 上次值: 变化才刷 */
    uint8_t  drawn;             /* 进页面后是否画过 */
    /* 数字逐格差分的上次状态 (app_ui.c 维护; 导出表不用初始化) */
    uint8_t  lastCells;         /* 上次画的格数 (0 = 未画 / 已作废) */
    uint8_t  lastStartX;        /* 上次首格 x (对齐/位数变化时整格重画) */
    uint8_t  lastCh[8];         /* 上次每格字符; 0 = 未画 */
} UI_FIELD;

/* ---------------- 对外接口 ---------------- */
void    UI_Init(void);                      /* 清表状态 (进页面时调) */
/* 顶层静态帧: id = g_uiFrames 下标 (实现见 ui_asset_draw.c) */
void    UI_DrawFrame(uint16_t id, uint16_t color);
void    UI_DrawFrameAt(uint16_t id, uint16_t x, uint16_t y, uint16_t color);
void    UI_DrawLine (const UI_FRAME_REF *f, uint8_t line, uint16_t color);
void    UI_DrawField(UI_FIELD *fld);        /* 差分重画一个区域 (只画变化的格) */
void    UI_FieldInvalidate(UI_FIELD *fld);  /* 作废差分状态: 下一次全画 (页清屏/重初始化后) */
uint8_t UI_Tick(void);                      /* 1ms 调用; 返回本次刷了几个区域(0/1) */

/* 数值 → 定宽字符串 (右对齐, 固定小数位)。返回写入的字符数; 缓冲区不足返回 -1 */
int8_t  UI_FormatNum(char *buf, uint8_t bufsz, int32_t value,
                     uint8_t dec, uint8_t cells, uint8_t pad);

/* 注册/使用区域表 (网页导出后替换实现即可) */
void    UI_SetFields(UI_FIELD *tbl, uint16_t n);
void    UI_DrawAll(void);                   /* 进页面: 静态+动态全画一遍 */

#endif /* __APP_UI_H__ */
