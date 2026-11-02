/*
 * 图层驱动导出自检: node scripts/check-layerexport.mjs
 * 校验: 图层→计划(内外部分流/动态绑定/圆环跳过) → 文件(2 个素材 .c + 表+静态绘制)
 *       最后把产物与固件真 app_ui.c 一起 gcc 编译运行 (字段/接口对不上就编不过)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { collectLayerPlan, planToFiles, taskCodeFor, taskHeaderFor, userHeaderFor, fontFileFor,
         pageLabel, normalizePage, pageNum, pageNums, pageEntries, pageIssuesFor,
         tableHeaderFor, tableForPlan, retargetAfterPageRemove, compactPlanPages, retargetJumps,
         frameFunctionBlocks } from '../src/layerexport.js'

let fails = 0
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`); if (!c) fails++ }

/* 三个素材: 一个灰度图标、一个 RGB565 图、一个数字字库 */
const assets = [
  { id: 'a1', name: 'icon', src: 'data:image/png;base64,AA', w: 16, h: 16 },
  { id: 'a2', name: 'photo', src: 'data:image/png;base64,BB', w: 24, h: 12 },
  { id: 'a3', name: 'num', src: 'data:image/png;base64,CC', w: 8, h: 11, font: { glyphW: 8, glyphH: 11, charset: 'custom' } },
]
const instances = [
  { id: 'i1', kind: 'image', name: '图标', assetId: 'a1', x: 10, y: 20, w: 16, h: 16, fmt: 'GRAY', color: 0xFFE0 },
  { id: 'i2', kind: 'image', name: '照片', assetId: 'a2', x: 40, y: 20, w: 24, h: 12, fmt: 'RGB565', ext: true },
  { id: 'i3', kind: 'image', name: '数字', assetId: 'a3', x: 10, y: 50, w: 8, h: 11, fmt: 'GRAY',
    bind: { name: 'g_uiSpeedX10', dec: 1, cells: 5, align: 1, bg: 0x0000 } },
  { id: 'i4', kind: 'ring', name: '圆环', ring: {} },
  { id: 'i5', kind: 'image', name: '无素材' },
  { id: 'i6', kind: 'image', name: '系统字', sysfont: { text: 'OK', family: 'Arial', size: 16 }, x: 4, y: 4, w: 20, h: 16, fmt: 'GRAY' },
]
const plan = collectLayerPlan(instances, assets, {})
ok('圆环进计划 (kind=ring): 不产素材/帧, 但带页号 → 导出那一页启停圆环',
   plan.items.some(i => i.id === 'i4' && i.kind === 'ring' && !i.key) &&
   !plan.skipped.some(s => s.id === 'i4'))
ok('跳过没有素材的图层', plan.skipped.some(s => s.id === 'i5'))
const draw = plan.items.filter(i => i.kind !== 'ring')          // 要素材的画布图层
ok('导出 4 个画布图层 (系统字图层没有素材文件, 也照样导出) + 1 个圆环', plan.items.length === 5 && draw.length === 4, `items=${plan.items.length}`)
ok('外部 flash 标志分流正确', draw.filter(i => i.ext).length === 1 && draw.filter(i => !i.ext).length === 3)
ok('动态绑定被识别', plan.items.filter(i => i.bind).length === 1)
ok('数组名 = 帧表序号 + _int/_ext (g_uiFrame0_int …), 动态层用 g_uiField0',
   draw.map(i => i.key).join(',') === 'g_uiFrame0_int,g_uiFrame1_ext,g_uiField0,g_uiFrame2_int', draw.map(i => i.key).join(','))

/* 像素由桩提供: 灰度全 200, RGB565 全 0x07FF */
const pixels = (it) => it.fmt === 1 ? { gray: new Uint8Array(it.w * it.h).fill(200) }
                                    : { rgb: new Uint16Array(it.w * it.h).fill(0x07FF) }
const r = planToFiles(plan, pixels, { ringConfig: '/* ring */\n#define RING_CX 119\n' })
const byName = Object.fromEntries(r.files.map(f => [f.name, f.text]))
ok('产出 10 个文件 (ring_config.h + ui_color.h + 2 素材 + 表 .c/.h + 字模 ui_font.c + 任务 .c/.h + 不覆盖的 ui_user.h)',
   Object.keys(byName).sort().join(',') === 'ring_config.h,ui_assets_ext.c,ui_assets_int.c,ui_color.h,ui_font.c,ui_table.c,ui_table.h,ui_task.c,ui_task.h,ui_user.h',
   Object.keys(byName).join(','))
ok('字库/字模单独一个文件 (ui_font.c), 属性表 (ui_table.c) 保持短小',
   byName['ui_font.c'].includes('const UI_FONT g_uiFontNum8x11') && !byName['ui_table.c'].includes('const UI_FONT ') &&
   byName['ui_table.c'].split('\n').length < 60)
