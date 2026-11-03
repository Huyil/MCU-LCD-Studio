/*
 * 圆环「每段逐行跨度表」(ring_seg_spans.h) 生成器 —— 网页版
 *
 * 对标 examples/render-port/tools/gen_ring_spans.py:
 *   · 输入 = ring_config.h 的 9 个几何量: RING_CX/CY, R_IN/OUT, ARC_START,
 *     ARC_SPAN, SEG_N, SEG_PITCH_X10000, SEG_BODY_X10000;
 *   · 输出 = RingSegRow ringSegRows[] + uint16_t ringSegRowOfs[] + 几何指纹宏;
 *   · 表大小 = 行数 × 5B + (N+1) × 2B (RingSegRow 是 5 个 uint8_t, 无填充)。
 *
 * 为什么要在网页里也能生成:
 *   bsp_ring.c 的 RING_FAST_SEG 快路径 (换档只重画变化的那几段) 直接
 *   #include "ring_seg_spans.h"; 纯网页用户不装 Python 也能拿到这张表,
 *   不用再跑 tools/gen_ring_spans.py。
 *
 * 与 Python 逐字节一致的关键:
 *   Python 的 round() 是**银行家舍入**(round-half-to-even), JS 的 Math.round()
 *   是四舍五入。角度量化 (atan2 → 0.5° 单位) 必须用 roundHalfEven(), 否则
 *   恰好落在 .5 上的像素会差 1 个角度单位, 表就整体错位。
 *
 * 适用范围 (与 bsp_ring.c 的 #if 完全一致):
 *   RING_SHAPE == 0 (圆环) && RING_SEG_ON == 1;
 *   圆角矩形 (RING_SHAPE=1) 走另一套 Q8 几何, 没有这张表。
 *   另: 表的行几何按 RING_SEG_PHASE_X10 == 0 生成 (参考生成器同样没有把
 *   相位算进去), 相位非 0 时引擎的 ring_seg_split() 会整体平移段边界,
 *   这张表就会对不上 —— 所以这里直接跳过并给 warning。
 *
 * 纯函数, 不碰 DOM: Node 自检 (scripts/check-ringspans.mjs) 直接 import。
 */
import { ringArcRange, ringSegGeom, ringInsetPx } from './ringrender.js'

const ANG = 720                       /* 一整圈, 0.5° 单位 */
const CACHE_MAX = 8

/** web = 网页导出用的出处说明; tool = 与 gen_ring_spans.py 逐字节相同的头 */
const BANNER_WEB =
  '/* ring_seg_spans.h —— 由网页 MCU-LCD-Editer 导出 (算法同 tools/ring_sim/gen_ring_spans.py), 请勿手改。'
const BANNER_TOOL = '/* ring_seg_spans.h —— 由 tools/ring_sim/gen_ring_spans.py 生成, 请勿手改。'

/** Python round(): round-half-to-even (银行家舍入). 非有限值按 NaN 返回。 */
export function roundHalfEven(x) {
  if (!Number.isFinite(x)) return NaN
  const t = Math.trunc(x)
  if (Math.abs(x - t) === 0.5) {
    /* 恰好在两个整数中间: 取偶数那一边 (负数同样对称) */
    const fl = Math.floor(x)
    return (fl % 2 === 0) ? fl : fl + 1
  }
  return Math.round(x)
}

/** ring_tables.h 的 ringAtanTab[257]: atan(i/256) 的 0.5° 单位 (0..90)
 *  注意: 参考 Python 生成器虽然 load_tables() 了这张表, 主循环实际用的是
 *  math.atan2 (tab_atan2() 是死代码); 本移植照做 —— 用固件的整数近似 atan
 *  会与 golden 表差 ~900 个边界像素。这里只保留"同口径"生成器, 供自检和
 *  需要固件同款量化的调用方使用。 */
export function ringAtanTab() {
  const out = new Array(257)
  for (let i = 0; i <= 256; i++) out[i] = roundHalfEven((Math.atan(i / 256) * 180) / Math.PI * 2)
  return out
}

