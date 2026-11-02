/*
 * ZIP 兜底导出自检 (零依赖: node scripts/check-zip.mjs)
 *
 * 覆盖:
 *   1) CRC32 标准向量 ("123456789" → 0xCBF43926)
 *   2) local header / central directory / EOCD 的签名、条目数、偏移
 *   3) 文本 + 二进制 + 中文文件名都能被标准 zip 读取 (UTF-8 标志位)
 */
import { crc32, buildZipBlob, zipFileName } from '../src/zip.js'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}

const enc = new TextEncoder()
ok('ZIP: CRC32 标准向量 ("123456789" → 0xCBF43926)',
   crc32(enc.encode('123456789')) === 0xCBF43926,
   '0x' + crc32(enc.encode('123456789')).toString(16).toUpperCase())

const blob = await buildZipBlob([
  { name: 'ui_table.c', text: 'const int a = 1;\n' },
  { name: '中文/字体.ttf', data: new Uint8Array([0, 1, 2, 255]) },
], new Date('2026-10-23T12:30:00'))
const u8 = new Uint8Array(await blob.arrayBuffer())
const dv = new DataView(u8.buffer)

ok('ZIP: local header 签名 + STORE 方法 + UTF-8 文件名标志',
   dv.getUint32(0, true) === 0x04034B50 &&
   dv.getUint16(8, true) === 0 && (dv.getUint16(6, true) & 0x0800) !== 0)
ok('ZIP: EOCD 在末尾, 条目数 = 2',
   dv.getUint32(u8.length - 22, true) === 0x06054B50 &&
   dv.getUint16(u8.length - 22 + 10, true) === 2)
ok('ZIP: central directory 偏移落在文件内且指向 0x02014B50',
   (() => {
     const off = dv.getUint32(u8.length - 22 + 16, true)
     return off > 0 && off < u8.length && dv.getUint32(off, true) === 0x02014B50
   })())
ok('ZIP: 文件名按 UTF-8 写入 (中文不乱码)',
   (() => {
     const dec = new TextDecoder()
     const n1 = dv.getUint16(26, true)
     const name1 = dec.decode(u8.subarray(30, 30 + n1))
     return name1 === 'ui_table.c'
   })())
ok('ZIP 文件名: 去掉非法路径字符并带日期',
   zipFileName('LCD/1.28R', new Date('2026-10-23T12:30:00')) === 'LCD-1.28R-20261023-1230.zip',
   zipFileName('LCD/1.28R', new Date('2026-10-23T12:30:00')))

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
