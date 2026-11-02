#include "bsp_ring.h"
#include "ring_tables.h"
#if RING_ARC_GRAD
#include "ring_grad.h"
#endif

#if (RING_TABLES_R_IN != RING_R_IN) || (RING_TABLES_R_OUT != RING_R_OUT) || \
    (RING_TABLES_SPAN_DEG != RING_SPAN_DEG) || (RING_TABLES_SHAPE != RING_SHAPE) || \
    (RING_TABLES_SIGMA_X10 != RING_SIGMA_X10) || (RING_TABLES_AA_X10 != RING_COV_AA_X10) || \
    (RING_TABLES_DEPTH != RING_DEPTH_DEF) || (RING_TABLES_STYLE != RING_DEPTH_STYLE_DEF) || \
    (RING_TABLES_LIGHT_DEG != RING_LIGHT_DEG_DEF)
#error "ring_tables.h is stale vs ring_config.h: run \"python tools/ring_sim/gen_tables.py\" (SHAPE/R_IN/R_OUT/SPAN/SIGMA/AA/DEPTH/STYLE/LIGHT must match)"
#endif

#ifdef RING_SIM

extern volatile uint8_t busy;
void LCD_RingBegin(void);
uint8_t LCD_RingRun(uint16_t x, uint16_t y, uint8_t n, const uint16_t* px);

void LCD_RingEnd(void);
#else

#include "bsp_gc9a01.h"

#endif

/* 示例 (CW32L011) 没有 EAU 外设: 用软件 isqrt, 不引 CW32L012 的 EAU 头。 */
#define RING_USE_EAU 0

#ifdef RING_SIM
#  ifndef LCD_W
#    define LCD_W 240
#  endif
#  ifndef LCD_H
#    define LCD_H 135
#  endif
#endif
#ifndef RING_SCR_W
#  define RING_SCR_W        LCD_W
#endif
#ifndef RING_SCR_H
#  define RING_SCR_H        LCD_H
#endif

#ifndef RING_PCLK_HZ
#define RING_PCLK_HZ   24000000UL
#endif
#if ((RING_PCLK_HZ / 10000UL) < 1UL) || ((RING_PCLK_HZ / 10000UL - 1UL) > 0xFFFFUL)
#error "RING_PCLK_HZ does not fit the 16-bit BTIM3 prescaler at 10kHz"
#endif
#define RING_BTIM_PSC  ((uint16_t)(RING_PCLK_HZ / 10000UL - 1UL))

RingState ring;

/* 遥测: 引擎往屏上推了几次环 —— g_ringPaints 连增量窗口一起算, g_ringFullPaints 只算
 * 整圈重画 (本板一次 ~300ms/30KB 的那个)。判"进页有没有白重画一次"看后者: 开机动画
 * 自己那一次之后, 页首 Ring_SetBg/Ring_Start 与首次 RingUI_Redraw 都不该再整圈画。 */
volatile uint16_t g_ringPaints;
volatile uint16_t g_ringFullPaints;
/* 其中"只补画变化扇区"的次数 (增量) */
volatile uint16_t g_ringPartialPaints;
/* 调试: Ring_ApplySeg 的调用/增量/退化整弧次数 (判断换档为什么走全量) */
volatile uint16_t g_dbgSegCalls, g_dbgSegDelta, g_dbgSegFull;

#define RING_RUN_MAX    64

#if RING_GLINT_DEF

static uint8_t s_arcDirty;
#endif

static uint8_t s_arcPainted;

static uint32_t s_arcSweepPainted;

/* 屏上已经画到第几段 (增量重画的基准; 全量重画时由 ring_paint_mark 从 sweep 反推) */
static uint8_t  s_litPainted;

/* 段驱动时"最后一段 body 的终点"的**精确**角度 (Q8 度, 相对弧起点)。
 * Ring_SegSweep() 只有 0.5° 分辨率 (末端向上取整, 多出来的量落在缝里),
 * 端点 AA 需要知道真正的 body 边沿, 否则羽化会落在缝里、离填充边半个像素。
 * 只由 Ring_ApplySeg()/Ring_SetLitNoPaint() 摆; ring_arc_update() 会核对它
 * 与 sweep 是否一致 (差在半度内), 对不上就退回 sweep —— 防止陈旧值串到
 * Ring_ApplyArc() 的任意扫弧上。 */
static uint32_t s_fillEndQ8;
static uint8_t  s_fillEndValid;

#if RING_GLINT_DEF

#define RING_BUF_PX     1216
#define RING_BUF_ROWS   80

#if RING_SHAPE == 0
#if (RING_R_OUT - RING_R_IN) > (RING_BUF_ROWS - 8)
#error "ring band too thick for RING_BUF_ROWS: raise RING_BUF_ROWS (need >= R_OUT-R_IN+8) or raise RING_R_IN"
#endif
#endif

static uint8_t s_val[RING_BUF_PX];

#if RING_SHAPE == 1
#  define RING_PER_PX       ((RING_PER_Q8) >> 8)
#  define RING_COORD_MAX_X  (((RING_SCR_W) > ((RING_CX) + (((RING_O_HX) + 255) >> 8) + 1)) \
                             ? (RING_SCR_W) : ((RING_CX) + (((RING_O_HX) + 255) >> 8) + 1))
#  define RING_COORD_MAX_Y  (((RING_SCR_H) > ((RING_CY) + (((RING_O_HY) + 255) >> 8) + 1)) \
                             ? (RING_SCR_H) : ((RING_CY) + (((RING_O_HY) + 255) >> 8) + 1))
#else
#  define RING_PER_PX       ((22 * ((RING_R_IN) + (RING_R_OUT))) / 7)
#  define RING_COORD_MAX_X  ((RING_CX) + (RING_R_OUT) + 1)
#  define RING_COORD_MAX_Y  ((RING_CY) + (RING_R_OUT) + 1)
#endif

#define RING_COORD_MAX_LEN  ((RING_PER_PX) * (4 * (RING_SPAN_DEG) + RING_GEAR_MAX) / 720 + 8)
#if ((RING_COORD_MAX_X) > 255) || ((RING_COORD_MAX_Y) > 255) || ((RING_COORD_MAX_LEN) > 255)
#  define RING_XY_T         uint16_t
#else
#  define RING_XY_T         uint8_t
#endif

#if ((RING_COORD_MAX_X) > 65535) || ((RING_COORD_MAX_Y) > 65535) || ((RING_COORD_MAX_LEN) > 65535)
#error "ring coords exceed 16-bit (LCD CASET/RASET limit): check RING_CX/CY and the ring size"
#endif

static RING_XY_T s_runX[RING_BUF_ROWS][2];
static RING_XY_T s_runL[RING_BUF_ROWS][2];
#if RING_SHAPE == 0
static uint8_t s_rowY0;
static uint8_t s_rowN;
#endif
#endif

uint8_t Ring_GetHwTrig(void) { return 0; }

static uint16_t ring_norm(int16_t a)
{
    while (a < 0) a = (int16_t)(a + RING_ANG_UNITS);
    while (a >= RING_ANG_UNITS) a = (int16_t)(a - RING_ANG_UNITS);
    return (uint16_t)a;
}

#if RING_SHAPE == 0
static void ring_tab_unit(uint16_t a, int16_t *pc, int16_t *ps)
{
    int16_t c, s;

    if (a < 180) {
        c =  ringCosQ14[a];
        s =  ringCosQ14[180 - a];
    } else if (a < 360) {
        c = -ringCosQ14[360 - a];
        s =  ringCosQ14[a - 180];
    } else if (a < 540) {
        c = -ringCosQ14[a - 360];
        s = -ringCosQ14[540 - a];
    } else {
        c =  ringCosQ14[720 - a];
        s = -ringCosQ14[a - 540];
    }
    *pc = c;
    *ps = s;
}
#endif

#if (RING_GLINT_DEF || RING_ARC_GRAD || RING_SEG_ON) && (RING_SHAPE == 0)

static uint16_t ring_tab_atan2(int16_t dy, int16_t dx)
{
    int16_t ax = (dx < 0) ? -dx : dx;
    int16_t ay = (dy < 0) ? -dy : dy;
    uint16_t b, t;
    int16_t phi;

    if (ax == 0 && ay == 0) return 0;

    if (ay <= ax) {
        uint16_t maj = (ax < RING_RECIP_N) ? (uint16_t)ax : (RING_RECIP_N - 1);
        t = (uint16_t)(((uint32_t)ay * ringRecip[maj]) >> 8);
        if (t > 256) t = 256;
        b = ringAtanTab[t];
        phi = (int16_t)b;
    } else {
        uint16_t maj = (ay < RING_RECIP_N) ? (uint16_t)ay : (RING_RECIP_N - 1);
        t = (uint16_t)(((uint32_t)ax * ringRecip[maj]) >> 8);
        if (t > 256) t = 256;
        b = ringAtanTab[t];
        phi = (int16_t)(180 - b);
    }
    if (dx < 0) phi = (int16_t)(360 - phi);
    if (dy < 0) phi = (int16_t)(-phi);

    phi = (int16_t)(phi + RING_ANG_UNITS);
    if (phi >= RING_ANG_UNITS) phi = (int16_t)(phi - RING_ANG_UNITS);
    if (phi >= RING_ANG_UNITS) phi = (int16_t)(phi - RING_ANG_UNITS);
    return (uint16_t)phi;
}

#endif

#ifndef RING_USE_EAU
#  ifdef RING_SIM
#    define RING_USE_EAU 0
#  else
#    define RING_USE_EAU 1
#  endif
#endif

#if RING_USE_EAU
static int16_t ring_tab_isqrt(uint32_t v)
{
    uint32_t pm;
    int16_t  r;

    pm = __get_PRIMASK();
    __disable_irq();
    CW_EAU->CSR      = (CW_EAU->CSR & ~EAU_CSR_MODE_Msk) | (uint32_t)EAU_MODE_SQRT;
    CW_EAU->DIVIDEND = v;
    while (CW_EAU->CSR & EAU_CSR_BUSY_Msk) { }
    r = (int16_t)CW_EAU->QUOTIENT;
    __set_PRIMASK(pm);
    return r;
}
#else
static int16_t ring_tab_isqrt(uint32_t v)
{
    uint32_t rem = 0, root = 0;
    int16_t i;
    for (i = 15; i >= 0; i--) {
        root <<= 1;
        rem = (rem << 2) | ((v >> (i * 2)) & 3u);
        if (root < rem) {
            rem -= root + 1;
            root += 2;
        }
    }
    return (int16_t)(root >> 1);
}
#endif

#if (RING_GLINT_DEF || RING_ARC_GRAD || RING_SEG_ON) && (RING_SHAPE == 0)
static uint16_t ring_atan2(int16_t dy, int16_t dx)
{
    return ring_tab_atan2(dy, dx);
}
#endif

#if RING_SHAPE == 0
static void ring_unit(uint16_t a, int16_t *pc, int16_t *ps)
{
    ring_tab_unit(a, pc, ps);
}

/* Q8 角 (整圆 = 720*128) -> 单位向量: 0.5° 表 + 线性插值。
 * 段边界/弧端点的位置都带 0.0001° 尾数, 直接落到 0.5° 表上会把 AA 的
 * 50% 线钉在 1px 网格上 —— 插值后射线位置精确到 Q8。 */
static void ring_unit_q8(int32_t q8, int16_t *pc, int16_t *ps)
{
    uint16_t au, fr;
    int16_t  c0, s0, c1, s1;

    q8 %= (RING_ANG_UNITS * 128);
    if (q8 < 0) q8 += (RING_ANG_UNITS * 128);
    au = (uint16_t)(q8 >> 7);
    fr = (uint16_t)(q8 & 127);

    ring_tab_unit(au, &c0, &s0);
    ring_tab_unit(ring_norm((int16_t)(au + 1u)), &c1, &s1);
    *pc = (int16_t)((int32_t)c0 + (((int32_t)(c1 - c0) * (int32_t)fr) >> 7));
    *ps = (int16_t)((int32_t)s0 + (((int32_t)(s1 - s0) * (int32_t)fr) >> 7));
}
#endif

static int16_t ring_isqrt(uint32_t v)
{
    return ring_tab_isqrt(v);
}

#if RING_SHAPE == 0

static uint8_t ring_cov(uint32_t r2)
{
    uint32_t i = (r2 - (uint32_t)(RING_R_IN * RING_R_IN)) >> 5;
    if (i >= RING_COV_R2_N) i = RING_COV_R2_N - 1;
    return ringCovR2[i];
}
#endif

#if RING_GLINT_DEF && (RING_SHAPE == 0)
static uint8_t ring_in_range(int16_t a, int16_t a0, int16_t len)
{
    int16_t d = (int16_t)(a - a0);
    if (d < 0) d = (int16_t)(d + RING_ANG_UNITS);
    if (d >= RING_ANG_UNITS) d = (int16_t)(d - RING_ANG_UNITS);
    return (uint8_t)(d <= len);
}

static uint8_t ring_in_sector(int16_t dx, int32_t k0, int16_t s0, int32_t k1, int16_t s1)
{
    return (uint8_t)((k0 - (int32_t)s0 * dx) >= 0 && (k1 - (int32_t)s1 * dx) <= 0);
}

static void ring_extend_y(int16_t a, int16_t *py0, int16_t *py1)
{
    int16_t c, s, y;
    ring_unit(ring_norm(a), &c, &s);
    y = (int16_t)(RING_CY + (((int32_t)RING_R_IN * s + 8192) >> 14));
    if (y < *py0) *py0 = y;
    if (y > *py1) *py1 = y;
    y = (int16_t)(RING_CY + (((int32_t)RING_R_OUT * s + 8192) >> 14));
    if (y < *py0) *py0 = y;
    if (y > *py1) *py1 = y;
}

static uint8_t ring_chunk_rows(int16_t a0, int16_t len, uint8_t *py0)
{
    int16_t y0 = 32000, y1 = -32000;

    ring_extend_y(a0, &y0, &y1);
    ring_extend_y((int16_t)(a0 + len), &y0, &y1);
    if (ring_in_range(180, a0, len) && RING_CY + RING_R_OUT > y1) y1 = RING_CY + RING_R_OUT;
    if (ring_in_range(540, a0, len) && RING_CY - RING_R_OUT < y0) y0 = RING_CY - RING_R_OUT;
    if (y0 < 0) y0 = 0;
    if (y1 > (RING_SCR_H - 1)) y1 = (RING_SCR_H - 1);

    if (y0 > 0) y0--;
    if (y1 < (RING_SCR_H - 1)) y1++;
    *py0 = (uint8_t)y0;
    return (uint8_t)(y1 - y0 + 1);
}

static void ring_compute(int16_t a0, int16_t len, int16_t newC, int16_t stepU, int8_t dir, uint8_t eraseOnly)
{
    const uint32_t RIN2  = (uint32_t)(RING_R_IN * RING_R_IN);
    const uint32_t ROUT2 = (uint32_t)(RING_R_OUT * RING_R_OUT);
    int16_t y0, y;
    int16_t s_c0, s_s0, s_c1, s_s1;
    uint16_t nVal = 0;

    s_rowN = ring_chunk_rows(a0, len, (uint8_t *)&s_rowY0);

    if (s_rowN > RING_BUF_ROWS) s_rowN = RING_BUF_ROWS;
    y0 = (int16_t)s_rowY0;

    ring_unit(ring_norm((int16_t)(a0 - 1)), &s_c0, &s_s0);
    ring_unit(ring_norm((int16_t)(a0 + len + 1)), &s_c1, &s_s1);

    for (y = y0; y < y0 + s_rowN; y++) {
        int16_t dy  = (int16_t)(y - RING_CY);
        uint32_t dy2 = (uint32_t)((int32_t)dy * dy);
        uint8_t ri  = (uint8_t)(y - y0);
        int8_t  side;
        int32_t k0, k1;

        s_runL[ri][0] = 0;
        s_runL[ri][1] = 0;
        if (dy2 >= ROUT2) continue;
        k0 = (int32_t)s_c0 * dy;
        k1 = (int32_t)s_c1 * dy;

        for (side = 1; side >= -1; side -= 2) {
            int16_t inner = (dy2 < RIN2) ? ring_isqrt(RIN2 - dy2) : 0;
            int16_t outer = ring_isqrt(ROUT2 - dy2);
            int16_t xa, xb, x, lo = -1, hi = -1;

            if (side > 0) { xa = (int16_t)(RING_CX + inner); xb = (int16_t)(RING_CX + outer); }
            else          { xa = (int16_t)(RING_CX - outer); xb = (int16_t)(RING_CX - inner - ((inner == 0) ? 1 : 0)); }
            if (xb < 0 || xa > (RING_SCR_W - 1) || xa > xb) continue;
            if (xa < 0) xa = 0;
            if (xb > (RING_SCR_W - 1)) xb = (RING_SCR_W - 1);

            for (x = xa; x <= xb; x++) {
                int16_t dx = (int16_t)(x - RING_CX);
                uint32_t r2 = (uint32_t)((int32_t)dx * dx) + dy2;
                uint16_t a;
                int16_t d, ad;
                uint8_t v;

                if (r2 < RIN2 || r2 > ROUT2) continue;
                if (!ring_in_sector(dx, k0, s_s0, k1, s_s1)) continue;
                a = ring_atan2(dy, dx);

                if (!ring_in_range((int16_t)a, a0, len)) continue;
                if (eraseOnly) {
                    v = 0;
                } else {
                    d = (int16_t)(a + RING_ANG_UNITS - (uint16_t)newC);
                    if (d >= RING_ANG_UNITS) d = (int16_t)(d - RING_ANG_UNITS);
                    if (d > 360) d = (int16_t)(d - RING_ANG_UNITS);
                    ad = (d < 0) ? (int16_t)(-d) : d;

                    if (ad <= RING_SPAN_U) {
                        v = ringGain[ad];
                    } else if ((dir > 0) ? (d < -RING_SPAN_U && d >= -(RING_SPAN_U + stepU))
                                         : (d > RING_SPAN_U && d <= RING_SPAN_U + stepU)) {
                        v = 0;
                    } else {
                        continue;
                    }
                }

                if (nVal >= RING_BUF_PX) { hi = -2; break; }
                s_val[nVal++] = v;
                if (lo < 0) lo = x;
                hi = x;
            }
            if (hi == -2) break;
            if (lo >= 0 && s_runL[ri][0] == 0) {
                s_runX[ri][0] = (RING_XY_T)lo;
                s_runL[ri][0] = (RING_XY_T)(hi - lo + 1);
            } else if (lo >= 0) {
                s_runX[ri][1] = (RING_XY_T)lo;
                s_runL[ri][1] = (RING_XY_T)(hi - lo + 1);
            }
        }
    }
}
#endif

