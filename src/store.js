import { reactive, computed, watch } from 'vue'
import { defaultPresets, syncBuiltinPresets, uid, FORMATS } from './defaults.js'
import { sanitizeName, renderTemplate, templateContext } from './template.js'
import { processImage, buildCArrayText, buildFontTableText, applyCropWindow, svgToCanvas, renderNumCanvas, inkBox, inkBoxLit, ditherGray565, blurGray, addGlowLike, glowPadOf, cropGray, tintCanvas } from './imageproc.js'
import { setRingAnimAngle, getRingAnimAngle, setRingAnimValue, getRingAnimValue,
         dropRingAnim, drawRing, ringLapPx, ringRectGeomQ8, ringRectTableR, ringInsetPx,
         ringAnimFlags, ringArcRange, ringGradStops, ringSegGeom } from './ringrender.js'
import { fwStripDataURL, fwBuiltinAssetMeta, FW_BUILTIN } from './fwassets.js'
import { exportAssets, formatNumText, formatNumSig, numFieldLead, builtinNumFont, numFontFromGlyphs, numLayout,
         idDrawFunction, asciiStrFunction, asciiCellBox, UI_TASK_PERIOD_DEF } from './uiexport.js'
import { collectLayerPlan, tableForPlan, tableHeaderFor, fontFileFor, fontDataFor, taskCodeFor, taskHeaderFor, userHeaderFor, pageIssuesFor, pixelExported, fontGlyphSetsFor } from './layerexport.js'
import { planLzss, encodeLzss, lzssFiles, splitFontParts, cIdent, FMT_GRAY8, FMT_RGB565 } from './lzsspack.js'
import { rgb565Bytes } from './lzss.js'
import { roundGeom, forEachOutsidePixel, OUT_ALPHA_MIN, OUT_DARK_MAX } from './roundscreen.js'
import { nearestColorName, rgb565To888, rgb888To565 } from './colors.js'
import { buildRingScan } from './ringscan.js'
import { buildRingSegSpans, ringSpansInfo } from './ringspans.js'
import { buildColorHeader, collectUsedColors } from './colordef.js'
import { projectMeta, archiveBaseName, archiveFileName } from './archive.js'

const STORAGE_KEY = 'lcd-layout-studio-v1'

export const state = reactive({
  assets: [],       // {id, name, src(dataURL), w, h}
  uiExport: {       // 「UI 帧/表导出」与「一键导出」共用的设置
    text: 'LEVEL\nMOTOR 1\nMOTOR 2\nSTOP',
    lineGap: 2, charGap: 0, bandH: 13, mode: 1,
    store: 'int', baseY: 60,
    lineColors: '0xFFFF, 0xFFE0, 0x8410, 0x8410',
    numEnable: true, numName: 'g_uiSpeedX10', numDec: 1, numCells: 5, numAlign: 1,
    numColor: '0x07FF', numBg: '0x0000', numX: 24, numY: 30,
    splits: [],          // 分割线: [{ y, frame, color }] 每条线管它到吓一条线之间的区域
  },
  instances: [],    // {id, assetId, name, x, y, w, h, fmt, color(565), mirror}  数组顺序即 z 序(底→顶)
  /* 多帧同位置组: 一个组 = 同一坐标上的一排变体, 每帧一个图层 (各自的 fmt/颜色/裁切/偏移)。
   * 组框 = 所有变体里最大的 w/h; 变体用 groupOffset 在组框内对齐, 组移动时一起动。
   *   { id, name, assetId, x, y, w, h, current, fps, loop }
   * 图层侧: groupId / groupIndex / groupOffset。组只在编辑器里存在, 导出仍按每个图层各走各的。 */
  frameGroups: [],
  pages: {},        // { [页面名]: { period } }  每个页面的刷新周期 (数字层不再各带周期)
  presets: defaultPresets(),
  activePresetId: null,
  /* 这个工程/存档自己的「一键导出」目录:
   *   name = 文件夹名 (存进工程 JSON, 换机器/给人看时知道该选哪个目录)
   *   id   = IndexedDB 里目录句柄的键 (FileSystemDirectoryHandle 不能 JSON 化, 只能本机存)
   * 每个存档各存各的; 一键导出只认当前工程的这一份, 不共用上一个工程的句柄. */
  exportDir: { name: '', id: '' },
  exportOpts: { includeArrays: true, perLine: 16, upperHex: true, shootHint: 'ring',
                lzssChunked: true, lzssChunkBytes: 2400 },   // ...; lzss* = 帧分片设置 (字模左右条在字库层拆)
  ui: {
    selectedId: null,       // 选中的实例
    dialogInstanceId: null, // 微调弹窗绑定的实例
    dialogNewAssetId: null, // 从素材栏单击打开 (新建模式)
    dialogFontAssetId: null, // 字库拆分弹窗绑定的素材
    dialogTextId: null,     // 文字实例编辑弹窗
    dialogTextNew: false,   // 文字新建模式
    dialogSysId: null,      // 系统字库实例编辑弹窗
    dialogSysNew: false,    // 系统字库新建模式
    dialogRingId: null,     // 圆环部件编辑弹窗
    dialogRingNew: false,   // 圆环新建模式
    dialogMultiLine: false, // 文本框弹窗 (旧入口已移除, 组件保留)
    dialogFrameGroup: false, // 多帧组弹窗 (多张图片 → 一张多帧素材)
    frameGroupAssetId: '', // 非空 = 编辑这个已有的多帧素材
    frameGroupPreviewId: '', // 旧版组变体子预览 (保留兼容, 新入口不再创建)
    copyMsg: '', // 主预览复制后的短提示 (不持久化)

    canUndo: false,         // 撤回栈非空 (仅 UI 状态, 不持久化)
    canRedo: false,         // 重做栈非空
    zoom: 0,                // 0 = 自适应
    showGrid: true,
    previewFollowFmt: false, // false = 预览统一按 RGB565; true = 按图层的导出格式 (GRAY 等) 渲染
    tab: 'export',
  },
  _imgTick: 0,              // 素材图加载完成计数 (响应式触发重绘, 不持久化)
  recentColors: [],         // 最近使用的调制色 (565, 会话级)
  _ringTick: 0,             // 圆环动画帧计数 (仅触发重绘, 不持久化)
  hiddenCircleWarns: {},    // { [instId]: true } 圆屏警告被用户隐藏的实例
  customFonts: [],          // 已加载的本地字体文件 [{id, name}]
})

export function pushRecentColor(v) {
  v &= 0xFFFF
  const arr = state.recentColors
  const i = arr.indexOf(v)
  if (i === 0) return
  if (i > 0) arr.splice(i, 1)
  arr.unshift(v)
  if (arr.length > 14) arr.length = 14
}

/* ---------- 系统字库 → 图片 ---------- */
/* 内置字体 (随网页一起发布, 见 src/style.css 里的 @font-face; 已按常用字子集转 woff2)。
 * 字重按 Photoshop 那套叫法显示 (Light/Regular/Medium/DemiBold/Bold…),
 * variable = 可变字体 (wght 轴连续可调, 能"无极调节"), 静态字体只有列出的档位。 */
export const BUILTIN_FONTS = [
  {
    family: 'MiSans', label: 'MiSans (内置)', variable: false,
    weights: [{ v: 300, n: 'Light' }, { v: 400, n: 'Regular' }, { v: 500, n: 'Medium' }, { v: 600, n: 'DemiBold' }, { v: 700, n: 'Bold' }],
  },
  {
    family: 'HarmonyOS Sans SC', label: 'HarmonyOS Sans (内置)', variable: false,
    weights: [{ v: 300, n: 'Light' }, { v: 400, n: 'Regular' }, { v: 500, n: 'Medium' }, { v: 700, n: 'Bold' }],
  },
  {
    family: 'OPPO Sans 4.0', label: 'OPPO Sans 4.0 (内置可变)', variable: true, min: 100, max: 700,
    weights: [{ v: 300, n: 'Light' }, { v: 400, n: 'Regular' }, { v: 500, n: 'Medium' }, { v: 600, n: 'SemiBold' }, { v: 700, n: 'Bold' }],
  },
]
export const DEFAULT_FONT = 'MiSans'
/* 系统字体: 下面这几档由浏览器挑最接近的 (也可能合成粗体), 名字同样按 PS 叫法 */
const SYS_WEIGHTS = [{ v: 100, n: 'Thin' }, { v: 300, n: 'Light' }, { v: 400, n: 'Regular' }, { v: 500, n: 'Medium' }, { v: 600, n: 'SemiBold' }, { v: 700, n: 'Bold' }, { v: 900, n: 'Black' }]
const ALL_WEIGHT_NAMES = [
  { v: 100, n: 'Thin' }, { v: 200, n: 'ExtraLight' }, { v: 300, n: 'Light' }, { v: 400, n: 'Regular' },
  { v: 500, n: 'Medium' }, { v: 600, n: 'SemiBold' }, { v: 700, n: 'Bold' }, { v: 800, n: 'ExtraBold' }, { v: 900, n: 'Black' },
]
/** 字重的 PS 式名字 (437 → ≈Medium 这种由调用方加 ≈) */
export function weightName(v) {
  const n = Math.round(+v || 400)
  let best = ALL_WEIGHT_NAMES[0]
  for (const w of ALL_WEIGHT_NAMES) if (Math.abs(w.v - n) < Math.abs(best.v - n)) best = w
  return best.n
}
/** 字体信息: 内置的按声明, 系统字体给常用档位 */
export function fontInfo(family) {
  const b = BUILTIN_FONTS.find(f => f.family === family)
  if (b) return b
  return { family, label: family, variable: false, weights: SYS_WEIGHTS, system: true }
}
/** 某个字体系列的离散字重档位 */
export function weightsOf(family) { return fontInfo(family).weights.map(w => w.v) }
/** 是否可变字体 (能无极调节字重) */
export function isVariableFont(family) { return !!fontInfo(family).variable }
/** 可变字体的字重范围 */
export function weightRangeOf(family) {
  const f = fontInfo(family)
  return f.variable ? { min: f.min || 100, max: f.max || 900 } : null
}
/** 确认字体已就绪 (canvas 画字前必须等它加载完, 否则会画成后备字体) */
export async function ensureFont(family, weight = 400, size = 32) {
  try {
    if (typeof document === 'undefined' || !document.fonts?.load) return
    await document.fonts.load(`${weight} ${Math.max(8, Math.round(size))}px "${family}"`)
  } catch (e) { /* 忽略 */ }
}

export const WIN_FONTS = [
  'Microsoft YaHei', '微软雅黑', 'SimSun 宋体', 'SimHei 黑体', 'KaiTi 楷体',
  'FangSong 仿宋', 'Consolas', 'Courier New', 'Arial', 'Times New Roman',
  'Segoe UI', 'Tahoma', 'Verdana',
]

/* ============================================================================
 *  导出前的"字体核定" (2026-10-13)
 *
 *  ！为什么需要: 系统字是 canvas **同步**渲染的 (renderSysFontCanvas) —— 字体没到位时浏览器
 *    静默换成回退字体, 而画出来的字宽/字形被 sysRenderCache / numFontSysCache 缓存住。
 *    实测 (2026-10-12 现场): OPPO Sans 4.0 / size 100 / spacing -3 → 回退字体每格 53、
 *    真字体每格 59, 两位数字差 12px —— 在这个窗口里点导出, 就把**回退字体的字模**烘进了
 *    ui_font.c, 上板右边多出 12px 把旁边的 "s" 左 4 列擦掉。
 *    所以"出文件"的动作 (一键导出 / 复制全部 / 下载 .c) 必须先过这道闸:
 *      ① await document.fonts.load 把内置字体真拉下来
 *      ② document.fonts.check 复核 (load 在极端情况下可能没生效)
 *      ③ 期间画过回退字体 → refreshFontMetrics() 丢掉那份缓存, 让重建走真字体
 *  ！只卡**内置字体** (随网页发布的 BUILTIN_FONTS): 用户选的系统字体 (Microsoft YaHei 之类)
 *    网页 load 不了, 只能放行 —— 浏览器自己挑替代, 与旧行为一致; 判据在 ensureFontsReady。
 * ========================================================================== */
let sysFontSuspect = false          /* 有没有在"字体没就绪"时画过内置系统字 */
export function isBuiltinFamily(family) { return BUILTIN_FONTS.some(f => f.family === family) }
/** 某族/字重/字号现在能不能真的画出来 (老浏览器没有 document.fonts 时不判, 与旧行为一致) */
export function fontsAvailable(family, weight = 400, size = 32) {
  try {
    if (typeof document === 'undefined' || !document.fonts?.check) return true
    return document.fonts.check(`${weight} ${Math.max(4, Math.round(size))}px "${family}"`)
  } catch (e) { return true }
}
/** 工程里"用 canvas 画系统字"实际会请求的 (family/weight/size) 清单 */
export function neededFontSpecs() {
  const out = new Map()
  for (const inst of state.instances || []) {
    const cfg = inst.sysfont
    if (!cfg) continue
    const family = cfg.family || DEFAULT_FONT
    const weight = Math.max(100, Math.min(900, Math.round(cfg.bold ? 700 : (cfg.weight || 400))))
    const size = Math.max(4, Math.round(+cfg.size || 20))
    const sig = `${family}|${weight}|${size}`
    if (!out.has(sig)) out.set(sig, { family, weight, size })
  }
  return [...out.values()]
}
/** 导出前核定: 拉字体 → 复核 → (必要时) 清掉回退字体的缓存。返回 { ok, missing } */
export async function ensureFontsReady() {
  const specs = neededFontSpecs().filter(s => isBuiltinFamily(s.family))
  if (!specs.length) return { ok: true, missing: [] }     /* 工程里没有系统字: 不拦 */
  await Promise.all(specs.map(s => ensureFont(s.family, s.weight, s.size)))
  const missing = [...new Set(specs
    .filter(s => !fontsAvailable(s.family, s.weight, s.size))
    .map(s => `${s.family} ${s.weight}`))]
  if (!missing.length && sysFontSuspect) refreshFontMetrics()   /* 丢掉回退字体画出来的那一份 */
  return { ok: missing.length === 0, missing }
}

const sysRenderCache = new Map()   // cfgKey -> canvas
const SS = 4                        // 4x 超采样, 缩回后平滑抗锯齿

/* ---------- 光晕 (外发光) ----------
 * 「编辑系统字」里的开关 + 三参数, 默认**关闭**。三个值都归一化到这里, 三条造字路
 * (固定文本 / 数字字库 / ASCII 字库) 与两条缓存键共用同一口径, 免得各处算得不一样。
 * ！光晕是**烘进字节**的 (和边缘斜坡 σ 一样): 预览读的就是这份字节 ⇒ 所见即板上,
 *   固件渲染代码一行都不用改。 */
export function glowCfg(cfg) {
  if (!cfg) return { on: false, thresh: 40, sigma: 0, gain: 1, pad: 0, fit: false }
  const num = (v, d, lo, hi) => {
    const x = +v
    return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d
  }
  const thresh = Math.round(num(cfg.glowThresh, 40, 0, 255))
  const sigma = num(cfg.glowSigma, 0, 0, 12)     /* 默认 0 = 关: σ 自己就是开关 (2026-10-17 起不另设开关) */
  const gain = num(cfg.glowGain, 1, 0, 4)
  /* 紧排 (glowFit): 光晕照算, 但只保留原格子内的部分 —— 数字/ASCII 字库的**字距与格子尺寸
   * 完全不变** (代价: 格子边缘的弱光被切掉, 大 σ 时能看到格子边界)。
   * 默认 false = 老行为 (四周外扩 ceil(3σ), 光晕完整, 字距随之拉开)。 */
  const fit = !!cfg.glowFit
  /* σ 自己就是开关 (2026-10-17 起不另设独立开关): σ>0 且增益>0 才发光。
   * 旧版那个 `glow` 独立开关的兼容闸已删 —— 线上那一版发布后没有任何工程存过 `glow` 键 (已确认),
   * 留着只会让人以为还存在一个"开关"字段。 */
  const on = sigma > 0 && gain > 0
  return { on, thresh, sigma, gain, pad: glowPadOf(thresh, sigma, gain, on), fit }
}

/** 灰度字节 → 叠光晕 (关掉时返回**同一个引用**, 零开销) */
function withGlow(values, w, h, g) {
  if (!g.on) return values
  return addGlowLike(values, w, h, g.thresh, g.sigma, g.gain)
}

/** 光晕后的系统字画布 (四周补 pad, 免得光晕被画布边缘切平)。
 *  ！syncSysSize 与 instanceProc **必须**走同一个结果: 尺寸 = 墨迹框 = 导出数组的步长,
 *   两者不一致就会一行行错开 (已知故障模式, 见 syncSysSize 注释)。 */
const sysGlowCache = new Map()
export function sysGlowCanvas(cfg) {
  const base = renderSysFontCanvas(cfg)
  if (!base) return null
  const g = glowCfg(cfg)
  if (!g.on || g.pad <= 0) return base
  const key = JSON.stringify([cfg, g.pad])
  const hit = sysGlowCache.get(key)
  if (hit) return hit
  const W = base.width + 2 * g.pad, H = base.height + 2 * g.pad
  /* ！先把字画进**外扩后的**画布再算光晕。
   *   早先是在原画布上算光晕 (addGlowLike(base 那一片) 再拷进外扩画布) —— 那是错的:
   *   addGlowLike 的输出与原画布同尺寸, 光晕在最外一圈就被**切平**了, 外扩出来的 pad
   *   全是空像素 (alpha 0, inkBox 根本看不见)。补 pad 的**全部意义**就是让光晕画得下。 */
  const t = document.createElement('canvas')
  t.width = W; t.height = H
  t.getContext('2d').drawImage(base, g.pad, g.pad)
  const src = processImage(t, W, H, 'GRAY', {})
  const vals = addGlowLike(src.values, src.w, src.h, g.thresh, g.sigma, g.gain)
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')
  const img = ctx.createImageData(W, H)
  for (let i = 0, n = W * H; i < n; i++) {
    const v = vals[i]
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  if (sysGlowCache.size > 40) sysGlowCache.clear()
  sysGlowCache.set(key, cv)
  return cv
}

/** 字体刚加载完时把系统字渲染缓存清掉 (否则会一直用后备字体画出来的那张) */
export function clearSysFontCache() {
  sysRenderCache.clear()
  /* ！光晕画布也得一起清: 它是**在 renderSysFontCanvas 的结果上**再加工的, 只清前者的话
   *   字体迟到后（用回退字体画的那一代）光晕画布还留着, 下面照样拿旧的那张走。 */
  sysGlowCache.clear()
}

export function renderSysFontCanvas(cfg) {
  const key = JSON.stringify(cfg)
  const hit = sysRenderCache.get(key)
  if (hit) return hit
  const all = String(cfg.text ?? '')
  if (!all.length) return null
  const family = cfg.family || DEFAULT_FONT
  const weight = Math.max(100, Math.min(900, Math.round(cfg.bold ? 700 : (cfg.weight || 400))))
  const font = `${weight} ${Math.round(cfg.size * SS)}px "${family}", sans-serif`
  /* ！字体没就绪时 canvas 会静默用回退字体画 —— 记一笔, 导出前核定 (ensureFontsReady) 会据此清缓存 */
  if (isBuiltinFamily(family) && !fontsAvailable(family, weight, cfg.size)) sysFontSuspect = true
  const meas = document.createElement('canvas').getContext('2d')
  meas.font = font
  const sp = Math.round((cfg.spacing || 0) * SS)          // 字间距 (允许负数: 字叠字)
  const lh = Math.round((cfg.lineGap || 0) * SS)          // 行间距 (多行时)
  /* 画布高度 / 基线:
   *  · 调用方给了 cfg.boxH + cfg.baseline → "格子由我来定" (ASCII 字库/数字字库那条路), 原样用;
   *  · 否则 (普通系统字文字层) 画布 = size, 但**按字迹兜住上下偏移** —— 上移就在顶部补同样的白,
   *    下移就在底部补。以前是直接平移基线, 于是「上下」填 -1 就把字顶切了
   *    (2026-10-14 现场: "为什么 -1 会导致字体上方被截断, 明明还有空间上移")。 */
  const offDev = Math.round((cfg.offsetY || 0) * SS)
  const fit = cfg.boxH == null
  const padTop = fit ? Math.max(0, -offDev) : 0
  const padBottom = fit ? Math.max(0, offDev) : 0
  const bigH = Math.max(1, Math.round((cfg.boxH == null ? cfg.size : cfg.boxH) * SS) + padTop + padBottom)

  /* 单行: 返回 {cv, w, h} (设备像素画布, 已按 SS 超采样) */
  const drawLine = (text) => {
    const chars = [...text]
    if (!chars.length) return { cv: null, w: 0, h: bigH }
    const widths = chars.map(c => meas.measureText(c).width)
    /* 逐字左右微调 (系统字微调窗): 先算偏移范围, 画布左右各让出空间, 再逐字平移。
     * 数字/ASCII 字库在各自生成函数里算偏移, 这里传 glyphDx:null 就不会重复。 */
    const dxMap = (cfg.glyphDx && typeof cfg.glyphDx === 'object') ? cfg.glyphDx : null
    const dxs = chars.map(c => (dxMap ? Math.round(+dxMap[c] || 0) : 0))
    const minDx = Math.min(0, ...dxs), maxDx = Math.max(0, ...dxs)
    const totalW = Math.max(1, Math.round(widths.reduce((a, b) => a + b, 0)
      + sp * (chars.length - 1)) + (maxDx - minDx))
    const big = document.createElement('canvas')
    big.width = totalW; big.height = bigH
    const bx = big.getContext('2d')
    bx.font = font
    bx.fillStyle = '#fff'
    bx.textBaseline = 'alphabetic'
    // 基线按实际字形上沿放置 (消除字体内部行距空白), offsetY 手动微调
    let ascent = 0
    if (cfg.ascent != null) {
      ascent = cfg.ascent                                   // 逐字渲染时用同一个基线, 数字才不会上下跳
    } else {
      for (const c of chars) ascent = Math.max(ascent, bx.measureText(c).actualBoundingBoxAscent || 0)
    }
    const baseline = cfg.baseline != null
      ? Math.round(cfg.baseline)                            // 调用方给定的格子: 基线也由它定
      : Math.round(padTop + offDev + ascent)
    let x = -minDx
    chars.forEach((c, i) => { bx.fillText(c, x + dxs[i], baseline); x += widths[i] + sp })
    return { cv: big, w: totalW, h: bigH }
  }

  const lines = all.split('\n')
  const parts = lines.map(drawLine)
  const totalW = Math.max(1, ...parts.map(p => p.w))
  const totalH = Math.max(1, parts.reduce((a, p) => a + p.h, 0) + lh * Math.max(0, lines.length - 1))
  const big = document.createElement('canvas')
  big.width = totalW; big.height = totalH
  const bx = big.getContext('2d')
  let y = 0
  for (const p of parts) {
    if (p.cv) bx.drawImage(p.cv, 0, y)
    y += p.h + lh
  }
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(totalW / SS))
  cv.height = Math.max(1, Math.round(totalH / SS))
  const ctx = cv.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(big, 0, 0, cv.width, cv.height)
  if (sysRenderCache.size > 40) sysRenderCache.clear()
  sysRenderCache.set(key, cv)
  return cv
}

/* 本地字体文件管理 (FontFace + IndexedDB 持久化) */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('lcd-layout', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('fonts', { keyPath: 'id' })
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function idbPut(rec) {
  const db = await idb()
  return new Promise((res, rej) => {
    const t = db.transaction('fonts', 'readwrite')
    t.objectStore('fonts').put(rec)
    t.oncomplete = res
    t.onerror = () => rej(t.error)
  })
}
async function idbAll() {
  const db = await idb()
  return new Promise((res, rej) => {
    const q = db.transaction('fonts', 'readonly').objectStore('fonts').getAll()
    q.onsuccess = () => res(q.result || [])
    q.onerror = () => rej(q.error)
  })
}
async function idbDel(id) {
  const db = await idb()
  return new Promise((res, rej) => {
    const t = db.transaction('fonts', 'readwrite')
    t.objectStore('fonts').delete(id)
    t.oncomplete = res
    t.onerror = () => rej(t.error)
  })
}

/* 一键导出目录句柄 (FileSystemDirectoryHandle) —— 不能塞进 JSON,
 * 只能按工程里的 exportDir.id 存进 IndexedDB; 换机器/清缓存后自然失效, 再选一次即可.
 * 单独一个 DB: 不动老字体库的版本 (避免升级时被其它标签页卡住). */
function idbDirs() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('lcd-layout-dirs', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('dirs', { keyPath: 'id' })
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function idbDirPut(rec) {
  const db = await idbDirs()
  return new Promise((res, rej) => {
    const t = db.transaction('dirs', 'readwrite')
    t.objectStore('dirs').put(rec)
    t.oncomplete = res
    t.onerror = () => rej(t.error)
  })
}
async function idbDirGet(id) {
  const db = await idbDirs()
  return new Promise((res, rej) => {
    const q = db.transaction('dirs', 'readonly').objectStore('dirs').get(id)
    q.onsuccess = () => res(q.result || null)
    q.onerror = () => rej(q.error)
  })
}

/** 记住这个工程选中的导出目录句柄 (id 由 rememberExportDir 生成) */
export async function saveExportDirHandle(id, handle) {
  if (!id || !handle || typeof indexedDB === 'undefined') return false
  try {
    await idbDirPut({ id, handle, name: String(handle.name || ''), at: Date.now() })
    return true
  } catch (e) {
    return false
  }
}

/** 取出工程 JSON 里 exportDir.id 对应的本机目录句柄 (没有/不支持时返回 null) */
export async function loadExportDirHandle(id) {
  if (!id || typeof indexedDB === 'undefined') return null
  try {
    const rec = await idbDirGet(id)
    return rec && rec.handle ? rec.handle : null
  } catch (e) {
    return null
  }
}

/** 用户选了一个导出目录 → 生成这个工程专属的句柄键, 写进工程 (下次保存随 JSON 带走).
 *  每次明选都给新 id: 即使两个存档是从同一个工程"另存为"出来的, 也不会互相改目录. */
export async function rememberExportDir(handle) {
  if (!handle) return null
  const name = String(handle.name || '').trim().slice(0, 120) || '导出目录'
  const id = uid('dir')
  state.exportDir = { name, id }
  await saveExportDirHandle(id, handle)
  return state.exportDir
}

const fontFaces = new Map()   // id -> FontFace
/* 自定义字库的原始字节 (id -> {id,name,ext,data}) —— 保存工程 / 一键导出时一起带上,
 * 否则换台机器打开工程只剩 family 名字, 字体其实是缺的。 */
const fontData = new Map()

function fontExtOf(name) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(String(name || ''))
  return m ? '.' + m[1].toLowerCase() : '.ttf'
}
function abToB64(buf) {
  const u = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000))
  return btoa(s)
}
function b64ToAb(b64) {
  const s = atob(String(b64 || ''))
  const u = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
  return u.buffer
}
/** 当前工程真正引用到的字体系列:
 *   · 系统字图层的 sysfont.family (文字/数字/ASCII 都是系统字);
 *   · 多帧画板里文字层的 family (画板素材保存的 frameGroupDoc.frames[].layers[])。
 *  只认"system"文字层: 用字库素材拼字的层 (source='asset') 不需要字体原文件。 */
export function usedFontFamilies(instances = state.instances, assets = state.assets) {
  const names = new Set()
  for (const inst of instances || []) {
    const fam = inst && inst.sysfont && inst.sysfont.family
    if (fam) names.add(String(fam).trim())
  }
  for (const a of assets || []) {
    const frames = a && a.frameGroupDoc && a.frameGroupDoc.frames
    if (!Array.isArray(frames)) continue
    for (const f of frames) {
      for (const l of (f && f.layers) || []) {
        if (l && l.kind === 'text' && l.source !== 'asset' && l.family) names.add(String(l.family).trim())
      }
    }
  }
  names.delete('')
  return names
}

/** 从自定义字库列表里挑出"当前工程引用到 + 有原文件字节"的那些 (纯函数, 可自检).
 *  同名只留一份 (同一个字体被加载过两次时, 导出目录里也只放一个文件). */
export function filterUsedCustomFonts(fonts, instances = state.instances, assets = state.assets) {
  const list = fonts == null ? [] : (Array.isArray(fonts) ? fonts : [...fonts])
  const used = usedFontFamilies(instances, assets)
  const seen = new Set()
  const out = []
  for (const f of list) {
    const name = String(f && f.name || '').trim()
    if (!name || !f.data || !used.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push(f)
  }
  return out
}

/** 一键导出用: 当前工程用到的自定义字库原文件 (name/ext/data); 没用到的一个都不带 */
export function usedCustomFontFiles() {
  return filterUsedCustomFonts(fontData.values())
}

export async function loadFontFile(file) {
  const buf = await file.arrayBuffer()
  const name = (file.name.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5 -]/g, '') || 'CustomFont')
  const face = new FontFace(name, buf)
  await face.load()
  document.fonts.add(face)
  const id = uid('font')
  await idbPut({ id, name, data: buf }).catch(() => {})
  fontFaces.set(id, face)
  fontData.set(id, { id, name, ext: fontExtOf(file.name), data: buf.slice(0) })
  state.customFonts.push({ id, name })
  return name
}

export async function removeFont(id) {
  const face = fontFaces.get(id)
  if (face) { document.fonts.delete(face); fontFaces.delete(id) }
  await idbDel(id).catch(() => {})
  fontData.delete(id)
  state.customFonts = state.customFonts.filter(f => f.id !== id)
}

export async function initCustomFonts() {
  try {
    const all = await idbAll()
    for (const rec of all) {
      try {
        const face = new FontFace(rec.name, rec.data)
        await face.load()
        document.fonts.add(face)
        fontFaces.set(rec.id, face)
        fontData.set(rec.id, { id: rec.id, name: rec.name, ext: fontExtOf(rec.name), data: rec.data })
        state.customFonts.push({ id: rec.id, name: rec.name })
      } catch (e) { /* 跳过坏字体 */ }
    }
  } catch (e) { /* IndexedDB 不可用 */ }
}

/* 从工程 JSON 恢复自定义字库 (保存时随 JSON 一起上传) */
async function restoreFontsFromProject(fonts) {
  if (!Array.isArray(fonts) || !fonts.length) return
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return
  let added = 0
  for (const f of fonts) {
    if (!f || !f.data || !f.name) continue
    if (state.customFonts.some(x => x.name === f.name)) continue
    try {
      const data = b64ToAb(f.data)
      const face = new FontFace(f.name, data)
      await face.load()
      document.fonts.add(face)
      const id = f.id || uid('font')
      await idbPut({ id, name: f.name, data }).catch(() => {})
      fontFaces.set(id, face)
      fontData.set(id, { id, name: f.name, ext: f.ext || fontExtOf(f.name), data })
      state.customFonts.push({ id, name: f.name })
      added++
    } catch (e) { /* 跳过坏字体 */ }
  }
  if (added) state._imgTick++
}

