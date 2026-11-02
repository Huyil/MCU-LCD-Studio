<script setup>
import { ref, reactive, computed, watch } from 'vue'
import ColorField from './ColorField.vue'
import {
  state, screen, addInstance, updateInstance, removeInstance,
  getAssetImage, instanceCode, fontMeta, fontCells, fontGlyphValues, pushRecentColor,
  getSvgImage, centerAnchor,
} from '../store.js'
import { sanitizeName } from '../template.js'
import { roundGeom } from '../roundscreen.js'
import { COLORS, QUICK_COLORS, colorByName, nearestColorName, rgb565To888 } from '../colors.js'
import { processImage, buildCArrayText, buildFontTableText, applyCropWindow, svgToCanvas } from '../imageproc.js'
import { copyText, downloadText, downloadCanvasPng } from '../utils.js'
import { imageFileName } from '../frameshoot.js'
import { frameAspectSource, fitAspect } from '../aspect.js'

const show = ref(false)
const draft = reactive({
  id: null, isNew: false, assetId: null,
  name: '', x: 0, y: 0, w: 32, h: 32, fmt: 'RGB565', color: 0xFFFF, mirror: false,
  frame: null, allFrames: false, crop: { x: 0, y: 0 },
})
const lockAspect = ref(true)
const copied = ref('')
const colorHex = ref('#ffff00')
const showArray = ref(false)   // 数组源码: 点击展开, 默认收起防抖动

const asset = computed(() => state.assets.find(a => a.id === draft.assetId))
const sc = screen

/* 打开: 编辑已有 / 从素材新建 */
watch(
  () => [state.ui.dialogInstanceId, state.ui.dialogNewAssetId],
  ([instId, assetId]) => {
    if (instId) {
      const it = state.instances.find(i => i.id === instId)
      if (!it) return
      Object.assign(draft, { ...it, isNew: false, allFrames: !!it.allFrames, crop: { x: it.crop?.x ?? 0, y: it.crop?.y ?? 0 } })
      syncHex()
      show.value = true
    } else if (assetId) {
      const a = state.assets.find(x => x.id === assetId)
      if (!a) return
      const k = Math.min(1, sc.value.w / a.w, sc.value.h / a.h)
      Object.assign(draft, {
        id: null, isNew: true, assetId,
        name: sanitizeName(a.name),
        x: Math.round((sc.value.w - a.w * k) / 2),
        y: Math.round((sc.value.h - a.h * k) / 2),
        w: Math.max(1, Math.round(a.w * k)),
        h: Math.max(1, Math.round(a.h * k)),
        fmt: a.defaultFmt || sc.value.defaultFmt || 'RGB565',
        color: a.font?.frameColors?.[0] ?? a.defaultColor ?? a.font?.color ?? 0xFFFF, mirror: false,
        frame: a.font ? 0 : null, allFrames: false,
        crop: { x: 0, y: 0 },
      })
      if (a.font) {
        const box = a.font.boxes?.[0]
        draft.w = box ? box.w : a.font.glyphW
        draft.h = box ? box.h : a.font.glyphH
      }
      syncHex()
      show.value = true
    }
  },
)

function close() {
  show.value = false
  state.ui.dialogInstanceId = null
  state.ui.dialogNewAssetId = null
}

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
  draft.color = ((n >> 16 & 0xFF) >> 3) << 11 | ((n >> 8 & 0xFF) >> 2) << 5 | ((n & 0xFF) >> 3)
  pushRecentColor(draft.color)
}

function pickColorName(n) {
  const v = colorByName(n)
  if (v !== undefined) { draft.color = v; pushRecentColor(v); syncHex() }
}

