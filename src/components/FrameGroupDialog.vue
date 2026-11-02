<script setup>
/*
 * 多帧画板编辑器 v2
 *
 * 一张多帧素材 = 若干帧; 每帧是一个小画布, 可以放多张图片/文字 (类似图层)。
 * 中间预览支持缩放、拖拽素材、上一帧残影 (仅预览); 右侧是帧表 + 图层表;
 * 预览下方是画布尺寸、自动尺寸、格式/名称、图片下载与入库/放屏。
 *
 * 导出仍是**一张多帧素材** (font.charset='frames'), 图层列表里只有 1 层;
 * 每帧共用同一画布尺寸 ⇒ 换帧不会字符偏移。
 */
import { computed, nextTick, reactive, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import TextDialog from './TextDialog.vue'
import {
  state, screen, getAssetImage, fontPreviewSrc, addAssetFile, fontCells,
  addInstance, updateInstance, sysGlowCanvas, saveFrameAsset, DEFAULT_FONT,
  addBitmapAsset, readClipboardObject, fontGlyphValues, flushLocalPersistence,
} from '../store.js'
import { numFontFromGlyphs } from '../uiexport.js'
import { renderNumCanvas } from '../imageproc.js'
import { rgb565To888 } from '../colors.js'
import { downloadCanvasPng } from '../utils.js'
import { imageFileName } from '../frameshoot.js'

const show = computed(() => !!state.ui.dialogFrameGroup)
const doc = reactive({
  assetId: '', name: '', fmt: 'RGB565', w: 128, h: 128,
  frames: [], cur: 0, selId: '', overlay: 35, alpha: 100, zoom: 1,
})
const cv = ref(null)
const stageEl = ref(null)
const textTarget = ref(null)
const fileInput = ref(null)
const busy = ref('')
const saving = ref(false)
const pasteMsg = ref('')
const lastSavedSig = ref('')
let saveTask = null
/* 画板自己的撤回栈: 删除帧/图层、拖动、改文字/尺寸都走这里 (App 的全局撤回只认 state.instances) */
const canUndo = ref(false)
const canRedo = ref(false)
let historyStack = []
let redoStack = []
let lastSnap = ''
let historyTimer = null
let suspendHistory = false
const playing = ref(false)
let pasteTimer = null
const textCache = new Map()
let timer = null
let seq = 0
let drag = null

const nid = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`
const curFrame = computed(() => doc.frames[doc.cur] || null)
const curLayers = computed(() => curFrame.value?.layers || [])
const selLayer = computed(() => curLayers.value.find(l => l.id === doc.selId) || null)
const sources = computed(() => state.assets)
const PAD = 48
const viewW = computed(() => doc.w + PAD * 2)
const viewH = computed(() => doc.h + PAD * 2)
const scale = computed(() => doc.zoom)
const editing = computed(() => !!doc.assetId)
const hasInstances = computed(() => !!doc.assetId && state.instances.some(i => i.assetId === doc.assetId))

function newFrame() { return { id: nid('f'), layers: [], preview: false } }
function ensureFrame() {
  if (!doc.frames.length) doc.frames.push(newFrame())
  doc.cur = Math.max(0, Math.min(doc.frames.length - 1, doc.cur))
  return doc.frames[doc.cur]
}
function normalizeDoc() {
  if (!doc.frames.length) doc.frames = [newFrame()]
  doc.frames.forEach(f => {
    if (!f.id) f.id = nid('f')
    if (!Array.isArray(f.layers)) f.layers = []
    if (f.preview == null) f.preview = false
    f.layers.forEach(l => {
      if (!l.id) l.id = nid('l')
      if (l.visible == null) l.visible = true
      if (l.kind === 'text') { if (!l.family) l.family = DEFAULT_FONT; if (!l.text) l.text = '文字' }
    })
  })
  doc.cur = Math.max(0, Math.min(doc.frames.length - 1, doc.cur))
  doc.selId = ''
}

function waitImg(img) {
  if (!img) return Promise.resolve(null)
  if (img.complete) return Promise.resolve(img)
  return new Promise(res => {
    img.addEventListener?.('load', () => res(img), { once: true })
    img.addEventListener?.('error', () => res(img), { once: true })
    setTimeout(() => res(img), 1500)
  })
}

async function reset() {
  suspendHistory = true
  clearTimeout(historyTimer)
  stop()
  textCache.clear()
  drag = null
  busy.value = ''
  Object.assign(doc, { assetId: '', name: '', fmt: 'RGB565', w: 128, h: 128, frames: [], cur: 0, selId: '', overlay: 35, alpha: 100, zoom: 1 })
  const id = state.ui.frameGroupAssetId
  if (id) {
    const a = state.assets.find(x => x.id === id)
    if (a) {
      doc.assetId = a.id
      doc.name = a.name
      doc.fmt = a.defaultFmt || 'RGB565'
      if (a.frameGroupDoc?.frames?.length) {
        doc.w = Math.max(1, Math.round(a.frameGroupDoc.w || a.font?.glyphW || a.w || 1))
        doc.h = Math.max(1, Math.round(a.frameGroupDoc.h || a.font?.glyphH || a.h || 1))
        doc.frames = JSON.parse(JSON.stringify(a.frameGroupDoc.frames))
        if (a.frameGroupDoc.overlay != null) doc.overlay = Math.max(0, Math.min(100, Math.round(a.frameGroupDoc.overlay)))
        if (a.frameGroupDoc.alpha != null) doc.alpha = Math.max(10, Math.min(100, Math.round(a.frameGroupDoc.alpha)))
      } else {
        const img = await waitImg(getAssetImage(a))
        const cells = img ? (fontCells(a) || []) : []
        doc.w = Math.max(1, Math.round(a.font?.glyphW || a.w || 1))
        doc.h = Math.max(1, Math.round(a.font?.glyphH || a.h || 1))
        doc.frames = cells.length
          ? cells.map((c, i) => ({
              id: nid('f'),
              layers: [{
                id: nid('l'), kind: 'image', assetId: a.id, frame: i,
                x: 0, y: 0, w: c.canvas.width, h: c.canvas.height, visible: true,
              }],
            }))
          : [newFrame()]
      }
    }
  }
  if (!doc.name) {
    const n = new Date()
    doc.name = `frames_${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}`
  }
  normalizeDoc()
  doc.cur = 0
  doc.selId = ''
  lastSavedSig.value = docSignature()
  historyStack = []; redoStack = []
  lastSnap = historySignature()
  syncHistoryFlags()
  nextTick(() => { fitZoom(); drawPreview(); setTimeout(() => { suspendHistory = false }, 0) })
}

async function close() {
  if (saveTask) { try { await saveTask } catch (e) { /* ignore */ } }
  if (hasContent()) { try { await autoSave() } catch (e) { /* ignore */ } }
  flushLocalPersistence()
  stop()
  textTarget.value = null
  state.ui.dialogFrameGroup = false
  state.ui.frameGroupAssetId = ''
}
function stop() {
  playing.value = false
  if (timer) { clearInterval(timer); timer = null }
}
function hasContent() {
  return doc.frames.some(f => f.layers.length > 0)
}
function docSignature() {
  return JSON.stringify({
    name: doc.name, fmt: doc.fmt, w: doc.w, h: doc.h, img: state._imgTick,
    frames: doc.frames.map(f => ({ preview: !!f.preview, layers: f.layers.map(l => ({ ...l })) })),
    overlay: doc.overlay, alpha: doc.alpha,
  })
}
function historySnapshot() {
  return JSON.stringify({
    w: doc.w, h: doc.h, name: doc.name, fmt: doc.fmt,
    frames: doc.frames, cur: doc.cur, selId: doc.selId, overlay: doc.overlay, alpha: doc.alpha,
  })
}
function historySignature() {
  return JSON.stringify({
    w: doc.w, h: doc.h, name: doc.name, fmt: doc.fmt,
    frames: doc.frames.map(f => ({ preview: !!f.preview, layers: f.layers.map(l => ({ ...l })) })),
    overlay: doc.overlay, alpha: doc.alpha,
  })
}
function syncHistoryFlags() {
  canUndo.value = historyStack.length > 0
  canRedo.value = redoStack.length > 0
}
function commitHistory() {
  clearTimeout(historyTimer)
  if (!show.value) return
  const now = historySignature()
  if (now === lastSnap) return
  historyStack.push(lastSnap)
  if (historyStack.length > 50) historyStack.shift()
  redoStack = []
  lastSnap = now
  syncHistoryFlags()
}
function applyHistory(snap) {
  const d = JSON.parse(snap)
  suspendHistory = true
  doc.w = Math.max(1, Math.round(+d.w || 1)); doc.h = Math.max(1, Math.round(+d.h || 1))
  doc.name = d.name || ''; doc.fmt = d.fmt || 'RGB565'
  doc.overlay = Math.max(0, Math.min(100, Math.round(d.overlay ?? 35)))
  doc.alpha = Math.max(10, Math.min(100, Math.round(d.alpha ?? 100)))
  doc.frames = Array.isArray(d.frames) ? d.frames : []
  normalizeDoc()
  doc.cur = Math.max(0, Math.min(doc.frames.length - 1, Math.round(+d.cur || 0)))
  doc.selId = doc.frames[doc.cur]?.layers.some(l => l.id === d.selId) ? d.selId : ''
  lastSnap = historySignature()
  nextTick(() => { fitZoom(); drawPreview(); setTimeout(() => { suspendHistory = false }, 0) })
}
function undoBoard() {
  if (!show.value) return
  clearTimeout(historyTimer)
  const now = historySignature()
  if (now !== lastSnap) {
    historyStack.push(lastSnap)
    if (historyStack.length > 50) historyStack.shift()
    redoStack = []
    lastSnap = now
  }
  if (!historyStack.length) { syncHistoryFlags(); return }
  const prev = historyStack.pop()
  redoStack.push(now)
  applyHistory(prev)
  syncHistoryFlags()
}
function redoBoard() {
  if (!show.value) return
  clearTimeout(historyTimer)
  const now = historySignature()
  if (now !== lastSnap) {
    historyStack.push(lastSnap)
    if (historyStack.length > 50) historyStack.shift()
    redoStack = []
    lastSnap = now
  }
  if (!redoStack.length) { syncHistoryFlags(); return }
  const next = redoStack.pop()
  historyStack.push(now)
  applyHistory(next)
  syncHistoryFlags()
}

async function autoSave() {
  if (!show.value || busy.value || saving.value) return false
  if (!hasContent()) return false
  const sig = docSignature()
  if (sig === lastSavedSig.value && doc.assetId) return false
  saving.value = true
  saveTask = (async () => {
    try {
      const res = await buildAsset()
      if (res) lastSavedSig.value = docSignature()
      return !!res
    } catch (e) { return false }
  })()
  try { return await saveTask } finally { saving.value = false; saveTask = null }
}
/** 页面关闭: beforeunload/pagehide 里不能 await; buildAsset 到 save 全是同步的 */
function persistNow() {
  if (!show.value || !hasContent() || saving.value || saveTask) return
  const sig = docSignature()
  if (sig === lastSavedSig.value && doc.assetId) return
  try { buildAsset() } catch (e) { /* ignore */ }
}
function onPageHide() {
  persistNow()
  flushLocalPersistence()
}
function fitZoom() {
  const el = stageEl.value
  const aw = Math.max(160, (el?.clientWidth || 500) - 26)
  const ah = Math.max(120, (el?.clientHeight || 360) - 26)
  doc.zoom = Math.max(0.25, Math.min(4, aw / Math.max(1, viewW.value), ah / Math.max(1, viewH.value)))
  nextTick(drawPreview)
}
function setZoom(z) { doc.zoom = Math.max(0.25, Math.min(8, +z || 1)); nextTick(drawPreview) }

/* ---------- 素材 → 帧 / 图层 ---------- */
function centerLayer(l) {
  l.x = Math.max(0, Math.round((doc.w - l.w) / 2))
  l.y = Math.max(0, Math.round((doc.h - l.h) / 2))
}
function addImageLayer(a, frameIdx, frame) {
  if (!a) return null
  commitHistory()
  const cells = frameIdx != null ? fontCells(a) : null
  const c = frameIdx != null ? cells?.[frameIdx] : null
  const w = Math.max(1, Math.round(c?.canvas?.width || a.w || 1))
  const h = Math.max(1, Math.round(c?.canvas?.height || a.h || 1))
  /* 新组的第一张图把画布撑到至少素材大小 (之后可用「自动设置尺寸」) */
  if (!editing.value && doc.frames.length === 1 && !ensureFrame().layers.length) {
    doc.w = Math.max(doc.w, w); doc.h = Math.max(doc.h, h)
  }
  const layer = {
    id: nid('l'), kind: 'image', assetId: a.id, frame: frameIdx == null ? null : frameIdx,
    w, h, x: 0, y: 0, visible: true,
  }
  centerLayer(layer)
  ;(frame || ensureFrame()).layers.push(layer)
  doc.selId = layer.id
  return layer
}
function addAsset(a) {
  if (!a) return
  if (a.font?.charset === 'frames') {
    const cells = fontCells(a) || []
    if (!cells.length) { addImageLayer(a, null, ensureFrame()); return nextTick(drawPreview) }
    if (cells.length > 24 && !confirm(`这个素材有 ${cells.length} 帧, 一次全部加入?`)) return
    let first = doc.frames.length === 1 && !doc.frames[0].layers.length ? 0 : -1
    cells.forEach((c, i) => {
      let frame
      if (first === 0 && i === 0) { frame = doc.frames[0]; doc.cur = 0 }
      else { frame = newFrame(); doc.frames.push(frame); if (i === 0) first = doc.frames.length - 1 }
      addImageLayer(a, i, frame)
    })
    if (first >= 0) doc.cur = first
    else doc.cur = Math.max(0, doc.frames.length - 1)
    nextTick(() => { fitZoom(); drawPreview() })
    return
  }
  addImageLayer(a, null, ensureFrame())
  nextTick(() => { fitZoom(); drawPreview() })
}
async function onFiles(e) {
  const list = [...(e.target.files || [])]
  e.target.value = ''
  if (!list.length) return
  busy.value = '导入中…'
  try {
    for (const f of list) {
      try { const a = await addAssetFile(f); if (a) addAsset(a) } catch (err) { console.warn(err) }
    }
  } finally { busy.value = '' }
}
function addText() {
  commitHistory()
  const frame = ensureFrame()
  const l = {
    id: nid('l'), kind: 'text', source: 'system', text: '文字', family: DEFAULT_FONT, size: 24, bold: false,
    weight: 400, spacing: 0, offsetY: 0, lineGap: 0, rampSigma: 0,
    glowThresh: 40, glowSigma: 0, glowGain: 1, glowFit: false,
    color: 0xFFFF, x: 0, y: 0, w: 40, h: 28, visible: true,
  }
  refreshText(l)
  centerLayer(l)
  frame.layers.push(l)
  doc.selId = l.id
  nextTick(drawPreview)
}
function textCfg(l) {
  return {
    text: String(l.text ?? ' '), family: l.family || DEFAULT_FONT,
    size: Math.max(4, Math.min(200, Math.round(+l.size || 24))),
    weight: Math.max(100, Math.min(900, Math.round(+l.weight || (l.bold ? 700 : 400)))),
    bold: !!l.bold, spacing: Math.round(+l.spacing || 0),
    offsetY: Math.round(+l.offsetY || 0), lineGap: Math.round(+l.lineGap || 0),
    rampSigma: Math.max(0, Math.min(2, +l.rampSigma || 0)),
    glowThresh: Math.max(0, Math.min(255, Math.round(+l.glowThresh || 0))),
    glowSigma: Math.max(0, Math.min(12, +l.glowSigma || 0)),
    glowGain: Math.max(0, Math.min(4, +l.glowGain || 0)),
    glowFit: !!l.glowFit,
  }
}
function assetTextCanvas(l) {
  const a = state.assets.find(x => x.id === l.assetId)
  if (!a?.font) return null
  const glyphs = fontGlyphValues(a, 'GRAY')
  if (!glyphs?.length) return null
  const chars = String(l.text || ' ') || ' '
  const f = numFontFromGlyphs(glyphs, '', a.font.glyphW, a.font.glyphH,
    Math.max(0, Math.round(+l.spacing || 0)), { chars })
  if (!f) return null
  return renderNumCanvas(chars, (l.color == null ? 0xFFFF : l.color) & 0xFFFF, 0xFFFF, f)
}
function textCanvas(l) {
  if (l.source === 'asset') {
    const key = JSON.stringify(['asset', l.assetId, l.text, l.spacing, l.color, l.fullSet])
    const hit = textCache.get(key)
    if (hit) return hit
    const c = assetTextCanvas(l)
    if (c) textCache.set(key, c)
    return c
  }
  const cfg = textCfg(l)
  const key = JSON.stringify([cfg, l.color])
  const hit = textCache.get(key)
  if (hit) return hit
  const gray = sysGlowCanvas(cfg)
  if (!gray) return null
  const g = gray.getContext('2d')
  const src = g.getImageData(0, 0, gray.width, gray.height).data
  const out = document.createElement('canvas')
  out.width = gray.width; out.height = gray.height
  const ctx = out.getContext('2d')
  const img = ctx.createImageData(gray.width, gray.height)
  const { r, g: gg, b } = rgb565To888((l.color == null ? 0xFFFF : l.color) & 0xFFFF)
  for (let i = 0; i < img.data.length; i += 4) {
    /* 同时兼容两种画布: 普通文字 = 白字 + alpha; 光晕 = 不透明 + 灰度 */
    const v = (src[i] / 255) * (src[i + 3] / 255)
    img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b
    img.data[i + 3] = Math.round(v * 255)
  }
  ctx.putImageData(img, 0, 0)
  textCache.set(key, out)
  return out
}
function refreshText(l) {
  if (!l || l.kind !== 'text') return
  if (l.source === 'asset') {
    const c = assetTextCanvas(l)
    if (c) {
      l.w = Math.max(1, c.width); l.h = Math.max(1, c.height)
      if (l.x == null || l.y == null) centerLayer(l)
    }
    nextTick(drawPreview)
    return
  }
  const raw = sysGlowCanvas(textCfg(l))
  if (raw) {
    l.w = Math.max(1, raw.width); l.h = Math.max(1, raw.height)
    if (l.x == null || l.y == null) centerLayer(l)
  }
  nextTick(drawPreview)
}
function openTextEditor(l) {
  if (!l || l.kind !== 'text') return
  doc.selId = l.id
  textTarget.value = l
}
function applyGroupText(cfg) {
  const l = textTarget.value
  if (l && cfg) {
    commitHistory()
    if (cfg.source === 'asset') {
      l.source = 'asset'
      l.assetId = cfg.assetId
      l.text = String(cfg.text || '')
      l.spacing = Math.round(+cfg.spacing || 0)
      l.fullSet = !!cfg.fullSet
      l.color = (cfg.color == null ? 0xFFFF : cfg.color) & 0xFFFF
    } else {
      l.source = 'system'
      for (const k of ['text', 'family', 'size', 'weight', 'bold', 'spacing', 'offsetY', 'lineGap',
        'rampSigma', 'glowThresh', 'glowSigma', 'glowGain', 'glowFit']) {
        if (cfg[k] !== undefined) l[k] = cfg[k]
      }
      l.color = (cfg.color == null ? 0xFFFF : cfg.color) & 0xFFFF
    }
    refreshText(l)
  }
  textTarget.value = null
  nextTick(drawPreview)
}

function clearFrames() {
  commitHistory()
  doc.frames = [newFrame()]
  doc.cur = 0
  doc.selId = ''
  nextTick(drawPreview)
}
function addFrame() {
  commitHistory()
  doc.frames.push(newFrame())
  doc.cur = doc.frames.length - 1
  doc.selId = ''
  nextTick(drawPreview)
}
function delFrame(i) {
  commitHistory()
  if (doc.frames.length <= 1) { doc.frames[0].layers = []; doc.selId = ''; return nextTick(drawPreview) }
  doc.frames.splice(i, 1)
  doc.cur = Math.max(0, Math.min(doc.frames.length - 1, doc.cur))
  doc.selId = ''
  nextTick(drawPreview)
}
function moveFrame(i, d) {
  commitHistory()
  const j = i + d
  if (j < 0 || j >= doc.frames.length) return
  const [f] = doc.frames.splice(i, 1); doc.frames.splice(j, 0, f)
  doc.cur = j
  nextTick(drawPreview)
}
function delLayer(id) {
  commitHistory()
  const f = curFrame.value; if (!f) return
  f.layers = f.layers.filter(l => l.id !== id)
  if (doc.selId === id) doc.selId = ''
  nextTick(drawPreview)
}
function moveLayer(id, d) {
  commitHistory()
  const f = curFrame.value; if (!f) return
  const i = f.layers.findIndex(l => l.id === id); if (i < 0) return
  const j = i + d; if (j < 0 || j >= f.layers.length) return
  const [l] = f.layers.splice(i, 1); f.layers.splice(j, 0, l)
  nextTick(drawPreview)
}
function layerName(l) {
  if (!l) return ''
  if (l.kind === 'text') return `文字「${l.text || ''}」`
  const a = state.assets.find(x => x.id === l.assetId)
  return (a?.name || '图片') + (l.frame != null ? ` #${l.frame + 1}` : '')
}
function frameThumb(f) {
  const l = f.layers.find(x => x.kind === 'image')
  const a = l && state.assets.find(x => x.id === l.assetId)
  return a?.src || ''
}