static uint16_t ring_mix(uint16_t bg, uint16_t fg, uint8_t v, int16_t dth)
{
    int16_t br = (int16_t)((bg >> 11) & 0x1F), bg6 = (int16_t)((bg >> 5) & 0x3F), bb = (int16_t)(bg & 0x1F);
    int16_t fr = (int16_t)((fg >> 11) & 0x1F), fg6 = (int16_t)((fg >> 5) & 0x3F), fb = (int16_t)(fg & 0x1F);
    int16_t rr = (int16_t)(br  + ((((fr  - br)  * v) + 128 + dth) >> 8));
    int16_t gg = (int16_t)(bg6 + ((((fg6 - bg6) * v) + 128 + dth) >> 8));
    int16_t bv = (int16_t)(bb  + ((((fb  - bb)  * v) + 128 + dth) >> 8));
    return (uint16_t)(((uint16_t)rr << 11) | ((uint16_t)gg << 5) | (uint16_t)bv);
}

#if (RING_DEPTH_DEF > 0) && (RING_SHAPE == 0)

static uint16_t ring_shade(uint16_t col, uint32_t r2, int16_t dx, int16_t dy, int16_t dth)
{
    int32_t ii = (int32_t)(r2 - (uint32_t)(RING_R_IN * RING_R_IN)) >> 5;
    int32_t t, k;

    if (ii < 0) ii = 0;
    if (ii >= RING_COV_R2_N) ii = RING_COV_R2_N - 1;
    t = ((int32_t)ringShadeNx[ii] * dx + (int32_t)ringShadeNy[ii] * dy) >> 8;
    k = (int32_t)ringShadeA[ii] + (((int32_t)ringShadeB[ii] * t) >> 8);
    if (k > 255) k = 255;
    if (k < -255) k = -255;

    if (k > 0) return ring_mix(col, 0xFFFF, (uint8_t)k, dth);
    if (k < 0) return ring_mix(col, 0x0000, (uint8_t)(-k), dth);
    return col;
}
#endif

#if RING_SHAPE == 0
static int16_t  s_arc_c0, s_arc_s0, s_arc_c1, s_arc_s1;
static int32_t  s_arc_k0, s_arc_k1;

static int16_t  s_arc_stx, s_arc_sty, s_arc_enx, s_arc_eny;
static int32_t  s_arc_capR;
static int32_t  s_arc_capR2, s_arc_capIn2;
static int16_t  s_arc_aa2;
static uint16_t s_arc_sweep;
/* 填充末端 (Q8, 相对弧起点): 段驱动时用 body 边沿的精确值, 否则 = sweep */
static uint32_t s_arc_endQ8;
static uint8_t  s_arc_inv;
static uint8_t  s_arc_caps;

static void ring_arc_update(void)
{
    int32_t rmid = (int32_t)(RING_R_IN + RING_R_OUT);
    uint16_t steps = ring.arcSteps ? ring.arcSteps : 1;
    uint16_t start = ring_norm((int16_t)ring.arcStart);

    {
        uint16_t range = RING_ARC_RANGE_U;
        if (range == 0u || range > RING_ANG_UNITS) range = RING_ANG_UNITS;
        if (ring.arcFine) s_arc_sweep = (uint16_t)ring.arcSweep;
        else s_arc_sweep = (uint16_t)(((uint32_t)ring.arcValue * range) / steps);
        if (s_arc_sweep > range) s_arc_sweep = range;
    }
    /* 端点 AA 的末端: 段驱动时取 body 边沿的精确角度 (与 sweep 的半度取整无关);
     * 核对 |差| < 0.5°, 不一致说明 s_fillEndQ8 是上一帧/别的调用留下的, 退回 sweep。 */
    {
        int32_t d = (int32_t)s_fillEndQ8 - (int32_t)s_arc_sweep * 128;

        if (s_fillEndValid && (d <= 8) && (d > -(128 + 8))) s_arc_endQ8 = s_fillEndQ8;
        else                                                s_arc_endQ8 = (uint32_t)s_arc_sweep * 128u;
    }
    if (s_arc_sweep == 0) {
        s_arc_caps = 0;
        return;
    }

    {
        /* 填充末端射线用**精确** Q8 (s_arc_endQ8), 不用 sweep 的 0.5° 取整:
         * 这样填充边界正好落在最后一段 body 的边沿上, 不会在缝里多出
         * 一条 0.5° 的"暗槽"残段; 端点 AA 也以同一条射线为中心。 */
        int32_t endQ8 = (int32_t)start * 128 + (int32_t)ring.arcDir * (int32_t)s_arc_endQ8;

        ring_unit(start, &s_arc_c0, &s_arc_s0);
        ring_unit_q8(endQ8, &s_arc_c1, &s_arc_s1);
    }
    s_arc_inv = (uint8_t)(s_arc_sweep > (RING_ANG_UNITS / 2));

    s_arc_capR  = (int32_t)(RING_R_OUT - RING_R_IN);
    s_arc_aa2   = (int16_t)(2 * ((RING_COV_AA_X10 + 5) / 10));
    s_arc_capR2 = s_arc_capR * s_arc_capR;
    {
        int32_t in = s_arc_capR - s_arc_aa2;
        if (in < 0) in = 0;
        s_arc_capIn2 = in * in;
    }

    s_arc_stx = (int16_t)((rmid * s_arc_c0 + 8192) >> 14);
    s_arc_sty = (int16_t)((rmid * s_arc_s0 + 8192) >> 14);
    s_arc_enx = (int16_t)((rmid * s_arc_c1 + 8192) >> 14);
    s_arc_eny = (int16_t)((rmid * s_arc_s1 + 8192) >> 14);

    s_arc_caps = (uint8_t)((ring.arcCaps && s_arc_sweep < RING_ANG_UNITS)
                            ? (ring.arcCapMask & 0x3u) : 0u);
}

static void ring_arc_row(int16_t dy)
{
    if (s_arc_sweep == 0 || s_arc_sweep >= RING_ANG_UNITS) return;
    s_arc_k0 = (int32_t)s_arc_c0 * dy;
    s_arc_k1 = (int32_t)s_arc_c1 * dy;
}

static uint8_t ring_arc_w(int16_t dx, int16_t dy)
{
    uint8_t w, in;

    if (s_arc_sweep == 0) return 0;
    if (s_arc_sweep >= RING_ANG_UNITS) return 255;
    {

        int32_t d0 = s_arc_k0 - (int32_t)s_arc_s0 * dx;
        int32_t d1 = s_arc_k1 - (int32_t)s_arc_s1 * dx;

        if (ring.arcDir < 0)
            in = s_arc_inv ? (uint8_t)(d0 <= 0 || d1 >= 0) : (uint8_t)(d0 <= 0 && d1 >= 0);
        else
            in = s_arc_inv ? (uint8_t)(d0 >= 0 || d1 <= 0) : (uint8_t)(d0 >= 0 && d1 <= 0);
    }
    w = in ? 255 : 0;
    if (!in && s_arc_caps) {
        uint8_t k;
        for (k = 0; k < 2; k++) {
            if ((s_arc_caps & (uint8_t)(k ? 0x2u : 0x1u)) == 0u) { continue; }

            int32_t ax = (int32_t)2 * dx - (k ? s_arc_enx : s_arc_stx);
            int32_t ay = (int32_t)2 * dy - (k ? s_arc_eny : s_arc_sty);
            int32_t d2 = ax * ax + ay * ay;
            if (d2 < s_arc_capR2) {
                uint8_t cw = 255;
                if (d2 > s_arc_capIn2) {
                    int16_t d = ring_isqrt((uint32_t)d2);
                    int32_t v = ((s_arc_capR - d) * 255) / (s_arc_aa2 ? s_arc_aa2 : 1);
                    cw = (uint8_t)(v < 0 ? 0 : (v > 255 ? 255 : v));
                }
                if (cw > w) w = cw;
            }
        }
    }
    return w;
}
#endif

#if !RING_ARC_GRAD || RING_GLINT_DEF || (RING_SHAPE == 1)
static uint16_t ring_arc_color(uint8_t w)
{
    if (w == 0)   return ring.arcTrack;
    if (w == 255) return ring.arcFill;
    return ring_mix(ring.arcTrack, ring.arcFill, w, 0);
}
#endif

#if (RING_ARC_GRAD || RING_SEG_ON) && (RING_SHAPE == 0)
/* 相对弧起点的角度 (0.5° 单位, 0..719); 渐变和分割共用一次 atan2。 */
static int16_t ring_arc_rel_u(int16_t dx, int16_t dy)
{
    uint16_t a = ring_atan2(dy, dx);
    int16_t  rel = (int16_t)((int16_t)a - (int16_t)RING_ARC_START_DEF);

    if (rel < 0) rel = (int16_t)(rel + RING_ANG_UNITS);
    return rel;
}
#endif

#if RING_SEG_ON && (RING_SHAPE == 0)
#if (RING_SEG_N < 2) || (RING_SEG_N > 180)
#error "RING_SEG_N out of range 2..180"
#endif
#if (RING_SEG_N) > 255
#error "RING_SEG_N > 255: 亮段数 lit 是 uint8_t"
#endif
/* 分割几何 (Q8 度), 与网页 ringSegGeom() 同一套口径:
 *   部分弧 (RING_SEG_ARC_REL=1): N 段 body + (N-1) 条内部缝, 总长 = 跨度
 *     P = (跨度 + gap)/N, body = P - gap
 *     ⇒ 最后一段与其余段等长, 末端正好落在弧终点 —— 不需要 end-skip。
 *   整圈: P = 360/N, N 条缝。
 * 优先用导出固定值 (PITCH/BODY/GAP_X10000, 0.0001°); 老 ring_config.h 没有它们时
 * 退回 GAP_X10 现算 (导出只是把同一式子四舍五入到 0.0001°, 两者应当一致)。
 * 0.0001° → Q8: ×256/10000, 四舍五入。 */
#ifndef RING_SEG_ARC_REL
#define RING_SEG_ARC_REL   0
#endif

#ifdef RING_SEG_GAP_X10000
#  define RING_SEG_P_Q8       (((long)(RING_SEG_PITCH_X10000) * 256L + 5000L) / 10000L)
#  define RING_SEG_BODY_Q8    (((long)(RING_SEG_BODY_X10000)  * 256L + 5000L) / 10000L)
#  define RING_SEG_GAP_Q8     (((long)(RING_SEG_GAP_X10000)   * 256L + 5000L) / 10000L)
#else
#  define RING_SEG_GAP_Q8     (((long)(RING_SEG_GAP_X10) * 256L) / 10L)
#  if RING_SEG_ARC_REL
#    define RING_SEG_P_Q8     ((((long)(RING_ARC_SPAN_DEF) * 128L) + (RING_SEG_GAP_Q8) + ((RING_SEG_N) / 2L)) / (RING_SEG_N))
#  else
#    define RING_SEG_P_Q8     ((92160L + ((RING_SEG_N) / 2L)) / (RING_SEG_N))
#  endif
#  define RING_SEG_BODY_Q8    ((RING_SEG_P_Q8) - (RING_SEG_GAP_Q8))
#endif

#ifdef RING_SEG_GAP_X10000
#  if (RING_SEG_PITCH_X10000) <= 0 || (RING_SEG_BODY_X10000) < 0
#    error "segment geometry invalid: RING_SEG_PITCH/BODY_X10000 (check the web export)"
#  endif
#endif

/* 档位分割线相对"段起点"的回退量 (Q8): split=0 → 整个 GAP (段末),
 * split=5 → GAP/2 (槽中), split=10 → 0 (下一段起点/段起点)。 */
#define RING_SEG_END_BACK_Q8  (((long)(RING_SEG_GAP_Q8) * (10L - (long)(RING_SEG_SPLIT_X10))) / 10L)
#define RING_SEG_PHASE_Q8     (((long)(RING_SEG_PHASE_X10) * 256L) / 10L)
#define RING_SEG_PHASE_MOD    ((((RING_SEG_PHASE_Q8) % (RING_SEG_P_Q8)) + (RING_SEG_P_Q8)) % (RING_SEG_P_Q8))
#if (RING_SEG_AA_X10) > 0
#define RING_SEG_AA_Q8        (((long)(RING_SEG_AA_X10) * 1358L + 50L) / 100L)
#define RING_SEG_AA_INV       ((65536L + (RING_SEG_AA_Q8) / 2) / (RING_SEG_AA_Q8))
#endif
#define RING_SEG_P_INV        ((65536L + (RING_SEG_P_Q8) / 2) / (RING_SEG_P_Q8))
#define RING_SEG_DEPTH255     (((long)(RING_SEG_DEPTH) * 255L + 50L) / 100L)

/* rel (Q8 度) → 段内偏移 (Q8) + 段号。渐变和缝遮罩共用同一份结果: 段号就是色号,
 * 所以每个像素只做一次取模。
 * 16.16 倒数 (P_INV) 只是**近似**, 直接用会让 q 系统性偏小 (到第 69 段能差半段),
 * 表现是"段越往后越窄、缝越往后越宽"; 所以余数 >= P 就进位。
 * 主循环里绝大多数像素不进 while, 只有段边界附近偶尔进一次。 */
static uint32_t ring_seg_split(uint32_t relQ8, uint8_t *pq)
{
    uint32_t u = relQ8 + (uint32_t)RING_SEG_PHASE_MOD;
    uint32_t q, r;

    /* 弧外 / 末段之后: 没有段 (返回"缝尾"), 也保证下面的修正循环 O(1)。 */
    if (u >= ((uint32_t)RING_SEG_N * (uint32_t)RING_SEG_P_Q8)) {
        *pq = (uint8_t)(RING_SEG_N - 1u);
        return (uint32_t)RING_SEG_BODY_Q8;
    }
    q = (u * (uint32_t)RING_SEG_P_INV) >> 16;
    r = u - q * (uint32_t)RING_SEG_P_Q8;
    while (r >= (uint32_t)RING_SEG_P_Q8) { q++; r -= (uint32_t)RING_SEG_P_Q8; }
    *pq = (uint8_t)q;
    return r;
}

#ifdef RING_SIM
/* 0..255: 段内 255, 缝内 0, 缝边 1px 斜坡 (0.5 = 缝边线); 同时带出段号 (= 渐变色号)。
 * ！板上绘制已改用 ring_seg_aa_color() 的 2px 像素距离 AA, 这里只留给主机
 *   几何自检 (check_seg_geom) 用, 所以只在 RING_SIM 下编译。 */
static uint8_t ring_seg_mask_cell(uint32_t relQ8, uint8_t *pcell)
{
    uint32_t u;
    int32_t  d, e;
    uint16_t m;

    u = ring_seg_split(relQ8, pcell);
    if (u >= (uint32_t)RING_SEG_BODY_Q8) return 0u;          /* 缝 */
    d = (int32_t)u;
    e = (int32_t)RING_SEG_BODY_Q8 - d;
    if (e < d) d = e;
#if (RING_SEG_AA_X10) > 0
    m = (uint16_t)(128 + ((d * RING_SEG_AA_INV) >> 8));
#else
    m = 255u;                                               /* AA 关 = 硬边 */
#endif
    if (m > 255u) m = 255u;
    return (uint8_t)m;
}
#endif

/* 暗槽: 缝位置把颜色按 RING_SEG_DEPTH 压向黑色 */
static uint16_t ring_seg_groove(uint16_t c, uint8_t mask)
{
    uint16_t k = (uint16_t)(((uint16_t)(255u - mask) * (uint16_t)RING_SEG_DEPTH255) >> 8);
    return ring_mix(c, 0x0000u, (uint8_t)k, 0);
}
#endif

#ifdef RING_SIM
/* 主机自检专用: 角向遮罩 (Q8 度, 相对弧起点). 用来验证"70 段 / 69 缝 / 等宽",
 * 不受 240px 光栅化精度限制 (主循环按 0.5° 取值, 这里可以 0.004° 扫)。 */