/* 颜色名防抖: 拖动取色时"最近枚举名"不逐帧跳动 */
const shownColor = ref(0xFFFF)
let nameTimer = null
watch(() => draft.color, c => {
  clearTimeout(nameTimer)
  nameTimer = setTimeout(() => (shownColor.value = c & 0xFFFF), 400)
}, { immediate: true })
const colorName = computed(() => nearestColorName(shownColor.value))
const colorExact = computed(() => COLORS.find(c => c.v === (draft.color & 0xFFFF))?.n || '')
const color565Text = computed(() => '0x' + (draft.color & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'))
function swCss(name) {
  const v = colorByName(name)
  if (v === undefined) return '#888'
  const { r, g, b } = rgb565To888(v)
  return `rgb(${r},${g},${b})`
}
const css565 = v => { const { r, g, b } = rgb565To888(v & 0xFFFF); return `rgb(${r},${g},${b})` }

/* 调色板 */
const showPalette = ref(false)
const allColors = COLORS
function setColor(v) {
  draft.color = v & 0xFFFF
  pushRecentColor(draft.color)
  syncHex()
}

/* 尺寸联动: 输入期间只联动比例不重写自身, 失焦时才规整 (避免打断输入/触发重管线).
 * ！比例基准必须是**当前帧**的尺寸 (多帧素材的 asset.w/h 是整张拼版图, 不是单帧):
 *   48×24 的帧如果拿拼版图 768×24 算比例, 输入 96 会得到高 3 —— 用户现场 bug.
 *   有内容框 (boxes) 时用内容框, 与 pickFrame() 给的初始 w/h 同一个基准. */
const aspectWH = computed(() => frameAspectSource(asset.value, draft.frame))
const aspectText = computed(() => {
  const s = aspectWH.value
  if (!s || !s.w || !s.h) return '—'
  return s.w + ' : ' + s.h
})
const isNum = v => Number.isFinite(+v) && +v > 0
function onWInput() {
  if (lockAspect.value && isNum(draft.w)) draft.h = fitAspect(draft.w, aspectWH.value, 'w')
}
function onHInput() {
  if (lockAspect.value && isNum(draft.h)) draft.w = fitAspect(draft.h, aspectWH.value, 'h')
}
function sanitizeWH() {
  draft.w = clampInt(draft.w, 1, 4096)
  draft.h = clampInt(draft.h, 1, 4096)
}
function clampInt(v, a, b) { v = Math.round(+v || 0); return Math.max(a, Math.min(b, v)) }

/* 防抖后的预览参数: 输入期间不跑图像管线, 停顿 200ms 才处理 */
const pv = reactive({ ready: false, w: 1, h: 1, fmt: 'RGB565', color: 0xFFFF, mirror: false, frame: null, crop: { x: 0, y: 0 } })
let pvTimer = null
watch(
  () => [draft.w, draft.h, draft.fmt, draft.color, draft.mirror, draft.frame, show.value,
         draft.crop.x, draft.crop.y],
  () => {
    if (!show.value) return
    pv.ready = false
    clearTimeout(pvTimer)
    pvTimer = setTimeout(() => {
      pv.w = clampInt(draft.w, 1, 4096)
      pv.h = clampInt(draft.h, 1, 4096)
      pv.fmt = draft.fmt; pv.color = draft.color; pv.mirror = draft.mirror
      pv.frame = draft.frame
      pv.crop = { x: clampInt(draft.crop.x, -9999, 9999), y: clampInt(draft.crop.y, -9999, 9999) }
      pv.ready = true
    }, 200)
  },
  { immediate: true },
)

function nativeSize() {
  if (!asset.value) return
  const k = Math.min(1, sc.value.w / asset.value.w, sc.value.h / asset.value.h)
  draft.w = Math.max(1, Math.round(asset.value.w * k))
  draft.h = Math.max(1, Math.round(asset.value.h * k))
}
function fitScreen() { draft.w = sc.value.w; draft.h = sc.value.h; draft.x = 0; draft.y = 0 }
function fitCircle() {
  const g = roundGeom(sc.value)          // 圆屏可用圆 (默认内切圆)
  const d = Math.hypot(+draft.w || 0, +draft.h || 0)
  if (d < 1) return
  const k = (2 * g.r) / d
  draft.w = Math.max(1, Math.round(draft.w * k))
  draft.h = Math.max(1, Math.round(draft.h * k))
  centerIn()
}
function centerIn() {
  const a = centerAnchor(sc.value)       // 圆屏 = 可用圆心
  draft.x = Math.round(a.cx - draft.w / 2)
  draft.y = Math.round(a.cy - draft.h / 2)
}
function align(xa, ya) {
  draft.x = Math.round(xa === 'l' ? 0 : xa === 'c' ? (sc.value.w - draft.w) / 2 : sc.value.w - draft.w)
  draft.y = Math.round(ya === 't' ? 0 : ya === 'c' ? (sc.value.h - draft.h) / 2 : sc.value.h - draft.h)
}

/* 实时预览 + 代码 (走防抖 pv, 输入期间不重算) */
const proc = computed(() => {
  void state._imgTick   // 图片异步加载完成后重算预览
  if (!show.value || !pv.ready) return null
  const a = asset.value
  if (!a) return null
  try {
    let src
    // SVG 素材: 从矢量重新光栅化到目标尺寸 (无损缩放)
    if (a.svg) {
      const svgImg = getSvgImage(a)
      // 未就绪时先不画, 等 SVG 的 onload → _imgTick 触发重算 (避免空白帧/尺寸跳变)
      if (!svgImg || !svgImg.complete || !svgImg.naturalWidth) return null
      src = svgToCanvas(svgImg, pv.w, pv.h)
    } else {
      const img = getAssetImage(a)
      if (!img.complete) return null
      src = img
      if (pv.frame != null && pv.frame >= 0 && a.font) {
        const cells = fontCells(a)
        const cell = cells ? cells[pv.frame] : null
        if (!cell) return null
        src = cell.canvas
      }
      src = applyCropWindow(src, pv.crop.x, pv.crop.y, pv.w, pv.h)
    }
    return processImage(src, pv.w, pv.h, pv.fmt, {
      tint: pv.color, mirror: pv.mirror,
      grayPack: sc.value.grayPack, rgb888AsMacro: sc.value.rgb888AsMacro,
    })
  } catch (e) { return null }
})

/* 粘性预览: 保留上一次结果, 新图算完一次性切换 (不出现"处理中"占位导致尺寸抖动) */
const lastPreview = reactive({ url: '', w: 0, h: 0 })
watch(proc, p => {
  if (p) {
    lastPreview.url = p.canvas.toDataURL()
    lastPreview.w = p.w
    lastPreview.h = p.h
  }
}, { immediate: true })

/* ---- 多帧素材: 帧选择 ---- */
const frameCells = computed(() => {
  void state._imgTick
  const a = asset.value
  if (!a?.font) return []
  const cells = fontCells(a)
  if (!cells) return []
  return cells.slice(0, 32).map((c, i) => {
    let url = ''
    try { url = c.canvas.toDataURL() } catch (e) { /* ignore */ }
    return { i, url, w: a.font.glyphW, h: a.font.glyphH, label: c.ch === ' ' ? '␠' : c.ch }
  })
})

function pickFrame(i) {
  const f = asset.value?.font
  const prev = f?.boxes?.[draft.frame] || null
  draft.frame = i
  if (i >= 0 && f) {
    const box = f.boxes?.[i] || null
    // 打包素材带每帧内容框: 换帧后图层只占这一帧的内容大小 (导出省 flash)
    draft.w = box ? box.w : f.glyphW
    draft.h = box ? box.h : f.glyphH
    draft.crop = box ? { x: box.x, y: box.y } : { x: 0, y: 0 }
    draft.x += (box ? box.x : 0) - (prev ? prev.x : 0)   // 位置补回框偏移, 换帧画面不跳
    draft.y += (box ? box.y : 0) - (prev ? prev.y : 0)
    // 多帧素材带过来的每帧颜色 (文本框打包时记的) → 选帧自动换色
    const fc = f.frameColors
    if (fc && fc[i] != null) draft.color = fc[i] & 0xFFFF
    syncHex()
  }
}

/* 源尺寸 (帧模式 = 当前帧尺寸) */
const srcW = computed(() => {
  const a = asset.value
  if (!a) return 0
  return (draft.frame != null && draft.frame >= 0 && a.font) ? a.font.glyphW : a.w
})
const srcH = computed(() => {
  const a = asset.value
  if (!a) return 0
  return (draft.frame != null && draft.frame >= 0 && a.font) ? a.font.glyphH : a.h
})

/* 步进: X/Y 裁切起点, 宽/高 (宽高同步比例) */
function stepX(d) { draft.crop.x = clampInt((+draft.crop.x || 0) + d, -9999, 9999) }
function stepY(d) { draft.crop.y = clampInt((+draft.crop.y || 0) + d, -9999, 9999) }
function stepW(d) { draft.w = clampInt((+draft.w || 1) + d, 1, 4096); onWInput() }
function stepH(d) { draft.h = clampInt((+draft.h || 1) + d, 1, 4096); onHInput() }

/* 重置: 裁切回 0,0, 宽高恢复源尺寸 (帧模式 = 帧尺寸) */
function resetCrop() {
  draft.crop = { x: 0, y: 0 }
  const a = asset.value
  if (a?.font && draft.frame != null && draft.frame >= 0) {
    draft.w = a.font.glyphW; draft.h = a.font.glyphH
  } else if (a) {
    draft.w = a.w; draft.h = a.h
  }
}

/* 按屏幕交集计算裁剪矩形 (图内坐标); 全在屏内返回 null, 全在屏外返回 {none} */
function cropForDraft() {
  const s = sc.value
  const x = Math.round(+draft.x || 0), y = Math.round(+draft.y || 0)
  const w = clampInt(draft.w, 1, 4096), h = clampInt(draft.h, 1, 4096)
  const x1 = Math.max(0, x), y1 = Math.max(0, y)
  const x2 = Math.min(s.w, x + w), y2 = Math.min(s.h, y + h)
  const cw = x2 - x1, ch = y2 - y1
  if (cw <= 0 || ch <= 0) return { none: true }
  if (x1 === x && y1 === y && x2 === x + w && y2 === y + h) return null
  return { x: x1 - x, y: y1 - y, w: cw, h: ch }
}

/* 帧实例: 数组 = 全部帧总表 (指令用 [N] 下标) */
const isFrameInst = computed(() =>
  pv.frame != null && pv.frame >= 0 && !!asset.value?.font)

function frameTableOpts() {
  const p = screen.value
  return {
    upperHex: state.exportOpts.upperHex,
    perLine: state.exportOpts.perLine || undefined,
  }
}
function frameTableText(maxChars) {
  const a = asset.value
  const glyphs = a ? fontGlyphValues(a, pv.fmt) : null
  if (!glyphs || !glyphs.length) return ''
  const kind = pv.fmt === 'GRAY' ? (screen.value.grayPack === 'g565' ? 'u16g' : 'u8') : 'u16'
  return buildFontTableText(sanitizeName(draft.name), glyphs, kind, { ...frameTableOpts(), maxChars })
}

/* 显示用文本 (截断, 防大图字符串卡顿); 复制/下载按需生成完整版 */
const codeText = computed(() => {
  if (!proc.value) return ''
  if (isFrameInst.value) {
    return `/* ${asset.value?.name || ''} 全部帧 → ${pv.fmt} */\n` + frameTableText(60000)
  }
  const lines = []
  lines.push(`/* ${asset.value?.name || ''} → ${pv.fmt} */`)
  lines.push(buildCArrayText(sanitizeName(draft.name), proc.value, {
    upperHex: state.exportOpts.upperHex, perLine: state.exportOpts.perLine || undefined,
    maxChars: 60000, crop: cropForDraft(),
  }))
  return lines.join('\n')
})

function fullArrayText() {
  const p = proc.value
  if (!p) return ''
  if (isFrameInst.value) {
    return `/* ${asset.value?.name || ''} 全部帧 → ${pv.fmt} */\n` + frameTableText(0)
  }
  return `/* ${asset.value?.name || ''} → ${pv.fmt} */\n` + buildCArrayText(sanitizeName(draft.name), p, {
    upperHex: state.exportOpts.upperHex, perLine: state.exportOpts.perLine || undefined,
    crop: cropForDraft(),
  })
}

/* 图片下载: 按**素材尺寸** (原始像素, 不缩放成屏上那一层的 w×h) 存 1 张 PNG。
 * 多帧素材的"素材尺寸"就是整条拼版图 (asset.w×asset.h) —— 就是要的那份东西。 */
function downloadAssetImage() {
  const a = asset.value
  if (!a) return
  try {
    let src = null
    if (a.svg) {
      const si = getSvgImage(a)
      if (si && si.complete && si.naturalWidth) src = si
    } else {
      const img = getAssetImage(a)
      if (img && img.complete && (img.naturalWidth || img.width)) src = img
    }
    const w = Math.max(1, Math.round(a.w || 0)), h = Math.max(1, Math.round(a.h || 0))
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    if (src) cv.getContext('2d').drawImage(src, 0, 0, w, h)
    downloadCanvasPng(imageFileName('img', a.name, w, h), cv)
  } catch (e) {
    console.warn('[图片下载]', e)     // 图还没加载完/画布被限制: 不静默, 但也不弹窗
  }
}

const truncatedCode = computed(() => {
  const t = codeText.value
  return t.length > 700 ? t.slice(0, 700) + '\n/* … 复制/下载获取完整内容 */' : t
})

const arrayBytes = computed(() => {
  const p = proc.value
  if (!p) return 0
  const per = p.kind === 'u8' ? 1 : (p.kind === 'u32' ? 4 : 2)
  if (isFrameInst.value) {
    const a = asset.value
    const glyphs = a ? fontGlyphValues(a, pv.fmt) : null
    return glyphs ? glyphs.length * (p.w * p.h) * per : 0
  }
  const c = cropForDraft()
  const len = c ? (c.none ? 0 : c.w * c.h) : p.len
  return len * per
})

/* 是否发生了屏幕裁剪 (提示用) */
const croppedNote = computed(() => {
  const c = cropForDraft()
  if (!c) return ''
  if (c.none) return '完全在屏幕外, 数组为空'
  return `已按屏幕裁剪为 ${c.w}×${c.h}`
})

async function doCopy(text, tag) {
  if (await copyText(text)) {
    copied.value = tag
    setTimeout(() => (copied.value = ''), 1200)
  }
}

function apply() {
  draft.name = sanitizeName(draft.name)
  draft.x = clampInt(draft.x, -4096, 4096)
  draft.y = clampInt(draft.y, -4096, 4096)
  draft.w = clampInt(draft.w, 1, 4096)
  draft.h = clampInt(draft.h, 1, 4096)
  const crop = { x: clampInt(draft.crop.x, -9999, 9999), y: clampInt(draft.crop.y, -9999, 9999) }
  if (draft.isNew) {
    const inst = addInstance(draft.assetId, null, null, { fmt: draft.fmt })
    if (inst) updateInstance(inst.id, {
      name: draft.name, x: draft.x, y: draft.y, w: draft.w, h: draft.h,
      fmt: draft.fmt, color: draft.color, mirror: draft.mirror,
      frame: draft.frame == null ? -1 : draft.frame, crop,
      allFrames: !!draft.allFrames,
    })
    state.ui.dialogInstanceId = inst?.id ?? null
  } else {
    updateInstance(draft.id, {
      name: draft.name, x: draft.x, y: draft.y, w: draft.w, h: draft.h,
      fmt: draft.fmt, color: draft.color, mirror: draft.mirror,
      frame: draft.frame == null ? -1 : draft.frame, crop,
      allFrames: !!draft.allFrames,
    })
  }
  close()
}

function doRemove() {
  if (!draft.isNew && draft.id) removeInstance(draft.id)
  close()
}

let maskDownOnMask = false
function onMaskDown(e) { maskDownOnMask = e.target === e.currentTarget }
function onMaskClick(e) {
  // 仅当按下与松开都在遮罩上才算空白点击 (拖选文字松开在窗外不会误关)
  if (e.target === e.currentTarget && maskDownOnMask) apply()
}

/* 预览缩放: 手动档位, 不自动缩放 */
const pvZoom = ref(1)
const ZOOM_STEPS = [0.5, 1, 2, 4, 8]
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="mask" @pointerdown="onMaskDown" @click="onMaskClick">
      <div class="dialog panel">
        <div class="panel-title">
          {{ draft.isNew ? '放置图片 — ' : '微调图片 — ' }}{{ asset?.name }}
          <span class="tag">{{ asset?.svg ? 'SVG 矢量' : asset?.w + '×' + asset?.h + ' 源图' }}</span>
          <span class="grow"></span>
          <button @click="downloadAssetImage()" :disabled="!asset"
            :title="`把这张素材按原始像素存成 PNG (按素材尺寸 ${asset?.w || 0}×${asset?.h || 0}, 不缩放; 多帧 = 整条拼版)`">⤓ 图片下载</button>
          <button class="danger" v-if="!draft.isNew" @click="doRemove">删除</button>
          <button @click="close">取消</button>
          <button class="primary" @click="apply">{{ draft.isNew ? '放置到屏幕' : '确定' }}</button>
        </div>

        <div class="body">
          <!-- 左: 参数 -->
          <div class="form">
            <div class="field-row">
              <label>数组名</label>
              <input class="mono" v-model="draft.name" style="width: 150px" />
              <span class="dim mono">gImage_{{ draft.name || '?' }}</span>
            </div>
            <div class="dim note" v-if="draft.groupId" style="margin: 0 0 6px">
              多帧画板变体 (第 {{ (draft.groupIndex | 0) + 1 }} 帧): 格式/颜色/裁切/镜像可单独设;
              组位置与组内偏移在「多帧画板」子预览里调, 整组一起移动。
            </div>

            <div class="sec">{{ draft.isNew ? '素材设置 (放置后可对齐/裁切)' : (asset?.svg ? '缩放 (SVG 矢量, 任意尺寸无损)' : '裁切 / 尺寸 (源图 ' + srcW + '×' + srcH + ', 越界黑边)') }}</div>
            <div class="duo">
              <div class="duo-l">
                <div class="field-row opts-row">
                  <label></label>
                  <button class="stp" @click="resetCrop">重置</button>
                  <label class="chk" title="按当前帧的源尺寸锁比例 (多帧素材按单帧, 不是拼版图)"><input type="checkbox" v-model="lockAspect" />锁定比例</label>
                  <span class="tag" title="当前帧的源尺寸比例">{{ aspectText }}</span>
                </div>
                <div class="field-row">
                  <label>X</label>
                  <input type="number" v-model.number="draft.crop.x" @change="stepX(0)" />
                  <button class="stp" @click="stepX(-1)">−</button><button class="stp" @click="stepX(1)">＋</button>
                </div>
                <div class="field-row">
                  <label>Y</label>
                  <input type="number" v-model.number="draft.crop.y" @change="stepY(0)" />
                  <button class="stp" @click="stepY(-1)">−</button><button class="stp" @click="stepY(1)">＋</button>
                </div>
                <div class="field-row">
                  <label>宽</label>
                  <input type="number" v-model.number="draft.w" @input="onWInput" @change="sanitizeWH" />
                  <button class="stp" @click="stepW(-1)">−</button><button class="stp" @click="stepW(1)">＋</button>
                </div>
                <div class="field-row">
                  <label>高</label>
                  <input type="number" v-model.number="draft.h" @input="onHInput" @change="sanitizeWH" />
                  <button class="stp" @click="stepH(-1)">−</button><button class="stp" @click="stepH(1)">＋</button>
                </div>
                <div class="field-row">
                  <label>快捷</label>
                  <button class="stp" @click="fitScreen">全屏</button>
                  <button v-if="sc.round" class="stp" @click="fitCircle">圆内</button>
                </div>
              </div>
              <div class="duo-r" v-if="!draft.isNew">
                <div class="grid9">
                  <button @click="align('l', 't')" title="左上">↖</button><button @click="align('c', 't')" title="上中">↑</button><button @click="align('r', 't')" title="右上">↗</button>
                  <button @click="align('l', 'c')" title="左中">←</button><button @click="align('c', 'c')" title="居中">●</button><button @click="align('r', 'c')" title="右中">→</button>
                  <button @click="align('l', 'b')" title="左下">↙</button><button @click="align('c', 'b')" title="下中">↓</button><button @click="align('r', 'b')" title="右下">↘</button>
                </div>
              </div>
            </div>

            <div class="sec" v-if="asset?.font && !draft.groupId">帧选择 (放置所选帧, 编辑里可再换)</div>
            <div v-if="asset?.font && !draft.groupId" class="field-row frames-row">
              <button :class="{ primary: draft.frame == -1 }" @click="pickFrame(-1)"
                title="-1: 仅网页渲染 — MCU 侧帧表 .index = 255, UI_DrawFrame 只把这一格清成底色, 不渲染">仅渲染</button>
              <div class="framecells">
                <div v-for="c in frameCells" :key="c.i" class="fcell"
                  :class="{ on: draft.frame === c.i }"
                  @click="pickFrame(c.i)" :title="`帧 ${c.i} [${c.label}]`">
                  <img :src="c.url" :style="{ width: c.w * 2 + 'px', height: c.h * 2 + 'px' }" />
                  <span>{{ c.label }}</span>
                </div>
              </div>
            </div>
            <div class="dim note" v-if="asset?.font && !draft.groupId && frameCells.length > 32">仅显示前 32 帧</div>
            <div class="dim note" v-if="draft.groupId">帧号由「多帧画板」管理: 这一层固定第 {{ (draft.groupIndex | 0) + 1 }} 帧; 换帧请用组子预览 ◀ ▶。</div>
            <div v-if="asset?.font?.charset === 'frames' && !draft.groupId" class="field-row" style="align-items: center">
              <label style="display: flex; gap: 6px; align-items: center; cursor: pointer">
                <input type="checkbox" v-model="draft.allFrames" />
                导出所有帧 ({{ frameCells.length }} 帧)
              </label>
              <span class="dim">MCU 按 id 调用: 0=关闭, 1..N=第 id 帧 (函数名 = 图层名)</span>
            </div>

            <div class="sec">色彩格式 (切换指令模板)</div>
            <div class="field-row">
              <label>格式</label>
              <label class="radio"><input type="radio" value="RGB565" v-model="draft.fmt" />RGB565</label>
              <label class="radio"><input type="radio" value="RGB888" v-model="draft.fmt" />RGB888</label>
              <label class="radio"><input type="radio" value="GRAY" v-model="draft.fmt" />Gray 灰度</label>
              <label class="chk" title="左右镜像绘制 (对应 mirror 参数)">
                <input type="checkbox" v-model="draft.mirror" />镜像
              </label>
            </div>
            <ColorField v-if="draft.fmt === 'GRAY'" v-model="draft.color" label="调制色" />
            <div class="dim note" v-else>RGB565 / RGB888 直显彩色 (color=0xFFFF), 灰度调制仅 GRAY 模式生效</div>

            <div class="sec">字库 / 帧 (可选)</div>
            <div class="field-row">
              <label>状态</label>
              <span v-if="asset?.font" class="tag font-ok">已拆分 {{ fontMeta(asset).count }}{{ asset.font.charset === 'frames' ? ' 帧' : ' 字' }} · {{ asset.font.glyphW }}×{{ asset.font.glyphH }}</span>
              <span v-else class="dim">未拆分 (长条图可切为帧或字符集)</span>
              <button @click="state.ui.dialogFontAssetId = draft.assetId">✂ 拆分…</button>
            </div>
            <div class="dim note" v-if="asset?.font && asset.font.charset !== 'frames'">本素材仍按图片/帧放置; 也可用工具栏「＋文字」以字符串方式引用。</div>

            <div class="sec sec-arr">
              <div class="arr-row1">
                数组数据 ({{ arrayBytes }} 字节)
                <span v-if="croppedNote" class="tag" style="color: var(--warn); border-color: var(--warn)">{{ croppedNote }}</span>
              </div>
              <div class="arr-row2">
                <button class="mini" @click="showArray = !showArray">{{ showArray ? '▾ 收起' : '▸ 源码' }}</button>
                <button class="mini" @click="doCopy(fullArrayText(), 'arr')">复制 C 数组{{ copied === 'arr' ? ' ✓' : '' }}</button>
                <button class="mini" @click="downloadText(`gImage_${draft.name || 'img'}.c`, fullArrayText())">下载 .c</button>
              </div>
            </div>
            <pre v-show="showArray" class="code code-mini">{{ truncatedCode }}</pre>
          </div>

          <!-- 右: 预览 (整栏给图片) -->
          <div class="preview">
            <div class="pv-block">
              <div class="pv-title">
                <span>模拟输出 ({{ draft.fmt }} 量化后{{ draft.fmt === 'GRAY' ? '×颜色' : '' }})</span>
                <span class="grow"></span>
                <span class="zbtns">
                  <button v-for="z in ZOOM_STEPS" :key="z" :class="{ on: pvZoom === z }"
                    @click="pvZoom = z">{{ z }}x</button>
                </span>
              </div>
              <div class="pv-img">
                <img v-if="lastPreview.url" :src="lastPreview.url" class="pv"
                  :style="{ width: lastPreview.w * pvZoom + 'px', height: lastPreview.h * pvZoom + 'px' }" />
              </div>
              <div class="dim mono">{{ clampInt(draft.w, 1, 4096) }}×{{ clampInt(draft.h, 1, 4096) }} px</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0, 0, 0, .55);
  /* 顶边锁死: 预览图/表单变高变矮, 弹窗都不移动, 内容在 .body 里滚 */
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 3vh;
}
.dialog {
  width: min(860px, 94vw);
  height: min(800px, 92vh);   /* 固定高度: 标题栏/按钮位置不随内容伸缩移动 */
  box-shadow: 0 20px 60px rgba(0, 0, 0, .6);
}
.body {
  display: grid; grid-template-columns: 340px minmax(0, 1fr);
  gap: 12px; padding: 12px; overflow: auto; min-height: 0; flex: 1;
}
.sec {
  margin: 10px 0 6px; padding-bottom: 3px;
  border-bottom: 1px dashed var(--border);
  font-size: 12px; color: var(--accent); font-weight: 600;
  display: flex; align-items: center; gap: 8px;
}
.sec .grow { flex: 1; }
.sec button { color: var(--text); font-weight: 400; }
.chk, .radio { color: var(--text-dim); font-size: 12px; display: inline-flex; align-items: center; gap: 3px; }
.note { font-size: 11px; padding: 0 0 4px 52px; }
.font-ok { color: var(--ok); border-color: var(--ok); }
.colname { display: inline-block; min-width: 118px; text-align: center; }
.swatches { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; min-width: 0; }
.sw {
  width: 20px; height: 20px; border-radius: 3px;
  border: 1px solid rgba(255,255,255,.15); cursor: pointer;
  box-shadow: inset 0 0 2px rgba(0,0,0,.4);
}
.sw:hover { outline: 1px solid var(--accent); }
.sw.on { outline: 2px solid var(--accent); outline-offset: 1px; }
.palette {
  display: flex; flex-wrap: wrap; gap: 4px;
  flex: 1; min-width: 0;
  max-height: 118px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: 4px;
  padding: 6px; background: var(--bg2);
}
.duo { display: flex; gap: 16px; align-items: flex-start; }
.duo-l { flex: 1; min-width: 0; }
.duo-r { flex: none; }
.grid9 {
  display: grid; grid-template-columns: repeat(3, 30px); gap: 4px;
}
.grid9 button { padding: 3px 0; font-size: 13px; line-height: 1; }
.stp { padding: 2px 8px; font-size: 11px; }
.frames-row { align-items: flex-start; }
.framecells {
  display: flex; flex-wrap: wrap; gap: 4px; flex: 1; min-width: 0;
  max-height: 108px; overflow-y: auto;
}
.fcell {
  display: flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 3px; border: 1px solid var(--border); border-radius: 4px;
  cursor: pointer; background: var(--bg2);
}
.fcell:hover { border-color: var(--accent); }
.fcell.on { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(79,195,247,.4); }
.fcell img { image-rendering: pixelated; display: block; }
.fcell span { font-size: 9px; color: var(--text-dim); }
.fcell.ro { cursor: default; opacity: .9; }
.sec-arr { display: block; }
.arr-row1 { display: flex; align-items: center; gap: 8px; }
.arr-row2 { display: flex; align-items: center; gap: 6px; margin-top: 5px; }