ok('素材数组不再是 static (各 .c 独立编译时别的文件要能看见)',
   /^const uint8_t g_uiFrame0_int\[/m.test(byName['ui_assets_int.c']))
ok('ui_table.h 声明了素材数组 + 帧 + 表 (多文件工程靠它)',
   ['extern const uint8_t g_uiFrame0_int[];', 'extern const UI_FRAME_REF g_uiFrame0;', 'extern UI_FIELD g_uiFields[];']
     .every(x => byName['ui_table.h'].includes(x)))
ok('内部素材 2 个数组 (动态那层不出像素; 系统字那层出)',
   (byName['ui_assets_int.c'].match(/g_uiFrame\d+_int\[/g) || []).length === 2)
ok('外部素材 1 个数组', (byName['ui_assets_ext.c'].match(/g_uiFrame\d+_ext\[/g) || []).length === 1)
ok('动态图层的像素不进素材 (勾了「值」→ 固件自己画数字, 省 flash)',
   !byName['ui_assets_int.c'].includes('g_uiField0[') && byName['ui_assets_int.c'].includes('g_uiFrame0_int['))
ok('帧表只列静态图层 (动态图层不在帧表里, 否则 .px 指向不存在的数组)',
   byName['ui_table.c'].includes('g_uiFrame2') && !byName['ui_table.c'].includes('g_uiFrame3') &&
   !/g_uiFrame\d = \{[\s\S]*?g_uiField0/.test(byName['ui_table.c']))
ok('表里 2 个帧 + 1 个动态区域 (.src 指向用户变量), 字库在 ui_font.c',
   byName['ui_table.c'].includes('.src = &g_uiSpeedX10') && byName['ui_font.c'].includes('const UI_FONT g_uiFontNum8x11'))
ok('静态绘制函数只含未绑定图层 (图标+照片)',
   /void UI_DrawStatic\(void\)[\s\S]*UI_DrawFrame\(&g_uiFrame0[\s\S]*UI_DrawFrame\(&g_uiFrame1[\s\S]*\}/.test(byName['ui_table.c']))
ok('静态绘制引用的是帧表项 (UI_FRAME_REF*), 不是像素数组 (以前会画成乱码)',
   !/UI_DrawFrame\(&g_uiFrame\d+_(int|ext)/.test(byName['ui_table.c']) &&
   !/UI_DrawStatic[\s\S]*g_uiFrame2_int/.test(byName['ui_table.c']))
ok('统计数字正确 (动态数也报出来)', r.stat.int === 2 && r.stat.ext === 1 && r.stat.dyn === 1 && r.stat.frames === 3, JSON.stringify(r.stat))

/* 文字层: 按 ID 取图的字模表 + 调用函数 (导出物里真的带, 不只是弹窗预览) */
{
  const asText = [{
    id: 't1', kind: 'text', name: 'str1', assetId: 'a4', text: 'AB', spacing: 0,
    x: 0, y: 0, w: 16, h: 11, fmt: 'GRAY', color: 0xFFFF,
  }]
  const fontAsset = { id: 'a4', name: 'f', src: 'data:,', w: 16, h: 11, font: { glyphW: 8, glyphH: 11, charset: 'custom', custom: 'AB' } }
  const p3 = collectLayerPlan(asText, [fontAsset], {})
  p3.items[0].fnName = 'str1'
  p3.items[0].picTable = { name: 'str1Pic', gw: 8, gh: 11, rows: [new Uint8Array(88).fill(0x11), new Uint8Array(88).fill(0x22)] }
  const f3 = Object.fromEntries(planToFiles(p3, () => ({ gray: new Uint8Array(16).fill(1) }), {}).files.map(f => [f.name, f.text]))
  const t3 = f3['ui_font.c']
  ok('文字层导出: 取图函数在 ui_font.c, 字模表在素材文件 (属性表里一行字模都没有)',
     !/^const uint8_t str1Pic/m.test(t3) && /void str1\(uint8_t x/.test(t3) &&
     !f3['ui_table.c'].includes('str1Pic') && !f3['ui_table.c'].includes('void str1('))
  ok('文字层导出: 带字模表 str1Pic[2][88] (0X 大写; 这一层没勾「外部」→ 落 ui_assets_int.c)',
     f3['ui_assets_int.c'].includes('const uint8_t str1Pic[2][88] = {') &&
     f3['ui_assets_int.c'].includes('0X11,') && !/\b17,17,/.test(f3['ui_assets_int.c']) &&
     !f3['ui_assets_ext.c'].includes('str1Pic'))
  ok('文字层导出: 带调用函数 void str1(x,y,id,color,bg)',
     /void str1\(uint8_t x, uint8_t y, uint8_t id, uint16_t color, uint16_t bg\)/.test(t3))
  ok('文字层导出: id 超范围 → LCD_Fill 填底色 (内部是 drawGrayImage)',
     t3.includes('if (id < 2) LCD_drawGrayImage(x, y, 8, 11, str1Pic[id], color, 0);') &&
     t3.includes('LCD_Fill(x, y, x + 8, y + 11, bg);'))
  /* 和「＋文字」弹窗里预览的代码必须是同一段 (弹窗用同一个生成器) */
  const { idDrawFunction, cGlyphTable } = await import('../src/uiexport.js')
  ok('文字层导出: 与弹窗预览同一份生成器 (函数在 ui_font.c, 字模表在素材文件)',
     t3.includes(idDrawFunction('str1', { count: 2, w: 8, h: 11 })) &&
     f3['ui_assets_int.c'].includes(cGlyphTable('str1Pic', p3.items[0].picTable.rows)))
}

/* 系统字「ASCII 字库」层: 整份 0x20~0x7E 字模表 + <名字>() / <名字>Str() (纯逻辑路径也得有) */
{
  const gw = 8, gh = 11
  const rows = Array.from({ length: 95 }, (_, i) => new Uint8Array(gw * gh).fill(i & 0xFF))
  const plan5 = {
    items: [{
      id: 't2', kind: 'image', key: 'g_uiInt0', name: 'asc_1', ascii: true, page: 0, pages: [0],
      x: 0, y: 0, w: gw, h: gh, fmt: 1, color: 0xFFFF, mirror: 0, fnName: 'asc_1',
      picTable: { name: 'asc_1Pic', gw, gh, rows, first: 32, count: 95, gap: 1 },
      bind: null, ext: false, lineH: 0,
    }],
    screen: { w: 240, h: 240 }, pagePeriods: {},
  }
  const f5 = Object.fromEntries(planToFiles(plan5, () => ({ gray: new Uint8Array(gw * gh).fill(1) }), {})
    .files.map(f => [f.name, f.text]))
  const t5 = f5['ui_font.c'] || ''
  ok('ASCII 字库导出: 95 行字模表在素材文件 (这一层没勾「外部」→ int; 属性表里不掺字模)',
     (f5['ui_assets_int.c'] || '').includes('const uint8_t asc_1Pic[95][88] = {') &&
     !/^const uint8_t asc_1Pic/m.test(t5) &&
     !(f5['ui_table.c'] || '').includes('asc_1Pic'))
  ok('ASCII 字库导出: ui_table.h 用行字节数声明字模表 (取图函数按 id 取行)',
     (f5['ui_table.h'] || '').includes('extern const uint8_t asc_1Pic[][88];'))
  ok('ASCII 字库导出: id 版与 Str 版两个函数都出 (同一个字模表, 两种用法)',
     /void asc_1\(uint8_t x, uint8_t y, uint8_t id, uint16_t color, uint16_t bg\)/.test(t5) &&
     /void asc_1Str\(uint8_t x, uint8_t y, const char \*str, uint16_t color\)/.test(t5))
  ok('ASCII 字库导出: ui_table.h 两个函数都有声明 (别的 .c 独立编译看得见)',
     f5['ui_table.h'].includes('void asc_1(uint8_t x, uint8_t y, uint8_t id, uint16_t color, uint16_t bg);') &&
     f5['ui_table.h'].includes('void asc_1Str(uint8_t x, uint8_t y, const char *str, uint16_t color);'))
  ok('ASCII 字库导出: Str() 步进 = 字宽+字距, 空格跳过, 按 c-32 取字模',
     t5.includes('x += 9)') && t5.includes("c == ' ') continue;") && t5.includes('asc_1Pic[c - 32u]'))
}

/* ---- 页面组合: page 是显示真值 + 特殊页 (-3/-2) + 定时跳转 + 按键只在 >=0 循环 ---- */
{
  const mk = (key, name, page) => ({
    id: key, key, name, page, x: 100, y: 20, color: 0xFFE0,
    fontTable: { name: 'g_uiFont_' + key, w: 8, h: 11 },
    bind: { type: 'num', name, dec: 1, cells: 5, align: 1, pad: 0, bg: 0 },
  })
  const st = (key, name, page) => ({ id: key, key, name, page, x: 0, y: 0, w: 8, h: 8, color: 0xFFFF, fmt: 1, font: null })
  const plan4 = {
    items: [
      mk('g_uiInt0', 'g_uiSpeedX10', 1),
      mk('g_uiInt1', 'g_uiTemp', 2),
      mk('g_uiInt2', 'g_uiVolt', 2),
      st('g_uiInt9', 'Logo', -4),                   // -4 = 开机 LOGO (特殊页): 配了 800ms → 1 页的定时跳转
      st('g_uiInt8', 'Charge', -2),                 // -2 = 关机充电 (特殊页)
      st('g_uiInt7', 'LowBat', -3),                 // -3 = 低电 (特殊页)
      { id: 'rg1', kind: 'ring', name: 'ring_1', page: 2, ring: { gear: 3, dir: -1 } },   // 圆环放在第 2 页
    ],
    skipped: [],
    screen: { w: 240, h: 240 },
    pagePeriods: { '-4': { jumpMs: 800, jumpTo: 1 }, 0: { period: 200 }, 1: { period: 200 }, 2: { period: 300 }, '-3': { period: 500 } },
  }
  const t = taskCodeFor(plan4, { lcdHeader: 'bsp_gc9a01.h', scrW: 240, scrH: 240 })
  const h = taskHeaderFor(plan4)
  /* ---- 隐藏页 (用户: 不显示充电页/LOGO/低电页, 又不想删掉状态) ----
   * 约定: LCD_HAS_* 只表示"会不会画内容"; 隐藏另给 LCD_*_HIDDEN 宏;
   *       隐藏页的 Enter = 只清屏 + 等新状态 (不画静态/数字/圆环, 也不自动跳页) */
  {
    const planH = JSON.parse(JSON.stringify(plan4))
    planH.pagePeriods = { ...planH.pagePeriods, '-2': { hidden: true }, '-4': { jumpMs: 800, jumpTo: 1, hidden: true }, 2: { period: 300, hidden: true } }
    const th = taskCodeFor(planH, { lcdHeader: 'bsp_gc9a01.h', scrW: 240, scrH: 240 })
    const hh = taskHeaderFor(planH)
    /* 取某个 Enter 的函数体 (不用正则, 免得转义踩坑) */
    const seg = (lbl) => {
      const i = th.indexOf('void LCD_' + lbl + '_Enter(void)')
      if (i < 0) return ''
      const j = th.indexOf('\n}', i)
      return j < 0 ? th.slice(i) : th.slice(i, j + 2)
    }
    ok('隐藏页: LCD_HAS_* = 0 (不画内容), 另给 LCD_HIDDEN_* = 1',
       /#define LCD_HAS_CHARGE_PAGE\s+0/.test(hh) && /#define LCD_HIDDEN_CHARGE_PAGE\s+1/.test(hh) &&
       /#define LCD_HAS_LOGO_PAGE\s+0/.test(hh) && /#define LCD_HIDDEN_LOGO_PAGE\s+1/.test(hh) &&
       /#define LCD_HAS_PAGE_2\s+0/.test(hh) && /#define LCD_PAGE_2_HIDDEN\s+1/.test(hh))
    ok('隐藏页: Enter 只有注释 (清屏已由 Goto 做) —— 不画静态层/数字/圆环, 也不启动任何定时器',
       /被隐藏/.test(seg('PageCharge')) && !/UI_DrawFrame|UI_DrawField|Ring_Start|timer_init/.test(seg('PageCharge')) &&
       !/UI_DrawFrame|UI_DrawField|Ring_Start|timer_init/.test(seg('Page2')) &&
       !/UI_DrawFrame/.test(seg('PageLogo')))
    ok('隐藏页: 定时跳转不生效 (进去等固件给新状态, 不自己走)',
       /#define LCD_PAGE_LOGO_JUMP_MS\s+0/.test(hh) && !/LCD_PageLogo_Jump/.test(th))
    ok('隐藏页: 按键切页跳过它 (2 页被隐藏 → user[] 只剩可见页)',
       /static const int8_t user\[\] = \{ 0, 1 \};/.test(th))
  }
  ok('页面: include multi_timer.h + ui_task.h', t.includes('#include "multi_timer.h"') && t.includes('#include "ui_task.h"'))
  ok('页面: 正常页 LCD_Page<n>_*, 特殊页 LCD_PageLogo_* / LCD_PageCharge_* / LCD_PageLowBat_*',
     t.includes('void LCD_Page0_Enter(void)') && t.includes('void LCD_PageCharge_Enter(void)') &&
     t.includes('void LCD_PageLowBat_Exit(void)') && t.includes('void LCD_PageLogo_Enter(void)'))
  ok('页面: 每页一个定时器, 周期是页面级的 (1 页 200 / 2 页 300)',
     t.includes('timer_init(&g_uiTmr_Page1, LCD_Page1_CB, 200, 200, 0);') &&
     t.includes('timer_init(&g_uiTmr_Page2, LCD_Page2_CB, 300, 300, 0);'))
  ok('页面: 同页多个变量合并进一个回调 (2 页里刷两个字段)',
     /void LCD_Page2_CB[\s\S]*?UI_DrawField\(&g_uiFields\[1\]\)[\s\S]*?UI_DrawField\(&g_uiFields\[2\]\)/.test(t))
  ok('页面: Enter = 画初始化显示内容 (静态 + 数字), 再启动刷新',
     /void LCD_Page2_Enter\(void\)[\s\S]*UI_DrawField\(&g_uiFields\[1\]\)[\s\S]*timer_start\(&g_uiTmr_Page2\)/.test(t))
  ok('定时跳转: Enter 起一次性定时器 + Jump 回调 LCD_UI_Goto(目标) + Exit 停掉 (LOGO 页 -4 上配的)',
     /void LCD_PageLogo_Enter\(void\)[\s\S]*timer_init\(&g_uiJump_PageLogo, LCD_PageLogo_Jump, 800, 0, 0\)[\s\S]*timer_start\(&g_uiJump_PageLogo\)/.test(t) &&
     /static void LCD_PageLogo_Jump\(void \*arg\)[\s\S]*LCD_UI_Goto\(1\)/.test(t) &&
     /void LCD_PageLogo_Exit\(void\)[\s\S]*timer_stop\(&g_uiJump_PageLogo\)/.test(t))
  ok('定时器参数顺序: timer_init(t, cb, 首次延迟, 周期, arg) —— 跳转是"延迟 N 后一次性", 不能立刻触发',
     t.includes('timer_init(&g_uiJump_PageLogo, LCD_PageLogo_Jump, 800, 0, 0);') &&
     t.includes('timer_init(&g_uiTmr_Page1, LCD_Page1_CB, 200, 200, 0);') &&
     !/timer_init\(&g_uiJump_\w+, \w+, 0, \d+, 0\)/.test(t) &&
     !/timer_init\(&g_uiTmr_\w+, \w+, 0, \d+, 0\)/.test(t))
  ok('圆环页: Enter 里 Ring_SetBg + Ring_Start(档位/方向来自 ring_config.h), Exit 里 Ring_Stop',
     /void LCD_Page2_Enter\(void\)[\s\S]*Ring_SetBg\(UI_PAGE_BG\)[\s\S]*Ring_Start\(RING_GEAR_DEF, RING_DIR_DEF\)/.test(t) &&
     /void LCD_Page2_Exit\(void\)[\s\S]*Ring_Stop\(\);/.test(t) &&
     t.includes('#include "bsp_ring.h"'))
  ok('空页号也留位 (0..最大页号), LCD_PAGE_N 只数 >=0 的页 = 3',
     t.includes('void LCD_Page0_Enter(void)') && t.includes('void LCD_Page1_Enter(void)') &&
     t.includes('void LCD_Page2_Enter(void)') && /#define LCD_PAGE_N\s+3/.test(h))
  ok('切页 LCD_UI_Goto(int8_t): 出旧页 → 清屏钩子 → 进新页 (UI_PAGE_CLEAR 可在 ui_user.h 覆盖)',
     /static void ui_exit_all\(void\)[\s\S]*case 2: LCD_Page2_Exit\(\); break;/.test(t) &&
     /void LCD_UI_Goto\(int8_t page\)[\s\S]*ui_exit_all\(\);[\s\S]*UI_PAGE_CLEAR\(\);[\s\S]*ui_enter\(page\);/.test(t) &&
     /#ifndef UI_PAGE_CLEAR[\s\S]*LCD_Fill\(0, 0, 240, 240, UI_PAGE_BG\)[\s\S]*#endif/.test(t) &&
     /static void ui_enter\(int8_t page\)[\s\S]*case 0: LCD_Page0_Enter\(\); break;/.test(t))
  ok('越界 = 空白页 (-1), 同页直接返回 (含 -1 → -1)',
     t.includes('if (page >= LCD_PAGE_N) page = -1;') && t.includes('if (page == s_page) return;') &&
     t.includes('static int8_t s_page = -1;'))
  ok('特殊页只在导出过时才认 (Goto 里有 case -4 / -3 / -2, 其它负数 → 空白)',
     /case -4: break;[\s\S]*case -3: break;[\s\S]*case -2: break;[\s\S]*default: page = -1; break;/.test(t))
  ok('LCD_UI_Setup = 停干净 + 设表 + UI_Init, 不进任何页 (老的 LCD_UI_Init 已删)',
     /void LCD_UI_Setup\(void\)[\s\S]*ui_exit_all\(\)[\s\S]*UI_SetFields\(g_uiFields, UI_FIELD_N\)[\s\S]*UI_Init\(\)[\s\S]*s_page = -1;/.test(t) &&
     !t.includes('LCD_UI_Init'))
  ok('页变了通知固件: UI_PAGE_CHANGED 可覆盖 (默认空操作)',
     t.includes('#ifndef UI_PAGE_CHANGED') && t.includes('UI_PAGE_CHANGED(s_page);'))
  ok('按键切页: NextPage 只在 >=0 的用户页里循环 (LOGO/充电/低电都进不去)',
     /static const int8_t user\[\] = \{ 0, 1, 2 \}/.test(t) &&
     t.includes('if (cur < 0 || cur >= LCD_PAGE_N) return user[0];'))
  ok('ui_task.h: 新 API + 每页事实宏 (有没有内容 / 定时跳转 / 特殊页)',
     h.includes('void LCD_UI_Setup(void);') && h.includes('void LCD_UI_Goto(int8_t page);') &&
     h.includes('int8_t LCD_UI_Page(void);') && h.includes('int8_t LCD_UI_NextPage(int8_t cur);') &&
     /#define LCD_HAS_PAGE_0\s+0/.test(h) && /#define LCD_HAS_PAGE_1\s+1/.test(h) && /#define LCD_HAS_LOGO_PAGE\s+1/.test(h) &&
     /#define LCD_PAGE_LOGO_JUMP_MS\s+800/.test(h) && /#define LCD_PAGE_LOGO_JUMP_TO\s+1/.test(h) &&
     /#define LCD_HAS_CHARGE_PAGE\s+1/.test(h) && /#define LCD_HAS_LOWBAT_PAGE\s+1/.test(h) &&
     h.includes('void LCD_PageCharge_Enter(void);') && /#define LCD_PAGE_LOGO\s+\(-4\)/.test(h))
  ok('页号工具: 特殊页命名 / -1 不能放图层 / 越界夹取',
     pageLabel(-1) === 'PageOff' && pageLabel(-2) === 'PageCharge' && pageLabel(-3) === 'PageLowBat' &&
     pageLabel(-4) === 'PageLogo' && pageLabel(4) === 'Page4' && pageNum({ page: -4 }) === -4 &&
     normalizePage(-1, 7) === 7 && normalizePage(-9) === -4 && normalizePage(99) === 9)
  ok('页清单: 特殊页只列有内容的, -1 永不出现; 正常页空号也留位',
     pageEntries([{ page: -4 }, { page: -2 }, { page: 0 }, { page: 2 }]).map(p => p.n).join(',') === '-4,-2,0,1,2')
  ok('页面自检: 目标页不存在 / -1 页放图层 / LOGO 页没配跳转都会告警',
     pageIssuesFor({ items: [{ name: 'a', page: -1 }], pagePeriods: {} }).some(w => w.text.includes('-1 页')) &&
     pageIssuesFor({ items: [{ name: 'a', page: -4 }], pagePeriods: { '-4': {} } }).some(w => w.text.includes('定时跳转')) &&
     pageIssuesFor({ items: [{ name: 'a', page: 1 }], pagePeriods: { 1: { jumpMs: 500, jumpTo: 9 } } }).some(w => w.text.includes('目标页')))
  ok('定时跳转目标不存在 → 生成的代码里不会起跳转定时器',
     !taskCodeFor({ items: [{ id: 'x', key: 'k', name: 'a', page: 1, x: 0, y: 0, color: 1, fmt: 1 }],
                    screen: { w: 240, h: 240 }, pagePeriods: { 1: { jumpMs: 500, jumpTo: 9 } } }).includes('g_uiJump'))
  ok('只有静态层的页也有 Enter/Exit, 但没有 CB (没东西要周期刷)',
     (() => {
       const only = taskCodeFor({ items: [{ id: 'x', key: 'g_uiIntX', name: 'bg', page: 1, x: 0, y: 0, color: 0xFFFF, fmt: 1 }], screen: { w: 240, h: 240 } })
       return only.includes('void LCD_Page0_Enter(void)') && only.includes('void LCD_Page1_Enter(void)') &&
              !only.includes('LCD_Page1_CB') && only.includes('void LCD_Page1_Exit(void)')
     })())
  ok('老工程里的页名 (main/Speed) 归到 0 页 (不会生成非法函数名)',
     taskCodeFor({ items: [{ id: 'x', key: 'k', name: 'a', page: 'main', x: 0, y: 0, color: 1, fmt: 1 }] }).includes('void LCD_Page0_Enter(void)'))
  ok('多页图层: 同一层落在多页, 但素材/帧只出一份 (每页 Enter 都画它)',
     (() => {
       const multi = { id: 'm1', key: 'g_uiIntM', name: '共用条', page: 0, pages: [0, 2], x: 1, y: 2, color: 0xFFFF, fmt: 1 }
       const planM = { items: [multi], screen: { w: 240, h: 240 }, pagePeriods: {} }
       const tM = taskCodeFor(planM, { scrW: 240, scrH: 240 })
       const files = planToFiles(planM, () => ({ gray: new Uint8Array(8 * 8) }), {})
       const assets = files.files.find(f => f.name === 'ui_assets_int.c').text
       const frames = (files.files.find(f => f.name === 'ui_table.c').text.match(/const UI_FRAME_REF g_uiFrame\d+/g) || []).length
       return pageNums(multi).join(',') === '0,2' &&
              pageEntries([multi]).map(p => p.n).join(',') === '0,1,2' &&
              /void LCD_Page0_Enter\(void\)[\s\S]*?UI_DrawFrame\(&g_uiFrame0/.test(tM) &&
              /void LCD_Page2_Enter\(void\)[\s\S]*?UI_DrawFrame\(&g_uiFrame0/.test(tM) &&
              frames === 1 && (assets.match(/const uint8_t \w+\[/g) || []).length === 1
     })())
  ok('圆环也能多页: 每页 Enter 启圆环 / Exit 停圆环 (页 0 与 2)',
     (() => {
       const ring = { id: 'r1', kind: 'ring', name: 'ring', pages: [0, 2], ring: { gear: 3, dir: -1 } }
       const tR = taskCodeFor({ items: [ring], screen: { w: 240, h: 240 }, pagePeriods: {} }, { scrW: 240, scrH: 240 })
       return /void LCD_Page0_Enter\(void\)[\s\S]*?Ring_Start\(RING_GEAR_DEF, RING_DIR_DEF\)/.test(tR) &&
              /void LCD_Page2_Enter\(void\)[\s\S]*?Ring_Start\(RING_GEAR_DEF, RING_DIR_DEF\)/.test(tR) &&
              /void LCD_Page0_Exit\(void\)[\s\S]*?Ring_Stop\(\);/.test(tR) &&
              /void LCD_Page2_Exit\(void\)[\s\S]*?Ring_Stop\(\);/.test(tR)
     })())
  ok('多页数字层: 表项只一条, 但每页 CB 都会刷它',
     (() => {
       const dyn = { id: 'd1', key: 'g_uiIntD', name: '速度', page: 1, pages: [1, 2],
                     x: 1, y: 1, color: 0xFFFF, fmt: 1, fontTable: { name: 'g_uiFontD', w: 8, h: 11 },
                     bind: { type: 'num', name: 'g_uiSpeed', dec: 0, cells: 3, align: 1, bg: 0 } }
       const tD = taskCodeFor({ items: [dyn], screen: { w: 240, h: 240 }, pagePeriods: { 1: { period: 200 }, 2: { period: 300 } } }, { scrW: 240, scrH: 240 })
       const hD = tableHeaderFor({ items: [dyn], screen: { w: 240, h: 240 }, pagePeriods: { 1: { period: 200 }, 2: { period: 300 } } })
       return /void LCD_Page1_CB[\s\S]*?UI_DrawField\(&g_uiFields\[0\]\)/.test(tD) &&
              /void LCD_Page2_CB[\s\S]*?UI_DrawField\(&g_uiFields\[0\]\)/.test(tD) &&
              /#define UI_FIELD_N 1\b/.test(hD)
     })())
  ok('页号工具: pages 数组优先 / 单页照旧 / 非法值退 0',
     pageNums({ page: 3 }).join(',') === '3' && pageNums({ pages: [2, 0, 2] }).join(',') === '2,0' &&
     pageNums({ page: 'main' }).join(',') === '0' && pageNums({}).join(',') === '0' && pageNum({ page: 5, pages: [2, 5] }) === 2)
  ok('没有特殊页时: 负数一律空白 (Goto 里不出现 case -2/-3)',
     !taskCodeFor({ items: [{ id: 'x', key: 'k', name: 'a', page: 0, x: 0, y: 0, color: 1, fmt: 1 }] }).includes('case -2:'))
}

/* ---- ui_user.h: 不覆盖的用户头 (变量声明 / LCD 头都放这里) ---- */
{
  const planU = {
    items: [
      { id: 'u1', key: 'g_uiInt0', name: 'Speed', color: 0xFFFF, bind: { type: 'num', name: 'g_uiSpeedX10', dec: 1, cells: 4 } },
      { id: 'u2', key: 'g_uiInt1', name: 'M', color: 0xFFFF, bind: { type: 'num', name: 'motor.speed', dec: 1, cells: 4 } },
      { id: 'u3', key: 'g_uiInt2', name: 'Logo', color: 0xFFFF, bind: null },
    ],
    skipped: [],
  }
  const uh = userHeaderFor(planU)
  ok('用户头: 生成 extern 声明 (普通变量原样, 成员变量给注释提示)',
     uh.includes('extern int32_t g_uiSpeedX10;') && uh.includes('motor.speed') &&
     !uh.includes('extern int32_t motor.speed;'), '')
  ok('用户头: 标注"不会被覆盖" + 可以补 LCD 头/宏',
     uh.includes('不会再被覆盖') && uh.includes('LCD 头') && uh.includes('#ifndef UI_USER_H'))
  ok('用户头: 标记 once=true (导出时已存在就跳过)', (() => {
    const files = planToFiles(planU, () => ({ gray: new Uint8Array(4) }), {}).files
    const f = files.find(x => x.name === 'ui_user.h')
    return !!f && f.once === true
  })())
  ok('生成的 C 都 include ui_user.h (变量声明才看得见)',
     taskCodeFor(planU, {}).includes('#include "ui_user.h"') &&
     planToFiles(planU, () => ({ gray: new Uint8Array(4) }), {}).files
       .find(f => f.name === 'ui_table.c').text.includes('#include "ui_user.h"'))
}

/* 真编译: 产物 + 固件 app_ui.c */
const FW = process.env.FW_DIR || ''
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'layerexp-'))
const gen = `#include "app_ui.h"
static int32_t g_uiSpeedX10 = 123;
static int32_t g_uiSelIdx;
${byName['ui_assets_int.c']}
${byName['ui_assets_ext.c']}
${byName['ui_font.c']}
${byName['ui_table.c']}
int n_gray=0,n_img=0,n_fill=0,n_char=0;
void LCD_drawChar(uint8_t a,uint8_t b,char c,uint8_t d,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)e;n_char++;}
void LCD_drawString(uint8_t a,uint8_t b,void*c,uint8_t d,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)e;}
uint8_t LCD_Fill(uint8_t a,uint8_t b,uint8_t c,uint8_t d,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)e;n_fill++;return 0;}
uint8_t LCD_drawImage(uint8_t a,uint8_t b,uint8_t c,uint8_t d,const uint8_t*p,uint16_t e){(void)a;(void)b;(void)c;(void)d;(void)p;(void)e;n_img++;return 0;}
uint8_t LCD_drawGrayImage(uint8_t a,uint8_t b,uint8_t c,uint8_t d,const uint8_t*g,uint16_t e,uint8_t m){(void)a;(void)b;(void)c;(void)d;(void)g;(void)e;(void)m;n_gray++;return 0;}
#include <stdio.h>
int main(void){
  UI_SetFields(g_uiFields, UI_FIELD_N);
  UI_Init();
  UI_DrawStatic();                       /* 静态: 图标(灰度)+照片(RGB565) */
  UI_DrawAll();                          /* 动态: 数字 */
  printf("%d %d %d %d\\n", n_gray, n_img, n_fill, (int)UI_FIELD_N);
  return 0;
}`
fs.writeFileSync(path.join(tmp, 'gen.c'), gen)
const hasFW = fs.existsSync(path.join(FW, 'code/spi/app_ui.c')) && fs.existsSync(path.join(FW, 'code/spi/app_ui.h'))
if (hasFW) {
  fs.copyFileSync(path.join(FW, 'code/spi/app_ui.c'), path.join(tmp, 'app_ui.c'))
  fs.copyFileSync(path.join(FW, 'code/spi/app_ui.h'), path.join(tmp, 'app_ui.h'))
}
fs.writeFileSync(path.join(tmp, 'app_lcd.h'), '#ifndef S1\n#define S1\n#include <stdint.h>\nvoid LCD_drawChar(uint8_t,uint8_t,char,uint8_t,uint16_t);\nvoid LCD_drawString(uint8_t,uint8_t,void*,uint8_t,uint16_t);\n#endif\n')
fs.writeFileSync(path.join(tmp, 'ui_user.h'), '/* 自检: 空用户头 (ui_assets_ext.c/ui_font.c 要 UI_EXT_RO) */\n#ifndef UI_EXT_RO\n#define UI_EXT_RO  __attribute__((used, section("ER_EXTUI")))\n#endif\n')
fs.writeFileSync(path.join(tmp, 'ui_table.h'), byName['ui_table.h'])
fs.writeFileSync(path.join(tmp, 'ui_color.h'), byName['ui_color.h'])
fs.writeFileSync(path.join(tmp, 'bsp_gc9a01.h'), '#ifndef S2\n#define S2\n#include <stdint.h>\nuint8_t LCD_Fill(uint8_t,uint8_t,uint8_t,uint8_t,uint16_t);\nuint8_t LCD_drawImage(uint8_t,uint8_t,uint8_t,uint8_t,const uint8_t*,uint16_t);\nuint8_t LCD_drawGrayImage(uint8_t,uint8_t,uint8_t,uint8_t,const uint8_t*,uint16_t,uint8_t);\n#endif\n')
let good = false, out = ''
if (hasFW) {
  try {
    execFileSync('gcc', ['-O2', '-Wall', '-I', tmp, path.join(tmp, 'gen.c'), path.join(tmp, 'app_ui.c'), '-o', path.join(tmp, 'g')], { stdio: 'pipe' })
    out = execFileSync(path.join(tmp, 'g'), { encoding: 'utf8' }).trim()
    good = true
  } catch (e) { out = ((e.stdout || '') + (e.stderr || '') + e.message).split('\n')[0] }
  /* 断言不变量: 能编能跑 / 恰好 1 个动态区域 / 静态与动态都真的发生了绘制 */
  const [g, im, fl, nf] = out.split(/\s+/).map(Number)
  ok('产物 + 固件 app_ui.c 真编译运行', good, good ? `实测 灰度${g} 图片${im} 填充${fl} 字段${nf}` : out)
  ok('恰好 1 个动态区域', nf === 1, `UI_FIELD_N=${nf}`)
  ok('静态图层确实画了 (灰度/图片各≥1)', g >= 1 && im >= 1, `灰度${g} 图片${im}`)
  ok('动态数字区域确实画了 (填充≥1 说明空格补位也生效)', fl >= 1, `填充${fl}`)
} else {
  ok('产物 + 固件 app_ui.c 真编译运行 (SKIP: 环境缺 app_ui.c)', true, 'FW_DIR=' + FW)
}
fs.rmSync(tmp, { recursive: true, force: true })

/* ---- 预览动效开关不导出: 只改 autoGlint/autoArc, 生成的 ui_task.c/h 必须逐字节相同 ---- */
{
  const mkPlan = (anim) => ({
    items: [{ id: 'r', kind: 'ring', name: 'ring_1', page: 0, x: 0, y: 0, w: 240, h: 240,
              ring: { gear: 2, dir: 1, value: 26, steps: 40, glintOn: true, glintMs: 100, ...anim } }],
    skipped: [], screen: { w: 240, h: 240 }, pagePeriods: { 0: { period: 200 } },
  })
  const off = mkPlan({ autoGlint: false, autoArc: false })
  const on = mkPlan({ autoGlint: true, autoArc: true, glintArcPx: 16 })
  const files = (p2) => [taskCodeFor(p2, { scrW: 240, scrH: 240 }), taskHeaderFor(p2), userHeaderFor(p2), tableHeaderFor(p2)].join('\n@@\n')
  const a = files(off), b = files(on)
  ok('预览动效开关不导出: 开与关生成的 ui_task.c/h 逐字节相同 (只有网页预览受影响)',
     a === b && a.includes('Ring_Start(RING_GEAR_DEF, RING_DIR_DEF)') && !/autoArc|autoGlint|glintArcPx/.test(b))
}

/* ---- 删页: 指向它的定时跳转要改指"图层的新家" ---- */
{
  const pages = { '-4': { jumpMs: 800, jumpTo: 2 }, 0: { period: 200 }, 1: { jumpMs: 500, jumpTo: 9 } }
  const r = retargetJumps(pages, 2, 0)
  ok('删页: 跳向被删页的跳转改指新家 (LOGO 的 jumpTo 2 → 0), 别的跳转不动',
     r['-4'].jumpTo === 0 && r['-4'].jumpMs === 800 && r['1'].jumpTo === 9 && pages['-4'].jumpTo === 2)
}

/* ---- 整理页号: 占位空页压掉, 图层归属与跳转目标一起重编号 (特殊页不动) ---- */
{
  const items = [{ id: 'ring', page: 9 }, { id: 'a', page: 0 }]
  const pages = { 0: { period: 200 }, 2: { period: 300 }, '-4': { jumpMs: 800, jumpTo: 2 }, 9: {} }
  const r = compactPlanPages(items, pages)
  ok('整理页号: 用到的页压成 0..k (第 9 页的圆环 → 2, 第 2 页有设置所以保留)',
     r.items.length === 1 && r.items[0].id === 'ring' && r.items[0].page === 2 &&
     Object.keys(r.pages).filter(k => +k >= 0).sort().join(',') === '0,1,2')
  ok('整理页号: 跳转目标跟着重编号 (LOGO -4 的 jumpTo 2 → 1), 特殊页自己的号不动',
     r.pages['-4'] && r.pages['-4'].jumpTo === 1 && r.pages['-4'].jumpMs === 800)
  const r2 = compactPlanPages([{ id: 'x', page: 3 }], {})
  ok('整理页号: 只有一层在第 3 页 → 压到第 0 页 (列表回到 1 页)',
     r2.items[0].page === 0 && r2.items[0].pages === undefined)
}

/* ---- 删页: 图层挪到哪 (纯函数; 面板的「删除」按钮走同一份规则) ---- */
{
  const items = [{ id: 'a', page: 2 }, { id: 'b', pages: [0, 2], page: 0 },
                 { id: 'c', pages: [1, 2], page: 1 }, { id: 'd', page: 0 }]
  const r = retargetAfterPageRemove(items, 2, 0)
  ok('删页: 只在被删页上的图层 → 整层挪到第 0 页 (素材/帧不受影响)',
     r.length === 3 && r[0].id === 'a' && r[0].page === 0 && r[0].pages === undefined)
  ok('删页: 还在别的页上的图层 → 只收窄 pages, 不改它的第一页',
     r.some(x => x.id === 'b' && x.page === 0 && x.pages === undefined))
  ok('删页: 不在被删页上的图层不动', !r.some(x => x.id === 'd'))
  ok('删页: 删第 0 页时, 还有别页的层保留别的页 (只去掉 0); 只在 0 页的层留在 0',
     JSON.stringify(retargetAfterPageRemove(items, 0, 0)) ===
       JSON.stringify([{ id: 'b', pages: undefined, page: 2 }, { id: 'd', pages: undefined, page: 0 }]))
}

/* ---- 页面绘制的 z 序 (2026-10-12 修) ----
 * 数字区域是**整格涂底**的 (LCD_drawGrayImage 连 g=0 的像素也发底色), 所以
 * "数字在静态图上面还是下面"必须与网页预览一致。旧版导出把这一页拆成
 * "所有静态帧 → 所有数字", 数字被强制画在最上层: 压在数字上面的静态图会被擦掉几列
 * (参考工程 现场实测: 26x34 的 "S" 被两位数字的格子擦掉左 4~5 列)。
 * 判据: 数字在下、图片在上的 z 序, 进页面与周期刷新都必须照这个顺序画。 */
{
  const zAssets = [
    { id: 'z1', name: 'img', src: 'data:image/png;base64,AA', w: 16, h: 16 },
    { id: 'z2', name: 'num', src: 'data:image/png;base64,CC', w: 8, h: 11, font: { glyphW: 8, glyphH: 11, charset: 'custom' } },
  ]
  /* 数组序 = z 序 (底→顶): 静态图 → 数字 → 压在上面的静态图 (x=12 与数字格 10..25 相交)
   * + 一张 z 序更高但**不相交**的远图 (x=100, 按"只补画相交帧"规则不该进周期回调) */
  const zInst = [
    { id: 'z_below', kind: 'image', name: '下层图', assetId: 'z1', x: 0, y: 0, w: 16, h: 16, fmt: 'GRAY' },
    { id: 'z_num', kind: 'image', name: '数字', assetId: 'z2', x: 10, y: 50, w: 8, h: 11, fmt: 'GRAY',
      bind: { name: 'g_uiVal', dec: 0, cells: 2, align: 2, bg: 0x0000 } },
    { id: 'z_above', kind: 'image', name: '上层图', assetId: 'z1', x: 12, y: 50, w: 16, h: 16, fmt: 'GRAY' },
    { id: 'z_far', kind: 'image', name: '远图', assetId: 'z1', x: 100, y: 50, w: 16, h: 16, fmt: 'GRAY' },
  ]
  const zTask = taskCodeFor(collectLayerPlan(zInst, zAssets, {}), { scrW: 320, scrH: 170 })
  const zEnter = zTask.slice(zTask.indexOf('_Enter(void)'), zTask.indexOf('_Exit(void)'))
  const zCb = zTask.slice(zTask.indexOf('_CB(void *arg)'), zTask.indexOf('void LCD_Page0_Enter'))
  const fBelow = zEnter.indexOf('g_uiFrame0'), fNum = zEnter.indexOf('g_uiFields[0]'),
        fAbove = zEnter.indexOf('g_uiFrame1')
  ok('z 序: 进页面按图层顺序画 (下层图 → 数字 → 上层图 → 远图)',
     fBelow >= 0 && fBelow < fNum && fNum < fAbove && fAbove < zEnter.indexOf('g_uiFrame2'))
  ok('z 序: 数字刷新后补画压在它上面的静态层 (否则每 200ms 又被擦一次)',
     zCb.indexOf('g_uiFields[0]') >= 0 && zCb.indexOf('g_uiFrame1') > zCb.indexOf('g_uiFields[0]'))
  ok('z 序: 数字**下面**的静态层不用重画 (数字本来就压着它)', zCb.indexOf('g_uiFrame0') < 0)
  ok('z 序: z 序在数字上但**不相交**的帧不补画 (各自归动画/静态层管)',
     zCb.indexOf('g_uiFrame2') < 0)
}

/* ---- 导出所有帧: 帧数组 + 按 id 取帧函数 (0=关闭, 1..N=帧) ---- */
{
  const items = [
    { id: 'm1', key: 'g_uiFrame0_ext', kind: 'image', name: '模式图标', assetId: 'a1', x: 8, y: 8, w: 48, h: 48, fmt: 'RGB565', ext: true, color: 0xFFFF, frame: 1,
      allFrames: { fn: 'mode_icon', count: 3, gray: false, ext: true } },
  ]
  const plan = { items, screen: { w: 320, h: 170 }, pagePeriods: {} }
  const fontC = fontFileFor(plan, { extStore: true, coord16: true })
  const head = tableHeaderFor(plan, { coordMax: 320 })
  ok('所有帧: 取帧函数 = 判 0 填底色 + 大数组偏移直取 (无逐帧 switch/指针表)',
     /void mode_icon\(uint16_t x, uint16_t y, uint8_t id, uint16_t color, uint16_t bg\)/.test(fontC) &&
     fontC.includes('if (id == 0u) { LCD_Fill(x, y, (uint16_t)(x + 48), (uint16_t)(y + 48), bg); return; }') &&
     fontC.includes('LCD_drawImage(x, y, 48, 48, MODE_ICON_P(g_uiFrame0_ext) + (uint32_t)(id - 1u) * (uint32_t)48 * 48 * 2u, color)') &&
     fontC.includes('if (id > 3u) return;') && !fontC.includes('case 1:'))
  ok('所有帧: ui_table.h 给出大数组 extern + 函数原型 (uint16 坐标)',
     head.includes('extern const uint16_t g_uiFrame0_ext[];') &&
     !head.includes('g_uiFrame0_ext_f1[') &&
     head.includes('void mode_icon(uint16_t x, uint16_t y, uint8_t id, uint16_t color, uint16_t bg);'))
  ok('所有帧: 坐标 #if 哨兵在头文件里 (uint8 静默截断的兜底)',
     head.includes('#define UI_EXP_COORD_MAX  320u') && head.includes('#error'))
  const tbl2 = tableForPlan(plan)
  ok('所有帧: 帧表 .px = 数组首地址 + .index = 选中的帧号 (偏移不再烘进 .px, 由固件算)',
     tbl2.includes('.px = g_uiFrame0_ext,') && tbl2.includes('.index = 1') &&
     !/\+\s*\d+,/.test(tbl2) && !tbl2.includes('_f1'))
  ok('所有帧: 帧表项里的 .index 与 UI_DrawStatic 的注释都写明是第几帧',
     /第 2\/3 帧 \(选帧走 \.index\)/.test(tbl2), tbl2.split('void UI_DrawStatic')[1])
  /* 取帧偏移一律按**字节**: 内部 RGB (2B/px) / 内部灰度 (1B/px) / 外部灰度 (打包 uint16)
   * 三种存储宽度都靠 const uint8_t* + 每帧字节数, 不能按元素宽度算。 */
  const one = (patch) => {
    const it = { id: 'x', key: 'g_uiFrame7_int', kind: 'image', name: '帧图', x: 0, y: 0, w: 5, h: 3,
                 fmt: 1, ext: false, color: 0xFFFF, frame: 0,
                 allFrames: { fn: 'frm', count: 2, gray: true, ext: false }, ...patch }
    return frameFunctionBlocks({ items: [it] })
  }
  const intGray = one({})
  ok('所有帧偏移: 内部灰度 = 每帧 w*h 字节 (5×3=15, 奇数也不多跳)',
     intGray.includes('FRM_P(g_uiFrame7_int) + (uint32_t)(id - 1u) * (uint32_t)5 * 3, color, 0') &&
     intGray.includes('#define FRM_P(v) ((const uint8_t *)(uintptr_t)(v))'))
  const extGray = one({ key: 'g_uiFrame7_ext', ext: true, allFrames: { fn: 'frm', count: 2, gray: true, ext: true } })
  ok('所有帧偏移: 外部灰度 (打包 uint16) 也按字节 = w*h, 不按 ceil(w*h/2) 元素',
     extGray.includes('FRM_P(g_uiFrame7_ext) + (uint32_t)(id - 1u) * (uint32_t)5 * 3, color, 0'))
  const intRgb = one({ fmt: 0, allFrames: { fn: 'frm', count: 2, gray: false, ext: false } })
  ok('所有帧偏移: 内部 RGB = 每帧 w*h*2 字节 (BE 字节对)',
     intRgb.includes('FRM_P(g_uiFrame7_int) + (uint32_t)(id - 1u) * (uint32_t)5 * 3 * 2u, color)'))
  const extRgb = one({ fmt: 0, key: 'g_uiFrame7_ext', ext: true,
                       allFrames: { fn: 'frm', count: 2, gray: false, ext: true } })
  ok('所有帧偏移: 外部 RGB = 每帧 w*h*2 字节 (uint16 元素, 按字节地址跳)',
     extRgb.includes('FRM_P(g_uiFrame7_ext) + (uint32_t)(id - 1u) * (uint32_t)5 * 3 * 2u, color)'))
}


/* ---- 仅素材 (assetOnly): 导出像素/帧表, 但不进任何页的 Enter ---- */
{
  const aInst = [
    { id: 'a_logo', kind: 'image', name: 'LOGO', assetId: 'a0', x: 0, y: 0, w: 32, h: 32, fmt: 'RGB565' },
    { id: 'a_mode', kind: 'image', name: '模式图标', assetId: 'a1', x: 8, y: 8, w: 48, h: 48, fmt: 'RGB565', assetOnly: true },
    { id: 'a_batt', kind: 'image', name: '电池', assetId: 'a2', x: 270, y: 8, w: 40, h: 24, fmt: 'GRAY', assetOnly: true },
  ]
  const aAssets = [
    { id: 'a0', name: 'logo', w: 32, h: 32 },
    { id: 'a1', name: 'mode', w: 48, h: 48 },
    { id: 'a2', name: 'batt', w: 40, h: 24 },
  ]
  const plan = collectLayerPlan(aInst, aAssets, {})
  const task = taskCodeFor(plan, { scrW: 320, scrH: 170 })
  const enter = task.slice(task.indexOf('_Enter(void)'), task.indexOf('_Exit(void)'))
  const table = tableForPlan(plan, { coordMax: 320 })
  const head = tableHeaderFor(plan, { coordMax: 320 })
  ok('仅素材: 进页 Enter 一个都不画 (LOGO 照画, 模式/电池不出现)',
     enter.includes('UI_DrawFrame(&g_uiFrame0') &&
     !/g_uiFrame1|g_uiFrame2/.test(enter))
  ok('仅素材: 帧表条目照常生成 (g_uiFrame1/2 在 ui_table.c/h 里, 固件按名自取)',
     table.includes('g_uiFrame1') && table.includes('g_uiFrame2') &&
     head.includes('g_uiFrame1') && head.includes('g_uiFrame2'))
  ok('仅素材: plan 项带上 assetOnly 标记 (页面清单按它过滤)',
     plan.items.filter(i => i.assetOnly).length === 2)
  /* UI_DrawStatic() 与 Enter 同一口径: 仅素材的层不进这里 (但帧表条目仍在) */
  const ds = table.slice(table.indexOf('void UI_DrawStatic(void)'))
  ok('仅素材: UI_DrawStatic() 里也不画它 (以前会画 —— 帧表条目还在, 固件按需自取)',
     /UI_DrawFrame\(&g_uiFrame0/.test(ds) && !/UI_DrawFrame\(&g_uiFrame1/.test(ds) && !/UI_DrawFrame\(&g_uiFrame2/.test(ds) &&
     /g_uiFrame1 \(模式图标 · 仅素材\)/.test(ds) && /g_uiFrame2 \(电池 · 仅素材\)/.test(ds), ds.split('\n').slice(-4).join(' | '))
}

/* ---- 帧号语义: 0..N-1 = 第几帧; -1 = 仅网页渲染 (MCU 侧 .index=255 清底色) ---- */
{
  const mk = (o) => ({ kind: 'image', fmt: 1, color: 0xFFFF, lineH: 0, mirror: 0, ext: false, bind: null, ...o })
  const plan = {
    skipped: [],
    items: [
      mk({ id: 'p0', key: 'g_uiFrame0_int', name: '底图', x: 0, y: 0, w: 8, h: 8, frame: 0 }),
      /* -1 (仅网页渲染): 照样进 DrawStatic, MCU 侧按 .index=255 清底色 */
      mk({ id: 'p1', key: 'g_uiFrame1_int', name: '清底', x: 8, y: 0, w: 8, h: 8, frame: -1 }),
      /* 中间夹一个仅素材: 它不进 DrawStatic, 但序号 g_uiFrame2 必须留给它 */
      mk({ id: 'p2', key: 'g_uiFrame2_ext', name: '素材', x: 24, y: 0, w: 8, h: 8, ext: true, frame: 0, assetOnly: true }),
      mk({ id: 'p3', key: 'g_uiFrame3_ext', name: '图标', x: 32, y: 0, w: 48, h: 24, ext: true, frame: 1,
           allFrames: { fn: 'icon', count: 14, gray: false, ext: true } }),
    ],
  }
  const table = tableForPlan(plan)
  const ds = table.slice(table.indexOf('void UI_DrawStatic(void)'))
  ok('帧=-1: 帧表 .index = 255 (MCU 侧清底色), 不是"不画"',
     /const UI_FRAME_REF g_uiFrame1 = \{[\s\S]*?\.index = 255\s*\};/.test(table))
  ok('帧=-1: 照样进 UI_DrawStatic (DrawStatic 只看「仅素材」)',
     /UI_DrawFrame\(&g_uiFrame1, UI_COLOR_WHITE\);\s*\/\* 清底 · 帧=-1: 仅网页渲染 — MCU 只清底色 \*\//.test(ds), ds)
  ok('跳过的仅素材层仍占序号: 画的是 g_uiFrame0/1/3, 没有 g_uiFrame2 的调用',
     /UI_DrawFrame\(&g_uiFrame0/.test(ds) && /UI_DrawFrame\(&g_uiFrame3/.test(ds) &&
     !/UI_DrawFrame\(&g_uiFrame2,/.test(ds) && /g_uiFrame2 \(素材 · 仅素材\)/.test(ds))
  ok('多帧层: .px = 数组首地址 + .index = 1 (偏移交给固件按 .index 算)',
     /\.px = g_uiFrame3_ext,/.test(table) && /const UI_FRAME_REF g_uiFrame3 = \{[\s\S]*?\.index = 1\s*\};/.test(table) &&
     !/g_uiFrame3_ext \+/.test(table))
  ok('单帧层 .index = 0 (数组里就选中那一张图)',
     /const UI_FRAME_REF g_uiFrame0 = \{[\s\S]*?\.index = 0\s*\};/.test(table))
  ok('UI_DrawStatic 注释写明"第 2/14 帧 (选帧走 .index)"',
     /UI_DrawFrame\(&g_uiFrame3, UI_COLOR_WHITE\);\s*\/\* 图标 · 第 2\/14 帧 \(选帧走 \.index\) \*\//.test(ds), ds)
  /* Enter 与 DrawStatic 同一口径: -1 的层进, 仅素材的不进 */
  const enter = taskCodeFor(plan, { scrW: 320, scrH: 170 })
  const seg = enter.slice(enter.indexOf('_Enter(void)'), enter.indexOf('_Exit(void)'))
  ok('Enter 口径相同: -1 (清底) 进 Enter, 仅素材不进',
     /g_uiFrame1/.test(seg) && /g_uiFrame3/.test(seg) && !/g_uiFrame2/.test(seg), seg)
}

/* ---- 数字字模: 数据与代码分文件, 按图层的「外部」选择分流 ---- */
{
  const mk = (o) => ({ kind: 'image', fmt: 1, color: 0xFFFF, lineH: 0, mirror: 0, ext: false, bind: null, ...o })
  const glyphs = new Uint8Array(8 * 11 * 10).fill(3)
  const numFont = { name: 'g_uiFont_g_uiExt0', w: 8, h: 11, gap: 1, first: 48, count: 10, bytes: glyphs }
  const mkPlan = (ext) => ({ skipped: [], items: [
    mk({ id: 'n', key: 'g_uiExt0', name: '数字', x: 100, y: 46, w: 17, h: 11, ext, frame: 0,
         bind: { type: 'num', name: 'g_uiVal', dec: 0, cells: 2, align: 2, pad: 0, bg: 0 }, fontTable: numFont }),
  ] })
  const filesOf = (ext) => Object.fromEntries(planToFiles(mkPlan(ext), () => ({ gray: new Uint8Array(17 * 11) }), {}).files.map(f => [f.name, f.text]))
  const extF = filesOf(true), intF = filesOf(false)
  ok('字模(外部层): 数组进 ui_assets_ext.c (uint16 + UI_EXT_RO, 不带 static); ui_font.c 里一个数组都没有',
     /^const uint16_t g_uiFont_g_uiExt0Glyph\[440\] UI_EXT_RO = \{/m.test(extF['ui_assets_ext.c']) &&
     /const UI_FONT g_uiFont_g_uiExt0 = \{ \.glyph = g_uiFont_g_uiExt0Glyph/.test(extF['ui_font.c']) &&
     !/Glyph\[\d+\]/.test(extF['ui_font.c']))
  ok('字模(内部层): 同样的字库落在 ui_assets_int.c (uint8), 结构体仍在 ui_font.c',
     /^const uint8_t g_uiFont_g_uiExt0Glyph\[880\] = \{/m.test(intF['ui_assets_int.c']) &&
     !/Glyph\[\d+\]/.test(intF['ui_font.c']) && !/Glyph\[\d+\]/.test(intF['ui_assets_ext.c']))
  ok('ui_table.h 按同样的分流宣告字模数组 (类型必须与定义一致)',
     /extern const uint16_t g_uiFont_g_uiExt0Glyph\[\];/.test(extF['ui_table.h']) &&
     /extern const uint8_t g_uiFont_g_uiExt0Glyph\[\];/.test(intF['ui_table.h']))
  ok('素材文件里没勾外部时不含 UI_EXT_RO (内外部由图层选择决定, 与其它素材同一规则)',
     !intF['ui_assets_int.c'].includes('UI_EXT_RO') &&
     /#include "ui_user\.h"/.test(extF['ui_assets_ext.c']))
}

/* ---- 仅尺寸 (sizeOnly): 只留坐标/尺寸 (.px = 0), 像素不进 flash; 与仅素材一起选则像素照导 ---- */
{
  const mk = (o) => ({ kind: 'image', fmt: 1, color: 0xFFFF, lineH: 0, mirror: 0, ext: true, bind: null,
                       x: 224, y: 52, w: 48, h: 24, frame: 0, ...o })
  const modes = {
    普通: mk({ id: 'n1', key: 'g_uiExt1', name: '普通' }),
    仅素材: mk({ id: 'n2', key: 'g_uiExt2', name: '仅素材', assetOnly: true }),
    仅尺寸: mk({ id: 'n3', key: 'g_uiExt3', name: '仅尺寸', sizeOnly: true }),
    仅尺寸仅素材: mk({ id: 'n4', key: 'g_uiExt4', name: '仅尺寸仅素材', sizeOnly: true, assetOnly: true }),
  }
  const run = (it) => {
    const plan = { skipped: [], items: [it], pagePeriods: {} }
    const table = tableForPlan(plan)
    const { files } = planToFiles(plan, () => ({ rgb: new Uint16Array(48 * 24).fill(1) }), { scrW: 320, scrH: 170 })
    const byName = Object.fromEntries(files.map(f => [f.name, f.text]))
    const ds = table.slice(table.indexOf('void UI_DrawStatic'))
    return {
      table, ds,
      pxZero: /\.px = 0,/.test(table),
      inAssets: /const uint16_t g_uiExt\d+\[/.test(byName['ui_assets_ext.c']),
      declared: /extern const uint16_t g_uiExt\d+\[\];/.test(byName['ui_table.h']),
      drawn: /UI_DrawFrame\(&g_uiFrame0/.test(ds),
      task: taskCodeFor(plan, { scrW: 320, scrH: 170 }),
    }
  }
  const N = run(modes.普通), A = run(modes.仅素材), S = run(modes.仅尺寸), B = run(modes.仅尺寸仅素材)
  ok('普通层: .px 指向素材数组, 进 DrawStatic',
     !N.pxZero && N.inAssets && N.declared && N.drawn)
  ok('仅素材: .px 照常指向数组, 但不进 DrawStatic (像素仍是固件自取的抓手)',
     !A.pxZero && A.inAssets && A.declared && !A.drawn)
  ok('仅尺寸: .px = 0 + 素材不导出 + 不声明 extern + 不进 DrawStatic (链接器把数组回收)',
     S.pxZero && !S.inAssets && !S.declared && !S.drawn &&
     !/g_uiExt\d+\[/.test(S.task))
  ok('仅尺寸+仅素材: .px 仍是 0, 但像素**照常导出**并声明 (多导入素材给固件按名自取)',
     B.pxZero && B.inAssets && B.declared && !B.drawn)
  ok('仅尺寸: 帧表条目仍在 (固件按名取坐标/尺寸), DrawStatic 注释里注明模式',
     /const UI_FRAME_REF g_uiFrame0 = \{[\s\S]*?\.px = 0,[\s\S]*?\};/.test(S.table) &&
     /不进这里[\s\S]*仅尺寸/.test(S.ds) && /仅尺寸\+仅素材/.test(B.ds))
}

console.log(`\n${fails ? '有失败' : '全部通过'} (fail=${fails})`)
process.exit(fails ? 1 : 0)
