<script setup>
import { ref, computed, watchEffect, watch, onMounted, onBeforeUnmount } from 'vue'
import { paintFrame } from '../frameshoot.js'
import { roundGeom, forEachOutsidePixel } from '../roundscreen.js'
import { rgb565To888 } from '../colors.js'
import {
  state, screen, instanceProc, frameLayers, addInstance, addAssetFile, addTextInstance,
  updateInstance, removeInstance, duplicateInstance, zorder, paintRect,
  hitInstance, inPaintBox, undo, redo, visibleInstances,
} from '../store.js'

const wrapEl = ref(null)
const canvasEl = ref(null)
const zoomRef = ref(2)
const cursor = ref(null) // {x,y}

const sc = screen

const zoom = computed(() => {
  /* 老工程/本地存过的分数缩放 (1.25x 之类) 也在这里归一, 免得一进来就是重采样画面 */
  return snapZoom(state.ui.zoom > 0 ? state.ui.zoom : zoomRef.value)
})

/* ---- 缩放必须让"1 个屏幕像素 = 整数个设备像素" ----
 * 画布是 sc.w×sc.h 的**逐像素**位图 (1 画布 px = 1 屏幕 px, 与固件逐像素对拍过),
 * 靠 CSS 放大显示。缩放不是整数倍时, 浏览器的放大用一个源像素顶 1 个还是 2 个显示像素
 * 会来回跳 —— 环带边缘那圈 2px 的 AA 就看着像"锯齿"; 放大到整数倍锯齿立刻消失 (用户现场)。
 * 所以:
 *   · CSS 缩放按 devicePixelRatio 归一: zoom*dpr 取整数 (dpr=1 → 整数倍; dpr=1.25 → 0.8/1.6/2.4…)
 *   · 档位只在"设备像素倍率"上走 (1,2,3…24), 不再有 1/4 步进的 1.25x/1.75x
 * 画布另有 image-rendering: pixelated 兜底 (nearest, 不糊)。 */
/* devicePixelRatio 会随**浏览器缩放**变 (125% → 1.25, 150% → 1.5), 用户中途按 Ctrl+滚轮
 * 就会变 —— 所以取实时值 (响应式), 别在 setup 里存死。 */
function curDpr() { return Math.max(1, Number(globalThis.devicePixelRatio) || 1) }
const dpr = ref(curDpr())
const zoomLabel = computed(() => {
  const z = zoom.value
  const n = z * dpr.value
  const txt = Number.isInteger(z) ? String(z) : z.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return { txt, dev: Math.round(n * 100) / 100, crisp: Math.abs(n - Math.round(n)) < 1e-6 }
})
function snapZoom(z) {
  const d = dpr.value
  const n = Math.max(1, Math.round(z * d))        /* 每个屏幕像素占几个设备像素 */
  return n / d
}
function autoFit() {
  const el = wrapEl.value
  if (!el) return
  const z = Math.min((el.clientWidth - 90) / sc.value.w, (el.clientHeight - 90) / sc.value.h)
  zoomRef.value = snapZoom(Math.max(0.5, z))      /* 取整到设备像素倍率 (可能略小于可用空间) */
}

let ro
/* 浏览器缩放 (Ctrl+滚轮 / 菜单里的 100%→125%) 会让 devicePixelRatio 变: 变了就重新归一,
 * 否则"整数倍"又变成分数, 环带 AA 立刻又出锯齿 */
function onWinResize() {
  const d = curDpr()
  if (d === dpr.value) return
  dpr.value = d
  zoomRef.value = snapZoom(zoomRef.value)
  if (state.ui.zoom > 0) state.ui.zoom = snapZoom(state.ui.zoom)
}
onMounted(() => {
  // 拖拽中不重新自适应: 缩放变化会隐藏覆盖层, 浏览器随即 pointercancel 中断拖拽
  ro = new ResizeObserver(() => { tick.value++; if (state.ui.zoom === 0 && !dragState.inst) autoFit() })
  ro.observe(wrapEl.value)
  window.addEventListener('resize', onWinResize)
  autoFit()
})
onBeforeUnmount(() => { ro?.disconnect(); window.removeEventListener('resize', onWinResize) })

