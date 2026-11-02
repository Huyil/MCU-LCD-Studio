<script setup>
import { ref, reactive, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import ColorPicker from './ColorPicker.vue'
import {
  state, screen, addRingInstance, updateInstance, removeInstance, pushRecentColor,
  centerAnchor, usableDiameter, centerRingRect, resetRingCountdown,
} from '../store.js'
import { sanitizeName } from '../template.js'
import { COLORS, QUICK_COLORS, colorByName, rgb565To888, rgb888To565 } from '../colors.js'
import { drawRing, ringRectGeom, ringStepPx, ringArcRange, ringSegGeom, ringTailU, getRingAnimValue,
         setRingAnimValue, ringGradStops, ringGrad565, mirrorRingX } from '../ringrender.js'
import { downloadCanvasPng } from '../utils.js'
import { imageFileName } from '../frameshoot.js'

const show = ref(false)
const isNew = ref(false)
const draft = reactive({
  id: null, name: 'ring1', x: 0, y: 0, w: 0, h: 0,
  ring: {
    shape: 'circle',                  // 'circle' | 'rect' (圆角矩形 = 网页预览版)
    rad: 24, thick: 12,               // 圆角矩形: 外圆角 / 环厚 (留边见下)
    rOut: 120, rIn: 86, aa: 2, steps: 40, value: 26, startDeg: -90,
    arcDir: 1,                        // 「弧向」进度弧方向: +1 顺时针 / -1 逆时针
    arcEndDeg: null,                  // 结束角: null = 整圈; 数值 = 只画 start→end 这段弧
    radIn: null,                      // 内圆角: null = 自动 (= 外圆角 − 环厚, 同心)
    inset: 8,                         // 留边 (总, px): 环带外沿离图层外框的余量 (内部算, 不改尺寸)
    trackColor: 0x6B4D, fillColor: 0x07FF,
    /* 渐变 (仅网页预览): [{ p: 0..100, c: RGB565 }], null = 平色。
     * 沿弧长从起始角铺到结束角; 导出取 0% 首点色, 固件仍是单色。 */
    trackGrad: null, fillGrad: null,
    /* glintOn  = 「启用白斑」: 硬件开关, 导出 RING_GLINT_DEF (板子上 Ring_SetGlint)
     * 两个预览动效开关 (只在网页预览, 不导出):
     *   autoGlint = 「光斑动画」(白斑沿路径转)   autoArc = 「自动动画」(进度 0→档位 扫) */
    glintOn: true, glintDeg: 0, glintSigma: 14, glintSpanDeg: 42, glintArcPx: 16,
    autoGlint: true, autoArc: true,
    glintMs: 100, syncMcU: true, caps: true,
    /* 立体感 (断面方向光): 强度 % / 凸起|凹陷 / 光源方位角; 0 = 平色 (与老固件逐像素一致) */
    depth: 0, depthStyle: 'ridge', lightDeg: -45,
    /* 分割 (角向遮罩): segOn 开关 / segCount 段数 / segGapDeg 缝宽(°) / segPhaseDeg 相位(相对弧起点)
     * 只有「暗槽」一种形态: segMode 只保留做老工程兼容 (cut 会迁成 100% 槽深);
     * segAA = 沟槽 AA 的总过渡宽度 (px, 0 = 硬边); segDepth = 压暗量 % (100 = 压到黑);
     * aaEdge = 端点 AA 的总过渡宽度 (px, 两端同值, 只在平口生效) */
    segOn: false, segCount: 90, segGapDeg: 1, segGapPct: null, segPhaseDeg: 0, segMode: 'groove', segAA: 2, aaEdge: 2, segSplit: 5, segDepth: 60,
    /* 扫描导出: 线宽/步长 px, 档位 (null = steps), 颜色高低字节交换 */
    scanWidth: 2, scanStepPx: 0.5, scanLevels: null, scanSwap: true,
    mirrorX: false,
    gear: 2, dir: 1,                   // 圆环页启动档位/方向 → 导出 RING_GEAR_DEF / RING_DIR_DEF
    /* 效果: static = 静态进度 / countdown = 倒计时 (递减 + 拖尾);
     * countMs = 满圈 → 0 的时长, tailMs = 递减边缘拖尾 (与固件 RINGUI_TAIL_MS 同口径) */
    effect: 'static', countMs: 10000, tailMs: 200,
  },
})

const tab = ref('basic')
const previewRun = ref(true)
const animTick = ref(0)
const pvCanvas = ref(null)
const stageEl = ref(null)
const dragKind = ref(null)

/* 直径输入: 本地字符串 + change 提交 —— 逐键钳制会把 "1"+"2" 拆坏 (历史 bug: 输入 2 被夹成 8) */
const dOutText = ref('')
const dInText = ref('')
function syncDiameterText() {
  dOutText.value = String(Math.max(2, Math.round(draft.ring.rOut * 2)))
  dInText.value = String(Math.max(0, Math.round(draft.ring.rIn * 2)))
}
function commitDiameters() {
  const o = Number(dOutText.value)
  if (Number.isFinite(o)) draft.ring.rOut = Math.max(1, o / 2)   // 渲染下限 Ø2 (drawRing rOut ≥ 1)
  const i = Number(dInText.value)
  if (Number.isFinite(i)) draft.ring.rIn = Math.max(0, Math.min(draft.ring.rOut - 1, i / 2))
  syncDiameterText()
}
function fillScreen() {
  draft.ring.rOut = usableDiameter(sc.value) / 2
  draft.ring.centerScreen = true
  centerOnly()
  syncDiameterText()
}
/* 形状切换: 换到圆角矩形时若还是圆形的正方形框, 给个 2:1 的默认矩形并居中 */
function onShapeChange() {
  const sc2 = screen.value
  if (draft.ring.shape === 'rect') {
    if (!draft.w || Math.abs(draft.w - draft.h) < 1) {
      draft.w = Math.max(16, Math.min(sc2.w, Math.round(draft.ring.rOut * 2)))
      draft.h = Math.max(16, Math.round(draft.w * 0.55))
    }
    draft.ring.centerScreen = true
    centerRect()
  } else {
    draft.ring.centerScreen = true
    centerOnly()
  }
}
function rectSize() { return { w: Math.max(8, Math.round(draft.w || 100)), h: Math.max(8, Math.round(draft.h || 60)) } }
function centerRect() {
  /* 让**环心**(floor(x+(w-1)/2), 就是导出的 RING_CX/CY) 落在屏幕中央像素上,
   * 而不是把图层矩形居中 —— 后者改尺寸时环心会漂 (见 store.js centerRingRect) */
  const { w, h } = rectSize()
  const c = centerRingRect(screen.value, w, h)
  draft.x = c.x
  draft.y = c.y
}
/* 撑满屏幕 (圆角矩形用): **尺寸 = 屏幕尺寸** (留边不在这里扣, 它在渲染时内部生效)。
 * 矩形屏/方屏直接取屏幕 w×h; 圆屏取"可用圆内、保持当前长宽比"的最大矩形 (四角不会伸到圆外)。 */
function fitScreenRect() {
  const sc2 = screen.value
  const cur = rectSize()
  const a = (cur.w > 0 && cur.h > 0) ? cur.w / cur.h : (sc2.w / sc2.h || 1)
  if (sc2.round) {
    const R = Math.max(4, usableDiameter(sc2) / 2)
    const h = Math.max(8, Math.round((2 * R) / Math.sqrt(a * a + 1)))
    draft.h = h
    draft.w = Math.max(8, Math.round(a * h))
  } else {
    draft.w = Math.max(8, Math.round(sc2.w))
    draft.h = Math.max(8, Math.round(sc2.h))
  }
  draft.ring.centerScreen = true
  centerRect()
}
function centerCurrent() {
  if (draft.ring.shape === 'rect') centerRect()
  else centerOnly()
}
function centerOnly() {
  const size = Math.ceil(draft.ring.rOut * 2)
  const a = centerAnchor(sc.value)
  draft.x = a.cx - size / 2
  draft.y = a.cy - size / 2
}
/* 尺寸改了 (对话框里填数字 / 点「撑满屏幕」) 且锁着屏幕中心 → 立即重新落位,
 * 免得环心跟着尺寸漂 (用户现场: "锁定后调整尺寸会导致圆心偏移") */
watch(() => [draft.w, draft.h], () => {
  if (draft.ring.centerScreen && draft.ring.shape === 'rect') centerRect()
})

/* 实际环心 (屏幕坐标) = 导出/固件用的 RING_CX/CY = floor(x + (w-1)/2);
 * 圆环那支是 图层尺寸/2 推出的精确直径, 环心就是图层中心 */
const ringCenter = computed(() => {
  const sc2 = screen.value
  if (draft.ring.shape === 'rect') {
    const { w, h } = rectSize()
    return { x: Math.floor((+draft.x || 0) + (w - 1) / 2), y: Math.floor((+draft.y || 0) + (h - 1) / 2) }
  }
  const size = Math.ceil((draft.ring.rOut ?? 0) * 2)
  return { x: Math.floor((+draft.x || 0) + (size - 1) / 2), y: Math.floor((+draft.y || 0) + (size - 1) / 2) }
})
/* 屏幕中央像素 (「锁定屏幕中心」的目标): 圆屏 = 可用圆心 */
const screenCenterPx = computed(() => {
  const sc2 = screen.value
  return sc2?.round ? centerAnchor(sc2) : { cx: Math.floor(((+sc2?.w || 0) - 1) / 2), cy: Math.floor(((+sc2?.h || 0) - 1) / 2) }
})
const isCentered = computed(() => ringCenter.value.x === screenCenterPx.value.cx && ringCenter.value.y === screenCenterPx.value.cy)

/* 内圆角: 「自动」= 外圆角 − 厚度 (同心圆角, 环带等厚)。开关单独一个, 免得只能靠"清空输入框" */
const radInAuto = computed({
  get: () => draft.ring.radIn == null || draft.ring.radIn === '',
  set: (v) => { draft.ring.radIn = v ? null : Math.round(rectRadii.value.radIn) },
})

function onCenterScreenChange() {
  if (!draft.ring.centerScreen) return
  if (draft.ring.shape === 'rect') centerRect()
  else centerOnly()
}
const colorTarget = ref('fill')   // 当前编辑: track | fill
const colorHex = ref('#07ff07')
/* 渐变编辑: gradSel 指向当前颜色通道原始数组里的停靠点; 排序只用于显示/导出。
 * 纯色模式下 trackGrad/fillGrad = null, 所有旧路径一字不变。 */
const gradSel = ref(0)
const gradKey = computed(() => colorTarget.value === 'fill' ? 'fillGrad' : 'trackGrad')
const flatKey = computed(() => colorTarget.value === 'fill' ? 'fillColor' : 'trackColor')
const gradStopsRaw = computed(() => {
  const g = draft.ring[gradKey.value]
  return Array.isArray(g) ? g : null
})
const isGrad = computed(() => !!gradStopsRaw.value && gradStopsRaw.value.length > 0)
const sortedGrad = computed(() => {
  const arr = gradStopsRaw.value
  if (!arr || !arr.length) return []
  return [...arr].sort((a, b) => (Number(a.p) || 0) - (Number(b.p) || 0))
})
const selGrad = computed(() => {
  const arr = gradStopsRaw.value
  if (!arr || !arr.length) return null
  return arr[Math.max(0, Math.min(gradSel.value, arr.length - 1))] || null
})
const canRemoveStop = computed(() => {
  const s = selGrad.value
  if (!isGrad.value || !s || sortedGrad.value.length <= 2) return false
  const at = sortedGrad.value.indexOf(s)
  return at > 0 && at < sortedGrad.value.length - 1
})
const sc = screen
/* 板子每步弧长 (px): 档位 × 0.5° 折算到一圈弧长 —— 与「弧长 (预览)」对齐后, 预览转速 = 板子 */
const boardStepPx = computed(() =>
  ringStepPx(Math.max(2, Math.round(draft.w || 240)), Math.max(2, Math.round(draft.h || 240)), draft.ring))

/* ===== 弧范围 / 效果 ===== */
const range = computed(() => ringArcRange(draft.ring))
/* 分割几何: 弧内 N 段 + N-1 条内部缝, P=(span+gap)/N, body=P-gap;
 * 最后一段 body 与其余段相同 (不会末端偏长)。缝宽 % 按实际节距 P 计, 100% = 全暗。 */
const segGeom = computed(() => ringSegGeom({ ...draft.ring, segOn: true }))
const segPitch = computed(() => segGeom.value?.P || 0)
const segBody = computed(() => segGeom.value?.body || 0)
const segSpan = computed(() => segGeom.value?.span || 0)
/* 缝宽百分比 (0.01% 步进): 0% = 关闭; 100% = 只有缝. 老工程由 segGapDeg 反算 */
const segGapPctValue = computed({
  get: () => {
    if (!draft.ring.segOn) return 0
    return Math.max(0, Math.min(100, segGeom.value?.pct ?? 0))
  },
  set: (v) => {
    const p = Math.max(0, Math.min(100, Number(v) || 0))
    draft.ring.segGapPct = p
    draft.ring.segOn = p > 0
    const g = p > 0 ? ringSegGeom({ ...draft.ring, segOn: true }) : null
    draft.ring.segGapDeg = g ? g.gap : 0
  },
})
const segGapDegValue = computed(() => draft.ring.segOn ? (segGeom.value?.gap || 0) : 0)
/* 段数跟随进度「满档 steps」(不是当前 value): 避免 steps 与 segCount 两个分割位置。
 * 要预览切面位置, 改「进度 → 当前值」, 不要改段数去当位置。 */
const progSteps = computed(() => Math.max(1, Math.min(720, Math.round(draft.ring.steps || 40))))
const progValue = computed(() => Math.max(0, Math.min(progSteps.value, Math.round(draft.ring.value || 0))))
const segFollowSteps = ref(false)
function toggleSegFollowSteps() {
  segFollowSteps.value = !segFollowSteps.value
  if (segFollowSteps.value) draft.ring.segCount = Math.max(2, Math.min(180, progSteps.value))
}
watch(progSteps, (v) => {
  if (segFollowSteps.value) draft.ring.segCount = Math.max(2, Math.min(180, v))
})
watch(() => draft.id, () => { segFollowSteps.value = false })
/* 缝宽 %: 滚轮每次 ±0.5% (与 input 的 step=0.1 分开; 手动输入 0.01 仍原样接收) */
function onSegGapWheel(e) {
  if (!e) return
  e.preventDefault()
  const dir = e.deltaY < 0 ? 1 : -1
  const cur = Number(segGapPctValue.value) || 0
  const next = Math.max(0, Math.min(100, cur + dir * 0.5))
  segGapPctValue.value = Math.round(next * 1000) / 1000
}
const tailU = computed(() => ringTailU(draft.ring))
const isCountdown = computed(() => draft.ring.effect === 'countdown')
const countMs = computed(() => Math.max(1000, Math.round(draft.ring.countMs ?? 10000)))
const countSec = computed({
  get: () => Math.round(countMs.value / 100) / 10,
  set: (v) => { draft.ring.countMs = Math.max(1000, Math.round((Number(v) || 1) * 1000)) },
})
const liveValue = computed(() => {
  void animTick.value
  const steps = Math.max(1, Math.round(draft.ring.steps || 40))
  const v = Number(getRingAnimValue(draft.id, draft.ring.value ?? 0))
  return Math.max(0, Math.min(steps, Number.isFinite(v) ? v : 0))
})
const liveValueText = computed(() => isCountdown.value ? liveValue.value.toFixed(1) : String(Math.round(liveValue.value)))
/* 手动改「预览位置」时同步运行期动画值: 否则「自动动画」开着时滑块只改导出值,
 * 预览仍按旧动画值走 (看起来像滑块没反应 / 满档时闪没)。 */
watch(() => draft.ring.value, (v) => {
  if (draft.id) setRingAnimValue(draft.id, Math.max(0, Number(v) || 0))
})

const countLeft = computed(() => {
  const steps = Math.max(1, Math.round(draft.ring.steps || 40))
  return Math.max(0, Math.min(1, liveValue.value / steps)) * countMs.value / 1000
})
const countLeftText = computed(() => countLeft.value >= 10 ? countLeft.value.toFixed(1) : countLeft.value.toFixed(2))
const tailMsSafe = computed(() => Math.max(0, Math.round(draft.ring.tailMs ?? 200)))
const startU = computed(() => (((Math.round(draft.ring.startDeg ?? 0) % 360) + 360) % 360) * 2)
const endU = computed(() => (((Math.round(range.value.endDeg) % 360) + 360) % 360) * 2)
function norm360(a) { return ((Math.round(a) % 360) + 360) % 360 }
function norm180(a) { return ((a + 180) % 360 + 360) % 360 - 180 }
function fmtDeg(a) { return norm360(a) + '°' }
function setRangeMode(full) {
  if (full) draft.ring.arcEndDeg = null
  else draft.ring.arcEndDeg = norm360((draft.ring.startDeg ?? 0) + range.value.dir * 270)
}
/* 参考图预设: 90 段 / 4° 节距 / 1° 缝 / 平口 (端帽关掉) */
function applySegPreset() {
  draft.ring.segOn = true
  draft.ring.segCount = 90
  draft.ring.segGapDeg = 1
  draft.ring.segGapPct = null
  draft.ring.segPhaseDeg = 0
  draft.ring.segMode = 'groove'
  draft.ring.segAA = 2
  draft.ring.segDepth = 60
  draft.ring.caps = false
}
/* 左右镜像: 起止角/弧向/白斑角/转向/分段相位一起翻到另一侧; 再点一次翻回.
 * 只改设计参数, 不改图层位置 —— 固件导出的是镜像后的角度. */
function applyMirrorX() {
  Object.assign(draft.ring, mirrorRingX(draft.ring))
}

function restartCountdown() {
  nextTick(() => { if (draft.id) resetRingCountdown(draft.id) })
}
/* 切到倒计时 / 改时长或档位: 从满圈重新开始, 否则会接着上一次的相位 */
watch(() => [draft.ring.effect, draft.ring.countMs, draft.ring.steps], () => {
  if (show.value && draft.ring.effect === 'countdown') restartCountdown()
})

/* ===== 角度盘 (圆环专用): 起止手柄直接拖 ===== */
const DIAL_R = 150
function polar(deg, r) {
  const rad = deg * Math.PI / 180
  return { x: 180 + Math.cos(rad) * r, y: 180 + Math.sin(rad) * r }
}
const dialTicks = computed(() => Array.from({ length: 24 }, (_, i) => {
  const a = i * 15
  const p1 = polar(a, 158), p2 = polar(a, i % 6 === 0 ? 168 : 163)
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, major: i % 6 === 0 }
}))
const dialLabels = computed(() => {
  const all = [
    { a: 0, t: '0°', ...polar(0, 174) }, { a: 90, t: '90°', ...polar(90, 174) },
    { a: 180, t: '180°', ...polar(180, 174) }, { a: 270, t: '270°', ...polar(270, 174) },
  ]
  if (range.value.full) return all
  /* 结束手柄所在方位的刻度让位给「止」标签 */
  return all.filter(l => Math.abs(norm180(l.a - range.value.endDeg)) >= 12)
})
/* 起止手柄都放在环外 (圆环画布缩到 80%, 外沿≈128/180), 不再压住环带 */
const dialStartPos = computed(() => polar(range.value.startDeg, 152))
const dialEndPos = computed(() => polar(range.value.endDeg, 152))
const dialArcPath = computed(() => {
  if (range.value.full) return ''
  const span = range.value.spanDeg
  const s = polar(range.value.startDeg, DIAL_R)
  const e = polar(range.value.startDeg + range.value.dir * span, DIAL_R)
  return 'M ' + s.x.toFixed(2) + ' ' + s.y.toFixed(2) +
    ' A ' + DIAL_R + ' ' + DIAL_R + ' 0 ' + (span > 180 ? 1 : 0) + ' ' + (range.value.dir > 0 ? 1 : 0) +
    ' ' + e.x.toFixed(2) + ' ' + e.y.toFixed(2)
})
function pointerAngle(e) {
  const el = stageEl.value
  if (!el) return 0
  const r = el.getBoundingClientRect()
  const a = Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI
  return norm360(a)
}
function beginDial(kind, e) {
  dragKind.value = kind
  e.preventDefault()
  e.stopPropagation()
  window.addEventListener('pointermove', onDialMove)
  window.addEventListener('pointerup', endDial, { once: true })
}
function onDialMove(e) {
  if (!dragKind.value) return
  let a = pointerAngle(e)
  if (dragKind.value === 'start') {
    draft.ring.startDeg = a
  } else {
    /* 整圈时拖"结束"手柄 = 开始裁一段弧; 与起始角重合会退化成整圈, 至少留 3° */
    const d = Math.abs(norm180(a - (draft.ring.startDeg ?? 0)))
    if (d < 3) a = norm360((draft.ring.startDeg ?? 0) + range.value.dir * 3)
    draft.ring.arcEndDeg = a
  }
}
function endDial() {
  dragKind.value = null
  window.removeEventListener('pointermove', onDialMove)
  window.removeEventListener('pointerup', endDial)
}

