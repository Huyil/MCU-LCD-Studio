/*
 * 多文件独立编译自检: node scripts/check-multifile.mjs
 *
 * 为什么单开一套: 用户工程里 ui_assets_int.c / ui_assets_ext.c / ui_table.c / ui_task.c
 * 是**各自独立编译**的 (Keil 的一组文件), 谁用谁都得先看见声明。以前的检查把产物拼成
 * 一个大 .c 再编, 于是"ui_table.c 里 include 排在字库后面 (UI_FONT undefined)"和
 * "素材数组是 static, 别的文件看不见"这两个错都被掩盖了 —— 用户那边一编译就炸:
 *     ui_table.c(948): error: #20: identifier "UI_FONT" is undefined
 * 所以这里按 Keil 的方式编: **每个 .c 单独 gcc -c**, 再链接起来跑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { planToFiles } from '../src/layerexport.js'
import { builtinNumFont, numFontFromGlyphs } from '../src/uiexport.js'

let fails = 0
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`); if (!c) fails++ }

const FW = process.env.FW_DIR || ''
const fwOk = fs.existsSync(path.join(FW, 'code/spi/app_ui.c'))

/* ---------------- 计划: 静态灰度 + 静态彩图 + 文字层(字模表) + 数字层(自带字库) ---------------- */
const bf = builtinNumFont()
const numFont = { ...bf, name: 'g_uiFont_g_uiField0' }
const gw = 6, gh = 9
const picRows = [0, 1, 2].map(i => Uint8Array.from({ length: gw * gh }, (_, k) => (k + i * 7) % 256))
const plan = {
  items: [
    { id: 'a', key: 'g_uiFrame0_int', name: '主图标', x: 8, y: 6, w: 16, h: 16, fmt: 0, color: 0xFFFF, ext: false, bind: null },
    { id: 'b', key: 'g_uiFrame1_ext', name: '底图', x: 0, y: 0, w: 24, h: 12, fmt: 1, color: 0xFFFF, ext: true, bind: null },
    {
      id: 'c', key: 'g_uiFrame2_int', name: 'Logo', x: 2, y: 40, w: gw, h: gh, fmt: 1, color: 0xFFFF, ext: false, bind: null,
      fnName: 'lcd_logo', picTable: { gw, gh, rows: picRows },
    },
    {
      id: 'd', key: 'g_uiField0', name: '车速', x: 60, y: 100, w: 40, h: 20, fmt: 1, color: 0xFFFF, ext: false,
      bind: { name: 'g_uiSpeedX10', type: 'num', dec: 1, cells: 4, align: 1, bg: 0x0000 },
      fontTable: numFont,
    },
    /* 结构体成员变量 (motor.speed): 声明得用户在 ui_user.h 里自己补, 这里模拟用户补好的样子 */
    {
      id: 'e', key: 'g_uiField1', name: '转速', x: 60, y: 130, w: 30, h: 20, fmt: 1, color: 0xFFFF, ext: false,
      bind: { name: 'motor.speed', type: 'num', dec: 0, cells: 3, align: 1, bg: 0x0000 },
      fontTable: numFont,
    },
  ],
  skipped: [],
}
plan.pagePeriods = { main: { period: 200 } }

const px = (it) => it.fmt === 0 ? { rgb: new Uint16Array(it.w * it.h).fill(0x07FF) } : { gray: new Uint8Array(it.w * it.h).fill(180) }
const { files } = planToFiles(plan, px, {})
const byName = Object.fromEntries(files.map(f => [f.name, f.text]))

