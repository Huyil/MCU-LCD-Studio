/*
 * 图像处理: 高质量缩放 (逐级减半 + 高质量插值, 类 PS 双线性平滑) 与
 * RGB565 / RGB888 / GRAY 量化, C 数组文本生成。
 * 数据格式对齐工程驱动:
 *   - LCD_drawImage     pic = uint16 RGB565 数组 (color=0xFFFF 直显;
 *                       color!=0xFFFF 时 G 通道 6bit 视为灰度 × 颜色调制)
 *   - LCD_drawGrayImage gray= uint8 灰度数组 (× 颜色调制, mirror 镜像)
 *   - RGB888 模板风格: RGB888(R,G,B) 宏 (见 bsp_*.h) 编译期压为 RGB565
 */
import { rgb888To565, rgb565To888 } from './colors.js'
import { asciiFont, ASCII_FONT_W, ASCII_FONT_H, ASCII_MODE1_H } from './asciifont.js'

/* 维度防御: 非法输入统一收敛到安全范围 (防 0/NaN/超大 崩溃管线) */
const clampDim = v => {
  v = Math.round(+v)
  if (!Number.isFinite(v) || v < 1) v = 1
  if (v > 4096) v = 4096
  return v
}

/* 源图基础缓存: 原图一次性降到 ≤BASE_MAX, 后续重采样一律从 base 出发。
 * 避免每次改尺寸都从原始大图 (如 12MP 照片) 拷贝全尺寸 canvas —— 那是页面卡死/显存耗尽的根源。 */
const BASE_MAX = 1024
const baseCache = new WeakMap() // source -> canvas (≤1024)
function getBase(source) {
  const sw = source.naturalWidth || source.width
  const sh = source.naturalHeight || source.height
  if (sw <= BASE_MAX && sh <= BASE_MAX) return source
  let base = baseCache.get(source)
  if (!base) {
    const k = Math.min(BASE_MAX / sw, BASE_MAX / sh)
    base = document.createElement('canvas')
    base.width = Math.max(1, Math.round(sw * k))
    base.height = Math.max(1, Math.round(sh * k))
    const c = base.getContext('2d')
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'high'
    c.drawImage(source, 0, 0, base.width, base.height)
    baseCache.set(source, base)
  }
  return base
}

/* 逐级减半再终缩, 避免 canvas 一次性大比例缩放的采样失真 */
export function resampleToCanvas(source, w, h) {
  w = clampDim(w); h = clampDim(h)
  const base = getBase(source)          // 大图走缓存的小尺寸 base, 小图原图直用
  const sw = base.naturalWidth || base.width
  const sh = base.naturalHeight || base.height

  // 目标比 base 还大 (放大场景): 直接从原图一次高质量缩放, 不污染 base 缓存
  if (w > sw || h > sh) {
    const up = document.createElement('canvas')
    up.width = w; up.height = h
    const uc = up.getContext('2d')
    uc.imageSmoothingEnabled = true
    uc.imageSmoothingQuality = 'high'
    uc.drawImage(source, 0, 0, w, h)
    return up
  }

  let cur = document.createElement('canvas')
  cur.width = sw; cur.height = sh
  cur.getContext('2d').drawImage(base, 0, 0)

  let cw = sw, ch = sh
  while (cw >= w * 2 && ch >= h * 2) {
    const nw = Math.max(w, cw >> 1), nh = Math.max(h, ch >> 1)
    const next = document.createElement('canvas')
    next.width = nw; next.height = nh
    const ctx = next.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(cur, 0, 0, nw, nh)
    cur = next
    cw = nw; ch = nh          // ← 修复: 原版缺此更新, 缩小>2倍即死循环爆内存
  }
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(w)); out.height = Math.max(1, Math.round(h))
  const ctx = out.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(cur, 0, 0, out.width, out.height)
  return out
}

/* SVG → Canvas: 按目标尺寸重新光栅化 (矢量无损缩放)
 * 用于 SVG 素材的实例渲染, 跳过 getBase 降采样缓存 */
export function svgToCanvas(img, w, h) {
  w = clampDim(w); h = clampDim(h)
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  const ctx = cv.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, w, h)
  return cv
}

