<script setup>
/*
 * 文字 / 数字 / 系统字 —— 一个弹窗管三种"文字类"图层 (原 TextDialog + SysFontDialog 合并):
 *
 *   来源 = 字库素材   → 用已拆分的字库拼字 (或选任意素材就地"拆分为字库")
 *         内容 = 固定文本 (拼成一条图导出) / 数字 (固件用字库刷变量, 字号跟着字库走)
 *   来源 = 系统字库   → 用系统字体渲染文字成图 (字号/粗体/字距/上下偏移)
 *
 * 顶部固定: 来源 / 字库 / 函数名 —— 函数名既是数组名, 也是"按 ID 取图"的调用函数名。
 */
import { ref, reactive, computed, watch, nextTick } from 'vue'
import ColorField from './ColorField.vue'
import {
  state, screen, addTextInstance, addSysInstance, updateInstance, removeInstance,
  fontCells, fontGlyphValues, pushRecentColor, escCStr,
  renderSysFontCanvas, sysGlowCanvas, WIN_FONTS, loadFontFile, numFontForSys,
  BUILTIN_FONTS, DEFAULT_FONT, weightsOf, weightName, fontInfo, isVariableFont, weightRangeOf,
  ensureFont, clearSysFontCache, asciiFontForSys, ASCII_PRINTABLE, ASCII_FIRST, ASCII_COUNT, glowCfg,
} from '../store.js'
import { sanitizeName, renderTemplate } from '../template.js'
import { COLORS, QUICK_COLORS, colorByName, nearestColorName, rgb565To888, rgb888To565 } from '../colors.js'
import { processImage, renderNumCanvas, tintCanvas, inkBox } from '../imageproc.js'
import SysFontTuneDialog from './SysFontTuneDialog.vue'
import { neededNumChars } from '../layerexport.js'
import { formatNumText, formatNumSig, numFieldLead, numFontFromGlyphs, builtinNumFont, idDrawFunction,
         asciiStrFunction, numLayout, cVarRef } from '../uiexport.js'
import { copyText, downloadCanvasPng } from '../utils.js'
import { imageFileName } from '../frameshoot.js'

/** 多帧画板文字编辑模式: 传入 group-layer + group-open, 复用同一个面板;
 *  确定时不写 state.instances, 只 emit 文字配置给多帧画板。 */
const props = defineProps({
  groupLayer: { type: Object, default: null },
  groupOpen: { type: Boolean, default: false },
})
const emit = defineEmits(['group-apply', 'group-close'])
const groupMode = computed(() => !!(props.groupOpen && props.groupLayer))

const show = ref(false)
const isNew = ref(false)
/* 光晕默认值: 四个键一起改, 免得某处漏了某个键导致"上一个图层的值传染过来"。
 * ！光晕**没有独立开关**了: σ 自己就是开关 (与「边缘斜坡 σ」同一写法), 默认 0 = 关。
 * glowFit (紧排) 只对数字/ASCII 字库有意义: 光晕照算, 但裁回原格子, 字距不变。 */
const GLOW_DEFAULTS = { glowThresh: 40, glowSigma: 0, glowGain: 1, glowFit: false }
/* 老图层没有这些键 → 显式回填默认 (0 是合法值, 不能用 `|| 默认` 兜) */
const num0 = (v, d) => (Number.isFinite(+v) ? +v : d)

const draft = reactive({
  id: null,
  source: 'asset',            // 'asset' 字库素材 | 'system' 系统字库
  assetId: null,
  name: 'str1',               // 数组名 / 调用函数名
  /* 内容 (三选一; 只在"来源=系统字库"时有 ASCII 那一项):
   *   'fixed' 固定文本: 把这一串渲染成一条图导出
   *   'num'   数字 (变量): 固件用字库刷变量
   *   'ascii' ASCII 字库: 整份 0x20~0x7E 渲染成字模表 + <名字>Str() (固件打任意字符串) */
  content: 'fixed',
  bind: { name: 'g_uiVal', dec: 1, cells: 5, align: 1, pad: 0, bg: 0x0000, demo: 125 },
  text: 'ABC', spacing: 0,
  family: DEFAULT_FONT, size: 20, weight: 400, bold: false, offsetY: 0, lineGap: 0, rampSigma: 0,
  evenSpacing: false,         // 等距: 字模格子按最宽字迹定宽 + 每字按字迹居中 (仅 数字/ASCII 字库)
  glyphDx: {},                // 系统字逐字左右微调 { '0': -1, ... } (px; 数字/ASCII/固定文本共用)
  ...GLOW_DEFAULTS,
  x: 0, y: 0, fmt: 'GRAY', color: 0xFFFF, fullSet: false,
  idFn: true,                 // 是否导出「按 ID 取图」的调用函数
})
const isNum = computed(() => draft.content === 'num')
const isAscii = computed(() => draft.content === 'ascii')

/* 系统字微调窗: 数字/ASCII 直接看字模叠加; 固定文本没有独立字模表, 偏移作用在整串渲染 */
const tuneOpen = ref(false)
const tuneChars = computed(() => {
  if (isNum.value) return [...DIGIT_CHARS]
  if (isAscii.value) return [...ASCII_PRINTABLE]
  return [...new Set([...String(draft.text || '')])].filter(ch => ch !== '\n' && ch !== '\r' && ch !== '\t')
})
const tuneFont = computed(() => (isNum.value ? numFont.value : (isAscii.value ? asciiFont.value : null)))

/* 多帧画板: 打开/切换目标文字层 → 回填到同一个 draft */
watch(() => [props.groupOpen, props.groupLayer], ([open, layer]) => {
  if (!open || !layer) return
  const l = layer
  const src = l.source === 'asset' ? 'asset' : 'system'
  const aid = l.assetId || (src === 'asset' ? (state.assets.find(a => a.font && a.font.charset !== 'frames')?.id || null) : null)
  Object.assign(draft, {
    id: null, source: src, content: 'fixed', assetId: aid,
    text: String(l.text ?? ''), family: l.family || DEFAULT_FONT,
    size: Math.max(4, Math.min(200, Math.round(+l.size || 24))),
    weight: Math.max(100, Math.min(900, Math.round(+l.weight || (l.bold ? 700 : 400)))),
    bold: !!l.bold,
    spacing: Math.round(+l.spacing || 0), offsetY: Math.round(+l.offsetY || 0),
    lineGap: Math.round(+l.lineGap || 0), rampSigma: Math.max(0, Math.min(2, +l.rampSigma || 0)),
    glowThresh: Math.round(Math.max(0, Math.min(255, num0(l.glowThresh, 40)))),
    glowSigma: Math.max(0, Math.min(12, num0(l.glowSigma, 0))),
    glowGain: Math.max(0, Math.min(4, num0(l.glowGain, 1))),
    glowFit: !!l.glowFit,
    glyphDx: {},
    color: (l.color == null ? 0xFFFF : l.color) & 0xFFFF,
    fullSet: !!l.fullSet,
    fmt: 'GRAY', x: Math.round(+l.x || 0), y: Math.round(+l.y || 0),
  })
  isNew.value = false
  show.value = true
  nextTick(syncHex)   /* colorHex 在 setup 后面才初始化 */
}, { immediate: true })
/* 多帧画板只支持固定文本; 防止残留的 num/ascii 状态把面板切到不支持的页 */
watch(() => [groupMode.value, draft.content], ([g, c]) => {
  if (g && c !== 'fixed') draft.content = 'fixed'
})
const pvZoomRaw = ref(1)
/* 预览倍率: 上限 128, 允许任意整数 (无极) —— 8x 在 240x240 的屏上看不清一个像素。
 * 用可写 computed 而不是裸 ref: number 输入框可以直接敲倍率, 这里统一钳到 1..128。 */
const ZOOM_MAX = 128
const pvZoom = computed({
  get: () => pvZoomRaw.value,
  set: (v) => {
    const n = Math.round(+v)
    pvZoomRaw.value = Number.isFinite(n) ? Math.max(1, Math.min(ZOOM_MAX, n)) : 1
  },
})
/* 滑条走「对数刻度」。线性滑条在 1..128 上会让 1~16 全挤在第一格, 调不动。
 * 滑条值 = log2(倍率), 范围 0..7 (2^7=128), 步进 0.05 ≈ 每格 3.5%。 */
const ZOOM_LOG_MAX = Math.log2(ZOOM_MAX)
const pvZoomLog = computed({
  get: () => Math.log2(pvZoom.value),
  set: (v) => { const n = +v; if (Number.isFinite(n)) pvZoom.value = Math.round(2 ** n) },
})
const ZOOM_STEPS = [1, 2, 4, 8, 16, 32, 64, 128]
const colorHex = ref('#ffffff')
const copied = ref('')
const fontFile = ref(null)
const provisional = ref(null)   // 新建时先落地的实例 (取消要删掉, 免得留一个看不见的图层)

const sc = screen
const winFonts = WIN_FONTS
const sysFontList = ref(WIN_FONTS)
const canQueryLocal = typeof window !== 'undefined' && !!window.queryLocalFonts
/* 已列在下拉里的字体 (内置 + 系统清单). 工程里用的是清单外的字体 (DSEG7 / 自己加载的 ttf) 时,
 * <select> 找不到对应 option 会显示空白, 看着像"字体被换成了 MiSans" —— 补一个"当前字体"项。 */
