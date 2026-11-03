<script setup>
/*
 * 一键导出: 把网页要交给固件的全部文件一次写进 code/lcd/ 目录
 *   优先用 File System Access API (Chrome/Edge, 需 https 或 localhost) 直接写文件夹;
 *   不支持时自动回退成逐个下载。
 *
 * ！导出目录是**每个存档自己的** (state.exportDir, 随工程 JSON 保存):
 *   · 句柄本体不能 JSON 化 → 按 exportDir.id 存 IndexedDB;
 *   · 切换存档后只认新存档的 id, 绝不沿用上一个工程的 dirHandle
 *     (老实现是模块级单例, 切档后一键导出会写进上一个工程的 code/lcd);
 *   · 换机器/清缓存 → 句柄失效, 一键导出时按这个存档重新选一次,
 *     JSON 里的 name 用来告诉用户"这个存档原来导出到哪个文件夹"。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  state, screen, cloud, exportLayer, ensureFontsReady, estimateLzss,
  loadExportDirHandle, rememberExportDir, normalizeExportDir,
} from '../store.js'
import { downloadText, downloadBlob } from '../utils.js'
import { buildZipBlob, zipFileName } from '../zip.js'

const status = ref('')
const busy = ref(false)
const canPick = typeof window !== 'undefined' && !!window.showDirectoryPicker

const KB = (b) => (b / 1024).toFixed(1) + ' KB'
/* LZSS 预估与导出共用同一个 exportLayer/pack (真实压缩, 不是估算公式)。
 * ！不能直接用 computed: exportLayer 要渲染所有图层并压缩, 拖拽时每帧算会卡。
 * 这里用"轻量签名 + 350ms 防抖"的 watch, 停下来才算一次。 */
const lzssStat = ref(null)
const lzssErr = ref('')
const pctText = (ratio) => {
  const p = 100 - 100 * ratio
  return (p >= 0 ? '-' : '+') + Math.abs(p).toFixed(1) + '%'
}
const lzssSavedText = computed(() => {
  const s = lzssStat.value
  if (!s || !s.rawBytes) return '0.0%'
  return pctText(s.packedBytes / s.rawBytes)
})
const lzssSig = computed(() => [
  state.instances.map(i => [i.id, i.kind, i.assetId, i.x, i.y, i.w, i.h, i.fmt, i.store, i.ext,
    i.frame, i.allFrames, i.sizeOnly, i.assetOnly, i.color, i.mirror, i.text, i.spacing, i.ascii,
    i.idFn, i.bind?.name, i.bind?.dec, i.bind?.cells, i.crop?.x, i.crop?.y,
    i.sysfont ? JSON.stringify(i.sysfont) : ''].join(',')).join('|'),
  state.assets.map(a => [a.id, a.w, a.h, a.src ? a.src.length : 0,
    a.font ? JSON.stringify(a.font) : ''].join(':')).join('|'),
  screen.value.w, screen.value.h, screen.value.grayPack,
  state.exportOpts.lzssChunked, state.exportOpts.lzssChunkBytes, state._imgTick,
].join('||'))
/* 老工程/手动关过分片: 一键回到 2.4KB 分片 (旧 g_assetBuf 的量级) */
function enableChunk() {
  state.exportOpts.lzssChunked = true
  if (!(+state.exportOpts.lzssChunkBytes > 0)) state.exportOpts.lzssChunkBytes = 2400
}
let lzssTimer = 0
function refreshLzss() {
  const r = estimateLzss({
    lzssChunked: !!state.exportOpts.lzssChunked,
    lzssChunkBytes: +state.exportOpts.lzssChunkBytes || 2400,
  })
  lzssErr.value = r.ok ? '' : (r.reason || '预估失败')
  lzssStat.value = r.ok ? r.stat : null
}
watch(lzssSig, () => {
  clearTimeout(lzssTimer)
  lzssTimer = setTimeout(refreshLzss, 350)
})
onMounted(refreshLzss)
onBeforeUnmount(() => clearTimeout(lzssTimer))

/* 当前存档的导出目录记录 (name 给人看, id 找本机句柄) */
const dirInfo = computed(() => normalizeExportDir(state.exportDir))
const dirName = computed(() => dirInfo.value.name || '')