/* ---------------- 静态检查: include 必须排在用类型之前 ---------------- */
{
  const lines = byName['ui_font.c'].split('\n')
  /* 只数**代码行**: 文件头的注释里也会出现 UI_FONT 字样 (不能算"首次用类型") */
  const firstUse = lines.findIndex(l => /\b(UI_FONT|UI_FRAME_REF|UI_FIELD)\b/.test(l) && !/^\s*(\*|\/\*)/.test(l))
  const firstInc = lines.findIndex(l => /^#include\s+"app_ui\.h"/.test(l))
  ok('ui_font.c: #include "app_ui.h" 排在任何 UI_* 类型之前 (Keil 报 UI_FONT undefined 的根因)',
    firstInc >= 0 && firstInc < firstUse, `include@${firstInc + 1} 首次用类型@${firstUse + 1}`)
  ok('字模在 ui_font.c, ui_table.c 只剩属性 (短小好找错)',
    /const UI_FONT g_uiFont_g_uiField0/.test(byName['ui_font.c']) && /void lcd_logo\(/.test(byName['ui_font.c']) &&
    !/const UI_FONT /.test(byName['ui_table.c']) && !/str1Pic|lcd_logo/.test(byName['ui_table.c']))
  ok('ui_table.c/ui_font.c: 顶部都 include 了 ui_table.h / ui_user.h',
    ['ui_table.c', 'ui_font.c'].every(f => /#include "ui_table\.h"/.test(byName[f]) && /#include "ui_user\.h"/.test(byName[f])))
  ok('ui_table.c: 素材数组是别的文件里定义的 → 只引用, 不定义',
    !/^const uint8_t g_uiFrame0_int\[/m.test(byName['ui_table.c']) && /\.px = g_uiFrame0_int,/.test(byName['ui_table.c']))
  ok('ui_assets_*.c: 数组去掉 static (否则别的 .c 看不见, 链接报 undefined)',
    /^const uint8_t g_uiFrame0_int\[/m.test(byName['ui_assets_int.c']) &&
    /* 外部素材 = 最终形态 (uint16 + UI_EXT_RO 宏), 内部素材仍 uint8 无 static */
    !/^static const uint\d+_t g_ui/m.test(byName['ui_assets_int.c']) &&
    /^const uint16_t g_uiFrame1_ext\[\d+\] UI_EXT_RO/m.test(byName['ui_assets_ext.c']) &&
    !/^static const/m.test(byName['ui_assets_ext.c']))
  ok('外部素材: 生成物里不写段名, 只写 UI_EXT_RO + #include "ui_user.h" (段名只在工程那份头里)',
    !byName['ui_assets_ext.c'].includes('ER_EXTUI') &&
    /#include "ui_user\.h"/.test(byName['ui_assets_ext.c']) &&
    byName['ui_assets_ext.c'].indexOf('#include "ui_user.h"') < byName['ui_assets_ext.c'].indexOf('const uint16_t g_uiFrame1_ext['))
  ok('ui_user.h: 带 UI_EXT_RO 的 #ifndef 默认定义 (新工程第一次导出就能编; 老工程用自己那份)',
    /#ifndef UI_EXT_RO\n#define UI_EXT_RO  __attribute__\(\(used, section\("ER_EXTUI"\)\)\)\n#endif/.test(byName['ui_user.h']))
  ok('字模数组搬出 ui_font.c: 这一套的数字层没勾「外部」→ 落在 ui_assets_int.c (uint8, 不带 static)',
    /^const uint8_t g_uiFont_\w+Glyph\[\d+\] = \{/m.test(byName['ui_assets_int.c']) &&
    !/Glyph\[\d+\]/.test(byName['ui_font.c']) && !/Glyph\[\d+\]/.test(byName['ui_assets_ext.c']))
  ok('ui_font.c 只剩 UI_FONT 结构体 + 函数 (数组搬走后, 字模进外部也不会拖走代码/结构体)',
    /const UI_FONT g_uiFont_\w+ = \{ \.glyph = g_uiFont_\w+Glyph/.test(byName['ui_font.c']))
  ok('ui_table.h 宣告字模数组 (定义在素材文件里, UI_FONT 结构体引用它)',
    /extern const uint8_t g_uiFont_\w+Glyph\[\];/.test(byName['ui_table.h']) &&
    /extern const UI_FONT g_uiFont_\w+;/.test(byName['ui_table.h']))
  ok('成员变量走 UI_SRC_* 宏 + 带 #ifndef 默认写法 (结构体定义拿不到时能在 ui_user.h 里换)',
    /\.src = UI_SRC_motor_speed,/.test(byName['ui_table.c']) &&
    /#ifndef UI_SRC_motor_speed\n#define UI_SRC_motor_speed \(&motor\.speed\)\n#endif/.test(byName['ui_table.c']))
  ok('ui_user.h 给出成员写法的解决方案 (含"指向自己的 int32_t 变量"这条路)',
    /UI_SRC_motor_speed/.test(byName['ui_user.h']) && /#define UI_SRC_motor_speed \(&motor\.speed\)/.test(byName['ui_user.h']) &&
    /int32_t 变量/.test(byName['ui_user.h']))
  ok('来源宏默认值只能是"常量地址" (静态初始化, 不能是函数调用 —— 试过, Keil/gcc 都报 not constant)',
    /#define UI_SRC_motor_speed \(&motor\.speed\)/.test(byName['ui_table.c']) &&
    !/UI_SRC_\w+ \(?\w+\(\)/.test(byName['ui_table.c']))
  ok('新增 ui_table.h: 声明了共用符号 (表/帧/字库/函数/素材)',
    byName['ui_table.h'] && ['extern UI_FIELD g_uiFields[];', 'extern const UI_FRAME_REF g_uiFrame0;',
      'extern const UI_FONT g_uiFont_g_uiField0;', 'void lcd_logo(uint8_t x, uint8_t y, uint8_t id, uint16_t color, uint16_t bg);',
      'extern const uint8_t g_uiFrame0_int[];', 'void UI_DrawStatic(void);',
      /extern const uint16_t g_uiFrame1_ext\[\];/.test(byName['ui_table.h'])].every(s => typeof s === 'boolean' ? s : byName['ui_table.h'].includes(s)))
  ok('ui_task.c: include 了 ui_table.h (g_uiFields / g_uiFrame* 的声明)',
    /#include "ui_table\.h"/.test(byName['ui_task.c']))
  ok('ui_font.c: 有文字层时带上 LCD 头 (函数体里要调 LCD_drawGrayImage / LCD_Fill)',
    /#include "bsp_gc9a01\.h"/.test(byName['ui_font.c']) &&
    byName['ui_font.c'].indexOf('#include "bsp_gc9a01.h"') < byName['ui_font.c'].indexOf('void lcd_logo('))
  ok('ui_table.h: UI_FIELD_N 是数字 (别的 .c 里 g_uiFields 是不完整类型, sizeof 用不了)',
    /#define UI_FIELD_N 2\b/.test(byName['ui_table.h']) && !/sizeof\(g_uiFields\)/.test(byName['ui_table.h']))
  ok('字库注释不再出现 undefined (last 兜底算出来; 注释随字模数组去素材文件)',
    !/undefined/.test(byName['ui_font.c'] + byName['ui_assets_int.c']) &&
    /字符 \d+\.\.\d+ \(\d+ 个\)/.test(byName['ui_assets_int.c']))
  ok('文件清单含 ui_table.h', files.some(f => f.name === 'ui_table.h'))
}

/* ---------------- 真编译: 每个 .c 单独编 (Keil 的编译方式), 再链接跑 ---------------- */
let ran = ''
if (!fwOk) {
  console.log(`SKIP  真编译 (找不到固件 ${FW}, 可用 FW_DIR=... 指定)`)
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uilcd-mf-'))
  const w = (n, s) => fs.writeFileSync(path.join(tmp, n), s)
  for (const f of files) w(f.name, f.text)
  /* 用户拿到 ui_user.h 后会自己补一行结构体声明 (文件顶部有提示), 这里模拟补好之后的样子 */
  fs.appendFileSync(path.join(tmp, 'ui_user.h'),
    '\n/* 用户自己补的: motor.speed 的宿主结构体 (完整定义可见就行) */\nstruct Motor { int32_t speed; };\nextern struct Motor motor;\n')
  w('multi_timer.h', `#ifndef MT_H\n#define MT_H\n#include <stdint.h>\nstruct Timer { void (*timeout_cb)(void*); void *arg; uint32_t repeat; uint8_t run; };\nvoid timer_init(struct Timer*, void (*)(void*), uint32_t, uint32_t, uint8_t);\nint  timer_start(struct Timer*);\nint  timer_stop(struct Timer*);\nvoid timer_ticks(void);\nvoid timer_loop(void);\n#endif\n`)
  w('multi_timer.c', `#include "multi_timer.h"
#define N 8
static struct Timer *reg[N]; static int nreg;
void timer_init(struct Timer*t, void(*cb)(void*), uint32_t d, uint32_t r, uint8_t f){(void)d;(void)f;t->timeout_cb=cb;t->repeat=r;t->run=0;}
int timer_start(struct Timer*t){int i;for(i=0;i<nreg;i++)if(reg[i]==t)return 0;if(nreg<N)reg[nreg++]=t;t->run=1;return 0;}
int timer_stop(struct Timer*t){t->run=0;return 0;}
void timer_ticks(void){}
void timer_loop(void){}
int uiTest_count(void){return nreg;}
uint32_t uiTest_period(int i){return i<nreg?reg[i]->repeat:0;}
int uiTest_fire(int i){if(i>=nreg)return -1;if(reg[i]->timeout_cb)reg[i]->timeout_cb(reg[i]->arg);return 0;}
`)
  w('app_lcd.h', '#ifndef S1\n#define S1\n#include <stdint.h>\nvoid LCD_drawChar(uint8_t,uint8_t,char,uint8_t,uint16_t);\nvoid LCD_drawString(uint8_t,uint8_t,void*,uint8_t,uint16_t);\n#endif\n')
  w('bsp_gc9a01.h', '#ifndef S2\n#define S2\n#include <stdint.h>\nuint8_t LCD_Fill(uint8_t,uint8_t,uint8_t,uint8_t,uint16_t);\nuint8_t LCD_drawImage(uint8_t,uint8_t,uint8_t,uint8_t,const uint8_t*,uint16_t);\nuint8_t LCD_drawGrayImage(uint8_t,uint8_t,uint8_t,uint8_t,const uint8_t*,uint16_t,uint8_t);\n#endif\n')
  fs.copyFileSync(path.join(FW, 'code/spi/app_ui.c'), path.join(tmp, 'app_ui.c'))
  fs.copyFileSync(path.join(FW, 'code/spi/app_ui.h'), path.join(tmp, 'app_ui.h'))
  /* 主程序: 只 include 生成的 ui_task.h, 其余靠链接 (模拟用户的 main.c) */
  w('main.c', `#include <stdio.h>
#include "ui_task.h"
#include "ui_table.h"
struct Motor { int32_t speed; };
struct Motor motor = { 42 };
int32_t g_uiSpeedX10 = 125;
int n_gray=0,n_img=0,n_fill=0;
uint8_t LCD_Fill(uint8_t a,uint8_t b,uint8_t c,uint8_t d,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)e;n_fill++;return 0;}
uint8_t LCD_drawImage(uint8_t a,uint8_t b,uint8_t c,uint8_t d,const uint8_t*p,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)p;(void)e;n_img++;return 0;}
uint8_t LCD_drawGrayImage(uint8_t a,uint8_t b,uint8_t c,uint8_t d,const uint8_t*g,uint16_t e,uint8_t m){(void)a;(void)b;(void)c;(void)d;(void)g;(void)e;(void)m;n_gray++;return 0;}
void LCD_drawChar(uint8_t a,uint8_t b,char c,uint8_t d,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)e;}
void LCD_drawString(uint8_t a,uint8_t b,void*c,uint8_t d,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)e;}
int uiTest_count(void); uint32_t uiTest_period(int); int uiTest_fire(int);
int main(void){
  int i, nu=0, af=0, af2=0, af3=0, nf, f0;
  LCD_UI_Setup();                      /* 一键初始化: 停干净 + 设表 + UI_Init (不进页) */
  LCD_UI_Goto(0);                      /* 进第 0 页: 画静态+数字, 起周期定时器 */
  nu = uiTest_count();
  af = n_gray;                         /* 进页面已经画过静态+数字 */
  f0 = n_img;
  nf = n_gray;
  motor.speed = 43;                    /* 值变化: 周期到必须重刷这个数字 (2026-10-13 值变化检测) */
  uiTest_fire(0);
  af2 = n_gray - nf;
  nf = n_gray;
  uiTest_fire(0);                      /* 值没再变: 一个像素都不动 (静默) */
  af3 = n_gray - nf;
  lcd_logo(2, 40, 1, 0xFFFF, 0);       /* 文字层的按 ID 取图函数, 跨文件调用 */
  i = (int)UI_FIELD_N;
  printf("%d %d %d %d %d %d %d\\n", nu, (int)uiTest_period(0), i, af, f0, af2, af3);
  return 0;
}
`)
  const compile = (src, tag) => {
    try {
      execFileSync('gcc', ['-std=gnu99', '-O1', '-Wall', '-I', tmp, '-c', path.join(tmp, src), '-o', path.join(tmp, tag + '.o')], { stdio: 'pipe' })
      return null
    } catch (e) { return String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 4).join(' | ') }
  }
  const objs = []
  let err = null
  /* 逐个独立编译: 这一步就是用户的 Keil 编译; 缺声明/顺序错都会在这里现形 */
  for (const [src, tag] of [['ui_assets_int.c', 'ai'], ['ui_assets_ext.c', 'ae'], ['ui_font.c', 'ft'], ['ui_table.c', 'tb'], ['ui_task.c', 'tk'], ['app_ui.c', 'ui'], ['multi_timer.c', 'mt'], ['main.c', 'mn']]) {
    const e = compile(src, tag)
    if (e && !err) err = `${src}: ${e}`
    else if (!e) objs.push(path.join(tmp, tag + '.o'))
  }
  ok('每个 .c 单独编译 (Keil 那种多文件工程) 全部通过', !err, err || `${objs.length} 个目标文件`)
  let out = ''
  if (!err) {
    try {
      execFileSync('gcc', [...objs, '-o', path.join(tmp, 'g')], { stdio: 'pipe' })
      out = execFileSync(path.join(tmp, 'g'), { encoding: 'utf8' }).trim()
      ran = out
    } catch (e) { err = String(e.stderr || e.message).split('\n').slice(0, 4).join(' | ') }
  }
  ok('链接 + 运行: 跨文件符号 (表/帧/字库/素材/文字函数) 都对得上', !err, err || out)
  if (!err) {
    const [nu, period, nfield, af, f0, af2, af3] = out.split(/\s+/).map(Number)
    ok('运行结果: 1 个任务 / 200ms / 2 个字段 (含 motor.speed) / 进页面画了静态+数字 / 值变化才刷数字 (不变则静默)',
      nu === 1 && period === 200 && nfield === 2 && af >= 3 && f0 >= 1 && af2 >= 1 && af3 === 0, out)
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(fails ? `\n有失败: ${fails} 项` : '\n全部通过')
process.exit(fails ? 1 : 0)