/** ring_tables.h 的 ringRecip[129]: 倒数表 (0 位 = 0, 1 位封顶 65535) */
export function ringRecip() {
  const out = new Array(129)
  out[0] = 0
  for (let k = 1; k < 129; k++) out[k] = Math.min(65535, roundHalfEven(65536 / k))
  return out
}

const pad = (v, n) => String(v).padStart(n)
const mod = (v, p) => ((v % p) + p) % p

/**
 * 从当前 ring 部件 + 屏幕算出表参数 (与 buildRingConfig() 同一套取整):
 *   圆心 = floor(x + (w-1)/2); 半径扣「留边」; 起止角/跨度按 0.5° 量化;
 *   段数/节距/段体取 ringSegGeom() 的结果 (网页预览与导出共用)。
 * 返回 { ok:true, params } 或 { ok:false, code, reason }。
 * code 给调用方判断"该不该提醒" (no-ring = 没圆环, 不打扰用户)。
 */
export function ringSpanParams(inst, sc, opts = {}) {
  if (!inst || inst.kind !== 'ring' || !inst.ring) {
    return { ok: false, code: 'no-ring', reason: '没有圆环部件' }
  }
  const r = inst.ring
  if (r.shape === 'rect') {
    return { ok: false, code: 'rect', reason: '圆角矩形环 (RING_SHAPE=1) 走 Q8 几何, 没有逐段跨度表' }
  }
  if (!r.segOn) {
    return { ok: false, code: 'seg-off', reason: '圆环分段 (分割) 未开启 (RING_SEG_ON=0)' }
  }
  const phaseX10 = Math.round((Number(r.segPhaseDeg) || 0) * 10)
  if (phaseX10 !== 0) {
    return { ok: false, code: 'seg-phase',
      reason: `分段相位 ${phaseX10 / 10}° 非 0: 引擎 ring_seg_split() 会平移段边界, 表生成器 (与 Python 参考实现一致) 不补相位, 跳过以免画错位` }
  }
  const W = Math.max(2, Math.round(Number(sc?.w) || 240))
  const H = Math.max(2, Math.round(Number(sc?.h) || 240))
  /* 不按屏幕尺寸一刀切: 表字段是 uint8, 只要**实际落进表里的** x/y 不超过
   * 255 就能用 (240×320 屏上靠上的环也能生成)。越界在生成后统一判 coord-overflow。 */
  /* 圆心/半径: 一字不差照抄 buildRingConfig() 的算法, 两边几何指纹才对得上。
   * 先查原始值: 缺半径时下面会被 max() 夹成 1, 悄悄生成一张残表。 */
  const rawRout = Number(r.rOut), rawRin = Number(r.rIn)
  if (!Number.isFinite(rawRout) || rawRout <= 0 || !Number.isFinite(rawRin) || rawRin < 0) {
    return { ok: false, code: 'bad-geometry', reason: '圆环半径缺失/无效 (需要 R_IN >= 0, R_OUT > 0)' }
  }
  const insetPx = ringInsetPx(r)
  const cx = Math.floor((Number(inst.x) || 0) + ((Number(inst.w) || 0) - 1) / 2)
  const cy = Math.floor((Number(inst.y) || 0) + ((Number(inst.h) || 0) - 1) / 2)
  const rOut = Math.max(1, Math.round((Number(r.rOut) || 0) - insetPx / 2))
  const rIn = Math.max(0, Math.min(Math.round((Number(r.rIn) || 0) - insetPx / 2), rOut - 1))
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !(rOut >= rIn)) {
    return { ok: false, code: 'bad-geometry', reason: '圆环几何无效 (半径/圆心不是有效数字)' }
  }
  const startDeg = ((Math.round(r.startDeg ?? -90) % 360) + 360) % 360
  if (!Number.isFinite(startDeg)) {
    return { ok: false, code: 'bad-geometry', reason: '圆环起始角无效 (不是有效数字)' }
  }
  const start = startDeg * 2
  const range = ringArcRange(r).rangeU
  const segG = ringSegGeom({ ...r, segOn: true })
  if (!segG) {
    return { ok: false, code: 'seg-missing', reason: '分段参数缺失 (段数/缝宽), 无法确定 PITCH/BODY' }
  }
  const n = segG.N
  const pitch = Math.round(segG.P * 10000)
  const body = Math.round(segG.body * 10000)
  if (!(n >= 2) || !(pitch > 0) || !(body >= 0)) {
    return { ok: false, code: 'seg-missing',
      reason: `分段参数不可用 (N=${n}, PITCH=${pitch}, BODY=${body}); 需要 N>=2、PITCH>0、BODY>=0` }
  }
  return {
    ok: true,
    params: { cx, cy, rIn, rOut, start, range, n, pitch, body, W, H, startDeg, insetPx },
  }
}

