<script setup>
/*
 * 系统字微调 —— 逐字左右偏移 (px)。
 *
 * 设计口径: 系统字层只是"多帧字模的生成器 + 选择器"; 对齐误差出在**字模生成**这一层,
 * 所以这里调的是每个字符在自己格子里的 x 偏移, 最后格子尺寸 = 所有字形叠加区域的最大尺寸
 * (numFontForSys / asciiFontForSys 会按并集重算 w/h)。
 *
 * 数字/ASCII: 能直接看到字模叠加预览; 固定文本没有独立字模表, 偏移作用在整串渲染上。
 */
import { ref, computed, watch, nextTick } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  mode: { type: String, default: 'num' },     // num / ascii / fixed
  font: { type: Object, default: null },      // { w,h,first,count,rows,bytes }
  chars: { type: Array, default: () => [] },
  glyphDx: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['update:open', 'update:glyphDx'])

const selected = ref('0')
const listChars = computed(() => {
  const out = []
  for (const ch of props.chars || []) {
    if (ch === '\n' || ch === '\r') continue
    if (!out.includes(ch)) out.push(ch)
  }
  return out
})
const modeLabel = computed(() => ({ num: '数字字库', ascii: 'ASCII 字库', fixed: '固定文本' }[props.mode] || ''))
const charLabel = (ch) => (ch === ' ' ? '空' : ch)
const dxOf = (ch) => Math.round(+((props.glyphDx || {})[ch]) || 0)
const selectedIdx = computed(() => {
  const f = props.font
  if (!f || !selected.value) return -1
  return selected.value.charCodeAt(0) - f.first
})

watch(listChars, (list) => {
  if (!list.length) return
  if (!list.includes(selected.value)) selected.value = list.includes('0') ? '0' : list[0]
}, { immediate: true })

function setDx(ch, v) {
  const n = Math.max(-32, Math.min(32, Math.round(+v || 0)))
  const next = { ...(props.glyphDx || {}) }
  if (n) next[ch] = n
  else delete next[ch]
  emit('update:glyphDx', next)
}
function nudge(d) { setDx(selected.value, dxOf(selected.value) + d) }
function close() { emit('update:open', false) }

/** 把每个字的字迹中心对到格子中心 (整数像素), 顺手修 2/3 这种 1px 抖动。 */
function autoAlign() {
  const f = props.font
  if (!f?.rows?.length) return
  const next = { ...(props.glyphDx || {}) }
  for (const ch of listChars.value) {
    const idx = ch.charCodeAt(0) - f.first
    const row = f.rows[idx]
    if (!row) continue
    let lo = -1, hi = -1
    for (let x = 0; x < f.w; x++) {
      let ink = false
      for (let y = 0; y < f.h; y++) if (row[y * f.w + x]) { ink = true; break }
      if (ink) { if (lo < 0) lo = x; hi = x }
    }
    if (lo < 0) continue
    const d = Math.round(f.w / 2 - (lo + hi + 1) / 2)
    const cur = Math.round(+next[ch] || 0) + d
    if (cur) next[ch] = cur
    else delete next[ch]
  }
  emit('update:glyphDx', next)
}
function resetAll() { emit('update:glyphDx', {}) }

