/*
 * 圆环「每段逐行跨度表」(ring_seg_spans.h) 自检: node scripts/check-ringspans.mjs
 *
 * 覆盖:
 *   1) round-half-to-even: Python round() 与 JS Math.round() 的分歧点 (x.5 取偶);
 *   2) ring_tables.h 的 ringAtanTab / ringRecip: JS 生成器逐项同口径
 *      (参考 Python 生成器虽然加载了这两张表, 但主循环用的是 atan2 → 这里只对齐表);
 *   3) golden 对拍: 用示例 ring 参数生成, 与 examples/.../ring_seg_spans.h 逐字节相同
 *      (banner:'tool' = 与 Python 完全相同的出处行); 网页 banner 只允许差第 1 行;
 *   4) 适用条件: 圆角矩形 / 无圆环 / 分段关 / 相位非 0 / 表内坐标越界 / 指纹不符 都跳过;
 *   5) 一键导出 (exportLayer) 真的把 ring_seg_spans.h 写进文件列表, 且 9 个几何指纹
 *      与同一次导出的 ring_config.h 逐项相等; 圆角矩形/分段关时不写文件;
 *   6) 表大小 = 行数×5B + (N+1)×2B, RING_SPAN_MAX_N = 实际单行最长跨度。
 *
 * 零依赖, 不启动服务器。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { roundHalfEven, ringAtanTab, ringRecip, buildRingSegSpans, ringSpanParams,
         fingerprintMatches } from '../src/ringspans.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const GOLDEN = path.join(ROOT, 'examples/render-port/code/spi/ring_seg_spans.h')
const TABLES = path.join(ROOT, 'examples/render-port/code/spi/ring_tables.h')

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}

/* ============================================================
 * 1) round-half-to-even (Python round 的语义)
 * ============================================================ */
{
  const cases = [
    [0.5, 0], [1.5, 2], [2.5, 2], [3.5, 4], [4.5, 4],
    [-0.5, 0], [-1.5, -2], [-2.5, -2], [-3.5, -4],
    [2.4999999999, 2], [2.5000000001, 3], [0, 0], [-0, 0], [719, 719],
  ]
  const bad = cases.filter(([x, y]) => roundHalfEven(x) !== y)
  ok('round-half-to-even: x.5 取偶 (含负数), 非 .5 仍是普通四舍五入',
     bad.length === 0, bad.length ? JSON.stringify(bad) : `${cases.length} 组`)
  ok('round-half-to-even: NaN 不抛异常 (返回 NaN)', Number.isNaN(roundHalfEven(NaN)))
  /* 对照 JS 内置: 2.5 / -2.5 正是两者不同的地方 (Math.round 会给 3 / -2) */
  ok('round-half-to-even 与 Math.round 在 .5 上确实不同 (不是空实现)',
     Math.round(2.5) === 3 && roundHalfEven(2.5) === 2 &&
     Math.round(-2.5) === -2 && roundHalfEven(-2.5) === -2)
}

/* ============================================================
 * 2) ringAtanTab / ringRecip 与 ring_tables.h 同口径
 * ============================================================ */
{
  const src = fs.readFileSync(TABLES, 'utf8')
  const arr = (name) => {
    const m = src.match(new RegExp(name + '\\s*\\[[^\\]]*\\]\\s*=\\s*\\{([\\s\\S]*?)\\}', 'm'))
    return m ? [...m[1].matchAll(/-?\d+/g)].map(x => +x[0]) : []
  }
  const atan = arr('ringAtanTab')
  const recip = arr('ringRecip')
  const jsAtan = ringAtanTab()
  const jsRecip = ringRecip()
  ok('ringAtanTab: 257 项, 与 ring_tables.h 逐项相等',
     atan.length === 257 && jsAtan.length === 257 && JSON.stringify(atan) === JSON.stringify(jsAtan),
     `golden ${atan.length} 项 / JS ${jsAtan.length} 项`)
  ok('ringRecip: 129 项, 与 ring_tables.h 逐项相等 (1 位封顶 65535)',
     recip.length === 129 && jsRecip.length === 129 && JSON.stringify(recip) === JSON.stringify(jsRecip),
     `golden ${recip.length} 项 / JS ${jsRecip.length} 项`)
}

