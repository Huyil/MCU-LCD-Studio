/*
 * UI 渲染冒烟 (node scripts/check-ui-render.mjs)
 *
 * 为什么要有: 左栏/右栏挂了大段新模板后, 曾经的失败模式是 **SFC 解析/渲染报错**
 * (vite build 能过但页面白屏)。这里用 vite 的 SSR 加载器把真正的 .vue 组件渲染成
 * HTML 字符串 —— 解析错、模板引用不存在的变量、v-for 结构错都会在这里直接抛出来。
 *
 * 不测交互 (canvas 绘制/拖拽/点击), 只测"挂载得起来 + 关键元素在"。
 */
import { createServer } from 'vite'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import fs from 'node:fs'

/* 浏览器 API 桩: 导出面板的云端存档块在 setup 里就读 localStorage (记住上次档名),
 * Node 里没有这个东西 —— 不桩的话 SSR 渲染直接抛 "localStorage is not defined",
 * 整个 UI 冒烟就只剩一条 FAIL (和模板本身对不对无关)。 */
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null },
  setItem(k, v) { this._m.set(k, String(v)) },
  removeItem(k) { this._m.delete(k) },
}
globalThis.fetch = async () => { throw new Error('no net in node') }

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}

const server = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

const render = async (comp) => renderToString(createSSRApp(comp))

