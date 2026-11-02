/*
 * layerexport.js —— 图层驱动导出 (P3)
 *
 * 设计要点 (对应需求):
 *   · 不再有"独立的表导出": **被图层引用的资源自动导出**, 表也由图层生成
 *   · 每个图层可勾选"外部 flash" (inst.ext) → 素材分别进 ui_assets_int.c / ui_assets_ext.c
 *   · 静态图层 → 生成 UI_DrawStatic() 里的逐条绘制调用 (不需要手写表)
 *   · 动态图层 (绑定了参数, inst.bind) → 生成 UI_FIELD 表项 (数字走灰度字库)
 *
 * 本模块保持**纯逻辑**: 像素数据由调用方提供 (浏览器用 canvas 取, 测试用桩),
 * 这样"图层 → 文件"的映射可以在 node 下完全自检。
 */
import { exportAssets, exportTable, exportFont, exportFontC, exportFontParts, fontGlyphSet, cGlyphTable, idDrawFunction, asciiStrFunction,
         numLayout, cVarRef, isMemberRef, srcMacroName, extAttrDefine, EXT_ATTR_MACRO } from './uiexport.js'
import { colorMacroName, buildColorHeader, collectUsedColors } from './colordef.js'

/**
 * 动态数字区域要用的字库: 每个数字层可以带自己的字库 (字号跟字库走, 见 store.numFontFor)。
 * 同名只出一份; 一个都没带 (纯逻辑调用方) 就退回内置 ASCII 8×11。
 */
function fontListFor(dyn, plan = null) {
  const byName = new Map()
  for (const it of dyn) if (it.fontTable?.name && it.fontTable.bytes) {
    /* 字模的存储方式 = **用它的那一层的选择** (同名只出一份, 先到先得):
     *   int / ext / lzss。LZSS 组的 ID 由 plan._fontLzss 给出 (打包前先规划)。 */
    if (!byName.has(it.fontTable.name)) {
      const store = it.store || (it.ext ? 'ext' : 'int')
      byName.set(it.fontTable.name, { ...it.fontTable, ext: store === 'ext', store,
                                      lzss: plan?._fontLzss?.get(it.fontTable.name) || null })
    }
  }
  const list = [...byName.values()]
  // 有数字项没带自己的字库 (或一个都没带) → 内置 ASCII 8×11 兜底 (g_uiFontNum8x11);
  // 兜底字库的存储方式跟随第一个数字层的选择 (int/ext/lzss)
  if (!list.length || dyn.some(it => !it.fontTable?.name || !it.fontTable.bytes)) {
    const first = dyn.find(it => (it.bind?.type || 'num') === 'num')
    const st = first?.store || 'int'
    list.push({ ...exportFont({}), ext: st === 'ext', store: st })
  }
  return list
}
/* 这批数字区域**实际需要**哪些字形 —— 字库只导这些, 不再把用不到的字形塞进 flash。
 *   0-9      : 数字区域总要
 *   '.'      : 有小数位 (dec>0) 才要
 *   '-'      : 值可能为负才要 (数字区域上的「可能为负」开关, 或 demo 是负数)
 *   '/'      : 数字格式化永远不用 (以前的 13 字模里它是纯死重) → 不导
 * 返回 { chars, why } —— why 是给导出注释/面板看的人话。 */
export function neededNumChars(dyn) {
  const bits = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
  let dec = 0, neg = 0
  for (const it of dyn || []) {
    if ((it.bind?.type || 'num') !== 'num') continue
    const d = Math.max(0, Math.round(+it.bind?.dec || 0))
    if (d > 0) { bits.add('.'); if (d > dec) dec = d }
    if (it.bind?.neg || +it.bind?.demo < 0) { bits.add('-'); neg++ }
  }
  const chars = [...bits].sort().join('')
  const why = [`0-9`, dec ? `'.' (有 ${dec} 位小数)` : `不带 '.' (没有小数位)`,
               neg ? `'-' (${neg} 个区域可能为负)` : `不带 '-' (值不会为负)`].join(' + ')
  return { chars, why }
}

/** 数字字库 → 三块: 代码 (UI_FONT 结构体, 留 ui_font.c) / 内部字模 / 外部字模。
 *  ！字模数组是"只经 LCD_drawGrayImage 读"的像素数据 → 跟其它素材一样按图层的「外部」
 *    选择分流到 ui_assets_int.c / ui_assets_ext.c;
 *    UI_FONT 结构体是 CPU 直接读字段 (.glyph/.w/.h/.gap) 的表 → 必须留在内部 (ui_font.c),
 *    否则字模被放进外部时会把结构体/函数一起拖过去 (取指/解引用即 HardFault)。 */
function fontPartsFor(plan, opt = {}) {
  const dyn = (plan?.items || []).filter(i => i.bind)
  const code = [], intData = [], extData = []
  let needLcd = false
  /* 1) 数字字库: UI_FONT 结构体 (代码) + 字模数组 (数据) */
  if (needFontFor(dyn)) {
    const need = neededNumChars(dyn)
    for (const f of fontListFor(dyn, plan)) {
      const p = exportFontParts(f, { chars: need.chars, why: need.why, ext: !!f.ext, lzss: f.lzss })
      if (p.inCode) { code.push(p.glyph); code.push(p.struct) }   /* 兜底字库 (没有像素): 两块都在 ui_font.c */
      else if (p.lzss) code.push(p.struct)                       /* LZSS: 字形在统一表里, 这里只留结构体 */
      else { code.push(p.struct); (f.ext ? extData : intData).push(p.glyph) }
    }
  }
  /* 2) 文字层 / ASCII 字库层: 取图函数 + 字模表 */
  const idp = idFunctionParts(plan, opt.coord16)
  if (idp.code.trim()) { needLcd = true; code.push(idp.code) }
  if (idp.intData.trim()) intData.push(idp.intData)
  if (idp.extData.trim()) extData.push(idp.extData)
  /* 3) 多帧图标 (导出所有帧): 取帧函数 (数据 <key> 走主素材路径, key = g_uiFrameN_ext/int) */
  const fr = frameFunctionBlocks(plan, opt.coord16)
  if (fr.trim()) { needLcd = true; code.push(fr) }
  const join = (a) => (a.length ? a.join('\n\n') + '\n' : '')
  return { code: join(code), intData: join(intData), extData: join(extData), needLcd }
}
/** 这个计划里会不会出字库 (有数字区域才出) */
const needFontFor = (dyn) => dyn.some(it => (it.bind?.type || 'num') === 'num')

/** 数字字库的实际字形集合 (含存储方式 + LZSS 组信息) —— 供 exportLayer 先建组/分配 ID。 */
export function fontGlyphSetsFor(plan) {
  const dyn = (plan?.items || []).filter(i => i.bind)
  if (!needFontFor(dyn)) return []
  const need = neededNumChars(dyn)
  return fontListFor(dyn, plan)
    .map(f => ({ f, set: fontGlyphSet(f, { chars: need.chars, why: need.why }) }))
    .filter(x => x.set.bytes && x.set.bytes.length)
}

const esc = (s) => String(s ?? '').replace(/[^\w]/g, '_')

/** 这一层要不要导出**像素**:
 *   · 没勾「仅尺寸」 → 照常导;
 *   · 勾了「仅尺寸」 → 只留坐标/尺寸 (帧表 .px = 0), 像素不导 —— 链接器随即把数组回收;
 *   · 「仅尺寸 + 仅素材」一起勾 → 像素**照常导出** (固件按名自取), 只是帧表 .px = 0。 */
export const pixelExported = (it) => !it.sizeOnly || !!it.assetOnly

/** 这一层要不要"进页/进 DrawStatic 画":
 *   · 仅素材 → 不进 (画不画由固件定, 自己 UI_DrawFrame);
 *   · 仅尺寸 → 不进 (它只提供坐标/尺寸, .px = 0, 本来也没东西可画)。 */
export const drawnByPage = (it) => !it.assetOnly && !it.sizeOnly

/**
 * 把图层列表整理成导出计划 (纯函数, 不碰 DOM)
 * @param instances 编辑器实例数组
 * @param assets    素材数组 ({id, name, src, w, h, font?})
 * @param opt       { screen:{w,h}, ringPage:boolean }
 * @returns { items:[{key,name,x,y,w,h,fmt,color,mirror,ext,gray,lineH,bind,frame,src}], skipped:[] }
 */
