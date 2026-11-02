/*
 * 圆环 (RING_SHAPE=0): 几何 = 圆心 + 内外半径。圆角矩形请在上面把「形状」改成圆角矩形。
 */
/*
 * ring_config.h —— 圆环设计参数总闸 (几何 + 白斑 + 进度弧 + 帧间隔)
 *
 * 【本文件由网页 MCU-LCD-Editer 导出 (圆环部件 ring_1)】
 *   直接覆盖固件里的 code/spi/ring_config.h, 然后编译 —— 不用手抄任何一行。
 *
 * 编译链: bsp_ring.h include 本文件 → gen_tables.py 读本文件算 ring_tables.h
 *   (Keil 的 Before Build 自动跑, 参数没变就跳过) → bsp_ring.c 用编译期 #error
 *   校验表与参数一致, 对不上直接编译报错, 不会画出错色的环。
 *
 * 布局 (圆心/半径/圆角/厚度/留边) **全部在网页里算好**: 导出的已经是最终几何, 板子上
 * 不做任何布局计算, 也不存在"二次扣留边"。要改设计参数请回网页改, 再重新导出。
 *
 * 改哪个会影响什么:
 *   RING_SHAPE / RING_R_IN / RING_R_OUT / RING_SPAN_DEG / RING_SIGMA_X10 / RING_COV_AA_X10
 *        → 表要重算 (脚本自动做, 改完直接编译即可)
 *   RING_CX / RING_CY / RING_ARC_* / RING_TICK_MS / RING_GLINT_DEF
 *        → 只影响运行时, 不用重算表
 *
 * 只在网页预览、**不导出**的字段 (板子上没有对应的东西):
 *   自动动画 autoArc (进度 0→档位 扫)、光斑动画 autoGlint (白斑沿路径转)、动画弧长 glintArcPx、
 *   白斑初始相位 (固件复位时白斑固定在 0°)、立体感 (圆角矩形导出 0 = 平色)、
 *   颜色渐变 (网页沿弧长多停靠点; 导出只取 0% 点, 固件仍是单色)。
 * 拖尾长度 tailU 也只在网页由 effect/tailMs 算; 导出的 RING_ARC_TAIL_MS_DEF 是设计记录,
 *   固件倒计时仍按 app_ring_ui.c 的 RINGUI_TAIL_MS 自行算长度。
 * 已导出的配置值: 档位 gear / 白斑转向 dir / 帧间隔 glintMs / 颜色 / 当前值与档位数 /
 *   圆头 / 起始角 / 结束角 / 范围跨度 / 倒计时效果 / 拖尾时长 / 白斑开关 / 形状与几何 /
 *   分割 (开关/段数/缝宽/相位/模式)
 *   —— 网页那两个动画开关开或关, 本文件逐字节不变。
 */
#ifndef __RING_CONFIG_H__
#define __RING_CONFIG_H__

/* ===== 形状: 0 = 圆环 (R_IN/R_OUT) / 1 = 圆角矩形环 (RING_HX..RING_INVPER) ===== */
#ifndef RING_SHAPE
#define RING_SHAPE         0
#endif

/* ===== 圆心 (px): 图层中心, 与网页「与 MCU 同步预览」同一个取整规则 ===== */
#define RING_CX            119
#define RING_CY            119

/* ===== 半径 (px): 圆环用 (已扣「留边」); 圆角矩形时只用于"表容量" ===== */
#define RING_R_IN          100
#define RING_R_OUT         117

/* ===== 白斑形状 (这三个 + R_IN/R_OUT 就是生成 ring_tables.h 的全部输入) ===== */
#define RING_SIGMA_X10     140
#define RING_COV_AA_X10    20 
#define RING_SPAN_DEG      42 

