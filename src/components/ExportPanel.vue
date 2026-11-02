<script setup>
import { ref, computed, onUnmounted } from 'vue'
import {
  state, screen,
  buildExport, buildRingConfig, warnings, updateInstance, toggleCircleWarn,
  ensureFontsReady, framesCount, frameLayers,
} from '../store.js'
import { copyText, downloadText } from '../utils.js'
import { shootFrameImage } from '../frameshoot.js'
import { pageNum, pageNums, pageEntries, normalizePage, PAGE_SPECIAL, PAGE_MAX,
         retargetAfterPageRemove, compactPlanPages, retargetJumps } from '../layerexport.js'
import ExportAllButton from './ExportAllButton.vue'
import ArchivePanel from './ArchivePanel.vue'

const sc = screen
const copied = ref('')

/* 图层存储方式: 内部 / 外部 / LZSS (互斥)。旧工程只有 ext 布尔 → 这里兼容推导。 */
const storeOf = (inst) => inst?.store === 'lzss' ? 'lzss' : (inst?.ext ? 'ext' : (inst?.store === 'ext' ? 'ext' : 'int'))
function setStore(inst, s) {
  updateInstance(inst.id, { store: s, ext: s === 'ext' })
}

/* ---- 导出图片 (单独一个按钮, 不混进「一键导出」): 当前预览帧 → 1 张 PNG 下载 ----
 * · 尺寸 = 屏幕分辨率 1:1 (与舞台上的缩放倍率无关)
 * · 像素 = 与预览同源 (frameshoot.paintFrame): 屏幕底色 + 各图层; 不带网格/选框/告警等编辑辅助
 * · 圆屏预设可带圆屏提示: 圆周细线 (默认) / 圆外压暗 / 不要 —— 只画在导出的图上 */
const shoot = ref('idle')          /* idle | ok | err */
const shootErr = ref('')
/* 圆屏提示: 老工程/老本地档没有这个键 → 读出来当 'ring' (缺省 = 圆周细线), 改一下才写回 exportOpts */
const shootHint = computed({
  get: () => state.exportOpts.shootHint || 'ring',
  set: (v) => { state.exportOpts.shootHint = v },
})
let shootTimer = 0
const shootLabel = computed(() => ({ ok: '✓ 已导出', err: '✗ 导出失败' }[shoot.value] || '导出图片'))
const shootTitle = computed(() => shoot.value === 'err'
  ? `导出失败: ${shootErr.value || '未知错误'} —— 再点一下重试`
  : '把当前预览窗口的这一帧按屏幕分辨率 1:1 导出成 PNG 下载 (屏幕底色 + 图层; 不含网格/选框/告警)')
function exportImage() {
  if (shoot.value === 'ok') return
  try {
    shootFrameImage({
      w: sc.value.w, h: sc.value.h, layers: frameLayers(),
      screenName: sc.value.name, bg: sc.value.bg, screen: sc.value,
      hint: shootHint.value,
    })
    shoot.value = 'ok'
  } catch (e) {
    console.error('[导出图片]', e)
    shootErr.value = String((e && e.message) || e)
    shoot.value = 'err'
  }
  clearTimeout(shootTimer)
  shootTimer = setTimeout(() => { shoot.value = 'idle' }, 1800)
}
onUnmounted(() => clearTimeout(shootTimer))

const output = computed(() => {
  try { return buildExport() } catch (e) { return `/* 导出计算错误: ${e.message} */` }
})
const warnSafe = computed(() => {
  try { return warnings.value || [] } catch (e) { return [{ level: 'warn', text: '警告计算错误: ' + e.message }] }
})
/* 导出预览: 折叠窗 (默认只给 头部 + 尾部, 点「展开全部」看整段) —— 整段导出都在这儿,
 * 放"导出"按钮下面, 不用滚到底部去看 */
const prevFold = ref(true)                 /* 默认折叠: 只留标题行 (用户: 默认改为折叠的) */
const prevAll = ref(false)                 /* 展开后: false = 头+尾, true = 整段 */
const outLines = computed(() => output.value.split('\n'))
const PREV_EDGE = 14                       /* 折叠时头/尾各显示多少行 */
const outHead = computed(() => outLines.value.slice(0, PREV_EDGE).join('\n'))
const outTail = computed(() => outLines.value.slice(-PREV_EDGE).join('\n'))
const outSkipped = computed(() => Math.max(0, outLines.value.length - PREV_EDGE * 2))
const outBytes = computed(() => output.value.length)

async function doCopy(text, tag) {
  if (await copyText(text)) {
    copied.value = tag
    setTimeout(() => (copied.value = ''), 1200)
  }
}

/* ---- 导出前字体核定 (与「一键导出」同一道闸, 判据见 store.js ensureFontsReady) ----
 * 系统字是 canvas **同步**画的: 内置字体 (MiSans/HarmonyOS/OPPO Sans) 没到位时浏览器会静默
 * 用回退字体画, 字宽/字形还被 sysRenderCache / numFontSysCache 缓存住 —— 这时"出文件"就把
 * 回退字体的字模烘进 ui_font.c (实测每格 53 vs 真字体 59 → 板上压掉旁边图层)。
 * ！必须"过了闸再生成": buildExport() 写在 await 之后取, 这样清过缓存的真字体才生效。 */
const fontMsg = ref('')
async function withFontCheck(fn) {
  fontMsg.value = '核定字体…'
  try {
    const gate = await ensureFontsReady()
    if (!gate.ok) {
      fontMsg.value = `字体还没就绪 (${gate.missing.join(', ')}): 已重新拉取, 等 1~2 秒再点一次`
      return
    }
    fontMsg.value = ''
    await fn()
  } catch (e) {
    fontMsg.value = '字体核定失败: ' + (e && e.message ? e.message : e)
  }
}
const doExportCopy = (tag) => withFontCheck(() => doCopy(buildExport(), tag))
const doExportDownload = () => withFontCheck(() => {
  downloadText(`lcd_${sc.name || 'layout'}.c`.replace(/[^\w.-]/g, '_'), buildExport())
})

/* 图层列表操作 (⌂ 归零 / 🔒 锁定 / 列表内快速改文本) */
function resetPos(inst) {
  updateInstance(inst.id, { x: 0, y: 0 })
}
function toggleLock(inst) {
  updateInstance(inst.id, { locked: !inst.locked })
}
function quickText(inst, e) {
  updateInstance(inst.id, { text: e.target.value })
}
function quickSysText(inst, e) {
  updateInstance(inst.id, { sysfont: { ...inst.sysfont, text: e.target.value } })
}