/* 裁切窗口: 从源图 (cx,cy) 取 w×h, 1:1 拷贝; 超出源图范围的部分为黑边 */
/**
 * 画一行"定宽数字" —— 与固件 UI_DrawField 的 UI_T_NUM 完全一致:
 * 每格 font.w × font.h, 字符按 (字符码 - font.first) 在 font.bytes (灰度 1B/px, 每字 w*h) 里查;
 * 空格格用底色 bg 填 (0xFFFF = 不填), 数字按灰度 × color 上色。
 * font 由调用方给 (网页里就是"这一层用的字库"导出的同一份数据) → 预览与固件逐字节一致。
 * @param text formatNumText() 的结果 (已经是定宽字符串)
 * @returns canvas (宽 = 格数 × font.w, 高 = font.h)
 */
/** 把一张"白字透明底"的画布染成指定颜色 (alpha 保留 → 预览不再是一块黑底) */
export function tintCanvas(cv, color = 0xFFFF, opt = {}) {
  const W = cv.width, H = cv.height
  const { r, g, b } = rgb565To888(color & 0xFFFF)
  /* zeroTransparent (预览用): 先留一份源像素 —— 要同时读"亮度"和"覆盖率":
   *   · 普通文字画布 (白字 + alpha AA): r=255, alpha = 覆盖率;
   *   · 光晕画布 (sysGlowCanvas 输出**不透明**): alpha=255, r/g/b = 灰度值。
   * 两者统一成 v = (r/255) × (alpha/255) = "这一像素有多亮"。 */
  const src = opt.zeroTransparent ? cv.getContext('2d').getImageData(0, 0, W, H).data : null
  const out = document.createElement('canvas')
  out.width = W; out.height = H
  const ctx = out.getContext('2d')
  ctx.drawImage(cv, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = `rgb(${r},${g},${b})`
  ctx.fillRect(0, 0, W, H)
  /* 预览用 (opt.zeroTransparent): **只有 v=0 的像素透明**, 其余不透明。
   * 为什么不做成"灰度当 alpha": 板上没有透明通道 —— 灰度 10 就是"暗但实心"的红,
   * 拿它当 alpha 会跟棋盘格混出一块半透明的假色, 看着跟实物不一样。
   * ！但亮度必须按 v 压进 RGB (2026-10-20 现场: "编辑系统字的预览图失去灰度, 只有黑白两种状态"):
   *   早先只把 alpha 二值化、RGB 仍写满色 → AA 边缘/光晕尾巴全被压成"有/没有"两态。
   *   按 v 压暗后, 深色底上的边缘就是正常的灰度过渡, 仍然没有假半透明。 */
  if (src) {
    const img = ctx.getImageData(0, 0, W, H)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      const v = (src[i] / 255) * (src[i + 3] / 255)
      d[i] = Math.round(r * v)
      d[i + 1] = Math.round(g * v)
      d[i + 2] = Math.round(b * v)
      d[i + 3] = v > 0 ? 255 : 0
    }
    ctx.putImageData(img, 0, 0)
  }
  return out
}

