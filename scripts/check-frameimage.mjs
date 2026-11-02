/*
 * 导出图片 (预览当前帧 → 1 张 PNG 下载) 自检: node scripts/check-frameimage.mjs
 *
 * 用户需求: "web 增加导出图片功能, 可以导出预览窗口当前帧位 1 张图片下载" +
 *           "屏幕是圆形的, 导出希望带有圆形的无填充半透明提示" + "默认背景色黑色".
 *
 * 验证 src/frameshoot.js (预览与导出共用的那一处):
 *   1) paintFrame: 导出的像素 = 预览的像素 —— 屏幕底色铺满 + 按图层顺序合成 + 坐标与预览同一取整;
 *      圆环走 drawRing 直绘 (底色也传进去当 AA 的淡出目标); **不带任何编辑辅助**
 *      (圆屏蒙版 / 越界告警 / 网格 / 选框都不在这里, 那是 ScreenStage 叠加的);
 *   2) drawRoundHint: 圆屏提示三选一 —— 圆周细线 (无填充, 半透明) / 圆外压暗 / 无; 方屏一律不画;
 *   3) frameImageName / imageFileName: 文件名清洗 (怪字符 → _, 名字里已有尺寸就不重复追加);
 *   4) shootFrameImage: 一整下"导出"动作 —— 画布尺寸 = 屏幕分辨率 (1:1)、PNG dataURL、
 *      <a download> 点一下、返回文件名 (用桩 document 记录, Node 里没有真画布)。
 */
import fs from 'node:fs'
import { paintFrame, drawRoundHint, shootFrameImage, frameImageName, imageFileName, bgCss } from '../src/frameshoot.js'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}

/* ---- 记录式 canvas / ctx / <a> 桩 (drawRing 还要 createImageData/putImageData + 离屏画布) ---- */
const made = []       // createElement 出来的所有元素
const clicks = []     // <a>.click() 的下载动作
function mkCtx() {
  const c = {
    calls: [],
    imageSmoothingEnabled: true,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalCompositeOperation: 'source-over',
    fills: [],
    fillRect: (...a) => {
      c.calls.push(['fillRect', ...a])
      c.fills.push({ x: a[0], y: a[1], w: a[2], h: a[3], op: c.globalCompositeOperation })
    },
    drawImage: (...a) => c.calls.push(['drawImage', a.length, a[1], a[2]]),
    clearRect: (...a) => c.calls.push(['clearRect', ...a]),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (...a) => c.calls.push(['putImageData', a[1], a[2]]),
    getImageData: (...a) => {
      c.calls.push(['getImageData', ...a])            /* 导出路径不该出现 (编辑辅助才要) */
      return { width: a[2], height: a[3], data: new Uint8ClampedArray(a[2] * a[3] * 4) }
    },
    save: () => c.calls.push(['save']), restore: () => c.calls.push(['restore']),
    beginPath: () => c.calls.push(['beginPath']), arc: (...a) => c.calls.push(['arc', ...a]),
    rect: (...a) => c.calls.push(['rect', ...a]),
    fill: (...a) => c.calls.push(['fill', ...a, 'style=' + c.fillStyle]),
    stroke: () => c.calls.push(['stroke', 'style=' + c.strokeStyle, 'w=' + c.lineWidth]),
  }
  return c
}
globalThis.document = {
  createElement() {
    const el = {
      width: 0, height: 0, href: '', download: '',
      getContext: () => (el._ctx || (el._ctx = mkCtx())),
      toDataURL: (type) => { el._png = type; return 'data:image/png;base64,TEST' },
      click: () => clicks.push({ href: el.href, download: el.download }),
    }
    made.push(el)
    return el
  },
}
const has = (c, kind) => c.calls.some(x => x[0] === kind)
const kindCalls = (c, kind) => c.calls.filter(x => x[0] === kind)