/* ---- 预览: 所有字形叠加, 选中的高亮; 格子边框/中线 ---- */
const cv = ref(null)
const SCALE = 6
function draw() {
  const f = props.font
  const el = cv.value
  if (!el) return
  if (!f?.rows?.length) {
    el.width = 1; el.height = 1
    return
  }
  const w = f.w, h = f.h
  const off = document.createElement('canvas')
  off.width = w; off.height = h
  const octx = off.getContext('2d')
  const img = octx.createImageData(w, h)
  const sel = selectedIdx.value
  for (let idx = 0; idx < f.rows.length; idx++) {
    const row = f.rows[idx]
    if (!row) continue
    const isSel = idx === sel
    const cr = isSel ? 255 : 90, cg = isSel ? 255 : 170, cb = isSel ? 255 : 255
    for (let i = 0; i < w * h; i++) {
      const v = row[i]
      if (!v) continue
      const a = (v / 255) * (isSel ? 1 : 0.22)
      const o = i * 4
      if (a > img.data[o + 3] / 255) {
        img.data[o] = cr; img.data[o + 1] = cg; img.data[o + 2] = cb
        img.data[o + 3] = Math.round(a * 255)
      }
    }
  }
  octx.putImageData(img, 0, 0)
  el.width = w * SCALE
  el.height = h * SCALE
  const ctx = el.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#101216'
  ctx.fillRect(0, 0, el.width, el.height)
  ctx.drawImage(off, 0, 0, el.width, el.height)
  /* 格子边框 + 中心线 (看清 1px 偏差) */
  ctx.strokeStyle = 'rgba(120,220,160,.9)'
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, el.width - 1, el.height - 1)
  ctx.strokeStyle = 'rgba(255,255,255,.18)'
  ctx.beginPath()
  ctx.moveTo(el.width / 2, 0); ctx.lineTo(el.width / 2, el.height)
  ctx.moveTo(0, el.height / 2); ctx.lineTo(el.width, el.height / 2)
  ctx.stroke()
}
watch(() => [props.open, props.font, props.glyphDx, selected.value], () => {
  if (props.open) nextTick(draw)
})
watch(() => props.open, (v) => { if (v) nextTick(draw) })
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="st-mask" @click.self="close">
      <div class="st-dlg">
        <div class="st-head">
          系统字微调
          <span class="dim">{{ modeLabel }} · 格子 {{ font ? font.w + '×' + font.h : '—' }}</span>
        </div>

        <div class="st-body">
          <div class="st-list">
            <button v-for="ch in listChars" :key="ch" class="st-ch" :class="{ on: ch === selected }"
              :title="'字符 ' + (ch === ' ' ? '空格' : ch) + ' 的左右偏移: ' + dxOf(ch) + 'px'"
              @click="selected = ch">{{ charLabel(ch) }}</button>
          </div>
          <div class="st-view">
            <canvas v-show="font" ref="cv" class="st-cv"></canvas>
            <div v-if="!font" class="dim st-note">
              固定文本是一张整图，没有独立字模表；这里的偏移会作用到整串渲染。
              要按字模调左右，请把内容切到「数字 (变量)」或「ASCII 字库」。
            </div>
          </div>
        </div>

        <div class="st-ctrl">
          <button @click="nudge(-1)">◀ -1</button>
          <input class="st-num" type="number" min="-32" max="32" :value="dxOf(selected)"
            @change="setDx(selected, $event.target.value)" />
          <button @click="nudge(1)">+1 ▶</button>
          <button @click="setDx(selected, 0)">这个字归零</button>
          <button :disabled="!font" @click="autoAlign">自动对中</button>
          <button @click="resetAll">全部清零</button>
        </div>

        <div class="dim st-foot">
          最终格子 = 所有字形叠加区域的最大尺寸；改偏移会实时重算
          <b v-if="font">{{ font.w }}×{{ font.h }}</b>。
        </div>
        <div class="st-actions">
          <button class="primary" @click="close">完成</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.st-mask { position: fixed; inset: 0; z-index: 150; background: rgba(0, 0, 0, .6); display: flex; align-items: center; justify-content: center; }
.st-dlg { width: min(560px, 94vw); max-height: 90vh; overflow: auto; background: var(--bg2, #1b1d21); border: 1px solid var(--border, #333); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.st-head { display: flex; justify-content: space-between; gap: 8px; font-size: 14px; font-weight: 600; }
.st-body { display: flex; gap: 10px; min-height: 180px; }
.st-list { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 3px; width: 150px; max-height: 240px; overflow: auto; }
.st-ch { min-width: 26px; height: 24px; padding: 0 4px; font: 12px/1 monospace; background: var(--bg, #111); color: var(--text); border: 1px solid var(--border, #333); border-radius: 4px; cursor: pointer; }
.st-ch.on { border-color: var(--accent, #4fc3f7); color: var(--accent, #4fc3f7); }
.st-view { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border, #333); border-radius: 6px; padding: 8px; background: #0d0f12; }
.st-cv { max-width: 100%; max-height: 300px; image-rendering: pixelated; }
.st-note { font-size: 11px; line-height: 1.5; }
.st-ctrl { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.st-num { width: 56px; }
.st-foot { font-size: 11px; line-height: 1.5; }
.st-actions { display: flex; justify-content: flex-end; }
</style>
