/*
 * app_ui.c —— 表驱动 UI 框架实现 (消费网页导出物)
 *
 * 详见 app_ui.h 与 doc/网页UI移植计划.md。要点:
 *   · 动态区域由 UI_Tick() 以 1ms 周期检查, 值变才画; 一次 tick 最多画一个区域
 *   · 数字走灰度位图字库 (UI_FONT, 1B/px), 经 LCD_drawGrayImage × 颜色输出;
 *     定宽 + 固定小数位 + 左/右/居中对齐 (居中是**像素级**的, 与网页 numFieldLead 同式)
 *   · 位图/多行菜单走 LCD_drawImage / LCD_drawGrayImage, 颜色由渲染时给
 *     (菜单每行一个颜色: 同一张灰度掩码, 逐行传不同 color)
 *
 * 2026-10-20 (网页重新导出后):
 *   · UI_FRAME_REF.px / UI_FONT.glyph 改成 const void * —— 内部素材是 uint8_t[],
 *     外部 W25Q 素材是 uint16_t[] (见 app_ui.h 的说明); 读的时候统一转成字节指针,
 *     按 fmt 决定每像素 1B / 2B。
 *   · 外部指针 (0x01000000 段) 不在这里解引用: 一律交给 LCD_draw* 的地址分流
 *     (bsp_gc9a01.c 走 W25Q 逐行读), 所以本文件不做任何指针有效性判断。
 */
#include "ui_user.h"        /* 工程自己的宏 (UI_BG_COLOR 等): 必须排在 app_ui.h 之前,
                             * 否则 app_ui.h 里的默认值先落地, 这份就盖不掉了 */
#include "app_ui.h"
#include "ui_asset_draw.h"  /* 新导出: UI_DrawFrame/At + 内部 RefAt + UI_DrawGlyph */
#include "app_lcd.h"
#include "bsp_gc9a01.h"

/* 区域表: 由网页导出物通过 UI_SetFields() 注入 (MVP 用手写示例表) */
static UI_FIELD *s_tbl = 0;
static uint16_t  s_n   = 0;

/* 数字区域"隐藏"开关 (app_ui.h 里 extern; 固件可在 ui_user.h / 别处置 1) */
int32_t g_uiHideDigits = 0;

void UI_SetFields(UI_FIELD *tbl, uint16_t n)
{
    s_tbl = tbl;
    s_n   = n;
}

void UI_Init(void)
{
    uint16_t i;
    uint8_t  k;
    for (i = 0; i < s_n; i++) {
        s_tbl[i].drawn = 0;
        s_tbl[i].lastCells = 0;
        s_tbl[i].lastStartX = 0;
        for (k = 0u; k < 8u; k++) s_tbl[i].lastCh[k] = 0u;
        if (s_tbl[i].src) s_tbl[i].last = *s_tbl[i].src;
    }
}

/* 作废差分状态: 下一次 UI_DrawField 整格重画 (页清屏/面板重初始化后用) */
void UI_FieldInvalidate(UI_FIELD *fld)
{
    uint8_t k;
    if (!fld) return;
    fld->lastCells  = 0;
    fld->lastStartX = 0;
    for (k = 0u; k < 8u; k++) fld->lastCh[k] = 0u;
    fld->drawn = 0;
}

/* ============================================================
 *  数值 → 有效数字串 (不带定宽补位; 负号在前)
 *  value 是"已放大 10^dec 倍"的整数, 例如 value=1234, dec=2 → "12.34"
 * ============================================================ */
static int8_t ui_num_sig(char *buf, uint8_t bufsz, int32_t value, uint8_t dec)
{
    char     tmp[18];
    uint8_t  n = 0, i;
    uint8_t  neg = 0;
    uint32_t v;

    if (dec > 6) dec = 6;
    if (value < 0) {
        neg = 1;
        /* 无符号绝对值: -(-2147483648) 不能直接取负, 先 +1 再取反再加 1 */
        v = (uint32_t)(-(value + 1)) + 1u;
    } else {
        v = (uint32_t)value;
    }

    /* 低位在前生成 (含小数点) */
    if (dec) {
        for (i = 0; i < dec; i++) { tmp[n++] = (char)('0' + (v % 10u)); v /= 10u; }
        tmp[n++] = '.';
    }
    do {
        tmp[n++] = (char)('0' + (v % 10u));
        v /= 10u;
    } while (v > 0u);

    if (neg) tmp[n++] = '-';
    if ((uint8_t)(n + 1) > bufsz) return -1;

    for (i = 0; i < n; i++) buf[i] = tmp[n - 1 - i];       /* 反转输出 */
    buf[n] = '\0';
    return (int8_t)n;
}