export function addSysInstance(cfg, fmt = 'GRAY') {
  const sc = screen.value
  const cv = renderSysFontCanvas(cfg)
  if (!cv) return null
  const inst = {
    id: uid('inst'),
    kind: 'image',
    page: 0,                            // 页号=序号=切页顺序
    sysfont: { ...cfg },
    name: 'txt_' + (state.instances.filter(i => i.sysfont).length + 1),
    x: Math.round((sc.w - cv.width) / 2),
    y: Math.round((sc.h - cv.height) / 2),
    w: cv.width, h: cv.height,
    fmt, color: 0xFFFF, mirror: false, frame: null, crop: { x: 0, y: 0 },
  }
  state.instances.push(inst)
  state.ui.selectedId = inst.id
  return inst
}

function syncSysSize(inst) {
  if (!inst.sysfont) return
  if (inst.bind) {          // 系统字 + 数字: 尺寸 = 整行数字宽 (含字距) × 字高
    const f = numFontFor(inst)
    const lay = numLayout(inst.bind, f)
    inst.w = Math.max(1, lay.w)
    inst.h = lay.h
    return
  }
  const cv = sysGlowCanvas(inst.sysfont)
  if (!cv) return
  /* 尺寸 = **墨迹框** (instanceProc 也按它裁切) —— 选区 / 帧表 / 导出数组的步长三者必须一致。
   * 以前这里用整张画布 (含四周空白), 而 instanceProc 却按黑边裁过 → 数组长度 ≠ w*h,
   * 固件按 w 字节一行读就一行行错开 (现象: 字形向右倾斜)。 */
  const box = glowCfg(inst.sysfont).on ? inkBoxLit(cv) : inkBox(cv)
  inst.w = box ? box.w : cv.width
  inst.h = box ? box.h : cv.height
}

/* ---------- 圆环部件 (期1 预览) ---------- */
/* 屏幕可用区中心锚点 (圆屏 = 可用圆心, 方屏 = 屏幕中心) */
export function centerAnchor(sc) {
  if (sc?.round) { const g = roundGeom(sc); return { cx: g.cx, cy: g.cy } }
  return { cx: (+sc?.w || 0) / 2, cy: (+sc?.h || 0) / 2 }
}

/* 可用直径: 圆屏 = 可用圆直径, 方屏 = 短边 */
export function usableDiameter(sc) {
  return sc?.round ? roundGeom(sc).r * 2 : Math.min(sc.w, sc.h)
}

/** 「锁定屏幕中心」时**环的落位**: 让环的圆心 (导出/固件用的像素中心
 *  `floor(x + (w-1)/2)`, 就是 RING_CX/CY) 落在屏幕的中央像素上 —— 而不是简单把图层矩形居中。
 *
 *  为什么不能直接居中图层: 环心在图层里的位置是 `floor((w-1)/2)` (固件同一条取整规则),
 *  图层矩形居中 (x = 屏心 − w/2) 时环心 = 屏心 − w/2 + floor((w-1)/2):
 *  偶数宽差 1px、奇数宽差 0.5px → 改尺寸时环心就在两三个像素之间跳 (用户现场:
 *  "锁定后调整尺寸会导致圆心偏移")。这里反过来解: x = 目标环心 − floor((w-1)/2),
 *  整数解 → 图层偏移保持整数 (与固件逐像素对拍的前提), 环心永远钉在屏心那一个像素上。 */
export function centerRingRect(sc, w, h) {
  const a = centerAnchor(sc)
  const W = Math.max(1, Math.round(+sc?.w || 0)), H = Math.max(1, Math.round(+sc?.h || 0))
  /* 目标环心像素: 圆屏 = 它的圆心像素; 方屏 = 中间那个像素 (floor((W-1)/2), 与固件对
   * "正方图层"的 RING_CX 取法同一个约定) */
  const tx = sc?.round ? Math.round(a.cx) : Math.floor((W - 1) / 2)
  const ty = sc?.round ? Math.round(a.cy) : Math.floor((H - 1) / 2)
  const ww = Math.max(1, Math.round(+w || 1)), hh = Math.max(1, Math.round(+h || 1))
  return { x: tx - Math.floor((ww - 1) / 2), y: ty - Math.floor((hh - 1) / 2) }
}

export function addRingInstance() {
  /* 一个工程只支持一个环: 板子上引擎是单例 (一套白斑窗口缓冲 1216B + 一个 BTIM),
   * 导出的 ring_config.h 也只有一份参数 —— 多出来的环在板子上会被完全忽略。
   * 所以这里直接拒绝第二次添加 (要换形状/参数就改这个环的弹窗)。 */
  const exist = state.instances.find(i => i.kind === 'ring')
  if (exist) return exist
  const sc = screen.value
  const rOut = usableDiameter(sc) / 2       // 默认外径 = 可用区 (240 内切圆屏即 Ø240)
  const ring = {
    gear: 2, dir: 1,                  // 圆环页启动档位/方向 (导出 RING_GEAR_DEF / RING_DIR_DEF)
    rOut, rIn: Math.min(rOut - 1, Math.max(1, Math.round(rOut * 0.72))),
    aa: 2,
    steps: 40, value: 26, startDeg: -90,
    trackColor: 0x6B4D, fillColor: 0x07FF,
    /* 渐变颜色 (仅网页预览): [{ p: 0..100, c: RGB565 }, ...], null = 平色。
     * 沿弧长从起始角铺到结束角; 导出 ring_config.h 只取 0% 点色 (固件仍是单色)。 */
    trackGrad: null, fillGrad: null,
    glintOn: true, glintDeg: 0, glintSigma: 14, glintSpanDeg: 42, glintArcPx: 16,
    /* 两个预览动效开关 (只在网页预览, 固件不读也不导出):
     *   autoGlint = 「光斑动画」白斑沿路径转    autoArc = 「自动动画」进度 0→档位 扫 */
    autoGlint: true, autoArc: true,
    glintMs: 100, syncMcU: true,
    depth: 0, depthStyle: 'ridge', lightDeg: -45,  /* 立体感 (断面方向光): 强度% / 凸起|凹陷 / 光源方位; 0 = 平色 */
    caps: true,
    shape: 'circle',      // 'circle' | 'rect' (圆角矩形 = 板子 RING_SHAPE=1 同一套整数几何, 可逐像素对拍)
    rad: 24, radIn: null, thick: 12,      // 圆角矩形: 外圆角 / 内圆角(空=自动) / 环厚
    inset: 8,             // 留边 (总, px): 环带外沿离图层外框的余量 (内部计算, 不动图层尺寸)
    arcDir: 1,            // 「弧向」进度弧方向: +1 顺时针 / -1 逆时针
    arcEndDeg: null,      // 结束角: null = 整圈 (量程 360°); 数值 = 只画 start→end 这段弧
    effect: 'static',     // 预览效果: 'static' = 静态进度 / 'countdown' = 倒计时 (递减 + 拖尾)
    countMs: 10000,       // 倒计时时长 (ms): 满圈 → 0 用多久
    tailMs: 200,          // 递减边缘拖尾 (ms): 与固件 RINGUI_TAIL_MS 同一口径
    /* 分割 (角向遮罩): 把环带按角度切成 segCount 段, 缝宽 segGapDeg 或百分比 segGapPct,
     * 相位相对弧起点。部分弧按「跨度/N」算节距 (N=70/300° → 4.2857°), 首尾不留缝。
     * segMode: 'groove' = 压暗 (默认) / 'cut' = 缝里透明;
     * segAA = 角向 AA **总过渡宽度** (px, 0 = 硬边), 段/缝边界 + 弧两端共用; segDepth = 压暗量 0..100%。
     * 默认关 (老工程/新环行为不变), 在圆环弹窗「效果 → 分割」里开。 */
    segOn: false, segCount: 90, segGapDeg: 1, segGapPct: null, segPhaseDeg: 0, segMode: 'groove', segAA: 2, aaEdge: 2, segSplit: 5, segDepth: 60,
    /* 扫描导出 (ring_scan.h/.c): 沿递增方向逐像素; 线宽/步长 px; 档位 null = steps; 颜色按 LCD 字节序交换 */
    scanWidth: 2, scanStepPx: 0.5, scanLevels: null, scanSwap: true,
    mirrorX: false,       // 镜像状态 (只作记录; 起止角/弧向/白斑已在镜像时改好)
    centerScreen: true,   // 锁定屏幕中心: x/y 自动跟随屏幕中心 (0.5px 精度)
  }
  const size = Math.ceil(rOut * 2)
  const a = centerAnchor(sc)
  const inst = {
    id: uid('inst'),
    kind: 'ring', ring,
    page: 2,                          // 圆环默认放第 2 页 (页号=序号, 就是切页顺序), 可在图层列表里改
    name: 'ring_' + (state.instances.filter(i => i.kind === 'ring').length + 1),
    x: a.cx - size / 2, y: a.cy - size / 2,   // 居中 (允许 0.5px)
    w: size, h: size,
    fmt: 'RGB565', color: 0xFFFF, mirror: false, frame: null, crop: { x: 0, y: 0 },
  }
  state.instances.push(inst)
  state.ui.selectedId = inst.id
  return inst
}

function syncRingSize(inst) {
  if (!inst.ring) return
  if (inst.ring.shape === 'rect') {
    /* 圆角矩形: 尺寸就是图层 w/h (对话框里填 / 拖) —— 不用半径推, 但「锁定屏幕中心」时
     * 必须跟着尺寸重新落位, 否则改尺寸 (含舞台拖角) 时环心会漂 (用户现场) */
    if (inst.ring.centerScreen) {
      const c = centerRingRect(screen.value, inst.w, inst.h)
      inst.x = c.x; inst.y = c.y
    }
    return
  }
  const size = Math.ceil(inst.ring.rOut * 2)   // 包围盒 = 精确直径
  inst.w = size; inst.h = size
  if (inst.ring.centerScreen) {
    const a = centerAnchor(screen.value)
    inst.x = a.cx - size / 2
    inst.y = a.cy - size / 2
  }
}

/* 白斑自动旋转: 角度写入非响应式 Map, 用 _ringTick 触发重绘 (不触碰持久化防抖) */
const animLastStep = new Map()   // instId -> 上次白斑步进时间 (实例删除时清理)
const animCountStart = new Map() // instId -> 倒计时起点 (ms); 切效果/改时长时 resetRingCountdown 清掉
/* 倒计时从满圈重新开始 (弹窗切到倒计时、改时长/档位时调用) */
export function resetRingCountdown(id) {
  if (id == null) animCountStart.clear()
  else animCountStart.delete(id)
}
export function initRingAnimator() {
  setInterval(() => {
    const now = Date.now()
    let dirty = false
    for (const inst of state.instances) {
      if (inst.kind !== 'ring' || !inst.ring) continue
      const r = inst.ring
      const isCountdown = r.effect === 'countdown'
      /* 两个预览动效开关 (网页预览效果, 固件不读也不导出), 各自独立:
       *   「光斑动画」autoGlint: 白斑相位 += 方向 × 每步弧长 (按一圈弧长折算角度)
       *   「自动动画」autoArc  : 进度值 0→档位 循环扫 (只进动画值, 不动 inst.ring.value)
       * 老工程只存了 autoGlint (一个开关管两件事那版) → ringAnimFlags 当成两个都开 */
      const anim = ringAnimFlags(r)
      if (isCountdown) {
        /* 倒计时: 按真实时间递减 (与 app_ring_ui.c 的 RingUI_Tick 同口径)。
         * valueU = steps × (1 − elapsed / total), 走满 total 后停在 0 约 600ms 再从头开始,
         * 这样递减边缘的拖尾 (drawRing 里的 tail) 一直贴着弧末端渐隐。
         * 倒计时期间不再跑 autoArc, 否则两个源同时改 value。 */
        const total = Math.max(1000, Math.round(r.countMs ?? 10000))
        const steps = Math.max(1, Math.round(r.steps || 40))
        let t0 = animCountStart.get(inst.id)
        if (t0 == null) { t0 = now; animCountStart.set(inst.id, t0) }
        const el = (now - t0) % (total + 600)
        const v = el >= total ? 0 : steps * (1 - el / total)
        setRingAnimValue(inst.id, v)
        dirty = true
      } else {
        animCountStart.delete(inst.id)
      }
      /* 白斑 / 自动动画仍按「帧间隔」节流, 与倒计时的 30ms 刷新解耦
       * (否则 glintMs=100 的工程被倒计时带到 33ms) */
      const ms = Math.max(10, r.glintMs || 100)
      const t = animLastStep.get(inst.id) || 0
      if (now - t >= ms) {
        animLastStep.set(inst.id, now)
        if (!isCountdown && anim.arc) {
          const steps = Math.max(1, Math.round(r.steps || 40))
          if ((r.value ?? 0) >= steps) {
            /* 设计值满档: 停在满环, 不进入 0 的重扫帧 (否则预览会周期性消失) */
            setRingAnimValue(inst.id, steps)
          } else {
            const cur = getRingAnimValue(inst.id, r.value ?? 0)
            setRingAnimValue(inst.id, cur >= steps ? 0 : cur + 1)
          }
          dirty = true
        }
        if (anim.glint && r.glintOn) {
          const dir = (r.dir ?? 1) < 0 ? -1 : 1
          const degPerPx = 360 / ringLapPx(inst.w, inst.h, r)
          const cur = getRingAnimAngle(inst.id, r.glintDeg ?? 0)
          setRingAnimAngle(inst.id, ((cur + dir * (r.glintArcPx || 16) * degPerPx) % 360 + 360) % 360)
          dirty = true
        }
      }
    }
    if (dirty) state._ringTick++
  }, 30)
}
state.activePresetId = state.presets[0].id

/* ---------- 非响应式缓存 ---------- */
const imageCache = new Map()   // assetId -> HTMLImageElement
const svgImageCache = new Map() // assetId -> SVG HTMLImageElement (用于重新光栅化)
const procCache = new Map()    // instId -> { key, proc }

/* 圆屏扫描用的像素数据缓存: 按 proc._key 复用 getImageData 结果 (拖动时避免每帧重取), 总量封顶 */
const pixelCache = new Map()   // proc._key -> { w, h, data }
let pixelCachePixels = 0
function procPixels(proc) {
  const hit = pixelCache.get(proc._key)
  if (hit && hit.w === proc.canvas.width && hit.h === proc.canvas.height) return hit
  const w = proc.canvas.width, h = proc.canvas.height
  const data = proc.canvas.getContext('2d').getImageData(0, 0, w, h).data
  if (pixelCachePixels + w * h > 8e6) { pixelCache.clear(); pixelCachePixels = 0 }
  const rec = { w, h, data }
  pixelCache.set(proc._key, rec)
  pixelCachePixels += w * h
  return rec
}

export function getAssetImage(asset) {
  let img = imageCache.get(asset.id)
  if (!img) {
    img = new Image()
    img.onload = () => { state._imgTick++ }   // 加载完成后触发响应式重绘
    img.src = asset.src
    imageCache.set(asset.id, img)
  }
  return img
}

export const screen = computed(() => {
  const p = state.presets.find(p => p.id === state.activePresetId) || state.presets[0]
  return p
})

/* ---------- 素材 ---------- */
/* 自动剔除图片四周纯黑边: 扫描非黑 (R+G+B>10) 像素边界, 返回裁切后 canvas; 无黑边返回 null */
function trimBlackEdges(source) {
  const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height
  if (!sw || !sh) return null
  const cv = document.createElement('canvas')
  cv.width = sw; cv.height = sh
  const ctx = cv.getContext('2d')
  ctx.drawImage(source, 0, 0)
  const data = ctx.getImageData(0, 0, sw, sh).data
  let top = sh, bottom = 0, left = sw, right = 0
  const threshold = 10
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4
      if (data[i + 3] < 3) continue
      if (data[i] + data[i + 1] + data[i + 2] > threshold) {
        if (y < top) top = y; if (y > bottom) bottom = y
        if (x < left) left = x; if (x > right) right = x
      }
    }
  }
  if (top > bottom || left > right) return null
  const tw = right - left + 1, th = bottom - top + 1
  if (left === 0 && top === 0 && tw === sw && th === sh) return null
  const out = document.createElement('canvas')
  out.width = tw; out.height = th
  out.getContext('2d').drawImage(cv, left, top, tw, th, 0, 0, tw, th)
  return out
}
/* 内置素材库: 由 scripts/import-fw-assets.mjs 从 MCU 工程导入 (固件那份字库可以删掉,
 * 网页这边随时可用)。幂等: 已存在则跳过; node 自检环境没有 document 时直接返回。 */
/* 图层「值」(动态数字区域) 的默认绑定: 图层列表第二行勾上「值」时用, 导出成 UI_FIELD 的 num 项。
 * demo = 编辑器里的预览值 (MCU 上真实值来自变量), 只影响画面预览, 不导出。 */
export function bindDefaults(instName) {
  const raw = String(instName || '').replace(/[^A-Za-z0-9_]/g, '').replace(/^_+/, '')   // 中文名会变成一串 _ → 去掉
  const tail = raw && /[A-Za-z]/.test(raw[0]) ? raw[0].toUpperCase() + raw.slice(1) : 'Val'
  return {
    type: 'num', name: 'g_ui' + tail, dec: 1, cells: 5, align: 1, pad: 0, bg: 0x0000, demo: 125,
    neg: 0,          /* 值可能为负 → 字库要带 '-' 字形 (不带就省一个字形) */
  }
}

/* 由灰度字节直接加入素材库 (多行内容生成帧用; 浏览器环境) */
export function addGrayAsset(name, gray, w, h, fontMeta = null) {
  if (typeof document === 'undefined' || !w || !h) return null
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  const ctx = cv.getContext('2d')
  const img = ctx.createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    const v = gray[i]
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const asset = { id: uid('asset'), name, src: cv.toDataURL('image/png'), w, h }
  if (fontMeta) asset.font = { glyphW: w, glyphH: h, charset: 'frames', dir: 0, ...fontMeta }
  state.assets.push(asset)
  return asset
}

/* ---------- 复制 / 粘贴对象 (主预览 Ctrl+C → 多帧组 Ctrl+V) ----------
 * 同一页面/同一 origin 用 localStorage 兜底 (不依赖剪贴板权限);
 * 跨页/跨窗口先试系统剪贴板 (image/png + text/plain JSON), 失败再退回本地。 */
const CLIP_KEY = 'lcd-layout-clipboard-v1'
let lastClipboard = null

function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(fr.result)
    fr.onerror = rej
    fr.readAsDataURL(blob)
  })
}
function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = rej
    i.src = src
  })
}
function saveClipboard(p) {
  lastClipboard = p
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(p)) } catch (e) { /* 大图可能超配额 */ }
}
function readLocalClipboard() {
  if (lastClipboard) return lastClipboard
  try {
    const raw = localStorage.getItem(CLIP_KEY)
    if (raw) { const p = JSON.parse(raw); if (p?.__lcdLayer) { lastClipboard = p; return p } }
  } catch (e) { /* ignore */ }
  return null
}
/** 把剪贴板里的 PNG 变成项目素材 (多帧组粘贴图片用) */
export function addBitmapAsset(name, src, w, h) {
  if (!src) return null
  const a = {
    id: uid('asset'), name: name || ('paste_' + Date.now().toString(36)),
    src, w: Math.max(1, Math.round(+w || 1)), h: Math.max(1, Math.round(+h || 1)),
  }
  state.assets.push(a)
  imageCache.delete(a.id)
  return a
}
/** 主预览选中的对象 → 系统剪贴板 + localStorage; 返回是否成功 */
export async function copySelectedToClipboard() {
  const inst = state.instances.find(i => i.id === state.ui.selectedId)
  if (!inst) return false
  let cv = null
  try {
    if (inst.kind === 'ring') {
      const w = Math.max(2, Math.round(inst.w)), h = Math.max(2, Math.round(inst.h))
      cv = document.createElement('canvas')
      cv.width = w; cv.height = h
      drawRing(cv.getContext('2d'), { ...inst, x: 0, y: 0 }, { bg: 0 })
    } else {
      cv = instanceProc(inst)?.canvas || null
    }
  } catch (e) { cv = null }
  if (!cv) return false
  const dataURL = cv.toDataURL('image/png')
  const p = {
    __lcdLayer: 1, name: inst.name || '对象', kind: 'image',
    dataURL, w: cv.width, h: cv.height,
  }
  if (inst.sysfont) {
    p.kind = 'text'
    p.text = String(inst.sysfont.text || '')
    p.family = inst.sysfont.family || DEFAULT_FONT
    p.size = Math.max(4, Math.round(+inst.sysfont.size || 24))
    p.bold = !!inst.sysfont.bold
    p.color = (inst.color == null ? 0xFFFF : inst.color) & 0xFFFF
    /* 参数复制: 字体/字号/字距/行距/上下/斜坡/光晕/颜色; 粘贴到已有文字层时只覆盖这些, 不动文字内容 */
    p.params = {
      kind: 'text',
      family: p.family, size: p.size, weight: Math.max(100, Math.min(900, Math.round(+inst.sysfont.weight || (p.bold ? 700 : 400)))),
      bold: p.bold, spacing: Math.round(+inst.sysfont.spacing || 0),
      offsetY: Math.round(+inst.sysfont.offsetY || 0), lineGap: Math.round(+inst.sysfont.lineGap || 0),
      rampSigma: Math.max(0, Math.min(2, +inst.sysfont.rampSigma || 0)),
      glowThresh: Math.round(Math.max(0, Math.min(255, +inst.sysfont.glowThresh || 40))),
      glowSigma: Math.max(0, Math.min(12, +inst.sysfont.glowSigma || 0)),
      glowGain: Math.max(0, Math.min(4, +inst.sysfont.glowGain || 1)),
      glowFit: !!inst.sysfont.glowFit,
      color: p.color,
    }
  } else if (inst.kind === 'image' || inst.kind === 'ring') {
    p.params = { kind: 'image', fmt: inst.fmt || 'RGB565', color: (inst.color == null ? 0xFFFF : inst.color) & 0xFFFF, mirror: !!inst.mirror }
  }
  saveClipboard(p)
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      const blob = await (await fetch(dataURL)).blob()
      const text = new Blob([JSON.stringify(p)], { type: 'text/plain' })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob, 'text/plain': text })])
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(JSON.stringify(p))
    }
  } catch (e) { /* 权限/浏览器不支持 → localStorage 兜底 */ }
  return true
}
/** 读剪贴板 (先系统, 后 localStorage); 返回 payload | null */
export async function readClipboardObject() {
  try {
    if (navigator.clipboard?.read) {
      /* 权限弹窗/浏览器实现卡住时别让粘贴一直等: 800ms 后走 localStorage 兜底 */
      const items = await Promise.race([
        navigator.clipboard.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('clipboard timeout')), 800)),
      ])
      for (const it of items) {
        if (it.types.includes('text/plain')) {
          try {
            const t = await (await it.getType('text/plain')).text()
            const p = JSON.parse(t)
            if (p?.__lcdLayer) { saveClipboard(p); return p }
          } catch (e) { /* 不是我们的 JSON */ }
        }
      }
      for (const it of items) {
        if (it.types.includes('image/png')) {
          const blob = await it.getType('image/png')
          const dataURL = await blobToDataURL(blob)
          const img = await loadImage(dataURL)
          const p = { __lcdLayer: 1, name: '粘贴图片', kind: 'image', dataURL, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height }
          saveClipboard(p)
          return p
        }
      }
    }
  } catch (e) { /* 没权限/不支持 */ }
  return readLocalClipboard()
}

/**
 * 安装/校正固件内置素材 (电池图标 10 帧、方向 3 帧、BLE 5 帧…)。
 *
 * ！帧数/尺寸**必须**直接用 ASSETS 元数据 (fwBuiltinAssetMeta), 不能拿
 *   `new Image().width` 去推: 刚 set src 时 width 还是 0 → frames 被算成 1、
 *   w 只剩一格。症状: 素材栏里电池图标显示成 1 帧, 属性弹窗勾了「导出所有帧」
 *   (只显示 "1 帧"), 一键导出也只出 1 帧 —— 用户看到的就是"电池图标导不出来"。
 *   旧存档里已经按 1 帧写进去的 fw_* 素材也要就地修复 (src 是横向长条, 尺寸/帧数改回元数据)。
 */
export function installBuiltinAssets() {
  if (typeof document === 'undefined') return 0
  let n = 0
  /* 2026-11: 默认素材只保留字体。旧 localStorage/旧工程里如果还躺着已下线的内置图片
   * (fw_logo / fw_battery / fw_dir / fw_ble / fw_krpm), 且没有任何图层在引用, 就清掉;
   * 仍被引用的保留, 避免打开旧工程直接缺图。 */
  const keepBuiltin = new Set(FW_BUILTIN.map(b => 'fw_' + b.id))
  const used = new Set((state.instances || []).map(i => i.assetId).filter(Boolean))
  const before = state.assets.length
  state.assets = state.assets.filter(a => !(a.builtin && String(a.id).startsWith('fw_') &&
    !keepBuiltin.has(a.id) && !used.has(a.id)))
  n += before - state.assets.length
  const dropCaches = (assetId) => {
    imageCache.delete(assetId)
    fontCellCache.delete(assetId)
    fontValueCache.delete(assetId)
    procCache.clear()        // 实例的 proc 是按旧帧数/旧尺寸算的, 一律重算
    pixelCache.clear()
    codeCache.clear()
  }
  for (const b of FW_BUILTIN) {
    const id = 'fw_' + b.id
    const meta = fwBuiltinAssetMeta(b)
    const cur = state.assets.find(a => a.id === id)
    if (cur) {
      /* 只修「旧版按 1 帧登记」的那一种, 不碰用户自己拆过的字库:
       *   cur.w 只有一格宽 + 元数据本来是多帧 + font 仍是 frames/1 帧 → 就是坏的那份。
       * 已经正确 (w = glyphW*frames) 或用户改成 custom 字库的, 原样保留。 */
      const brokenFrames = meta.frames > 1 && cur.w === meta.glyphW && cur.h === meta.h &&
        cur.font?.charset === 'frames' && (+cur.font?.frames || 1) === 1
      if (!brokenFrames) continue
      const src = cur.src || fwStripDataURL(b.id)
      if (!src) continue
      Object.assign(cur, { name: b.name, src, w: meta.w, h: meta.h, builtin: true, font: meta.font })
      dropCaches(id)
      n++
      continue
    }
    const src = fwStripDataURL(b.id)
    if (!src) continue
    state.assets.push({
      id, name: b.name, src,
      w: meta.w, h: meta.h,
      builtin: true, font: meta.font,
    })
    n++
  }
  return n
}

/* 一键导出 (图层驱动): 被图层引用的素材自动导出; store=int/ext/lzss 决定去哪。
 * 表/静态绘制/字库都由图层列表自动生成, 不需要单独导出表。 */
/**
 * proc → 导出用的像素。固件只认两种格式 (见 app_ui.h): GRAY8(1B/px) 与 RGB565(2B/px),
 * 素材数组一律按字节 (const uint8_t[])。这里把编辑器内部的几种 proc.kind 归一:
 *   u8          灰度字节                    → GRAY8
 *   u16g        灰度值装在 G565 的 16 位里   → RGB565
 *   u16         RGB565 16 位                → RGB565
 *   macro888/u32 RGB888 → 折算成 RGB565      → RGB565
 * 归一后交给 uiexport.exportAssets 出文本 —— 与帧表 (.px/.fmt) 同一套规则,
 * 不会再出现"表里叫 g_uiFrame0_int、素材里叫 gImage_g_uiFrame0_int"这种对不上的事。
 */
function pixelsOfProc(proc) {
  const { values, kind, w, h } = proc || {}
  if (!values) return null
  if (kind === 'u16') return { rgb: values }
  const n = Math.max(0, Math.round(w) * Math.round(h))
  if (kind === 'u16g') {
    const rgb = new Uint16Array(n)
    for (let i = 0; i < n; i++) rgb[i] = (values[i] >> 2) << 5      // 灰度装入 G 字段
    return { rgb }
  }
  if (kind === 'u8') return { gray: values }
  if (kind === 'macro888' || kind === 'u32') {
    const rgb = new Uint16Array(n)
    for (let i = 0; i < n; i++) {
      const r = kind === 'u32' ? (values[i] >> 16) & 0xFF : values[i * 3]
      const g = kind === 'u32' ? (values[i] >> 8) & 0xFF : values[i * 3 + 1]
      const b = kind === 'u32' ? values[i] & 0xFF : values[i * 3 + 2]
      rgb[i] = rgb888To565(r, g, b)
    }
    return { rgb }
  }
  return null
}

/** proc 像素 → MCU 内存字节 (RGB565 小端; GRAY8 原样)。 */
function pxBytesOf(px) {
  if (!px) return null
  if (px.rgb) return rgb565Bytes(px.rgb)
  return px.gray ? new Uint8Array(px.gray) : null
}