/* ---------- 绘制 ---------- */
function imageFor(l) {
  const a = state.assets.find(x => x.id === l.assetId)
  if (!a) return null
  if (l.frame != null) {
    const c = fontCells(a)?.[l.frame]
    return c ? { img: c.canvas, w: c.canvas.width, h: c.canvas.height } : null
  }
  const img = getAssetImage(a)
  return img ? { img, w: Math.max(1, a.w), h: Math.max(1, a.h) } : null
}
function drawLayer(ctx, l, alpha = 1, ox = 0, oy = 0) {
  if (!l || l.visible === false) return
  ctx.globalAlpha = alpha
  if (l.kind === 'text') {
    const c = textCanvas(l)
    if (c) ctx.drawImage(c, ox + l.x, oy + l.y, l.w || c.width, l.h || c.height)
  } else {
    const s = imageFor(l)
    if (s?.img && s.img.complete !== false) ctx.drawImage(s.img, ox + l.x, oy + l.y, l.w || s.w, l.h || s.h)
  }
  ctx.globalAlpha = 1
}
function drawFrame(ctx, frame, alpha = 1, ox = 0, oy = 0) {
  if (!frame) return
  for (const l of frame.layers) drawLayer(ctx, l, alpha, ox, oy)
}
function drawPreview() {
  const el = cv.value
  if (!el) return
  const ctx = el.getContext('2d')
  const W = viewW.value, H = viewH.value
  const x0 = PAD, y0 = PAD, x1 = PAD + doc.w, y1 = PAD + doc.h
  ctx.clearRect(0, 0, W, H)
  /* 存储框之外压暗: 素材可以拖到框外 (自动尺寸会按它们的外接矩形扩大框) */
  ctx.fillStyle = 'rgba(0,0,0,.38)'
  ctx.fillRect(0, 0, W, y0)
  ctx.fillRect(0, y1, W, H - y1)
  ctx.fillRect(0, y0, x0, doc.h)
  ctx.fillRect(x1, y0, W - x1, doc.h)
  /* 预览默认 RGB565; 勾了「预览跟随格式」且导出格式是 GRAY 时才做灰度预览 */
  const grayPreview = !!state.ui.previewFollowFmt && doc.fmt === 'GRAY'
  if (grayPreview) ctx.filter = 'grayscale(1)'
  /* 多帧叠加: 只有勾了「叠加」的其它帧才画, 当前帧单独透明度; 全部仅预览 */
  doc.frames.forEach((f, i) => {
    if (i === doc.cur) return
    if (f.preview) drawFrame(ctx, f, Math.min(1, Math.max(0, (doc.overlay ?? 35) / 100)), PAD, PAD)
  })
  drawFrame(ctx, curFrame.value, Math.min(1, Math.max(0.1, (doc.alpha ?? 100) / 100)), PAD, PAD)
  if (grayPreview) ctx.filter = 'none'
  /* 存储框 (整组导出的范围) */
  ctx.save()
  ctx.strokeStyle = '#4fc3f7'
  ctx.lineWidth = 1
  ctx.setLineDash([6, 4])
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(1, doc.w) - 1, Math.max(1, doc.h) - 1)
  ctx.setLineDash([])
  ctx.fillStyle = '#4fc3f7'
  ctx.font = '10px sans-serif'
  ctx.fillText(`存储框 ${doc.w}×${doc.h}`, x0 + 2, y0 - 5)
  const l = selLayer.value
  if (l && l.visible !== false) {
    ctx.strokeStyle = '#ffd166'
    ctx.setLineDash([4, 3])
    ctx.strokeRect(PAD + Math.round(l.x) + 0.5, PAD + Math.round(l.y) + 0.5, Math.max(1, Math.round(l.w)) - 1, Math.max(1, Math.round(l.h)) - 1)
  }
  ctx.restore()
}
watch(() => JSON.stringify({
  cur: doc.cur, w: doc.w, h: doc.h, overlay: doc.overlay, alpha: doc.alpha, sel: doc.selId,
  img: state._imgTick, frames: doc.frames,
}), () => nextTick(drawPreview), { immediate: true })
watch(show, (v) => { if (v) reset(); else stop() })

