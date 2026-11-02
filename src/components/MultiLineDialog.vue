<script setup>
/*
 * 文本框 —— 多行内容 → 分割线 → 帧素材 (弹窗)
 *
 *   左栏: 内容 + 参数 + 「加入素材库」
 *   右栏: 预览 (点击空白 = 加分割线, 按住拖 = 移动, 双击 = 删除) + 分割线列表
 *         每条线管它到吓一条线之间的区域; 勾「作为一帧」的区域各成一个帧素材。
 *
 * 纯逻辑在 uiexport.js (renderTextGray / splitRegions / textToAssets), 已由
 * scripts/check-uiexport.mjs + scripts/check-card.mjs 覆盖; 本组件只做接线与预览。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { state, addGrayAsset } from '../store.js'
import { renderTextGray, splitRegions, textToAssets, linesEvery, pickRow, regionRows, withTopAnchor, packFrames, contentBox } from '../uiexport.js'
import ColorPicker from './ColorPicker.vue'

const ui = state.uiExport          // 与「UI 帧/表导出」「一键导出」共用同一份设置
const canvas = ref(null)
const boxEl = ref(null)
const boxW = ref(420)
const status = ref('')
const pickIdx = ref(-1)            // 正在挑颜色的分割线下标
const selIdx = ref(-1)             // 选中的分割线 (预览里画粗一点)
const hoverY = ref(-1)             // 鼠标位置对应的内容 y (画虚线提示)
const dragIdx = ref(-1)

const lines = computed(() => String(ui.text ?? '').split('\n').map(t => ({ text: t })))

const rendered = computed(() => {
  try {
    return renderTextGray(lines.value, { mode: ui.mode, charGap: ui.charGap, lineGap: ui.lineGap })
  } catch (e) {
    return { error: e.message, w: 0, h: 0, gray: null }
  }
})

const regions = computed(() => {
  const r = rendered.value
  if (r.error || !r.w || !r.h) return []
  return splitRegions(r.gray, r.w, r.h, ui.splits)
})

const frameCount = computed(() => regions.value.filter(x => x.frame).length)
const ok = computed(() => !rendered.value.error && rendered.value.w > 0 && rendered.value.h > 0)
/* 下方列表 = **区域** (一行 = 一段), 不是分割线: line = 管着这段的那条线 (0 = 顶部锚线) */
const rows = computed(() => {
  if (!ok.value || !ui.splits.length) return []
  return regionRows(rendered.value.h, ui.splits)
})

/* 预览显示尺寸: 按栏宽与高度上限算整数倍, 宽高都定死 (命中换算就准) */
const view = computed(() => {
  const r = rendered.value
  if (!ok.value) return { w: 0, h: 0 }
  const s = Math.max(0.25, Math.min(6, (boxW.value - 4) / r.w, 360 / r.h))
  return { w: Math.max(1, Math.round(r.w * s)), h: Math.max(1, Math.round(r.h * s)) }
})

/* RGB565 → CSS rgb() */
function cssColor(v) {
  const c = (v ?? 0xFFFF) & 0xFFFF
  const r = Math.round(((c >> 11) & 31) * 255 / 31)
  const g = Math.round(((c >> 5) & 63) * 255 / 63)
  const b = Math.round((c & 31) * 255 / 31)
  return 'rgb(' + r + ',' + g + ',' + b + ')'
}
function hexOf(v) { return '0x' + ((v ?? 0xFFFF) & 0xFFFF).toString(16).toUpperCase().padStart(4, '0') }
function setHex(sp, e) {
  const s = String(e.target.value || '').trim()
  const n = s.startsWith('#') ? parseInt(s.slice(1), 16)
    : /^0x/i.test(s) ? parseInt(s.slice(2), 16) : Number(s)
  if (Number.isFinite(n)) sp.color = n & 0xFFFF
  e.target.value = hexOf(sp.color)
}