uint8_t Ring_DbgSegQ8(uint32_t relQ8)
{
#if (RING_SEG_ON) && (RING_SHAPE == 0)
    uint8_t cell;

    return ring_seg_mask_cell(relQ8, &cell);
#else
    (void)relQ8;
    return 255u;
#endif
}
#endif

#if RING_ARC_GRAD && (RING_SHAPE == 0) && !RING_SEG_ON
/* 无分割: 沿弧渐变按弧长比例取格。 */
static uint8_t ring_grad_cell(int16_t rel)
{
    uint16_t cell;

    /* 端帽: 起点帽在 rel 接近 720 处 (取 0 格色); 终点帽在 rel 刚超过当前
     * 已亮 sweep 处 (取当前弧末端的色, 不再往未点亮格继续变蓝)。 */
    if (rel > (int16_t)s_arc_sweep) {
        uint16_t mid = (uint16_t)(RING_ARC_RANGE_U + (RING_ANG_UNITS - RING_ARC_RANGE_U) / 2u);
        if (rel > (int16_t)mid) return 0u;
        rel = (int16_t)s_arc_sweep;
    }

#if ((RING_ARC_SPAN_DEF) % RING_GRAD_N) == 0
    cell = (uint16_t)((uint16_t)rel / (uint16_t)((RING_ARC_SPAN_DEF) / RING_GRAD_N));
#else
    cell = (uint16_t)(((uint32_t)rel * RING_GRAD_N) / RING_ARC_RANGE_U);
#endif
    if (cell >= RING_GRAD_N) cell = RING_GRAD_N - 1u;
    return (uint8_t)cell;
}

static uint16_t ring_grad_color(uint8_t w, int16_t rel)
{
    uint16_t fg;

    if (w == 0) return ring.arcTrack;
    fg = ringGrad70[ring_grad_cell(rel)];
    if (ring.dim) fg = ring_mix(fg, 0x0000u, ring.dim, 0);   /* 暂停: 渐变整体压暗 */
    if (w == 255) return fg;
    return ring_mix(ring.arcTrack, fg, w, 0);
}
#endif

/* 整段口径的扫弧终点: sweep = lit×P − gap (与缝同一个 Q8 网格), 再换算到 0.5° 单位。
 * **向上取整**: 多出的 <0.5° 落在缝里, 会被分段遮罩剪掉; 向下取整会把最后一段 body
 * 切短 0.3~0.9px (屏幕上就是末段偏细 / 差半格)。 */
uint16_t Ring_SegSweep(uint8_t lit)
{
    if (lit == 0u) return 0u;
#if (RING_SEG_ON) && (RING_SHAPE == 0)
    {
        int32_t q8;

        if (lit > RING_SEG_N) lit = RING_SEG_N;
        /* 档位分割线落在**槽中间** (用户 2026-10-22): 旧版减一个整 GAP,
         * 正好停在最后一段 body 的末尾 —— 视觉上分割线贴着段体, 槽只剩后半截。
         * 减半个 GAP 后, 每档末尾是"半条槽", 与下一档开头对称。 */
        q8 = ((int32_t)lit * RING_SEG_P_Q8) - (int32_t)RING_SEG_END_BACK_Q8;
        if (q8 <= 0) return 0u;
        q8 = (q8 + 127) >> 7;                        /* Q8 → 0.5°, ceil */
        if ((uint32_t)q8 > RING_ARC_RANGE_U) q8 = (int32_t)RING_ARC_RANGE_U;
        return (uint16_t)q8;
    }
#else
    {
        uint8_t steps = (RING_SEG_N) ? (uint8_t)(RING_SEG_N) : 1u;

        if (lit > steps) lit = steps;
        return (uint16_t)(((uint32_t)lit * RING_ARC_RANGE_U) / steps);
    }
#endif
}

/* 记下"亮到第 lit 段"时填充末端的精确角度 (Q8, 相对弧起点)。
 * 端点 AA 用; Ring_SegSweep() 仍按 0.5° 输出 (推屏/增量窗口都靠它)。 */
static void ring_fill_end_set(uint8_t lit)
{
#if (RING_SEG_ON) && (RING_SHAPE == 0)
    if (lit == 0u) {
        s_fillEndQ8    = 0u;
        s_fillEndValid = 0u;
        return;
    }
    if (lit >= (uint8_t)RING_SEG_N) {
        s_fillEndQ8 = (uint32_t)RING_ARC_RANGE_U * 128u;
    } else {
        s_fillEndQ8 = (uint32_t)lit * RING_SEG_P_Q8 - (uint32_t)RING_SEG_END_BACK_Q8;
    }
    s_fillEndValid = 1u;
#else
    (void)lit;
#endif
}

#if RING_DITHER
static const uint8_t s_bayer[64] = {
     0, 32,  8, 40,  2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44,  4, 36, 14, 46,  6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
     3, 35, 11, 43,  1, 33,  9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47,  7, 39, 13, 45,  5, 37,
    63, 31, 55, 23, 61, 29, 53, 21
};
#endif

#if RING_SHAPE == 1

#define RING_RECT_ARC(rcq, th)   (((rcq) * (th) * 143) >> 14)
#define RING_RECT_FLOOR(v)       ((int32_t)(v) >> 8)
#define RING_RECT_CEIL(v)        (((int32_t)(v) + 255) >> 8)

#define RING_RECT_XMAX           (RING_SCR_W - 1)
#define RING_RECT_YMAX           (RING_SCR_H - 1)
#define RING_RECT_DOUT           ((RING_O_RC) - (RING_RC))
#define RING_RECT_DIN            ((RING_RC) - (RING_I_RC))
#define RING_RECT_PAD            ((RING_RECT_DOUT) > (RING_RECT_DIN) ? (RING_RECT_DOUT) : (RING_RECT_DIN))

#define RING_RECT_PADY           ((RING_RECT_PAD) > (RING_HT) ? (RING_RECT_PAD) : (RING_HT))
#if RING_GLINT_DEF

#if (2 * ((RING_RECT_PADY + 255) >> 8) + 6) > (RING_BUF_ROWS - 4)
#error "this rect geometry needs a taller window than RING_BUF_ROWS: raise RING_BUF_ROWS (4 bytes per row)"
#endif
#endif

static uint16_t ring_rect_atan_u(int32_t ay, int32_t ax)
{
    int32_t  maj = (ax >= ay) ? ax : ay;
    int32_t  mn  = (ax >= ay) ? ay : ax;
    uint16_t mh  = (uint16_t)((maj + 128) >> 8);
    uint32_t t;
    uint8_t  b;

    if (mh < 1) mh = 1;
    if (mh >= RING_RECIP_N) mh = (uint16_t)(RING_RECIP_N - 1);
    t = ((uint32_t)(mn >> 4) * ringRecip[mh]) >> 12;
    if (t > 256) t = 256;
    b = ringAtanTab[t];
    return (uint16_t)((ax >= ay) ? b : (180 - b));
}

static void ring_rect_span(int32_t dyQ8, int32_t *pxo, int32_t *pxi)
{
    int32_t ay = (dyQ8 < 0) ? -dyQ8 : dyQ8;
    int32_t k;

    if (ay > (int32_t)RING_O_HY) {
        *pxo = 0;
    } else if (ay <= (int32_t)RING_O_HY - (int32_t)RING_O_RC) {
        *pxo = (int32_t)RING_O_HX;
    } else {
        k = ay - ((int32_t)RING_O_HY - (int32_t)RING_O_RC);
        *pxo = (int32_t)RING_O_HX - (int32_t)RING_O_RC
             + (int32_t)ring_isqrt((uint32_t)((int32_t)RING_O_RC * (int32_t)RING_O_RC - k * k));
    }
    if (ay > (int32_t)RING_I_HY) {
        *pxi = 0;
    } else if (ay <= (int32_t)RING_I_HY - (int32_t)RING_I_RC) {
        *pxi = (int32_t)RING_I_HX;
    } else {
        k = ay - ((int32_t)RING_I_HY - (int32_t)RING_I_RC);
        *pxi = (int32_t)RING_I_HX - (int32_t)RING_I_RC
             + (int32_t)ring_isqrt((uint32_t)((int32_t)RING_I_RC * (int32_t)RING_I_RC - k * k));
    }
}

static void ring_rect_span_rng(int32_t dyQ8, int32_t *pxo, int32_t *pxi)
{
    int32_t xoA, xiA, xoB, xiB;

    ring_rect_span(dyQ8 - 128, &xoA, &xiA);
    ring_rect_span(dyQ8 + 128, &xoB, &xiB);
    *pxo = (xoA > xoB) ? xoA : xoB;

    *pxi = (xiA > 0 && xiB > 0) ? ((xiA < xiB) ? xiA : xiB) : 0;
}

static int32_t ring_rect_dist(int32_t dxQ8, int32_t dyQ8, int32_t hx, int32_t hy, int32_t R)
{
    int32_t ax = (dxQ8 < 0) ? -dxQ8 : dxQ8;
    int32_t ay = (dyQ8 < 0) ? -dyQ8 : dyQ8;
    int32_t qx = ax - (hx - R), qy = ay - (hy - R);
    int32_t px = (qx > 0) ? qx : 0, py = (qy > 0) ? qy : 0;

    if (px > 0 && py > 0)
        return 2 * (int32_t)ring_isqrt((uint32_t)(((px * px) >> 2) + ((py * py) >> 2))) - R;
    return ((qx > qy) ? qx : qy) - R;
}

static uint8_t ring_rect_cov(int32_t dxQ8, int32_t dyQ8)
{

    int32_t dOut = ring_rect_dist(dxQ8, dyQ8, (int32_t)RING_O_HX, (int32_t)RING_O_HY, (int32_t)RING_O_RC);
    int32_t dIn, m;

    if (dOut >= 128) return 0;
    dIn = ring_rect_dist(dxQ8, dyQ8, (int32_t)RING_I_HX, (int32_t)RING_I_HY, (int32_t)RING_I_RC);
    m = (-dOut < dIn) ? -dOut : dIn;
    if (m <= -128) return 0;
    if (m >= (int32_t)RING_RECT_AA_Q8 - 128) return 255;
    return (uint8_t)(((m + 128) * RING_RECT_INV_AA) >> 8);
}

#if RING_DEPTH_DEF > 0

static void ring_rect_normal(int32_t dxQ8, int32_t dyQ8, int32_t *pnx, int32_t *pny)
{
    int32_t ax = (dxQ8 < 0) ? -dxQ8 : dxQ8;
    int32_t ay = (dyQ8 < 0) ? -dyQ8 : dyQ8;
    int32_t ex = (int32_t)RING_O_HX - (int32_t)RING_O_RC;
    int32_t ey = (int32_t)RING_O_HY - (int32_t)RING_O_RC;
    int32_t sx = (dxQ8 < 0) ? -1 : 1;
    int32_t sy = (dyQ8 < 0) ? -1 : 1;

    if (((int32_t)RING_O_RC > 0) && ax > ex && ay > ey) {
        int32_t inv = 65536 / (int32_t)RING_O_RC;
        *pnx = (((ax - ex) * sx) * inv) >> 8;
        *pny = (((ay - ey) * sy) * inv) >> 8;
        return;
    }
    if (ax > ex) { *pnx = 256 * sx; *pny = 0; return; }
    *pnx = 0; *pny = 256 * sy;
}

static uint16_t ring_rect_shade(uint16_t col, int32_t dQ8, int32_t nx, int32_t ny, int16_t dth)
{
    int32_t i = dQ8 >> RING_SHADE_SHIFT;
    int32_t t, k;

    if (i < 0) i = 0;
    if (i >= RING_SHADE_N) i = RING_SHADE_N - 1;
    t = (((int32_t)RING_SHADE_NX * nx) + ((int32_t)RING_SHADE_NY * ny)) >> 16;
    k = (int32_t)ringShadeA[i] + (((int32_t)ringShadeB[i] * t) >> 8);
    if (k > 255) k = 255;
    if (k < -255) k = -255;
    if (k > 0) return ring_mix(col, 0xFFFF, (uint8_t)k, dth);
    if (k < 0) return ring_mix(col, 0x0000, (uint8_t)(-k), dth);
    return col;
}
#endif

static int32_t ring_rect_s(int32_t dxQ8, int32_t dyQ8)
{
    const int32_t ex = (int32_t)RING_HX - (int32_t)RING_RC;
    const int32_t ey = (int32_t)RING_HY - (int32_t)RING_RC;
    const int32_t hq = RING_RECT_ARC(RING_RC, 180);
    int32_t ax = (dxQ8 < 0) ? -dxQ8 : dxQ8;
    int32_t ay = (dyQ8 < 0) ? -dyQ8 : dyQ8;
    int32_t qx = ax - ex, qy = ay - ey, s;

    if (qx < 0) qx = 0;
    if (qy < 0) qy = 0;
    if (RING_RC > 0 && qx > 0 && qy > 0) {
        int32_t arc = RING_RECT_ARC(RING_RC, ring_rect_atan_u(qy, qx));
        if (dxQ8 >= 0 && dyQ8 < 0) return ex + (hq - arc);
        if (dxQ8 >= 0)             return ex + hq + 2 * ey + arc;
        if (dyQ8 >= 0)             return ex + 2 * hq + 2 * ey + 2 * ex + (hq - arc);
        return ex + 3 * hq + 2 * ey + 2 * ex + 2 * ey + arc;
    }
    {

        int32_t px = (dxQ8 < -ex) ? -ex : ((dxQ8 > ex) ? ex : dxQ8);
        int32_t py = (dyQ8 < -ey) ? -ey : ((dyQ8 > ey) ? ey : dyQ8);
        int32_t t1 = ((dxQ8 - px) < 0 ? (px - dxQ8) : (dxQ8 - px)) >> 2;
        int32_t t2 = ((dyQ8 + RING_HY) < 0 ? -(dyQ8 + RING_HY) : (dyQ8 + RING_HY)) >> 2;
        int32_t t3 = ((dyQ8 - RING_HY) < 0 ? (RING_HY - dyQ8) : (dyQ8 - RING_HY)) >> 2;
        int32_t t4 = ((dxQ8 - RING_HX) < 0 ? (RING_HX - dxQ8) : (dxQ8 - RING_HX)) >> 2;
        int32_t t5 = ((dxQ8 + RING_HX) < 0 ? -(dxQ8 + RING_HX) : (dxQ8 + RING_HX)) >> 2;
        int32_t t6 = ((dyQ8 - py) < 0 ? (py - dyQ8) : (dyQ8 - py)) >> 2;
        int32_t d1 = t1 * t1 + t2 * t2;
        int32_t d2 = t1 * t1 + t3 * t3;
        int32_t d3 = t4 * t4 + t6 * t6;
        int32_t d4 = t5 * t5 + t6 * t6;

        s = (px >= 0) ? px : ((int32_t)RING_PER_Q8 + px);
        if (d2 < d1) { d1 = d2; s = ex + 2 * hq + 2 * ey + (ex - px); }
        if (d3 < d1) { d1 = d3; s = ex + hq + (py + ey); }
        if (d4 < d1) { s = ex + 3 * hq + 2 * ey + 2 * ex + (ey - py); }
    }
    return s;
}

#if RING_GLINT_DEF
static uint16_t ring_rect_angle_u(int32_t sQ8)
{
    int32_t a = (int32_t)(((uint32_t)sQ8 * (uint32_t)RING_INVPER) >> 16);

    if (a >= RING_ANG_UNITS) a = RING_ANG_UNITS - 1;
    if (a < 0) a = 0;
    return (uint16_t)a;
}
#endif

static void ring_rect_point_q8(int32_t sQ8, int32_t *px, int32_t *py)
{
    const int32_t ex = (int32_t)RING_HX - (int32_t)RING_RC;
    const int32_t ey = (int32_t)RING_HY - (int32_t)RING_RC;
    const int32_t hq = RING_RECT_ARC(RING_RC, 180);
    int32_t s = sQ8 % (int32_t)RING_PER_Q8;

    if (s < 0) s += (int32_t)RING_PER_Q8;
    if (s <= ex) { *px = s; *py = -(int32_t)RING_HY; return; }
    s -= ex;
    if (RING_RC > 0 && s <= hq) {
        int32_t th = (s * 180) / hq;
        if (th > 180) th = 180;
        *px = ex + (((int32_t)RING_RC * ringCosQ14[180 - th]) >> 14);
        *py = -ey - (((int32_t)RING_RC * ringCosQ14[th]) >> 14);
        return;
    }
    s -= hq;
    if (s <= 2 * ey) { *px = (int32_t)RING_HX; *py = -ey + s; return; }
    s -= 2 * ey;
    if (RING_RC > 0 && s <= hq) {
        int32_t th = (s * 180) / hq;
        if (th > 180) th = 180;
        *px = ex + (((int32_t)RING_RC * ringCosQ14[th]) >> 14);
        *py = ey + (((int32_t)RING_RC * ringCosQ14[180 - th]) >> 14);
        return;
    }
    s -= hq;
    if (s <= 2 * ex) { *px = ex - s; *py = (int32_t)RING_HY; return; }
    s -= 2 * ex;
    if (RING_RC > 0 && s <= hq) {
        int32_t th = (s * 180) / hq;
        if (th > 180) th = 180;
        *px = -ex - (((int32_t)RING_RC * ringCosQ14[180 - th]) >> 14);
        *py = ey + (((int32_t)RING_RC * ringCosQ14[th]) >> 14);
        return;
    }
    s -= hq;
    if (s <= 2 * ey) { *px = -(int32_t)RING_HX; *py = ey - s; return; }
    s -= 2 * ey;
    if (RING_RC > 0 && s <= hq) {
        int32_t th = (s * 180) / hq;
        if (th > 180) th = 180;
        *px = -ex - (((int32_t)RING_RC * ringCosQ14[th]) >> 14);
        *py = -ey - (((int32_t)RING_RC * ringCosQ14[180 - th]) >> 14);
        return;
    }
    s -= hq;
    *px = -ex + s; *py = -(int32_t)RING_HY;
}

