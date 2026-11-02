/*
 * 光晕 (外发光) 自检 (零依赖: node scripts/check-glow.mjs)
 *
 * 覆盖:
 *   1) addGlowLike 的纯行为: 关掉逐字节不变 / 取大(只加不减) / 钳位 / 阈值 / 随距离衰减
 *   1b) 死区: σ≲0.36 时高斯核退化成 [0,1,0] ⇒ 逐字节 no-op 且不留白
 *   1c) 抗锯齿不被吹白 (2026-10-17 从加性改取大的原因)
 *   2) 光晕**溢出原格子** ⇒ 必须留白 (glowPadOf = ceil(3σ)); 不留就会被切平
 *   3) 接线: 三条造字路 (固定文本/数字/ASCII) 都叠了光晕, 且**在斜坡与抖动之后**
 *   4) 关掉时格子尺寸与字节不变 (老工程逐字节兼容)
 *   5) ASCII 字库的缓存键带了光晕参数 (不带就会拿到上一份没光晕的字库)
 *
 * 这条检查的重点是"**关掉 = 与以前完全相同**" —— 光晕是新功能, 默认关,
 * 老工程重新打开必须一个字节都不差, 否则导出会整体漂移。
 */
import fs from 'node:fs'

const { addGlowLike, glowPadOf, cropGray } = await import('../src/imageproc.js')

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}

/* ---------- 1. 纯行为 ---------- */
const W = 25, H = 25
const dot = new Uint8Array(W * H)
const cx = 12, cy = 12
dot[cy * W + cx] = 255

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

ok('σ=0 → 严格 no-op (逐字节不变)', same(addGlowLike(dot, W, H, 40, 0, 1), dot))
ok('增益=0 → 严格 no-op (逐字节不变)', same(addGlowLike(dot, W, H, 40, 4, 0), dot))
ok('σ<0 → 严格 no-op', same(addGlowLike(dot, W, H, 40, -3, 1), dot))

const g = addGlowLike(dot, W, H, 40, 3, 1)
ok('亮部中心钳在 255', g[cy * W + cx] === 255)
const at = (d) => g[cy * W + (cx + d)]
ok('点亮处四周真的出现光晕 (左侧 1px > 0)', at(-1) > 0, `= ${at(-1)}`)
ok('光晕随距离衰减', at(-1) > 0 && at(-1) >= at(-3) && at(-3) > at(-6),
   `${at(-1)} ≥ ${at(-3)} > ${at(-6)}`)
let farMax = 0
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (Math.abs(x - cx) > 3 * 3 + 1 || Math.abs(y - cy) > 3 * 3 + 1) {
      farMax = Math.max(farMax, g[y * W + x])
    }
  }
}
ok('3σ 之外基本无光 (≤2)', farMax <= 2, `max = ${farMax}`)

let le = true, ge = true
for (let i = 0; i < g.length; i++) { if (g[i] > 255) le = false; if (g[i] < dot[i]) ge = false }
ok('不溢出 255', le)
ok('取大: 只加不减 (结果处处 ≥ 原值)', ge)

/* 阈值: 40 灰的整片图, 阈值 200 时不该发光 —— 取大混合下均匀场永远不变
 * (光晕只能出现在比它**暗**的地方; 一片均匀的 40 灰没有暗处可发光) */
const flat = new Uint8Array(W * H).fill(40)
ok('阈值 200 时 40 灰不发光 (全 40)', addGlowLike(flat, W, H, 200, 3, 1).every(v => v === 40))
ok('阈值 0 时均匀场也不被抬高 (取大: 无暗处可发光)',
   addGlowLike(flat, W, H, 0, 3, 1).every(v => v === 40))

/* ---------- 1b. 死区: σ≲0.36 高斯核退化成 [0,1,0] ⇒ 逐字节 no-op ---------- */
/* 一条真实形状的抗锯齿斜坡 (MiSans @40px 的 '8' 左边缘实测值: 0,0,75,231,255) */
const ramp = new Uint8Array(W * H)
for (let y = 0; y < H; y++) {
  ramp[y * W + 0] = 0; ramp[y * W + 1] = 0
  ramp[y * W + 2] = 75; ramp[y * W + 3] = 231
  for (let x = 4; x < W; x++) ramp[y * W + x] = 255
}
ok('死区 σ=0.1 → 逐字节 no-op (与关掉完全相同)',
   same(addGlowLike(ramp, W, H, 40, 0.1, 1), ramp))
