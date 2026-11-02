<script setup>
/*
 * 屏幕预设 —— 屏幕参数 + 预设库 + 指令模板。
 *
 * 重构后的层级 (按使用顺序):
 *   ① 预设库: 选一个预设 → 看它是什么屏 (内置/自定义) → 新建 / 复制 / 删除;
 *   ② 当前预设: 改名 + 看清它管什么 (屏幕尺寸/背景色/模板), 并说明"自动保存, 存档会带走";
 *   ③ 屏幕参数 / 新建图层默认格式 / 指令模板: 真正编辑当前预设。
 *
 * 预设仍然"改哪存哪" (localStorage + 工程/存档), 所以这里没有"保存预设"按钮 ——
 * 只有「维护预设库」里的补内置/重置内置两个低频动作。
 */
import { ref, computed, watch } from 'vue'
import { state, screen, selectPreset, duplicatePreset, removePreset, resetPresets, restoreBuiltinPresets } from '../store.js'
import { roundGeom } from '../roundscreen.js'
import { suggestPresetName } from '../archive.js'
import TplEditor from './TplEditor.vue'
import ColorField from './ColorField.vue'

const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['update:open'])

const sc = screen
function close() { emit('update:open', false) }

const isBuiltin = computed(() => !!(sc.value.builtin || String(sc.value.id || '').startsWith('preset_bi_')))
const presetType = computed(() => isBuiltin.value ? '内置' : '自定义')

/* 屏幕底色 (RGB565, 默认黑 = 0x0000): 预览 / 导出图片 / 导出 C 的 UI_PAGE_BG 同一个值。
 * 老预设/老工程没有 bg 字段 → 读出来当黑; 改一下才写进预设 (内置预设按 overrides 存)。 */
const bgColor = computed({
  get: () => (sc.value.bg ?? 0x0000) & 0xFFFF,
  set: (v) => { sc.value.bg = (Number(v) || 0) & 0xFFFF },
})

/* 圆屏可用像素区: 留空 = 屏幕内切圆 (真实圆屏可用圆常比内切圆小 1~2px 或有偏移) */
const maskGeom = computed(() => roundGeom(sc.value))
const maskD = ref('')
const maskX = ref('')
const maskY = ref('')
function syncMaskText() {
  maskD.value = sc.value.maskR != null ? String(Math.round(sc.value.maskR * 2)) : ''
  maskX.value = sc.value.maskCx != null ? String(sc.value.maskCx) : ''
  maskY.value = sc.value.maskCy != null ? String(sc.value.maskCy) : ''
}
function commitMask() {
  const d = Number(maskD.value)
  if (maskD.value === '' || !Number.isFinite(d)) delete sc.value.maskR
  else sc.value.maskR = Math.max(0.5, d / 2)
  const x = Number(maskX.value)
  if (maskX.value === '' || !Number.isFinite(x)) delete sc.value.maskCx
  else sc.value.maskCx = x
  const y = Number(maskY.value)
  if (maskY.value === '' || !Number.isFinite(y)) delete sc.value.maskCy
  else sc.value.maskCy = y
  syncMaskText()
}
function resetMask() {
  delete sc.value.maskR; delete sc.value.maskCx; delete sc.value.maskCy
  syncMaskText()
}
watch(() => [sc.value.id, sc.value.maskR, sc.value.maskCx, sc.value.maskCy, props.open], () => {
  if (props.open) syncMaskText()
}, { immediate: true })

/* 新建 = 复制当前屏幕参数, 名字按尺寸自动生成 (240x240-圆), 撞名自动 -2 */
function newPreset() {
  const p = JSON.parse(JSON.stringify(sc.value))
  p.id = 'preset_' + Date.now().toString(36) + '_new'
  p.name = suggestPresetName(p, state.presets.map(x => x.name))
  delete p.builtin
  state.presets.push(p)
  selectPreset(p.id)
}

function removeCurrent() {
  if (state.presets.length <= 1) return
  if (typeof confirm === 'function' &&
      !confirm('删除预设「' + sc.value.name + '」？\n内置预设删掉后可用「补内置」找回；自定义预设删了就没了。')) return
  removePreset(sc.value.id)
}

