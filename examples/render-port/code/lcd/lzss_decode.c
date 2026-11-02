/*
 * lzss_decode.c —— 通用 LZSS 解码器 (与 Web 的 src/lzss.js 同一格式)
 *
 * 约束: 只用 <stdint.h>; 无 malloc/stdio; 所有多字节都按字节取
 *       (M0+ 上非对齐 16 位读会 HardFault)。
 */
#include "lzss_decode.h"

uint16_t LZSS_Decode(const uint8_t *src, uint16_t clen,
                     uint8_t *dst, uint16_t rawlen, uint16_t cap)
{
    uint16_t ip = 0u;
    uint16_t op = 0u;
    uint8_t ctrl = 0u;
    uint8_t bits = 0u;

    if ((src == 0) || (dst == 0) || (rawlen == 0u) || (rawlen > cap)) {
        return 0u;
    }

    while (op < rawlen) {
        uint8_t bit;

        if (bits == 0u) {
            if (ip >= clen) {
                return 0u;
            }
            ctrl = src[ip];
            ip++;
            bits = 8u;
        }
        bit = (uint8_t)((ctrl >> 7) & 0x01u);
        ctrl = (uint8_t)(ctrl << 1);
        bits--;

        if (bit == 0u) {
            if (ip >= clen) {
                return 0u;
            }
            dst[op] = src[ip];
            ip++;
            op++;
        } else {
            uint16_t tok;
            uint16_t off;
            uint16_t len;
            uint16_t from;
            uint16_t i;

            if ((uint16_t)(clen - ip) < 2u) {
                return 0u;
            }
            tok = (uint16_t)((uint16_t)src[ip] | ((uint16_t)src[ip + 1u] << 8));
            ip = (uint16_t)(ip + 2u);
            off = (uint16_t)(tok >> 4);
            len = (uint16_t)((tok & 0x0Fu) + 3u);

            if ((off == 0u) || (off > op)) {
                return 0u;
            }
            if (((uint32_t)op + (uint32_t)len) > (uint32_t)rawlen) {
                return 0u;
            }

            from = (uint16_t)(op - off);
            for (i = 0u; i < len; i++) {
                dst[op + i] = dst[from + i];
            }
            op = (uint16_t)(op + len);
        }
    }

    return rawlen;
}