/* ---------- 拖动 / 缩放 ---------- */
function canvasPt(e) {
  const r = cv.value?.getBoundingClientRect()
  if (!r) return { x: 0, y: 0 }
  return { x: (e.clientX - r.left) / doc.zoom - PAD, y: (e.clientY - r.top) / doc.zoom - PAD }
}
function hitLayer(x, y) {
  const list = curLayers.value
  for (let i = list.length - 1; i >= 0; i--) {
    const l = list[i]
    if (l.visible === false) continue
    if (x >= l.x && x < l.x + l.w && y >= l.y && y < l.y + l.h) return l
  }
  return null
}
function onCanvasDbl(e) {
  const p = canvasPt(e)
  const l = hitLayer(p.x, p.y)
  if (l?.kind === 'text') openTextEditor(l)
}
function onDown(e) {
  const p = canvasPt(e)
  const l = hitLayer(p.x, p.y)
  if (!l) { doc.selId = ''; return }
  commitHistory()
  doc.selId = l.id
  drag = { l, dx: p.x - l.x, dy: p.y - l.y }
  cv.value?.setPointerCapture?.(e.pointerId)
  e.preventDefault()
}
function onMove(e) {
  if (!drag) return
  const p = canvasPt(e)
  const l = drag.l
  l.x = Math.round(Math.max(-PAD, Math.min(doc.w + PAD - l.w, p.x - drag.dx)))
  l.y = Math.round(Math.max(-PAD, Math.min(doc.h + PAD - l.h, p.y - drag.dy)))
  drawPreview()
}
function onUp(e) {
  drag = null
  cv.value?.releasePointerCapture?.(e.pointerId)
}
function clampSize() {
  /* 只改存储框; 素材可以留在框外 (预览里压暗区), 「自动设置尺寸」再按外接矩形收框 */
  doc.w = Math.max(1, Math.min(4096, Math.round(+doc.w || 1)))
  doc.h = Math.max(1, Math.min(4096, Math.round(+doc.h || 1)))
  fitZoom()
}
function clampLayer() {
  const l = selLayer.value
  if (l) {
    l.w = Math.max(1, Math.min(4096, Math.round(l.w || 1)))
    l.h = Math.max(1, Math.min(4096, Math.round(l.h || 1)))
    /* 允许放到存储框外 (最多一圈 PAD), 用「自动设置尺寸」把框收成外接矩形 */
    l.x = Math.round(Math.max(-PAD, Math.min(doc.w + PAD - l.w, +l.x || 0)))
    l.y = Math.round(Math.max(-PAD, Math.min(doc.h + PAD - l.h, +l.y || 0)))
  }
  nextTick(drawPreview)
}
function autoSize() {
  commitHistory()
  /* 按所有帧里**可见素材的外接矩形**定存储框:
   * 左上角一张 + 右下角一张 → 框就是两张的并集 (用户说的"全屏")。
   * 框可能不在原点 → 整体平移回去, 保证导出的帧从 0,0 开始。 */
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const f of doc.frames) for (const l of f.layers) {
    if (l.visible === false) continue
    minX = Math.min(minX, l.x); minY = Math.min(minY, l.y)
    maxX = Math.max(maxX, l.x + l.w); maxY = Math.max(maxY, l.y + l.h)
  }
  if (!Number.isFinite(minX)) return
  const w = Math.max(1, Math.round(maxX - minX))
  const h = Math.max(1, Math.round(maxY - minY))
  for (const f of doc.frames) for (const l of f.layers) {
    l.x = Math.round(l.x - minX); l.y = Math.round(l.y - minY)
  }
  doc.w = w; doc.h = h
  fitZoom()
}
function step(d) {
  if (!doc.frames.length) return
  doc.cur = (doc.cur + d + doc.frames.length) % doc.frames.length
  doc.selId = ''
  nextTick(drawPreview)
}
function toggle() {
  if (playing.value) return stop()
  if (doc.frames.length < 2) return
  playing.value = true
  timer = setInterval(() => step(1), 250)
}
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(fr.result)
    fr.onerror = rej
    fr.readAsDataURL(blob)
  })
}
function imageSize(src) {
  return new Promise((res) => {
    const i = new Image()
    i.onload = () => res({ w: i.naturalWidth || i.width, h: i.naturalHeight || i.height })
    i.onerror = () => res({ w: 1, h: 1 })
    i.src = src
  })
}
function showPasteMsg(msg) {
  pasteMsg.value = msg
  clearTimeout(pasteTimer)
  pasteTimer = setTimeout(() => { pasteMsg.value = '' }, 1600)
}
async function pastePayload(p) {
  if (!p) return false
  commitHistory()
  const frame = ensureFrame()
  /* 粘贴 = **新建一个图层**。复制过来的参数 (字体/字号/光晕/颜色…) 只用来初始化新层;
   * 不复制原图层的 id/名字, 也不覆盖已有图层。 */
  if (p.kind === 'text') {
    const style = p.params?.kind === 'text' ? { ...p.params } : {}
    delete style.kind
    const l = {
      id: nid('l'), kind: 'text', source: 'system',
      text: String(p.text || style.text || '文字'),
      family: style.family || p.family || DEFAULT_FONT,
      size: Math.max(4, Math.min(200, Math.round(+(style.size ?? p.size) || 24))),
      bold: !!(style.bold ?? p.bold), color: (style.color ?? p.color ?? 0xFFFF) & 0xFFFF,
      weight: Math.max(100, Math.min(900, Math.round(+(style.weight) || 400))),
      spacing: Math.round(+(style.spacing) || 0), offsetY: Math.round(+(style.offsetY) || 0),
      lineGap: Math.round(+(style.lineGap) || 0),
      rampSigma: Math.max(0, Math.min(2, +(style.rampSigma) || 0)),
      glowThresh: Math.max(0, Math.min(255, Math.round(+(style.glowThresh) || 40))),
      glowSigma: Math.max(0, Math.min(12, +(style.glowSigma) || 0)),
      glowGain: Math.max(0, Math.min(4, +(style.glowGain) || 1)),
      glowFit: !!style.glowFit,
      x: 0, y: 0, w: 1, h: 1, visible: true,
    }
    refreshText(l)
    centerLayer(l)
    frame.layers.push(l)
    doc.selId = l.id
    nextTick(() => { drawPreview(); fitZoom() })
    showPasteMsg('已粘贴新文字层')
    return true
  }
  if (p.dataURL) {
    const a = addBitmapAsset('paste_' + Date.now().toString(36), p.dataURL, p.w, p.h)
    if (!a) return false
    const l = {
      id: nid('l'), kind: 'image', assetId: a.id, frame: null,
      w: a.w, h: a.h, x: 0, y: 0, visible: true,
    }
    centerLayer(l)
    frame.layers.push(l)
    doc.selId = l.id
    nextTick(() => { drawPreview(); fitZoom() })
    showPasteMsg('已粘贴新图片层')
    return true
  }
  return false
}
async function pasteClipboard() {
  try {
    const p = await readClipboardObject()
    if (p) return await pastePayload(p)
    showPasteMsg('剪贴板里没有可粘贴的对象')
  } catch (e) { showPasteMsg('粘贴失败') }
  return false
}
let pasteEventAt = 0
async function doPasteEvent(e) {
  if (!show.value || textTarget.value) return
  const ae = document.activeElement
  if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable)) return
  const cd = e.clipboardData
  if (!cd) return
  e.preventDefault()
  if (Date.now() - pasteEventAt < 300) return
  pasteEventAt = Date.now()
  /* 1) 本应用的 JSON (可保留文字语义) */
  const txt = cd.getData('text/plain')
  if (txt) {
    try {
      const p = JSON.parse(txt)
      if (p?.__lcdLayer) { await pastePayload(p); return }
    } catch (err) { /* 普通文本 */ }
    if (txt.trim() && !/^https?:\/\//i.test(txt.trim())) {
      await pastePayload({ kind: 'text', text: txt, family: DEFAULT_FONT, size: 24, bold: false, color: 0xFFFF })
      return
    }
  }
  /* 2) 图片 (系统截图 / 其它网页复制的图片) */
  const item = [...(cd.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'))
  const file = item?.getAsFile?.() || [...(cd.files || [])].find(f => f.type.startsWith('image/'))
  if (file) {
    const dataURL = await blobToDataURL(file)
    const sz = await imageSize(dataURL)
    await pastePayload({ kind: 'image', name: file.name || 'paste', dataURL, w: sz.w, h: sz.h })
    return
  }
  /* 3) 浏览器只给自定义 MIME / 读 API 兜底 */
  pasteClipboard()
}
function onGroupKey(e) {
  if (!show.value || textTarget.value) return
  const ae = document.activeElement
  if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable)) return
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  const key = e.key.toLowerCase()
  if (key === 'z') {
    e.preventDefault()
    if (e.shiftKey) redoBoard(); else undoBoard()
    return
  }
  if (key === 'y') { e.preventDefault(); redoBoard(); return }
  if (key !== 'v') return
  /* 优先让 paste 事件同步拿 clipboardData; 120ms 内没来再走 read API */
  setTimeout(() => { if (Date.now() - pasteEventAt > 200) pasteClipboard() }, 120)
}
watch(historySignature, () => {
  if (!show.value || suspendHistory) return
  clearTimeout(historyTimer)
  historyTimer = setTimeout(commitHistory, 350)
})
if (typeof window !== 'undefined') {
  window.addEventListener('paste', doPasteEvent)
  window.addEventListener('keydown', onGroupKey)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('beforeunload', onPageHide)
}
function onUnmount() {
  clearTimeout(historyTimer)
  stop()
  if (typeof window !== 'undefined') {
    window.removeEventListener('paste', doPasteEvent)
    window.removeEventListener('keydown', onGroupKey)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('beforeunload', onPageHide)
  }
}
onBeforeUnmount(onUnmount)