export function collectLayerPlan(instances, assets, opt = {}) {
  /* 固件只认 GRAY8 / RGB565。GRAY 图层在"灰度装 G565"的屏幕预设下 (grayPack='g565')
   * 出的是 16 位像素, 表里就得写 RGB565 —— 否则固件按 1B/px 读, 画面全乱。 */
  const grayPacked = opt.grayPack === 'g565'
  const items = [], skipped = []
  /* 数组命名 (2026-10-21): 跟帧表下标走 —— g_uiFrame0_ext / g_uiFrame0_int。
   *   · 静态层 = 帧表里的一项, 序号就是 g_uiFrame<N> 的 N (z 序, 跳过圆环/动态层);
   *   · 动态层 (数字) 不占帧表, 用 g_uiField<N> 只给字库/函数取个不撞车的基名;
   *   · 圆环没有数组。
   * 以前按"内部/外部各自从 0 编号" (g_uiInt0 / g_uiExt0), 和帧表序号对不上:
   * 看代码时 g_uiExt5 到底画在哪一帧要靠数, 电池这种"仅素材 + 导出所有帧"尤其难找。 */
  let frameSeq = 0, fieldSeq = 0
  for (const inst of instances || []) {
    /* 圆环: 不产生素材/帧, 但它**属于某一页** —— 导出成那一页的 Enter 启圆环 / Exit 停圆环
     * (参数仍走 ring_config.h)。所以它进计划, 只是 kind='ring' 走另一条路。 */
    if (inst.kind === 'ring') {
      if (!inst.ring) { skipped.push({ id: inst.id, why: '圆环没有参数 (参数走 ring_config.h)' }); continue }
      items.push({
        id: inst.id, kind: 'ring', key: '', name: inst.name || 'ring',
        page: pageNum(inst), pages: pageNums(inst), ring: { ...inst.ring },
        x: Math.round(inst.x || 0), y: Math.round(inst.y || 0),
        w: Math.round(inst.w || 0), h: Math.round(inst.h || 0),
        bind: null, ext: false, store: 'int', lzss: false,
      })
      continue
    }
    const a = (assets || []).find(x => x.id === inst.assetId) || null
    // 系统字图层没有素材文件 (文字是渲染出来的), 但它自己有像素, 照样导出
    if (!a && !inst.sysfont) { skipped.push({ id: inst.id, why: '没有素材' }); continue }
    /* 存储方式 (2026-11): 三态 int / ext / lzss。旧工程只有 inst.ext 布尔,
     * 这里做一次兼容推导; 新工程写 inst.store。 */
    /* store 是主口径; 但旧代码/旧存档可能只改 inst.ext (布尔) ——
     * ext=true 且不是 LZSS 时按外部处理, 避免"勾了外部却进内部"。 */
    const store = inst.store === 'lzss' ? 'lzss'
      : (inst.ext ? 'ext' : (inst.store === 'ext' ? 'ext' : 'int'))
    const ext = store === 'ext'
    const lzss = store === 'lzss'
    const key = inst.bind
      ? `g_uiField${fieldSeq++}`
      : (lzss ? `g_uiFrame${frameSeq++}` : `g_uiFrame${frameSeq++}_${ext ? 'ext' : 'int'}`)
    items.push({
      id: inst.id,
      kind: inst.kind || 'image',
      page: pageNum(inst),
      pages: pageNums(inst),
      key,
      name: inst.name || key,
      assetId: a?.id || null,
      x: Math.round(inst.x || 0), y: Math.round(inst.y || 0),
      w: Math.round(inst.w || a?.w), h: Math.round(inst.h || a?.h),
      fmt: (inst.fmt === 'GRAY' && !grayPacked) ? 1 : 0,                // UI_FMT_*(1=GRAY8, 0=RGB565)
      color: inst.color == null ? 0xFFFF : (inst.color & 0xFFFF),
      mirror: inst.mirror ? 1 : 0,
      /* 输出里**没有"多行素材"这回事**: 多行文本在网页里只是"一次做几张素材"的便利,
       * 放上屏幕的每一帧都是独立一张图 (lineH = 0)。要整条多行像素才显式给 inst.lineH。 */
      lineH: Math.max(0, Math.round(+inst.lineH || 0)),
      ext, store,
      /* 系统字「ASCII 字库」层: 像素照旧出 (这一层显示的示例文本), 另外由调用方补上
       * it.picTable (整份 0x20..0x7E 字模) + it.ascii → 导出器再多出 <名字> / <名字>Str 两个函数 */
      ascii: !!inst.ascii,
      bind: inst.bind || null,          // 动态: { name:'g_uiSpeedX10', dec, cells, align, pad }
      /* 仅素材 (不进页): 像素照常导出、帧表条目 (g_uiFrameN) 照常生成 —— 固件按名自取
       * (UI_DrawFrame(N)); 但**任何页的 Enter 都不画它** (素材归动态层/状态机管)。
       * 用例: 手/模式图标、电池 —— 网页只当素材仓库, 画不画由固件定。 */
      assetOnly: !!inst.assetOnly,
      /* 仅尺寸: 这一层只留**坐标/尺寸** (帧表 .px = 0), 像素不进 flash ——
       * 帧表条目照常生成, 固件读 g_uiFrameN.x/.y/.w/.h 定位, 数据自己带。
       * 与「仅素材」一起选 → 尺寸仍出 0, 但像素**照常导出**给固件按名自取。 */
      sizeOnly: !!inst.sizeOnly,
      /* 帧选择 (0 基, 与网页输入框同值): 0..N-1 = 画第几帧; -1 = 仅网页渲染
       * (MCU 侧帧表 .index = 255 → UI_DrawFrame 只清底色 UI_BG_COLOR, 不渲染)。 */
      frame: (inst.frame == null) ? 0 : inst.frame,
      src: a?.src || null,
      font: a?.font || null,
    })
  }
  return { items, skipped }
}

/**
 * 文字层 → 函数定义列表: 名字取图层名 (重复时退回数组名, 免得两个图层撞符号)。
 * 定义 (ui_table.c) 与声明 (ui_table.h) 都从这里来, 保证两边永远一致。
 * ascii = 这一层的字模表是**字符字库** (系统字 ASCII 选项): 除了按 id 取图,
 * 再配一个 <名字>Str() 打字符串 (见 uiexport.asciiStrFunction)。
 */
function idFunctionDefs(plan) {
  const used = new Set()
  const defs = []
  for (const it of plan.items) {
    if (!it.picTable?.rows?.length) continue
    if (!pixelExported(it)) continue        /* 仅尺寸: 字模表也不导 (没有像素就没有取图函数) */
    let fn = it.fnName || it.key
    if (used.has(fn)) fn = it.key
    used.add(fn)
    defs.push({
      fn, rows: it.picTable.rows, w: it.picTable.gw, h: it.picTable.gh,
      /* 行字节数 (字形大小) 以数据为准: 声明 extern 时要用它, 与 cGlyphTable 同源 */
      rowBytes: it.picTable.rows[0]?.length || (it.picTable.gw * it.picTable.gh),
      /* 字模表进"内部"/"外部"/LZSS = 这一层的选择 */
      ext: !!it.ext,
      lzss: it.picTable.lzss || null,
      ascii: !!it.ascii, first: it.picTable.first, gap: it.picTable.gap,
    })
  }
  return defs
}
/** 文字层的"按 ID 取图"函数块: 字模表 + void <函数名>(x, y, id, color, bg)。 */
/** 多帧图标"导出所有帧"的取帧函数块: void fn(x, y, id, color, bg)。
 *  id 口径 (用户约定): 0 = 关闭 (填底色), 1..N = 第 id 帧。
 *  ！所有帧在**一个连续大数组** <key> 里 (key = g_uiFrameN_ext/int; 第 k 帧在偏移 k*每帧大小处) ——
 *    取帧就是数组偏移, 不需要逐帧 switch, 也不需要 armcc 不认的指针表;
 *    地址强转仍走 FN_P 宏 (与固件 UI_PXADDR 同一招)。 */
export function frameFunctionBlocks(plan, coord16) {
  const CT = coord16 ? 'uint16_t' : 'uint8_t'
  const items = (plan?.items || []).filter(i => i.allFrames && i.allFrames.count > 0 && pixelExported(i))
  if (!items.length) return ''
  const L = []
  for (const it of items) {
    const { fn, count, gray } = it.allFrames
    const w = it.w, h = it.h
    const lz = it.lzss
    if (lz) {
      /* LZSS: 每帧 = _C 个片, 首片 ID = UI_ASSET_<key> + (id-1) * _C */
      L.push(`/* ${fn}: 多帧图标 (导出所有 ${count} 帧, LZSS 组 ${lz.key}) —— MCU 按 id 调用:`)
      L.push(` *   id = 0 关闭 (填底色 bg); id = 1..${count} 画第 id 帧; 其余值不动。 */`)
      L.push(`void ${fn}(${CT} x, ${CT} y, uint8_t id, uint16_t color, uint16_t bg)`)
      L.push('{')
      L.push(`    if (id == 0u) { LCD_Fill(x, y, (${CT})(x + ${w}), (${CT})(y + ${h}), bg); return; }`)
      L.push(`    if (id > ${count}u) return;                          /* 超范围: 保持原画面不动 */`)
      L.push(`    UI_DrawAsset((uint16_t)(UI_ASSET_${lz.key} + (uint16_t)(id - 1u) * UI_ASSET_${lz.key}_C),`)
      L.push(`                 (uint8_t)UI_ASSET_${lz.key}_C, x, y, color, bg, 0);`)
      L.push('}')
      L.push('')
      continue
    }
    /* ！一律按**字节地址**取帧: 素材文件的存储宽度不一样 —
     *   · 内部 RGB = 每像素 2 字节 (BE 字节对), 内部灰度 = 每像素 1 字节;
     *   · 外部 RGB = uint16 元素, 外部灰度 = 字节序列按 2B/元素打包 (packBytesKeepSeq);
     *   三种情况下**帧与帧在内存里都是紧挨着的**, 所以统一转成 const uint8_t* 再加
     *   "每帧字节数" 最稳, 不会因为元素宽度/奇偶像素数算错偏移 (灰度 w*h 为奇数时,
     *   按 uint16 元素跨度的老写法还会多跳 1 字节)。 */
    const strideBytes = gray ? `(uint32_t)${w} * ${h}` : `(uint32_t)${w} * ${h} * 2u`
    L.push(`/* ${fn}: 多帧图标 (导出所有 ${count} 帧, 连续存放于 ${it.key}) —— MCU 按 id 调用:`)
    L.push(` *   id = 0 关闭 (填底色 bg); id = 1..${count} 画第 id 帧; 其余值不动。 */`)
    L.push(`#define ${fn.toUpperCase()}_P(v) ((const uint8_t *)(uintptr_t)(v))`)
    L.push(`void ${fn}(${CT} x, ${CT} y, uint8_t id, uint16_t color, uint16_t bg)`)
    L.push('{')
    /* ！LCD_Fill 的末列/末行**不包含** (内部 Address_Set 到 end-1) → 这里传 x+w / y+h,
     *   不是 x+w-1 (老写法每次少清 1px, 右/下各留一条残影)。 */
    L.push(`    if (id == 0u) { LCD_Fill(x, y, (${CT})(x + ${w}), (${CT})(y + ${h}), bg); return; }`)
    L.push(`    if (id > ${count}u) return;                          /* 超范围: 保持原画面不动 */`)
    const ptr = `${fn.toUpperCase()}_P(${it.key}) + (uint32_t)(id - 1u) * ${strideBytes}`
    const call = gray
      ? `LCD_drawGrayImage(x, y, ${w}, ${h}, ${ptr}, color, 0)`
      : `LCD_drawImage(x, y, ${w}, ${h}, ${ptr}, color)`
    L.push(`    ${call};`)
    L.push('}')
    L.push('')
  }
  return L.join('\n') + '\n'
}

/** 文字层/ASCII 字库层 → 三块: 代码 (取图函数) / 内部字模表 / 外部字模表。
 *  ！字模表是纯像素数据 → 跟其它素材一样按图层的「外部」选择进
 *    ui_assets_int.c / ui_assets_ext.c; ui_font.c 里只留函数。 */
function idFunctionParts(plan, coord16) {
  const defs = idFunctionDefs(plan)
  const code = [], intData = [], extData = []
  for (const d of defs) {
    const first = d.ascii ? (d.first == null ? 32 : d.first) : 32
    if (!d.lzss) {
      ;(d.ext ? extData : intData).push(
        cGlyphTable(d.fn + 'Pic', d.rows, 16, d.ext ? EXT_ATTR_MACRO : ''))
    }
    let fnCode = idDrawFunction(d.fn, {
      count: d.rows.length, w: d.w, h: d.h, coord16,
      ascii: d.ascii, first, lzss: d.lzss,
    })
    /* ASCII 字库: 再给一个"打字符串"的封装 (固件刷任意文本用这个最顺手) */
    if (d.ascii) {
      fnCode += '\n\n' + asciiStrFunction(d.fn, {
        first, count: d.rows.length, w: d.w, h: d.h,
        gap: Math.max(0, Math.round(d.gap) || 0), coord16, lzss: d.lzss,
      })
    }
    code.push(fnCode)
  }
  const join = (a) => (a.length ? a.join('\n\n') + '\n' : '')
  return { code: join(code), intData: join(intData), extData: join(extData) }
}

/**
 * ui_table.h —— ui_table.c 里那些东西的**声明** (每次导出重写, 不用手改)。
 *
 * 为什么需要它: 一个 Keil 工程里 ui_assets_int.c / ui_ext.c / ui_table.c / ui_task.c 是
 * **各自独立编译**的, 谁用谁就得先看见声明 —— 否则报 "identifier g_uiFields is undefined"。
 * 之前只有 .c 没有 .h, 每个文件都缺声明, 用户那边就是这么炸的。
 */