/** 生成表文本与统计。参数已是 ringSpanParams() 的归一化结果。 */
function renderTable(p, banner) {
  const { cx, cy, rIn, rOut, start, range, n, pitch, body, W, H } = p
  const P_Q8 = Math.floor((pitch * 256 + 5000) / 10000)          /* Python: // 10000 */
  const BODY_Q8 = Math.floor((body * 256 + 5000) / 10000)
  if (P_Q8 <= 0) {
    return { ok: false, code: 'seg-missing', reason: `PITCH ${pitch} (0.0001°) 量化到 Q8 后为 0, 分段几何不可用` }
  }
  const RAD2DEG = 180 / Math.PI

  /* seg -> y -> [[x, isBody], ...] */
  const rows = Array.from({ length: n }, () => new Map())
  const RIN2 = rIn * rIn, ROUT2 = rOut * rOut
  /* 只扫环的外接框: 与全屏扫描结果等价 (框外 r2 必然越界), 大屏也快 */
  const x0 = Math.max(0, cx - rOut), x1 = Math.min(W - 1, cx + rOut)
  const y0 = Math.max(0, cy - rOut), y1 = Math.min(H - 1, cy + rOut)
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx
      const r2 = dx * dx + dy * dy
      if (r2 < RIN2 || r2 > ROUT2) continue
      /* 与 Python 完全相同: round-half-even, 再折到 0..719 (0.5°) */
      const a = mod(roundHalfEven(Math.atan2(dy, dx) * RAD2DEG * 2), ANG)
      if (!Number.isFinite(a)) continue
      const rel = mod(a - start, ANG)
      if (rel * 128 >= range * 128) continue
      const seg = Math.floor((rel * 128) / P_Q8)
      if (seg >= n) continue
      const row = rows[seg]
      let arr = row.get(y)
      if (!arr) row.set(y, (arr = []))
      arr.push([x, (rel * 128 - seg * P_Q8) < BODY_Q8])
    }
  }

  const bodyRows = []
  const ofs = new Array(n + 1).fill(0)
  let count = 0, maxN = 1
  for (let s = 0; s < n; s++) {
    const ys = Array.from(rows[s].keys()).sort((a, b) => a - b)
    for (const y of ys) {
      const px = rows[s].get(y).sort((a, b) => a[0] - b[0])
      /* 同一种颜色且 x 连续 → 合成一条跨度 */
      const runs = []
      let i = 0
      while (i < px.length) {
        let j = i
        while (j + 1 < px.length && px[j + 1][0] === px[j][0] + 1 && px[j + 1][1] === px[i][1]) j++
        runs.push([px[i][1] ? 1 : 0, px[i][0], j - i + 1])
        i = j + 1
      }
      const b = runs.find(x => x[0] === 1)
      const g = runs.find(x => x[0] === 0)
      if (!b && !g) continue
      /* 只有缝 (这一行段体还没开始/已结束) 也要进表, 否则熄灭时那一小块缝
       * 不会被暗槽色覆盖, 环上会出现 1~4px 的黑点 (参考实现同样处理)。 */
      bodyRows.push([y, b ? b[1] : 0, b ? b[2] : 0, g ? g[1] : 0, g ? g[2] : 0])
      const span = (b ? b[2] : 0) + (g ? g[2] : 0)
      if (span > maxN) maxN = span
      count++
    }
    ofs[s + 1] = count
  }

  /* uint8 字段 / uint16 偏移的硬边界: 越界直接判不支持, 不生成半套 */
  if (count === 0) {
    return { ok: false, code: 'empty', reason: '圆环在屏幕内没有任何像素 (可能被移出屏幕), 表为空' }
  }
  if (count > 65535) {
    return { ok: false, code: 'too-many-rows', reason: `表行数 ${count} 超出 uint16 偏移上限` }
  }
  for (const [y, xb, nb, xg, ng] of bodyRows) {
    if (y > 255 || xb > 255 || xg > 255 || nb > 255 || ng > 255) {
      return { ok: false, code: 'coord-overflow',
        reason: `行 (${y}: ${xb}+${nb}, ${xg}+${ng}) 超出 uint8 字段上限, 表结构装不下` }
    }
  }

  const bytes = count * 5 + (n + 1) * 2
  const hdr = []
  hdr.push(banner === 'tool' ? BANNER_TOOL : BANNER_WEB)
  hdr.push(' *')
  hdr.push(' * 圆环每段的逐行几何: 段体 (xb,nb) + 缝/分隔线 (xg,ng)。')
  hdr.push(' * 段体色随点亮状态变 (ringGrad70[seg] / arcTrack), 缝色同理 (暗槽色 / arcTrack)。')
  hdr.push(' *')
  hdr.push(` * 生成参数 (来自 ring_config.h): C=(${cx},${cy}) R=${rIn}..${rOut} 起始=${start}(0.5°) 跨度=${range}(0.5°)`)
  hdr.push(` *                               N=${n} PITCH=${pitch} BODY=${body} (x0.0001°)`)
  hdr.push(` * 表大小: ${count} 行 × 5B + 偏移 ${n + 1} × 2B = ${bytes} B`)
  hdr.push(' */')
  hdr.push('#ifndef __RING_SEG_SPANS_H__')
  hdr.push('#define __RING_SEG_SPANS_H__')
  hdr.push('')
  hdr.push('#include <stdint.h>')
  hdr.push('')
  hdr.push('/* 几何指纹: bsp_ring.c 编译期核对, 表过期(改了 ring_config.h 却没重跑')
  hdr.push(' * gen_ring_spans.py) 直接 #error, 不会画出错位的环。 */')
  hdr.push('#define RING_SPAN_CFG_CX      ' + cx)
  hdr.push('#define RING_SPAN_CFG_CY      ' + cy)
  hdr.push('#define RING_SPAN_CFG_RIN     ' + rIn)
  hdr.push('#define RING_SPAN_CFG_ROUT    ' + rOut)
  hdr.push('#define RING_SPAN_CFG_START   ' + start)
  hdr.push('#define RING_SPAN_CFG_RANGE   ' + range)
  hdr.push('#define RING_SPAN_CFG_N       ' + n)
  hdr.push('#define RING_SPAN_CFG_PITCH   ' + pitch)
  hdr.push('#define RING_SPAN_CFG_BODY    ' + body)
  hdr.push('')
  hdr.push('#define RING_SPAN_SEGS      ' + n)
  hdr.push('#define RING_SPAN_ROWS      ' + count)
  hdr.push('#define RING_SPAN_MAX_N     ' + maxN + '      /* 单行最长跨度 (运行期缓冲大小) */')
  hdr.push('')
  hdr.push('typedef struct {')
  hdr.push('    uint8_t y;      /* 行 */')
  hdr.push('    uint8_t xb;     /* 段体起始列 */')
  hdr.push('    uint8_t nb;     /* 段体像素数: 点亮 = ringGrad70[seg], 熄灭 = arcTrack */')
  hdr.push('    uint8_t xg;     /* 缝(分隔线)起始列, ng==0 时无意义 */')
  hdr.push('    uint8_t ng;     /* 缝像素数: 点亮 = 暗槽色, 熄灭 = arcTrack */')
  hdr.push('} RingSegRow;')
  hdr.push('')
  hdr.push('extern const RingSegRow  ringSegRows[RING_SPAN_ROWS];')
  hdr.push('extern const uint16_t    ringSegRowOfs[RING_SPAN_SEGS + 1];')
  hdr.push('')
  hdr.push('#endif')

  const txt = ['', 'const uint16_t ringSegRowOfs[RING_SPAN_SEGS + 1] = {']
  for (let i = 0; i <= n; i += 12) {
    txt.push('    ' + ofs.slice(i, i + 12).map(v => pad(v, 4)).join(', ') + ',')
  }
  txt.push('};')
  txt.push('')
  txt.push('const RingSegRow ringSegRows[RING_SPAN_ROWS] = {')
  for (let s = 0; s < n; s++) {
    txt.push('    /* seg ' + pad(s, 2) + ': ' + (ofs[s + 1] - ofs[s]) + ' 行 */')
    for (let k = ofs[s]; k < ofs[s + 1]; k++) {
      const [y, xb, nb, xg, ng] = bodyRows[k]
      txt.push('    { ' + pad(y, 3) + ', ' + pad(xb, 3) + ', ' + pad(nb, 2) + ', ' + pad(xg, 3) + ', ' + pad(ng, 2) + ' },')
    }
  }
  txt.push('};')

  return {
    ok: true,
    header: hdr.join('\n') + '\n' + txt.join('\n') + '\n',
    bytes,
    rows: count,
    segs: n,
    maxN,
    params: p,
  }
}