static uint16_t s_rx_startU, s_rx_sweepU;
static int32_t  s_rx_s0, s_rx_sweepS;
static int32_t  s_rx_tailS;         /* 设计拖尾长度 (弧长 Q8) */
static int32_t  s_rx_tailEff;       /* 实际拖尾长度: 被起点帽盘挡短后的值 */
static int8_t   s_rx_dir;
static uint8_t  s_rx_caps;
static int16_t  s_rx_aa2;
static int32_t  s_rx_capR, s_rx_capR2, s_rx_capIn2;
static int16_t  s_rx_c0x, s_rx_c0y, s_rx_c1x, s_rx_c1y;

static void ring_rect_update(void)
{
    const int32_t per = (int32_t)RING_PER_Q8;
    uint16_t steps = ring.arcSteps ? ring.arcSteps : 1;

    s_rx_startU = (uint16_t)((ring_norm((int16_t)ring.arcStart) + 180) % RING_ANG_UNITS);
    if (ring.arcFine) {

        uint32_t sw = ring.arcSweep;
        if (sw > (uint32_t)per) { sw = (uint32_t)per; }
        s_rx_sweepS = (int32_t)sw;
        s_rx_sweepU = (uint16_t)((sw * (uint32_t)RING_ANG_UNITS + (uint32_t)per / 2u) / (uint32_t)per);
    } else {
        s_rx_sweepU = (uint16_t)(((uint32_t)ring.arcValue * RING_ANG_UNITS) / steps);
        if (s_rx_sweepU > RING_ANG_UNITS) s_rx_sweepU = RING_ANG_UNITS;
        s_rx_sweepS = ((int32_t)s_rx_sweepU * per + 360) / 720;
    }
    s_rx_dir = (int8_t)((ring.arcDir < 0) ? -1 : 1);
    if (s_rx_sweepS <= 0) {
        s_rx_caps  = 0;
        s_rx_tailS = 0;
        s_rx_tailEff = 0;
        return;
    }
    {
        int32_t s0 = ((int32_t)s_rx_startU * per + 360) / 720;

        int32_t s1 = (s_rx_dir < 0) ? (s0 - s_rx_sweepS) : (s0 + s_rx_sweepS);
        int32_t x, y;

        s1 %= per;
        if (s1 < 0) { s1 += per; }
        s_rx_s0 = s0;

        s_rx_tailS = (ring.arcTrail > 0)
                   ? (((int32_t)ring.arcTrail * per + 360) / 720) : 0;
        ring_rect_point_q8(s0, &x, &y);
        s_rx_c0x = (int16_t)((x + 64) >> 7);
        s_rx_c0y = (int16_t)((y + 64) >> 7);
        ring_rect_point_q8(s1, &x, &y);
        s_rx_c1x = (int16_t)((x + 64) >> 7);
        s_rx_c1y = (int16_t)((y + 64) >> 7);
    }
    s_rx_capR  = (((int32_t)RING_HT * 2) + 128) >> 8;
    s_rx_aa2   = (int16_t)(2 * ((RING_COV_AA_X10 + 5) / 10));
    s_rx_capR2 = s_rx_capR * s_rx_capR;
    {
        int32_t in = s_rx_capR - s_rx_aa2;
        if (in < 0) in = 0;
        s_rx_capIn2 = in * in;
    }
    s_rx_caps = (uint8_t)((ring.arcCaps && s_rx_sweepS < per)
                          ? (ring.arcCapMask & (uint8_t)((s_rx_tailS > 0) ? 0x1u : 0x3u)) : 0u);

    /* ★ 拖尾恒为设计长度, **不做任何按缝钳位** (2026-10-15 委托: "与圆帽重叠这段显示
     *   慢, 过了圆帽又突然刷新一块")。
     *   ! 曾经的做法是 `tailEff = min(设计拖尾, 帽半径弧长 − 缝)` —— 本意是"拖尾别压到
     *   帽盘上", 但它把**渐变外沿 (弧端 + tailEff) 钉死在"帽盘近边"这个固定位置上**:
     *   缝从 0 长到帽半径(8.5px)这段里, 外沿一动不动(= 屏幕上唯一在动的那条边不动了),
     *   缝一过帽半径, 钳位失效 ⇒ 外沿**一步跳回设计长度**(15 档 11.9px ≈ 0.2s 弧长;
     *   99 档同一跳 ≈ 1.4s 弧长) —— 现场就是"先慢慢的不动, 然后突然刷掉一块"。
     *   ! 帽盘不再靠"缩拖尾"保护, 改成**帽盘盖在拖尾之上**(见 ring_rect_arc_w 的帽子
     *   分支): 盘内一律取帽的覆盖度, 盘外照旧渐隐 ⇒ 圆帽完整 + 渐变外沿始终 = 弧端 +
     *   设计拖尾、随进度连续走 (逐帧核对过: 外沿每拍进 1.9px, 无跳变)。 */
    s_rx_tailEff = s_rx_tailS;
}

static uint8_t ring_rect_arc_w(int16_t dx, int16_t dy, int32_t sQ8)
{
    uint8_t w, in;
    int32_t rel;

    if (s_rx_sweepS <= 0) return 0;
    if (s_rx_sweepS >= (int32_t)RING_PER_Q8) return 255;
    rel = (s_rx_dir > 0) ? (sQ8 - s_rx_s0) : (s_rx_s0 - sQ8);
    if (rel < 0) rel += (int32_t)RING_PER_Q8;
    in = (uint8_t)(rel <= s_rx_sweepS);
    w = in ? 255 : 0;

    if (in && s_rx_tailEff > 0)
    {
        /* 拖尾渐隐 (长度恒为设计值, 见 ring_rect_update): 外沿 = 弧端 + 设计拖尾 */
        int32_t back = s_rx_sweepS - rel;
        if (back < s_rx_tailEff)
        {
            int32_t v = (back * 255) / s_rx_tailEff;
            if (v < 0)   { v = 0; }
            if (v > 255) { v = 255; }
            w = (uint8_t)v;
        }
    }

    /* ★ 端帽对**盘内所有像素**生效 (不再要求 !in): 帽是实体圆头, 拖尾的渐隐不许吃掉它
     *   —— 这也是"缝比帽半径还窄"时保护帽盘的唯一正确办法。盘外仍按拖尾/平头取值,
     *   所以"渐变外沿 = 弧端 + 设计拖尾"保持不变、随进度连续移动 (2026-10-15)。 */
    if (s_rx_caps != 0u)
    {
        /* 起点帽 (bit0): 有拖尾时强度按"剩弧 / 拖尾"淡出 (旧口径"圆帽融进擦除渐变"不变) */
        if ((s_rx_caps & 0x1u) != 0u)
        {
            /* ！sc 只在"有拖尾"那一支乘 (与网页/旧固件逐像素一致): 无拖尾时乘 255 会
             *   变成 ×255>>8 = −1 阶, 帽盘边缘色差就跑出来了 (parity 抓过)。 */
            int32_t sc = 255;

            if (s_rx_tailS > 0)
            {
                sc = (s_rx_sweepS * 255) / s_rx_tailEff;

                if (sc > 255) { sc = 255; }
            }

            if (sc > 0)
            {
                int32_t ax = (int32_t)2 * dx - s_rx_c0x;
                int32_t ay = (int32_t)2 * dy - s_rx_c0y;
                int32_t d2 = ax * ax + ay * ay;

                if (d2 < s_rx_capR2) {
                    uint8_t cw = 255;
                    if (d2 > s_rx_capIn2) {
                        int16_t d = ring_isqrt((uint32_t)d2);
                        int32_t v = ((s_rx_capR - d) * 255) / (s_rx_aa2 ? s_rx_aa2 : 1);
                        cw = (uint8_t)(v < 0 ? 0 : (v > 255 ? 255 : v));
                    }
                    if (s_rx_tailS > 0) {
                        cw = (uint8_t)(((int32_t)cw * sc) >> 8);
                    }
                    if (cw > w) w = cw;
                }
            }
        }

        /* 末端帽 (bit1): 满强度; 有拖尾时掩码里这一位已被 update 去掉 (末端靠渐隐收边) */
        if ((s_rx_caps & 0x2u) != 0u)
        {
            int32_t ax = (int32_t)2 * dx - s_rx_c1x;
            int32_t ay = (int32_t)2 * dy - s_rx_c1y;
            int32_t d2 = ax * ax + ay * ay;

            if (d2 < s_rx_capR2) {
                uint8_t cw = 255;
                if (d2 > s_rx_capIn2) {
                    int16_t d = ring_isqrt((uint32_t)d2);
                    int32_t v = ((s_rx_capR - d) * 255) / (s_rx_aa2 ? s_rx_aa2 : 1);
                    cw = (uint8_t)(v < 0 ? 0 : (v > 255 ? 255 : v));
                }
                if (cw > w) w = cw;
            }
        }
    }
    return w;
}

#ifdef RING_SIM
/* 主机自检 (tools/ring_sim) 专用: 读出当前弧几何 —— 用来把"拖尾不压起点帽盘"这条
 * 不变量钉死 (sweepS: 已覆盖弧长 / tailD: 设计拖尾 / tailE: 被帽盘挡短后的拖尾 /
 * capQ8: 帽盘半径折算的弧长; 全部 Q8)。 */
void Ring_DbgArc(int32_t *sweepS, int32_t *tailDesignS, int32_t *tailEffS, int32_t *capQ8)
{
    if (sweepS)      { *sweepS      = s_rx_sweepS; }
    if (tailDesignS) { *tailDesignS = s_rx_tailS; }
    if (tailEffS)    { *tailEffS    = s_rx_tailEff; }
    if (capQ8)       { *capQ8       = s_rx_capR * 128; }
}
#endif

#if RING_GLINT_DEF

static uint8_t ring_rect_gain(uint16_t aU, int16_t newC)
{
    int16_t gU = (int16_t)(newC + 180);
    int16_t d;

    while (gU >= RING_ANG_UNITS) gU = (int16_t)(gU - RING_ANG_UNITS);
    while (gU < 0) gU = (int16_t)(gU + RING_ANG_UNITS);
    d = (int16_t)((int16_t)aU - gU);
    if (d > 360) d = (int16_t)(d - RING_ANG_UNITS);
    if (d < -360) d = (int16_t)(d + RING_ANG_UNITS);
    if (d < 0) d = (int16_t)(-d);
    return (d <= RING_SPAN_U) ? ringGain[d] : 0;
}

static int32_t s_rx_w0, s_rx_w1;
static int16_t s_rx_y0;
static uint8_t s_rx_rn;
static uint8_t s_rx_erase;

static int32_t ring_rect_run_s(int32_t x, int16_t dy, int32_t sBase)
{
    const int32_t half = (int32_t)RING_PER_Q8 / 2;
    int32_t s = ring_rect_s((x - RING_CX) * 256, (int32_t)dy * 256);

    while (s < sBase - half) s += (int32_t)RING_PER_Q8;
    while (s > sBase + half) s -= (int32_t)RING_PER_Q8;
    return s;
}

static int16_t ring_rect_bisect(int16_t xa, int16_t xb, int16_t dy, int32_t sBase, int32_t target, int8_t inc)
{
    int16_t lo = xa, hi = xb;

    while (lo < hi) {
        int16_t mid = (int16_t)((lo + hi) >> 1);
        int32_t s = ring_rect_run_s(mid, dy, sBase);
        if ((inc > 0) ? (s >= target) : (s <= target)) hi = mid;
        else lo = (int16_t)(mid + 1);
    }
    return lo;
}

static uint8_t ring_rect_run_win(int16_t xa, int16_t xb, int16_t dy, int32_t *p0, int32_t *p1)
{
    const int32_t per = (int32_t)RING_PER_Q8;
    const int32_t half = per / 2;
    int32_t sFirst = ring_rect_s(((int32_t)xa - RING_CX) * 256, (int32_t)dy * 256);
    int32_t sLast  = ring_rect_s(((int32_t)xb - RING_CX) * 256, (int32_t)dy * 256);
    int32_t sBase, sMin, sMax, w0 = s_rx_w0, w1 = s_rx_w1;
    int32_t x0, x1;

    if (sLast < sFirst - half) sLast += per;
    else if (sLast > sFirst + half) sLast -= per;
    sMin = (sFirst < sLast) ? sFirst : sLast;
    sMax = (sFirst < sLast) ? sLast : sFirst;
    sBase = (sMin + sMax) / 2;
    while (w1 < sBase - half) { w0 += per; w1 += per; }
    while (w0 > sBase + half) { w0 -= per; w1 -= per; }
    if (w1 < sMin || w0 > sMax) return 0;
    if (sLast >= sFirst) {
        x0 = ring_rect_bisect(xa, xb, dy, sBase, w0, 1);
        x1 = (w1 >= sMax) ? xb : (int32_t)(ring_rect_bisect(xa, xb, dy, sBase, w1 + 1, 1) - 1);
    } else {
        x0 = ring_rect_bisect(xa, xb, dy, sBase, w1, -1);
        x1 = (w0 <= sMin) ? xb : (int32_t)(ring_rect_bisect(xa, xb, dy, sBase, w0 - 1, -1) - 1);
    }
    x0 -= 3; if (x0 < xa) x0 = xa;
    x1 += 3; if (x1 > xb) x1 = xb;
    if (x1 < x0) return 0;
    *p0 = x0;
    *p1 = x1;
    return 1;
}

static void ring_rect_win(int32_t a0, int32_t a1)
{
    const int32_t per = (int32_t)RING_PER_Q8;
    const int32_t pad = (RING_RECT_PADY + 128) >> 8;
    int32_t y0 = 32000, y1 = -32000;
    int32_t s, x, y;

    s_rx_w0 = (a0 * per + 360) / 720;
    s_rx_w1 = (a1 * per + 360) / 720;
    if (s_rx_w1 - s_rx_w0 >= per) { s_rx_w0 = 0; s_rx_w1 = per; }
    for (s = s_rx_w0; ; s += 3 * 256) {
        int32_t yy;
        if (s > s_rx_w1) s = s_rx_w1;
        ring_rect_point_q8(s, &x, &y);
        yy = (y + 128) >> 8;
        if (yy < y0) y0 = yy;
        if (yy > y1) y1 = yy;
        if (s >= s_rx_w1) break;
    }
    y0 = (int32_t)RING_CY + y0 - pad - 2;
    y1 = (int32_t)RING_CY + y1 + pad + 2;
    if (y0 < 0) y0 = 0;
    if (y1 > (RING_RECT_YMAX)) y1 = (RING_RECT_YMAX);
    if (y1 < y0) { s_rx_y0 = 0; s_rx_rn = 0; return; }
    s_rx_y0 = (int16_t)y0;
    s_rx_rn = (uint8_t)(y1 - y0 + 1);
    if (s_rx_rn > RING_BUF_ROWS) s_rx_rn = RING_BUF_ROWS;
}

static void ring_rect_compute(int16_t newC)
{
    uint16_t nVal = 0;
    int16_t ri;

    for (ri = 0; ri < (int16_t)s_rx_rn; ri++) {
        int16_t y = (int16_t)(s_rx_y0 + ri);
        int32_t dy = (int32_t)y - RING_CY, dyQ8 = dy * 256;
        int32_t xo, xi;
        int8_t side;

        s_runL[ri][0] = 0;
        s_runL[ri][1] = 0;
        ring_rect_span_rng(dyQ8, &xo, &xi);
        if (xo <= 0) continue;
        for (side = 1; side >= -1; side -= 2) {
            int32_t xa, xb, x, lo = -1, hi = -1;

            if (side > 0) { xa = (int32_t)RING_CX + RING_RECT_FLOOR(xi); xb = (int32_t)RING_CX + RING_RECT_CEIL(xo); }
            else          { xa = (int32_t)RING_CX - RING_RECT_CEIL(xo);  xb = (int32_t)RING_CX - RING_RECT_FLOOR(xi); }
            if (xb < 0 || xa > (RING_RECT_XMAX) || xa > xb) continue;
            if (xa < 0) xa = 0;
            if (xb > (RING_RECT_XMAX)) xb = (RING_RECT_XMAX);

            while (xa <= xb && !ring_rect_cov((xa - RING_CX) * 256, dyQ8)) xa++;
            while (xb >= xa && !ring_rect_cov((xb - RING_CX) * 256, dyQ8)) xb--;
            if (xa > xb) continue;
            if (!ring_rect_run_win((int16_t)xa, (int16_t)xb, (int16_t)dy, &xa, &xb)) continue;
            for (x = xa; x <= xb; x++) {
                int32_t dxQ8 = (x - RING_CX) * 256;
                uint8_t v = 0;

                if (!ring_rect_cov(dxQ8, dyQ8)) continue;
                if (!s_rx_erase) {
                    v = ring_rect_gain(ring_rect_angle_u(ring_rect_s(dxQ8, dyQ8)), newC);
                }
                if (nVal >= RING_BUF_PX) break;
                s_val[nVal++] = v;
                if (lo < 0) lo = x;
                hi = x;
            }
            if (lo >= 0 && s_runL[ri][0] == 0) {
                s_runX[ri][0] = (RING_XY_T)lo;
                s_runL[ri][0] = (RING_XY_T)(hi - lo + 1);
            } else if (lo >= 0) {
                s_runX[ri][1] = (RING_XY_T)lo;
                s_runL[ri][1] = (RING_XY_T)(hi - lo + 1);
            }
        }
    }
}