/* 页面列表: 正常页 0..max (空页号也留位) + 有内容的特殊页 (-3 低电 / -2 关机充电)。
 * 每一页导出成 LCD_<页>_Enter/Exit/CB; 页面里放圆环 → 那一页的 Enter 启圆环, Exit 停圆环。
 * 「跳转」= 定时跳转 (进这一页后 N ms 自动 LCD_UI_Goto(目标页)) —— LOGO 页就是靠它自己走的。 */
const pageList = computed(() =>
  pageEntries(state.instances, state.pages).map(({ n, mine }) => ({
    n,
    special: n < 0,
    role: PAGE_SPECIAL[n] || '特殊页',
    hidden: !!pageCfg(n)?.hidden,
    layers: mine.filter(it => it.kind !== 'ring').length,
    nums: mine.filter(it => it.bind).length,
    rings: mine.filter(it => it.kind === 'ring').length,
  })))
/* 一页一份设置: { period, jumpMs, jumpTo } (老工程里可能只存了个裸数字当周期) */
const pageCfg = (n) => {
  const p = state.pages?.[n] ?? state.pages?.[String(n)]
  return (p && typeof p === 'object') ? p : { period: p }
}
function setPageCfg(n, patch) {
  state.pages = { ...(state.pages || {}), [n]: { ...pageCfg(n), ...patch } }
}
function pagePeriod(n) {
  return Math.max(1, Math.round(+(pageCfg(n)?.period) || 0) || 200)
}
function setPagePeriod(n, v) {
  setPageCfg(n, { period: Math.max(1, Math.min(60000, Math.round(+v || 0) || 200)) })
}
function pageJumpMs(n) {
  return Math.max(0, Math.round(+(pageCfg(n)?.jumpMs) || 0))
}
function pageJumpTo(n) {
  const v = pageCfg(n)?.jumpTo
  if (!(v === '' || v == null)) return Math.round(+v)
  /* 默认目标 = 第一个**正常页** (0 起): 特殊页 (-4 LOGO 等) 不该当默认跳转目标 */
  return pageList.value.find(q => q.n >= 0)?.n ?? 0
}
function setPageJumpMs(n, v) {
  setPageCfg(n, { jumpMs: Math.max(0, Math.min(60000, Math.round(+v || 0))) })
}
function setPageJumpTo(n, v) {
  setPageCfg(n, { jumpTo: Math.round(+v) })
}

/* 图层/圆环属于哪些页: 以前是文本框里写 "0,1" (不好用) → 现在改成**一排按钮**,
 * 点一下就切换这一层在不在那一页 (素材只导一份, 多页只是多画几遍)。
 * -4 LOGO / -3 低电 / -2 关机充电 是特殊页, 0..9 是正常页, -1 是空白页 (放不了图层)。 */
function layerPages(inst) {
  return pageNums(inst)
}
function toggleLayerPage(inst, n) {
  const cur = layerPages(inst)
  /* 「仅素材」/「仅尺寸」亮着时, 页按钮看着都是灭的: 点任何页 = 离开这两个模式
   * (这两模式下"属于哪一页"没有意义: 一个不进页绘制, 一个只提供坐标/尺寸) */
  const on = cur.includes(n) && !inst.assetOnly && !inst.sizeOnly
  let next = on ? cur.filter(x => x !== n) : [...cur, n].sort((a, b) => a - b)
  if (!next.length) next = [n]            /* 至少留一页: 再点一下就是"只放这一页" */
  if (next.length === 1) updateInstance(inst.id, { pages: undefined, page: next[0], assetOnly: false, sizeOnly: false })
  else updateInstance(inst.id, { pages: next, page: next[0], assetOnly: false, sizeOnly: false })
}
/* 页里能不能加/删: 正常页 0..9 可加可删; 特殊页 (-4/-3/-2) 只能隐藏, 不许删 */
function nextFreePage() {
  const used = new Set(pageList.value.map(p => p.n))
  for (let n = 0; n <= PAGE_MAX; n++) if (!used.has(n)) return n
  return null
}
function addPage() {
  const n = nextFreePage()
  if (n == null) return
  setPageCfg(n, {})                        /* 建个空页 (没有图层也照样导出: 进去是清屏) */
}
/* 图层行那个「＋」: 新建一页并直接把这一层放进去 (少点一步) */
function addPageWith(inst) {
  const n = nextFreePage()
  if (n == null) return
  addPage()
  toggleLayerPage(inst, n)
}
function pageHasLayers(n) {
  return state.instances.some(it => layerPages(it).includes(n))
}
function pageLayerCount(n) {
  return state.instances.filter(it => layerPages(it).includes(n)).length
}
function pageIsJumpTarget(n) {
  return pageList.value.some(q => q.n !== n && pageJumpMs(q.n) > 0 && pageJumpTo(q.n) === n)
}
/* 页号就是**切页顺序**, 中间的空号删了也会留位 —— 所以删除规则分三种, 每种都写清后果:
 *   · 最后一页          → 删了就少一页 (上面的图层挪到第 0 页)
 *   · 有图层的非 0 页    → 图层挪到第 0 页后删掉这一页 (指向它的跳转清零)
 *   · 中间的空页号       → 删不掉 (占位), 只能隐藏它 / 或删最后一页;
 *   · 第 0 页有图层      → 不删 (主页面), 先把图层挪走
 * (以前是"有图层/被跳转就不让删" → 用户反馈"删除按钮根本不能用") */
function isLastPage(n) {
  const ns = pageList.value.filter(p => p.n >= 0).map(p => p.n)
  return ns.length > 0 && Math.max(...ns) === n
}
/* 正常页 (>=0) **一律可删** (强制删); 特殊页 (-4/-3/-2) 是固件状态机的状态, 只能隐藏。
 * 删之前弹确认窗: 先看清这一页有哪些层、选好它们的新家, 再说清页号会重排。 */
