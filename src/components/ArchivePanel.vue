<script setup>
/*
 * 工程条 (右栏) —— 从常驻的「工程存档」大块压缩成一行:
 *
 *   ★ 当前工程名  ●  320×170   [保存] [⚙] [⌄]
 *
 * 点 ★ / 工程名 / ⌄ 打开浮层 (不占常驻高度):
 *   · 快速切换: 在线存档一行一个 (★ = 当前), 点行就切;
 *   · 未保存/切换前暂存: 切走前自动把当前工程存一份 (本页内存, 最多 4 份), 可「返回」;
 *   · 保存/另存: 档名 + 保存 + ＋新建 (同名尺寸不同仍自动改名, 见 archive.js);
 *   · 本地工程 JSON 导出/导入.
 *
 * 高度问题: 原来常驻的当前工程卡、档名行、同名提示、存档列表、本地 JSON 全部收进浮层.
 * 默认关闭; 测试可以传 defaultOpen 打开浮层做 SSR 断言.
 */
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import {
  state, screen, cloud, cloudProbe, cloudSave, cloudLoadByName, cloudArchiveMeta,
  cloudDelete, exportProject, importProject, projectSignature, projectDirtyNow, CLOUD_HOME,
} from '../store.js'
import {
  archiveBaseName, archiveFileName, cleanArchiveName, planArchiveSave,
  screenLabel, suggestArchiveName, sameScreen,
} from '../archive.js'
import { copyText, downloadText } from '../utils.js'
import ScreenDialog from './ScreenDialog.vue'

const props = defineProps({ defaultOpen: { type: Boolean, default: false } })

const sc = screen
const NAME_KEY = 'lcd-cloud-name'
const name = ref(cleanArchiveName(localStorage.getItem(NAME_KEY) || ''))
const nameInput = ref(null)
const root = ref(null)
const projFile = ref(null)
const menuOpen = ref(props.defaultOpen)
const busy = ref(false)
const screenOpen = ref(false)
const copied = ref('')
const msg = ref('')
const msgKind = ref('info')          /* info | ok | warn | error */
const stashes = ref([])              /* 切换前暂存的未保存工程 (本页内存) */
let stashSeq = 0

const current = computed(() => ({
  w: Math.round(+sc.value.w || 0), h: Math.round(+sc.value.h || 0),
  round: !!sc.value.round, preset: sc.value.name || '',
}))
const currentScreenLabel = computed(() => screenLabel(current.value))
const files = computed(() => Array.isArray(cloud.list) ? cloud.list : [])
/* 新存的排前面 (mtime 降序), 没有 mtime 的按名字 */
const sorted = computed(() => [...files.value].sort((a, b) => (b.mtime || 0) - (a.mtime || 0) ||
  String(a.name || '').localeCompare(String(b.name || ''))))
const nameFile = computed(() => archiveFileName(name.value))
const nameExists = computed(() => !!nameFile.value && files.value.some(f => f.name === nameFile.value))
const currentName = computed(() => cloud.current || '')
const displayName = computed(() => currentName.value || '未保存工程')
const dirty = computed(() => !!cloud.dirty)
const drift = computed(() => !!(cloud.current && cloud.currentScreen && !sameScreen(current.value, cloud.currentScreen)))
const driftText = computed(() => drift.value
  ? '尺寸已从 ' + screenLabel(cloud.currentScreen) + ' 改成 ' + currentScreenLabel.value +
    '：保存会自动改名，不覆盖原档。'
  : '')
const barTitle = computed(() => {
  const parts = ['当前工程：' + displayName.value, currentScreenLabel.value, state.instances.length + ' 层']
  if (dirty.value) parts.push('有未保存修改')
  return parts.join(' · ') + '\n点击快速切换其他工程（★ = 当前）'
})

/* 读取/保存后 store 会写 cloud.current: 档名自动回填输入框 (读取后点一下就能存回原档)。
 * immediate: 直链 /lcd/<档名> 可能在面板挂载前就载入完了。 */
watch(() => cloud.current, (n) => {
  if (!n) return
  if (name.value !== n) name.value = n
  try { localStorage.setItem(NAME_KEY, n) } catch (e) { /* 忽略隐私模式 */ }
}, { immediate: true })

