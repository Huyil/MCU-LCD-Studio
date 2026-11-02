/*
 * store 行为自检 (零依赖: node scripts/check-store.mjs)
 *
 * 覆盖:
 *   1) 撤回/重做: 删除实例后可撤回恢复, 重做再次删除 (防误删)
 *   2) 可用像素区: addRingInstance 按预设的可用圆取默认直径与圆心
 *   3) 深拷贝: duplicateInstance 不再与原实例共享 ring 对象
 *
 * Node 下用最小桩替换浏览器 API; 不启动任何服务器。
 */
import fs from 'node:fs'

globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null },
  setItem(k, v) { this._m.set(k, String(v)) },
}
globalThis.indexedDB = { open() { throw new Error('no idb in node') } }
globalThis.fetch = async () => { throw new Error('no net in node') }

const { state, initPersistence, addRingInstance, removeInstance, duplicateInstance, undo, redo, screen, usableDiameter, inPaintBox, hitInstance }
  = await import('../src/store.js')

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

initPersistence()
state.instances = []          // 清掉可能存在的存档
await sleep(500)

/* ---- 1. 撤回 / 重做 ---- */
const ring = addRingInstance()
const rid = ring.id
await sleep(500)
ok('新建实例后可撤回', state.ui.canUndo === true)
removeInstance(rid)
await sleep(500)
ok('删除后实例消失', state.instances.length === 0)
ok('删除后可撤回', undo() === true)
ok('撤回恢复被删实例', state.instances.length === 1 && state.instances[0].id === rid)
ok('撤回后可重做', state.ui.canRedo === true)
ok('重做再次删除', redo() === true && state.instances.length === 0)

/* ---- 2. 可用像素区驱动圆环默认几何 ---- */
state.presets[0].maskR = 118
state.presets[0].maskCx = 122
state.presets[0].maskCy = 120
state.activePresetId = state.presets[0].id
ok('usableDiameter 跟随可用圆', Math.round(usableDiameter(screen.value)) === 236)
const r2 = addRingInstance()
ok('圆环默认外径 = 可用圆直径', Math.round(r2.ring.rOut * 2) === 236, `Ø=${Math.round(r2.ring.rOut * 2)}`)
ok('圆环默认圆心 = 可用圆心', Math.round(r2.x + r2.w / 2) === 122 && Math.round(r2.y + r2.h / 2) === 120)
delete state.presets[0].maskR; delete state.presets[0].maskCx; delete state.presets[0].maskCy

/* ---- 3. 复制实例深拷贝 ---- */
const copy = (duplicateInstance(r2.id), state.instances[state.instances.length - 1])
ok('复制实例 id 不同', copy.id !== r2.id)
ok('复制实例 ring 不再共享引用', copy.ring !== r2.ring)
copy.ring.rOut = 10
ok('改副本不影响原实例', r2.ring.rOut !== 10)

/* ---- 4. 命中回退: proc 未就绪时必须退回包围盒 (否则点不中图层) ---- */
const fake = { id: 'fake', assetId: 'no-such-asset', kind: 'image', x: 10, y: 20, w: 30, h: 40 }
ok('inPaintBox 命中盒内', inPaintBox(fake, 10, 20) && inPaintBox(fake, 39, 59))
ok('inPaintBox 排除盒外', !inPaintBox(fake, 9, 20) && !inPaintBox(fake, 40, 59))
ok('hitInstance 无 proc 时退回包围盒', hitInstance(fake, 25, 40) === true)

