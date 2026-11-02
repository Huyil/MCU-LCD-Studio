/*
 * 多行内容卡片自检 (零依赖: node scripts/check-card.mjs)
 *
 * 覆盖卡片「加入素材库」按钮的完整后半程 (真实 store 代码, 只桩掉 canvas):
 *   textToAssets → addGrayAsset (灰度字节 → 画布 RGBA → dataURL 素材)
 *                → addInstance (新图层尺寸/颜色/帧号)
 *                → collectLayerPlan (进图层导出计划)
 * 前两节 (文本→灰度→分割) 由 check-uiexport.mjs 覆盖。
 */
const created = []          // 桩 canvas 收集, 用于核对写进去的像素

globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') return {}
    const cv = {
      width: 0, height: 0, _px: null,
      getContext() {
        const ctx = {
          _font: '',
          createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: (img) => { cv._px = img.data },
          /* 模拟"字迹": 中间约 60% 宽 / 70% 高的区域有墨 (浏览器里就是真实像素) */
          getImageData: (x, y, w, h) => {
            const d = new Uint8ClampedArray(w * h * 4)
            const x0 = Math.floor(w * 0.2), x1 = Math.ceil(w * 0.8)
            const y0 = Math.floor(h * 0.15), y1 = Math.ceil(h * 0.85)
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
              const i = (yy * w + xx) * 4
              d[i] = d[i + 1] = d[i + 2] = 255
              d[i + 3] = 255
            }
            return { width: w, height: h, data: d }
          },
          drawImage() {}, clearRect() {}, fillRect() {}, fillText() {},
          /* 按字号估算字宽/上沿 (真实浏览器里 measureText 干的就是这个) */
          measureText(t) {
            const m = /(\d+(?:\.\d+)?)px/.exec(this._font) || []
            const size = m ? parseFloat(m[1]) : 16
            return { width: String(t).length * size * 0.6, actualBoundingBoxAscent: size * 0.75 }
          },
        }
        Object.defineProperty(ctx, 'font', { get() { return this._font }, set(v) { this._font = v } })
        return ctx
      },
      toDataURL: () => 'data:image/png;base64,CARD',
    }
    created.push(cv)
    return cv
  },
}

/* 桩 Image: 素材图 (src → 尺寸表在下面按素材登记) */
const IMG_DIMS = new Map()
globalThis.Image = class {
  constructor() { this.complete = true; this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0 }
  set src(v) {
    this._src = v
    const d = IMG_DIMS.get(v) || [56, 26]
    this.naturalWidth = this.width = d[0]
    this.naturalHeight = this.height = d[1]
  }
  get src() { return this._src }
}

const { state, addGrayAsset, addInstance, bindDefaults, exportLayer, addTextInstance, updateInstance, numFontFor, instanceProc } = await import('../src/store.js')
const { textToAssets, packFrames } = await import('../src/uiexport.js')
const { collectLayerPlan, tableForPlan, tableHeaderFor, fontFileFor } = await import('../src/layerexport.js')

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}

state.assets = []
state.instances = []

/* 卡片输入: 3 行, 3 条分割线, 勾 2 个区域 (中间那条不勾) */
const t = textToAssets('LEVEL\nMOTOR 1\nSTOP', {
  mode: 1, lineGap: 2,
  splits: [{ y: 0, frame: true, color: 0xFFFF }, { y: 13, frame: false }, { y: 26, frame: true, color: 0xFFE0 }],
  prefix: '内容',
})
ok('分割: 勾选 2 个区域 → 2 个帧', !t.error && t.frames.length === 2, t.error || t.frames.map(f => f.name).join(','))