ok('死区 σ=0.2 → 逐字节 no-op', same(addGlowLike(ramp, W, H, 40, 0.2, 1), ramp))
{
  const s3 = addGlowLike(ramp, W, H, 40, 0.3, 1)
  const dmax = Math.max(...[...ramp].map((v, i) => Math.abs(s3[i] - v)))
  ok('死区 σ=0.3 → 最大偏差 ≤1 (邻点权重仅 0.4%, 只是舍入抖动)', dmax <= 1, `maxΔ ${dmax}`)
}
ok('死区不留白 σ=0.1 → pad 0 (不白拉字距)', glowPadOf(40, 0.1, 1, true) === 0)
ok('死区不留白 σ=0.3 → pad 0', glowPadOf(40, 0.3, 1, true) === 0)
ok('σ=0.5 起才留白', glowPadOf(40, 0.5, 1, true) === 2, `σ=0.5 → ${glowPadOf(40, 0.5, 1, true)}`)

/* ---------- 1c. 抗锯齿不能被光晕吹白 ----------
 * 旧实现是加性: out = src + mask, 而 mask(v) ≤ v 恒成立 ⇒ 相加只会抬高字迹自己的斜坡。
 * 实测 (MiSans @40px '8'): 142 个 AA 像素被吹白 66 个, 扫描线 [75,231] → [117,255], 纯黑处 0 像素被点亮。 */
{
  const s1 = addGlowLike(ramp, W, H, 40, 1, 1)
  const lb = [2, 3].map(i => `${ramp[i]}→${s1[i]}`).join(', ')
  ok('σ=1: 抗锯齿斜坡像素抬升 ≤40 (加性时 75→178)', [2, 3].every(i => s1[i] - ramp[i] <= 40), lb)
  ok('σ=1: 斜坡像素无一被吹到 ≥250', [2, 3].every(i => s1[i] < 250), lb)
  let zlit = 0
  for (let i = 0; i < s1.length; i++) if (ramp[i] === 0 && s1[i] >= 20) zlit++
  ok('σ=1: 纯黑处真的被点亮 (确实有光晕)', zlit > 0, `${zlit} px`)
}

/* ---------- 2. 溢出原格子 ⇒ 必须留白 ---------- */
const pad = glowPadOf(40, 3, 1, true)
ok('glowPadOf = ceil(3σ)', pad === 9, `σ=3 → ${pad}`)
ok('关掉时留白 = 0', glowPadOf(40, 3, 1, false) === 0)
ok('增益 0 时留白 = 0 (不白留空间)', glowPadOf(40, 3, 0, true) === 0)

/* 把亮点贴在 1px 宽的窄条边缘: 不留白 → 光晕被切; 留白 → 光晕完整 */
function stripGlow(extraPad) {
  const w = 1 + 2 * extraPad, h = 1 + 2 * extraPad
  const v = new Uint8Array(w * h)
  v[extraPad * w + extraPad] = 255
  const out = addGlowLike(v, w, h, 40, 3, 1)
  /* 边缘一格与紧邻它的内侧一格之差: 被切平的话两者相等 (斜率为 0) */
  return Math.abs(out[extraPad * w + extraPad] - out[extraPad * w + (w - 1)])
}
ok('不留白 → 光晕在边界被切平 (贴边值与中心同高)', stripGlow(0) === 0, `差 ${stripGlow(0)}`)
ok('留白 3σ → 光晕在到达边界前已衰减掉', stripGlow(pad) > 0, `差 ${stripGlow(pad)}`)

/* ---------- 2b. 紧排: 裁回原格子 (cropGray) ---------- */
{
  const W = 5, H = 4
  const v = new Uint8Array(W * H)
  for (let i = 0; i < v.length; i++) v[i] = i + 1
  const c = cropGray(v, W, H, 1, 1, 3, 2)
  ok('cropGray: 从 (1,1) 裁 3×2, 像素原样搬过去',
     c.length === 6 && [...c].join(',') === [7, 8, 9, 12, 13, 14].join(','), [...c].join(','))
  ok('cropGray: 越界补 0 (不越界读)', cropGray(v, W, H, -1, -1, 2, 2).length === 4 &&
     [...cropGray(v, W, H, -1, -1, 2, 2)].join(',') === '0,0,0,1')
  ok('cropGray: 空输入/零尺寸 → 空数组 (不崩)', cropGray(null, 0, 0, 0, 0, 0, 0).length === 0)
}

