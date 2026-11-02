/*
 * lzss_decode.h —— 通用 LZSS 解码器 (无工程常量, 无 malloc/stdio)
 *
 * 格式: control byte 管最多 8 个 token, MSB 先行;
 *   bit=0 -> literal (1 B); bit=1 -> match (2 B 小端):
 *   offset = tok >> 4 (1..4095), len = (tok & 15) + 3 (3..18)。
 * 历史就在 dst 里, 不需要额外窗口 RAM。
 */
#ifndef LZSS_DECODE_H
#define LZSS_DECODE_H

#include <stdint.h>

/* 成功返回 rawlen; 流损坏/越界/容量不足返回 0。 */
uint16_t LZSS_Decode(const uint8_t *src, uint16_t clen,
                     uint8_t *dst, uint16_t rawlen, uint16_t cap);

#endif /* LZSS_DECODE_H */