/* ---- 1) paintFrame: 底色铺满 + 图层顺序 + 坐标取整 + 跳过空 proc ---- */
{
  const imgA = { canvas: { name: 'A' } }, imgB = { canvas: { name: 'B' } }
  const layers = [
    { inst: { kind: 'image', x: 1.4, y: 2.6, w: 10, h: 10 }, proc: imgA },   // → (1, 3)
    { inst: { kind: 'image', x: -3.2, y: 0.5, w: 4, h: 4 }, proc: null },     // 没算好画布 → 跳过
    { inst: { kind: 'image', x: 7, y: 8, w: 2, h: 2 }, proc: imgB },          // 盖在上面 (顺序)
  ]
  const ctx = mkCtx()
  paintFrame(ctx, { w: 240, h: 240, layers })
  ok('导出: 先铺满屏幕底色 (尺寸 = 屏幕分辨率, 不是缩放后的显示尺寸)',
     ctx.calls[0][0] === 'fillRect' && ctx.calls[0].slice(1).join(',') === '0,0,240,240')
  ok('导出: 底色默认黑 (老预设没有 bg 字段 → 0x0000)',
     ctx.fillStyle === 'rgb(0,0,0)' && bgCss(undefined) === 'rgb(0,0,0)' && bgCss(0x0000) === 'rgb(0,0,0)')
  ok('导出: 屏幕预设的背景色生效 (565 → CSS, 预览/导出同一套换算)',
     bgCss(0xF800) === 'rgb(255,0,0)' && bgCss(0x07E0) === 'rgb(0,255,0)')
  {
    const c2 = mkCtx()
    paintFrame(c2, { w: 8, h: 8, layers: [], bg: 0xFFFF })
    ok('导出: 传了底色就用底色 (白底示例)', c2.fillStyle === 'rgb(255,255,255)', c2.fillStyle)
  }
  ok('导出: 关闭插值 (imageSmoothingEnabled=false, 与预览同一条 nearest 路径)',
     ctx.imageSmoothingEnabled === false)
  const draws = kindCalls(ctx, 'drawImage')
  ok('导出: 每个有画布的图层各画一次, 顺序 = 图层顺序 (后画的压在上面)',
     draws.length === 2 && draws[0][1] === 3 && draws[1][1] === 3, JSON.stringify(draws))
  ok('导出: 坐标按 Math.round 取整 (与预览 drawImage 一致, 不出现半像素)',
     draws[0][2] === 1 && draws[0][3] === 3 && draws[1][2] === 7 && draws[1][3] === 8)
  ok('导出: proc 为空的图层跳过, 不抛错', draws.length === 2)
  ok('导出: 不叠加任何编辑辅助 (无圆屏蒙版 evenodd / 无告警 getImageData / 无选框)',
     !has(ctx, 'getImageData') && !has(ctx, 'beginPath') && !has(ctx, 'arc') && !has(ctx, 'fill'))
  /* 用户: "主页导出图片需要自动添加背景色" —— 收尾再用 destination-over 垫一次:
   * 只补"仍然透明"的像素, 已画好的图层一个都不动 ⇒ 导出的 PNG 永远不透明。 */
  const opFills = ctx.fills.filter(f => f.op === 'destination-over')
  ok('导出: 收尾用 destination-over 把底色补到透明像素上 (整帧不留透明洞)',
     opFills.length === 1 && opFills[0].x === 0 && opFills[0].y === 0 &&
     opFills[0].w === 240 && opFills[0].h === 240 &&
     ctx.fills[0].op === 'source-over' && ctx.fills[ctx.fills.length - 1].op === 'destination-over',
     JSON.stringify(ctx.fills.map(f => f.op)))
}