.preview { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.pv-block { flex: none; }
.pv-title {
  font-size: 12px; color: var(--text-dim); margin-bottom: 6px;
  display: flex; align-items: center; gap: 8px; width: 100%;
}
.pv-title .grow { flex: 1; }
.zbtns { display: inline-flex; gap: 3px; }
.zbtns button { padding: 0 7px; font-size: 11px; line-height: 18px; }
.zbtns button.on { background: var(--accent-dim); border-color: var(--accent); color: #fff; }
.pv-img {
  display: inline-flex; padding: 8px;
  background:
    linear-gradient(45deg, #222 25%, transparent 25%, transparent 75%, #222 75%),
    linear-gradient(45deg, #222 25%, #181818 25%, #181818 75%, #222 75%);
  background-size: 12px 12px; background-position: 0 0, 6px 6px;
  border: 1px solid var(--border); border-radius: 4px;
}
.pv { image-rendering: pixelated; display: block; }
.code {
  margin: 0; overflow: auto;
  background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
  padding: 8px; font-family: var(--mono); font-size: 11px;
  color: #a5d6a7; white-space: pre;
}
.code-mini {
  margin: 8px 0 0 0;
  height: 92px;   /* 固定高度: 展开状态下内容变化也不抖动 */
}
.preview { align-items: flex-start; }
.pv-block { display: flex; flex-direction: column; align-items: center; width: 100%; }
</style>