/* 覆盖前二次确认: 目录里已有同名文件时不直接覆盖, 先给
 * 「继续覆盖 / 修改路径 / 取消」三个选择. */
const overwritePrompt = ref(null)   // { dir, files:[] }
let overwriteResolve = null
function askOverwrite(dir, files) {
  overwritePrompt.value = { dir, files: [...files] }
  return new Promise(resolve => { overwriteResolve = resolve })
}
function answerOverwrite(choice) {
  const r = overwriteResolve
  overwriteResolve = null
  overwritePrompt.value = null
  if (r) r(choice)
}
onBeforeUnmount(() => { if (overwriteResolve) answerOverwrite('cancel') })

/* id -> 句柄 的单条缓存: 必须同时比较 id, 否则切档后会拿错目录 */
let handleCache = { id: '', handle: null }

async function getHandle(id) {
  if (!id) return null
  if (handleCache.id === id && handleCache.handle) return handleCache.handle
  const h = await loadExportDirHandle(id)
  if (h) handleCache = { id, handle: h }
  return h
}

/** 句柄从 IndexedDB 恢复后可能还需要一次权限 (必须在用户点击的调用栈里) */
async function ensurePermission(handle) {
  try {
    if (!handle || typeof handle.queryPermission !== 'function') return true
    let p = await handle.queryPermission({ mode: 'readwrite' })
    if (p === 'granted') return true
    if (p !== 'prompt' || typeof handle.requestPermission !== 'function') return false
    p = await handle.requestPermission({ mode: 'readwrite' })
    return p === 'granted'
  } catch (e) {
    return false
  }
}

/** 目录选择器的 id: 按存档分开记 (浏览器据此记住每个存档上次选的目录) */
function pickerId() {
  const slug = String(cloud.current || 'unsaved').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24) || 'unsaved'
  return 'lcd-' + slug
}

/** 让用户明选一个目录 → 记成**这个存档**的目录 (新 id, 不与其他存档共用) */
async function pickDir() {
  const info = dirInfo.value
  const saved = info.id ? await getHandle(info.id) : null
  const opts = { id: pickerId(), mode: 'readwrite', startIn: saved || 'documents' }
  let h
  try {
    h = await window.showDirectoryPicker(opts)
  } catch (e) {
    /* 旧句柄失效时 startIn 可能被拒: 退回默认目录再选一次 */
    if (saved && e && e.name === 'TypeError') {
      h = await window.showDirectoryPicker({ id: pickerId(), mode: 'readwrite', startIn: 'documents' })
    } else {
      throw e
    }
  }
  await rememberExportDir(h)
  handleCache = { id: state.exportDir.id, handle: h }
  return h
}

/** 取当前存档的目录: 有本机句柄就直接用; 没有/没权限就让用户选 (不会借用别的存档) */
async function resolveDir() {
  const info = dirInfo.value
  if (info.id) {
    const h = await getHandle(info.id)
    if (h && await ensurePermission(h)) {
      /* 文件夹在系统里改过名 → 把 JSON 里的 name 跟着更新 */
      if (h.name && h.name !== info.name) {
        state.exportDir = { ...info, name: String(h.name).slice(0, 120) }
      }
      return { handle: h, picked: false }
    }
  }
  return { handle: await pickDir(), picked: true }
}

async function chooseDir() {
  if (busy.value || !canPick) return
  busy.value = true
  try {
    status.value = '选择导出目录…'
    const h = await pickDir()
    status.value = `导出目录已设为 ${h.name}/（只对这个存档生效；记得保存工程）`
  } catch (e) {
    status.value = (e && e.name === 'AbortError') ? '已取消选择目录' : '选择目录失败: ' + (e && e.message ? e.message : e)
  } finally {
    busy.value = false
  }
}

async function fileExists(dir, name) {
  try { await dir.getFileHandle(name); return true } catch (e) { return false }
}

/** 文件夹写不了 (不支持/权限失败/写入异常) → 打成一个 ZIP 下载, 不再散落一堆文件。
 *  ZIP 自己失败才退回逐个下载 (最后一层兜底)。 */