static void ring_rect_blit(void)
{
    uint16_t bg = ring.bg;
    uint16_t fg = ring.color;
    uint16_t off = 0;
    uint8_t  ri;

    if (busy) return;
    LCD_RingBegin();
    for (ri = 0; ri < s_rx_rn; ri++) {
        uint8_t k;
        RING_XY_T y = (RING_XY_T)(s_rx_y0 + ri);
        int32_t dy = (int32_t)y - RING_CY, dyQ8 = dy * 256;

        for (k = 0; k < 2; k++) {
            RING_XY_T n = s_runL[ri][k];
            RING_XY_T x0 = s_runX[ri][k];
            while (n) {
                uint8_t m = (n > RING_RUN_MAX) ? RING_RUN_MAX : (uint8_t)n;
                uint16_t px[RING_RUN_MAX];
                uint8_t i;
                for (i = 0; i < m; i++) {
                    RING_XY_T xx = (RING_XY_T)(x0 + i);
                    int32_t dxQ8 = ((int32_t)xx - RING_CX) * 256;
                    uint8_t cov = ring_rect_cov(dxQ8, dyQ8);
                    uint16_t base = ring_arc_color(ring_rect_arc_w((int16_t)(xx - RING_CX), (int16_t)dy,
                                                                    ring_rect_s(dxQ8, dyQ8)));
                    uint16_t band = ring_mix(base, fg, s_val[off + i], 0);
                    int16_t dth = 0;
#if RING_DITHER
                    dth = (int16_t)(((int16_t)s_bayer[((y & 7) << 3) | (xx & 7)] - 32) * 4);
#endif
#if RING_DEPTH_DEF > 0
                    {
                        int32_t nx, ny;
                        ring_rect_normal(dxQ8, dyQ8, &nx, &ny);
                        band = ring_rect_shade(band, -ring_rect_dist(dxQ8, dyQ8, (int32_t)RING_O_HX,
                                              (int32_t)RING_O_HY, (int32_t)RING_O_RC), nx, ny, dth);
                    }
#endif

                    px[i] = ring_mix(bg, band, cov, dth);
                }
                LCD_RingRun((uint16_t)x0, (uint16_t)y, m, px);
                x0 = (uint8_t)(x0 + m);
                off = (uint16_t)(off + m);
                n = (uint8_t)(n - m);
            }
        }
    }
    LCD_RingEnd();
}

static void ring_rect_render(int16_t oldC, int16_t newC, int16_t stepU, int8_t dir, uint8_t eraseOnly)
{
    const int32_t per = (int32_t)RING_PER_Q8;
    const int32_t thickPx = ((int32_t)RING_HT * 2) >> 8;
    int32_t a0, a1, pos, left, maxChunk;
    int32_t pxPerU = ((per >> 8) * (thickPx > 0 ? thickPx : 1)) / RING_ANG_UNITS + 1;

    (void)oldC;

    if (dir > 0) {
        a0 = (int32_t)newC + 180 - RING_SPAN_U - stepU;
        a1 = (int32_t)newC + 180 + RING_SPAN_U;
    } else {
        a0 = (int32_t)newC + 180 - RING_SPAN_U;
        a1 = (int32_t)newC + 180 + RING_SPAN_U + stepU;
    }
    maxChunk = (int32_t)(RING_BUF_PX * 3 / 4) / pxPerU;
    if (maxChunk < 8) maxChunk = 8;
    if (maxChunk > RING_ANG_UNITS) maxChunk = RING_ANG_UNITS;
    s_rx_erase = eraseOnly;
    pos = a0;
    left = a1 - a0;
    while (left > 0) {
        int32_t c = (left > maxChunk) ? maxChunk : left;
        ring_rect_win(pos, pos + ((c < left) ? c + 1 : c));

        while (c > 1 && s_rx_rn > RING_BUF_ROWS) {
            c = c >> 1;
            if (c < 1) c = 1;
            ring_rect_win(pos, pos + ((c < left) ? c + 1 : c));
        }
        ring_rect_compute(newC);
        ring_rect_blit();
        pos  += c;
        left -= c;
    }
}
#endif

#define RING_ARC_PADQ8   (3 * 256)
#define RING_HALFQ8      (((int32_t)RING_PER_Q8) / 2)

static int32_t s_rx_wc;
static int32_t s_rx_wh;
static uint8_t s_rx_win;

static int32_t ring_rect_wdist(int32_t s)
{
    int32_t d = s - s_rx_wc;
    if (d >  RING_HALFQ8) d -= (int32_t)RING_PER_Q8;
    if (d < -RING_HALFQ8) d += (int32_t)RING_PER_Q8;
    return d;
}

static uint8_t ring_rect_in_win(int32_t s)
{
    int32_t d;
    if (!s_rx_win) return 1;
    d = ring_rect_wdist(s);
    return (uint8_t)(d >= -s_rx_wh && d <= s_rx_wh);
}

static int32_t ring_rect_bisect_win(int32_t xa, int32_t xb, int32_t dyQ8,
                                    int32_t base, int32_t target, int32_t inc)
{
    int32_t lo = xa, hi = xb + 1;

    while (lo < hi) {
        int32_t mid = (lo + hi) >> 1;
        int32_t s   = ring_rect_s(((mid - RING_CX) * 256), dyQ8);
        int32_t d   = s - base;
        if (d >  RING_HALFQ8) d -= (int32_t)RING_PER_Q8;
        if (d < -RING_HALFQ8) d += (int32_t)RING_PER_Q8;
        s = base + d;
        if ((inc > 0) ? (s >= target) : (s <= target)) { hi = mid; }
        else                                           { lo = mid + 1; }
    }
    return lo;
}

static uint8_t ring_rect_paint_core(void)
{
    const int32_t per = (int32_t)RING_PER_Q8;
    int32_t y, y0, y1;

    if (busy) return 0;
    y0 = (int32_t)RING_CY - RING_RECT_CEIL(RING_O_HY) - 1;
    y1 = (int32_t)RING_CY + RING_RECT_CEIL(RING_O_HY) + 1;
    if (y0 < 0) y0 = 0;
    if (y1 > (RING_RECT_YMAX)) y1 = (RING_RECT_YMAX);

    if (s_rx_win) {

        int32_t pad = ((RING_RECT_PADY + 128) >> 8) + RING_RECT_AA_PX + 2;
        int32_t sA = s_rx_wc - s_rx_wh, sB = s_rx_wc + s_rx_wh, s;
        int32_t wy0 = 32000, wy1 = -32000;

        for (s = sA; ; s += 256) {
            int32_t xx, yy;
            if (s > sB) { s = sB; }
            ring_rect_point_q8(s, &xx, &yy);
            yy = (yy + 128) >> 8;
            if (yy - pad < wy0) { wy0 = yy - pad; }
            if (yy + pad > wy1) { wy1 = yy + pad; }
            if (s >= sB) { break; }
        }
        wy0 += (int32_t)RING_CY;
        wy1 += (int32_t)RING_CY;
        if (wy0 > y0) { y0 = wy0; }
        if (wy1 < y1) { y1 = wy1; }
        if (y0 < 0) y0 = 0;
        if (y1 > (RING_RECT_YMAX)) y1 = (RING_RECT_YMAX);
        if (y1 < y0) return 1;
    }

    LCD_RingBegin();
    for (y = y0; y <= y1; y++) {
        int32_t dy = y - RING_CY, dyQ8 = dy * 256;
        int32_t xo, xi;
        int8_t side;

        ring_rect_span_rng(dyQ8, &xo, &xi);
        if (xo <= 0) continue;
        for (side = 1; side >= -1; side -= 2) {
            int32_t xa, xb;

            if (side > 0) { xa = (int32_t)RING_CX + RING_RECT_FLOOR(xi); xb = (int32_t)RING_CX + RING_RECT_CEIL(xo); }
            else          { xa = (int32_t)RING_CX - RING_RECT_CEIL(xo);  xb = (int32_t)RING_CX - RING_RECT_FLOOR(xi); }
            if (xb < 0 || xa > (RING_RECT_XMAX) || xa > xb) continue;
            if (xa < 0) xa = 0;
            if (xb > (RING_RECT_XMAX)) xb = (RING_RECT_XMAX);
            while (xa <= xb && !ring_rect_cov((xa - RING_CX) * 256, dyQ8)) xa++;
            while (xb >= xa && !ring_rect_cov((xb - RING_CX) * 256, dyQ8)) xb--;
            if (xa > xb) continue;

            if (s_rx_win) {

                int32_t x0 = xa, x1 = xb;
                int32_t sa = ring_rect_s(((x0 - RING_CX) * 256), dyQ8);
                int32_t sb = ring_rect_s(((x1 - RING_CX) * 256), dyQ8);
                int32_t w0, w1, d = sb - sa;

                if (d >  RING_HALFQ8) sb -= per;
                if (d < -RING_HALFQ8) sb += per;
                {
                    int32_t w = s_rx_wc - sa;
                    while (w >  RING_HALFQ8) w -= per;
                    while (w < -RING_HALFQ8) w += per;
                    w0 = sa + w - s_rx_wh;
                    w1 = sa + w + s_rx_wh;
                }
                if (w1 < ((sa < sb) ? sa : sb) || w0 > ((sa < sb) ? sb : sa)) continue;
                if (sa <= sb) {
                    xa = ring_rect_bisect_win(x0, x1, dyQ8, sa, w0, 1);
                    xb = ring_rect_bisect_win(x0, x1, dyQ8, sa, w1 + 1, 1) - 1;
                } else {
                    xa = ring_rect_bisect_win(x0, x1, dyQ8, sa, w1, -1);
                    xb = ring_rect_bisect_win(x0, x1, dyQ8, sa, w0 - 1, -1) - 1;
                }
                if (xa > xb) continue;
            }

            while (xa <= xb) {
                uint16_t px[RING_RUN_MAX];
                uint8_t  n  = 0;
                int32_t  xs = xa;
                int32_t  x  = xa;

                while (x <= xb) {
                    int32_t dxQ8 = (x - RING_CX) * 256;
                    int32_t s    = ring_rect_s(dxQ8, dyQ8);

                    if (!ring_rect_in_win(s)) {
                        if (n) { LCD_RingRun((uint16_t)xs, (uint16_t)y, n, px); n = 0; }
                        x++;
                        xs = x;
                        continue;
                    }
                    {
                        uint8_t cov = ring_rect_cov(dxQ8, dyQ8);
                        uint16_t band = ring_arc_color(ring_rect_arc_w((int16_t)(x - RING_CX), (int16_t)dy, s));
                        int16_t dth = 0;
#if RING_DITHER
                        dth = (int16_t)(((int16_t)s_bayer[(((int32_t)y & 7) << 3) | (x & 7)] - 32) * 4);
#endif
#if RING_DEPTH_DEF > 0
                        {
                            int32_t nx, ny;
                            ring_rect_normal(dxQ8, dyQ8, &nx, &ny);
                            band = ring_rect_shade(band, -ring_rect_dist(dxQ8, dyQ8, (int32_t)RING_O_HX,
                                                  (int32_t)RING_O_HY, (int32_t)RING_O_RC), nx, ny, dth);
                        }
#endif
                        if (n == 0) { xs = x; }
                        px[n++] = ring_mix(ring.bg, band, cov, dth);
                    }
                    if (n >= RING_RUN_MAX) {
                        LCD_RingRun((uint16_t)xs, (uint16_t)y, n, px);
                        n = 0;
                    }
                    x++;
                }
                if (n) { LCD_RingRun((uint16_t)xs, (uint16_t)y, n, px); }
                xa = x;
            }
        }
    }
    LCD_RingEnd();
    return 1;
}

static uint8_t ring_rect_paint_arc(void)
{
    s_rx_win = 0;
    return ring_rect_paint_core();
}

static uint8_t ring_rect_paint_arc_win(int32_t wc, int32_t wh)
{
    s_rx_wc  = wc;
    s_rx_wh  = wh;
    s_rx_win = 1;
    return ring_rect_paint_core();
}
#endif

#if RING_GLINT_DEF && (RING_SHAPE == 0)
static void ring_blit(void);

#if RING_SHAPE == 0

#define RING_PX_PER_UNIT  ((int16_t)((((int32_t)RING_R_OUT * RING_R_OUT - (int32_t)RING_R_IN * RING_R_IN) * 22) / (7 * RING_ANG_UNITS)))

static void ring_render(int16_t oldC, int16_t newC, int16_t stepU, int8_t dir, uint8_t eraseOnly)
{
    int16_t a0  = (dir > 0) ? (int16_t)(oldC - RING_SPAN_U) : (int16_t)(newC - RING_SPAN_U);
    int16_t len = (int16_t)(stepU + 2 * RING_SPAN_U);
    int16_t pos = a0, left = len;

    int16_t maxChunk = (int16_t)(((int32_t)RING_BUF_PX * 5 / 6) / (RING_PX_PER_UNIT > 0 ? RING_PX_PER_UNIT : 1));

    if (maxChunk < 8) maxChunk = 8;
    while (left > 0) {
        int16_t c = (left > maxChunk) ? maxChunk : left;
        uint8_t cy;

        while (c > 4 && ring_chunk_rows(pos, (int16_t)((c < left) ? (c + 1) : c), &cy) > RING_BUF_ROWS) {
            c = (int16_t)(c >> 1);
        }

        {
            int16_t cl = (int16_t)((c < left) ? (c + 1) : c);
            ring_compute(pos, cl, newC, stepU, dir, eraseOnly);
            ring_blit();
        }
        pos  = (int16_t)(pos + c);
        left = (int16_t)(left - c);
    }
}
#endif

#if RING_SHAPE == 0
static void ring_blit(void)
{
    uint16_t bg = ring.bg;
    uint16_t fg = ring.color;
    uint16_t off = 0;
    uint8_t  ri;

    if (busy) return;
    LCD_RingBegin();
    for (ri = 0; ri < s_rowN; ri++) {
        uint8_t k;
        RING_XY_T y = (RING_XY_T)(s_rowY0 + ri);
        int16_t dy = (int16_t)(y - RING_CY);
        uint32_t dy2 = (uint32_t)((int32_t)dy * dy);
        ring_arc_row(dy);
        for (k = 0; k < 2; k++) {
            RING_XY_T n = s_runL[ri][k];
            RING_XY_T x0 = s_runX[ri][k];
            while (n) {
                uint8_t m = (n > RING_RUN_MAX) ? RING_RUN_MAX : (uint8_t)n;
                uint16_t px[RING_RUN_MAX];
                uint8_t i;
                for (i = 0; i < m; i++) {
                    uint8_t gain = s_val[off + i];
                    RING_XY_T xx = (RING_XY_T)(x0 + i);
                    int16_t dx = (int16_t)(xx - RING_CX);
                    uint32_t r2 = (uint32_t)((int32_t)dx * dx) + dy2;
                    uint16_t base = ring_arc_color(ring_arc_w(dx, dy));

                    int16_t dth = 0;
#if RING_DITHER
                    dth = (int16_t)(((int16_t)s_bayer[((y & 7) << 3) | (xx & 7)] - 32) * 4);
#endif

                    {
                        uint16_t band = ring_mix(base, fg, gain, 0);
#if RING_DEPTH_DEF > 0
                        band = ring_shade(band, r2, dx, dy, dth);
#endif
                        px[i] = ring_mix(bg, band, ring_cov(r2), dth);
                    }
                }
                LCD_RingRun((uint16_t)x0, (uint16_t)y, m, px);
                x0 = (uint8_t)(x0 + m);
                off = (uint16_t)(off + m);
                n   = (uint8_t)(n - m);
            }
        }
    }
    LCD_RingEnd();
}
#endif

#endif

#if RING_SHAPE == 1
#define ring_arc_update()           ring_rect_update()
#define ring_paint_arc()            ring_rect_paint_arc()
#define ring_paint_arc_win(c, h)    ring_rect_paint_arc_win((c), (h))
#define ring_arc_sweep_now()        ((uint32_t)s_rx_sweepS)
#if RING_GLINT_DEF
#define ring_render(a, b, c, d, e)  ring_rect_render(a, b, c, d, e)
#endif
#else
#define ring_paint_arc_win(c, h)    ring_paint_arc()
#define ring_arc_sweep_now()        ((uint32_t)s_arc_sweep)
#endif

#if RING_SHAPE == 0
#if RING_SEG_ON && (RING_SHAPE == 0)
/* 扇区 [a0, a1] (Q8, 相对弧起点) 覆盖到的行范围 —— 只用来裁循环, 多留 1 行。
 * 与 ring_chunk_rows() 同一套算法, 但那个在 RING_GLINT_DEF 里, 不能直接用。 */
static uint8_t ring_span_cross(int16_t a0u, int16_t len, int16_t target)
{
    int16_t d = (int16_t)(target - a0u);

    if (d < 0) d = (int16_t)(d + RING_ANG_UNITS);
    return (uint8_t)(d <= len);
}