/** 内容外框 (按 alpha>8 找墨迹), 用来告诉用户"去掉黑边后实际多大"; 全空返回 null */
export function inkBox(cv) {
  const w = cv?.width | 0, h = cv?.height | 0
  if (!w || !h) return null
  let d
  try { d = cv.getContext('2d').getImageData(0, 0, w, h).data } catch (e) { return null }
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/** 与 inkBox 同口径, 但按**亮度** (max(r,g,b) > min) 找墨迹, 全空返回 null。
 *
 *  为什么需要另开一个: 光晕画布 (sysGlowCanvas) 把整张的 alpha 都写成 255 —— 导出时
 *  processImage 要靠 alpha 把字合成到黑底, 不能动它。于是 inkBox 量出来的是**整张外扩画布**:
 *  光晕尾巴那几十级灰 (5bit 屏与肉眼都看不见) 全被当成"墨", 白白撑开图层宽高 ——
 *  现象就是"光晕调到 10px, 字没见粗, 框却大了一圈, 四周全是黑的"。
 *  按亮度量就只能量到**看得见的那部分**, 与 numFontFromGlyphs 的行/列裁剪同一条线
 *  (那边裁的是精确为 0 的边, 这里 min 默认 0 同义)。
 *
 *  ！只在**开了光晕**时用它 (调用方判 glowCfg().on) —— 普通画布是"白字 + alpha 承载覆盖度",
 *    按亮度量会把半透明边缘也算成墨, 结果比 inkBox 略大。关光晕必须仍走 inkBox, 逐字节不变。 */
export function inkBoxLit(cv, min = 0) {
  const w = cv?.width | 0, h = cv?.height | 0
  if (!w || !h) return null
  let d
  try { d = cv.getContext('2d').getImageData(0, 0, w, h).data } catch (e) { return null }
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      if (Math.max(d[o], d[o + 1], d[o + 2]) > min) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/**
 * 从灰度数组里裁一块 (ox,oy) 起、cw×ch 大; 越界补 0。
 *
 * 专给「紧排光晕」用: 光晕必须在**带 pad 的画布**上算 (否则边缘 clamp 会把光晕摊成一条假边),
 * 算完再裁回原格子 —— 这样字距/格子尺寸与不开光晕时完全一致, 只是格子外的弱光被切掉。
 * @param values 行主序灰度 (Uint8Array/Array), 长度 gw*gh
 */
export function cropGray(values, gw, gh, ox, oy, cw, ch) {
  const w = Math.max(0, Math.round(cw) || 0)
  const h = Math.max(0, Math.round(ch) || 0)
  const out = new Uint8Array(w * h)
  if (!values || !w || !h) return out
  const x0 = Math.round(ox) || 0, y0 = Math.round(oy) || 0
  for (let y = 0; y < h; y++) {
    const sy = y + y0
    if (sy < 0 || sy >= gh) continue
    for (let x = 0; x < w; x++) {
      const sx = x + x0
      if (sx < 0 || sx >= gw) continue
      out[y * w + x] = values[sy * gw + sx] | 0
    }
  }
  return out
}

/**
 * GRAY8 → RGB565 量化**预抖动** (烘焙进导出数据, MCU 渲染代码不变)。
 *
 * 为什么要有它: 板子那侧灰度×颜色后直接截断进 RGB565 (R/B 5 位 / G 6 位),
 * 一条 AA 渐变在 5 位红上只剩 32 级 —— 量化台阶在字上读起来就是"锯齿/网点感";
 * 网页预览是 8bit/通道直达显示器, 所以同一份数据两边观感不同。
 * 把 8×8 Bayer 有序抖动**烘进灰度值** (阈值铺满整个量化步长, 见函数内说明),
 * 量化台阶的 contour 被打散成细网点 → 板子观感向预览靠拢, flash 与渲染代码都不变。
 * (与固件圆环引擎 bsp_ring.c 的 Bayer 同思路, 那边在渲染时加, 这边在导出时加。)
 *
 * 对 0/255 二值掩膜是逐字节 no-op, 只影响中间灰度; MCU 侧 GRAY×color 的公式不变。
 * @param values 灰度数组 (行主序, gw*gh)
 * @param strength 1 = 标准一个整步; <1 = 轻抖 (想弱化网点感时用)
 */
const BAYER8_D = (() => {                     /* 标准 8×8 有序抖动矩阵 (0..63), 递归生成免抄错 */
  let m = [[0]]
  for (let n = 1; n < 8; n *= 2) {            /* M(2n) = [[4M, 4M+2], [4M+3, 4M+1]] */
    const next = []
    for (let y = 0; y < n * 2; y++) next.push(new Array(n * 2).fill(0))
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = m[y][x] * 4
      next[y][x] = v; next[y][x + n] = v + 2
      next[y + n][x] = v + 3; next[y + n][x + n] = v + 1
    }
    m = next
  }
  return m
})()

export function ditherGray565(values, gw, gh, strength = 1) {
  /* 有序抖动的正确姿势: 阈值铺满**整个量化步长** [0, STEP), 再 floor。
   *  · STEP = 8 = RGB565 R/B 的 5 位步长 (G 的 6 位步长 4 是它的因子, 自动覆盖);
   *  · 每个像素落到 floor((g+θ)/8)*8, 8×8 块内 θ 恰好取遍 0..8 → 块均值 == g (无系统偏差);
   *  · 板子公式不变: 它拿到的字节已经是 8 的倍数, 截断不再产生误差;
   *  · g=0 → 恒 0 (θ<8); g=255 → 钳回 255 (面板对 255/248 输出同值, 观感不变)。
   * 幅度用 ±半步的"加性"写法是错的: 一半灰度永远跨不过边界, 系统偏差仍在 (实测过)。 */
  const STEP = 8
  const n = Math.max(0, gw * gh)
  const out = new Uint8Array(n)
  const k = (STEP * (strength == null ? 1 : strength)) / 64
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x
      const g = values[i] | 0
      if (g <= 0) { out[i] = 0; continue }        /* 0/255 二值掩膜逐字节 no-op */
      if (g >= 255) { out[i] = 255; continue }
      /* 256/255 预畸变: 固件 (b*255+128)>>8 不是恒等映射 (b=200 → 199 → 掉一级),
       * 先把目标灰度反解成"面板真的会显示这个级别的字节", 抖动才严格成立 */
      const th = BAYER8_D[y & 7][x & 7] * k       /* [0, STEP) 铺满整个量化步长 */
      const v = Math.floor(((g + th) * 256) / (255 * STEP)) * STEP
      out[i] = v < 0 ? 0 : (v > 255 ? 255 : v)
    }
  }
  return out
}

