/*
 * lzss.js —— 通用 LZSS 编解码 (与 MCU 侧 lzss_decode.c 同一格式)
 *
 * 流格式 (与旧 asset_lzss.c 完全一致, 只是去掉了所有工程常量):
 *   control byte 管最多 8 个 token, MSB 先行;
 *   bit=0 -> literal: 后跟 1 字节原样输出;
 *   bit=1 -> match  : 后跟 2 字节小端 tok,
 *                     offset = tok >> 4      (1..4095)
 *                     len    = (tok & 15) + 3 (3..18)
 *                     从已解出的 dst[pos - offset] 起逐字节复制 len 字节。
 *
 * 编码器是贪心的 (3 字节前缀索引候选、从最近往前找最长匹配、窗口 4095、
 * maxlen 18、literal 兜底)。解码端只认格式, 流不唯一。
 */

const WINDOW = 4095
const MAXLEN = 18
const MINLEN = 3

/** 参考解码器: 成功返回 rawlen 字节的 Uint8Array; 流损坏/越界返回 null。 */
export function lzssDecompress(src, rawlen) {
  const dst = new Uint8Array(rawlen)
  let pos = 0, ip = 0, ctrl = 0, bits = 0
  while (pos < rawlen) {
    if (bits === 0) {
      if (ip >= src.length) return null
      ctrl = src[ip++]; bits = 8
    }
    const bit = (ctrl >> 7) & 1
    ctrl = (ctrl << 1) & 0xFF; bits--
    if (bit === 0) {
      if (ip >= src.length) return null
      dst[pos++] = src[ip++]
    } else {
      if (ip + 1 >= src.length) return null
      const tok = src[ip] | (src[ip + 1] << 8); ip += 2
      const off = tok >> 4, len = (tok & 0x0F) + 3
      if (off === 0 || off > pos || pos + len > rawlen) return null
      for (let k = 0; k < len; k++) { dst[pos] = dst[pos - off]; pos++ }
    }
  }
  return dst
}

/** 贪心编码器 (任意字节流; 块内独立)。 */
export function lzssCompress(data) {
  const n = data.length
  const out = []
  let pos = 0
  const key3 = (p) => (data[p] << 16) | (data[p + 1] << 8) | data[p + 2]
  const heads = new Map()          // 3B 前缀 -> [位置...] (升序)

  while (pos < n) {
    const group = []
    let control = 0
    let tokens = 0

    while (tokens < 8 && pos < n) {
      let bestLen = 0, bestOff = 0
      const maxLen = Math.min(MAXLEN, n - pos)

      if (maxLen >= MINLEN && pos + 3 <= n) {
        const candidates = heads.get(key3(pos))
        if (candidates) {
          /* 从最近的位置往前找; offset = pos - q */
          for (let ci = candidates.length - 1; ci >= 0; ci--) {
            const q = candidates[ci]
            const off = pos - q
            if (off > WINDOW) break
            let length = MINLEN
            while (length < maxLen && data[q + length] === data[pos + length]) length++
            if (length > bestLen) {
              bestLen = length; bestOff = off
              if (length === maxLen) break
            }
          }
        }
      }

      let consumed
      if (bestLen >= MINLEN) {
        const tok = (bestOff << 4) | (bestLen - MINLEN)
        group.push(tok & 0xFF, (tok >> 8) & 0xFF)
        control |= 1 << (7 - tokens)
        consumed = bestLen
      } else {
        group.push(data[pos])
        consumed = 1
      }

      const far = pos + consumed
      for (let p = pos; p < far; p++) {
        if (p + 3 <= n) {
          const k = key3(p)
          const list = heads.get(k)
          if (list) list.push(p); else heads.set(k, [p])
        }
      }
      pos = far
      tokens++
    }

    out.push(control)
    out.push(...group)
  }
  return Uint8Array.from(out)
}

/** 简单非加密哈希: 素材去重 (相同帧 → 同一个 blob 偏移)。 */
export function hashBytes(bytes) {
  let h = 0x811C9DC5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** RGB565 (Uint16Array) → MCU 内存字节序 (小端: 低字节在前)。 */
export function rgb565Bytes(rgb) {
  const out = new Uint8Array(rgb.length * 2)
  for (let i = 0; i < rgb.length; i++) {
    out[i * 2] = rgb[i] & 0xFF
    out[i * 2 + 1] = (rgb[i] >> 8) & 0xFF
  }
  return out
}
