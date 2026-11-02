#ifndef __BSP_RING_H__
#define __BSP_RING_H__

#include <stdint.h>

#include "../lcd/ring_config.h"

#ifndef RING_SHAPE
#define RING_SHAPE      0
#endif

#define RING_RECT_AA_PX   ((((RING_COV_AA_X10) + 5) / 10) < 1 ? 1 : (((RING_COV_AA_X10) + 5) / 10))
#define RING_RECT_AA_Q8   (RING_RECT_AA_PX * 256)
#define RING_RECT_INV_AA  (65536 / RING_RECT_AA_Q8)

#ifndef RING_GLINT_DEF
#define RING_GLINT_DEF  1
#endif

#ifndef RING_ARC_DIR_DEF
#define RING_ARC_DIR_DEF  1
#endif

#ifndef RING_DEPTH_DEF
#define RING_DEPTH_DEF        0
#endif
#ifndef RING_DEPTH_STYLE_DEF
#define RING_DEPTH_STYLE_DEF  0
#endif
#ifndef RING_LIGHT_DEG_DEF
#define RING_LIGHT_DEG_DEF    (-45)
#endif

#define RING_SPAN_U     (RING_SPAN_DEG * 2)
#define RING_ANG_UNITS  720

/* 进度弧的实际量程 (0.5° 单位): 导出 RING_ARC_SPAN_DEF=560 即 280°。
 * 老配置没有这个宏时退回整圈 720, 保持原有行为。 */
#ifndef RING_ARC_SPAN_DEF
#define RING_ARC_SPAN_DEF  RING_ANG_UNITS
#endif
#define RING_ARC_RANGE_U   ((uint16_t)(RING_ARC_SPAN_DEF))

/* 沿弧渐变: 1 = 用 ring_grad.h 的 70 色表 (默认青 0x07FF → 蓝 0x001F),
 * 0 = 退回导出配置的平色 ring.arcFill。表由 tools/ring_sim/gen_ring_grad.py 生成。 */
#ifndef RING_ARC_GRAD
#define RING_ARC_GRAD  1
#endif

/* 分割 (角向遮罩): 网页 22:31 版导出 RING_SEG_*; 旧导出没有这些宏时用下面这组
 * 临时默认值 (与网页默认一致: 90 段整圈 / 缝 1° / 暗槽 60%), 先让板子看到分段效果。
 * 网页重新导出后, ring_config.h 里的宏会覆盖这里。
 * RING_SEG_N 是**整圈**段数 (P = 360/N): 280° 弧要 70 段 (4°/段) 时应设 90;
 * RING_ARC_STEPS_DEF(70) 是进度格数, 两者独立。 */
#ifndef RING_SEG_ON
#define RING_SEG_ON       1
#endif
#ifndef RING_SEG_N
#define RING_SEG_N        90
#endif
#ifndef RING_SEG_GAP_X10
#define RING_SEG_GAP_X10  10      /* 0.1° */
#endif
#ifndef RING_SEG_PHASE_X10
#define RING_SEG_PHASE_X10 0      /* 0.1°, 相对弧起点 */
#endif
#ifndef RING_SEG_MODE
#define RING_SEG_MODE     1       /* 0 = 切断 / 1 = 暗槽 */
#endif
#ifndef RING_SEG_AA_X10
#define RING_SEG_AA_X10   8       /* 0.1px: 段/缝边界 AA 总宽 */
#endif
#ifndef RING_SEG_SPLIT_X10
#define RING_SEG_SPLIT_X10 5      /* 0..10: 档位分割线在槽里的位置 (0=段末 / 5=槽中 / 10=下段起点) */
#endif
#if (RING_SEG_SPLIT_X10) < 0 || (RING_SEG_SPLIT_X10) > 10
#error "RING_SEG_SPLIT_X10 out of range 0..10 (web export)"
#endif
/* 弧两端平口的角向 AA (0.1px, 总宽): **一个值管两端** (起点/终点不再分开)。
 * 兼容上一版拆开的 RING_AA_START_X10 / RING_AA_END_X10; 都没有时跟随 RING_SEG_AA_X10。 */
