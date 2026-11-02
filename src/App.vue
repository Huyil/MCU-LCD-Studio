<script setup>
import { onMounted, onBeforeUnmount } from 'vue'
import AssetPanel from './components/AssetPanel.vue'
import ScreenStage from './components/ScreenStage.vue'
import ExportPanel from './components/ExportPanel.vue'
import InstanceDialog from './components/InstanceDialog.vue'
import FontSplitDialog from './components/FontSplitDialog.vue'
import TextDialog from './components/TextDialog.vue'
import RingDialog from './components/RingDialog.vue'
import FrameGroupDialog from './components/FrameGroupDialog.vue'
import { state, removeInstance, duplicateInstance, updateInstance, initPersistence, screen, undo, redo, copySelectedToClipboard } from './store.js'

initPersistence()
let copyTimer = null

function onKey(e) {
  if (state.ui.dialogInstanceId || state.ui.dialogNewAssetId ||
      state.ui.dialogFontAssetId || state.ui.dialogTextId || state.ui.dialogTextNew ||
      state.ui.dialogSysId || state.ui.dialogSysNew ||
      state.ui.dialogRingId || state.ui.dialogRingNew || state.ui.dialogFrameGroup) return
  /* 快捷键: Ctrl+C 允许焦点在图层行/按钮上 (选对象后焦点常在按钮);
   * 但输入框/文本域里保持浏览器原生复制。其它快捷键仍要求焦点在页面本体,
   * 防 Delete 误删 (点过右栏按钮后不触发)。 */
  const ae = document.activeElement
  const mod = e.ctrlKey || e.metaKey
  const typing = !!ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable)
  if (mod && e.key.toLowerCase() === 'c' && !typing) {
    e.preventDefault()
    copySelectedToClipboard().then(ok => {
      state.ui.copyMsg = ok ? '已复制对象/参数 (多帧画板 Ctrl+V 新建图层)' : '没有可复制的对象'
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => { state.ui.copyMsg = '' }, 1600)
    })
    return
  }
  if (ae && ae !== document.body && ae !== document.documentElement) return
  // 撤回 / 重做
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo(); else undo()
    return
  }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
  const inst = state.instances.find(i => i.id === state.ui.selectedId)
  if (!inst) return
  const step = e.shiftKey ? 10 : 1
  const arrow = /^Arrow(Left|Right|Up|Down)$/.test(e.key)
  if (inst.locked && arrow) return   // 锁定: 方向键不改位置 (属性弹窗里仍可改)
  let handled = true
  if (e.key === 'ArrowLeft') updateInstance(inst.id, { x: inst.x - step })
  else if (e.key === 'ArrowRight') updateInstance(inst.id, { x: inst.x + step })
  else if (e.key === 'ArrowUp') updateInstance(inst.id, { y: inst.y - step })
  else if (e.key === 'ArrowDown') updateInstance(inst.id, { y: inst.y + step })
  else if (e.key === 'Delete' || e.key === 'Backspace') removeInstance(inst.id)
  else if (e.key.toLowerCase() === 'd' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); duplicateInstance(inst.id) }
  else handled = false
  if (handled) e.preventDefault()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="logo">◧</span> MCU LCD Studio
        <span class="tag">{{ screen.name }} · {{ screen.w }}×{{ screen.h }}{{ screen.round ? ' · 圆屏' : '' }}</span>
      </div>
      <div class="grow"></div>
      <div class="hint dim">
        拖素材到屏幕 · 单击选中 · 双击微调 · 方向键移动(Shift×10) · Del 删除 · Ctrl+C 复制 · Ctrl+D 复制 · Ctrl+Z 撤回
      </div>
      <span v-if="state.ui.copyMsg" class="tag copy-toast">{{ state.ui.copyMsg }}</span>
    </header>

    <main class="cols">
      <AssetPanel class="col-left" />
      <ScreenStage class="col-mid" />
      <ExportPanel class="col-right" />
    </main>

    <InstanceDialog />
    <FontSplitDialog />
    <TextDialog />
    <RingDialog />
    <FrameGroupDialog />
  </div>
</template>

<style scoped>
.app { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.topbar {
  flex: none; display: flex; align-items: center; gap: 12px;
  padding: 8px 14px; background: var(--bg2);
  border-bottom: 1px solid var(--border);
}
.brand { font-weight: 700; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.logo { color: var(--accent); }
.grow { flex: 1; }
.hint { font-size: 11px; }
.copy-toast { color: var(--ok); border-color: var(--ok); font-size: 10px; }
.cols {
  flex: 1; display: grid; min-height: 0; gap: 10px; padding: 10px;
  grid-template-columns: 210px minmax(0, 1fr) 400px;
  /* 行高锁死: 三栏里的内容 (素材/预览/图层) 再怎么变, 页面高度都不变 —— 否则底部按钮会被顶下去 */
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
}
.col-left, .col-mid, .col-right { min-height: 0; }
@media (max-width: 1100px) {
  .cols { grid-template-columns: 180px minmax(0, 1fr) 320px; }
}
</style>