/* ============================================================
 * 3) golden 对拍: 示例参数 (C=119,119 R=100..117 起 125° 跨 290°, N=70, 40% 缝)
 * ============================================================ */
const ring = {
  shape: 'circle', rIn: 100, rOut: 117, inset: 0, aa: 2, glintOn: false,
  startDeg: 125, arcEndDeg: 55, arcDir: 1,
  segOn: true, segCount: 70, segGapPct: 40,
}
const inst = { id: 'ring', kind: 'ring', name: 'ring_1', x: 0, y: 0, w: 240, h: 240, ring }
const SC = { w: 240, h: 240 }

{
  const p = ringSpanParams(inst, SC)
  ok('示例参数归一化 = ring_config.h 的 9 个几何量',
    p.ok && p.params.cx === 119 && p.params.cy === 119 &&
    p.params.rIn === 100 && p.params.rOut === 117 &&
    p.params.start === 250 && p.params.range === 580 &&
    p.params.n === 70 && p.params.pitch === 41667 && p.params.body === 25000,
    p.ok ? JSON.stringify(p.params) : p.reason)

  const js = buildRingSegSpans(inst, SC, { banner: 'tool' })
  const gold = fs.readFileSync(GOLDEN, 'utf8')
  ok('golden: 整文件逐字节相同 (与 gen_ring_spans.py 的输出一致)',
     js.ok && js.header === gold,
     js.ok ? `${js.header.length} B / golden ${gold.length} B` : js.reason)
  ok('golden: 行数/段数/表大小与示例头注释一致',
    js.ok && js.rows === 1042 && js.segs === 70 && js.bytes === 5352 && js.maxN === 19,
    js.ok ? `${js.rows} 行 / ${js.bytes} B / maxN ${js.maxN}` : '')
  ok('表大小公式: 行数×5B + (N+1)×2B',
    js.ok && js.bytes === js.rows * 5 + (js.segs + 1) * 2,
    js.ok ? `${js.bytes} = ${js.rows}×5 + ${js.segs + 1}×2` : '')

  /* 网页导出用的出处行不同, 数据区必须逐字节相同 */
  const web = buildRingSegSpans(inst, SC)
  const a = web.ok ? web.header.split('\n') : []
  const b = gold.split('\n')
  const diff = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff.push(i)
  ok('网页 banner: 只差第 1 行 (出处说明), 其余逐行逐字节相同',
    web.ok && diff.length === 1 && diff[0] === 0 && a.length === b.length,
    diff.length ? `差异行 ${diff.join(',')}` : '')
  ok('网页 banner 不会冒充 Python 脚本生成',
    web.ok && /网页/.test(a[0]) && !/由 tools\/ring_sim\/gen_ring_spans\.py 生成/.test(a[0]))

  /* 表内数值逐行再对一遍 (防止"整文件相等"只是 banner 碰巧) */
  const rowsOf = (txt) => [...txt.matchAll(/\{ *(\d+), *(\d+), *(\d+), *(\d+), *(\d+) \},/g)]
    .map(m => m.slice(1).map(Number))
  const ofsOf = (txt) => {
    const m = txt.match(/ringSegRowOfs[\s\S]*?\{([\s\S]*?)\}/)
    return m ? m[1].match(/-?\d+/g).map(Number) : []
  }
  ok('golden: ringSegRows 1042 行逐项相等', JSON.stringify(rowsOf(web.header)) === JSON.stringify(rowsOf(gold)))
  ok('golden: ringSegRowOfs 71 项逐项相等, 单调不减, 末项 = 行数',
    JSON.stringify(ofsOf(web.header)) === JSON.stringify(ofsOf(gold)) &&
    ofsOf(web.header).every((v, i, arr) => i === 0 || v >= arr[i - 1]) &&
    ofsOf(web.header).at(-1) === 1042)
  ok('指纹宏 9 项与示例 ring_config.h 同值',
    fingerprintMatches(web.header, fs.readFileSync(
      path.join(ROOT, 'examples/render-port/code/lcd/ring_config.h'), 'utf8')))
}