/* ---- 2) 圆环图层: 走 drawRing 直绘 (不是 proc 画布), 用它自己的 w/h 建离屏, 底色传给 AA ---- */
{
  made.length = 0
  const ctx = mkCtx()
  paintFrame(ctx, {
    w: 64, h: 48, bg: 0xFFFF,
    layers: [{ inst: { kind: 'ring', x: 3, y: 4, w: 20, h: 16, ring: { rOut: 8, rIn: 4 } }, proc: null }],
  })
  const off = made.find(c => c.width === 20 && c.height === 16)
  ok('导出: 圆环走 drawRing 直绘 (用实例 w×h 建离屏画布 + putImageData)',
     !!off && has(ctx, 'drawImage'))
  /* ！整帧合成里圆环**不许 clearRect** 自己的包围盒: 那会把底色/下层图片擦成透明洞
   *   (导出 PNG 里就是一块透明矩形 —— 用户报的"导出图片没有背景色"就是这个) */
  ok('导出: 圆环不再 clearRect 包围盒 (clear:false, 不会把底色/下层擦成透明洞)',
     !has(ctx, 'clearRect'))
  ok('导出: 圆环落在实例坐标上 (drawImage 用取整后的 x,y)',
     ctx.calls.some(x => x[0] === 'drawImage' && x[2] === 3 && x[3] === 4))
}

/* ---- 3) 圆屏提示 ---- */
{
  const round240 = { w: 240, h: 240, round: true }
  const square = { w: 128, h: 128, round: false }

  const ring = mkCtx()
  drawRoundHint(ring, { screen: round240, hint: 'ring' })
  const arcs = kindCalls(ring, 'arc')
  const strokes = kindCalls(ring, 'stroke')
  ok('圆屏提示·圆周细线: 默认不填充 (没有 fill), 只描两圈 (暗/亮双色, 亮底暗底都看得见)',
     !has(ring, 'fill') && arcs.length === 2 && strokes.length === 2 &&
     /255, 255, 255/.test(strokes[1][1]) && /0, 0, 0/.test(strokes[0][1]), JSON.stringify(strokes))
  ok('圆屏提示·圆周细线: 圆半径用屏幕预设的可用圆 (240×240 内切 = r120, 描在 r-0.5 / r-1.5)',
     Math.abs(arcs[0][3] - 119.5) < 1e-6 && Math.abs(arcs[1][3] - 118.5) < 1e-6 &&
     arcs[0][1] === 120 && arcs[0][2] === 120, JSON.stringify(arcs.map(a => a.slice(1))))

  const mask = mkCtx()
  drawRoundHint(mask, { screen: round240, hint: 'mask' })
  ok('圆屏提示·圆外压暗: 与预览同一层遮罩 (rect + arc + evenodd, 圆内不动)',
     has(mask, 'fill') && kindCalls(mask, 'fill').some(x => x.includes('evenodd')) &&
     has(mask, 'arc') && !has(mask, 'stroke'))

  {
    const c = mkCtx()
    drawRoundHint(c, { screen: round240, hint: 'none' })
    ok('圆屏提示·不要: 一个像素都不画', c.calls.length === 0)
  }
  {
    /* 老工程没有这个选项 → 缺省 = 圆周细线 (与 ExportPanel 的 `|| 'ring'` 一致) */
    const c = mkCtx()
    drawRoundHint(c, { screen: round240, hint: undefined })
    ok('圆屏提示·缺省 (老工程没配过): 按圆周细线走, 不是"什么都没有"',
       kindCalls(c, 'stroke').length === 2 && kindCalls(c, 'arc').length === 2)
  }
  const sq = mkCtx()
  drawRoundHint(sq, { screen: square, hint: 'ring' })
  ok('圆屏提示: 方屏预设不画 (只有圆屏才有这个提示)', sq.calls.length === 0)
}

