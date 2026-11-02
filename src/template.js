/*
 * 指令模板引擎: {key} 通配符替换。
 * 可用通配符:
 *   {x} {y} {w} {h}      实例几何 (整数像素, 随模拟屏位置实时变化)
 *   {name}               实例名 (合法 C 标识符)
 *   {pic}                数组标识符 gImage_{name}
 *   {color}              调制色宏 (UI_COLOR_WHITE 等, 定义在导出的 ui_color.h)
 *   {colorHex}           调制色原值, 0xXXXX (RGB565)
 *   {colorName}          最近 Color_t 枚举名 (bsp_*.h)
 *   {mirror}             0/1 镜像标志
 *   {i}                  序号 (从 0 开始)
 *   {len}                数组元素数 (w*h)
 *   {lenBytes}           数组字节数
 *   {sw} {sh}            屏幕宽高
 *   {fmt}                RGB565 / RGB888 / GRAY
 */
import { nearestColorName } from './colors.js'
import { colorMacroName } from './colordef.js'

export function sanitizeName(raw) {
  let s = String(raw || '').trim()
  s = s.replace(/\.[^.]+$/, '')            // 去扩展名
  s = s.replace(/[^A-Za-z0-9_]/g, '_')
  if (!s) s = 'img'
  if (/^[0-9]/.test(s)) s = 'img_' + s
  return s
}

export function renderTemplate(tpl, ctx) {
  if (!tpl) return ''
  return String(tpl).replace(/\{(\w+)\}/g, (m, key) => {
    if (key in ctx) return String(ctx[key])
    return m // 未知通配符原样保留
  })
}

export function templateContext(inst, screen, index, kind, frameIdx) {
  const name = sanitizeName(inst.name)
  const elemBytes = kind === 'u8' ? 1 : (kind === 'u32' ? 4 : 2)
  return {
    x: Math.round(inst.x), y: Math.round(inst.y),
    w: Math.round(inst.w), h: Math.round(inst.h),
    name,
    pic: `gImage_${name}${frameIdx != null ? `[${frameIdx}]` : ''}`,
    color: colorMacroName(inst.color & 0xFFFF),
    colorHex: '0x' + (inst.color & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'),
    colorName: nearestColorName(inst.color & 0xFFFF),
    mirror: inst.mirror ? 1 : 0,
    i: index,
    len: Math.round(inst.w) * Math.round(inst.h),
    lenBytes: Math.round(inst.w) * Math.round(inst.h) * elemBytes,
    sw: screen.w, sh: screen.h,
    fmt: inst.fmt,
  }
}