/* ---- 覆盖层: 与画布位置同步 (scroll/resize/响应式变化时重算) ---- */
const tick = ref(0)
const ovVisible = ref(true)
const offscreenInsts = computed(() => visibleInstances.value.filter(i => overlapRatio(i) < 0.25))

// 缩放/屏幕尺寸变化: 先隐藏覆盖层, 布局稳定后重算位置再显示 (防止位置错乱)
// 拖拽中直接跳过: 隐藏覆盖层会让浏览器 pointercancel 掉正在进行的拖拽
watch(() => [zoom.value, sc.value.w, sc.value.h], () => {
  if (dragState.inst) return
  ovVisible.value = false
  requestAnimationFrame(() => requestAnimationFrame(() => {
    tick.value++
    ovVisible.value = true
  }))
})

function ovOrigin() {
  void tick.value
  const cv = canvasEl.value, wrap = wrapEl.value
  if (!cv || !wrap) return { ox: 0, oy: 0, vw: 0, vh: 0 }
  const cr = cv.getBoundingClientRect(), wr = wrap.getBoundingClientRect()
  return { ox: cr.left - wr.left, oy: cr.top - wr.top, vw: wr.width, vh: wr.height }
}

/* 实例实际绘制矩形: 由 store 统一给出 (与 render 的 drawImage 完全一致) */
function ovStyle(inst) {
  const o = ovOrigin()
  const r = paintRect(inst)
  return {
    left: o.ox + r.x * zoom.value + 'px',
    top: o.oy + r.y * zoom.value + 'px',
    width: r.w * zoom.value + 'px',
    height: r.h * zoom.value + 'px',
  }
}

/* 胶囊位置: 实例中心, 限制在舞台可视区内且推到显示区域外 */
function badgePos(inst) {
  const o = ovOrigin()
  const r = paintRect(inst)
  const fw = sc.value.w * zoom.value, fh = sc.value.h * zoom.value
  let cx = o.ox + (r.x + r.w / 2) * zoom.value
  let cy = o.oy + (r.y + r.h / 2) * zoom.value
  cx = Math.max(16, Math.min(o.vw - 16, cx))
  cy = Math.max(16, Math.min(o.vh - 16, cy))
  const inFrame = cx > o.ox + 6 && cx < o.ox + fw - 6 && cy > o.oy + 6 && cy < o.oy + fh - 6
  if (inFrame) {
    const dl = cx - o.ox, dr = o.ox + fw - cx, dt = cy - o.oy, db = o.oy + fh - cy
    const m = Math.min(dl, dr, dt, db)
    if (m === dl) cx = o.ox - 22
    else if (m === dr) cx = o.ox + fw + 22
    else if (m === dt) cy = o.oy - 22
    else cy = o.oy + fh + 22
    cx = Math.max(16, Math.min(o.vw - 16, cx))
    cy = Math.max(16, Math.min(o.vh - 16, cy))
  }
  return { left: cx + 'px', top: cy + 'px' }
}

function beginDrag(inst, e) {
  state.ui.selectedId = inst.id
  dragState.inst = inst
  dragState.sx = e.clientX; dragState.sy = e.clientY
  dragState.ox = inst.x; dragState.oy = inst.y
  dragInstId.value = inst.id        /* 对齐参考线: 拖拽期间显示 */
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragUp)
  window.addEventListener('pointercancel', onDragUp)
}