/* ============================================================
 * 4) 不适用 / 配置不支持 → 跳过 (不写半套)
 * ============================================================ */
{
  const noRing = buildRingSegSpans(null, SC)
  ok('无圆环 → 跳过 (code=no-ring)', !noRing.ok && noRing.code === 'no-ring')

  const rect = { ...inst, ring: { ...ring, shape: 'rect', rad: 24, thick: 14, inset: 8 } }
  const r = buildRingSegSpans(rect, SC)
  ok('圆角矩形 (RING_SHAPE=1) → 跳过, 不生成表', !r.ok && r.code === 'rect', r.reason)

  const segOff = { ...inst, ring: { ...ring, segOn: false } }
  const s = buildRingSegSpans(segOff, SC)
  ok('分段关闭 (RING_SEG_ON=0) → 跳过', !s.ok && s.code === 'seg-off', s.reason)

  const phase = { ...inst, ring: { ...ring, segPhaseDeg: 2 } }
  const ph = buildRingSegSpans(phase, SC)
  ok('分段相位非 0 → 跳过 (参考生成器不补相位, 表会错位)', !ph.ok && ph.code === 'seg-phase', ph.reason)

  const phaseTiny = { ...inst, ring: { ...ring, segPhaseDeg: 0.04 } }
  ok('相位 <0.05° 在 RING_SEG_PHASE_X10 里量化成 0 → 仍可生成',
    buildRingSegSpans(phaseTiny, SC).ok)

  /* 屏幕比 256 大不一定不行: 只要实际落进表里的 x/y <=255 就能用 */
  const wide = buildRingSegSpans(inst, { w: 320, h: 240 })
  ok('320×240 屏 + 环在左半边 (实际坐标 <=255) → 仍可生成',
    wide.ok && wide.bytes === 5352, wide.ok ? `${wide.bytes} B` : wide.reason)
  const shifted = buildRingSegSpans({ ...inst, x: 200 }, { w: 320, h: 240 })
  ok('环移到 x>255 后越出 uint8 字段 → 跳过 (code=coord-overflow), 不写截断表',
    !shifted.ok && shifted.code === 'coord-overflow', shifted.reason)
  const offscreen = buildRingSegSpans({ ...inst, x: -1000, y: -1000 }, SC)
  ok('环完全在屏幕外 → 跳过 (code=empty), 不写空表',
    !offscreen.ok && offscreen.code === 'empty', offscreen.reason)

  const badGeom = { ...inst, ring: { ...ring, rOut: undefined, rIn: undefined } }
  const bg = buildRingSegSpans(badGeom, SC)
  ok('半径缺失 → 跳过 (code=bad-geometry)', !bg.ok && bg.code === 'bad-geometry', bg.reason)

  const wrongCfg = '/* 假配置 */\n#define RING_CX 1\n#define RING_CY 1\n'
  const fp = buildRingSegSpans(inst, SC, { configText: wrongCfg })
  ok('与 ring_config.h 指纹不符 → 跳过 (code=fingerprint), 不写错位的表',
    !fp.ok && fp.code === 'fingerprint', fp.reason)

  const goodCfg = fs.readFileSync(path.join(ROOT, 'examples/render-port/code/lcd/ring_config.h'), 'utf8')
  ok('与示例 ring_config.h 指纹相符 → 生成',
    buildRingSegSpans(inst, SC, { configText: goodCfg }).ok)
}