/* ============================================================
 *  数值 → 定宽字符串 (定宽右对齐 + 固定小数位)
 *  cells 为定宽格数: 不足时左侧补空格(pad=0)或补零(pad=1), 放不下返回 -1
 *  ！渲染不要用这里的空格补位做居中 —— UI_DrawField 用 ui_num_sig() 算像素级
 *    的对齐 (与网页 numFieldLead 一致); 本函数保留给外部/调试使用。
 * ============================================================ */
int8_t UI_FormatNum(char *buf, uint8_t bufsz, int32_t value,
                    uint8_t dec, uint8_t cells, uint8_t pad)
{
    char    sig[18];
    int8_t  n = ui_num_sig(sig, sizeof(sig), value, dec);
    uint8_t k = 0, i;

    if (n < 0 || (uint8_t)n > cells || (uint8_t)(cells + 1) > bufsz) return -1;

    if (pad) {
        /* 补零: 符号先出, 零补在符号与数字之间 (不跨小数点) */
        if (sig[0] == '-') buf[k++] = '-';
        for (i = (uint8_t)n; i < cells; i++) buf[k++] = '0';
    } else {
        for (i = (uint8_t)n; i < cells; i++) buf[k++] = ' ';
    }
    for (i = 0; i < (uint8_t)n; i++) buf[k++] = sig[i];
    buf[k] = '\0';
    return (int8_t)k;
}

/* ============================================================
 *  素材绘制
 *
 *  UI_DrawFrame(id, color) / UI_DrawFrameAt(...) 由新导出 ui_asset_draw.c 提供:
 *  内部按 raw / LZSS 表自动分派, 本文件不再重复实现 (否则链接期重复定义)。
 *  UI_DrawLine 只服务 raw 多行素材 (当前导出没有多行素材)。
 * ============================================================ */

/* 多行素材的第 line 行 (每行可单独给颜色 → 菜单) */
void UI_DrawLine(const UI_FRAME_REF *f, uint8_t line, uint16_t color)
{
    if (!f || !f->px || !f->lineH) return;
    if (line >= (f->h / f->lineH)) return;

    if (f->fmt == UI_FMT_GRAY8) {
        LCD_drawGrayImage((uint8_t)f->x, (uint8_t)(f->y + line * f->lineH),
                          (uint8_t)f->w, f->lineH,
                          (const uint8_t *)((uint32_t)f->px + (uint32_t)line * f->lineH * f->w),
                          color, f->mirror);
    } else {
        LCD_drawImage((uint8_t)f->x, (uint8_t)(f->y + line * f->lineH),
                      (uint8_t)f->w, f->lineH,
                      (const uint8_t *)((uint32_t)f->px + (uint32_t)line * f->lineH * f->w * 2),
                      color);
    }
}

/* 画一个字模 (raw / LZSS 都由 ui_asset_draw.c 的 UI_DrawGlyph 处理);
 * ch 不在字库范围时用底色填掉这一格 (与网页"空格/越界跳过"同义)。 */
static void ui_draw_glyph(const UI_FONT *ft, uint16_t x, uint16_t y,
                          uint8_t ch, uint16_t color, uint16_t bg)
{
    UI_DrawGlyph(ft, ch, x, y, g_uiHideDigits ? bg : color, bg, 0);
}

/* ============================================================
 *  动态区域
 * ============================================================ */