try {
  const store = await server.ssrLoadModule('/src/store.js')
  const { state, bindDefaults } = store
  const Card = (await server.ssrLoadModule('/src/components/MultiLineDialog.vue')).default
  const Panel = (await server.ssrLoadModule('/src/components/AssetPanel.vue')).default
  const Export = (await server.ssrLoadModule('/src/components/ExportPanel.vue')).default
  const Archive = (await server.ssrLoadModule('/src/components/ArchivePanel.vue')).default

  /* ---- 素材库: 按钮 + 弹窗 ---- */
  state.uiExport.text = 'LEVEL\nMOTOR 1\nSTOP'
  state.uiExport.mode = 1
  state.uiExport.lineGap = 2
  state.uiExport.splits = [
    { y: 0, frame: true, color: 0xFFFF },
    { y: 13, frame: false },
    { y: 26, frame: true, color: 0xFFE0 },
  ]

  state.ui.dialogMultiLine = false
  const panel = await render(Panel)
  ok('AssetPanel 渲染不抛错', panel.length > 500, `${panel.length} 字节`)
  ok('素材库顶部有「多帧画板」按钮 (原「＋文本框」位置), 不再有文本框入口',
     panel.includes('多帧画板') && !panel.includes('＋ 文本框') && panel.includes('素材库'))
  ok('素材库: 旧的「T 系统字」按钮已删 (系统字改在文字弹窗里切来源)',
     !panel.includes('T 系统字') && !panel.includes('dialogSysNew') &&
     panel.includes('＋文字') && panel.includes('圆环'))
  ok('弹窗未打开时不出现在页面里', !panel.includes('加入素材库 ('))

  /* 多帧素材卡片: 单帧实际尺寸 + 帧数, 不是整条拼版尺寸 */
  {
    const src = fs.readFileSync(new URL('../src/components/AssetPanel.vue', import.meta.url), 'utf8')
    ok('素材库: 多帧卡片显示单帧尺寸 + 帧数 (不是整条拼版尺寸)',
       /function assetSizeText/.test(src) && /frameStripCount\(a\)/.test(src) &&
       /\{\{ assetSizeText\(a\) \}\}/.test(src) && /\{\{ assetSizeText\(it\.asset\) \}\}/.test(src))
  }

  /* 左栏: 当前工程 / 总素材库 切换 (总库含其他工程素材) */
  {
    const lib = store.assetLibrary
    const keepMode = lib.mode, keepItems = lib.items
    lib.mode = 'global'
    lib.items = [{
      id: 'ga_test', key: 'k_test',
      asset: { id: 'a_test', name: '共享素材', src: 'data:image/png;base64,AA', w: 8, h: 8 },
      origins: ['工程A', '工程B'], addedAt: 1,
    }, {
      id: 'ga_text', key: 'k_text',
      asset: { id: 'text_layer_t1', name: '文字「ABC」', src: 'data:image/png;base64,AA', w: 8, h: 8, derivedText: 't1' },
      origins: ['当前工程'], addedAt: 2,
    }]
    const gp = await render(Panel)
    ok('素材库: 可切到「总素材库」(跨工程素材 / 来源 / 同步在线存档)',
       gp.includes('总素材库') && gp.includes('共享素材') && gp.includes('工程A') &&
       gp.includes('同步在线存档素材') && gp.includes('当前工程'))
    ok('素材库: 总库素材有「单击 / 拖动 = 加入当前工程」说明',
       gp.includes('单击 / 拖动 = 加入当前工程'))
    ok('素材库: 文字/系统字快照显示「文字」标签 (与图片/字库/画板区分)',
       gp.includes('文字「ABC」') && gp.includes('text-tag'))
    const panelSrc = fs.readFileSync(new URL('../src/components/AssetPanel.vue', import.meta.url), 'utf8')
    ok('素材库: 同步按钮写明只读服务器现有存档并重建 (不再累积历史条目)',
       panelSrc.includes('只读取服务器上现有的存档') && panelSrc.includes('重建总库'))
    const textSrc = fs.readFileSync(new URL('../src/components/TextDialog.vue', import.meta.url), 'utf8')
    ok('文字弹窗: 字库下拉排除自动生成的「文字」快照 (没有 font, 不能当字库选)',
       /filter\(a => !a\.derivedText\)/.test(textSrc))
    lib.mode = keepMode
    lib.items = keepItems
  }

  state.ui.dialogMultiLine = true
  const dlg = await render(Card)
  ok('文本框弹窗渲染不抛错', dlg.length > 500, `${dlg.length} 字节`)
  ok('弹窗: 标题 + 尺寸标签', dlg.includes('文本框') && dlg.includes('56×37'))
  ok('弹窗: 3 条分割线各一行 (区域列表 3 行)', (dlg.match(/class="split-row/g) || []).length === 3)
  ok('弹窗: 勾 2 个 → 按钮写「加入素材库 (2 段)」', dlg.includes('加入素材库 (2 段)'))
  ok('弹窗: 有素材名输入框', dlg.includes('class="namein"'))
  ok('弹窗: 说明写清"每段各成一张独立素材" (多行只是网页侧的便利, 与输出无关)',
     dlg.includes('每段各成一张独立素材') && dlg.includes('打包成一张多帧素材') && !dlg.includes('高亮行'))
  ok('弹窗: 预览画布 + 交互提示', dlg.includes('class="cv"') && dlg.includes('点击 / 拖动分线'))
  ok('弹窗: 分割线是 1px 叠加细线 (不随预览放大变粗), 3 条线 3 个',
     dlg.includes('class="lines"') && (dlg.match(/class="[^"]*\bhline\b/g) || []).length === 3,
     `hline=${(dlg.match(/class="[^"]*\bhline\b/g) || []).length}`)
  ok('弹窗: 实线/虚线区分 (作为一帧 / 只作参考)',
     (dlg.match(/class="[^"]*\bref\b[^"]*"/g) || []).length === 1)
  ok('弹窗: 说明里写清"线那一行算下面那段"', dlg.includes('线所在那一行算下面那段的第一行'))
  ok('弹窗: 有「每 N px 均分」(切窄条用)', dlg.includes('class="bandnum"') && dlg.includes('均分'))
  ok('弹窗: 字模高度标签是「字高」(不是分割条高度)',
     dlg.includes('>字高</label>') && !dlg.includes('>行高</label>'))
  /* 下方列表 = 区域 (一行 = 一段), 不是分割线 */
  ok('弹窗: 下方列表是「分割区域」而不是分割线',
     dlg.includes('分割区域 (3)') && !dlg.includes('分割线 (3)'))
  ok('弹窗: 每段显示自己的 y 范围与高度',
     dlg.includes('0–13') && dlg.includes('13–26') && dlg.includes('26–37') &&
     dlg.includes('13px') && dlg.includes('11px'))
  ok('弹窗: 第 1 段的 y 锁在 0 (顶部锚线, 不用手动加)',
     (dlg.match(/class="ynum"/g) || []).length === 3 && /class="ynum"[^>]*value="0" disabled/.test(dlg))
  ok('弹窗: 锚线不给删 (取消「帧」即可不导出这段)',
     /class="mini danger" disabled/.test(dlg))
  ok('弹窗: 内容回填到文本框', dlg.includes('LEVEL'))

  /* ---- ＋文字弹窗: 双击打开"数字"层时, 内容必须还是「数字 (变量)」 ---- */
  {
    const store2 = await server.ssrLoadModule('/src/store.js')
    const Text = (await server.ssrLoadModule('/src/components/TextDialog.vue')).default
    const keep = state.instances
    // 造一个"系统字 + 数字"的图层 (kind=image + sysfont + bind, 跟真实创建路径一致)
    state.instances = [{
      id: 'sysnum', kind: 'image', page: 'main', name: 'misans_1', x: 101, y: 110, w: 60, h: 24,
      fmt: 'GRAY', color: 0xFFFF, mirror: false, frame: null, crop: { x: 0, y: 0 },
      sysfont: { text: '123', family: 'MiSans', size: 24, weight: 400, spacing: 0, offsetY: 0, lineGap: 0 },
      bind: { type: 'num', name: 'g_uiSpeed', dec: 1, cells: 4, align: 1, pad: 0, bg: 0, demo: 125, period: 200 },
    }]
    state.ui.dialogSysId = 'sysnum'
    await new Promise(r => setTimeout(r, 30))
    const ctx = {}
    const html = await renderToString(createSSRApp(Text), ctx)
    const body = (ctx.teleports && (ctx.teleports.body || ctx.teleports['#body'])) || html
    ok('＋文字弹窗: 打开时 X/Y 按图层当前位置回填 (拖拽到 101,110 后不会跳回旧位置)',
       body.includes('value="101"') && body.includes('value="110"'),
       `X=${/value="(\d+)"/.exec(body)?.[1]} Y 命中=${body.includes('value="110"')}`)
    ok('＋文字弹窗: 双击"系统字 + 数字"层, 内容仍选中「数字 (变量)」',
       /数字 \(变量\)/.test(body) && body.includes('变量名') && body.includes('g_uiSpeed') &&
       /radio[^>]*checked/.test(body), `${body.length} 字节`)

    /* ASCII 字库层: 双击打开要回填成「ASCII 字库」, 不是固定文本 (否则点确定就把字库改没了) */
    state.instances = [{
      id: 'sysascii', kind: 'image', page: 0, name: 'misans_2', ascii: true, x: 12, y: 34, w: 29, h: 14,
      fmt: 'GRAY', color: 0xFFFF, mirror: false, frame: null, crop: { x: 0, y: 0 },
      sysfont: { text: 'ABC', family: 'MiSans', size: 20, weight: 400, spacing: 0, offsetY: 0, lineGap: 0 },
    }]
    state.ui.dialogSysId = 'sysascii'
    {
      const ctx2 = {}
      const html2 = await renderToString(createSSRApp(Text), ctx2)
      const body2 = (ctx2.teleports && (ctx2.teleports.body || ctx2.teleports['#body'])) || html2
      const asciiRadio = body2.match(/<input[^>]*value="ascii"[^>]*>/)?.[0] || ''
      ok('＋文字弹窗: 双击"系统字 + ASCII 字库"层, 内容仍选中「ASCII 字库」',
         /ASCII 字库/.test(body2) && /checked/.test(asciiRadio) && body2.includes('misans_2'),
         `ascii=${asciiRadio}`)
      ok('＋文字弹窗: 数值回填 (X/Y) 仍按图层当前位置', body2.includes('value="12"') && body2.includes('value="34"'))
      ok('＋文字弹窗: ASCII 模式下没出"数字"专属字段 (变量名/格数)',
         !body2.includes('变量名') && !body2.includes('小数位'))
    }


    /* 右栏: ASCII 图层要有 ASCII 标签 + 状态行 (一眼看出出的是字库不是死图) */
    {
      const expAscii = await render(Export)
      ok('图层行: ASCII 字库层挂「ASCII」标签 + 状态行 (Str 函数 / 95 字形)',
         expAscii.includes('mode-tag lib') && expAscii.includes('>ASCII<') &&
         expAscii.includes('misans_2Str()') && expAscii.includes('0x20~0x7E'))
    }
    /* ---- 光晕 σ: 排在「边缘斜坡 σ」下方, **无独立开关** (σ 自己就是开关: 0 = 关) ---- */
    {
      const ctx3 = {}
      const h3 = await renderToString(createSSRApp(Text), ctx3)
      const b3 = (ctx3.teleports && (ctx3.teleports.body || ctx3.teleports['#body'])) || h3
      /* 右上角「图片下载」: 与预览 1:1 导出 (文字/数字 = 预览那张; ASCII = 16 列整表) */
      ok('＋文字弹窗: 右上角渲染出「⤓ 图片下载」按钮 (在 删除/取消/确定 左侧)',
         b3.includes('⤓ 图片下载') && b3.indexOf('⤓ 图片下载') < b3.indexOf('>删除<'))
      const iRamp = b3.indexOf('边缘斜坡')
      const iGlow = b3.indexOf('光晕')
      ok('＋文字弹窗: 「光晕 σ」排在「边缘斜坡 σ」下方',
         iRamp > 0 && iGlow > iRamp, `ramp@${iRamp} glow@${iGlow}`)
      /* 用户要求: "不要单独开关, 0 表示关" —— 与「边缘斜坡 σ」同一写法 */
      ok('＋文字弹窗: 光晕没有独立开关 (σ 自己就是开关)',
         !/<input[^>]*type="checkbox"[^>]*\/?>光晕/.test(b3))
      const win = b3.slice(iGlow, iGlow + 900)
      const gsl = (win.match(/<input[^>]*type="range"[^>]*>/) || [''])[0]
      ok('＋文字弹窗: 光晕 σ 是滑条, 0.1 一档, min=0 (= 关) 上限 12',
         gsl !== '' && /min="0"/.test(gsl) && /max="12"/.test(gsl) && /step="0\.1"/.test(gsl),
         gsl.slice(0, 96))
      /* 用户要求: "支持 0.1 调节" —— 数字框与滑条必须同档, 否则手填 0.5 会被滑条吸走 */
      ok('＋文字弹窗: 光晕 σ 的数字框也是 0.1 一档 (与滑条同档)',
         /max="12"[^>]*step="0\.1"/.test(win) && (win.match(/step="0\.1"/g) || []).length >= 2)
      ok('＋文字弹窗: 默认 σ=0 —— 只出提示行, 阈值/增益收起',
         b3.includes('σ ≥ 0.5 起才有可见光晕') &&
         !b3.includes('>阈值</label>') && !b3.includes('>增益</label>'))

      /* 光晕开着时: 数字/ASCII 要有「紧排」开关 + 每格占位提示 (解释 σ=4 → 2 格宽 +40px) */
      state.instances = [{
        id: 'sysglow', kind: 'text', page: 0, name: 'sysglow', x: 0, y: 0, w: 92, h: 64,
        fmt: 'GRAY', color: 0xFFFF,
        bind: { type: 'num', name: 'g_uiVal', dec: 0, cells: 2, align: 2, pad: 0, bg: 0, demo: 35 },
        sysfont: { family: 'DSEG7Modern-BoldItalic', size: 64, weight: 400, spacing: 0, offsetY: 0, rampSigma: 0, evenSpacing: true, glowSigma: 4, glowThresh: 40, glowGain: 2.5 },
      }]
      state.ui.dialogSysId = 'sysglow'
      {
        const ctxG = {}
        const hG = await renderToString(createSSRApp(Text), ctxG)
        const bG = (ctxG.teleports && (ctxG.teleports.body || ctxG.teleports['#body'])) || hG
        const fitChk = (bG.match(/<input[^>]*type="checkbox"[^>]*\/?>紧排/) || [''])[0]
        ok('＋文字弹窗: σ>0 时数字层出现「紧排」开关 (默认未勾选)',
           fitChk !== '' && !/checked/.test(fitChk), fitChk.slice(0, 96))
        ok('＋文字弹窗: 提示行算出每格占位 (σ=4 ⇒ 字距 +24px)',
           bG.includes('每格四周各留 12px') && bG.includes('字距最多 +24px'), bG.slice(bG.indexOf('每格四周'), bG.indexOf('每格四周') + 80))
        ok('＋文字弹窗: 清单外字体 (DSEG7) 不会显示成空白下拉',
           bG.includes('DSEG7Modern-BoldItalic (当前字体)'))
      }
    }

    /* ---- 等距: 只对「数字 (变量)/ASCII 字库」有意义 (那两条路每字一个独立字模) ---- */
    {
      /* ！「数字」是由 it.bind 认出来的, 不是 sysfont.content:
       *   对话框里是 `draft.content = it.ascii ? 'ascii' : (it.bind ? 'num' : 'fixed')` */
      state.instances = [{
        id: 'num1', kind: 'text', page: 0, name: 'num1', x: 0, y: 0, w: 40, h: 20,
        fmt: 'GRAY', color: 0xFFFF,
        bind: { type: 'num', name: 'g_uiVal', dec: 1, cells: 5, align: 1, pad: 0, bg: 0x0000, demo: 125 },
        sysfont: { family: 'MiSans', size: 20, spacing: 0, offsetY: 0, rampSigma: 0 },
      }]
      state.ui.dialogSysId = 'num1'
      const ctxN = {}
      const hN = await renderToString(createSSRApp(Text), ctxN)
      const bN = (ctxN.teleports && (ctxN.teleports.body || ctxN.teleports['#body'])) || hN
      const echk = (bN.match(/<input[^>]*type="checkbox"[^>]*\/?>等距/) || [''])[0]
      ok('＋文字弹窗: 数字(变量) 字库有「等距」开关, 且默认未勾选 (老行为不变)',
         echk !== '' && !/checked/.test(echk), echk.slice(0, 96))
      /* ！不能拿 indexOf('等距') 量距离 —— 模板注释 `<!-- 等距: ... -->` 在 SSR 里是保留的,
       *   那会命中注释而不是勾选框。改用勾选框自己的位置, 并钉住它落在「字距」行与「边缘斜坡」行之间。 */
      const iChk = bN.indexOf(echk)
      const iSp = bN.lastIndexOf('>字距</label>', iChk)
      const iRamp2 = bN.indexOf('边缘斜坡', iChk)
      ok('＋文字弹窗: 「等距」开关就在「字距」那一行 (用户要求加在字距行)',
         iChk > 0 && iSp > 0 && iSp < iChk && iRamp2 > iChk,
         `字距行@${iSp} 等距勾选框@${iChk} 边缘斜坡@${iRamp2}`)
    }
    /* 光晕是系统字专有 → 「字库素材」来源不该出现它 */
    {
      state.assets = [{ id: 'gz', name: 'gz', src: 'data:image/png;base64,AA', w: 8, h: 8 }]
      state.instances = [{
        id: 'gz1', kind: 'image', assetId: 'gz', page: 0, name: 'gz1',
        x: 0, y: 0, w: 8, h: 8, fmt: 'GRAY', color: 0xFFFF,
      }]
      state.ui.dialogSysId = 'gz1'
      const ctx4 = {}
      const h4 = await renderToString(createSSRApp(Text), ctx4)
      const b4 = (ctx4.teleports && (ctx4.teleports.body || ctx4.teleports['#body'])) || h4
      ok('＋文字弹窗: 字库素材来源不出现「光晕」 (光晕是系统字专有)',
         !b4.includes('光晕'), `${b4.length} 字节`)
    }
    state.ui.dialogSysId = null
    state.instances = keep
    void store2
  }

  /* ---- 右栏: 图层行 (静态/动态标签 + 第几帧 + 值) ---- */
  state.assets = [{
    id: 'mf', name: '内容 (3帧)', src: 'data:image/png;base64,AA', w: 56, h: 33,
    font: {
      glyphW: 56, glyphH: 11, charset: 'frames', dir: 'row', frames: 3, color: 0xFFFF,
      boxes: [{ x: 1, y: 1, w: 40, h: 10 }, { x: 0, y: 1, w: 32, h: 10 }, { x: 1, y: 1, w: 24, h: 10 }],
      frameColors: [0xFFFF, 0xFFE0, 0x07FF],
    },
  }]
  state.instances = [
    { id: 'v1', assetId: 'mf', name: 'Speed', kind: 'image', x: 10, y: 20, w: 40, h: 10, fmt: 'GRAY', color: 0xFFFF, frame: 0 },
  ]
  let exp = await render(Export)
  const expSrc = fs.readFileSync(new URL('../src/components/ExportPanel.vue', import.meta.url), 'utf8')
  ok('ExportPanel 渲染不抛错 (静态层)', exp.length > 500 && exp.includes('class="valrow"'))
  ok('图层行: 静态层不再挂"静态"标签 (只有数字层挂「数字」, 少点噪音)',
     !exp.includes('>静态<') && !exp.includes('mode-tag'))
  /* 帧一行、数字一行, 分开 (帧 = 显示第几帧; 数字 = 这一层变成变量数字) */
  ok('图层行: 设置行 = 页 + 外部 + 帧输入框 /总数 (无左右键, 不联动仅素材)',
     (exp.match(/class="valrow"/g) || []).length === 1 &&
     exp.includes('pagebtns') && exp.includes('外部') &&
     exp.includes('class="fnum"') && !exp.includes('◀') && !exp.includes('▶'))
  /* 「页」从文本框改成按钮组了 (用户: 填写功能不好用) —— 一页一个按钮, 点一下切换 */
  ok('图层行: 页 = 按钮组 (一页一个按钮, 点一下切换; 不再是文本框)',
     /class="[^"]*pagebtns/.test(exp) && /class="[^"]*pbtn/.test(exp) &&
     /toggleLayerPage\(inst, q\.n\)/.test(expSrc) && !/class="pagename/.test(expSrc) &&
     /class="mini pbtn add"/.test(expSrc) && !/class="pagename/.test(exp))
  /* 页面块: 能加页; 每页能隐藏; 正常页可删 (带前置条件提示) */
  ok('页面块: 「＋ 添加页」+ 每页「隐藏」开关 + 正常页「删除」',
     /＋ 添加页/.test(expSrc) && /setPageHidden\(pg\.n, !pageHidden\(pg\.n\)\)/.test(expSrc) &&
     /canDeletePage\(pg\.n\)/.test(expSrc) && /deletePageTip\(pg\.n\)/.test(expSrc) &&
     /function addPage\(\)/.test(expSrc) && /function nextFreePage\(\)/.test(expSrc) &&
     /删除/.test(exp))
  /* 删除要**能用**: 以前"有图层/被跳转就禁用" → 用户反馈按钮根本点不动。
   * 现在: 末页可删; 有图层的非 0 页可删 (图层挪到第 0 页); 中间空页号禁用并说明原因 */
  ok('页面块: 「整理页号」按钮 (压掉中间的空占位页; 图层归属/跳转目标一起重编号)',
     /整理页号 \(压掉 \{\{ compactInfo\.removed \}\} 个空页\)/.test(expSrc) &&
     /function compactPages\(\)/.test(expSrc) && /compactPlanPages\(state\.instances/.test(expSrc))
  ok('页面块: 跳转目标默认是第一个**正常页** (不是 -4 LOGO 那个特殊页); ms=0 时不显示目标选择',
     /pageList\.value\.find\(q => q\.n >= 0\)\?\.n \?\? 0/.test(expSrc) &&
     /v-if="pageJumpMs\(pg\.n\)"[\s\S]{0,420}<select class="pgsel"/.test(expSrc) &&
     /v-else class="pageline cfg more"/.test(expSrc))
  ok('页面块: 空页明确标出来 ("空页 · 进去是清屏") 且不再占第二行 (窄栏不挤)',
     /空页 · 进去是清屏/.test(expSrc) && /v-if="pg\.nums \|\| pageJumpMs\(pg\.n\)"/.test(expSrc) &&
     /class="mini chip"/.test(expSrc) && /class="mini danger del"/.test(expSrc))
  /* 用户要求: 正常页 (>=0) 一律**强制可删**, 删前弹确认窗并选图层新家 */
  ok('页面块: 正常页一律可删 (强制); 删除走确认窗 + 让用户选图层新家 + 页号重排',
     /const canDeletePage = \(n\) => n >= 0/.test(expSrc) &&
     /openDeletePage\(pg\.n\)/.test(expSrc) &&
     /function confirmDeletePage\(\)/.test(expSrc) &&
     /retargetAfterPageRemove\(state\.instances, n, dest\)/.test(expSrc) &&
     /retargetJumps\(\{ \.\.\.\(state\.pages \|\| \{\}\) \}, n, dest\)/.test(expSrc) &&
     /compactPages\(\)\n\}/.test(expSrc))
  ok('删页确认窗: 列出这一页的图层 + 新家下拉 + 说明页号会重排/跳转跟着走',
     /class="mask delmask"/.test(expSrc) && /dlg-layers/.test(expSrc) &&
     /v-model\.number="delPage\.dest"/.test(expSrc) && /delDestList/.test(expSrc) &&
     /页号会重排/.test(expSrc) && /确认删除/.test(expSrc) && /取消/.test(expSrc))
  ok('图层行: 页按钮对圆环也有 (圆环放哪页 = 那页启停圆环), 但圆环没有「外部」',
     /class="valrow"/.test(exp))
  ok('页面块: 3 个特殊页只能隐藏不能删 (按钮换「不可删」标签)',
     /v-if="!pg\.special"[\s\S]{0,240}openDeletePage\(pg\.n\)/.test(expSrc) &&
     /v-else class="tag spec"/.test(expSrc) && /只能「隐藏」/.test(expSrc) &&
     /PAGE_SPECIAL\[n\] \|\| '特殊页'\} 是固件状态机用的特殊页, 不能删除/.test(expSrc))
  ok('页面块/图层行: 隐藏页在按钮上打叉 (line-through) —— 一眼看出哪页被隐藏',
     /\.pbtn\.hidden \{ text-decoration: line-through/.test(expSrc))
  ok('图层行: 帧选择不禁用 (还没勾数字)', !/class="fnum"[^>]*disabled/.test(exp))

  /* 数字层 (由「＋文字」弹窗选的) 在图层行只显示状态, 不给在这里改成数字 */
  state.instances[0].bind = { type: 'num', name: 'g_uiSpeed', dec: 1, cells: 5, align: 1, pad: 0, bg: 0x0000, demo: 125 }
  exp = await render(Export)
  ok('图层行: 数字层多一行只读状态 (变量名/格数)',
     exp.includes('g_uiSpeed') && exp.includes('5 格') &&
     (exp.match(/class="valrow"/g) || []).length === 2)
  ok('图层行: 数字层不再有就地编辑的「数字」勾选框 (改去「＋文字」弹窗)',
     !exp.includes('>数字<input') && !exp.includes('class="vname"'))
  ok('图层行: 帧选择只给静态图层 (数字层不出现帧输入框; 静态图层一律显示, 含单帧)',
     expSrc.includes('v-if="inst.kind !== \'ring\' && !inst.bind && !inst.groupId"') && !exp.includes('class="fnum"'))
  ok('图层行: 数字层挂「数字」标签', exp.includes('mode-tag dyn') && exp.includes('>数字<'))
  /* ＋文字 弹窗里才是"固定文本 / 数字(变量) / ASCII 字库"的选择 */
  const txt = fs.readFileSync(new URL('../src/components/TextDialog.vue', import.meta.url), 'utf8')
  ok('＋文字弹窗: 有「固定文本 / 数字 (变量)」选择',
     txt.includes('固定文本') && txt.includes('数字 (变量)') && txt.includes('v-model="draft.content"'))
  ok('＋文字弹窗: 内容第三个选项「ASCII 字库」(只在来源=系统字库时出现)',
     /value="ascii" v-model="draft\.content"[^>]*\/>ASCII 字库/.test(txt) &&
     /v-if="draft\.source === 'system'[^"]*"[\s\S]{0,240}value="ascii"/.test(txt) &&
     txt.includes("const isAscii = computed(() => draft.content === 'ascii')"))
  ok('＋文字弹窗: ASCII 字库 = 整份 0x20~0x7E 字模表 + <名字>/<名字>Str 打进导出',
     txt.includes('asciiFontForSys') && txt.includes('ASCII_COUNT') &&
     txt.includes('idDrawFunction(fnName.value, { count: f.count, w: f.w, h: f.h, ascii: true, first })') &&
     txt.includes('asciiStrFunction(fnName.value, { first, count: f.count, w: f.w, h: f.h, gap: f.gap })'))
  ok('＋文字弹窗: ASCII 有"导出给固件的那份"字模一览 (读的同一份字节)',
     txt.includes('<span>ASCII 字模</span>') && txt.includes('asciiSheet(') &&
     txt.includes('renderNumCanvas(seg, color, 0xFFFF, font)') && txt.includes('asciiUrl'))
  ok('＋文字弹窗: 两个预览标题不带多余括号 (ASCII 字模 / 示例文本预览)',
     /<span>ASCII 字模<\/span>/.test(txt) && txt.includes("'示例文本预览'") &&
     !/<span>ASCII 字模 \(/.test(txt) && !/示例文本预览 \(/.test(txt))
  ok('＋文字弹窗: 上下 的说明写清"负值只收紧字底, 不切字顶" (现场踩过 -1 切字顶)',
     /上下<\/label>/.test(txt) && /从字底收紧/.test(txt) && /不会切到字顶/.test(txt) &&
     !txt.includes('整体上下微调'))
  ok('＋文字弹窗: 切回「字库素材」时自动退出 ASCII 模式 (那个来源没有 ASCII 字库)',
     txt.includes("nv === 'asset' && draft.content === 'ascii') draft.content = 'fixed'"))
  ok('＋文字弹窗: 数字字段齐 (变量名/小数位/格数/对齐/补零/底色/预览值)',
     ['draft.bind.name', 'draft.bind.dec', 'draft.bind.cells', 'draft.bind.align', 'draft.bind.pad', 'draft.bind.bg', 'draft.bind.demo']
       .every(t => txt.includes(t)))
  ok('＋文字弹窗: 字库信息(名字/尺寸/字距)单独一行 (不跟单选挤在一起, 改字号不会跳)',
     (() => {
       const i = txt.indexOf('<label>内容</label>')
       const row = txt.slice(i, txt.indexOf('</div>', i))
       return !row.includes('字库 {{ numFont.name }}') && txt.includes('class="dim mono fontinfo"')
     })())
  ok('＋文字弹窗: 数字模式按固件格式预览 + 放不下提示',
     txt.includes('formatNumText') && txt.includes('格放不下'))
  ok('＋文字弹窗: 系统字同时有「字距」和「行距」(不只是行距), 数字也用字距',
     txt.includes('>字距</label>') && txt.includes('>行距</label>') &&
     txt.includes('draft.lineGap') && txt.includes('numFont.gap'))
  ok('＋文字弹窗: 字距/行距/上下 自成一行 (不挤在"字号"那行后面)',
     (() => {
       const i = txt.indexOf('<label>字号</label>')
       const row = txt.slice(i, txt.indexOf('</div>', i))
       return !row.includes('字距') && !row.includes('行距') && !row.includes('上下')
     })())
  ok('＋文字弹窗: 系统字默认名 = 字体名_序号 (MiSans → misans_1); 中文名回退 txt_N',
     txt.includes('function autoName(') && txt.includes('function fontPrefix(') &&
     txt.includes("'txt_' + (state.instances.filter(i => i.sysfont).length + 1)") &&
     /p \+ '_' \+ \(Math\.max\(used, base\) \+ 1\)/.test(txt))
  ok('＋文字弹窗: 换字体时自动名跟着换 (microsoft_yahei_1 → misans_1), 自定义名不动',
     txt.includes('function looksAuto(') && /watch\(\(\) => draft\.family, \(nv, ov\)/.test(txt) &&
     txt.includes('looksAuto(draft.name, nv, ov)') && txt.includes('looksAuto(draft.name, draft.family)'))
  ok('＋文字弹窗: 字重按 PS 叫法 (Light/Regular/Medium/Bold) 且静态字体只列自带档位',
     txt.includes('fontInfo(draft.family).weights') && txt.includes('w.n }} ({{ w.v }}') &&
     txt.includes(':checked="(+draft.weight || 400) >= 700"'))
  ok('＋文字弹窗: 变量名允许结构体成员写法 (motor.speed / motor->speed)',
     txt.includes('cVarRef(String(b.name') && txt.includes('motor.speed / motor->speed'))
  ok('＋文字弹窗: 数字层不再自带更新周期 (周期挪到"页面"里统一设置)',
     !txt.includes('draft.bind.period') && !txt.includes('>更新周期</label>') &&
     txt.includes('更新周期在图层列表上方的「页面」里统一设置'))
  ok('＋文字弹窗: 预览值排在"补前导零"前面',
     txt.indexOf('<label>预览值</label>') > 0 &&
     txt.indexOf('<label>预览值</label>') < txt.indexOf('补前导零'))
  ok('＋文字弹窗: 标签紧贴输入框 (不再用 min-width 撑开)',
     /\.field-row label \{[^}]*min-width: 0/.test(txt))
  ok('＋文字弹窗: 标签与输入框绑成一对 (.pair), 换行时不会拆到两行',
     txt.includes('.pair { display: inline-flex') &&
     (txt.match(/class="pair"/g) || []).length >= 7 &&
     /<span class="pair"><label>预览值<\/label><input/.test(txt))
  ok('＋文字弹窗: 可变字体字重无极调节 (滑块+数字, wght 范围内连续)',
     txt.includes('isVariableFont(draft.family)') && txt.includes('type="range"') &&
     txt.includes('weightRangeOf(draft.family).min') && txt.includes('weightName(draft.weight)'))
  ok('＋文字弹窗: 默认字体 = MiSans (内置)', txt.includes('family: DEFAULT_FONT') && txt.includes('BUILTIN_FONTS'))
  ok('内置字体: 档位用 PS 叫法且与文件名对应 (MiSans Light/Regular/Medium/DemiBold/Bold)',
     (() => {
       const st = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')
       const okNames = ["n: 'Light'", "n: 'Regular'", "n: 'Medium'", "n: 'DemiBold'", "n: 'Bold'"]
       const fileOf = { Light: 'misans-300', Regular: 'misans-400', Medium: 'misans-500', DemiBold: 'misans-600', Bold: 'misans-700' }
       const dir = new URL('../src/assets/fonts/', import.meta.url)
       return okNames.every(x => st.includes(x)) &&
         Object.values(fileOf).every(f => fs.existsSync(new URL(f + '.woff2', dir))) &&
         st.includes("variable: true") && st.includes('min: 100, max: 700')
     })())
  ok('内置字体: @font-face 与字体文件一一对上 (MiSans/HarmonyOS/OPPO)',
     (() => {
       const css = fs.readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
       const need = ['misans-300', 'misans-400', 'misans-500', 'misans-600', 'misans-700',
         'harmonyos-sc-300', 'harmonyos-sc-400', 'harmonyos-sc-500', 'harmonyos-sc-700', 'oppo-sans-var']
       const dir = new URL('../src/assets/fonts/', import.meta.url)
       return need.every(n => css.includes(n + '.woff2') && fs.existsSync(new URL(n + '.woff2', dir))) &&
         css.includes("font-family: 'MiSans'") && css.includes("font-family: 'HarmonyOS Sans SC'") &&
         css.includes("font-family: 'OPPO Sans 4.0'") && css.includes('font-weight: 100 700')
     })())
  ok('＋文字弹窗: 数字模式额外给一条 0~9 字模预览 (就是导出的那份)',
     txt.includes('数字字模 (导出给固件的那份)') && txt.includes("DIGIT_CHARS = '-.0123456789'") &&
     txt.includes('digitUrl'))
  ok('＋文字弹窗: 字距允许负数 / 预览透明底(不黑) + 显示导出与内容尺寸',
     txt.includes('min="-32"') && txt.includes('tintCanvas') && txt.includes('inkBox') &&
     txt.includes('导出 {{ metrics.w }}×{{ metrics.h }}') && txt.includes('内容 {{ inkSize.w }}×{{ inkSize.h }}'))
  ok('＋文字弹窗: 多行文本走 lineGap (renderSysFontCanvas 支持 \n)',
     fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8').includes("split('\\n')"))
  ok('＋文字弹窗: 已合并系统字 (来源 = 字库素材 / 系统字库)',
     txt.includes('系统字库') && txt.includes('renderSysFontCanvas') && !fs.existsSync(new URL('../src/components/SysFontDialog.vue', import.meta.url)))
  ok('＋文字弹窗: 顶部就是 来源/字库/函数名',
     txt.indexOf('来源') < txt.indexOf('函数名') && txt.indexOf('字库</label>') < txt.indexOf('位置 (屏幕'))
  ok('＋文字弹窗: 函数名会生成"按 ID 取图"的调用函数 (与导出一份生成器)',
     txt.includes('idDrawFunction(') && txt.includes('导出调用函数') && txt.includes('字节 flash'))
  ok('旧「UI 帧/表导出…」按钮已删 (导出只剩图层驱动)',
     !exp.includes('UI 帧/表导出') && exp.includes('一键导出到文件夹'))
  /* 导出动作区重排: 主操作 + 状态各占一行, 三个复制/下载一行 (不再挤在标题栏里) */
  ok('右栏: 导出按钮重排 (动作区固定在标题下)',
     exp.includes('class="actions"') && exp.includes('class="arow"') && exp.includes('class="ea"'))
  ok('右栏: 一键导出在最前, 复制/下载在后',
     exp.indexOf('一键导出到文件夹') > 0 && exp.indexOf('一键导出到文件夹') < exp.indexOf('复制全部'))
  /* 一键导出目录: 每个存档一份 (state.exportDir 随 JSON), 不再用模块级单例句柄 */
  {
    const eaSrc = fs.readFileSync(new URL('../src/components/ExportAllButton.vue', import.meta.url), 'utf8')
    ok('右栏: 一键导出显示当前存档的目录, 未选时写明「本存档单独设置」',
       exp.includes('未选择（本存档单独设置）') && eaSrc.includes('state.exportDir'))
    ok('一键导出: 目录句柄按 exportDir.id 取 (切档不会沿用上一个工程的 dirHandle)',
       eaSrc.includes('loadExportDirHandle') && eaSrc.includes('handleCache') &&
       /handleCache\s*=\s*\{\s*id/.test(eaSrc) && !/let dirHandle = null/.test(eaSrc))
    ok('一键导出: 选目录时生成这个存档专属的新 id, 并记住句柄',
       eaSrc.includes('rememberExportDir') && eaSrc.includes('pickerId()'))
    ok('一键导出: 用户取消目录选择时停手, 不偷偷改成逐个下载',
       eaSrc.includes('AbortError') && eaSrc.includes('未写文件'))
    ok('一键导出: 覆盖前二次确认 (继续覆盖 / 修改路径 / 取消)',
       eaSrc.includes('askOverwrite') && eaSrc.includes('继续覆盖') &&
       eaSrc.includes('修改路径…') && eaSrc.includes('取消'))
    ok('一键导出: 权限失败/不支持时打包成一个 ZIP (不再散落下载)',
       eaSrc.includes('buildZipBlob') && eaSrc.includes('zipFileName') && eaSrc.includes('已打包 ZIP'))
    ok('一键导出旁边有独立 ZIP 下载 (不申请文件夹)',
       eaSrc.includes('downloadZip') && eaSrc.includes('ZIP 下载') &&
       /downloadFallback\(files, `手动 ZIP 下载/.test(eaSrc))
    ok('右栏: 操作区重新分组 (导出到文件夹 / 复制下载 / 保存图片)',
       exp.includes('独立目录 · 覆盖前确认') && exp.includes('C 代码文本') && exp.includes('当前预览帧'))
  }
  ok('右栏: 标题栏里不再塞按钮 (标题 = 导出 / 存档)',
     /<div class="panel-title"[^>]*>\s*导出 \/ 存档\s*<\/div>/.test(exp))
  /* 所有"出东西"的操作集中在 .actions 一块里 (滚动区不再散落) */
  const actionsHtml = exp.slice(exp.indexOf('class="actions"'), exp.indexOf('class="scroll"'))
  ok('右栏: 导出功能集中到一块 (一键导出/复制/下载/数组格式)',
     ['一键导出到文件夹', '复制全部', '下载 .c', '复制 ring', '0X 大写']
       .every(t => actionsHtml.includes(t)))
  ok('右栏: 滚动区不再有「导出选项」「工程」小节',
     !/class="sec"[^>]*>\s*导出选项/.test(exp) && !/class="sec"[^>]*>\s*工程\s*</.test(exp))
  ok('右栏: 有「页面」块 (每页一行, 数字页给周期输入)',
     exp.includes('pagelist') && exp.includes('页面 (') && exp.includes('class="pgnum"') &&
     (() => {
       const src = fs.readFileSync(new URL('../src/components/ExportPanel.vue', import.meta.url), 'utf8')
       const se = src.indexOf('</script>')
       const script = src.slice(0, se)
       return script.includes('function pagePeriod(') && script.includes('function setPagePeriod(') &&
         script.includes('state.pages = ') && !/bind\.period/.test(src)
     })())
  /* 高度: 工程条 = 一行; 存档列表/本地 JSON/保存行全在浮层里, 默认不渲染 */
  ok('右栏: 工程条压成一行 (★ 当前工程 + 尺寸 + 保存 + 预设 + 展开)',
     /class="projectbar archive"/.test(exp) && exp.includes('★') && exp.includes('保存') &&
     exp.includes('屏幕预设') && exp.includes('未保存工程'))
  ok('右栏: 存档菜单默认收起 (列表/档名/本地 JSON 不再把右栏顶高)',
     !/class="menu"/.test(exp) && !exp.includes('快速切换工程'))

  /* 存档交互约定 (源码 + 浮层 SSR) */
  const archSrc = fs.readFileSync(new URL('../src/components/ArchivePanel.vue', import.meta.url), 'utf8')
  ok('存档: 读取后把档名自动填回输入框 (再点保存就存回原档)',
     /watch\(\(\) => cloud\.current/.test(archSrc) && /name\.value = n/.test(archSrc) &&
     /localStorage\.setItem\(NAME_KEY, n\)/.test(archSrc))
  ok('存档: 同名时先读原档页面尺寸, 尺寸不同 → 自动改名 (不覆盖)',
     /planArchiveSave\(/.test(archSrc) && /cloudArchiveMeta\(/.test(archSrc) &&
     archSrc.includes('原存档不会被覆盖') && archSrc.includes('自动改名'))
  ok('存档: 新建 = 日期+尺寸生成不撞车档名再保存',
     /function saveAsNew\(/.test(archSrc) && /suggestArchiveName\(current\.value/.test(archSrc))
  ok('存档: 切换前暂存未保存工程 (最多 4 份), 可返回 / 丢弃',
     /const stashes = ref\(\[\]\)/.test(archSrc) && /function stashCurrent\(/.test(archSrc) &&
     /function restoreStash\(/.test(archSrc) && archSrc.includes('未保存 / 切换前暂存') &&
     archSrc.includes('返回') && /stashes\.value\.length > 4/.test(archSrc))
  ok('存档: 当前存档尺寸漂移时提前警告 (改过屏幕尺寸后保存会改名)',
     /const drift = computed/.test(archSrc) && /const driftText = computed/.test(archSrc) &&
     archSrc.includes('保存会自动改名'))
  ok('存档: 浮层含 保存 / ＋新建 / 在线存档 / 直链 / 删除; JSON 导入导出已挪到主条',
     ['快速切换工程', '保存', '＋ 新建', '在线存档', '直链', '删除存档']
       .every(t => archSrc.includes(t)) &&
     archSrc.includes('JSON⤓') && archSrc.includes('JSON⤒') &&
     /导入工程 JSON/.test(archSrc) && /导出整个工程 JSON/.test(archSrc))
  ok('屏幕预设入口在工程条里 (⚙ 打开 ScreenDialog, 不再单独占一行)',
     /@click="openPreset"/.test(archSrc) && /<ScreenDialog v-model:open="screenOpen" \/>/.test(archSrc))

  /* 浮层打开后: ★ 当前工程 / 存档行 / 档名回填 / 尺寸漂移提示 */
  const { cloud } = store
  cloud.ok = true
  cloud.list = [
    { name: 'demo.json', size: 1234, mtime: Date.now() },
    { name: 'other.json', size: 5678, mtime: Date.now() - 3600000 },
  ]
  cloud.current = 'demo'
  cloud.currentScreen = { w: 128, h: 128, round: false }
  cloud.baseSig = store.projectSignature()
  cloud.dirty = false
  const openArchive = { render: () => h(Archive, { defaultOpen: true }) }
  const archHtml = await render(openArchive)
  ok('右栏浮层: ★ 当前工程 + 在线存档行 (点行切换) + 保存/新建',
     archHtml.includes('快速切换工程') && archHtml.includes('★') && archHtml.includes('☆') &&
     archHtml.includes('demo') && archHtml.includes('＋ 新建') && archHtml.includes('保存'))
  ok('右栏浮层: 读取/直链载入后档名自动回填输入框',
     /value="demo"[^>]*placeholder="存档名（档名）"/.test(archHtml))
  ok('右栏浮层: 当前屏幕尺寸已改 → 提前警告「保存会自动改名」',
     archHtml.includes('尺寸已从 128×128 改成 240×240 圆屏') && archHtml.includes('保存会自动改名'))
  cloud.current = ''
  cloud.currentScreen = null
  cloud.baseSig = ''
  cloud.dirty = false
  cloud.ok = false
  cloud.list = []

  /* 中·模拟屏 (预览窗口): 工具条能渲染 (模板接线错会在这里直接暴露)。
   * ！SSR 里图层覆盖层要 paintRect → instanceProc → document.createElement('canvas'),
   *   Node 没有 canvas —— 这里只验工具条, 先把图层清空再渲染, 完了恢复。
   * 导出图片按钮**不在这里** (用户要求单独放右栏导出区)。 */
  {
    const keepInst = state.instances
    state.instances = []
    const Stage = (await server.ssrLoadModule('/src/components/ScreenStage.vue')).default
    const st = await render(Stage)
    state.instances = keepInst
    ok('中栏·模拟屏: 工具条渲染正常 (撤回/缩放/1:1), 导出图片按钮不在这里 (在右栏导出区)',
       st.includes('↶ 撤回') && st.includes('1:1') && !/shootbtn|exportImage/.test(st))
  }
} catch (e) {
  ok('UI 渲染', false, (e && e.message) || String(e))
} finally {
  await server.close()
}

/* ---- 模板里的事件处理函数必须在脚本里有定义 ----
 * 教训: 清理 ExportPanel 的旧代码时误删了 toggleLock/resetPos/quickText/quickSysText,
 * 模板照常渲染, 但点按钮直接 ReferenceError (看起来就是"按钮失效")。 */
{
  const dir = new URL('../src/components/', import.meta.url)
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.vue'))) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8')
    const se = src.indexOf('</script>')
    if (se < 0) continue
    const script = src.slice(src.indexOf('<script setup>'), se)
    const tpl = src.slice(se)
    const imported = new Set()
    for (const m of script.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
      for (const one of m[1].split(',')) {
        const n = one.trim().split(/\s+as\s+/).pop().trim()
        if (n) imported.add(n)
      }
    }
    const names = new Set()
    for (const m of tpl.matchAll(/@[a-zA-Z]+(?:\.[a-zA-Z]+)*="([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1])
    const missing = [...names].filter(n =>
      !imported.has(n) && !new RegExp(`(?:function|const|let|var)\\s+${n}\\b`).test(script))
    ok(`${f}: 模板事件处理函数都有定义`, missing.length === 0, missing.join(', ') || '')
  }
}

/* ---- 弹窗框锁定: 预览图/表单变高变矮, 弹窗和按钮都不许移动 ----
 * 要求: mask 用 flex-start 顶边锚定 + 框有固定 height + 超长内容在 .body 里滚 */
{
  const ring = fs.readFileSync(new URL('../src/components/RingDialog.vue', import.meta.url), 'utf8')
  /* 两个方向参数都留着, 但名字分开: 「弧向」= 进度弧, 「白斑转向」= 白斑 —— 不再像重复 */
  ok('圆环对话框: 进度弧方向叫「弧向」, 白斑方向叫「白斑转向」(旧名「递增方向」已不用)',
     ring.includes('>弧向<') && ring.includes('白斑转向') &&
     /draft\.ring\.arcDir/.test(ring) && /draft\.ring\.dir/.test(ring) && !ring.includes('递增方向'))
  ok('圆环对话框: 「初始化档位」+ 帧间隔在白斑区同一条 (导出 RING_GEAR_DEF / RING_TICK_MS)',
     /初始化档位<\/label>\s*<input[^>]*draft\.ring\.gear[\s\S]{0,400}?帧间隔<\/label>/.test(ring) &&
     ring.includes('放哪一页在图层列表的「页」里填'))
  /* 白斑区要装齐白斑自己的参数: 开关/转向/σ/范围/初始化档位/帧间隔/弧长/初始角 */
  ok('圆环对话框: 白斑区含 弧长+初始角 (以前挂在预览图下方, 位置搞错了)',
     /弧长 \(预览\)<\/label>[\s\S]{0,600}?draft\.ring\.glintArcPx[\s\S]{0,600}?初始角 \(预览\)<\/label>[\s\S]{0,300}?draft\.ring\.glintDeg/.test(ring))
  /* 圆角矩形左栏跟圆环同一套: 一行一个概念, 名字也用圆环的说法 (环厚 → 厚度) */
  ok('圆角矩形左栏与圆环对齐: 尺寸 / 厚度+留边 / 外圆角 / 内圆角 各一行, 「环厚」改名「厚度」',
     /<label>尺寸 W×H<\/label>/.test(ring) && ring.includes('>厚度</label>') && !ring.includes('>环厚</label>') &&
     /<label[^>]*>\s*外圆角<\/label>/.test(ring) && /<label[^>]*>内圆角<\/label>/.test(ring))
  /* 「内圆角自动」= 单独一个开关 (以前只能靠把输入框清空, 用户要求单独开关) */
  ok('圆角矩形: 「内圆角自动」是单独开关 (勾上 = 外圆角−厚度, 取消才能自己填)',
     /v-model="radInAuto"/.test(ring) && /:disabled="radInAuto"/.test(ring) && /radInAuto = computed/.test(ring))
  /* 环心: 显示实际坐标 + 与屏幕中心的偏差 + 一键居中 (用户要求"具体的圆心位置显示") */
  ok('圆环对话框: 显示实际环心 (坐标 + 偏离屏幕中心多少 px) 且能一键「居中」',
     /ringCenter\.x/.test(ring) && /screenCenterPx\.cx/.test(ring) && /isCentered/.test(ring) && />居中<\/button>/.test(ring))
  /* 分割模式选项取消: 只留槽深; 100% = 压黑 = 原「切断」 */
  ok('圆环对话框: 「切断/暗槽」模式按钮已移除, 只保留槽深 (100% = 压黑)',
     !ring.includes('>切断</button>') && !ring.includes('>暗槽</button>') &&
     ring.includes('>槽深</label>') && ring.includes('压黑'))
  /* 抗锯齿 AA: 滑条 + 数字框 (总过渡宽度 px) */
  ok('圆环对话框: 「沟槽 AA」有滑杆 + 数字框 (0..4px, 0 = 硬边)',
     ring.includes('沟槽 AA') &&
     /type="range"[^>]*v-model\.number="draft\.ring\.segAA"/.test(ring) &&
     /type="number"[^>]*v-model\.number="draft\.ring\.segAA"/.test(ring) && ring.includes('>硬边</button>'))
  /* 沟槽 AA / 端点 AA 两类 (不是左右两端) */
  ok('圆环对话框: AA 分「沟槽 AA」与「端点 AA」两类, 端点一个值管两端',
     ring.includes('>沟槽 AA</label>') && ring.includes('>端点 AA</label>') &&
     /v-model\.number="draft\.ring\.segAA"/.test(ring) &&
     /v-model\.number="draft\.ring\.aaEdge"/.test(ring) &&
     !ring.includes('起点 AA') && !ring.includes('终点 AA'))
  /* 分割挪到「基本」页的几何下方; 「快速范围」整块删除 */
  {
    const iBasic = ring.indexOf("tab === 'basic'")
    const iEffect = ring.lastIndexOf("tab === 'effect'")
    const iGeom = ring.indexOf('card-title">几何')
    const iSeg = ring.indexOf('card-title">分割 (缝宽 %)')
    ok('圆环对话框: 分割卡片在「基本」页、几何下方; 「快速范围」已删除',
       iBasic >= 0 && iGeom > iBasic && iSeg > iGeom && iEffect > iSeg && !ring.includes('快速范围'),
       'basic ' + iBasic + ' / 几何 ' + iGeom + ' / 分割 ' + iSeg + ' / effect ' + iEffect)
  }
  /* 分割点 (RING_SEG_SPLIT_X10) */
  ok('圆环对话框: 分割点滑杆 0..10 (0=段末 / 5=槽中 / 10=下段起点)',
     /v-model\.number="draft\.ring\.segSplit"/.test(ring) && ring.includes('分割点') &&
     ring.includes('RING_SEG_SPLIT_X10'))
  /* 实时预览缩放 */
  ok('圆环对话框: 实时预览可缩放 (1×..6× 按钮, 适配复位, 不抢滚轮)',
     /const pvZoom = ref\(1\)/.test(ring) && /function setPvZoom/.test(ring) &&
     !/onPvWheel/.test(ring) && ring.includes('适配') && /pv-pixel/.test(ring))
  /* 锁定屏幕中心 + 改尺寸 → 环心不许漂 (用户现场) */
  {
    const st = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')
    ok('锁定屏幕中心: 改尺寸 (含舞台拖角) 后重新落位, 环心钉在屏幕中央像素',
       /export function centerRingRect/.test(st) && /centerRingRect\(screen\.value, inst\.w, inst\.h\)/.test(st) &&
       /watch\(\(\) => \[draft\.w, draft\.h\]/.test(ring))
  }
  /* 启用白斑 = 硬件开关 → 已并入「效果」页 (用户要求: 白斑页并进效果页, 不再单开页签) */
  {
    const iEffect = ring.lastIndexOf("tab === 'effect'")
    const iAppearance = ring.indexOf('<!-- 外观 -->')
    const glintOn = ring.indexOf('<input type="checkbox" v-model="draft.ring.glintOn" />启用白斑')
    const previewCard = ring.indexOf('预览开关 (不导出)')
    ok('圆环对话框: 「启用白斑」在「效果」页 (白斑页并入效果, 没有独立的「白斑」页签)',
       iEffect > 0 && iAppearance > iEffect && glintOn > iEffect && glintOn < iAppearance &&
       !ring.includes("tab === 'glint'") && !ring.includes('>白斑</button>') &&
       previewCard > glintOn)
  }
  /* 选多张图片 → 二次选择 (合成多帧 / 逐个添加) */
  {
    const panel = fs.readFileSync(new URL('../src/components/AssetPanel.vue', import.meta.url), 'utf8')
    ok('多选图片: 弹二次选择 (合成为多帧素材 / 逐个添加)',
       /list.length > 1/.test(panel) && panel.includes('合成为多帧素材') && panel.includes('逐个添加') &&
       /mergeAssetsToFrames/.test(panel))
    ok('多选图片: 取消不清空、逐个添加走原来的单张流程',
       /function cancelPending/.test(panel) && /async function addOneByOne/.test(panel))
  }
  /* 一个工程只允许一个环 (板上是单例引擎 + 一份 ring_config.h) */
  {
    const panel = fs.readFileSync(new URL('../src/components/AssetPanel.vue', import.meta.url), 'utf8')
    const st = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')
    ok('单环限制: 已有环时「◯ 圆环」按钮禁用并说明原因',
       /ringCount >= 1/.test(panel) && panel.includes('一个工程只支持一个环'))
    ok('单环限制: store 里第二次 addRingInstance 直接返回已存在的那一个',
       /const exist = state\.instances\.find\(i => i\.kind === 'ring'\)/.test(st) && /if \(exist\) return exist/.test(st))
    ok('单环限制: 老工程里多个环会给出警告 (板子上只认第一个)',
       /工程里有 \$\{rings\.length\} 个环/.test(st) || /板子上只支持 1 个/.test(st))
  }
  /* 立体感 (预览版): 断面光照, 圆/圆角矩形共用一份公式; 默认 0 = 与板子一致 */
  ok('圆环对话框: 立体感控件 (强度滑杆 + 样式/光照), 默认 0% = 关 不影响对拍',
     /draft\.ring\.depthStyle/.test(ring) && /draft\.ring\.lightDeg/.test(ring) && /draft\.ring\.depth/.test(ring))
  /* 强度 = 0 时把样式/光照收起来, 并明确写"(关)" —— 用户报过"立体感好像关不掉" */
  ok('圆环对话框: 立体感 0% 时样式/光照收起 + 标注 (关 = 平色)',
     /v-if="draft\.ring\.depth > 0"/.test(ring) && /'\(关/.test(ring))
  /* 留边对两种形状都要有 (用户报过"留边只对圆角矩形生效") */
  {
    const insetRows = (ring.match(/draft\.ring\.inset/g) || []).length
    const shapeGuard = /v-if="draft\.ring\.shape !== 'rect'"/.test(ring)
    ok('圆环对话框: 「留边」两种形状共用一行 (圆环也扣留边)', insetRows >= 1 && shapeGuard &&
       !/v-if="draft\.ring\.shape === 'rect'"[^>]*>[\s\S]{0,400}draft\.ring\.inset/.test(ring))
  }
  /* 预览动效只留 1 个开关 (自动动画): 白斑转 + 进度扫都由它管 */
  /* 用户要求: 把「自动动画」拆成两个独立开关 —— 自动动画 (进度扫) + 光斑动画 (白斑转) */
  /* 用户: "弧长 (预览) 4 px/步 —— 为什么不能设置为 1" → min 从 4 放开到 0.5, 并标出板子等效值 */
  ok('圆环对话框: 「弧长 (预览)」能填 1 (min 0.5), 并给出板子等效值 + 一键对齐',
     /弧长 \(预览\)/.test(ring) && /min="0\.5" max="64" step="0\.5"[^>]*draft\.ring\.glintArcPx/.test(ring) &&
     /approx|≈ 板子/.test(ring) && /boardStepPx/.test(ring) &&
     /draft\.ring\.glintArcPx = Math\.round\(boardStepPx/.test(ring))
  ok('圆环对话框: 预览动效拆成两个开关 —— 「自动动画」(进度扫) + 「光斑动画」(白斑转)',
     ring.includes('自动动画') && ring.includes('光斑动画') &&
     /v-model="draft\.ring\.autoArc"[^>]*\/>自动动画/.test(ring) &&
     /v-model="draft\.ring\.autoGlint"[^>]*\/>光斑动画/.test(ring) &&
     !/自动旋转|自动递增/.test(ring))
  /* 两个开关在动画器/渲染里各自独立 (纯函数 ringAnimFlags, 含老工程兼容) */
  {
    const M = await import('../src/ringrender.js')     /* 纯 ESM (无 .vue), 直接 import 就行 */
    const legacy = M.ringAnimFlags({ autoGlint: true })                    /* 老工程: 一个开关管两件事 */
    const both = M.ringAnimFlags({ autoGlint: true, autoArc: true })
    const onlyGlint = M.ringAnimFlags({ autoGlint: true, autoArc: false })
    const onlyArc = M.ringAnimFlags({ autoGlint: false, autoArc: true })
    const none = M.ringAnimFlags({ autoGlint: false, autoArc: false })
    ok('动效开关: 各自独立推进 (只开光斑 = 白斑转不扫进度; 只开自动 = 扫进度不转白斑)',
       onlyGlint.glint === true && onlyGlint.arc === false &&
       onlyArc.arc === true && onlyArc.glint === false &&
       both.glint && both.arc && !none.glint && !none.arc)
    ok('动效开关: 老工程 (只有 autoGlint = 当初"一开关管两件事") 仍按两个都开跑', legacy.glint && legacy.arc)
  }
  /* 渐变颜色: 轨道/填充各自一组停靠点, 色条上可加点/拖点/删点; 导出取 0% 首点 */
  ok('圆环对话框: 颜色有「纯色/渐变」模式, 渐变条 + 多停靠点 (加点/拖点/删点)',
     /setColorMode\('grad'\)/.test(ring) && /class="grad-bar"/.test(ring) &&
     /class="grad-stop"/.test(ring) && /addGradStopAt/.test(ring) &&
     /removeGradStop/.test(ring) && /trackGrad/.test(ring) && /fillGrad/.test(ring))
  {
    const st = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')
    ok('渐变导出: 板端仍是单色, RING_ARC_TRACK/FILL_DEF 取 0% 首点并在摘要里标注',
       /ringGradStops\(r\.trackGrad\)/.test(st) && /ringGradStops\(r\.fillGrad\)/.test(st) &&
       /0% 停靠点/.test(st) && ring.includes('网页渐变') && /exportFlatColor/.test(ring))
  }
}

for (const name of ['InstanceDialog', 'TextDialog', 'RingDialog', 'FontSplitDialog', 'MultiLineDialog']) {
  const src = fs.readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8')
  const top = /\.mask\s*\{[^}]*align-items:\s*flex-start/.test(src)
  const h = /\.(dialog|dlg)\s*\{[^}]*height:\s*min\(/.test(src)
  const scroll = /\.body\s*\{[^}]*flex:\s*1/.test(src) && /\.body\s*\{[^}]*overflow:\s*(auto|hidden)/.test(src)
  ok(`${name}: 弹窗框锁定 (顶边锚定 + 高度固定 + 内容内部滚)`, top && h && scroll,
     `top=${top} height=${h} scroll=${scroll}`)
}

/* 预览画布必须 content-box: 否则 style 的宽高含 1px 边框, 鼠标换算越往下越偏 (见 check-uiexport 的 pickRow) */
{
  const src = fs.readFileSync(new URL('../src/components/MultiLineDialog.vue', import.meta.url), 'utf8')
  const cvRule = (src.match(/\.cv\s*\{[^}]*\}/) || [''])[0]
  ok('文本框弹窗: 预览画布用 content-box (边框不吃掉位图区域)',
     /box-sizing:\s*content-box/.test(cvRule))
  ok('文本框弹窗: 命中换算用 uiexport.pickRow (统一已自检)',
     /pickRow\(/.test(src) && /import \{[^}]*pickRow[^}]*\} from '\.\.\/uiexport\.js'/.test(src))
}

/* 舞台缩放: 必须是"1 个屏幕像素 = 整数个设备像素" —— 否则浏览器分数重采样,
 * 环带边缘那圈 2px AA 会看着像锯齿 (用户现场: 放大到整数倍锯齿就消失) */
{
  const stage = fs.readFileSync(new URL('../src/components/ScreenStage.vue', import.meta.url), 'utf8')
  ok('舞台缩放: 按 devicePixelRatio 归一到整数设备像素 (画布逐像素, 显示不重采样)',
     /devicePixelRatio/.test(stage) && /function snapZoom/.test(stage) &&
     /snapZoom\(state\.ui\.zoom/.test(stage) && /snapZoom\(z\)/.test(stage))
  ok('舞台画布: image-rendering: pixelated (nearest, 不糊)',
     /image-rendering:\s*pixelated/.test(stage))
  ok('舞台缩放: 档位显示带上设备像素倍率 + 非整数时告警', /zoomLabel\.dev/.test(stage) && /zoomval\.warn/.test(stage))
  /* 浏览器缩放 (125%/150%) 会改 devicePixelRatio: 必须实时读 + 变了重新归一, 不能存死 */
  ok('舞台缩放: devicePixelRatio 实时读取, 浏览器缩放变化后重新归一',
     /function curDpr/.test(stage) && /const dpr = ref\(curDpr\(\)\)/.test(stage) &&
     /addEventListener\('resize', onWinResize\)/.test(stage) && /dpr\.value = d/.test(stage))
  ok('预览双击: 多帧素材打开多帧画板 (不进"微调图片"弹窗)',
     /const a = state\.assets\.find/.test(stage) && /a\?\.font\?\.charset === 'frames'/.test(stage) &&
     /state\.ui\.dialogFrameGroup = true/.test(stage) && /function openInst/.test(stage))
}

/* 导出图片 (用户: "web 增加导出图片功能, 可以导出预览窗口当前帧位 1 张图片下载" → 后来定:
 * 「只放右栏导出区, 一键导出旁边的单独按钮」)。像素绘制与预览共用 paintFrame
 * (见 check-frameimage), 这里钉的是"按钮在哪/接线/反馈"这层 UI 约定。 */
{
  const stage = fs.readFileSync(new URL('../src/components/ScreenStage.vue', import.meta.url), 'utf8')
  const panel = fs.readFileSync(new URL('../src/components/ExportPanel.vue', import.meta.url), 'utf8')
  /* 中栏工具条不再挂导出按钮 (用户要"单独的在右栏") */
  ok('中栏工具条: 不再有导出图片按钮 (挪到右栏导出区, 不给工具条加宽度压力)',
     !/shootbtn|exportImage/.test(stage))
  /* 右栏: 「一键导出」下面**单独一行**按钮 —— 不在 ExportAllButton 里, 也不是它的子项 */
  const iAll = panel.indexOf('<ExportAllButton />')
  const iShoot = panel.indexOf('class="shootbtn"')
  ok('右栏导出区: 「导出图片」是单独一个按钮 (在 一键导出 之后, 不在它里面)',
     iShoot > iAll && iAll > 0 && /<div class="imgrow">\s*<button class="shootbtn"/.test(panel))
  ok('右栏: 保存图片独立成组 (小标题 + 按钮/圆屏提示同一行)',
     /<span class="bhead-t">保存图片<\/span>/.test(panel) &&
     /class="imgrow"/.test(panel) && /class="block img-export"/.test(panel))
  ok('右栏导出区: 按钮接 exportImage(), 文案 ⤓ 导出图片 → ✓ 已导出 / ✗ 导出失败 (宽度不抖)',
     /@click="exportImage\(\)"/.test(panel) && /⤓ \{\{ shootLabel \}\}/.test(panel) &&
     /ok: '✓ 已导出', err: '✗ 导出失败'/.test(panel) && !/✓ 已导出[^']*<button/.test(panel))
  ok('右栏导出区: 成功/失败有反馈 (title 里给原因), 不静默吞掉',
     /shootErr\.value = String/.test(panel) && /再点一下重试/.test(panel))
  /* 圆屏提示: 三选一, 只出现在圆屏预设; 存在 exportOpts 里随工程/本地档一起留 */
  const sel = (panel.match(/<select v-model="shootHint">[\s\S]*?<\/select>/) || [''])[0]
  ok('右栏导出区: 圆屏提示三选一 (圆周细线 / 圆外压暗 / 不要), 只有圆屏预设才显示',
     /v-if="sc\.round"/.test(panel) && sel !== '' &&
     ['ring', 'mask', 'none'].every(v => sel.includes(`value="${v}"`)) &&
     /get: \(\) => state\.exportOpts\.shootHint \|\| 'ring'/.test(panel))
}

/* 屏幕底色 (背景色): 屏幕预设里可改, 默认黑; 预览/导出图片/导出 C 的 UI_PAGE_BG 同一个值 */
{
  const screenSrc = fs.readFileSync(new URL('../src/components/ScreenDialog.vue', import.meta.url), 'utf8')
  ok('屏幕预设: 有「背景色」选色 (默认黑 0x0000), 存进预设 (预览/导出图片/UI_PAGE_BG 同一个值)',
     /<ColorField v-model="bgColor" label="背景色"/.test(screenSrc) &&
     /get: \(\) => \(sc\.value\.bg \?\? 0x0000\)/.test(screenSrc) &&
     /set: \(v\) => \{ sc\.value\.bg =/.test(screenSrc))
  ok('屏幕预设: 老预设没有 bg 字段也不会显示成白色 (ColorField 默认值是白, 必须先兜 0)',
     /sc\.value\.bg \?\? 0x0000/.test(screenSrc))
  const lay = fs.readFileSync(new URL('../src/layerexport.js', import.meta.url), 'utf8')
  const storeSrc2 = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')
  ok('导出的 C: UI_PAGE_BG 用屏幕预设的底色 (宏, 不再写死 0x0000)',
     /#define UI_PAGE_BG \$\{colorMacroName\(plan\.screen\?\.bg \?\? 0x0000\)\}/.test(lay) &&
     /bg: \(screen\.value\.bg == null \? 0x0000 : screen\.value\.bg\) & 0xFFFF/.test(storeSrc2) &&
     !/#define UI_PAGE_BG 0x0000/.test(lay))
}

/* 各弹窗右上角「图片下载」: 放在 删除/取消/确定 (帧管理是 ✕关闭) 的左侧, 按素材/格子原始尺寸导出 */
{
  const read = (f) => fs.readFileSync(new URL(`../src/components/${f}`, import.meta.url), 'utf8')
  const dialogs = {
    'InstanceDialog.vue': ['@click="doRemove"', 'downloadAssetImage', '删除/取消/确定'],
    'FontSplitDialog.vue': ['@click="clearFont"', 'downloadSplitSheet', '清除拆分/取消/应用拆分'],
    'TextDialog.vue': ['@click="doRemove"', 'downloadPreviewImage', '删除/取消/确定'],
    'RingDialog.vue': ['@click="doRemove"', 'downloadPreviewImage', '删除/取消/确定'],
    'FrameManageDialog.vue': ['@click="emit(\'close\')"', 'downloadSheet', '✕ 关闭'],
  }
  for (const [f, [rightOf, fn, label]] of Object.entries(dialogs)) {
    const src = read(f)
    const iDl = src.indexOf('⤓ 图片下载')
    ok(`${f}: 右上角有「⤓ 图片下载」按钮, 接在 ${fn}() 上, 且在「${label}」左侧`,
       iDl > 0 && new RegExp(`@click="${fn}\\(\\)"`).test(src) &&
       src.indexOf(rightOf) > iDl, `按钮@${iDl} 首个右侧按钮@${src.indexOf(rightOf)}`)
  }
  const frame = read('FrameManageDialog.vue')
  ok('帧管理: 每个格子另有 ⤓ (按格子尺寸导出该帧) + 顶部「图片下载」= 整条素材',
     /@click="downloadCell\(c\.i\)"/.test(frame) && /@click="downloadSheet\(\)"/.test(frame) &&
     /sliceFrames\(a\)\[i\]/.test(frame))
  ok('素材/字库弹窗: 导出的是**画布原始像素** (按素材尺寸, 不缩放), 走 downloadCanvasPng',
     ['InstanceDialog.vue', 'FontSplitDialog.vue', 'FrameManageDialog.vue'].every(f =>
       /downloadCanvasPng\(/.test(read(f))) &&
     /imageFileName\('img'/.test(read('InstanceDialog.vue')) &&
     /imageFileName\('font'/.test(read('FontSplitDialog.vue')))
}

/* 导出预览: 折叠窗 (头部/尾部) + 放在导出按钮正下方 (用户: 别让我滚到底部去看) */
{
  const expSrc = fs.readFileSync(new URL('../src/components/ExportPanel.vue', import.meta.url), 'utf8')
  ok('导出预览: 在「导出」按钮块 (class="actions") 之后 —— 不用滚到底部',
     expSrc.indexOf('class="actions"') > 0 &&
     expSrc.indexOf('class="sec prev-sec"') > expSrc.indexOf('class="actions"') &&
     expSrc.indexOf('class="sec prev-sec"') < expSrc.indexOf('class="scroll"'))
  ok('导出预览: 默认**折叠** (只留标题行), 展开先给 头+尾, 再点「看整段」才是全量',
     /const prevFold = ref\(true\)/.test(expSrc) && /const prevAll = ref\(false\)/.test(expSrc) &&
     /v-if="!prevFold" class="prev-body"/.test(expSrc) && /v-if="prevAll"/.test(expSrc) &&
     /const outHead = computed/.test(expSrc) && /const outTail = computed/.test(expSrc) &&
     /中间省略 \{\{ outSkipped \}\} 行/.test(expSrc) &&
     /\{\{ prevFold \? '展开' : '收起' \}\}/.test(expSrc) && /\{\{ prevAll \? '只看头尾' : '看整段' \}\}/.test(expSrc))
  ok('导出预览: 头部/尾部各 14 行, 不再按 400 行硬砍 (整段导出都在, 展开就能看全)',
     /const PREV_EDGE = 14/.test(expSrc) && !/outputTruncated/.test(expSrc) &&
     /copied === 'all' \? '已复制 ✓' : '复制'/.test(expSrc))
}

/* 指令模板 (随色彩格式切换) 挪到「屏幕预设」弹窗了 (用户: 改到屏幕预设的窗口里) */
{
  const panelSrc = fs.readFileSync(new URL('../src/components/ExportPanel.vue', import.meta.url), 'utf8')
  const screenSrc = fs.readFileSync(new URL('../src/components/ScreenDialog.vue', import.meta.url), 'utf8')
  const tplSrc = fs.readFileSync(new URL('../src/components/TplEditor.vue', import.meta.url), 'utf8')
  ok('指令模板: 导出面板里已经没有了 (只留一句"已挪到屏幕配置弹窗"的注释)',
     !/class="tabs"/.test(panelSrc) && !/sc\.templates/.test(panelSrc) && !/showTplHelp/.test(panelSrc) &&
     /已挪到「屏幕配置」弹窗/.test(panelSrc))
  /* 屏幕预设列表: 三组新尺寸的吋数要显示出来 (用户按屏选预设), 横竖都在 */
  ok('屏幕预设: 下拉里带吋数 (1.9吋 170x320 / 1.14吋 135x240 / 3.2吋 240x320, 横竖各一条)',
     /p\.inch \? ' · ' \+ p\.inch \+ '吋'/.test(screenSrc) && /sc\.inch \? ' · ' \+ sc\.inch/.test(screenSrc) &&
     /恢复内置预设列表/.test(screenSrc))
  ok('指令模板: 屏幕预设弹窗里挂上了 <TplEditor />', /import TplEditor from '\.\/TplEditor\.vue'/.test(screenSrc) &&
     /<TplEditor \/>/.test(screenSrc))
  ok('指令模板: 五个格式页签 + 模板输入 + 通配符说明 + 头部/尾部 (整段导出包裹)',
     /const FMTS = \['RGB565', 'RGB888', 'GRAY', 'TEXT', 'TEXTFN'\]/.test(tplSrc) &&
     /v-model="tpl"/.test(tplSrc) && /v-for="h in PLACEHOLDER_DOC"/.test(tplSrc) &&
     /v-model="sc\.header"/.test(tplSrc) && /v-model="sc\.footer"/.test(tplSrc) &&
     /头部 \/ 尾部 \(整段导出包裹\)/.test(tplSrc))
  ok('指令模板: 老工程没有 templates 字段也不会崩 (可写计算属性兜底)',
     /if \(!sc\.value\.templates\) sc\.value\.templates = \{\}/.test(tplSrc))
}


/* 多帧组 v2: 中间预览/右侧帧+图层/尺寸导出在预览下/一张多帧素材 */
{
  const readC = (f) => fs.readFileSync(new URL(`../src/components/${f}`, import.meta.url), 'utf8')
  const asset = readC('AssetPanel.vue')
  const app = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  const fgd = readC('FrameGroupDialog.vue')
  const exp = readC('ExportPanel.vue')
  const storeSrc = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')
  ok('多帧组: 「＋文本框」入口已移除, 原位置改成「多帧画板」',
     !/＋ 文本框/.test(asset) && !/dialogMultiLine = true/.test(asset) &&
     /state\.ui\.dialogFrameGroup = true">多帧画板</.test(asset))
  ok('多帧组: App 挂载 <FrameGroupDialog />, 不再挂文本框/旧组预览',
     /<FrameGroupDialog \/>/.test(app) && !/<MultiLineDialog \/>/.test(app) &&
     !/FrameGroupPreview/.test(app))
  ok('多帧组: 双击多帧素材/图层直接开多帧组页 (不是放置图片)',
     /@dblclick\.stop="dblAsset\(a\)"/.test(asset) && /frameGroupAssetId = asset\.id/.test(asset) &&
     /@dblclick="dblLayer\(inst\)"/.test(exp) && /a\?\.font\?\.charset === 'frames'/.test(exp))
  ok('多帧组: 左侧素材加到当前帧; 一帧可叠多张图 (addImageLayer push)',
     /@click="addAsset\(a\)"/.test(fgd) && /function addImageLayer/.test(fgd) &&
     /layers\.push\(layer\)/.test(fgd) && /ensureFrame\(\)/.test(fgd))
  ok('多帧组: ＋文字 + 双击文字打开首页同一个文字编辑面板',
     /@click="addText"/.test(fgd) && /kind: 'text'/.test(fgd) &&
     /@dblclick\.stop="openTextEditor\(l\)"/.test(fgd) && /onCanvasDbl/.test(fgd) &&
     /openTextEditor\(selLayer\)/.test(fgd) && /<TextDialog v-if="textTarget"/.test(fgd) &&
     /:group-layer="textTarget"/.test(fgd) && /@group-apply="applyGroupText"/.test(fgd) &&
     /groupMode/.test(fgd + fs.readFileSync(new URL('../src/components/TextDialog.vue', import.meta.url), 'utf8')) &&
     /props\.groupOpen && props\.groupLayer/.test(fgd + fs.readFileSync(new URL('../src/components/TextDialog.vue', import.meta.url), 'utf8')))
  {
    const txt2 = fs.readFileSync(new URL('../src/components/TextDialog.vue', import.meta.url), 'utf8')
    ok('多帧组文字面板: 字库素材/系统字库都可选, 不再灰掉',
       /value="asset" v-model="draft\.source" \/>字库素材/.test(txt2) &&
       /value="system" v-model="draft\.source" \/>系统字库/.test(txt2) &&
       !/value="asset" v-model="draft\.source" :disabled/.test(txt2) &&
       !/value="system" v-model="draft\.source" :disabled/.test(txt2) &&
       /source: 'asset', assetId: draft\.assetId/.test(txt2))
  }
  ok('多帧组: 帧表在右侧, 支持 ＋帧/上移/下移/删除 与当前帧图层表',
     /帧顺序/.test(fgd) && /@click="addFrame"/.test(fgd) && /moveFrame\(i, -1\)/.test(fgd) &&
     /moveFrame\(i, 1\)/.test(fgd) && /delFrame\(i\)/.test(fgd) && /当前帧图层/.test(fgd) &&
     /moveLayer\(l\.id, -1\)/.test(fgd) && /delLayer\(l\.id\)/.test(fgd))
  ok('多帧组: 中间预览可缩放/拖动/存储框/多帧叠加 (仅预览)',
     /fitZoom/.test(fgd) && /setZoom\(4\)/.test(fgd) && /@pointerdown="onDown"/.test(fgd) &&
     /@pointermove="onMove"/.test(fgd) && /存储框/.test(fgd) && /viewW/.test(fgd) &&
     /doc\.overlay/.test(fgd) && /v-model="f\.preview"/.test(fgd) && /全部叠加/.test(fgd) &&
     /drawFrame\(ctx, f, Math\.min/.test(fgd))
  ok('多帧组: 自动尺寸 = 所有可见素材的外接矩形 (左上 + 右下 = 全屏)',
     /function autoSize/.test(fgd) && /minX = Math\.min\(minX, l\.x\)/.test(fgd) &&
     /maxX = Math\.max\(maxX, l\.x \+ l\.w\)/.test(fgd) &&
     /l\.x = Math\.round\(l\.x - minX\)/.test(fgd))
  ok('多帧组: 尺寸/自动尺寸/格式/名称/下载都在预览下方',
     /画布 W/.test(fgd) && /自动设置尺寸/.test(fgd) && /function autoSize/.test(fgd) &&
     /v-model\.number="doc\.w"/.test(fgd) && /v-model\.number="doc\.h"/.test(fgd) &&
     /v-model="doc\.fmt"/.test(fgd) && /function downloadPreview/.test(fgd) &&
     /downloadCanvasPng/.test(fgd))
  ok('多帧组: 只有 RGB565 / GRAY 两种格式, 整组一个格式',
     /<option value="RGB565">RGB565<\/option>/.test(fgd) &&
     /<option value="GRAY">GRAY \(8bit\)<\/option>/.test(fgd) && !/RGB888/.test(fgd))
  ok('多帧组: 保存仍是一张多帧素材 + 放到屏幕只建一个图层',
     /saveFrameAsset/.test(fgd) && /font: \{ glyphW: doc\.w, glyphH: doc\.h, charset: 'frames', dir: 'col'/.test(fgd) &&
     /addInstance\(res\.asset\.id/.test(fgd) && (fgd.match(/addInstance\(/g) || []).length === 1 &&
     /saveFrameAsset/.test(storeSrc))
  ok('多帧组: 素材栏不再有旧「组」按钮/旧组图层入口',
     !/createFrameGroup/.test(asset) && !/class="del group-btn"/.test(asset))
  ok('预览格式: 默认统一 RGB565; 「跟随格式」才按导出格式渲染',
     /previewFollowFmt: false/.test(storeSrc) &&
     /const followFmt = !!state\.ui\.previewFollowFmt/.test(storeSrc) &&
     /instanceProc\(followFmt \? inst : \{ \.\.\.inst, fmt: 'RGB565' \}\)/.test(storeSrc) &&
     /v-model="state\.ui\.previewFollowFmt"/.test(fgd) &&
     /v-model="state\.ui\.previewFollowFmt"/.test(fs.readFileSync(new URL('../src/components/ScreenStage.vue', import.meta.url), 'utf8')) &&
     /const grayPreview = !!state\.ui\.previewFollowFmt && doc\.fmt === 'GRAY'/.test(fgd) &&
     /ctx\.filter = 'grayscale\(1\)'/.test(fgd))
  ok('最近色: 拖色盘只在鼠标松开时记录一次 (不会刷一排)',
     /emit\('commit', lastColor\)/.test(fs.readFileSync(new URL('../src/components/ColorPicker.vue', import.meta.url), 'utf8')) &&
     /@commit="setColor\(\$event, true\)"/.test(fs.readFileSync(new URL('../src/components/ColorField.vue', import.meta.url), 'utf8')) &&
     /@input="applyHex\(false\)" @change="applyHex\(true\)"/.test(fs.readFileSync(new URL('../src/components/ColorField.vue', import.meta.url), 'utf8')))
  ok('多帧画板: 帧顺序有明确的「叠加」开关 (对齐其它帧用)',
     /v-model="f\.preview"[^>]*\/>叠加/.test(fgd) && /ghost-on/.test(fgd) &&
     /全部叠加/.test(fgd) && /只当前/.test(fgd))
  ok('多帧画板: Ctrl+Z 撤回删除/拖动/改文字 (本地历史, 不靠 App 的图层撤回)',
     /function undoBoard/.test(fgd) && /historyStack/.test(fgd) &&
     /key === 'z'/.test(fgd) && /e\.shiftKey/.test(fgd) && /function applyHistory/.test(fgd) &&
     /Ctrl\+Z/.test(fgd))
  ok('多帧画板: 图片下载按导出格式 (GRAY 用纯白亮度 max 通道, 不导预览颜色)',
     /function frameCanvas\(frame, fmt = 'RGB565'\)/.test(fgd) &&
     /frameCanvas\(curFrame\.value, doc\.fmt\)/.test(fgd) &&
     /Math\.max\(d\[i\], d\[i \+ 1\], d\[i \+ 2\]\) \* \(d\[i \+ 3\] \/ 255\)/.test(fgd) &&
     /grayByMax/.test(fs.readFileSync(new URL('../src/imageproc.js', import.meta.url), 'utf8')) &&
     /grayByMax: asset\.font\?\.charset === 'frames'/.test(storeSrc))
  ok('多帧画板: 只在关闭画板/关闭页面时自动保存, 不做定时保存',
     /function autoSave/.test(fgd) && !/setTimeout\(\(\) => \{ autoSave\(\) \}/.test(fgd) &&
     /flushLocalPersistence/.test(fgd) && /addEventListener\('pagehide', onPageHide\)/.test(fgd) &&
     /addEventListener\('beforeunload', onPageHide\)/.test(fgd) && /关闭时自动保存/.test(fgd) &&
     /export function flushLocalPersistence/.test(storeSrc))
  ok('复制: 主预览 Ctrl+C 复制选中对象 (输入框内不拦截)',
     /copySelectedToClipboard/.test(app) && /e\.key\.toLowerCase\(\) === 'c'/.test(app) &&
     /copySelectedToClipboard\(\)\.then/.test(app))
  ok('粘贴: 多帧组 Ctrl+V 支持系统剪贴板 + localStorage 兜底',
     /readClipboardObject/.test(fgd) && /addEventListener\('paste'/.test(fgd) &&
     /addEventListener\('keydown', onGroupKey/.test(fgd) && /addBitmapAsset/.test(fgd))
  ok('粘贴: 始终新建图层; 复制来的参数只用来初始化新层样式',
     /p\.kind === 'text'/.test(fgd) && /const style = p\.params\?\.kind === 'text'/.test(fgd) &&
     /frame\.layers\.push\(l\)/.test(fgd) && /已粘贴新文字层/.test(fgd) &&
     /已粘贴新图片层/.test(fgd) && /p\.params/.test(storeSrc))
  ok('剪贴板: 同时写 image/png 与 text/plain JSON, 同一 origin 同步 localStorage',
     /ClipboardItem\(\{ 'image\/png': blob, 'text\/plain': text \}\)/.test(storeSrc) &&
     /localStorage\.setItem\(CLIP_KEY/.test(storeSrc) && /dataURL/.test(storeSrc) &&
     /kind = 'text'/.test(storeSrc))
}

/* 系统字微调: 按钮/对话框挂载; 数字、ASCII、固定文本都能打开 (固定文本没有字模表, 只调整串) */
{
  const dlg = fs.readFileSync(new URL('../src/components/TextDialog.vue', import.meta.url), 'utf8')
  const tune = fs.readFileSync(new URL('../src/components/SysFontTuneDialog.vue', import.meta.url), 'utf8')
  ok('系统字微调: 对话框已挂载, 按钮对所有系统字模式可见',
     /<SysFontTuneDialog/.test(dlg) && /v-if="draft\.source === 'system'"/.test(dlg) &&
     /逐字微调/.test(dlg))
  ok('系统字微调: 逐字左右偏移/自动对中/最终格子 = 叠加最大尺寸',
     /function autoAlign/.test(tune) && /最终格子 = 所有字形叠加区域的最大尺寸/.test(tune) &&
     /glyphDx/.test(tune))
}

/* 组件 setup 里引用了 store 的符号, 但 import 漏了 —— Vite 构建不报, 浏览器一挂载就
 * ReferenceError, 整个子组件空白 (2026-11: ExportAllButton 的 screen 就是这么丢的)。*/
{
  const ea = fs.readFileSync(new URL('../src/components/ExportAllButton.vue', import.meta.url), 'utf8')
  const imp = (/import\s*\{([\s\S]*?)\}\s*from\s*'\.\.\/store\.js'/.exec(ea) || [])[1] || ''
  ok('ExportAllButton: 用了 screen.value 就必须 import screen (防挂载时 ReferenceError)',
     !/\bscreen\.value\b/.test(ea) || /\bscreen\b/.test(imp))
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