#ifndef RING_AA_EDGE_X10
#  if defined(RING_AA_START_X10) && defined(RING_AA_END_X10)
#    define RING_AA_EDGE_X10 ((RING_AA_START_X10 + RING_AA_END_X10) / 2)
#  elif defined(RING_AA_START_X10)
#    define RING_AA_EDGE_X10 RING_AA_START_X10
#  else
#    define RING_AA_EDGE_X10 RING_SEG_AA_X10
#  endif
#endif
#ifndef RING_SEG_DEPTH
#define RING_SEG_DEPTH    60      /* 暗槽压暗量 0..100 */
#endif

#if RING_SHAPE == 1
#define RING_SWEEP_FULL   ((uint32_t)RING_PER_Q8)
#else
#define RING_SWEEP_FULL   ((uint32_t)RING_ANG_UNITS)
#endif

#if RING_DEPTH_DEF > 0
#define RING_HAS_SHADE   1
#else
#define RING_HAS_SHADE   0
#endif

#ifndef RING_DITHER
#define RING_DITHER     0
#endif

#define RING_GEAR_MAX   40

#ifndef RING_TRIG_HW
#define RING_TRIG_HW    0
#endif
#if RING_TRIG_HW
#error "RING_TRIG_HW=1 还没实现 (参考工程的 CORDIC 分支未移植); 表实现是当前的正确路径"
#endif

typedef struct {
    uint16_t center;
    uint16_t bg;
    uint16_t color;
    uint16_t tickMs;
    uint8_t  step;
    int8_t   dir;
    uint8_t  active;
    uint8_t  drawn;
#if RING_GLINT_DEF
    uint8_t  glint;
#endif

    uint16_t arcTrack;
    uint16_t arcFill;
    uint16_t arcStart;
    uint8_t  arcSteps;
    uint8_t  arcValue;
    uint8_t  arcCaps;           /* 端帽总闸 (来自导出配置 RING_ARC_CAPS_DEF) */
    uint8_t  arcCapMask;        /* 端帽选择掩码: bit0 = 起点帽, bit1 = 末端帽 (默认 3) */
    int8_t   arcDir;

    uint16_t arcTrail;

    uint32_t arcSweep;
    uint8_t  arcFine;

    uint8_t  dim;               /* 0..255: 沿弧渐变整体压暗 (暂停态). 0 = 原色 */
} RingState;

extern RingState ring;

void Ring_Init(void);

void Ring_Start(uint8_t gear, int8_t dir);

void Ring_Stop(void);

void Ring_Clear(void);

void Ring_SetGear(uint8_t gear);
void Ring_SetSpeed(uint8_t step_half_deg);
void Ring_SetInterval(uint16_t ms);
void Ring_SetDir(int8_t dir);

void Ring_SetGlint(uint8_t on);

void Ring_Tick(void);

uint8_t Ring_Redraw(void);

/* 引擎当前是否在跑 (页任务/固件恢复时据此决定要不要重新 Ring_Start;
 * 已在跑就不要再来一次整弧, 否则每次进页都多画一整圈 = 用户看到的"全屏刷新") */
uint8_t Ring_IsRunning(void);

/* 只摆好"亮到第几段"的几何, 不推屏: 页任务 Ring_Start() 之前调用,
 * 让第一次 Start 就画出正确进度, 避免 Start(默认满弧) 后再 ApplySeg 全量补一遍。 */
void Ring_SetLitNoPaint(uint8_t lit);

/* 屏被别的层整屏擦了 (页切换的清屏) → 引擎作废"已画"标记, 下一次 Redraw()/Start() 整圈补回 */
void Ring_ScreenInvalidate(void);

extern volatile uint16_t g_ringPaints;
extern volatile uint16_t g_ringFullPaints;
extern volatile uint16_t g_ringPartialPaints;   /* 其中增量 (只画变化扇区) 的次数 */

uint16_t Ring_GetCenter(void);

uint8_t Ring_GetHwTrig(void);

void Ring_SetBg(uint16_t color565);

void Ring_SetColor(uint16_t color565);

void Ring_SetArc(uint16_t track565, uint16_t fill565);
void Ring_SetProgress(uint8_t value, uint8_t steps);