function ovDown(e, inst, force = false) {
  e.preventDefault()
  e.stopPropagation()
  if (inst.locked) return   // 锁定: 覆盖层 pointer-events:none 兜底, 此处再拦截
  // 覆盖层是矩形: 统一走画布命中 —— 可见像素优先, 没有可见像素时退回最上层包围盒
  // (圆环的洞/四角是透明的, 直接像素判定会让点击"没反应"; 有下层可见像素时才点穿)
  const hit = force ? inst : hitTest(e)
  if (hit && hit.locked) return
  state.ui.selectedId = hit ? hit.id : null
  if (hit) beginDrag(hit, e)
}

function openInst(inst) {
  /* 预览窗口双击多帧素材 → 打开多帧画板, 不弹"微调图片" */
  const a = state.assets.find(x => x.id === inst.assetId)
  if (a?.font?.charset === 'frames') {
    state.ui.frameGroupAssetId = a.id
    state.ui.dialogFrameGroup = true
    return
  }
  if (inst.kind === 'ring') state.ui.dialogRingId = inst.id
  else if (inst.sysfont) state.ui.dialogSysId = inst.id
  else if (inst.kind === 'text') state.ui.dialogTextId = inst.id
  else state.ui.dialogInstanceId = inst.id
}

// 切换预设 / 屏幕尺寸变化时重算自适应缩放
watch(() => [sc.value.w, sc.value.h, state.activePresetId], () => {
  if (state.ui.zoom === 0) autoFit()
})

function setZoom(z) {
  state.ui.zoom = Math.min(24, Math.max(0.25, snapZoom(z)))
}

/* ---- 渲染帧 (量化预览 1:1 合成, CSS 放大 nearest) ----
 * 图层表 (frameLayers) 与底色来自 store: 与右栏「导出图片」共用同一份 → 下载到的 = 预览里看到的 */
function render() {
  void state._ringTick   // 圆环动画帧触发重绘
  const cv = canvasEl.value
  if (!cv) return
  if (cv.width !== sc.value.w || cv.height !== sc.value.h) {
    cv.width = sc.value.w; cv.height = sc.value.h
  }
  const ctx = cv.getContext('2d')
  paintFrame(ctx, { w: cv.width, h: cv.height, layers: frameLayers(), bg: sc.value.bg })
  // 圆屏几何 (蒙版 / 红色警告 / store.warnings 三处共用同一来源)
  const geom = sc.value.round ? roundGeom(sc.value) : null
  // 圆外告警必须在**蒙版之前**采样: 蒙版会把黑底抬成 (5,7,10), 那已经不是纯黑了,
  // 若在蒙版后判定, 整个圆外区域都会被当成"内容"而标红。
  let warn = null
  if (geom) {
    let minX = cv.width, minY = cv.height, maxX = 0, maxY = 0
    let hasInst = false
    for (const inst of state.instances) {
      if (state.hiddenCircleWarns[inst.id]) continue
      const r = paintRect(inst)
      const x1 = Math.max(0, Math.floor(r.x)), y1 = Math.max(0, Math.floor(r.y))
      const x2 = Math.min(cv.width, Math.ceil(r.x + r.w)), y2 = Math.min(cv.height, Math.ceil(r.y + r.h))
      if (x1 < x2 && y1 < y2) {
        if (x1 < minX) minX = x1; if (y1 < minY) minY = y1
        if (x2 > maxX) maxX = x2; if (y2 > maxY) maxY = y2
        hasInst = true
      }
    }
    if (hasInst) {
      const sw = maxX - minX, sh = maxY - minY
      const imgData = ctx.getImageData(minX, minY, sw, sh)
      const hits = []
      /* 只收真正的实例像素: 透明(alpha<10) / 全黑(0,0,0) / **屏幕底色** 都过滤掉。
       * 底色可配之后 (默认黑) 圆外铺的就是底色 —— 不排掉的话, 换成非黑底色整个圆外都会标红。 */
      const bg = rgb565To888(sc.value.bg ?? 0)
      forEachOutsidePixel(imgData.data, sw, sh, minX, minY, geom, si => hits.push(si), [bg.r, bg.g, bg.b])
      if (hits.length) warn = { minX, minY, sw, sh, hits }
    }
  }
  // 圆屏: 圈外区域盖半透明蒙版 —— 出圈素材暗淡可见, 仍可选中拖回
  if (geom) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, cv.width, cv.height)
    ctx.arc(geom.cx, geom.cy, geom.r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(8, 11, 16, 0.62)'
    ctx.fill('evenodd')
    ctx.restore()
  }
  // 圆屏警告红色叠加: 蒙版之后绘制, 保证可见 (只标实例像素, 背景/蒙版不动)
  if (warn) {
    const imgData = ctx.getImageData(warn.minX, warn.minY, warn.sw, warn.sh)
    const od = imgData.data
    for (const si of warn.hits) {
      od[si] = 255; od[si + 1] = 0; od[si + 2] = 0; od[si + 3] = 230  // 90% 红
    }
    ctx.putImageData(imgData, warn.minX, warn.minY)
  }
}
watchEffect(render)