export function exportLayer(opt = {}) {
  const pack = screen.value.grayPack
  const plan = collectLayerPlan(state.instances, state.assets, { grayPack: pack })
  plan.screen = {
    w: Math.round(screen.value.w), h: Math.round(screen.value.h),
    bg: (screen.value.bg == null ? 0x0000 : screen.value.bg) & 0xFFFF,   // UI_PAGE_BG 用 (每套预设自己的底色)
  }   // 切页清屏用
  const intPx = [], extPx = []
  /* LZSS: 分片是可选项。chunkBytes = 0 → 不分片 (单块 = 整帧, 缓冲按最大帧);
   * 否则按行切, 每片 ≤ chunkBytes (行宽超过粒度时退化为 1 行/片)。 */
  const lzssChunked = opt.lzssChunked != null ? !!opt.lzssChunked : !!state.exportOpts.lzssChunked
  const lzssChunkBytes = lzssChunked
    ? Math.max(128, Math.round(+opt.lzssChunkBytes || +state.exportOpts.lzssChunkBytes || 2400))
    : 0
  const lzssGroups = []
  const perLine = state.exportOpts.perLine || 16
  let dyn = 0
  /* 坐标类型: 画布/图层最大边缘 > 255 → uint16 (uint8 静默截断, ui_table.h 里有 #if 哨兵) */
  let coordMax = Math.max(plan.screen.w, plan.screen.h)
  for (const it of plan.items) {
    coordMax = Math.max(coordMax, (+it.x || 0) + (+it.w || 0), (+it.y || 0) + (+it.h || 0))
  }
  const coord16 = coordMax > 255
  for (const it of plan.items) {
    const inst = state.instances.find(i => i.id === it.id)
    if (!inst) continue
    /* 动态图层 (数字): 固件用字库画数字, 这一层自己的像素既不用也不画 → 不导出像素,
     * 但要把"这一层用的那份字库"带上 (字号跟字库走) */
    if (inst.bind) {
      dyn++
      it.fontTable = numFontFor(inst, it.key)
      it.bind = { ...it.bind, fontName: it.fontTable.name }
      continue
    }
    /* 系统字「ASCII 字库」层: 整份 0x20..0x7E 字模 + <名字> / <名字>Str 两个函数
     * (见 layerexport 的 idFunctionParts)。这一层显示的示例文本仍按普通素材导出成静态帧。 */
    if (inst.ascii && !inst.bind && pixelExported(it)) {
      const t = asciiTableFor(inst)
      if (t) {
        it.fnName = sanitizeName(inst.name) || it.key
        it.ascii = true
        it.picTable = { name: it.fnName + 'Pic', gw: t.w, gh: t.h, rows: t.rows,
                        first: t.first, count: t.count, gap: t.gap }
      }
    }
    /* 文字层: 除了字符串图, 再给一张"按 ID 取图"的字模表 (函数名 = 图层名, 见 layerexport);
     * 可在「＋文字」弹窗里关掉 (字模表要占 flash) */
    if (inst.kind === 'text' && inst.idFn !== false && pixelExported(it)) {
      const a = state.assets.find(x => x.id === inst.assetId)
      if (a?.font && a.font.charset !== 'frames') {
        const glyphs = fontGlyphValues(a, 'GRAY')
        if (glyphs?.length) {
          it.fnName = sanitizeName(inst.name) || it.key
          it.picTable = {
            name: it.fnName + 'Pic',
            gw: a.font.glyphW, gh: a.font.glyphH,
            rows: glyphs.map(g => g.values),
          }
        }
      }
    }
    /* 文字层/ASCII 取图表: 每行一个字模 → LZSS 一组 (每行独立成片, 可按 id 取) */
    if (it.store === 'lzss' && it.picTable?.rows?.length && pixelExported(it)) {
      const key = cIdent((it.fnName || it.key) + 'Pic')
      lzssGroups.push({ key, label: `${it.fnName || it.key} 字模`, w: it.picTable.gw, h: it.picTable.gh,
                        fmt: FMT_GRAY8, images: it.picTable.rows.map(r => new Uint8Array(r)) })
      it.picTable.lzssKey = key
    }
    /* 多帧图标 + 勾了"导出所有帧": 所有帧拼成**一个连续大数组** (<key>,
     * key = g_uiFrameN_ext/int; 第 k 帧在偏移 k*每帧大小处), 再配一个按 id 取帧的函数
     * (0=关闭, 1..N=帧)。数组名与帧表条目同名, 不再用 g_uiExtN 这种和帧号对不上的编号。
     * 连续存放 = 取帧就是数组偏移, 函数体不需要逐帧 switch (armcc 也不需要指针表)。
     * ！逐帧像素 = 克隆实例换 frame 号再走同一渲染管线 (缓存按 id 隔离, 互不污染)。
     * ！「仅尺寸」(没同时勾「仅素材」) 时整块跳过: 不导像素就不该生成取帧函数/数组。 */
    if (inst.allFrames && pixelExported(it)) {
      const a = state.assets.find(x => x.id === inst.assetId)
      const cnt = framesCount(a)
      if (cnt > 0) {
        const framePx = (fi) => pixelsOfProc((() => { try { return instanceProc({ ...inst, id: inst.id + '#f' + fi, frame: fi }) } catch { return null } })())
        const first = framePx(0)
        const isRgb = !!first?.rgb
        const per = Math.max(0, Math.round(it.w) * Math.round(it.h))   /* 每帧像素/字节 数 */
        let okAll = !!first && per > 0
        const acc = isRgb ? new Uint16Array(per * cnt) : new Uint8Array(per * cnt)
        for (let fi = 0; okAll && fi < cnt; fi++) {
          const px2 = framePx(fi)
          const src = px2 ? (isRgb ? px2.rgb : px2.gray) : null
          if (!src || src.length !== per || !!px2.rgb !== isRgb) { okAll = false; break }
          acc.set(src, fi * per)
        }
        if (okAll) {
          /* ！gray 按像素**实际格式**判定 (px.rgb 有值 = RGB), 不按图层 fmt ——
           *   多帧素材的 fmt 勾选和像素实际格式可能不一致, 按像素才是权威。 */
          it.allFrames = { fn: sanitizeName(inst.name) || it.key, count: cnt,
                           gray: !isRgb, ext: !!it.ext, lzss: it.store === 'lzss' }
          /* 帧表条目引用**选中的那一帧** (帧选择器 1..N 控制; 0/仅素材时无页面绘制,
           * 条目仍按选中帧给, 固件另有按 id 取帧函数) */
          it.frame = inst.frame == null ? 0 : inst.frame
          if (it.store === 'lzss') {
            /* 每帧一块/一组片; 帧序与 .index 一致 (0..cnt-1) */
            const images = []
            for (let fi = 0; fi < cnt; fi++) {
              const part = acc.subarray(fi * per, (fi + 1) * per)
              images.push(isRgb ? rgb565Bytes(part) : new Uint8Array(part))
            }
            lzssGroups.push({ key: it.key, label: inst.name || it.key, w: it.w, h: it.h,
                              fmt: isRgb ? FMT_RGB565 : FMT_GRAY8, images })
          } else {
            /* 一个大数组: 注释里的 WxH 写总尺寸 (帧数*帧高), 寻址按每帧 w*h */
            ;(it.ext ? extPx : intPx).push({ name: it.key, w: it.w, h: it.h * cnt,
                                             ...(isRgb ? { rgb: acc } : { gray: acc }) })
          }
          continue            /* 这一层的"单帧"数组不再单独导出 (全帧已含) */
        }
      }
    }
    let proc = null
    try { proc = instanceProc(inst) } catch (e) { proc = null }
    /* proc 已经是"按图层自己的裁切窗口 + 尺寸"的成品图 (不用也不能再传 inst.crop) */
    const px = pixelsOfProc(proc)
    if (!px) continue
    /* 「仅尺寸」单独勾 (没同时勾「仅素材」): 这一层只留坐标/尺寸 (帧表 .px = 0), 不导像素 */
    if (!pixelExported(it)) continue
    if (it.store === 'lzss') {
      const bytes = pxBytesOf(px)
      if (bytes) {
        lzssGroups.push({ key: it.key, label: inst.name || it.key, w: it.w, h: it.h,
                          fmt: px.rgb ? FMT_RGB565 : FMT_GRAY8, images: [bytes] })
      }
    } else {
      ;(it.ext ? extPx : intPx).push({ name: it.key, w: it.w, h: it.h, ...px })
    }
  }
  /* 数字字库: 走 LZSS 的字形也进同一张表 (每个字形一块/一组片; 与帧共用 ID 空间) */
  const fontSets = fontGlyphSetsFor(plan)
  /* 字模的左右条在"字库层"拆: 每个字形拆成 parts 个窄图 (如 54×80 → 27×80 + 27×80),
   * 存进统一表时仍是普通矩形 (不需要 x 偏移, 帧表格式保持干净)。
   * 字模粒度始终 ≤ 2400 B (旧 g_assetBuf 口径), 与帧的「分片」开关无关。 */
  const fontParts = new Map()   // name -> { parts, partW, count, keys, base, chunks }
  for (const { f, set } of fontSets) {
    if (f.store !== 'lzss') continue
    const sp = splitFontParts(set, state.exportOpts.lzssChunkBytes || 2400)
    const keys = []
    sp.groups.forEach((grp, p) => {
      const key = cIdent(f.name + (sp.parts > 1 ? `GlyphP${p}` : 'Glyph'))
      keys.push(key)
      lzssGroups.push({ key, label: `${f.name} 字库${sp.parts > 1 ? ` P${p + 1}/${sp.parts}` : ''}`,
                        w: grp.width, h: sp.height, fmt: FMT_GRAY8, images: grp.images })
    })
    fontParts.set(f.name, { parts: sp.parts, partW: sp.partW, count: sp.count, keys })
  }

  /* 先规划 ID (帧表/字库代码要引用), 再压缩 —— 表项顺序与 ID 一一对应。 */
  let lzssPlan = null, lzssEnc = null
  if (lzssGroups.length) {
    lzssPlan = planLzss(lzssGroups, { chunkBytes: lzssChunkBytes })
    plan._fontLzss = new Map()
    const byKey = new Map()
    for (const it of plan.items) {
      if (it.kind === 'ring') continue
      byKey.set(cIdent(it.key), { it })
      if (it.picTable?.lzssKey) byKey.set(cIdent(it.picTable.lzssKey), { it, pic: true })
    }
    for (const [name, m] of fontParts) for (const k of m.keys) byKey.set(k, { font: name })
    for (const g of lzssPlan.groups) {
      const info = { key: g.key, base: g.base, chunks: g.chunks, frames: g.frames }
      const hit = byKey.get(g.key)
      if (!hit) continue
      if (hit.pic) hit.it.picTable.lzss = info
      else if (hit.font) {
        const m = fontParts.get(hit.font)
        if (m && m.base == null) { m.base = g.base; m.chunks = g.chunks }
      } else hit.it.lzss = info
    }
    for (const [name, m] of fontParts) {
      plan._fontLzss.set(name, { key: m.keys[0], base: m.base, chunks: m.chunks,
                                 parts: m.parts, partW: m.partW, count: m.count })
    }
    lzssEnc = encodeLzss(lzssPlan)
  }
  /* 原始素材字节数: LZSS 的 rawBytes 只是"走压缩的那部分"; 这里再算内部/外部 raw,
   * 给导出面板一个"如果不压缩、全放内部 Flash 要占多少"的基数。 */
  const pxBytes = (arr) => (arr || []).reduce((n, p) =>
    n + (p.gray ? p.gray.length : (p.rgb ? p.rgb.length * 2 : 0)), 0)
  /* 文字 / ASCII 字库层: 整份字模表不在 fontSets 里 (fontSets 只管数字绑定字库),
   * 而是 plan.items[].picTable.rows。按行字节数计入内部/外部 raw; LZSS 已由 rawBytes 统计。 */
  const picBytes = (it) => (it.picTable?.rows || []).reduce((n, r) => n + (r?.length || 0), 0)
  const rawIntPicBytes = (plan.items || []).reduce((n, it) =>
    n + (it.store === 'lzss' || it.store === 'ext' ? 0 : picBytes(it)), 0)
  const rawExtPicBytes = (plan.items || []).reduce((n, it) =>
    n + (it.store === 'ext' ? picBytes(it) : 0), 0)
  const rawIntBytes = pxBytes(intPx) + rawIntPicBytes + (fontSets || []).reduce((n, x) =>
    n + (x.f.store === 'lzss' || x.f.store === 'ext' ? 0 : (x.set?.bytes?.length || 0)), 0)
  const rawExtBytes = pxBytes(extPx) + rawExtPicBytes + (fontSets || []).reduce((n, x) =>
    n + (x.f.store === 'ext' ? (x.set?.bytes?.length || 0) : 0), 0)
  const lzssExtra = lzssPlan ? {
    rawIntBytes,
    rawExtBytes,
    originalIntBytes: rawIntBytes + (lzssEnc?.stats?.rawBytes || 0),
    originalBytes: rawIntBytes + rawExtBytes + (lzssEnc?.stats?.rawBytes || 0),
  } : {}
  /* 只算 LZSS 预估: 不生成其余 C 文件/工程 JSON/圆环扫描, 避免导出面板拖拽时卡顿 */
  if (opt.onlyLzss) {
    return {
      files: [], plan,
      stat: {
        int: intPx.length, ext: extPx.length, dyn, layers: plan.items.length, skipped: plan.skipped.length,
        tasks: 0,
        lzss: lzssPlan ? {
          ...lzssEnc.stats,
          chunked: lzssPlan.chunked,
          chunkBytes: lzssPlan.chunkBytes,
          warnings: lzssPlan.warnings,
          ...lzssExtra,
        } : null,
      },
    }
  }
  /* 数字字库的字模数组 = 像素数据 → 按图层的选择进素材文件 (int/ext) 或 LZSS 表 */
  const fdata = fontDataFor(plan)
  /* 素材文本只有 exportAssets 一个来源 (与帧表 names/fmt 同源) */
  const assetsC = (list, store) => exportAssets(list, {
    store, uitable: true, perLine, extra: store === 'ext' ? fdata.ext : fdata.int,
  })
  /* ui_task.c 里要调 LCD 原语: 跟着屏幕预设的头部找它 include 的那个 LCD 头 */
  const lcdHeader = (String(screen.value.header || '').match(/#include\s+"([^"]+)"/) || [])[1] || 'bsp_gc9a01.h'
  /* g_uiFrames[] 的长度 = 静态帧数 (圆环/数字层不进表) —— UI_DrawFrame(id) 的越界校验用 */
  const frameCount = plan.items.filter(i => i.kind !== 'ring' && !i.bind).length
  plan.pagePeriods = state.pages || {}          // 每个页面的周期 (图层列表上方的「页面」里设置)
  const taskC = taskCodeFor(plan, { lcdHeader, scrW: plan.screen.w, scrH: plan.screen.h })
  const fontC = fontFileFor(plan, { lcdHeader, coord16 })
  /* 圆环逐像素扫描表 (沿递增方向, 带档位映射) —— 与 ring_config.h 一起导出; 环境不支持 canvas 时自动跳过 */
  let ringScan = null
  try {
    const ringInst = state.instances.find(i => i.kind === 'ring')
    if (ringInst) ringScan = buildRingScan(ringInst, screen.value)
  } catch { ringScan = null }
  /* 圆环每段逐行跨度表 (ring_seg_spans.h): 只有「圆环 + 分段」才生成。
   * 与 ring_config.h 同一次导出 —— 把刚生成的配置文本交给生成器核对 9 个几何
   * 指纹, 对不上就整张跳过 (绝不写一张和配置不同步的表)。
   * 不支持的原因 (圆角矩形/分段关/相位非 0/屏幕过大) 进 stat.ringSpans, 面板显示。 */
  const ringConfig = buildRingConfig()
  let ringSpans = null, ringSpansHeader = null
  try {
    const ringInst = state.instances.find(i => i.kind === 'ring')
    const rs = buildRingSegSpans(ringInst, screen.value, { configText: ringConfig })
    if (rs.ok) {
      ringSpansHeader = rs.header
      ringSpans = { ok: true, code: '', reason: '', bytes: rs.bytes, rows: rs.rows, segs: rs.segs, maxN: rs.maxN }
    } else {
      ringSpans = { ok: false, code: rs.code, reason: rs.reason, bytes: 0, rows: 0, segs: 0, maxN: 0 }
    }
  } catch (e) {
    ringSpans = { ok: false, code: 'error', bytes: 0, rows: 0, segs: 0, maxN: 0,
      reason: '生成器异常: ' + (e && e.message ? e.message : e) }
  }
  let files = [
    { name: 'ui_color.h', text: buildColorHeader(collectUsedColors(plan, plan.screen)) },
    ...(ringScan ? [{ name: 'ring_scan.h', text: ringScan.header }, { name: 'ring_scan.c', text: ringScan.source }] : []),
    { name: 'ring_config.h', text: ringConfig },
    ...(ringSpansHeader ? [{ name: 'ring_seg_spans.h', text: ringSpansHeader }] : []),
    ...(taskC ? [{ name: 'ui_task.c', text: taskC }, { name: 'ui_task.h', text: taskHeaderFor(plan) }] : []),
    { name: 'ui_assets_int.c', text: assetsC(intPx, 'int') },
    { name: 'ui_assets_ext.c', text: assetsC(extPx, 'ext') },
    ...(lzssPlan ? lzssFiles(lzssPlan, lzssEnc, { lcdHeader, frameCount }) : []),
    { name: 'ui_table.h', text: tableHeaderFor(plan, { coordMax }) },
    ...(fontC ? [{ name: 'ui_font.c', text: fontC }] : []),        // 字模数据单独一个文件
    { name: 'ui_table.c', text: tableForPlan(plan) },
    { name: 'ui_user.h', text: userHeaderFor(plan), once: true },   // 只生成一次, 之后不覆盖
  ]
  /* 一键导出同时带上工程备份与自定义字库原文件 (用户 2026-10-23):
   *   lcd-project.json 里已经内嵌字库, 字体原文件再单独放一份, 方便换机器/重装。 */
  try {
    files.push({ name: 'lcd-project.json', text: exportProject() })
    for (const f of usedCustomFontFiles()) {
      const base = String(f.name || 'font').replace(/[^\w\u4e00-\u9fa5 .-]/g, '_').slice(0, 60)
      files.push({ name: 'lcd-font-' + base + (f.ext || '.ttf'), data: f.data })
    }
  } catch (e) { /* 工程 JSON 失败不影响 C 导出 */ }
  /* 可选压缩导出 (默认关闭 = 文件列表/内容与原来逐字节一致):
   *  先按原样生成全部 files, 再整体换成 packed 版 (ui_assets_ext.c → ui_assets_packed.c
   *  + asset_blocks.h + 解码器 asset_lzss.c/.h, ui_font.c 换压缩模板)。
   *  布局不符 (字模/电池/图标数量尺寸不对) → 抛错, 绝不写半套文件。 */

  return {
    files, plan,
    stat: {
      int: intPx.length, ext: extPx.length, dyn, layers: plan.items.length, skipped: plan.skipped.length,
      tasks: taskC ? plan.items.filter(i => i.bind).length : 0,
      ringSpans,
      lzss: lzssPlan ? {
        ...lzssEnc.stats,
        chunked: lzssPlan.chunked,
        chunkBytes: lzssPlan.chunkBytes,
        warnings: lzssPlan.warnings,
        ...lzssExtra,
      } : null,
    },
  }
}

/** 导出前预估 LZSS: 与 exportLayer() 共用同一份 plan/pack, 不存在"预估一套、导出另一套"。
 *  返回 { ok, stat } (stat 为 null = 当前工程没有 LZSS 素材); 出错转成 { ok:false, reason }。
 *  同步计算 (exportLayer 是同步的), 组件里放进 computed 由响应式依赖自动失效。 */
export function estimateLzss(opt = {}) {
  try {
    const { stat } = exportLayer({ ...opt, onlyLzss: true })
    return { ok: true, stat: stat.lzss }
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e), stat: null }
  }
}

/** 导出面板用: 圆环查表 (ring_seg_spans.h) 会不会生成 / 占多少 Flash。
 *  与 exportLayer 共用同一份生成器 + 参数归一化 + 模块缓存, 面板显示的数
 *  就是真正写进文件的那张表; 不重复一套估算公式。 */
export function estimateRingSpans() {
  try {
    const inst = state.instances.find(i => i.kind === 'ring')
    return ringSpansInfo(inst, screen.value, { configText: buildRingConfig() })
  } catch (e) {
    return { ok: false, code: 'error', reason: '生成器异常: ' + (e && e.message ? e.message : e) }
  }
}

export async function addAssetFile(file, opts = {}) {
  const transient = !!opts.transient
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
  if (isSvg) {
    // SVG: 读取文本 → Blob URL 加载 Image → 光栅化为位图 dataURL (颜色正确)
    const svgText = await new Promise((res, rej) => {
      const fr = new FileReader()
      fr.onload = () => res(fr.result)
      fr.onerror = rej
      fr.readAsText(file)
    })
    const img = await new Promise((res, rej) => {
      const i = new Image()
      i.onload = () => res(i)
      i.onerror = rej
      i.src = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }))
    })
    const w = img.naturalWidth || img.width || 256
    const h = img.naturalHeight || img.height || 256
    // 立即光栅化为位图 dataURL (保留原始颜色)
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    cv.getContext('2d').drawImage(img, 0, 0, w, h)
    const src = cv.toDataURL('image/png')
    const asset = { id: uid('asset'), name: file.name, src, w, h, svg: true, svgText }
    if (transient) asset._transient = true      /* 多选合成用的临时素材: 不进总素材库 */
    state.assets.push(asset)
    imageCache.set(asset.id, img)
    svgImageCache.set(asset.id, img)     // SVG Image (用于重新光栅化)
    return asset
  }
  // 普通图片: 原有逻辑
  const src = await new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(fr.result)
    fr.onerror = rej
    fr.readAsDataURL(file)
  })
  const img = await new Promise((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = rej
    i.src = src
  })
  const asset = { id: uid('asset'), name: file.name, src, w: img.naturalWidth, h: img.naturalHeight }
  if (transient) asset._transient = true
  state.assets.push(asset)
  imageCache.set(asset.id, img)
  return asset
}

/* ---------- 多张图片 → 一个多帧素材 ----------
 * 素材的"多帧"就是一张**拼版图** + font={glyphW,glyphH,charset:'frames',dir:'col'}
 * (fontCells 按格子切, 实例上那个"帧"字段选第几格)。这里把 N 张图横向拼成一条:
 * 格子 = 所有图里最大的宽高, 每张在自己的格子里居中, 空处透明。 */
/** 拼版几何 (纯函数, 自检直接测): sizes = [{w,h}, …] → 格子与画布尺寸 */
export function framesSheetMeta(sizes) {
  const list = (sizes || []).filter(s => s && s.w > 0 && s.h > 0)
  if (!list.length) return null
  const cellW = Math.max(...list.map(s => Math.round(s.w)))
  const cellH = Math.max(...list.map(s => Math.round(s.h)))
  return { cellW, cellH, w: cellW * list.length, h: cellH, count: list.length, dir: 'col' }
}

/** 把几张已导入的素材拼成一个多帧素材 (返回新素材; 原来的临时素材会被删掉) */
export function mergeAssetsToFrames(assets, name) {
  const list = (assets || []).filter(Boolean)
  if (!list.length) return null
  const meta = framesSheetMeta(list.map(a => ({ w: a.w, h: a.h })))
  if (!meta) return null
  const cv = document.createElement('canvas')
  cv.width = meta.w; cv.height = meta.h
  const ctx = cv.getContext('2d')
  list.forEach((a, i) => {
    const img = getAssetImage(a)
    if (!img || !img.complete) return
    const dx = i * meta.cellW + Math.round((meta.cellW - a.w) / 2)
    const dy = Math.round((meta.cellH - a.h) / 2)
    ctx.drawImage(img, dx, dy, a.w, a.h)
  })
  const asset = {
    id: uid('asset'),
    name: name || (list[0].name + ` 等${list.length}帧`),
    src: cv.toDataURL('image/png'),
    w: meta.w, h: meta.h,
    font: { glyphW: meta.cellW, glyphH: meta.cellH, charset: 'frames', dir: 'col', frames: meta.count },
  }
  state.assets.push(asset)
  for (const a of list) removeAsset(a.id)      /* 临时素材不留在素材栏里 */
  return asset
}

/** 等一张已缓存的素材图就绪 (刚 set src 时 complete=false) */
function waitAssetImage(img) {
  if (!img) return Promise.resolve(null)
  if (img.complete) return Promise.resolve(img)
  return new Promise(res => {
    const done = () => res(img)
    img.addEventListener?.('load', done, { once: true })
    img.addEventListener?.('error', done, { once: true })
    setTimeout(done, 1500)
  })
}

/**
 * 多帧组 → **一张多帧素材** (不是 N 个图层)。
 * 每帧画进"所有帧里最大的格子"并居中, 所以切帧时图层尺寸/位置完全不变 (不会偏移)。
 * @param frames [{ assetId, frame?: number }]  frame=null/undefined → 整张素材当一帧;
 *               frame 是 0 基 → 取该多帧素材的第 frame 格 (可把现成多帧再拆开重排)
 * @param opts { name, fmt }
 * @returns 新素材 (已进 state.assets) | null
 */
export async function composeFrameAsset(frames, opts = {}) {
  if (typeof document === 'undefined') return null
  const list = []
  for (const fr of (frames || [])) {
    const a = state.assets.find(x => x.id === fr?.assetId)
    if (!a) continue
    const img = await waitAssetImage(getAssetImage(a))
    if (!img) continue
    if (fr.frame != null && a.font) {
      const cells = fontCells(a)
      const cell = cells ? cells[Math.max(0, Math.min(cells.length - 1, Math.round(fr.frame)))] : null
      if (!cell) continue
      list.push({ src: cell.canvas, w: cell.canvas.width, h: cell.canvas.height })
    } else {
      list.push({ src: img, w: Math.max(1, Math.round(a.w)), h: Math.max(1, Math.round(a.h)) })
    }
  }
  const meta = framesSheetMeta(list.map(s => ({ w: s.w, h: s.h })))
  if (!meta) return null
  const cv = document.createElement('canvas')
  cv.width = meta.w; cv.height = meta.h
  const ctx = cv.getContext('2d')
  list.forEach((s, i) => {
    const dx = i * meta.cellW + Math.round((meta.cellW - s.w) / 2)
    const dy = Math.round((meta.cellH - s.h) / 2)
    ctx.drawImage(s.src, dx, dy, s.w, s.h)
  })
  const asset = {
    id: uid('asset'),
    name: opts.name || (list.length > 1 ? `多帧组 ${list.length}帧` : '多帧组'),
    src: cv.toDataURL('image/png'),
    w: meta.w, h: meta.h,
    /* dir='col' = 横排 (fontCells 的命名): 每格 cellW×cellH, 实例上用「帧」选第几格。
     * 不写 boxes ⇒ 所有帧共用整个格子 ⇒ 换帧时 x/y/w/h 不变, 不会位移。 */
    font: { glyphW: meta.cellW, glyphH: meta.cellH, charset: 'frames', dir: 'col', frames: list.length },
    defaultFmt: opts.fmt || 'RGB565',
  }
  state.assets.push(asset)
  return asset
}

/**
 * 保存多帧组编辑器产出的素材: 有 id 就地更新 (src/尺寸/字体/编辑文档), 没有就新建。
 * 更新时清掉素材/像素缓存, 并把引用它的图层尺寸同步到新格子 —— 否则旧图层还按旧 w/h 读,
 * 帧表步长与数组长度对不上 (一行行错开)。
 */
export function saveFrameAsset(id, data) {
  let a = id ? state.assets.find(x => x.id === id) : null
  const isNew = !a
  if (!a) {
    a = { id: uid('asset') }
    state.assets.push(a)
  }
  Object.assign(a, data)
  const ax = a.id
  imageCache.delete(ax)
  fontCellCache.delete(ax)
  fontValueCache.delete(ax)
  procCache.clear()
  pixelCache.clear()
  codeCache.clear()
  const gw = Math.max(1, Math.round(a.font?.glyphW || a.w || 1))
  const gh = Math.max(1, Math.round(a.font?.glyphH || a.h || 1))
  const cnt = Math.max(1, Math.round(a.font?.frames || (gw ? Math.round((a.w || gw) / gw) : 1)))
  for (const inst of state.instances) {
    if (inst.assetId !== ax) continue
    inst.w = gw; inst.h = gh
    delete inst.crop
    if (a.defaultFmt) inst.fmt = a.defaultFmt
    if (inst.frame != null) inst.frame = Math.max(0, Math.min(cnt - 1, inst.frame | 0))
  }
  return { asset: a, isNew }
}

/* ---------- 多帧素材的帧管理 (排序 / 插入 / 删除) ----------
 * 落地方式: 切出每帧画布 → 按新顺序重拼一条横排拼版 (与 mergeAssetsToFrames 同一格局),
 * asset 的 id/名字/实例引用全部不变 —— 实例上的"第几帧"序号自然跟着新顺序走。 */

/** 多帧素材的帧数 (非多帧素材 = 0) */
/** 帧索引 (渲染/预览用): inst.frame 是 0 基, 与网页输入框同值 (**-1 = 仅网页渲染**,
 *  MCU 侧帧表 .index = 255 → 只清底色; 预览按第 0 帧显示)。 */
export function frameIdx(inst) {
  const f = inst?.frame
  return (f == null || f < 0) ? 0 : f
}

export function framesCount(a) {
  return frameStripCount(a)
}

/** 竖排/横排帧条的真实帧数 (framesCount 直接用它)。
 *  以前只看宽度 —— BAT.gif (12×280, dir=row) 会被数成 1 帧;
 *  现在按 dir/长宽比选方向, 与 fontCells 的切法一致。 */
export function frameStripCount(a) {
  const f = a?.font
  if (!f || f.charset !== 'frames') return 0
  const gw = Math.max(1, Math.round(+f.glyphW || 0))
  const gh = Math.max(1, Math.round(+f.glyphH || 0))
  if (!gw || !gh) return 0
  const horiz = f.dir ? f.dir === 'col' : (a.w / gw) >= (a.h / gh)
  const n = Math.ceil((horiz ? a.w : a.h) / (horiz ? gw : gh))
  return Math.max(1, Math.round(n) || 1)
}

/* ---------- 多帧同位置组 (2026-10-21 现场) ----------
 * 需求: 同一个多帧素材的每一帧要**单独设渲染方式** (fmt/颜色/裁切/大小), 但都落在同一个屏幕位置;
 *       换帧不能让字符/图形位移。做法不是"一个图层内换帧", 而是**每帧一个图层** + 一个共享组框:
 *   · 组框尺寸 = 所有变体里最大的 w/h (用户口径: 按最大的帧定组合尺寸);
 *   · 每个变体有自己的 groupOffset (相对组框左上角), 默认在组框里居中;
 *   · 组移动 = 所有变体一起平移; 只改变体偏移 = 只有那一帧在组框里挪;
 *   · 主画布只画组里 current 那一帧 (否则后画的整帧会把前面的盖掉), 子预览逐帧/播放;
 *   · 导出完全不动: 每个变体还是一个普通图层, 各带自己的 fmt/color/frame/裁切。
 * 老工程没有 frameGroups → 空数组, 所有图层无 groupId ⇒ 行为与以前逐字节一致。 */
export function frameGroupOf(id) {
  if (!id) return null
  return (state.frameGroups || []).find(g => g.id === id) || null
}

/** 组里的变体 (按 groupIndex 排序; 脏数据缺 index 时按数组顺序兜底) */
export function frameGroupLayers(g) {
  if (!g) return []
  return state.instances
    .filter(i => i.groupId === g.id)
    .sort((a, b) => (a.groupIndex | 0) - (b.groupIndex | 0))
}

/** 这个图层现在是否该画在主画布上: 无组 = 永远画; 有组 = 只画当前帧 */
export function isInstanceVisible(inst) {
  if (!inst?.groupId) return true
  const g = frameGroupOf(inst.groupId)
  if (!g) return true
  return (inst.groupIndex | 0) === (g.current | 0)
}

/** 主画布/选择框/命中测试共用的可见图层表 (隐藏的组变体不能挡住点击) */
export const visibleInstances = computed(() => state.instances.filter(isInstanceVisible))

function recalcFrameGroupBox(g) {
  const list = frameGroupLayers(g)
  if (!list.length) return
  g.w = Math.max(1, ...list.map(i => Math.max(1, Math.round(+i.w || 1))))
  g.h = Math.max(1, ...list.map(i => Math.max(1, Math.round(+i.h || 1))))
}

/**
 * 把一张多帧素材拆成"同位置组": 每帧一个图层, 全部落在同一个组框里。
 * @param assetId 多帧素材 id
 * @param opts { frames?: number[], x?, y?, fmt? }  frames 默认全部
 * @returns 组对象 | null
 */