/* 一次成帧: 同时摆好 track/fill/sweep/trail 再整圈画一次。
 * 返回值 1 = 这一帧已上屏; 0 = 屏忙没画成 (字段已生效, 调用方下一拍重调, 语义同 Ring_Redraw)。
 * ！"整画一帧"由**调用方**显式开关 —— 不像 SetArc/SetArcSweep 那样各自隐式重画
 *   (拆开调会先按旧 sweep 上配色, 整圈闪一帧)。 */
uint8_t Ring_ApplyArc(uint16_t track565, uint16_t fill565, uint32_t sweep, uint16_t trailU);

/* 整段口径的扫弧终点: lit = 已亮段数 (0..RING_SEG_N)。
 * sweep = lit×P − gap, 与缝遮罩同一个 Q8 网格, 所以填充边界永远正好落在段尾上
 * (不会出现"进度网格 vs 分段网格"两套边界)。返回值单位 = Ring_ApplyArc 的 sweep (0.5°)。
 * 无分割 (RING_SEG_ON=0) 时退回 lit×量程/RING_SEG_N。 */
uint16_t Ring_SegSweep(uint8_t lit);

/* 按"亮段数"驱动 (档位 × 2 = lit)。只变 lit 时只重画变化的那几段 (增量),
 * 颜色/起点/方向/底有任何变化则自动退化成整弧重画。返回值同 Ring_ApplyArc。 */
uint8_t Ring_ApplySeg(uint16_t track565, uint16_t fill565, uint8_t lit, uint16_t trailU);

/* 沿弧渐变整体压暗 (暂停/低电): 0 = 原色, 255 = 全黑。只改字段, 不重绘;
 * 下一帧 Ring_ApplyArc()/Ring_Redraw() 生效。 */
void Ring_SetDim(uint8_t dim);

void Ring_SetArcSweep(uint32_t sweep);
void Ring_SetStartDeg(int16_t deg);
void Ring_SetCaps(uint8_t on);
/* 端帽选择 (在 Ring_SetCaps 总闸之内): bit0 = 起点帽, bit1 = 末端帽; 默认 0x3 = 都画。
 * 用途: 开机动画要"扫过去"的速度感 ⇒ 只留起点帽 (0x1), 末端不画 (弧长不鼓包、增量窗口也小)。
 * ！有拖尾时引擎本来就不画末端帽 (靠渐隐收边), 掩码里的 bit1 会被忽略 —— 与旧行为一致。 */
void Ring_SetCapMask(uint8_t mask);
void Ring_SetArcTrail(uint16_t trailU);
void Ring_SetArcDir(int8_t dir);

/* 段/缝边界的角向 AA 宽度, 运行期可调:
 *   单位 0.1px, **总过渡宽度**; 0 = 关闭 (硬边), 8 = 0.8px, 20 = 2.0px (默认/上限 60)。
 * 初始值来自 ring_config.h 的 RING_SEG_AA_X10; 改完立即整弧重画。 */
void Ring_SetSegAA(uint16_t aaX10);
uint16_t Ring_GetSegAA(void);

/* 弧两端平口的角向 AA 宽度 (一个值管起点+终点; 只在平口时生效):
 *   单位 0.1px, **总宽**; 0 = 端点硬边。初始值 = RING_AA_EDGE_X10
 *   (缺省跟随 RING_SEG_AA_X10)。改完立即整弧重画。 */
void Ring_SetEdgeAA(uint16_t edgeX10);
uint16_t Ring_GetEdgeAA(void);

#ifdef RING_SIM
/* 主机自检 (tools/ring_sim) 专用: 当前弧几何 (Q8) —— 钉"拖尾不压起点帽盘" */
void Ring_DbgArc(int32_t *sweepS, int32_t *tailDesignS, int32_t *tailEffS, int32_t *capQ8);
/* 主机自检: 角向分段遮罩 (Q8 度, 相对弧起点), 返回 0..255 (缝=0, 段内=255) */
uint8_t Ring_DbgSegQ8(uint32_t relQ8);
#endif

#if !defined(RING_SIM) && RING_GLINT_DEF

void BTIM3_HALLTIM_IRQHandler(void);
#endif

#endif