void UI_DrawField(UI_FIELD *fld)
{
    int32_t v = fld->src ? *fld->src : 0;

    if (fld->type == UI_T_NUM) {
        const UI_FONT *ft = fld->font;
        char     sig[20];
        int8_t   n;
        uint8_t  i, cw, gap, boxW, contentW, startX, lead;
        uint8_t  disp[8], count, layoutChanged;

        n = ui_num_sig(sig, sizeof(sig), v, fld->dec);
        if (n < 0 || (uint8_t)n > fld->cells) return;   /* 放不下就不画 (保持上次内容) */

        if (!ft) {
            if (fld->bg != 0xFFFF)
                LCD_Fill((uint8_t)fld->x, (uint8_t)fld->y,
                         (uint8_t)(fld->x + fld->cells * 8u),
                         (uint8_t)(fld->y + 11u), fld->bg);
            fld->last  = v;
            fld->drawn = 1;
            return;
        }

        gap      = ft->gap;
        cw       = (uint8_t)(ft->w + ft->gap);
        boxW     = (uint8_t)(fld->cells * cw - gap);
        contentW = (uint8_t)((uint8_t)n * cw - gap);

        /* 对齐 (像素级, 与网页 numFieldLead 同式):
         *   pad=1  → 补零, 内容顶右 (与老固件一致)
         *   align C → 内容在整格盒子里居中 (可能落在两格中间, 不是"塞进某一格")
         *   align R → 右对齐; align L → 左对齐 */
        if (fld->pad) {
            lead = (uint8_t)(boxW - contentW);
        } else if (fld->align == UI_ALIGN_C) {
            lead = (uint8_t)((boxW - contentW + 1u) / 2u);
        } else if (fld->align == UI_ALIGN_R) {
            lead = (uint8_t)(boxW - contentW);
        } else {
            lead = 0u;
        }

        /* 把"这一帧要显示的每格字符"展开到 disp[]:
         *   pad=0: 只有 n 个有效字符, 首格在居中/右对齐后的 startX;
         *   pad=1: 前面补 cells-n 个 '0', 从整格盒子左边开始。 */
        if (fld->pad) {
            count = (uint8_t)(fld->cells > 8u ? 8u : fld->cells);
            for (i = 0u; i < count; i++) disp[i] = (uint8_t)'0';
            for (i = 0u; i < (uint8_t)n; i++) {
                uint8_t k = (uint8_t)(count - (uint8_t)n + i);
                if (k < count) disp[k] = (uint8_t)sig[i];
            }
            startX = (uint8_t)fld->x;
        } else {
            count = (uint8_t)n;
            if (count > 8u) count = 8u;
            startX = (uint8_t)(fld->x + lead);
            for (i = 0u; i < count; i++) disp[i] = (uint8_t)sig[i];
        }

        /* 位数/对齐位置变了才整格清一次 (9↔10、居中位置变化);
         * 同布局下只重画"字符变了"的那一格 —— 十位不变就不动十位,
         * 也不再每帧先整格擦黑 (那就是用户看到的"擦除过程")。 */
        layoutChanged = (uint8_t)((fld->lastCells != count) ||
                                  (fld->lastStartX != startX));

        if (layoutChanged) {
            /* pad=1 时 count == cells, startX = x: 几个字模正好铺满整格盒子,
             * 字模自带黑底, 不需要额外 LCD_Fill —— 9→10 / 进页不再有"擦除"过程。
             * 只有非 pad 的位数变化 (如 9↔10 居中位置跳) 才需要清一次盒子。 */
            if (!fld->pad && fld->bg != 0xFFFF) {
                LCD_Fill((uint8_t)fld->x, (uint8_t)fld->y,
                         (uint8_t)(fld->x + boxW), (uint8_t)(fld->y + ft->h),
                         fld->bg);
            }
            for (i = 0u; i < count; i++) {
                ui_draw_glyph(ft, (uint16_t)(startX + i * cw), fld->y,
                              disp[i], fld->color, fld->bg);
            }
        } else {
            for (i = 0u; i < count; i++) {
                if (disp[i] != fld->lastCh[i]) {
                    ui_draw_glyph(ft, (uint16_t)(startX + i * cw), fld->y,
                                  disp[i], fld->color, fld->bg);
                }
            }
        }
        for (i = 0u; i < 8u; i++) fld->lastCh[i] = (i < count) ? disp[i] : 0u;
        fld->lastCells  = count;
        fld->lastStartX = startX;
    } else {
        /* 帧/列表: 下标来自 src (可为常量 0); 多行素材按 lineH 逐行着色 */
        uint16_t idx = (uint16_t)(v < 0 ? 0 : v);
        const UI_FRAME_REF *fr;
        if (!fld->frames || !fld->nframes) return;
        if (idx >= fld->nframes) idx = (uint16_t)(fld->nframes - 1);
        fr = fld->frames[idx];
        if (!fr) return;
        if (fr->lineH) {                         /* 逐行: 高亮行走 lineColor */
            uint8_t ln, rows = (uint8_t)(fr->h / fr->lineH);
            UI_FRAME_REF tmp = *fr;
            tmp.x = fld->x;
            tmp.y = fld->y;
            for (ln = 0; ln < rows; ln++) {
                uint16_t c = (ln == fld->hiLine && fld->lineColor != 0xFFFF)
                             ? fld->lineColor : fld->color;
                UI_DrawLine(&tmp, ln, c);
            }
        } else {
            UI_FRAME_REF tmp = *fr;
            tmp.x = fld->x;
            tmp.y = fld->y;
            UI_DrawFrameRefAt(&tmp, fld->x, fld->y, fld->color);
        }
    }
    fld->last  = v;
    fld->drawn = 1;
}

/* 1ms 周期: 遍历区域表, 只刷第一个变化的区域 (避免多区域挤在一帧里) */
uint8_t UI_Tick(void)
{
    uint16_t i;
    for (i = 0; i < s_n; i++) {
        UI_FIELD *f = &s_tbl[i];
        int32_t   v = f->src ? *f->src : 0;
        if (!f->drawn || v != f->last) {
            UI_DrawField(f);
            return 1;
        }
    }
    return 0;
}

/* 进页面: 静态内容由调用方直接画, 这里把动态区域全画一遍并记下基准值 */
void UI_DrawAll(void)
{
    uint16_t i;
    for (i = 0; i < s_n; i++) UI_DrawField(&s_tbl[i]);
}