/* ---- 命中测试 (顶层的优先) ---- */
function hitTest(e) {
  const rect = canvasEl.value.getBoundingClientRect()
  const px = (e.clientX - rect.left) / zoom.value
  const py = (e.clientY - rect.top) / zoom.value
  let boxHit = null
  const list = visibleInstances.value                      // 组里当前没显示的帧不能挡住点击
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i]
    if (hitInstance(it, px, py)) return it               // 可见像素优先 (透明处可点穿到下层)
    if (!boxHit && inPaintBox(it, px, py)) boxHit = it   // 兜底: 没有可见像素命中 → 最上层包围盒
  }
  return boxHit
}

function onCanvasDown(e) {
  e.preventDefault()   // 阻止浏览器框选文字, 防止拖动实例被打断
  const hit = hitTest(e)
  if (hit && hit.locked) { return }   // 锁定: 不选中、不拖拽, 完全穿透
  state.ui.selectedId = hit ? hit.id : null
  if (!hit) return
  beginDrag(hit, e)
}

const dragState = { inst: null, sx: 0, sy: 0, ox: 0, oy: 0 }
function onDragMove(e) {
  const d = dragState
  if (!d.inst) return
  // 圆环锁定屏幕中心时禁止拖拽
  if (d.inst.ring?.centerScreen) return
  const nx = d.ox + Math.round((e.clientX - d.sx) / zoom.value)
  const ny = d.oy + Math.round((e.clientY - d.sy) / zoom.value)
  updateInstance(d.inst.id, {
    x: Math.max(-(d.inst.w - 1), Math.min(sc.value.w - 1, nx)),
    y: Math.max(-(d.inst.h - 1), Math.min(sc.value.h - 1, ny)),
  })
}
function onDragUp() {
  dragState.inst = null
  dragInstId.value = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragUp)
  window.removeEventListener('pointercancel', onDragUp)
}

/* ---- 对齐参考线 (拖拽图层 / 从素材栏拖放时显示) ----
 * · 十字中心线: 被拖图层(拖放时=落点)中心的横竖两条, **延长贯穿整个画布**
 * · 分数参考线: 画布的 1/5 · 1/4 · 1/3 · 中线(1/2), 两侧对称位置都画,
 *   各分数一种颜色, 线端标 k/n —— 拖东西时才出现, 平时画布干净 */
const dragInstId = ref(null)
const guides = computed(() => {
  const z = zoom.value
  const W = sc.value.w * z, H = sc.value.h * z
  const v = [], h = []
  for (const n of [5, 4, 3, 2]) {
    for (let k = 1; k < n; k++) {
      /* 标签只标最外两条 (1/n 与 (n-1)/n), 中间的挤在一起看不清 */
      const lab = (k === 1 || k === n - 1) ? `${k}/${n}` : null
      v.push({ pos: Math.round(W * k / n), cls: n === 2 ? 'mid' : 'f' + n, lab })
      h.push({ pos: Math.round(H * k / n), cls: n === 2 ? 'mid' : 'f' + n, lab })
    }
  }
  /* 十字中心: 拖已有图层 = 图层中心; 从素材栏拖放 = 指针落点 (素材按中心放置) */
  let cx = null, cy = null
  const di = state.instances.find(i => i.id === dragInstId.value)
  if (di) {
    const r = paintRect(di)
    cx = (r.x + r.w / 2) * z
    cy = (r.y + r.h / 2) * z
  } else if (dropHint.value && cursor.value) {
    cx = (cursor.value.x + 0.5) * z
    cy = (cursor.value.y + 0.5) * z
  }
  return { on: dragInstId.value != null || dropHint.value, v, h, cx, cy }
})