export function createFrameGroup(assetId, opts = {}) {
  const a = state.assets.find(x => x.id === assetId)
  if (!a?.font || a.font.charset !== 'frames') return null
  const n = frameStripCount(a)
  if (!n) return null
  const wanted = Array.isArray(opts.frames) && opts.frames.length
    ? [...new Set(opts.frames.map(i => Math.round(+i)).filter(i => i >= 0 && i < n))]
    : [...Array(n).keys()]
  if (!wanted.length) return null
  const sc = screen.value
  const descs = wanted.map((fi, idx) => {
    const box = a.font.boxes?.[fi] || null
    const w = Math.max(1, Math.round(box ? box.w : a.font.glyphW))
    const h = Math.max(1, Math.round(box ? box.h : a.font.glyphH))
    return { fi, idx, w, h, crop: box ? { x: Math.round(box.x), y: Math.round(box.y) } : { x: 0, y: 0 } }
  })
  const gw = Math.max(1, ...descs.map(d => d.w))
  const gh = Math.max(1, ...descs.map(d => d.h))
  const gx = Math.round(Number.isFinite(+opts.x) ? +opts.x : (sc.w - gw) / 2)
  const gy = Math.round(Number.isFinite(+opts.y) ? +opts.y : (sc.h - gh) / 2)
  const gid = uid('fg')
  /* 图层名要当 C 数组名: 中文/括号会被 sanitize 成下划线, 显示很难看 ——
   * 名字里实在没有可读字符时退回素材 id (内置素材是 fw_fonts 这类, 可读)。 */
  const rawBase = sanitizeName(a.name)
  const baseName = (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawBase) && !/_{2,}/.test(rawBase))
    ? rawBase : (sanitizeName(a.id) || 'frame')
  /* 同一素材可以建多个组; 图层名要带组号, 否则两次建组的 C 数组名会撞 (Keil duplicate symbol) */
  const groupNo = state.frameGroups.filter(x => x.assetId === assetId).length + 1
  const layerBase = `${baseName}_g${groupNo}`
  const group = {
    id: gid, name: String(a.name || '多帧').slice(0, 40) + ' 组', assetId, x: gx, y: gy, w: gw, h: gh,
    current: 0, fps: 4, loop: true,
  }
  state.frameGroups.push(group)
  const fmt = opts.fmt || sc.defaultFmt || 'RGB565'
  descs.forEach(d => {
    /* 默认在组框里居中: 各帧大小不同也能对齐中心; 用户可在子预览里改 offset */
    const off = { x: Math.round((gw - d.w) / 2), y: Math.round((gh - d.h) / 2) }
    const inst = {
      id: uid('inst'), assetId, name: `${layerBase}_f${d.fi + 1}`,
      page: 0, x: gx + off.x, y: gy + off.y, w: d.w, h: d.h,
      fmt, color: a.font.frameColors?.[d.fi] ?? a.font.color ?? 0xFFFF,
      mirror: false, frame: d.fi,
      groupId: gid, groupIndex: d.idx, groupOffset: off,
    }
    if (d.crop.x || d.crop.y) inst.crop = d.crop
    state.instances.push(inst)
  })
  state.ui.selectedId = frameGroupLayers(group)[0]?.id || null
  state.ui.frameGroupPreviewId = gid
  return group
}

/** 整组平移 (拖拽/方向键走这里; 直接改 x/y, 不走 updateInstance 避免递归) */
export function moveFrameGroup(gid, dx, dy) {
  const g = frameGroupOf(gid)
  if (!g || (!dx && !dy)) return
  g.x += dx; g.y += dy
  for (const inst of frameGroupLayers(g)) {
    inst.x += dx; inst.y += dy
  }
}

/** 切到组里的第 i 帧 (主画布只显示它; 子预览/播放也走这里) */
export function setFrameGroupCurrent(gid, i) {
  const g = frameGroupOf(gid)
  if (!g) return
  const list = frameGroupLayers(g)
  if (!list.length) return
  const n = Math.max(0, Math.min(list.length - 1, Math.round(+i) || 0))
  g.current = n
  /* 当前选中的就是组里的层 → 选中跟着切, 方便直接改这一帧的属性 */
  const sel = state.instances.find(x => x.id === state.ui.selectedId)
  if (sel?.groupId === gid && sel.id !== list[n].id) state.ui.selectedId = list[n].id
}

/** 只挪组里的某一帧 (组框内偏移; 用来对准位置) */
export function setFrameGroupOffset(instId, x, y) {
  const inst = state.instances.find(i => i.id === instId)
  const g = frameGroupOf(inst?.groupId)
  if (!inst || !g) return
  const off = { x: Math.round(+x || 0), y: Math.round(+y || 0) }
  inst.groupOffset = off
  inst.x = g.x + off.x
  inst.y = g.y + off.y
}

/** 删除整组 (连同它的变体图层) */
export function removeFrameGroup(gid) {
  const g = frameGroupOf(gid)
  if (!g) return
  const ids = new Set(frameGroupLayers(g).map(i => i.id))
  state.instances = state.instances.filter(i => !ids.has(i.id))
  for (const id of ids) dropInstanceCaches(id)
  state.frameGroups = state.frameGroups.filter(x => x.id !== gid)
  if (state.ui.frameGroupPreviewId === gid) state.ui.frameGroupPreviewId = ''
  if (ids.has(state.ui.selectedId)) state.ui.selectedId = null
}

/** 工程指纹/撤回栈里只放"会影响导出"的组字段: current/fps/loop 是预览状态,
 *  播放时每秒变 4 次, 不能因此把工程标脏或往撤回栈里塞帧。 */
function frameGroupsForSig(list) {
  return (list || []).map(g => ({
    id: g.id, name: g.name, assetId: g.assetId, x: g.x, y: g.y, w: g.w, h: g.h,
  }))
}

/* 在图层列表里点中组内某一帧 → 主画布立刻切到那一帧 (否则点中的是"看不见的层") */
watch(() => state.ui.selectedId, (id) => {
  const inst = state.instances.find(i => i.id === id)
  if (!inst?.groupId) return
  const g = frameGroupOf(inst.groupId)
  if (g && (g.current | 0) !== (inst.groupIndex | 0)) g.current = inst.groupIndex | 0
})

/** 切出每帧的画布 (每格 glyphW×glyphH; 越界格自动夹住) */
export function sliceFrames(a) {
  const cnt = framesCount(a)
  if (!cnt || !a?.font) return []
  const img = getAssetImage(a)
  if (!img) return []
  const f = a.font
  const cw = Math.max(1, Math.round(+f.glyphW || 1)), ch = Math.max(1, Math.round(+f.glyphH || 1))
  const horiz = f.dir ? f.dir === 'col' : (a.w / cw) >= (a.h / ch)
  const out = []
  for (let i = 0; i < cnt; i++) {
    const cv = document.createElement('canvas')
    cv.width = cw; cv.height = ch
    cv.getContext('2d').drawImage(img, horiz ? i * cw : 0, horiz ? 0 : i * ch, cw, ch, 0, 0, cw, ch)
    out.push(cv)
  }
  return out
}

/** 用新的帧序重拼多帧素材 (就地改 asset); keep: 随帧走的附加表 (frameColors) 同步重排 */
function rebuildFrames(a, cellCanvases, extras) {
  const list = cellCanvases.filter(Boolean)
  if (!list.length) return false
  const cw = a.font.glyphW, ch = a.font.glyphH
  const cv = document.createElement('canvas')
  cv.width = cw * list.length; cv.height = ch
  const ctx = cv.getContext('2d')
  list.forEach((c, i) => ctx.drawImage(c, i * cw, 0))
  a.src = cv.toDataURL('image/png')
  a.w = cv.width; a.h = cv.height
  /* 重拼后统一成横排: 原来竖排的 dir='row' 必须改掉, 否则 framesCount/sliceFrames 会按高度读错 */
  a.font.dir = 'col'
  a.font.frames = list.length
  imageCache.delete(a.id)                      /* 拼版图变了: 旧图缓存必须失效 */
  dropAllPixelCachesFor(a.id)
  /* 内容框/每帧颜色是"按帧序"记录的 → 同步重排; 对不上的清掉 (插入的帧没有历史框) */
  if (a.font.boxes && extras?.boxes) a.font.boxes = extras.boxes
  else delete a.font.boxes
  if (a.font.frameColors && extras?.frameColors) a.font.frameColors = extras.frameColors
  else delete a.font.frameColors
  /* 实例的帧号夹到新范围内 */
  for (const inst of state.instances) {
    if (inst.assetId === a.id && inst.frame != null && inst.frame >= list.length) inst.frame = list.length - 1
  }
  return true
}

/** 重排: 把第 from 帧移动到 to (0 基) */
export function moveAssetFrame(a, from, to) {
  const n = framesCount(a)
  if (from < 0 || from >= n) return false
  to = Math.max(0, Math.min(n - 1, to))
  const perm = []                     /* perm[新序号] = 旧序号 */
  for (let i = 0; i < n; i++) { if (i !== from) perm.push(i) }
  perm.splice(to, 0, from)
  const cells = sliceFrames(a)
  if (!cells.length) return false
  return rebuildFrames(a, perm.map(i => cells[i]), remapByPerm(a, perm))
}

/** 删除第 idx 帧 (至少留 1 帧; 全删请直接删素材) */
export function deleteAssetFrame(a, idx) {
  const n = framesCount(a)
  if (n <= 1 || idx < 0 || idx >= n) return false
  const perm = []
  for (let i = 0; i < n; i++) { if (i !== idx) perm.push(i) }
  const cells = sliceFrames(a)
  if (!cells.length) return false
  return rebuildFrames(a, perm.map(i => cells[i]), remapByPerm(a, perm))
}

/** 在 idx 处插入一帧 (idx=-1 = 追加到末尾); img = 已加载的 HTMLImageElement */
export function insertAssetFrame(a, idx, img) {
  const cells = sliceFrames(a)
  if (!cells.length || !img) return false
  const cw = a.font.glyphW, ch = a.font.glyphH
  const cv = document.createElement('canvas')
  cv.width = cw; cv.height = ch
  const c2 = cv.getContext('2d')
  const sc = Math.min(cw / img.naturalWidth, ch / img.naturalHeight)      /* 等比居中放进格子 */
  const dw = Math.max(1, Math.round(img.naturalWidth * sc))
  const dh = Math.max(1, Math.round(img.naturalHeight * sc))
  c2.drawImage(img, Math.round((cw - dw) / 2), Math.round((ch - dh) / 2), dw, dh)
  if (idx < 0 || idx >= cells.length) cells.push(cv); else cells.splice(idx, 0, cv)
  const perm = []                     /* 插入帧 = -1 (无历史数据); 其余保持原序号 */
  for (let i = 0; i < cells.length; i++) {
    if (idx < 0 || idx >= cells.length - 1) perm.push(i < cells.length - 1 ? i : -1)
    else perm.push(i < idx ? i : (i === idx ? -1 : i - 1))
  }
  return rebuildFrames(a, cells, remapByPerm(a, perm))
}

/** 帧序变化时同步重排 boxes/frameColors: perm[新序号] = 旧序号 (-1 = 新帧无数据) */
function remapByPerm(a, perm) {
  const pick = (arr) => {
    if (!Array.isArray(arr)) return undefined
    const out = perm.map(i => (i >= 0 ? (arr[i] ?? null) : null))
    while (out.length && out[out.length - 1] === null) out.pop()
    return out.length ? out : undefined
  }
  return { boxes: pick(a.font.boxes), frameColors: pick(a.font.frameColors) }
}

function dropAllPixelCachesFor(assetId) {
  for (const inst of state.instances) {
    if (inst.assetId === assetId) dropInstanceCaches(inst.id)
  }
}

/* 获取 SVG 矢量 Image (用于按任意尺寸重新光栅化) */
export function getSvgImage(asset) {
  if (!asset?.svg) return null
  return svgImageCache.get(asset.id) || null
}

export function removeAsset(id) {
  const gone = state.instances.filter(i => i.assetId === id)
  state.assets = state.assets.filter(a => a.id !== id)
  state.instances = state.instances.filter(i => i.assetId !== id)
  for (const inst of gone) dropInstanceCaches(inst.id)
  /* 素材删掉后, 它的多帧组也不能留空壳 */
  const liveGroups = new Set(state.instances.map(i => i.groupId).filter(Boolean))
  state.frameGroups = state.frameGroups.filter(g => liveGroups.has(g.id))
  if (state.ui.frameGroupPreviewId && !state.frameGroups.some(g => g.id === state.ui.frameGroupPreviewId)) {
    state.ui.frameGroupPreviewId = ''
  }
  imageCache.delete(id)
  svgImageCache.delete(id)
}

/* ---------- 总素材库 (跨工程) ----------
 * 左栏「总素材库」显示服务器上现有几份存档用过的素材 + 当前工程:
 *   · 当前工程素材自动汇总 (按 像素 hash + 字库/帧元信息 去重);
 *   · 打开/切换过的在线存档, 其素材在载入时自动汇总;
 *   · 点「同步在线存档素材」→ 只读取服务器上现有的存档, **按它们重建总库** (不累积历史),
 *     当前工程以内存里的最新版本最后并入.
 * 只保存在本浏览器 localStorage, **不写进工程 JSON / 在线存档**.
 * 素材被从当前工程删除后, 总库里仍保留 (可以再拖回来用) —— 这就是"总库"的意义;
 * 但下次重建时, 不属于任何现有存档/当前工程的历史条目会被清掉. */
export const assetLibrary = reactive({
  items: [],          // [{ id, key, asset, origins:[], addedAt, lastSeen }]
  mode: 'project',    // project | global (左栏当前显示哪一库)
  synced: {},         // 兼容旧缓存 (以前存 mtime; 现在每次重建, 不再靠它跳过)
  rev: 0,             // 变更计数, 用来防抖落盘
  syncing: false,
  msg: '',            // 同步/清空提示
  storageMsg: '',     // localStorage 配额提示
})

const KEY_GLOBAL_ASSETS = 'lcd-layout-studio-global-assets-v1'
const KEY_ASSET_LIB_MODE = 'lcd-asset-lib-mode'
const assetKeyCache = new WeakMap()

/* FNV-1a: 给 dataURL 算一个短 key, 总库条目里不用再存一份完整 src 当 key */
function hashText(s) {
  const str = String(s || '')
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(36) + ':' + str.length
}

/** 素材去重键: 像素内容 + 字库/帧元信息 (同名不同图、同图不同拆分都算不同素材) */
export function globalAssetKey(a) {
  if (!a || !a.src) return ''
  const font = a.font ? JSON.stringify(a.font) : ''
  const hit = assetKeyCache.get(a)
  if (hit && hit.src === a.src && hit.font === font) return hit.key
  const key = hashText(a.src) + '|' + font
  assetKeyCache.set(a, { src: a.src, font, key })
  return key
}

/** 把一组素材并进总库 (返回新增/更新数). origin = 来源工程名 */
export function mergeGlobalAssets(list, origin) {
  const o = String(origin || '').trim()
  const byKey = new Map(assetLibrary.items.map(it => [it.key, it]))
  /* 同一素材 id 改了内容 (重新拆分字库 / 文字快照改了字) → 用新版本替换旧条目,
   * 不再像以前那样"旧内容+新内容"两条都留着 (总库里越积越多的重复就是这么来的). */
  const byAssetId = new Map()
  for (const it of assetLibrary.items) {
    const id = it && it.asset && it.asset.id
    if (!id) continue
    if (!byAssetId.has(id)) byAssetId.set(id, [])
    byAssetId.get(id).push(it)
  }
  let added = 0, updated = 0, changed = false
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || !a.src || a._transient) continue
    const key = globalAssetKey(a)
    if (!key) continue
    let it = byKey.get(key)
    if (!it) {
      const stale = (byAssetId.get(a.id) || []).filter(x => x.key !== key)
      if (stale.length) {
        const drop = new Set(stale)
        assetLibrary.items = assetLibrary.items.filter(x => !drop.has(x))
        for (const x of stale) byKey.delete(x.key)
        byAssetId.delete(a.id)
        changed = true
      }
      it = {
        id: uid('ga'), key,
        asset: JSON.parse(JSON.stringify(a)),
        origins: o ? [o] : [],
        addedAt: Date.now(), lastSeen: Date.now(),
      }
      delete it.asset._transient
      assetLibrary.items.push(it)
      byKey.set(key, it)
      if (a.id) byAssetId.set(a.id, [it])
      added++; changed = true
      continue
    }
    if (o && !it.origins.includes(o)) {
      it.origins.push(o)
      if (it.origins.length > 6) it.origins.shift()
      it.lastSeen = Date.now()
      changed = true
    }
    const old = it.asset
    if (!old || old.name !== a.name || old.w !== a.w || old.h !== a.h ||
        JSON.stringify(old.font || null) !== JSON.stringify(a.font || null)) {
      const copy = JSON.parse(JSON.stringify(a))
      delete copy._transient
      it.asset = copy
      it.lastSeen = Date.now()
      updated++; changed = true
    }
  }
  if (changed) assetLibrary.rev++
  return { added, updated }
}

/**
 * 存档里的素材 → 总库条目前的校正.
 * 2026-10-21 之前保存的工程把内置字体素材 (`fw_fonts` 等) 按 1 帧存下来
 * (当时用 Image.width 推帧数), 和修复后的多帧版本 src 相同、font.frames 不同 →
 * 会以两个 key 重复进总库. 这里按固件元数据把「1 帧的坏版本」校正回多帧,
 * 与 installBuiltinAssets() 的判定同一口径 (只修坏的那份, 不碰用户自己拆过的字库).
 */
export function normalizeGlobalAsset(a) {
  if (!a || !a.src) return null
  const id = String(a.id || '')
  if (!id.startsWith('fw_')) return a
  const b = FW_BUILTIN.find(x => 'fw_' + x.id === id)
  if (!b) return a
  const meta = fwBuiltinAssetMeta(b)
  const broken = meta.frames > 1 &&
    a.font && a.font.charset === 'frames' && (+a.font.frames || 1) === 1 &&
    Math.round(+a.w || 0) === meta.glyphW && Math.round(+a.h || 0) === meta.h
  return broken ? { ...a, w: meta.w, h: meta.h, font: meta.font } : a
}

/**
 * 按「来源清单」重建总素材库 (纯函数, 不碰网络/localStorage).
 *
 * 为什么不是继续 merge: 老实现只往里加, 删掉的工程/改过帧数的旧档会永远留在总库,
 * 用户看到的就是"很多重复". 现在每次同步都从服务器上**现有的几份存档**重算一遍
 * (当前工程放在最后一源, 用内存里的最新版本覆盖服务器旧版本), 不存在的来源自然消失.
 *
 * @param {{origin:string, assets:any[]}[]} sources 来源工程 (顺序 = origins 顺序, 后者覆盖前者同名同内容)
 * @param {any[]} prevItems 上一次的条目: 只用来继承 id/addedAt, 让列表不整片跳动
 * @returns {{items:any[], added:number, updated:number}}
 */
export function buildGlobalAssetItems(sources, prevItems = []) {
  const prevByKey = new Map()
  for (const it of Array.isArray(prevItems) ? prevItems : []) {
    if (it && it.key) prevByKey.set(it.key, it)
  }
  const byKey = new Map()
  const items = []
  let added = 0, updated = 0
  for (const source of Array.isArray(sources) ? sources : []) {
    const origin = String(source && source.origin || '').trim()
    const assets = Array.isArray(source && source.assets) ? source.assets : []
    for (const raw of assets) {
      const a = normalizeGlobalAsset(raw)
      if (!a || !a.src || a._transient) continue
      const key = globalAssetKey(a)
      if (!key) continue
      let it = byKey.get(key)
      if (!it) {
        const old = prevByKey.get(key)
        it = {
          id: (old && old.id) || uid('ga'), key,
          asset: JSON.parse(JSON.stringify(a)),
          origins: [],
          addedAt: (old && old.addedAt) || Date.now(),
          lastSeen: Date.now(),
        }
        delete it.asset._transient
        byKey.set(key, it)
        items.push(it)
        added++
      }
      if (origin && !it.origins.includes(origin)) {
        it.origins.push(origin)
        if (it.origins.length > 6) it.origins.shift()
      }
      const old = it.asset
      if (!old || old.name !== a.name || old.w !== a.w || old.h !== a.h ||
          JSON.stringify(old.font || null) !== JSON.stringify(a.font || null)) {
        const copy = JSON.parse(JSON.stringify(a))
        delete copy._transient
        it.asset = copy
        updated++
      }
      it.lastSeen = Date.now()
    }
  }
  return { items, added, updated }
}

/** 把总库里的素材放进当前工程 (已有相同内容就直接复用); 返回工程里的 asset */
export function adoptGlobalAsset(itemId) {
  const it = assetLibrary.items.find(x => x.id === itemId)
  if (!it || !it.asset) return null
  const key = it.key || globalAssetKey(it.asset)
  const have = state.assets.find(a => globalAssetKey(a) === key)
  if (have) return have
  const a = JSON.parse(JSON.stringify(it.asset))
  a.id = uid('asset')
  delete a._transient
  state.assets.push(a)
  imageCache.delete(a.id)
  if (a.svg && a.svgText) {
    try {
      const i = new Image()
      i.onload = () => { state._imgTick++ }
      i.src = URL.createObjectURL(new Blob([a.svgText], { type: 'image/svg+xml' }))
      svgImageCache.set(a.id, i)
    } catch (e) { /* Node 自检没有 Image/Blob */ }
  }
  try { getAssetImage(a) } catch (e) { /* Node 自检没有 Image */ }
  return a
}

/** 从总库移除 (不影响已加入工程的副本) */
export function removeGlobalAsset(itemId) {
  const n = assetLibrary.items.length
  assetLibrary.items = assetLibrary.items.filter(x => x.id !== itemId)
  if (assetLibrary.items.length !== n) assetLibrary.rev++
}

/** 清空总库: 当前工程的素材随后会重新汇总, 所以不会丢当前工程在用的 */
export function clearGlobalAssets() {
  assetLibrary.items = []
  assetLibrary.synced = {}
  assetLibrary.msg = '总素材库已清空（当前工程素材会重新汇总）'
  assetLibrary.rev++
  mergeGlobalAssets(state.assets, cloud.current || '当前工程')
}

export function setAssetLibraryMode(mode) {
  assetLibrary.mode = mode === 'global' ? 'global' : 'project'
  try { localStorage.setItem(KEY_ASSET_LIB_MODE, assetLibrary.mode) } catch (e) { /* 忽略 */ }
}

export function loadGlobalAssets() {
  try {
    const mode = localStorage.getItem(KEY_ASSET_LIB_MODE)
    if (mode === 'global' || mode === 'project') assetLibrary.mode = mode
  } catch (e) { /* 忽略 */ }
  try {
    const raw = localStorage.getItem(KEY_GLOBAL_ASSETS)
    if (!raw) return 0
    const d = JSON.parse(raw)
    const arr = Array.isArray(d) ? d : (Array.isArray(d && d.items) ? d.items : [])
    const out = [], seen = new Set()
    for (const x of arr) {
      const asset = x && x.asset ? x.asset : (x && x.src ? x : null)
      if (!asset || !asset.src) continue
      const key = (x && x.key) || globalAssetKey(asset)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({
        id: (x && x.id) || uid('ga'), key, asset,
        origins: Array.isArray(x && x.origins) ? x.origins.filter(Boolean).slice(-6)
          : (x && x.origin ? [x.origin] : []),
        addedAt: +(x && x.addedAt) || Date.now(),
        lastSeen: +(x && x.lastSeen) || +(x && x.addedAt) || Date.now(),
      })
    }
    assetLibrary.items = out
    assetLibrary.synced = (!Array.isArray(d) && d && d.synced && typeof d.synced === 'object') ? d.synced : {}
    assetLibrary.rev++
    return out.length
  } catch (e) {
    console.warn('总素材库恢复失败', e)
    return 0
  }
}

let globalSaveTimer = 0
function scheduleSaveGlobalAssets() {
  clearTimeout(globalSaveTimer)
  globalSaveTimer = setTimeout(saveGlobalAssets, 600)
}

export function saveGlobalAssets() {
  try {
    localStorage.setItem(KEY_GLOBAL_ASSETS, JSON.stringify({
      version: 1, items: assetLibrary.items, synced: assetLibrary.synced,
    }))
    assetLibrary.storageMsg = ''
  } catch (e) {
    assetLibrary.storageMsg = '总素材库太大，浏览器存不下（本次会话仍可用；可点「清空」）'
    console.warn('总素材库保存失败 (可能超出 localStorage 容量)', e)
  }
}

/**
 * 按服务器上**现有的存档**重建总素材库 (只检查这几份工程, 不再累积历史条目):
 *   · 当前工程用内存里的最新素材 (服务器上那份可能比内存旧), 放最后一源覆盖同名内容;
 *   · 其它存档逐份读 assets, 内置 fw_* 的旧「1 帧」元数据先校正;
 *   · 条目 id/addedAt 按内容 key 继承, 列表顺序不整片跳.
 * 网络/解析失败不算总库为空: 失败来源本次跳过, 并在提示里报数量.
 */
export async function syncAssetsFromArchives() {
  if (assetLibrary.syncing) return null
  assetLibrary.syncing = true
  assetLibrary.msg = '正在按在线存档重建总素材库…'
  const out = { files: 0, added: 0, skipped: 0, failed: [], total: 0 }
  try {
    await cloudProbe()
    if (!cloud.ok) throw new Error('当前部署未启用在线存档服务')
    const sources = []
    for (const f of cloud.list) {
      const n = archiveBaseName(f.name)
      /* 当前工程以内存里的最新素材为准, 不拉服务器上的旧版本 (后面会作为最后一源并入) */
      if (cloud.current && f.name === archiveFileName(cloud.current)) { out.skipped++; continue }
      assetLibrary.msg = '正在读取「' + n + '」…'
      try {
        const json = await cloudLoad(n)
        const d = JSON.parse(json)
        if (Array.isArray(d.assets)) {
          sources.push({ origin: n, assets: d.assets })
          out.files++
        }
      } catch (e) {
        out.failed.push(n)
      }
    }
    /* 当前工程最后并入: 同名同内容会用内存里的名字/字库信息覆盖服务器旧版 */
    sources.push({ origin: cloud.current || '当前工程', assets: state.assets })
    const built = buildGlobalAssetItems(sources, assetLibrary.items)
    assetLibrary.items = built.items
    assetLibrary.synced = {}
    assetLibrary.rev++
    out.added = built.added
    out.total = built.items.length
    assetLibrary.msg = out.files
      ? ('已按服务器 ' + out.files + ' 份存档重建总库：' + out.total + ' 个素材' +
         (out.failed.length ? '；' + out.failed.length + ' 份读取失败' : ''))
      : ('服务器上没有可用的存档；总库只汇总了当前工程的 ' + out.total + ' 个素材' +
         (out.failed.length ? '（' + out.failed.length + ' 份读取失败）' : ''))
    return out
  } catch (e) {
    assetLibrary.msg = '同步失败: ' + (e && e.message ? e.message : e)
    return null
  } finally {
    assetLibrary.syncing = false
  }
}

/* 实例移除时清理所有以实例为键的缓存/动画/警告状态 */
function dropInstanceCaches(id) {
  procCache.delete(id)
  codeCache.delete(id)
  pixelCache.clear()               // 按内容键缓存, 无实例索引, 条目很少, 直接清空
  animLastStep.delete(id)
  dropRingAnim(id)
  delete state.hiddenCircleWarns[id]
}

/* ---------- 实例 ---------- */
export function addInstance(assetId, px, py, opts = {}) {
  const asset = state.assets.find(a => a.id === assetId)
  if (!asset) return null
  const sc = screen.value
  // 拆分素材: 默认显示第 0 帧 (占一个位置, 属性里可换帧)
  let w = asset.w, h = asset.h
  let frame = null
  if (asset.font) {
    w = asset.font.glyphW
    h = asset.font.glyphH
    frame = 0
  }
  /* 打包素材带"每帧内容框" (boxes): 图层只占内容大小 → 导出省 flash;
   * 位置补回框在格内的偏移, 画面和整格摆放时一模一样 */
  const box = asset.font?.boxes?.[frame ?? 0] || null
  // 默认尺寸: 按整格等比缩至屏内 (位置/居中仍按整格算, 换了裁剪也不跳)
  const k = Math.min(1, sc.w / w, sc.h / h)
  const cellW = Math.max(1, Math.round(w * k)), cellH = Math.max(1, Math.round(h * k))
  const bw = Math.max(1, Math.round((box ? box.w : w) * k))
  const bh = Math.max(1, Math.round((box ? box.h : h) * k))
  const ox = box ? Math.round(box.x * k) : 0
  const oy = box ? Math.round(box.y * k) : 0
  const inst = {
    id: uid('inst'),
    assetId,
    name: sanitizeName(asset.name),
    page: 0,                            // 默认第 0 页 (页号=序号=切页顺序)
    x: Math.round((px ?? (sc.w - cellW) / 2)) - (opts.center === false ? 0 : Math.round(cellW / 2)) + ox,
    y: Math.round((py ?? (sc.h - cellH) / 2)) - (opts.center === false ? 0 : Math.round(cellH / 2)) + oy,
    w: bw, h: bh,
    /* 多帧画板保存时带了 defaultFmt (RGB565/GRAY); 从素材库放置必须沿用它, 不能被屏幕默认格式覆盖 */
    fmt: opts.fmt || asset.defaultFmt || sc.defaultFmt || 'RGB565',
    store: 'int',                        // 内部 / 外部 / LZSS (图层第二行切换)
    color: asset.font?.frameColors?.[frame ?? 0] ?? asset.defaultColor ?? asset.font?.color ?? 0xFFFF,   // 帧素材自带颜色
    mirror: false,
    frame,
  }
  if (box) inst.crop = { x: box.x, y: box.y }   // 裁切窗口 = 内容框 (窗口大小 = inst.w/h)
  state.instances.push(inst)
  state.ui.selectedId = inst.id
  return inst
}

/* ---------- 字库 (素材级拆分) ---------- */
const fontCellCache = new Map()   // assetId -> {key, cells:[{ch, canvas}]}
const fontValueCache = new Map()  // assetId -> {key(fmt), glyphs:[{ch, values, len}]}

export function fontCharset(f) {
  if (f.charset === 'ascii') {
    // 起始字符可调 (默认空格 0x20): 条图不从空格开始时对齐用
    const start = Math.max(0x01, Math.min(0x7E, Math.round(+f.start) || 0x20))
    let s = ''
    for (let c = start; c <= 0x7E; c++) s += String.fromCharCode(c)
    return s
  }
  if (f.charset === 'frames') return ''   // 帧模式: 不映射字符, 按索引
  return f.custom || ''
}

export function fontMeta(asset) {
  const cells = fontCells(asset)
  return {
    count: cells ? cells.length : 0,
    missing: cells ? '' : '图片未加载',
  }
}

/* 把长条图按字符集切成单字 canvas (横向条优先, 自动识别纵向条)
 * 图片不足的部分自动补 0 (黑) 扩展, 保证每个字符集都有完整 gw×gh 数据 */
export function fontCells(asset) {
  void state._imgTick
  if (!asset?.font) return null
  const img = getAssetImage(asset)
  if (!img.complete || !img.naturalWidth) return null
  const f = asset.font
  const gw = Math.max(1, Math.round(f.glyphW)), gh = Math.max(1, Math.round(f.glyphH))
  const key = JSON.stringify([asset.id, asset.src.length, gw, gh, f.charset, f.custom, f.start])
  const hit = fontCellCache.get(asset.id)
  if (hit && hit.key === key) return hit.cells
  const chars = fontCharset(f)
  let count, horiz
  if (f.dir) {
    // 显式指定排列: col=按列切分(从左到右) row=按行切分(从上到下)
    horiz = f.dir === 'col'
  } else if (chars.length) {
    horiz = img.naturalWidth >= gw * chars.length
  } else {
    horiz = img.naturalWidth / gw >= img.naturalHeight / gh
  }
  if (chars.length) {
    count = chars.length
  } else {
    count = Math.max(1, Math.ceil(horiz ? img.naturalWidth / gw : img.naturalHeight / gh))
  }
  const cells = []
  for (let i = 0; i < count; i++) {
    const sx = horiz ? i * gw : 0
    const sy = horiz ? 0 : i * gh
    const cv = document.createElement('canvas')
    cv.width = gw; cv.height = gh
    const availW = Math.min(gw, img.naturalWidth - sx)
    const availH = Math.min(gh, img.naturalHeight - sy)
    if (availW > 0 && availH > 0) {
      // 与图片重叠部分原样绘制; 余下区域保持透明 (量化后为黑 = 补0)
      cv.getContext('2d').drawImage(img, sx, sy, availW, availH, 0, 0, availW, availH)
    }
    cells.push({ ch: chars[i] ?? String(i), canvas: cv })
  }
  fontCellCache.set(asset.id, { key, cells })
  return cells
}

