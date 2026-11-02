<script setup>
import { ref, computed, watch } from 'vue'
import { state, addAssetFile, removeAsset, getAssetImage, fontPreviewSrc, mergeAssetsToFrames,
  assetLibrary, adoptGlobalAsset, removeGlobalAsset, clearGlobalAssets, setAssetLibraryMode,
  syncAssetsFromArchives, globalAssetKey, cloud, frameStripCount } from '../store.js'
import FrameManageDialog from './FrameManageDialog.vue'

const framesAssetId = ref('')          /* 非空 = 打开那个多帧素材的帧管理弹窗 */
/* 多帧素材卡片: 显示**单帧实际尺寸 + 帧数**, 不是整条拼版尺寸 (1408×128 这种看不出格子) */
function isFrameAsset(a) { return a?.font?.charset === 'frames' }
function frameCountOf(a) {
  if (!isFrameAsset(a)) return 1
  const n = frameStripCount(a) || Math.max(0, Math.round(+a.font.frames || 0)) || 0
  return Math.max(1, n)
}
function assetSizeText(a) {
  if (!isFrameAsset(a)) return `${a.w}×${a.h}`
  const n = frameCountOf(a)
  const gw = Math.max(1, Math.round(+a.font.glyphW || 0)) || Math.max(1, Math.round((a.w || 1) / n))
  const gh = Math.max(1, Math.round(+a.font.glyphH || 0)) || Math.max(1, Math.round((a.h || 1) / n))
  return `${gw}×${gh} · ${n}帧`
}
function assetTotalText(a) { return `${a.w}×${a.h}` }
function assetFmt(a) { return a?.defaultFmt === 'GRAY' ? 'GRAY' : (a?.defaultFmt ? 'RGB565' : '') }
const fileInput = ref(null)
const dragOver = ref(false)