/* ---- 4) 文件名 ---- */
{
  ok('文件名: 名字里已带尺寸就不重复追加 (_240x240 只出现一次)',
     frameImageName('1.28R-240x240-', 240, 240) === 'lcd_1.28R-240x240.png',
     frameImageName('1.28R-240x240-', 240, 240))
  ok('文件名: 普通名字带上分辨率',
     frameImageName('my screen', 128, 128) === 'lcd_my_screen_128x128.png',
     frameImageName('my screen', 128, 128))
  ok('文件名: 名字被洗干净 (纯中文) 就只用分辨率, 不会出现双下划线/空名',
     frameImageName('我的屏', 170, 320) === 'lcd_170x320.png', frameImageName('我的屏', 170, 320))
  ok('文件名: 空名字/无屏幕对象兜底成 layout',
     frameImageName('', 240, 170) === 'lcd_240x170.png' &&
     frameImageName(undefined, 240, 170) === 'lcd_240x170.png')
  ok('文件名: 素材/字库/文字这些弹窗用各自前缀 (同一套清洗规则)',
     imageFileName('img', 'logo.png', 64, 32) === 'img_logo_64x32.png' &&
     imageFileName('font', 'ascii1408', 128, 16) === 'font_ascii1408_128x16.png' &&
     imageFileName('ring', 'ring1', 240, 240) === 'ring_ring1_240x240.png')
}

/* ---- 5) 一整下"导出图片": 画布 1:1 + 底色 + 圆屏提示 + PNG + <a download> 点一次 ---- */
{
  made.length = 0; clicks.length = 0
  const proc = { canvas: { name: 'A' } }
  const name = shootFrameImage({
    w: 240, h: 240, screenName: '1.28R-240x240-', bg: 0x0000,
    screen: { w: 240, h: 240, round: true }, hint: 'ring',
    layers: [{ inst: { kind: 'image', x: 5, y: 6, w: 9, h: 9 }, proc }],
  })
  ok('导出图片: 返回的文件名 = lcd_<屏幕名>.png (与下载用的同一个)',
     name === 'lcd_1.28R-240x240.png', name)
  const cv = made.find(c => c.width === 240 && c.height === 240 && c._png)
  ok('导出图片: 画布尺寸 = 屏幕分辨率 1:1 (不是舞台缩放后的显示尺寸)',
     !!cv && cv.width === 240 && cv.height === 240)
  ok('导出图片: 画布真的按预览同一段绘制 (底色 + 图层 drawImage)',
     !!cv && has(cv._ctx, 'fillRect') && has(cv._ctx, 'drawImage') && cv._ctx.fillStyle === 'rgb(0,0,0)')
  ok('导出图片: 圆屏提示画在导出图上 (细线两圈 stroke), 但底色/图层不受影响',
     !!cv && kindCalls(cv._ctx, 'stroke').length === 2 && !has(cv._ctx, 'getImageData'))
  ok('导出图片: 用 PNG dataURL (不糊/无损), 不导成 JPEG', !!cv && cv._png === 'image/png')
  ok('导出图片: 触发 1 次 <a download> 下载, 文件名对得上',
     clicks.length === 1 && clicks[0].download === 'lcd_1.28R-240x240.png' &&
     clicks[0].href === 'data:image/png;base64,TEST', JSON.stringify(clicks))

  /* 方屏 + 不要提示: 只画底色和图层 */
  made.length = 0; clicks.length = 0
  shootFrameImage({
    w: 128, h: 128, screenName: '1.2-128x128', bg: 0x0000,
    screen: { w: 128, h: 128, round: false }, hint: 'ring', layers: [],
  })
  const cv2 = made.find(c => c.width === 128 && c.height === 128 && c._png)
  ok('导出图片: 方屏不画圆屏提示 (设置了也不画)', !!cv2 && !has(cv2._ctx, 'stroke') && !has(cv2._ctx, 'arc'))
}

