/*
 * 在线存档 命名 / 页面尺寸 / 覆盖判定 自检: node scripts/check-archive.mjs
 *
 * 现场需求:
 *  · 读取存档后把档名自动填回输入框 (再点保存就存回原档) —— UI 侧用 cloud.current 驱动;
 *  · 保存会覆盖同名档, 但如果原档页面尺寸和当前不同 → 自动改名, 绝不覆盖另一块屏的工程;
 *  · 新建存档用「日期 + 当前尺寸」生成不撞车的档名.
 *
 * 这里只测纯函数 (不碰 DOM/网络); UI 接线在 check-ui-render 里断言.
 */
import {
  cleanArchiveName, archiveFileName, archiveBaseName, screenSizeTag, screenLabel,
  sameScreen, archiveNames, uniqueArchiveName, stripScreenTag, projectMeta,
  planArchiveSave, suggestArchiveName, suggestPresetName,
} from '../src/archive.js'

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''))
  if (!cond) fails++
}

/* ---- 档名清洗: 服务器上是 <档名>.json, 不能带路径字符 ---- */
{
  ok('档名: 去空白 + 去 .json + 路径字符换成 -',
    cleanArchiveName('  foo/bar:baz*.json ') === 'foo-bar-baz')
  ok('档名: 空/全是点横线 → 空 (不回退到 ".")', cleanArchiveName(' .. ') === '' && cleanArchiveName(null) === '')
  ok('档名 ↔ 文件名 往返', archiveFileName(' 测试/屏 ') === '测试-屏.json' && archiveBaseName('测试-屏.json') === '测试-屏')
  ok('空档名不生成 .json', archiveFileName('') === '')
}

/* ---- 从工程 JSON 取页面尺寸: 新 meta 优先, 老存档回退 presets ---- */
{
  const withMeta = {
    meta: { w: 240, h: 240, round: true, preset: '1.28R' },
    presets: [{ id: 'a', w: 128, h: 128 }], activePresetId: 'a',
  }
  const m1 = projectMeta(withMeta)
  ok('存档尺寸: 有 meta 就用 meta (240×240 圆)',
    m1.w === 240 && m1.h === 240 && m1.round === true && m1.from === 'meta')
  const old = {
    presets: [{ id: 'bi', w: 128, h: 128 }, { id: 'x', w: 170, h: 320 }],
    activePresetId: 'x',
  }
  const m2 = projectMeta(JSON.stringify(old))
  ok('老存档: 回退到 activePresetId 指向的预设 (170×320)',
    m2.w === 170 && m2.h === 320 && m2.round === false && m2.from === 'presets')
  const noActive = { presets: [{ id: 'a', w: 0, h: 0 }, { id: 'b', w: 240, h: 170 }] }
  ok('老存档: activePresetId 缺失/无效 → 第一条有效预设', projectMeta(noActive).w === 240)
  ok('坏 JSON / 没有屏幕信息 → null', projectMeta('{oops') === null && projectMeta({ assets: [] }) === null)
}

/* ---- 尺寸比较: w/h/圆屏 都算 (同尺寸圆/方是两套工程) ---- */
{
  const a = { w: 240, h: 240, round: true }
  ok('尺寸相同: w/h/圆屏一致', sameScreen(a, { w: 240, h: 240, round: true }))
  ok('尺寸不同: 圆屏标记不同也算不同 (防止方屏覆盖圆屏)',
    !sameScreen(a, { w: 240, h: 240, round: false }) &&
    !sameScreen(a, { w: 128, h: 128, round: true }))
  ok('尺寸标签 / 人话', screenSizeTag(a) === '240x240-圆' && screenLabel(a) === '240×240 圆屏' &&
    screenLabel({ w: 128, h: 128 }) === '128×128' && screenLabel(null) === '未知尺寸')
}

