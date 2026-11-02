/* 图片/多帧属性 比例锁定自检: node scripts/check-aspect.mjs
 * 现场 bug: 48×24 的多帧帧, 输入宽 96 变成 96×3 —— 因为旧代码拿整张拼版图 768×24 算比例。
 * 修复: 比例基准用当前帧 (font.boxes 或 glyphW/H), 不是 asset.w/h。
 */
import { frameAspectSource, fitAspect } from '../src/aspect.js'

let fails = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''))
  if (!cond) fails++
}

/* 16 帧 × 48×24 的横排拼版 */
const frames = {
  w: 768, h: 24,
  font: { glyphW: 48, glyphH: 24, charset: 'frames' },
}
{
  const s = frameAspectSource(frames, 0)
  ok('多帧素材: 比例基准 = 单帧 48×24 (不是拼版图 768×24)', s.w === 48 && s.h === 24, JSON.stringify(s))
  ok('48×24 帧输入宽 96 → 高 48 (不再变成 3)', fitAspect(96, s, 'w') === 48)
  ok('48×24 帧输入高 96 → 宽 192', fitAspect(96, s, 'h') === 192)
}
{
  const boxed = { ...frames, font: { ...frames.font, boxes: [{ x: 4, y: 2, w: 40, h: 18 }] } }
  const s = frameAspectSource(boxed, 0)
  ok('带内容框的帧: 比例基准 = 内容框 40×18', s.w === 40 && s.h === 18, JSON.stringify(s))
  ok('内容框 40×18 输入宽 80 → 高 36', fitAspect(80, s, 'w') === 36)
}
{
  const plain = { w: 48, h: 24 }
  const s = frameAspectSource(plain, null)
  ok('普通图片: 比例基准 = 素材尺寸 48×24, 96 → 48', s.w === 48 && s.h === 24 && fitAspect(96, s, 'w') === 48)
  ok('无素材 → null, fitAspect 原样返回', frameAspectSource(null) === null && fitAspect(96, null, 'w') === 96)
  ok('非法尺寸不崩, 夹到 ≥1',
    fitAspect(-5, { w: 48, h: 24 }, 'w') === 1 &&
    frameAspectSource({ w: 0, h: 0 }, null) === null)
}
console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过')
process.exit(fails ? 1 : 0)
