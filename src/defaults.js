/* 默认屏幕预设与指令模板 (参考 bsp_gc9a01.h / bsp_st7735s.h) */

let _uid = 0
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${(_uid++).toString(36)}`

/* 通用模板 (新屏幕预设共用; 每个预设拿一份**深拷贝**, 免得改一个把别的也改了) */
const TPL_STD = {
  RGB565: 'LCD_drawImage({x}, {y}, {w}, {h}, {pic}, 0xFFFF);   /* RGB565 直显 */',
  RGB888: 'LCD_drawImage({x}, {y}, {w}, {h}, {pic}, 0xFFFF);   /* RGB888(R,G,B)宏 已编译期压为 RGB565 */',
  GRAY:   'LCD_drawGrayImage({x}, {y}, {w}, {h}, {pic}, {color}, {mirror});   /* 8bit灰度×颜色, {colorName} */',
  TEXT:   'LCD_drawStr_{name}({x}, {y}, "{text}", {color});   /* {text} */',
  TEXTFN: 'void LCD_drawStr_{name}(uint8_t x, uint8_t y, const char *str, uint16_t color)\n{\n    static const char map_{name}[] = "{charset}";\n    for (; *str; str++, x += {gw}) {\n        const char *p = strchr(map_{name}, *str);\n        if (p) LCD_drawGrayImage(x, y, {gw}, {gh}, {pic}[p - map_{name}], color, 0);\n    }\n}',
}
/* 一个分辨率 = 横竖两个预设 (面板转 90° 就是另一个; 驱动里 MADCTL 的事, 导出只管 w/h)。
 * inch = 面板对角尺寸 (英寸, 只用来在预设列表里认屏; 导出不用它)。 */
const mkScreen = (w, h, inch = 0) => {
  const land = w > h
  const diag = inch ? `${inch}吋 ` : ''
  return {
    id: `preset_bi_${w}x${h}`,       /* 内置项的**稳定 id** (写死在代码里): 不进 localStorage,
                                      * 工程文件里也只当引用; 自定义预设才用 uid('preset') */
    builtin: true,
    name: `${w}x${h}-${land ? '横' : '竖'}`,
    inch,                            // 对角尺寸 (英寸): 仅显示, 便于按屏选预设
    w, h, round: false,
    bg: 0x0000,                       // 屏幕底色 (RGB565): 预览/导出图片/导出 C 的 UI_PAGE_BG 三者同一个值
    grayPack: 'u8',                  // Gray 统一 8bit (LCD_drawGrayImage uint8_t 灰度)
    rgb888AsMacro: true,
    defaultFmt: 'RGB565',
    header: `/* ${diag}${w}x${h} ${land ? '横屏' : '竖屏'} 布局导出 — LCD 头按实际驱动改这一行 */\n#include "bsp_gc9a01.h"`,
    footer: '',
    templates: JSON.parse(JSON.stringify(TPL_STD)),
  }
}

/* 内置分辨率的**补装**: 老用户的预设存在 localStorage 里, 新增的内置分辨率不补就永远看不到
 * (以前用 "补过一次" 的布尔标记 → 标记写过之后再加新分辨率, 老用户就再也拿不到了 ——
 *  170x320 / 135x240 / 240x320 这三组就是这么漏掉的)。
 * 现在记的是**给过用户的名字清单** offered: 只补没给过的; 用户删掉的不会再加回来
 * (删之前已经记在 offered 里了)。纯函数, 自检直接测 (store.js 只负责读写 localStorage)。 */
export function syncBuiltinPresets(presets, offered) {
  const list = Array.isArray(presets) ? presets.slice() : []
  const seen = new Set(Array.isArray(offered) ? offered : [])
  const have = new Set(list.map(p => p.name))
  let added = 0
  for (const p of defaultPresets()) {
    if (seen.has(p.name)) continue          /* 已经给过 (哪怕用户删了) → 不再打扰 */
    seen.add(p.name)
    if (have.has(p.name)) continue          /* 用户手里已经有了 (同名的) → 只记账 */
    list.push(p)
    added++
  }
  return { presets: list, offered: [...seen], added }
}