/**
 * 灰度字模的**边缘斜坡加宽** (2026-10-13 现场: 大数字斜边/圆弧"一格一格")
 *
 * 为什么需要: 浏览器渲染系统字给的是 **~1px 的覆盖率斜坡** —— 沿边缘法线基本是
 *   0 → 20 → 255 两个像素就跨完。59×76 这种大字号在 320×170 面板上, 斜线/圆弧上
 *   就是肉眼可见的台阶。
 *   · 8bit 位深本身不是原因 (256 级足够);
 *   · 565 输出量化也不是主因 (白字实测每像素误差 ≤4/255, 那步的正解是**预抖动**,
 *     见 ditherGray565 —— 它治"色带/网点"), 台阶只能靠**把斜坡摊宽**。
 * 做法: 分离式高斯 (边缘 clamp), σ = 0 时**严格返回原数组** (no-op)。
 * 量与板子: 板子拿到的就是这份字节 (固件只做 灰度×颜色), 所以预览即板子。
 * @param values 行主序灰度 (Uint8Array/Array), 长度 gw*gh
 * @param sigma  柔化半径 (px): 0=不变; 常用 0.5~0.8 (过渡宽 ≈ 2σ); >1.0 小字号会发虚
 * @returns Uint8Array (0..255 整数)
 */
export function blurGray(values, gw, gh, sigma = 0) {
  const n = Math.max(0, gw * gh)
  const src = values || []
  const out = new Uint8Array(n)
  const s = +sigma || 0
  if (s <= 0 || n === 0) {                     /* 严格 no-op: 一个字节都不动 */
    for (let i = 0; i < n; i++) out[i] = src[i] | 0
    return out
  }
  const r = Math.max(1, Math.ceil(3 * s))
  const k = []
  let sum = 0
  for (let i = -r; i <= r; i++) { const w = Math.exp(-(i * i) / (2 * s * s)); k.push(w); sum += w }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  const tmp = new Float32Array(n)
  /* 横向: 边缘 clamp (字模四周本来就有留白, 不引入黑边) */
  for (let y = 0; y < gh; y++) {
    const base = y * gw
    for (let x = 0; x < gw; x++) {
      let a = 0
      for (let i = -r; i <= r; i++) {
        let xx = x + i
        if (xx < 0) xx = 0; else if (xx >= gw) xx = gw - 1
        a += (src[base + xx] | 0) * k[i + r]
      }
      tmp[base + x] = a
    }
  }
  /* 纵向 */
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let a = 0
      for (let i = -r; i <= r; i++) {
        let yy = y + i
        if (yy < 0) yy = 0; else if (yy >= gh) yy = gh - 1
        a += tmp[yy * gw + x] * k[i + r]
      }
      const v = Math.round(a)
      out[y * gw + x] = v < 0 ? 0 : (v > 255 ? 255 : v)
    }
  }
  return out
}

