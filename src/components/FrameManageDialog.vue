<script setup>
/* 帧管理弹窗: 多帧素材的 排序(↑↓) / 删除(✕) / 插入(＋)。
 * 操作即时落地 (重拼拼版图, asset id/实例引用不变, 实例的帧号跟着新顺序走)。 */
import { ref, computed, watch } from 'vue'
import { state, framesCount, sliceFrames, moveAssetFrame, deleteAssetFrame, insertAssetFrame, getAssetImage } from '../store.js'
import { downloadCanvasPng } from '../utils.js'
import { imageFileName } from '../frameshoot.js'

const props = defineProps({ assetId: { type: String, default: '' } })
const emit = defineEmits(['close'])

const tick = ref(0)                       /* 帧操作后自增 → 重新切片刷新缩略图 */
const asset = computed(() => state.assets.find(a => a.id === props.assetId))
const cells = computed(() => {
  void tick.value
  const a = asset.value
  if (!a) return []
  return sliceFrames(a).map((cv, i) => ({ i, url: cv.toDataURL('image/png'), w: cv.width, h: cv.height }))
})
const busy = ref('')

watch(() => props.assetId, () => { tick.value++ })

/* 图片下载: 整条素材 (素材尺寸, 所有帧拼版) / 单帧 (格子尺寸) */
function downloadSheet() {
  const a = asset.value
  if (!a) return
  const img = getAssetImage(a)
  if (!img?.complete || !(img.naturalWidth || img.width)) { busy.value = '素材图还没加载完, 稍后再点'; return }
  const w = Math.max(1, Math.round(a.w || img.naturalWidth)), h = Math.max(1, Math.round(a.h || img.naturalHeight))
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  cv.getContext('2d').drawImage(img, 0, 0, w, h)
  downloadCanvasPng(imageFileName('img', a.name, w, h), cv)
}
function downloadCell(i) {
  const a = asset.value
  const cv = a ? sliceFrames(a)[i] : null
  if (cv) downloadCanvasPng(imageFileName('frame', `${a.name}_f${i + 1}`, cv.width, cv.height), cv)
}

function move(i, d) {
  const a = asset.value
  if (!a) return
  if (moveAssetFrame(a, i, i + d)) tick.value++
}
function del(i) {
  const a = asset.value
  if (!a) return
  if (cells.value.length <= 1) { busy.value = '至少保留 1 帧 (全删请直接删素材)'; return }
  if (deleteAssetFrame(a, i)) tick.value++
}
async function addFile(ev) {
  const a = asset.value
  const f = ev.target.files?.[0]
  ev.target.value = ''
  if (!a || !f) return
  busy.value = '导入中…'
  const url = URL.createObjectURL(f)
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image()
      im.onload = () => res(im); im.onerror = rej; im.src = url
    })
    if (insertAssetFrame(a, -1, img)) tick.value++
    else busy.value = '插入失败 (素材或图片无效)'
  } catch { busy.value = '图片加载失败' } finally { URL.revokeObjectURL(url) }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg frame-dlg">
      <div class="dlg-head">
        <b>帧管理 — {{ asset?.name }}</b>
        <span class="dim">{{ framesCount(asset) }} 帧 · {{ asset?.font?.glyphW }}×{{ asset?.font?.glyphH }} / 帧</span>
        <!-- 图片下载: 右上角 (关闭 左侧) —— 整条素材按素材尺寸; 每格另有自己的 ⤓ (按格子尺寸) -->
        <button class="mini" @click="downloadSheet()" :disabled="!asset"
          :title="`把整条素材按原始像素存成 PNG (${asset?.w || 0}×${asset?.h || 0}, 所有帧拼版)`">⤓ 图片下载</button>
        <button class="mini" @click="emit('close')">✕ 关闭</button>
      </div>
      <div class="dim note">
        排序/删除/插入即时生效 (拼版图重拼, 实例的"第几帧"跟着新顺序走)。
        插入的新帧等比缩放进格子; 属性弹窗勾「导出所有帧」后 MCU 按 id 调用 (0=关闭, 1..N=帧)。
      </div>
      <div v-if="busy" class="dim note" style="color: var(--warn)">{{ busy }}</div>
      <div class="frames">
        <div v-for="c in cells" :key="c.i" class="fcell">
          <img :src="c.url" />
          <span>{{ c.i + 1 }}</span>
          <div class="ops">
            <button class="mini" :disabled="c.i === 0" @click="move(c.i, -1)">↑</button>
            <button class="mini" :disabled="c.i === cells.length - 1" @click="move(c.i, 1)">↓</button>
            <button class="mini" @click="downloadCell(c.i)" :title="`导出第 ${c.i + 1} 帧 (按格子尺寸 ${c.w}×${c.h})`">⤓</button>
            <button class="mini danger" :disabled="cells.length <= 1" @click="del(c.i)">✕</button>
          </div>
        </div>
        <label class="fcell add">
          <input type="file" accept="image/*" @change="addFile" hidden />
          <b>＋ 帧</b>
          <span class="dim">追加到末尾</span>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; background: #0008; display: flex; align-items: center; justify-content: center; z-index: 60; }
.dlg { background: var(--bg, #1d2230); color: var(--fg, #dfe6f3); border-radius: 10px; padding: 14px; width: min(720px, 92vw); max-height: 86vh; overflow: auto; }
.dlg-head { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
.dlg-head .mini { margin-left: auto; }
.note { margin-bottom: 8px; }
.frames { display: flex; flex-wrap: wrap; gap: 10px; }
.fcell { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px; border: 1px solid #45506a; border-radius: 8px; }
.fcell img { max-width: 84px; max-height: 84px; image-rendering: pixelated; background: #000; }
.fcell .ops { display: flex; gap: 4px; }
.fcell.add { cursor: pointer; justify-content: center; min-width: 90px; min-height: 100px; }
.mini { font-size: 12px; padding: 2px 8px; }
.danger { color: #ff8f8f; }
</style>