export function defaultPresets() {
  return [
    {
      id: 'preset_bi_240x240R',
      builtin: true,
      name: '1.28R-240x240-',          // GC9A01 1.28寸 240x240 圆屏
      w: 240, h: 240, round: true, bg: 0x0000,
      grayPack: 'u8',                  // u8: drawGrayImage 灰度数组 | g565: drawImage G字段打包
      rgb888AsMacro: true,
      defaultFmt: 'RGB565',
      header: '/* 1.28R 240x240 圆屏 (GC9A01) 布局导出 — lcd-layout-studio */\n#include "bsp_gc9a01.h"',
      footer: '',
      templates: {
        RGB565:
          'LCD_drawImage({x}, {y}, {w}, {h}, {pic}, 0xFFFF);   /* RGB565 直显 */',
        RGB888:
          'LCD_drawImage({x}, {y}, {w}, {h}, {pic}, 0xFFFF);   /* RGB888(R,G,B)宏 已编译期压为 RGB565 */',
        GRAY:
          'LCD_drawGrayImage({x}, {y}, {w}, {h}, {pic}, {color}, {mirror});   /* 8bit灰度×颜色, {colorName} */',
        TEXT:
          'LCD_drawStr_{name}({x}, {y}, "{text}", {color});   /* {text} */',
        TEXTFN:
          'void LCD_drawStr_{name}(uint8_t x, uint8_t y, const char *str, uint16_t color)\n{\n    static const char map_{name}[] = "{charset}";\n    for (; *str; str++, x += {gw}) {\n        const char *p = strchr(map_{name}, *str);\n        if (p) LCD_drawGrayImage(x, y, {gw}, {gh}, {pic}[p - map_{name}], color, 0);\n    }\n}',
      },
    },
    {
      id: 'preset_bi_128x128',
      builtin: true,
      name: '1.2-128x128',             // ST7735S 1.2寸 128x128 方屏 (+32 偏移由驱动内处理)
      w: 128, h: 128, round: false, bg: 0x0000,
      grayPack: 'u8',                  // Gray 统一 8bit (MCU: LCD_drawGrayImage uint8_t 灰度)
      rgb888AsMacro: true,
      defaultFmt: 'RGB565',
      header: '/* 1.2 128x128 方屏 (ST7735S, +32 偏移由 LCD_Address_Set 内部处理) 布局导出 */\n#include "bsp_st7735s.h"',
      footer: '',
      templates: {
        RGB565:
          'LCD_drawImage({x}, {y}, {w}, {h}, {pic}, 0xFFFF);   /* RGB565 直显 */',
        RGB888:
          'LCD_drawImage({x}, {y}, {w}, {h}, {pic}, 0xFFFF);   /* RGB888(R,G,B)宏 已编译期压为 RGB565 */',
        GRAY:
          'LCD_drawGrayImage({x}, {y}, {w}, {h}, {pic}, {color}, {mirror});   /* 8bit灰度×颜色, {colorName}; 参考 GC9A01 实现 */',
        TEXT:
          'LCD_drawStr_{name}({x}, {y}, "{text}", {color});   /* {text} */',
        TEXTFN:
          'void LCD_drawStr_{name}(uint8_t x, uint8_t y, const char *str, uint16_t color)\n{\n    static const char map_{name}[] = "{charset}";\n    for (; *str; str++, x += {gw}) {\n        const char *p = strchr(map_{name}, *str);\n        if (p) LCD_drawGrayImage(x, y, {gw}, {gh}, {pic}[p - map_{name}], color, 0);\n    }\n}',
      },
    },
    /* ---- 新增分辨率: 每个都出「横屏 + 竖屏」两条 ----
     * 1.9吋 170x320 / 320x170 · 1.14吋 135x240 / 240x135 · 3.2吋 240x320 / 320x240
     * 坐标/宽高用几位由**各屏自己的驱动**决定 (2026-09 决定): ST7735S 这类保持 uint8_t 不动;
     * 320 宽的屏换新驱动时按那个驱动的接口来, 不强制把现有原语加宽到 uint16_t。
     * 预设里的 LCD 头默认写 bsp_gc9a01.h, 用哪块屏就改那一行。 */
    mkScreen(170, 320, 1.9), mkScreen(320, 170, 1.9),
    mkScreen(135, 240, 1.14), mkScreen(240, 135, 1.14),
    mkScreen(240, 320, 3.2), mkScreen(320, 240, 3.2),
    mkScreen(240, 170), mkScreen(170, 240),          /* 用户手上一块 240x170 的屏 (吋数未知, 不标) */
  ]
}

export const FORMATS = ['RGB565', 'RGB888', 'GRAY']

export const PLACEHOLDER_DOC = [
  ['{x} {y} {w} {h}', '实例几何, 随模拟屏位置实时变化'],
  ['{pic} / {name}', '数组名 gImage_xxx / 实例名'],
  ['{color}', '颜色宏 UI_COLOR_* (定义在导出的 ui_color.h)'],
  ['{colorHex}', '调制色原值 0xXXXX (RGB565)'],
  ['{colorName}', '最近 Color_t 枚举名'],
  ['{mirror}', '0/1 镜像标志'],
  ['{i}', '实例序号'],
  ['{len} / {lenBytes}', '数组元素数 / 字节数'],
  ['{sw} {sh}', '屏幕宽高'],
  ['TEXT 专用: {gw} {gh} {idx} {ch} {text}', '字宽/字高/字库下标/字符/整段文本'],
  ['TEXTFN 专用: {charset}', '字库字符集 (C 字符串, 已转义)'],
]