/* ---- 屏外实例: 边缘浮动标签 (不产生滚动条, 可选中可拖回) ---- */
function overlapRatio(inst) {
  const s = sc.value
  const r = paintRect(inst)
  const ix = Math.max(0, r.x), iy = Math.max(0, r.y)
  const ix2 = Math.min(s.w, r.x + r.w), iy2 = Math.min(s.h, r.y + r.h)
  if (ix2 <= ix || iy2 <= iy) return 0
  return ((ix2 - ix) * (iy2 - iy)) / (Math.max(1, r.w) * Math.max(1, r.h))
}
function onMove(e) {
  const rect = canvasEl.value.getBoundingClientRect()
  const x = Math.floor((e.clientX - rect.left) / zoom.value)
  const y = Math.floor((e.clientY - rect.top) / zoom.value)
  if (x >= 0 && y >= 0 && x < sc.value.w && y < sc.value.h) cursor.value = { x, y }
  else cursor.value = null
}

/* ---- 拖放: 素材 / 文件 ---- */
const dropHint = ref(false)
function onDragOver(e) {
  if (e.dataTransfer.types.includes('application/x-lcd-asset') || e.dataTransfer.types.includes('Files')) {
    e.preventDefault()
    dropHint.value = true
    /* 拖放期间 pointermove 不来 (来的是 dragover): 用它同步落点, 十字线跟着指针走 */
    if (canvasEl.value) {
      const rect = canvasEl.value.getBoundingClientRect()
      const x = Math.floor((e.clientX - rect.left) / zoom.value)
      const y = Math.floor((e.clientY - rect.top) / zoom.value)
      if (x >= 0 && y >= 0 && x < sc.value.w && y < sc.value.h) cursor.value = { x, y }
      else cursor.value = null
    }
  }
}
async function onDrop(e) {
  dropHint.value = false
  e.preventDefault()
  const rect = canvasEl.value.getBoundingClientRect()
  const px = (e.clientX - rect.left) / zoom.value
  const py = (e.clientY - rect.top) / zoom.value
  const assetId = e.dataTransfer.getData('application/x-lcd-asset')
  if (assetId) {
    const asset = state.assets.find(a => a.id === assetId)
    // 文本字库 → 文字实例 (弹窗输入文本); 帧素材/普通图片 → 图片实例
    if (asset?.font && asset.font.charset !== 'frames') {
      const inst = addTextInstance(asset.id)
      if (inst) {
        updateInstance(inst.id, {
          x: Math.round(px - inst.w / 2),
          y: Math.round(py - inst.h / 2),
        })
        state.ui.dialogTextId = inst.id   // 立即打开编辑, 直接输入字符串
      }
    } else {
      addInstance(assetId, px, py)
    }
    return
  }
  if (e.dataTransfer.files?.length) {
    const asset = await addAssetFile(e.dataTransfer.files[0])
    if (asset) addInstance(asset.id, px, py)
  }
}

const sel = computed(() => state.instances.find(i => i.id === state.ui.selectedId) || null)
</script>