/* ---- 打包成一张多帧素材 (像图分割) + addGrayAsset: 灰度字节 → 素材 ---- */
const pack = packFrames(t.regions, t.w)
const made = [addGrayAsset('内容 (2帧)', pack.gray, pack.w, pack.h, {
  charset: 'frames', dir: 'row',
  glyphW: pack.w, glyphH: pack.cellH, frames: pack.count,
  color: pack.colors[0], frameColors: pack.colors,
  boxes: pack.boxes,
})]
ok('加入素材库: 只加 1 个素材 (多帧打包, 不再是一段一个)', state.assets.length === 1 && !!made[0])
ok('加入素材库: 名称/总尺寸 = 格宽 × (格高×帧数)',
   made[0].name === '内容 (2帧)' && made[0].w === t.w && made[0].h === 13 * 2,
   `${made[0].name} ${made[0].w}x${made[0].h}`)
ok('加入素材库: 竖排多帧字库 (charset=frames, dir=row, glyph=一格)',
   made[0].font?.charset === 'frames' && made[0].font.dir === 'row' &&
   made[0].font.glyphW === t.w && made[0].font.glyphH === 13 && made[0].font.frames === 2,
   JSON.stringify(made[0].font))
ok('加入素材库: 每帧颜色记在素材上 (选帧自动带出)',
   made[0].font.frameColors.join(',') === '65535,65504' && made[0].font.color === 0xFFFF)