/**
 * 灰度字模的**光晕 / 外发光** (2026-10-17 现场: 数码管字想要"灯管在发光"的观感)
 *
 * 做法 (三步, 与工程里"先掩膜再模糊"的习惯一致):
 *   ① 取亮部掩膜: 只让**阈值以上**的像素发光 —— 黑底上的暗部本来就不该发光;
 *      掩膜按 (v−阈值)/(255−阈值) 归一化, 所以阈值不影响光晕亮度上限;
 *   ② 掩膜做分离式高斯 (复用 blurGray, 同一套核与边缘 clamp);
 *   ③ 光晕与原图**取大** (screen/lighten) 而不是相加。
 *      2026-10-17 实测改口: 这里原本是加性的, 理由是"用 max() 暗底弱光晕会被 0 吃掉" —— 是错的,
 *      max(0, 晕) 就是晕本身, 一点没被吃。而加性有致命副作用: 掩膜恒有 mask(v) ≤ v (因为
 *      (v−t)/(255−t)·255 ≤ v 对 v ≤ 255 恒成立), 所以相加只会去抬高**字迹自己的**抗锯齿斜坡。
 *      σ≲0.33 时高斯核退化成 [0,1,0] (扩散严格为 0), 加性就纯粹变成一次对比度拉伸:
 *      MiSans @40px 的 '8' 实测 142 个 AA 像素被吹白 66 个 (扫描线 75/231 → 117/255),
 *      而纯黑处一个像素都没亮 —— "没有光晕, 只有一身硬边"。
 *      取大则保证光晕只出现在比它暗的地方, 斜坡像素原样保留; 且 σ 在死区时逐字节 no-op。
 *
 * ！光晕会**溢出原格子**: 调用方必须先在四周留出 ceil(3σ) 的空白, 否则光晕被切平
 *   (切平处是一条硬边, 比没有光晕更难看)。留白量见 glowPadOf()。
 * ！σ≤0 或增益≤0 时**严格返回原数组的副本** (no-op), 保证"关掉 = 与以前逐字节相同"。
 *
 * 量与板子: 板子拿到的就是这份字节 (固件只做 灰度×颜色), 所以**预览即板子**;
 * 而且 GRAY + 运行期颜色时, 光晕会被固件一起染色 —— 白字红晕、绿字绿晕都自动成立。
 *
 * @param values 行主序灰度 (Uint8Array/Array), 长度 gw*gh
 * @param thresh 发光阈值 (0..255): 0=全图发光; 大字号白字常用 32~48
 * @param sigma  光晕半径 (px): 越大越弥散; 常用 2~6
 * @param gain   光晕增益 (倍率): 卷起多少光; 1.0 = 掩膜原始强度
 * @returns Uint8Array (0..255 整数)
 */
export function addGlowLike(values, gw, gh, thresh = 40, sigma = 4, gain = 1) {
  const n = Math.max(0, gw * gh)
  const src = values || []
  const out = new Uint8Array(n)
  const s = +sigma || 0
  const k = +gain || 0
  if (s <= 0 || k <= 0 || n === 0) {           /* 严格 no-op: 关掉时逐字节不变 */
    for (let i = 0; i < n; i++) out[i] = src[i] | 0
    return out
  }
  const th = Math.max(0, Math.min(255, Math.round(+thresh || 0)))
  const span = th >= 255 ? 1 : 255 - th
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const v = src[i] | 0
    if (v <= th) continue                            /* mask 默认 0 */
    const m = Math.round(((v - th) / span) * 255)
    mask[i] = m > 255 ? 255 : m
  }
  const bl = blurGray(mask, gw, gh, s)
  for (let i = 0; i < n; i++) {
    const s0 = src[i] | 0
    const gv = Math.round((bl[i] | 0) * k)
    out[i] = gv > s0 ? (gv > 255 ? 255 : gv) : s0    /* 取大: mask ≤ src ⇒ 死区里 out ≡ src */
  }
  return out
}

/** 光晕需要的四周留白 (px) —— 与 addGlowLike 的 blurGray 半径 ceil(3σ) 对齐。
 *  关掉时返回 0 (格子尺寸与以前完全一致)。 */
export function glowPadOf(thresh, sigma, gain, on) {
  if (!on) return 0
  const s = +sigma || 0
  const k = +gain || 0
  if (s <= 0 || k <= 0) return 0
  /* σ≲0.36: 高斯核的邻点权重 exp(-1/(2σ²)) < 2% → 归一化后就是 [0,1,0], 一个像素都不扩散。
   * 那时光晕是彻底的空操作 (配合取大混合逐字节等于原图), 再留白就只是白占步进、白拉字距。
   * 所以死区直接不给留白 —— 滑条 0.1~0.3 与"关"完全等价 (2026-10-17 现场)。 */
  if (Math.exp(-1 / (2 * s * s)) < 0.02) return 0
  return Math.max(0, Math.ceil(3 * s))
}

/**
 * 数字区域的画布。默认宽 = 文本自然宽度; **数字区域**要多给两个参数 (与固件同一口径):
 *   opt.width = 这块显示区的总宽 (cells*cw - gap)
 *   opt.lead  = 首字符相对画布左边的偏移 (对齐: 左 0 / 中 半格也居中 / 右)
 *   ！bg != 0xFFFF 时整块先填 bg —— 固件那边是"先把字形覆盖不到的两段留白用底色清掉",
 *     结果等价 (字形自己会把格子内部刷成底色/黑)。
 */