const canDeletePage = (n) => n >= 0
function deletePageTip(n) {
  if (n < 0) return `${PAGE_SPECIAL[n] || '特殊页'} 是固件状态机用的特殊页, 不能删除 —— 只能「隐藏」(隐藏后进去只清屏)`
  const c = pageLayerCount(n)
  return `删除页 ${n}` + (c ? ` (上面有 ${c} 层: 会让你选它们放哪一页)` : ' (空页)') +
    ' —— 页号 = 切页顺序, 删掉后面的页号会依次前移'
}
/* 确认窗口状态: { n, dest } */
const delPage = ref(null)
const delDestList = computed(() => pageList.value
  .filter(q => q.n !== delPage.value?.n)
  .map(q => ({ n: q.n, label: q.special ? q.role + ' (' + q.n + ')' : '页 ' + q.n })))
const delLayers = computed(() => (delPage.value == null ? []
  : state.instances.filter(it => layerPages(it).includes(delPage.value.n))))
function openDeletePage(n) {
  if (!canDeletePage(n)) return
  const dest = pageList.value.find(q => q.n !== n && q.n >= 0)?.n
    ?? pageList.value.find(q => q.n !== n)?.n ?? 0
  delPage.value = { n, dest }
}
function cancelDeletePage() { delPage.value = null }
function confirmDeletePage() {
  const d = delPage.value
  if (!d) return
  const n = d.n
  const dest = (d.dest === '' || d.dest == null) ? 0 : Math.round(+d.dest)
  /* ① 这一页上的图层挪到 dest (素材/帧不受影响) —— 规则在 layerexport, 自检直接测那份 */
  for (const t of retargetAfterPageRemove(state.instances, n, dest)) {
    updateInstance(t.id, { pages: t.pages, page: t.page })
  }
  /* ② 指向这一页的跳转改指 dest (页号没了, 内容挪过去了) + 删掉这一页的设置 */
  let np = retargetJumps({ ...(state.pages || {}) }, n, dest)
  delete np[n]
  delete np[String(n)]
  state.pages = np
  delPage.value = null
  /* ③ 页号重排: 页号 = 切页顺序, 删掉必须前移 (否则会留一个空占位页) */
  compactPages()
}
/* 整理页号: 页号 = 切页顺序, 中间的空号会一直占位 (例: 只有一层放在第 9 页 → 冒出 1..8 八个空页)。
 * 整理 = 把"用到的正常页"按顺序压成 0..k (特殊页不动, 图层归属与跳转目标一起重编号)。 */
const compactInfo = computed(() => {
  const r = compactPlanPages(state.instances, state.pages || {})
  const before = pageList.value.filter(p => p.n >= 0).length
  const used = new Set()
  for (const it of state.instances) for (const n of pageNums(it)) if (n >= 0) used.add(n)
  for (const k of Object.keys(state.pages || {})) {
    const n = Math.round(+k)
    const c = state.pages[k]
    if (n < 0 || !c || typeof c !== 'object') continue
    if (c.period || c.jumpMs || c.hidden) used.add(n)
    if (c.jumpTo != null && Math.round(+c.jumpTo) >= 0) used.add(Math.round(+c.jumpTo))
  }
  return { plan: r, removed: Math.max(0, before - used.size) }
})
function compactPages() {
  const r = compactPlanPages(state.instances, state.pages || {})
  for (const t of r.items) updateInstance(t.id, { pages: t.pages, page: t.page })
  state.pages = r.pages
}

/* 隐藏/恢复: 隐藏 = 板子上液晶进这一页只清屏, 等固件状态机给新状态 (3 个特殊页只能用这个) */
function pageHidden(n) {
  return !!(pageCfg(n)?.hidden)
}
function setPageHidden(n, v) {
  setPageCfg(n, { hidden: !!v })
}