/* ===== 预览 ===== */
/* 环带外沿尺寸 = 图层外框 − 2×内缩 (「撑满屏幕」后想贴边就把内缩填 0) */
const rectOuter = computed(() => {
  const { w, h } = rectSize()
  const inset = Math.max(0, Math.round(draft.ring.inset ?? 8))
  return { w: Math.max(1, w - inset), h: Math.max(1, h - inset) }
})
/* 对话框里显示"实际外/内圆角" —— 与 drawRing 用同一个推导 (ringRectGeom) */
const rectRadii = computed(() => {
  const w = Math.max(8, Math.round(draft.w || 100)), h = Math.max(8, Math.round(draft.h || 60))
  const g = ringRectGeom(w, h, { rad: draft.ring.rad, radIn: draft.ring.radIn, thick: draft.ring.thick, inset: draft.ring.inset, aa: draft.ring.aa })
  return { radOut: g.radOut, radIn: g.radIn, clamped: (draft.ring.rad ?? 24) < g.radOut - 0.5 }
})
const pvSize = computed(() => draft.ring.shape === 'rect'
  ? { w: Math.max(8, Math.round(draft.w || 100)), h: Math.max(8, Math.round(draft.h || 60)) }
  : { w: Math.ceil(draft.ring.rOut * 2), h: Math.ceil(draft.ring.rOut * 2) })