/* 字库/帧素材的素材栏缩略图: 切分后的字符格按 1:1 摆放 (不缩放, 放不下的格子直接不画);
 * 特例: 1:1 只放得下一格时缩放这一格填满缩略图 (大字号/单帧素材)。
 * 返回 dataURL, 未就绪返回 null。 */
const fontPreviewCache = new Map()
export function fontPreviewSrc(asset, size = 44) {
  if (!asset?.font) return null
  const f = asset.font
  const key = JSON.stringify([asset.id, asset.src.length, f.glyphW, f.glyphH, f.charset, f.custom, f.start, f.dir, size])
  const hit = fontPreviewCache.get(key)
  if (hit !== undefined) return hit
  const cells = fontCells(asset)
  if (!cells?.length) return null
  const gw = Math.max(1, Math.round(f.glyphW)), gh = Math.max(1, Math.round(f.glyphH))
  const gap = 1
  const cols = Math.max(1, Math.floor((size + gap) / (gw + gap)))
  const rows = Math.max(1, Math.floor((size + gap) / (gh + gap)))
  const n = Math.min(cells.length, cols * rows)
  const oneCell = n === 1   // 只会显示 1 格 (字号太大 / 字库只有 1 格) → 缩放填满
  let dw = gw, dh = gh
  if (oneCell) {   // 等比缩放 (像素画用最近邻)
    const k = Math.min(size / gw, size / gh)
    dw = Math.max(1, Math.round(gw * k)); dh = Math.max(1, Math.round(gh * k))
  }
  const useCols = Math.min(cols, n)
  const useRows = Math.ceil(n / useCols)
  const totalW = useCols * dw + (useCols - 1) * gap
  const totalH = useRows * dh + (useRows - 1) * gap
  const ox = totalW <= size ? Math.round((size - totalW) / 2) : 0
  const oy = totalH <= size ? Math.round((size - totalH) / 2) : 0
  const cv = document.createElement('canvas')
  cv.width = size; cv.height = size
  const ctx = cv.getContext('2d')
  ctx.imageSmoothingEnabled = false
  cells.slice(0, n).forEach((c, i) => {
    ctx.drawImage(c.canvas, ox + (i % useCols) * (dw + gap), oy + Math.floor(i / useCols) * (dh + gap), dw, dh)
  })
  const url = cv.toDataURL('image/png')
  if (fontPreviewCache.size > 30) fontPreviewCache.clear()
  fontPreviewCache.set(key, url)
  return url
}

/* 字库量化值 (u8 灰度 / u16 RGB565), 按格式缓存 */
/* 数字要用到的字模: 空格不用画 (固件遇到空格是用底色 FILL 的), 所以只渲染 '-' '.' '0'~'9' */
const NUM_CHARS = '-.0123456789'

/**
 * 系统字 → 数字字库: 把数字用得到的字符逐个按系统字体渲染成灰度字模 (固定基线 + 等宽格),
 * 交给 numFontFromGlyphs 拼成 UI_FONT 那份数据。**选系统字时自动导出, 免得固件拿到空字库画不出东西。**
 */
export function numFontForSys(cfg, key = '') {
  if (typeof document === 'undefined' || !cfg) return null
  /* 边缘斜坡 σ: **跟着这一层的系统字配置走** (cfg.rampSigma, 对话框里每层可设; 0=不变) */
  const ramp = Math.max(0, Math.min(2, +cfg.rampSigma || 0))
  /* 光晕: 同样跟着这一层走, 默认关。pad = 光晕要外扩的格子边距 (关掉时 =0 ⇒ 逐字节同以前)。
   * glowFit (紧排): 光晕仍按 blurPad 算, 但**出格尺寸不外扩** —— 算完裁回原格子。
   * 这样数字/ASCII 字库的字距与不开光晕时完全一致; 代价是格子外的弱光被切掉。 */
  const glow = glowCfg(cfg), blurPad = glow.pad, pad = glow.fit ? 0 : blurPad
  const sig = JSON.stringify(['numsys', cfg, key])
  const hit = numFontSysCache.get(sig)
  if (hit !== undefined) return hit
  let font = null
  try {
    const size = Math.max(4, Math.round(+cfg.size || 20))
    const base = { ...cfg, size, spacing: 0, glyphDx: null }   // 逐字偏移在下面统一算, 别在单字渲染里重复

    // 先量一个参考字符('0')的基线, 后面所有字都按它对齐
    const ref = renderSysFontCanvas({ ...base, text: '0' })
    const meas = document.createElement('canvas').getContext('2d')
    const wt = Math.max(100, Math.min(900, Math.round(base.bold ? 700 : (base.weight || 400))))
    meas.font = `${wt} ${size * 4}px "${base.family || DEFAULT_FONT}", sans-serif`
    const ascent = Math.max(1, Math.round((meas.measureText('0').actualBoundingBoxAscent || size * 0.75) ))
    const cells = [...NUM_CHARS].map(ch => ({ ch, cv: renderSysFontCanvas({ ...base, text: ch, ascent }) }))
                  .filter(c => !!c.cv)
    if (ref) void ref
    if (cells.length) {
      const sp = Math.round(+cfg.spacing || 0)
      /* 等距 (cfg.evenSpacing): 格子按**最宽字迹**定宽 + 每个字按**字迹**居中。
       * 固件是逐格等步进的, 而字体的左右边距每个字都不一样 (MiSans @20px: '1' 偏 0.68px、
       * 'j' 偏 1.21px, 随字号线性放大) —— 按字身居中就会左右不齐。关掉 = 原行为 (逐字节不变)。 */
      const even = !!cfg.evenSpacing
      const adv = Math.max(1, ...cells.map(c => c.cv.width))
      /* 正字距 → 交给 UI_FONT.gap (固件按 w+gap 步进);
       * 负字距 → 把格子收窄。固件是**逐格画**的 (每格一张图, 后面盖前面), 没法像网页那样"字叠字",
       * 所以收窄不能切进字迹: 下限 = 最宽字迹的宽度, 再负就被夹住 (有效字距会在界面里显示出来)。 */
      let inkMax = 1
      if (even || sp < 0) {
        for (const c of cells) {
          const b = inkBox(c.cv)
          if (b) inkMax = Math.max(inkMax, b.w)
        }
      }
      const cw = even ? Math.max(1, inkMax) : Math.max(1, inkMax, adv + Math.min(0, sp))
      const chh = Math.max(1, ...cells.map(c => c.cv.height))
      /* 手工字模微调: 每个字可以在自己的格子里左右平移 (cfg.digitDx[ch], 单位 px)。
       * 平移后取所有字迹的并集宽度 → cw2; 格子变大/向左扩, 所有字统一按 minX 平移,
       * 所以不会因为某个字往左挪 1px 就被格子裁掉。digitDx 为空时 cw2 === cw, 逐字节不变。 */
      const dxUser = (cfg.glyphDx && typeof cfg.glyphDx === 'object') ? cfg.glyphDx
        : (cfg.digitDx && typeof cfg.digitDx === 'object' ? cfg.digitDx : null)
      const layout = cells.map(({ ch, cv }) => {
        const ib = even ? inkBox(cv) : null
        const baseDx = ib && cw >= ib.w
          ? Math.round((cw - ib.w) / 2) - ib.x
          : (cw >= cv.width ? Math.round((cw - cv.width) / 2) : 0)
        const userDx = dxUser ? Math.round(+dxUser[ch] || 0) : 0
        /* 基线范围先夹进原格子 (负字距时本来就允许裁), 再叠加用户左右偏移 ——
         * 只有用户真的把字往外挪, 格子才扩; 否则逐字节与以前一致。 */
        const bLeft = Math.max(0, Math.min(cw, baseDx + (ib ? ib.x : 0)))
        const bRight = Math.max(bLeft, Math.min(cw, baseDx + (ib ? ib.x + ib.w : cv.width)))
        return { ch, cv, ib, baseDx, userDx, left: bLeft + userDx, right: bRight + userDx }
      })
      let minX = 0, maxX = cw
      for (const l of layout) { minX = Math.min(minX, l.left); maxX = Math.max(maxX, l.right) }
      const cw2 = Math.max(1, maxX - minX)
      /* 光晕要在格子外也画得下 → 四周各加 pad; pad=0 时 GW/GH 与原值相等。
       * 紧排时 pad=0 (出格与不开光晕一致), 但临时画布仍用 blurPad, 免得边缘 clamp 造出假边。 */
      const GW = cw2 + 2 * pad, GH = chh + 2 * pad
      const TW = cw2 + 2 * blurPad, TH = chh + 2 * blurPad
      const glyphs = layout.map(({ ch, cv, baseDx, userDx }) => {
        const t = document.createElement('canvas')
        t.width = TW; t.height = TH
        /* 原格子里按字迹居中 (或字身居中) + 用户左右微调, 再整体平移 -minX + blurPad */
        const dx = baseDx + userDx - minX + blurPad
        t.getContext('2d').drawImage(cv, dx, blurPad)
        const p = processImage(t, TW, TH, 'GRAY', {})
        /* ！GRAY 字模必须和"字库素材"那条路 (fontGlyphValues) 走**同一份处理**:
         *   ① 边缘斜坡加宽 (σ>0): 治大字号斜边/圆弧台阶 (浏览器 AA 只有 ~1px);
         *   ② 565 预抖动: 板子把灰度×颜色后截断进 RGB565 (红/蓝 5 位), 不抖的一条 AA 渐变
         *      只剩 ~32 级, 现场读作"边缘网点/色带"。
         * ！① 与 ② **互斥** (2026-10-16 现场): 抖动把边缘灰度重量化到 8 的整数倍, 而 σ 摊出来的
         *   斜坡上总有值卡在半档 (真机: 右边缘 124 = 15.5×8) → Bayer 把它逐行推成 120/128,
         *   一条笔直的竖边就变成周期 2 行的梳齿 (字形 "1" 的右边缘 73 行里翻转 17 次; 同一笔画的
         *   左侧 248/168/16 恰好都是 8 的整数倍, 所以纹丝不动)。
         *   字模里只有 0/255 + 边缘斜坡, 没有大面积平坦渐变, 抖动在这里买不到抗色带的收益
         *   ⇒ **σ>0 时不做 565 抖动**, 斜坡才是笔直的。预览走 renderNumCanvas(font.bytes),
         *   读的就是这份字节 ⇒ 预览与板子同时一致。
         *   cfg.dither565 = false 可关抖动 (只在 σ=0 时有意义); 斜坡宽度由这一层的 cfg.rampSigma 控制。 */
        let vals = p.values
        if (ramp > 0) vals = blurGray(vals, p.w, p.h, ramp)
        else if (cfg.dither565 !== false) vals = ditherGray565(vals, p.w, p.h)
        /* 光晕**最后**叠 (在斜坡/抖动之后): 光晕本身是平滑的, 不该再被抖动重量化 ——
         * 抖动治的是"平坦渐变色带", 而光晕是低频大块, 抖它只会平添网点。 */
        vals = withGlow(vals, p.w, p.h, glow)
        /* 紧排: 光晕在带 blurPad 的画布上算完, 裁回原格子 —— 字距/格宽不变。
         * 不开紧排时不裁 (逐字节老行为)。 */
        if (glow.fit && blurPad > 0) vals = cropGray(vals, p.w, p.h, blurPad, blurPad, cw2, chh)
        return { ch, values: vals }
      })
      /* 开了光晕且未紧排才裁左右 (pad>0): 去掉"格子外扩了、光晕却到不了"的黑边,
       * 让格宽 = 字迹 + 可见光晕 —— 与行裁剪 (上下) 同口径。pad=0 时不裁 ⇒ 逐字节同以前。 */
      font = numFontFromGlyphs(glyphs, key, GW, GH, Math.max(0, sp), pad > 0 ? { trimCols: true } : {})
      if (font) {
        font.spacing = font.w - adv          // 有效字距 (负数被夹住时比用户填的大; 裁列后按实际格宽算)
        /* 给对话框报"实际占位": 不开光晕时的格宽 cw → 开光晕后的 font.w。
         * 现场那句"σ=4 却宽了 40px"就是 2 格 × +20px —— 界面直接把这两个数写出来。 */
        font.baseW = cw2
        font.glowGrow = font.w - cw2
      }
    }
  } catch (e) { font = null }
  if (numFontSysCache.size > 20) numFontSysCache.clear()
  numFontSysCache.set(sig, font)
  return font
}

/* ---------- 系统字 → ASCII 字库 (0x20..0x7E, 95 个) ----------
 * 「＋文字」弹窗里 来源=系统字库 + 内容=ASCII 字库 走这条: 把可打印 ASCII 整份逐字渲染成
 * 灰度字模 (固定基线 + 等宽格), 固件就能打**任意字符串** —— 而不是把当前这一串字烘成一张图。
 * 处理口径与 numFontForSys 一致 (边缘斜坡 σ → 565 预抖动 → 整组裁掉上下空行),
 * 只是字符集换成整份 ASCII; 两边都各自显式走 blurGray/ditherGray565 (自检分别卡住)。 */
export const ASCII_PRINTABLE = (() => { let s = ''; for (let c = 0x20; c <= 0x7E; c++) s += String.fromCharCode(c); return s })()
export const ASCII_FIRST = 0x20
export const ASCII_COUNT = 0x7E - 0x20 + 1
const asciiFontSysCache = new Map()

/** 一整批字符的"字迹上下沿" (设备像素, 与 renderSysFontCanvas 的 SS 同尺度):
 *  asc = 最高字迹到基线的距离, desc = 最深降部。字库格子的高度必须 ≥ asc+desc ——
 *  只按 asc 放基线会把 j/g/y/p/q 的尾巴顶出画布底边 (2026-10-14 现场: "底部被截断")。 */
function sysInkFor(base, chars) {
  const size = Math.max(4, Math.round(+base.size || 20))
  const wt = Math.max(100, Math.min(900, Math.round(base.bold ? 700 : (base.weight || 400))))
  const meas = document.createElement('canvas').getContext('2d')
  meas.font = `${wt} ${size * SS}px "${base.family || DEFAULT_FONT}", sans-serif`
  let asc = 0, desc = 0
  for (const ch of chars) {
    if (ch === ' ') continue
    const m = meas.measureText(ch)
    asc = Math.max(asc, m.actualBoundingBoxAscent || 0)
    desc = Math.max(desc, m.actualBoundingBoxDescent || 0)
  }
  return { asc: Math.max(1, Math.round(asc)), desc: Math.max(0, Math.round(desc)) }
}

/**
 * 系统字 → ASCII 字库描述 { name, w, h, gap, first, count, bytes, rows, spacing } | null。
 * rows (逐字 Uint8Array) 就是导出时那张 2D 字模表; bytes 是同一份数据的连续序列。
 */
export function asciiFontForSys(cfg) {
  if (typeof document === 'undefined' || !cfg) return null
  const ramp = Math.max(0, Math.min(2, +cfg.rampSigma || 0))
  /* 同 numFontForSys: pad = 出格外扩 (紧排时 0), blurPad = 临时画布的实际留白 (始终 ceil(3σ)) */
  const glow = glowCfg(cfg), blurPad = glow.pad, pad = glow.fit ? 0 : blurPad
  /* 缓存键只带"会影响字模字节"的字段 —— 改示例文本 / 图层名不该重算这 95 个字 (一份要几百 ms)。
   * ！光晕参数**必须**进键: 它改字节, 不入键就会拿到上一份没光晕的字库。 */
  const sig = JSON.stringify(['asciisys', cfg.family || DEFAULT_FONT, cfg.size, cfg.weight, cfg.bold,
                              cfg.spacing, cfg.offsetY, ramp, cfg.dither565 !== false, !!cfg.evenSpacing,
                              JSON.stringify(cfg.glyphDx || cfg.digitDx || null),
                              glow.on, glow.thresh, glow.sigma, glow.gain, glow.fit])
  const hit = asciiFontSysCache.get(sig)
  if (hit !== undefined) return hit
  let font = null
  try {
    const size = Math.max(4, Math.round(+cfg.size || 20))
    const base = { ...cfg, size, spacing: 0, rampSigma: ramp, glyphDx: null }
    /* 格子高度 = 完整字迹 (asc+desc) ± 上下偏移; 基线按偏移方向让位 —— 见 asciiCellBox 的注释 */
    const { asc, desc } = sysInkFor(base, ASCII_PRINTABLE)
    const { boxH, baseline } = asciiCellBox(asc, desc, cfg.offsetY, SS)
    const cells = [...ASCII_PRINTABLE]
      .map(ch => ({ ch, cv: renderSysFontCanvas({ ...base, text: ch, ascent: asc, boxH, baseline }) }))
      .filter(c => !!c.cv)
    if (cells.length) {
      const sp = Math.round(+cfg.spacing || 0)
      /* 等距: 同 numFontForSys —— 格子按**最宽字迹**定宽 + 每字按**字迹**居中 */
      const even = !!cfg.evenSpacing
      const adv = Math.max(1, ...cells.map(c => c.cv.width))
      /* 负字距 → 把格子收窄, 但不能切进字迹: 下限 = 最宽字迹 (与数字字库同一条规则) */
      let inkMax = 1
      if (even || sp < 0) {
        for (const c of cells) {
          const b = inkBox(c.cv)
          if (b) inkMax = Math.max(inkMax, b.w)
        }
      }
      const cw = even ? Math.max(1, inkMax) : Math.max(1, inkMax, adv + Math.min(0, sp))
      const chh = Math.max(1, ...cells.map(c => c.cv.height))
      /* 逐字左右微调 (与数字字库同一条规则): 平移后按并集扩格子; 无偏移时 cw2 === cw */
      const dxUser = (cfg.glyphDx && typeof cfg.glyphDx === 'object') ? cfg.glyphDx
        : (cfg.digitDx && typeof cfg.digitDx === 'object' ? cfg.digitDx : null)
      const layout = cells.map(({ ch, cv }) => {
        const ib = even ? inkBox(cv) : null
        const baseDx = ib && cw >= ib.w
          ? Math.round((cw - ib.w) / 2) - ib.x
          : (cw >= cv.width ? Math.round((cw - cv.width) / 2) : 0)
        const userDx = dxUser ? Math.round(+dxUser[ch] || 0) : 0
        /* 基线范围先夹进原格子 (负字距时本来就允许裁), 再叠加用户左右偏移 ——
         * 只有用户真的把字往外挪, 格子才扩; 否则逐字节与以前一致。 */
        const bLeft = Math.max(0, Math.min(cw, baseDx + (ib ? ib.x : 0)))
        const bRight = Math.max(bLeft, Math.min(cw, baseDx + (ib ? ib.x + ib.w : cv.width)))
        return { ch, cv, ib, baseDx, userDx, left: bLeft + userDx, right: bRight + userDx }
      })
      let minX = 0, maxX = cw
      for (const l of layout) { minX = Math.min(minX, l.left); maxX = Math.max(maxX, l.right) }
      const cw2 = Math.max(1, maxX - minX)
      /* 光晕外扩: pad=0 时与原值相等; 紧排时 pad=0, 临时画布仍用 blurPad */
      const GW = cw2 + 2 * pad, GH = chh + 2 * pad
      const TW = cw2 + 2 * blurPad, TH = chh + 2 * blurPad
      const glyphs = layout.map(({ ch, cv, baseDx, userDx }) => {
        const t = document.createElement('canvas')
        t.width = TW; t.height = TH
        /* 等距 → 按**字迹框**居中 (与数字字库同一口径); 否则按字身框居中; 再加用户左右微调 */
        const dx = baseDx + userDx - minX + blurPad
        t.getContext('2d').drawImage(cv, dx, blurPad)
        const p = processImage(t, TW, TH, 'GRAY', {})
        /* 与 numFontForSys 逐字相同的两步, 同样互斥: ① 边缘斜坡加宽 (σ>0) ② 565 预抖动 (仅 σ=0)。
         * 二者叠加会把斜坡上的半档值 (124 = 15.5×8) 抖成周期 2 行的梳齿 —— 详见 numFontForSys 注释。 */
        let vals = p.values
        if (ramp > 0) vals = blurGray(vals, p.w, p.h, ramp)
        else if (cfg.dither565 !== false) vals = ditherGray565(vals, p.w, p.h)
        vals = withGlow(vals, p.w, p.h, glow)      /* 光晕最后叠 (同 numFontForSys) */
        /* 紧排: 算完裁回原格子, 字距不变 (同 numFontForSys) */
        if (glow.fit && blurPad > 0) vals = cropGray(vals, p.w, p.h, blurPad, blurPad, cw2, chh)
        return { ch, values: vals }
      })
      /* 同 numFontForSys: 开了光晕且未紧排才裁左右 (去掉光晕到不了的黑边); pad=0 时不裁 = 老行为 */
      font = numFontFromGlyphs(glyphs, '', GW, GH, Math.max(0, sp),
                               { chars: ASCII_PRINTABLE, trimCols: pad > 0 })
      if (font) {
        font.spacing = font.w - adv      // 有效字距 (负数被夹住时比用户填的大; 裁列后按实际格宽算)
        font.baseW = cw2                 // 开光晕前的格宽 (界面用来报"每格 +多少px")
        font.glowGrow = font.w - cw2
      }
    }
  } catch (e) { font = null }
  if (asciiFontSysCache.size > 12) asciiFontSysCache.clear()
  asciiFontSysCache.set(sig, font)
  return font
}

/** ASCII 字库 + 这一层 → 导出要用的那份 (rows 直接当字模表用) */
export function asciiTableFor(inst) {
  const f = asciiFontForSys(inst?.sysfont)
  if (!f?.rows?.length) return null
  return { rows: f.rows, w: f.w, h: f.h, gap: Math.max(0, Math.round(f.gap) || 0),
           first: f.first, count: f.count, bytes: f.bytes.length, spacing: f.spacing }
}

/* 数字用的字库: 优先用"这一层自己的字库素材" (字号跟着字库走), 没有就用内置 ASCII 8×11 */
const numFontCache = new Map()
const numFontSysCache = new Map()
export function numFontFor(inst, key = '') {
  /* 系统字图层: 数字用系统字渲染出来的字库 (选系统字时自动导出 0~9, 免得跑空) */
  if (inst?.sysfont) {
    const f = numFontForSys(inst.sysfont, key)
    if (f) return f
  }
  const a = state.assets.find(x => x.id === inst?.assetId)
  if (a?.font && a.font.charset !== 'frames') {
    const f = a.font
    const sig = [a.id, a.src.length, f.glyphW, f.glyphH, f.charset, f.custom, f.start, key,
                 (+f.rampSigma || 0)].join('|')
    const hit = numFontCache.get(sig)
    if (hit) return hit
    const glyphs = fontGlyphValues(a, 'GRAY')
    const font = numFontFromGlyphs(glyphs, key, f.glyphW, f.glyphH)
    if (font) {
      if (numFontCache.size > 30) numFontCache.clear()
      numFontCache.set(sig, font)
      return font
    }
  }
  return builtinNumFont()
}

export function fontGlyphValues(asset, fmt) {
  const cells = fontCells(asset)
  if (!cells || !cells.length) return null
  const f = asset.font
  const dith = f.dither565 !== false          /* 默认开: GRAY 上 RGB565 预抖动 (资产可关) */
  const ramp = Math.max(0, Math.min(2, +f.rampSigma || 0))   /* 边缘斜坡 σ(px): 跟着这个字库素材走 */
  const key = JSON.stringify([asset.id, asset.src.length, f.glyphW, f.glyphH, f.charset, f.custom, f.start, fmt, dith, ramp])
  const hit = fontValueCache.get(asset.id)
  if (hit && hit.key === key) return hit.glyphs
  const glyphs = []
  for (const c of cells) {
    try {
      const p = processImage(c.canvas, f.glyphW, f.glyphH, fmt, {})
      /* ① 边缘斜坡加宽 (σ>0 时): 治大字号斜边/圆弧的"一格一格"台阶 —— 浏览器给的 AA 只有 ~1px。
       * ② RGB565 预抖动 (仅 σ=0): 板子灰度×颜色后截断进 5/6 位, 不抖的字库一条 AA 渐变只剩 32 级。
       * ！① 与 ② 互斥 (2026-10-16 现场, 与 numFontForSys 同口径): σ 斜坡 + 抖动 = 直边周期 2 行梳齿。
       * 预览读同一份字节, 所以"预览即板子"成立。 */
      let vals = p.values
      if (fmt === 'GRAY' && ramp > 0) vals = blurGray(vals, p.w, p.h, ramp)
      else if (fmt === 'GRAY' && dith) vals = ditherGray565(vals, p.w, p.h)
      glyphs.push({ ch: c.ch, values: vals, len: p.len, gw: p.w, gh: p.h })
    } catch (e) { /* 跳过坏字 */ }
  }
  fontValueCache.set(asset.id, { key, glyphs })
  return glyphs
}

export function updateAsset(id, patch) {
  const a = state.assets.find(a => a.id === id)
  if (!a) return
  Object.assign(a, patch)
  fontCellCache.delete(id)
  fontValueCache.delete(id)
}

/* ---------- 文字实例 ---------- */
export function textMetrics(inst) {
  const a = state.assets.find(x => x.id === inst.assetId)
  if (!a?.font) return { w: inst.w, h: inst.h }
  const len = [...String(inst.text || '')].length
  const sp = Math.round(inst.spacing || 0)
  return {
    w: Math.max(0, len * a.font.glyphW + Math.max(0, len - 1) * sp),
    h: a.font.glyphH,
  }
}

export function syncTextSize(inst) {
  if (inst.kind !== 'text') return
  if (inst.bind) {          // 数字层: 尺寸 = 头 + 定宽数字 + 尾 (字号跟着字库走)
    const f = numFontFor(inst)
    const lay = numLayout(inst.bind, f)
    inst.w = Math.max(1, lay.w)
    inst.h = lay.h
    return
  }
  const m = textMetrics(inst)
  inst.w = m.w; inst.h = m.h
}

/**
 * 字体真正加载完之后: 丢掉"用回退字体量出来的"字宽/字高缓存, 重同步系统字图层尺寸, 再重绘一次。
 *
 * ！为什么必须有这一步 (2026-10-12 现场踩到, 症状是"网页预览跟导出到板子上不一样"):
 *   `@font-face` 用的是 `font-display: swap` —— 页面刚打开时系统字先用**回退字体**渲染,
 *   而 numFontForSys()/renderSysFontCanvas() 是**同步**的 (没法 await 字体), 于是首帧量出来的
 *   字宽 (回退字体的) 被 numFontSysCache / sysRenderCache 缓存住, 之后一直用。
 *   更坑的是: 预览用 key=''、导出用 key=图层名 → 两份缓存, **导出那一次往往已经是真字体了**,
 *   于是同一层数字在预览里宽 106、导出成 118 —— 板上就会压住旁边的图层。
 *   (现场: OPPO Sans 4.0 / size 100 / spacing -3 → 回退字体每格 53, 真字体每格 59;
 *    两位数字 = 106 vs 118, 右边多出 12px, 把 26x34 的 "s" 左 4 列擦掉。)
 *
 * ！只清"与字体度量有关"的缓存 (字形画布/字模/字库/成品像素), 不动素材图片缓存。
 */
export function refreshFontMetrics() {
  sysRenderCache.clear()
  fontCellCache.clear()
  fontValueCache.clear()
  fontPreviewCache.clear()
  numFontCache.clear()
  numFontSysCache.clear()
  asciiFontSysCache.clear()
  procCache.clear(); codeCache.clear(); pixelCache.clear()
  sysFontSuspect = false          /* 缓存清干净了, "画过回退字体"这件事也一并作废 */
  let touched = false
  for (const inst of state.instances || []) {
    if (inst.kind === 'text') { syncTextSize(inst); touched = true }
    if (inst.sysfont) { syncSysSize(inst); touched = true }
  }
  /* 尺寸没变时也要重绘一次 (像素是按旧字宽画进 proc 的): 换一份数组身份触发 watchEffect(render),
   * 与 applyUndoSnapshot() 用同一手法。 */
  if (touched || state.instances?.length) state.instances = [...(state.instances || [])]
  return true
}

/* ！「边缘斜坡 σ」是**每层/每个字库自己的**配置 (系统字: cfg.rampSigma; 字库素材: asset.font.rampSigma),
 * 不在导出选项里 —— 换了 σ 会改字库字节, 而两条造字路的缓存键都带上了它 (cfg / f.rampSigma),
 * 所以改完自动重算; 对话框保存时 updateInstance → 该层重绘。 */

/** 把工程里用到的系统字都显式 load 一遍 (每族/字重/字号各一次), 然后刷新度量。
 *  document.fonts.ready 只保证"已经请求过的"字体加载完 —— 而 swap 下浏览器可能还没开始请求,
 *  所以这里逐个 load 再刷新; 调用方 (main.js) 在 ready 之后跑, 并在 1.2s 后再兜一次。 */
export async function ensureProjectFontsAndRefresh() {
  const seen = new Set()
  for (const inst of state.instances || []) {
    const cfg = inst.sysfont
    if (!cfg) continue
    const size = Math.max(4, Math.round(+cfg.size || 20))
    const weight = Math.max(100, Math.min(900, Math.round(cfg.bold ? 700 : (cfg.weight || 400))))
    const sig = `${cfg.family}|${weight}|${size}`
    if (seen.has(sig)) continue
    seen.add(sig)
    await ensureFont(cfg.family || DEFAULT_FONT, weight, size)
  }
  return refreshFontMetrics()
}

export function addTextInstance(assetId) {
  const asset = state.assets.find(a => a.id === assetId && a.font)
  if (!asset) return null
  const sc = screen.value
  const inst = {
    id: uid('inst'),
    kind: 'text',
    assetId,
    page: 0,                            // 页号=序号=切页顺序
    name: 'str_' + (state.instances.filter(i => i.kind === 'text').length + 1),
    text: 'ABC',
    spacing: 0,
    fmt: 'GRAY',
    color: 0xFFFF,
    mirror: false,
    x: 0, y: 0, w: 0, h: 0,
    fullSet: false,   // 导出完整字符集 (false=只导用到的字)
  }
  syncTextSize(inst)
  inst.x = Math.round((sc.w - inst.w) / 2)
  inst.y = Math.round((sc.h - inst.h) / 2)
  state.instances.push(inst)
  state.ui.selectedId = inst.id
  return inst
}

/* ---------- 文字/系统字图层 → 当前工程素材 ----------
 * 「＋文字」建出来的是图层 (kind:'text' / sysfont), 不是素材, 所以素材栏里一直看不到.
 * 这里给**固定文本**层生成一份只读快照 (素材栏里显示「文字」标签):
 *   · 数字 (bind) / ASCII 字库是动态值/整表, 不是一张固定图, 不生成;
 *   · id 固定为 text_layer_<图层 id>: 改文字/字号/颜色是原地更新, 不会越改越多;
 *   · 图层删掉且快照没被别的图片层当素材用时自动收回. */
