/*
 * 圆角矩形环 (网页预览版) 自检: node scripts/check-ringrect.mjs
 * 几何 = "周长参数 t + 到中心线的有符号距离 d"(ringRectPath/ringRectPointAt) +
 *        "外框内 ∩ 内框外"的环带 (ringRectBand, 内外圆角各自带 AA) +
 *        参数推导 (ringRectGeom: 外圆角/内圆角/中心线)。
 * 这里做往返对拍与边界断言, 保证 drawRing 用到的判据 (进度弧/白斑沿边框跑) 不会错位。
 */
import { ringRectPath, ringRectPointAt, ringRectBand, ringRectGeom, ringLapPx,
         ringArcGeom, ringArcFillW } from '../src/ringrender.js'

let fails = 0
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`); if (!c) fails++ }

const GEOMS = [[100, 60, 20], [120, 120, 60], [80, 40, 0], [50, 30, 30], [140, 80, 8]]

/* 1) 点 ↔ 周长位置 往返: pointAt(t) 再算回来必须是同一个 t, 且 d≈0 (落在中心线上) */
{
  let bad = 0, n = 0
  for (const [hx, hy, rc] of GEOMS) {
    for (let i = 0; i < 400; i++) {
      const t0 = i / 400
      const p = ringRectPointAt(t0, hx, hy, rc)
      const r = ringRectPath(p.x, p.y, hx, hy, rc)
      const dt = Math.min(Math.abs(r.t - t0), 1 - Math.abs(r.t - t0))
      n++
      if (dt > 1e-6 || Math.abs(r.d) > 1e-6) bad++
    }
  }
  ok(`周长参数往返 (${GEOMS.length} 组几何 × 400 点): pointAt(t) → path() 还是同一个 t 且 d=0`,
     bad === 0, bad ? bad + ' 处不符' : n + ' 点全对')
}

/* 2) 一圈的弧长 = 周长 (rc=0 → 4(hx+hy); 有圆角 → 4(ex+ey)+2πr) */
{
  const [hx, hy, rc] = [120, 70, 24]
  const ex = hx - rc, ey = hy - rc
  const per = 4 * (ex + ey) + 2 * Math.PI * rc
  let sum = 0
  const N = 2000
  let prev = ringRectPointAt(0, hx, hy, rc)
  for (let i = 1; i <= N; i++) {
    const p = ringRectPointAt(i / N, hx, hy, rc)
    sum += Math.hypot(p.x - prev.x, p.y - prev.y)
    prev = p
  }
  ok('周长一致: 采样一圈的折线长度 ≈ 4(直边)+2πr',
     Math.abs(sum - per) / per < 0.005, `采样 ${sum.toFixed(2)} vs 公式 ${per.toFixed(2)}`)
}

/* 3) 关键位置: 顶部中点 t=0 (角 = -90°), 右侧中 t=0.25 (0°), 底部 t=0.5 (90°), 左侧 t=0.75 (180°) */
{
  const [hx, hy, rc] = [100, 60, 20]
  const a = (t) => { const p = ringRectPointAt(t, hx, hy, rc); return ringRectPath(p.x, p.y, hx, hy, rc).a * 180 / Math.PI }
  const near = (v, w) => Math.abs(v - w) < 1e-6
  ok('等效角约定: 顶部 = -90°(起始角默认值), 顺时针 → 右 0° / 下 90° / 左 180° (与圆环同一套)',
     near(a(0), -90) && near(a(0.25), 0) && near(a(0.5), 90) && near(a(0.75), 180),
     [a(0), a(0.25), a(0.5), a(0.75)].map(v => v.toFixed(1)).join(' / '))
}

/* 4) 有符号距离 (中心线): 外边 +5 / 内边 -5 */
{
  const [hx, hy, rc] = [100, 60, 20]
  const out = ringRectPath(0, -hy - 5, hx, hy, rc).d
  const inn = ringRectPath(0, -hy + 5, hx, hy, rc).d
  ok('有符号距离: 中心线外侧 +5 / 内侧 -5', Math.abs(out - 5) < 1e-6 && Math.abs(inn + 5) < 1e-6, `${out.toFixed(3)} / ${inn.toFixed(3)}`)
}

/* 5) 环带 + 边缘 AA (同心圆角): 中心线最实, 到边界渐隐到 0, 内孔/带外都是 null */
{
  const g = ringRectGeom(220, 140, { rad: 24, thick: 12, inset: 12, aa: 2 })   // ht = 6
  const p0 = ringRectPointAt(0.1, g.hx, g.hy, g.rc)                        // 中心线上一点 (上边)
  const at = (off) => ringRectBand(p0.x, p0.y + off, g)                    // 沿法线 (上下) 挪
  const mid = at(0), half = at(g.ht - g.aa / 2), edge = at(g.ht), out = at(g.ht + g.aa + 1), hole = at(-g.ht - g.aa - 1)
  ok('环带 (同心圆角): 中心线 cov=1, 半环厚-AA/2 处 ≈0.5, 到边界 =0, 带外/内孔 = null',
     mid && mid.cov === 1 && half && Math.abs(half.cov - 0.5) < 1e-6 && edge === null && out === null && hole === null,
     `cov=${mid && mid.cov} / ${half && half.cov.toFixed(3)} / ${edge} / ${out} / ${hole}`)
}

/* 6) 内外圆角独立: 沿"角对角线"量角上的环带厚度 —— 内圆角越大, 角上越厚 */
{
  const base = { rad: 24, thick: 10, inset: 12, aa: 0.5 }
  const diagThick = (radIn) => {
    const g = ringRectGeom(160, 96, { ...base, radIn })
    const cx0 = g.ow / 2 - g.radOut, cy0 = -(g.oh / 2 - g.radOut)          // 右上角圆心 (相对画布中心)
    let inside = false, entry = 0, exit = 0
    for (let s = g.radOut + 2; s > -60; s -= 0.02) {               // 从带外沿 45° 往里走
      const x = cx0 + s / Math.SQRT2, y = cy0 - s / Math.SQRT2     // 右上角: 斜向外/内
      const hit = ringRectBand(x, y, g)
      if (hit && !inside) { inside = true; entry = s }
      else if (inside && !hit) { exit = s; break }
    }
    return entry - exit
  }
  const t0 = diagThick(0), t1 = diagThick(null), t2 = diagThick(24)
  ok('内外圆角可分别调: 角上环带厚度 内R=0 (最薄) < 默认同心 (=环厚) < 内R=外R (最厚)',
     t0 < t1 - 1 && Math.abs(t1 - 10) < 0.5 && t2 > t1 + 1,
     `内R=0: ${t0.toFixed(1)} / 默认(同心): ${t1.toFixed(1)} / 内R=外R: ${t2.toFixed(1)} px`)
}

/* 7) 参数推导: 外圆角下限 = 环厚+1 (内圆角 ≥1), 上限 = 半宽/半高; 内圆角默认 = 外 − 环厚 */
{
  const a = ringRectGeom(160, 96, { rad: 24, thick: 10, inset: 12, aa: 2 })
  ok('外圆角 24 + 环厚 10 → 中心线 19 / 内圆角 14 (= 外 − 环厚, 同心)',
     Math.abs(a.radOut - 24) < 1e-6 && Math.abs(a.radMid - 19) < 1e-6 && Math.abs(a.radIn - 14) < 1e-6,
     `外 ${a.radOut} / 中 ${a.radMid} / 内 ${a.radIn}`)
  const b = ringRectGeom(160, 96, { rad: 4, thick: 20, inset: 12, aa: 2 })
  ok('外圆角给太小 (4) 而环厚 20 → 抬到 环厚+1=21, 内圆角 1 (不会出现内尖角)',
     b.radOut >= 21 - 1e-6 && b.radIn >= 1 - 1e-6, `外 ${b.radOut} / 内 ${b.radIn}`)
  const c = ringRectGeom(160, 96, { rad: 999, thick: 10, inset: 12, aa: 2 })
  ok('外圆角超上限 → 夹到 min(W,H)/2 (胶囊形)', Math.abs(c.radOut - Math.min(160 - 12, 96 - 12) / 2) < 1e-6, `外 ${c.radOut}`)
  const d = ringRectGeom(160, 96, { rad: 24, radIn: 999, thick: 10, inset: 12, aa: 2 })
  ok('内圆角 > 外圆角 → 夹到外圆角 (等圆度上限)', Math.abs(d.radIn - d.radOut) < 1e-6, `内 ${d.radIn}`)
}

/* 8) 一圈弧长 (白斑步进折算): 圆 = 2π中径; 圆角矩形 = 周长 */
{
  const lap = ringLapPx(220, 140, { shape: 'rect', rad: 24, thick: 12, inset: 12, aa: 2 })
  const g = ringRectGeom(220, 140, { rad: 24, thick: 12, inset: 12, aa: 2 })
  const per = 4 * ((g.hx - g.rc) + (g.hy - g.rc)) + 2 * Math.PI * g.rc
  const cir = ringLapPx(240, 240, { rIn: 86, rOut: 120 })
  ok('一圈弧长: 圆角矩形 = 周长, 圆 = 2π·中径 (白斑 px/步 → 角度用这个折算)',
     Math.abs(lap - per) < 1e-6 && Math.abs(cir - 2 * Math.PI * 103) < 1e-6,
     `rect ${lap.toFixed(1)} / circle ${cir.toFixed(1)}`)
}

/* 9) 进度递增方向: 逆时针的楔形(含两端圆帽) = 顺时针关于"起始射线"的镜像 */
{
  const mk = (arcDir, value, steps) => {
    const cfg = { rIn: 86, rOut: 120, aa: 2, startDeg: -90, value, steps, caps: true, arcDir }
    cfg._g = ringArcGeom(cfg)
    return cfg
  }
  let bad = 0, n = 0
  for (const [value, steps] of [[10, 40], [20, 40], [30, 40], [5, 40]]) {
    const cw = mk(1, value, steps), ccw = mk(-1, value, steps)
    for (let deg = -360; deg < 360; deg += 0.25) {
      const rad = deg * Math.PI / 180, R = 103
      const dx = Math.cos(rad) * R, dy = Math.sin(rad) * R
      const dot = dy * -1                                  // 起始射线 n = (0,-1)
      const mx = -dx, my = 2 * dot * -1 - dy                // 关于该直线反射
      const a = ringArcFillW(dx, dy, cw), b = ringArcFillW(mx, my, ccw)
      n++
      if (Math.abs(a - b) > 1e-9) bad++
    }
  }
  ok('进度方向: 逆时针 = 顺时针的镜像 (楔形 + 两端圆帽, 4 组档位 × 2880 点)',
     bad === 0, bad ? bad + '/' + n + ' 处不符' : n + ' 点全一致')
}

/* 10) 留边 (总, px): 环带外沿的框 = 图层尺寸 − 留边; 老参数 pad 仍兼容 (pad*2) */
{
  const g = ringRectGeom(320, 170, { rad: 24, thick: 12, inset: 8, aa: 2 })
  const old = ringRectGeom(320, 170, { rad: 24, thick: 12, pad: 4, aa: 2 })        // 老工程: pad 4/边 = 8 总
  ok('留边是"总"余量: 320x170 + 留边 8 → 环带外沿 312x162 (图层尺寸不变); 老参数 pad 兼容',
     Math.abs(g.ow - 312) < 1e-6 && Math.abs(g.oh - 162) < 1e-6 &&
     Math.abs(old.ow - 312) < 1e-6, `inset: ${g.ow}x${g.oh} / pad(旧): ${old.ow}x${old.oh}`)
}

console.log(fails ? `\n有失败 (fail=${fails})` : '\n全部通过 (fail=0)')
process.exit(fails ? 1 : 0)