/* ---- 预览缩放: 1×..6×, 放大后 stage-wrap 出现滚动条 (只走按钮, 不抢滚轮) ----
 * 只放大 CSS 显示 (画布仍是 pvSize 原生像素), 放大后切 pixelated 便于看 AA/缝边。
 * 角度盘 SVG 跟 stage 一起放大, 手柄仍可拖。 */
const pvZoom = ref(1)
const pvScroll = ref(null)
const PV_ZOOM_MAX = 6
function centerPvScroll() {
  const el = pvScroll.value
  if (!el) return
  el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2)
  el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2)
}
function setPvZoom(z) {
  const next = Math.max(1, Math.min(PV_ZOOM_MAX, Math.round(Number(z) * 10) / 10))
  if (next === pvZoom.value) return
  pvZoom.value = next
  nextTick(centerPvScroll)
}
function zoomPv(d) { setPvZoom(pvZoom.value + d) }
const stageStyle = computed(() => {
  const s = pvSize.value
  const z = pvZoom.value
  const scale = Math.min(360 / s.w, 360 / s.h, 1.6) * z
  return { width: Math.round(s.w * scale) + 'px', height: Math.round(s.h * scale) + 'px' }
})
function drawPreview() {
  if (!show.value || !pvCanvas.value) return
  const { w, h } = pvSize.value
  if (pvCanvas.value.width !== w) pvCanvas.value.width = w
  if (pvCanvas.value.height !== h) pvCanvas.value.height = h
  drawRing(pvCanvas.value.getContext('2d'), { x: 0, y: 0, w, h, id: draft.id, ring: draft.ring })
}

/* 图片下载: 预览画布本身就是按 pvSize 1:1 画的 (显示上的缩放只是 CSS), 直接存它。
 * 圆环以外是透明的 —— 圆环是"部件", 这样叠到什么地方都干净。 */
function downloadPreviewImage() {
  const cv = pvCanvas.value
  if (!cv || !cv.width) return
  const shape = draft.ring.shape === 'rect' ? 'rect' : 'circle'
  downloadCanvasPng(imageFileName('ring', draft.name || shape, cv.width, cv.height), cv)
}
watch(() => [draft.ring, draft.w, draft.h, show.value], () => drawPreview(), { deep: true, immediate: true, flush: 'post' })
/* 弹窗预览自己也要跟着动画走 (主舞台只重画它自己的画布): 倒计时 / 自动动画 / 光斑 */
let pvTimer = null
function stopPvTimer() { if (pvTimer) { clearInterval(pvTimer); pvTimer = null } }
function startPvTimer() {
  stopPvTimer()
  if (!show.value || !previewRun.value) return
  const r = draft.ring
  const animating = r.effect === 'countdown' || r.autoArc || (r.autoGlint && r.glintOn)
  if (!animating) return
  pvTimer = setInterval(() => {
    if (!show.value) return
    animTick.value++
    drawPreview()
  }, 33)
}
watch([show, previewRun, () => draft.ring.effect, () => draft.ring.autoArc, () => draft.ring.autoGlint, () => draft.ring.glintOn], startPvTimer)
onBeforeUnmount(() => { stopPvTimer(); endDial() })

/* 打开 / 新建 */
/* snapshot 必须先声明: 下面的打开 watch 是 immediate, 挂载时回调立刻执行 takeSnapshot(),
 * 若 ref 声明在 watch 之后会踩 TDZ (Cannot access 'snapshot' before initialization) */
const snapshot = ref(null)
watch(() => [state.ui.dialogRingId, state.ui.dialogRingNew], ([id, isNewFlag]) => {
  if (id) {
    const it = state.instances.find(i => i.id === id && i.kind === 'ring')
    if (!it) return
    Object.assign(draft, { id: it.id, name: it.name, x: it.x, y: it.y, w: it.w, h: it.h,
      ring: { shape: 'circle', rad: 24, thick: 12, inset: 8, effect: 'static', countMs: 10000, tailMs: 200, arcEndDeg: null, segOn: false, segCount: 90, segGapDeg: 1, segGapPct: null, segPhaseDeg: 0, segMode: 'groove', segAA: 2, aaEdge: 2, segSplit: 5, segDepth: 60,
    /* 扫描导出: 线宽/步长 px, 档位 (null = steps), 颜色高低字节交换 */
    scanWidth: 2, scanStepPx: 0.5, scanLevels: null, scanSwap: true,
    mirrorX: false, ...it.ring, centerScreen: it.ring.centerScreen ?? true } })
    /* 旧工程存的是「切断」(segMode='cut'): 模式选项已取消, 统一迁成 100% 槽深。
     * 黑底上视觉等价; 之后保存/导出都是 MODE=1 + DEPTH=100。 */
    if (draft.ring.segMode === 'cut') {
      draft.ring.segMode = 'groove'
      draft.ring.segDepth = 100
    }
    /* 上一版把端点 AA 拆成起点/终点; 现在统一成一个「端点 AA」 */
    if (draft.ring.aaEdge === undefined || draft.ring.aaEdge === null) {
      draft.ring.aaEdge = draft.ring.aaStart ?? draft.ring.aaEnd ?? 2
    }
    isNew.value = false
    tab.value = 'basic'
    previewRun.value = true
    syncHex()
    syncDiameterText()
    if (draft.ring.centerScreen) centerCurrent()   // 锁中心时按当前尺寸重新落位 (老工程/改过直径后 x/y 可能是旧值)
    takeSnapshot()
    show.value = true
    nextTick(centerPvScroll)        // 记住的缩放 >1 时, 打开即把视口回到环心
    resetRingCountdown(draft.id)
    state.ui.dialogRingNew = false
  } else if (isNewFlag) {
    /* 单例: 一个工程只允许一个环 —— addRingInstance() 已有环时会返回那个环,
     * 这时按"打开已有环"处理 (不是新建), 否则会留下一个空环 */
    const before = state.instances.length
    const inst = addRingInstance()
    if (!inst) return
    const ringDefaults = { shape: 'circle', rad: 24, thick: 12, inset: 8, effect: 'static', countMs: 10000, tailMs: 200, arcEndDeg: null, trackGrad: null, fillGrad: null,
      segOn: false, segCount: 90, segGapDeg: 1, segGapPct: null, segPhaseDeg: 0, segMode: 'groove', segAA: 2, aaEdge: 2, segSplit: 5, segDepth: 60,
    /* 扫描导出: 线宽/步长 px, 档位 (null = steps), 颜色高低字节交换 */
    scanWidth: 2, scanStepPx: 0.5, scanLevels: null, scanSwap: true }
    if (state.instances.length === before) {
      Object.assign(draft, { id: inst.id, name: inst.name, x: inst.x, y: inst.y, w: inst.w, h: inst.h,
        ring: { ...ringDefaults, ...inst.ring, centerScreen: inst.ring.centerScreen ?? true } })
      isNew.value = false
      syncHex(); syncDiameterText()
      if (draft.ring.centerScreen) centerCurrent()
      takeSnapshot()
      show.value = true
      state.ui.dialogRingNew = false
      return
    }
    Object.assign(draft, { id: inst.id, name: inst.name, x: inst.x, y: inst.y, w: inst.w, h: inst.h,
      ring: { ...ringDefaults, ...inst.ring } })
    isNew.value = true
    syncHex()
    syncDiameterText()
    if (draft.ring.centerScreen) centerCurrent()
    takeSnapshot()
    show.value = true
    state.ui.dialogRingNew = false
  }
}, { immediate: true })

/* 编辑期间实时写回实例 —— 否则弹窗里拖滑杆/改颜色时, 主预览图一动不动
 * (以前是"只有点确定才写回")。打开时先存一份快照, 取消/关闭再回滚。 */
function takeSnapshot() {
  const it = draft.id ? state.instances.find(i => i.id === draft.id) : null
  snapshot.value = it ? JSON.parse(JSON.stringify({ name: it.name, x: it.x, y: it.y, w: it.w, h: it.h, ring: it.ring })) : null
}
function liveApply() {
  if (!show.value || !draft.id) return
  const it = state.instances.find(i => i.id === draft.id)
  if (!it) return
  const patch = { name: sanitizeName(draft.name), x: draft.x, y: draft.y, ring: { ...draft.ring } }
  if (draft.ring.shape === 'rect') {
    const { w, h } = rectSize()
    patch.w = w; patch.h = h; draft.w = w; draft.h = h
  }
  updateInstance(draft.id, patch)
  /* 锁中心时 store 会按新直径重新落位 (syncRingSize), 把结果同步回 draft ——
   * 否则改完直径后「环心」还停在旧坐标, 下一次写回又把它推回去 */
  if (draft.ring.centerScreen) { draft.x = it.x; draft.y = it.y }
}
watch(() => [draft.ring, draft.w, draft.h, draft.name], () => liveApply(), { deep: true })

function rollback() {
  const sn = snapshot.value
  if (!sn || !draft.id) return
  updateInstance(draft.id, sn)
  Object.assign(draft, { name: sn.name, x: sn.x, y: sn.y, w: sn.w, h: sn.h, ring: { effect: 'static', countMs: 10000, tailMs: 200, arcEndDeg: null, segOn: false, segCount: 90, segGapDeg: 1, segGapPct: null, segPhaseDeg: 0, segMode: 'groove', segAA: 2, aaEdge: 2, segSplit: 5, segDepth: 60,
    /* 扫描导出: 线宽/步长 px, 档位 (null = steps), 颜色高低字节交换 */
    scanWidth: 2, scanStepPx: 0.5, scanLevels: null, scanSwap: true,
    mirrorX: false, ...sn.ring } })
}

