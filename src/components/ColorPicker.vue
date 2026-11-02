<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { rgb565To888, rgb888To565 } from '../colors.js'

const props = defineProps({ modelValue: { type: Number, default: 0xFFFF } })
const emit = defineEmits(['update:modelValue', 'commit'])

const hsv = reactive({ h: 0, s: 1, v: 1 })
let internal = false
let lastColor = props.modelValue & 0xFFFF

function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let h = 0
  if (d) {
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return { h, s: mx ? d / mx : 0, v: mx }
}
function hsv2rgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c } else { r = c; b = x }
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) }
}

function syncFromModel() {
  const { r, g, b } = rgb565To888(props.modelValue & 0xFFFF)
  Object.assign(hsv, rgb2hsv(r, g, b))
}
watch(() => props.modelValue, () => { if (!internal) syncFromModel() }, { immediate: true })

function emitColor() {
  internal = true
  const { r, g, b } = hsv2rgb(hsv.h, hsv.s, hsv.v)
  lastColor = rgb888To565(r, g, b)
  emit('update:modelValue', lastColor)
  setTimeout(() => (internal = false), 0)
}

const sqEl = ref(null), hueEl = ref(null)
function pos(e, el) {
  const rect = el.getBoundingClientRect()
  return { x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
           y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) }
}
function bind(el, fn) {
  const move = e => { fn(e); emitColor() }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    emit('commit', lastColor)  /* 鼠标松开才提交一次"最近色" (带最终值) */
  }
  el.addEventListener('pointerdown', e => {
    e.preventDefault()
    fn(e); emitColor()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })
}
onMounted(() => {
  if (sqEl.value) bind(sqEl.value, e => { const p = pos(e, sqEl.value); hsv.s = p.x; hsv.v = 1 - p.y })
  if (hueEl.value) bind(hueEl.value, e => { hsv.h = pos(e, hueEl.value).x * 360 })
})

const rgbText = computed(() => {
  const { r, g, b } = hsv2rgb(hsv.h, hsv.s, hsv.v)
  return `rgb(${r}, ${g}, ${b})`
})
</script>

<template>
  <div class="cp">
    <div ref="sqEl" class="cp-sv" :style="{ backgroundColor: `hsl(${hsv.h}, 100%, 50%)` }" :title="rgbText">
      <span class="cp-dot" :style="{ left: hsv.s * 100 + '%', top: (1 - hsv.v) * 100 + '%' }"></span>
    </div>
    <div ref="hueEl" class="cp-hue">
      <span class="cp-dot" :style="{ left: (hsv.h / 360) * 100 + '%' }"></span>
    </div>
  </div>
</template>

<style scoped>
.cp { width: 100%; }
.cp-sv {
  height: 108px; border-radius: 4px; position: relative; cursor: crosshair;
  background-image:
    linear-gradient(to top, #000, rgba(0,0,0,0)),
    linear-gradient(to right, #fff, rgba(255,255,255,0));
  border: 1px solid var(--border);
}
.cp-hue {
  height: 12px; margin-top: 6px; border-radius: 6px; position: relative;
  cursor: ew-resize; border: 1px solid var(--border);
  background: linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%);
}
.cp-dot {
  position: absolute; width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid #fff; box-shadow: 0 0 3px rgba(0,0,0,.7);
  transform: translate(-50%, -50%); pointer-events: none;
}
</style>
