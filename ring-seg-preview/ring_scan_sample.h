/*
 * ring_scan.h —— 圆环逐像素扫描表 (由网页 MCU-LCD-Editer 自动生成, 请勿手改)
 *
 * 沿圆环**递增方向**逐坐标 + RGB565 颜色; 颜色已按 LCD_drawPx 的字节序做高低交换
 * (与 DR2120B 的 picArc 一致: 0x07E0 绿 → 0xE007)。
 *
 * frameIndices[L] = 第 L 档结束处最后一个像素下标 (含):
 *   frameIndices[0] = 0, frameIndices[LEVELS] = COUNT-1;
 *   点亮第 L 档 = 从 0 画到 frameIndices[L] (含); 跨过该下标即一档。
 *
 * 扫描参数: 形状 圆环; 中心 (119,119); 起始 130.00°; 跨度 280.00°; 方向 顺时针
 *           线宽 2px; 步长 0.5px; 档位 70; 颜色已交换字节
 */
#ifndef RING_SCAN_H
#define RING_SCAN_H

#define RING_SCAN_COUNT   1112
#define RING_SCAN_LEVELS  70
#define RING_SCAN_CX      119
#define RING_SCAN_CY      119
#define RING_SCAN_START_DEG 130.00
#define RING_SCAN_SPAN_DEG  280.00
#define RING_SCAN_DIR     1
#define RING_SCAN_SHAPE   0
#define RING_SCAN_WIDTH   2
#define RING_SCAN_STEP_PX 0.5
#define RING_SCAN_SWAP    1
#define RING_SCAN_COORD16 0

/* 与 DR2120B pic.h 的 ArcPX_PIC 同布局 (x,y,color); 屏幕 >255 时坐标自动用 16 位 */
#if RING_SCAN_COORD16
typedef struct { unsigned short x, y; unsigned short color; } RingScanPx;
#else
typedef struct { unsigned char  x, y; unsigned short color; } RingScanPx;
#endif

extern const RingScanPx ringScanPx[RING_SCAN_COUNT];
extern const unsigned short ringScanFrame[RING_SCAN_LEVELS + 1];

#endif /* RING_SCAN_H */
