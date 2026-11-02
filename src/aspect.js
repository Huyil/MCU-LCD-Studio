/*
 * 尺寸比例 (图片/多帧属性弹窗) —— 从 InstanceDialog 抽出来的纯函数, 便于自检。
 *
 * 关键 bug 背景:
 *   多帧素材的 asset.w/h 是**整张横排拼版图** (例如 16 帧 × 48 宽 = 768×24),
 *   而图层实际放的是**单帧** (48×24)。旧代码 onWInput 用 asset.w/h 算比例,
 *   48×24 的帧输入宽 96 会得到高 96×24/768 = 3 —— 用户现场就是这个。
 *   比例基准必须是当前帧: 有逐帧内容框 (font.boxes) 用内容框, 否则用 glyphW/H。
 */

/** 当前帧/素材的源尺寸 {w,h} (比例锁定的基准); 无素材返回 null */
export function frameAspectSource(asset, frame) {
  if (!asset) return null
  if (frame != null && frame >= 0 && asset.font) {
    const box = asset.font.boxes?.[frame]
    if (box && +box.w > 0 && +box.h > 0) return { w: Math.round(+box.w), h: Math.round(+box.h) }
    const gw = +asset.font.glyphW, gh = +asset.font.glyphH
    if (gw > 0 && gh > 0) return { w: Math.round(gw), h: Math.round(gh) }
  }
  if (+asset.w > 0 && +asset.h > 0) return { w: Math.round(+asset.w), h: Math.round(+asset.h) }
  return null
}

/** 按源比例把一个方向的值换算到另一个方向: axis='w' → 返回高; 'h' → 返回宽 */
export function fitAspect(value, source, axis = 'w') {
  const v = Math.max(1, Math.round(Number(value) || 0))
  if (!source || !(+source.w > 0) || !(+source.h > 0)) return v
  return axis === 'w'
    ? Math.max(1, Math.round(v * source.h / source.w))
    : Math.max(1, Math.round(v * source.w / source.h))
}