const cache = new Map()
function cachedRender(p, banner) {
  const key = [banner, p.W, p.H, p.cx, p.cy, p.rIn, p.rOut, p.start, p.range, p.n, p.pitch, p.body].join(',')
  let hit = cache.get(key)
  if (!hit) {
    hit = renderTable(p, banner)
    cache.set(key, hit)
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  }
  return hit
}

/**
 * 生成 ring_seg_spans.h。
 * opts.configText = 本次导出的 ring_config.h 文本: 给了就核对 9 个几何指纹,
 *   对不上直接跳过 (绝不写一张和配置不同步的表)。
 * opts.banner = 'web' (默认) | 'tool' (与 Python 逐字节相同的出处行, 仅自检用)。
 */
export function buildRingSegSpans(inst, sc, opts = {}) {
  const pre = ringSpanParams(inst, sc, opts)
  if (!pre.ok) return pre
  let out
  try {
    out = cachedRender(pre.params, opts.banner === 'tool' ? 'tool' : 'web')
  } catch (e) {
    return { ok: false, code: 'error', reason: '生成失败: ' + (e && e.message ? e.message : e) }
  }
  if (!out.ok) return out
  if (opts.configText && !fingerprintMatches(out.header, opts.configText)) {
    return { ok: false, code: 'fingerprint',
      reason: '生成的表与本次 ring_config.h 的几何指纹不一致 (内部参数没同步), 已跳过; 这是导出器 bug, 请反馈' }
  }
  return out
}

