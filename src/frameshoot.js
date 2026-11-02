/*
 * 预览帧 / 素材图导出 —— 「导出图片」与各弹窗「图片下载」共用的像素来源。
 *
 * 为什么单独一个模块: 预览 (ScreenStage.render) 与导出图片必须画的是同一样东西,
 * 否则迟早出现"预览里长这样, 下载下来不是这张"。这里只画**屏幕像素本身**
 * (屏幕底色 + 各图层, 与固件逐像素对拍过的那条路径), 编辑辅助 (网格 / 圆屏蒙版 /
 * 越界告警红 / 选中框 / 对齐线) 由 ScreenStage 自己叠加, 不进导出。
 *
 * 导入进来的 layers: [{ inst, proc }] —— proc = instanceProc(inst) 的量化画布
 * (圆环没有 proc, 由 drawRing 直绘)。
 */
import { drawRing } from './ringrender.js'
import { roundGeom } from './roundscreen.js'
import { rgb565To888 } from './colors.js'

/** 屏幕底色 (RGB565) → CSS 颜色; 缺省/非法 = 黑 (老预设/老工程没有 bg 字段) */
export function bgCss(bg) {
  const { r, g, b } = rgb565To888((Number(bg) || 0) & 0xFFFF)
  return `rgb(${r},${g},${b})`
}

/** 把"这一帧"画到 ctx 上 (1:1 屏幕像素, 坐标取整规则与预览完全一致; bg = 屏幕底色) */
export function paintFrame(ctx, { w, h, layers, bg = 0x0000 }) {
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = bgCss(bg)
  ctx.fillRect(0, 0, w, h)
  for (const it of layers || []) {
    const inst = it && it.inst
    if (!inst) continue
    /* 圆环: 直绘 (含动画), 不走 proc 画布; clear:false —— 别把底色/下层擦成透明洞 */
    if (inst.kind === 'ring') { drawRing(ctx, inst, { bg, clear: false }); continue }
    if (!it.proc) continue
    ctx.drawImage(it.proc.canvas, Math.round(inst.x), Math.round(inst.y))
  }
  /* 收尾: 把底色补到"仍然透明"的像素上 (destination-over = 只垫在透明处, 已有像素一个都不改)。
   * 用户要的「主页导出图片自动添加背景色」: 导出/预览永远是一张**不透明**的屏幕帧,
   * 透明素材/圆环边缘都落在屏幕上那个底色上, 不会留出透明洞。 */
  ctx.save()
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = bgCss(bg)
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
}

/**
 * 圆屏提示 (只画在**导出图**上, 预览里那层蒙版是编辑辅助, 另走一路):
 *   'ring' 圆周细线: 不填充、半透明, 只把圆屏边界勾勒出来 (默认) —— 用户要的"圆形的无填充半透明提示";
 *                  双色描边 (外面一道暗 + 里面一道亮), 黑底/亮底都看得见;
 *   'mask' 圆外压暗: 与预览同一层遮罩 (圆外盖 62% 暗色, 圆内一个像素都不动);
 *   'none' 不带提示 (要拿去做素材/叠加用)。
 * screen 传屏幕预设 (用它的 round / maskR / maskCx / maskCy, 与预览/告警同一份几何)。
 */
export function drawRoundHint(ctx, { screen, hint = 'ring' }) {
  if (!screen || !screen.round || !hint || hint === 'none') return
  const g = roundGeom(screen)
  ctx.save()
  if (hint === 'mask') {
    ctx.beginPath()
    ctx.rect(0, 0, g.w, g.h)
    ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(8, 11, 16, 0.62)'
    ctx.fill('evenodd')
  } else {
    ctx.lineWidth = 1
    for (const [rr, style] of [[Math.max(0.5, g.r - 0.5), 'rgba(0, 0, 0, 0.55)'],
                               [Math.max(0.5, g.r - 1.5), 'rgba(255, 255, 255, 0.5)']]) {
      ctx.beginPath()
      ctx.arc(g.cx, g.cy, rr, 0, Math.PI * 2)
      ctx.strokeStyle = style
      ctx.stroke()
    }
  }
  ctx.restore()
}

/**
 * 文件名: `<前缀>_<名字>_<宽>x<高>.<ext>`
 * · 名字里的怪字符压成 `_` (与 ExportPanel 的 `lcd_*.c` 同一套清洗)
 * · 名字里已经带了尺寸 (如 `1.28R-240x240-`) 就不重复追加 `_240x240`
 * · 名字整个被洗掉了 (纯中文等) 就退回 `<前缀>_<宽>x<高>`
 */
export function imageFileName(prefix, name, w, h, ext = 'png') {
  const size = `${Math.round(w)}x${Math.round(h)}`
  /* 素材名常带 .png/.jpg 后缀: 先脱掉, 免得出现 logo.png_64x32.png 这种双后缀 */
  const raw = String(name ?? '').replace(/\.(png|jpe?g|gif|bmp|webp|svg)$/i, '')
    .replace(/[^\w.-]+/g, '_').replace(/^[-_.]+|[-_.]+$/g, '')
  const base = raw || size
  const stem = (raw && !raw.includes(size)) ? `${base}_${size}` : base
  return `${prefix}_${stem}.${ext}`
}

/** 屏幕帧的文件名: lcd_<屏幕名>_<宽>x<高>.png */
export const frameImageName = (screenName, w, h, ext = 'png') => imageFileName('lcd', screenName, w, h, ext)

/**
 * 「导出图片」按钮就调这一下: 当前帧 → 1 张 PNG → 触发下载, 返回文件名。
 * · 画布尺寸 = 屏幕分辨率 (1:1 像素; 舞台上的缩放倍率不参与 —— 300% 看着大, 导出的还是 240×240)
 * · 像素 = paintFrame (与预览同源) + 可选的圆屏提示 (drawRoundHint)
 * · dataURL 同步下载 (尺寸只有几十~几百 KB): 不经过异步 toBlob, 用户手势不会过期
 */
export function shootFrameImage({ w, h, layers, screenName, bg = 0x0000, screen = null, hint = 'ring' }) {
  const cv = document.createElement('canvas')
  cv.width = Math.round(w); cv.height = Math.round(h)
  const ctx = cv.getContext('2d')
  paintFrame(ctx, { w: cv.width, h: cv.height, layers, bg })
  drawRoundHint(ctx, { screen, hint })
  const name = frameImageName(screenName, cv.width, cv.height)
  const a = document.createElement('a')
  a.href = cv.toDataURL('image/png')
  a.download = name
  a.click()
  return name
}