/** 这个计划里有没有走 LZSS 的素材 (帧 / 取图表 / 字库) —— 决定是否 include 新格式头。 */
export const planHasLzss = (plan) =>
  (plan?.items || []).some(i => i.lzss || i.picTable?.lzss) ||
  !!(plan?._fontLzss && plan._fontLzss.size)

export function tableHeaderFor(plan, opt = {}) {
  const items = plan?.items || []
  const frames = items.filter(i => i.kind !== 'ring' && !i.bind)   // 圆环不进表 (只进页面任务)

  const dyn = items.filter(i => i.bind)
  const L = ['#ifndef UI_TABLE_H',
             '#define UI_TABLE_H',
             '',
             '/* ui_table.h —— ui_table.c 导出的表/字库/函数的声明 (每次导出重写, 别改这个文件)',
             ' * ui_task.c 与 ui_table.c 各自独立编译, 靠这个头互相看得见 */',
             '',
             '#include "app_ui.h"',
             ...(planHasLzss(plan) ? ['#include "ui_assets_lzss.h"   /* LZSS 素材 ID / UI_ASSET_NONE */'] : []),
             '#include "ui_color.h"          /* UI_COLOR_* 颜色宏 (每次导出重写) */',
             '']
  if (frames.length) {
    L.push('/* 帧: 每个静态图层一帧 (定义在 ui_table.c); .index = 画 px 数组里第几帧 (0 基), 255 = 仅网页渲染 (只清底色) */')
    frames.forEach((f, i) => L.push(`extern const UI_FRAME_REF g_uiFrame${i};`))
    L.push(`#define UI_FRAME_N ${frames.length}`)
    L.push(`extern const UI_FRAME_REF *const g_uiFrames[UI_FRAME_N];`, '')
  }
  L.push('/* 动态区域表 (定义在 ui_table.c) */')
  L.push('extern UI_FIELD g_uiFields[];')
  /* 这里必须是**数字**: 别的 .c 里 g_uiFields 只有声明 (不完整类型), sizeof 用不了 */
  L.push(`#define UI_FIELD_N ${dyn.length}`, '')
  if (needFontFor(dyn)) {
    L.push('/* 数字字库: UI_FONT 结构体在 ui_font.c; 字模数组在 ui_assets_int.c / ui_assets_ext.c */')
    for (const f of fontListFor(dyn, plan)) {
      /* 字模数组不带 static (定义在素材文件里); 没有像素的兜底字库是 ui_font.c 里的 static, 不声明。
       * LZSS 字库没有连续数组 (字形在统一表里), 只声明 UI_FONT 结构体。 */
      if (f.bytes && !f.lzss) L.push(`extern const ${f.ext ? 'uint16_t' : 'uint8_t'} ${f.name}Glyph[];`)
      L.push(`extern const UI_FONT ${f.name};`)
    }
    L.push('')
  }
  /* 文字层 / ASCII 字库层: 字模表在素材文件里, 取图函数在 ui_font.c 里按 id 取行 */
  {
    const pics = idFunctionDefs(plan)
    if (pics.length) L.push('/* 文字层/ASCII 字模表: 定义在 ui_assets_int.c / ui_assets_ext.c (按图层的「外部」选择) */')
    for (const d of pics) {
      if (d.lzss) continue   /* LZSS: 每一行是一个表项, 没有连续二维数组 */
      L.push(`extern const uint8_t ${d.fn}Pic[][${d.rowBytes}];   /* ${d.rows.length} 行 × ${d.rowBytes}B */`)
    }
    if (pics.length) L.push('')
  }
  /* 坐标类型: 导出器按"画布/图层最大边缘"选, 这里 #if 编译期再校验一遍 */
  const coordMax = opt.coordMax != null ? Math.round(opt.coordMax) : 255
  const CT = coordMax > 255 ? 'uint16_t' : 'uint8_t'
  L.push(`/* 坐标类型自动判定 (导出器计算): 本导出最大边缘 = ${coordMax}px → 坐标参数用 ${CT}`)
  L.push(' * ！uint8_t 会静默截断 (x=256..319 变 0..63), 编译期一个字都不报 —— 这个 #if 就是兜底哨兵 */')
  L.push(`#define UI_EXP_COORD_MAX  ${coordMax}u`)
  L.push('#if (UI_EXP_COORD_MAX > 65535u)')
  L.push('#error "UI_EXP_COORD_MAX 超出 uint16_t: 画布或图层太大"')
  L.push('#endif')
  L.push('#if (UI_EXP_COORD_MAX > 255u)')
  L.push('#define UI_COORD_16  1      /* 坐标参数一律 uint16_t (与导出器判定一致) */')
  L.push('#endif', '')
  const fns = idFunctionDefs(plan)
  if (fns.length) {
    L.push('/* 文字层: 外部给 id, 内部取第 id 张图 (定义在 ui_table.c) */')
    for (const d of fns) L.push(`void ${d.fn}(${CT} x, ${CT} y, uint8_t id, uint16_t color, uint16_t bg);`)
    L.push('')
  }
  /* ASCII 字库 (系统字): 打字符串的封装 —— 与 id 版同源同表, 声明一起出 */
  const asciiFns = fns.filter(d => d.ascii)
  if (asciiFns.length) {
    L.push('/* ASCII 字库: 打任意字符串 (逐字取模, 空格/越界跳过) — 定义在 ui_font.c */')
    for (const d of asciiFns) L.push(`void ${d.fn}Str(${CT} x, ${CT} y, const char *str, uint16_t color);`)
    L.push('')
  }
  const frms = (plan?.items || []).filter(i => i.allFrames && i.allFrames.count > 0 && pixelExported(i))
  if (frms.length) {
    L.push('/* 多帧图标 (导出所有帧): 数组声明在下面「素材数组」块 (key 与帧表条目同名); 函数在 ui_font.c')
    L.push(' *   id: 0=关闭(填底色), 1..N=第 id 帧 —— MCU 侧业务代码按状态给 id */')
    for (const it of frms)
      L.push(`void ${it.allFrames.fn}(${CT} x, ${CT} y, uint8_t id, uint16_t color, uint16_t bg);`)
    L.push('')
  }
  L.push('/* 进页面画一次: 把静态图层按 z 序全画一遍 (定义在 ui_table.c) */')
  L.push('void UI_DrawStatic(void);', '')
  if (frames.length) {
    L.push('/* 素材数组 (定义在 ui_assets_int.c / ui_assets_ext.c)')
    L.push(' * ！外部素材是"最终形态" const uint16_t + 段属性 (ui_assets_ext.c), 内部素材 uint8_t */')
    for (const f of frames) {
      if (!pixelExported(f)) continue  /* 仅尺寸: 这一层没有数组, 别声明 (声明了也没人定义) */
      if (f.lzss) continue             /* LZSS: 像素在统一表里, 没有独立数组 */
      /* 数组名 = 帧表条目名 + _ext/_int (g_uiFrame0_ext)。勾了「导出所有帧」的层也是
       * 这一个名字 —— 数组里是 N 帧连续像素, 帧表 .index 选第几帧, 取帧函数按偏移直取。 */
      const note = f.allFrames ? `      /* ${f.allFrames.count} 帧连续存放, 每帧 ${f.w}x${f.h}; 函数 ${f.allFrames.fn}() */`
                               : (f.ext ? '      /* 外部 Flash 段 */' : '')
      if (f.ext) L.push(`extern const uint16_t ${f.key}[];${note}`)
      else       L.push(`extern const uint8_t ${f.key}[];${note}`)
    }
    L.push('')
  }
  L.push('#endif /* UI_TABLE_H */', '')
  return L.join('\n')
}

/**
 * ui_table.c 的文件开头 (纯属性表: 帧表 + 区域表 + 静态绘制)。
 * **include 必须在最前面** —— 表里的 `.px = g_uiFrame0_ext` 是别的文件里的数组。
 * (用户踩过: include 排在字模数据后面 → Keil 报 identifier "UI_FONT" is undefined)
 */
function tableFileHead(plan) {
  return `/* 由 MCU-LCD-Editer 导出: 帧表 + 动态区域表 + 静态绘制 (纯"属性", 字模数据在 ui_font.c)
 * 与 code/spi/app_ui.h 的 UI_FRAME_REF / UI_FIELD 一一对应
 * 素材数组 (g_uiFrame0_ext / g_uiFrame0_int ...) 在 ui_assets_int.c / ui_assets_ext.c 里, 本文件只引用
 * 用法: 面板初始化后 LCD_UI_Setup() 一次 (设表 + UI_Init), 切页用 LCD_UI_Goto(page);
 *       刷新由 ui_task.c 的页面任务负责
 */
#include "app_ui.h"
#include "ui_table.h"
${planHasLzss(plan) ? '#include "ui_assets_lzss.h"   /* LZSS 素材 ID / UI_ASSET_NONE */\n' : ''}#include "ui_user.h"                 /* 你的变量声明/宏 (这个文件不会被导出覆盖) */

`
}

/**
 * ui_font.c 的文件开头 (字模数据 + 文字层的按 ID 取图函数)。
 * 字库动辄几千行, 单独一个文件 —— 属性表 (ui_table.c) 才能保持几十行、一眼看完。
 */