/* ---- 分割线 ---- */
function sortSplits() { ui.splits.sort((a, b) => a.y - b.y) }
/* 顶部锚线 (y=0): 它拥有最上面那段; 固定不能拖/删, 否则最上面那段又没人管了 */
function isAnchor(i) { return i === 0 && ui.splits.length > 0 && Math.round(ui.splits[0].y) === 0 }
function addAnchor() {
  if (ui.splits.some(s => Math.round(s.y) === 0)) return
  ui.splits.push({ y: 0, frame: true, color: 0xFFFF })
  sortSplits()
}
function dedupe() {
  sortSplits()
  addAnchor()          // 排序后若没有 y=0, 补上 (顶部那段才有主)
  for (let i = ui.splits.length - 1; i > 0; i--) {
    if (Math.round(ui.splits[i].y) === Math.round(ui.splits[i - 1].y)) ui.splits.splice(i, 1)
  }
  selIdx.value = -1
  pickIdx.value = -1
}
function delSplit(i) {
  if (isAnchor(i)) return          // 顶部锚线不能删 (取消勾选「帧」即可不导出)
  ui.splits.splice(i, 1)
  if (pickIdx.value === i) pickIdx.value = -1
  if (selIdx.value === i) selIdx.value = -1
}
function clearSplits() {
  ui.splits.splice(0, ui.splits.length)
  pickIdx.value = selIdx.value = -1
}
/* 按高度均分 (切帧高度模式): 每 N px 一条线, 从顶到底 */
const band = ref(ui.bandH || 13)
function splitByBand() {
  const r = rendered.value
  if (!ok.value) return
  const step = Math.max(1, Math.round(band.value) || 1)
  const ys = linesEvery(r.h, step)
  ui.splits.splice(0, ui.splits.length, ...ys.map(y => ({ y, frame: true, color: 0xFFFF })))
  pickIdx.value = selIdx.value = -1
  status.value = '已按每 ' + step + 'px 均分 → ' + ys.length + ' 条分割线 (' + ys.length + ' 帧)'
}

/* ---- 预览交互: 点空白加线 / 拖线 / 双击删线 ---- */
/* 鼠标 y → 内容像素行 (换算在 uiexport.pickRow, 已自检):
 * 画布 1px 边框 + border-box 会让"直接用 rect.height 换算"越往下越偏, pickRow 显式扣掉边框。
 * floor = "鼠标所在的那一行", 线落在该行顶边。 */
const BORDER = 1
function contentY(e) {
  const cv = canvas.value
  const r = rendered.value
  if (!cv || !ok.value) return -1
  const rect = cv.getBoundingClientRect()
  const row = pickRow(e.clientY - rect.top, view.value.h, r.h, BORDER)
  return row < 0 ? -1 : row
}
/* 抓线容差按"屏幕像素"算: 预览放大 6 倍时容差 ≈ 0.7 内容像素,
 * 这样 1~2px 高的窄条也能用鼠标点出来 (原来固定 3 内容像素 = 18 屏幕像素, 根本切不出 2px) */
