<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { state, updateAsset, getAssetImage, fontCharset } from '../store.js'
import { downloadCanvasPng } from '../utils.js'
import { imageFileName } from '../frameshoot.js'

const show = ref(false)
const asset = ref(null)
const f = reactive({ glyphW: 8, glyphH: 14, charset: 'frames', custom: '0123456789', dir: 'col', start: 0x20, startCodeText: '0x20', dither565: true, rampSigma: 0 })
const view = ref('fit')

const imgEl = computed(() => asset.value ? getAssetImage(asset.value) : null)

watch(() => state.ui.dialogFontAssetId, id => {
  if (!id) return
  const a = state.assets.find(x => x.id === id)
  if (!a) return
  asset.value = a
  if (a.font) {
    Object.assign(f, { ...a.font })
    f.dither565 = a.font.dither565 ?? true    /* 老资产没这个字段 = 默认开 */
    f.rampSigma = a.font.rampSigma ?? 0       /* 边缘斜坡 σ (px): 老资产 = 0 (不变) */
    f.start = a.font.start ?? 0x20
    f.startCodeText = '0x' + f.start.toString(16).toUpperCase().padStart(2, '0')
    splitCount.value = Math.max(1, Math.ceil((f.dir === 'col' ? a.w : a.h) / Math.max(1, f.dir === 'col' ? a.font.glyphW : a.font.glyphH)))
  } else {
    // 默认 = 原图尺寸 (整图为一张); 排列方向按宽高比: 高>宽 → 按行切分(上下)
    Object.assign(f, {
      glyphW: a.w, glyphH: a.h, charset: 'frames', custom: '0123456789',
      dir: a.h > a.w ? 'row' : 'col',
      start: 0x20, startCodeText: '0x20', dither565: true, rampSigma: 0,
    })
    splitCount.value = 1
  }
  show.value = true
})

/* 张数 ↔ 字宽/字高 双向联动 */
const splitCount = ref(1)
const imgW = computed(() => asset.value?.w || 1)
const imgH = computed(() => asset.value?.h || 1)
function onGlyphW() {
  splitCount.value = Math.max(1, Math.ceil(imgW.value / Math.max(1, gw.value)))
}
function onGlyphH() {
  splitCount.value = Math.max(1, Math.ceil(imgH.value / Math.max(1, gh.value)))
}
function onCount() {
  const n = Math.max(1, Math.min(1024, Math.round(+splitCount.value) || 1))
  splitCount.value = n
  if (horiz.value) f.glyphW = Math.max(1, Math.ceil(imgW.value / n))
  else f.glyphH = Math.max(1, Math.ceil(imgH.value / n))
}

/* 重置: 字宽/字高恢复原图尺寸, 张数回 1 (类型/排列/字符集不动) */
function resetDims() {
  const a = asset.value
  if (!a) return
  f.glyphW = a.w
  f.glyphH = a.h
  splitCount.value = 1
}

function close() {
  show.value = false
  state.ui.dialogFontAssetId = null
}

const charsetStr = computed(() => f.charset === 'ascii' ? fontCharset({ charset: 'ascii', start: f.start }) : (f.charset === 'custom' ? (f.custom || '') : ''))
const isFrames = computed(() => f.charset === 'frames')

/* ASCII 起始字符: 默认空格 0x20, 支持输入字符 / 0xNN / 十进制 */
function parseStart() {
  const t = String(f.startCodeText).trim()
  let code = NaN
  if (/^0x[0-9a-f]+$/i.test(t)) code = parseInt(t, 16)
  else if (/^\d+$/.test(t)) code = parseInt(t, 10)
  else if ([...t].length === 1) code = t.codePointAt(0)
  if (Number.isFinite(code) && code >= 0x01 && code <= 0x7E) {
    f.start = code
    const c = String.fromCharCode(code)
    return `0x${code.toString(16).toUpperCase().padStart(2, '0')} '${c === ' ' ? '␠' : c}'`
  }
  f.start = 0x20
  return "0x20 '␠' (无效输入)"
}
const startLabel = computed(() => parseStart())
const gw = computed(() => Math.max(1, Math.round(+f.glyphW) || 1))
const gh = computed(() => Math.max(1, Math.round(+f.glyphH) || 1))
const horiz = computed(() => f.dir === 'col')   // 显式开关: col=按列(左→右) row=按行(上→下)
const cellCount = computed(() => isFrames.value
  ? Math.max(1, Math.ceil(horiz.value ? imgW.value / gw.value : imgH.value / gh.value))
  : charsetStr.value.length)