function close() {
  // 新建模式下打开弹窗时实例已落库: 取消/关闭需回滚, 否则会留下一个未确认的圆环
  if (isNew.value && draft.id) removeInstance(draft.id)
  else rollback()                     // 编辑模式: 取消 = 回到打开前的样子 (实时写回的反作用)
  show.value = false
  isNew.value = false
  stopPvTimer()
  state.ui.dialogRingId = null
}
function curColor() {
  if (isGrad.value && selGrad.value) return Number(selGrad.value.c) & 0xFFFF
  return Number(colorTarget.value === 'fill' ? draft.ring.fillColor : draft.ring.trackColor) & 0xFFFF
}
function setCurColor(v) {
  const c = v & 0xFFFF
  if (isGrad.value && selGrad.value) {
    selGrad.value.c = c
    syncFlatFromGrad()          // 平色字段跟首点走 → 导出/旧逻辑始终有有效颜色
  } else {
    draft.ring[flatKey.value] = c
  }
  pushRecentColor(c)
  syncHex()
}
function syncHex() {
  const v = curColor() & 0xFFFF
  const { r, g, b } = rgb565To888(v)
  colorHex.value = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
}
function applyHex() {
  const m = /^#?([0-9a-f]{6})$/i.exec(colorHex.value.trim())
  if (!m) return
  const n = parseInt(m[1], 16)
  setCurColor(rgb888To565((n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF))
}
watch(colorTarget, () => { gradSel.value = 0; syncHex() })
const color565Text = computed(() => '0x' + (curColor() & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'))
const colorExact = computed(() => COLORS.find(c => c.v === (curColor() & 0xFFFF))?.n || '')
const css565 = v => { const { r, g, b } = rgb565To888(v & 0xFFFF); return `rgb(${r},${g},${b})` }
function lighten565(c, k) {
  const q = rgb565To888(c & 0xFFFF)
  return rgb888To565(
    Math.round(q.r + (255 - q.r) * k),
    Math.round(q.g + (255 - q.g) * k),
    Math.round(q.b + (255 - q.b) * k),
  )
}
function syncFlatFromGrad() {
  const arr = sortedGrad.value
  if (!arr.length) return
  draft.ring[flatKey.value] = Number(arr[0].c) & 0xFFFF
}
/* 纯色 ↔ 渐变: 切到渐变时以当前平色为 0%, 再补一个更亮的 100%;
 * 切回纯色时保留首点色, 渐变数组清空 (导出/固件口径不变)。 */
function setColorMode(mode) {
  if (mode === 'grad') {
    if (isGrad.value) return
    const flat = Number(draft.ring[flatKey.value]) & 0xFFFF
    draft.ring[gradKey.value] = [
      { p: 0, c: flat },
      { p: 100, c: lighten565(flat, 0.55) },
    ]
    gradSel.value = 0
    syncFlatFromGrad()
  } else {
    if (!isGrad.value) return
    const first = sortedGrad.value[0]
    const keep = first ? Number(first.c) & 0xFFFF : curColor()
    draft.ring[flatKey.value] = keep
    draft.ring[gradKey.value] = null
    gradSel.value = 0
  }
  syncHex()
}
function addGradStopAt(p) {
  if (!isGrad.value) setColorMode('grad')
  const arr = gradStopsRaw.value
  if (!arr) return
  const pos = Math.max(0, Math.min(100, Math.round((Number(p) || 0) * 10) / 10))
  const norm = ringGradStops(arr)
  const c = norm ? ringGrad565(norm, pos / 100, 0) : (Number(draft.ring[flatKey.value]) & 0xFFFF)
  const stop = { p: pos, c }
  arr.push(stop)
  arr.sort((a, b) => (Number(a.p) || 0) - (Number(b.p) || 0))
  gradSel.value = Math.max(0, arr.indexOf(stop))
  syncFlatFromGrad()
  syncHex()
}
function addGradStop() {
  if (!isGrad.value) setColorMode('grad')
  const pts = sortedGrad.value.map(s => Math.max(0, Math.min(100, Number(s.p) || 0)))
  if (!pts.some(p => p <= 0.01)) pts.unshift(0)
  if (!pts.some(p => p >= 99.99)) pts.push(100)
  let best = -1, p = 50
  for (let i = 0; i < pts.length - 1; i++) {
    const gap = pts[i + 1] - pts[i]
    if (gap > best) { best = gap; p = (pts[i] + pts[i + 1]) / 2 }
  }
  addGradStopAt(p)
}
function removeGradStop() {
  const arr = gradStopsRaw.value
  const s = selGrad.value
  if (!arr || arr.length <= 2 || !s) return
  const pos = sortedGrad.value.indexOf(s)
  if (pos <= 0 || pos >= sortedGrad.value.length - 1) return  // 首/末点保留, 否则两端没有停靠点
  const at = arr.indexOf(s)
  if (at < 0) return
  arr.splice(at, 1)
  gradSel.value = Math.max(0, Math.min(at, arr.length - 1))
  syncFlatFromGrad()
  syncHex()
}
function commitGradPos(v) {
  const s = selGrad.value
  if (!s) return
  s.p = Math.max(0, Math.min(100, Math.round((Number(v) || 0) * 10) / 10))
  const arr = gradStopsRaw.value
  if (arr) {
    arr.sort((a, b) => (Number(a.p) || 0) - (Number(b.p) || 0))
    gradSel.value = Math.max(0, arr.indexOf(s))
  }
  syncFlatFromGrad()
  syncHex()
}
function beginGradDrag(i, e) {
  const arr = gradStopsRaw.value
  if (!arr || !arr[i]) return
  gradSel.value = i
  const bar = e.currentTarget?.closest?.('.grad-bar')
  if (!bar) return
  const move = (ev) => {
    const rect = bar.getBoundingClientRect()
    const p = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width))) * 100
    const list = gradStopsRaw.value
    const s = list?.[i]
    if (!list || !s) return
    /* 拖动时不许越过相邻点: 保持原始顺序, 索引/选中态不跳 */
    const sorted = [...list].sort((a, b) => (Number(a.p) || 0) - (Number(b.p) || 0))
    const k = sorted.indexOf(s)
    const low = k > 0 ? Number(sorted[k - 1].p) || 0 : 0
    const high = k < sorted.length - 1 ? Number(sorted[k + 1].p) || 0 : 100
    const minP = k > 0 ? low + 0.1 : 0
    const maxP = k < sorted.length - 1 ? high - 0.1 : 100
    s.p = minP <= maxP
      ? Math.round(Math.max(minP, Math.min(maxP, p)) * 10) / 10
      : Math.round(((low + high) / 2) * 10) / 10
    syncFlatFromGrad()
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    const list = gradStopsRaw.value
    const s = list?.[i]
    if (list && s) {
      list.sort((a, b) => (Number(a.p) || 0) - (Number(b.p) || 0))
      gradSel.value = Math.max(0, list.indexOf(s))
    }
    syncHex()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}
function onGradBarClick(e) {
  if (!isGrad.value || e.target !== e.currentTarget) return
  const rect = e.currentTarget.getBoundingClientRect()
  const pos = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100
  const hit = sortedGrad.value.find(s => Math.abs((Number(s.p) || 0) - pos) <= 2)
  if (hit) {
    const arr = gradStopsRaw.value
    if (arr) gradSel.value = Math.max(0, arr.indexOf(hit))
    syncHex()
    return
  }
  addGradStopAt(pos)
}
function clampPct(p) { return Math.max(0, Math.min(100, Number(p) || 0)).toFixed(1) }
const gradientCss = computed(() => {
  const arr = sortedGrad.value
  if (!arr.length) return 'transparent'
  const parts = arr.map(s => css565(s.c) + ' ' + clampPct(s.p) + '%')
  return 'linear-gradient(90deg, ' + parts.join(', ') + ')'
})
function exportFlatColor(target) {
  const key = target === 'fill' ? 'fillGrad' : 'trackGrad'
  const flatKey2 = target === 'fill' ? 'fillColor' : 'trackColor'
  const norm = ringGradStops(draft.ring[key])
  const v = norm?.[0]?.c ?? (Number(draft.ring[flatKey2]) & 0xFFFF)
  return '0x' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')
}
function hex565(v) { return '0x' + (Number(v) & 0xFFFF).toString(16).toUpperCase().padStart(4, '0') }
function rawIndexOfStop(s) {
  const arr = gradStopsRaw.value
  return arr ? Math.max(0, arr.indexOf(s)) : 0
}
function selectGradStop(s) {
  gradSel.value = rawIndexOfStop(s)
  syncHex()
}


const segExport = computed(() => {
  const g = ringSegGeom({ ...draft.ring, segOn: true })
  if (!g) return { n: 0, p: 0, pct: 0, gap: 0, body: 0, lit: 0, phase: 0, open: false, span: 360 }
  const steps = Math.max(1, Math.round(draft.ring.steps || 40))
  const value = Math.max(0, Number(draft.ring.value || 0))
  return { n: g.N, p: g.P, pct: g.pct, gap: g.gap, body: g.body,
           lit: Math.max(0, Math.min(g.N, Math.round(value * g.N / steps))),
           phase: g.phase, open: g.open, span: g.span }
})
const exportRows = computed(() => {
  const trackN = Array.isArray(draft.ring.trackGrad) ? draft.ring.trackGrad.length : 0
  const fillN = Array.isArray(draft.ring.fillGrad) ? draft.ring.fillGrad.length : 0
  const rows = [
    ['RING_ARC_START_DEF', String(startU.value)],
    ['RING_ARC_END_DEF', range.value.full ? '—' : String(endU.value)],
    ['RING_ARC_SPAN_DEF', String(range.value.rangeU) + (range.value.full ? ' (整圈)' : '')],
    ['RING_ARC_EFFECT_DEF', isCountdown.value ? '1 (倒计时)' : '0 (静态)'],
    ['RING_ARC_TAIL_MS_DEF', isCountdown.value ? String(tailMsSafe.value) : '—'],
    ['RING_ARC_TRACK_DEF', exportFlatColor('track') + (trackN ? ' · 首点' : '')],
    ['RING_ARC_FILL_DEF', exportFlatColor('fill') + (fillN ? ' · 首点' : '')],
    ['RING_ARC_STEPS_DEF', String(draft.ring.steps)],
    ['RING_ARC_VALUE_DEF', String(draft.ring.value)],
    ['RING_ARC_CAPS_DEF', draft.ring.caps ? '1 (圆端帽)' : '0 (平头)'],
    ['RING_SEG_ON', draft.ring.segOn ? '1 (开)' : '0 (关)'],
    ['RING_SEG_N', String(segExport.value.n) + ' · 节距 ' + segExport.value.p.toFixed(3) + '° · 每段 ' + segExport.value.body.toFixed(3) + '°'],
    ['RING_SEG_LIT_DEF', String(segExport.value.lit) + ' / ' + String(segExport.value.n) + ' (当前静态值)'],
    ['RING_SEG_ARC_REL', segExport.value.open ? '1 (弧内 N 段)' : '0 (整圈)'],
    ['RING_SEG_GAP_X10', String(Math.round(segExport.value.gap * 10)) + ' (0.1°)'],
    ['RING_SEG_GAP_X10000', String(Math.round(segExport.value.gap * 10000)) + ' (0.0001°, 固定)'],
    ['RING_SEG_BODY_X10000', String(Math.round(segExport.value.body * 10000)) + ' (0.0001°, 每段)'],
    ['RING_SEG_PITCH_X10000', String(Math.round(segExport.value.p * 10000)) + ' (0.0001°)'],
    ['RING_SEG_PHASE_X10', String(Math.round(segExport.value.phase * 10))],
    ['RING_SEG_SPLIT_X10', String(Math.max(0, Math.min(10, Math.round(draft.ring.segSplit ?? 5)))) + ' (0=段末 / 5=槽中 / 10=下段起点)'],
    ['RING_SEG_AA_X10', String(Math.round((Number(draft.ring.segAA) || 0) * 10)) + ' (0.1px, 总宽; 0 = 硬边)'],
    ['RING_AA_EDGE_X10', String(Math.round((Number(draft.ring.aaEdge ?? 2) || 0) * 10)) + ' (0.1px, 端点平口, 两端同值)'],
    ['RING_SEG_MODE', '1 (暗槽, 固定)'],
    ['RING_SEG_DEPTH', String(draft.ring.segMode === 'cut' ? 100 : Math.max(0, Math.min(100, Math.round(draft.ring.segDepth ?? 60)))) + ' %'],
  ]
  if (trackN || fillN) {
    rows.push(['网页渐变', '轨道 ' + trackN + ' 点 · 填充 ' + fillN + ' 点（板端仍单色，导出取 0% 首点）'])
  }
  return rows
})

function apply() {
  draft.name = sanitizeName(draft.name)
  const patch = { name: draft.name, x: draft.x, y: draft.y, ring: { ...draft.ring } }
  if (draft.ring.shape === 'rect') {
    const { w, h } = rectSize()
    patch.w = w; patch.h = h; draft.w = w; draft.h = h
  }
  updateInstance(draft.id, patch)
  isNew.value = false   // 已应用: close() 不回滚
  snapshot.value = null // 确定后不再回滚 (实时写回的结果就是要的)
  close()
}
function doRemove() {
  if (draft.id) removeInstance(draft.id)
  isNew.value = false
  close()
}
let maskDownOnMask = false
function onMaskDown(e) { maskDownOnMask = e.target === e.currentTarget }
function onMaskClick(e) {
  // 仅当按下与松开都在遮罩上才算空白点击 (拖选文字松开在窗外不会误关)
  if (e.target === e.currentTarget && maskDownOnMask) apply()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="mask" @pointerdown="onMaskDown" @click="onMaskClick">
      <div class="dialog panel">
        <div class="panel-title ring-title">
          <span class="badge">RING</span>
          <span class="tt">{{ isNew ? '新建圆环' : '圆环属性' }}</span>
          <span class="sub">单例引擎 · 起始/结束角 · 倒计时</span>
          <span class="grow"></span>
          <button @click="downloadPreviewImage()" :disabled="!pvCanvas"
            title="把左边「实时预览」那一张按 1:1 原始像素存成 PNG (圆环以外透明)">⤓ 图片下载</button>
          <button class="danger" v-if="!isNew" @click="doRemove">删除</button>
          <button @click="close">取消</button>
          <button class="primary" @click="apply">确定</button>
        </div>

        <div class="body">
          <!-- ===== 左: 实时预览 + 角度盘 ===== -->
          <aside class="preview-pane">
            <div class="pv-head">
              <div>
                <div class="pv-title">实时预览</div>
                <div class="pv-sub">
                  {{ draft.ring.shape === 'rect'
                    ? pvSize.w + '×' + pvSize.h + ' 圆角矩形 · r' + Math.round(draft.ring.rad)
                    : 'Ø' + Math.round(draft.ring.rOut * 2) + ' · 厚 ' + Math.round(draft.ring.rOut - draft.ring.rIn) + 'px' }}
                </div>
              </div>
              <div class="pv-tools">
                <button class="mini" :disabled="pvZoom <= 1" title="缩小预览" @click="zoomPv(-0.5)">−</button>
                <span class="mono pv-zoom" title="当前预览缩放倍数 (只放大显示, 不改画布)">{{ pvZoom.toFixed(1) }}×</span>
                <button class="mini" :disabled="pvZoom >= PV_ZOOM_MAX" title="放大预览 (看缝边/AA 细节)" @click="zoomPv(0.5)">＋</button>
                <button class="mini" :disabled="pvZoom <= 1" title="回到适配大小" @click="setPvZoom(1)">适配</button>
                <button class="mini" @click="previewRun = !previewRun">{{ previewRun ? '暂停' : '播放' }}</button>
              </div>
            </div>

            <div ref="pvScroll" class="stage-wrap">
              <div ref="stageEl" class="stage"
                   :class="{ 'circle-stage': draft.ring.shape === 'circle', 'pv-pixel': pvZoom >= 2 }"
                   :style="stageStyle">
                <canvas ref="pvCanvas" class="pv"></canvas>
                <svg v-if="draft.ring.shape === 'circle'" class="dial" viewBox="0 0 360 360">
                  <circle cx="180" cy="180" :r="DIAL_R" class="guide" />
                  <line v-for="(t, i) in dialTicks" :key="i" :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2"
                    class="tick" :class="{ major: t.major }" />
                  <text v-for="l in dialLabels" :key="l.t" :x="l.x" :y="l.y" class="dial-label">{{ l.t }}</text>
                  <circle v-if="range.full" cx="180" cy="180" :r="DIAL_R" class="range-full" />
                  <path v-else :d="dialArcPath" class="range-arc" />
                  <line :x1="180" :y1="180" :x2="dialStartPos.x" :y2="dialStartPos.y" class="spoke start" />
                  <template v-if="!range.full">
                    <line :x1="180" :y1="180" :x2="dialEndPos.x" :y2="dialEndPos.y" class="spoke end" />
                    <circle :cx="dialEndPos.x" :cy="dialEndPos.y" r="9" class="handle end"
                      @pointerdown.stop="beginDial('end', $event)" />
                    <text :x="dialEndPos.x + 15" :y="dialEndPos.y + 4" class="handle-label end">止</text>
                  </template>
                  <circle :cx="dialStartPos.x" :cy="dialStartPos.y" r="9" class="handle start"
                    @pointerdown.stop="beginDial('start', $event)" />
                  <text :x="dialStartPos.x + 15" :y="dialStartPos.y + 4" class="handle-label start">起</text>
                </svg>
                <div v-if="isCountdown" class="count-overlay">
                  <b>{{ countLeftText }}</b>
                  <span>秒</span>
                </div>
              </div>
            </div>

            <div class="chips">
              <span class="chip">{{ draft.ring.shape === 'rect' ? pvSize.w + '×' + pvSize.h : 'Ø' + Math.round(draft.ring.rOut * 2) }}</span>
              <span class="chip">{{ range.full ? '整圈 360°' : range.spanDeg.toFixed(0) + '° 弧' }}</span>
              <span class="chip" :class="{ hot: isCountdown }">{{ isCountdown ? '倒计时 ' + (countMs / 1000) + 's' : '静态进度' }}</span>
              <span v-if="tailU > 0" class="chip">拖尾 {{ (tailU / 2).toFixed(1) }}°</span>
            </div>

            <div class="info-card">
              <div class="info-row"><span>起始角</span><b>{{ fmtDeg(range.startDeg) }}</b><span>结束角</span><b>{{ range.full ? '—' : fmtDeg(range.endDeg) }}</b></div>
              <div class="info-row"><span>弧向</span><b>{{ draft.ring.arcDir > 0 ? '顺时针' : '逆时针' }}</b><span>端帽</span><b>{{ draft.ring.caps ? '圆头' : '平头' }}</b></div>
              <div class="info-row"><span>进度</span><b>{{ liveValueText }} / {{ draft.ring.steps }}</b><span>环心</span><b>{{ ringCenter.x }}, {{ ringCenter.y }}</b></div>
            </div>
            <div class="hint" v-if="draft.ring.shape === 'circle'">拖动角度盘上的<b class="start-t">起</b>/<b class="end-t">止</b>手柄可直接改起始角与结束角；范围外的环带不绘制。</div>
            <div class="hint" v-else>圆角矩形的范围按路径长度计算（顶边中点 = 0°），起止角数字在「基本」页的「起止角」里改。</div>
            <div class="dim note2">渲染与板子同一套整数几何（同步预览时逐像素对拍）。倒计时拖尾口径 = 固件 RINGUI_TAIL_MS。</div>
          </aside>

          <!-- ===== 右: 分组属性 ===== -->
          <section class="editor-pane">
            <nav class="tabs">
              <button :class="{ on: tab === 'basic' }" @click="tab = 'basic'">基本</button>
              <button :class="{ on: tab === 'effect' }" @click="tab = 'effect'">效果</button>
              <button :class="{ on: tab === 'look' }" @click="tab = 'look'">外观</button>
            </nav>

            <div class="tab-body">
              <!-- 基本 -->
              <template v-if="tab === 'basic'">
                <div class="card">
                  <div class="card-title">图层</div>
                  <div class="field-row">
                    <label>名称</label>
                    <input class="mono" v-model="draft.name" style="width: 120px" />
                    <label title="图层左上角在屏幕上的坐标 (不是圆心)">位置</label>
                    <input type="number" step="0.5" v-model.number="draft.x" style="width: 62px" :disabled="draft.ring.centerScreen" />
                    <input type="number" step="0.5" v-model.number="draft.y" style="width: 62px" :disabled="draft.ring.centerScreen" />
                    <label class="chk"><input type="checkbox" v-model="draft.ring.centerScreen" @change="onCenterScreenChange" />锁定屏幕中心</label>
                  </div>
                  <div class="field-row">
                    <label>圆心</label>
                    <span class="mono" :title="'环心的实际屏幕坐标 = floor(位置 + (尺寸-1)/2), 就是导出/固件用的 RING_CX / RING_CY'">({{ ringCenter.x }}, {{ ringCenter.y }})</span>
                    <span class="dim">屏幕中心 ({{ screenCenterPx.cx }}, {{ screenCenterPx.cy }})
                      <template v-if="isCentered">· 已居中 ✓</template>
                      <template v-else>· 偏 ({{ ringCenter.x - screenCenterPx.cx }}, {{ ringCenter.y - screenCenterPx.cy }}) px</template>
                    </span>
                    <button class="mini" @click="draft.ring.centerScreen = true; centerCurrent()">居中</button>
                  </div>
                  <div class="field-row">
                    <label>形状</label>
                    <label class="radio"><input type="radio" value="circle" v-model="draft.ring.shape" @change="onShapeChange" />圆环</label>
                    <label class="radio"><input type="radio" value="rect" v-model="draft.ring.shape" @change="onShapeChange" />圆角矩形</label>
                    <span class="dim">圆角矩形光斑沿边框跑 (与板子同一套整数几何)</span>
                  </div>
                  <div class="dim note2">放哪一页在图层列表的「页」里填 (圆环在哪页 = 那一页启停圆环)。</div>
                </div>

                <div class="card">
                  <div class="card-title">几何</div>
                  <template v-if="draft.ring.shape !== 'rect'">
                    <div class="field-row">
                      <label>外径 Ø / 内径 Ø</label>
                      <input type="number" min="2" max="960" v-model="dOutText" @change="commitDiameters" style="width: 66px" />
                      <input type="number" min="0" max="960" v-model="dInText" @change="commitDiameters" style="width: 66px" />
                      <span class="dim">px · 厚度 {{ Math.round(draft.ring.rOut - draft.ring.rIn) }}</span>
                      <button class="mini" @click="fillScreen" :title="`外径撑满可用区 ${Math.round(usableDiameter(sc))}px (再扣掉「留边」)`">Ø 撑满屏幕</button>
                    </div>
                  </template>
                  <template v-else>
                    <div class="field-row">
                      <label>尺寸 W×H</label>
                      <input type="number" min="8" max="1024" v-model.number="draft.w" style="width: 66px" />
                      <input type="number" min="8" max="1024" v-model.number="draft.h" style="width: 66px" />
                      <span class="dim">px (= 屏幕尺寸的图层框)</span>
                      <button class="mini" @click="fitScreenRect">撑满屏幕</button>
                    </div>
                    <div class="field-row">
                      <label title="环带宽度 (外沿→内沿)">厚度</label>
                      <input type="number" min="1" max="200" v-model.number="draft.ring.thick" style="width: 58px" />
                      <span class="dim">px → 环带外沿 {{ rectOuter.w }}×{{ rectOuter.h }}</span>
                    </div>
                    <div class="field-row">
                      <label title="外边缘的圆角半径">外圆角</label>
                      <input type="number" min="0" max="400" v-model.number="draft.ring.rad" style="width: 66px" />
                      <span class="dim">px · 实际 {{ Math.round(rectRadii.radOut) }}
                        <template v-if="rectRadii.clamped">(被抬到 厚度+1)</template>
                      </span>
                    </div>
                    <div class="field-row">
                      <label title="内角半径。自动 = 外圆角 − 厚度">内圆角</label>
                      <label class="chk"><input type="checkbox" v-model="radInAuto" />自动</label>
                      <input type="number" min="0" max="400" v-model.number="draft.ring.radIn" :disabled="radInAuto"
                             :placeholder="String(Math.round(rectRadii.radIn))" style="width: 66px" />
                      <span class="dim">px · 实际 {{ Math.round(rectRadii.radIn) }}</span>
                    </div>
                  </template>
                  <div class="field-row">
                    <label title="留边 (总, px): 环带外沿离图层外框的余量, 内部计算, 不改尺寸">留边</label>
                    <input type="number" min="0" max="200" v-model.number="draft.ring.inset" style="width: 58px" />
                    <span class="dim">px
                      <template v-if="draft.ring.shape !== 'rect'">→ 实际外径 Ø{{ Math.round((draft.ring.rOut - Math.max(0, Math.round(draft.ring.inset ?? 0)) / 2) * 2) }}</template>
                      <template v-else>→ 环带外沿 {{ rectOuter.w }}×{{ rectOuter.h }}</template>
                    </span>
                  </div>
                  <div class="field-row">
                    <label>边缘 AA</label>
                    <input type="number" min="0.5" max="6" step="0.5" v-model.number="draft.ring.aa" style="width: 58px" />
                    <span class="dim">px (内外边缘 + 端帽抗锯齿宽度)</span>
                  </div>
                </div>

                <div class="card">
                  <div class="card-title">分割 (缝宽 %)</div>
                  <div class="field-row">
                    <label>缝宽</label>
                    <input type="number" min="0" max="100" step="0.1" v-model.number="segGapPctValue"
                           @wheel.prevent="onSegGapWheel"
                           style="width: 68px" title="0% = 关闭; 100% = 只有缝 (全暗); 滚轮 ±0.5%, 手动可输 0.01" />
                    <span class="dim">% · 0=关闭 · 100%=只有缝 · 滚轮±0.5% · 可手输0.01 · ≈{{ segGapDegValue.toFixed(3) }}°</span>
                    <button class="mini" @click="applySegPreset">参考图 90 段</button>
                  </div>
                  <div class="field-row">
                    <label>段数</label>
                    <input type="number" min="2" max="180" step="1" v-model.number="draft.ring.segCount"
                           :disabled="!draft.ring.segOn || segFollowSteps" style="width: 62px" />
                    <button class="mini" :class="{ on: segFollowSteps }" :disabled="!draft.ring.segOn"
                            @click="toggleSegFollowSteps"
                            title="段数 = 进度满档 steps；预览位置请改进度当前值，不要改段数当位置">
                      {{ segFollowSteps ? '已跟随满档 ' + progSteps : '跟随进度满档' }}
                    </button>
                    <span class="dim">满档 {{ progSteps }} / 当前 {{ progValue }} · {{ range.full ? ((Number(draft.ring.segCount) || 90) + ' 段 · ' + (Number(draft.ring.segCount) || 90) + ' 条缝') : (((Number(draft.ring.segCount) || 90) - 1) + ' 条内部缝') }} · 节距 {{ segPitch.toFixed(3) }}° · 每段 {{ segBody.toFixed(3) }}°</span>
                  </div>
                  <div class="field-row">
                    <label title="与「进度 → 当前值」是同一个 RING_ARC_VALUE_DEF，不是第二个分割状态">预览位置</label>
                    <input type="range" min="0" :max="progSteps" step="1" v-model.number="draft.ring.value" class="wide" />
                    <span class="mono" style="min-width: 54px; text-align: right">{{ progValue }} / {{ progSteps }}</span>
                    <span class="dim">同进度当前值；只改位置，段数用「跟随进度满档」</span>
                  </div>
                  <div class="field-row">
                    <label title="档位分割线在槽里的位置: 0 = 段体末尾, 5 = 槽中点 (与 MCU 一致), 10 = 下一段开头">分割点</label>
                    <input type="range" min="0" max="10" step="1" v-model.number="draft.ring.segSplit"
                           :disabled="!draft.ring.segOn" class="wide" />
                    <span class="mono" style="width: 34px; text-align: right">{{ Number(draft.ring.segSplit ?? 5) }}</span>
                    <span class="dim">0=段末 · 5=槽中 · 10=下段起点 · 导出 <code>RING_SEG_SPLIT_X10</code></span>
                  </div>
                  <div class="dim note2">
                    分割点决定每档末尾停在槽里的位置：固件 <code>Ring_SegSweep()</code> 用
                    <code>fillEnd = lit×P − gap×(10−split)/10</code>，网页预览也用同一式并把结果
                    按 0.5° 向上取整。默认 5 = 槽中点；0 = 段体末尾（旧行为）；10 = 下一段开头。
                  </div>
                  <div class="field-row">
                    <label>相位</label>
                    <input type="number" min="-180" max="180" step="0.5" v-model.number="draft.ring.segPhaseDeg"
                           :disabled="!draft.ring.segOn" style="width: 62px" />
                    <span class="dim">° · 0 = 弧起点正好是一段的开始</span>
                    <button class="mini" :disabled="!draft.ring.segOn" @click="draft.ring.segPhaseDeg = 0">对齐弧起点</button>
                  </div>
                  <div class="field-row">
                    <label title="沟槽抗锯齿: 段与段之间缝隙的过渡总宽度, 边界两侧各铺一半; 0 = 硬边">沟槽 AA</label>
                    <input type="range" min="0" max="4" step="0.1" v-model.number="draft.ring.segAA"
                           :disabled="!draft.ring.segOn" class="wide" />
                    <input type="number" min="0" max="4" step="0.1" v-model.number="draft.ring.segAA"
                           :disabled="!draft.ring.segOn" style="width: 54px" />
                    <span class="dim">px</span>
                    <button class="mini" :disabled="!draft.ring.segOn" @click="draft.ring.segAA = 0" title="关闭 AA (硬边)">硬边</button>
                  </div>
                  <div class="dim note2">
                    沟槽 AA 是<b>总过渡宽度</b>（px）：边界处 50%，向段内/缝内各铺一半，所以加大 AA 会同时软化缝的两侧
                    （早先只软段内一侧，缝的另一侧是硬边）。同步/理想预览都生效；导出写 <code>RING_SEG_AA_X10</code>（0.1px），
                    板端可用 <code>Ring_SetSegAA()</code> 运行期现场改。
                  </div>
                  <div class="field-row">
                    <label title="端点抗锯齿: 整条弧起点/终点两条平口的过渡总宽度 (两端同一个值); 0 = 硬边">端点 AA</label>
                    <input type="range" min="0" max="6" step="0.1" v-model.number="draft.ring.aaEdge"
                           :disabled="!!draft.ring.caps" class="wide" />
                    <input type="number" min="0" max="6" step="0.1" v-model.number="draft.ring.aaEdge"
                           :disabled="!!draft.ring.caps" style="width: 54px" />
                    <span class="dim">px</span>
                    <button class="mini" :disabled="!!draft.ring.caps"
                            title="端点 AA 跟随上面的沟槽 AA"
                            @click="draft.ring.aaEdge = draft.ring.segAA">跟随沟槽</button>
                  </div>
                  <div class="dim note2">
                    端点 AA 只作用在<b>起始角 / 结束角</b>这两条静态端面上（平口、圆端帽关掉时），
                    一个值同时管起点和终点，并且<b>只向边界外延伸</b>——端面本身保持满高亮，不会被削掉半像素。
                    进度未满时（如 10/35）填充前沿也做一段**向外** AA（与 MCU 这一版一致，
                    颜色取前沿处的段/槽色，不侵蚀已亮段体）；只有满档时前沿才与结束角重合。
                    0 = 硬边。导出 <code>RING_AA_EDGE_X10</code>，板端 <code>Ring_SetEdgeAA()</code> 运行期可改。
                  </div>
                  <div class="field-row">
                    <label title="暗槽的压暗量: 0 = 不压暗, 100 = 压到黑 (等价于原来的切断)">槽深</label>
                    <input type="range" min="0" max="100" v-model.number="draft.ring.segDepth"
                           :disabled="!draft.ring.segOn" class="wide" />
                    <input type="number" min="0" max="100" step="1" v-model.number="draft.ring.segDepth"
                           :disabled="!draft.ring.segOn" style="width: 54px" />
                    <span class="dim">%</span>
                    <button class="mini" :disabled="!draft.ring.segOn" @click="draft.ring.segDepth = 100" title="100% = 压到黑 (原「切断」)">压黑</button>
                  </div>
                  <div class="dim note2">
                    缝宽百分比只用于网页预览；导出会换算成固定值（gap / body / pitch，0.001°），MCU 不再按百分比二次计算。
                    0% = 关闭，100% = 只有缝（全暗）；开口弧 70 段 = 69 条内部缝，首尾不留缝，每段 body 等长。
                    分割只有「暗槽」一种形态：槽深 100% 就是压到黑，等于原来的「切断」，所以不再单列模式选项。
                    端帽盘保持实心，平口请把「圆端帽」关掉。
                    预览切面位置用「进度 → 当前值」，段数用「跟随进度满档」；不要把段数改成 50/56 当位置，否则会出现第二个分割位置。
                  </div>
                </div>

                <div class="card">
                  <div class="card-title">起止角</div>
                  <div class="field-row">
                    <label>范围</label>
                    <label class="radio"><input type="radio" :checked="range.full" @change="setRangeMode(true)" />整圈</label>
                    <label class="radio"><input type="radio" :checked="!range.full" @change="setRangeMode(false)" />部分弧</label>
                    <span class="dim">跨度 <b class="mono">{{ range.spanDeg.toFixed(1) }}°</b> · {{ range.rangeU }} × 0.5°</span>
                  </div>
                  <div class="field-row">
                    <label>起始角</label>
                    <input type="number" min="-360" max="360" step="1" v-model.number="draft.ring.startDeg" style="width: 66px" />
                    <input type="range" min="-360" max="360" step="1" v-model.number="draft.ring.startDeg" class="wide" />
                    <span class="dim">270 = 顶部 (-90 同义)</span>
                  </div>
                  <div class="field-row">
                    <label>结束角</label>
                    <input type="number" min="-360" max="360" step="1" v-model.number="draft.ring.arcEndDeg"
                           :disabled="range.full" style="width: 66px" :placeholder="range.full ? '整圈' : ''" />
                    <input type="range" min="-360" max="360" step="1" v-model.number="draft.ring.arcEndDeg"
                           :disabled="range.full" class="wide" />
                    <span class="dim">按弧向从起始角走到这里</span>
                  </div>
                  <div class="field-row">
                    <label>弧向</label>
                    <label class="radio"><input type="radio" :value="1" v-model.number="draft.ring.arcDir" />顺时针</label>
                    <label class="radio"><input type="radio" :value="-1" v-model.number="draft.ring.arcDir" />逆时针</label>
                    <label class="chk"><input type="checkbox" v-model="draft.ring.caps" />圆端帽</label>
                    <span class="dim">整圈时端帽自动隐藏</span>
                  </div>
                  <div class="field-row">
                    <label>镜像</label>
                    <label class="chk" title="把起止角/弧向/白斑角/白斑转向一起翻到左右另一侧；再点一次翻回。只改设计参数，不改图层位置">
                      <input type="checkbox" :checked="draft.ring.mirrorX" @change="applyMirrorX" />左右镜像
                    </label>
                    <span class="dim">同步翻转起止角 / 弧向 / 白斑角 / 转向{{ draft.ring.mirrorX ? ' · 当前为镜像' : '' }}</span>
                  </div>
                </div>

                <div class="card">
                  <div class="card-title">进度 (导出 RING_ARC_STEPS/VALUE)</div>
                  <div class="field-row">
                    <label>满档</label>
                    <input type="number" min="2" max="360" v-model.number="draft.ring.steps" style="width: 60px" />
                    <label>当前</label>
                    <input type="number" min="0" :max="draft.ring.steps" v-model.number="draft.ring.value" style="width: 60px" />
                    <input type="range" min="0" :max="draft.ring.steps" step="1" v-model.number="draft.ring.value" class="wide" />
                  </div>
                  <div class="dim note2">进度 = value / steps × 范围跨度；倒计时效果运行时会覆盖这个静态值。</div>
                </div>

                <div class="card">
                  <div class="card-title">范围速查</div>
                  <div class="export-grid">
                    <span class="mono dim">屏幕方位</span><span>0° 右 · 90° 下 · 180° 左 · 270° 上</span>
                    <span class="mono dim">本弧</span><span>{{ range.full ? '整圈' : range.spanDeg.toFixed(1) + '° · ' + range.rangeU + ' × 0.5°' }}；{{ draft.ring.arcDir > 0 ? '顺时针' : '逆时针' }} 推进</span>
                    <span class="mono dim">导出</span><span>START {{ startU }} · END {{ range.full ? '—' : endU }} · SPAN {{ range.rangeU }} (0.5° 单位)</span>
                  </div>
                </div>
              </template>

              <!-- 效果 -->
              <template v-else-if="tab === 'effect'">
                <div class="card">
                  <div class="card-title">预览效果</div>
                  <div class="effect-grid">
                    <label class="effect-card" :class="{ on: draft.ring.effect === 'static' }">
                      <input type="radio" value="static" v-model="draft.ring.effect" />
                      <b>静态进度</b>
                      <span>按「当前/满档」固定显示，适合普通进度环。</span>
                    </label>
                    <label class="effect-card" :class="{ on: isCountdown }">
                      <input type="radio" value="countdown" v-model="draft.ring.effect" />
                      <b>倒计时</b>
                      <span>满圈按真实时间递减到 0，末端带拖尾渐隐。</span>
                    </label>
                  </div>
                </div>

                <div class="card" v-if="isCountdown">
                  <div class="card-title">倒计时参数</div>
                  <div class="field-row">
                    <label>总时长</label>
                    <input type="number" min="1" max="600" step="0.1" v-model.number="countSec" style="width: 70px" />
                    <span class="dim">秒 (内部 countMs = {{ countMs }} ms)</span>
                    <button class="mini" @click="restartCountdown">重播</button>
                  </div>
                  <div class="field-row">
                    <label title="递减边缘的拖尾时长；固件 ringui_trail_u(sel) = 720×TAIL_MS/(1000×档位)">拖尾</label>
                    <input type="number" min="0" max="5000" step="10" v-model.number="draft.ring.tailMs" style="width: 70px" />
                    <span class="dim">ms → 等效 {{ tailU }} × 0.5° ({{ (tailU / 2).toFixed(1) }}°)，与固件 RINGUI_TAIL_MS 同式</span>
                  </div>
                  <div class="field-row">
                    <label>当前</label>
                    <b class="mono">{{ liveValueText }} / {{ draft.ring.steps }}</b>
                    <span class="dim">实时值；导出的静态值 = {{ draft.ring.value }}（RING_ARC_VALUE_DEF）</span>
                  </div>
                  <div class="dim note2">倒计时以真实时间为准（不依赖帧率）：value = steps × (1 − elapsed/total)，走完停 0.6s 后循环。边缘拖尾 {{ tailU > 0 ? (tailU / 2).toFixed(1) + '° 内从填充色线性渐隐到轨道色' : '已关闭（tailMs = 0，硬边）' }}。</div>
                </div>

                <!-- 白斑 (原「白斑」页, 已并入效果) -->
                <div class="card">
                  <div class="card-title">白斑 (乘法提亮)</div>
                  <div class="field-row">
                    <label class="chk" title="板子上画不画白斑（编译期总开关，导出 RING_GLINT_DEF）"><input type="checkbox" v-model="draft.ring.glintOn" />启用白斑</label>
                    <label>白斑转向</label>
                    <select v-model.number="draft.ring.dir" style="width: 130px">
                      <option :value="1">正转 顺时针</option>
                      <option :value="-1">反转 逆时针</option>
                    </select>
                  </div>
                  <div class="field-row">
                    <label>角宽 σ</label>
                    <input type="number" min="1" max="45" v-model.number="draft.ring.glintSigma" style="width: 58px" />
                    <label>范围</label>
                    <input type="number" min="1" max="180" v-model.number="draft.ring.glintSpanDeg" style="width: 58px" />
                    <span class="dim">±° (超出即 0, 固件 RING_SPAN_DEG; 推荐 = 3σ)</span>
                  </div>
                  <div class="field-row">
                    <label>初始化档位</label>
                    <input type="number" min="1" max="40" v-model.number="draft.ring.gear" style="width: 58px" />
                    <label>帧间隔</label>
                    <input type="number" min="10" max="2000" v-model.number="draft.ring.glintMs" style="width: 66px" />
                    <span class="dim">ms → {{ (draft.ring.gear * 0.5 * 1000 / Math.max(10, draft.ring.glintMs || 100)).toFixed(0) }}°/s</span>
                  </div>
                  <div class="field-row">
                    <label>弧长 (预览)</label>
                    <input type="number" min="0.5" max="64" step="0.5" v-model.number="draft.ring.glintArcPx" style="width: 62px" />
                    <span class="dim">px/步</span>
                    <button class="mini" :title="'按板子算: 档位 × 0.5° 折算到一圈弧长 = ' + boardStepPx.toFixed(2) + ' px/步'"
                      @click="draft.ring.glintArcPx = Math.round(boardStepPx * 100) / 100">≈ 板子 {{ boardStepPx.toFixed(2) }}</button>
                  </div>
                  <div class="field-row">
                    <label>初始角 (预览)</label>
                    <input type="number" min="0" max="359" v-model.number="draft.ring.glintDeg" style="width: 62px" />
                    <span class="dim">° · 固件复位时白斑固定在 0°</span>
                  </div>
                </div>
                <div class="dim note2">白斑沿路径转：整圈时按一圈弧长折算角度；部分弧时仍按实际路径走（与板子一致）。</div>

                <div class="card">
                  <div class="card-title">逐像素扫描导出 (ring_scan.h / .c)</div>
                  <div class="field-row">
                    <label title="沿中径两侧取多少像素 (参考图 picArc 是 2px 宽)">线宽</label>
                    <input type="number" min="1" max="64" v-model.number="draft.ring.scanWidth" style="width: 58px" />
                    <span class="dim">px</span>
                    <label title="沿弧的采样步长; 越小越密, 表越大">步长</label>
                    <input type="number" min="0.1" max="8" step="0.1" v-model.number="draft.ring.scanStepPx" style="width: 62px" />
                    <span class="dim">px</span>
                    <label title="分档数; 空 = 用「满档 steps」">档位</label>
                    <input type="number" min="2" max="720" v-model.number="draft.ring.scanLevels"
                           :placeholder="String(draft.ring.steps)" style="width: 62px" />
                  </div>
                  <div class="field-row">
                    <label class="chk" title="某些 LCD_drawPx 先发低字节；picArc 里的颜色可能已做高低交换">
                      <input type="checkbox" v-model="draft.ring.scanSwap" />颜色高低字节交换
                    </label>
                    <span class="dim">沿弧的进度方向逐坐标 + RGB565；frameIndices 每档结束下标</span>
                  </div>
                  <div class="dim note2">
                    导出时按「满档」渲染后扫描（白斑/动画关闭），坐标是屏幕绝对坐标；颜色取 2px 线宽内实际渲染像素。
                    frameIndices[L] = 第 L 档最后一个像素下标（含），frameIndices[0]=0、满档 = COUNT−1。
                    目标引擎可直接用 picArc/frameIndices 替换自己的扫描表，档位数用 RING_SCAN_LEVELS。
                  </div>
                </div>

                <div class="card">
                  <div class="card-title">预览开关 (不导出)</div>
                  <div class="field-row">
                    <label class="chk" title="静态模式下进度 0→满档循环；倒计时模式由时间驱动"><input type="checkbox" v-model="draft.ring.autoArc" />自动动画</label>
                    <label class="chk"><input type="checkbox" v-model="draft.ring.autoGlint" />光斑动画</label>
                    <label class="chk" title="按 MCU 的真实算法预览（覆盖率查表 + 整数几何）"><input type="checkbox" v-model="draft.ring.syncMcU" />与 MCU 同步预览</label>
                  </div>
                </div>

                <div class="card">
                  <div class="card-title">倒计时口径</div>
                  <div class="dim note2">
                    倒计时 value = steps × (1 − elapsed / total)，从满档递减到 0；末端拖尾长度
                    = 720 × tailMs / (1000 × 档位) 个 0.5°，在填充色 → 轨道色之间线性渐隐。
                    板端对应 app_ring_ui.c 的 g_uiUvRemain 与 RINGUI_TAIL_MS；当前固件倒计时仍固定整圈，
                    网页的起止角范围属于设计预览。
                  </div>
                </div>
              </template>

              <!-- 外观 -->
              <template v-else>
                <div class="card">
                  <div class="card-title">颜色</div>
                  <div class="field-row">
                    <label>目标</label>
                    <label class="radio"><input type="radio" value="track" v-model="colorTarget" />轨道色</label>
                    <label class="radio"><input type="radio" value="fill" v-model="colorTarget" />填充色</label>
                    <span class="tag mono">{{ color565Text }}</span>
                    <span class="dim" v-if="isGrad && selGrad">选中渐变点 · {{ clampPct(selGrad.p) }}%</span>
                  </div>
                  <div class="field-row">
                    <label>模式</label>
                    <div class="seg">
                      <button type="button" :class="{ on: !isGrad }" @click="setColorMode('solid')">纯色</button>
                      <button type="button" :class="{ on: isGrad }" @click="setColorMode('grad')">渐变</button>
                    </div>
                    <span class="dim">{{ isGrad ? '沿弧长插值 · ' + sortedGrad.length + ' 个渐变点' : '导出 / 板端使用单色' }}</span>
                  </div>

                  <div v-if="isGrad" class="grad-editor">
                    <div class="grad-bar" :style="{ background: gradientCss }" @click="onGradBarClick">
                      <span v-for="s in sortedGrad" :key="rawIndexOfStop(s)" class="grad-stop" :class="{ on: s === selGrad }"
                        :style="{ left: clampPct(s.p) + '%', background: css565(s.c) }"
                        :title="clampPct(s.p) + '% · ' + hex565(s.c)"
                        @pointerdown.prevent.stop="beginGradDrag(rawIndexOfStop(s), $event)"
                        @click.stop="selectGradStop(s)"></span>
                    </div>
                    <div class="grad-scale"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
                    <div class="field-row grad-controls">
                      <label>选中点</label>
                      <span class="tag mono" v-if="selGrad">{{ clampPct(selGrad.p) }}% · {{ hex565(selGrad.c) }}</span>
                      <input type="number" min="0" max="100" step="0.1"
                        :value="selGrad ? Math.round(Number(selGrad.p) * 10) / 10 : 0"
                        @change="commitGradPos($event.target.value)" style="width: 68px" :disabled="!selGrad" />
                      <span class="dim">% 位置</span>
                      <button type="button" class="mini" @click="addGradStop">加点</button>
                      <button type="button" class="mini" :disabled="!canRemoveStop" @click="removeGradStop">删点</button>
                    </div>
                    <div class="dim note2">点色条空白处加点、拖动圆点改位置（不会越过相邻点）；色板 / HEX / 取色器作用于选中点。渐变沿弧长铺开，整圈首尾颜色不同时会在起点留一道接缝。</div>
                  </div>

                  <div class="field-row">
                    <div class="swatches">
                      <span v-for="c in QUICK_COLORS" :key="c" class="sw" :class="{ on: colorExact === c }"
                        :style="{ background: css565(colorByName(c)) }" :title="c" @click="setCurColor(colorByName(c))"></span>
                    </div>
                  </div>
                  <div class="field-row">
                    <input type="color" v-model="colorHex" @input="applyHex" style="width: 40px; padding: 1px" />
                    <input class="mono" v-model="colorHex" @change="applyHex" style="width: 90px" />
                    <span class="dim">HEX 取色</span>
                  </div>
                  <div class="field-row">
                    <div style="flex: 1; min-width: 0">
                      <ColorPicker :model-value="curColor()" @update:model-value="setCurColor" />
                    </div>
                  </div>
                </div>

                <div class="card">
                  <div class="card-title">立体感 (只在网页预览)</div>
                  <div class="field-row">
                    <label>强度</label>
                    <input type="range" min="0" max="100" v-model.number="draft.ring.depth" class="wide" />
                    <span class="mono" style="width: 42px; text-align: right">{{ draft.ring.depth }}%</span>
                    <span class="dim">{{ draft.ring.depth > 0 ? '' : '(关 = 平色)' }}</span>
                  </div>
                  <div class="field-row" v-if="draft.ring.depth > 0">
                    <label>样式</label>
                    <select v-model="draft.ring.depthStyle" style="width: 90px">
                      <option value="ridge">凸起</option>
                      <option value="groove">凹陷</option>
                    </select>
                    <label>光照</label>
                    <input type="number" min="-180" max="180" v-model.number="draft.ring.lightDeg" style="width: 66px" />
                    <span class="dim">° (-45 = 左上)</span>
                  </div>
                  <div class="dim note2">立体感目前只在网页预览；导出/板子仍是平色。</div>
                </div>

                <div class="card">
                  <div class="card-title">导出摘要 (ring_config.h)</div>
                  <div class="export-grid">
                    <template v-for="row in exportRows" :key="row[0]">
                      <span class="mono dim">{{ row[0] }}</span><span class="mono">{{ row[1] }}</span>
                    </template>
                  </div>
                  <div class="dim note2">网页预览已能画起止角范围、拖尾与多停靠点渐变；导出的 RING_ARC_END_DEF / SPAN / TAIL_MS 目前是设计记录，颜色渐变也只取 0% 首点 —— 固件圆形路径仍按整圈、单色绘制（app_ring_ui.c 倒计时固定 RING_SWEEP_FULL），接入范围弧/渐变后才能直接消费这些宏。</div>
                </div>
              </template>
            </div>
          </section>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 顶边锁死: 预览/表单变高变矮, 弹窗都不移动, 内容在各自的滚动区里滚 */
.mask { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.6); display: flex; align-items: flex-start; justify-content: center; padding-top: 3vh; }
.dialog { width: min(1160px, 96vw); height: min(820px, 93vh); box-shadow: 0 20px 60px rgba(0,0,0,.65); }
.ring-title { gap: 8px; }
.badge { font-size: 10px; letter-spacing: .12em; color: var(--accent); border: 1px solid var(--accent-dim); border-radius: 4px; padding: 2px 6px; }
.tt { color: var(--text); font-weight: 600; font-size: 13px; }
.sub { color: var(--text-dim); font-size: 11px; }
.grow { flex: 1; }
.body { display: grid; grid-template-columns: 400px minmax(0, 1fr); gap: 14px; padding: 14px; overflow: hidden; flex: 1; min-height: 0; }

/* ---- 左预览 ---- */
.preview-pane { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow: auto; padding-right: 2px; }
.pv-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.pv-title { font-size: 12px; color: var(--text); font-weight: 600; }
.pv-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
.pv-tools { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 4px; }
.pv-zoom { min-width: 38px; text-align: center; font-size: 11px; color: var(--text-dim); }
/* 放大后靠滚动条平移 (flex 居中对溢出内容会裁掉左边/上边, 所以用 block + margin auto) */
.stage-wrap { display: block; overflow: auto; max-height: 460px; padding: 10px;
  background: radial-gradient(circle at 50% 45%, #1d2631, #0b0f14 70%); border: 1px solid var(--border); border-radius: 10px; }
.stage { position: relative; flex: none; margin: 0 auto; background-color: #0c1117;
  background-image: linear-gradient(45deg, #151c24 25%, transparent 25%), linear-gradient(-45deg, #151c24 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #151c24 75%), linear-gradient(-45deg, transparent 75%, #151c24 75%);
  background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0; border-radius: 8px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.04); }
.pv { position: absolute; inset: 0; width: 100%; height: 100%; image-rendering: pixelated; display: block; border-radius: 8px; }
/* 圆环留出外圈给角度盘: 环缩到 80%, 手柄/刻度落在环外 */
.circle-stage .pv { inset: 10%; width: 80%; height: 80%; image-rendering: auto; }
/* 放大看细节时按像素块显示, 2× 以上不再做平滑插值 */
.stage.pv-pixel .pv { image-rendering: pixelated; }
.dial { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.guide { fill: none; stroke: rgba(255,255,255,.14); stroke-width: 1.5; }
.tick { stroke: rgba(255,255,255,.26); stroke-width: 1; }
.tick.major { stroke: rgba(255,255,255,.46); stroke-width: 1.5; }
.dial-label { fill: rgba(255,255,255,.46); font-size: 11px; text-anchor: middle; dominant-baseline: middle;
  paint-order: stroke; stroke: rgba(0,0,0,.6); stroke-width: 3px; }
.range-full { fill: none; stroke: var(--accent); stroke-width: 3; opacity: .45; }
.range-arc { fill: none; stroke: var(--accent); stroke-width: 4; opacity: .85; stroke-linecap: round; }
.spoke { stroke-width: 1.5; stroke-dasharray: 3 3; }
.spoke.start { stroke: var(--accent); }
.spoke.end { stroke: var(--warn); }
.handle { pointer-events: auto; cursor: grab; stroke: #0b0f14; stroke-width: 3; }
.handle.start { fill: var(--accent); }
.handle.end { fill: var(--warn); }
.handle:active { cursor: grabbing; }
.handle-label { font-size: 11px; font-weight: 700; text-anchor: middle; paint-order: stroke; stroke: #0b0f14; stroke-width: 3; }
.handle-label.start { fill: var(--accent); }
.handle-label.end { fill: var(--warn); }
.count-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; pointer-events: none; color: #eaf6ff; text-shadow: 0 2px 10px rgba(0,0,0,.8); }
.count-overlay b { font-size: 30px; font-variant-numeric: tabular-nums; letter-spacing: .02em; }
.count-overlay span { font-size: 11px; color: var(--text-dim); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { font-size: 11px; color: var(--text-dim); background: var(--bg3); border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; }
.chip.hot { color: #08131a; background: var(--accent); border-color: var(--accent); font-weight: 600; }
.info-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 5px; }
.info-row { display: grid; grid-template-columns: 44px 1fr 44px 1fr; align-items: center; gap: 4px; font-size: 11px; }
.info-row span { color: var(--text-dim); }
.info-row b { color: var(--text); font-family: var(--mono, monospace); font-weight: 500; }
.hint { font-size: 11px; line-height: 1.6; color: var(--text-dim); border-left: 2px solid var(--accent-dim); padding-left: 8px; }
.hint b.start-t { color: var(--accent); }
.hint b.end-t { color: var(--warn); }
.note2 { font-size: 11px; line-height: 1.7; }

/* ---- 右编辑 ---- */
.editor-pane { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: 10px; flex-wrap: wrap; }
.tabs button { background: transparent; border: none; border-bottom: 2px solid transparent; border-radius: 0; color: var(--text-dim); padding: 7px 14px; font-size: 12px; cursor: pointer; }
.tabs button:hover { color: var(--text); background: var(--bg2); }
.tabs button.on { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.tab-body { overflow: auto; padding-right: 4px; flex: 1; min-height: 0; }
.card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
.card-title { font-size: 12px; font-weight: 600; color: var(--accent); margin-bottom: 8px; }
.field-row { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; flex-wrap: wrap; }
.field-row label { color: var(--text-dim); font-size: 12px; min-width: 44px; }
.field-row input[type=range].wide { flex: 1; min-width: 110px; }
.radio, .chk { color: var(--text-dim); font-size: 12px; display: inline-flex; align-items: center; gap: 3px; }
.preset-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.preset { font-size: 11px; padding: 6px 10px; border-radius: 6px; }
.preset.on { border-color: var(--accent); color: var(--accent); }
.effect-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.effect-card { display: flex; flex-direction: column; gap: 4px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; background: var(--bg); }
.effect-card input { display: none; }
.effect-card b { font-size: 12px; color: var(--text); }
.effect-card span { font-size: 11px; color: var(--text-dim); line-height: 1.6; }
.effect-card.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent-dim); }
.effect-card.on b { color: var(--accent); }
/* ---- 渐变颜色 ---- */
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.seg button { border: 0; border-radius: 0; background: var(--bg3); color: var(--text-dim); font-size: 11px; padding: 4px 12px; }
.seg button + button { border-left: 1px solid var(--border); }
.seg button:hover { color: var(--accent); }
.seg button.on { background: var(--accent); color: #08131a; font-weight: 600; }
.seg button.on:hover { color: #08131a; }
.grad-editor { margin: 2px 0 8px; padding: 8px 8px 6px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); }
.grad-bar { position: relative; height: 30px; margin: 0 4px; border: 1px solid rgba(255,255,255,.16); border-radius: 5px; cursor: copy;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.35); }
.grad-stop { position: absolute; top: 50%; width: 15px; height: 15px; margin: -8px 0 0 -8px; border: 2px solid #0b0f14; border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(255,255,255,.7), 0 2px 6px rgba(0,0,0,.65); cursor: grab; z-index: 1; }
.grad-stop.on { width: 19px; height: 19px; margin: -10px 0 0 -10px; z-index: 3;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0,0,0,.55); }
.grad-stop:active { cursor: grabbing; }
.grad-scale { display: flex; justify-content: space-between; margin: 4px 4px 0; font-size: 10px; color: var(--text-dim); }
.grad-controls { margin: 7px 0 0; }
.mini { font-size: 11px; padding: 3px 8px; }
.swatches { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; min-width: 0; }
.sw { width: 22px; height: 22px; border-radius: 4px; border: 1px solid rgba(255,255,255,.15); cursor: pointer; }
.sw.on { outline: 2px solid var(--accent); outline-offset: 1px; }
.export-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 11px; }
</style>