/* ===== 白斑总开关 (编译期): 0 = 白斑整套不进编译, 板上只剩静态进度弧 =====
 * 实测 (armcc AC5 -O3, R_IN=95/R_OUT=120): 关掉省 ~2.2KB flash (Code 3512→1824,
 * RO 1078→531) + 1538B SRAM (ZI 1560→22, 就是 s_val 窗口缓冲 + 行段表)。
 * =1 时还能用 Ring_SetGlint(0/1) 运行期临时开关; =0 时 Ring_SetGlint/Ring_SetColor
 * 是空函数 (接口保留, ui_task.c 不用改)。
 * 包一层 #ifndef: 主机自检 tools/ring_sim (make check-glint) 用 -D 覆盖, 两种模式各编一遍。 */
#ifndef RING_GLINT_DEF
#define RING_GLINT_DEF     0
#endif

/* ===== 立体感 (断面方向光): 0 = 平色 (断面表与光照代码都不编) =====
 * 强度 0..100; 样式 0 = 凸起 / 1 = 凹陷; 光照 = 光源方位角 (屏幕坐标, -45 = 左上)
 * 表由 tools/ring_sim/gen_tables.py 按这三个值生成 (改了要重编一次; 表与配置不一致时
 * bsp_ring.c 的编译期 #error 会直接拦住)。
 * 圆环按半径预烘断面表; 圆角矩形按"离外边界的深度"预烘 —— 同一套断面光照公式。 */
#ifndef RING_DEPTH_DEF
#define RING_DEPTH_DEF        0
#endif
#ifndef RING_DEPTH_STYLE_DEF
#define RING_DEPTH_STYLE_DEF  0
#endif
#ifndef RING_LIGHT_DEG_DEF
#define RING_LIGHT_DEG_DEF    -45
#endif

/* ===== 进度弧默认值 (运行时可用 Ring_SetArc/SetProgress/SetStartDeg/SetCaps 改) =====
 * 颜色: 网页里配了渐变时这里只取 0% 停靠点 —— 固件仍是平色, 不会假装支持渐变。 */
#define RING_ARC_TRACK_DEF 0x0000
#define RING_ARC_FILL_DEF  0x07FF
#define RING_ARC_START_DEF 250 
/* ===== 弧范围 / 效果 (0.5° 单位; 720 = 整圈) ===== 
 * 网页「起始角 → 结束角」的范围弧: SPAN = 这段弧的总跨度, END = 结束角。
 * 网页预览已按范围/拖尾绘制; 当前固件圆形路径 (bsp_ring.c) 与倒计时 (app_ring_ui.c)
 * 仍按整圈量程画, 读到 SPAN<720 时应自行把量程改成 SPAN 并把 sweep 映射到范围。
 * 接入前这些宏只是设计记录, 不影响整圈行为。 */
#define RING_ARC_END_DEF   110    /* 结束角 (0.5°): 55° */
#define RING_ARC_SPAN_DEF  580    /* 范围跨度 (0.5°): 290° */
/* 预览效果: 0 = 静态进度 / 1 = 倒计时 (value 随时间递减) */
#define RING_ARC_EFFECT_DEF 0
/* 递减边缘拖尾 (ms): 与固件 app_ring_ui.c 的 RINGUI_TAIL_MS 同口径, 0 = 硬边 */
#define RING_ARC_TAIL_MS_DEF 0   
#define RING_ARC_STEPS_DEF 35  
#define RING_ARC_VALUE_DEF 35  
#define RING_ARC_CAPS_DEF  0
/* ===== 分割 (角向遮罩): 0 = 关 =====
 * 部分弧: N 段 + N-1 条内部缝, 总长 = N*body + (N-1)*gap, 所以
 *   P = (跨度 + gap)/N, body = P - gap —— 最后一段与其余段完全等长。
 * 整圈: P = 360/N, N 条缝。网页用百分比预览; **导出只写固定值**
 * (gap/body/pitch, 0.001°), 不让 MCU 再按百分比二次计算。
 * 相位相对弧起点 (0 = 弧起点正好是一段的开始)。板端在颜色/白斑/立体感之后,
 * 按 P 取模: 缝位置按 RING_SEG_DEPTH 把颜色压暗 (固定 MODE=1, 暗槽)。
 * 槽深 100% = 压到黑 = 原来的「切断」; 不再导出 MODE=0。
 * 缝边 AA 用**像素到缝边线的带符号距离**做斜坡 (不受 0.5° 角度表限制) —— 240×240 上
 * 1° 缝只有 ~2px, 0.5° 量化会直接变成硬边。斜坡跨边界对称展开 (向段内/缝内各 AA/2),
 * 边界处 0.5; RING_SEG_AA_X10 是段/缝边界的总过渡宽度 (0.1px), 0 = 硬边。
 * 弧两端平口另有 RING_AA_EDGE_X10 (一个值管两端, 0 = 硬边)。 */