/* ---- 撞名: 自动 -2/-3, 不覆盖 ---- */
{
  const files = [{ name: 'lcd-2026-10-20-240x240.json' }, 'lcd-2026-10-20-240x240-2.json']
  const n = uniqueArchiveName('lcd-2026-10-20-240x240', files)
  ok('新档名撞车 → 自动 -3 (跳过已占用的 -2)', n === 'lcd-2026-10-20-240x240-3', n)
  ok('服务器列表字符串/对象两种形状都能认', archiveNames(files).size === 2)
}

/* ---- 保存决策 ---- */
{
  const current = { w: 240, h: 240, round: true }

  const p1 = planArchiveSave({ name: 'new', current, exists: false, files: [] })
  ok('保存: 新档名 → 直接写', p1.action === 'save' && p1.name === 'new')

  const p2 = planArchiveSave({
    name: 'same', current, exists: true, existing: { w: 240, h: 240, round: true }, files: [],
  })
  ok('保存: 同名 + 尺寸相同 → 先确认再覆盖', p2.action === 'confirm' && p2.name === 'same')

  const existing = { w: 128, h: 128, round: false }
  const p3 = planArchiveSave({ name: 'old', current, exists: true, existing, files: [{ name: 'old.json' }] })
  ok('保存: 同名但尺寸不同 → 自动改名 (不覆盖), 名字带当前尺寸',
    p3.action === 'rename' && p3.name === 'old-240x240-圆' && p3.from === 'old', JSON.stringify(p3))

  const p4 = planArchiveSave({
    name: 'old-128x128', current, exists: true, existing,
    files: [{ name: 'old-128x128.json' }, { name: 'old-240x240-圆.json' }],
  })
  ok('保存: 旧名字带旧尺寸 → 换成本次尺寸; 目标再撞车 → -2',
    p4.action === 'rename' && p4.name === 'old-240x240-圆-2', p4.name)

  const p5 = planArchiveSave({ name: 'x', current, exists: true, existing: null, files: [{ name: 'x.json' }] })
  ok('保存: 同名但读不到原尺寸 → 保守确认 (不静默覆盖)', p5.action === 'confirm' && p5.unknown === true)

  const p6 = planArchiveSave({
    name: 'same-round-diff', current, exists: true,
    existing: { w: 240, h: 240, round: false }, files: [],
  })
  ok('保存: 同 w/h 但圆屏标记不同 → 也算尺寸不同, 自动改名', p6.action === 'rename')

  const p7 = planArchiveSave({ name: ' /bad:name ', current, exists: false, files: [] })
  ok('保存: 档名先清洗再落盘', p7.action === 'save' && p7.name === 'bad-name')
}

/* ---- 新建档名: 日期 + 当前尺寸 ---- */
{
  const d = new Date(2026, 9, 20, 15, 4, 5)     /* 本地时间 2026-10-20 */
  const n1 = suggestArchiveName({ w: 240, h: 240, round: true }, d, [])
  ok('新建: lcd-2026-10-20-240x240-圆', n1 === 'lcd-2026-10-20-240x240-圆', n1)
  const n2 = suggestArchiveName({ w: 240, h: 240, round: true }, d, [{ name: n1 + '.json' }])
  ok('新建: 同一天同尺寸再建 → -2', n2 === n1 + '-2', n2)
}

/* ---- 预设名也用尺寸, 避免一堆「新预设-7」 ---- */
{
  ok('预设名: 240x240-圆', suggestPresetName({ w: 240, h: 240, round: true }, []) === '240x240-圆')
  ok('预设名撞车 → -2', suggestPresetName({ w: 128, h: 128 }, ['128x128']) === '128x128-2')
}

/* ---- stripScreenTag: 只剥末尾的旧尺寸, 不动普通名字 ---- */
{
  ok('去旧尺寸后缀: foo-128x128 → foo', stripScreenTag('foo-128x128', { w: 128, h: 128 }) === 'foo')
  ok('去旧尺寸后缀: foo_128x128 → foo', stripScreenTag('foo_128x128', { w: 128, h: 128 }) === 'foo')
  ok('普通名字不误伤', stripScreenTag('我的屏', { w: 128, h: 128 }) === '我的屏')
}

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过')
process.exit(fails ? 1 : 0)