/* 图层第二行: 选第几帧 (多帧素材) */
function frameCountOf(inst) {
  const a = state.assets.find(x => x.id === inst.assetId)
  return framesCount(a) || Math.max(1, a?.font?.boxes?.length || 1)
}
/* 换帧: 尺寸/裁切/位置/颜色都跟着那一帧的内容框走 (与 InstanceDialog.pickFrame 同一套规则) */
/* 双击图层: 多帧素材 → 多帧画板编辑页; 其它保持原来的属性/文字/圆环弹窗 */
function dblLayer(inst) {
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
function applyFrame(inst, i) {
  const a = state.assets.find(x => x.id === inst.assetId)
  const n = frameCountOf(inst)
  i = Math.max(0, Math.min(n - 1, Math.round(i) || 0))
  if (i === inst.frame) return
  const patch = { frame: i }
  if (a?.font) {
    const box = a.font.boxes?.[i] || null
    const prev = a.font.boxes?.[inst.frame] || null
    patch.w = box ? box.w : a.font.glyphW
    patch.h = box ? box.h : a.font.glyphH
    patch.crop = box ? { x: box.x, y: box.y } : { x: 0, y: 0 }
    patch.x = Math.round(inst.x + (box ? box.x : 0) - (prev ? prev.x : 0))
    patch.y = Math.round(inst.y + (box ? box.y : 0) - (prev ? prev.y : 0))
    const fc = a.font.frameColors
    if (fc && fc[i] != null) patch.color = fc[i] & 0xFFFF
  }
  updateInstance(inst.id, patch)
}
function setFrame(inst, i, e) {
  if (inst.groupId) return                       // 组内变体: 帧号固定, 由多帧画板管理
  /* 与内部值同口径 (0 基, 网页显示的就是这个值):
   *   -1 = 仅网页渲染 (MCU 侧 UI_FRAME_REF.index = 255 → 只清底色, 不渲染);
   *   0..N-1 = 画第几帧。 */
  const n = frameCountOf(inst)
  const v = Math.round(+i)
  if (!Number.isFinite(v) || v < 0) {
    updateInstance(inst.id, { frame: -1 })
    if (e) e.target.value = -1
    return
  }
  applyFrame(inst, Math.min(n - 1, v))
  if (e) e.target.value = inst.frame ?? 0
}

/* 存档 / 工程 JSON / 屏幕预设入口都在 ArchivePanel 里 (保存/读取/预设同一块, 顺序按使用流程) */
</script>

<template>
  <div class="panel">
    <div class="panel-title">
      导出 / 存档
    </div>

    <!-- 固定在标题下的操作区: 工程条 → 导出到文件夹 → 复制/下载 → 保存图片.
         每组都有小标题, 分隔线不抢视线; 滚动区只留页面/图层/警告. -->
    <div class="actions">
      <!-- 当前工程条放在最上面: 先看清在哪个工程, 再导出/切换 (菜单浮层不占常驻高度) -->
      <ArchivePanel />

      <section class="block">
        <div class="block-head">
          <span class="bhead-t">导出到文件夹</span>
          <span class="dim bhead-d" title="每个存档单独记住目录；已有文件会先问「继续 / 修改路径 / 取消」；无法申请文件夹权限时自动打包 ZIP">独立目录 · 覆盖前确认</span>
        </div>
        <ExportAllButton />
      </section>

      <section class="block">
        <div class="block-head">
          <span class="bhead-t">复制 / 下载</span>
          <span class="dim bhead-d">C 代码文本</span>
        </div>
        <div class="arow">
          <button class="primary" @click="doExportCopy('all')">复制全部{{ copied === 'all' ? ' ✓' : '' }}</button>
          <button @click="doExportDownload()">下载 .c</button>
          <button @click="doCopy(buildRingConfig(), 'ringcfg')" title="把圆环参数 (几何+进度弧+白斑) 复制成 ring_config.h 的内容, 直接粘进 code/spi/ring_config.h 覆盖, 然后编译; 逐像素扫描表 ring_scan.h/.c 随「一键导出」生成">{{ copied === 'ringcfg' ? '已复制 ✓' : '复制 ring' }}</button>
        </div>
        <div class="dim note" v-if="fontMsg">{{ fontMsg }}</div>

        <div class="crow fmtrow">
          <label class="dim" title="生成 C 数组的风格: 0X 大写十六进制, 每行多少个">数组</label>
          <label class="chk" title="勾上 = 0X 大写十六进制 (与工程 pic.c / ascii1408.c 一致)">
            <input type="checkbox" v-model="state.exportOpts.upperHex" />0X 大写</label>
          <label class="dim">每行</label>
          <input type="number" min="1" max="64" v-model.number="state.exportOpts.perLine" placeholder="16" style="width: 48px" />
          <span class="dim">个</span>
        </div>
      </section>

      <!-- 保存图片: 与「导出到文件夹」分开; 圆屏提示只影响导出的 PNG -->
      <section class="block img-export">
        <div class="block-head">
          <span class="bhead-t">保存图片</span>
          <span class="dim bhead-d">当前预览帧</span>
        </div>
        <div class="imgrow">
          <button class="shootbtn" :class="shoot" @click="exportImage()" :title="shootTitle">
            ⤓ {{ shootLabel }}
          </button>
          <template v-if="sc.round">
            <label class="dim" title="只画在导出的 PNG 上 (预览里的蒙版是编辑辅助, 不受这里影响)">圆屏提示</label>
            <select v-model="shootHint">
              <option value="ring">圆周细线 (无填充)</option>
              <option value="mask">圆外压暗</option>
              <option value="none">不要</option>
            </select>
          </template>
        </div>
      </section>

      <!-- 字库「边缘斜坡 σ」不在这里: 它跟着**每一层自己的字库**走
           (系统字: 文字/数字对话框里的「边缘斜坡 σ」; 字库素材: 字模分割对话框里) -->
    </div>

    <!-- 导出预览 (折叠): 整段导出的 头部 / 尾部; 展开 = 全部, 可滚。放在操作区正下方 -->
    <div class="preview-block">
      <div class="sec prev-sec">
        <span>导出预览</span>
        <span class="dim">{{ outLines.length }} 行 · {{ outBytes }} 字符 · {{ state.instances.length }} 条指令</span>
        <span class="grow"></span>
        <button v-if="!prevFold" class="mini chip" :class="{ on: prevAll }" @click="prevAll = !prevAll"
          :title="prevAll ? ('只看头部/尾部各 ' + PREV_EDGE + ' 行') : '看整段导出 (区域自己滚)'">
          {{ prevAll ? '只看头尾' : '看整段' }}</button>
        <button class="mini chip" :class="{ on: !prevFold }" @click="prevFold = !prevFold"
          :title="prevFold ? ('展开: 先给头部/尾部各 ' + PREV_EDGE + ' 行, 需要看全再点「看整段」') : '收起预览'">
          {{ prevFold ? '展开' : '收起' }}</button>
        <button class="mini chip" @click="doExportCopy('all')" title="复制整段导出 (与「复制全部」同一个内容)">
          {{ copied === 'all' ? '已复制 ✓' : '复制' }}</button>
      </div>
      <div v-if="!prevFold" class="prev-body" :class="{ open: prevAll }">
        <template v-if="prevAll">
          <pre class="code">{{ output }}</pre>
        </template>
        <template v-else>
          <pre class="code head">{{ outHead }}</pre>
          <div v-if="outSkipped > 0" class="prev-gap">
            中间省略 {{ outSkipped }} 行 · 点「看整段」展开全部
          </div>
          <pre v-if="outSkipped > 0" class="code tail">{{ outTail }}</pre>
        </template>
      </div>
    </div>

    <!-- 屏幕预设入口已挪进 ArchivePanel 的「当前工程」卡片 (保存/读取/预设同一块) -->

    <div class="scroll">
      <!-- 指令模板 / 头尾 已挪到「屏幕配置」弹窗 (它们跟着屏幕预设走) -->

      <!-- 警告 -->
      <div v-if="warnSafe.length" class="warnbox">
        <div v-for="(w, i) in warnSafe" :key="i" class="warn">
          ⚠ {{ w.text }}
          <span class="grow"></span>
          <button v-if="w.instId" class="mini warn-btn"
            :class="{ ignored: state.hiddenCircleWarns[w.instId] }"
            :title="state.hiddenCircleWarns[w.instId] ? '恢复红色警告' : '忽略此警告'"
            @click.stop="toggleCircleWarn(w.instId)">
            {{ state.hiddenCircleWarns[w.instId] ? '恢复' : '忽略' }}
          </button>
        </div>
      </div>

      <!-- 页面: 数字刷新按页面统一设置周期; 定时跳转 = 进这一页后 N ms 自动切到目标页;
           负数页是特殊页 (-4 开机LOGO / -3 低电 / -2 关机充电), 按键切页进不去, 只有固件状态机能进 -->
      <div class="sec">页面 ({{ pageList.length }})
        <button class="mini addpage" v-if="compactInfo.removed > 0"
          :title="'把用到的页按顺序压成 0..' + (pageList.filter(p => p.n >= 0).length - compactInfo.removed - 1) +
            ' (现在有 ' + compactInfo.removed + ' 个空占位页): 图层归属与跳转目标一起重编号, 特殊页不动'"
          @click="compactPages()">整理页号 (压掉 {{ compactInfo.removed }} 个空页)</button>
        <button class="mini addpage" :disabled="nextFreePage() == null"
          :title="nextFreePage() == null ? ('页号 0..' + PAGE_MAX + ' 用满了: 删掉一个空页再加') : ('新建一页 (页 ' + nextFreePage() + '): 空页也会导出 —— 进去是清屏')"
          @click="addPage()">＋ 添加页</button>
      </div>
      <div class="pagelist">
        <div v-for="pg in pageList" :key="pg.n" class="pagerow" :class="{ off: pg.hidden, empty: !pg.layers && !pg.nums && !pg.rings }">
          <!-- 第一行: 页号 + 内容概况 + 隐藏/删除 (窄栏里只放这些) -->
          <div class="pageline head">
            <span class="tag mono pgno" :class="{ special: pg.special }"
              :title="pg.special
                ? ('页号 ' + pg.n + ' (' + pg.role + '): 特殊页, 只有固件状态机能进; 按键切页不会到这里')
                : ('页号 ' + pg.n + ' = 第 ' + (pg.n + 1) + ' 个正常页 (按键切页按这个顺序走)')">
              {{ pg.special ? pg.role : '页 ' + pg.n }}</span>
            <span class="dim pginfo" :title="pg.layers + ' 层' + (pg.nums ? ' · 数字 ' + pg.nums : '') + (pg.rings ? ' · 圆环 ' + pg.rings : '')">
              <template v-if="!pg.layers && !pg.nums && !pg.rings">空页 · 进去是清屏</template>
              <template v-else>{{ pg.layers }} 层<template v-if="pg.nums"> · 数字 {{ pg.nums }}</template><template v-if="pg.rings"> · 圆环 {{ pg.rings }}</template></template>
            </span>
            <span class="grow"></span>
            <button class="mini chip" :class="{ on: pageHidden(pg.n) }"
              :title="(pg.special
                ? '隐藏这一页: 板子上 LCD_UI_Goto(' + pg.n + ') 进去只清屏, 不画内容也不自动跳页, 等固件状态机给新页号。' + pg.role + ' 是特殊页 —— 只能隐藏, 不能删除'
                : '隐藏这一页: 板子上进去只清屏, 等固件给新页号 (按键切页会跳过它)') + (pageHidden(pg.n) ? ' (现在是隐藏: 点一下恢复显示)' : '')"
              @click="setPageHidden(pg.n, !pageHidden(pg.n))">{{ pageHidden(pg.n) ? '已隐藏' : '隐藏' }}</button>
            <button v-if="!pg.special" class="mini danger del" :disabled="!canDeletePage(pg.n)"
              :title="deletePageTip(pg.n)" @click="openDeletePage(pg.n)">✕</button>
            <span v-else class="tag spec" title="特殊页 (-4/-3/-2) 是固件状态机的状态, 删掉会让固件对不上 —— 只能隐藏">不可删</span>
          </div>
          <!-- 第二行: 只在真有设置时出现 (周期 = 有数字层; 跳转 = 已经配了 ms>0) —— 空页不占地方 -->
          <div v-if="pg.nums || pageJumpMs(pg.n)" class="pageline cfg">
            <template v-if="pg.nums">
              <label class="dim clab" title="进页面 LCD_<页>_Enter() 里按这个周期启动定时器; 整页数字共用">周期</label>
              <input class="pgnum" type="number" min="1" max="60000" :value="pagePeriod(pg.n)"
                @input="setPagePeriod(pg.n, $event.target.value)" />
              <span class="dim">ms</span>
            </template>
            <span v-if="pg.nums" class="cfgsep"></span>
            <template v-if="pageJumpMs(pg.n)">
              <label class="dim clab" title="定时跳转: 进这一页后过 N ms 自动 LCD_UI_Goto(目标页); 0 = 不跳。LOGO 页就是靠它自己走; 提前离开这一页会自动取消">跳转</label>
              <input class="pgnum" type="number" min="0" max="60000" :value="pageJumpMs(pg.n)"
                @input="setPageJumpMs(pg.n, $event.target.value)" />
              <span class="dim">ms →</span>
              <select class="pgsel" :value="pageJumpTo(pg.n)" @change="setPageJumpTo(pg.n, $event.target.value)">
                <option v-for="q in pageList" :key="q.n" :value="q.n">{{ q.n }}</option>
              </select>
            </template>
          </div>
          <!-- 第二行的备用入口: 从没配过跳转的页, 给一个小按钮 (配了就在上面编辑, 想清零直接填 0) -->
          <div v-else class="pageline cfg more">
            <button class="mini link" @click="setPageJumpMs(pg.n, 200)"
              title="给这一页加「定时跳转」(默认 200ms → 第一页): 进这一页后自动切走">＋ 定时跳转</button>
          </div>
        </div>
        <div v-if="!pageList.length" class="dim l-empty">暂无图层</div>
      </div>

      <!-- 图层列表 -->
      <div class="sec">图层 ({{ state.instances.length }})</div>
      <div class="layer-list">
        <div v-for="inst in state.instances" :key="inst.id" class="layer-item">
          <div
            class="layer" :class="{ on: inst.id === state.ui.selectedId }"
            @click="state.ui.selectedId = inst.id"
            @dblclick="dblLayer(inst)"
            :title="inst.kind === 'ring' ? ('圆环 ' + inst.ring.value + '/' + inst.ring.steps + ' 双击编辑') : inst.sysfont ? ('系统字 [' + inst.sysfont.text + '] 双击编辑') : inst.kind === 'text' ? ('文字 [' + inst.text + '] 双击编辑') : (inst.name + ' 双击微调')"
          >
            <span class="tag mono kind" :class="{ txt: inst.kind === 'text' || inst.sysfont }">{{ inst.kind === 'ring' ? '◯' : inst.sysfont ? 'T' : inst.kind === 'text' ? '文' : '图' }}</span>
            <span class="lname mono">{{ inst.name }}</span>
            <span v-if="inst.bind" class="tag mode-tag dyn"
              :title="'动态: MCU 用字库画 ' + inst.bind.name + ' 的数字, 这一层自己的像素不导出'">数字</span>
            <!-- 「仅尺寸」/「仅素材」的标记只在下面那一行做按钮显示 (标题行不重复挂标签) -->
            <span v-if="inst.ascii" class="tag mode-tag lib"
              :title="'ASCII 字库: 导出 95 个字形 (0x20~0x7E) 的字模表 + 打字符串函数 ' + inst.name + 'Str()'">ASCII</span>
            <span v-if="inst.groupId" class="tag mode-tag grp"
              :title="'多帧同位置组: 这一层是组里第 ' + ((inst.groupIndex | 0) + 1) + ' 帧 · 组框按最大帧, 每层可单独设格式/颜色/裁切'">组{{ (inst.groupIndex | 0) + 1 }}</span>
            <span v-if="inst.sysfont" class="qtext">
              <input :value="inst.sysfont.text" @input="quickSysText(inst, $event)" @click.stop @dblclick.stop
                placeholder="文字…" title="快速编辑系统字文本" />
            </span>
            <span v-else-if="inst.kind === 'text'" class="qtext">
              <input :value="inst.text" @input="quickText(inst, $event)" @click.stop @dblclick.stop
                placeholder="文本…" title="快速编辑文本内容" />
            </span>
            <span v-else class="dim mono lgeom">{{ Math.round(inst.x) }},{{ Math.round(inst.y) }} · {{ Math.round(inst.w) }}×{{ Math.round(inst.h) }} · {{ inst.fmt }}</span>
            <button class="mini" title="坐标重置到 0,0" :disabled="inst.locked" @click.stop="resetPos(inst)">⌂</button>
            <button class="mini lock-btn" :class="{ 'is-locked': inst.locked }" :title="inst.locked ? '已锁定: 拖拽/方向键禁用, 点击解锁' : '锁定位置 (禁止拖拽, 仅属性可改)'" @click.stop="toggleLock(inst)">{{ inst.locked ? '🔒' : '🔓' }}</button>
            <button v-if="inst.groupId" class="mini" title="打开多帧画板子预览 (逐帧/播放, 调组内偏移)"
              @click.stop="state.ui.frameGroupPreviewId = inst.groupId">▣</button>
            <button class="mini prop-btn" title="打开属性编辑" @click.stop="inst.kind === 'ring' ? (state.ui.dialogRingId = inst.id) : inst.sysfont ? (state.ui.dialogSysId = inst.id) : inst.kind === 'text' ? (state.ui.dialogTextId = inst.id) : (state.ui.dialogInstanceId = inst.id)">⚙</button>
          </div>

          <!-- 第二行: 这一层的设置 (页 / 外部 / 第几帧) —— 第一行只留身份和三个图标按钮 -->
          <div class="valrow">
            <span class="vlab" title="这一层属于哪些页: 点按钮切换 (可以多页 —— 一个图层活在多页, 素材只导一份); 0..9 正常页 (按键切页按序号走), 特殊页只有固件状态机能进, 被隐藏的页会打叉 (进去只清屏)">页</span>
            <span class="pagebtns" @click.stop>
              <button v-if="inst.kind !== 'ring'" class="mini pbtn"
                :class="{ on: !!inst.sizeOnly }"
                title="仅尺寸: 只导出坐标/尺寸 —— 帧表 .px = 0, 这一层像素不进 flash; 与「仅素材」一起选 = 尺寸仍出 0, 像素照样导出给固件按名自取"
                @click="updateInstance(inst.id, { sizeOnly: !inst.sizeOnly })">仅尺寸</button>
              <button v-if="inst.kind !== 'ring'" class="mini pbtn"
                :class="{ on: !!inst.assetOnly }"
                title="仅素材: 不进页, 素材照常导出"
                @click="updateInstance(inst.id, { assetOnly: !inst.assetOnly })">仅素材</button>
              <button v-for="q in pageList" :key="q.n" class="mini pbtn"
                :class="{ on: layerPages(inst).includes(q.n) && !inst.assetOnly && !inst.sizeOnly, special: q.special, hidden: q.hidden }"
                :title="(q.special ? q.role + ' 页 ' + q.n : '页 ' + q.n) +
                  (layerPages(inst).includes(q.n) ? ' — 这一层在: 点一下移除' : ' — 点一下加进去') +
                  (q.hidden ? ' (这一页被隐藏: 板子上进去只清屏)' : '')"
                @click="toggleLayerPage(inst, q.n)">{{ q.special ? q.role : q.n }}</button>
              <button class="mini pbtn add" :disabled="nextFreePage() == null"
                :title="nextFreePage() == null ? '页号 0..' + PAGE_MAX + ' 用满了' : '新建一页 (页 ' + nextFreePage() + ') 并把这一层放进去'"
                @click="addPageWith(inst)">＋</button>
            </span>
            <template v-if="inst.kind !== 'ring'">
            <span class="storebtns" @click.stop>
              <button class="mini sbtn" :class="{ on: storeOf(inst) === 'int' }"
                title="内部: 像素进内部 Flash (ui_assets_int.c)" @click="setStore(inst, 'int')">内部</button>
              <button class="mini sbtn" :class="{ on: storeOf(inst) === 'ext' }"
                title="外部: 像素进外部 Flash (ui_assets_ext.c, UI_EXT_RO)" @click="setStore(inst, 'ext')">外部</button>
              <button class="mini sbtn" :class="{ on: storeOf(inst) === 'lzss' }"
                title="LZSS: 像素压进统一素材表 (ui_assets_lzss.c), 导出页显示压缩率与解码 RAM"
                @click="setStore(inst, 'lzss')">LZSS</button>
            </span>
            </template>
            <template v-if="inst.kind !== 'ring' && !inst.bind && !inst.groupId">
            <span class="vlab" title="-1 = 仅网页渲染 (MCU 侧只清底色); 0..N-1 = 静态画第几帧 (0 = 第 1 帧)">帧</span>
            <input class="fnum" type="number" min="-1" :max="frameCountOf(inst) - 1"
              :value="inst.frame ?? -1" @change="setFrame(inst, $event.target.value, $event)" @click.stop
              title="-1 = 仅网页渲染 (MCU: .index=255 → 清底色); 0 = 第 1 帧, 1 = 第 2 帧 …; 与「仅素材」互不联动" />
            <span class="dim vlab">/-1..{{ frameCountOf(inst) - 1 }}</span>
            </template>
            <span v-else-if="inst.groupId" class="dim vlab" title="组里每一帧固定一个变体, 换帧请用子预览 ◀ ▶">组内帧 {{ (inst.groupIndex | 0) + 1 }}</span>
          </div>

          <!-- 第三行: 文字层如果是"数字"(在「＋文字」弹窗里选的), 这里只显示状态; 双击图层去改 -->
          <div v-if="inst.bind" class="valrow">
            <span class="tag mode-tag dyn">数字</span>
            <span class="mono vname-ro">{{ inst.bind.name }}</span>
            <span class="dim">{{ inst.bind.dec }} 位小数 · {{ inst.bind.cells }} 格 · {{ ['左', '右', '中'][inst.bind.align || 0] }}</span>
            <span class="dim vhint">(双击图层改)</span>
          </div>

          <!-- 第三行: ASCII 字库层 (系统字) —— 出的是整份字模 + 打字符串函数, 不是一张定死的图 -->
          <div v-if="inst.ascii" class="valrow">
            <span class="tag mode-tag lib">ASCII</span>
            <span class="mono vname-ro">{{ inst.name }}Str()</span>
            <span class="dim">0x20~0x7E 全 95 字形 · 固件打任意字符串</span>
            <span class="dim vhint">(双击图层改字号/字体/字距)</span>
          </div>
        </div>
        <div v-if="!state.instances.length" class="dim l-empty">暂无图层 — 左栏拖入图片, 或工具栏「＋文字」</div>
      </div>


    </div>

    <!-- 删页确认窗: 说清这一页有哪些层 + 选新家 + 页号会重排 (页号 = 切页顺序) -->
    <div v-if="delPage" class="mask delmask" @click.self="cancelDeletePage">
      <div class="dlg">
        <div class="dlg-title">删除页 {{ delPage.n }}?</div>
        <div class="dlg-body">
          <div class="dlg-row">
            <span class="dim">这一页上的图层 ({{ delLayers.length }})</span>
            <span v-if="!delLayers.length" class="dim">— 空页, 没有图层</span>
            <span v-else class="dlg-layers">
              <span v-for="it in delLayers.slice(0, 8)" :key="it.id" class="tag">{{ it.name || it.id }}</span>
              <span v-if="delLayers.length > 8" class="dim">… 共 {{ delLayers.length }} 层</span>
            </span>
          </div>
          <div class="dlg-row">
            <label class="dim" :title="delLayers.length ? '这些图层删除后放到这一页 (素材/帧不受影响, 只是换一页显示)' : '这一页没有图层, 这一项不影响结果'">图层移到</label>
            <select class="pgsel" v-model.number="delPage.dest">
              <option v-for="q in delDestList" :key="q.n" :value="q.n">{{ q.label }}</option>
            </select>
          </div>
          <div class="dlg-note">
            · 删掉后<strong>页号会重排</strong> (第 {{ delPage.n }} 页之后的页依次前移) —— 页号就是切页顺序, 固件里 <code>LCD_UI_Goto()</code> 的页号要跟着改<br />
            · 指向这一页的「定时跳转」会改指到上面选的那一页<br />
            · 只是想先别显示: 用「隐藏」(板子上进去只清屏, 页号不动)
          </div>
        </div>
        <div class="dlg-foot">
          <span class="grow"></span>
          <button @click="cancelDeletePage">取消</button>
          <button class="danger" @click="confirmDeletePage">确认删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ext-chk { font-size: 11px; white-space: nowrap; }
