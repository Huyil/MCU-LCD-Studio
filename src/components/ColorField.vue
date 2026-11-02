<script setup>
/* 共用 RGB565 选色块: 快捷色 / HEX / 拾色器 / 最近色.
 * 从 InstanceDialog 与 TextDialog 里重复的两套逻辑抽出来 —— 两页行为一致,
 * 不会再出现"一边支持最近色、一边不支持"或 HEX 同步不一致。 */
import { ref, computed, watch } from 'vue'
import ColorPicker from './ColorPicker.vue'
import { state, pushRecentColor } from '../store.js'
import { COLORS, QUICK_COLORS, colorByName, nearestColorName, rgb565To888 } from '../colors.js'

const props = defineProps({
  modelValue: { type: Number, default: 0xFFFF },
  label: { type: String, default: '颜色' },
  showQuick: { type: Boolean, default: true },
  showRecent: { type: Boolean, default: true },
  /* 紧凑: 只留「快捷色 + 拾色器/HEX」, 收起大色盘 —— 屏幕预设这类窄表单用 */
  compact: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const value = computed(() => props.modelValue & 0xFFFF)
const colorHex = ref('#ffffff')
const shownColor = ref(value.value)
let nameTimer = null

function toHex(v) {
  const n = v & 0xFFFF
  const r = (((n >> 11) & 0x1F) * 255 / 31) | 0
  const g = (((n >> 5) & 0x3F) * 255 / 63) | 0
  const b = ((n & 0x1F) * 255 / 31) | 0
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
}
function sync() {
  colorHex.value = toHex(value.value)
  clearTimeout(nameTimer)
  nameTimer = setTimeout(() => (shownColor.value = value.value), 400)
}
watch(value, sync, { immediate: true })

function setColor(v, remember = true) {
  if (v == null) return
  const n = v & 0xFFFF
  emit('update:modelValue', n)
  if (remember) pushRecentColor(n)
  colorHex.value = toHex(n)
}
function applyHex(remember = true) {
  const m = /^#?([0-9a-f]{6})$/i.exec(colorHex.value.trim())
  if (!m) { colorHex.value = toHex(value.value); return }
  const n = parseInt(m[1], 16)
  const c = ((n >> 16 & 0xFF) >> 3) << 11 | ((n >> 8 & 0xFF) >> 2) << 5 | ((n & 0xFF) >> 3)
  setColor(c, remember)
}
const color565Text = computed(() => '0x' + value.value.toString(16).toUpperCase().padStart(4, '0'))
const colorName = computed(() => nearestColorName(shownColor.value))
const colorExact = computed(() => COLORS.find(c => c.v === value.value)?.n || '')
const swCss = (name) => {
  const v = colorByName(name)
  if (v === undefined) return '#888'
  const { r, g, b } = rgb565To888(v)
  return `rgb(${r},${g},${b})`
}
const css565 = (v) => {
  const { r, g, b } = rgb565To888(v & 0xFFFF)
  return `rgb(${r},${g},${b})`
}
</script>

<template>
  <div class="cf">
    <div class="field-row" v-if="showQuick">
      <label>{{ label }}</label>
      <div class="swatches">
        <span v-for="c in QUICK_COLORS" :key="c" class="sw" :class="{ on: colorExact === c }"
          :style="{ background: swCss(c) }" :title="c" @click="setColor(colorByName(c))"></span>
      </div>
    </div>
    <div class="field-row">
      <label>{{ showQuick ? '' : label }}</label>
      <input type="color" v-model="colorHex" @input="applyHex(false)" @change="applyHex(true)" style="width: 34px; padding: 1px" title="拾色器" />
      <input class="mono" v-model="colorHex" @change="applyHex" style="width: 82px" />
      <span class="tag mono" title="RGB565 实时值">{{ color565Text }}</span>
      <span class="tag mono colname" :title="colorExact ? '精确匹配 Color_t' : '最近似 Color_t (≈)'">{{ colorExact || '≈' + colorName }}</span>
    </div>
    <div class="field-row" v-if="!compact">
      <label>取色器</label>
      <div style="flex: 1; min-width: 0;">
        <ColorPicker :model-value="value" @update:model-value="setColor($event, false)" @commit="setColor($event, true)" />
      </div>
    </div>
    <div class="field-row" v-if="showRecent && state.recentColors.length">
      <label>最近</label>
      <div class="swatches">
        <span v-for="c in state.recentColors" :key="c" class="sw" :class="{ on: value === c }"
          :style="{ background: css565(c) }" :title="'0x' + c.toString(16).toUpperCase().padStart(4, '0')"
          @click="setColor(c)"></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cf :deep(.field-row) { flex-wrap: wrap; }
.swatches { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; min-width: 0; }
.sw { width: 18px; height: 18px; border-radius: 4px; border: 1px solid var(--border); cursor: pointer; }
.sw.on { outline: 2px solid var(--accent); outline-offset: 1px; }
.colname { display: inline-block; min-width: 104px; text-align: center; }
</style>