/* 图片完整容纳的字数 / 末尾补 0 的像素 */
const fitStats = computed(() => {
  if (!horiz.value) {
    const fit = Math.floor(imgH.value / gh.value)
    const padPx = Math.max(0, splitCount.value * gh.value - imgH.value)
    return { fit, padPx, padDim: '高' }
  }
  const fit = Math.floor(imgW.value / gw.value)
  const padPx = Math.max(0, splitCount.value * gw.value - imgW.value)
  return { fit, padPx, padDim: '宽' }
})

/* 切字预览 (前 24 个, 含补 0 部分) */
const previewCells = computed(() => {
  const img = imgEl.value
  if (!img?.complete) return []
  const out = []
  const n = Math.min(24, cellCount.value)
  for (let i = 0; i < n; i++) {
    const sx = horiz.value ? i * gw.value : 0
    const sy = horiz.value ? 0 : i * gh.value
    const cv = document.createElement('canvas')
    cv.width = gw.value; cv.height = gh.value
    const aw = Math.min(gw.value, img.naturalWidth - sx)
    const ah = Math.min(gh.value, img.naturalHeight - sy)
    if (aw > 0 && ah > 0) cv.getContext('2d').drawImage(img, sx, sy, aw, ah, 0, 0, aw, ah)
    const padded = aw < gw.value || ah < gh.value
    const label = charsetStr.value[i] ?? String(i)
    out.push({ ch: label, url: cv.toDataURL(), w: gw.value, h: gh.value, padded })
  }
  return out
})

const gridStyle = computed(() => horiz.value
  ? { backgroundSize: `${gw.value}px 100%, 100% ${gh.value}px` }
  : { backgroundSize: `100% ${gh.value}px, ${gw.value}px 100%` })

function apply() {
  if (!asset.value || cellCount.value < 1) return
  updateAsset(asset.value.id, {
    font: { glyphW: gw.value, glyphH: gh.value, charset: f.charset, custom: f.custom, dir: f.dir, start: f.start, dither565: f.dither565 !== false, rampSigma: Math.max(0, Math.min(2, +f.rampSigma || 0)) },
  })
  close()
}

/* 图片下载: 把拆出来的每一格按**格子尺寸**拼成一条 (预览里那排格子的原尺寸版, = 固件里那份字模的样子)。
 * 上限 24 格的预览只是"看得过来", 下载给的是**全部格子**。 */
function downloadSplitSheet() {
  const img = imgEl.value
  const a = asset.value
  if (!img?.complete || !a) return
  const cw = gw.value, ch = gh.value
  const n = Math.max(1, cellCount.value)
  const cv = document.createElement('canvas')
  cv.width = n * cw; cv.height = ch
  const ctx = cv.getContext('2d')
  for (let i = 0; i < n; i++) {
    const sx = horiz.value ? i * cw : 0
    const sy = horiz.value ? 0 : i * ch
    const aw = Math.min(cw, img.naturalWidth - sx)
    const ah = Math.min(ch, img.naturalHeight - sy)
    if (aw > 0 && ah > 0) ctx.drawImage(img, sx, sy, aw, ah, i * cw, 0, aw, ah)
  }
  downloadCanvasPng(imageFileName('font', a.name, cv.width, cv.height), cv)
}

function clearFont() {
  if (asset.value) updateAsset(asset.value.id, { font: undefined })
  close()
}

