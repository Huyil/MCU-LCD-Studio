/*
 * 「等距」自检 (零依赖: node scripts/check-even.mjs)
 *
 * 等距 = 字模格子按**最宽字迹**定宽 + 每个字按**字迹框**居中。
 *
 * 治病: 固件是**逐格等步进**画的, 而字体每个字的左右边距都不一样 —— 按字身 (advance) 居中时,
 *   每个字的字迹中心都偏一点 (MiSans @100px: '1' 偏 3.4px, 随字号线性放大),
 *   一排数字看着就左右不齐。窄字 ('.' 'i') 又被摆在很宽的格子正中, 空隙忽大忽小。
 *
 * 两节:
 *   A. **行为** —— 用真 MiSans 的字身/字迹度量桩一个 canvas, 跑**真的** numFontForSys,
 *      从它实际发出的 `drawImage(字模画布, dx, pad)` 里读出每个字的落点, 量"字迹中心离格心多远"。
 *        关掉 → 最差 3.4px (这就是病) ; 打开 → ≤0.5px (半像素取整, 这就是药)。
 *      同时钉住格子宽度: 关 = 最宽字身, 开 = 最宽字迹, 且不许把字迹裁掉。
 *   B. **接线** —— 两条造字路都接了, UI/回填/缓存键都对, 且**不**泄漏进导出格式与固件结构。
 *
 * 桩的度量取自 src/assets/fonts/misans-400.woff2 (fontTools 直接读轮廓), 所以"每个字左右边距
 * 不同"这件事是真的, 不是编出来的。
 */
const EM = {                      // 单位 em: [advance(字身), lsb(字迹左沿), inkW(字迹宽)]
  '-': [0.39400, 0.04200, 0.31000],
  '.': [0.24800, 0.07200, 0.10400],
  '0': [0.63400, 0.06200, 0.51000],
  '1': [0.40300, 0.05000, 0.23500],
  '2': [0.56600, 0.04600, 0.46700],
  '3': [0.59200, 0.05300, 0.48600],
  '4': [0.59100, 0.02800, 0.52700],
  '5': [0.60400, 0.05300, 0.48900],
  '6': [0.60600, 0.05500, 0.49900],
  '7': [0.52700, 0.03200, 0.44900],
  '8': [0.63000, 0.06200, 0.50600],
  '9': [0.60000, 0.04600, 0.49800],
}
const emOf = (ch) => EM[ch] || [0.6, 0.2, 0.36]      // 表外的字退回"居中 60%" (本自检用不到)

const created = []
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') return {}
    const cv = { width: 0, height: 0, _text: undefined, _draws: [] }
    let ctx = null
    cv.getContext = () => {
      if (ctx) return ctx
      ctx = {
        _font: '',
        imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (img) => { cv._px = img.data },
        fillText: (t) => { cv._text = String(t) },              // 记下"这张画布画的是哪个字"
        drawImage: (src, dx, dy) => { cv._draws.push({ src, dx, dy }) },   // 记下落点 (本自检的观测口)
        clearRect() {}, fillRect() {},
        /* 按"这张画布画的字"造墨迹: 位置/宽度用真 MiSans 的字迹分数 —— 于是左右边距真的不对称 */
        getImageData: (x, y, w, h) => {
          const d = new Uint8ClampedArray(w * h * 4)
          const ch = textOf(cv)
          const e = ch !== undefined ? emOf(String(ch)) : null
          const x0 = e ? Math.round(e[1] / e[0] * w) : Math.floor(w * 0.2)
          const x1 = e ? x0 + Math.max(1, Math.round(e[2] / e[0] * w)) : Math.ceil(w * 0.8)
          for (let yy = Math.floor(h * 0.15); yy < Math.ceil(h * 0.85); yy++) {
            for (let xx = x0; xx < x1; xx++) {
              if (xx < 0 || xx >= w) continue
              const i = (yy * w + xx) * 4
              d[i] = d[i + 1] = d[i + 2] = 255
              d[i + 3] = 255
            }
          }
          return { width: w, height: h, data: d }
        },
        measureText(t) {
          const m = /(\d+(?:\.\d+)?)px/.exec(this._font) || []
          const size = m ? parseFloat(m[1]) : 16
          return { width: emOf(String(t))[0] * size, actualBoundingBoxAscent: size * 0.72 }
        },
      }
      Object.defineProperty(ctx, 'font', { get() { return this._font }, set(v) { this._font = v } })
      return ctx
    }
    created.push(cv)
    return cv
  },
}

