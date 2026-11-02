#ifndef __bsp_w25q_H__
#define __bsp_w25q_H__

/*
 * 本移植包不包含 W25Q 外部 Flash 驱动。
 *
 * 但 code/spi/bsp_gc9a01.c 顶部有一行无条件的：
 *     #include "bsp_w25q.h"
 * 为了让包在不带 bsp_w25q.c/.h 的情况下也能编译，这里放一个空头文件。
 *
 * 请保持 bsp_spiHost.h 里的 USE_W25Q 是注释状态（当前渲染流程全部走内部
 * Flash 的 LZSS 素材）。如果目标板要回退外部 Flash，把真正的 bsp_w25q.h /
 * bsp_w25q.c 加回来，并恢复 USE_W25Q。
 */

#endif /* __bsp_w25q_H__ */