function fontFileHead({ needLcd = false, lcdHeader = 'bsp_gc9a01.h', lzss = false } = {}) {
  return `/* 由 MCU-LCD-Editer 导出: 数字字库 (UI_FONT 结构体) + 文字层字模与取图函数
 * ！字模**数组**不在这里: 纯像素数据按图层的「外部」选择并进 ui_assets_int.c / ui_assets_ext.c
 *   (数据与代码分对象 —— 字模进外部 Flash 时才不会把函数/结构体一起拖过去)。
 * 与 code/spi/app_ui.h 的 UI_FONT 一一对应; 声明在 ui_table.h 里
 */
#include "app_ui.h"
#include "ui_table.h"
#include "ui_user.h"                 /* 你的变量声明/宏 (这个文件不会被导出覆盖) */
${lzss ? '#include "ui_assets_lzss.h"   /* LZSS 字库/取图表 ID */\n#include "ui_asset_draw.h"   /* UI_DrawFrame/At (顶层) */\n' : ''}${needLcd ? `#include "${lcdHeader}"      /* 文字层函数用的 LCD_drawGrayImage / LCD_Fill */\n` : ''}
`
}
/** ui_user.h —— **用户自己的头文件, 导出时只生成一次, 之后永不覆盖**
 *  生成的 ui_font.c / ui_table.c / ui_task.c 都会 #include 它, 所以:
 *   · 简单变量 (g_uiSpeedX10) → 自动列 extern int32_t;
 *   · 成员写法 (sys.motor.level) → 表格里用 UI_SRC_* 宏取地址, 写法由用户在这个文件里给
 *     (结构体定义常常只在自己 .c 里, 直接 &sys.motor.level 会报 incomplete type);
 *   · LCD 头不是 bsp_gc9a01.h、或需要额外的宏, 也在这里补。 */
export function userHeaderFor(plan) {
  const names = []
  const member = []
  for (const it of plan?.items || []) {
    const n = String(it.bind?.name ?? '').trim()
    if (!n) continue
    if (!isMemberRef(n)) { if (!names.includes(n)) names.push(n) }
    else if (!member.includes(n)) member.push(n)
  }
  const body = []
  if (names.length) {
    body.push('/* ---- 数字区域用的变量: 表格里 .src = &变量 ----')
    body.push(' * 源必须是 int32_t (固件按 4 字节读): 变量是 uint8_t/int8_t 就先换算成 int32_t 再绑 */')
    for (const n of names) body.push(`extern int32_t ${n};`)
  } else {
    body.push('/* ---- 数字区域用的变量: 目前还没有 (有的话在这里写 extern int32_t 变量;) ---- */')
  }
  if (member.length) {
    body.push('')
    body.push('/* ---- 成员写法 (sys.motor.level): 表格里用 UI_SRC_xxx 宏取地址 ----')
    body.push(' * 名字里有 . 或 -> 时生成器不写 &结构体.成员, 而是写 UI_SRC_xxx ——')
    body.push(' * 因为那要求「结构体的完整定义」在生成的文件里可见, 固件里常常只在自己 .c 里定义 →')
    body.push(' * Keil 会报 #70: incomplete type is not allowed。让下面几行的写法成立即可, 三选一:')
    body.push(' *   ① 结构体定义在头文件里 → #include "app_sleep.h"')
    body.push(' *   ② 本文件里直接写一份: struct X { ... }; extern struct X x;')
    body.push(' *   ③ 定义拿不到, 也不想动固件头文件 → 让宏指向一个自己的 int32_t 变量 (在别处更新它):')
    body.push(' *        extern int32_t g_uiSpeedX10;      // 固件里: g_uiSpeedX10 = 值; 每周期更新')
    body.push(' *        #define UI_SRC_x (&g_uiSpeedX10)')
    body.push(' * 注意: 这里只能是"常量地址" (&对象 / &对象.成员), 不能写函数调用 ——')
    body.push(' *       区域表是静态初始化, 写 UI_Get_x() 会报 initializer element is not constant。')
    body.push(' *       另外源必须是 int32_t: 绑 uint8_t 的成员会读到 4 字节垃圾 (类型不匹配)。')
    body.push(' */')
    for (const n of member) body.push(`#define ${srcMacroName(n)} (&${cVarRef(n)})`)
  }
  return `#ifndef UI_USER_H
#define UI_USER_H

/*
 * ui_user.h —— 这是**你的**文件: 导出时只在第一次生成, 之后不会再被覆盖。
 *
 * 表/帧/字库/素材数组的声明都在 ui_table.h 里 (每次导出重写, 不用你管);
 * 这个文件留给**工程自己的东西**: 下面几节按当前设计先列了起步清单。
 * 新增变量后记得自己也加一行, 这个文件不会跟着导出更新。
 * 另外: app_ui.h 里 UI_FIELD.src 是 const int32_t * —— 源变量必须是 int32_t,
 * 是 uint8_t/int8_t 这种就先换算成 int32_t 的变量再绑 (或按 ③ 写取值函数)。
 */
#include <stdint.h>

/* ---- 外部 W25Q 素材的段属性: UI_EXT_RO ----
 * ui_assets_ext.c 的素材数组与 ui_font.c 的数字字模都写这个宏 (生成代码里**不写段名**)。
 * 改段名/改投放规则只改这一行 —— 导出器只认宏名, 不认段名。
 * ！used 不能删: 素材的唯一调用点被回收后就轮不到数据, 语义上仍需显式保留;
 * ！段名必须与工程 .sct 的选择器逐字一致 (armcc 的输入段名没有前导点)。
 * ！这个宏只在第一次导出时写进来; 工程已有 ui_user.h 时按工程自己那份为准。 */
${extAttrDefine()}

${body.join('\n')}

/* ---- 需要的话在这里补 LCD 头 / 宏 ----
 * #include "bsp_st7735s.h"
 * #define UI_USER_XXX 1
 */

#endif /* UI_USER_H */
`
}

/** 页清单 (页号 + 落在这一页的项):
 *  · 特殊页 (-4/-3/-2) 只列**有内容的**或**在网页上配置过**的 (配置过才能"隐藏"它)
 *  · 正常页 0..max: 空页号也留位; pageMap 里有键的 (网页上点「＋ 添加页」加的) 也列出来
 *  · -1 是空白页, 永远不列 (没有内容)
 *  pageMap = state.pages ({ 页号: {period, jumpMs, jumpTo, hidden} }) */
export function pageEntries(items, pageMap) {
  const arr = items || []
  const all = arr.map(it => pageNums(it))
  const cfgNums = Object.keys(pageMap || {})
    .map(k => Math.round(+k))
    .filter(n => Number.isFinite(n) && n !== PAGE_OFF && n >= PAGE_MIN && n <= PAGE_MAX)
  const present = new Set([...all.flat(), ...cfgNums])
  const maxN = Math.max(0, ...present)
  const out = []
  for (let n = PAGE_MIN; n <= maxN; n++) {
    if (n === PAGE_OFF) continue
    if (n < 0 && !present.has(n)) continue
    out.push({ n, label: pageLabel(n), mine: arr.filter((it, i) => all[i].includes(n)) })
  }
  return out
}
/** 进页面: 这一页要画的图层 (静态帧 + 数字), **按 z 序** —— 网页预览怎么叠, 板上就怎么叠。
 *  与旧版的区别只有顺序: 旧版是"所有静态帧 → 所有数字", 数字永远在最上层。 */
function pageDrawSeq(p) {
  return p.draws || []
}

/** 数字的周期刷新序列: 从**最下面那个数字**起, 按 z 序把剩下的图层都重画。
 *  ！数字整格涂底 → 只刷数字会擦掉压在它上面的静态层; 而它下面那些不用管
 *    (数字本来就该压住它们)。 */
function dynRedrawSeq(p) {
  const all = pageDrawSeq(p)
  const first = all.findIndex(it => it.bind)
  return first < 0 ? [] : all.slice(first)
}

/** 页面清单 (带静态/数字/圆环分组 + 隐藏标记), 给 ui_task.c / ui_task.h 生成用 */
function pageListFor(plan) {
  return pageEntries(plan?.items || [], plan?.pagePeriods).map(({ n, label, mine }) => ({
    n, label,
    /* draws = 这一页要画的图层, **保持 plan 的 z 序** (底→顶)。
     * ！以前页面任务把这一页拆成 statics/dyns 两组分别画 (静态帧全画完才画数字),
     *   于是"数字层在网页里排第几层"这个 z 序信息在导出时就丢了 —— 板上永远是数字压静态层。
     *   症状: 数字是**整格涂底**的 (空白列也写底色), 压在它下面的静态图会被擦掉几列,
     *   而网页预览按 z 序画 → 预览里好好的, 板上缺一块 (2026-10-12 实测: 26x34 的 "S"
     *   被两位数字的格子擦掉左 4~5 列)。所以页面任务改成按 draws 顺序画。
     * 「仅素材」层 (assetOnly) 与「仅尺寸」层 (sizeOnly) 都不进 draws/statics/dyns:
     *   前者画不画由固件定 (自己 UI_DrawFrame), 后者只提供坐标/尺寸 (.px = 0, 没东西可画)。
     *   两者的**帧表条目照常生成** (固件按名取坐标/像素)。仍算这一页的成员 (页不因此变空)。
     * ！帧号不参与过滤 (0 = 第 1 帧, -1 = 仅网页渲染): -1 的层照样进 Enter/DrawStatic,
     *   固件在 UI_DrawFrame 里按 .index = 255 清底色 —— 与应用层的约定一致。 */
    draws: mine.filter(it => it.kind !== 'ring' && drawnByPage(it)),
    statics: mine.filter(it => it.kind !== 'ring' && !it.bind && drawnByPage(it)),
    dyns: mine.filter(it => it.kind !== 'ring' && it.bind && drawnByPage(it)),
    rings: mine.filter(it => it.kind === 'ring'),
  }))
}
/** 每页的刷新周期 + 定时跳转 (plan.pagePeriods = { 页号: {period, jumpMs, jumpTo} }; 老工程可能是裸数字) */
function pageSettingsFor(plan, list) {
  const all = plan?.pagePeriods || {}
  const nums = new Set(list.map(p => p.n))
  for (const p of list) {
    const cfg = all[p.n] ?? all[String(p.n)]
    p.period = Math.max(1, Math.round(+(cfg?.period ?? cfg) || 0) || 200)
    p.jumpMs = Math.max(0, Math.round(+(cfg?.jumpMs) || 0))
    p.hidden = !!(cfg && typeof cfg === 'object' && cfg.hidden)
    /* 隐藏 = 进去只清屏等新状态 → 不自动跳页 (配置留着, 取消隐藏后原样恢复) */
    if (p.hidden) { p.jumpMs = 0; p.jumpTo = null }
    const jt = cfg?.jumpTo
    p.jumpTo = (jt === '' || jt == null) ? null : Math.round(+jt)
    /* 跳转目标页不存在 → 这条跳转不生效 (网页那边也会给警告) */
    if (p.jumpMs && (p.jumpTo == null || !nums.has(p.jumpTo))) { p.jumpMs = 0; p.jumpTo = null }
  }
  return list
}

/**
 * 页面配置自检 (给网页显示警告, 不阻断导出):
 *   · -1 是关机空白页 —— 放不了图层 (会被当成 0 页导出)
 *   · 定时跳转的目标页必须存在, 否则这条跳转不生效 (生成器里已忽略)
 *   · LOGO 特殊页 (-4) 有内容却没配定时跳转 → 状态机进去就停在那
 *   · 特殊页 (-4/-2/-3) 没内容 → 固件会跳过它 (开机直接进主页 / 充电、低电退回黑屏)
 */
export function pageIssuesFor(plan) {
  const items = plan?.items || []
  const list = pageSettingsFor(plan, pageListFor(plan))   /* 过一遍设置: 才有 hidden / 跳转生效与否 */
  const nums = new Set(list.map(p => p.n))
  const all = plan?.pagePeriods || {}
  const cfgOf = (n) => all[n] ?? all[String(n)]
  const out = []
  for (const it of items) {
    if (Math.round(+it.page) === PAGE_OFF)
      out.push({ level: 'warn', text: `图层「${it.name}」放在第 -1 页 (关机空白页) — 这一页没有内容, 已按第 0 页导出` })
  }
  for (const p of list) {
    const ms = Math.max(0, Math.round(+(cfgOf(p.n)?.jumpMs) || 0))
    if (!ms) continue
    const to = Math.round(+(cfgOf(p.n)?.jumpTo))
    if (!Number.isFinite(to) || !nums.has(to))
      out.push({ level: 'warn', text: `页 ${p.n} 配了 ${ms}ms 定时跳转, 但目标页 ${Number.isFinite(to) ? to : '(空)'} 不存在 — 这条跳转不会生效` })
  }
  /* 隐藏页: 说清"运行期会长什么样" (进去只清屏, 等固件给新状态) */
  for (const p of list) {
    const nm = p.n < 0 ? `${PAGE_SPECIAL[p.n] || '特殊页'} (${p.n})` : `页 ${p.n}`
    if (p.hidden)
      out.push({ level: 'info', text: `${nm} 已隐藏 — 板子上 LCD_UI_Goto(${p.n}) 进去只清屏, 不画内容也不自动跳页, 等固件状态机给新的页号` })
  }
  const logo = list.find(p => p.n === PAGE_LOGO)
  if (logo && !logo.hidden && (logo.statics.length + logo.dyns.length + logo.rings.length) &&
      !Math.max(0, Math.round(+(cfgOf(PAGE_LOGO)?.jumpMs) || 0)))
    out.push({ level: 'warn', text: '开机 LOGO 页 (-4) 有内容但没配「定时跳转」— 固件进去就不会自己走了' })
  return out
}