/* 画布沿 drawImage 链往下找到"这张图的字" —— 降采样那张自己没有 fillText, 字在链上游 */
function textOf(cv) {
  let c = cv
  for (let i = 0; i < 8 && c; i++) {
    if (c._text !== undefined) return c._text
    c = c._draws[0] && c._draws[0].src
  }
  return undefined
}
/* 到"字"有几跳: 单字画布 = 2 跳, 字模格子 = 3 跳 (用来把两类画布分开) */
function hops(cv) {
  let c = cv
  for (let n = 0; n < 9; n++) {
    if (!c) return -1
    if (c._text !== undefined) return n
    c = c._draws[0] && c._draws[0].src
  }
  return -1
}

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}

const store = await import('../src/store.js')
const { numFontForSys } = store
const { inkBox } = await import('../src/imageproc.js')

/* ---------- A. 行为: 真的跑 numFontForSys, 看它把每个字摆在格子里的哪儿 ---------- */
/* 用 100px 而不是 20px: 偏移随字号线性放大, 100px 下像素取整的噪声小得多 */
const BASE = { family: 'MiSans', size: 100, weight: 400, spacing: 0, offsetY: 0 }

function measure(even) {
  const from = created.length
  const font = numFontForSys({ ...BASE, evenSpacing: even }, 'even-check-' + even)
  const fresh = created.slice(from).filter(c => c._draws.length === 1)
  const cellCvs = fresh.filter(c => hops(c) === 3)
  const charCvs = fresh.filter(c => hops(c) === 2)
  /* charCvs[0] 是 numFontForSys 开头为量基线而多渲染的那张 '0' (不参与字模), 从第 2 张起才对应 NUM_CHARS */
  const chars = charCvs.slice(1)
  const rows = cellCvs.map((t, i) => {
    const cv = chars[i]
    const ib = inkBox(cv)
    const dx = t._draws[0].dx
    return ib ? { dx, cellW: t.width, cell: dx + ib.x + ib.w / 2, inkW: ib.w,
                  inkStart: dx + ib.x, inkEnd: dx + ib.x + ib.w } : null
  }).filter(Boolean)
  const dev = (r) => Math.abs(r.cell - r.cellW / 2)
  return {
    font, rows, chars, cellCvs,
    maxDev: Math.max(...rows.map(dev)),
    cw: font.w,
    advMax: Math.max(...chars.map(c => c.width)),
    inkMax: Math.max(...chars.map(c => (inkBox(c) || { w: 0 }).w)),
  }
}

const off = measure(false)
const on = measure(true)

ok('行为桩拿到了字模格子 (cell = char 数)', on.cellCvs.length > 0 && on.cellCvs.length === on.chars.length,
   `cell=${on.cellCvs.length} char=${on.chars.length}`)
ok('关掉: 格子宽 = 最宽**字身** (原行为)', off.cw === off.advMax, `cw=${off.cw} advMax=${off.advMax}`)
ok('打开: 格子宽 = 最宽**字迹**', on.cw === on.inkMax, `cw=${on.cw} inkMax=${on.inkMax}`)
ok('打开后格子确实变窄了 (贴住字迹)', on.cw < off.cw, `${off.cw} → ${on.cw}`)

/* 这一条是本功能的全部意义: 字迹中心离格心多远 */
ok('关掉: 字迹中心确实偏 (这就是要治的病)', off.maxDev >= 3,
   `最差 ${off.maxDev.toFixed(2)}px @100px`)
ok('打开: 每个字都落在格子正中 (只剩半像素取整)', on.maxDev <= 0.5,
   `最差 ${on.maxDev.toFixed(2)}px @100px`)
ok('打开比关掉好一个数量级', on.maxDev * 4 < off.maxDev,
   `${off.maxDev.toFixed(2)} → ${on.maxDev.toFixed(2)}px`)

/* 不能为了居中把字迹裁掉。注意 dx 允许为负 —— 那是在**剪掉字身左边的空白边距** (字迹仍从格内 x=0 起),
   真正的不变量是"墨迹落在格子里", 不是"画布落在格子里"。 */
ok('打开: 墨迹完整落在格子里 (dx 可为负, 那是在剪空边距)',
   on.rows.every(r => r.inkStart >= 0 && r.inkEnd <= r.cellW),
   on.rows.map(r => `[${r.inkStart},${r.inkEnd}]/${r.cellW}`).join(' '))
ok('打开: 格子宽 = 之前算出的最宽字迹 ⇒ 不会白留空间', on.cw === on.inkMax)

/* 关掉必须**逐字节回到老行为**: 格子宽、间距都不能变 */
ok('关掉: spacing = 0 (格子 = 字身宽, 与老版本一致)', off.font.spacing === 0, `= ${off.font.spacing}`)
ok('打开: spacing 报告为负 (格子收窄了, 界面据此提示)', on.font.spacing === on.cw - on.advMax,
   `= ${on.font.spacing}`)