const fontKnown = computed(() => new Set([...BUILTIN_FONTS.map(f => f.family), ...sysFontList.value]))

/* 素材全列出来, 标出哪些已经是字库 (没拆分的就地拆分)。
 * 排除自动生成的「文字」快照 (没有 font, 选了也不能当字库用). */
const assetOptions = computed(() => state.assets.filter(a => !a.derivedText).map(a => ({
  id: a.id,
  name: a.name,
  font: (a.font && a.font.charset !== 'frames') ? a.font : null,
})))
const asset = computed(() => state.assets.find(a => a.id === draft.assetId) || null)
const fontReady = computed(() => !!(asset.value?.font && asset.value.font.charset !== 'frames'))

/* 数字用的字库: 跟这一层的字库素材走 (没字库才退回内置 ASCII 8×11) */
const numFont = computed(() => {
  if (draft.source === 'system') {
    const f = numFontForSys(sysCfg(), sanitizeName(draft.name) || 'Num')
    if (f) return f
    return builtinNumFont()
  }
  if (draft.source === 'asset' && fontReady.value) {
    const a = asset.value
    const f = numFontFromGlyphs(fontGlyphValues(a, 'GRAY'), sanitizeName(draft.name) || 'Num', a.font.glyphW, a.font.glyphH)
    if (f) return f
  }
  return builtinNumFont()
})
const numText = computed(() => formatNumText(draft.bind.demo, draft.bind.dec, draft.bind.cells, draft.bind.pad))
/* 这一层实际会用到哪些字形 —— 字库只导这些 (用不到的 '-' '.' '/' 不再进 flash) */
const exportChars = computed(() => neededNumChars([{ bind: draft.bind }]).chars)
const exportCharsDesc = computed(() => {
  const c = exportChars.value
  const parts = ['0-9']
  if (c.includes('.')) parts.push("'.'")
  if (c.includes('-')) parts.push("'-'")
  if (!c.includes('.') && !c.includes('-')) parts.push('无小数/负号')
  return parts.join(' + ')
})

/* ---- 三个入口: 编辑文字 / 编辑系统字 / 新建 ---- */
watch(() => [state.ui.dialogTextId, state.ui.dialogTextNew, state.ui.dialogSysId, state.ui.dialogSysNew],
  ([tid, tNew, sid, sNew]) => {
    if (tid) {
      const it = state.instances.find(i => i.id === tid && i.kind === 'text')
      if (!it) return
      Object.assign(draft, { ...it })
      draft.rampSigma = 0   /* 字库素材层的 σ 跟素材走 (字库拆分弹窗), 清掉上一次编辑的残留 */
      Object.assign(draft, GLOW_DEFAULTS)   /* 光晕是系统字专有: 切到字库素材层必须清掉残留 */
      draft.source = 'asset'
      draft.idFn = it.idFn !== false
      const bnd = (it.bind && (it.bind.type || 'num') === 'num') ? it.bind : null
      draft.content = bnd ? 'num' : 'fixed'
      if (bnd) draft.bind = { name: 'g_uiVal', dec: 1, cells: 5, align: 1, pad: 0, bg: 0x0000, demo: 125, ...bnd }
      isNew.value = false
      syncHex(); show.value = true; state.ui.dialogTextNew = false
    } else if (sid) {
      const it = state.instances.find(i => i.id === sid && i.sysfont)
      if (!it) return
      /* 注意: x/y 在实例上 (不在 sysfont 里) —— 拖拽后双击编辑必须重新读一遍,
       * 否则弹窗里显示的是上一次的坐标, 点确定就把图层挪回旧位置 */
      Object.assign(draft, {
        id: it.id, name: it.name, fmt: it.fmt, color: it.color,
        ...it.sysfont,
        /* ！σ 必须显式回填: 老图层的 sysfont 没有 rampSigma 键, {...it.sysfont} 展开不会覆盖
         * draft 里的旧值 —— 上一个图层的 0.7 会"传染"到这里, 点确定就写进本层 (2026-10-13 现场bug) */
        rampSigma: Math.max(0, Math.min(2, +it.sysfont.rampSigma || 0)),
        /* 同上: 光晕四键 + 等距也必须显式回填 (老图层没有这些键)。
         * σ 默认 0 = 关 —— 2026-10-17 起 σ 自己就是开关, 那个老的 `glow` 开关字段从没进过任何工程。 */
        glowThresh: Math.round(Math.max(0, Math.min(255, num0(it.sysfont.glowThresh, 40)))),
        glowSigma: Math.max(0, Math.min(12, num0(it.sysfont.glowSigma, 0))),
        glowGain: Math.max(0, Math.min(4, num0(it.sysfont.glowGain, 1))),
        glowFit: !!it.sysfont.glowFit,
        evenSpacing: !!it.sysfont.evenSpacing,
        glyphDx: (it.sysfont.glyphDx && typeof it.sysfont.glyphDx === 'object') ? { ...it.sysfont.glyphDx }
          : (it.sysfont.digitDx && typeof it.sysfont.digitDx === 'object' ? { ...it.sysfont.digitDx } : {}),
        x: Math.round(+it.x || 0), y: Math.round(+it.y || 0),
      })
      draft.source = 'system'
      /* 系统字图层也可能是"数字"(bind) 或 "ASCII 字库"(ascii): 打开时必须按它的实际状态回填,
       * 否则每次都显示成固定文本 */
      const bnd = (it.bind && (it.bind.type || 'num') === 'num') ? it.bind : null
      draft.content = it.ascii ? 'ascii' : (bnd ? 'num' : 'fixed')
      if (bnd) draft.bind = { name: 'g_uiVal', dec: 1, cells: 5, align: 1, pad: 0, bg: 0x0000, demo: 125, ...bnd }
      isNew.value = false
      syncHex(); show.value = true; state.ui.dialogSysNew = false
    } else if (tNew) {
      state.ui.dialogTextNew = false
      const a = assetOptions.value.find(x => x.font)
      if (a) {
        const inst = addTextInstance(a.id)
        Object.assign(draft, { ...inst })
        draft.source = 'asset'
        provisional.value = inst.id          // 还没点确定: 取消就删掉
      } else {
        Object.assign(draft, {
          id: null, source: 'system', content: 'fixed',
          assetId: state.assets[0]?.id || null,
          name: autoName('asset'),
          fmt: 'GRAY', color: 0xFFFF, text: 'ABC', spacing: 0,
          family: DEFAULT_FONT, size: 20, weight: 400, bold: false, offsetY: 0, lineGap: 0, rampSigma: 0,
          evenSpacing: false, glyphDx: {},
          ...GLOW_DEFAULTS,
        })
      }
      draft.content = 'fixed'
      isNew.value = true
      syncHex(); show.value = true
    } else if (sNew) {
      state.ui.dialogSysNew = false
      Object.assign(draft, {
        id: null, source: 'system', content: 'fixed',
        name: autoName('system', draft.family),
        fmt: 'GRAY', color: 0xFFFF,
        text: 'ABC', family: DEFAULT_FONT, size: 20, weight: 400, spacing: 0, offsetY: 0, bold: false, rampSigma: 0,
        evenSpacing: false, glyphDx: {},
        ...GLOW_DEFAULTS,
      })
      isNew.value = true
      syncHex(); show.value = true
    }
  }, { immediate: true })

function close() {
  tuneOpen.value = false
  show.value = false
  const wasGroup = groupMode.value
  state.ui.dialogTextId = null
  state.ui.dialogSysId = null
  if (provisional.value) { removeInstance(provisional.value); provisional.value = null }
  if (wasGroup) emit('group-close')
}

async function enumLocalFonts() {
  try {
    const fonts = await window.queryLocalFonts()
    sysFontList.value = [...new Set(fonts.map(f => f.family))]
  } catch (e) { alert('枚举系统字体失败: ' + e.message) }
}
async function onFontFile(e) {
  const f = e.target.files[0]
  e.target.value = ''
  if (!f) return
  try { draft.family = await loadFontFile(f) } catch (err) { alert('字体加载失败: ' + err.message) }
}