async function downloadFallback(files, reason) {
  try {
    const blob = await buildZipBlob(files.map(f => (
      f.data != null ? { name: f.name, data: f.data } : { name: f.name, text: f.text }
    )))
    downloadBlob(zipFileName(cloud.current || 'lcd-export'), blob)
    status.value = `${reason} —— 已打包 ZIP 下载 ${files.length} 个文件`
  } catch (e) {
    files.forEach(f => (f.data != null ? downloadBlob(f.name, f.data) : downloadText(f.name, f.text)))
    status.value = `${reason} —— ZIP 打包失败 (${e && e.message ? e.message : e})，已逐个下载 ${files.length} 个文件`
  }
}

/** 只下载 ZIP，不申请/写入任何文件夹。与「一键导出到文件夹」共用同一份 exportLayer()。 */
async function downloadZip() {
  if (busy.value) return
  busy.value = true
  try {
    status.value = '核定字体…'
    const gate = await ensureFontsReady()
    if (!gate.ok) {
      status.value = `字体还没就绪 (${gate.missing.join(', ')}): 已重新拉取, 等 1~2 秒再点一次`
        + ' —— 现在导出会把回退字体的字模写进 ui_font.c'
      return
    }
    let files, stat
    try { ({ files, stat } = exportLayer()) } catch (e) {
      status.value = '导出失败: ' + e.message
      return
    }
    await downloadFallback(files, `手动 ZIP 下载（图层 ${stat.layers}）`)
  } finally {
    busy.value = false
  }
}