#ifndef RING_SEG_ON
#define RING_SEG_ON        1
#endif
#define RING_SEG_N         70  
#define RING_SEG_LIT_DEF   70     /* 当前静态亮段数 = round(VALUE*N/STEPS); 倒计时按实时值重算 */
#define RING_SEG_ARC_REL   1   /* 1 = 部分弧: P=(跨度+gap)/N, N段只有N-1缝; 0 = 整圈: P=360/N */
#define RING_SEG_GAP_X10   17     /* 0.1° (兼容旧固件; 小缝会取整到 0) */
#define RING_SEG_GAP_X10000 16667  /* 0.0001°: 固定缝宽 (网页百分比已换算好) */
#define RING_SEG_BODY_X10000 25000  /* 0.0001°: 每段固定长度 */
#define RING_SEG_PITCH_X10000 41667  /* 0.0001°: 段起点间距 (body+gap) */
#define RING_SEG_PHASE_X10 0     /* 0.1°: 相对弧起点 */
#define RING_SEG_SPLIT_X10 5   /* 0..10: 档位分割线在槽里的位置 (0=段末 / 5=槽中 / 10=下段起点) */
#define RING_SEG_MODE      1   /* 固定 1 = 暗槽 (槽深 100% 等价于原来的切断) */
#define RING_SEG_AA_X10    20     /* 段/缝边界 AA 总宽 (0.1px): 运行期 Ring_SetSegAA() 可改, 0 = 硬边 */
#define RING_AA_EDGE_X10   20     /* 弧两端平口 AA 总宽 (0.1px, 两端同一个值): 运行期 Ring_SetEdgeAA() 可改, 0 = 硬边 */
#define RING_SEG_DEPTH     60    /* 暗槽压暗量 0..100 (%): 100 = 压到黑 (= 切断) */
/* 进度弧方向 (「弧向」): 同样包 #ifndef, 主机自检用 -DRING_ARC_DIR_DEF=±1 编两份 */
#ifndef RING_ARC_DIR_DEF
#define RING_ARC_DIR_DEF   1   /* +1 顺时针 / -1 逆时针 */
#endif

/* ===== 帧间隔 (ms): 角速度 = 初始化档位 x 0.5 度 x 1000 / RING_TICK_MS =====
 * 下限是一帧的渲染耗时(档1约8.5ms、档40约16ms), 低于它中断来不及、加速无效;
 * 100ms 偏慢(10fps 会看出跳格), 想要顺滑取 30~40ms。 */
#define RING_TICK_MS       100

/* ===== 白斑进页参数 (ui_task.c 的 LCD_Page<n>_Enter 里: Ring_Start(RING_GEAR_DEF, RING_DIR_DEF)) =====
 * 初始化档位: 每帧走 档位 × 0.5° (1..40), 每次进这一页都按它重置 —— 与进度弧的当前值无关;
 * 白斑转向: +1 = 角度增大方向 (屏幕上顺时针), -1 = 反过来; 运行时也能用 Ring_SetDir() 按电机方向改。 */
#define RING_GEAR_DEF      2  
#define RING_DIR_DEF       1

#endif /* __RING_CONFIG_H__ */