/* ---------- 输出 ---------- */
function frameCanvas(frame, fmt = 'RGB565') {
  const c = document.createElement('canvas')
  c.width = doc.w; c.height = doc.h
  const ctx = c.getContext('2d')
  drawFrame(ctx, frame, 1)
  if (fmt === 'GRAY') {
    /* 图片下载按导出格式来: 多帧 GRAY 按纯白亮度 (max 通道) 出图, 不把预览颜色/光晕染色带出去 */
    const img = ctx.getImageData(0, 0, c.width, c.height)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue
      /* 与多帧素材导出口径一致: 按最大通道保留彩色内容的亮度, 不压成 luma 灰 */
      const g = Math.round(Math.max(d[i], d[i + 1], d[i + 2]) * (d[i + 3] / 255))
      d[i] = d[i + 1] = d[i + 2] = g
    }
    ctx.putImageData(img, 0, 0)
  }
  return c
}
function stripCanvas() {
  const n = doc.frames.length
  if (!n) return null
  const c = document.createElement('canvas')
  c.width = doc.w * n; c.height = doc.h
  const ctx = c.getContext('2d')
  for (let i = 0; i < n; i++) ctx.drawImage(frameCanvas(doc.frames[i]), i * doc.w, 0)
  return c
}
function downloadPreview() {
  /* 格式 = 导出格式: RGB565 出彩色, GRAY 出纯灰度; 残影/选框/预览透明度不导出 */
  const c = frameCanvas(curFrame.value, doc.fmt)
  downloadCanvasPng(imageFileName('framegroup', doc.name, c.width, c.height), c)
}
function dumpDoc() {
  return {
    w: doc.w, h: doc.h, overlay: doc.overlay, alpha: doc.alpha,
    frames: doc.frames.map(f => ({ id: f.id, preview: !!f.preview, layers: f.layers.map(l => ({ ...l })) })),
  }
}
async function buildAsset() {
  if (!doc.frames.length) return null
  const strip = stripCanvas()
  if (!strip) return null
  const n = doc.frames.length
  const res = saveFrameAsset(doc.assetId, {
    name: (doc.name || 'frames').trim(),
    src: strip.toDataURL('image/png'),
    w: strip.width, h: strip.height,
    font: { glyphW: doc.w, glyphH: doc.h, charset: 'frames', dir: 'col', frames: n },
    frameGroupDoc: dumpDoc(),
    defaultFmt: doc.fmt,
  })
  doc.assetId = res.asset.id
  lastSavedSig.value = docSignature()
  return res
}
async function place() {
  if (busy.value) return
  busy.value = '生成中…'
  try {
    const wasExisting = hasInstances.value
    const res = await buildAsset()
    if (!res) return
    if (!wasExisting) {
      const inst = addInstance(res.asset.id, screen.value.w / 2, screen.value.h / 2)
      if (inst) updateInstance(inst.id, { fmt: doc.fmt, frame: 0, allFrames: true })
    } else {
      /* 编辑已有组: 格式/全帧导出选择也同步到引用它的图层 */
      for (const inst of state.instances.filter(i => i.assetId === res.asset.id)) {
        updateInstance(inst.id, { fmt: doc.fmt, allFrames: true })
      }
    }
    close()
  } finally { busy.value = '' }
}
async function toLibrary() {
  if (busy.value) return
  busy.value = '生成中…'
  try { await buildAsset(); close() } finally { busy.value = '' }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="mask" @click.self="close">
      <div class="dialog panel fgd">
        <div class="panel-title">
          多帧画板
          <span class="tag mono">{{ doc.frames.length }} 帧 · {{ doc.w }}×{{ doc.h }}</span>
          <span class="grow"></span>
          <button class="mini" :disabled="!canUndo" @click="undoBoard" title="撤回 (Ctrl+Z)">↶</button>
          <button class="mini" :disabled="!canRedo" @click="redoBoard" title="重做 (Ctrl+Shift+Z / Ctrl+Y)">↷</button>
          <button @click="close">×</button>
        </div>

        <div class="fgd-body">
          <!-- 左: 素材 -->
          <div class="fgd-left">
            <div class="sec">素材 <span class="dim">(单击加到当前帧)</span></div>
            <div class="src-list">
              <div v-for="a in sources" :key="a.id" class="src" :title="`${a.name} ${a.w}×${a.h}`" @click="addAsset(a)">
                <img :src="(a.font && fontPreviewSrc(a)) || a.src" />
                <span>{{ a.name }}</span>
                <span class="dim">{{ a.w }}×{{ a.h }}</span>
              </div>
              <div v-if="!sources.length" class="dim empty">还没有图片素材<br />先「导入图片」</div>
            </div>
            <button class="primary wide" @click="fileInput.click()">＋ 导入图片…</button>
            <button class="wide" @click="addText">＋ 文字</button>
            <input ref="fileInput" type="file" accept="image/*,.svg" multiple hidden @change="onFiles" />
            <div class="dim note">多帧素材一次加入它的所有帧; 普通图加到当前帧, 可叠多张。</div>
          </div>

          <!-- 中: 预览 + 尺寸/导出设置 -->
          <div class="fgd-center">
            <div class="stage-head">
              <span class="sec">预览</span>
              <span class="grow"></span>
              <label class="chk" title="勾了「叠加」的其它帧用这个透明度画; 只影响预览">叠加帧
                <input type="range" min="5" max="100" step="5" v-model.number="doc.overlay" style="width: 58px" />
                <span class="mono">{{ doc.overlay }}%</span>
              </label>
              <label class="chk" title="当前帧预览透明度; 只影响预览, 不影响导出">当前帧
                <input type="range" min="10" max="100" step="5" v-model.number="doc.alpha" style="width: 54px" />
                <span class="mono">{{ doc.alpha }}%</span>
              </label>
              <button class="mini" @click="setZoom(1)">1x</button>
              <button class="mini" @click="setZoom(2)">2x</button>
              <button class="mini" @click="setZoom(4)">4x</button>
              <button class="mini" @click="fitZoom">适应</button>
            </div>
            <div ref="stageEl" class="stage-wrap">
              <div class="stage" :style="{ width: viewW * scale + 'px', height: viewH * scale + 'px' }">
                <canvas ref="cv" :width="viewW" :height="viewH"
                  :style="{ width: viewW * scale + 'px', height: viewH * scale + 'px' }"
                  @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @dblclick="onCanvasDbl"></canvas>
              </div>
            </div>
            <div class="ctrl">
              <button class="mini" @click="step(-1)">◀</button>
              <button class="mini play" @click="toggle">{{ playing ? '⏸' : '▶' }}</button>
              <button class="mini" @click="step(1)">▶</button>
              <span class="mono">{{ doc.frames.length ? (doc.cur + 1) + '/' + doc.frames.length : '0/0' }}</span>
              <input class="range" type="range" min="0" :max="Math.max(0, doc.frames.length - 1)" step="1" v-model.number="doc.cur" />
            </div>

            <div class="docbar">
              <div class="row">
                <label>画布 W <input class="mono" type="number" min="1" max="4096" v-model.number="doc.w" @change="clampSize" /></label>
                <label>H <input class="mono" type="number" min="1" max="4096" v-model.number="doc.h" @change="clampSize" /></label>
                <button class="mini" @click="autoSize" title="存储框改成所有帧里可见素材的外接矩形 (左上角 + 右下角两张图 = 整个外接范围)">自动设置尺寸</button>
              </div>
              <div class="row">
                <label>名称 <input class="mono" v-model="doc.name" style="width: 140px" /></label>
                <label>格式
                  <select v-model="doc.fmt">
                    <option value="RGB565">RGB565</option>
                    <option value="GRAY">GRAY (8bit)</option>
                  </select>
                </label>
                <label class="chk" title="不勾: 预览始终 RGB565; 勾选: GRAY 时预览也按灰度显示 (只影响预览)">
                  <input type="checkbox" v-model="state.ui.previewFollowFmt" />预览跟随格式</label>
                <span class="grow"></span>
                <button @click="downloadPreview" title="按当前画布和导出格式 (RGB565/GRAY) 存当前帧 PNG; 残影/选框/预览透明度不导出">⤓ 图片下载</button>
              </div>
              <div class="row">
                <span class="dim">放到屏幕后默认导出所有帧; 不要全帧可在图层 ⚙ 里取消。</span>
                <span v-if="pasteMsg" class="tag" style="color: var(--ok); border-color: var(--ok)">{{ pasteMsg }}</span>
                <span class="tag" style="color: var(--text-dim)"
                  title="不点「加入素材库」也会在关闭画板/关闭页面时自动保存">关闭时自动保存</span>
                <span class="grow"></span>
                <button @click="toLibrary" :disabled="!doc.frames.length || !!busy">加入素材库</button>
                <button class="primary" @click="place" :disabled="!doc.frames.length || !!busy">
                  {{ busy || (hasInstances ? '保存修改' : '放到屏幕') }}
                </button>
              </div>
            </div>
          </div>

          <!-- 右: 帧表 + 图层表 -->
          <div class="fgd-right">
            <div class="sec">帧顺序 <span class="grow"></span>
              <button class="mini" title="所有帧都在预览里叠加显示" @click="doc.frames.forEach(f => f.preview = true)">全部叠加</button>
              <button class="mini" title="只显示当前帧" @click="doc.frames.forEach(f => f.preview = false)">只当前</button>
              <button class="mini" @click="addFrame">＋ 帧</button>
              <button class="mini" :disabled="!doc.frames.length" @click="clearFrames">清空</button>
            </div>
            <div class="frame-list">
              <div v-for="(f, i) in doc.frames" :key="f.id" class="frow"
                :class="{ on: i === doc.cur, 'ghost-on': f.preview && i !== doc.cur }"
                @click="doc.cur = i; doc.selId = ''">
                <label class="ghost" :class="{ on: f.preview }" @click.stop
                  title="叠加到预览里, 方便和当前帧对齐; 只影响预览, 各帧仍独立导出">
                  <input type="checkbox" v-model="f.preview" />叠加
                </label>
                <span class="mono idx">#{{ i + 1 }}</span>
                <img v-if="frameThumb(f)" :src="frameThumb(f)" />
                <span v-else class="tbox">T</span>
                <span class="lab">{{ f.layers.length }} 层</span>
                <button class="mini" title="上移" :disabled="i === 0" @click.stop="moveFrame(i, -1)">↑</button>
                <button class="mini" title="下移" :disabled="i === doc.frames.length - 1" @click.stop="moveFrame(i, 1)">↓</button>
                <button class="mini danger" title="删除这一帧" @click.stop="delFrame(i)">✕</button>
              </div>
            </div>

            <div class="sec">当前帧图层 <span class="grow"></span>
              <button class="mini" @click="addText">＋ 文字</button>
            </div>
            <div class="layer-list">
              <div v-for="(l, i) in curLayers" :key="l.id" class="lrow" :class="{ on: l.id === doc.selId }" @click="doc.selId = l.id" @dblclick.stop="openTextEditor(l)">
                <input type="checkbox" v-model="l.visible" @click.stop title="显示/隐藏 (隐藏不导出)" />
                <span class="tag">{{ l.kind === 'text' ? '文' : '图' }}</span>
                <span class="lab">{{ layerName(l) }}</span>
                <button class="mini" :disabled="i === 0" @click.stop="moveLayer(l.id, -1)">↑</button>
                <button class="mini" :disabled="i === curLayers.length - 1" @click.stop="moveLayer(l.id, 1)">↓</button>
                <button class="mini danger" @click.stop="delLayer(l.id)">✕</button>
              </div>
              <div v-if="!curLayers.length" class="dim empty">当前帧是空的<br />左侧点图片或「＋文字」</div>
            </div>

            <div v-if="selLayer" class="props">
              <div class="row" v-if="selLayer.kind === 'text'">
                <span class="dim">双击文字层 / 画布上的文字打开文字编辑面板</span>
                <span class="grow"></span>
                <button class="mini" @click="openTextEditor(selLayer)">编辑文字…</button>
              </div>
              <div class="row">
                <label>X <input class="mono" type="number" v-model.number="selLayer.x" @change="clampLayer" /></label>
                <label>Y <input class="mono" type="number" v-model.number="selLayer.y" @change="clampLayer" /></label>
                <label>W <input class="mono" type="number" min="1" v-model.number="selLayer.w" @change="clampLayer" /></label>
                <label>H <input class="mono" type="number" min="1" v-model.number="selLayer.h" @change="clampLayer" /></label>
              </div>
            </div>
            <div class="dim note">拖动素材可放到存储框外 (预览压暗区); 「自动设置尺寸」按所有可见素材的外接矩形收框。叠加帧只影响预览, 各帧数据仍独立。Ctrl+V 会新建一个图层 (文字层带复制来的样式参数)。</div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
  <TextDialog v-if="textTarget" :group-layer="textTarget" :group-open="true"
    @group-apply="applyGroupText" @group-close="textTarget = null" />
</template>

<style scoped>
.mask { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, .6); display: flex; align-items: flex-start; justify-content: center; padding-top: 2.5vh; }
.fgd { width: min(1180px, 97vw); height: min(800px, 94vh); display: flex; flex-direction: column; }
.fgd-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 210px minmax(0, 1fr) 300px; gap: 10px; padding: 10px; }
.fgd-left, .fgd-center, .fgd-right { min-height: 0; display: flex; flex-direction: column; gap: 6px; }
.fgd-left { border-right: 1px solid var(--border); padding-right: 10px; }
.fgd-center { min-width: 0; }
.fgd-right { border-left: 1px solid var(--border); padding-left: 10px; overflow-y: auto; }
.sec { font-size: 11px; color: var(--text-dim); display: flex; align-items: center; gap: 6px; margin: 2px 0; }
.sec .grow { flex: 1; }
.src-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 4px; }
.src { display: flex; align-items: center; gap: 6px; padding: 3px 5px; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
.src:hover { border-color: var(--accent); background: rgba(90, 160, 255, .08); }
.src img { width: 28px; height: 28px; object-fit: contain; image-rendering: pixelated; background: #111; border-radius: 3px; }
.src span:nth-child(2) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.wide { width: 100%; }
.stage-head { display: flex; align-items: center; gap: 5px; flex: none; }
.stage-wrap { flex: 1; min-height: 120px; overflow: auto; display: block; border: 1px solid var(--border); border-radius: 4px; background: #151515; }
.stage { position: relative; margin: 8px auto; background-color: #151515;
  background-image: linear-gradient(45deg, #202020 25%, transparent 25%, transparent 75%, #202020 75%),
                    linear-gradient(45deg, #202020 25%, transparent 25%, transparent 75%, #202020 75%);
  background-size: 12px 12px; background-position: 0 0, 6px 6px; }
.stage canvas { display: block; image-rendering: pixelated; cursor: move; touch-action: none; }
.ctrl { display: flex; align-items: center; gap: 5px; justify-content: center; font-size: 11px; flex: none; }
.ctrl .play { color: var(--accent); min-width: 24px; }
.range { flex: 1; max-width: 260px; accent-color: var(--accent); }
.docbar { flex: none; border-top: 1px solid var(--border); padding-top: 5px; display: flex; flex-direction: column; gap: 4px; font-size: 11px; }
.docbar .row { display: flex; align-items: center; gap: 7px; }
.docbar input[type=number] { width: 62px; }
.frame-list { flex: none; max-height: 180px; min-height: 70px; overflow: auto; display: flex; flex-direction: column; gap: 3px; }
.frow, .lrow { display: flex; align-items: center; gap: 4px; padding: 2px 4px; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
.frow.on, .lrow.on { border-color: var(--accent); background: rgba(90, 160, 255, .08); }
.frow.ghost-on { border-style: dashed; }
.frow .ghost { display: flex; align-items: center; gap: 2px; font-size: 9px; color: var(--text-dim); cursor: pointer; flex: 0 0 auto; }
.frow .ghost.on { color: var(--accent); }
.frow img { width: 26px; height: 22px; object-fit: contain; image-rendering: pixelated; background: #111; }
.frow .tbox { width: 26px; height: 22px; display: grid; place-items: center; background: #222; color: var(--text-dim); font-size: 10px; border-radius: 3px; }
.frow .idx { width: 28px; color: var(--text-dim); font-size: 10px; }
.frow .lab, .lrow .lab { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.layer-list { flex: 1; min-height: 60px; overflow: auto; display: flex; flex-direction: column; gap: 3px; }
.props { flex: none; border-top: 1px solid var(--border); padding-top: 5px; display: flex; flex-direction: column; gap: 4px; font-size: 11px; }
.props .row { display: flex; align-items: center; gap: 5px; }
.props input[type=number] { width: 48px; }
.props .grow { flex: 1; }
.props .grow input { width: 100%; }
.empty { padding: 14px 6px; text-align: center; line-height: 1.8; }
.danger { color: var(--danger, #f66); }
.chk { display: flex; align-items: center; gap: 3px; }
</style>
