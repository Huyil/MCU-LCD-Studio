/*
 * 生成固件用的灰度字库 C 文件 (node scripts/make-font-c.mjs [输出路径])
 *
 * 与「一键导出」里的字库**同一份数据、同一个格式** (0X 大写十六进制, 每行 16 个) ——
 * 与工程 pic.c / ascii1408.c 同风格。缺省路径时打印到 stdout。
 *
 * 固件里 code/spi/ui_demo_font.c 就是它生成的:
 *   g_uiFont0[2288]  +  const UI_FONT g_uiFontNum = { .glyph = g_uiFont0, ... }
 * 只想用网页导出的话可以不跑它: 绑了「值」的图层会让 ui_table.c 自带同一份字库。
 */
import fs from 'node:fs'
import { exportFont, exportFontC } from '../src/uiexport.js'

const fo = exportFont({})
const body = exportFontC(fo)
  .replace(/g_uiFontNumGlyph/g, 'g_uiFont0')             // 固件里用的数组名
  .replace(/^static const uint8_t/m, 'const uint8_t')    // 演示文件是外部链接

const head = `/*
 * ui_demo_font.c —— MCU 侧示例字库 (8bit 灰度, ${fo.w}x${fo.h}, ASCII ${fo.first}..${fo.last}: 空格/-/./0~9)
 *
 * 由 node scripts/make-font-c.mjs 生成 (数据来自网页 src/asciifont.js, 与固件原 gImage_ascii0814 同源),
 * 格式与工程 pic.c / ascii1408.c 一致: 0X 大写十六进制, 每行 16 个。
 * 用来验证"数字走灰度位图字库"这条链路 —— 正式用法是网页导出时直接产出同样的数组
 * (绑了「值」的图层会让生成的 ui_font.c 自带字库; 兜底那份叫 g_uiFontNum8x11,
 *  与这个演示文件的 g_uiFontNum 不撞名, 但两边都 SetFields 时只留一套)。
 */
#include "app_ui.h"

`
const text = head + body + '\n'
const out = process.argv[2]
if (out) {
  fs.writeFileSync(out, text)
  console.log(`已写入 ${out} (${fo.bytes.length} 字节字模, 0X 大写, 每行 16)`)
} else {
  process.stdout.write(text)
}