export function isTextMaterialInstance(inst) {
  if (!inst || inst.groupId) return false
  if (inst.kind === 'text') return !(inst.bind && (inst.bind.type || 'num') === 'num')
  if (inst.sysfont) return !inst.ascii && !(inst.bind && (inst.bind.type || 'num') === 'num')
  return false
}

/** 影响"这张文字图长什么样"的签名 (只用于判断要不要重新生成; 拖动 x/y 不会触发) */
export function textMaterialSignature(inst) {
  if (!isTextMaterialInstance(inst)) return ''
  if (inst.sysfont) {
    return JSON.stringify(['sys', inst.sysfont, inst.fmt, inst.color, inst.mirror,
      inst.crop || null, Math.round(+inst.w || 0), Math.round(+inst.h || 0)])
  }
  return JSON.stringify(['text', inst.assetId, String(inst.text || ''),
    Math.round(+inst.spacing || 0), inst.fmt, inst.color, !!inst.fullSet,
    Math.round(+inst.w || 0), Math.round(+inst.h || 0)])
}

function textMaterialName(inst) {
  const raw = inst.sysfont ? (inst.sysfont.text != null ? inst.sysfont.text : inst.text) : inst.text
  const text = String(raw || '').replace(/\s+/g, ' ').trim()
  const body = text.length > 18 ? text.slice(0, 18) + '…' : (text || '空文本')
  const fam = inst.sysfont && inst.sysfont.family ? String(inst.sysfont.family).split(/[ ,]/)[0] : ''
  return '文字「' + body + '」' + (fam ? ' · ' + fam.slice(0, 12) : '')
}

const textMaterialSeen = new Map()   // asset id -> 上次生成时的签名
let textMaterialTimer = 0

/** 把当前工程里的固定文字层同步成素材 (返回新增/更新/收回条数; Node 自检没有 canvas 时返回 0) */
export function syncTextMaterialAssets() {
  if (typeof document === 'undefined') return 0
  let changed = 0
  const owners = new Set()
  for (const inst of state.instances || []) {
    if (!isTextMaterialInstance(inst)) continue
    owners.add(inst.id)
    const sig = textMaterialSignature(inst)
    const id = 'text_layer_' + inst.id
    const have = state.assets.find(a => a.id === id)
    if (have && textMaterialSeen.get(id) === sig) continue
    let proc = null
    try { proc = instanceProc(inst) } catch (e) { proc = null }
    if (!proc || !proc.canvas) continue
    let src = ''
    try { src = proc.canvas.toDataURL() } catch (e) { continue }
    const w = Math.max(1, Math.round(proc.w || proc.canvas.width || inst.w || 1))
    const h = Math.max(1, Math.round(proc.h || proc.canvas.height || inst.h || 1))
    const name = textMaterialName(inst)
    if (have) {
      if (have.name !== name || have.src !== src || have.w !== w || have.h !== h ||
          have.defaultFmt !== inst.fmt) {
        Object.assign(have, { name, src, w, h, defaultFmt: inst.fmt, derivedText: inst.id })
        imageCache.delete(id)
        changed++
      }
    } else {
      state.assets.push({ id, name, src, w, h, defaultFmt: inst.fmt, derivedText: inst.id })
      imageCache.delete(id)
      changed++
    }
    textMaterialSeen.set(id, sig)
  }
  /* 图层删了 (且快照没被别的图层当图片用) → 收回, 不留孤儿素材 */
  for (const a of [...state.assets]) {
    if (!a || typeof a.derivedText !== 'string' || owners.has(a.derivedText)) continue
    if ((state.instances || []).some(i => i.assetId === a.id)) continue
    state.assets = state.assets.filter(x => x.id !== a.id)
    imageCache.delete(a.id)
    textMaterialSeen.delete(a.id)
    changed++
  }
  return changed
}

export function scheduleTextMaterialSync(delay = 300) {
  clearTimeout(textMaterialTimer)
  textMaterialTimer = setTimeout(syncTextMaterialAssets, delay)
}

export function updateInstance(id, patch) {
  const inst = state.instances.find(i => i.id === id)
  if (!inst) return
  /* 组内变体: 拖拽/方向键改 x/y = 整组一起动 (组内相对位置不变)。
   * 组内偏移不在这里走 —— 子预览用 setFrameGroupOffset 单独改那一帧。 */
  const group = inst.groupId ? frameGroupOf(inst.groupId) : null
  if (group && (patch.x != null || patch.y != null)) {
    const nx = patch.x != null ? Math.round(+patch.x || 0) : inst.x
    const ny = patch.y != null ? Math.round(+patch.y || 0) : inst.y
    const dx = nx - inst.x, dy = ny - inst.y
    delete patch.x; delete patch.y
    moveFrameGroup(group.id, dx, dy)
  }
  Object.assign(inst, patch)
  if (patch.bind === null) delete inst.bind          // 取消「数字」→ 真的删掉, 不留 null
  if (inst.kind === 'text') syncTextSize(inst)
  if (inst.sysfont) syncSysSize(inst)
  if (inst.kind === 'ring') {
    syncRingSize(inst)
    if (patch.ring) setRingAnimAngle(inst.id, patch.ring.glintDeg ?? 0)   // 手动改角度 → 动画从此处续转
  }
  // 帧实例: 尺寸跟随帧尺寸
  /* ！组内变体不能走这里: 它们的 w/h 是"这一帧的内容框" (各帧可以不同, 组框按最大帧算);
   *   若强行改成整格 glyphW/H, 子预览里的对齐/偏移就全乱了。 */
  if (!inst.groupId && inst.kind !== 'text' && inst.frame != null && inst.frame >= 0) {
    const a = state.assets.find(x => x.id === inst.assetId)
    if (a?.font) { inst.w = a.font.glyphW; inst.h = a.font.glyphH }
  }
  if (group && (patch.w != null || patch.h != null)) recalcFrameGroupBox(group)
}

export function removeInstance(id) {
  const inst = state.instances.find(i => i.id === id)
  const gid = inst?.groupId || ''
  state.instances = state.instances.filter(i => i.id !== id)
  dropInstanceCaches(id)
  if (gid) {
    const g = frameGroupOf(gid)
    if (g) {
      const left = frameGroupLayers(g)
      if (!left.length) removeFrameGroup(gid)
      else {
        /* 删的是当前帧 → 夹到剩下的最后一帧 */
        if ((g.current | 0) >= left.length) g.current = left.length - 1
        recalcFrameGroupBox(g)
      }
    }
  }
  if (state.ui.selectedId === id) state.ui.selectedId = null
  if (state.ui.dialogInstanceId === id) state.ui.dialogInstanceId = null
}

export function duplicateInstance(id) {
  const inst = state.instances.find(i => i.id === id)
  if (!inst) return
  // 深拷贝: ring/crop/sysfont 等嵌套对象不能与原实例共享引用
  const copy = JSON.parse(JSON.stringify(inst))
  copy.id = uid('inst')
  copy.x = inst.x + 8
  copy.y = inst.y + 8
  state.instances.push(copy)
  state.ui.selectedId = copy.id
}

export function zorder(id, dir) {
  const idx = state.instances.findIndex(i => i.id === id)
  if (idx < 0) return
  const to = dir === 'top' ? state.instances.length - 1 : dir === 'bottom' ? 0 : idx + dir
  if (to < 0 || to >= state.instances.length) return
  const [it] = state.instances.splice(idx, 1)
  state.instances.splice(to, 0, it)
}

export const selectedInstance = computed(() =>
  state.instances.find(i => i.id === state.ui.selectedId) || null)

/* ---------- 预览 (量化后 1:1 画布, 带缓存) ---------- */
const codeCache = new Map()    // instId -> { key, text } 数组文本缓存

export function instanceProc(inst) {
  void state._imgTick   // 图片异步加载完成后触发重算
  const p = screen.value

  // 圆环部件: 用 drawRing 渲染到临时 canvas (供 warnings/红色检测使用)
  if (inst.kind === 'ring') {
    const w = Math.max(2, Math.round(inst.w)), h = Math.max(2, Math.round(inst.h))
    const key = JSON.stringify(['ring', inst.id, inst.ring, inst.w, inst.h, p?.bg ?? 0])
    const hit = procCache.get(inst.id)
    if (hit && hit.key === key) return hit.proc
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    const ctx = cv.getContext('2d')
    // 画进画布自己的原点: 实例坐标偏移由绘制方 (paintRect) 负责, 否则半像素定位会被裁掉
    // bg: 边缘 AA 往屏幕底色淡出 (与预览/导出图片同一底色)
    drawRing(ctx, { ...inst, x: 0, y: 0 }, { bg: p?.bg ?? 0 })
    const proc = { canvas: cv, values: null, kind: 'ring', w, h, len: 0 }
    proc._key = key
    procCache.set(inst.id, { key, proc })
    return proc
  }

  /* 动态数字区域 (「＋文字」弹窗里选了「数字」): 按固件 UI_T_NUM 的画法预览 ——
   * 定宽 cells 格 + 固定小数位 + 补零/补空格 + 底色 + **对齐(左/中/右)**, 数字用 inst.color。
   * 这一层**自己的像素不画** (固件那边由 UI_Tick 刷数字; 导出也不含它的素材), 画面上看到的就是数字。
   * ！对齐必须与固件逐像素一致 (numFieldLead ↔ code/spi/app_ui.c 的 UI_DrawField),
   *   否则"网页设居中、板子画歪一格"这种不一致又会冒出来。 */
  if (inst.bind && (inst.bind.type || 'num') === 'num') {
    const b = inst.bind
    const key = JSON.stringify(['num', inst.id, b, inst.color, inst.w, inst.h])
    const hit = procCache.get(inst.id)
    if (hit && hit.key === key) return hit.proc
    const font = numFontFor(inst)
    const sig = formatNumSig(b.demo == null ? 0 : b.demo, b.dec)
    const lead = numFieldLead(b, font, sig.length)            // null = 放不下 (固件不画)
    const gw = Math.max(1, Math.round(font?.w) || 8)
    const gap = Math.max(0, Math.round(font?.gap) || 0)
    const cells = Math.max(1, Math.round(+b.cells || 1))
    const boxW = cells * (gw + gap) - gap                    // 这块显示区的总宽 (与固件一致)
    const text = lead == null ? '' : sig
    const cv = renderNumCanvas(text, inst.color == null ? 0xFFFF : inst.color,
                               b.bg == null ? 0xFFFF : b.bg, font,
                               { width: boxW, lead: lead == null ? 0 : lead })
    // 颜色已画进画布 → 用 RGB565 保色 (不能走 GRAY+tint, 否则底色会被染成数字色)
    const proc = processImage(cv, cv.width, cv.height, 'RGB565', { grayPack: p.grayPack, rgb888AsMacro: p.rgb888AsMacro })
    proc._key = key
    procCache.set(inst.id, { key, proc })
    return proc
  }

  // 系统字库: 渲染文字为图片源 (无 assetId, 须在 asset 检查前)
  if (inst.sysfont) {
    /* 用 sysGlowCanvas 而不是 renderSysFontCanvas: 光晕已烘进像素, 墨迹框自然含光晕 ⇒
     * 裁切窗口/尺寸与 syncSysSize 一致 (两者不一致会一行行错开) */
    const rc = sysGlowCanvas(inst.sysfont)
    if (!rc) return null
    const cw2 = Math.max(1, Math.min(4096, Math.round(inst.w)))
    const ch2 = Math.max(1, Math.min(4096, Math.round(inst.h)))
    const key = JSON.stringify(['sys', inst.sysfont, inst.fmt, inst.color, inst.mirror,
      inst.w, inst.h, inst.crop ?? null, p.grayPack, p.rgb888AsMacro])
    const hit = procCache.get(inst.id)
    if (hit && hit.key === key) return hit.proc
    /* 系统字: 裁切窗口 = 手动 crop 优先, 否则 = 墨迹框 (与 syncSysSize 用同一个 inkBox)。
     * proc 尺寸**必须**等于图层尺寸 cw2×ch2 —— 帧表里写的是 inst.w/inst.h,
     * 固件按 w 字节一行读数组; 两者不等就会一行行错开 (现象: 字形向右倾斜)。 */
    const box = glowCfg(inst.sysfont).on ? inkBoxLit(rc) : inkBox(rc)
    const ox = inst.crop ? (Math.round(inst.crop.x) || 0) : (box ? box.x : 0)
    const oy = inst.crop ? (Math.round(inst.crop.y) || 0) : (box ? box.y : 0)
    const src1 = applyCropWindow(rc, ox, oy, cw2, ch2)
    const proc = processImage(src1, cw2, ch2, inst.fmt, {
      tint: inst.color, mirror: inst.mirror,
      grayPack: p.grayPack, rgb888AsMacro: p.rgb888AsMacro,
    })
    /* ！导出的 RGB565 字节必须保持白色字迹 (固件后续按 color 算/叠色), 不能在这里染色。
     *   只染**预览画布**: 否则改颜色后主画布预览仍是一张白字, 看起来像颜色设置没生效。 */
    if (inst.fmt === 'RGB565') proc.canvas = tintCanvas(proc.canvas, inst.color, { zeroTransparent: true })
    proc._key = key
    procCache.set(inst.id, { key, proc })
    return proc
  }

  const asset = state.assets.find(a => a.id === inst.assetId)

  if (!asset) return null

  // 文字实例: 逐字拼条后整体量化
  if (inst.kind === 'text') {
    const cells = fontCells(asset)
    if (!cells || !cells.length) return null
    const key = JSON.stringify(['text', asset.id, asset.src.length, inst.text, inst.spacing,
      inst.fmt, inst.color, asset.font.glyphW, asset.font.glyphH, asset.font.charset, asset.font.custom])
    const hit = procCache.get(inst.id)
    if (hit && hit.key === key) return hit.proc
    const gw = asset.font.glyphW, gh = asset.font.glyphH
    const chars = [...String(inst.text || '')]
    /* 字库里没有的字**留空格子** (不能丢): 丢掉会让拼条宽度 < 图层宽度 (textMetrics 按整串算),
     * 而帧表写的是图层尺寸 → 数组长度 ≠ w*h → 固件按 w 字节一行读就一行行错开 (字形倾斜)。
     * 尺寸直接用 textMetrics (与 syncTextSize / 帧表同一个公式)。 */
    const seq = chars.map(ch => cells.find(c => c.ch === ch) || null)
    if (!seq.some(Boolean)) return null
    const sp = Math.round(inst.spacing || 0)
    const m = textMetrics(inst)
    const strip = document.createElement('canvas')
    strip.width = Math.max(1, m.w)
    strip.height = Math.max(1, m.h)
    const sctx = strip.getContext('2d')
    seq.forEach((c, i) => { if (c) sctx.drawImage(c.canvas, i * (gw + sp), 0) })
    const proc = processImage(strip, strip.width, strip.height, inst.fmt, { tint: inst.color })
    /* 同系统字: RGB565 导出保持白色字迹, 只给预览画布染色。 */
    if (inst.fmt === 'RGB565') proc.canvas = tintCanvas(proc.canvas, inst.color, { zeroTransparent: true })
    proc._key = key
    procCache.set(inst.id, { key, proc })
    return proc
  }

  const img = getAssetImage(asset)
  if (!img.complete || !img.naturalWidth) return null
  // SVG 素材: SVG Image 就绪时矢量重新光栅化; 否则回退到位图路径
  let src
  if (asset.svg && asset.svgText) {
    const svgImg = svgImageCache.get(asset.id)
    if (svgImg && svgImg.complete && svgImg.naturalWidth) {
      const cw2 = Math.max(1, Math.round(inst.w))
      const ch2 = Math.max(1, Math.round(inst.h))
      const key = JSON.stringify(['svg', asset.id, inst.w, inst.h, inst.fmt, inst.color, inst.mirror,
        p.grayPack, p.rgb888AsMacro])
      const hit = procCache.get(inst.id)
      if (hit && hit.key === key) return hit.proc
      src = svgToCanvas(svgImg, cw2, ch2)
      // 与位图路径保持一致: 剔除黑边后仍缩放到实例尺寸, 避免"矢量就绪后画面缩放一次"
      const trimmed = trimBlackEdges(src)
      if (trimmed) src = trimmed
      const proc = processImage(src, cw2, ch2, inst.fmt, {
        tint: inst.color, mirror: inst.mirror, grayByMax: asset.font?.charset === 'frames',
        grayPack: p.grayPack, rgb888AsMacro: p.rgb888AsMacro,
      })
      proc._key = key
      procCache.set(inst.id, { key, proc })
      return proc
    }
    // SVG Image 未就绪 → 回退到位图路径 (用 src dataURL 加载的 Image)
  }
  // 多帧素材: 源改为选中帧的切片; 裁切窗口 = (crop.x, crop.y, w, h), 越界补黑边
  src = img
  if (inst.frame != null && inst.frame >= 0 && asset.font) {
    const cells = fontCells(asset)
    const cell = cells ? cells[frameIdx(inst)] : null
    if (!cell) return null
    src = cell.canvas
  }
  // 普通图片: 剔除黑边后再缩放到实例尺寸 (尺寸仍由实例 w/h 决定, 见 paintRect)
  if (!asset.font || inst.frame == null || inst.frame < 0) {
    const trimmed = trimBlackEdges(src)
    if (trimmed) src = trimmed
  }
  const cw = Math.max(1, Math.min(4096, Math.round(inst.w)))
  const chh = Math.max(1, Math.min(4096, Math.round(inst.h)))
  src = applyCropWindow(src, Math.round(inst.crop?.x) || 0, Math.round(inst.crop?.y) || 0, cw, chh)
  const key = JSON.stringify([asset.id, inst.frame ?? -1, inst.crop ?? null, inst.w, inst.h, inst.fmt, inst.color, inst.mirror,
    p.grayPack, p.rgb888AsMacro])
  const hit = procCache.get(inst.id)
  if (hit && hit.key === key) return hit.proc
  const proc = processImage(src, inst.w, inst.h, inst.fmt, {
    tint: inst.color, mirror: inst.mirror, grayByMax: asset.font?.charset === 'frames',
    grayPack: p.grayPack, rgb888AsMacro: p.rgb888AsMacro,
  })
  proc._key = key
  procCache.set(inst.id, { key, proc })
  return proc
}

/**
 * 预览/导出图片共用的图层表: [{ inst, proc }] —— proc = 量化画布。
 * ScreenStage.render 与 ExportPanel 的「导出图片」都走这一份, 保证"下载到的 = 预览里看到的"。
 * 圆环没有 proc (由 drawRing 直绘, 见 frameshoot.paintFrame)。
 */
export function frameLayers() {
  /* 组内只画当前帧: 多帧变体都在同一位置, 全画的话后一帧会整块盖掉前一帧。
   * 导出不走这里 (collectLayerPlan 用 state.instances), 所以每帧仍然各导各的。
   * ！预览默认强制 RGB565; 只有勾了「跟随格式」才按 inst.fmt 渲染 (GRAY 等只影响导出)。 */
  const followFmt = !!state.ui.previewFollowFmt
  return state.instances.filter(isInstanceVisible).map(inst => ({
    inst,
    proc: inst.kind === 'ring' ? null
      : instanceProc(followFmt ? inst : { ...inst, fmt: 'RGB565' }),
  }))
}

/* 实例实际绘制矩形 —— 与 ScreenStage.render 的 drawImage 参数严格一致:
 * 图片/文字取整坐标 + proc 画布尺寸; 圆环保留 0.5px 坐标 (ringrender 支持半像素) */
export function paintRect(inst) {
  const p = instanceProc(inst)
  const w = p ? p.w : Math.max(1, Math.round(inst.w))
  const h = p ? p.h : Math.max(1, Math.round(inst.h))
  if (inst.kind === 'ring') return { x: inst.x, y: inst.y, w, h }
  return { x: Math.round(inst.x), y: Math.round(inst.y), w, h }
}

/* 包围盒命中 (不含像素判断): 覆盖层/点穿回退用 */
export function inPaintBox(inst, x, y) {
  const r = paintRect(inst)
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

/* 像素级命中: 先过包围盒, 再看像素 —— 完全透明 / 纯黑像素不参与命中。
 * 圆环四角、透明 PNG 的空白区可直接点穿; proc 未就绪或像素读取失败时退回包围盒。 */
export function hitInstance(inst, x, y) {
  if (!inPaintBox(inst, x, y)) return false
  const proc = instanceProc(inst)
  if (!proc?.canvas) return true
  const r = paintRect(inst)
  const lx = Math.floor(x - r.x), ly = Math.floor(y - r.y)
  if (lx < 0 || ly < 0 || lx >= proc.w || ly >= proc.h) return true
  let pix
  try { pix = procPixels(proc) } catch (e) { return true }   // 像素读不到时不能挡住选中
  const si = (ly * pix.w + lx) * 4
  if (pix.data[si + 3] < OUT_ALPHA_MIN) return false
  return pix.data[si] + pix.data[si + 1] + pix.data[si + 2] > OUT_DARK_MAX
}

function arrayTextCached(inst, proc, name, crop) {
  const key = JSON.stringify([proc._key, name, state.exportOpts.upperHex, state.exportOpts.perLine, crop || null])
  const hit = codeCache.get(inst.id)
  if (hit && hit.key === key) return hit.text
  const text = buildCArrayText(name, proc, {
    upperHex: state.exportOpts.upperHex,
    perLine: state.exportOpts.perLine || undefined,
    crop,
  })
  codeCache.set(inst.id, { key, text })
  return text
}

/* 实例与屏幕的交集 (屏幕坐标系, 以实际绘制矩形为准); 完全屏外时 w/h = 0 */
export function visibleRect(inst, sc) {
  const r = paintRect(inst)
  const ix = Math.round(r.x), iy = Math.round(r.y)
  const x1 = Math.max(0, ix), y1 = Math.max(0, iy)
  const x2 = Math.min(sc.w, ix + Math.round(r.w))
  const y2 = Math.min(sc.h, iy + Math.round(r.h))
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) }
}

/* 数组裁剪矩形 (图内坐标, 与 proc 数组尺寸对齐); 全在屏内返回 null (不裁剪) */
export function cropRect(inst, sc) {
  const r = paintRect(inst)
  const ix = Math.round(r.x), iy = Math.round(r.y)
  const iw = Math.max(1, Math.round(r.w)), ih = Math.max(1, Math.round(r.h))
  if (ix >= 0 && iy >= 0 && ix + iw <= sc.w && iy + ih <= sc.h) return null
  const v = visibleRect(inst, sc)
  if (v.w <= 0 || v.h <= 0) return { none: true }
  return { x: v.x - ix, y: v.y - iy, w: v.w, h: v.h }
}

/* ---------- 警告 ---------- */
export function toggleCircleWarn(instId) {
  if (state.hiddenCircleWarns[instId]) delete state.hiddenCircleWarns[instId]
  else state.hiddenCircleWarns[instId] = true
}

export const warnings = computed(() => {
  const sc = screen.value, out = []
  const geom = sc.round ? roundGeom(sc) : null
  for (const inst of state.instances) {
    const pr = paintRect(inst)
    const tag = `${inst.name} @(${Math.round(pr.x)},${Math.round(pr.y)}) ${Math.round(pr.w)}×${Math.round(pr.h)}`
    // 方屏: 包围盒越界即警告 (矩形对矩形, AABB 判定精确)
    // 圆屏: 交给下面的像素级判定 —— 透明/纯黑不参与, 不再用 AABB 四角误伤圆环
    if (!geom && (pr.x < 0 || pr.y < 0 || pr.x + pr.w > sc.w || pr.y + pr.h > sc.h))
      out.push({ level: 'warn', text: `${tag} 超出屏幕范围` })
    if (geom) {
      const proc = instanceProc(inst)
      if (proc?.canvas) {
        const pix = procPixels(proc)
        // 与舞台红色叠加共用同一判定 (roundscreen.js): 像素中心 + 内切圆, 无额外容差
        const outsideCount = forEachOutsidePixel(pix.data, pix.w, pix.h, pr.x, pr.y, geom, null)
        if (outsideCount > 0) out.push({ level: 'warn', text: `${tag} ${outsideCount} 像素落在圆屏显示区之外`, instId: inst.id })
      }
    }
  }
  // 同名但数据不同 = 真冲突; 同名同数据 = 共享数组, 合法
  const sigByName = new Map()
  const conflicted = new Set()
  for (const inst of state.instances) {
    const n = sanitizeName(inst.name)
    const sig = arraySignature(inst)
    if (sigByName.has(n) && sigByName.get(n) !== sig) conflicted.add(n)
    else sigByName.set(n, sig)
  }
  if (conflicted.size) out.push({ level: 'warn', text: `数组名冲突(同名不同数据): ${[...conflicted].join(', ')} — 请改名或统一尺寸/格式` })
  /* 一个工程只支持一个环 (板上单例引擎) —— 老工程/手工改 JSON 可能带出多个 */
  {
    const rings = state.instances.filter(i => i.kind === 'ring')
    if (rings.length > 1)
      out.push({ level: 'warn', text: `工程里有 ${rings.length} 个环 —— 板子上只支持 1 个 (单例引擎 + 一份 ring_config.h): 只有第一个「${rings[0].name}」的参数会生效, 其余请删掉, 或把形状/参数合并到这一个里` })
  }
  /* 圆角矩形 / 逆时针 / 立体感 都上板了 (RING_SHAPE=1 + RING_ARC_DIR_DEF + 断面表) */
  /* 页面配置: 定时跳转目标不存在 / -1 页放了图层 / LOGO 页 (0 页) 没配跳转 */
  out.push(...pageIssuesFor({ items: state.instances, pagePeriods: state.pages || {} }))
  return out
})

/* ---------- 导出 ---------- */
/* 数组数据签名: 相同签名 = 相同数组内容 (位置/调色不算, 可共享一张数组) */
function arraySignature(inst) {
  const asset = state.assets.find(a => a.id === inst.assetId)
  if (!asset) return JSON.stringify(['none', inst.id])
  if (inst.kind === 'text') {
    return JSON.stringify(['text', asset.id, asset.src.length, asset.font?.glyphW, asset.font?.glyphH,
      asset.font?.charset, asset.font?.custom, inst.fmt, screen.value.grayPack, !!inst.fullSet,
      [...new Set(String(inst.text || ''))].sort().join('')])
  }
  if (inst.frame != null && inst.frame >= 0) {
    return JSON.stringify(['frames', asset.id, asset.src.length, asset.font?.glyphW, asset.font?.glyphH,
      asset.font?.charset, asset.font?.custom, inst.fmt, screen.value.grayPack])
  }
  return JSON.stringify(['img', asset.id, asset.src.length, inst.frame ?? -1, inst.crop ?? null,
    inst.w, inst.h, inst.fmt, screen.value.grayPack, screen.value.rgb888AsMacro])
}
const escCh = c => (c >= ' ' && c <= '~' && c !== '*' && c !== '/' && c !== '\\') ? c : ''

/* C 字符串转义 (含非 ASCII → \xNN) */
export function escCStr(s) {
  let out = ''
  for (const ch of String(s)) {
    const c = ch.charCodeAt(0)
    if (ch === '"' || ch === '\\') out += '\\' + ch
    else if (c < 0x20 || c > 0x7E) out += '\\x' + c.toString(16).toUpperCase().padStart(2, '0')
    else out += ch
  }
  return out
}

function textTableFor(inst, asset) {
  const glyphs = fontGlyphValues(asset, inst.fmt)
  if (!glyphs || !glyphs.length) return null
  const used = new Set([...String(inst.text || '')])
  const table = inst.fullSet ? glyphs : glyphs.filter(g => used.has(g.ch))
  if (!table.length) return null
  const sc = screen.value
  const kind = inst.fmt === 'GRAY' ? (sc.grayPack === 'g565' ? 'u16g' : 'u8') : 'u16'
  return { table, kind }
}

/**
 * 系统字「ASCII 字库」层 → C 代码 (指令面板/单层复制):
 * 字模表 (整份 0x20..0x7E) + 按 id 取图 + 打字符串函数。与「一键导出」的 ui_font.c 同源生成器,
 * 只是这里把字模数组也一起贴出来 (面板可以直接复制走)。
 * 这一层显示的示例文本仍按普通素材导出, 由调用方在后面接着处理。
 */
function asciiExportParts(inst, wantArray) {
  const name = sanitizeName(inst.name)
  const t = asciiTableFor(inst)
  if (!t) return [`/* ${name}: ASCII 字库未就绪 (系统字体还没加载完?) */`]
  const first = t.first, last = t.first + t.count - 1
  const hex = (v) => '0x' + v.toString(16).toUpperCase().padStart(2, '0')
  const parts = [`/* 系统字 ASCII 字库 → GRAY8: ${t.count} 个字形 (${hex(first)}..${hex(last)}),`
    + ` 每字 ${t.w}×${t.h} = ${t.w * t.h}B, 共 ${(t.bytes / 1024).toFixed(1)}KB`
    + (first === ASCII_FIRST ? '; 字符序 = ASCII 码序' : '') + ' */']
  const sig = JSON.stringify(['asciifont', name, t.count, t.first, t.w, t.h, t.gap])
  if (wantArray(name + 'Pic', sig)) {
    const glyphs = t.rows.map((values, i) => ({ ch: String.fromCharCode(first + i), values, len: values.length, gw: t.w, gh: t.h }))
    parts.push(buildFontTableText(name + 'Pic', glyphs, 'u8', {
      upperHex: state.exportOpts.upperHex, perLine: state.exportOpts.perLine || undefined,
    }))
  }
  const table = `gImage_${name}Pic`
  parts.push(idDrawFunction(name, { count: t.count, w: t.w, h: t.h, table, ascii: true, first }))
  parts.push(asciiStrFunction(name, { first, count: t.count, w: t.w, h: t.h, gap: t.gap, table }))
  return parts
}