export function renderNumCanvas(text, color = 0xFFFF, bg = 0xFFFF, font = null, opt = {}) {
  const gw = Math.max(1, Math.round(font?.w) || ASCII_FONT_W)
  const gh = Math.max(1, Math.round(font?.h) || ASCII_MODE1_H)
  const gap = Math.max(0, Math.round(font?.gap) || 0)          // 字间距
  const bytes = font?.bytes || null
  const first = font ? (font.first | 0) : asciiFont().first
  const count = font ? (font.count | 0) : asciiFont().count
  const chars = [...String(text || '')]
  const natW = chars.length * gw + Math.max(0, chars.length - 1) * gap
  const w = Math.max(1, Math.round(opt.width) || natW), h = gh
  const lead = Math.max(0, Math.round(opt.lead) || 0)
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  const ctx = cv.getContext('2d')
  const img = ctx.createImageData(w, h)
  const d = img.data
  if ((bg & 0xFFFF) !== 0xFFFF) {
    const c = rgb565To888(bg & 0xFFFF)
    for (let i = 0; i < w * h; i++) { d[i * 4] = c.r; d[i * 4 + 1] = c.g; d[i * 4 + 2] = c.b; d[i * 4 + 3] = 255 }
  }
  const col = rgb565To888(color & 0xFFFF)
  chars.forEach((ch, i) => {
    if (ch === ' ') return
    const gi = ch.charCodeAt(0) - first
    if (gi < 0 || gi >= count) return
    for (let r = 0; r < gh; r++) {
      for (let cc = 0; cc < gw; cc++) {
        let g
        if (bytes) {
          g = bytes[gi * gw * gh + r * gw + cc]
        } else {                                   // 内置 ASCII 字模: 步进是 8×14, 只取前 11 行
          const af = asciiFont()
          g = af.data[gi * ASCII_FONT_W * ASCII_FONT_H + r * ASCII_FONT_W + cc]
        }
        if (!g) continue
        const gx = lead + i * (gw + gap) + cc
        if (gx < 0 || gx >= w) continue
        const o = (r * w + gx) * 4
        const a = g / 255
        d[o] = d[o] * (1 - a) + col.r * a
        d[o + 1] = d[o + 1] * (1 - a) + col.g * a
        d[o + 2] = d[o + 2] * (1 - a) + col.b * a
        d[o + 3] = 255    /* 非 0 一律不透明; 值为 0 的像素在上面 `if (!g) continue` 就跳过了 ⇒ 保持 0 (透明) */
      }
    }
  })
  ctx.putImageData(img, 0, 0)
  return cv
}

export function applyCropWindow(source, cx, cy, w, h) {
  const sw = source.naturalWidth || source.width
  const sh = source.naturalHeight || source.height
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  const ix = Math.max(0, cx), iy = Math.max(0, cy)
  const iw = Math.min(w, sw - cx), ih = Math.min(h, sh - cy)
  if (iw > 0 && ih > 0) ctx.drawImage(source, ix, iy, iw, ih, ix - cx, iy - cy, iw, ih)
  return cv
}

/* 驱动同款灰度×颜色调制: g6(0..63) 与 5/6/5 通道相乘 */
function tintChannels(g6, color565) {
  const cr = (color565 >> 11) & 0x1F
  const cg = (color565 >> 5) & 0x3F
  const cb = color565 & 0x1F
  const r5 = (g6 * cr) >> 6, g6o = (g6 * cg) >> 6, b5 = (g6 * cb) >> 6
  return { r: (r5 * 255 / 31) | 0, g: (g6o * 255 / 63) | 0, b: (b5 * 255 / 31) | 0 }
}

/**
 * 量化 + 生成 1:1 预览画布 (量化损失可见)。
 * @param source   源 canvas / img
 * @param fmt      'RGB565' | 'RGB888' | 'GRAY'
 * @param opts     { tint: 0xFFFF (GRAY 调制色), mirror: false, grayPack: 'u8'|'g565',
 *                   rgb888AsMacro: true }
 * @returns { canvas, values, w, h, len, kind }
 *   kind: 'u8' | 'u16' | 'macro888' | 'u32'
 */
