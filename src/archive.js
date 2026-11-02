/*
 * 在线存档的命名 / 页面尺寸判定 —— 纯函数, 不碰 DOM / localStorage / Vue.
 *
 * 为什么单独拎出来:
 *  · 存档名会直接变成服务器上的 <档名>.json, 必须清洗 (斜杠/引号等会坏路径);
 *  · 「保存时会不会覆盖别人的工程」只看页面尺寸 —— 这段判断要能单独跑自检
 *    (scripts/check-archive.mjs), 不依赖浏览器;
 *  · 尺寸不同 → 自动改名, 名字又可能撞车 → 统一用 uniqueArchiveName 加 -2/-3.
 *
 * 页面尺寸 = 工程里 activePresetId 指向的屏幕预设 (w/h/round). 新工程在 exportProject()
 * 里额外写一份 meta, 读老存档时没有 meta 就回退到 presets 数组.
 */

export const ARCHIVE_EXT = '.json'

/** 存档名清洗: 去 .json / 非法路径字符 / 首尾空白与点横线, 限长 80 */
export function cleanArchiveName(raw) {
  let n = String(raw == null ? '' : raw).trim()
  n = n.replace(/\.json$/i, '')
  n = n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
  n = n.replace(/\s+/g, ' ')
  n = n.replace(/^[.\s_-]+|[.\s_-]+$/g, '')
  return n.slice(0, 80).trim()
}

/** 档名 → 服务器文件名 (空名返回 '') */
export function archiveFileName(raw) {
  const n = cleanArchiveName(raw)
  return n ? n + ARCHIVE_EXT : ''
}

/** 服务器文件名 → 档名 */
export function archiveBaseName(file) {
  return cleanArchiveName(file)
}

/** 尺寸短标签: 240x240 / 240x240-圆 (用在档名后缀) */
export function screenSizeTag(meta) {
  const w = Math.round(+(meta && meta.w) || 0)
  const h = Math.round(+(meta && meta.h) || 0)
  if (!w || !h) return ''
  return w + 'x' + h + (meta && meta.round ? '-圆' : '')
}

/** 尺寸给人看的写法: 240×240 圆屏 / 未知尺寸 */
export function screenLabel(meta) {
  const w = Math.round(+(meta && meta.w) || 0)
  const h = Math.round(+(meta && meta.h) || 0)
  if (!w || !h) return '未知尺寸'
  return w + '×' + h + (meta && meta.round ? ' 圆屏' : '')
}

/** 两个页面尺寸是否一致 (w/h/圆屏; 圆屏标记也算 — 同尺寸圆/方是两套工程) */
export function sameScreen(a, b) {
  if (!a || !b) return false
  return Math.round(+a.w || 0) === Math.round(+b.w || 0) &&
    Math.round(+a.h || 0) === Math.round(+b.h || 0) &&
    !!a.round === !!b.round
}

/** 服务器列表 → 已占用的档名集合 (接受 [{name}] 或 ['x.json']) */
export function archiveNames(files) {
  const out = new Set()
  for (const f of Array.isArray(files) ? files : []) {
    const n = cleanArchiveName(typeof f === 'string' ? f : f && f.name)
    if (n) out.add(n)
  }
  return out
}

/** 档名撞车时加 -2 / -3 … (不会覆盖已有档) */
export function uniqueArchiveName(base, files = []) {
  const b = cleanArchiveName(base) || 'lcd'
  const used = archiveNames(files)
  if (!used.has(b)) return b
  let i = 2
  while (used.has(b + '-' + i)) i++
  return b + '-' + i
}

/** 去掉档名末尾的旧尺寸后缀 (foo-128x128 → foo), 方便换成新尺寸; 不匹配就原样返回 */
export function stripScreenTag(name, meta) {
  let n = cleanArchiveName(name)
  const tags = []
  const tag = screenSizeTag(meta)
  if (tag) tags.push(tag)
  const w = Math.round(+(meta && meta.w) || 0)
  const h = Math.round(+(meta && meta.h) || 0)
  if (w && h) tags.push(w + 'x' + h)
  for (const t of tags) {
    if (n.endsWith('-' + t)) return n.slice(0, -(t.length + 1))
    if (n.endsWith('_' + t)) return n.slice(0, -(t.length + 1))
  }
  return n
}

