<script setup>
/*
 * 指令模板 + 通配符说明 + 头部/尾部 —— 从导出面板挪进「屏幕预设」弹窗:
 * 这三样都是**跟着屏幕预设走**的 (sc.templates / sc.header / sc.footer, 每个预设一份),
 * 放在预设窗口里才看得出"改的是哪一套屏"; 导出面板那边只留导出动作与预览。
 */
import { ref, computed } from 'vue'
import { screen } from '../store.js'
import { PLACEHOLDER_DOC } from '../defaults.js'

const sc = screen
const FMTS = ['RGB565', 'RGB888', 'GRAY', 'TEXT', 'TEXTFN']
const fmtTab = ref('RGB565')
const showTplHelp = ref(false)

/* 预设里理论上都有 templates, 但老工程/手改 JSON 可能没有 → 用可写计算属性兜底 */
const tpl = computed({
  get: () => (sc.value.templates || {})[fmtTab.value] ?? '',
  set: (v) => {
    if (!sc.value.templates) sc.value.templates = {}
    sc.value.templates[fmtTab.value] = v
  },
})
</script>

<template>
  <div class="sec">指令模板 (随色彩格式切换)
    <button class="mini" @click="showTplHelp = !showTplHelp">通配符?</button>
  </div>
  <div v-if="showTplHelp" class="help">
    <div v-for="h in PLACEHOLDER_DOC" :key="h[0]" class="help-row">
      <code>{{ h[0] }}</code><span class="dim">{{ h[1] }}</span>
    </div>
  </div>
  <div class="tabs">
    <button v-for="f in FMTS" :key="f" :class="{ on: fmtTab === f }" @click="fmtTab = f">{{ f }}</button>
  </div>
  <textarea v-model="tpl" rows="3" class="tpl"></textarea>
  <div class="dim tpl-hint">
    每行一条指令; 多行模板按行输出。当前 {{ fmtTab }} 模板预览:
    <span class="mono">{x},{y},{w},{h},{pic}{{ fmtTab === 'GRAY' ? ',{color},{mirror}' : '' }}</span>
  </div>
  <details>
    <summary class="dim">头部 / 尾部 (整段导出包裹)</summary>
    <textarea v-model="sc.header" rows="3" class="tpl" placeholder="/* 头部: 一般放 #include / 宏定义 */"></textarea>
    <textarea v-model="sc.footer" rows="2" class="tpl" placeholder="/* 尾部 */"></textarea>
    <div class="dim tpl-hint" style="margin-bottom: 0">
      头部的 <code class="mono">#include "bsp_gc9a01.h"</code> 会被认成屏幕的 LCD 头 (导出代码 include 它)
    </div>
  </details>
</template>

<style scoped>
.help { background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; margin-bottom: 6px; }
.help-row { display: flex; gap: 10px; font-size: 11px; }
.help-row code { color: var(--accent); }
.tabs { display: flex; gap: 4px; margin-bottom: 4px; }
.tabs button.on { background: var(--accent-dim); color: #fff; border-color: var(--accent); }
.tpl { width: 100%; resize: vertical; }
.tpl-hint { font-size: 11px; margin: 2px 0 8px; }
</style>