/* ---- 颜色 ---- */
function syncHex() {
  const v = draft.color & 0xFFFF
  const r = (((v >> 11) & 0x1F) * 255 / 31) | 0
  const g = (((v >> 5) & 0x3F) * 255 / 63) | 0
  const b = ((v & 0x1F) * 255 / 31) | 0
  colorHex.value = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
}
function applyHex() {
  const m = /^#?([0-9a-f]{6})$/i.exec(colorHex.value.trim())
  if (!m) return
  const n = parseInt(m[1], 16)
  draft.color = rgb888To565((n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF)
  pushRecentColor(draft.color)
}
function pickColorName(n) {
  const v = colorByName(n)
  if (v !== undefined) { draft.color = v; pushRecentColor(v); syncHex() }
}
const shownColor = ref(0xFFFF)
let nameTimer = null
watch(() => draft.color, c => {
  clearTimeout(nameTimer)
  nameTimer = setTimeout(() => (shownColor.value = c & 0xFFFF), 400)
}, { immediate: true })
const colorName = computed(() => nearestColorName(shownColor.value))
const colorExact = computed(() => COLORS.find(c => c.v === (draft.color & 0xFFFF))?.n || '')
const color565Text = computed(() => '0x' + (draft.color & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'))
const swCss = (name) => { const v = colorByName(name); if (v === undefined) return '#888'; const { r, g, b } = rgb565To888(v); return `rgb(${r},${g},${b})` }

/* ---- 尺寸 ---- */
function sysCfg() {
  return {
    text: String(draft.text || ''), family: draft.family,
    size: Math.max(4, Math.round(+draft.size) || 20),
    spacing: Math.round(+draft.spacing) || 0, offsetY: Math.round(+draft.offsetY) || 0,
    lineGap: Math.round(+draft.lineGap) || 0,
    weight: Math.max(100, Math.min(900, Math.round(+draft.weight || 400))),
    bold: !!draft.bold,
    /* 边缘斜坡 σ(px): 跟着**这一层自己的字库**走 (2026-10-13 现场: 大数字斜边/圆弧台阶;
     * 浏览器给的字形 AA 只有 ~1px, 只能靠高斯柔化摊宽)。0 = 不变。 */
    rampSigma: Math.max(0, Math.min(2, +draft.rampSigma || 0)),
    /* 光晕: 与 σ 同一层口径 —— 烘进字节, 固件不改。σ 自己就是开关: 0 = 关 (字节与以前逐字节相同) */
    glowThresh: Math.round(Math.max(0, Math.min(255, num0(draft.glowThresh, 40)))),
    glowSigma: Math.max(0, Math.min(12, num0(draft.glowSigma, 0))),
    glowGain: Math.max(0, Math.min(4, num0(draft.glowGain, 1))),
    /* 紧排: 只对数字/ASCII 字库生效 —— 光晕照算, 但裁回原格子, 字距/图层尺寸不变 */
    glowFit: !!draft.glowFit,
    /* 等距: 字模格子按**最宽字迹**定宽 + 每字按**字迹**居中 (见 store.js numFontForSys/asciiFontForSys) */
    evenSpacing: !!draft.evenSpacing,
    glyphDx: { ...(draft.glyphDx || {}) },
  }
}
/* 光晕占位提示: σ=4 → 每边 ceil(12)=12px, 数字/ASCII 每格 +24px —— 这就是"4px 看着像 40px"的来源。
 * 预览倍率再乘一遍: 10x 预览里 12px 显示成 120px。 */
const glowPad = computed(() => {
  try { return glowCfg(sysCfg()).pad } catch (e) { return 0 }
})
/* 实际占位 (来自 store 的 numFontForSys/asciiFontForSys): 开光晕前 baseW → 现在 w。
 * 比"理论 +2·pad"准: trimCols 会裁掉发黑的尾列, σ=4 的 DSEG7 实际是每格 +20px (2 格 +40px)。 */
const glowCell = computed(() => {
  if (!(isNum.value || isAscii.value)) return null
  const f = isNum.value ? numFont.value : asciiFont.value
  if (!f || !Number.isFinite(+f.baseW) || !Number.isFinite(+f.w)) return null
  const base = +f.baseW, now = +f.w
  return { base, now, grow: now - base }
})
function glowHint() {
  const s = +draft.glowSigma || 0
  if (s < 0.36) return 'σ < 0.36 = 高斯不足一个像素, 不扩散 (等同关)'
  const p = glowPad.value
  const gc = glowCell.value
  if (draft.glowFit && (isNum.value || isAscii.value)) {
    return `每格 ${gc ? gc.base : '原'}px 不变 (光晕在格子边缘截断)`
  }
  if (gc && gc.grow > 0) {
    const cells = isNum.value ? Math.max(1, Math.round(+draft.bind.cells || 1)) : 0
    const total = cells ? `; ${cells} 格整块 +${gc.grow * cells}px` : ''
    return `每格 ${gc.base}→${gc.now}px (字距 +${gc.grow}px)${total}; 勾「紧排」可不扩`
  }
  if (isNum.value || isAscii.value) {
    return `每格四周各留 ${p}px → 字距最多 +${2 * p}px; 勾「紧排」可不扩`
  }
  return `画布四周各留 ${p}px (整层 +${2 * p}px, 字间不变)`
}
function glowZoomHint() {
  const p = glowPad.value
  if (!p || pvZoom.value <= 1) return ''
  return `预览 ${pvZoom.value}x: 屏幕上看 ${p * pvZoom.value}px`
}
const metrics = computed(() => {
  if (isNum.value) {
    const l = numLayout(draft.bind, numFont.value)
    return { w: Math.max(1, l.w), h: l.h }
  }
  if (draft.source === 'system') {
    /* 系统字 (含 ASCII 字库模式): 尺寸 = 这一层显示的示例文本 —— ASCII 字库那 95 个字模
     * 不占版面, 板上由固件按 <名字>Str() 自己选位置/字符串 */
    try {
      /* ！走 sysGlowCanvas: 光晕会外扩画布, 这里的 w/h 就是界面上显示的图层尺寸,
       *   用未加光晕的画布量就会**少报** (光晕被当成画布外的部分裁掉)。 */
      const cv = sysGlowCanvas(sysCfg())
      return cv ? { w: cv.width, h: cv.height } : { w: 0, h: 0 }
    } catch (e) { return { w: 0, h: 0 } }      // 非浏览器环境 (SSR 自检) 没有 canvas
  }
  if (!fontReady.value) return { w: 0, h: 0 }
  const a = asset.value
  const len = [...String(draft.text || '')].length
  const sp = Math.round(+draft.spacing || 0)
  return { w: len * a.font.glyphW + Math.max(0, len - 1) * sp, h: a.font.glyphH }
})

/* ASCII 字库 (系统字): 整份 0x20~0x7E 的字模描述 —— 表格尺寸/总字节都从它来 */
const asciiFont = computed(() => {
  if (!isAscii.value || draft.source !== 'system') return null
  try { return asciiFontForSys(sysCfg()) } catch (e) { return null }
})
const asciiBytes = computed(() => {
  const f = asciiFont.value
  return f ? f.bytes.length : 0
})

const missingChars = computed(() => {
  if (draft.source !== 'asset' || isNum.value || !fontReady.value) return []
  const cells = fontCells(asset.value)
  if (!cells) return []
  const have = new Set(cells.map(c => c.ch))
  return [...new Set([...String(draft.text || '')].filter(c => !have.has(c)))]
})

/* ---- 预览 ---- */
const previewUrl = ref('')
const lastW = ref(0)
const inkSize = ref(null)          // 去掉黑边后的实际内容尺寸
const asciiUrl = ref('')           // ASCII 全字库一览 (导出给固件的那份)
const asciiW = ref(0)
/* 「图片下载」用: 留存预览画布本身 (1:1 原始像素存 PNG, 不是按预览缩放后的显示尺寸)。
 * 用普通变量而不是 ref: 画布是 DOM 对象, 塞进响应式代理没好处。 */
let lastPvCv = null                // 文字 / 数字预览那张
let lastAsciiCv = null             // ASCII 全字库那张
let lastDigitCv = null             // 数字字模条 (0~9) 那张
let pvTimer = null
watch(() => [draft.source, draft.content, draft.text, draft.spacing, draft.fmt, draft.color, draft.assetId, draft.name, show.value,
  draft.bind.name, draft.bind.dec, draft.bind.cells, draft.bind.pad, draft.bind.bg, draft.bind.demo,

  draft.family, draft.size, draft.weight, draft.bold, draft.offsetY, draft.lineGap, draft.rampSigma,
  draft.glowThresh, draft.glowSigma, draft.glowGain, draft.glowFit, draft.evenSpacing, draft.glyphDx], () => {
  if (!show.value) return
  clearTimeout(pvTimer)
  pvTimer = setTimeout(async () => {
    /* 内置字体要走网络加载: 等它 ready 再画, 否则第一张会画成后备字体并进缓存 */
    if (draft.source === 'system' || isNum.value) {
      await ensureFont(draft.family, draft.weight || 400, draft.size || 20)
      clearSysFontCache()
    }
    let cv = null
    try {
      if (isNum.value) {
        const t = numText.value
        if (t == null) { previewUrl.value = ''; lastW.value = metrics.value.w; inkSize.value = null; return }
        /* ！与固件 + 画布预览同一份对齐规则 (numFieldLead ↔ app_ui.c 的 UI_DrawField):
         *   画布取"显示区总宽"、首字按 左/中/右 偏移 —— 弹窗里看到的就得是板上那个样子。 */
        const b = draft.bind
        const f0 = numFont.value
        const sig = formatNumSig(b.demo, b.dec)
        const lead = numFieldLead(b, f0, sig.length)
        const gw0 = Math.max(1, Math.round(f0?.w) || 8)
        const gap0 = Math.max(0, Math.round(f0?.gap) || 0)
        const cells0 = Math.max(1, Math.round(+b.cells || 1))
        const boxW0 = cells0 * (gw0 + gap0) - gap0
        /* ！预览一律**不铺底色 (0xFFFF)**: 值为 0 的像素保持透明, 非 0 一律不透明。
         *   导出的字节里底色仍是 b.bg, 但这张是给人看的调试视图 ——
         *   铺上底色后光晕的尾巴 (只有几十级灰) 与纯黑分不出来, 看不出它到底扩到哪、格子为什么这么宽。 */
        cv = renderNumCanvas(lead == null ? '' : sig, draft.color, 0xFFFF, f0,
                             { width: boxW0, lead: lead == null ? 0 : lead })  // 已经带色, 底透明
      } else if (draft.source === 'system') {
        const c = sysGlowCanvas(sysCfg())          // 光晕已烘进像素, 预览直接染成底色
        if (c) cv = tintCanvas(c, draft.color, { zeroTransparent: true })   // 0 透明 ⇒ 看得到光晕范围
      } else if (fontReady.value) {
        const a = asset.value
        const cells = fontCells(a)
        if (cells?.length) {
          const gw = a.font.glyphW, gh = a.font.glyphH
          const sp = Math.round(+draft.spacing || 0)
          const seq = [...String(draft.text || '')].map(ch => cells.find(c => c.ch === ch)).filter(Boolean)
          if (seq.length) {
            const strip = document.createElement('canvas')
            strip.width = Math.max(1, seq.length * gw + Math.max(0, seq.length - 1) * sp)
            strip.height = gh
            const ctx = strip.getContext('2d')
            seq.forEach((c, i) => ctx.drawImage(c.canvas, i * (gw + sp), 0))
            cv = tintCanvas(strip, draft.color)      // 只染字, 底透明
          }
        }
      }
    } catch (e) { cv = null }
    if (!cv) { previewUrl.value = ''; lastPvCv = null; inkSize.value = null; return }
    previewUrl.value = cv.toDataURL()
    lastPvCv = cv                       /* 「图片下载」按 1:1 原始像素存这张 (文字/数字都用它) */
    lastW.value = cv.width
    inkSize.value = inkBox(cv)
  }, 150)
}, { immediate: true })

/* ASCII 字库一览: 把整份 0x20~0x7E 按 16 列摆出来 (读的就是导出那份字节) */
const asciiStyle = computed(() => ({
  width: Math.max(1, asciiW.value * pvZoom.value) + 'px',
  imageRendering: pvZoom.value >= 1 ? 'pixelated' : 'auto',
}))
let pvTimer2 = null
watch(() => [draft.content, draft.color, draft.family, draft.size, draft.weight, draft.bold,
  draft.spacing, draft.offsetY, draft.rampSigma, show.value,
  draft.glowThresh, draft.glowSigma, draft.glowGain, draft.glowFit, draft.evenSpacing, draft.glyphDx], () => {
  if (!show.value || !isAscii.value) { asciiUrl.value = ''; lastAsciiCv = null; return }
  clearTimeout(pvTimer2)
  pvTimer2 = setTimeout(async () => {
    try {
      await ensureFont(draft.family, draft.weight || 400, draft.size || 20)
      clearSysFontCache()
      const f = asciiFont.value
      if (!f) { asciiUrl.value = ''; lastAsciiCv = null; return }
      const cv = asciiSheet(f, draft.color)
      asciiUrl.value = cv.toDataURL()
      lastAsciiCv = cv
      asciiW.value = cv.width
    } catch (e) { asciiUrl.value = ''; lastAsciiCv = null }
  }, 150)
}, { immediate: true })

/** 整份字库摆成 16 列 × N 行的一张图 (色 = 这一层的颜色; 空白字符不画) */
function asciiSheet(font, color) {
  const chars = [...ASCII_PRINTABLE]
  const cols = 16
  const rows = Math.ceil(chars.length / cols)
  const step = font.w + Math.max(0, font.gap)
  const cv = document.createElement('canvas')
  cv.width = cols * step
  cv.height = rows * font.h
  const ctx = cv.getContext('2d')
  for (let r = 0; r < rows; r++) {
    const seg = chars.slice(r * cols, (r + 1) * cols).join('')
    ctx.drawImage(renderNumCanvas(seg, color, 0xFFFF, font), 0, r * font.h)
  }
  return cv
}

/* 数字模式: 单独渲染一条 0~9 (外加 '-' '.') —— 就是导出给固件的那份字模, 用来检查字体/字号/字距 */
const digitUrl = ref('')
const digitW = ref(0)
const DIGIT_CHARS = '-.0123456789'
watch(() => [draft.content, draft.color, draft.bind.bg, numFont.value, show.value], () => {
  if (!show.value || !isNum.value) { digitUrl.value = ''; lastDigitCv = null; return }
  try {
    /* 不铺 draft.bind.bg: 数字字模开光晕后, 黑底会把光晕范围整个吃掉 (0 的像素才透明) */
    const cv = renderNumCanvas(DIGIT_CHARS, draft.color, 0xFFFF, numFont.value)
    digitUrl.value = cv.toDataURL()
    lastDigitCv = cv
    digitW.value = cv.width
  } catch (e) { digitUrl.value = ''; lastDigitCv = null }
}, { immediate: true })
const digitStyle = computed(() => ({
  width: Math.max(1, digitW.value * pvZoom.value) + 'px',
  imageRendering: pvZoom.value >= 1 ? 'pixelated' : 'auto',
}))

/* 图片下载: 把当前预览的那张按 1:1 原始像素存成 PNG (文字 = 拼字图; 数字 = 显示区那一条;
 * ASCII 字库 = 16 列整表)。存的是**画布本身**, 不是预览里缩放后的显示尺寸。 */
const canDownloadPreview = computed(() => !!(isAscii.value ? asciiUrl.value : previewUrl.value))
function downloadPreviewImage() {
  const ascii = isAscii.value
  const cv = ascii ? lastAsciiCv : lastPvCv
  if (!cv) return
  const kind = ascii ? 'ascii' : (isNum.value ? 'num' : 'text')
  const label = draft.name || (ascii ? '' : draft.text) || kind
  downloadCanvasPng(imageFileName(kind, label, cv.width, cv.height), cv)
}

const pvStyle = computed(() => ({
  width: Math.max(1, lastW.value * pvZoom.value) + 'px',
  imageRendering: pvZoom.value >= 1 ? 'pixelated' : 'auto',
}))

/* ---- 函数名 → 生成的"按 ID 取图"调用函数 ---- */
function fontCharsetOf(a) {
  if (!a?.font) return ''
  if (a.font.charset === 'ascii') { let s = ''; for (let c = 0x20; c <= 0x7E; c++) s += String.fromCharCode(c); return s }
  return a.font.custom || ''
}
const fnName = computed(() => sanitizeName(draft.name) || 'str1')
const idCount = computed(() => {
  if (isNum.value) return numFont.value.count
  if (isAscii.value) return ASCII_COUNT
  if (draft.source === 'asset') return Math.max(1, [...fontCharsetOf(asset.value)].length)
  return 1
})
const fnText = computed(() => {
  if (draft.source === 'system' || isNum.value || !draft.idFn) return ''
  const gw = asset.value?.font?.glyphW || 8
  const gh = asset.value?.font?.glyphH || 11
  return idDrawFunction(fnName.value, { count: idCount.value, w: gw, h: gh })
})
/* 字模表要花多少 flash (让用户看得见, 好决定要不要这个函数) */
const idFnBytes = computed(() => {
  if (isAscii.value) return asciiBytes.value
  if (draft.source !== 'asset' || isNum.value || !fontReady.value) return 0
  const a = asset.value
  return idCount.value * a.font.glyphW * a.font.glyphH
})
const picDecl = computed(() => {
  if (isAscii.value) {
    const f = asciiFont.value
    if (!f) return ''
    return `/* 字库表: ${fnName.value}Pic[${f.count}][${f.w * f.h}] (灰度 1B/px, 一格 = 一个 ASCII 字符;\n`
      + ` * 字符序 = 码序 0x${ASCII_FIRST.toString(16).toUpperCase()}..0x7E, 固件按 c - 0x${ASCII_FIRST.toString(16).toUpperCase()} 取字模) */`
  }
  if (draft.source !== 'asset' || !fontReady.value || isNum.value) return ''
  const a = asset.value
  return `/* 字库表: ${fnName.value}Pic[${idCount.value}][${a.font.glyphW * a.font.glyphH}] (灰度 1B/px, 一格 = 一个字) */`
})

/* ---- 指令预览 ---- */
const codePreview = computed(() => {
  if (isNum.value) {
    const f = numFont.value
    return `/* 数字区域: 固件用字库刷 ${draft.bind.name} 的值 (这一层不出图片素材)\n` +
      ` * 字库 ${f.name}: ${f.w}x${f.h}, 字符 ${f.first}..${f.first + f.count - 1}\n` +
      ` * UI_T_NUM dec=${draft.bind.dec} cells=${draft.bind.cells} align=${['UI_ALIGN_L', 'UI_ALIGN_R', 'UI_ALIGN_C'][draft.bind.align || 0]} pad=${draft.bind.pad ? 1 : 0} */`
  }
  if (isAscii.value) {
    const f = asciiFont.value
    if (!f) return '/* ASCII 字库: 字体还没就绪 (等系统字体加载完再看) */'
    const per = f.w * f.h
    const first = ASCII_FIRST, last = first + f.count - 1
    return `/* 系统字 ASCII 字库: ${f.count} 个字形 (0x${first.toString(16).toUpperCase()}..0x${last.toString(16).toUpperCase()}),`
      + ` 每字 ${f.w}×${f.h} = ${per}B, 共 ${(f.bytes.length / 1024).toFixed(1)}KB flash\n`
      + ` * 固件: ${fnName.value}Str(x, y, "任意字符串", color);   或 ${fnName.value}(x, y, id, color, bg) 按 id 取图 (id = 字符码 - 0x${first.toString(16).toUpperCase()})\n`
      + ` * 这一层显示的示例文本 "..." 仍按普通素材导出成静态图 (见「导出预览」/一键导出)\n`
      + ` * 字模数据在 ui_font.c, 声明在 ui_table.h */\n\n`
      + `const uint8_t ${fnName.value}Pic[${f.count}][${per}] = { … };\n\n`
      + idDrawFunction(fnName.value, { count: f.count, w: f.w, h: f.h, ascii: true, first })
      + '\n\n'
      + asciiStrFunction(fnName.value, { first, count: f.count, w: f.w, h: f.h, gap: f.gap })
  }
  if (draft.source === 'system') return '/* 系统字: 渲染成图片, 按普通素材导出 (见「导出预览」/一键导出) */'
  if (!fontReady.value) return '/* 先选一个字库素材 (或就地「拆分为字库…」) */'
  const a = asset.value
  const tpl = sc.value.templates.TEXT || ''
  const gw = a.font.glyphW, gh = a.font.glyphH
  const name = fnName.value
  const v = draft.color & 0xFFFF
  const callCtx = {
    x: Math.round(+draft.x || 0), y: Math.round(+draft.y || 0),
    w: gw, h: gh, name, pic: `gImage_${name}`,
    text: escCStr(draft.text || ''),
    color: '0x' + v.toString(16).toUpperCase().padStart(4, '0'),
    colorName: nearestColorName(v), i: 0, len: gw * gh, lenBytes: gw * gh,
    sw: sc.value.w, sh: sc.value.h, fmt: draft.fmt, mirror: 0,
  }
  if (/\{(ch|idx|gw|gh)\}/.test(tpl)) {
    const sp = Math.max(0, Math.round(+draft.spacing || 0))
    return [...String(draft.text || '')].slice(0, 12).map((ch, i) => renderTemplate(tpl, {
      ...callCtx, x: callCtx.x + i * (gw + sp), idx: i, ch, text: escCStr(draft.text || ''),
    })).join('\n')
  }
  const fnCtx = { name, pic: `gImage_${name}`, gw, gh, charset: escCStr(fontCharsetOf(a)) }
  const fn = renderTemplate(sc.value.templates.TEXTFN || '', fnCtx)
  const call = renderTemplate(tpl, callCtx)
  return (fn ? fn + '\n\n' : '') + call
})

async function doCopy() {
  const t = [picDecl.value, codePreview.value, fnText.value].filter(Boolean).join('\n\n')
  if (await copyText(t)) {
    copied.value = 'y'
    setTimeout(() => (copied.value = ''), 1200)
  }
}

/* 新图层的默认名字 */
function fontPrefix(family) {
  return String(family || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}
/** 系统字: 用"字体名_序号" (MiSans → misans_1); 字体名是中文/取不出英数字 → 回退旧方法 txt_N */
function autoName(kind, family, excludeId = null) {
  if (kind === 'system') {
    const p = fontPrefix(family)
    if (p) {
      const used = state.instances.filter(i => i.id !== excludeId && new RegExp('^' + p + '_\\d+$').test(String(i.name || ''))).length
      const base = state.instances.filter(i => i.sysfont && i.id !== excludeId).length
      return p + '_' + (Math.max(used, base) + 1)
    }
    return 'txt_' + (state.instances.filter(i => i.sysfont).length + 1)
  }
  return 'str_' + (state.instances.filter(i => i.kind === 'text').length + 1)
}
/** 只改"还是自动生成"的名字, 用户改过就不动 */
/** 这个名字是不是"自动生成的样子": str_N / txt_N / <某个字体前缀>_N (含换字体前的旧前缀) */
function looksAuto(name, ...families) {
  const n = String(name || '')
  if (/^(str|txt)_\d+$/.test(n)) return true
  return families.some(f => {
    const p = fontPrefix(f)
    return !!p && new RegExp('^' + p + '_\\d+$').test(n)
  })
}
/* 换字体: 名字还是自动生成的就跟着换 (microsoft_yahei_1 → misans_1);
 * 用户手动改过的名字不动。改字重/字号不触发。 */
watch(() => draft.family, (nv, ov) => {
  if (!draft.name || !looksAuto(draft.name, nv, ov)) return
  draft.name = autoName(draft.source, nv, draft.id)
})
/* 字库素材 ↔ 系统字 互切: 自动名也跟着换前缀; ASCII 字库只有系统字有 → 切回字库素材时退回固定文本 */
watch(() => draft.source, (nv, ov) => {
  if (nv === 'asset' && draft.content === 'ascii') draft.content = 'fixed'
  if (!draft.name || !looksAuto(draft.name, draft.family)) return
  if (nv === 'system' && !fontPrefix(draft.family)) return   // 中文字体名 → 保持 txt_N
  draft.name = autoName(nv, draft.family, draft.id)
})

/* 数字绑定 (字库 / 系统字两种来源共用) */
function numBind() {
  const b = draft.bind
  return {
    type: 'num',
    name: cVarRef(String(b.name || 'g_uiVal')) || 'g_uiVal',   // 允许 motor.speed / motor->speed
    dec: Math.max(0, Math.min(6, Math.round(+b.dec || 0))),
    cells: Math.max(1, Math.min(20, Math.round(+b.cells || 1))),
    align: Math.round(+b.align || 0), pad: b.pad ? 1 : 0,
    bg: (b.bg == null ? 0xFFFF : b.bg) & 0xFFFF,
    demo: Math.round(+b.demo || 0),
  }
}

function apply() {
  if (groupMode.value) {
    const color = (draft.color == null ? 0xFFFF : draft.color) & 0xFFFF
    if (draft.source === 'asset') {
      if (!fontReady.value) { alert('请先选一个「已拆分字库」的素材'); return }
      emit('group-apply', {
        source: 'asset', assetId: draft.assetId, text: String(draft.text || ''),
        spacing: Math.round(+draft.spacing || 0), color, fullSet: !!draft.fullSet,
      })
    } else {
      emit('group-apply', { source: 'system', ...sysCfg(), color })
    }
    close()
    return
  }
  draft.name = sanitizeName(draft.name)
  const base = {
    name: draft.name,
    x: Math.round(+draft.x || 0), y: Math.round(+draft.y || 0),
    fmt: draft.fmt, color: draft.color,
  }
  const cur = state.instances.find(i => i.id === draft.id)

  /* 系统字: 换成一个系统字实例 (原来是文字层就删掉) */
  if (draft.source === 'system') {
    /* ASCII 字库层也得有个"示例文本"当这一层的图 —— 空文本渲染不出画布, 实例根本建不出来 */
    if (isAscii.value && !String(draft.text || '').trim()) draft.text = 'ABC'
    const cfg = sysCfg()
    const wasSys = !!cur?.sysfont
    const bnd = isNum.value ? numBind() : null
    /* ASCII 字库层: 整份 0x20~0x7E 字模 + <名字>Str(); 示例文本/字距照旧存实例上 */
    const extra = {
      ascii: isAscii.value,
      ...(isAscii.value ? { text: String(draft.text || ''), spacing: Math.round(+draft.spacing || 0) } : {}),
    }
    if (isNew.value || !cur) {
      const inst = addSysInstance(cfg, draft.fmt)
      if (inst) updateInstance(inst.id, { ...base, ...extra, ...(bnd ? { bind: bnd } : {}) })
      if (provisional.value) { removeInstance(provisional.value); provisional.value = null }
    } else if (wasSys) {
      updateInstance(draft.id, { ...base, ...extra, sysfont: cfg, bind: bnd })
    } else {
      const inst = addSysInstance(cfg, draft.fmt)
      if (inst) {
        updateInstance(inst.id, { ...base, ...extra })
        removeInstance(draft.id)
      }
    }
    provisional.value = null
    close()
    return
  }

  /* 字库素材 */
  if (!fontReady.value) { alert('请先选一个「已拆分字库」的素材, 或点「拆分为字库…」'); return }
  const patch = {
    ...base,
    assetId: draft.assetId, text: String(draft.text || ''),
    spacing: Math.round(+draft.spacing || 0), fullSet: !!draft.fullSet,
    idFn: !!draft.idFn,
    kind: 'text', sysfont: null, ascii: false,
  }
  if (isNum.value) {
    patch.bind = numBind()
    const lay = numLayout(patch.bind, numFont.value)
    patch.w = lay.w
    patch.h = lay.h
  } else {
    patch.bind = null
  }
  if (isNew.value || !cur || cur.sysfont) {
    if (provisional.value && provisional.value === draft.id) {
      updateInstance(provisional.value, { ...patch })     // 新建时已经落地了, 直接改它
    } else {
      const inst = addTextInstance(draft.assetId)
      if (inst) updateInstance(inst.id, { ...patch })
      if (cur?.sysfont) removeInstance(draft.id)
    }
  } else {
    updateInstance(draft.id, { ...patch })
  }
  provisional.value = null
  close()
}

function doRemove() {
  if (draft.id && !isNew.value) removeInstance(draft.id)
  close()
}
let maskDownOnMask = false
function onMaskDown(e) { maskDownOnMask = e.target === e.currentTarget }
function onMaskClick(e) {
  if (e.target === e.currentTarget && maskDownOnMask) apply()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="mask" @pointerdown="onMaskDown" @click="onMaskClick">
      <div class="dialog panel">
        <div class="panel-title">
          {{ groupMode ? '编辑文字 (多帧画板)' : ((isNew ? '新建' : '编辑') + (draft.source === 'system' ? '系统字' : (isNum ? '数字' : '文字'))) }}
          <span class="tag">{{ metrics.w }}×{{ metrics.h }} px</span>
          <span class="grow"></span>
          <button v-if="draft.source === 'system'" @click="tuneOpen = true"
            title="逐字左右偏移 (px)：修系统字 1px 的左右抖动；最终格子 = 所有字形叠加区域的最大尺寸。数字 / ASCII / 固定文本都生效；改动会烘进导出的字模/图片。">逐字微调…</button>
          <button @click="downloadPreviewImage()" :disabled="!canDownloadPreview"
            title="把当前预览按 1:1 原始像素存成 PNG (文字 = 拼字图 / 数字 = 显示区那一条 / ASCII = 16 列整表)">⤓ 图片下载</button>
          <button class="danger" v-if="!isNew && !groupMode" @click="doRemove">删除</button>
          <button @click="close">取消</button>
          <button class="primary" @click="apply">确定</button>
        </div>

        <div class="body">
          <div class="form">
            <!-- 顶部: 来源 / 字库 / 函数名 -->
            <div class="sec">来源</div>
            <div class="field-row">
              <label></label>
              <label class="radio" title="用素材里已拆分的字库 (一个字一格): 拼字 或 刷数字"><input type="radio" value="asset" v-model="draft.source" />字库素材</label>
              <label class="radio" title="用系统字体渲染成图片 (字号随意, 适合大号数字/中文)"><input type="radio" value="system" v-model="draft.source" />系统字库</label>
            </div>

            <div class="field-row" v-if="groupMode">
              <label></label>
              <span class="dim">多帧画板只取文字渲染结果; 函数名/数组/导出设置不参与。</span>
            </div>
            <div class="field-row">
              <label>内容</label>
              <label class="radio" title="固定字符串: 把字库里的字/系统字渲染成一条图导出"><input type="radio" value="fixed" v-model="draft.content" :disabled="groupMode" />固定文本</label>
              <label class="radio" v-if="!groupMode" title="数字: 固件用字库刷变量里的数 —— 系统字会按当前字号自动导出 0~9 字模 (不会跑空); 这一层不出图片素材">
                <input type="radio" value="num" v-model="draft.content" />数字 (变量)</label>
              <label class="radio" v-if="draft.source === 'system' && !groupMode"
                title="ASCII 字库: 用这个系统字体/字号把 0x20~0x7E 全部 95 个字符渲染成字模表导出, 固件就能打任意字符串 (名字 与 名字Str 两个函数)">
                <input type="radio" value="ascii" v-model="draft.content" />ASCII 字库</label>
            </div>
            <!-- 字库信息: 钉成**两行**, 第二行默认空 ——
                 尺寸/字距/等距都会随字号和开关变。文字一长就在这一行里折行, 把下面的控件推来推去
                 (2026-10-17 现场: 字距从 0 变 -1 时那一行长出一截折成两行, 下面的按键位置就跳了)。
                 所以固定两行: 第一行 = 身份 (名字/尺寸), 第二行 = 字距/等距这些**会随参数变**的细节,
                 用 min-height 占住 —— 没内容时也是一行空的, 行数恒定 ⇒ 下面不会动。
                 ASCII 字库: 只报"导出的那份有多大"; 95 个字模不占版面, 板上位置由 <名字>Str() 自己给 -->
            <div v-if="isNum || isAscii" class="field-row">
              <label></label>
              <span class="dim mono fontinfo">
                <template v-if="isNum">字库 {{ numFont.name }} · {{ numFont.w }}×{{ numFont.h }}</template>
                <template v-else-if="asciiFont">ASCII {{ asciiFont.count }} 字形 (0x20~0x7E) · 每字 {{ asciiFont.w }}×{{ asciiFont.h }} · 共 {{ (asciiBytes / 1024).toFixed(1) }}KB flash</template>
                <template v-else>字库还没量出来 (等系统字体加载完)</template>
                <span class="fontinfo-meta"><template v-if="isNum && numFont.gap">字距 {{ numFont.gap }}px</template><template v-else-if="isNum && numFont.spacing">字距 {{ numFont.spacing }}px (收窄格子, 已按字迹夹住)</template><template v-else-if="isAscii && asciiFont && asciiFont.gap">字距 {{ asciiFont.gap }}px</template><template v-if="draft.evenSpacing"> · 等距</template></span>
              </span>
            </div>
            <div v-if="isAscii && asciiBytes > 16384" class="field-row">
              <label></label>
              <span class="warn-t">字库偏大 (占 64KB flash 的 {{ Math.round(asciiBytes / 65536 * 100) }}%): 字号降一点 / 换更窄的字体都能明显省下来</span>
            </div>
            <template v-if="isNum">
              <div class="field-row">
                <label>变量名</label>
                <input class="mono" v-model="draft.bind.name" style="width: 150px"
                  title="源文件里的变量名; 支持结构体成员写法 motor.speed / motor->speed (导出成 &motor.speed)" />
              </div>
              <div class="field-row">
                <span class="pair"><label>小数位</label><input type="number" min="0" max="6" v-model.number="draft.bind.dec" style="width: 48px" /></span>
                <span class="pair"><label>格数</label><input type="number" min="1" max="20" v-model.number="draft.bind.cells" style="width: 48px" /></span>
                <span class="pair"><label>对齐</label>
                  <select v-model.number="draft.bind.align" style="width: 58px">
                    <option :value="0">左</option><option :value="1">右</option><option :value="2">中</option>
                  </select></span>
                <span class="pair"><label>预览值</label><input type="number" v-model.number="draft.bind.demo" style="width: 80px" /></span>
                <label class="radio"><input type="checkbox" v-model="draft.bind.pad" />补前导零</label>
                <label class="radio" title="这个值可能小于 0 → 字库必须带 '-' 字形。不带就能省一个字形 (大字号下几百字节到几 KB)"><input type="checkbox" :checked="!!(draft.bind.neg || draft.bind.demo < 0)" @change="draft.bind.neg = $event.target.checked ? 1 : 0" />可能为负 (带 '-')</label>
              </div>
              <div class="field-row">
                <label>底色</label>
                <input class="mono" :value="'0x' + (draft.bind.bg & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')"
                  @change="e => draft.bind.bg = parseInt(String(e.target.value).replace(/^#|^0x/i, ''), 16) & 0xFFFF"
                  style="width: 76px" />
                <span class="tag mono" v-if="numText">{{ numText }}</span>
                <span class="tag" v-else style="color: var(--err); border-color: var(--err)">{{ draft.bind.cells }} 格放不下 → 固件不画</span>
                <span class="dim">更新周期在图层列表上方的「页面」里统一设置</span>
              </div>
            </template>

            <template v-if="draft.source === 'asset'">
              <div class="field-row">
                <label>字库</label>
                <select v-model="draft.assetId" style="flex: 1">
                  <option v-for="a in assetOptions" :key="a.id" :value="a.id">
                    {{ a.name }}{{ a.font ? ' — 字库 ' + a.font.glyphW + '×' + a.font.glyphH : ' — 未拆分' }}
                  </option>
                </select>
              </div>
              <div class="field-row" v-if="!assetOptions.length">
                <label></label><span class="warn-t">素材库是空的: 先「导入图片」再拆分成字库, 或直接用「系统字库」</span>
              </div>
              <div class="field-row" v-else-if="!fontReady">
                <label></label>
                <span class="warn-t">这个素材还没拆成字库 (一格 = 一个字)</span>
                <button @click="state.ui.dialogFontAssetId = draft.assetId">拆分为字库…</button>
              </div>
            </template>

            <template v-else>
              <div class="field-row">
                <label>字体</label>
                <select v-model="draft.family" style="flex: 1">
                  <optgroup label="内置字体 (随网页发布)">
                    <option v-for="f in BUILTIN_FONTS" :key="f.family" :value="f.family">{{ f.label }}</option>
                  </optgroup>
                  <optgroup label="系统字体">
                    <option v-for="f in sysFontList" :key="f" :value="f">{{ f }}</option>
                  </optgroup>
                  <option v-if="draft.family && !fontKnown.has(draft.family)" :value="draft.family">{{ draft.family }} (当前字体)</option>
                </select>
                <button v-if="canQueryLocal" @click="enumLocalFonts" title="枚举本机全部字体">枚举…</button>
                <button @click="fontFile.click()" title="加载字体文件 (.ttf/.otf)">文件…</button>
                <input ref="fontFile" type="file" accept=".ttf,.otf,.woff,.woff2" hidden @change="onFontFile" />
              </div>
              <div class="field-row">
                <label>字号</label><input type="number" min="4" max="200" v-model.number="draft.size" style="width: 60px" />
                <label title="字重 (同一字体不同粗细)">字重</label>
                <!-- 可变字体: 连续可调 (无极) -->
                <template v-if="isVariableFont(draft.family)">
                  <input type="range" class="wslider" :min="weightRangeOf(draft.family).min"
                    :max="weightRangeOf(draft.family).max" step="1" v-model.number="draft.weight" />
                  <input type="number" class="wnum" :min="weightRangeOf(draft.family).min"
                    :max="weightRangeOf(draft.family).max" v-model.number="draft.weight" />
                  <span class="tag mono" :title="'可变字体 wght 轴连续可调'">{{ weightName(draft.weight) }} {{ draft.weight }}</span>
                </template>
                <!-- 静态字体: 只有这些样式 (PS 里的 Light/Regular/Medium/Bold 那套叫法) -->
                <template v-else>
                  <select v-model.number="draft.weight" style="width: 118px">
                    <option v-for="w in fontInfo(draft.family).weights" :key="w.v" :value="w.v">{{ w.n }} ({{ w.v }})</option>
                  </select>
                  <label class="radio" title="快捷方式: 勾上 = 字重 700"><input type="checkbox"
                    :checked="(+draft.weight || 400) >= 700"
                    @change="draft.weight = $event.target.checked ? 700 : 400" />粗体</label>
                </template>
              </div>
              <div class="field-row">
                <span class="pair"><label title="字间距: 每个字之间空多少像素; 可以填负数 (字挤在一起/叠一点)">字距</label>
                  <input type="number" min="-32" max="64" v-model.number="draft.spacing" style="width: 56px" /></span>
                <!-- 等距: 只对「数字 (变量)/ASCII 字库」生效 —— 那两条路把每个字渲染成**独立字模**,
                     固件按 (w+gap) 逐格步进。原来的格子按字体的**字身**(advance) 定宽、按字身居中,
                     而每个字的左右边距各不相同 (MiSans @20px: '1' 偏 0.68px, 'j' 偏 1.21px, 随字号放大),
                     一排字符看着就左右不齐; 窄字 ('.' 'i') 又被摆在很宽的格子正中, 空隙忽大忽小。
                     勾上 = 格子按**最宽字迹**定宽 + 每字按**字迹**居中 ⇒ 步进完全均匀、字字在正中。 -->
                <label class="radio" v-if="isNum || isAscii"
                  title="等距: 字模格子按「最宽字迹」定宽, 每个字按「字迹」居中 —— 固件逐格步进时每个字符都在正中, 不会因为字体左右边距不同而左右偏移。关掉 = 沿用字体自带的字身宽度 (原行为)。格子会比原来略窄 (MiSans 数字约 -17%)。">
                  <input type="checkbox" v-model="draft.evenSpacing" />等距</label>
                <span class="pair"><label title="行间距: 文本里换行 (Enter) 后, 两行之间空多少像素">行距</label>
                  <input type="number" min="0" max="64" v-model.number="draft.lineGap" style="width: 56px" /></span>
                <span class="pair"><label title="上下微调 (px): 正值 = 字往下坐 (格子上方留白); 负值 = 从字底收紧 (裁掉 j/g/y 这类降部尾巴, 字库更矮省 flash)。两种方向都不会切到字顶 —— 画布会按字迹+偏移自动放高。">上下</label>
                  <input type="number" min="-32" max="64" v-model.number="draft.offsetY" style="width: 56px" /></span>
              </div>
              <!-- 边缘斜坡 σ: **这一层自己的**字模抗锯齿宽度 (只对 GRAY 字库生效)。
                   浏览器渲染的系统字 AA 只有 ~1px, 大字号下斜边/圆弧就是一格一格的台阶;
                   σ 把覆盖率斜坡摊宽 (0.7 ≈ 过渡 1.4px) → 斜边变顺, 代价是略"肉"。
                   0 = 完全不变; >1.0 小字号会发虚。预览读的是同一份字节 ⇒ 所见即板上。 -->
              <div class="field-row">
                <span class="pair"><label title="灰度字模的边缘斜坡宽度 (高斯 σ, px)。只影响这一层的字库; 0 = 不变">边缘斜坡 σ</label>
                  <input type="range" class="wslider" min="0" max="2" step="0.05" v-model.number="draft.rampSigma" style="width: 90px" />
                  <input type="number" min="0" max="2" step="0.1" v-model.number="draft.rampSigma" style="width: 48px" />
                  <span class="dim">px</span></span>
                <span class="dim">0=原样 · 0.7 推荐 · 越大越柔</span>
              </div>
              <!-- 光晕 (外发光): 与 σ 同一层口径 —— **烘进字模字节**, 固件一行都不用改。
                   σ 自己就是开关 (与上面「边缘斜坡 σ」同一写法): 0 = 关, 字节与以前逐字节相同。
                   开着时字模四周自动留出 ceil(3σ) 的空白, 否则光晕会被格子边缘切平
                   (切平处是一条硬边, 比没有光晕更难看)。代价: 数字/ASCII 字库的每格尺寸会变大,
                   字距随之拉开 —— 这是光晕必须占的物理空间, 不是 bug。
                   「紧排」= 光晕照算, 但裁回原格子: 字距不变, 代价是格子边缘的弱光被切掉。 -->
              <div class="field-row">
                <span class="pair"><label title="外发光 (烘进字模字节, 固件不改)。σ = 0 就是关">光晕 σ</label>
                  <input type="range" class="wslider" min="0" max="12" step="0.1" v-model.number="draft.glowSigma" style="width: 90px" />
                  <input type="number" min="0" max="12" step="0.1" v-model.number="draft.glowSigma" style="width: 52px" />
                  <span class="dim">px</span></span>
                <template v-if="(+draft.glowSigma || 0) > 0">
                  <span class="pair"><label title="发光阈值 (0..255): 只有比它亮的像素才发光 —— 黑底上的暗部不该发光; 0 = 全图发光">阈值</label>
                    <input type="number" min="0" max="255" v-model.number="draft.glowThresh" style="width: 56px" /></span>
                  <span class="pair"><label title="光晕强度 (倍率): 1.0 = 掩膜原始强度, 越大越亮; 想更亮先加它 (不占字距)">增益</label>
                    <input type="number" min="0" max="4" step="0.1" v-model.number="draft.glowGain" style="width: 52px" /></span>
                  <label class="radio" v-if="isNum || isAscii"
                    title="紧排: 光晕照算, 但只保留原格子里的部分 —— 字距/图层尺寸不变; 代价是格子边缘的弱光被切掉 (大 σ 时能看到格子边界)">
                    <input type="checkbox" v-model="draft.glowFit" />紧排</label>
                  <span class="dim">{{ glowHint() }}<template v-if="glowZoomHint()"> · {{ glowZoomHint() }}</template></span>
                </template>
                <span class="dim" v-else>0 = 关 · σ ≥ 0.5 起才有可见光晕 · 想更亮先加增益 (1→2.5), 想更大再加 σ (3→5) · 字模四周自动留白 ceil(3σ), 字距随之拉开</span>
              </div>
              <div class="field-row">
                <label></label>
                <span class="dim">文本里按 Enter 换行 = 多行 (行距生效); 字距同时作用于数字模式</span>
              </div>
            </template>

            <div class="field-row" v-if="!groupMode">
              <label>函数名</label>
              <input class="mono" v-model="draft.name" style="width: 140px" />
              <span class="dim" v-if="draft.source === 'asset' && !isNum">
                → <span class="mono">{{ fnName }}Pic[{{ idCount }}][…]</span> + 调用函数
              </span>
              <span class="dim" v-else-if="isAscii">
                → <span class="mono">{{ fnName }}Pic[{{ ASCII_COUNT }}][…]</span> + <span class="mono">{{ fnName }}()</span> / <span class="mono">{{ fnName }}Str()</span>
              </span>
              <span class="dim" v-else-if="isNum">数字区域用它做数组/表项名</span>
            </div>

            <div class="field-row" v-if="draft.source === 'asset' && !isNum">
              <label></label>
              <label class="radio" title="导出这个调用函数: 固件传 id 就画第 id 张图, 超范围用底色 FILL">
                <input type="checkbox" v-model="draft.idFn" />导出调用函数
              </label>
              <span class="dim" v-if="draft.idFn">
                字模表 {{ idCount }}×{{ (asset?.font.glyphW || 0) * (asset?.font.glyphH || 0) }} = {{ idFnBytes }} 字节 flash
              </span>
            </div>
            <div class="field-row" v-if="draft.source === 'asset' && !isNum">
              <label>文本</label>
              <input v-model="draft.text" style="flex: 1" class="mono" placeholder="要显示的字符串" />
            </div>
            <div class="field-row" v-if="draft.source === 'system'">
              <label>{{ isAscii ? '示例文本' : '文本' }}</label>
              <input v-model="draft.text" style="flex: 1" class="mono" :placeholder="isAscii ? '只用来预览/演示这一层的字体 (板上由固件调 ' + fnName + 'Str 打字符串)' : '要渲染的文字'" />
            </div>
            <div class="field-row" v-if="isAscii">
              <label></label>
              <span class="dim">板上要打什么字符串由固件决定: <span class="mono">{{ fnName }}Str(x, y, "Hello", color)</span> —— 95 个字模全部导出</span>
            </div>
            <div class="field-row" v-if="missingChars.length">
              <label></label>
              <span class="warn-t">字库缺少: {{ missingChars.map(c => c === ' ' ? '␠' : c).join(' ') }} (将跳过不画)</span>
            </div>

            <div class="sec" v-if="!groupMode">位置 (屏幕 {{ sc.w }}×{{ sc.h }})</div>
            <div class="field-row" v-if="!groupMode">
              <label>X / Y</label>
              <input type="number" v-model.number="draft.x" />
              <input type="number" v-model.number="draft.y" />
              <button @click="draft.x = Math.round((sc.w - metrics.w) / 2); draft.y = Math.round((sc.h - metrics.h) / 2)">居中</button>
              <button @click="draft.x = 0; draft.y = 0">左上</button>
            </div>
            <div class="field-row" v-if="draft.source === 'asset' && !isNum">
              <label>字间距</label>
              <input type="number" v-model.number="draft.spacing" style="width: 52px" /> px
            </div>

            <div class="sec">格式与颜色</div>
            <div class="field-row" v-if="!groupMode">
              <label>格式</label>
              <label class="radio"><input type="radio" value="GRAY" v-model="draft.fmt" />Gray 灰度×颜色</label>
              <label class="radio"><input type="radio" value="RGB565" v-model="draft.fmt" />RGB565</label>
            </div>
            <ColorField v-model="draft.color" label="颜色" />

            <div class="field-row" v-if="draft.source === 'asset' && !isNum && !groupMode">
              <label>字库导出</label>
              <label class="radio"><input type="checkbox" v-model="draft.fullSet" />导出完整字符集 (默认只导用到的字)</label>
            </div>
          </div>

          <div class="preview">
            <div class="pv-title">
              <span>{{ isAscii ? '示例文本预览' : '预览' }}</span>
              <span class="tag mono" title="这一层真正占的像素 (导出/固件按这个画)">导出 {{ metrics.w }}×{{ metrics.h }}</span>
              <span v-if="inkSize" class="tag mono" title="去掉四周空白后, 字迹实际占的大小">内容 {{ inkSize.w }}×{{ inkSize.h }}</span>
              <span class="grow"></span>
              <span class="zbtns">
                <input class="wslider" type="range" min="0" :max="ZOOM_LOG_MAX" step="0.05" v-model.number="pvZoomLog"
                       title="预览倍率滑条 (对数刻度 1x~128x)" />
                <button v-for="z in ZOOM_STEPS" :key="z" :class="{ on: pvZoom === z }" @click="pvZoom = z">{{ z }}x</button>
                <input class="mono" type="number" min="1" :max="ZOOM_MAX" step="1" v-model.number="pvZoom"
                       style="width: 54px" title="任意倍率 (1~128, 无极)" />
                <span class="dim">x</span>
              </span>
            </div>
            <div class="pv-img">
              <img v-if="previewUrl" :src="previewUrl" class="pv" :style="pvStyle" />
              <div v-else class="dim">无预览</div>
            </div>

            <template v-if="isNum">
              <div class="pv-title" style="margin-top: 10px">
                <span>数字字模 (导出给固件的那份)</span>
                <span class="tag mono">{{ numFont.w }}×{{ numFont.h }} ×{{ exportChars.length }} 个字形 ({{ exportCharsDesc }})</span>
              </div>
              <div class="pv-img digits">
                <img v-if="digitUrl" :src="digitUrl" class="pv" :style="digitStyle" />
                <div v-else class="dim">无</div>
              </div>
            </template>

            <template v-if="isAscii">
              <div class="pv-title" style="margin-top: 10px">
                <span>ASCII 字模</span>
                <span class="tag mono" v-if="asciiFont">{{ ASCII_COUNT }} 字形 0x20~0x7E · {{ asciiFont.w }}×{{ asciiFont.h }} · {{ (asciiBytes / 1024).toFixed(1) }}KB</span>
              </div>
              <div class="pv-img digits">
                <img v-if="asciiUrl" :src="asciiUrl" class="pv" :style="asciiStyle" />
                <div v-else class="dim">无 (字体加载中)</div>
              </div>
            </template>

            <div class="pv-title" style="margin-top: 10px" v-if="!groupMode">
              <span>{{ isNum ? '数字区域 (固件刷)' : (isAscii ? '字库 / 打字符串函数' : '调用函数 / 指令预览') }}</span>
              <span class="grow"></span>
              <button class="mini" @click="doCopy">复制{{ copied === 'y' ? ' ✓' : '' }}</button>
            </div>
            <pre v-if="!groupMode" class="code">{{ [picDecl, codePreview, fnText].filter(Boolean).join('\n\n') }}</pre>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
  <SysFontTuneDialog
    v-if="draft.source === 'system'"
    :open="tuneOpen"
    :mode="isNum ? 'num' : (isAscii ? 'ascii' : 'fixed')"
    :font="tuneFont"
    :chars="tuneChars"
    :glyph-dx="draft.glyphDx"
    @update:open="tuneOpen = $event"
    @update:glyph-dx="draft.glyphDx = $event"
  />
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0, 0, 0, .55);
  /* 顶边锁死: 预览图/表单变高变矮, 弹窗都不移动, 内容在 .body 里滚 */
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 3vh;
}
.dialog { width: min(880px, 94vw); height: min(760px, 92vh); box-shadow: 0 20px 60px rgba(0,0,0,.6); }
.body { display: grid; grid-template-columns: 390px minmax(0, 1fr); gap: 12px; padding: 12px; overflow: auto; flex: 1; min-height: 0; }
.sec {
  margin: 10px 0 6px; padding-bottom: 3px; border-bottom: 1px dashed var(--border);
  font-size: 12px; color: var(--accent); font-weight: 600;
}
.radio { color: var(--text-dim); font-size: 12px; display: inline-flex; align-items: center; gap: 3px; }
.field-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
.field-row label { color: var(--text-dim); font-size: 12px; min-width: 0; white-space: nowrap; }
/* 标签+输入框绑成一对: 换行时整对一起换, 不会"标签在上、输入框掉到下一行" */
.pair { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.field-row label.radio { min-width: 0; }
.grow { flex: 1; }
.warn-t { color: var(--warn); font-size: 11px; }
.fontinfo { font-size: 11px; }
/* 第二行: 用 min-height 占住 —— 没内容时也是空的一行, 所以「字距/等距」怎么变、变得多长,
   这一行的高度都不变, 下面的按键不会被顶下去 (2026-10-17 现场: 那一行折行导致按键跳位) */
.fontinfo-meta { display: block; min-height: 1.4em; line-height: 1.4; }
.wslider { width: 110px; } .wnum { width: 56px; }
.swatches { display: flex; gap: 3px; flex-wrap: wrap; flex: 1; }
.sw { width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--border); cursor: pointer; }
.sw.on { outline: 2px solid var(--accent); }
.colname { cursor: help; }
.preview { display: flex; flex-direction: column; min-width: 0; }
.pv-title { font-size: 12px; color: var(--text-dim); margin-bottom: 6px; display: flex; align-items: center; gap: 8px; width: 100%; flex-wrap: wrap; }
.zbtns { display: inline-flex; gap: 3px; align-items: center; }
.zbtns button { padding: 0 7px; font-size: 11px; line-height: 18px; }
.zbtns button.on { background: var(--accent-dim); border-color: var(--accent); color: #fff; }
.pv-img {
  display: inline-flex; align-items: flex-start; padding: 8px; max-width: 100%;
  min-height: 120px; max-height: 70vh; overflow: auto;
  background:
    linear-gradient(45deg, #222 25%, transparent 25%, transparent 75%, #222 75%),
    linear-gradient(45deg, #222 25%, #181818 25%, #181818 75%, #222 75%);
  background-size: 12px 12px; background-position: 0 0, 6px 6px;
  border: 1px solid var(--border); border-radius: 4px;
}
/* flex: none 是必须的 —— .pv-img 是 inline-flex, img 作为 flex item 默认 flex-shrink:1,
 * 一旦 width*倍率 超过预览框宽度, 图片会被"缩回去"填满框 ⇒ 2x 与 64x 看起来一模一样,
 * 放大根本没生效。flex:none 让它保持指定尺寸溢出, 由 .pv-img 的 overflow:auto 出滚动条。 */
.pv { image-rendering: pixelated; flex: none; }
.pv-img.digits { height: auto; max-height: 70vh; align-items: center; }
.code {
  margin: 0; overflow: auto; max-height: 240px; flex: 1;
  background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
  padding: 8px; font-family: var(--mono); font-size: 11px; color: #a5d6a7; white-space: pre;
}
</style>