/**
 * 从工程 JSON (字符串或已 parse 的对象) 里取页面尺寸.
 * 优先 meta (exportProject 新写的), 其次 activePresetId 指向的预设, 最后第一条预设.
 * 返回 null = 这个文件里没有可用的屏幕信息.
 */
export function projectMeta(data) {
  let d = data
  if (typeof d === 'string') {
    try { d = JSON.parse(d) } catch (e) { return null }
  }
  if (!d || typeof d !== 'object') return null

  /* 新存档: exportProject 写的 meta (最可靠 — 不受预设列表被改影响) */
  const m = (d.meta && typeof d.meta === 'object') ? d.meta : null
  if (m && +m.w > 0 && +m.h > 0) {
    return {
      w: Math.round(+m.w), h: Math.round(+m.h), round: !!m.round,
      preset: String(m.preset || m.name || ''), layers: +m.layers || 0, from: 'meta',
    }
  }
  /* 老存档: 从预设里找当前选中的那条 */
  const list = Array.isArray(d.presets) ? d.presets : []
  const p = list.find(x => x && x.id === d.activePresetId) ||
    list.find(x => x && +x.w > 0 && +x.h > 0) || null
  if (!p) return null
  return {
    w: Math.round(+p.w), h: Math.round(+p.h), round: !!p.round,
    preset: String(p.name || ''), layers: 0, from: 'presets',
  }
}

/**
 * 保存决策 (纯函数):
 *   { action:'save', name }                 名字没被占用 → 直接写
 *   { action:'confirm', name, existing }    同一尺寸 → 问一句再覆盖
 *   { action:'confirm', name, unknown:true } 名字被占用但读不到原尺寸 → 保守确认
 *   { action:'rename', name, from, existing } 尺寸不同 → 自动换名, 永不覆盖原档
 *   { action:'invalid', name:'' }            名字清洗后为空
 *
 * exists 或 files 里出现同名都算撞名; existing 必须是 projectMeta() 的形状.
 */
export function planArchiveSave({ name, current, exists, existing = null, files = [] }) {
  const n = cleanArchiveName(name)
  if (!n) return { action: 'invalid', name: '' }
  /* 两个来源都认: 调用方查到的 exists, 或服务器列表里同名 (清洗后) 的项 */
  const collided = !!exists || archiveNames(files).has(n)
  if (!collided) return { action: 'save', name: n }

  const known = !!(existing && +existing.w > 0 && +existing.h > 0)
  if (!known) return { action: 'confirm', name: n, existing: null, unknown: true }

  if (!sameScreen(current, existing)) {
    const base = stripScreenTag(n, existing) || n
    const tag = screenSizeTag(current)
    const want = tag ? base + '-' + tag : base
    return {
      action: 'rename', name: uniqueArchiveName(want, files), from: n,
      existing: { ...existing }, reason: 'size-mismatch',
    }
  }
  return { action: 'confirm', name: n, existing: { ...existing } }
}

/** 「＋ 新建」的默认档名: lcd-2026-10-20-240x240[-圆], 撞车自动 -2 */
export function suggestArchiveName(current, date = new Date(), files = []) {
  let d = date
  if (typeof d === 'string' || typeof d === 'number') d = new Date(d)
  if (!d || isNaN(d.getTime())) d = new Date()
  const p = (x) => String(x).padStart(2, '0')
  const day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  const tag = screenSizeTag(current)
  return uniqueArchiveName('lcd-' + day + (tag ? '-' + tag : ''), files)
}

/** 预设名: 尺寸优先 (新建预设时懒得想名字, 也避免一堆「新预设-7」) */
export function suggestPresetName(current, names = []) {
  const tag = screenSizeTag(current)
  const base = tag || '新预设'
  const used = new Set((Array.isArray(names) ? names : []).map(n => String(n || '').trim()).filter(Boolean))
  if (!used.has(base)) return base
  let i = 2
  while (used.has(base + '-' + i)) i++
  return base + '-' + i
}