.storebtns { display: inline-flex; gap: 2px; }
.sbtn { min-width: 30px; padding: 0 4px; font-size: 10px; line-height: 15px; opacity: .55; }
.sbtn.on { opacity: 1; border-color: var(--accent); color: var(--accent); font-weight: 600; }
/* 删页确认窗 (与其它弹窗同一套观感: 半透明遮罩 + 面板) */
.delmask { position: fixed; inset: 0; z-index: 120; background: rgba(0, 0, 0, .55); display: flex; align-items: flex-start; justify-content: center; padding-top: 18vh; }
.dlg { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; width: 460px; max-width: 92vw; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
.dlg-title { padding: 8px 12px; font-weight: 600; border-bottom: 1px dashed var(--border); color: var(--accent); }
.dlg-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.dlg-row { display: flex; align-items: center; gap: 8px; }
.dlg-layers { display: inline-flex; flex-wrap: wrap; gap: 3px; }
.dlg-note { color: var(--text-dim); font-size: 11px; line-height: 1.7; }
.dlg-note code { color: var(--text); }
.dlg-foot { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px dashed var(--border); }
.dlg-foot .grow { flex: 1; }
.pagename { width: 52px; font-size: 11px; padding: 0 3px; }
.pagelist { border: 1px solid var(--border); border-radius: 4px; background: var(--bg2); margin-bottom: 6px; }
.pagerow { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; font-size: 11px; }
.pagerow + .pagerow { border-top: 1px solid var(--bg); }
.pagerow.off { opacity: .62; }
.pagerow.off .pginfo::after { content: ' · 已隐藏'; color: var(--warn); }
.pageline { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* 图层行里的「页」按钮组: 点一下切换这一层在不在那一页 (以前是文本框写 "0,1") */
.pagebtns { display: inline-flex; flex-wrap: wrap; gap: 2px; }
.pbtn { min-width: 20px; padding: 0 4px; font-size: 10px; line-height: 15px; opacity: .55; }
.pbtn.on { opacity: 1; border-color: var(--accent); color: var(--accent); font-weight: 600; }
.pbtn.special { font-size: 9px; }
.pbtn.hidden { text-decoration: line-through; }
.pbtn.add { opacity: .8; }
.addpage { margin-left: 6px; font-size: 10px; padding: 0 6px; }
.tag.spec { font-size: 9px; opacity: .7; }
.mini.danger:not(:disabled) { color: #ff8a8a; border-color: #6a3030; }
.pgsel { font-size: 11px; padding: 1px 2px; }
.pageline.cfg { color: var(--text-dim); flex-wrap: wrap; row-gap: 4px; }
.pageline.cfg.more { margin-top: -2px; }
.pgno { flex: none; }
.pginfo { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.clab { flex: none; }
.cfgsep { width: 1px; height: 12px; background: var(--border); flex: none; }
.chip { font-size: 10px; padding: 0 6px; line-height: 16px; opacity: .7; }
.chip.on { opacity: 1; color: var(--warn); border-color: var(--warn); }
.del { flex: none; padding: 0 6px; line-height: 16px; }
.mini.link { font-size: 10px; opacity: .55; padding: 0 4px; line-height: 15px; }
.mini.link:hover { opacity: 1; }
.tag.special { color: var(--warn, #e6a23c); border-color: currentColor; }

.scroll { flex: 1; overflow-y: auto; padding: 10px; }
/* 导出动作区: 固定在标题下, 不随右栏内容滚动.
 * 布局: 工程条 → [导出到文件夹] → [复制 / 下载] → [保存图片]; 每块一个小标题,
 * 块之间用虚线分隔 (不再一堆边框卡片互相挤). */
.actions {
  flex: none; display: flex; flex-direction: column; gap: 5px;
  padding: 8px 10px 6px; border-bottom: 1px solid var(--border);
}
.block { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.block + .block { border-top: 1px dashed var(--border); padding-top: 7px; }
.block-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.bhead-t { flex: none; font-size: 12px; font-weight: 600; color: var(--accent); }
.bhead-d { font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fmtrow { margin-top: 1px; }
.arow { display: flex; gap: 6px; }
.arow button { flex: 1; min-width: 0; white-space: nowrap; }
/* 保存图片: 按钮 + 圆屏提示同一行, 比原来单独一张卡片矮一半 */
.img-export { padding-top: 7px; border-top: 1px dashed var(--border); }
.imgrow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.imgrow .shootbtn { flex: 1 1 auto; min-width: 0; }
.imgrow label { flex: none; }
.imgrow select { flex: 0 1 132px; min-width: 0; }
.shootbtn.ok { color: #81c784; }
.shootbtn.err { color: #ff8a80; }
/* 工程/数组/在线存档这些行: 按钮按内容宽, 不拉满 */
.crow { display: flex; align-items: center; gap: 5px; font-size: 12px; }
.crow button { white-space: nowrap; }
.crow label { color: var(--text-dim); flex: none; }
.note { font-size: 11px; }
.sec {
  margin: 12px 0 6px; padding-bottom: 3px;
  border-bottom: 1px dashed var(--border);
  font-size: 12px; color: var(--accent); font-weight: 600;
  display: flex; align-items: center; gap: 6px;
}
.sec:first-child { margin-top: 0; }
.mini { padding: 0 6px; font-size: 11px; }
.chk { color: var(--text-dim); font-size: 12px; display: inline-flex; align-items: center; gap: 3px; }
.warnbox { border: 1px solid var(--warn); border-radius: 4px; padding: 6px 8px; margin: 6px 0; }
.warn { color: var(--warn); font-size: 11px; display: flex; align-items: center; gap: 6px; }
.warn-btn { padding: 0 6px; font-size: 10px; line-height: 16px; flex: none; }
.warn-btn.ignored { opacity: .5; }
/* 导出预览: 与操作区同一条左右留白, 再进滚动区 */
.preview-block { flex: none; padding: 0 10px 6px; border-bottom: 1px solid var(--border); }
.preview-block .prev-sec { margin-top: 7px; }
.prev-sec { display: flex; align-items: center; gap: 6px; }
.prev-body { display: flex; flex-direction: column; gap: 4px; margin-bottom: 0; }
.prev-body .code { max-height: 168px; }
.prev-body.open .code { max-height: 46vh; }
.prev-gap { text-align: center; font-size: 10px; color: var(--text-dim); border-top: 1px dashed var(--border); border-bottom: 1px dashed var(--border); padding: 2px 0; }
.code {
  margin: 0; background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
  padding: 8px; font-family: var(--mono); font-size: 11px;
  color: #a5d6a7; white-space: pre; overflow: auto;
  max-height: 200px; min-height: 60px;
}
.layer-list {
  border: 1px solid var(--border); border-radius: 4px;
  max-height: 260px; overflow-y: auto; background: var(--bg2);
}
.layer-item { border-bottom: 1px solid var(--bg); }
.layer-item:last-child { border-bottom: none; }
.layer {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 6px; font-size: 11px; cursor: pointer;
  user-select: none;
}
/* 第二行: 值 (动态数字区域) */
.valrow {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
  padding: 2px 6px 2px 30px; font-size: 11px;
}
.valrow + .valrow { padding-top: 0; }
.val-chk { flex: none; }
.vname { width: 110px; font-size: 11px; padding: 1px 4px; }
.vnum { width: 40px; font-size: 11px; padding: 1px 3px; }
.vlab { color: var(--text-dim); font-size: 10px; }
.valign { padding: 0 2px; font-size: 11px; }
.vname-ro { font-size: 11px; }
.fnum { width: 40px; font-size: 11px; padding: 1px 3px; }
.mode-tag { font-size: 9px; padding: 0 3px; flex: none; }
.mode-tag.sta { color: var(--text-dim); }
.mode-tag.dyn { color: var(--warn); border-color: var(--warn); }
.mode-tag.lib { color: var(--accent); border-color: var(--accent); }
.mode-tag.grp { color: var(--ok); border-color: var(--ok); }
.vhint { font-size: 10px; }
.layer.on { background: var(--bg3); box-shadow: inset 2px 0 0 var(--accent); }
.layer .kind { flex: none; width: 22px; padding: 0; text-align: center; }
.layer .kind.txt { color: var(--ok); border-color: var(--ok); }
.lname { flex: none; max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qtext { flex: 1; min-width: 0; }
.qtext input { width: 100%; font-size: 11px; padding: 1px 4px; }
.lgeom { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.layer .mini { flex: none; padding: 0 5px; font-size: 10px; line-height: 16px; }
.lock-btn.is-locked { color: var(--err); border-color: var(--err); background: rgba(239,83,80,.15); }
.lock-btn:not(.is-locked) { color: var(--ok); border-color: var(--ok); background: rgba(102,187,106,.12); }
.prop-btn { color: var(--accent); border-color: var(--accent-dim); }
.l-empty { padding: 10px; text-align: center; font-size: 11px; }
details summary { cursor: pointer; font-size: 11px; margin: 4px 0; }
</style>
