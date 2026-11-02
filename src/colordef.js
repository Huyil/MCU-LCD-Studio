/*
 * 颜色名 → C 宏 (ui_color.h) —— 纯函数, 不碰 DOM.
 *
 * 为什么单独一个文件: 导出物里到处是 RGB565 颜色 (.color/.bg/UI_PAGE_BG/
 * UI_DrawFrame 的第二个参数)。以前直接写 0xFFFF, 看代码时不知道是什么颜色,
 * 改色也要回去查表。现在统一引用 ui_color.h 里的 UI_COLOR_<名字>。
 *
 * 名字来自 colors.data.js (固件 bsp_gc9a01.h / bsp_st7735s.h 的 Color_t):
 *   · 表里有的颜色 → UI_COLOR_WHITE / UI_COLOR_RED / UI_COLOR_BLUE_SKY ...
 *   · 表里没有的自定义色 → UI_COLOR_RGB565_1234 (值本身进名字, 不会指错色)
 *
 * 导出的 ui_color.h **只列本工程实际用到/模板里引用的颜色** (通常几条到十几条),
 * 不再是全 244 色表 —— 完整 Color_t 表仍在固件 bsp_*.h / 项目 colors.data.js 里。
 */
import raw from './colors.data.js'

export const COLOR_MACRO_PREFIX = 'UI_COLOR_'

function hex565(v) {
  return '0x' + ((v == null ? 0 : v) & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')
}

/** RGB565 → 宏名 (精确名字优先, 没有就 UI_COLOR_RGB565_XXXX) */
export function colorMacroName(v) {
  const n = (v == null ? 0xFFFF : v) & 0xFFFF
  const hit = raw.find(c => c.v === n)
  if (hit) return COLOR_MACRO_PREFIX + String(hit.n)
  return COLOR_MACRO_PREFIX + 'RGB565_' + n.toString(16).toUpperCase().padStart(4, '0')
}

/** 导出计划/屏幕里实际用到的颜色值 (去重). 还会扫描模板/头尾里手写的 UI_COLOR_XXX,
 *  这样自定义模板引用某个颜色名时不会被裁掉. */
export function collectUsedColors(plan, screen, extra = []) {
  const out = new Set()
  const add = (v) => {
    if (v == null) return
    const n = +v
    if (Number.isFinite(n)) out.add(n & 0xFFFF)
  }
  const scanMacros = (text) => {
    for (const m of String(text || '').matchAll(/UI_COLOR_([A-Z0-9_]+)/g)) {
      const key = m[1]
      if (key.startsWith('RGB565_')) {
        const v = parseInt(key.slice(7), 16)
        if (Number.isFinite(v)) add(v)
        continue
      }
      const c = raw.find(x => x.n === key)
      if (c) add(c.v)
    }
  }
  const addScreen = (sc) => {
    if (!sc) return
    add(sc.bg)
    scanMacros(sc.header)
    scanMacros(sc.footer)
    if (sc.templates && typeof sc.templates === 'object') {
      for (const t of Object.values(sc.templates)) scanMacros(t)
    }
  }
  addScreen(screen)
  addScreen(plan && plan.screen)
  for (const it of (plan && plan.items) || []) {
    add(it.color)
    add(it.bind && it.bind.bg)
  }
  for (const v of extra || []) add(v)
  return [...out]
}

/**
 * 生成 ui_color.h —— **只列本工程实际用到的颜色** (不是全 244 色表).
 * 完整 Color_t 名字表仍在固件 bsp_*.h / 项目 colors.data.js 里.
 * 默认黑/白始终保留: 生成代码的 UI_PAGE_BG / 绘制默认值要用.
 * @param {number[]} usedValues 本工程用到的颜色
 */
export function buildColorHeader(usedValues = []) {
  /* 兜底: 生成代码里常见默认值 (屏幕底色 0 / 绘制默认 0xFFFF) */
  const values = new Set([0x0000, 0xFFFF])
  for (const v of usedValues || []) {
    const n = +v
    if (Number.isFinite(n)) values.add(n & 0xFFFF)
  }
  /* Color_t 里值 → 名字 (同值多名取表里第一个) */
  const named = new Map()
  for (const c of raw) {
    const v = c.v & 0xFFFF
    if (!named.has(v)) named.set(v, c.n)
  }
  const defs = []
  const seenName = new Set()
  for (const [v, n] of named) {
    if (!values.has(v)) continue
    const name = COLOR_MACRO_PREFIX + String(n).replace(/[^\w]/g, '_')
    if (seenName.has(name)) continue
    seenName.add(name)
    defs.push([name, v])
  }
  /* 表里没有精确名字的自定义色 */
  const custom = [...values].filter(v => !named.has(v)).sort((a, b) => a - b)
  for (const v of custom) {
    const name = COLOR_MACRO_PREFIX + 'RGB565_' + v.toString(16).toUpperCase().padStart(4, '0')
    if (seenName.has(name)) continue
    seenName.add(name)
    defs.push([name, v])
  }
  const pad = Math.max(...defs.map(([n]) => n.length), 24) + 1
  const L = []
  L.push('/*')
  L.push(' * ui_color.h —— 本工程用到的颜色名 → RGB565 宏 (由 MCU-LCD-Editer 生成, 每次导出重写)')
  L.push(' *')
  L.push(' * 只列当前工程实际用到/模板里引用的颜色; 完整 244 色 Color_t 表在固件')
  L.push(' * bsp_gc9a01.h / bsp_st7735s.h (以及项目 colors.data.js) 里, 不重复导出。')
  L.push(' * 表里没有精确名字的自定义色追加为 UI_COLOR_RGB565_XXXX。')
  L.push(' *')
  L.push(` * 本文件定义 ${defs.length} 个颜色宏。`)
  L.push(' */')
  L.push('#ifndef UI_COLOR_H')
  L.push('#define UI_COLOR_H')
  L.push('')
  for (const [name, value] of defs) L.push(`#define ${name.padEnd(pad)} ${hex565(value)}`)
  L.push('')
  L.push('#endif /* UI_COLOR_H */')
  L.push('')
  return L.join('\n')
}
