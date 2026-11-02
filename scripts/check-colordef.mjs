/*
 * 颜色宏头 ui_color.h 自检 (零依赖: node scripts/check-colordef.mjs)
 *
 * 覆盖:
 *   1) RGB565 → 宏名: 命名色用名字, 自定义色用 UI_COLOR_RGB565_XXXX
 *   2) 从导出计划收集用到的颜色
 *   3) ui_color.h: 头保护、全色表、自定义色追加
 */
import { colorMacroName, collectUsedColors, buildColorHeader, COLOR_MACRO_PREFIX } from '../src/colordef.js'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}

ok('颜色宏: 命名色按 Color_t 名字 (WHITE/CYAN/GRAY/YELLOW)',
   colorMacroName(0xFFFF) === 'UI_COLOR_WHITE' &&
   colorMacroName(0x07FF) === 'UI_COLOR_CYAN' &&
   colorMacroName(0x8410) === 'UI_COLOR_GRAY' &&
   colorMacroName(0xFFE0) === 'UI_COLOR_YELLOW')
ok('颜色宏: 表里没有的自定义色带值 (UI_COLOR_RGB565_4529)',
   colorMacroName(0x4529) === 'UI_COLOR_RGB565_4529',
   colorMacroName(0x4529))
ok('颜色宏: null/缺省按 WHITE 处理 (与旧导出默认值一致)',
   colorMacroName(null) === 'UI_COLOR_WHITE' && colorMacroName(undefined) === 'UI_COLOR_WHITE')

const plan = {
  screen: { w: 240, h: 240, bg: 0x0000 },
  items: [
    { color: 0xFFFF },
    { color: 0x07FF, bind: { bg: 0x0000 } },
    { color: 0x4529 },
  ],
}
const used = collectUsedColors(plan, plan.screen, [0x1234])
ok('颜色收集: 图层色 + 数字底色 + 屏幕底色 + 额外值都收进来',
   [0xFFFF, 0x07FF, 0x0000, 0x4529, 0x1234].every(v => used.includes(v)) && used.length === 5,
   used.map(v => '0x' + v.toString(16)).join(','))
const fromTpl = collectUsedColors(
  { items: [] },
  { bg: 0x0000, templates: { GRAY: 'LCD_drawGrayImage(..., UI_COLOR_RED, 0);', RGB565: 'UI_COLOR_RGB565_07E0' } },
)
ok('颜色收集: 模板/头尾里手写的 UI_COLOR_* 也算用到 (不会被裁掉)',
   fromTpl.includes(0xF800) && fromTpl.includes(0x07E0), fromTpl.map(v => '0x' + v.toString(16)).join(','))

const h = buildColorHeader(used)
ok('ui_color.h: 头保护 + 只列本工程用到的颜色 (不是全 244 色表)',
   h.includes('#ifndef UI_COLOR_H') && h.includes('#define UI_COLOR_H') &&
   h.includes('#endif /* UI_COLOR_H */') &&
   /#define UI_COLOR_WHITE\s+0xFFFF/.test(h) &&
   /#define UI_COLOR_CYAN\s+0x07FF/.test(h) &&
   !/UI_COLOR_RED/.test(h) && !/UI_COLOR_BLUE_SKY/.test(h))
ok('ui_color.h: 只追加工程里用到、表里没有的自定义色 (去重)',
   /#define UI_COLOR_RGB565_4529\s+0x4529/.test(h) &&
   /#define UI_COLOR_RGB565_1234\s+0x1234/.test(h) &&
   (h.match(/#define UI_COLOR_RGB565_4529/g) || []).length === 1)
ok('ui_color.h: 宏名前缀固定 (生成代码/模板都按这个引用)',
   COLOR_MACRO_PREFIX === 'UI_COLOR_' && colorMacroName(0x001F).startsWith(COLOR_MACRO_PREFIX))

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