/** ui_task.h 的内容: 页号模型 + 切页 API + 每页 Enter/Exit 声明 + 每页"事实"宏 */
export function taskHeaderFor(plan) {
  const list = pageSettingsFor(plan, pageListFor(plan))
  const normals = list.filter(p => p.n >= 0)
  const specials = list.filter(p => p.n < 0)
  const decls = list.map(p => {
    const lbl = pageLabel(p.n)
    const note = p.n < 0 ? ` (${PAGE_SPECIAL[p.n] || '特殊页'})` : ''
    if (p.hidden) {
      return `void LCD_${lbl}_Enter(void);      /* 进页面${note}: **被隐藏** —— 只清屏, 等新的状态 (不画任何内容)\n` +
        `void LCD_${lbl}_Exit(void);       /* 出页面: 被隐藏, 没有要收尾的 */`
    }
    return `void LCD_${lbl}_Enter(void);      /* 进页面${note}: 画初始化显示内容 + 启动刷新` +
      (p.rings.length ? ' + 启圆环' : '') + (p.jumpMs ? ` + ${p.jumpMs}ms 后自动跳页 ${p.jumpTo}` : '') + ` */\n` +
      `void LCD_${lbl}_Exit(void);       /* 出页面: 停刷新` + (p.rings.length ? ' + 停圆环' : '') +
      (p.jumpMs ? ' + 停跳转' : '') + ` */`
  })
  const facts = []
  for (const p of normals) {
    const content = p.statics.length + p.dyns.length + p.rings.length
    facts.push(`#define LCD_HAS_PAGE_${p.n}       ${content && !p.hidden ? 1 : 0}      /* 页 ${p.n} 会不会画内容 (隐藏页 = 0) */`)
    facts.push(`#define LCD_PAGE_${p.n}_HIDDEN    ${p.hidden ? 1 : 0}      /* 1 = 这一页被隐藏: 进去只清屏, 等固件给新状态 */`)
    facts.push(`#define LCD_PAGE_${p.n}_JUMP_MS   ${p.jumpMs || 0}      /* 0 = 这一页不会自己跳走 (隐藏页恒 0) */`)
    if (p.jumpMs) facts.push(`#define LCD_PAGE_${p.n}_JUMP_TO   ${p.jumpTo}`)
  }
  for (const p of specials) {
    const key = SPECIAL_FACT[p.n] || ('SPEC' + Math.abs(p.n))
    facts.push(`#define LCD_HAS_${key}_PAGE      ${p.hidden ? 0 : 1}      /* 页 ${p.n} (${PAGE_SPECIAL[p.n] || '特殊页'}) 会不会画内容` +
      (p.hidden ? ' (被隐藏)' : '') + ` */`)
    facts.push(`#define LCD_HIDDEN_${key}_PAGE   ${p.hidden ? 1 : 0}      /* 1 = 被隐藏: 进去只清屏等新状态 */`)
    facts.push(`#define LCD_PAGE_${key}_JUMP_MS  ${p.jumpMs || 0}      /* 0 = 这一页不会自己跳走 (隐藏页恒 0) */`)
    if (p.jumpMs) facts.push(`#define LCD_PAGE_${key}_JUMP_TO  ${p.jumpTo}`)
  }
  for (const n of [PAGE_LOGO, PAGE_CHARGE, PAGE_LOWBAT]) {
    const key = SPECIAL_FACT[n]
    if (!specials.some(p => p.n === n)) {
      facts.push(`#define LCD_HAS_${key}_PAGE      0      /* 页 ${n} (${PAGE_SPECIAL[n]}) 没导出 */`)
      facts.push(`#define LCD_HIDDEN_${key}_PAGE   0`)
    }
  }
  return `#ifndef UI_TASK_H
#define UI_TASK_H

#include <stdint.h>

/* 页号约定 (负数只给特殊页, 按键永远进不去):
 *   -1 = 关机空白 (没有内容; Goto(-1) = 出旧页 + 停刷新 + 清屏)
 *   -2 = 关机充电 / -3 = 低电 / -4 = 开机 LOGO: 网页画了内容才生成 LCD_Page*_*
 *   >=0 = 正常页: 0..LCD_PAGE_N-1, 按键只在这之间循环 */
#define LCD_PAGE_N         ${normals.length}      /* >=0 的正常页数 */
#define LCD_PAGE_CHARGE  (-2)
#define LCD_PAGE_LOWBAT  (-3)
#define LCD_PAGE_LOGO    (-4)

/* 每页"会不会画内容 / 有没有定时跳转 / 有没有被隐藏":
 *   LCD_HAS_PAGE_n / LCD_HAS_LOGO_PAGE…  1 = 这一页会画内容 (隐藏页 = 0)
 *   LCD_PAGE_n_HIDDEN / LCD_HIDDEN_*_PAGE 1 = 被隐藏: LCD_UI_Goto() 进去只清屏, 等新的状态
 * 隐藏页仍然是**合法页号** (状态机照样能进退), 只是不画任何东西、也不会自动跳页 ——
 * 用来"先不显示"关机充电页 / 开机 LOGO / 低电页。要不要进这一页由固件状态机决定:
 *   #if !LCD_HAS_LOWBAT_PAGE && !LCD_HIDDEN_LOWBAT_PAGE   → 干脆别进 (老行为: 跳过)
 *   #if LCD_HIDDEN_LOWBAT_PAGE                            → 进去清屏等新状态 (黑屏, 不下电) */
/* 每页"有没有内容 / 有没有定时跳转" —— 固件据此决定特殊页要不要走
 * (网页没导出 LOGO 页 / 充电页 → 跳过它, 或退回空白页 -1) */
${facts.join('\n')}

/* 全局一次: 设区域表 + UI_Init; **不进任何页** (面板每次重新初始化后调一次) */
void LCD_UI_Setup(void);

/* 切页: 出旧页 (停刷新/停圆环/停跳转) → 清屏 → 进新页。
 * page = 0..LCD_PAGE_N-1 正常页; -2 关机充电; -3 低电; -1/越界 = 空白页 (不进任何页)。
 * 已经是这一页则什么都不做。 */
void LCD_UI_Goto(int8_t page);

/* 当前页号 (空白 = -1) */
int8_t LCD_UI_Page(void);

/* 按键切页: 只在 >=0 的正常页里循环 (特殊页只有固件状态机能进) */
int8_t LCD_UI_NextPage(int8_t cur);

/* 每页一对 (一般不用直接调, 用 LCD_UI_Goto) */
${decls.join('\n')}

#endif /* UI_TASK_H */
`
}