/* 只补缺的内置预设 —— 比"重置"安全: 你自己加的预设不会被冲掉 */
const presetMsg = ref('')
function doRestoreBuiltin() {
  const n = restoreBuiltinPresets()
  presetMsg.value = n ? `补上 ${n} 条内置预设` : '内置预设都已在列表里'
  setTimeout(() => { presetMsg.value = '' }, 2500)
}
function doResetBuiltin() {
  if (typeof confirm === 'function' &&
      !confirm('恢复内置预设列表？\n内置项回到代码默认；你自己新建/复制的预设会保留。')) return
  resetPresets()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mask" @click.self="close">
      <div class="dialog panel">
        <div class="panel-title">
          屏幕预设
          <span class="tag">{{ sc.name }} · {{ sc.w }}×{{ sc.h }}{{ sc.round ? ' 圆' : '' }}{{ sc.inch ? ' · ' + sc.inch + '吋' : '' }}</span>
          <span class="grow"></span>
          <button class="primary" @click="close">关闭</button>
        </div>

        <div class="body">
          <!-- ① 预设库: 先选, 再改 -->
          <div class="sec">预设库 <span class="dim" style="font-weight: 400">· 改动自动保存</span></div>
          <div class="field-row">
            <select v-model="state.activePresetId" style="flex: 1" title="切换预设（只改变屏幕参数与指令模板，不动素材/图层）"
              @change="selectPreset($event.target.value)">
              <option v-for="p in state.presets" :key="p.id" :value="p.id">
                {{ p.name }} · {{ p.w }}×{{ p.h }}{{ p.round ? ' 圆' : '' }}{{ p.inch ? ' · ' + p.inch + '吋' : '' }}{{ p.builtin ? ' · 内置' : ' · 自定义' }}
              </option>
            </select>
            <button class="primary" @click="newPreset" title="以当前屏幕参数新建一个预设（名字按尺寸自动生成）">＋ 新建</button>
          </div>

          <div class="preset-card">
            <div class="preset-head">
              <span class="tag" :class="isBuiltin ? 'builtin' : 'custom'">{{ presetType }}</span>
              <span class="pname">{{ sc.name }}</span>
              <span class="dim mono">{{ sc.w }}×{{ sc.h }}{{ sc.round ? ' 圆' : '' }}{{ sc.inch ? ' · ' + sc.inch + '吋' : '' }}</span>
              <span class="grow"></span>
              <button class="mini" @click="duplicatePreset(sc.id)" title="复制当前预设">复制</button>
              <button class="mini danger" @click="removeCurrent" :disabled="state.presets.length <= 1" title="删除当前预设">删除</button>
            </div>
            <div class="field-row name-row">
              <label>预设名</label>
              <input v-model="sc.name" style="flex: 1" placeholder="给这套屏幕参数起个名字" />
            </div>
            <div class="preset-note dim">
              预设 = 屏幕尺寸 + 背景色 + 指令模板。改哪存哪（浏览器本地）；导出工程 JSON / 在线存档时一起带走。
            </div>
          </div>

          <details class="preset-maint">
            <summary class="dim">维护预设库<span v-if="presetMsg"> · {{ presetMsg }}</span></summary>
            <div class="field-row">
              <button @click="doRestoreBuiltin"
                title="只补缺的内置分辨率 (1.28R 圆 / 1.2 方 / 1.9 / 1.14 / 3.2 吋各横竖两条 / 240x170 横竖), 自己加的预设不动">补内置</button>
              <button class="danger" @click="doResetBuiltin"
                title="整份恢复内置预设列表（自定义预设保留）—— 对内置项的改动会丢失">重置内置</button>
            </div>
            <div class="dim note" style="font-size: 11px; line-height: 1.6">
              「重置内置」只恢复内置项；自己新建/复制的预设不会被删。
            </div>
          </details>

          <!-- ② 当前预设的屏幕参数 -->
          <div class="sec">屏幕参数</div>
          <div class="field-row">
            <label>宽 × 高</label>
            <input type="number" min="16" max="1024" v-model.number="sc.w" /> ×
            <input type="number" min="16" max="1024" v-model.number="sc.h" />
            <label class="chk"><input type="checkbox" v-model="sc.round" />圆屏限制</label>
          </div>
          <ColorField v-model="bgColor" label="背景色" compact
            title="屏幕底色 (RGB565, 默认黑): 预览底色 / 导出图片底色 / 导出 C 的 UI_PAGE_BG 三者同一个值" />
          <div v-if="sc.round" class="field-row" title="圆屏实际可用像素范围; 留空 = 屏幕内切圆。判定: 像素中心落在圆内即可用">
            <label>可用区</label>
            <span class="dim">Ø</span>
            <input type="number" min="1" step="1" v-model="maskD" @change="commitMask"
              :placeholder="Math.round(maskGeom.r * 2)" style="width: 62px" />
            <span class="dim">圆心</span>
            <input type="number" step="0.5" v-model="maskX" @change="commitMask"
              :placeholder="maskGeom.cx" style="width: 62px" />
            <input type="number" step="0.5" v-model="maskY" @change="commitMask"
              :placeholder="maskGeom.cy" style="width: 62px" />
            <button class="mini" @click="resetMask" title="恢复为屏幕内切圆">内切</button>
          </div>

          <div class="sec">新建图层默认格式</div>
          <div class="field-row">
            <label>格式</label>
            <select v-model="sc.defaultFmt">
              <option>RGB565</option><option>RGB888</option><option>GRAY</option>
            </select>
            <label class="chk" title="灰度数组打包: u8=drawGrayImage 的字节灰度; g565=drawImage 的 G 字段灰度">
              <input type="checkbox" :true-value="'u8'" :false-value="'g565'" v-model="sc.grayPack" />灰度用 u8 数组
            </label>
            <label class="chk" title="RGB888 以 RGB888(R,G,B) 宏导出 (编译期压为 RGB565), 否则导出 0xRRGGBB 原始数据">
              <input type="checkbox" v-model="sc.rgb888AsMacro" />RGB888 用宏
            </label>
          </div>

          <!-- 指令模板 / 头尾: 跟着屏幕预设走 (每个预设一套) -->
          <TplEditor />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0, 0, 0, .55);
  /* 顶边锁死: 内容变高变矮, 弹窗都不移动 */
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 3vh;
}
.dialog { width: min(560px, 94vw); height: min(460px, 92vh); box-shadow: 0 20px 60px rgba(0,0,0,.6); }
.body { padding: 12px; overflow: auto; flex: 1; min-height: 0; }
.sec {
  margin: 10px 0 6px; padding-bottom: 3px; border-bottom: 1px dashed var(--border);
  font-size: 12px; color: var(--accent); font-weight: 600;
}
.sec:first-child { margin-top: 0; }
.field-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
.field-row label { color: var(--text-dim); font-size: 12px; min-width: 52px; }
.chk { color: var(--text-dim); font-size: 12px; display: inline-flex; align-items: center; gap: 3px; min-width: 0; }
.grow { flex: 1; }
.mini { padding: 0 6px; font-size: 11px; }

/* 当前预设卡片: 一眼看清"这是哪套屏 / 内置还是自定义 / 能不能删" */
.preset-card {
  border: 1px solid var(--border); border-radius: 4px; background: var(--bg2);
  padding: 6px 8px; margin-bottom: 6px;
}
.preset-head { display: flex; align-items: center; gap: 6px; min-width: 0; margin-bottom: 5px; }
.preset-head .pname { font-size: 12px; font-weight: 600; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preset-head .tag.builtin { color: var(--text-dim); }
.preset-head .tag.custom { color: var(--accent); border-color: var(--accent-dim); }
.name-row { margin-bottom: 4px; }
.preset-note { font-size: 11px; line-height: 1.65; }
.preset-maint { margin: 0 0 6px; }
.preset-maint summary { cursor: pointer; font-size: 11px; }
.preset-maint .field-row { margin: 5px 0 2px; }
</style>