<template>
  <div class="panel">
    <!-- 工具条 (固定高度) -->
    <div class="toolbar">
      <label class="chk"><input type="checkbox" v-model="state.ui.showGrid" />网格</label>
      <label class="chk" title="默认预览统一按 RGB565 渲染; 勾选后按图层的导出格式 (如 GRAY) 渲染"><input type="checkbox" v-model="state.ui.previewFollowFmt" />跟随格式</label>
      <button @click="undo()" :disabled="!state.ui.canUndo" title="撤回 (Ctrl+Z)">↶ 撤回</button>
      <button @click="redo()" :disabled="!state.ui.canRedo" title="重做 (Ctrl+Shift+Z / Ctrl+Y)">↷ 重做</button>
      <span class="sep"></span>
      <button @click="setZoom(zoom - 1)">−</button>
      <span class="tag mono zoomval" @click="state.ui.zoom = 0"
        :title="`点击恢复自适应; 当前 1 个屏幕像素 = ${zoomLabel.dev} 个设备像素${zoomLabel.crisp ? ' (整数倍, 无重采样)' : ' (非整数: 会被浏览器重采样)'}`"
        :class="{ warn: !zoomLabel.crisp }">{{ zoomLabel.txt }}x</span>
      <button @click="setZoom(zoom + 1)">＋</button>
      <button @click="setZoom(1)" title="1:1 像素">1:1</button>
    </div>

    <!-- 选中信息 / 操作 (同样固定高度: 选中变化不改变面板高度, 避免预览区抖动/拖拽被打断) -->
    <div class="statusbar">
      <span class="mono dim cursorval">
        <template v-if="cursor">({{ cursor.x }}, {{ cursor.y }})</template>
        <template v-else>—</template>
      </span>
      <span class="grow"></span>
      <template v-if="sel">
        <span class="tag mono sb-none">{{ sel.kind === 'ring' ? '◯' : sel.kind === 'text' ? '文' : '图' }} {{ sel.name }}</span>
        <span class="mono dim sb-info"><template v-if="sel.kind === 'text' || sel.sysfont">"{{ sel.kind === 'text' ? sel.text : sel.sysfont.text }}" · </template>{{ Math.round(sel.x) }},{{ Math.round(sel.y) }} · {{ Math.round(sel.w) }}×{{ Math.round(sel.h) }}<template v-if="sel.frame != null && sel.frame >= 0"> · 帧{{ sel.frame }}</template> · {{ sel.fmt }}<template v-if="!state.ui.previewFollowFmt && sel.fmt !== 'RGB565'"> (预览 RGB565)</template></span>
        <button @click="openInst(sel)" class="primary">{{ sel.kind === 'ring' || sel.kind === 'text' || sel.sysfont ? '编辑' : '微调' }}</button>
        <button @click="zorder(sel.id, 1)" title="上移一层">▲</button>
        <button @click="zorder(sel.id, -1)" title="下移一层">▼</button>
        <button @click="zorder(sel.id, 'top')" title="置顶">⤒</button>
        <button @click="zorder(sel.id, 'bottom')" title="置底">⤓</button>
        <button @click="duplicateInstance(sel.id)">复制</button>
        <button class="danger" @click="removeInstance(sel.id)">删除</button>
      </template>
      <template v-else-if="state.instances.length">
        <span class="dim sb-info">共 {{ state.instances.length }} 个图层 · 单击选中, 双击微调</span>
      </template>
    </div>

    <div class="stagepos">
      <div class="stagewrap" ref="wrapEl" @scroll="tick++" @dragover="onDragOver" @dragleave="dropHint = false" @drop="onDrop">
        <div class="assembly" :style="{ padding: Math.max(6, 10 * Math.min(1, zoom / 2)) + 'px' }">
          <div
            class="frame"
            :class="{ round: sc.round, dropping: dropHint }"
            :style="{ width: sc.w * zoom + 'px', height: sc.h * zoom + 'px' }"
            @pointerdown="onCanvasDown"
            @pointermove="onMove"
          >
            <canvas ref="canvasEl" class="lcd"
              :style="{ width: sc.w * zoom + 'px', height: sc.h * zoom + 'px' }"></canvas>

            <!-- 网格 -->
            <div v-if="state.ui.showGrid" class="grid" :style="{ backgroundSize: (16 * zoom) + 'px ' + (16 * zoom) + 'px' }"></div>

            <!-- 对齐参考线: 分数线 (1/5 1/4 1/3 中线) + 被拖对象中心的十字延长线 -->
            <div v-if="guides.on" class="guides">
              <div v-for="(g, i) in guides.v" :key="'gv' + i" class="gline gv" :class="g.cls" :style="{ left: g.pos + 'px' }">
                <span v-if="g.lab" class="glab">{{ g.lab }}</span>
              </div>
              <div v-for="(g, i) in guides.h" :key="'gh' + i" class="gline gh" :class="g.cls" :style="{ top: g.pos + 'px' }">
                <span v-if="g.lab" class="glab">{{ g.lab }}</span>
              </div>
              <template v-if="guides.cx != null">
                <div class="gline gv cross" :style="{ left: guides.cx + 'px' }"></div>
                <div class="gline gh cross" :style="{ top: guides.cy + 'px' }"></div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- 覆盖层: 选框/胶囊不受画框裁剪、不产生滚动条 (位置与画布实时同步) -->
      <!-- 覆盖层也要接拖放: 图层方框压在画布上, 松手时浏览器把 .inst 当放置目标,
           事件不会冒泡到 .stagewrap → 以前"拖到已有图层上"会放不下 -->
      <div class="ovlayer" v-show="ovVisible" @dragover="onDragOver" @dragleave="dropHint = false" @drop="onDrop">
        <div
          v-for="inst in visibleInstances" :key="inst.id"
          class="inst"
          :class="{ selected: inst.id === state.ui.selectedId, locked: inst.locked }"
          :style="ovStyle(inst)"
          @pointerdown="ovDown($event, inst)"
          @dblclick="openInst(inst)"
          :title="(inst.locked ? '🔒 已锁定 — 双击打开属性' : `${inst.kind === 'text' ? '文字 [' + inst.text + ']' : inst.name} (${Math.round(inst.x)},${Math.round(inst.y)}) ${Math.round(inst.w)}×${Math.round(inst.h)} ${inst.fmt}`) + (inst.sizeOnly ? ' 〔仅尺寸: 帧表只留坐标/尺寸 (.px = 0), 像素不进 flash〕' : '') + (inst.assetOnly ? ' 〔仅素材: 坐标/尺寸照常导出, 页面任务不画, 固件自取〕' : '')"
        ></div>

        <!-- 屏外实例胶囊 (显示区域外, 可选中/直接拖回; 锁定实例不显示胶囊) -->
        <template v-for="inst in offscreenInsts" :key="'os' + inst.id">
          <div
            v-if="!inst.locked"
            class="osbadge mono"
            :style="badgePos(inst)"
            @pointerdown="ovDown($event, inst, true)"
            @dblclick="openInst(inst)"
            :title="(inst.kind === 'text' ? ('文字 ' + inst.text) : inst.name) + ' — 在屏幕外, 按住拖回'"
          >{{ inst.kind === 'text' ? '文 ' + inst.text : inst.name }}</div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chk { color: var(--text-dim); font-size: 12px; display: flex; align-items: center; gap: 3px; }