const cName = (s) => {
  const t = String(s ?? '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '')
  return t || 'main'
}
/* ---------- 页号模型 ----------
 *   -1 = 关机空白: 没有内容 (不能放图层); Goto(-1) = 出旧页 + 停刷新 + 清屏
 *   -2 = 关机充电: 特殊页, 网页画内容, 只有固件状态机能进 (按键进不去)
 *   -3 = 低电:     特殊页, 同上 (显示 keepShow 时间后下电 + MCU 休眠)
 *   -4 = 开机 LOGO: 特殊页, 同上; 一般配一个"定时跳转"自动进正常页 (按键进不去)
 *  >=0 = 正常页 (主页 / 数字页…): 按键只在这之间循环
 * 负数只保留给上面这几个特殊页; 0..PAGE_MAX 是原有范围。 */
export const PAGE_OFF = -1
export const PAGE_CHARGE = -2
export const PAGE_LOWBAT = -3
export const PAGE_LOGO = -4
export const PAGE_MIN = PAGE_LOGO
export const PAGE_MAX = 9
export const PAGE_SPECIAL = {
  [PAGE_OFF]: '关机空白', [PAGE_CHARGE]: '关机充电', [PAGE_LOWBAT]: '低电', [PAGE_LOGO]: '开机LOGO',
}
/** 特殊页在"每页事实"宏里的名字: -4 → LCD_HAS_LOGO_PAGE */
const SPECIAL_FACT = { [PAGE_LOGO]: 'LOGO', [PAGE_CHARGE]: 'CHARGE', [PAGE_LOWBAT]: 'LOWBAT' }

/** C 函数名里的页后缀: 0 → Page0, -2 → PageCharge, -3 → PageLowBat, -4 → PageLogo */
export const pageLabel = (n) => {
  const v = Math.round(+(n ?? 0)) || 0
  if (v === PAGE_OFF) return 'PageOff'
  if (v === PAGE_CHARGE) return 'PageCharge'
  if (v === PAGE_LOWBAT) return 'PageLowBat'
  if (v === PAGE_LOGO) return 'PageLogo'
  return v < 0 ? 'PageSpec' + Math.abs(v) : 'Page' + v
}
/** 合法化页号: 允许 -4..-2 与 0..9; -1 是空白页 (放不了图层) → fallback */
export function normalizePage(v, fallback = 0) {
  const n = Math.round(+(v ?? NaN))
  if (!Number.isFinite(n)) return fallback
  if (n === PAGE_OFF) return fallback
  if (n < PAGE_MIN) return PAGE_MIN
  if (n > PAGE_MAX) return PAGE_MAX
  return n
}
/**
 * 图层属于**哪些页** (一个图层可以同时活在多页):
 *   · 单页: inst.page (老工程照旧, 'main' 之类名字归 0 页)
 *   · 多页: inst.pages = [0, 1, …] (页输入框里写 "0,1" 就是它; 圆环同样支持)
 * 导出时**素材/帧只出这一份**, 但每一页的 Enter 都会画它 —— 多页不额外花 flash。
 */
export function pageNums(it) {
  const raw = (Array.isArray(it?.pages) && it.pages.length) ? it.pages : [it?.page]
  const out = []
  for (const p of raw) {
    const n = normalizePage(p, null)
    if (n != null && !out.includes(n)) out.push(n)
  }
  if (!out.length) out.push(0)
  return out
}
/**
 * 删页时把"跳向 from 的定时跳转"改指 to —— 页号没了, 但它的内容挪到 to 了,
 * 跳转跟着内容走比直接清零更符合预期。纯函数 (面板与自检共用)。
 */
export function retargetJumps(pages, from, to) {
  const out = { ...(pages || {}) }
  for (const k of Object.keys(out)) {
    const cfg = out[k]
    if (cfg && typeof cfg === 'object' && cfg.jumpTo != null && Math.round(+cfg.jumpTo) === from)
      out[k] = { ...cfg, jumpTo: to }
  }
  return out
}

/**
 * 整理页号: 把"用到的正常页"按顺序压成 0..k (特殊页 -4/-3/-2 不动)。
 * 「用到」= 有图层, 或被别的页跳转指着, 或 state.pages 里有设置 (周期/跳转/隐藏) ——
 * 纯占位的空页号会被丢掉。返回 { items, pages } (只含需要改的项, 面板写回即可)。
 * 典型场景: 只有一层在图 9 页 → 列表里冒出 1..8 八个空页; 整理一次就回到 0/1。
 */
export function compactPlanPages(items, pageMap) {
  const used = new Set()
  for (const it of items || []) for (const n of pageNums(it)) if (n >= 0) used.add(n)
  const cfgOf = (k) => { const p = pageMap?.[k]; return (p && typeof p === 'object') ? p : null }
  for (const k of Object.keys(pageMap || {})) {
    const n = Math.round(+k)
    if (n < 0) continue
    const c = cfgOf(k)
    if (c && (c.period || c.jumpMs || c.hidden)) used.add(n)
    if (c && c.jumpTo != null) { const jt = Math.round(+c.jumpTo); if (jt >= 0) used.add(jt) }
  }
  const normals = [...used].sort((a, b) => a - b)
  const map = new Map(normals.map((n, i) => [n, i]))
  const itemsOut = []
  for (const it of items || []) {
    const cur = pageNums(it)
    const next = [...new Set(cur.map(n => (n >= 0 && map.has(n) ? map.get(n) : n)))].sort((a, b) => a - b)
    if (!next.length) continue
    if (next.join(',') !== cur.join(','))
      itemsOut.push({ id: it.id, pages: next.length === 1 ? undefined : next, page: next[0] })
  }
  const pagesOut = {}
  for (const k of Object.keys(pageMap || {})) {
    const n = Math.round(+k)
    const v = pageMap[k]
    if (n >= 0 && !map.has(n)) continue             /* 纯占位空页: 丢掉 */
    const nv = (v && typeof v === 'object') ? { ...v } : v
    /* 跳转目标也要跟着重编号 —— 特殊页 (-4/-3/-2) 自己的号不变, 但它跳向哪一页要改 */
    if (nv && typeof nv === 'object' && nv.jumpTo != null) {
      const jt = Math.round(+nv.jumpTo)
      nv.jumpTo = (jt >= 0 && map.has(jt)) ? map.get(jt) : undefined
    }
    pagesOut[n < 0 ? n : map.get(n)] = nv
  }
  return { items: itemsOut, pages: pagesOut }
}

/**
 * 删掉某一页时, 落在它上面的图层要挪到哪 —— 纯数据计算 (面板与自检共用一份规则):
 *   · 这一层还在别的页上 → 只把 page n 去掉 (pages 收窄)
 *   · 只在被删的那一页上 → 整层挪到 dest (默认第 0 页, 也就是主页面)
 * 返回 [{ id, pages, page }] (pages=undefined 表示单页, 与 store 的存法一致)。
 */
export function retargetAfterPageRemove(items, n, dest = 0) {
  const out = []
  for (const it of items || []) {
    const cur = pageNums(it)
    if (!cur.includes(n)) continue
    const rest = cur.filter(x => x !== n)
    const pages = rest.length ? rest : [dest]
    out.push({ id: it.id, pages: pages.length === 1 ? undefined : pages, page: pages[0] })
  }
  return out
}

/**
 * 图层属于哪一页 (取第一个) —— **页号就是序号 (0,1,2…), 序号即调用顺序**:
 * 导出成 LCD_Page0_Enter / LCD_Page1_Enter …, 切页 LCD_UI_Goto(sys.page) 按序号走。
 * 老工程里存的 'main' 之类名字统一归到 0 页。
 */
export const pageNum = (it) => pageNums(it)[0]     /* 多页时取第一页 (pages 优先) */

/**
 * 图层计划 → 页面刷新文件 (ui_task.c)。
 *
 * **page 是唯一的"显示内容"真值** (负数留给特殊页, 按键进不去):
 *   · `LCD_<页>_Enter()`: 静态图层按 z 序画一遍 + 每个数字画一遍 + 有圆环就 SetBg/Start,
 *     再启动这一页的周期定时器 (数字刷新) 和**定时跳转**定时器 (网页上配了才启);
 *   · `LCD_<页>_Exit()`: 停圆环 / 停周期刷新 / 停跳转 (幂等);
 *   · `LCD_<页>_CB()`: 周期到点把这一页的数字重刷一遍 (整页共用一个周期, 在「页面」里设置);
 *   · `LCD_<页>_Jump()`: 定时跳转 → 到点自己 `LCD_UI_Goto(目标页)` (LOGO 页就是这么自动走的);
 *     `timer_init(t, cb, N, 0, 0)` = N 毫秒后**只触发一次** (第三参是首次延迟, 第四参 0 = 不重复);
 *   · `LCD_UI_Setup()`: 全局一次 (停干净 → 设表 → UI_Init), **不进页**;
 *   · `LCD_UI_Goto(page)`: 出旧页 → 清屏 → 进新页; >=0 正常页 / -2 关机充电 / -3 低电 / -1 空白;
 *   · `LCD_UI_NextPage(cur)`: 按键切页 (只在 >=0 的正常页里循环);
 *   · `LCD_UI_Page()`: 当前页 (空白 = -1)。
 * 图层/圆环用 inst.page 归属页面 (数字, 老的 'main' 名字归 0 页)。
 * @param plan collectLayerPlan 的结果 (需要 page / bind / fontTable / kind='ring')
 * @param opt  { lcdHeader, scrW, scrH }   LCD 头与屏幕尺寸 (清屏用)
 */
export function taskCodeFor(plan, opt = {}) {
  const items = (plan?.items || [])
  if (!items.length) return ''
  /* 新格式 (LZSS) 用顶层 UI_DrawFrame(id, color); 旧的 raw 导出仍用指针版, 保持现固件可编 */
  const idDraw = planHasLzss(plan)
  const list = pageSettingsFor(plan, pageListFor(plan))
  const dyn = items.filter(i => i.bind)
  const st = items.filter(i => i.kind !== 'ring' && !i.bind)

  /* 变量在 g_uiFields 里的下标 = 动态项的出现顺序 (与 exportTable 一致) */
  dyn.forEach((it, idx) => { it._fld = idx })
  /* 静态项在 g_uiFrames 里的下标 = 非动态项的出现顺序 (与 exportTable 一致) */
  st.forEach((it, idx) => { it._frm = idx })

  const scrW = Math.max(1, Math.round(opt.scrW || plan.screen?.w || 240))
  const scrH = Math.max(1, Math.round(opt.scrH || plan.screen?.h || 240))
  const hasRing = list.some(p => p.rings.length)
  const L = [`/*
 * 由 MCU-LCD-Editer 导出: 页面任务 (page 是唯一的"显示内容"真值)
 *   正常页 >=0: LCD_Page<n>_Enter / Exit (+ CB 周期刷数字 + 可选的定时跳转);
 *   特殊页 -4 开机 LOGO / -2 关机充电 / -3 低电: 只有固件状态机能进 (按键进不去);
 *   -1 = 空白页: 没有内容, Goto(-1) = 出旧页 + 停刷新/停圆环 + 清屏。
 * 用法: 面板初始化后调 LCD_UI_Setup() 一次; 之后切页只用 LCD_UI_Goto(page);
 *       main loop 里跑 timer_loop() (页面定时器 / 定时跳转靠它驱动)。
 */
#include "multi_timer.h"
#include "ui_task.h"
#include "ui_table.h"                 /* g_uiFields / g_uiFrame* / 字库 的声明 */
#include "app_ui.h"
#include "ui_user.h"                 /* 你的变量声明/宏 (这个文件不会被导出覆盖) */
#include "${opt.lcdHeader || 'bsp_gc9a01.h'}"      /* LCD_Fill / LCD_drawGrayImage (屏幕预设里的 LCD 头) */
${hasRing ? '#include "bsp_ring.h"            /* 这一套页面里有圆环: Ring_Start/Ring_Stop/Ring_SetBg */\n' : ''}
/* 切页清屏色 = 屏幕底色 (屏幕预设里的「背景色」; 预览/导出图片/这里三者同一个值)
 * 圆环的 AA 也按它往底色淡出 */
#define UI_PAGE_BG ${colorMacroName(plan.screen?.bg ?? 0x0000)}

/* ★ 进页清屏钩子 (2026-10-14): 默认整屏擦一次 (普通切换要干净背景)。
 * 工程在 ui_user.h (导出不覆盖它) 里 #define UI_PAGE_CLEAR() 即可覆盖:
 *   · 空操作 —— 全屏擦除只在 LCD 初始化 (SPI/面板配置完) 后做一次, 切页永不
 *     整屏擦, 背景由固件自己管 (逐符号擦除 / 免擦除进页那一套);
 *   · 或换成局部擦除 / 带 TE 同步, 随工程。 */
#ifndef UI_PAGE_CLEAR
#define UI_PAGE_CLEAR()  ${hasRing ? `do { LCD_Fill(0, 0, ${scrW}, ${scrH}, UI_PAGE_BG); Ring_ScreenInvalidate(); } while (0)` : `LCD_Fill(0, 0, ${scrW}, ${scrH}, UI_PAGE_BG)`}
#endif

/* 页变了通知固件 (可选): 在 ui_user.h 里写
 *   #define UI_PAGE_CHANGED(p)  (sys.page = (int8_t)(p))
 * LOGO 页的"定时跳转"就是在这里跳的 —— 固件不知道的话, 状态机下一拍会按它自己的
 * sys.page 把画面拽回去。不定义 = 空操作。 */
#ifndef UI_PAGE_CHANGED
#define UI_PAGE_CHANGED(p) ((void)(p))
#endif
`]

  for (const p of list) {
    const lbl = pageLabel(p.n)
    const role = p.n < 0 ? ` (${PAGE_SPECIAL[p.n] || '特殊页'})` : ''
    L.push('')
    if (p.hidden) L.push(`/* ===== 页面 ${p.n}${role}: **被隐藏** —— 进去只清屏, 等新的状态 (内容不导出) ===== */`)
    else L.push(`/* ===== 页面 ${p.n}${role}: 静态 ${p.statics.length} 层` +
      (p.dyns.length ? ` + 数字 ${p.dyns.length} 个 (周期 ${p.period}ms)` : '') +
      (p.rings.length ? ` + 圆环 ${p.rings.length} 个` : '') +
      (p.jumpMs ? ` · ${p.jumpMs}ms 后自动跳页 ${p.jumpTo}` : '') + ` ===== */`)
    /* 隐藏: 整页内容/定时器都不生成 (Goto 里的清屏已经做过), Enter/Exit 留空壳给状态机用 */
    if (p.hidden) {
      L.push(`void LCD_${lbl}_Enter(void)`)
      L.push('{')
      L.push('    /* 被隐藏: 切页时已经清屏 (LCD_Fill), 这里什么都不画 —— 等固件给新的状态。')
      L.push('     * 要恢复显示: 回网页把这一页的「隐藏」关掉再导出。 */')
      L.push('}')
      L.push(`void LCD_${lbl}_Exit(void)`)
      L.push('{')
      L.push('    /* 被隐藏: 没有刷新/圆环/跳转要收尾 */')
      L.push('}')
      continue
    }
    if (p.dyns.length) {
      L.push(`static struct Timer g_uiTmr_${lbl};`)
      L.push(`static void LCD_${lbl}_CB(void *arg)`)
      L.push('{')
      L.push('    (void)arg;')
      /* ！周期回调只做"值变化检测", **不再无条件整页重画** (2026-10-13):
       *   · UI_FIELD 引擎自带 drawn/last (UI_DrawField 内部维护) —— 值没变一个像素都不动,
       *     电池档位/倒计时秒数不变时这里完全静默 (以前每 200ms 重画一遍静态帧,
       *     会把充电动画/动态层刷回去, 固件侧还得打补丁摘除);
       *   · 数字是整格涂底的, 值变化重画后, 压在它上面的静态层会被擦掉 —— 所以只补画
       *     **与数字区域几何相交**的帧 (z 序在数字之上); 不相交的帧 (如角落的电池图标)
       *     归属各自的动态层/动画, 周期回调碰都不碰。 */
      const seq = dynRedrawSeq(p)
      const fields = []            // [{it, overs:[...]}] 每个数字区域 + 与它相交的上层帧
      for (const it of seq) {
        if (it.bind) fields.push({ it, overs: [] })
        else if (fields.length) {
          const f = fields[fields.length - 1].it
          const hit = (it.x < f.x + f.w) && (f.x < it.x + it.w)
                    && (it.y < f.y + f.h) && (f.y < it.y + it.h)
          if (hit) fields[fields.length - 1].overs.push(it)
        }
      }
      for (let fi = 0; fi < fields.length; fi++) {
        const { it, overs } = fields[fi]
        const i = it._fld
        L.push(`    {`)
        L.push(`        int32_t v = (g_uiFields[${i}].src != 0) ? *(g_uiFields[${i}].src) : 0;`)
        L.push(`        if ((g_uiFields[${i}].drawn == 0u) || (v != g_uiFields[${i}].last))`)
        L.push(`        {`)
        L.push(`            UI_DrawField(&g_uiFields[${i}]);        /* ${it.bind.name} */`)
        for (const ov of overs) {
          const col = colorMacroName(ov.color == null ? 0xFFFF : ov.color)
          const call = idDraw ? `UI_DrawFrame(${ov._frm}, ${col})` : `UI_DrawFrame(&g_uiFrame${ov._frm}, ${col})`
          L.push(`            ${call};   /* ${ov.name || ov.key} (与数字区域相交, z 序在其上) */`)
        }
        L.push(`        }`)
        L.push(`    }`)      /* ！关掉字段块的局部作用域 —— 少这行会让后续函数嵌进本 CB (gcc: invalid storage class for function) */
      }
      L.push('}')
    }
    if (p.jumpMs) {
      L.push(`static struct Timer g_uiJump_${lbl};`)
      L.push(`static void LCD_${lbl}_Jump(void *arg)`)
      L.push('{')
      L.push('    (void)arg;')
      L.push(`    LCD_UI_Goto(${p.jumpTo});                /* 定时跳转: 这一页到点自己走 */`)
      L.push('}')
    }
    L.push(`void LCD_${lbl}_Enter(void)`)
    L.push('{')
    if (pageDrawSeq(p).length) {
      L.push('    /* 初始化显示内容: 按图层 z 序 (静态帧 / 数字混排 —— 与网页预览同一套叠加顺序) */')
      for (const it of pageDrawSeq(p)) {
        if (it.bind) {
          L.push(`    UI_DrawField(&g_uiFields[${it._fld}]);        /* ${it.bind.name} */`)
        } else {
          const col = colorMacroName(it.color == null ? 0xFFFF : it.color)
          const call = idDraw ? `UI_DrawFrame(${it._frm}, ${col})` : `UI_DrawFrame(&g_uiFrame${it._frm}, ${col})`
          L.push(`    ${call};`)
        }
      }
    }
    if (p.rings.length) {
      L.push('    /* 这一页有圆环: 先对齐底色再启动 (参数在 ring_config.h) */')
      L.push('    Ring_SetBg(UI_PAGE_BG);')
      L.push('    Ring_Start(RING_GEAR_DEF, RING_DIR_DEF);')
    }
    if (p.dyns.length) {
      /* timer_init(handle, cb, 首次延迟, 周期, arg) —— 第三个是**首次到期时间**:
       * multi_timer 的 timer_start 把 cur_expired_time 设成 timeout, 写 0 会"下一拍就刷"。
       * 进页面已经画过一遍了, 所以首次等一个周期再刷。 */
      L.push(`    timer_init(&g_uiTmr_${lbl}, LCD_${lbl}_CB, ${p.period}, ${p.period}, 0);`)
      L.push(`    timer_start(&g_uiTmr_${lbl});`)
    }
    if (p.jumpMs) {
      L.push(`    /* 定时显示: ${p.jumpMs}ms 后自动进页 ${p.jumpTo} (第三参 = 首次延迟; repeat=0 = 一次性, 出页会取消) */`)
      L.push(`    timer_init(&g_uiJump_${lbl}, LCD_${lbl}_Jump, ${p.jumpMs}, 0, 0);`)
      L.push(`    timer_start(&g_uiJump_${lbl});`)
    }
    L.push('}')
    L.push(`void LCD_${lbl}_Exit(void)`)
    L.push('{')
    if (p.rings.length) L.push('    Ring_Stop();                     /* 先停圆环, 免得它的中断还在往屏上画 */')
    if (p.dyns.length) L.push(`    timer_stop(&g_uiTmr_${lbl});`)
    if (p.jumpMs) L.push(`    timer_stop(&g_uiJump_${lbl});     /* 提前离开就取消定时跳转 */`)
    if (!p.rings.length && !p.dyns.length && !p.jumpMs) L.push('    /* 这一页没有动态内容/圆环/跳转, 不用收尾 */')
    L.push('}')
  }

  const specials = list.filter(p => p.n < 0)
  const normalPages = list.filter(p => p.n >= 0)
  const visible = normalPages.filter(p => !p.hidden).map(p => p.n)
  /* 按键只在"没被隐藏"的正常页之间循环; 全隐藏了 (极端) 就退回全部, 免得数组为空跑飞 */
  const userPages = visible.length ? visible : normalPages.map(p => p.n)
  const cases = (kind) => list.map(p => `    case ${p.n}: LCD_${pageLabel(p.n)}_${kind}(); break;`).join('\n')
  L.push('')
  L.push('static int8_t s_page = -1;        /* -1 = 还没进过任何页 (就是空白页) */')
  L.push('')
  L.push('int8_t LCD_UI_Page(void)')
  L.push('{')
  L.push('    return s_page;')
  L.push('}')
  L.push('')
  L.push('/* 出当前页: 停刷新 / 停圆环 / 停跳转 (幂等; 不画面) */')
  L.push('static void ui_exit_all(void)')
  L.push('{')
  L.push('    switch (s_page) {')
  L.push(cases('Exit'))
  L.push('    default: break;                  /* -1: 没有旧页 */')
  L.push('    }')
  L.push('}')
  L.push('')
  L.push('/* 进目标页: 画内容 + 启刷新/圆环/跳转 (不处理旧页) */')
  L.push('static void ui_enter(int8_t page)')
  L.push('{')
  L.push('    switch (page) {')
  L.push(cases('Enter'))
  L.push('    default: break;                  /* -1: 空白页, 没有内容 */')
  L.push('    }')
  L.push('}')
  L.push('')
  L.push('/* 切页: 出旧页 → 清屏 → 进新页。')
  L.push(' * page = 0..LCD_PAGE_N-1 正常页; -2 关机充电; -3 低电; -1/越界 = 空白页 (不进任何页)。 */')
  L.push('void LCD_UI_Goto(int8_t page)')
  L.push('{')
  L.push('    if (page >= LCD_PAGE_N) page = -1;              /* 正常页越界 → 空白 */')
  if (specials.length) {
    L.push('    if (page < -1) {                                /* 负数是保留给特殊页的 */')
    L.push('        switch (page) {')
    for (const p of specials) L.push(`        case ${p.n}: break;                       /* ${PAGE_SPECIAL[p.n] || '特殊页'} */`)
    L.push('        default: page = -1; break;                  /* 没导出 / 不认识 → 空白 */')
    L.push('        }')
    L.push('    }')
  } else {
    L.push('    if (page < 0) page = -1;                        /* 这一套没有特殊页: 负数一律空白 */')
  }
  L.push('    if (page == s_page) return;                     /* 已经是这一页 (含 -1 → -1) */')
  L.push('    ui_exit_all();                                  /* 停刷新 + 停圆环 + 停跳转 */')
  L.push('    UI_PAGE_CLEAR();                                /* 进页清屏 (钩子: 默认整屏擦, ui_user.h 可覆盖成空操作/局部擦) */')
  L.push('    s_page = page;')
  L.push('    ui_enter(page);')
  L.push('    UI_PAGE_CHANGED(s_page);                        /* 通知固件: 定时跳转后 sys.page 跟着走 */')
  L.push('}')
  L.push('')
  L.push('/* 按键切页: 只在 >=0 的正常页里循环 (特殊页只有固件状态机能进) */')
  L.push('int8_t LCD_UI_NextPage(int8_t cur)')
  L.push('{')
  if (userPages.length) {
    if (!visible.length) L.push('    /* 注意: 所有正常页都被隐藏了 —— 按键循环退回全部页 (进去是清屏) */')
    L.push(`    static const int8_t user[] = { ${userPages.join(', ')} };`)
    L.push('    uint8_t i;')
    L.push('    if (cur < 0 || cur >= LCD_PAGE_N) return user[0];       /* 特殊页/空白 → 回第一页 */')
    L.push('    for (i = 0; i < sizeof(user) / sizeof(user[0]); i++)')
    L.push('        if (user[i] == cur) return user[(i + 1) % (sizeof(user) / sizeof(user[0]))];')
    L.push('    return user[0];')
  } else {
    L.push('    (void)cur;')
    L.push('    return -1;                                      /* 一页都没有 */')
  }
  L.push('}')
  L.push('')
  L.push('/* 全局一次: 设表 + UI_Init; **不进任何页** (面板每次重新初始化后调一次) */')
  L.push('void LCD_UI_Setup(void)')
  L.push('{')
  L.push('    ui_exit_all();                                  /* 上一次还在跑的刷新/圆环/跳转先停干净 */')
  L.push('    UI_SetFields(g_uiFields, UI_FIELD_N);')
  L.push('    UI_Init();')
  L.push('    s_page = -1;')
  L.push('}')
  return L.join('\n') + '\n'
}

/** 注释里塞用户写的图层名: 名字里可能有注释终止符或换行, 直接放进去会把 C 注释截断 */
const cCommentText = (s) => String(s ?? '').replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ').trim().slice(0, 40)

/** 帧选择 (网页"帧"输入框, 0 基, 与内部值同口径) → UI_FRAME_REF.index:
 *   · 0..N-1 = 画 px 数组里的第几帧 (px 是数组首地址, 偏移由固件按 index 算);
 *   · -1 (网页: 仅网页渲染) → 255: MCU 侧 UI_DrawFrame 只清底色 UI_BG_COLOR, 不渲染。
 *  没勾"导出所有帧"的层, 数组里就选中那一张图 → 0 (选帧已经烘进像素了)。 */
const uiFrameIndex = (it) => {
  if (it.frame != null && it.frame < 0) return 255
  return it.allFrames ? Math.max(0, it.frame || 0) : 0
}

/** 帧表成员 → 帧表条目 (两条导出路径共用; 下标 i = UI_DrawStatic 里的 g_uiFrame<i>) */
const frameEntryFor = (it) => ({
  name: it.key,
  x: it.x, y: it.y, w: it.w, h: it.h,
  lineH: it.lineH,
  /* 勾了"导出所有帧"的层按**像素实际格式** (allFrames.gray), 不按图层 fmt 勾选 */
  fmt: it.allFrames ? (it.allFrames.gray ? 1 : 0) : it.fmt,
  mirror: it.mirror,
  index: uiFrameIndex(it),
  /* 「仅尺寸」: .px 写 0 —— 帧表只提供坐标/尺寸, 不映射到任何数组 (素材因此可被回收);
   * ！与「仅素材」一起勾时像素照常导出, 但 .px 仍是 0 (文件里那些数组靠 ui_table.h 的
   *   extern 给固件按名自取)。 */
  pxZero: !!it.sizeOnly || !!it.lzss,
  lzss: it.lzss || null,
  _ext: it.ext, _item: it,
})

/** 帧表成员 → UI_DrawStatic() 的函数体。
 *  帧表条目 (g_uiFrameN) **一个都不少** (仅素材/仅尺寸的也要留着给固件按名自取), 这里只画
 *  "进页就该出现"的层 —— 判据是 drawnByPage(): 「仅素材」(画不画由固件定) 与
 *  「仅尺寸」(.px = 0, 只给坐标/尺寸) 都不进。
 *  帧号在这里不参与过滤: -1 的层照样进 DrawStatic, MCU 侧按 .index=255 清底色。
 *  ！跳过的层仍占帧表序号 → 必须按 framed 的**原始下标**写 g_uiFrameN, 否则画到别人的帧上。
 *  ！帧选择不在调用参数里 (UI_DrawFrame 只收"帧表项 + 颜色"): 选中的那一帧走 .index,
 *    这里附一行小注释方便对账。 */
function staticDrawBlock(framed, idDraw = false) {
  const draws = [], skipped = []
  framed.forEach((it, i) => {
    const nm = cCommentText(it.name || it.key || '')
    if (!drawnByPage(it)) {
      const mode = it.assetOnly && it.sizeOnly ? '仅尺寸+仅素材' : (it.assetOnly ? '仅素材' : '仅尺寸')
      skipped.push(`g_uiFrame${i}${nm ? ` (${nm} · ${mode})` : ''}`)
      return
    }
    const col = colorMacroName(it.color == null ? 0xFFFF : it.color)
    const idx = uiFrameIndex(it)
    const note = (idx === 255)
      ? `${nm ? nm + ' · ' : ''}帧=-1: 仅网页渲染 — MCU 只清底色`
      : (it.allFrames ? `${nm ? nm + ' · ' : ''}第 ${idx + 1}/${it.allFrames.count} 帧 (选帧走 .index)` : '')
    const call = idDraw ? `UI_DrawFrame(${i}, ${col})` : `UI_DrawFrame(&g_uiFrame${i}, ${col})`
    draws.push(`    ${call};${note ? '        /* ' + note + ' */' : ''}`)
  })
  return ['/* 静态图层绘制: 由图层列表自动生成 (进页面调用一次) */',
          'void UI_DrawStatic(void)',
          '{',
          ...(draws.length ? draws
            : [skipped.length ? '    /* 这一套的静态层都是仅素材: 进页不画 (帧表条目仍在, 固件按需自取) */'
                              : '    /* 没有静态图层 */']),
          ...(skipped.length ? [`    /* 不进这里 (帧表条目仍在, 固件按需 UI_DrawFrame 自取): ${skipped.join(', ')} */`] : []),
          '}'].join('\n')
}

/**
 * 计划 → 表文件内容 (帧表 + 动态区域 + 静态绘制), 与像素数据无关; 字模数据在 fontFileFor。
 * 动态图层 (带 bind) **不占素材**: 固件用字库在它的位置上画数字, 它自己的像素既不画也不导出,
 * 所以帧表里也不能出现 (否则 .px 指向一个不存在的数组, 编不过) —— 这也是"值"能省 flash 的原因。
 */
export function tableForPlan(plan) {
  const res = plan.items.filter(i => i.kind !== 'ring' && !i.bind)   // 需要像素数组的静态资源 (圆环不进表)
  const frames = res.map(frameEntryFor)
  const dyn = plan.items.filter(i => i.bind)
  const fields = dyn.map(it => ({
    type: it.bind.type || 'num',
    dec: it.bind.dec || 0, align: it.bind.align || 1, cells: it.bind.cells || 0,
    pad: it.bind.pad ? 1 : 0, x: it.x, y: it.y,
    color: it.color, bg: it.bind.bg == null ? 0xFFFF : it.bind.bg,
    srcName: it.bind.name, fontName: it.fontTable?.name || it.bind.fontName || 'g_uiFontNum8x11',
  }))
  const statics = staticDrawBlock(res, planHasLzss(plan))
  return tableFileHead(plan) +
    exportTable(frames, fields, { name: 'ui_table', store: 'both', head: false, lzss: planHasLzss(plan) }) +
    `

${statics}
`
}

/**
 * 计划 → 字模**代码**文件内容 (ui_font.c): 取图/取帧函数 + 数字字库的 UI_FONT 结构体。
 * **字模数组/字模表都不在这里** —— 它们是像素数据, 走 fontDataFor() 进 ui_assets_*.c
 * (数据与代码分对象: 字模被放进外部 Flash 时才不会把函数/结构体一起拖过去)。
 * 没有任何字模 (没有数字层、也没有文字层字模表) 时返回 '' —— 调用方就别写这个文件。
 */
export function fontFileFor(plan, opt = {}) {
  const p = fontPartsFor(plan, opt)
  if (!p.code.trim()) return ''
  return fontFileHead({ needLcd: p.needLcd, lcdHeader: opt.lcdHeader, lzss: planHasLzss(plan) }) + p.code
}

/** 字模**数据** (数字字模数组 + 文字层/ASCII 字模表): 按各图层的「外部」选择分别并进
 *  ui_assets_int.c / ui_assets_ext.c。
 *  @returns { int, ext }  两段文本 (可能为空串) */
export function fontDataFor(plan, opt = {}) {
  const { intData, extData } = fontPartsFor(plan, opt)
  return { int: intData, ext: extData }
}

/**
 * 计划 → 固件文件
 * @param plan   collectLayerPlan 的结果
 * @param pixels (item) => { gray:Uint8Array } | { rgb:Uint16Array } | null   由调用方提供
 * @param opt    { ringConfig: string, lcdHeader: string }
 *               ringConfig = ring_config.h 的内容; lcdHeader = 屏幕预设里的 LCD 头 (文字层函数要用)
 */
export function planToFiles(plan, pixels, opt = {}) {
  /* 坐标类型自动判定: 画布或任一图层右/下边缘超出 255 → 坐标参数一律 uint16_t
   * (uint8_t 会静默截断 x=256..319 → 0..63)。导出器算一次, ui_table.h 里再用
   * #if 编译期校验一次 (见 tableHeaderFor 的 UI_EXP_COORD_MAX 块)。 */
  let coordMax = Math.max(+opt.scrW || 0, +opt.scrH || 0)
  for (const it of plan?.items || []) {
    coordMax = Math.max(coordMax, (+it.x || 0) + (+it.w || 0), (+it.y || 0) + (+it.h || 0))
  }
  const coord16 = coordMax > 255
  /* 动态图层不导出像素 (固件画数字, 不用这些字节) */
  const ints = plan.items.filter(i => i.kind !== 'ring' && !i.ext && !i.lzss && !i.bind && pixelExported(i))
  const exts = plan.items.filter(i => i.kind !== 'ring' && i.ext && !i.bind && pixelExported(i))
  const mkAssets = (list) => list.map(it => {
    const px = pixels(it)
    if (!px) return null
    return { name: it.key, w: it.w, h: it.h, gray: px.gray, rgb: px.rgb }
  }).filter(Boolean)

  const intA = mkAssets(ints), extA = mkAssets(exts)

  /* 帧表成员 = 帧表条目与 UI_DrawStatic() 的公共来源 (下标必须一一对应) */
  const framed = plan.items.filter(i => i.kind !== 'ring' && !i.bind)
  /* 帧表 (两种存储共用一份, 指针分流由固件按地址判断) */
  const frames = framed.map(frameEntryFor)
  /* 动态区域: 只有绑定了参数的图层进表; 其余是静态绘制 */
  const dyn = plan.items.filter(i => i.bind)
  const fields = dyn.map(it => ({
    type: it.bind.type || 'num',
    dec: it.bind.dec || 0, align: it.bind.align || 1, cells: it.bind.cells || 0,
    pad: it.bind.pad ? 1 : 0, x: it.x, y: it.y,
    color: it.color, bg: it.bind.bg == null ? 0xFFFF : it.bind.bg,
    srcName: it.bind.name, fontName: it.fontTable?.name || it.bind.fontName || 'g_uiFontNum8x11',
  }))
  const needFont = fields.some(f => f.type === 'num')

  const common = `${exportTable(frames, fields, { name: 'ui_table', store: 'both', head: false, lzss: planHasLzss(plan) })}

${staticDrawBlock(framed, planHasLzss(plan))}
`

  const taskC = taskCodeFor(plan, { lcdHeader: opt.lcdHeader, scrW: opt.scrW, scrH: opt.scrH })
  const fontC = fontFileFor(plan, { lcdHeader: opt.lcdHeader, coord16 })
  const fdata = fontDataFor(plan)      /* 数字字模: 按图层的「外部」选择并进素材文件 */
  const files = [
    { name: 'ui_color.h', text: buildColorHeader(collectUsedColors(plan, plan.screen)) },
    { name: 'ui_assets_int.c', text: exportAssets(intA, { store: 'int', uitable: true, extra: fdata.int }) },
    { name: 'ui_assets_ext.c', text: exportAssets(extA, { store: 'ext', uitable: true, extra: fdata.ext }) },
    { name: 'ui_table.h', text: tableHeaderFor(plan, { coordMax }) },
    ...(fontC ? [{ name: 'ui_font.c', text: fontC }] : []),      // 字模单独一个文件 (几千行)
    { name: 'ui_table.c', text: tableFileHead(plan) + common },      // 纯属性表 (几十行)
    ...(taskC ? [{ name: 'ui_task.c', text: taskC }, { name: 'ui_task.h', text: taskHeaderFor(plan) }] : []),
    { name: 'ui_user.h', text: userHeaderFor(plan), once: true },   // once = 已存在就不覆盖
  ]
  if (opt.ringConfig) files.unshift({ name: 'ring_config.h', text: opt.ringConfig })
  return {
    files,
    stat: {
      int: intA.length, ext: extA.length, dyn: fields.length, frames: frames.length,
      rings: plan.items.filter(i => i.kind === 'ring').length,
      pages: Math.max(0, ...plan.items.map(i => pageNum(i))) + 1,
    },
  }
}