static void ring_span_rows(int32_t a0Q8, int32_t a1Q8, int16_t *py0, int16_t *py1)
{
    int16_t a0u = (int16_t)(a0Q8 >= 0 ? a0Q8 / 128 : (a0Q8 - 127) / 128);
    int16_t a1u = (int16_t)(a1Q8 >= 0 ? (a1Q8 + 127) / 128 : a1Q8 / 128);
    int16_t len = (int16_t)(a1u - a0u);
    int16_t y0 = 32000, y1 = -32000;

    if (len < 0) len = (int16_t)(len + RING_ANG_UNITS);      /* 窗口跨 0° */

    int16_t c, s, y, k;

    for (k = 0; k < 2; k++) {
        ring_unit(ring_norm(k ? a1u : a0u), &c, &s);
        y = (int16_t)(RING_CY + (((int32_t)RING_R_IN * s + 8192) >> 14));
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        y = (int16_t)(RING_CY + (((int32_t)RING_R_OUT * s + 8192) >> 14));
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
    }
    /* 扇区跨过 90°/270° 时 sin 的极值在扇区内部, 要补上环带上下沿 */
    if (ring_span_cross(ring_norm(a0u), len, 180) && (RING_CY + RING_R_OUT > y1)) y1 = (int16_t)(RING_CY + RING_R_OUT);
    if (ring_span_cross(ring_norm(a0u), len, 540) && (RING_CY - RING_R_OUT < y0)) y0 = (int16_t)(RING_CY - RING_R_OUT);

    if (y0 > 0) y0--;
    if (y1 < (RING_SCR_H - 1)) y1++;
    if (y0 < 0) y0 = 0;
    if (y1 > (RING_SCR_H - 1)) y1 = (RING_SCR_H - 1);
    *py0 = y0;
    *py1 = y1;
}

/* 像素的相对角是否落在窗口 [winA, winA+winW) 内 (Q8, 相对弧起点, 环绕安全) */
static uint8_t ring_pixel_in_win(int16_t dx, int16_t dy, int32_t winA, int32_t winW)
{
    int32_t d = (int32_t)ring_arc_rel_u(dx, dy) * 128 - winA;

    if (d < 0) d += (RING_ANG_UNITS * 128L);
    return (uint8_t)(d < winW);
}
#endif

/* ===== 弧两端 / 段缝边界 角向抗锯齿 (运行期可调宽度) =====
 * 起点/终点是整条弧上唯一"填充色直接切到轨道色"的两条边; 段/缝边界同理。
 * 两条边共用一套参数: 以边界射线为中心铺一条 AA 过渡带, 覆盖度 0.5 落在射线
 * 上, 向两侧各铺 AA/2 px (AA = 总过渡宽度):
 *     缝侧 -AA/2 → 0, 边界 0 → 0.5, 段内 +AA/2 → 1
 * 用像素到射线的**垂直距离**算 (不受 0.5° 角度表量化), 所以边缘是真正的
 * 亚像素斜坡, 而不是"一个 50% 像素 + 硬边"。
 *
 * 宽度不再是编译期常量: 默认值取自 ring_config.h 的 RING_SEG_AA_X10
 * (0.1px, **总宽度**; 20 = 2.0px), 运行期可用 Ring_SetSegAA(x10) 直接改,
 * 改完自动重画整弧。0 = 关闭 (硬边), 便于在板子上现场对 AA 宽度做 A/B。
 *
 * 内部用半宽 (Q14 px):  half = x10/10/2 px → Q14 = x10*8192/10。
 * 覆盖度: t = 128 + dist/half*128 (dist 为正 = body 侧)。 */
#define RING_AA_HALF_FROM_X10(x10)   ((int32_t)(((long)(x10) * 8192L + 5L) / 10L))
#define RING_AA_HALF_DEF             RING_AA_HALF_FROM_X10(RING_SEG_AA_X10)
#define RING_AA_DIV_FROM_HALF(h)     ((int32_t)((h) / 128))

static int32_t s_angAAHalf = RING_AA_HALF_DEF;                 /* Q14 px, 半宽 */
static int32_t s_angAADiv  = RING_AA_DIV_FROM_HALF(RING_AA_HALF_DEF);

/* 由 0.1px 总宽度重算内部半宽; aaX10 = 0 → 关闭。 */
static void ring_aa_set(uint16_t aaX10)
{
    int32_t h;

    if (aaX10 > 60u) aaX10 = 60u;               /* 上限 6px, 防止溢出/糊成一片 */
    h = RING_AA_HALF_FROM_X10(aaX10);
    s_angAAHalf = h;
    s_angAADiv  = RING_AA_DIV_FROM_HALF(h);
}

/* 弧两端平口的 AA 半宽: **一个值管起点+终点** (与"沟槽 AA"分开)。
 * 初始值来自 ring_config.h 的 RING_AA_EDGE_X10; 老配置没有时 = RING_SEG_AA_X10。 */
static int32_t s_edgeAAHalf = RING_AA_HALF_FROM_X10(RING_AA_EDGE_X10);

static void ring_edgeaa_set(uint16_t edgeX10)
{
    if (edgeX10 > 60u) edgeX10 = 60u;
    s_edgeAAHalf = RING_AA_HALF_FROM_X10(edgeX10);
}

static uint16_t ring_edge_color(uint8_t cell)
{
    uint16_t fg;

#if RING_ARC_GRAD && RING_SEG_ON
    if (cell >= (uint8_t)RING_GRAD_N) cell = (uint8_t)(RING_GRAD_N - 1u);
    fg = ringGrad70[cell];
    if (ring.dim) fg = ring_mix(fg, 0x0000u, ring.dim, 0);
#else
    (void)cell;
    fg = ring.arcFill;
    if (ring.dim) fg = ring_mix(fg, 0x0000u, ring.dim, 0);
#endif
    return fg;
}

/* 段内像素的角向着色 + AA (AA 宽度运行期可调)。
 * 位置来自 ring_seg_split() 的段内偏移 r (Q8 度); 边界射线用 r 判断是
 * "body 起点 / body 终点" 中的哪一条, 再用 Q8 插值的单位向量做点积 ——
 * 边界位置是精确的, 不受 0.5° atan 表量化 (这正是原来缝边发硬的原因)。
 *   body 侧颜色 = 该段渐变色 (含暂停压暗)
 *   gap  侧颜色 = groove(body, 0) (MODE=1, 深度按 RING_SEG_DEPTH 逐段变)
 *                或 arcTrack        (MODE=0, 切断)
 * 返回 0..255 的混合色, *pcell = 该像素所属段号 (渐变/cut 都要用)。
 * 只在 RING_SEG_ON 时编 (依赖 RING_SEG_* 几何宏); 关闭分割时弧两端仍有 AA。 */
#if RING_SEG_ON && (RING_SHAPE == 0)
static uint16_t ring_seg_aa_color(int16_t dx, int16_t dy, uint32_t relQ8, uint8_t *pcell)
{
    uint8_t  q;
    uint32_t r = ring_seg_split(relQ8, &q);
    uint32_t edge;
    int8_t   bodyPlus;
    uint8_t  bodyCell, gapCell;
    uint16_t body, gap;
    int16_t  c, s;
    int32_t  cross, sBody, t;

    if (r < (uint32_t)RING_SEG_BODY_Q8) {
        /* body 内: 取更近的那条边 (起 or 止) */
        bodyCell = q;
        if (r < ((uint32_t)RING_SEG_BODY_Q8 - r)) {
            edge    = (uint32_t)q * RING_SEG_P_Q8;
            bodyPlus = 1;
            gapCell  = (q > 0u) ? (uint8_t)(q - 1u) : 0u;
        } else {
            edge    = (uint32_t)q * RING_SEG_P_Q8 + RING_SEG_BODY_Q8;
            bodyPlus = -1;
            gapCell  = q;
        }
    } else {
        /* 缝里: 取更近的那条边 —— 前一段的终点 or 后一段的起点。
         * 以前这里一律用"前一段终点", 于是缝的**另一侧**(后一段的起点)
         * 没有过渡, 两条分割线一边软一边硬, 看起来就是歪的。 */
        uint32_t dEnd  = r - (uint32_t)RING_SEG_BODY_Q8;
        uint32_t dNext = (uint32_t)RING_SEG_P_Q8 - r;

        if ((((uint32_t)q + 1u) < (uint32_t)RING_SEG_N) && (dNext < dEnd)) {
            bodyCell = (uint8_t)(q + 1u);
            gapCell  = q;
            edge     = ((uint32_t)q + 1u) * RING_SEG_P_Q8;
            bodyPlus = 1;
        } else {
            bodyCell = q;
            gapCell  = q;
            edge     = (uint32_t)q * RING_SEG_P_Q8 + RING_SEG_BODY_Q8;
            bodyPlus = -1;
        }
    }

    ring_unit_q8((int32_t)ring.arcStart * 128 + (int32_t)edge, &c, &s);
    cross = (int32_t)c * dy - (int32_t)s * dx;
    sBody = (bodyPlus > 0) ? cross : -cross;

    /* 运行期 AA 宽度: body 侧 +AA/2 → 255, 边界 → 128, 缝侧 -AA/2 → 0。
     * s_angAADiv = 半宽/128; AA 关闭时退化成硬边 (sBody >= 0 全亮)。 */
    if (s_angAADiv > 0) {
        t = 128 + (sBody / s_angAADiv);
    } else {
        t = (sBody >= 0) ? 255 : 0;
    }
    if (t < 0) t = 0;
    if (t > 255) t = 255;

    body = ring_edge_color(bodyCell);
#if RING_SEG_MODE == 0
    gap  = ring.arcTrack;
#else
    gap  = ring_seg_groove(ring_edge_color(gapCell), 0);
#endif

    *pcell = bodyCell;
    return ring_mix(gap, body, (uint8_t)t, 0);
}
#endif  /* RING_SEG_ON && RING_SHAPE == 0 */

/* 端点外延的颜色 = 该端自己那一段的沟槽色 (cell 的渐变色压暗)。
 * 起点用第 0 段、结束角用最后一段: 颜色与端面同色系, 不会跑出上一周期的错色。
 * 未开分割或 segmented=0 时返回调用方给的 fg (fill / track)。 */
static uint16_t ring_end_color(uint8_t cell, uint16_t fg, uint8_t segmented)
{
#if RING_SEG_ON && (RING_SHAPE == 0)
    if (segmented) {
        /* 端面颜色 = 该段在**段/缝边界处**的颜色 (mask=0.5):
         *   mix(groove, body, 0.5) —— 与主体遍边界像素同色, 向外再按 cov 淡出。
         * 旧版直接返回 groove (深度 60% 时只有 0.4×body), 端点外像一圈暗影,
         * 看起来就是"没做 AA / 效果不好"。 */
        uint16_t body = ring_edge_color(cell);

        return ring_mix(ring_seg_groove(body, 0), body, 128, 0);
    }
#else
    (void)cell; (void)segmented;
#endif
    return fg;
}

/* absQ8 = 末端射线的绝对角 (Q8, 0 = +x, 顺时针为正);
 * outwardAfter = 1: 射线外侧在角度增大方向; 0: 外侧在角度减小方向;
 * aaHalf = 该端的 AA 半宽 (Q14 px), 起点/终点各自独立, 0 = 不画过渡带 (硬边)。 */
static void ring_paint_end(int32_t absQ8, uint16_t fg, uint8_t outwardAfter, int32_t aaHalf,
                           uint8_t segmented, uint8_t cell)
{
    const uint32_t RIN2  = (uint32_t)(RING_R_IN * RING_R_IN);
    const uint32_t ROUT2 = (uint32_t)(RING_R_OUT * RING_R_OUT);
    int16_t  c, s;
    int16_t  xin, yin, xout, yout;
    int16_t  bx0, bx1, by0, by1, y;
    int16_t  pad;

    ring_unit_q8(absQ8, &c, &s);

    /* AA 关闭 (宽度 0): 端点就是硬边, 主体遍已经画好, 这一遍不用跑。 */
    if (aaHalf <= 0) return;

    xin  = (int16_t)(RING_CX + (((int32_t)RING_R_IN  * c) >> 14));
    yin  = (int16_t)(RING_CY + (((int32_t)RING_R_IN  * s) >> 14));
    xout = (int16_t)(RING_CX + (((int32_t)RING_R_OUT * c) >> 14));
    yout = (int16_t)(RING_CY + (((int32_t)RING_R_OUT * s) >> 14));

    /* 端点 bbox: 径向那 17px 那一条 + 外侧余量 (完整 AA 宽度 px + 2) */
    pad = (int16_t)((aaHalf >> 13) + 2);
    bx0 = (int16_t)(((xin < xout) ? xin : xout) - pad);
    bx1 = (int16_t)(((xin > xout) ? xin : xout) + pad);
    by0 = (int16_t)(((yin < yout) ? yin : yout) - pad);
    by1 = (int16_t)(((yin > yout) ? yin : yout) + pad);
    if (bx0 < 0) bx0 = 0;
    if (by0 < 0) by0 = 0;
    if (bx1 > (RING_SCR_W - 1)) bx1 = (int16_t)(RING_SCR_W - 1);
    if (by1 > (RING_SCR_H - 1)) by1 = (int16_t)(RING_SCR_H - 1);
    if ((bx0 > bx1) || (by0 > by1)) return;

    {
        uint16_t fgpx = ring_end_color(cell, fg, segmented);

    for (y = by0; y <= by1; y++) {
        uint16_t px[RING_RUN_MAX];
        uint8_t  n = 0;
        int16_t  runx = 0;
        int16_t  dy = (int16_t)(y - RING_CY);
        uint32_t dy2 = (uint32_t)((int32_t)dy * dy);
        int16_t  x;

        for (x = bx0; x <= bx1; x++) {
            int16_t  dx = (int16_t)(x - RING_CX);
            uint32_t r2 = (uint32_t)((int32_t)dx * dx) + dy2;
            int32_t  cross, dist, cov;

            if ((r2 < RIN2) || (r2 > ROUT2)) {
                if (n) { LCD_RingRun((uint16_t)runx, (uint16_t)y, n, px); n = 0; }
                continue;
            }
            /* cross > 0: 像素在射线角度增大的一侧 */
            cross = (int32_t)c * dy - (int32_t)s * dx;
            dist  = outwardAfter ? cross : -cross;
            /* 单边、向外: dist <= 0 (带内) 不画 (主体遍已满高亮);
             * 0..AA 向外淡出; AA 之外不画。这样不会侵蚀高亮区。 */
            if ((dist <= 0) || (dist >= (aaHalf * 2))) {
                if (n) { LCD_RingRun((uint16_t)runx, (uint16_t)y, n, px); n = 0; }
                continue;
            }
            cov = 255 - ((dist * 128) / aaHalf);   /* 0 → 255, AA/2 → 127, AA → 0 */
            if (cov < 0) cov = 0;
            if (cov > 255) cov = 255;

            /* 颜色固定为该端的沟槽色; 用 cov 作为 alpha 向背景淡出 —— 端面本身满色,
             * 不会先被混成轨道色/黑色, 沟槽格能完整延续到端面外。 */
            {
                uint16_t a = (uint16_t)(((uint32_t)cov * (uint32_t)ring_cov(r2) + 127u) >> 8);

                if (n == 0) runx = x;
                px[n++] = ring_mix(ring.bg, fgpx, (uint8_t)a, 0);
            }
            if (n >= RING_RUN_MAX) {
                LCD_RingRun((uint16_t)runx, (uint16_t)y, n, px);
                n = 0;
            }
        }
        if (n) LCD_RingRun((uint16_t)runx, (uint16_t)y, n, px);
    }
    }
}

/* 弧带绘制。winW > 0 时只画 [winA, winA+winW) 这一段扇区 (Q8, 相对弧起点),
 * winW == 0 时画整弧。增量重画靠这个把一次换档的 SPI 从整弧 ~17KB 压到几百字节。 */