/* ---------- B. 接线 ---------- */
const fs = await import('node:fs')
const storeSrc = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8')
const dlg = fs.readFileSync(new URL('../src/components/TextDialog.vue', import.meta.url), 'utf8')
const procSrc = fs.readFileSync(new URL('../src/imageproc.js', import.meta.url), 'utf8')

const numFn = storeSrc.slice(storeSrc.indexOf('export function numFontForSys'),
                             storeSrc.indexOf('export function numFontForSys') + 4600)
const asciiFn = storeSrc.slice(storeSrc.indexOf('export function asciiFontForSys'),
                               storeSrc.indexOf('export function asciiFontForSys') + 4600)

for (const [name, fn] of [['数字字库', numFn], ['ASCII 字库', asciiFn]]) {
  ok(`${name}: 读了 evenSpacing`, /const even = !!cfg\.evenSpacing/.test(fn))
  ok(`${name}: 等距时格子按最宽字迹定宽`, /const cw = even \? Math\.max\(1, inkMax\)/.test(fn))
  ok(`${name}: 等距时才去量字迹 (不白算 95 个字)`, /if \(even \|\| sp < 0\)/.test(fn))
  ok(`${name}: 等距时按字迹框居中`, /const ib = even \? inkBox\(cv\) : null/.test(fn) &&
     /Math\.round\(\(cw - ib\.w\) \/ 2\) - ib\.x/.test(fn))
}
ok('ASCII 字库缓存键带了 evenSpacing (不带会拿到上一份的字库)',
   /'asciisys'[\s\S]{0,300}!!cfg\.evenSpacing/.test(storeSrc))
ok('数字字库缓存键带整个 cfg (自动含 evenSpacing)', /JSON\.stringify\(\['numsys', cfg, key\]\)/.test(storeSrc))

ok('dialog 默认关 (新建的字库不会莫名变窄)', (dlg.match(/evenSpacing: false/g) || []).length >= 3)
ok('dialog 回填老图层 (老数据没有这个键, 必须显式兜 false)',
   /evenSpacing: !!it\.sysfont\.evenSpacing/.test(dlg))
ok('sysCfg 送出 evenSpacing (进 cfg 才到得了 store)', /evenSpacing: !!draft\.evenSpacing/.test(dlg))
ok('两个预览 watch 都盯了 evenSpacing', (dlg.match(/draft\.evenSpacing, draft\.glyphDx\]/g) || []).length >= 2)
ok('UI: 开关在「字距」行且只有 数字/ASCII 时显示',
   /v-model="draft\.evenSpacing"[\s\S]{0,400}?/.test(dlg.slice(dlg.indexOf('v-model="draft.evenSpacing"') - 700,
                                                             dlg.indexOf('v-model="draft.evenSpacing"') + 40)) &&
   /v-if="isNum \|\| isAscii"[\s\S]{0,300}v-model="draft\.evenSpacing"/.test(dlg))
/* 数字/ASCII 两行信息已并成**一行两段** (2026-10-17): 第二段 .fontinfo-meta 里才是会变的东西 */
ok('UI: 勾上时字库信息行标出「等距」(点落在第二行内)', (() => {
  const i = dlg.indexOf('class="fontinfo-meta"')
  if (i < 0) return false
  return /v-if="draft\.evenSpacing"> · 等距/.test(dlg.slice(i, dlg.indexOf('</div>', i)))
})())

/* 现场病根: 字距从 0 变 -1 时那一行长出一截折成两行, 把下面的按键顶下去了 ——
   第二行用 min-height 常驻占位, 行数恒定, 字距/等距怎么变行高都不动 */
ok('UI: 字库信息固定两行 (第二行 min-height 占位, 行高不随字距变)',
   /\.fontinfo-meta \{ display: block; min-height: 1\.4em/.test(dlg))

/* 等距只改**字模字节**, 不许泄漏进导出格式/固件结构 —— 固件那边一行都不用改 */
const noLeak = ['src/uiexport.js', 'src/layerexport.js', 'src/imageproc.js', 'src/ringrender.js',
                'src/asciifont.js', 'src/fwassets.js']
const leaked = noLeak.filter(f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8').includes('evenSpacing'))
ok('不泄漏进导出格式/固件结构 (只有 store.js 与对话框认识它)', leaked.length === 0, leaked.join(', '))
ok('imageproc 里没有 evenSpacing (纯像素层不认识它)', !procSrc.includes('evenSpacing'))

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