/** 只给面板/统计用的摘要 (不返回整段文本, 避免组件拿着大字符串) */
export function ringSpansInfo(inst, sc, opts = {}) {
  const r = buildRingSegSpans(inst, sc, opts)
  if (!r.ok) return { ok: false, code: r.code, reason: r.reason }
  return { ok: true, code: '', reason: '', bytes: r.bytes, rows: r.rows, segs: r.segs, maxN: r.maxN }
}

const CFG_MACRO = {
  CX: 'RING_CX', CY: 'RING_CY', RIN: 'RING_R_IN', ROUT: 'RING_R_OUT',
  START: 'RING_ARC_START_DEF', RANGE: 'RING_ARC_SPAN_DEF', N: 'RING_SEG_N',
  PITCH: 'RING_SEG_PITCH_X10000', BODY: 'RING_SEG_BODY_X10000',
}

/** 表里的 RING_SPAN_CFG_* 是否与 ring_config.h 的 9 个宏逐项相等 */
export function fingerprintMatches(spanHeader, configText) {
  if (!spanHeader || !configText) return false
  for (const [name, cfgName] of Object.entries(CFG_MACRO)) {
    const a = spanHeader.match(new RegExp('#define\\s+RING_SPAN_CFG_' + name + '\\s+(-?\\d+)'))
    const b = configText.match(new RegExp('#define\\s+' + cfgName + '\\s+(-?\\d+)'))
    if (!a || !b || Number(a[1]) !== Number(b[1])) return false
  }
  return true
}
