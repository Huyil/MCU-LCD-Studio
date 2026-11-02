/*
 * 极简 ZIP 打包 (只读/写 STORE 方式, 不压缩) —— 一键导出的文件夹权限失败时用。
 *
 * 为什么不用第三方库: 导出物是文本 .c/.h/.json + 少量字体二进制, 用 ZIP 的
 * "stored" 方式就够 (浏览器再解压), 自己写 100 行比引一个包/多 100KB 依赖划算。
 *
 * 格式: 每个文件 = local header + 原始字节; 最后 = central directory + EOCD。
 * 文件名用 UTF-8 (通用标志位 bit 11), 中文文件名/字体名不会乱码。
 * 注意: 不支持 ZIP64 / 加密 / 压缩; 导出物远小于 4GB, 够用。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

/** 标准 CRC32 (ZIP 用) */
export function crc32(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let c = 0xFFFFFFFF
  for (let i = 0; i < u.length; i++) c = CRC_TABLE[(c ^ u[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function dosDateTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F)
  const day = (((Math.max(1980, d.getFullYear()) - 1980) & 0x7F) << 9) |
    (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F)
  return { time, date: day }
}

function writeU16(dv, off, v) { dv.setUint16(off, v & 0xFFFF, true) }
function writeU32(dv, off, v) { dv.setUint32(off, v >>> 0, true) }

async function bytesOf(entry) {
  if (entry && entry.data != null) {
    if (entry.data instanceof Uint8Array) return entry.data
    if (entry.data instanceof ArrayBuffer) return new Uint8Array(entry.data)
    if (typeof Blob !== 'undefined' && entry.data instanceof Blob) return new Uint8Array(await entry.data.arrayBuffer())
    return new Uint8Array(entry.data)
  }
  return new TextEncoder().encode(String(entry && entry.text != null ? entry.text : ''))
}

function zipNameOf(entry) {
  const raw = String(entry && entry.name != null ? entry.name : '').replace(/\\/g, '/').replace(/^\/+/, '')
  return raw || 'file'
}

/**
 * @param {{name:string, text?:string, data?:Uint8Array|ArrayBuffer|Blob}[]} files
 * @returns {Promise<Blob>}
 */
export async function buildZipBlob(files, date = new Date()) {
  const list = Array.isArray(files) ? files : []
  const { time, date: dosDate } = dosDateTime(date)
  const enc = new TextEncoder()
  const locals = []
  const centrals = []
  let offset = 0
  for (const f of list) {
    const name = enc.encode(zipNameOf(f))
    const data = await bytesOf(f)
    const crc = crc32(data)
    const lh = new Uint8Array(30 + name.length)
    const lv = new DataView(lh.buffer)
    writeU32(lv, 0, 0x04034B50)
    writeU16(lv, 4, 20)              // version needed
    writeU16(lv, 6, 0x0800)          // UTF-8 filename
    writeU16(lv, 8, 0)               // stored
    writeU16(lv, 10, time)
    writeU16(lv, 12, dosDate)
    writeU32(lv, 14, crc)
    writeU32(lv, 18, data.length)
    writeU32(lv, 22, data.length)
    writeU16(lv, 26, name.length)
    writeU16(lv, 28, 0)
    lh.set(name, 30)
    locals.push(lh, data)

    const ch = new Uint8Array(46 + name.length)
    const cv = new DataView(ch.buffer)
    writeU32(cv, 0, 0x02014B50)
    writeU16(cv, 4, 20)              // version made by
    writeU16(cv, 6, 20)              // version needed
    writeU16(cv, 8, 0x0800)
    writeU16(cv, 10, 0)
    writeU16(cv, 12, time)
    writeU16(cv, 14, dosDate)
    writeU32(cv, 16, crc)
    writeU32(cv, 20, data.length)
    writeU32(cv, 24, data.length)
    writeU16(cv, 28, name.length)
    writeU16(cv, 30, 0)              // extra
    writeU16(cv, 32, 0)              // comment
    writeU16(cv, 34, 0)              // disk start
    writeU16(cv, 36, 0)              // internal attrs
    writeU32(cv, 38, 0)              // external attrs
    writeU32(cv, 42, offset)         // local header offset
    ch.set(name, 46)
    centrals.push(ch)
    offset += lh.length + data.length
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  writeU32(ev, 0, 0x06054B50)
  writeU16(ev, 4, 0)
  writeU16(ev, 6, 0)
  writeU16(ev, 8, list.length)
  writeU16(ev, 10, list.length)
  writeU32(ev, 12, centralSize)
  writeU32(ev, 16, offset)
  writeU16(ev, 20, 0)
  return new Blob([...locals, ...centrals, eocd], { type: 'application/zip' })
}

/** 下载文件名: lcd-<存档名>-20261023-1230.zip (非法路径字符清掉) */
export function zipFileName(prefix = 'lcd-export', date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const p = (n) => String(n).padStart(2, '0')
  const base = String(prefix || 'lcd-export').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, '-').slice(0, 48) || 'lcd-export'
  return `${base}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`
}