function textExportParts(inst, i, wantArray) {
  const sc = screen.value
  const parts = []
  const asset = state.assets.find(a => a.id === inst.assetId)
  if (!asset?.font) return [`/* ${sanitizeName(inst.name)}: 字库缺失, 已跳过 */`]
  const cells = fontCells(asset)
  if (!cells || !cells.length) return [`/* ${sanitizeName(inst.name)}: 字库图片未就绪 */`]
  const gw = asset.font.glyphW, gh = asset.font.glyphH
  const sp = Math.max(0, Math.round(inst.spacing || 0))
  const name = sanitizeName(inst.name)
  const tt = textTableFor(inst, asset)
  const kind = tt ? tt.kind : 'u8'

  // 通用字库调用函数 (每字库一次)
  const tpl = sc.templates.TEXT || ''
  const perCharMode = /\{(ch|idx|gw|gh)\}/.test(tpl)
  if (!perCharMode && wantArray(`LCD_drawStr_${name}`, arraySignature(inst))) {
    const fnCtx = { name, pic: `gImage_${name}`, gw, gh, charset: escCStr(fontCharset(asset.font)) }
    parts.push(renderTemplate(sc.templates.TEXTFN || '', fnCtx))
  }

  if (tt && wantArray(name, arraySignature(inst))) {
    parts.push(`/* ${asset.name} 字库 → ${inst.fmt}${inst.fullSet ? ' (完整字符集)' : ' (仅用到的字符)'} */`)
    parts.push(buildFontTableText(name, tt.table, kind, {
      upperHex: state.exportOpts.upperHex, perLine: state.exportOpts.perLine || undefined,
    }))
  }

  if (!perCharMode) {
    // 单条调用模式
    const x = Math.round(inst.x), y = Math.round(inst.y)
    if (x >= sc.w || y >= sc.h || x + gw * Math.max(1, [...String(inst.text || '')].length) <= 0 || y + gh <= 0) {
      parts.push(`/* ${name}: 完全在屏幕外 */`)
      return parts
    }
    const v = inst.color & 0xFFFF
    const ctx = {
      x, y, w: Math.round(inst.w), h: gh, name, pic: `gImage_${name}`,
      text: escCStr(inst.text || ''),
      color: '0x' + v.toString(16).toUpperCase().padStart(4, '0'),
      colorName: nearestColorName(v), i,
      len: gw * gh, lenBytes: gw * gh * (kind === 'u8' ? 1 : 2),
      sw: sc.w, sh: sc.h, fmt: inst.fmt, mirror: 0,
    }
    parts.push(renderTemplate(tpl, ctx))
    return parts
  }

  // 逐字模式 (兼容含 {ch}/{idx} 的旧模板)
  const chars = [...String(inst.text || '')]
  let drew = 0
  chars.forEach((ch, ci) => {
    const x = Math.round(inst.x) + ci * (gw + sp)
    const y = Math.round(inst.y)
    if (x >= sc.w || y >= sc.h || x + gw <= 0 || y + gh <= 0) return   // 完全屏外
    const idx = tt ? Math.max(0, tt.table.findIndex(g => g.ch === ch)) : 0
    const v = inst.color & 0xFFFF
    const per = kind === 'u8' ? 1 : 2
    const ctx = {
      x, y, w: gw, h: gh, gw, gh, name, pic: `gImage_${name}`,
      idx, ch: escCh(ch),
      color: '0x' + v.toString(16).toUpperCase().padStart(4, '0'),
      colorName: nearestColorName(v),
      i, len: gw * gh, lenBytes: gw * gh * per,
      sw: sc.w, sh: sc.h, fmt: inst.fmt, text: String(inst.text || ''), mirror: 0,
    }
    parts.push(renderTemplate(sc.templates.TEXT || 'LCD_drawGrayImage({x}, {y}, {gw}, {gh}, {pic}[{idx}], {color}, 0);', ctx))
    drew++
  })
  if (drew === 0) parts.push(`/* ${name}: 所有字符均在屏幕外 */`)
  return parts
}

/* 帧实例导出: 全部帧一张二维总表 + 指令用数字下标 [N] 选帧 */
function frameExportParts(inst, i, wantArray) {
  const sc = screen.value
  const parts = []
  const asset = state.assets.find(a => a.id === inst.assetId)
  if (!asset?.font) return [`/* ${sanitizeName(inst.name)}: 帧数据缺失, 已跳过 */`]
  const glyphs = fontGlyphValues(asset, inst.fmt)
  if (!glyphs || !glyphs.length) return [`/* ${sanitizeName(inst.name)}: 帧图未就绪 */`]
  const kind = inst.fmt === 'GRAY' ? (sc.grayPack === 'g565' ? 'u16g' : 'u8') : 'u16'
  const name = sanitizeName(inst.name)
  if (wantArray(name, arraySignature(inst))) {
    parts.push(`/* ${asset.name} 全部 ${glyphs.length} 帧 → ${inst.fmt} */`)
    parts.push(buildFontTableText(name, glyphs, kind, {
      upperHex: state.exportOpts.upperHex, perLine: state.exportOpts.perLine || undefined,
    }))
  }
  if (inst.x >= sc.w || inst.y >= sc.h || inst.x + inst.w <= 0 || inst.y + inst.h <= 0) {
    parts.push(`/* ${name}: 完全在屏幕外, 已跳过 */`)
    return parts
  }
  const ctx = templateContext(inst, sc, i, kind, frameIdx(inst))
  parts.push(renderTemplate(sc.templates[inst.fmt] || '', ctx))
  return parts
}

/* 生成 ring_config.h: 把编辑器里的圆环落成固件宏 (字段一一对应 bsp_ring.h / Ring_SetXxx)
 * 注意: ring_tables.h 不由网页导出 —— 它必须与 bsp_ring.h 的 5 个参数严格一致,
 * 由固件侧 tools/ring_sim/gen_tables.py 生成 (Keil Before Build 已挂)。
 * ring_seg_spans.h (逐段跨度表) 由 ringspans.js 生成, 用同一套参数; exportLayer
 * 会把这里生成的文本交给它核对 9 个几何指纹, 对不上就整张跳过。 */
export function buildRingConfig() {
  const sc = screen.value
  const inst = state.instances.find(i => i.kind === 'ring')
  if (!inst || !inst.ring) return '/* 没有圆环部件: 先在左侧添加一个 "圆环" 实例 */\n'
  const r = inst.ring
  /* 圆心按"像素中心"取整: 240 屏的 0..239 像素中心在 119.5 → 取 119 (与固件同约定,
   * 靠外径 +1 补掉半个像素; 取 120 也合法, 但交接时两边必须一致) */
  const cx = Math.floor(inst.x + (inst.w - 1) / 2), cy = Math.floor(inst.y + (inst.h - 1) / 2)
  const isRect = r.shape === 'rect'
  /* 圆角矩形: 板子侧 (RING_SHAPE=1) 与网页「与 MCU 同步预览」共用同一套 Q8 整数几何,
   * 这里就导出 ringRectGeomQ8() 的结果 —— 网页那边也用它, 两边不可能算出不同的几何。
   * 圆环那支照旧导出 R_IN/R_OUT (矩形时它们只用于"表容量": R_OUT 决定倒数表条目数)。 */
  const rectG = isRect ? ringRectGeomQ8(inst.w, inst.h, r) : null
  /* 圆环: 半径也要扣「留边」(总, px) —— 与预览同一条式子 (整条带内收 inset/2, 厚度不变),
   * 不然预览留了边、板子还是贴着屏幕边。矩形那边留边在 ringRectGeomQ8 里已经扣过。 */
  const insetPx = ringInsetPx(r)
  const cRout = Math.max(1, Math.round(r.rOut - insetPx / 2))
  const cRin = Math.max(0, Math.min(Math.round(r.rIn - insetPx / 2), cRout - 1))
  const effRout = isRect ? ringRectTableR(rectG) : cRout
  const effRin = isRect ? 0 : cRin
  const px = (v) => Math.round(v / 256)     /* Q8 → px (导出注释里给个可读的设计值) */
  const sig = Math.max(1, r.glintSigma || 14)
  const span = Math.round(r.glintSpanDeg != null ? r.glintSpanDeg : sig * 3)
  const startDeg = ((Math.round(r.startDeg ?? -90) % 360) + 360) % 360
  /* 弧范围 (0.5° 单位): rangeU=720 整圈; 部分弧 = 从起始角按弧向走到结束角。
   * 结束角直接取 ringArcRange() 的结果 (不能只用 start+span: 弧向 -1 时终点在另一侧)。
   * 固件圆形路径当前仍按整圈, 这些宏先按设计值导出, 便于下一版接入。 */
  const arcRange = ringArcRange(r)
  const arcEndDeg = ((Math.round(arcRange.endDeg) % 360) + 360) % 360
  const arcSpanU = arcRange.rangeU
  const arcEndU = (((Math.round(arcRange.endDeg) % 360) + 360) % 360) * 2
  const arcEffect = r.effect === 'countdown' ? 1 : 0
  const arcTailMs = arcEffect ? Math.max(0, Math.round(r.tailMs ?? 200)) : 0   // 静态效果没有时间拖尾
  /* 分割 (角向遮罩): 与 ringSegGeom() 同一套夹取 —— 预览与导出不可能算出不同参数.
   * 部分弧: N 段 + N-1 条内部缝, P=(span+gap)/N, body=P-gap; 最后一段与其余等长。 */
  const segG = ringSegGeom({ ...r, segOn: true })
  const segN = segG ? segG.N : Math.max(2, Math.min(180, Math.round(r.segCount ?? 90)))
  const segP = segG ? segG.P : 0
  const segGap = segG ? segG.gap : 0
  const segBody = segG ? segG.body : 0
  const segOpen = !!(segG && segG.open)
  /* 当前静态进度值对应的亮段数: round(VALUE × N / STEPS), clamp 0..N。
   * 仅供静态设计/进页初始值; 倒计时运行时应按实时 value 重新算。 */
  const segSteps = Math.max(1, Math.round(Number(r.steps ?? 40) || 40))
  const segValue = Math.max(0, Number(r.value ?? 0) || 0)
  const segLit = Math.max(0, Math.min(segN, Math.round(segValue * segN / segSteps)))
  const segPhase = Number(r.segPhaseDeg ?? 0) || 0
  /* 分割只有「暗槽」一种形态 (模式选项已取消): 固定 MODE=1;
   * 旧工程 segMode:'cut' 按 100% 槽深导出 (= 压到黑, 黑底上等价于切断)。 */
  const segMode = 1
  /* 档位分割线在槽里的位置: 0=段末, 5=槽中, 10=下一段起点; 与固件同一口径 */
  const segSplit = Math.max(0, Math.min(10, Math.round(Number(r.segSplit ?? 5) || 0)))
  /* 角向 AA = 总过渡宽度 (px), 与固件 Ring_SetSegAA()/RING_SEG_AA_X10 同口径; 0 = 硬边 */
  const segAA = Math.max(0, Math.min(4, Number(r.segAA ?? 2) || 0))
  /* 弧两端平口的角向 AA: 一个值管两端 (px), 缺省 2px; 0 = 端点硬边。
   * 兼容上一版的 aaStart/aaEnd: 有哪个用哪个, 都当同一个端点 AA。 */
  const endAAOf = (v) => {
    if (v === null || v === undefined || v === '') return 2
    const x = Number(v)
    return Number.isFinite(x) ? Math.max(0, Math.min(6, x)) : 2
  }
  const aaEdge = endAAOf(r.aaEdge ?? r.aaStart ?? r.aaEnd)
  const segDepth = r.segMode === 'cut' ? 100 : Math.max(0, Math.min(100, Math.round(r.segDepth ?? 60)))
  /* 颜色: 网页渐变只导出 0% 停靠点 (固件只有平色)。没有渐变或数据无效时用原单色。 */
  const trackFlat = ringGradStops(r.trackGrad)?.[0]?.c ?? ((r.trackColor ?? 0x6B4D) & 0xFFFF)
  const fillFlat = ringGradStops(r.fillGrad)?.[0]?.c ?? ((r.fillColor ?? 0x07FF) & 0xFFFF)
  const hx = (v) => '0x' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')
  const p = (v, n) => String(v).padEnd(n)
  return `${isRect ? `/*
 * 圆角矩形环 (RING_SHAPE=1): 板子按下面这套 Q8 整数几何逐行画 —— 与网页「与 MCU 同步预览」
 * 同一套代码 (ringrender.js 的 *Q8 系列), 所以预览即板子。几何由设计参数 (尺寸/厚度/
 * 外圆角/内圆角/留边) 经 ringRectGeomQ8() 派生, 不再手改。
 */
` : `/*
 * 圆环 (RING_SHAPE=0): 几何 = 圆心 + 内外半径。圆角矩形请在上面把「形状」改成圆角矩形。
 */
`}/*
 * ring_config.h —— 圆环设计参数总闸 (几何 + 白斑 + 进度弧 + 帧间隔)
 *
 * 【本文件由网页 MCU-LCD-Editer 导出 (圆环部件 ${inst.name})】
 *   直接覆盖固件里的 code/spi/ring_config.h, 然后编译 —— 不用手抄任何一行。
 *
 * 编译链: bsp_ring.h include 本文件 → gen_tables.py 读本文件算 ring_tables.h
 *   (Keil 的 Before Build 自动跑, 参数没变就跳过) → bsp_ring.c 用编译期 #error
 *   校验表与参数一致, 对不上直接编译报错, 不会画出错色的环。
 *
 * 布局 (圆心/半径/圆角/厚度/留边) **全部在网页里算好**: 导出的已经是最终几何, 板子上
 * 不做任何布局计算, 也不存在"二次扣留边"。要改设计参数请回网页改, 再重新导出。
 *
 * 改哪个会影响什么:
 *   RING_SHAPE / RING_R_IN / RING_R_OUT / RING_SPAN_DEG / RING_SIGMA_X10 / RING_COV_AA_X10
 *        → 表要重算 (脚本自动做, 改完直接编译即可)
 *   RING_CX / RING_CY / RING_ARC_* / RING_TICK_MS / RING_GLINT_DEF
 *        → 只影响运行时, 不用重算表
 *
 * 只在网页预览、**不导出**的字段 (板子上没有对应的东西):
 *   自动动画 autoArc (进度 0→档位 扫)、光斑动画 autoGlint (白斑沿路径转)、动画弧长 glintArcPx、
 *   白斑初始相位 (固件复位时白斑固定在 0°)、立体感 (圆角矩形导出 0 = 平色)、
 *   颜色渐变 (网页沿弧长多停靠点; 导出只取 0% 点, 固件仍是单色)。
 * 拖尾长度 tailU 也只在网页由 effect/tailMs 算; 导出的 RING_ARC_TAIL_MS_DEF 是设计记录,
 *   固件倒计时仍按 app_ring_ui.c 的 RINGUI_TAIL_MS 自行算长度。
 * 已导出的配置值: 档位 gear / 白斑转向 dir / 帧间隔 glintMs / 颜色 / 当前值与档位数 /
 *   圆头 / 起始角 / 结束角 / 范围跨度 / 倒计时效果 / 拖尾时长 / 白斑开关 / 形状与几何 /
 *   分割 (开关/段数/缝宽/相位/模式)
 *   —— 网页那两个动画开关开或关, 本文件逐字节不变。
 */
#ifndef __RING_CONFIG_H__
#define __RING_CONFIG_H__

/* ===== 形状: 0 = 圆环 (R_IN/R_OUT) / 1 = 圆角矩形环 (RING_HX..RING_INVPER) ===== */
#ifndef RING_SHAPE
#define RING_SHAPE         ${isRect ? 1 : 0}
#endif

/* ===== 圆心 (px): 图层中心, 与网页「与 MCU 同步预览」同一个取整规则 ===== */
#define RING_CX            ${p(cx, 3)}
#define RING_CY            ${p(cy, 3)}
${isRect ? `
/* ===== 写屏边界 (px) =====
 * 圆心 RING_CX/CY 是**屏幕坐标**, 所以逐行扫描的边界必须用屏幕尺寸 ——
 * 以前按图层尺寸 (RING_RECT_W/H) 裁: 图层比屏小或不在原点时, 下半部分会被整片裁掉
 * (用户现场: "导出到 mcu 只显示上半部分, 下半部分不显示弧形也不显示光斑")。 */
#define RING_SCR_W         ${p(Math.max(2, Math.round(sc.w || 240)), 3)}
#define RING_SCR_H         ${p(Math.max(2, Math.round(sc.h || 240)), 3)}

/* ===== 圆角矩形环: 图层外框 (px) = 设计尺寸 + 它在屏幕上的位置 (仅供回看/自检用) ===== */
#define RING_RECT_W        ${p(Math.max(2, Math.round(inst.w)), 3)}
#define RING_RECT_H        ${p(Math.max(2, Math.round(inst.h)), 3)}
#define RING_RECT_X0       ${p(Math.round(inst.x || 0), 3)}
#define RING_RECT_Y0       ${p(Math.round(inst.y || 0), 3)}

/* ===== 网页属性页的设计参数: 仅供回看, **引擎不读、也不会二次扣减** =====
 *   外圆角 ${p(px(rectG.oRc), 3)} / 内圆角 ${p(px(rectG.iRc), 3)} / 环厚 ${p(px(rectG.ht * 2), 3)} / 留边 ${p(insetPx, 3)} (总, px)
 * 「留边」是网页上的布局参数 (环带外沿离图层外框的余量): 导出时已经算进下面的 Q8 几何
 * (外框 = 尺寸 − 留边), 板子上只按算好的几何画 —— 圆环那边同理 (RING_R_OUT/R_IN 已扣留边)。
 * 要改圆角/厚度/留边请在网页里改, 再重新导出本文件。 */

/* ===== 派生 Q8 几何 (网页 ringRectGeomQ8 的输出: 已经扣过留边; 板子只认这些) =====
 * 带 = 外框圆角矩形 − 内框圆角矩形 (内外圆角各自独立 → 角上带厚 ≠ 直边带厚)。 */
#define RING_HX            ${p(rectG.hx, 5)}   /* 中心线半宽 */
#define RING_HY            ${p(rectG.hy, 5)}
#define RING_RC            ${p(rectG.rc, 5)}   /* 中心线圆角 (周长参数/端帽用) */
#define RING_HT            ${p(rectG.ht, 5)}   /* 半环厚 */
#define RING_O_HX          ${p(rectG.oHx, 5)}   /* 外框半宽/半高/圆角 */
#define RING_O_HY          ${p(rectG.oHy, 5)}
#define RING_O_RC          ${p(rectG.oRc, 5)}
#define RING_I_HX          ${p(rectG.iHx, 5)}   /* 内框 */
#define RING_I_HY          ${p(rectG.iHy, 5)}
#define RING_I_RC          ${p(rectG.iRc, 5)}
#define RING_PER_Q8        ${p(rectG.per, 7)}   /* 中心线周长 (Q8) */
#define RING_INVPER        ${p(rectG.invPer, 5)}   /* round(720*65536/per): aU = (s*INVPER)>>16 */
` : ''}
/* ===== 半径 (px): 圆环用 (已扣「留边」); 圆角矩形时只用于"表容量" ===== */
#define RING_R_IN          ${p(effRin, 3)}
#define RING_R_OUT         ${p(Math.round(effRout), 3)}

/* ===== 白斑形状 (这三个 + R_IN/R_OUT 就是生成 ring_tables.h 的全部输入) ===== */
#define RING_SIGMA_X10     ${p(Math.round(sig * 10), 3)}
#define RING_COV_AA_X10    ${p(Math.round((r.aa || 2) * 10), 3)}
#define RING_SPAN_DEG      ${p(span, 3)}

/* ===== 白斑总开关 (编译期): 0 = 白斑整套不进编译, 板上只剩静态进度弧 =====
 * 实测 (armcc AC5 -O3, R_IN=95/R_OUT=120): 关掉省 ~2.2KB flash (Code 3512→1824,
 * RO 1078→531) + 1538B SRAM (ZI 1560→22, 就是 s_val 窗口缓冲 + 行段表)。
 * =1 时还能用 Ring_SetGlint(0/1) 运行期临时开关; =0 时 Ring_SetGlint/Ring_SetColor
 * 是空函数 (接口保留, ui_task.c 不用改)。
 * 包一层 #ifndef: 主机自检 tools/ring_sim (make check-glint) 用 -D 覆盖, 两种模式各编一遍。 */
#ifndef RING_GLINT_DEF
#define RING_GLINT_DEF     ${r.glintOn === false ? 0 : 1}
#endif

/* ===== 立体感 (断面方向光): 0 = 平色 (断面表与光照代码都不编) =====
 * 强度 0..100; 样式 0 = 凸起 / 1 = 凹陷; 光照 = 光源方位角 (屏幕坐标, -45 = 左上)
 * 表由 tools/ring_sim/gen_tables.py 按这三个值生成 (改了要重编一次; 表与配置不一致时
 * bsp_ring.c 的编译期 #error 会直接拦住)。
 * 圆环按半径预烘断面表; 圆角矩形按"离外边界的深度"预烘 —— 同一套断面光照公式。 */
#ifndef RING_DEPTH_DEF
#define RING_DEPTH_DEF        ${Math.max(0, Math.min(100, Math.round(r.depth || 0)))}
#endif
#ifndef RING_DEPTH_STYLE_DEF
#define RING_DEPTH_STYLE_DEF  ${r.depthStyle === 'groove' ? 1 : 0}
#endif
#ifndef RING_LIGHT_DEG_DEF
#define RING_LIGHT_DEG_DEF    ${Math.round(r.lightDeg ?? -45)}
#endif

/* ===== 进度弧默认值 (运行时可用 Ring_SetArc/SetProgress/SetStartDeg/SetCaps 改) =====
 * 颜色: 网页里配了渐变时这里只取 0% 停靠点 —— 固件仍是平色, 不会假装支持渐变。 */
#define RING_ARC_TRACK_DEF ${hx(trackFlat)}
#define RING_ARC_FILL_DEF  ${hx(fillFlat)}
#define RING_ARC_START_DEF ${p(startDeg * 2, 4)}
/* ===== 弧范围 / 效果 (0.5° 单位; 720 = 整圈) ===== 
 * 网页「起始角 → 结束角」的范围弧: SPAN = 这段弧的总跨度, END = 结束角。
 * 网页预览已按范围/拖尾绘制; 当前固件圆形路径 (bsp_ring.c) 与倒计时 (app_ring_ui.c)
 * 仍按整圈量程画, 读到 SPAN<720 时应自行把量程改成 SPAN 并把 sweep 映射到范围。
 * 接入前这些宏只是设计记录, 不影响整圈行为。 */
#define RING_ARC_END_DEF   ${p(arcEndU, 4)}   /* 结束角 (0.5°): ${arcEndDeg}° */
#define RING_ARC_SPAN_DEF  ${p(arcSpanU, 4)}   /* 范围跨度 (0.5°): ${arcSpanU === 720 ? '整圈' : (arcSpanU / 2) + '°'} */
/* 预览效果: 0 = 静态进度 / 1 = 倒计时 (value 随时间递减) */
#define RING_ARC_EFFECT_DEF ${arcEffect}
/* 递减边缘拖尾 (ms): 与固件 app_ring_ui.c 的 RINGUI_TAIL_MS 同口径, 0 = 硬边 */
#define RING_ARC_TAIL_MS_DEF ${p(arcTailMs, 4)}
#define RING_ARC_STEPS_DEF ${p(r.steps || 40, 4)}
#define RING_ARC_VALUE_DEF ${p(r.value || 0, 4)}
#define RING_ARC_CAPS_DEF  ${r.caps ? 1 : 0}
/* ===== 分割 (角向遮罩): 0 = 关 =====
 * 部分弧: N 段 + N-1 条内部缝, 总长 = N*body + (N-1)*gap, 所以
 *   P = (跨度 + gap)/N, body = P - gap —— 最后一段与其余段完全等长。
 * 整圈: P = 360/N, N 条缝。网页用百分比预览; **导出只写固定值**
 * (gap/body/pitch, 0.001°), 不让 MCU 再按百分比二次计算。
 * 相位相对弧起点 (0 = 弧起点正好是一段的开始)。板端在颜色/白斑/立体感之后,
 * 按 P 取模: 缝位置按 RING_SEG_DEPTH 把颜色压暗 (固定 MODE=1, 暗槽)。
 * 槽深 100% = 压到黑 = 原来的「切断」; 不再导出 MODE=0。
 * 缝边 AA 用**像素到缝边线的带符号距离**做斜坡 (不受 0.5° 角度表限制) —— 240×240 上
 * 1° 缝只有 ~2px, 0.5° 量化会直接变成硬边。斜坡跨边界对称展开 (向段内/缝内各 AA/2),
 * 边界处 0.5; RING_SEG_AA_X10 是段/缝边界的总过渡宽度 (0.1px), 0 = 硬边。
 * 弧两端平口另有 RING_AA_EDGE_X10 (一个值管两端, 0 = 硬边)。 */
#ifndef RING_SEG_ON
#define RING_SEG_ON        ${r.segOn ? 1 : 0}
#endif
#define RING_SEG_N         ${p(segN, 4)}
#define RING_SEG_LIT_DEF   ${p(segLit, 4)}   /* 当前静态亮段数 = round(VALUE*N/STEPS); 倒计时按实时值重算 */
#define RING_SEG_ARC_REL   ${segOpen ? 1 : 0}   /* 1 = 部分弧: P=(跨度+gap)/N, N段只有N-1缝; 0 = 整圈: P=360/N */
#define RING_SEG_GAP_X10   ${p(Math.round(segGap * 10), 4)}   /* 0.1° (兼容旧固件; 小缝会取整到 0) */
#define RING_SEG_GAP_X10000 ${p(Math.round(segGap * 10000), 6)} /* 0.0001°: 固定缝宽 (网页百分比已换算好) */
#define RING_SEG_BODY_X10000 ${p(Math.round(segBody * 10000), 6)} /* 0.0001°: 每段固定长度 */
#define RING_SEG_PITCH_X10000 ${p(Math.round(segP * 10000), 6)} /* 0.0001°: 段起点间距 (body+gap) */
#define RING_SEG_PHASE_X10 ${p(Math.round(segPhase * 10), 5)} /* 0.1°: 相对弧起点 */
#define RING_SEG_SPLIT_X10 ${p(segSplit, 3)} /* 0..10: 档位分割线在槽里的位置 (0=段末 / 5=槽中 / 10=下段起点) */
#define RING_SEG_MODE      ${segMode}   /* 固定 1 = 暗槽 (槽深 100% 等价于原来的切断) */
#define RING_SEG_AA_X10    ${p(Math.round(segAA * 10), 4)}   /* 段/缝边界 AA 总宽 (0.1px): 运行期 Ring_SetSegAA() 可改, 0 = 硬边 */
#define RING_AA_EDGE_X10   ${p(Math.round(aaEdge * 10), 4)}   /* 弧两端平口 AA 总宽 (0.1px, 两端同一个值): 运行期 Ring_SetEdgeAA() 可改, 0 = 硬边 */
#define RING_SEG_DEPTH     ${p(segDepth, 3)}   /* 暗槽压暗量 0..100 (%): 100 = 压到黑 (= 切断) */
/* 进度弧方向 (「弧向」): 同样包 #ifndef, 主机自检用 -DRING_ARC_DIR_DEF=±1 编两份 */
#ifndef RING_ARC_DIR_DEF
#define RING_ARC_DIR_DEF   ${(r.arcDir ?? 1) < 0 ? -1 : 1}   /* +1 顺时针 / -1 逆时针 */
#endif

/* ===== 帧间隔 (ms): 角速度 = 初始化档位 x 0.5 度 x 1000 / RING_TICK_MS =====
 * 下限是一帧的渲染耗时(档1约8.5ms、档40约16ms), 低于它中断来不及、加速无效;
 * 100ms 偏慢(10fps 会看出跳格), 想要顺滑取 30~40ms。 */
#define RING_TICK_MS       ${Math.max(1, Math.round(r.glintMs || 100))}

/* ===== 白斑进页参数 (ui_task.c 的 LCD_Page<n>_Enter 里: Ring_Start(RING_GEAR_DEF, RING_DIR_DEF)) =====
 * 初始化档位: 每帧走 档位 × 0.5° (1..40), 每次进这一页都按它重置 —— 与进度弧的当前值无关;
 * 白斑转向: +1 = 角度增大方向 (屏幕上顺时针), -1 = 反过来; 运行时也能用 Ring_SetDir() 按电机方向改。 */
#define RING_GEAR_DEF      ${p(Math.max(1, Math.min(40, Math.round(r.gear || 2))), 3)}
#define RING_DIR_DEF       ${r.dir < 0 ? -1 : 1}

#endif /* __RING_CONFIG_H__ */
`
}

function ringExportComment(inst) {
  const r = inst.ring
  const eff = r.effect === 'countdown' ? `倒计时 ${Math.round((r.countMs ?? 10000) / 100) / 10}s / 拖尾 ${Math.max(0, Math.round(r.tailMs ?? 200))}ms` : '静态进度'
  const grad = (Array.isArray(r.trackGrad) && r.trackGrad.length) || (Array.isArray(r.fillGrad) && r.fillGrad.length)
  return `/* ${sanitizeName(inst.name)}: 圆环部件 r${r.rIn}~${r.rOut} · ${r.value}/${r.steps} 档 · ${eff} — 起止角/范围见 RING_ARC_END_DEF / SPAN_DEF${grad ? ' · 颜色渐变仅网页, 导出去 0% 首点' : ''} */`
}

export function buildExport() {
  const sc = screen.value
  const parts = []
  if (sc.header) parts.push(sc.header)
  const emittedArrays = new Map()   // name -> sig: 同名同数据只输出一张数组
  const wantArray = (name, sig) => {
    if (!state.exportOpts.includeArrays) return false
    const prev = emittedArrays.get(name)
    if (prev === sig) return false            // 已输出过相同数组
    emittedArrays.set(name, sig)
    return true
  }
  for (let i = 0; i < state.instances.length; i++) {
    const inst = state.instances[i]
    /* 系统字 ASCII 字库层: 先出字库 (表 + 两个函数), 再按普通图层出这一层显示的示例图 */
    if (inst.ascii && !inst.bind) parts.push(...asciiExportParts(inst, wantArray))
    if (inst.kind === 'text') {
      parts.push(...textExportParts(inst, i, wantArray))
      continue
    }
    if (inst.kind === 'ring') {
      parts.push(ringExportComment(inst))
      continue
    }
    if (inst.frame != null && inst.frame >= 0) {
      parts.push(...frameExportParts(inst, i, wantArray))
      continue
    }
    // 数组按屏幕交集裁剪; 指令几何同步为可见区域 (否则绘制错位)
    const vis = visibleRect(inst, sc)
    const crop = cropRect(inst, sc)
    if (vis.w <= 0 || vis.h <= 0) {
      parts.push(`/* ${sanitizeName(inst.name)}: 完全在屏幕外, 已跳过 */`)
      continue
    }
    const eff = { ...inst, x: vis.x, y: vis.y, w: vis.w, h: vis.h }
    const kind = inst.fmt === 'GRAY' ? (sc.grayPack === 'g565' ? 'u16g' : 'u8') : inst.fmt === 'RGB888' ? (sc.rgb888AsMacro ? 'macro888' : 'u32') : 'u16'
    const ctx = templateContext(eff, sc, i, kind)
    if (state.exportOpts.includeArrays) {
      const proc = instanceProc(inst)
      if (proc && wantArray(ctx.name, arraySignature(inst))) {
        const asset = state.assets.find(a => a.id === inst.assetId)
        parts.push(`/* ${asset ? asset.name : ''} → ${inst.fmt} */`)
        parts.push(arrayTextCached(inst, proc, ctx.name, crop))
      }
    }
    parts.push(renderTemplate(sc.templates[inst.fmt] || '', ctx))
  }
  if (sc.footer) parts.push(sc.footer)
  return parts.join('\n')
}

export function instanceCode(inst) {
  const sc = screen.value
  const always = () => true   // 单实例复制: 始终带数组
  if (inst.kind === 'ring') {
    return ringExportComment(inst)   // 圆环无数组数据, 与整体导出保持一致
  }
  /* 系统字 ASCII 字库层: 字库那一段在前, 后面照常给这一层显示的示例图 */
  const pre = (inst.ascii && !inst.bind) ? asciiExportParts(inst, always).join('\n\n') + '\n\n' : ''
  if (inst.kind === 'text') {
    return pre + textExportParts(inst, state.instances.indexOf(inst), always).join('\n')
  }
  if (inst.frame != null && inst.frame >= 0) {
    return pre + frameExportParts(inst, state.instances.indexOf(inst), always).join('\n')
  }
  const vis = visibleRect(inst, sc)
  const crop = cropRect(inst, sc)
  if (vis.w <= 0 || vis.h <= 0) return pre + `/* ${sanitizeName(inst.name)}: 完全在屏幕外 */`
  const eff = { ...inst, x: vis.x, y: vis.y, w: vis.w, h: vis.h }
  const proc = instanceProc(inst)
  const kind = proc ? proc.kind : 'u16'
  const i = state.instances.indexOf(inst)
  const ctx = templateContext(eff, sc, Math.max(0, i), kind)
  let code = renderTemplate(sc.templates[inst.fmt] || '', ctx)
  if (proc) code += '\n\n' + arrayTextCached(inst, proc, ctx.name, crop)
  return pre + code
}