const scaleY = computed(() => (ok.value && rendered.value.h ? view.value.h / rendered.value.h : 1))
function nearestLine(y) {
  const tol = Math.max(0.5, 4 / scaleY.value)     // 4 屏幕像素
  let best = -1, bd = tol + 1
  ui.splits.forEach((s, i) => {
    const d = Math.abs(s.y - y)
    if (d < bd) { bd = d; best = i }
  })
  return best
}
function onHover(e) {
  if (dragIdx.value >= 0) return
  hoverY.value = contentY(e)
}
function onDown(e) {
  if (!ok.value || e.button !== 0) return
  const y = contentY(e)
  if (y < 0) return
  let i = nearestLine(y)
  if (i < 0) {                       // 空白处按下: 从这里切一段 (第一次分割会自动补顶部锚线), 并直接进入拖动
    const next = withTopAnchor(ui.splits, y)
    ui.splits.splice(0, ui.splits.length, ...next)
    i = ui.splits.findIndex(s => Math.round(s.y) === Math.min(rendered.value.h, y))
    if (i < 0) i = ui.splits.length - 1
  }
  selIdx.value = i
  pickIdx.value = -1
  if (isAnchor(i)) return            // 锚线固定 0: 只选中, 不给拖 (要挪就改下面那段的 y)
  dragIdx.value = i
  const move = (ev) => {
    if (dragIdx.value < 0) return
    const yy = contentY(ev)
    if (yy < 0) return
    ui.splits[dragIdx.value].y = yy      // 拖动中不排序, 松手再排 (避免行号乱跳)
    hoverY.value = yy
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    const keep = ui.splits[dragIdx.value]
    dragIdx.value = -1
    dedupe()
    if (keep) selIdx.value = ui.splits.indexOf(keep)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  e.preventDefault()
}
function onDblClick(e) {
  const i = nearestLine(contentY(e))
  if (i >= 0) delSplit(i)
}

/* ---- 预览绘制: 只画内容 (区域按各自颜色着色) ----
 * 分割线不画进位图: 预览是放大的 (最多 6 倍), 画进去会变成 6px 粗的一条。
 * 线改成画布上的 DOM 叠加细线 (1px), 位置由 lineViews 按显示高度算。 */
const sig = computed(() => JSON.stringify([ui.text, ui.mode, ui.charGap, ui.lineGap, ui.splits]))
function paint() {
  const cv = canvas.value
  const r = rendered.value
  if (!cv || !ok.value) return
  cv.width = r.w; cv.height = r.h
  const ctx = cv.getContext('2d')
  const img = ctx.createImageData(r.w, r.h)
  for (const rg of regions.value) {
    const c = (rg.color ?? 0xFFFF) & 0xFFFF
    const cr = ((c >> 11) & 31) * 255 / 31
    const cg = ((c >> 5) & 63) * 255 / 63
    const cb = (c & 31) * 255 / 31
    for (let y = rg.y0; y < rg.y1; y++) {
      const row = y * r.w
      for (let x = 0; x < r.w; x++) {
        const i = (row + x) * 4
        const a = r.gray[row + x] / 255
        img.data[i] = cr * a
        img.data[i + 1] = cg * a
        img.data[i + 2] = cb * a
        img.data[i + 3] = 255
      }
    }
  }
  ctx.putImageData(img, 0, 0)
}

/* 分割线的屏幕位置 (叠加层用): 内容 y → 显示高度 px */
function topOf(y) {
  const r = rendered.value
  if (!ok.value || !r.h) return 0
  const yy = Math.max(0, Math.min(r.h, y))
  return Math.round(yy / r.h * view.value.h)
}
const lineViews = computed(() => ui.splits.map((s, i) => ({
  i, top: topOf(s.y),
  on: i === selIdx.value || i === dragIdx.value,
  frame: !!s.frame,
})))
const hoverTop = computed(() => (hoverY.value >= 0 && dragIdx.value < 0 ? topOf(hoverY.value) : -1))

watch(sig, () => paint(), { flush: 'post' })

let ro = null
/* 弹窗是 v-if 开关的: 画布每次打开都是新元素, 必须在打开后再量宽度 + 重画一次
 * (否则预览会一直空着, 直到用户碰了内容/分割线才触发 watch) */
function attach() {
  const el = boxEl.value
  if (ro) { ro.disconnect(); ro = null }
  if (el && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { boxW.value = boxEl.value?.clientWidth || boxW.value })
    ro.observe(el)
  }
  if (el) boxW.value = el.clientWidth || boxW.value
  paint()
}
watch(() => state.ui.dialogMultiLine, (open) => {
  if (!open) { if (ro) { ro.disconnect(); ro = null } return }
  addAnchor()               // 老状态可能没有 y=0 的锚线, 打开时补一次
  attach()                  // flush: 'post' → DOM 已建好, 直接量宽度并重画
}, { flush: 'post' })
onMounted(attach)
onBeforeUnmount(() => { if (ro) ro.disconnect() })

/* ---- 加入素材库: 勾了「帧」的区域各成一个素材 ----
 * 多行输入只是"一次做几张素材"的便利, 与输出无关: 导出时一段就是独立的一张图,
 * 没有"多行素材/菜单/高亮行"那套东西 (不带 lineH)。勾「打包成一张多帧素材」
 * 才会竖排合成一张 (那是在素材库里按帧切换, 不是输出形态)。 */