/* ============================================================
 * 5) 一键导出集成: 文件列表里真的有 ring_seg_spans.h, 指纹与 ring_config.h 同源
 * ============================================================ */
{
  globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null },
    setItem(k, v) { this._m.set(k, String(v)) },
    removeItem(k) { this._m.delete(k) },
  }
  globalThis.indexedDB = { open() { throw new Error('no idb in node') } }
  globalThis.fetch = async () => { throw new Error('no net in node') }

  const { state, screen, exportLayer, estimateRingSpans } = await import('../src/store.js')
  state.presets[0].w = 240
  state.presets[0].h = 240
  state.activePresetId = state.presets[0].id
  state.instances = [inst]

  const est = estimateRingSpans()
  ok('面板估算 = 5352 B / 1042 行 (与真正导出的表同一份生成器)',
    est.ok && est.bytes === 5352 && est.rows === 1042, JSON.stringify(est))

  const { files, stat } = exportLayer()
  const byName = Object.fromEntries(files.map(f => [f.name, f.text]))
  ok('一键导出包含 ring_seg_spans.h (与 ring_config.h 同一次)',
    !!byName['ring_seg_spans.h'] && !!byName['ring_config.h'])
  ok('导出统计带 ringSpans (面板/状态行用)', stat.ringSpans && stat.ringSpans.ok &&
    stat.ringSpans.bytes === 5352 && stat.ringSpans.rows === 1042)
  ok('导出文件的 9 个几何指纹与 ring_config.h 逐项相等',
    fingerprintMatches(byName['ring_seg_spans.h'], byName['ring_config.h']))
  ok('导出的表与 golden 数据区逐行相同 (仅出处行不同)',
    (() => {
      const gold = fs.readFileSync(GOLDEN, 'utf8').split('\n')
      const mine = byName['ring_seg_spans.h'].split('\n')
      mine[0] = gold[0]
      return mine.join('\n') === gold.join('\n')
    })())

  /* 示例工程源文件里的真实圆环再走一遍 end-to-end: golden 就是它导出的 */
  const projPath = path.join(ROOT, 'examples/render-port/source/lcd-project.json')
  if (fs.existsSync(projPath)) {
    const proj = JSON.parse(fs.readFileSync(projPath, 'utf8'))
    const projRing = (proj.instances || []).find(i => i.kind === 'ring')
    if (projRing) {
      state.instances = [projRing]
      const pr = exportLayer()
      const mine = pr.files.find(f => f.name === 'ring_seg_spans.h')
      const gold = fs.readFileSync(GOLDEN, 'utf8').split('\n')
      const lines = mine ? mine.text.split('\n') : []
      if (lines.length) lines[0] = gold[0]
      ok('示例工程 lcd-project.json 的真实圆环 → 导出表与 golden 数据区逐行相同',
        !!mine && lines.join('\n') === gold.join('\n') &&
        pr.stat.ringSpans && pr.stat.ringSpans.bytes === 5352)
    }
  }
  state.instances = [inst]

  /* 圆角矩形: 一键导出不写表, 状态给明确原因 */
  state.instances = [{ ...inst, ring: { ...ring, shape: 'rect', rad: 24, thick: 14, inset: 8, depth: 0 } }]
  const rectOut = exportLayer()
  ok('圆角矩形: 一键导出不写 ring_seg_spans.h, stat 给原因',
    !rectOut.files.some(f => f.name === 'ring_seg_spans.h') &&
    rectOut.stat.ringSpans && !rectOut.stat.ringSpans.ok && rectOut.stat.ringSpans.code === 'rect')

  /* 分段关: 同上 */
  state.instances = [{ ...inst, ring: { ...ring, segOn: false } }]
  const offOut = exportLayer()
  ok('分段关: 一键导出不写 ring_seg_spans.h',
    !offOut.files.some(f => f.name === 'ring_seg_spans.h') &&
    offOut.stat.ringSpans && !offOut.stat.ringSpans.ok && offOut.stat.ringSpans.code === 'seg-off')

  /* 无圆环: 不打扰 (code=no-ring), 也不写表 */
  state.instances = []
  const noOut = exportLayer()
  ok('无圆环: 不写表, stat.ringSpans.code=no-ring',
    !noOut.files.some(f => f.name === 'ring_seg_spans.h') &&
    noOut.stat.ringSpans && !noOut.stat.ringSpans.ok && noOut.stat.ringSpans.code === 'no-ring')

  /* 恢复示例工程状态, 避免影响同进程里的后续用例 (独立进程, 仅作示范) */
  state.instances = [inst]
  void screen
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exitCode = fails ? 1 : 0