async function onFiles(files) {
  const list = [...files].filter(f => /^image\//.test(f.type) || /\.svg$/i.test(f.name))
  if (!list.length) return
  /* 选了多张 → 先问一句: 拼成一个多帧素材, 还是各建各的 (以前只能逐个添加) */
  if (list.length > 1) { pending.value = list; return }
  await addOneByOne(list)
}

/* "逐个添加": 原来的行为 —— 每张一个素材 */
async function addOneByOne(list) {
  for (const f of list) {
    try { await addAssetFile(f) } catch (e) { console.warn(e) }
  }
}

/* 二次选择的弹窗状态 */
const pending = ref(null)          // 待处理的文件列表 (null = 不显示)
const merging = ref(false)
const mergeErr = ref('')
function cancelPending() { pending.value = null; mergeErr.value = '' }

async function doMergeFrames() {
  const list = pending.value
  if (!list?.length) return
  merging.value = true; mergeErr.value = ''
  try {
    const tmp = []
    for (const f of list) {
      try { const a = await addAssetFile(f, { transient: true }); if (a) tmp.push(a) } catch (e) { console.warn(e) }
    }
    if (tmp.length < 2) { mergeErr.value = '至少要有 2 张能读进来的图'; merging.value = false; return }
    mergeAssetsToFrames(tmp)
    pending.value = null
  } catch (e) {
    mergeErr.value = '合成失败: ' + (e?.message || e)
  } finally { merging.value = false }
}

async function doAddOneByOne() {
  const list = pending.value
  pending.value = null
  await addOneByOne(list || [])
}

function onDragOver(e) {
  // 素材拖拽 (从素材栏拖出) 不在 dropzone 停留, 让事件穿透到屏幕
  if (e.dataTransfer.types.includes('application/x-lcd-asset')) {
    dragOver.value = false
    return
  }
  e.preventDefault()
  dragOver.value = true
}

function onPick(e) { onFiles(e.target.files); e.target.value = '' }

function onDropFiles(e) {
  dragOver.value = false
  // 素材拖拽 (application/x-lcd-asset): 不消费, 让事件穿透到屏幕
  if (e.dataTransfer.types.includes('application/x-lcd-asset')) return
  if (e.dataTransfer.files?.length) { e.preventDefault(); onFiles(e.dataTransfer.files); return }
}

function onDragStart(e, asset) {
  e.dataTransfer.setData('application/x-lcd-asset', asset.id)
  e.dataTransfer.effectAllowed = 'copy'
  // 拖拽缩略图
  const img = getAssetImage(asset)
  if (img?.complete) e.dataTransfer.setDragImage(img, 24, 24)
}

function clickAsset(asset) {
  /* 多帧素材: 单击**不弹放置窗**, 双击打开多帧画板; 要放置直接拖到屏幕。
   * 原来用 220ms 延迟等双击, 人手稍慢就先把放置窗打开了, 第二次点击落在遮罩上,
   * 双击永远到不了素材卡 —— 用户看到的就是"双击没进画板"。 */
  if (asset?.font?.charset === 'frames') return
  state.ui.dialogNewAssetId = asset.id
}
function dblAsset(asset) {
  if (asset?.font?.charset !== 'frames') return
  state.ui.dialogNewAssetId = null
  state.ui.frameGroupAssetId = asset.id
  state.ui.dialogFrameGroup = true
}
function dblGlobal(it) {
  const a = adoptGlobalAsset(it.id)
  if (a?.font?.charset === 'frames') {
    state.ui.frameGroupAssetId = a.id
    state.ui.dialogFrameGroup = true
  }
}

/* 删除素材: 二次确认 (素材不入撤回栈, 删除不可逆) */
function delAsset(asset) {
  const used = state.instances.filter(i => i.assetId === asset.id).length
  const msg = `删除素材「${asset.name}」?`
    + (used ? `\n该素材正被 ${used} 个图层使用, 将一并删除。` : '')
    + '\n\n素材删除不可撤回。'
  if (confirm(msg)) removeAsset(asset.id)
}
const ringCount = computed(() => state.instances.filter(i => i.kind === 'ring').length)

/* ---- 总素材库 (跨工程) ---- */
const globalMode = computed(() => assetLibrary.mode === 'global')
const projectKeys = computed(() => new Set(state.assets.map(a => globalAssetKey(a))))
const globalQ = ref('')
const globalItems = computed(() => {
  const q = globalQ.value.trim().toLowerCase()
  const list = q
    ? assetLibrary.items.filter(it => {
        const a = it.asset || {}
        return (String(a.name || '') + ' ' + (it.origins || []).join(' ')).toLowerCase().includes(q)
      })
    : assetLibrary.items
  return [...list].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
})
const originsText = (it) => {
  const list = Array.isArray(it.origins) ? it.origins : []
  if (!list.length) return '来源未知'
  return list.length > 2 ? '… / ' + list.slice(-2).join(' / ') : list.join(' / ')
}
const inProject = (it) => projectKeys.value.has(it.key)
let autoSynced = false
function switchLib(mode) {
  setAssetLibraryMode(mode)
  if (mode !== 'global') { globalQ.value = ''; return }
  /* 第一次进总库时, 若在线服务可用, 自动把其它存档的素材汇总一次 (mtime 缓存, 不会重复拉).
   * 离线/本地入口不自动请求, 用户仍可点「同步在线存档素材」或使用本机已汇总的素材. */
  if (!autoSynced && cloud.ok) {
    autoSynced = true
    doSyncAssets()
  }
}
/* 恢复成「总素材库」模式 / 打开页面时探测还没回来: 服务一可用就自动同步一次 */
watch(() => cloud.ok, (ok) => {
  if (ok && globalMode.value && !autoSynced) { autoSynced = true; doSyncAssets() }
}, { immediate: true })
function useGlobal(it) {
  const a = adoptGlobalAsset(it.id)
  if (!a) return
  /* 多帧: 单击只加入工程, 双击开画板 (与当前工程素材同一套) */
  if (a.font?.charset === 'frames') return
  state.ui.dialogNewAssetId = a.id
}
function onGlobalDragStart(e, it) {
  const a = adoptGlobalAsset(it.id)
  if (!a) return
  e.dataTransfer.setData('application/x-lcd-asset', a.id)
  e.dataTransfer.effectAllowed = 'copy'
  const img = getAssetImage(a)
  if (img?.complete) e.dataTransfer.setDragImage(img, 24, 24)
}
function openGlobalFrames(it) {
  const a = adoptGlobalAsset(it.id)
  if (a) framesAssetId.value = a.id
}
function delGlobal(it) {
  if (inProject(it)) return
  const name = it.asset?.name || '素材'
  if (confirm(`从总素材库移除「${name}」？\n不会影响已加入工程的副本。`)) removeGlobalAsset(it.id)
}
async function doSyncAssets() { await syncAssetsFromArchives() }
function clearLib() {
  if (confirm('清空总素材库？\n当前工程的素材会重新汇总；已加入工程的素材不受影响。')) clearGlobalAssets()
}
</script>

<template>
  <div class="panel">
    <div class="panel-title">
      素材库 <span class="tag">{{ globalMode ? assetLibrary.items.length : state.assets.length }}</span>
      <span class="grow"></span>
      <button class="primary" @click="fileInput.click()" title="导入图片到当前工程（导入后也会自动进总素材库）">导入图片</button>
      <input ref="fileInput" type="file" accept="image/*,.svg" multiple hidden @change="onPick" />
    </div>

    <!-- 当前工程 / 总素材库 (跨工程汇总) 切换 -->
    <div class="libtabs">
      <button :class="{ on: !globalMode }" @click="switchLib('project')" title="只显示当前工程的素材">当前工程 ({{ state.assets.length }})</button>
      <button :class="{ on: globalMode }" @click="switchLib('global')" title="所有工程用过的素材；可同步在线存档">总素材库 ({{ assetLibrary.items.length }})</button>
    </div>

    <template v-if="!globalMode">

    <!-- 多帧画板: 多张图片 → 一张多帧素材 (替换原「＋文本框」入口) -->
    <div class="toprow">
      <button class="primary" title="多张图片 → 一张多帧素材: 每帧可来自不同图片, 顺序可调, 格子按最大帧, 放到屏幕后只是一个普通多帧图层"
        @click="state.ui.frameGroupAssetId = ''; state.ui.dialogFrameGroup = true">多帧画板</button>
    </div>

    <!-- 新建部件 (原在模拟屏工具栏) -->
    <div class="addrow">
      <button class="primary" title="文字 / 数字 / 系统字 —— 都在同一个弹窗里 (顶部切「来源」)" @click="state.ui.dialogTextNew = true">＋文字</button>
      <button class="primary" :disabled="ringCount >= 1"
        :title="ringCount >= 1 ? '一个工程只支持一个环 (板子上是单例引擎: 一套窗口缓冲 + 一个定时器, 多环的其余参数会被忽略) —— 要换形状就在这个环的弹窗里改「形状」' : '圆环 / 圆角矩形进度部件'"
        @click="state.ui.dialogRingNew = true">◯ 圆环{{ ringCount >= 1 ? ' (已有)' : '' }}</button>
    </div>

    <div
      class="dropzone"
      :class="{ over: dragOver }"
      @dragover="onDragOver"
      @dragleave="dragOver = false"
      @drop.prevent="onDropFiles"
    >
      <div
        v-for="a in state.assets" :key="a.id"
        class="asset"
        draggable="true"
        @dragstart="onDragStart($event, a)"
        @click="clickAsset(a)"
        @dblclick.stop="dblAsset(a)"
        :title="a.font?.charset === 'frames' ? `${a.name}  单帧 ${assetSizeText(a)} (整条 ${assetTotalText(a)})${assetFmt(a) ? ' · ' + assetFmt(a) : ''}\n双击: 打开多帧画板 · 拖动: 放到屏幕` : `${a.name}  ${a.w}×${a.h}\n单击: 放置并微调 · 拖动: 放到屏幕指定位置`"
      >
        <img :src="(a.font && fontPreviewSrc(a)) || a.src" class="thumb" />
        <div class="meta">
          <div class="name">{{ a.name }}</div>
          <div class="dim">{{ assetSizeText(a) }} <span v-if="assetFmt(a)" class="tag fmt-tag" title="这个素材默认的导出格式">{{ assetFmt(a) }}</span> <span v-if="a.derivedText" class="tag text-tag" title="由文字/系统字图层自动生成（只读快照；改文字会原地更新，可当普通图片拖到屏幕）">文字</span> <span v-if="a.font && (a.frameGroupDoc || a.font.charset !== 'frames')" class="tag font-tag" :title="a.frameGroupDoc ? '多帧画板素材, 双击继续编辑' : '已拆分为字库'">{{ a.frameGroupDoc ? '画板' : '字库' }}</span></div>
        </div>
        <button v-if="a.font?.charset === 'frames'" class="del frames-btn" title="帧管理: 排序 / 删除 / 插入"
          @click.stop="framesAssetId = a.id">≡</button>
        <button class="del danger" title="删除素材"
          @click.stop="delAsset(a)">✕</button>
      </div>
      <div v-if="!state.assets.length" class="empty dim">
        拖入图片文件到此栏<br />或点击「导入图片」<br /><br />
        图片导入后:<br />· 拖到中间模拟屏放置<br />· 单击打开微调弹窗
      </div>
    </div>
    </template>

    <template v-else>
      <!-- 总素材库: 所有工程用过的素材; 单击/拖动 = 先加入当前工程, 再放置 -->
      <div class="toprow">
        <button class="primary" :disabled="assetLibrary.syncing"
          :title="cloud.ok
            ? '只读取服务器上现有的存档，按它们重建总库（不再累积历史条目；当前工程最后并入）'
            : '会先探测在线存档服务；本地入口不可用时只能看本机已汇总的素材'"
          @click="doSyncAssets">{{ assetLibrary.syncing ? '同步中…' : '同步在线存档素材' }}</button>
        <button class="mini" title="清空总素材库（当前工程素材会重新汇总；已加入工程的素材不受影响）" @click="clearLib">清空</button>
      </div>
      <div class="libsearch">
        <input v-model="globalQ" placeholder="搜索素材 / 来源…" />
      </div>
      <div class="dropzone"
        @dragover="onDragOver" @dragleave="dragOver = false" @drop.prevent="onDropFiles">
        <div v-for="it in globalItems" :key="it.id" class="asset global-asset"
          draggable="true" @dragstart="onGlobalDragStart($event, it)" @click="useGlobal(it)" @dblclick.stop="dblGlobal(it)"
          :title="it.asset.font?.charset === 'frames' ? `${it.asset.name}  单帧 ${assetSizeText(it.asset)} (整条 ${assetTotalText(it.asset)})${assetFmt(it.asset) ? ' · ' + assetFmt(it.asset) : ''}\n单击: 加入当前工程 · 双击: 打开多帧画板 · 拖动: 加入并拖到屏幕\n来源: ${originsText(it)}` : `${it.asset.name}  ${it.asset.w}×${it.asset.h}\n单击: 加入当前工程并放置 · 拖动: 加入并拖到屏幕\n来源: ${originsText(it)}`">
          <img :src="(it.asset.font && fontPreviewSrc(it.asset)) || it.asset.src" class="thumb" />
          <div class="meta">
            <div class="name">{{ it.asset.name }}</div>
            <div class="dim">{{ assetSizeText(it.asset) }}
              <span v-if="assetFmt(it.asset)" class="tag fmt-tag">{{ assetFmt(it.asset) }}</span>
              <span v-if="it.asset.derivedText" class="tag text-tag" title="由文字/系统字图层自动生成">文字</span>
              <span v-if="it.asset.font && (it.asset.frameGroupDoc || it.asset.font.charset !== 'frames')" class="tag font-tag">{{ it.asset.frameGroupDoc ? '画板' : '字库' }}</span>
              <span v-if="inProject(it)" class="tag inproj" title="当前工程里已有这个素材">已在工程</span>
            </div>
            <div class="origin" :title="(it.origins || []).join(' / ')">{{ originsText(it) }}</div>
          </div>
          <button v-if="it.asset.font?.charset === 'frames'" class="del frames-btn" title="帧管理（会先把素材加入当前工程）"
            @click.stop="openGlobalFrames(it)">≡</button>
          <button v-if="!inProject(it)" class="del danger" title="从总素材库移除（不影响已加入工程的副本）"
            @click.stop="delGlobal(it)">✕</button>
        </div>
        <div v-if="!globalItems.length" class="empty dim">
          <template v-if="globalQ">没有匹配「{{ globalQ }}」的素材</template>
          <template v-else>总素材库还是空的<br />打开/切换别的工程、导入图片会自动汇总；<br />也可以点「同步在线存档素材」</template>
        </div>
      </div>
      <div v-if="assetLibrary.storageMsg || assetLibrary.msg" class="libmsg dim">{{ assetLibrary.storageMsg || assetLibrary.msg }}</div>
      <div v-else class="libmsg dim">单击 / 拖动 = 加入当前工程；总库只存在本浏览器。</div>
    </template>
  </div>
  <!-- 多选图片 → 二次选择: 合成一个多帧素材 / 逐个添加 -->
  <Teleport to="body">
    <div v-if="pending" class="pick-mask" @click.self="cancelPending">
      <div class="pick-dlg">
        <div class="pick-title">选了 {{ pending.length }} 张图片</div>
        <div class="pick-body">
          <button class="pick-opt" :disabled="merging" @click="doMergeFrames">
            <b>合成为多帧素材</b>
            <span class="dim">拼成一条横向拼版图 (帧 = 每张图, 取最大宽高为格子), 实例上用「帧」选第几张 —— 适合做动画/状态切换</span>
          </button>
          <button class="pick-opt" :disabled="merging" @click="doAddOneByOne">
            <b>逐个添加</b>
            <span class="dim">每张图各建一个素材 (原来的行为)</span>
          </button>
        </div>
        <div class="pick-foot">
          <span class="dim">{{ merging ? '正在合成…' : '' }}{{ mergeErr }}</span>
          <span class="grow"></span>
          <button @click="cancelPending" :disabled="merging">取消</button>
        </div>
      </div>
    </div>
  </Teleport>
  <FrameManageDialog v-if="framesAssetId" :asset-id="framesAssetId" @close="framesAssetId = ''" />
</template>

<style scoped>
.toprow { flex: none; display: flex; padding: 8px 10px 0; gap: 5px; }
.toprow button { flex: 1; min-width: 0; }
.toprow .mini { flex: 0 0 auto; padding: 0 8px; }
.libtabs { flex: none; display: flex; gap: 4px; padding: 6px 10px 0; }
.libtabs button { flex: 1; min-width: 0; font-size: 11px; padding: 3px 2px; white-space: nowrap; }
.libtabs button.on { background: var(--accent-dim); border-color: var(--accent); color: #fff; }
.libsearch { flex: none; padding: 6px 10px 0; }
.libsearch input { width: 100%; }
.libmsg { flex: none; padding: 4px 10px 6px; font-size: 10px; line-height: 1.4; }
.origin { font-size: 10px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag.inproj { color: var(--ok); border-color: var(--ok); font-size: 9px; }
.addrow { flex: none; display: flex; gap: 6px; padding: 8px 10px; }
.addrow button { flex: 1; min-width: 0; font-size: 11px; padding: 4px 2px; white-space: nowrap; }
.dropzone { flex: 1; overflow-y: auto; padding: 8px; }
.pick-mask { position: fixed; inset: 0; z-index: 120; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; }
.pick-dlg { width: min(460px, 92vw); background: var(--panel, #1b1d21); border: 1px solid var(--line, #333); border-radius: 10px; padding: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.6); }
.pick-title { font-weight: 600; margin-bottom: 10px; }
.pick-body { display: flex; flex-direction: column; gap: 8px; }
.pick-opt { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; text-align: left; padding: 10px 12px; }
.pick-opt b { font-size: 13px; }
.pick-opt .dim { font-size: 11px; line-height: 1.5; }
.pick-foot { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.pick-foot .grow { flex: 1; }
.dropzone.over { outline: 2px dashed var(--accent); outline-offset: -4px; }
.asset {
  position: relative;
  display: flex; gap: 8px; align-items: center;
  padding: 6px; margin-bottom: 6px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: grab;
}
.asset:hover { border-color: var(--accent); }
.asset:active { cursor: grabbing; }
.thumb {
  width: 44px; height: 44px; object-fit: contain;
  background:
    linear-gradient(45deg, #222 25%, transparent 25%, transparent 75%, #222 75%),
    linear-gradient(45deg, #222 25%, #181818 25%, #181818 75%, #222 75%);
  background-size: 10px 10px;
  background-position: 0 0, 5px 5px;
  border-radius: 4px;
  flex: none;
}
.meta { min-width: 0; flex: 1; }
.name {
  font-size: 12px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.dim { color: var(--text-dim); font-size: 11px; }
.del {
  position: absolute; top: 2px; right: 2px;
  padding: 0 4px; font-size: 10px; line-height: 14px;
  opacity: 0; border: none; background: transparent;
}
.asset:hover .del { opacity: 1; }
.global-asset > .del { opacity: .5; }
.global-asset:hover > .del { opacity: 1; }
.frames-btn { right: 20px; opacity: 0.85; } /* 帧管理 ≡: 常显 (只在多帧素材上出现) */
.font-tag { color: var(--ok); border-color: var(--ok); font-size: 9px; vertical-align: 1px; }
.text-tag { color: #e8b45a; border-color: #e8b45a; font-size: 9px; vertical-align: 1px; }
.fmt-tag { color: var(--accent); border-color: var(--accent); font-size: 9px; vertical-align: 1px; }
.empty {
  text-align: center; padding: 30px 10px;
  font-size: 12px; line-height: 1.9;
}
</style>