/* ---- 5. 圆角矩形环导出 (ring_config.h): RING_SHAPE + Q8 几何必须与网页 ringRectGeomQ8 完全一致 ---- */
{
  const { buildRingConfig } = await import('../src/store.js')
  const { ringRectGeomQ8, ringRectTableR } = await import('../src/ringrender.js')
  const inst = r2
  inst.shape = undefined
  inst.w = 240; inst.h = 240; inst.x = 0; inst.y = 0
  Object.assign(inst.ring, { shape: 'rect', rad: 24, radIn: null, thick: 14, inset: 8, aa: 2,
                             glintOn: true, glintSigma: 14, glintSpanDeg: 42, depth: 0 })
  const txt = buildRingConfig()
  const num = (k) => {
    const m = txt.match(new RegExp('#define\\s+' + k + '\\s+(-?\\d+)'))
    return m ? Number(m[1]) : null
  }
  const G = ringRectGeomQ8(inst.w, inst.h, inst.ring)
  ok('圆角矩形导出: RING_SHAPE=1 (圆环那支走 0)', num('RING_SHAPE') === 1)
  ok('圆角矩形导出: Q8 几何与网页 ringRectGeomQ8 逐项一致',
     num('RING_HX') === G.hx && num('RING_HY') === G.hy && num('RING_RC') === G.rc &&
     num('RING_HT') === G.ht && num('RING_O_HX') === G.oHx && num('RING_O_HY') === G.oHy &&
     num('RING_O_RC') === G.oRc && num('RING_I_HX') === G.iHx && num('RING_I_HY') === G.iHy &&
     num('RING_I_RC') === G.iRc && num('RING_PER_Q8') === G.per && num('RING_INVPER') === G.invPer,
     `RING_HX=${num('RING_HX')} vs ${G.hx}`)
  ok('圆角矩形导出: R_OUT 只当"表容量" (倒数表覆盖的像素刻度)',
     num('RING_R_OUT') === ringRectTableR(G) && num('RING_R_IN') === 0, `R_OUT=${num('RING_R_OUT')}`)
  /* 边缘 AA 宽度: 板子 (bsp_ring.h 的 RING_RECT_AA_PX/_Q8/_INV_AA) 与网页 (G.aaQ8/G.invAa)
   * 必须从同一个导出宏推出来 —— 覆盖率斜坡两边同式才对得上 (对拍是逐像素比) */
  ok('圆角矩形导出: AA 斜坡宽度两边同一个整数推导 (aa_px = (X10+5)/10)',
     num('RING_COV_AA_X10') === Math.round((inst.ring.aa || 2) * 10) &&
     G.aaPx === Math.max(1, Math.floor((num('RING_COV_AA_X10') + 5) / 10)) &&
     G.aaQ8 === G.aaPx * 256 && G.invAa === Math.floor(65536 / G.aaQ8),
     `RING_COV_AA_X10=${num('RING_COV_AA_X10')} aaPx=${G.aaPx} aaQ8=${G.aaQ8} invAa=${G.invAa}`)
  ok('圆角矩形导出: 不再有"内切圆等效"的说法, 立体感强制 0 (板子那支只有平色)',
     !/内切圆/.test(txt) && num('RING_DEPTH_DEF') === 0)
  /* 布局参数 (留边/厚度/圆角) 只在网页算 —— 板子不做布局计算, 所以不许导出成会被误读的宏 */
  ok('圆角矩形导出: 留边/厚度/圆角只是注释留档 (板子不读、不会二次扣减)',
     !/^#define RING_RECT_(RAD|RADIN|THICK|INSET)\b/m.test(txt) && /留边 8/.test(txt),
     'RING_RECT_* 只应剩 W/H')
  /* 还原成圆环, 免得影响后面的用例 */
  Object.assign(inst.ring, { shape: 'circle', rad: 24, radIn: null, thick: 12, inset: 8 })
}

/* ---- 5y. 内置多帧素材: 帧数/尺寸来自元数据, 不能用 Image.width 现推 ---- */
{
  const { fwBuiltinAssetMeta, FW_BUILTIN } = await import('../src/fwassets.js')
  const { framesCount } = await import('../src/store.js')
  const metaOf = (id) => fwBuiltinAssetMeta(FW_BUILTIN.find(b => b.id === id))
  const f = metaOf('fonts')
  ok('内置字体: 28x40 x10 → 280x40, framesCount 也是 10',
     f.frames === 10 && f.w === 280 && f.h === 40 && f.font.frames === 10 &&
     framesCount({ w: f.w, h: f.h, font: f.font }) === 10,
     JSON.stringify({ w: f.w, h: f.h, frames: f.frames }))
  ok('默认素材库只保留字体 (fonts / font1210 / ascii)',
     FW_BUILTIN.length === 3 &&
     metaOf('fonts').frames === 10 && metaOf('font1210').frames === 16 && metaOf('ascii').frames === 95 &&
     metaOf('fonts').w === 280 && metaOf('font1210').w === 160 && metaOf('ascii').w === 760)
  ok('图片默认素材已清理 (LOGO / 电池 / 方向 / BLE / KRPM 不再内置)',
     !['logo', 'battery', 'dir', 'ble', 'krpm'].some(id => FW_BUILTIN.some(b => b.id === id)))
  ok('竖排帧条: framesCount 按高度算 (BAT.gif 12×280 → 14 帧, 不是 1)',
     framesCount({ w: 12, h: 280, font: { glyphW: 12, glyphH: 20, charset: 'frames', dir: 'row' } }) === 14)
  ok('竖排帧条: 内容 56×40 / 格 56×10 → 4 帧',
     framesCount({ w: 56, h: 40, font: { glyphW: 56, glyphH: 10, charset: 'frames', dir: 'row' } }) === 4)
}