async function run() {
  if (busy.value) return
  busy.value = true
  try {
    /* ① 先定目录 (利用这次点击的用户手势; 也让 lcd-project.json 里带上正确目录) */
    let target = null, picked = false, dirErr = ''
    if (canPick) {
      status.value = '准备导出目录…'
      try {
        const r = await resolveDir()
        target = r.handle
        picked = r.picked
      } catch (e) {
        /* 用户按取消: 什么都不写, 也不要偷偷改成下载 */
        if (e && e.name === 'AbortError') {
          status.value = '已取消选择导出目录，未写文件'
          return
        }
        dirErr = e && e.message ? e.message : String(e)
      }
    }

    /* ② 字体核定 (2026-10-13): 系统字是 canvas 同步画的, 内置字体没到位时浏览器会静默用
     *   回退字体画, 字宽/字形还被 sysRenderCache / numFontSysCache 缓存住 —— 这时导出就把
     *   **回退字体的字模**烘进了 ui_font.c (实测每格 53 vs 真字体 59, 两位数字差 12px,
     *   上板会压掉旁边图层)。核定不过就不出文件, 让用户等字体到位再点。 */
    status.value = '核定字体…'
    const gate = await ensureFontsReady()
    if (!gate.ok) {
      status.value = `字体还没就绪 (${gate.missing.join(', ')}): 已重新拉取, 等 1~2 秒再点一次`
        + ' —— 现在导出会把回退字体的字模写进 ui_font.c'
      return
    }

    /* ③ 生成文件 (此时若判定"画过回退字体", 缓存已被 refreshFontMetrics 清掉, 这里走真字体) */
    let files, stat
    try { ({ files, stat } = exportLayer()) } catch (e) {
      status.value = '导出失败: ' + e.message
      return
    }
    const summary = `图层 ${stat.layers} (内部 ${stat.int} / 外部 ${stat.ext} / LZSS ${stat.lzss ? stat.lzss.groups : 0}, 跳过 ${stat.skipped})`

    /* ④ 写文件夹 (不支持/拿不到目录就打包 ZIP 下载; 压缩只在写文件夹时生效) */
    if (!target) {
      await downloadFallback(files,
        dirErr ? `无法申请文件夹权限 (${dirErr})` : '此浏览器不支持直接写文件夹')
      return
    }

    /* ⑤ 覆盖前二次确认: 目录里已有同名文件 → 继续覆盖 / 修改路径 / 取消.
     *   改路径后对新目录再查一遍 (循环), 绝不在用户没确认时覆盖. */
    while (true) {
      const existing = []
      for (const f of files) {
        if (f.once) continue
        if (await fileExists(target, f.name)) existing.push(f.name)
      }
      if (!existing.length) break
      status.value = `等待确认：${target.name}/ 已有 ${existing.length} 个文件…`
      const choice = await askOverwrite(target.name, existing)
      if (choice === 'cancel') {
        status.value = `已取消写入（${target.name}/ 里已有 ${existing.length} 个文件，未覆盖）`
        return
      }
      if (choice === 'change') {
        status.value = '选择新的导出目录…'
        try {
          target = await pickDir()
          picked = true
        } catch (e) {
          if (e && e.name === 'AbortError') { status.value = '已取消选择目录，未写文件'; return }
          status.value = '选择目录失败: ' + (e && e.message ? e.message : e)
          return
        }
        continue
      }
      break                              // 继续覆盖
    }

    status.value = '导出中…'
    try {
      const kept = []
      const fresh = []                     // 新出现的 .c —— Keil 工程要手动加进分组, 否则链接报 undefined
      let wrote = 0
      /* 旧固定布局压缩文件: 新导出不再生成, 但在旧目录里可能还躺着 → 提醒从 Keil 移除 */
      const legacy = []
      if (stat.lzss) {
        for (const n of ['ui_assets_packed.c', 'asset_blocks.h', 'asset_lzss.c', 'asset_lzss.h']) {
          if (await fileExists(target, n)) legacy.push(n)
        }
      }
      for (const f of files) {
        const exists = await fileExists(target, f.name)
        if (exists && f.once) { kept.push(f.name); continue }   // 只生成一次的文件 (ui_user.h): 不覆盖
        if (!exists && /\.c$/.test(f.name)) fresh.push(f.name)
        const fh = await target.getFileHandle(f.name, { create: true })
        const w = await fh.createWritable()
        await w.write(f.data ? new Blob([f.data]) : new Blob([f.text], { type: 'text/plain;charset=utf-8' }))
        await w.close()
        wrote++
      }
      status.value = `已写入 ${wrote} 个文件 → ${target.name}/`
        + (picked ? '（目录设置只对这个存档生效，记得保存工程）' : '')
        + (kept.length ? ` · 保留原样: ${kept.join(', ')} (不覆盖)` : '')
        + ` · ${summary}`
        + (stat.ringSpans && stat.ringSpans.ok
          ? ` · 圆环查表 ${stat.ringSpans.bytes} B (${stat.ringSpans.rows} 行)`
          : (stat.ringSpans && stat.ringSpans.code !== 'no-ring'
            ? ` · 圆环查表未生成: ${stat.ringSpans.reason}`
              + (['rect', 'seg-off'].includes(stat.ringSpans.code)
                ? '' : ' · 圆环+分段时请把 bsp_ring.c 的 RING_FAST_SEG 设为 0 (否则缺头文件)')
            : ''))
        + (stat.lzss ? ` · LZSS ${KB(stat.lzss.packedBytes)} / 原始 ${KB(stat.lzss.rawBytes)}，解码缓冲 ${stat.lzss.bufferSize} B` : '')
        + (stat.lzss ? ' · 需新版 app_ui.h（UI_FRAME_REF.asset / UI_FONT.assetBase / UI_DrawFrame(id)）并移除 app_ui.c 里旧 UI_DrawFrame' : '')
        + (legacy.length ? ` · 旧文件仍在目录: ${legacy.join(', ')} —— 请从 Keil 工程移除` : '')
        + (fresh.length ? ` · 新文件 ${fresh.join(', ')}: 记得加进 Keil 工程 (右键分组 → Add Existing Files)` : '')
    } catch (e) {
      /* 写目录失败 → ZIP 兜底 (与刚生成的文件一致) */
      await downloadFallback(files, `写入文件夹失败 (${e.message || e})`)
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="ea">
    <div class="mainrow">
      <button class="primary" :disabled="busy" @click="run"
              title="把 ring_config.h / ring_seg_spans.h / ring_scan.h/.c / ui_table.c / ui_font.c / ui_assets_*.c / ui_assets_lzss.* / lzss_decode.* / ui_asset_draw.* / ui_task.* 一次写进这个存档自己的 code/lcd/ 目录 (每个存档单独记住; 不支持时打包 ZIP)">
        {{ busy ? '导出中…' : '一键导出到文件夹' }}
      </button>
      <button class="zipbtn" :disabled="busy" @click="downloadZip"
              title="不写文件夹，直接把本次导出的全部 .c/.h/JSON 打成一个 ZIP 下载">
        ZIP 下载
      </button>
    </div>
    <!-- LZSS 概览: 由图层上的「LZSS」存储选择决定, 不需要全局开关。
         数据与导出共用同一份 plan/pack, 不会出现"预估一套、导出另一套"。 -->
    <div v-if="lzssStat" class="lzssbox">
      <div class="lzss-title">LZSS 素材
        <span class="dim">{{ lzssStat.groups }} 组 / {{ lzssStat.blocks }} 块</span>
      </div>
      <div class="dim st" title="原始素材总量 = LZSS 原始像素 + 内部 raw + 外部 raw；不压缩、不按存储方式拆分时的总量">
        原始素材总量（内部 + 外部）：<b>{{ KB(lzssStat.originalBytes) }}</b>
      </div>
      <div v-if="lzssStat.rawIntBytes || lzssStat.rawExtBytes" class="dim st">
        LZSS {{ KB(lzssStat.rawBytes) }} · 内部 raw {{ KB(lzssStat.rawIntBytes) }} · 外部 raw {{ KB(lzssStat.rawExtBytes) }}
      </div>
      <div v-if="lzssStat.rawIntBytes" class="dim st">LZSS 原始 {{ KB(lzssStat.rawBytes) }} → 压缩 {{ KB(lzssStat.packedBytes) }}（{{ lzssSavedText }}） · 表 {{ lzssStat.tableBytes }} B</div>
      <div v-else class="dim st">LZSS 压缩 {{ KB(lzssStat.packedBytes) }}（{{ lzssSavedText }}） · 表 {{ lzssStat.tableBytes }} B</div>
      <div class="dim st">解码 RAM：<b>{{ lzssStat.bufferSize }} B</b>
        （{{ lzssStat.chunked ? '分片 ' + lzssStat.chunkBytes + ' B' : '不分片（按最大帧）' }}）</div>
      <label class="cprs" title="按行切片: 每片解压后再画。开 = 缓冲小、块数多；关 = 一块解完整帧，缓冲 = 最大帧。表里每片都带 y 偏移, 渲染桥逐片绘制。">
        <input type="checkbox" v-model="state.exportOpts.lzssChunked" :disabled="busy"> 分片解码（省 RAM）
      </label>
      <label v-if="state.exportOpts.lzssChunked" class="cprs chunk" title="每片的目标字节数; 实际按整行/整列切, 缓冲取实际最大片">
        粒度 <input type="number" min="128" step="128" v-model.number="state.exportOpts.lzssChunkBytes" :disabled="busy"> B
      </label>

      <div v-if="lzssStat.bufferSize > 4096 && !lzssStat.chunked" class="warn st">
        解码缓冲 {{ lzssStat.bufferSize }} B 较大（不分片 = 按最大帧；旧版是强制拆条 + 2400 B）。
        <button class="mini" @click="enableChunk">按 2.4KB 分片</button>
      </div>
      <div v-if="lzssStat.warnings && lzssStat.warnings.length" class="warn st">{{ lzssStat.warnings[0] }}</div>
      <div v-if="lzssStat.dedupeSaved > 0" class="dim st">相同帧去重省 {{ lzssStat.dedupeSaved }} B</div>
      <details v-if="lzssStat.detail && lzssStat.detail.length" class="lzss-detail">
        <summary class="dim">逐项压缩率（{{ lzssStat.detail.length }} 组）</summary>
        <div v-for="g in lzssStat.detail" :key="g.key" class="lzss-row dim">
          <span class="mono">{{ g.label }}</span>
          <span>{{ KB(g.rawBytes) }} → {{ KB(g.packedBytes) }}（{{ pctText(g.ratio) }}）</span>
        </div>
      </details>
    </div>
    <div v-else-if="lzssErr" class="warn st">LZSS 预估失败：{{ lzssErr }}</div>
    <div class="dirline">
      <span class="dim">目录</span>
      <span class="dname" :title="dirName ? '这个存档的导出目录: ' + dirName : '这个存档还没选导出目录；一键导出时会让你选，不会沿用上一个存档的目录'">
        {{ dirName ? dirName + '/' : '未选择（本存档单独设置）' }}
      </span>
      <button v-if="canPick" class="mini" :disabled="busy" @click="chooseDir"
              title="给这个存档选择导出目录（每个存档单独记住，随工程 JSON 保存）">选择…</button>
    </div>
    <div v-if="!canPick && !status" class="dim st">此浏览器不支持直接写文件夹，会打包成 ZIP 下载。</div>
    <div class="dim st" v-if="status">{{ status }}</div>
  </div>

  <!-- 覆盖前二次确认: 继续覆盖 / 修改路径 / 取消 -->
  <Teleport to="body">
    <div v-if="overwritePrompt" class="ow-mask" @click.self="answerOverwrite('cancel')">
      <div class="ow-dlg">
        <div class="ow-title">目标目录里已有文件，先确认</div>
        <div class="ow-body">
          <div class="ow-row">目录：<b class="mono">{{ overwritePrompt.dir }}/</b></div>
          <div class="ow-row">将覆盖 <b>{{ overwritePrompt.files.length }}</b> 个文件：</div>
          <div class="ow-files mono">
            <div v-for="f in overwritePrompt.files" :key="f" class="ow-file">{{ f }}</div>
          </div>
          <div class="ow-note dim">ui_user.h 这类只生成一次的文件会保持原样；改路径会换成这个存档的新目录。</div>
        </div>
        <div class="ow-actions">
          <button class="primary" @click="answerOverwrite('continue')">继续覆盖</button>
          <button @click="answerOverwrite('change')">修改路径…</button>
          <button @click="answerOverwrite('cancel')">取消</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 主操作单独占一行: 状态文字再长也只占自己那一行, 不挤旁边的按钮 */
.ea { display: flex; flex-direction: column; gap: 4px; }
.ea button { width: 100%; }
.mainrow { display: flex; gap: 6px; align-items: stretch; }
.mainrow .primary { flex: 1 1 0; min-width: 0; }
.mainrow .zipbtn { flex: 1 1 0; width: auto; white-space: nowrap; }
.dirline { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 11px; }
.dirline .dname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.dirline button { flex: none; width: auto; padding: 0 6px; font-size: 10px; line-height: 18px; }
.st { font-size: 11px; line-height: 1.5; word-break: break-word; max-height: 64px; overflow-y: auto; }
.cprs { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text); cursor: pointer; user-select: none; }
.cprs input { margin: 0; }
.lzssbox { border: 1px solid var(--border, #333); border-radius: 6px; padding: 6px 8px; margin: 4px 0; display: flex; flex-direction: column; gap: 3px; background: rgba(255,255,255,.02); }
.lzss-title { font-size: 12px; font-weight: 600; display: flex; justify-content: space-between; gap: 8px; }
.lzss-title .dim { font-weight: 400; font-size: 10px; }
.chunk input { width: 64px; }

.warn .mini { width: auto; margin-left: 4px; font-size: 10px; line-height: 15px; }
.lzss-detail { font-size: 10px; }
.lzss-detail summary { cursor: pointer; user-select: none; }
.lzss-row { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; }
.lzss-row .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%; }
.warn { font-size: 11px; line-height: 1.5; word-break: break-word; color: #ffb74d; max-height: 64px; overflow-y: auto; }
/* 覆盖前确认 (遮罩 + 面板, 与删除页/其它弹窗同一套观感) */
.ow-mask { position: fixed; inset: 0; z-index: 130; background: rgba(0, 0, 0, .55); display: flex; align-items: flex-start; justify-content: center; padding-top: 16vh; }
.ow-dlg { width: min(480px, 92vw); background: var(--bg2, #1b1d21); border: 1px solid var(--border, #333); border-radius: 8px; box-shadow: 0 12px 40px rgba(0,0,0,.55); overflow: hidden; }
.ow-title { padding: 9px 12px; font-weight: 600; font-size: 13px; color: var(--accent, #4fc3f7); border-bottom: 1px dashed var(--border, #333); }
.ow-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.ow-row { color: var(--text-dim, #999); }
.ow-row b { color: var(--text, #eee); font-weight: 600; }
.ow-files { max-height: 120px; overflow-y: auto; background: var(--bg, #111); border: 1px solid var(--border, #333); border-radius: 4px; padding: 6px 8px; font-size: 11px; line-height: 1.65; }
.ow-file { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ow-note { font-size: 11px; line-height: 1.6; }
.ow-actions { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px dashed var(--border, #333); }
.ow-actions button { flex: 1; min-width: 0; }
</style>