static uint8_t ring_paint_band(int32_t winA, int32_t winW)
{
    const uint32_t RIN2  = (uint32_t)(RING_R_IN * RING_R_IN);
    const uint32_t ROUT2 = (uint32_t)(RING_R_OUT * RING_R_OUT);
    int16_t y, y0, y1;

    if (busy) return 0;

    if (winW > 0) {
#if RING_SEG_ON && (RING_SHAPE == 0)
        /* winA/winW 是"相对弧起点"的角, 算行范围要换成绝对角 */
        ring_span_rows((int32_t)RING_ARC_START_DEF * 128 + winA,
                       (int32_t)RING_ARC_START_DEF * 128 + winA + winW, &y0, &y1);
#else
        (void)winA; (void)winW;
        winW = 0;
        y0 = 0;
        y1 = (int16_t)(RING_SCR_H - 1);
#endif
    } else {
        /* 整弧: 只扫环带所在的行 (原来是 0..239 全屏) */
        y0 = (int16_t)(RING_CY - RING_R_OUT);
        y1 = (int16_t)(RING_CY + RING_R_OUT);
        if (y0 < 0) y0 = 0;
        if (y1 > (RING_SCR_H - 1)) y1 = (int16_t)(RING_SCR_H - 1);
    }

    LCD_RingBegin();
    for (y = y0; y <= y1; y++) {
        int16_t dy  = (int16_t)(y - RING_CY);
        uint32_t dy2 = (uint32_t)((int32_t)dy * dy);
        int16_t inner, outer, xa, xb;
        int8_t  side;

        if (dy2 > ROUT2) continue;
        outer = ring_isqrt(ROUT2 - dy2);
        inner = (dy2 < RIN2) ? ring_isqrt(RIN2 - dy2) : 0;
        ring_arc_row(dy);

        for (side = 1; side >= -1; side -= 2) {
            if (side > 0) { xa = (int16_t)(RING_CX + inner); xb = (int16_t)(RING_CX + outer); }
            else          { xa = (int16_t)(RING_CX - outer); xb = (int16_t)(RING_CX - inner - ((inner == 0) ? 1 : 0)); }
            if (xa < 0) xa = 0;
            if (xb > (RING_SCR_W - 1)) xb = (RING_SCR_W - 1);

            while (xa <= xb) {
                int16_t dx = (int16_t)(xa - RING_CX);
                uint32_t r2 = (uint32_t)((int32_t)dx * dx) + dy2;
                if (r2 >= RIN2 && r2 <= ROUT2) break;
                xa++;
            }
            while (xb >= xa) {
                int16_t dx = (int16_t)(xb - RING_CX);
                uint32_t r2 = (uint32_t)((int32_t)dx * dx) + dy2;
                if (r2 >= RIN2 && r2 <= ROUT2) break;
                xb--;
            }

#if RING_SEG_ON && (RING_SHAPE == 0)
            if (winW > 0) {
                /* 扇区 < 180°, 与一行相交必是连续区间: 两端各收一次即可 */
                while ((xa <= xb) && !ring_pixel_in_win((int16_t)(xa - RING_CX), dy, winA, winW)) xa++;
                if (xa > xb) continue;
                while ((xb >= xa) && !ring_pixel_in_win((int16_t)(xb - RING_CX), dy, winA, winW)) xb--;
                if (xb < xa) continue;
            } else if ((uint16_t)RING_ARC_RANGE_U < (uint16_t)RING_ANG_UNITS) {
                /* 整弧重画也要只碰**配置的弧范围** [start, start+span):
                 * 底部的 70° 缺口 (125°→55° 之间) 不是圆环, 那里躺着 F/R/电池,
                 * 以前 w==0 的分支会把整圈 annulus 都按 track 色擦黑 —— 缺口里的
                 * 素材跟着消失。这里把 xa/xb 收到弧内, 缺口一个像素都不写。 */
                /* +128 (0.5°): ring_arc_rel_u() 是 0.5° 量化, 弧末端内侧
                 * ~0.25° 的像素会被四舍五入到 290.0 而被这里裁掉, 留下一个
                 * 单像素黑洞; 多放一个量化单位, 让 ring_arc_w()/端点 AA 去判。 */
                int32_t arcW = (int32_t)RING_ARC_RANGE_U * 128 + 128;
                while ((xa <= xb) && !ring_pixel_in_win((int16_t)(xa - RING_CX), dy, 0, arcW)) xa++;
                if (xa > xb) continue;
                while ((xb >= xa) && !ring_pixel_in_win((int16_t)(xb - RING_CX), dy, 0, arcW)) xb--;
                if (xb < xa) continue;
            }
#endif

            while (xa <= xb) {
                uint16_t px[RING_RUN_MAX];
                uint8_t  n = 0;
                int16_t  x = xa;
                while (x <= xb && n < RING_RUN_MAX) {
                    int16_t  dx = (int16_t)(x - RING_CX);
                    uint32_t r2 = (uint32_t)((int32_t)dx * dx) + dy2;
                    int16_t  dth = 0;
#if RING_DITHER
                    dth = (int16_t)(((int16_t)s_bayer[((y & 7) << 3) | (x & 7)] - 32) * 4);
#endif
                    {
                        uint8_t  w = ring_arc_w(dx, dy);
                        uint16_t band;

                        if (w) {
#if (RING_SEG_ON) && (RING_SHAPE == 0)
                            uint8_t cell = 0;

                            /* 段内 2px 角向 AA: body ↔ groove (逐段色, 深度可变) */
                            band = ring_seg_aa_color(dx, dy,
                                        (uint32_t)(int32_t)ring_arc_rel_u(dx, dy) * 128u,
                                        &cell);
                            band = ring_mix(ring.arcTrack, band, w, 0);
#else
#  if RING_ARC_GRAD
                            band = ring_grad_color(w, ring_arc_rel_u(dx, dy));
#  else
                            band = ring_arc_color(w);
#  endif
#endif
                        } else {
                            band = ring.arcTrack;
                        }
#if RING_DEPTH_DEF > 0
                        band = ring_shade(band, r2, dx, dy, dth);
#endif
                        px[n++] = ring_mix(ring.bg, band, ring_cov(r2), dth);
                    }
                    x++;
                }
                LCD_RingRun((uint16_t)xa, (uint16_t)y, n, px);
                xa = x;
            }
        }
    }

    /* 弧的**静态端点** (起始角 / 结束角) 角向过渡, 单边向外, 不侵蚀高亮。
     * 当前进度前沿 (例如 10/35 的填充末端) 不做 AA —— 只有满档时末端才与
     * 配置的结束角重合, 由这里的结束角过渡负责。
     * 端帽打开的那一端不画; 有拖尾时末端由渐隐收边, 也不画。 */
#if (RING_ARC_SPAN_DEF) < RING_ANG_UNITS
    if ((s_arc_caps & 0x1u) == 0u) {
        ring_paint_end((int32_t)ring.arcStart * 128,
                       (s_arc_sweep != 0u) ? ring_edge_color(0u) : ring.arcTrack,
                       (uint8_t)(ring.arcDir < 0),
                       s_edgeAAHalf,
                       (uint8_t)(s_arc_sweep != 0u), 0u);
    }
    if (((s_arc_caps & 0x2u) == 0u) && (ring.arcTrail == 0u)) {
        uint16_t efg;
        uint8_t  ecell = 0u;

        if (s_arc_sweep >= (uint16_t)RING_ARC_RANGE_U) {
#if (RING_SEG_ON) && (RING_SHAPE == 0)
            ecell = (s_arc_endQ8 > 0u)
                        ? (uint8_t)((s_arc_endQ8 - 1u) / (uint32_t)RING_SEG_P_Q8)
                        : 0u;
#endif
            efg = ring_edge_color(ecell);
        } else {
            efg = ring.arcTrack;        /* 未满档: 结束角只是轨道末端 */
        }
        ring_paint_end((int32_t)ring.arcStart * 128 +
                           (int32_t)ring.arcDir * (int32_t)RING_ARC_RANGE_U * 128,
                       efg,
                       (uint8_t)(ring.arcDir > 0),
                       s_edgeAAHalf,
                       (uint8_t)(s_arc_sweep >= (uint16_t)RING_ARC_RANGE_U), ecell);

        /* 未满档: 当前进度前沿也做向外 AA (2026-10-22 用户要求)。
         * 前沿已落在槽中点 (fillEnd = lit*P - gap/2), 边界颜色取该处的槽色;
         * 只向外淡出, 不侵蚀已亮的段体。 */
        if ((s_arc_sweep != 0u) && (s_arc_sweep < (uint16_t)RING_ARC_RANGE_U)) {
            uint8_t  fcell = 0u;
            uint16_t ffg;

#if (RING_SEG_ON) && (RING_SHAPE == 0)
            uint32_t rem;

            fcell = (s_arc_endQ8 > 0u)
                        ? (uint8_t)((s_arc_endQ8 - 1u) / (uint32_t)RING_SEG_P_Q8)
                        : 0u;
            rem = s_arc_endQ8 % (uint32_t)RING_SEG_P_Q8;
            ffg = (rem >= (uint32_t)RING_SEG_BODY_Q8)
                      ? ring_seg_groove(ring_edge_color(fcell), 0)
                      : ring_end_color(fcell, ring.arcTrack, 1u);
#else
            ffg = ring.arcTrack;
#endif
            ring_paint_end((int32_t)ring.arcStart * 128 +
                               (int32_t)ring.arcDir * (int32_t)s_arc_endQ8,
                           ffg,
                           (uint8_t)(ring.arcDir > 0),
                           s_edgeAAHalf, 0u, fcell);
        }
    }
#endif

    LCD_RingEnd();
    return 1;
}

/* 整弧重画 (进页 / 唤醒 / 屏被别层擦过) */
static uint8_t ring_paint_arc(void)
{
    return ring_paint_band(0, 0);
}

/* 由扫弧终点反推"画到第几段" —— Ring_SegSweep() 是单调的, 70 次比较而已。 */
static uint8_t ring_lit_of_sweep(uint32_t sweep)
{
#if (RING_SEG_ON) && (RING_SHAPE == 0)
    uint8_t lit = 0;

    while ((lit < (uint8_t)RING_SEG_N) && (Ring_SegSweep((uint8_t)(lit + 1u)) <= sweep)) lit++;
    return lit;
#else
    (void)sweep;
    return 0;
#endif
}

/* 增量重画: 只补画 / 擦掉"亮段数变化"涉及的那一小段扇区。
 *   oldLit → newLit 的差值区间 = [oldLit×P − gap, newLit×P)
 * 起点要往回退一条缝: 该缝在未亮时是轨道色, 亮了以后要变成暗槽色。
 * 返回 0 = 没画成 (调用方退全量); 1 = 已上屏。 */
#if RING_SEG_ON && (RING_SHAPE == 0)
static uint8_t ring_paint_delta(uint8_t oldLit, uint8_t newLit)
{
    int32_t a, len;

    if (oldLit == newLit) return 1;
    if (oldLit > newLit) { uint8_t t = oldLit; oldLit = newLit; newLit = t; }

    a = (int32_t)oldLit * RING_SEG_P_Q8 - (int32_t)RING_SEG_GAP_Q8;
    len = (int32_t)(newLit - oldLit) * RING_SEG_P_Q8;
    if (len <= 0) return 1;

    /* 两端各留 3° 余量给 AA 与像素量化 (端点 2px 过渡带会越过填充边 ~1°,
     * 2° 余量在"槽中点分割 + 前沿 AA"后仍可能漏掉一个边缘像素) */
    a -= 768;
    len += 1536;

    /* 扇区 < 180° 时"与一行相交必连续"才成立; 留 10° 余量, 再大就整弧重画 */
    if (len > (170L * 256L)) return 0;

    return ring_paint_band(a, len);
}
#else
static uint8_t ring_paint_delta(uint8_t oldLit, uint8_t newLit)
{
    (void)oldLit; (void)newLit;
    return 0;
}
#endif
#endif

/* 屏上那一圈 == 引擎当前状态? (画出来会是同一幅?) —— 是就不必再推一次屏。
 * 判据分两支, 都只看**参与成像**的量:
 *   ① 上次画的就是满圈, 这一发还是满圈: 成像只取决于底色与进度弧色 ——
 *      方向/起点/端帽/拖尾都不参与 (ring_rect_arc_w 满圈时直接返回 255);
 *   ② 非满圈: 逐项指纹 (底色/轨道色/进度弧色/起点/方向/端帽/拖尾 + 已画张角) 全一致。
 * 屏被别的层擦了必须 Ring_ScreenInvalidate(), 否则这里会误判。 */
static uint16_t s_paintBg, s_paintTrack, s_paintFill;
static uint8_t  s_paintFull;
static uint32_t s_paintKey;

static uint32_t ring_paint_key(void)
{
    uint32_t k = (uint32_t)ring.arcStart;

    k = k * 33u + (uint32_t)(uint8_t)ring.arcDir;
    k = k * 33u + ring.arcCaps;
    k = k * 33u + ring.arcCapMask;
    k = k * 33u + ring.arcTrail;
    k = k * 33u + ring.dim;        /* 暂停压暗也参与成像, 必须进指纹 */
#if RING_GLINT_DEF
    k = k * 33u + ring.color;
    k = k * 33u + (uint32_t)ring.glint;
    k = k * 33u + ring.center;
#endif
    return k;
}

static void ring_paint_mark(void)
{
    s_paintBg      = ring.bg;
    s_paintTrack   = ring.arcTrack;
    s_paintFill    = ring.arcFill;
    s_paintFull    = (uint8_t)(ring_arc_sweep_now() >= RING_SWEEP_FULL);
    s_paintKey     = ring_paint_key();
    s_arcSweepPainted = ring_arc_sweep_now();
    s_litPainted   = ring_lit_of_sweep(s_arcSweepPainted);
    s_arcPainted   = 1;
}

static uint8_t ring_screen_ok(void)
{
    if (!s_arcPainted) { return 0; }
    if ((s_paintBg != ring.bg) || (s_paintTrack != ring.arcTrack) ||
        (s_paintFill != ring.arcFill)) { return 0; }
#if RING_GLINT_DEF
    if (ring.glint) { return 0; }       /* 白斑要逐帧动, 不能省 */
#endif
    if (s_paintFull) { return (uint8_t)(ring_arc_sweep_now() >= RING_SWEEP_FULL); }
    return (uint8_t)((s_paintKey == ring_paint_key()) &&
                     (s_arcSweepPainted == ring_arc_sweep_now()));
}

/* 与 ring_screen_ok 相同, 但**不看 sweep**: 用来判断"能不能只补画变化的那几段"。
 * 颜色/底色/起点/方向/端帽/拖尾/压暗 任何一项变了都必须整弧重画。 */
static uint8_t ring_screen_ok_no_sweep(void)
{
    if (!s_arcPainted) { return 0; }
    if ((s_paintBg != ring.bg) || (s_paintTrack != ring.arcTrack) ||
        (s_paintFill != ring.arcFill)) { return 0; }
#if RING_GLINT_DEF
    if (ring.glint) { return 0; }
#endif
    return (uint8_t)(s_paintKey == ring_paint_key());
}

void Ring_ScreenInvalidate(void)
{
    s_arcPainted = 0;
}

static uint8_t ring_draw_try(void)
{
    if (ring_screen_ok()) { return 1; }

    if (!ring_paint_arc()) return 0;
    ring_paint_mark();
    g_ringPaints++;
    g_ringFullPaints++;
#if RING_GLINT_DEF
    if (ring.glint) ring_render((int16_t)ring.center, (int16_t)ring.center, 0, ring.dir, 0);
#endif
    ring.drawn = 1;
    return 1;
}
static void ring_draw(void)
{
    if (!ring_draw_try())
    {
#if RING_GLINT_DEF
        s_arcDirty = 1;
#endif
    }
}

void Ring_Tick(void)
{
#if RING_GLINT_DEF
    int16_t oldC, newC;
#endif

    if (!ring.active || busy) return;

#if RING_GLINT_DEF

    if (s_arcDirty) {
        if (!ring_draw_try()) return;
        s_arcDirty = 0;
        return;
    }
    if (!ring.glint) return;

    oldC = (int16_t)ring.center;
    newC = (int16_t)ring_norm(oldC + (int16_t)ring.dir * (int16_t)ring.step);

    ring_render(oldC, newC, (int16_t)ring.step, ring.dir, 0);
    ring.center = (uint16_t)newC;
    ring.drawn = 1;
#endif
}

void Ring_Init(void)
{
    ring.center = 0;
    ring.step   = 20;
    ring.dir    = 1;
    ring.active = 0;
    ring.drawn  = 0;
#if RING_GLINT_DEF
    ring.glint  = RING_GLINT_DEF ? 1 : 0;
#endif
    ring.bg     = 0x0000;
    ring.color  = 0xFFFF;
    ring.tickMs = RING_TICK_MS;
    ring.arcTrack = RING_ARC_TRACK_DEF;
    ring.arcFill  = RING_ARC_FILL_DEF;
    ring.arcStart = RING_ARC_START_DEF;
    ring.arcSteps = RING_ARC_STEPS_DEF;
    ring.arcValue = RING_ARC_VALUE_DEF;
    ring.arcCaps  = RING_ARC_CAPS_DEF;
    ring.arcCapMask = 0x3u;
    ring.arcDir   = (RING_ARC_DIR_DEF < 0) ? -1 : 1;
    ring.dim      = 0u;
    ring.arcTrail = 0;
    ring.arcSweep = RING_SWEEP_FULL;
    ring.arcFine  = 0;
    ring_aa_set((uint16_t)RING_SEG_AA_X10);      /* 段/缝 AA 运行期宽度 = 配置默认 */
    ring_edgeaa_set((uint16_t)RING_AA_EDGE_X10);   /* 弧两端平口 AA: 一个值管两端 */
    ring_arc_update();
    s_arcSweepPainted = ring_arc_sweep_now();
    /* 复位后引擎认为屏上还没有环: 之后 SetArc/SetArcSweep 只改状态不推屏, 由第一次
     * Redraw()/Start() 一次性画出来 —— 否则 Init 之后每个设置项都各自整圈重画一次
     * (本板实测一次整圈重画 ~300ms, 开机动画一上来就白推三圈)。 */
    s_arcPainted = 0;
#if RING_GLINT_DEF
#if RING_SHAPE == 0
    s_rowY0     = 0;
    s_rowN      = 0;
#else
    s_rx_y0     = 0;
    s_rx_rn     = 0;
#endif
#endif

#ifndef RING_SIM
    /* CW32L011 无 EAU: 已定义 RING_USE_EAU=0, 不再调用 EAU_Init() */
#if RING_GLINT_DEF

    __SYSCTRL_BTIM123_CLK_ENABLE();
    BTIM_TimeBaseInitTypeDef cfg = {0};
    cfg.BTIM_Prescaler = RING_BTIM_PSC;
    cfg.BTIM_Period    = (uint16_t)(10 * RING_TICK_MS - 1);
    cfg.BTIM_CountMode = BTIM_COUNT_MODE_REPETITIVE;
    cfg.BTIM_Mode      = BTIM_MODE_TIMER;
    BTIM_TimeBaseInit(CW_BTIM3, &cfg);
    CW_BTIM3->DIER_f.UIE = 1;               /* 原 BTIM_ITConfig */
#endif
#endif
}