export function processImage(source, w, h, fmt, opts = {}) {
  w = clampDim(w); h = clampDim(h)
  const tint = opts.tint ?? 0xFFFF
  const grayByMax = !!opts.grayByMax
  const cv = resampleToCanvas(source, w, h)
  const W = cv.width, H = cv.height
  const data = cv.getContext('2d').getImageData(0, 0, W, H).data
  const n = W * H
  const preview = document.createElement('canvas')
  preview.width = W; preview.height = H
  const pctx = preview.getContext('2d')
  const pimg = pctx.createImageData(W, H)
  const pd = pimg.data

  let values, kind
  if (fmt === 'GRAY') {
    values = new Uint8Array(n)
    kind = opts.grayPack === 'g565' ? 'u16g' : 'u8'
  } else if (fmt === 'RGB565') {
    values = new Uint16Array(n); kind = 'u16'
  } else {
    if (opts.rgb888AsMacro !== false) { values = new Uint8Array(n * 3); kind = 'macro888' }
    else { values = new Uint32Array(n); kind = 'u32' }
  }

  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255
    // LCD 无透明通道: 合成到黑底
    const r = Math.round(data[i * 4] * a)
    const g = Math.round(data[i * 4 + 1] * a)
    const b = Math.round(data[i * 4 + 2] * a)
    let pr, pg, pb
    if (fmt === 'GRAY') {
      /* grayByMax: 多帧素材按"纯白亮度"导出 —— 取 RGB 最大通道 (已乘 alpha),
       * 红/蓝/绿都保留满亮度, 不再被 BT.601 luma 压暗成灰。普通图片仍用 luma。 */
      const g8 = grayByMax
        ? Math.max(r, g, b)
        : Math.round(0.299 * r + 0.587 * g + 0.114 * b)
      values[i] = g8
      const t = tintChannels(g8 >> 2, tint)
      pr = t.r; pg = t.g; pb = t.b
    } else if (fmt === 'RGB565') {
      const v = rgb888To565(r, g, b)
      values[i] = v
      const o = rgb565To888(v)
      pr = o.r; pg = o.g; pb = o.b
    } else {
      if (kind === 'macro888') {
        values[i * 3] = r; values[i * 3 + 1] = g; values[i * 3 + 2] = b
      } else {
        values[i] = (r << 16) | (g << 8) | b
      }
      const v = rgb888To565(r, g, b) // 宏最终也是 565
      const o = rgb565To888(v)
      pr = o.r; pg = o.g; pb = o.b
    }
    pd[i * 4] = pr; pd[i * 4 + 1] = pg; pd[i * 4 + 2] = pb; pd[i * 4 + 3] = 255
  }
  pctx.putImageData(pimg, 0, 0)

  let canvas = preview
  if (opts.mirror) {
    canvas = document.createElement('canvas')
    canvas.width = W; canvas.height = H
    const c = canvas.getContext('2d')
    c.translate(W, 0); c.scale(-1, 1)
    c.drawImage(preview, 0, 0)
  }
  return { canvas, values, kind, w: W, h: H, len: n }
}

const hex = (v, pad, upper) => (upper ? '0X' : '0x') + v.toString(16).toUpperCase().padStart(pad, '0')

/** 生成字库二维数组文本: const unsigned char gImage_x[N][M] = {{...},...}
 *  glyphs: [{ch, values, len, gw, gh}]  kind: 'u8'|'u16g'|'u16' */
export function buildFontTableText(name, glyphs, kind, opts = {}) {
  const upper = opts.upperHex !== false
  const perLine = opts.perLine || (kind === 'u8' ? 16 : 12)
  const pad = kind === 'u8' ? 2 : 4
  if (!glyphs.length) return `/* 字库为空 */`
  const m = glyphs[0].len
  const type = kind === 'u8' ? 'unsigned char' : 'unsigned short'
  const lines = []
  const fmtTag = { u8: '8bit 灰度', u16g: '8bit 灰度 (G565 打包)', u16: 'RGB565' }[kind]
  const chars = glyphs.map(g => (g.ch >= ' ' && g.ch <= '~' && g.ch !== '*' && g.ch !== '/' && g.ch !== '\\') ? `'${g.ch}'` : '').join(' ')
  lines.push(`/* 字库 ${glyphs[0].gw}x${glyphs[0].gh} ${fmtTag} | 字符集: ${chars} | lcd-layout-studio */`)
  lines.push(`const ${type} gImage_${name}[${glyphs.length}][${m}] = {`)
  for (const g of glyphs) {
    const row = []
    for (let i = 0; i < g.len; i++) {
      const v = kind === 'u16g' ? ((g.values[i] >> 2) << 5) : g.values[i]
      row.push(hex(v, pad, upper))
    }
    const chTag = (g.ch >= ' ' && g.ch <= '~' && g.ch !== '*' && g.ch !== '/' && g.ch !== '\\') ? `  /* '${g.ch}' */` : ''
    // 每行一个字 (字内按 perLine 折行)
    const inner = []
    for (let i = 0; i < row.length; i += perLine)
      inner.push('        ' + row.slice(i, i + perLine).join(','))
    lines.push('    {' + (inner.length > 1 ? '\n' + inner.join(',\n') + '\n    ' : inner[0]) + '},' + chTag)
  }
  lines.push('};')
  return lines.join('\n')
}