function onDocDown(e) {
  if (!menuOpen.value) return
  if (root.value && !root.value.contains(e.target)) menuOpen.value = false
}
function onKey(e) { if (e.key === 'Escape' && menuOpen.value) menuOpen.value = false }
function onWindowFocus() { if (!busy.value && menuOpen.value && (cloud.ok || !cloud.probed)) cloudProbe() }
onMounted(() => {
  document.addEventListener('pointerdown', onDocDown, true)
  window.addEventListener('keydown', onKey)
  window.addEventListener('focus', onWindowFocus)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocDown, true)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('focus', onWindowFocus)
})

function toggleMenu() {
  menuOpen.value = !menuOpen.value
  if (menuOpen.value) {
    msg.value = ''; msgKind.value = 'info'
    /* 打开浮层时顺手刷新列表 (窗口切回来也会刷新) */
    if (cloud.ok || !cloud.probed) cloudProbe()
  }
}
async function focusName() { await nextTick(); nameInput.value?.focus(); nameInput.value?.select?.() }
function openPreset() { menuOpen.value = false; screenOpen.value = true }

const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + 'M'
  : n >= 1024 ? Math.round(n / 1024) + 'K' : (n || 0) + 'B'
const fmtTime = (t) => {
  const d = new Date(t)
  if (isNaN(d)) return ''
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const fileMeta = (f) => [fmtSize(f.size), fmtTime(f.mtime)].filter(Boolean).join(' · ')

async function refresh(quiet = false) {
  if (busy.value) return
  if (!quiet) { msgKind.value = 'info'; msg.value = '正在刷新服务器存档…' }
  await cloudProbe()
  if (!cloud.ok) {
    msgKind.value = 'error'
    msg.value = '在线存档不可用: ' + (cloud.err || '未检测到服务')
  } else if (!quiet) {
    msgKind.value = 'ok'
    msg.value = '已刷新 · 服务器上 ' + files.value.length + ' 份存档'
  }
}

/* 切换前把当前未保存工程暂存一份 (最多 4 份, 本页内存; 刷新会丢) */
function stashCurrent() {
  const sig = projectSignature()
  const hasWork = !!(state.assets.length || state.instances.length || Object.keys(state.pages || {}).length)
  if (!hasWork) return null
  const isDirty = !cloud.baseSig || sig !== cloud.baseSig
  if (!isDirty && cloud.current) return null     /* 干净且已存档: 直接切回去即可, 不用暂存 */
  if (stashes.value.length && stashes.value[0].sig === sig) return null
  const s = {
    id: 'stash_' + Date.now().toString(36) + '_' + (++stashSeq),
    name: cloud.current || '',
    label: cloud.current || '未保存工程',
    meta: currentScreenLabel.value + ' · ' + state.instances.length + ' 层',
    screen: { ...current.value },
    baseScreen: cloud.currentScreen ? { ...cloud.currentScreen } : { ...current.value },
    json: exportProject(),
    baseSig: cloud.baseSig || '',
    sig,
    at: Date.now(),
  }
  stashes.value.unshift(s)
  if (stashes.value.length > 4) stashes.value.pop()
  return s
}

async function quickSwitch(f) {
  if (!f || busy.value) return
  const n = archiveBaseName(f.name)
  if (n === cloud.current) { msgKind.value = 'info'; msg.value = '「' + n + '」已经是当前工程'; return }
  const st = stashCurrent()
  busy.value = true
  msgKind.value = 'info'; msg.value = '正在切换到「' + n + '」…'
  const ok = await cloudLoadByName(n)
  busy.value = false
  if (ok) {
    name.value = n
    msgKind.value = 'ok'
    msg.value = '已切换到「' + n + '」· ' + currentScreenLabel.value +
      (st ? ' · 原工程已暂存，可在「未保存 / 切换前暂存」里返回' : '')
  } else {
    msgKind.value = 'error'; msg.value = cloud.msg
  }
}

async function restoreStash(s) {
  if (busy.value) return
  const st = stashCurrent()
  busy.value = true
  try {
    importProject(s.json)
    cloud.current = s.name || ''
    cloud.currentScreen = s.baseScreen || s.screen || null
    cloud.currentAt = Date.now()
    cloud.currentKind = 'stash'
    cloud.baseSig = s.baseSig || ''
    cloud.dirty = projectDirtyNow()
    cloud.msg = '已返回暂存工程' + (s.name ? '「' + s.name + '」' : '')
    name.value = s.name || ''
    stashes.value = stashes.value.filter(x => x.id !== s.id)
    msgKind.value = 'ok'
    msg.value = cloud.msg + (st ? ' · 切换前工程也已暂存' : '')
  } catch (e) {
    msgKind.value = 'error'
    msg.value = '返回失败: ' + (e && e.message ? e.message : e)
  } finally {
    busy.value = false
  }
}

function dropStash(s) {
  if (typeof confirm === 'function' &&
      !confirm('丢弃暂存「' + s.label + '」？丢弃后无法恢复。')) return
  stashes.value = stashes.value.filter(x => x.id !== s.id)
}

/* 快速保存: 有当前档名就直接存; 没有就打开浮层填档名 */
async function quickSave() {
  if (busy.value) return
  if (!cloud.ok) { menuOpen.value = true; msgKind.value = 'error'; msg.value = '在线存档不可用，请用「导出 JSON」备份'; return }
  if (!currentName.value || !name.value) {
    menuOpen.value = true
    msgKind.value = 'warn'
    msg.value = '先填存档名，或点「＋ 新建」自动生成一个'
    await focusName()
    return
  }
  const ok = await save()
  if (ok) menuOpen.value = false
}

/* 保存 (返回是否成功, 给「新建」用) */
async function save() {
  if (busy.value) return false
  if (!cloud.ok) {
    msgKind.value = 'error'; msg.value = '在线存档不可用，请用「导出 JSON」备份'
    return false
  }
  const n = cleanArchiveName(name.value)
  if (!n) {
    msgKind.value = 'warn'
    msg.value = '请先填存档名，或点「＋ 新建」自动生成一个'
    await focusName()
    return false
  }
  name.value = n

  /* 同名档 → 先读它的页面尺寸, 再决定"覆盖"还是"自动改名" */
  const hit = files.value.some(f => f.name === n + '.json')
  let existing = null
  if (hit) {
    busy.value = true
    msgKind.value = 'info'; msg.value = '正在核对原存档的页面尺寸…'
    try { existing = await cloudArchiveMeta(n) } catch (e) { existing = null }
    busy.value = false
  }

  const plan = planArchiveSave({ name: n, current: current.value, exists: hit, existing, files: files.value })
  if (plan.action === 'invalid') {
    msgKind.value = 'warn'; msg.value = '存档名清洗后为空，请换一个'
    return false
  }
  if (plan.action === 'confirm') {
    const tip = plan.unknown
      ? '服务器上已有「' + n + '」.json，但读不到它的页面尺寸。\n覆盖可能换掉另一块屏的工程 —— 仍要覆盖？'
      : '覆盖存档「' + n + '」？\n原存档：' + screenLabel(plan.existing) + '\n当前工程：' + screenLabel(current.value)
    if (typeof confirm === 'function' && !confirm(tip)) {
      msgKind.value = 'warn'; msg.value = '已取消保存'; return false
    }
  }
  if (plan.action === 'rename') {
    name.value = plan.name
    msgKind.value = 'warn'
    msg.value = '页面尺寸不同：原存档「' + plan.from + '」是 ' + screenLabel(plan.existing) +
      '，当前是 ' + screenLabel(current.value) + ' → 已自动改名为「' + plan.name + '」，原存档不会被覆盖'
  } else {
    msgKind.value = 'info'; msg.value = '保存中…'
  }

  busy.value = true
  try {
    await cloudSave(plan.name, exportProject())
    try { localStorage.setItem(NAME_KEY, plan.name) } catch (e) { /* 忽略 */ }
    name.value = plan.name
    if (plan.action === 'rename') {
      msgKind.value = 'warn'; msg.value += ' · 已保存'
    } else {
      msgKind.value = 'ok'
      msg.value = '已保存「' + plan.name + '」· ' + screenLabel(current.value)
    }
    return true
  } catch (e) {
    msgKind.value = 'error'; msg.value = '保存失败: ' + (e && e.message ? e.message : e)
    return false
  } finally {
    busy.value = false
  }
}

/* 新建 = 用"日期 + 当前尺寸"生成不撞车的档名并立刻存一份 (不碰任何旧档) */
async function saveAsNew() {
  if (busy.value) return
  busy.value = true
  msgKind.value = 'info'; msg.value = '正在检查服务器存档列表…'
  try { await cloudProbe() } catch (e) { /* 下面 save() 会报错 */ }
  busy.value = false
  const n = suggestArchiveName(current.value, new Date(), files.value)
  name.value = n
  if (await save()) {
    msgKind.value = 'ok'
    msg.value = '已新建存档「' + n + '」· ' + screenLabel(current.value) + '（可继续编辑后点「保存」）'
  }
}

async function del(f) {
  if (!f || busy.value) return
  const n = archiveBaseName(f.name)
  if (typeof confirm === 'function' && !confirm('删除在线存档「' + n + '」？删除后不可恢复。')) return
  busy.value = true
  msgKind.value = 'info'; msg.value = '删除中…'
  try {
    await cloudDelete(n)
    msgKind.value = 'ok'; msg.value = '已删除「' + n + '」'
  } catch (e) {
    msgKind.value = 'error'; msg.value = '删除失败: ' + (e && e.message ? e.message : e)
  } finally {
    busy.value = false
  }
}

/* 直链: <origin>/lcd/<档名> */
async function link(f) {
  if (!f) return
  const n = archiveBaseName(f.name)
  const url = location.origin + '/lcd/' + encodeURIComponent(n)
  if (await copyText(url)) {
    copied.value = f.name
    setTimeout(() => { copied.value = '' }, 1200)
    msgKind.value = 'ok'; msg.value = '直链已复制: ' + url
  } else {
    msgKind.value = 'error'; msg.value = '复制失败，请手动复制: ' + url
  }
}

function downloadProject() {
  const tag = sc.value.w + 'x' + sc.value.h + (sc.value.round ? '-圆' : '')
  downloadText('lcd-layout-project-' + tag + '.json', exportProject())
  msgKind.value = 'ok'; msg.value = '已导出工程 JSON（素材 / 图层 / 页面 / 屏幕预设都在里面）'
}

function onProjFile(e) {
  const f = e.target.files && e.target.files[0]
  if (!f) return
  const fr = new FileReader()
  fr.onload = () => {
    try {
      importProject(fr.result)
      name.value = ''
      msgKind.value = 'ok'
      msg.value = '已导入「' + f.name + '」· ' + screenLabel(current.value) + '（可 Ctrl+Z 撤回；需要时填档名另存）'
    } catch (err) {
      msgKind.value = 'error'; msg.value = '导入失败: ' + (err && err.message ? err.message : err)
    }
  }
  fr.readAsText(f)
  e.target.value = ''
}
</script>

<template>
  <div ref="root" class="projectbar archive" :class="{ open: menuOpen }">
    <!-- 第一行: 名字 + 展开按钮; 第二行: 其余操作 -->
    <div class="bar-row1">
      <button class="star-btn" :class="{ dirty }" :title="barTitle" @click="toggleMenu">★</button>
      <button class="proj-name" :title="barTitle" @click="toggleMenu">
        <span class="pname">{{ displayName }}</span>
        <span v-if="dirty" class="dirty-dot" title="有未保存修改">●</span>
      </button>
      <span class="grow"></span>
      <button class="mini chev" :class="{ on: menuOpen }" title="快速切换 / 存档管理" @click="toggleMenu">{{ menuOpen ? '⌃' : '⌄' }}</button>
    </div>
    <div class="bar-row2">
      <span class="dims dim mono">{{ sc.w }}×{{ sc.h }}{{ sc.round ? '圆' : '' }}</span>
      <span class="grow"></span>
      <button class="mini" title="导出整个工程 JSON（素材 / 图层 / 页面 / 自定义字库）" @click="downloadProject">JSON⤓</button>
      <button class="mini" title="导入工程 JSON（会替换当前工程，可 Ctrl+Z 撤回）" @click="projFile.click()">JSON⤒</button>
      <button class="mini" :class="{ primary: dirty }" :disabled="busy || !cloud.ok" :title="cloud.ok
        ? '保存到当前存档（自定义字库会随工程一起上传）；没有档名会打开存档菜单'
        : '在线存档不可用：请用「导出 JSON」备份'" @click="quickSave">保存</button>
      <button class="mini" title="屏幕预设（尺寸 / 圆屏 / 背景色 / 指令模板）" @click="openPreset">⚙</button>
    </div>

    <!-- 浮层: 不占常驻高度 -->
    <div v-if="menuOpen" class="menu" @click.stop>
      <div class="menu-head">
        <span class="star lit">★</span>
        <b>快速切换工程</b>
        <span class="dim current">{{ displayName }}</span>
        <span class="grow"></span>
        <button class="mini" :disabled="busy" title="刷新服务器存档列表" @click="refresh()">⟳</button>
      </div>

      <!-- 未保存 / 切换前暂存 -->
      <div v-if="stashes.length" class="stash">
        <div class="menu-sub">未保存 / 切换前暂存 <span class="dim">（本页有效，刷新会丢）</span></div>
        <div v-for="s in stashes" :key="s.id" class="srow">
          <span class="star">☆</span>
          <span class="sname" :title="s.label">{{ s.label }}</span>
          <span class="dim smeta">{{ s.meta }}</span>
          <span class="grow"></span>
          <button class="mini" :disabled="busy" title="返回这个未保存工程" @click="restoreStash(s)">返回</button>
          <button class="mini danger" :disabled="busy" title="丢弃这份暂存（不可恢复）" @click="dropStash(s)">✕</button>
        </div>
      </div>

      <!-- 保存 / 另存 -->
      <div class="menu-sub">保存 / 另存 <span class="dim">（输入框 = 存到哪个档；改档名再保存 = 另存）</span></div>
      <div class="save-row">
        <input ref="nameInput" v-model="name" class="mono" placeholder="存档名（档名）" :title="nameExists
          ? '服务器上已有同名存档：保存前会核对页面尺寸，尺寸不同会自动改名'
          : '存档名，会写成 档名.json；读取存档后会自动填回这里'" @keyup.enter="save" />
        <button class="primary" :disabled="busy || !cloud.ok" :title="nameExists
          ? '保存到服务器：同名时先核对页面尺寸（相同才确认覆盖，不同会自动改名）'
          : '把当前工程保存到服务器'" @click="save">保存</button>
        <button :disabled="busy || !cloud.ok" title="用「日期 + 当前尺寸」生成新档名并保存，不会覆盖任何已有存档" @click="saveAsNew">＋ 新建</button>
      </div>
      <div v-if="nameExists" class="dim note">同名档：尺寸相同会先确认再覆盖；尺寸不同会自动改名，不覆盖原档。</div>
      <div v-if="driftText" class="dim note warn">{{ driftText }}</div>
      <div v-if="dirty" class="dim note">当前工程有未保存修改；切换前会自动暂存，可从这里返回。</div>

      <!-- 在线存档列表: 点行 = 快速切换 -->
      <template v-if="cloud.ok">
        <div class="menu-sub">在线存档 · {{ files.length }} 份 <span class="dim">（点行 = 切换）</span></div>
        <div class="qlist">
          <div v-for="f in sorted" :key="f.name" class="qrow"
            :class="{ on: f.name === archiveFileName(cloud.current) }"
            :title="'点击切换到「' + archiveBaseName(f.name) + '」（当前工程会先暂存）'"
            @click="quickSwitch(f)">
            <span class="star" :class="{ lit: f.name === archiveFileName(cloud.current) }">{{ f.name === archiveFileName(cloud.current) ? '★' : '☆' }}</span>
            <span class="qmain">
              <span class="qname">{{ archiveBaseName(f.name) }}</span>
              <span class="qmeta">{{ fileMeta(f) }}<template v-if="f.name === archiveFileName(cloud.current)"> · 当前</template></span>
            </span>
            <span class="qops" @click.stop>
              <button class="mini" :disabled="busy" :title="'复制直链：' + archiveBaseName(f.name)"
                @click="link(f)">{{ copied === f.name ? '✓' : '🔗' }}</button>
              <button class="mini danger" :disabled="busy" :title="'删除存档 ' + archiveBaseName(f.name)"
                @click="del(f)">✕</button>
            </span>
          </div>
        </div>
        <div v-if="!sorted.length" class="dim note">服务器上还没有存档 —— 填个档名点「保存」，或点「＋ 新建」。</div>
      </template>
      <div v-else-if="cloud.probed" class="dim note">
        在线存档只在 <a :href="CLOUD_HOME" target="_blank" rel="noopener">{{ CLOUD_HOME }}</a>
        可用（{{ cloud.err || '未检测到服务' }}）。本地工程请用下面的「导出 JSON」。
      </div>
      <div v-else class="dim note">正在探测在线存档服务…</div>

      <div v-if="msg" class="arch-msg" :class="msgKind">{{ msg }}</div>
      <div v-else-if="cloud.msg" class="arch-msg info">{{ cloud.msg }}</div>

      <div class="menu-foot">
        <span class="dim note">保存会自动上传自定义字库{{ state.customFonts.length ? '（' + state.customFonts.length + ' 个）' : '' }}；浏览器也自动保存</span>
      </div>
    </div>

    <!-- 文件选择框放在浮层外: 菜单关掉/重渲染时, 已经打开的选文件对话框仍能把结果交回来 -->
    <input ref="projFile" type="file" accept=".json" hidden @change="onProjFile" />

    <ScreenDialog v-model:open="screenOpen" />
  </div>
</template>

<style scoped>
.projectbar {
  position: relative; display: flex; flex-direction: column; align-items: stretch; gap: 2px; min-width: 0;
  padding: 3px 6px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg2);
}
.bar-row1, .bar-row2 { display: flex; align-items: center; gap: 4px; min-width: 0; }
.bar-row1 .proj-name { flex: 1; min-width: 0; }
.bar-row1 .pname { max-width: 100%; }
.bar-row2 .grow { flex: 1; }
.grow { flex: 1; }
.star-btn {
  flex: none; border: none; background: transparent; color: var(--warn);
  font-size: 16px; line-height: 1; padding: 0 2px; cursor: pointer;
}
.star-btn:hover { color: #fff; }
.star-btn.dirty { text-shadow: 0 0 7px var(--warn); }
.proj-name {
  flex: 0 1 auto; min-width: 0; display: flex; align-items: center; gap: 4px;
  border: none; background: transparent; padding: 0; text-align: left; color: var(--text);
}
.proj-name:hover { color: var(--accent); }
.pname { max-width: 128px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.dirty-dot { color: var(--warn); font-size: 10px; line-height: 1; flex: none; }
.dims { flex: none; font-size: 10px; }
.chev { flex: none; padding: 0 4px; }
.chev.on { color: var(--accent); border-color: var(--accent); }

/* 浮层 */
.menu {
  position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 60;
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
  box-shadow: 0 14px 34px rgba(0, 0, 0, .6); padding: 7px 8px;
  max-height: min(60vh, 430px); overflow-y: auto;
}
.menu-head { display: flex; align-items: center; gap: 6px; font-size: 11px; min-width: 0; }
.menu-head .current { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.star { flex: none; color: var(--text-dim); font-size: 12px; line-height: 1; }
.star.lit { color: var(--warn); }
.menu-sub {
  margin: 7px 0 3px; padding-bottom: 2px; border-bottom: 1px dashed var(--border);
  font-size: 10px; color: var(--text-dim); display: flex; align-items: center; gap: 5px;
}
.stash { border: 1px solid var(--warn); border-radius: 4px; padding: 4px 5px; margin-top: 5px; background: rgba(255, 183, 77, .06); }
.stash .menu-sub { border-bottom-color: rgba(255, 183, 77, .35); color: var(--warn); margin-top: 0; }
.srow { display: flex; align-items: center; gap: 5px; font-size: 11px; min-width: 0; padding: 2px 0; }
.sname { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--warn); }
.smeta { flex: none; font-size: 10px; }
.save-row { display: flex; align-items: center; gap: 5px; }
.save-row input { flex: 1; min-width: 0; }
.save-row button { flex: none; white-space: nowrap; }
.note { font-size: 10px; line-height: 1.5; margin-top: 2px; }
.note.warn { color: var(--warn); }

/* 在线存档: 点行切换, 右侧小按钮做管理 */
.qlist { display: flex; flex-direction: column; gap: 1px; }
.qrow {
  display: flex; align-items: center; gap: 5px; padding: 3px 4px; min-width: 0;
  border: 1px solid transparent; border-radius: 4px; cursor: pointer;
}
.qrow:hover { background: var(--bg3); }
.qrow.on { border-color: var(--accent-dim); background: var(--bg3); }
.qmain { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.qname { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qmeta { font-size: 10px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qops { flex: none; display: flex; gap: 1px; opacity: .45; }
.qrow:hover .qops { opacity: 1; }
.qops .mini { padding: 0 4px; font-size: 10px; line-height: 15px; }
.mini.danger:not(:disabled) { color: #ff8a8a; border-color: #6a3030; }

.arch-msg { font-size: 10px; line-height: 1.55; word-break: break-all; margin-top: 5px; }
.arch-msg.info { color: var(--text-dim); }
.arch-msg.ok { color: var(--ok); }
.arch-msg.warn { color: var(--warn); }
.arch-msg.error { color: var(--err); }
.menu-foot { display: flex; align-items: center; gap: 5px; margin-top: 7px; padding-top: 6px; border-top: 1px dashed var(--border); }
.menu-foot button { white-space: nowrap; }
</style>