const assetName = ref('内容')
const packOne = ref(false)         // false = 每段一张图 (默认)
function addToLibrary() {
  const r = textToAssets(ui.text, {
    mode: ui.mode, charGap: ui.charGap, lineGap: ui.lineGap, splits: ui.splits,
  })
  if (r.error) { status.value = r.error; return }
  const segs = r.regions.filter(x => x.frame)
  if (!segs.length) { status.value = '没有勾「帧」的区域 — 勾上才会进素材库'; return }
  const name = String(assetName.value || '').trim() || '内容'

  /* 默认: 每段裁掉四周空白后各成一个独立素材 (一张图 = 一个素材, 放上去就是一帧) */
  if (!packOne.value) {
    const notes = []
    let n = 0
    for (const [i, seg] of segs.entries()) {
      const b = contentBox(seg.gray, r.w, seg.h) || { x: 0, y: 0, w: r.w, h: seg.h }
      const g = new Uint8Array(b.w * b.h)
      for (let y = 0; y < b.h; y++) g.set(seg.gray.subarray((b.y + y) * r.w + b.x, (b.y + y) * r.w + b.x + b.w), y * b.w)
      const a = addGrayAsset(name + ' ' + (i + 1), g, b.w, b.h, { color: seg.color })
      if (a) n++
      notes.push(b.w + '×' + b.h)
    }
    status.value = n
      ? '已加入素材库 ' + n + ' 个素材 (每段一张图: ' + notes.join(', ') + ') → 关掉窗口逐个拖到屏幕上'
      : '加入失败 (浏览器环境不支持 canvas?)'
    return
  }

  const pack = packFrames(r.regions, r.w)
  if (!pack) { status.value = '没有勾「帧」的区域 — 勾上才会进素材库'; return }
  const a = addGrayAsset(name + ' (' + pack.count + '帧)', pack.gray, pack.w, pack.h, {
    charset: 'frames', dir: 'row',            // 竖排切格: 一格 = 一段
    glyphW: pack.w, glyphH: pack.cellH, frames: pack.count,
    color: pack.colors[0],                    // 新图层默认用第 1 帧的颜色
    frameColors: pack.colors,                 // 选帧时自动带出那一帧的颜色 (InstanceDialog)
    boxes: pack.boxes,                        // 每帧内容框 → 图层只占内容大小, 导出省 flash
  })
  const boxNote = pack.boxes.map(b => b.w + '×' + b.h).join(', ')
  status.value = a
    ? '已加入素材库「' + name + '」: ' + pack.count + ' 帧 × 格 ' + pack.w + '×' + pack.cellH +
      ' (每帧实际内容 ' + boxNote + ') → 关掉窗口拖到屏幕上, 属性里选第几帧'
    : '加入失败 (浏览器环境不支持 canvas?)'
}

function close() { state.ui.dialogMultiLine = false }
</script>