/** 生成 C 数组文本 (风格对齐工程 pic.c: 0X 大写十六进制)
 *  opts.crop {x,y,w,h}: 按屏幕裁剪 (图内坐标, 只写可见部分; null=整图)
 *  opts.maxChars: 显示用截断上限 (复制/下载不传, 生成完整内容) */
export function buildCArrayText(name, proc, opts = {}) {
  const { values, kind, w, h } = proc
  const upper = opts.upperHex !== false
  const perLine = opts.perLine || (kind === 'u8' ? 16 : kind === 'u16' || kind === 'u16g' ? 12 : kind === 'macro888' ? 8 : 8)
  const maxChars = opts.maxChars || 0

  // 屏幕裁剪矩形 (图内坐标)
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)))
  let x0 = 0, y0 = 0, x1 = w, y1 = h
  if (opts.crop) {
    x0 = cl(opts.crop.x, 0, w); y0 = cl(opts.crop.y, 0, h)
    x1 = cl(opts.crop.x + opts.crop.w, 0, w); y1 = cl(opts.crop.y + opts.crop.h, 0, h)
  }
  const cw = x1 - x0, ch = y1 - y0
  const len = Math.max(0, cw * ch)

  const lines = []
  const fmtTag = { u8: '8bit 灰度', u16g: '8bit 灰度 (G565 打包)', u16: 'RGB565', macro888: 'RGB888(R,G,B)宏→RGB565', u32: 'RGB888' }[kind]
  const sizeNote = opts.crop && len < w * h ? `${cw}x${ch} (源 ${w}x${h}, 已按屏幕裁剪)` : `${w}x${h}`

  let decl
  if (kind === 'u8') decl = `const unsigned char gImage_${name}[${len}]`
  else if (kind === 'u32') decl = `const unsigned int gImage_${name}[${len}]`
  else decl = `const unsigned short gImage_${name}[${len}]`

  lines.push(`/* ${sizeNote} ${fmtTag} | lcd-layout-studio */`)
  if (len === 0) {
    lines.push(`${decl} = {`)
    lines.push('};')
    return lines.join('\n')
  }
  lines.push(`${decl} = {`)
  const row = []
  let chars = 0, truncated = false, last = false
  for (let ry = 0; ry < ch && !truncated; ry++) {
    for (let rx = 0; rx < cw; rx++) {
      const i = (y0 + ry) * w + (x0 + rx)
      if (kind === 'u8') row.push(hex(values[i], 2, upper))
      else if (kind === 'u16') row.push(hex(values[i], 4, upper))
      else if (kind === 'u16g') row.push(hex((values[i] >> 2) << 5, 4, upper)) // 灰度装入 G 字段
      else if (kind === 'macro888') {
        const r = values[i * 3], g = values[i * 3 + 1], b = values[i * 3 + 2]
        row.push(`RGB888(${hex(r, 2, upper)}, ${hex(g, 2, upper)}, ${hex(b, 2, upper)})`)
      } else row.push(hex(values[i], 6, upper))
      last = ry === ch - 1 && rx === cw - 1
      if (row.length === perLine || last) {
        const line = '    ' + row.join(',') + (last ? '' : ',')
        lines.push(line)
        chars += line.length
        row.length = 0
        if (maxChars && chars > maxChars && !last) truncated = true
      }
    }
  }
  if (truncated) lines.push(`    /* …显示截断: 共 ${len} 元素, 复制/下载获取完整内容 */`)
  lines.push('};')
  return lines.join('\n')
}