/* ---------- 3/4/5. 接线检查 (与工程其它自检同一口径: 读源码断言) ---------- */
const store = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')
const dlg = fs.readFileSync(new URL('../src/components/TextDialog.vue', import.meta.url), 'utf8')
const proc = fs.readFileSync(new URL('../src/imageproc.js', import.meta.url), 'utf8')

const numFn = store.slice(store.indexOf('export function numFontForSys'),
                          store.indexOf('export function numFontForSys') + 12000)
const asciiFn = store.slice(store.indexOf('export function asciiFontForSys'),
                            store.indexOf('export function asciiFontForSys') + 9000)

ok('数字字库: 叠了光晕 (withGlow)', /withGlow\(vals, p\.w, p\.h, glow\)/.test(numFn))
ok('ASCII 字库: 叠了光晕 (withGlow)', /withGlow\(vals, p\.w, p\.h, glow\)/.test(asciiFn))
ok('数字字库: 出格尺寸带 pad (GW/GH)', /numFontFromGlyphs\(glyphs, key, GW, GH/.test(numFn))
ok('ASCII 字库: 出格尺寸带 pad (GW/GH)', /numFontFromGlyphs\(glyphs, '', GW, GH/.test(asciiFn))
/* 光晕必须在斜坡/抖动**之后** —— 在之前会被抖动重新重量化, 光晕上平添网点 */
const numOrder = numFn.indexOf('ditherGray565(vals, p.w, p.h)') < numFn.indexOf('withGlow(vals')
ok('数字字库: 光晕在斜坡/抖动之后', numOrder && /blurGray\([^)]*\)[\s\S]*withGlow\(vals/.test(numFn))
ok('ASCII 字库: 光晕在斜坡/抖动之后',
   /blurGray\([^)]*\)[\s\S]*withGlow\(vals/.test(asciiFn))
/* 三条路共用一个归一化口径 */
ok('三条路共用 glowCfg 归一', (store.match(/glowCfg\(cfg\)/g) || []).length >= 3)
ok('固定文本: syncSysSize 走 sysGlowCanvas', /const cv = sysGlowCanvas\(inst\.sysfont\)/.test(store))
ok('固定文本: instanceProc 走 sysGlowCanvas', /const rc = sysGlowCanvas\(inst\.sysfont\)/.test(store))
ok('ASCII 字库缓存键带光晕参数',
   /'asciisys'[\s\S]{0,400}glow\.on, glow\.thresh, glow\.sigma, glow\.gain/.test(store))
ok('数字字库缓存键带整个 cfg (自动含光晕)', /JSON\.stringify\(\['numsys', cfg, key\]\)/.test(store))
/* 字体迟到后要把**两层**缓存都清掉 (只清 sysRenderCache 会留下用回退字体画的光晕画布) */
{
  const fn = store.slice(store.indexOf('export function clearSysFontCache'), store.indexOf('export function clearSysFontCache') + 300)
  ok('清字体缓存时光晕画布一起清', /sysRenderCache\.clear\(\)[\s\S]{0,200}sysGlowCache\.clear\(\)/.test(fn))
}

/* 默认关 + σ 即开关 + UI 落在 σ 下方 */
ok('addGlowLike 默认参数是"低增益可关"', /export function addGlowLike\(values, gw, gh, thresh = 40, sigma = 4, gain = 1\)/.test(proc))
/* 2026-10-17 起光晕**没有独立开关**: σ 自己就是开关 (与「边缘斜坡 σ」同一写法), 0 = 关 */
ok('glowCfg: σ 默认 0 = 关', /sigma = num\(cfg\.glowSigma, 0, 0, 12\)/.test(store))
/* σ 是唯一的开关: 不再有独立的 `glow` 布尔 (2026-10-17 那条兼容闸已删 —— 它从没进过任何已发布工程) */
ok('glowCfg: σ 自己就是开关 (σ>0 且增益>0 才发光)',
   /const on = sigma > 0 && gain > 0/.test(store))
ok('对话框默认关闭 (GLOW_DEFAULTS.glowSigma = 0)',
   /GLOW_DEFAULTS = \{ glowThresh: 40, glowSigma: 0, glowGain: 1, glowFit: false \}/.test(dlg))
ok('sysCfg 送出三个光晕字段, 且不再有独立开关',
   /glowThresh[\s\S]{0,220}glowSigma[\s\S]{0,220}glowGain/.test(dlg) && !/glow: !!draft\.glow/.test(dlg))
ok('切到"字库素材"层会清掉光晕残留', /Object\.assign\(draft, GLOW_DEFAULTS\)\s*\/\* 光晕是系统字专有/.test(dlg))
/* 回填按数字兜 0 —— σ 是唯一开关, 且 0 是合法值 (不能用 `|| 默认`),
 * 同时确认已废弃的独立开关字段在读写两侧都彻底不在了 */
ok('老图层回填: σ 按数字兜 0, 已废弃的独立开关字段不再读写',
   /glowSigma: Math\.max\(0, Math\.min\(12, num0\(it\.sysfont\.glowSigma, 0\)\)\)/.test(dlg)
   && !/draft\.glow\b/.test(dlg) && !/sysfont\.glow\b/.test(dlg))
const iSigma = dlg.indexOf('边缘斜坡 σ</label>')
const iGlow = dlg.indexOf('光晕 σ</label>')
ok('UI: 光晕排在「边缘斜坡 σ」下方同一分支', iSigma > 0 && iGlow > iSigma)
ok('UI: 光晕 σ 是滑条, 0.1 一档 (0 = 关, 无独立开关)',
   /min="0" max="12" step="0\.1" v-model\.number="draft\.glowSigma"/.test(dlg))
ok('UI: 阈值/增益只在 σ>0 时展开', /v-if="\(\+draft\.glowSigma \|\| 0\) > 0"/.test(dlg))

/* ---------- 紧排 (glowFit): 光晕照算, 但裁回原格子 ----------
 * 现场问题: 数字字库每格四周留 ceil(3σ) ⇒ σ=4 时每格 +24px, 字距被拉开;
 * 紧排把带 pad 算完的光晕裁回原格子, 字距与不开光晕时完全一致 (代价: 格子外弱光被切)。
 * 默认 false ⇒ 老工程/DR1152 (σ=0) 一个字节都不变。 */
ok('glowCfg: 紧排默认 false, 且返回值带 fit 字段',
   /const fit = !!cfg\.glowFit/.test(store) &&
   /pad: glowPadOf\(thresh, sigma, gain, on\), fit/.test(store) &&
   /return \{ on: false, thresh: 40, sigma: 0, gain: 1, pad: 0, fit: false \}/.test(store))
ok('数字字库: 紧排时出格 pad=0, 内部仍用 blurPad 算光晕',
   /const glow = glowCfg\(cfg\), blurPad = glow\.pad, pad = glow\.fit \? 0 : blurPad/.test(numFn) &&
   /const TW = cw2 \+ 2 \* blurPad, TH = chh \+ 2 \* blurPad/.test(numFn))
ok('数字字库: 紧排时 cropGray 裁回原格子 (cw×chh)',
   /if \(glow\.fit && blurPad > 0\) vals = cropGray\(vals, p\.w, p\.h, blurPad, blurPad, cw2, chh\)/.test(numFn))
ok('ASCII 字库: 紧排同样裁回原格子 (与数字字库同一口径)',
   /if \(glow\.fit && blurPad > 0\) vals = cropGray\(vals, p\.w, p\.h, blurPad, blurPad, cw2, chh\)/.test(asciiFn))
ok('紧排: 不再按 pad 裁列 (pad=0), 老行为仍走 trimCols (数字=三元, ASCII=对象)',
   /pad > 0 \? \{ trimCols: true \}/.test(numFn) &&
   /trimCols: pad > 0/.test(asciiFn))
ok('ASCII 字库缓存键带紧排 (否则会拿到上一份外扩的字库)',
   /glow\.on, glow\.thresh, glow\.sigma, glow\.gain, glow\.fit/.test(store))
ok('对话框: 紧排只对数字/ASCII 显示, 且默认未勾选',
   /v-if="isNum \|\| isAscii"/.test(dlg) && /v-model="draft\.glowFit"/.test(dlg) &&
   /GLOW_DEFAULTS = \{ glowThresh: 40, glowSigma: 0, glowGain: 1, glowFit: false \}/.test(dlg))
ok('对话框: 提示行直接算出"每格 +2·pad px"与预览倍率 (解释 4px→40px)',
   /每格四周各留/.test(dlg) && /预览 \$\{pvZoom\.value\}x: 屏幕上看/.test(dlg))
ok('对话框: sysCfg 把 glowFit 一起存进这一层',
   /glowFit: !!draft\.glowFit/.test(dlg))

/* 预览倍率: 8x 在 240x240 的屏上看不清一个像素 —— 上限放到 128 且支持任意整数 (无极) */
ok('预览倍率: 档位到 128x (原上限 8x 太小)', /const ZOOM_STEPS = \[1, 2, 4, 8, 16, 32, 64, 128\]/.test(dlg))
ok('预览倍率: 无极输入框 (1~128 任意整数)',
   /v-model\.number="pvZoom"/.test(dlg) && /Math\.min\(ZOOM_MAX, n\)/.test(dlg) && /const ZOOM_MAX = 128/.test(dlg))
ok('预览倍率: 对数滑条 (线性滑条在 1..128 上调不动)',
   /v-model\.number="pvZoomLog"/.test(dlg) && /Math\.log2\(pvZoom\.value\)/.test(dlg) &&
   /type="range" min="0" :max="ZOOM_LOG_MAX" step="0\.05"/.test(dlg))
ok('预览框不再锁死高度 (大倍率能看到细节)',
   !/height: 200px; overflow: auto/.test(dlg) && !/max-height: 120px/.test(dlg))
/* 这是「2x 与 64x 看起来一样」的真因: .pv-img 是 inline-flex, img 作为 flex item
 * 默认 flex-shrink:1, 超过框宽就被缩回去填满框 ⇒ 放大完全没生效。必须 flex:none。 */
ok('预览图不被 flex 缩回 (否则 2x 与 64x 一样宽)',
   /\.pv \{ image-rendering: pixelated; flex: none; \}/.test(dlg))

/* ---------- 6. 列裁剪: 光晕"左右空、上下贴"的直接治具 ----------
 * 桩测不出这个 (合成字形的光晕会一直糊到格边), 所以直接拿 numFontFromGlyphs 单测:
 * 造一对"格子 6 列、只有中间 2 列有墨"的字模 (两侧纯黑 = 光晕在 3σ 处衰减到的尾巴)。 */
const { numFontFromGlyphs } = await import('../src/uiexport.js')
const mkGlyph = (ch, GW = 6, GH = 3) => {
  const v = new Uint8Array(GW * GH)
  for (let r = 0; r < GH; r++) for (let x = 2; x < 4; x++) v[r * GW + x] = 200
  return { ch, values: v }
}
const gl = [mkGlyph('0'), mkGlyph('1')]
const noTrim = numFontFromGlyphs(gl, '', 6, 3, 0, { chars: '01' })
const didTrim = numFontFromGlyphs(gl, '', 6, 3, 0, { chars: '01', trimCols: true })
ok('列裁剪: 默认关 → 格子宽不变, 逐字节老行为', noTrim.w === 6 && noTrim.colTrimmed === false)
ok('列裁剪: 开了 → 裁到墨迹范围 (6 → 2 列)',
   didTrim.w === 2 && didTrim.colTrim[0] === 2 && didTrim.colTrim[1] === 3 && didTrim.colTrimmed === true)
ok('列裁剪: 留下的像素原样搬过去 (没丢墨、没引入黑边)',
   didTrim.bytes.length === 2 * 2 * 3 && [...didTrim.bytes].every(v => v === 200))
/* 与行裁剪同口径: 整组一起裁 ⇒ 字模之间相对位置不变 */
const gl2 = [mkGlyph('0'), { ch: '1', values: (() => {
  const v = new Uint8Array(18); for (let r = 0; r < 3; r++) v[r * 6 + 4] = 200; return v
})() }]
const t2 = numFontFromGlyphs(gl2, '', 6, 3, 0, { chars: '01', trimCols: true })
ok('列裁剪: 整组一起裁 (取并集 2..4), 不按单字各裁各的',
   t2.colTrim[0] === 2 && t2.colTrim[1] === 4 && t2.w === 3)
ok('列裁剪: 整组全空 → 不裁 (保留原格子)', numFontFromGlyphs(
   [{ ch: '0', values: new Uint8Array(18) }], '', 6, 3, 0, { chars: '0', trimCols: true }).w === 6)
ok('接线: 开了光晕才传 trimCols (pad>0); 关光晕时不裁',
   /trimCols: pad > 0/.test(fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')))

/* ---------- 7. 预览: 只有 v=0 的像素透明, 其余不透明; 亮度按 v 压进 RGB ----------
 * 光晕的尾巴只有几十级灰, 铺在不透明黑底上跟纯黑分不出来 —— 用户没法判断"到底扩到哪"。
 * 但**不能拿灰度当 alpha**: 板上没有透明通道, 灰度 10 就是"暗但实心"的红,
 * 当 alpha 会跟棋盘格混出一块半透明的假色。只让出 0 ⇒ 范围可见, 又不把暗部看成半透明。
 * ！RGB 必须按 v 压暗 (2026-10-20 现场: "编辑系统字的预览图失去灰度, 只有黑白两种状态") ——
 *   只二值化 alpha、RGB 写满色的话, AA 边缘/光晕尾巴就只剩"有/没有"两态。 */
ok('tintCanvas 支持 zeroTransparent: v=0 → 透明, 其余不透明且亮度按 v 压进 RGB',
   /export function tintCanvas\(cv, color = 0xFFFF, opt = \{\}\)/.test(proc) &&
   /opt\.zeroTransparent \?/.test(proc) &&
   /const v = \(src\[i\] \/ 255\) \* \(src\[i \+ 3\] \/ 255\)/.test(proc) &&
   /d\[i\] = Math\.round\(r \* v\)/.test(proc) && /d\[i \+ 3\] = v > 0 \? 255 : 0/.test(proc))
ok('renderNumCanvas: 值为 0 的像素先被 continue 跳过 (保持透明), 其余写 255',
   /if \(!g\) continue/.test(proc) && /d\[o \+ 3\] = 255/.test(proc))
ok('预览: 数字 (变量) 主预览不铺 b.bg',
   /renderNumCanvas\(lead == null \? '' : sig, draft\.color, 0xFFFF, f0,/.test(dlg))
ok('预览: 系统字主预览走 zeroTransparent',
   /tintCanvas\(c, draft\.color, \{ zeroTransparent: true \}\)/.test(dlg))
ok('预览: 数字字模 + ASCII 大表都不铺底色',
   /renderNumCanvas\(DIGIT_CHARS, draft\.color, 0xFFFF, numFont\.value\)/.test(dlg) &&
   /renderNumCanvas\(seg, color, 0xFFFF, font\)/.test(dlg))
ok('全局不再有 alphaFromGray (语义已改成"只有 0 透明")',
   !/alphaFromGray/.test(proc + dlg + store))

/* ---------- 8. 图层尺寸也按"看得见的部分"量 ----------
 * 光晕画布整张 alpha=255 (导出合成要用), inkBox 于是量出**整张外扩画布** ⇒
 * 光晕尾巴那几十级灰把图层宽高白白撑大 ("字没变粗, 框大了一圈, 四周全黑")。
 * 固定文本这条路也得量亮度; 关光晕时必须仍走 inkBox (逐字节不变)。 */
ok('inkBoxLit: 按亮度 (max(r,g,b)) 找墨迹, 不是按 alpha',
   /export function inkBoxLit\(cv, min = 0\)/.test(proc) &&
   /Math\.max\(d\[o\], d\[o \+ 1\], d\[o \+ 2\]\) > min/.test(proc))
ok('尺寸: 固定文本 (syncSysSize) 开光晕时量亮度',
   /const box = glowCfg\(inst\.sysfont\)\.on \? inkBoxLit\(cv\) : inkBox\(cv\)/.test(store))
ok('尺寸: 固定文本 (instanceProc 裁切窗口) 用同一个判定',
   /const box = glowCfg\(inst\.sysfont\)\.on \? inkBoxLit\(rc\) : inkBox\(rc\)/.test(store))
ok('尺寸: 关光晕时仍走 inkBox (老工程逐字节不变)',
   (store.match(/glowCfg\(inst\.sysfont\)\.on \? inkBoxLit\(/g) || []).length === 2)

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