<template>
  <div v-if="state.ui.dialogMultiLine" class="mask" @click.self="close">
    <div class="dlg">
      <div class="head">
        <b>文本框</b>
        <span class="dim">多行内容 → 分割线 → 帧素材 (勾「作为一帧」的区域各成一张图)</span>
        <span class="grow"></span>
        <span class="tag">{{ frameCount }} 帧</span>
        <button class="x" @click="close">×</button>
      </div>

      <div class="body">
        <!-- 左: 内容 + 参数 -->
        <div class="col left">
          <label>内容 (每行一条, 可不等长)</label>
          <textarea v-model="ui.text" rows="10" spellcheck="false" placeholder="每行一段内容…"></textarea>

          <div class="row">
            <label>字高</label>
            <select v-model.number="ui.mode" title="字模高度 (与固件 LCD_drawChar 的 mode 一致), 不是分割条的高度">
              <option :value="1">11</option>
              <option :value="0">14</option>
            </select>
            <label>字距</label><input type="number" min="0" max="4" v-model.number="ui.charGap" />
            <label>行距</label><input type="number" min="0" max="8" v-model.number="ui.lineGap" />
            <span class="grow"></span>
            <span class="dim" v-if="ok">{{ rendered.w }}×{{ rendered.h }}</span>
          </div>

          <div class="row">
            <label>素材名</label>
            <input class="namein" v-model="assetName" placeholder="内容" title="加入素材库后的名字 (帧数会自动附上)" />
          </div>

          <div class="row">
            <button class="primary add" :disabled="!frameCount" @click="addToLibrary"
              :title="packOne ? '把勾了「帧」的区域竖排打包成一张多帧素材 (在素材库里按帧切换)' : '每段裁掉空白后各成一个独立素材 (一段一张图, 放上去就是一帧)'">
              加入素材库 ({{ frameCount }} 段)
            </button>
            <label class="chk" title="勾上 = 竖排合成一张多帧素材 (素材库里按帧切换); 不勾 = 每段一张独立图 (推荐)">
              <input type="checkbox" v-model="packOne" />打包成一张多帧素材
            </label>
            <button @click="close">关闭</button>
          </div>
          <div class="dim st" v-if="status">{{ status }}</div>
          <div class="dim err" v-if="rendered.error">渲染错误: {{ rendered.error }}</div>

          <div class="hint">
            用法: 预览里点一下 = 从鼠标那一行切一段 (第一次切会自动补 y=0 的锚线, 顶部那段也有主) ·
            按住线拖动 = 移动 · 双击线 = 删除 (细实线 = 勾了「帧」, 虚线 = 只作参考)。<br />
            下方列表每行 = **一段区域** (显示 y 范围与高度), 勾「帧」的段会进素材库。
            多行输入只是"一次做几张素材"的便利: 默认<b>每段各成一张独立素材</b> (裁掉四周空白),
            导出时每个图层就是一张独立的图 —— 输出里没有"多行素材/菜单"那回事。
          </div>
        </div>

        <!-- 右: 预览 + 分割线列表 -->
        <div class="col right">
          <label>预览 (点击 / 拖动分线, 颜色实时显示)</label>
          <div ref="boxEl" class="box">
            <div class="stage" v-show="ok">
              <canvas
                ref="canvas" class="cv"
                :style="{ width: view.w + 'px', height: view.h + 'px' }"
                @pointerdown="onDown" @pointermove="onHover" @pointerleave="hoverY = -1"
                @dblclick="onDblClick" title="点击空白 = 加分割线 · 拖动 = 移动 · 双击 = 删除"
              ></canvas>
              <!-- 分割线叠加层: 1px 细线, 不随预览放大变粗; pointer-events:none 让点击仍落到画布 -->
              <div class="lines">
                <div v-if="hoverTop >= 0" class="hline hover" :style="{ top: hoverTop + 'px' }"></div>
                <div v-for="L in lineViews" :key="L.i" class="hline"
                  :class="{ on: L.on, ref: !L.frame }" :style="{ top: L.top + 'px' }"></div>
              </div>
            </div>
            <div class="dim none" v-if="!ok">内容为空</div>
          </div>

          <div class="row">
            <span class="dim grow" title="一行 = 一段区域 (线所在那一行算下面那段的第一行)">分割区域 ({{ rows.length }})</span>
            <label class="dim">每</label>
            <input class="bandnum" type="number" min="1" max="240" v-model.number="band"
              title="按这个高度从顶到底均分 (可以填 2 这种窄条高度)" />
            <span class="dim">px</span>
            <button class="mini" @click="splitByBand" :disabled="!ok" title="按上面的高度从顶到底均分, 生成分割线 (替换现有分割线)">均分</button>
            <button class="mini" @click="clearSplits" :disabled="!ui.splits.length">清空</button>
          </div>

          <div class="splits">
            <div v-for="(rg, i) in rows" :key="i" class="split-item">
              <div class="split-row" :class="{ on: rg.line >= 0 && rg.line === selIdx }" @click="rg.line >= 0 && (selIdx = rg.line)">
                <span class="segno" :class="{ dim: !rg.frame }" :title="'第 ' + (i + 1) + ' 段: y ' + rg.y0 + ' – ' + rg.y1">{{ i + 1 }}</span>
                <template v-if="rg.line >= 0">
                  <input class="ynum" type="number" min="0" v-model.number="ui.splits[rg.line].y" :disabled="rg.line === 0"
                    :title="rg.line === 0 ? '顶部锚线: 固定 0 (最上面那段靠它才能作为一帧)' : '这一段从哪一行开始'" @change="dedupe" />
                  <span class="dim mono yrange">{{ rg.y0 }}–{{ rg.y1 }}</span>
                  <span class="dim">{{ rg.h }}px</span>
                  <label class="chk" title="勾选 = 这一段单独成一帧, 可加入素材库"><input type="checkbox" v-model="ui.splits[rg.line].frame" />帧</label>
                  <span class="grow"></span>
                  <button class="swatch" :style="{ background: cssColor(rg.color) }"
                    @click.stop="pickIdx = pickIdx === rg.line ? -1 : rg.line" :title="'这段的渲染颜色 ' + hexOf(rg.color)"></button>
                  <input class="hex" :value="hexOf(rg.color)" @change="setHex(ui.splits[rg.line], $event)" @click.stop />
                  <button class="mini danger" @click.stop="delSplit(rg.line)" :disabled="rg.line === 0"
                    :title="rg.line === 0 ? '顶部锚线不能删 (取消勾选「帧」即可不导出这段)' : '删掉这条线 (并入上面那段)'">✕</button>
                </template>
                <template v-else>
                  <span class="dim grow">顶部这段还没有 y=0 的锚线 — 点右边补上 (否则它不能作为一帧)</span>
                  <button class="mini" @click.stop="addAnchor">补锚线</button>
                </template>
              </div>
              <div v-if="rg.line >= 0 && pickIdx === rg.line" class="picker"><ColorPicker v-model="ui.splits[rg.line].color" /></div>
            </div>
            <div v-if="!rows.length && ok" class="dim none">
              在预览里点一下 = 从那里切一段 (会自动在 y=0 补一根锚线, 最上面那段也能作为一帧);<br />
              或者填「每 N px」点均分。
            </div>
            <div v-if="!ok" class="dim none">内容为空</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; background: #0008; z-index: 60;
  /* 顶边锁死: 内容/预览/分割线列表怎么变, 弹窗都不移动 */
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 3vh;
}
.dlg {
  background: var(--bg2); border: 1px solid var(--border); border-radius: 8px;
  width: min(900px, 94vw); height: min(760px, 92vh);   /* 固定高度: 标题/按钮位置不随内容伸缩移动 */
  overflow: hidden; display: flex; flex-direction: column;
}
.head {
  display: flex; align-items: center; gap: 8px; flex: none;
  padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 13px;
}
.head .grow { flex: 1; }
/* 两栏各自滚: 左栏内容再长、右栏预览再高, 弹窗框都不动 */
.body { display: flex; gap: 12px; padding: 12px; flex: 1; min-height: 0; overflow: hidden; }
.col { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; min-height: 0; }
.col.left { overflow-y: auto; }
.col.right { overflow: hidden; }
.row { display: flex; align-items: center; gap: 6px; }
.row label { color: var(--text-dim); font-size: 12px; }
.grow { flex: 1; }
textarea { width: 100%; font-size: 12px; resize: vertical; }
.box { display: flex; align-items: flex-start; justify-content: center; min-height: 60px; }
.stage { position: relative; }
.cv {
  display: block;
  box-sizing: content-box;   /* 画布 style 的宽高 = 位图区域 (不含 1px 边框), 鼠标换算才对得上 */
  image-rendering: pixelated; background: #000;
  border: 1px solid var(--border); border-radius: 4px; cursor: crosshair;
}
/* 分割线: 1px 细线 (画布放大多少倍都不变粗)
 * 实线 = 勾了「作为一帧」· 虚线 = 只作参考 · 白色 = 选中/拖动中 */