.sep { width: 1px; height: 16px; background: var(--border); margin: 0 4px; }
.zoomval { cursor: pointer; min-width: 44px; text-align: center; }
.zoomval.warn { color: #ffb45a; }        /* 非整数设备像素倍率: 预览有重采样, 不是所见即所得 */
.cursorval { min-width: 62px; }
.stagepos {
  position: relative; flex: 1; min-height: 0;
  display: flex; overflow: hidden;
}
.stagewrap {
  flex: 1; position: relative; overflow: auto;
  display: flex; align-items: center; justify-content: center;
  user-select: none; -webkit-user-select: none;
  background:
    radial-gradient(circle at 50% 40%, #171e26 0%, #0e1216 70%);
}
.ovlayer {
  position: absolute; inset: 0; z-index: 5;
  pointer-events: none;
  user-select: none; -webkit-user-select: none;
}
.ovlayer .inst, .ovlayer .osbadge { pointer-events: auto; }
.assembly {
  background: linear-gradient(145deg, #232a33, #151a20);
  border-radius: 14px;
  box-shadow: 0 6px 30px rgba(0,0,0,.55), inset 0 0 2px #3a4652;
  margin: 30px;
}
.frame {
  position: relative;
  background: #000;
  overflow: hidden;      /* 滚动范围只由屏幕尺寸决定, 内容超出不再撑出滚动条 */
  box-shadow: inset 0 0 8px rgba(0,0,0,.9);
  cursor: default;
}
.frame.dropping { outline: 2px dashed var(--accent); outline-offset: 2px; }
.lcd {
  display: block;
  image-rendering: pixelated;
}
.grid {
  position: absolute; inset: 0; pointer-events: none;
  background-image:
    linear-gradient(to right, rgba(255,255,255,.07) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255,255,255,.07) 1px, transparent 1px);
}
.circle-guide {
  position: absolute; inset: 0; pointer-events: none;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.12);
}
.inst {
  position: absolute;
  border: 1px solid transparent;
}
.inst:hover { border-color: rgba(79, 195, 247, .55); }

/* ---- 对齐参考线: 拖拽期间才显示 (分数线 + 中心十字延长线) ---- */
.guides { position: absolute; inset: 0; z-index: 4; pointer-events: none; overflow: hidden; }
.gline { position: absolute; opacity: .8; }
.gv { top: 0; bottom: 0; width: 0; border-left: 1px solid; }
.gh { left: 0; right: 0; height: 0; border-top: 1px solid; }
.gline.cross { border-left-style: dashed; border-top-style: dashed; border-color: var(--accent, #4fc3f7); z-index: 1; }
.gline.mid { border-color: rgba(79, 195, 247, .6); }
.gline.f5 { border-color: rgba(129, 199, 132, .4); }   /* 1/5: 绿 */
.gline.f4 { border-color: rgba(255, 179, 0, .4); }     /* 1/4: 琥珀 */
.gline.f3 { border-color: rgba(240, 98, 146, .45); }   /* 1/3: 粉红 */
.glab {
  position: absolute; top: 1px; left: 2px;
  font: 9px/1 monospace; color: var(--text-dim, #9aa4b2);
  background: rgba(10, 14, 18, .7); padding: 1px 2px; border-radius: 2px;
  white-space: nowrap;
}
.gh .glab { top: 1px; left: auto; right: 2px; }
.inst.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgba(79,195,247,.35), inset 0 0 0 1px rgba(79,195,247,.2);
}
.inst.locked {
  pointer-events: none;    /* 锁定: 不可拖拽/选中; 不再画红框 (锁定状态看右栏图层列表) */
}
.osbadge {
  position: absolute; transform: translate(-50%, -50%);
  background: rgba(79, 195, 247, .85); color: #06222f;
  font-size: 11px; padding: 2px 9px; border-radius: 10px;
  cursor: grab; white-space: nowrap; z-index: 5;
  user-select: none; -webkit-user-select: none;
  box-shadow: 0 2px 8px rgba(0,0,0,.5);
}
.osbadge:active { cursor: grabbing; }
.toolbar, .statusbar {
  flex: none;
  display: flex; align-items: center; gap: 8px;
  padding: 0 10px;
  height: 34px;            /* 固定高度: 选中变化不改变面板高度, 避免预览区抖动/拖拽被打断 */
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  flex-wrap: nowrap;
  overflow: hidden;
  user-select: none; -webkit-user-select: none;
}
.sb-info {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sb-none { flex: none; }
.toolbar button { flex: none; }
.grow { flex: 1; }
</style>