/* ---- 5z. 多张图片 → 多帧素材: 拼版几何 ---- */
{
  const { framesSheetMeta } = await import('../src/store.js')
  const m = framesSheetMeta([{ w: 100, h: 50 }, { w: 80, h: 60 }, { w: 100, h: 40 }])
  ok('多帧拼版: 格子取最大宽高, 画布 = 格子×张数 (横向)',
     m.cellW === 100 && m.cellH === 60 && m.w === 300 && m.h === 60 && m.count === 3 && m.dir === 'col',
     JSON.stringify(m))
  ok('多帧拼版: 空列表返回 null (不生成空素材)', framesSheetMeta([]) === null && framesSheetMeta(null) === null)
}
/* ---- 5a. 内置屏幕预设: 三组新尺寸 (横竖各一条) + 补装机制 ---- */
{
  const { defaultPresets, syncBuiltinPresets } = await import('../src/defaults.js')
  const want = [[170, 320, 1.9], [320, 170, 1.9], [135, 240, 1.14], [240, 135, 1.14], [240, 320, 3.2], [320, 240, 3.2]]
  const all = defaultPresets()
  const miss = want.filter(([w, h]) => !all.some(p => p.w === w && p.h === h))
  const inchBad = want.filter(([w, h, inch]) => {
    const p = all.find(q => q.w === w && q.h === h)
    return !p || p.inch !== inch
  })
  ok('内置屏幕预设: 1.9吋 170x320 / 1.14吋 135x240 / 3.2吋 240x320 横竖各一条 (共 6 条, 带吋数)',
     miss.length === 0 && inchBad.length === 0,
     miss.length ? '缺 ' + JSON.stringify(miss) : `共 ${all.length} 条预设, 吋数都对`)

  /* 补装: 老用户的预设存在 localStorage 里 —— 新加的内置分辨率必须能补给他们,
   *   · 用户删掉的 (已经给过) 不许再加回来
   *   · 用户手里已有的同名项不重复加 */
  const mine = [{ name: '我的屏-200x100', w: 200, h: 100 }]
  const r1 = syncBuiltinPresets(mine, [])
  const r2 = syncBuiltinPresets(mine, ['170x320-竖'])
  const r3 = syncBuiltinPresets([...mine, { name: '170x320-竖', w: 999, h: 999 }], [])
  const names = (r) => r.presets.map(p => p.name)
  /* 载入工程文件 / 撤销 会把 presets 整份替换 → 那两条路径也必须补装 (否则新尺寸又没了) */
  {
    const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')
    const hits = (src.match(/ensureBuiltinPresets\(\)/g) || []).length
    ok('内置预设补装: 启动恢复 + 载入工程 + 撤销 三条路径都补 (工程文件里的 presets 会整份换掉列表)',
       /export function ensureBuiltinPresets/.test(src) && hits >= 4, `ensureBuiltinPresets 出现 ${hits} 次`)
  }
  ok('内置预设补装: 新分辨率会自动补给老用户; 删掉的/已有的不重复加',
     r1.added === all.length &&                            /* 老用户: 内置的全补上 (6 条新尺寸 + 圆屏/方屏) */
     names(r1).includes('170x320-竖') &&
     r2.added === all.length - 1 && !names(r2).includes('170x320-竖') &&   /* 已给过的那条不再补 */
     r3.presets.filter(p => p.name === '170x320-竖').length === 1 &&
     r3.presets.find(p => p.name === '170x320-竖').w === 999,
     `补装 ${r1.added} 条 / 已给过 ${r2.added} 条 / 同名不重复 ${r3.presets.filter(p => p.name === '170x320-竖').length} 条`)
  /* 存储模型: **固定预设来自代码** (每次加载都在), localStorage 只存"用户数据" */
  {
    const { splitPresets, mergePresets } = await import('../src/store.js')
    const bi = defaultPresets()
    ok('内置预设 id 稳定 (写死在代码里, 两次调用一致 → 工程文件/覆盖能引用)',
       JSON.stringify(bi.map(p => p.id)) === JSON.stringify(defaultPresets().map(p => p.id)) &&
       bi.every(p => p.id.startsWith('preset_bi_')))
    const sp0 = splitPresets(bi)
    ok('落盘: 纯内置时**一条都不写** localStorage (固定项不占用户存储)',
       sp0.custom.length === 0 && sp0.overrides.length === 0 && sp0.hidden.length === 0)

    const mine = JSON.parse(JSON.stringify(bi))
    mine.push({ id: 'preset_mine', name: '我的屏-200x100', w: 200, h: 100 })
    mine[0].w = 111
    const gone = mine.splice(1, 1)[0]
    const sp = splitPresets(mine)
    ok('落盘: 只存 自定义 + 对内置项的改动(overrides) + 删掉的内置项(hidden)',
       sp.custom.length === 1 && sp.overrides.length === 1 && sp.overrides[0].id === mine[0].id &&
       sp.hidden.length === 1 && sp.hidden[0] === gone.id,
       JSON.stringify({ custom: sp.custom.map(p => p.name), ov: sp.overrides.map(p => p.id), hidden: sp.hidden }))

    const back = mergePresets(sp)
    ok('合并: 内置项以代码为准 (缺的自动回来), 改动生效, 自定义保住, 删掉的仍隐藏',
       back.filter(p => p.id.startsWith('preset_bi_')).length === bi.length - 1 &&
       back.find(p => p.id === mine[0].id).w === 111 &&
       back.some(p => p.id === 'preset_mine') && !back.some(p => p.id === gone.id))

    /* 老格式 (整份数组混着内置项) 迁移: 不重复、自定义不丢 */
    const mig = mergePresets(mine)
    const names = mig.map(p => p.name)
    ok('迁移: 老格式(整份数组)并进来不重复, 自定义预设保住',
       new Set(names).size === names.length && mig.some(p => p.id === 'preset_mine') &&
       mig.filter(p => p.id.startsWith('preset_bi_')).length === bi.length)
  }
  /* 屏幕底色 (背景色): 预设级字段, 默认黑 0x0000 —— 预览 / 导出图片 / 导出 C 的 UI_PAGE_BG 同一个值。
   * ！老工程的 overrides 里没有 bg 字段: 合并必须用 base 的默认值兜住 (否则读到 undefined)。 */
  {
    const { splitPresets, mergePresets } = await import('../src/store.js')
    const bi = defaultPresets()
    ok('屏幕底色: 所有内置预设都带 bg 且默认黑 (0x0000)',
       bi.every(p => p.bg === 0x0000), JSON.stringify(bi.map(p => p.name + ':' + p.bg).slice(0, 3)))
    const ov = { id: bi[0].id, name: bi[0].name, w: 111 }        /* 老工程: 只有改过的字段, 没有 bg */
    const one = mergePresets({ custom: [], overrides: [ov], hidden: [] }).find(p => p.id === bi[0].id)
    ok('屏幕底色: 老工程的覆盖项 (没有 bg) 合并后仍是默认黑, 不会被写成 undefined',
       one && one.bg === 0x0000 && one.w === 111, one ? `w=${one.w} bg=${one.bg}` : 'missing')
    const mine = bi.map(p => ({ ...p }))
    mine[0].bg = 0xF800                                           /* 用户改了底色 → 落盘进 overrides */
    const sp = splitPresets(mine)
    ok('屏幕底色: 改过底色 → 存进 overrides, 合并后又回来',
       sp.overrides.length === 1 && sp.overrides[0].bg === 0xF800 &&
       mergePresets(sp).find(p => p.id === bi[0].id).bg === 0xF800)
  }
  /* 240x170 那块屏 (用户手上真有) 必须在内置里, 且横竖成对 */
  ok('内置屏幕预设: 240x170 / 170x240 横竖各一条 (用户手上的屏)',
     all.some(p => p.w === 240 && p.h === 170) && all.some(p => p.w === 170 && p.h === 240),
     all.filter(p => (p.w === 240 && p.h === 170) || (p.w === 170 && p.h === 240)).map(p => p.name).join(', '))
  /* 「补内置」按钮: 只补缺, 自定义预设不动, 删过的内置也能拿回来 */
  {
    const { restoreBuiltinPresets } = await import('../src/store.js')
    const keep = state.presets.slice()
    state.presets = [{ name: '我的屏-200x100', w: 200, h: 100 }]
    const n = restoreBuiltinPresets()
    const names2 = state.presets.map(p => p.name)
    ok('补内置: 保留自定义预设, 只把缺的内置补齐 (重置会冲掉自定义, 所以另给一个)',
       names2.includes('我的屏-200x100') && n === all.length && state.presets.length === all.length + 1,
       `补了 ${n} 条, 现在 ${state.presets.length} 条`)
    const n2 = restoreBuiltinPresets()
    ok('补内置: 再点一次不重复加 (幂等)', n2 === 0, `第二次补了 ${n2} 条`)
    state.presets = keep
  }
}