.lines { position: absolute; inset: 1px; pointer-events: none; }
.hline {
  position: absolute; left: 0; right: 0; height: 0;
  border-top: 1px solid #ffd54f;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .45);
}
.hline.ref { border-top-style: dashed; opacity: .7; }
.hline.on { border-top: 2px solid #fff; margin-top: -1px; }
.hline.hover { border-top: 1px dashed rgba(255, 213, 79, .5); box-shadow: none; }
.col.right .box { flex: none; }
.splits { flex: 1; min-height: 60px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.split-item { border-radius: 4px; }
.split-row {
  display: flex; align-items: center; gap: 6px;
  padding: 2px 4px; border: 1px solid transparent; border-radius: 4px; font-size: 12px;
}
.split-row.on { border-color: var(--accent); background: var(--bg3); }
.ynum { width: 56px; font-size: 11px; padding: 2px 4px; }
.ynum:disabled { opacity: .55; }
.segno {
  flex: none; width: 16px; text-align: center; font-size: 10px;
  color: var(--accent); border: 1px solid var(--accent-dim); border-radius: 3px; line-height: 14px;
}
.segno.dim { color: var(--text-dim); border-color: var(--border); }
.yrange { font-size: 11px; }
.bandnum { width: 46px; font-size: 11px; padding: 2px 3px; }
.namein { flex: 1; min-width: 0; font-size: 12px; padding: 2px 4px; }
.chk { display: flex; align-items: center; gap: 3px; color: var(--text-dim); font-size: 12px; }
.swatch { width: 20px; height: 18px; padding: 0; border-radius: 3px; border: 1px solid var(--border); cursor: pointer; }
.hex { width: 74px; font-size: 11px; padding: 2px 4px; font-family: var(--mono); }
.mini { padding: 0 6px; font-size: 11px; }
.picker { background: var(--bg3); border: 1px solid var(--border); border-radius: 5px; padding: 6px; margin: 4px 0 6px; }
.add { font-size: 12px; }
.st { font-size: 11px; }
.err { color: var(--err); font-size: 11px; }
.none { font-size: 11px; padding: 4px 0; }
.hint { font-size: 11px; color: var(--text-dim); line-height: 1.7; margin-top: 4px; }
</style>