/* ---- 6) 接线: 预览与导出共用同一段像素绘制; 按钮在右栏 (不在一键导出里) ---- */
{
  const stage = fs.readFileSync(new URL('../src/components/ScreenStage.vue', import.meta.url), 'utf8')
  const panel = fs.readFileSync(new URL('../src/components/ExportPanel.vue', import.meta.url), 'utf8')
  const shoot = fs.readFileSync(new URL('../src/frameshoot.js', import.meta.url), 'utf8')
  ok('预览走 frameshoot.paintFrame (render 里那一处, 图层 = store.frameLayers())',
     (stage.match(/paintFrame\(/g) || []).length === 1 &&
     /paintFrame\(ctx, \{ w: cv\.width, h: cv\.height, layers: frameLayers\(\), bg: sc\.value\.bg \}\)/.test(stage))
  ok('预览不再自己拿导出按钮 (挪到右栏导出区了): ScreenStage 里没有 shootFrameImage/toDataURL',
     !/shootFrameImage/.test(stage) && !/toDataURL/.test(stage))
  ok('「导出图片」按钮在右栏导出区, 调 frameshoot.shootFrameImage (不自己重画一遍)',
     /shootFrameImage\(\{/.test(panel) && /layers: frameLayers\(\)/.test(panel) &&
     /bg: sc\.value\.bg/.test(panel) && /screen: sc\.value/.test(panel) &&
     /hint: shootHint\.value/.test(panel) && !/toDataURL/.test(panel))
  /* paintFrame = 只画屏幕像素; 圆屏提示是"另画一层"的导出装饰, ScreenStage 的编辑蒙版仍是它自己的 */
  const paintBody = shoot.slice(shoot.indexOf('export function paintFrame'), shoot.indexOf('export function drawRoundHint'))
  ok('paintFrame 只画底色 + 图层 (编辑辅助留在 ScreenStage: 那边仍有自己的 evenodd 蒙版)',
     !/evenodd/.test(paintBody) && /evenodd/.test(stage) && /drawRoundHint/.test(shoot))
  /* 圆环的边缘 AA 要往屏幕底色淡出 (底色可配之后不能还写死 0x0000) */
  const ring = fs.readFileSync(new URL('../src/ringrender.js', import.meta.url), 'utf8')
  ok('圆环 AA: drawRing 收 opts.bg 并往它淡出 (不再写死黑)',
     /export function drawRing\(ctx, inst, opts = \{\}\)/.test(ring) &&
     /const bg565 = \(Number\(opts\.bg\) \|\| 0\) & 0xFFFF/.test(ring) &&
     (ring.match(/mix565\(bg565, lit,/g) || []).length === 2)
  ok('圆环: clear 开关默认 true (RingDialog 反复重画靠它清上一帧), 整帧合成传 clear:false',
     /if \(opts\.clear !== false\) ctx\.clearRect\(dx, dy, w, h\)/.test(ring) &&
     /drawRing\(ctx, inst, \{ bg, clear: false \}\)/.test(shoot))
}

/* ---- 7) 用户: "单独的素材属性不需要背景色" —— 各弹窗的「图片下载」不许铺屏幕底色 ---- */
{
  const read = (f) => fs.readFileSync(new URL(`../src/components/${f}`, import.meta.url), 'utf8')
  for (const f of ['InstanceDialog.vue', 'FontSplitDialog.vue', 'FrameManageDialog.vue',
                   'TextDialog.vue', 'RingDialog.vue']) {
    const src = read(f)
    ok(`${f}: 图片下载不铺屏幕底色 (透明底: 不 import/调用 paintFrame·bgCss·shootFrameImage, 不画 fillRect)`,
       !/paintFrame|bgCss|shootFrameImage/.test(src) && !/fillRect/.test(src) &&
       /downloadCanvasPng\(/.test(src))
  }
  ok('素材导出的文件名/画布按素材(格子)原始尺寸 (与屏幕分辨率无关)',
     /imageFileName\('img'/.test(read('InstanceDialog.vue')) &&
     /imageFileName\('frame'/.test(read('FrameManageDialog.vue')) &&
     /imageFileName\('font'/.test(read('FontSplitDialog.vue')))
}

console.log(fails ? `\n${fails} 项未通过` : '\n全部通过')
process.exit(fails ? 1 : 0)