/* ---------- 预设 ---------- */
export function selectPreset(id) {
  state.activePresetId = id
  state.ui.selectedId = null
}

export function duplicatePreset(id) {
  const p = state.presets.find(p => p.id === id)
  if (!p) return
  const copy = JSON.parse(JSON.stringify(p))
  copy.id = uid('preset'); copy.name = p.name + '副本'
  /* 复制两次不要出现两个同名预设 (下拉里认不出来) */
  const used = new Set(state.presets.map(x => x.name))
  if (used.has(copy.name)) {
    let i = 2
    while (used.has(p.name + '副本-' + i)) i++
    copy.name = p.name + '副本-' + i
  }
  state.presets.push(copy)
  state.activePresetId = copy.id
}

export function removePreset(id) {
  if (state.presets.length <= 1) return
  state.presets = state.presets.filter(p => p.id !== id)
  if (state.activePresetId === id) state.activePresetId = state.presets[0].id
}

/* ---------- 屏幕预设的存储模型 ----------
 *  **固定 (内置) 预设来自代码** (defaultPresets(), 稳定 id `preset_bi_*`): 不进 localStorage,
 *  每次加载都在, 也能被工程文件/存档引用。localStorage 只存三样"用户数据":
 *    · custom    用户自己新增/复制的预设 (id 是 uid('preset'))
 *    · overrides 用户改过的内置项 (整份按 id 存, 只存改过的)
 *    · hidden    用户删掉的内置项 id (内置项不能被真删, 只能藏起来)
 *  这样: 内置分辨率升级/新增, 所有人刷新就有; 用户的东西也不会被冲掉。 */
const isBuiltinPreset = (p) => !!(p && (p.builtin || String(p.id || '').startsWith('preset_bi_')))
const samePreset = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** state.presets → 要落盘的那三样 (内置项按需只存"改动") */
export function splitPresets(list) {
  const all = Array.isArray(list) ? list : []
  const bi = new Map(defaultPresets().map(p => [p.id, p]))
  const custom = [], overrides = [], seen = new Set()
  for (const p of all) {
    if (!p || !p.id) continue
    seen.add(p.id)
    if (bi.has(p.id)) {
      const base = bi.get(p.id)
      const strip = (o) => { const c = { ...o }; delete c.templates; return c }
      const changed = JSON.stringify(strip(p)) !== JSON.stringify(strip(base))
      if (changed) overrides.push(p)
    } else {
      custom.push(p)
    }
  }
  const hidden = [...bi.keys()].filter(id => !seen.has(id))
  return { custom, overrides, hidden }
}

/** 落盘的三样 + 工程文件里的 presets → state.presets (固定项永远以代码为准) */
export function mergePresets(saved) {
  const list = Array.isArray(saved) ? saved.slice() : (saved && Array.isArray(saved.presets) ? saved.presets.slice() : [])
  const overrides = new Map()
  for (const o of (saved && Array.isArray(saved.overrides) ? saved.overrides : [])) if (o && o.id) overrides.set(o.id, o)
  const hidden = new Set(saved && Array.isArray(saved.hidden) ? saved.hidden : [])
  const custom = (saved && Array.isArray(saved.custom)) ? saved.custom.slice()
               : list.filter(p => p && !isBuiltinPreset(p))
  /* 老格式 (整份数组, 内置项也混在里面): 按 id 认出来当覆盖, 认不出的当自定义 */
  if (!saved || !Array.isArray(saved.custom)) {
    const biIds = new Set(defaultPresets().map(p => p.id))
    for (const p of list) {
      if (!p || !p.id) continue
      if (biIds.has(p.id)) { if (!overrides.has(p.id)) { const c = { ...p }; delete c.templates; overrides.set(p.id, p) } }
      else if (!custom.some(q => q.id === p.id)) custom.push(p)
    }
  }
  const out = []
  for (const base of defaultPresets()) {
    if (hidden.has(base.id)) continue
    const ov = overrides.get(base.id)
    out.push(ov ? { ...base, ...ov, id: base.id, builtin: true } : { ...base })
  }
  out.push(...custom.filter(p => p && !isBuiltinPreset(p)))
  return out.length ? out : defaultPresets()
}

export function resetPresets() {
  /* 内置项恢复默认 (丢掉对它们的改动/隐藏), **自定义预设保留** —— 自定义在 localStorage 里是
   * 独立的一份, 不该被"重置内置"牵连。 */
  const custom = (state.presets || []).filter(p => !isBuiltinPreset(p))
  state.presets = [...defaultPresets(), ...custom]
  state.activePresetId = state.presets[0].id
}

/** 「补内置」: 把缺的内置项加回来 (自己加的预设与对内置项的改动都不动)。
 *  内置项现在的存储模型是"代码为准 + hidden 列表", 所以这里 = 取消隐藏。 */
export function restoreBuiltinPresets() {
  const custom = (state.presets || []).filter(p => !isBuiltinPreset(p))
  const kept = (state.presets || []).filter(isBuiltinPreset)
  const merged = mergePresets({ custom, overrides: kept, hidden: [] })
  const before = kept.length
  state.presets = merged
  if (!state.presets.some(p => p.id === state.activePresetId)) state.activePresetId = state.presets[0].id
  return Math.max(0, state.presets.filter(isBuiltinPreset).length - before)
}

/* ---------- 撤回 / 重做 (会话级; 只快照可持久化状态, 不含素材大图) ---------- */
const UNDO_MAX = 30
let undoStack = []
let redoStack = []
let undoLast = null      // 最近一次已提交的状态快照
let undoPending = null   // 防抖窗口内待提交的快照
let undoTimer = null

function undoSnapshot() {
  return JSON.stringify({
    instances: state.instances, frameGroups: frameGroupsForSig(state.frameGroups),
    presets: splitPresets(state.presets),   /* 只带自定义/改动 */
    activePresetId: state.activePresetId, exportOpts: state.exportOpts,
    exportDir: normalizeExportDir(state.exportDir),
  })
}
function syncUndoFlags() {
  state.ui.canUndo = undoStack.length > 0
  state.ui.canRedo = redoStack.length > 0
}
/* 把防抖窗口里的编辑落成一步 (连续拖动/输入只记一步) */
function commitUndoStep() {
  clearTimeout(undoTimer)
  if (undoPending === null || undoPending === undoLast) { undoPending = null; return }
  undoStack.push(undoLast)
  if (undoStack.length > UNDO_MAX) undoStack.shift()
  redoStack = []
  undoLast = undoPending
  undoPending = null
  syncUndoFlags()
}
/** 老工程补齐分片设置; 明确关掉分片的尊重 false (字模左右条不靠这个开关)。 */
function normalizeExportOpts(opts) {
  if (!opts || typeof opts !== 'object') return opts
  if (opts.lzssChunked === undefined) opts.lzssChunked = true
  if (!(+opts.lzssChunkBytes > 0)) opts.lzssChunkBytes = 2400
  return opts
}

/** 旧工程只有 inst.ext 布尔; 新工程用 inst.store ('int'|'ext'|'lzss')。
 *  载入/撤回时统一补齐, 保证导出与图层按钮拿到同一口径。 */
export function normalizeInstanceStores() {
  for (const inst of state.instances || []) {
    if (!inst || inst.kind === 'ring') continue
    if (inst.store === 'lzss') { inst.ext = false; continue }
    const st = inst.ext ? 'ext' : (inst.store === 'ext' ? 'ext' : 'int')
    inst.store = st
    inst.ext = st === 'ext'
  }
}

function applyUndoSnapshot(json) {
  const d = JSON.parse(json)
  undoLast = json            // 先记录, 避免 watcher 把这次恢复当成新编辑
  undoPending = null
  // 素材不进撤回栈 (删除素材走二次确认且不可逆): 引用了已删素材的图层不再恢复, 避免幽灵图层
  const alive = new Set(state.assets.map(a => a.id))
  const all = d.instances || []
  const kept = all.filter(i => !i.assetId || alive.has(i.assetId))
  if (kept.length !== all.length) console.warn('[lcd-layout] 撤回: 跳过引用了已删除素材的图层')
  state.instances = kept
  normalizeInstanceStores()
  /* 组跟着图层一起恢复; 变体都被删掉的空组不留 */
  state.frameGroups = (d.frameGroups || []).filter(g => g && g.id &&
    kept.some(i => i.groupId === g.id)).map(g => ({ ...g, current: g.current | 0, fps: g.fps || 4, loop: g.loop !== false }))
  if (d.presets) state.presets = mergePresets(d.presets)   /* 固定项来自代码 */
  ensureBuiltinPresets()          /* 存档里的 presets 会整份替换列表 → 新内置尺寸补回来 */
  state.activePresetId = d.activePresetId || state.presets[0]?.id || null
  state.exportDir = normalizeExportDir(d.exportDir)
  if (d.exportOpts) Object.assign(state.exportOpts, normalizeExportOpts(d.exportOpts))
  state.ui.selectedId = null
  procCache.clear(); codeCache.clear(); pixelCache.clear()
}
export function undo() {
  commitUndoStep()           // 未提交的编辑先落一步, 再撤回
  if (!undoStack.length) return false
  const prev = undoStack.pop()
  redoStack.push(undoLast)
  applyUndoSnapshot(prev)
  syncUndoFlags()
  return true
}
export function redo() {
  commitUndoStep()           // 有未提交的新编辑 → redo 栈被清空, 自然失效
  if (!redoStack.length) return false
  const next = redoStack.pop()
  undoStack.push(undoLast)
  applyUndoSnapshot(next)
  syncUndoFlags()
  return true
}
function initUndo() {
  undoLast = undoSnapshot()
  watch(() => undoSnapshot(), (now) => {
    if (now === undoLast) return
    undoPending = now
    clearTimeout(undoTimer)
    undoTimer = setTimeout(commitUndoStep, 400)
  })
  syncUndoFlags()
}

/* ---------- 持久化 (拆分: assets 大块单独存, 布局轻量高频存) ---------- */
const KEY_LAYOUT = STORAGE_KEY                  // 实例/预设/选项 (KB 级)
const KEY_ASSETS = 'lcd-layout-studio-assets-v1' // 图片 dataURL (MB 级, 仅增删时写)
let saveTimer = null
let assetTimer = null

/** 立即把工程/素材写进 localStorage (页面关闭/画板自动保存用; 不走 400/800ms 防抖) */
export function flushLocalPersistence() {
  try {
    localStorage.setItem(KEY_ASSETS, JSON.stringify(state.assets))
  } catch (e) { /* 配额 */ }
  try {
    localStorage.setItem(KEY_LAYOUT, JSON.stringify({
      instances: state.instances, frameGroups: state.frameGroups || [],
      presets: splitPresets(state.presets),
      activePresetId: state.activePresetId, exportOpts: state.exportOpts,
      exportDir: normalizeExportDir(state.exportDir),
      pages: state.pages,
    }))
  } catch (e) { /* 配额 */ }
}

export function initPersistence() {
  initCustomFonts()   // 本地字体文件恢复 (异步)
  cloudProbe()        // 在线存档可用性探测 (异步)
  void cloudOpenFromUrl()   // /lcd/<档名> 直链 → 自动载入那份存档 (没有档名时什么都不做)
  initRingAnimator()  // 圆环白斑自动旋转 (100ms/步)
  try {
    const rawAssets = localStorage.getItem(KEY_ASSETS)
    const raw = localStorage.getItem(KEY_LAYOUT)
    // 兼容旧版单 key 存储
    const dOld = raw ? JSON.parse(raw) : null
    if (rawAssets) {
      const a = JSON.parse(rawAssets)
      if (Array.isArray(a)) state.assets = a
      else if (dOld?.assets) state.assets = dOld.assets
    } else if (dOld?.assets) state.assets = dOld.assets
    if (dOld) {
      if (dOld.instances) state.instances = dOld.instances
      if (Array.isArray(dOld.frameGroups)) state.frameGroups = dOld.frameGroups
      if (dOld.presets) state.presets = mergePresets(dOld.presets)   /* 固定项来自代码, 这里只并自定义/改动 */
      if (dOld.exportOpts) Object.assign(state.exportOpts, normalizeExportOpts(dOld.exportOpts))
      if (dOld.exportDir) state.exportDir = normalizeExportDir(dOld.exportDir)
      if (dOld.pages) state.pages = dOld.pages     // 每页: 刷新周期 + 定时跳转
      state.activePresetId = dOld.activePresetId || state.presets[0].id
    }
    // 旧圆环数据迁移: centered(圆心坐标) → 左上角坐标
    for (const inst of state.instances) {
      if (inst.kind === 'ring' && inst.ring?.centered) {
        inst.x -= inst.w / 2
        inst.y -= inst.h / 2
        delete inst.ring.centered
      }
    }
  } catch (e) { console.warn('恢复失败', e) }
  normalizeInstanceStores()

  ensureBuiltinPresets()

  /* ---- 总素材库 (跨工程): 恢复 + 自动汇总当前工程; 素材一变就并进去 ---- */
  loadGlobalAssets()
  watch(() => assetLibrary.rev, scheduleSaveGlobalAssets)
  mergeGlobalAssets(state.assets, cloud.current || '当前工程')
  /* 素材编辑 (拆帧/换色…) 可能连续变几次: 300ms 防抖, 只把稳定后的版本收进总库 */
  let libMergeTimer = 0
  watch(() => state.assets.map(a => a.id + ':' + a.name + ':' + a.w + 'x' + a.h + ':' +
    (a.src ? a.src.length : 0) + ':' + JSON.stringify(a.font || null)).join('|'),
    () => {
      clearTimeout(libMergeTimer)
      libMergeTimer = setTimeout(() => mergeGlobalAssets(state.assets, cloud.current || '当前工程'), 300)
    })
  /* 档名变化 (另存/载入) 也更新来源标签 */
  watch(() => cloud.current, () => mergeGlobalAssets(state.assets, cloud.current || '当前工程'))

  /* 固定文字/系统字图层 → 当前工程素材 (随文字/字号/颜色变化, 300ms 防抖).
   * _imgTick: 素材图/字体刚解码完时再兜一次 —— 首次载入字库还没 Image 时生成不了. */
  watch(() => [
    (state.instances || []).map(textMaterialSignature).join('||'),
    state._imgTick,
  ], () => scheduleTextMaterialSync(300), { immediate: true })

  /* ---- 未保存判定 (菜单里的「未保存」标记 + 切换前暂存) ----
   * 深监听 + 250ms 防抖: 拖动时只重新算一次指纹, 不每帧 JSON.stringify. */
  let dirtyTimer = 0
  watch(() => [state.instances, state.pages, state.presets, state.assets, state.exportOpts, state.exportDir, state.activePresetId], () => {
    clearTimeout(dirtyTimer)
    dirtyTimer = setTimeout(() => { cloud.dirty = projectDirtyNow() }, 250)
  }, { deep: true, immediate: true })

  // 预热图片解码缓存
  watch(() => state.assets.map(a => a.id).join(','), () => {
    state.assets.forEach(a => {
      getAssetImage(a)
      // SVG 素材: 重新缓存 SVG Image (用于矢量重新光栅化)
      if (a.svg && a.svgText && !svgImageCache.has(a.id)) {
        const i = new Image()
        i.onload = () => { state._imgTick++ }   // 矢量图就绪 → 触发重绘 (避免停留在位图回退帧)
        i.src = URL.createObjectURL(new Blob([a.svgText], { type: 'image/svg+xml' }))
        svgImageCache.set(a.id, i)
      }
    })
  }, { immediate: true })

  // assets: 只在素材列表/内容/字库配置变化时序列化 (大字符串, 低频)
  watch(() => state.assets.map(a => a.id + ':' + a.src.length + ':' +
    (a.font ? [a.font.glyphW, a.font.glyphH, a.font.charset, a.font.custom, a.font.start].join(',') : '')).join('|'), () => {
    clearTimeout(assetTimer)
    assetTimer = setTimeout(() => {
      try { localStorage.setItem(KEY_ASSETS, JSON.stringify(state.assets)) }
      catch (e) { console.warn('素材保存失败 (可能超出 localStorage 容量)', e) }
    }, 800)
  })

  // 布局/预设/选项: 轻量高频
  /* 只存"用户数据": 固定预设来自代码, 不写进 localStorage (splitPresets 只挑自定义/改动/隐藏) */
  watch(() => JSON.stringify({
    instances: state.instances, frameGroups: frameGroupsForSig(state.frameGroups),
    presets: splitPresets(state.presets),
    activePresetId: state.activePresetId, exportOpts: state.exportOpts,
    exportDir: normalizeExportDir(state.exportDir),
    pages: state.pages,
  }), () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KEY_LAYOUT, JSON.stringify({
          instances: state.instances, frameGroups: state.frameGroups || [],
          presets: splitPresets(state.presets),
          activePresetId: state.activePresetId, exportOpts: state.exportOpts,
          exportDir: normalizeExportDir(state.exportDir),
          pages: state.pages,
        }))
      } catch (e) { console.warn('保存失败', e) }
    }, 400)
  })

  initUndo()   // 撤回/重做 (与持久化共用同一份状态子集)
}

/* ---------- 在线存档 (可选: 同源 /api/lcd-projects/; 公开部署默认关闭) ----------
 *  · 接口是**相对路径** → 哪个入口打开就连哪个后端。
 *    没有这个接口 (它把 /api/* 转给了物料系统), 所以本地入口下 cloud.ok 会是 false,
 *    面板里显示一行"当前入口未启用在线存档"的提示, 不再默默隐藏整块。
 *  · 多端共享: 列表来自服务器目录 (nginx autoindex json), 带 size/mtime;
 *    窗口重新获得焦点时会自动刷新一次, 别的机器刚存的档能立刻看到。 */
const CLOUD_BASE = '/api/lcd-projects/'
const CLOUD_KEY = (typeof window !== 'undefined' && window.__LCD_CLOUD_KEY__) || ''
export const CLOUD_HOME = (typeof location !== 'undefined')
  ? location.origin + location.pathname.replace(/[^/]*$/, '')
  : ''
/* current = 最近读取/保存的档名 (不带 .json); currentScreen = 那一刻的页面尺寸.
 * 面板用它显示"当前存档", 并在尺寸改过之后提醒"保存会自动改名". 空 = 没碰过 / 已删. */
export const cloud = reactive({
  ok: false, probed: false, err: '', list: [], msg: '',
  current: '', currentScreen: null, currentAt: 0, currentKind: '',
  baseSig: '',      /* 最近保存/读取时的工程指纹 (dirty 判断用) */
  dirty: false,     /* 有未保存改动 (菜单里的「未保存」; 切换前会自动暂存) */
})

/** 当前屏幕的尺寸快照 (与存档 meta 同口径) */
function cloudScreenSnapshot() {
  const s = screen.value
  return { w: Math.round(+s.w || 0), h: Math.round(+s.h || 0), round: !!s.round }
}

export async function cloudProbe() {
  try {
    const r = await fetch(CLOUD_BASE)
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const j = await r.json()
    if (!Array.isArray(j)) throw new Error('返回的不是列表 (这个入口没有在线存档服务)')
    cloud.ok = true
    cloud.err = ''
    cloud.list = j.filter(f => String(f.name || '').endsWith('.json'))
  } catch (e) {
    cloud.ok = false                    /* 列表保留上次的, 只标记服务不可用 */
    cloud.err = e.message || String(e)
  } finally {
    cloud.probed = true
  }
}

export async function cloudSave(name, json) {
  const r = await fetch(CLOUD_BASE + encodeURIComponent(name) + '.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-LCD-Key': CLOUD_KEY },
    body: json,
  })
  if (!r.ok) throw new Error('保存失败 HTTP ' + r.status)
  await cloudProbe()
  /* 记住"当前存档": 面板据此把档名留在输入框里, 并显示尺寸漂移提醒 */
  cloud.current = name
  cloud.currentScreen = cloudScreenSnapshot()
  cloud.currentAt = Date.now()
  cloud.currentKind = 'save'
  /* 用实际写进服务器的 JSON 算指纹: 上传期间又改了两下也不会被误判成"已保存" */
  try { cloud.baseSig = projectSignatureOf(JSON.parse(json)) }
  catch (e) { cloud.baseSig = projectSignature() }
  cloud.dirty = projectDirtyNow()
}

export async function cloudLoad(name) {
  const r = await fetch(CLOUD_BASE + encodeURIComponent(name) + '.json')
  if (!r.ok) throw new Error('读取失败 HTTP ' + r.status)
  return await r.text()
}

/** 只读存档的页面尺寸 (保存前的"会不会覆盖不同尺寸工程"判断用; 不碰当前工程) */
export async function cloudArchiveMeta(name) {
  const json = await cloudLoad(name)
  return projectMeta(json)                  /* null = 文件里没有屏幕信息 */
}

/* ---------- 直链打开: /lcd/<档名> (带 .json 也行) → 自动探测 + 载入, 然后把地址还原成 /lcd/ ---------- */
export function archiveNameFromUrl(pathname) {
  const p = pathname != null ? String(pathname) : (typeof location !== 'undefined' ? location.pathname : '')
  const m = /^\/lcd\/([^/]+)\/?$/.exec(p || '')
  if (!m) return ''
  let n = m[1]
  try { n = decodeURIComponent(n) } catch (e) { /* 原样用 */ }
  if (n === 'index.html' || n === 'index.htm') return ''
  return n.replace(/\.json$/i, '').trim()
}

/** 载入指定存档 (手动「读取」和直链都用它) */
export async function cloudLoadByName(name) {
  if (!name) return false
  await cloudProbe()
  if (!cloud.ok) {
    cloud.msg = '当前入口未启用在线存档服务'
    return false
  }
  try {
    const json = await cloudLoad(name)
    importProject(json)
    /* 读取后把"当前存档"和档名交回给面板 (输入框自动填这个名字, 再点保存就是存回原档) */
    cloud.current = name
    cloud.currentScreen = cloudScreenSnapshot()
    cloud.currentAt = Date.now()
    cloud.currentKind = 'load'
    cloud.baseSig = projectSignature()
    cloud.dirty = false
    cloud.msg = '已从存档 ' + name + ' 载入'
    return true
  } catch (e) {
    const m = String(e && e.message || e)
    cloud.msg = /404/.test(m) ? ('存档 ' + name + ' 不存在') : ('载入存档 ' + name + ' 失败: ' + m)
    return false
  }
}

/** 启动时调用: URL 里带档名就自动载入; 不管成功失败都把地址还原成 /lcd/ (否则刷新会用存档覆盖刚编辑的内容) */
export async function cloudOpenFromUrl() {
  const name = archiveNameFromUrl()
  if (!name) return false
  const back = () => { try { history.replaceState(null, '', '/lcd/') } catch (e) { /* ignore */ } }
  /* 本机已经有工程 (localStorage 恢复出来的): 先问一句, 免得开个链接把手里在改的东西冲掉 */
  if (state.instances.length && typeof confirm === 'function' &&
      !confirm('打开存档「' + name + '」会替换当前工程 (可用 Ctrl+Z 撤回)。继续？')) {
    cloud.msg = '已取消载入存档 ' + name
    back()
    return false
  }
  const okLoad = await cloudLoadByName(name)
  back()
  return okLoad
}

export async function cloudDelete(name) {
  const r = await fetch(CLOUD_BASE + encodeURIComponent(name) + '.json', {
    method: 'DELETE',
    headers: { 'X-LCD-Key': CLOUD_KEY },
  })
  if (!r.ok && r.status !== 204) throw new Error('删除失败 HTTP ' + r.status)
  await cloudProbe()
  if (cloud.current === name) {
    cloud.current = ''; cloud.currentScreen = null; cloud.currentAt = 0; cloud.currentKind = ''
    cloud.baseSig = ''
    cloud.dirty = projectDirtyNow()
  }
}

/** 内置屏幕预设补装 (1.9吋 170x320 / 1.14吋 135x240 / 3.2吋 240x320 各横竖两条 …):
 *  老用户的预设存在 localStorage 里, 从存档/工程文件读进来的 presets 也会**整份替换**列表 ——
 *  两种情况都要主动把没见过的内置分辨率补上, 否则新尺寸永远看不到。
 *  以前用 "补过一次" 的布尔标记: 标记写过之后再加新分辨率就再也补不进去了
 *  (这三组尺寸就是这么漏的) → 现在记**给过用户的名字清单** (syncBuiltinPresets 纯函数):
 *  只补没给过的; 用户自己删掉的 (删之前已经记过) 不会再被加回来。返回补了几条。 */
export function ensureBuiltinPresets() {
  /* 固定预设现在**每次加载都从代码合并** (mergePresets): 老用户/工程文件里没有它们也没关系,
   * 新增分辨率所有人刷新就有。这个函数只留作"再合并一次"的兼容入口 (载入工程/撤销之后调用),
   * 返回补了几条 —— 老的那套"给过谁的名单" (lcd-layout-presets-offered) 已废弃。 */
  const before = (state.presets || []).filter(isBuiltinPreset).length
  state.presets = mergePresets({ custom: (state.presets || []).filter(p => !isBuiltinPreset(p)),
                                 overrides: (state.presets || []).filter(isBuiltinPreset),
                                 hidden: [] })
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem('lcd-layout-presets-offered') } catch (e) { /* 忽略 */ }
  return Math.max(0, state.presets.filter(isBuiltinPreset).length - before)
}

/** 导出目录记录的归一化 (工程 JSON 里只存 name + 本机句柄键 id).
 *  老工程没有这一项 / 手改成字符串时也能读; 不做路径猜测, 真正的目录以本机句柄为准. */
export function normalizeExportDir(d) {
  if (typeof d === 'string') return { name: d.trim().slice(0, 120), id: '' }
  const o = (d && typeof d === 'object') ? d : {}
  return {
    name: String(o.name == null ? '' : o.name).trim().slice(0, 120),
    id: String(o.id == null ? '' : o.id).trim().slice(0, 80),
  }
}

/** 工程内容指纹: 判断"有没有未保存改动". 不含大图 src 本体, 只含长度 + 字库/帧元信息.
 *  projectSignatureOf 也接受已解析的工程对象 —— 保存/读取时用**那份 JSON**算指纹,
 *  避免"上传期间又改了两下"导致 baseSig 记错. */
export function projectSignatureOf(d) {
  const p = d || {}
  const assets = Array.isArray(p.assets) ? p.assets : []
  return JSON.stringify({
    instances: p.instances || [],
    frameGroups: frameGroupsForSig(p.frameGroups),
    pages: p.pages || {},
    presets: p.presets || [],
    activePresetId: p.activePresetId || null,
    exportDir: normalizeExportDir(p.exportDir),
    exportOpts: p.exportOpts || {},
    assets: assets.map(a => [a.id, a.name, a.w, a.h, a.src ? a.src.length : 0, a.font || null]),
  })
}
export function projectSignature() {
  return projectSignatureOf({
    instances: state.instances,
    pages: state.pages || {},
    presets: state.presets,
    activePresetId: state.activePresetId,
    exportDir: state.exportDir,
    exportOpts: state.exportOpts,
    assets: state.assets,
  })
}

/** 当前工程是否改过 (baseSig 为空 = 从没存过; 空工程不算脏) */
export function projectDirtyNow() {
  const has = !!(state.assets.length || state.instances.length || Object.keys(state.pages || {}).length)
  if (!cloud.baseSig) return has
  return projectSignature() !== cloud.baseSig
}

export function exportProject() {
  const s = screen.value
  return JSON.stringify({
    version: 1, assets: state.assets, instances: state.instances,
    frameGroups: state.frameGroups || [],
    presets: state.presets, activePresetId: state.activePresetId, exportOpts: state.exportOpts,
    /* 这个存档自己的「一键导出」目录 (每个存档可以不同; 换机器打开会按 name 提示重选) */
    exportDir: normalizeExportDir(state.exportDir),
    /* 自定义字库原文件 (base64): 保存/导出 JSON 时自动带上, 换机器打开工程字体不会丢 */
    /* 只带当前工程真正用到的自定义字库 (未使用的字体不再塞进 JSON/导出目录) */
    fonts: usedCustomFontFiles().map(f => ({
      id: f.id, name: f.name, ext: f.ext || fontExtOf(f.name), data: abToB64(f.data),
    })),
    pages: state.pages || {},          // 每页: 刷新周期 + 定时跳转 (jumpMs/jumpTo)
    /* 页面尺寸快照: 在线存档保存前不必解析整套 presets 就能判断"是不是同一块屏".
     * 老存档没有 meta → archive.projectMeta() 回退到 activePresetId. */
    meta: { w: Math.round(+s.w || 0), h: Math.round(+s.h || 0), round: !!s.round,
            preset: s.name || '', layers: state.instances.length },
  }, null, 1)
}

export function importProject(json) {
  const d = JSON.parse(json)
  if (!Array.isArray(d.assets)) throw new Error('无效工程文件')
  /* 本地导入 = 新的工程, 不再属于任何在线存档 (cloudLoadByName 会随后重新写上档名) */
  cloud.current = ''; cloud.currentScreen = null; cloud.currentAt = 0; cloud.currentKind = ''
  cloud.baseSig = ''; cloud.dirty = false
  state.assets = d.assets; state.instances = d.instances || []
  normalizeInstanceStores()
  state.frameGroups = Array.isArray(d.frameGroups) ? d.frameGroups : []
  state.pages = d.pages || {}          // 每页: 刷新周期 + 定时跳转 (老工程没有这一项 → 空)
  if (Array.isArray(d.fonts) && d.fonts.length) restoreFontsFromProject(d.fonts)
  // SVG 素材: 重建 svgImageCache
  svgImageCache.clear()
  for (const a of state.assets) {
    if (a.svg && a.svgText) {
      const i = new Image()
      i.onload = () => { state._imgTick++ }
      i.src = URL.createObjectURL(new Blob([a.svgText], { type: 'image/svg+xml' }))
      svgImageCache.set(a.id, i)
    }
  }
  for (const inst of state.instances) {
    if (inst.kind === 'ring' && inst.ring?.centered) {   // 旧圆心坐标 → 左上角
      inst.x -= inst.w / 2
      inst.y -= inst.h / 2
      delete inst.ring.centered
    }
  }
  if (d.presets) state.presets = mergePresets(d.presets)   /* 固定项来自代码 */
  ensureBuiltinPresets()          /* 存档里的 presets 会整份替换列表 → 新内置尺寸补回来 */
  state.activePresetId = d.activePresetId || state.presets[0].id
  state.exportDir = normalizeExportDir(d.exportDir)   /* 每个存档自己的导出目录 (老工程没有 → 空) */
  if (d.exportOpts) Object.assign(state.exportOpts, normalizeExportOpts(d.exportOpts))
  state.ui.selectedId = null
  /* 老存档里可能把内置多帧素材按"1 帧"存下来了 (见 installBuiltinAssets 注释):
   * 打开工程时就地按元数据修复, 否则电池图标之类的「导出所有帧」永远只有 1 帧。 */
  try { installBuiltinAssets() } catch (e) { /* node 自检没有 canvas */ }
  cloud.dirty = projectDirtyNow()
}

export { FORMATS }