void Ring_Start(uint8_t gear, int8_t dir)
{
    Ring_SetGear(gear);
    ring.dir    = (dir >= 0) ? 1 : -1;
    ring.center = 0;
    ring.active = 0;

#if RING_GLINT_DEF
    s_arcDirty = 0;
#endif
    if (!ring_draw_try())
    {
#if RING_GLINT_DEF
        s_arcDirty = 1;
#endif

    }
    ring.active = 1;

#if !defined(RING_SIM) && RING_GLINT_DEF
    BTIM_Cmd(CW_BTIM3, ENABLE);
#endif
}

void Ring_Stop(void)
{
    ring.active = 0;
#if !defined(RING_SIM) && RING_GLINT_DEF
    BTIM_Cmd(CW_BTIM3, DISABLE);
    CW_BTIM3->ICR = 0;
#endif
}

void Ring_Clear(void)
{
    ring.active = 0;
#if RING_GLINT_DEF
    s_arcDirty = 0;
#endif
#if RING_GLINT_DEF
    if (ring.drawn && !busy) {
        ring_render((int16_t)ring.center, (int16_t)ring.center, 0, ring.dir, 1);
        ring.drawn = 0;
    }
#else
    ring.drawn = 0;
#endif

    s_arcPainted = 0;
    s_arcSweepPainted = 0;
    Ring_Stop();
}

void Ring_SetGear(uint8_t gear)
{
    if (gear < 1) gear = 1;
    if (gear > RING_GEAR_MAX) gear = RING_GEAR_MAX;
    ring.step = gear;
}

void Ring_SetSpeed(uint8_t step_half_deg)
{
    if (step_half_deg < 1) step_half_deg = 1;
    if (step_half_deg > RING_GEAR_MAX) step_half_deg = RING_GEAR_MAX;
    ring.step = step_half_deg;
}

void Ring_SetInterval(uint16_t ms)
{
    if (ms < 1) ms = 1;
    ring.tickMs = ms;
#if !defined(RING_SIM) && RING_GLINT_DEF
    BTIM_Cmd(CW_BTIM3, DISABLE);
    CW_BTIM3->ICR = 0;
    {
        BTIM_TimeBaseInitTypeDef cfg = {0};
        cfg.BTIM_Prescaler = RING_BTIM_PSC;
        cfg.BTIM_Period    = (uint16_t)(10 * ms - 1);
        cfg.BTIM_CountMode = BTIM_COUNT_MODE_REPETITIVE;
        cfg.BTIM_Mode      = BTIM_MODE_TIMER;
        BTIM_TimeBaseInit(CW_BTIM3, &cfg);
    }
    if (ring.active) BTIM_Cmd(CW_BTIM3, ENABLE);
#endif
}

void Ring_SetDir(int8_t dir)
{
    ring.dir = (dir >= 0) ? 1 : -1;
}

void Ring_SetGlint(uint8_t on)
{
#if RING_GLINT_DEF
    on = on ? 1 : 0;
    if (ring.glint == on) return;
    ring.glint = on;
    if (ring.active && !busy) ring_draw();
    else if (ring.active)     s_arcDirty = 1;
#else
    (void)on;
#endif
}

static void ring_arc_repaint(uint8_t forceFull)
{
    uint32_t oldSweep = s_arcSweepPainted;

    ring_arc_update();

    if (busy)
    {
#if RING_GLINT_DEF
        s_arcDirty = 1;
#endif
        return;
    }

    if (!s_arcPainted) { return; }

#if RING_SHAPE == 1
    {
        int32_t per  = (int32_t)RING_PER_Q8;
        int32_t eOld, eNew, d, wc, wh, m, raw;

        if (forceFull) { ring_draw(); return; }

        if (s_rx_sweepS <= 0) { ring_draw(); return; }

        raw = (int32_t)s_rx_sweepS - (int32_t)oldSweep;
        if (raw < 0) { raw = -raw; }
        if (raw * 3 >= per) { ring_draw(); return; }

        eOld = s_rx_s0 + ((s_rx_dir < 0) ? -(int32_t)oldSweep : (int32_t)oldSweep);
        eNew = s_rx_s0 + ((s_rx_dir < 0) ? -s_rx_sweepS    : s_rx_sweepS);
        eOld %= per; if (eOld < 0) { eOld += per; }
        eNew %= per; if (eNew < 0) { eNew += per; }

        m = RING_ARC_PADQ8 + s_rx_tailS;
        if (s_rx_tailS == 0 && s_rx_caps) { m += (int32_t)s_rx_capR * 128; }

        d = eNew - eOld;
        if (d >  RING_HALFQ8) d -= per;
        if (d < -RING_HALFQ8) d += per;

        {
            int32_t lo = eOld - m;
            int32_t hi = eOld + m;
            int32_t capRq8 = (int32_t)s_rx_capR * 128;

            if (d > 0) { hi += d; } else { lo += d; }
            if (capRq8 < 256) { capRq8 = 256; }

            if ((s_rx_caps && (s_rx_tailS > 0)) &&
                ((s_rx_sweepS < s_rx_tailS) || ((per - s_rx_sweepS) < capRq8) ||
                 ((int32_t)oldSweep < s_rx_tailS) || ((per - (int32_t)oldSweep) < capRq8)))
            {
                int32_t capP = capRq8 + RING_ARC_PADQ8;
                int32_t s0   = s_rx_s0;
                int32_t cLo, cHi;

                while (s0 < 0)    { s0 += per; }
                while (s0 >= per) { s0 -= per; }
                cLo = s0 - capP;
                cHi = s0 + capP;

                while (cLo < lo - RING_HALFQ8) { cLo += per; cHi += per; }
                while (cLo > lo + RING_HALFQ8) { cLo -= per; cHi -= per; }
                if (cLo < lo) { lo = cLo; }
                if (cHi > hi) { hi = cHi; }
            }
            wc = lo + (hi - lo) / 2;
            wh = (hi - lo) / 2 + 1;
        }
        while (wc >= per) { wc -= per; }

        if (wh * 2 >= per / 3) { ring_draw(); return; }

        if (!ring_paint_arc_win(wc, wh))
        {
#if RING_GLINT_DEF
            s_arcDirty = 1;
#endif
            return;
        }
        s_arcSweepPainted = (uint32_t)s_rx_sweepS;
        s_paintFull       = (uint8_t)(s_rx_sweepS >= (int32_t)RING_PER_Q8);
        s_arcPainted      = 1;
        g_ringPaints++;
#if RING_GLINT_DEF

        if (ring.glint) ring_render((int16_t)ring.center, (int16_t)ring.center, 0, ring.dir, 0);
#endif
        ring.drawn = 1;
    }
#else

    (void)oldSweep;
    (void)forceFull;
    ring_draw();
#endif
}

void Ring_SetArc(uint16_t track565, uint16_t fill565)
{
    if (ring.arcTrack == track565 && ring.arcFill == fill565) return;
    ring.arcTrack = track565;
    ring.arcFill  = fill565;
    ring_arc_repaint(1);
}

/* 一次成帧 (见 bsp_ring.h): 字段全部摆好后只整圈画一次。
 * ！拆成 SetArc + SetArcSweep + SetArcTrail 会各重画一次, 而且第一笔按**旧 sweep**
 *   上**新配色** (整圈闪一帧) —— 蓄力起手 / 出老化都用这个入口, 由调用方决定整画一帧。 */
uint8_t Ring_ApplyArc(uint16_t track565, uint16_t fill565, uint32_t sweep, uint16_t trailU)
{
    uint16_t range = RING_ARC_RANGE_U;
    if (range == 0u || range > RING_ANG_UNITS) range = RING_ANG_UNITS;
    if (sweep > range) { sweep = range; }
    if (trailU > RING_ANG_UNITS) { trailU = RING_ANG_UNITS; }

    ring.arcTrack = track565;
    ring.arcFill  = fill565;
    ring.arcSweep = sweep;
    ring.arcFine  = 1;
    ring.arcTrail = trailU;

    /* ！必须先按新 sweep 重算几何再画: Ring_Redraw() 自己不动几何, 少了这一句就会拿
     *   **旧 sweep** 上**新配色** (蓄力起手表现就是"整圈一闪橙")。 */
    ring_arc_update();

    return Ring_Redraw();
}

/* 按"亮段数"驱动整弧 (示例: 档位 × 2 = lit)。
 * 与 Ring_ApplyArc 的区别: 只有 lit 变了 (颜色/起点/方向/底都没动) 时**只重画变化的
 * 那几段**, 不再推整弧 —— 换一档约 2 段 = 188px ≈ 0.13ms SPI, 整弧是它的 ~45 倍。
 * 其余情况 (进页/唤醒/换色/第一次画) 自动退化成整弧重画。 */
uint8_t Ring_ApplySeg(uint16_t track565, uint16_t fill565, uint8_t lit, uint16_t trailU)
{
    uint16_t range = RING_ARC_RANGE_U;
    uint32_t sweep;
    uint8_t  oldLit;

    if (range == 0u || range > RING_ANG_UNITS) range = RING_ANG_UNITS;
    if (lit > (uint8_t)RING_SEG_N) lit = (uint8_t)RING_SEG_N;
    ring_fill_end_set(lit);
    sweep = Ring_SegSweep(lit);
    oldLit = s_litPainted;
    g_dbgSegCalls++;

    /* 增量前提: 屏上是同一套配色/几何, 只差"亮到第几段" */
    if (s_arcPainted && !busy &&
        (track565 == ring.arcTrack) && (fill565 == ring.arcFill) &&
        (trailU == ring.arcTrail) && ring_screen_ok_no_sweep()) {
        if (lit == oldLit) {
            /* 屏上已经是这一帧: 一针都不画。
             * 页任务的 Ring_Start() 已画过满弧, 固件 dsp_draw_all() 再调一次
             * Ring_ApplySeg(同一 lit) 时不能再退化成整弧重画。 */
            return 1u;
        }
        ring.arcSweep = sweep;
        ring.arcFine  = 1;
        ring_arc_update();                       /* 先按新 sweep 摆好几何 */
        if (ring_paint_delta(oldLit, lit)) {
            ring_paint_mark();                   /* 更新指纹, s_litPainted 跟着更新 */
            g_ringPaints++;
            g_ringPartialPaints++;
            g_dbgSegDelta++;
            ring.drawn = 1;
            return 1u;
        }
    }

    g_dbgSegFull++;
    return Ring_ApplyArc(track565, fill565, sweep, trailU);
}

void Ring_SetLitNoPaint(uint8_t lit)
{
    if (lit > (uint8_t)RING_SEG_N) lit = (uint8_t)RING_SEG_N;
    ring_fill_end_set(lit);
    ring.arcValue = lit;
    ring.arcSteps = (uint8_t)RING_SEG_N;
    ring.arcFine  = 1;
    ring.arcSweep = Ring_SegSweep(lit);
    ring_arc_update();
}

void Ring_SetProgress(uint8_t value, uint8_t steps)
{
    if (steps < 1) steps = 1;
    if (value > steps) value = steps;
    if (ring.arcSteps == steps && ring.arcValue == value && !ring.arcFine) return;
    ring.arcSteps = steps;
    ring.arcValue = value;
    ring.arcFine  = 0;
    ring_arc_repaint(0);
}

void Ring_SetArcSweep(uint32_t sweep)
{
    uint16_t range = RING_ARC_RANGE_U;
    if (range == 0u || range > RING_ANG_UNITS) range = RING_ANG_UNITS;
    if (sweep > range) { sweep = range; }
    if (ring.arcFine && ring.arcSweep == sweep) return;
    ring.arcSweep = sweep;
    ring.arcFine  = 1;
    ring_arc_repaint(0);
}

void Ring_SetStartDeg(int16_t deg)
{
    uint16_t u;
    deg = (int16_t)(deg % 360);
    if (deg < 0) deg = (int16_t)(deg + 360);
    u = (uint16_t)(deg * 2);
    if (ring.arcStart == u) return;
    ring.arcStart = u;
    ring_arc_repaint(1);
}

void Ring_SetArcTrail(uint16_t trailU)
{

    if (trailU > RING_ANG_UNITS) { trailU = RING_ANG_UNITS; }
    if (ring.arcTrail == trailU) return;
    ring.arcTrail = trailU;

    ring_arc_repaint(1);
}

void Ring_SetCaps(uint8_t on)
{
    on = on ? 1 : 0;
    if (ring.arcCaps == on) return;
    ring.arcCaps = on;
    ring_arc_repaint(1);
}

void Ring_SetCapMask(uint8_t mask)
{
    mask &= 0x3u;
    if (ring.arcCapMask == mask) return;
    ring.arcCapMask = mask;
    ring_arc_repaint(1);
}

void Ring_SetArcDir(int8_t dir)
{
    dir = (dir < 0) ? -1 : 1;
    if (ring.arcDir == dir) return;
    ring.arcDir = dir;
    ring_arc_repaint(1);
}

/* 半宽 (Q14 px) → 0.1px 总宽 (回读用)。 */
static uint16_t ring_aa_x10_of(int32_t half)
{
    if (half <= 0) return 0u;
    return (uint16_t)(((uint32_t)half * 20u + 8192u) / 16384u);
}

#if RING_SHAPE == 0
/* 运行期调整段/缝边界的角向 AA 宽度, 单位 0.1px, 总宽度。
 *   0  = 关闭 (硬边)
 *   8  = 0.8px (老默认)     20 = 2.0px (新默认)     60 = 6px (上限)
 * 改完立即整弧重画 —— 方便在板子上现场 A/B 缝边缘的软硬。 */
void Ring_SetSegAA(uint16_t aaX10)
{
    uint16_t before = Ring_GetSegAA();

    ring_aa_set(aaX10);
    if (Ring_GetSegAA() != before) ring_arc_repaint(1);
}

/* 当前段/缝 AA 总宽度 (0.1px)。 */
uint16_t Ring_GetSegAA(void)
{
    return ring_aa_x10_of(s_angAAHalf);
}

/* 运行期调整弧两端平口的 AA 宽度 (一个值管起点+终点), 单位 0.1px, 总宽。
 *   0 = 端点硬边; 只在平口 (端帽关) 时生效。 */
void Ring_SetEdgeAA(uint16_t edgeX10)
{
    uint16_t before = Ring_GetEdgeAA();

    ring_edgeaa_set(edgeX10);
    if (Ring_GetEdgeAA() != before) ring_arc_repaint(1);
}

uint16_t Ring_GetEdgeAA(void)
{
    return ring_aa_x10_of(s_edgeAAHalf);
}
#else
/* 圆角矩形走 ring_rect_* 那一套, 没有圆环的角向 AA 变量; 保留接口空实现。 */
void Ring_SetSegAA(uint16_t aaX10) { (void)aaX10; }
uint16_t Ring_GetSegAA(void) { return 0u; }
void Ring_SetEdgeAA(uint16_t edgeX10) { (void)edgeX10; }
uint16_t Ring_GetEdgeAA(void) { return 0u; }
#endif

void Ring_SetBg(uint16_t color565)
{
    /* 只记字段, 不在这里整圈重绘 (2026-10-20):
     * ui_task 的页首顺序是 Ring_SetBg() → Ring_Start(); 旧实现 SetBg 先整圈画一次,
     * Ring_Start 再整圈画一次 —— 进页时圆环会画两遍, 就是"整圈闪一下"的来源。
     * 调用方随后的 Ring_Start()/Ring_ApplyArc()/Ring_Redraw() 会带上新底色。 */
    ring.bg = color565;
}

/* 沿弧渐变整体压暗 (暂停): 只记字段, 不在这里重绘 —— 调用方随后的
 * Ring_ApplyArc()/Ring_Redraw() 会带上新值 (与 SetArc 的"一次成帧"同一个口径)。 */
void Ring_SetDim(uint8_t dim)
{
    ring.dim = dim;
}

void Ring_SetColor(uint16_t color565)
{
#if RING_GLINT_DEF
    if (color565 == ring.color) return;
    ring.color = color565;
    if (ring.drawn && !busy) ring_draw();
#else
    (void)color565;
#endif
}

uint8_t Ring_IsRunning(void)
{
    return (uint8_t)(ring.active ? 1u : 0u);
}

uint8_t Ring_Redraw(void)
{
    if (ring_draw_try())
    {
#if RING_GLINT_DEF
        s_arcDirty = 0;
#endif
        return 1u;
    }
#if RING_GLINT_DEF
    s_arcDirty = 1;
#endif
    return 0u;
}

uint16_t Ring_GetCenter(void)
{
    return ring.center;
}

#if !defined(RING_SIM) && RING_GLINT_DEF

void BTIM3_HALLTIM_IRQHandler(void)
{
    CW_BTIM3->ICR = 0;
    Ring_Tick();
}
#endif