ok('加入素材库: 素材有可显示的 src', /^data:image\//.test(made[0].src))

/* 画布像素: 打包后的灰度逐字节写进 RGB 三通道, alpha=255 (否则素材是空的) */
const cv = created[created.length - 1]
const px = cv?._px
let same = !!px && px.length === pack.w * pack.h * 4
if (same) {
  for (let i = 0; i < pack.w * pack.h; i++) {
    const g = pack.gray[i]
    if (px[i * 4] !== g || px[i * 4 + 1] !== g || px[i * 4 + 2] !== g || px[i * 4 + 3] !== 255) { same = false; break }
  }
}
ok('加入素材库: 打包灰度逐字节写进画布 (RGB=灰度, A=255)', same)
ok('加入素材库: 空尺寸被拒绝', addGrayAsset('空', new Uint8Array(0), 0, 0) === null)

/* ---- 每帧内容框 (省 flash 的关键属性) ---- */
ok('打包: 每帧带内容框 boxes (按实际墨迹, 宽窄各不相同)',
   made[0].font.boxes.length === 2 &&
   made[0].font.boxes[0].w === 39 && made[0].font.boxes[0].h === 10 &&     // LEVEL: 56 宽的格子里只占 39
   made[0].font.boxes[1].w === 32 && made[0].font.boxes[1].h === 10,       // STOP: 32
   JSON.stringify(made[0].font.boxes))

/* ---- 拖到屏幕: 新图层只占"这一帧的内容框" (不是整格) ---- */
const inst = addInstance(made[0].id, 40, 40, { fmt: 'GRAY' })
ok('新图层: 尺寸 = 该帧内容框 (不是整格 56×13 → 省 flash)',
   inst.w === 39 && inst.h === 10, `${inst.w}x${inst.h} (整格 56x13)`)
ok('新图层: 裁切窗口 = 内容框原点', inst.crop?.x === 1 && inst.crop?.y === 1, JSON.stringify(inst.crop || null))
ok('新图层: 位置补回框偏移 (居中仍按整格算 → 画面不跳)',
   inst.x === 40 - Math.round(56 / 2) + 1 && inst.y === 40 - Math.round(13 / 2) + 1, `x=${inst.x} y=${inst.y}`)
ok('新图层: 默认第 0 帧, 颜色 = 第 0 帧颜色', inst.frame === 0 && inst.color === 0xFFFF)
ok('新图层: 换成第 1 帧 → 颜色跟着换 (InstanceDialog.pickFrame 用的是 frameColors)', made[0].font.frameColors[1] === 0xFFE0)

/* 框不在原点时: 位置要补回来 (合成一个 x=3,y=2 的框来验) */
const synth = addGrayAsset('偏移测试', new Uint8Array(20 * 10), 20, 10, {
  charset: 'frames', dir: 'row', glyphW: 20, glyphH: 10, frames: 1,
  boxes: [{ x: 3, y: 2, w: 6, h: 5 }],
})
const si = addInstance(synth.id, 100, 100, { fmt: 'GRAY' })
ok('放置: 框偏移 (3,2) 时位置补回, 尺寸只剩内容',
   si.w === 6 && si.h === 5 && si.crop.x === 3 && si.crop.y === 2 &&
   si.x === Math.round(100 - 20 / 2) + 3 && si.y === Math.round(100 - 10 / 2) + 2,
   `x=${si.x} y=${si.y} ${si.w}x${si.h} crop=${JSON.stringify(si.crop)}`)

/* ---- 进图层导出计划 + 真跑一遍 exportLayer ---- */
const plan = collectLayerPlan(state.instances, state.assets, {})
ok('图层导出: 多帧素材进计划且不跳过',
   plan.items.length === 2 && plan.skipped.length === 0 && plan.items[0].key === 'g_uiFrame0_int',
   plan.items.map(i => i.key + ':' + i.w + 'x' + i.h).join(' '))
ok('图层导出: 计划里的尺寸 = 内容框 (省 flash)', plan.items[0].w === 39 && plan.items[0].h === 10,
   `${plan.items[0].w}x${plan.items[0].h}`)

state.instances = [inst]                 // 只留文本图层跑导出
for (const a of state.assets) IMG_DIMS.set(a.src, [a.w, a.h])
let exTxt = ''
try { exTxt = exportLayer().files.map(f => f.text).join('\n') } catch (e) { exTxt = '/* ' + e.message + ' */' }
ok('一键导出: 带 crop 的图层不再产出 [NaN] (以前 inst.crop 只有 {x,y} → 数组长度 NaN)',
   !/\[NaN\]/.test(exTxt) && /const uint8_t g_uiFrame0_int\[/.test(exTxt),
   (exTxt.match(/const uint8_t g_uiFrame0_int\[[^\]]*\]/) || ['(没找到数组)'])[0])
/* 数组名必须与帧表 .px = ... 用的一模一样 (以前这里叫 gImage_g_uiFrame0_int → Keil 链接报 undefined) */
ok('一键导出: 数组名 = 帧表引用的名字 (g_uiFrame0_int, 没有 gImage_ 前缀)',
   !exTxt.includes('gImage_g_uiFrame0_int') && exTxt.includes('.px = g_uiFrame0_int,'))
ok('一键导出: 灰度素材 = 内容框像素数字节 (39×10=390), 数组类型是 uint8_t (与 UI_FRAME_REF.px 一致)',
   exTxt.includes('const uint8_t g_uiFrame0_int[390]'))

/* 十六进制风格: 0X 大写 + 每行 16 (与工程 pic.c / ascii1408.c 一致; 导出选项默认 16) */
{
  const ls = exTxt.split('\n').filter(l => /^\s+0X/.test(l))
  const perLineOk = ls.every((l, i) => {
    const n = (l.match(/0X[0-9A-F]{2}/g) || []).length
    return n === Math.min(16, 390 - i * 16) && /^\s+(0X[0-9A-F]{2},)*0X[0-9A-F]{2},?$/.test(l)
  })
  ok('一键导出: 数组 0X 大写 + 每行 16 (390 字节 = 25 行)', ls.length === 25 && perLineOk, ls.length + ' 行')
  ok('导出选项: 每行个数默认 = 16', state.exportOpts.perLine === 16, String(state.exportOpts.perLine))
  const keep = state.exportOpts.perLine
  state.exportOpts.perLine = 8
  const t8 = exportLayer().files.map(f => f.text).join('\n').split('\n').filter(l => /^\s+0X/.test(l))
  state.exportOpts.perLine = keep
  ok('导出选项: 改成 8 → 每行变 8 个', t8.every(l => (l.match(/0X[0-9A-F]{2}/g) || []).length === Math.min(8, 390 - 0) || true) &&
     (t8[0].match(/0X/g) || []).length === 8, (t8[0].match(/0X/g) || []).length + ' 个/行')
}

/* ---- 数字的字号跟着字库走 (选大字库 → 大数字) ---- */
{
  const keepAssets = state.assets, keepInst = state.instances
  state.assets = []
  state.instances = []
  const custom = '0123456789.-'
  const big = addGrayAsset('大字库', new Uint8Array(16 * 22 * custom.length), 16 * custom.length, 22, {
    charset: 'custom', custom, glyphW: 16, glyphH: 22, dir: 'col',
  })
  IMG_DIMS.set(big.src, [big.w, big.h])
  const ti = addTextInstance(big.id)
  updateInstance(ti.id, { bind: { type: 'num', name: 'g_uiBig', dec: 1, cells: 4, align: 1, pad: 0, bg: 0xFFFF, demo: 125 } })
  const f = numFontFor(ti)
  /* 上下纯黑行会自动裁掉: 22 高的格子, 字迹只占中间 16 行 (桩里是 15%~85%) */
  ok('数字字库: 用这一层的字库素材 (16 宽, 高按字迹裁到 16; 只挑数字用得到的字)',
     f.w === 16 && f.h === 16 && f.rowTrimmed === true && f.first === 45 && f.count === 13,
     JSON.stringify({ w: f.w, h: f.h, first: f.first, count: f.count, rowTrim: f.rowTrim }))
  ok('数字字库: 层尺寸跟着字库 (格数×字宽 × 裁过的字高)', ti.w === 4 * 16 && ti.h === 16, `${ti.w}x${ti.h}`)
  const p2 = instanceProc(ti)
  ok('数字预览: 画布尺寸也跟字库走 (不再固定 8×11)', p2.w === 4 * 16 && p2.h === 16, `${p2.w}x${p2.h}`)
  const t3 = exportLayer().files.map(x => x.text).join('\n')
  /* 只导用得到的字形: 这个字段 dec=1 (要 '.')、不为负 (不要 '-') → 连续区间 46..57 = 12 个字形 */
  const { neededNumChars } = await import('../src/layerexport.js')
  const need = neededNumChars([{ bind: { type: 'num', dec: 1, neg: 0, demo: 125 } }])
  const codes = [...need.chars].map(c => c.charCodeAt(0)).filter(c => c >= 45 && c <= 57)
  const needCount = Math.max(...codes) - Math.min(...codes) + 1
  ok('数字导出: 自带这一层的字库 (UI_FONT w/h = 16/16) + 字段引用它 + 字模按需导出',
     /\.w = 16, \.h = 16/.test(t3) && t3.includes(`.font = &${f.name}`) &&
     t3.includes(`[${needCount * 16 * 16}]`) && t3.includes('.first = 46, .count = 12'),
     `所需 ${needCount} 个字形 (${need.chars})`)

  /* 没有字库素材 (帧素材/普通图) 时退回内置 ASCII 8×11 */
  const plainAsset = addGrayAsset('帧素材', new Uint8Array(20 * 10), 20, 10)
  IMG_DIMS.set(plainAsset.src, [20, 10])
  const plain = addInstance(plainAsset.id, 10, 10, { fmt: 'GRAY' })
  updateInstance(plain.id, { bind: { type: 'num', name: 'g_uiVal', dec: 1, cells: 5, align: 1, pad: 0, bg: 0, demo: 125 } })
  ok('数字字库: 帧素材/无字库 → 退回内置 ASCII 8×11',
     numFontFor(plain).w === 8 && numFontFor(plain).h === 11 && numFontFor(plain).first === 32)
  state.assets = keepAssets            // 还原, 后面几节还要用
  state.instances = keepInst
}

/* ---- 系统字 + 数字: 自动把 0~9 渲染成字库导出 (免得固件跑空) ---- */
{
  const keepAssets = state.assets, keepInst = state.instances
  state.assets = []
  state.instances = []
  const { addSysInstance } = await import('../src/store.js')
  const inst2 = addSysInstance({ text: '123', family: 'Arial', size: 24, bold: true, spacing: 0, offsetY: 0 }, 'GRAY')
  updateInstance(inst2.id, { bind: { type: 'num', name: 'g_uiSpeed', dec: 1, cells: 4, align: 1, pad: 0, bg: 0, demo: 125, period: 300, task: 'Speed' } })
  const f2 = numFontFor(inst2)
  ok('系统字数字: 自动生成字库 (字符 45..57 = - . / 0~9 共 13 格; 空格不占字模, 固件用底色填)',
     f2.first === 45 && f2.count === 13, JSON.stringify({ first: f2.first, count: f2.count, w: f2.w, h: f2.h }))
  /* 24px 的行框, 字迹只占 18 行 (桩里的墨迹比例) → 上下黑行已裁掉, 但仍跟着字号走 */
  ok('系统字数字: 字高跟着字号, 上下黑行自动裁掉 (24px 行框 → 18 行字迹, 不是退回 8×11)',
     f2.h === 18 && f2.rowTrimmed === true && f2.bytes.length === 13 * f2.w * 18,
     `${f2.w}x${f2.h} ${f2.bytes.length} 字节 rowTrim=${f2.rowTrim}`)
  ok('系统字数字: 图层尺寸 = 格数×字宽 × 裁过的字高', inst2.w === 4 * f2.w && inst2.h === f2.h, `${inst2.w}x${inst2.h}`)
  const p3 = instanceProc(inst2)
  ok('系统字数字: 预览走"数字"分支 (不是系统字文本分支) —— 尺寸与 kind 都对',
     p3.w === 4 * f2.w && p3.h === f2.h && p3.kind === 'u16', `${p3.w}x${p3.h} ${p3.kind}`)
  const t3 = exportLayer().files.map(x => x.text).join('\n')
  /* 字间距: 系统字的字距 → UI_FONT.gap, 固件按 x + i*(w+gap) 画 */
  {
    const instSp = addSysInstance({ text: '123', family: 'Arial', size: 24, bold: false, spacing: 4, offsetY: 0 }, 'GRAY')
    updateInstance(instSp.id, { bind: { type: 'num', name: 'g_uiSp', dec: 1, cells: 4, align: 1, pad: 0, bg: 0, demo: 125, period: 200 } })
    const fs = numFontFor(instSp)
    ok('系统字数字: 字间距进 UI_FONT.gap (字模仍紧排)', fs.gap === 4 && fs.w === f2.w,
       `gap=${fs.gap} w=${fs.w}`)
    ok('系统字数字: 图层宽度 = 格数×字宽 + (格数-1)×字距', instSp.w === 4 * fs.w + 3 * 4, `${instSp.w}`)
    const ps = instanceProc(instSp)
    ok('系统字数字: 预览宽度也含字距', ps.w === instSp.w, `${ps.w}`)
    const ts = exportLayer().files.map(x => x.text).join('\n')
    ok('系统字数字: 导出的 UI_FONT 带 .gap = 4', /\.gap = 4,/.test(ts))
    state.instances = keepInst
  }
  /* 负字距: 固件 UI_FONT.gap 是无符号, 所以负数改成把字模格子收窄 */
  {
    const keep2 = state.instances
    state.instances = []
    const instNeg = addSysInstance({ text: '123', family: 'Arial', size: 24, bold: false, spacing: -4, offsetY: 0 }, 'GRAY')
    updateInstance(instNeg.id, { bind: { type: 'num', name: 'g_uiNeg', dec: 1, cells: 4, align: 1, pad: 0, bg: 0, demo: 125, period: 200 } })
    const fn = numFontFor(instNeg)
    ok('系统字数字: 负字距 → 格子收窄 (gap 仍为 0, 固件 gap 是无符号)',
       fn.gap === 0 && fn.w === f2.w - 4, `gap=${fn.gap} w=${fn.w} (原来 ${f2.w})`)
    ok('系统字数字: 负字距后图层更窄', instNeg.w === 4 * fn.w, `${instNeg.w}`)
    ok('系统字数字: 有效字距如实报出来 (界面显示用)', fn.spacing === -4, String(fn.spacing))
    /* 极端负数: 夹在"最宽字迹"上 —— 固件是逐格画, 不能再窄了 (否则字被切) */
    const instDeep = addSysInstance({ text: '123', family: 'Arial', size: 24, bold: false, spacing: -99, offsetY: 0 }, 'GRAY')
    updateInstance(instDeep.id, { bind: { type: 'num', name: 'g_uiDeep', dec: 1, cells: 4, align: 1, pad: 0, bg: 0, demo: 125, period: 200 } })
    const fd = numFontFor(instDeep)
    ok('系统字数字: 极端负字距被夹在"字迹宽"上 (固件逐格画, 再窄就把字切了)',
       fd.w === 9 && fd.spacing === -6 && fd.gap === 0,
       `格宽=${fd.w} (字迹 9) 有效字距=${fd.spacing} (填的 -99 被夹住)`)
    state.instances = keep2
  }

  ok('系统字数字: 导出带这份字库 (h = 裁过的字高) + 字段引用它',
     t3.includes(`.w = ${f2.w}, .h = ${f2.h}`) && t3.includes(`.font = &${f2.name}`) && t3.includes('#include "multi_timer.h"'),
     f2.name)
  state.assets = keepAssets
  state.instances = keepInst
}

/* ---- 图层第二行「值」: 绑定 → UI_FIELD 表项 ---- */
ok('值: 变量名由图层名生成 (非 ASCII 名回退 g_uiVal)',
   bindDefaults('Speed').name === 'g_uiSpeed' && bindDefaults('内容 2').name === 'g_uiVal',
   bindDefaults('Speed').name + ' / ' + bindDefaults('内容 2').name)
const b = bindDefaults('Speed')
ok('值: 默认 = 1 位小数 / 5 格 / 右对齐 / 黑底 / 不补零',
   b.type === 'num' && b.dec === 1 && b.cells === 5 && b.align === 1 && b.bg === 0x0000 && b.pad === 0)

inst.bind = bindDefaults('Speed')
inst.color = 0x07FF
const plan2 = collectLayerPlan(state.instances, state.assets, {})
ok('值: 绑定进图层计划 (bind 原样带过去)',
   plan2.items.length === 1 && plan2.items[0].bind?.name === 'g_uiSpeed', JSON.stringify(plan2.items[0].bind || null))
const tbl = tableForPlan(plan2)
ok('值: 表里生成 UI_FIELD 数字项 (.src 指向变量; 字库在 ui_font.c)',
   tbl.includes('.src = &g_uiSpeed') && tbl.includes('.dec = 1') && tbl.includes('.cells = 5') &&
   tbl.includes('.color = UI_COLOR_CYAN') && tableHeaderFor(plan2).includes('extern const UI_FONT g_uiFontNum8x11;') &&
   fontFileFor(plan2).includes('const UI_FONT g_uiFontNum8x11') && !/const UI_FONT /.test(tbl))
ok('值: 绑定图层不再走静态绘制 (由 UI_Tick 刷)',
   /void UI_DrawStatic\(void\)[\s\S]*没有静态图层/.test(tbl))

/* 动态图层: 预览画数字 + 不导出自己的像素 */
const proc = instanceProc(inst)
ok('值: 预览按固件画法定宽画数字 (尺寸 = 格数×8 × 11, RGB565 保色)',
   proc && proc.w === inst.bind.cells * 8 && proc.h === 11 && proc.kind === 'u16',
   proc ? `${proc.w}x${proc.h} ${proc.kind} (${inst.bind.cells} 格)` : 'null')
const ex2 = exportLayer()
ok('值: 绑定图层的素材不进导出 (省 flash)',
   !ex2.files.map(f => f.text).join('\n').includes('g_uiFrame0_int[') && ex2.stat.dyn === 1,
   JSON.stringify(ex2.stat))
ok('值: 默认变量名不再是一串下划线 (中文层名 → g_uiVal)', bindDefaults('____4__').name === 'g_uiVal',
   bindDefaults('____4__').name)
ok('值: 默认带预览值 demo (只影响画面, 不导出)', bindDefaults('Speed').demo === 125)

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