let maskDownOnMask = false
function onMaskDown(e) { maskDownOnMask = e.target === e.currentTarget }
function onMaskClick(e) {
  // 仅当按下与松开都在遮罩上才算空白点击 (拖选文字松开在窗外不会误关)
  if (e.target === e.currentTarget && maskDownOnMask) close()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="mask" @pointerdown="onMaskDown" @click="onMaskClick">
      <div class="dialog panel">
        <div class="panel-title">
          字库拆分 — {{ asset?.name }}
          <span class="tag">{{ asset?.w }}×{{ asset?.h }}</span>
          <span class="grow"></span>
          <button @click="downloadSplitSheet()" :disabled="cellCount < 1"
            :title="`把拆出来的 ${cellCount} 个格子按格子尺寸 ${gw}×${gh} 拼成一条存成 PNG (1:1, 不缩放)`">⤓ 图片下载</button>
          <button class="danger" v-if="asset?.font" @click="clearFont">清除拆分</button>
          <button @click="close">取消</button>
          <button class="primary" @click="apply" :disabled="cellCount < 1">应用拆分</button>
        </div>

        <div class="body">
          <div class="form">
            <div class="sec">切分参数</div>
            <div class="field-row">
              <label>字宽 / 字高</label>
              <input type="number" min="1" max="256" v-model.number="f.glyphW" @input="onGlyphW" />
              <input type="number" min="1" max="256" v-model.number="f.glyphH" @input="onGlyphH" />
              <span class="dim">px</span>
              <button class="stp" @click="resetDims" :title="`恢复原图尺寸 ${asset?.w || 0}×${asset?.h || 0}`">重置</button>
            </div>
            <div class="field-row">
              <label>张数</label>
              <input type="number" min="1" max="1024" v-model.number="splitCount" @input="onCount" style="width: 64px" />
              <span class="dim">张 (与{{ horiz ? '字宽' : '字高' }}联动)</span>
            </div>
            <div class="field-row">
              <label>排列</label>
              <label class="radio"><input type="radio" value="col" v-model="f.dir" />按列切分 (从左到右)</label>
              <label class="radio"><input type="radio" value="row" v-model="f.dir" />按行切分 (从上到下)</label>
            </div>
            <div class="field-row">
              <label title="GRAY 导出时把 8×8 Bayer 抖动烘进灰度字节: 板子灰度×颜色后直接截断进 RGB565 (红/蓝只有 5 位=32 级), 不抖的字库一条 AA 渐变会有明显锯齿/色带感。抖动烘进数据后 —— MCU 渲染代码不变、flash 占用不变、显示速度不变, 观感向网页预览靠拢。对 0/255 二值掩膜无影响; 只对 GRAY 格式生效 (RGB565 素材本来就在导出时完成了量化)。
**σ>0 时自动关闭** (二者互斥): 抖动把边缘灰度重量化到 8 的整数倍, 而 σ 摊出的斜坡上总有半档值 (124 = 15.5×8), Bayer 会把它逐行推成 120/128 —— 一条笔直的竖边就变成周期 2 行的梳齿">RGB565 抗色带抖动</label>
              <label class="chk"><input type="checkbox" v-model="f.dither565" :disabled="f.rampSigma > 0" />开启 (默认)</label>
              <span v-if="f.rampSigma > 0" class="dim">σ&gt;0 时不生效（防直边梳齿）</span>
            </div>
            <div class="field-row">
              <label title="灰度字模的**边缘斜坡**宽度 (高斯 σ, px): 浏览器渲染的字形 AA 只有 ~1px, 大字号下斜边/圆弧就是一格一格的台阶 (位深再加也治不了)。σ 把覆盖率斜坡摊宽 → 斜边变顺; 0 = 完全不变; 0.6~0.8 推荐; >1.0 小字号会发虚。只对 GRAY 生效, 烘进导出字节, MCU 渲染代码不变">边缘斜坡 σ</label>
              <input type="range" min="0" max="2" step="0.05" v-model.number="f.rampSigma" style="width: 90px" />
              <input type="number" min="0" max="2" step="0.1" v-model.number="f.rampSigma" style="width: 48px" />
              <span class="dim">px · 0=原样 · 0.7 推荐 · 越大越柔</span>
            </div>
            <div class="field-row">
              <label>补 0</label>
              <span v-if="fitStats.padPx > 0" class="tag pad-tag">{{ fitStats.padDim }}度不足, 自动补 0 扩展 {{ fitStats.padPx }}px</span>
              <span v-else class="dim">无余数, 不需扩展</span>
            </div>

            <div class="sec">拆分类型</div>
            <div class="type-list">
              <label class="type-opt" :class="{ on: f.charset === 'frames' }">
                <input type="radio" value="frames" v-model="f.charset" />1. 帧拆分
                <span class="dim">只按张数切分, 不映射字符</span>
              </label>
              <label class="type-opt" :class="{ on: f.charset === 'ascii' }">
                <input type="radio" value="ascii" v-model="f.charset" />2. ASCII 拆分
                <span class="dim">可设起始字符, 可用「＋文字」</span>
              </label>
              <label class="type-opt" :class="{ on: f.charset === 'custom' }">
                <input type="radio" value="custom" v-model="f.charset" />3. 自定义拆分
                <span class="dim">自定字符集, 可用「＋文字」</span>
              </label>
            </div>
            <div class="field-row" v-if="f.charset === 'ascii'">
              <label>起始字符</label>
              <input v-model="f.startCodeText" class="mono" style="width: 80px" placeholder="0x20" @input="parseStart" />
              <span class="tag mono">{{ startLabel }}</span>
              <span class="dim">条图第一格对应的 ASCII 字符 (默认空格 0x20), 到 0x7E 结束</span>
            </div>
            <div class="field-row" v-if="isFrames">
              <label>说明</label>
              <span class="dim">不映射字符, 只按张数切分; 拖入屏幕后在属性「帧选择」里挑某一帧显示</span>
            </div>
            <div class="field-row" v-else-if="f.charset === 'custom'">
              <label>字符</label>
              <input v-model="f.custom" style="flex: 1" placeholder="如 0123456789 或 .:-KMG%" class="mono" />
            </div>
            <div class="field-row">
              <label>结果</label>
              <span v-if="isFrames" class="tag mono">帧数 {{ cellCount }}{{ cellCount > fitStats.fit ? ` (图片容纳 ${fitStats.fit}, 余补 0)` : '' }}</span>
              <span v-else class="tag mono">完整 {{ Math.min(fitStats.fit, cellCount) }} 字 / 共 {{ cellCount }} 字</span>
              <span v-if="!isFrames && cellCount > fitStats.fit" class="warn-t">图片只容纳 {{ fitStats.fit }} 字, 其余 {{ cellCount - fitStats.fit }} 字全 0 (黑) 填充</span>
            </div>
            <div class="dim note">应用后: 拖该素材 = 多帧图 (占一个位置, 属性里换帧); ASCII/自定义拆分另可用「＋文字」按字符串显示。</div>
          </div>

          <div class="preview">
            <div class="pv-title">原条图 (网格 = 切分)</div>
            <div class="strip-box">
              <img v-if="asset" :src="asset.src" class="strip" />
              <div class="gridlines" :style="gridStyle"></div>
            </div>
            <div class="pv-title">切出的字 (前 {{ previewCells.length }})</div>
            <div class="cells">
              <div v-for="(c, i) in previewCells" :key="i" class="cell" :class="{ padded: c.padded }">
                <img :src="c.url" :style="{ width: c.w * 2 + 'px', height: c.h * 2 + 'px' }" />
                <span class="dim">{{ c.ch === ' ' ? '␠' : c.ch }}</span>
              </div>
              <div v-if="!previewCells.length" class="dim">参数无效或图片未加载</div>
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
.dialog { width: min(820px, 94vw); height: min(700px, 92vh); box-shadow: 0 20px 60px rgba(0,0,0,.6); }
.body { display: grid; grid-template-columns: 330px minmax(0, 1fr); gap: 12px; padding: 12px; overflow: auto; flex: 1; min-height: 0; }
.sec {
  margin: 10px 0 6px; padding-bottom: 3px; border-bottom: 1px dashed var(--border);
  font-size: 12px; color: var(--accent); font-weight: 600;
}
.radio { color: var(--text-dim); font-size: 12px; display: inline-flex; align-items: center; gap: 3px; }
.note { font-size: 11px; margin: 8px 0 0 52px; }
.warn-t { color: var(--warn); font-size: 11px; }
.stp { padding: 2px 8px; font-size: 11px; }
.type-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
.type-opt {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg2); cursor: pointer; font-size: 12px;
}
.type-opt:hover { border-color: var(--accent); }
.type-opt.on { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(79,195,247,.35); }
.type-opt input { margin: 0; }
.type-opt .dim { font-size: 11px; }
.field-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
.field-row label { color: var(--text-dim); font-size: 12px; min-width: 52px; }
.pv-title { font-size: 12px; color: var(--text-dim); margin: 0 0 6px; }
.strip-box { position: relative; max-height: 180px; overflow: auto; border: 1px solid var(--border); border-radius: 4px; }
.strip { display: block; max-width: 100%; image-rendering: pixelated; }
.gridlines {
  position: absolute; inset: 0; pointer-events: none;
  background-image:
    linear-gradient(to right, rgba(79,195,247,.5) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(79,195,247,.5) 1px, transparent 1px);
}
.cells { display: flex; flex-wrap: wrap; gap: 6px; }
.cell {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; padding: 4px;
}
.cell img { image-rendering: pixelated; display: block; }
.cell span { font-size: 10px; }
.cell.padded { border-color: var(--warn); }
.pad-tag { color: var(--warn); border-color: var(--warn); }
</style>