/* ---- 5b. 「锁定屏幕中心」时环心不许跟着尺寸漂 (用户现场) ---- */
{
  const { centerRingRect } = await import('../src/store.js')
  const sc = { w: 240, h: 240 }
  const ctr = (x, w) => Math.floor(x + (w - 1) / 2)          // 环心像素 = 导出的 RING_CX
  let drift = 0, eg = ''
  for (const w of [218, 219, 220, 221, 226, 227, 240]) {
    const c = centerRingRect(sc, w, w)
    if (ctr(c.x, w) !== 119) { drift++; if (!eg) eg = `w=${w} → 环心 ${ctr(c.x, w)}` }
  }
  const c226 = centerRingRect(sc, 226, 140)
  ok('锁定屏幕中心: 任何尺寸下环心都落在屏幕中央像素 (119) 且偏移保持整数',
     drift === 0 && ctr(c226.x, 226) === 119 && ctr(c226.y, 140) === 119 &&
     Number.isInteger(c226.x) && Number.isInteger(c226.y),
     drift ? eg : `226x140 → 位置 (${c226.x},${c226.y}), 环心 (119,119)`)
}

/* ---- 6. 圆环也吃「留边」: 导出与预览同一条式子 (整条带内收 留边/2, 厚度不变) ---- */
{
  const { buildRingConfig } = await import('../src/store.js')
  const { ringInsetPx } = await import('../src/ringrender.js')
  const inst = r2
  inst.ring.shape = 'circle'
  inst.ring.rOut = 120; inst.ring.rIn = 95; inst.ring.inset = 8
  const num = (txt, k) => {
    const m = txt.match(new RegExp('#define\\s+' + k + '\\s+(-?\\d+)'))
    return m ? Number(m[1]) : null
  }
  const t1 = buildRingConfig()
  ok('圆环导出: 留边 8px → R_OUT 扣 4 (整条带内收, 厚度不变)',
     num(t1, 'RING_R_OUT') === 116 && num(t1, 'RING_R_IN') === 91,
     `R_OUT=${num(t1, 'RING_R_OUT')} R_IN=${num(t1, 'RING_R_IN')}`)
  inst.ring.inset = 0
  const t0 = buildRingConfig()
  ok('圆环导出: 留边 0 → 原样 (不偷偷扣)',
     num(t0, 'RING_R_OUT') === 120 && num(t0, 'RING_R_IN') === 95)
  delete inst.ring.inset; delete inst.ring.fitPad; delete inst.ring.pad
  ok('留边: 三个字段都没有 = 0 (自检/对拍里的临时 ring 对象不该被扣)',
     ringInsetPx(inst.ring) === 0 && num(buildRingConfig(), 'RING_R_OUT') === 120)
  inst.ring.inset = 8
  inst.ring.pad = 5
  ok('留边: 新字段 inset 优先于老 pad*2', ringInsetPx(inst.ring) === 8)
  delete inst.ring.pad
}

/* ---- 7. 预览动效开关 (自动动画 / 光斑动画) 不导出: ring_config.h 必须逐字节相同 ---- */
{
  const { buildRingConfig } = await import('../src/store.js')
  const inst = r2
  Object.assign(inst.ring, { shape: 'circle', glintOn: true, gear: 3, dir: -1, glintMs: 50 })
  inst.ring.autoArc = false; inst.ring.autoGlint = false
  const off = buildRingConfig()
  inst.ring.autoArc = true; inst.ring.autoGlint = true
  const on = buildRingConfig()
  ok('预览动效开关不导出: 自动动画/光斑动画 开与关, ring_config.h 逐字节相同',
     off === on && !/^#define\s+\S*(autoArc|autoGlint|glintArcPx)/m.test(on))
  ok('导出头注释写明: 这两个动画只在网页预览 (顺带列全其他不导出字段)',
     /只在网页预览、\*\*不导出\*\*的字段/.test(on) && /自动动画 autoArc/.test(on) &&
     /光斑动画 autoGlint/.test(on) && /逐字节不变/.test(on))
  inst.ring.glintArcPx = 16
  ok('预览动效参数 (弧长 glintArcPx) 也不导出', buildRingConfig() === on)
  /* 顺带确认"该导出的硬件参数"还在 (免得上面那条靠清空导出通过) */
  ok('该导出的硬件参数仍在 (档位/方向/帧间隔/颜色/进度)',
     /#define RING_GEAR_DEF\s+3/.test(on) && /#define RING_DIR_DEF\s+-1/.test(on) &&
     /#define RING_TICK_MS\s+50/.test(on) && /#define RING_ARC_VALUE_DEF/.test(on))
}

/* ---- 8. 工程 JSON 带页面尺寸 meta (在线存档保存前判断"是不是同一块屏") ---- */
{
  const { exportProject, importProject, cloud, projectSignature, projectSignatureOf } = await import('../src/store.js')
  const p = JSON.parse(exportProject())
  ok('工程 JSON 带 fonts 字段 (保存时自动上传自定义字库)', Array.isArray(p.fonts))
  ok('工程导出带 meta: 宽度/高度/圆屏/层数 (存档覆盖判定不必解析整套 presets)',
     p.meta && p.meta.w === screen.value.w && p.meta.h === screen.value.h &&
     p.meta.round === !!screen.value.round && p.meta.layers === state.instances.length,
     JSON.stringify(p.meta))
  ok('工程指纹: 同一份 JSON 与当前状态算出的指纹一致 (保存后不会被误判成"又改过")',
     projectSignatureOf(p) === projectSignature())
  cloud.current = 'demo'; cloud.currentScreen = { w: 1, h: 1, round: false }
  importProject(JSON.stringify({ assets: [], instances: [] }))
  ok('本地导入工程 → 清掉"当前存档" (不会误以为还挂在那份在线档上)',
     cloud.current === '' && cloud.currentScreen === null)
}

/* ---- 8b. 每个存档自己的导出目录: 存 JSON, 句柄按 id 存本机 IDB ---- */
{
  const { normalizeExportDir, rememberExportDir, loadExportDirHandle,
          exportProject, importProject, projectSignature } = await import('../src/store.js')
  ok('导出目录归一化: 空 / 字符串 / 对象都认, 去空白并限长',
     normalizeExportDir(null).name === '' && normalizeExportDir(null).id === '' &&
     normalizeExportDir(' code/lcd ').name === 'code/lcd' &&
     normalizeExportDir({ name: ' A ', id: ' dir_A ' }).name === 'A' &&
     normalizeExportDir({ name: ' A ', id: ' dir_A ' }).id === 'dir_A')
  ok('导出目录: 老工程没有 exportDir → 空 (不会继承上一个存档的目录)',
     state.exportDir.name === '' && state.exportDir.id === '')
  const keep = state.exportDir
  state.exportDir = { name: 'code/lcd', id: 'dir_A' }
  const p = JSON.parse(exportProject())
  ok('工程 JSON 带 exportDir: 目录名 + 本机句柄键 (每个存档可不同)',
     p.exportDir && p.exportDir.name === 'code/lcd' && p.exportDir.id === 'dir_A',
     JSON.stringify(p.exportDir))
  const sigA = projectSignature()
  state.exportDir = { name: 'code/lcd-2', id: 'dir_B' }
  ok('工程指纹包含 exportDir: 改导出目录 = 有未保存改动', projectSignature() !== sigA)
  state.exportDir = { name: '', id: '' }
  importProject(JSON.stringify({ assets: [], instances: [], exportDir: p.exportDir }))
  ok('工程 JSON 往返: exportDir 跟着存档恢复',
     state.exportDir.name === 'code/lcd' && state.exportDir.id === 'dir_A')
  const remembered = await rememberExportDir({ name: 'other/lcd' })
  ok('选目录: rememberExportDir 生成这个工程专属的新句柄键并写进 state',
     !!remembered && remembered.name === 'other/lcd' && /^dir_/.test(remembered.id))
  ok('本机没有对应句柄时返回 null (换机器后按 name 重新选, 不会猜路径)',
     (await loadExportDirHandle('dir_not_exist')) === null)
  state.exportDir = keep
}

/* ---- 8c. 只导出当前用到的自定义字库 (系统字层 + 多帧画板 system 文字层) ---- */
{
  const { usedFontFamilies, filterUsedCustomFonts } = await import('../src/store.js')
  const instances = [
    { id: 'i1', sysfont: { family: 'UsedSys', size: 20 } },
    { id: 'i2', kind: 'text', assetId: 'a1' },          // 字库素材拼字: 不需要字体原文件
  ]
  const assets = [
    { id: 'a1', frameGroupDoc: { frames: [{ layers: [{ kind: 'text', source: 'system', family: 'BoardFont' }] }] } },
    { id: 'a2', frameGroupDoc: { frames: [{ layers: [{ kind: 'text', source: 'asset', family: 'GlyphOnly' }] }] } },
    { id: 'a3' },
  ]
  const used = usedFontFamilies(instances, assets)
  ok('字库: 只认系统字层 + 多帧画板 system 文字层的 family',
     used.has('UsedSys') && used.has('BoardFont') &&
     !used.has('GlyphOnly') && used.size === 2,
     [...used].join(','))
  const fonts = [
    { name: 'UsedSys', ext: '.ttf', data: new Uint8Array([1]) },
    { name: 'BoardFont', ext: '.otf', data: new Uint8Array([2]) },
    { name: 'UnusedFont', ext: '.ttf', data: new Uint8Array([3]) },
    { name: 'UsedSys', ext: '.ttf', data: new Uint8Array([4]) },   // 同名重复只留一份
    { name: 'BoardFont', ext: '.otf' },                            // 没有原文件字节
  ]
  const picked = filterUsedCustomFonts(fonts, instances, assets)
  ok('字库: 只挑被引用的 + 有原文件字节的 (未使用/无 data/重复都不导出)',
     picked.length === 2 && picked.map(f => f.name).sort().join(',') === 'BoardFont,UsedSys' &&
     picked.every(f => f.data), picked.map(f => f.name).join(','))
  const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')
  ok('字库: 一键导出 + 工程 JSON 都走 usedCustomFontFiles (不再遍历全部 fontData)',
     /for \(const f of usedCustomFontFiles\(\)\)/.test(src) &&
     /fonts: usedCustomFontFiles\(\)\.map/.test(src) &&
     !/customFontFiles\(\)/.test(src))
}

/* ---- 9. 未保存判定 (工程指纹) ---- */
{
  const { projectSignature, projectDirtyNow, cloud } = await import('../src/store.js')
  cloud.baseSig = projectSignature()
  cloud.dirty = false
  ok('工程指纹: 与最近保存/读取时一致 → 未修改', projectDirtyNow() === false)
  const keepPages = state.pages
  state.pages = { ...(state.pages || {}), 7: { period: 123 } }
  ok('工程指纹: 改页面设置 → 有未保存修改', projectDirtyNow() === true)
  state.pages = keepPages
  ok('工程指纹: 改回原样 → 又变干净', projectDirtyNow() === false)
}

/* ---- 10. 总素材库 (跨工程): 去重 / 来源合并 / 加入当前工程 / 移除 ---- */
{
  const { assetLibrary, mergeGlobalAssets, adoptGlobalAsset, removeGlobalAsset, globalAssetKey, removeAsset } =
    await import('../src/store.js')
  assetLibrary.items = []
  const a = { id: 'ga_a', name: '共享图', src: 'data:image/png;base64,AA', w: 8, h: 8 }
  const r1 = mergeGlobalAssets([a], '工程A')
  const r2 = mergeGlobalAssets([{ ...a, name: '共享图-改名' }], '工程B')
  ok('总素材库: 同一内容只存一份 (按像素 hash 去重), 来源合并到同一条',
     r1.added === 1 && r2.added === 0 && assetLibrary.items.length === 1 &&
     assetLibrary.items[0].origins.includes('工程A') && assetLibrary.items[0].origins.includes('工程B') &&
     assetLibrary.items[0].asset.name === '共享图-改名')
  const item = assetLibrary.items[0]
  ok('总素材库 key 不含完整 src (只存 hash + 字库元信息)',
     item.key.length < 200 && item.key === globalAssetKey(item.asset))
  const adopted = adoptGlobalAsset(item.id)
  ok('总素材库: 加入当前工程 = 复制一份, id 不同但内容相同',
     !!adopted && state.assets.includes(adopted) && adopted.id !== item.asset.id &&
     adopted.name === item.asset.name)
  removeAsset(adopted.id)
  await sleep(20)
  assetLibrary.items = []
  removeGlobalAsset(item.id)
  ok('总素材库: 可单独移除条目 (不影响工程里的副本)', assetLibrary.items.length === 0)
  /* 同一素材 id 改了内容 (重新拆分字库 / 文字快照改字) → 替换旧条目, 不再新旧两条都留 */
  assetLibrary.items = []
  mergeGlobalAssets([a], '工程A')
  const before = assetLibrary.items[0]
  mergeGlobalAssets([{ ...a, src: 'data:image/png;base64,AB' }], '工程A')
  ok('总素材库: 同一素材 id 改了内容 → 替换旧条目, 不新增重复',
     assetLibrary.items.length === 1 && assetLibrary.items[0].asset.src.endsWith('AB') &&
     assetLibrary.items[0].id !== before.id)
  assetLibrary.items = []
}

/* ---- 10b. 总素材库重建: 只检查给定来源 (服务器现有存档), 历史条目不再累积 ---- */
{
  const { buildGlobalAssetItems, globalAssetKey } = await import('../src/store.js')
  const a = { id: 'A', name: 'A图', src: 'data:image/png;base64,AAA', w: 8, h: 8 }
  const b = { id: 'B', name: 'B图', src: 'data:image/png;base64,BBB', w: 8, h: 8 }
  const c = { id: 'C', name: 'C图', src: 'data:image/png;base64,CCC', w: 8, h: 8 }
  const first = buildGlobalAssetItems([
    { origin: '工程A', assets: [a, b] },
    { origin: '工程B', assets: [{ ...b, name: 'B图-改名' }, c] },
  ])
  const itemB = first.items.find(x => x.key === globalAssetKey(b))
  ok('总库重建: 同内容跨工程只留一条, 来源合并, 后一源的名字覆盖前一源',
     first.items.length === 3 && first.added === 3 &&
     itemB && itemB.origins.includes('工程A') && itemB.origins.includes('工程B') &&
     itemB.asset.name === 'B图-改名')
  const itemA = first.items.find(x => x.key === globalAssetKey(a))
  const second = buildGlobalAssetItems([{ origin: '工程A', assets: [a] }], first.items)
  ok('总库重建: 只保留本次来源里的素材 (B/C 这类已删存档的历史条目被清掉)',
     second.items.length === 1 && second.items[0].key === globalAssetKey(a))
  ok('总库重建: 仍在来源里的条目继承 id/addedAt (列表不会整片跳)',
     second.items[0].id === itemA.id && second.items[0].addedAt === itemA.addedAt)
  /* 旧存档把内置多帧素材按 1 帧存过: 不校正的话和修复后的版本 src 相同却会重复两条 */
  const broken = { id: 'fw_fonts', name: '字体', src: 'data:image/png;base64,FONT', w: 28, h: 40,
                   font: { glyphW: 28, glyphH: 40, charset: 'frames', frames: 1, dir: 0 } }
  const fixed = { ...broken, w: 280, font: { ...broken.font, frames: 10 } }
  const one = buildGlobalAssetItems([
    { origin: '旧档', assets: [broken] },
    { origin: '新档', assets: [fixed] },
  ])
  ok('总库重建: 旧存档的 fw_* 1 帧按固件元数据校正, 与多帧版合并成一条',
     one.items.length === 1 && one.items[0].asset.w === 280 &&
     one.items[0].asset.font.frames === 10,
     JSON.stringify(one.items.map(x => ({ w: x.asset.w, frames: x.asset.font?.frames }))))
}

/* ---- 10c. 文字/系统字图层 → 当前工程素材: 只生成固定文本, 拖动不重生成 ---- */
{
  const { isTextMaterialInstance, textMaterialSignature } = await import('../src/store.js')
  const txt = { id: 't1', kind: 'text', assetId: 'a1', text: 'ABC', spacing: 0, fmt: 'GRAY',
                color: 0xFFFF, w: 30, h: 10, x: 0, y: 0 }
  const num = { ...txt, bind: { type: 'num' } }
  const sys = { id: 't2', kind: 'image', sysfont: { text: 'Hi', family: 'Arial', size: 20 },
                text: 'Hi', fmt: 'GRAY', color: 0xFFFF, w: 20, h: 20 }
  const ascii = { ...sys, ascii: true }
  ok('文字素材: 固定文字层 / 系统字层会生成, 数字 / ASCII 字库层不生成',
     isTextMaterialInstance(txt) && isTextMaterialInstance(sys) &&
     !isTextMaterialInstance(num) && !isTextMaterialInstance(ascii))
  const sig = textMaterialSignature(txt)
  ok('文字素材: 拖动位置不触发重生成, 改文字/字号才触发',
     sig === textMaterialSignature({ ...txt, x: 99, y: 5 }) &&
     sig !== textMaterialSignature({ ...txt, text: 'ABD' }) &&
     textMaterialSignature(sys) !== textMaterialSignature({ ...sys, sysfont: { ...sys.sysfont, size: 24 } }) &&
     textMaterialSignature(num) === '')
}

/* ---- 素材默认格式: 多帧画板存的 RGB565/GRAY 必须沿用到放置出来的图层 ---- */
{
  const { addInstance, state: st } = await import('../src/store.js')
  const keep = { p: st.presets, a: st.activePresetId, assets: st.assets, inst: st.instances }
  st.presets = [{ id: 'p_fmt', name: 't', w: 100, h: 100, round: false, bg: 0, defaultFmt: 'RGB565' }]
  st.activePresetId = 'p_fmt'
  st.assets = [{ id: 'a_fmt', name: 'a', src: 'data:image/png;base64,AA', w: 10, h: 10, defaultFmt: 'GRAY' }]
  st.instances = []
  const inst = addInstance('a_fmt', 50, 50)
  ok('放置素材: 沿用素材自己的 defaultFmt (GRAY), 不被屏幕默认 RGB565 覆盖', inst?.fmt === 'GRAY', inst?.fmt)
  st.presets = keep.p; st.activePresetId = keep.a; st.assets = keep.assets; st.instances = keep.inst
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
