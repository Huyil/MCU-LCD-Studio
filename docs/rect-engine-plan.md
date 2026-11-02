# 圆角矩形环上板：整数几何约定与实施记录

> 状态：**第 1~4 步全部完成，自检全绿**（网页 `npm run check` 12 项、固件 `make check` / `make check-rect`）。
> 两端共用一套整数几何：网页 `src/ringrender.js` 的 `ringRect*Q8 / ringRectArcW / ringRectGain8`，
> 固件 `code/spi/bsp_ring.c` 的 `RING_SHAPE == 1` 那一支 —— 逐像素对拍在
> `tools/ring_sim/parity.py`（矩形 200 例底图 + 3 例白斑，三种屏 240×240 / 240×320 / 320×170）。

## 0. 总原则（已落实）

- 网页侧先做**整数参考实现**，拿现成的浮点 SDF 渲染当 golden 对齐（`scripts/check-ringrecti.mjs`
  7 条断言），对齐后再照抄进固件。
- 固件按 **`#if RING_SHAPE`** 分家：圆环与圆角矩形**不复用**几何代码，另一套一个字节都不编
  （实测矩形支：白斑总开关 `RING_GLINT_DEF=0` 省 4176B flash + 1574B SRAM）。
- 白斑按 **`#if RING_GLINT_DEF`** 独立开关：关掉时增益表 / atan 表 / 1216B 窗口缓冲都不编
  （`make check-glint` 圆环 / `make check-glint-rect` 矩形，两种模式各编一遍）。
- 验收：`make check-parity` 逐像素对拍 + "增量刷新 == 从零重画" + `arc_dir` 镜像不变量 +
  armcc (AC5) 两种形状各编一遍（33 个 .c，0 error 0 warning）。

## 1. 冻结的整数约定（两边照抄）

| 项 | 约定 | JS 参考实现 |
|---|---|---|
| 定点 | 全部 **Q8**（256 = 1px）；`isqrt` 输入 Q16 → 输出 Q8（floor） | `isqrtQ16` |
| 带 = ? | **外框圆角矩形 − 内框圆角矩形**（内外圆角各自独立 → 角上带厚 ≠ 直边带厚） | `ringRectGeomQ8` |
| 外框 | `(ow/2, oh/2, radOut)`；内框 `(ow/2−thick, oh/2−thick, radIn)`；`ow = w − 留边` | 同上 |
| 中心线 | `(hx, hy, rc=radMid)`，只用于**周长参数**与端帽圆心 | 同上 |
| 每行跨度 | `\|dy\| > OHY → xo = 0`；`\|dy\| ≤ OHY−ORC ? OHX : OHX−ORC+isqrt(ORC²−k²)`；内框同理 | `ringRectSpanQ8` |
| 覆盖率 | 像素区间 `[dx−128, dx+128]` 与带区间 `[−xo,−xi] ∪ [xi,xo]` 的重叠 `ov` → `(ov*255)>>8` | `ringRectCov8` |
| 周长参数 s | 顶边中点 = 0，顺时针；直边线性、角弧按角度（**整数 atan 表**，角度误差 < 0.05°） | `ringRectPathSQ8` |
| 整数 π | 角弧 `arc = (rc·th·143) >> 14`（π/360 ≈ 143/16384）；`hq = arc(180)` | `rectArcQ8` |
| 直边候选 | 四条边取垂足最近：d2 用 **Q8>>2** 尺度比较（32 位不溢出，两端同判） | `ringRectPathSQ8` |
| 等效角 | `aU = (s·invPer)>>16`，`invPer = round(720·65536/per)`；**夹到 719** | `ringRectAngleU` |
| **弧归属** | `rel = ((s − s_start)·dir) mod per`，`rel ≤ sweepS`（sweepS = round(sweepU·per/720)） | `ringRectArcW` |
| 端帽 | 帽心 = `ringRectPointAtQ8(s_start/s_end)`（弧长→角度用真除法，hq 是编译期常数）→ 半像素整数；帽半径 = 环厚；AA 与圆环同一式 | `ringRectArcGeom/ArcW` |
| 白斑 | 等效角 aU 直接查增益表（`gU = glintDeg + 180`，顶边中点 = 0 的换算） | `ringRectGain8` |

### 与原计划的两处偏差（都是有原因的）

1. **弧归属改在 s 域判**（计划里写的是 `relU = ((aU − startU)·dir) mod 720`）。等效角一格
   ≈1.2px，且在"顶边中点"接缝处 0/719 的回绕让 顺/逆时针**不再互为镜像**（实测差 3 像素）。
   改用路径长度判：量化 1/256px，且 `per − s(x) = s(−x)` 在整数式里严格成立 →
   矩形顺逆时针**逐像素精确镜像**（`make check-arcdir-rect`，镜像差异 0）。白斑仍用 aU
   （增益表按 0.5° 索引，不动）。
2. **坐标/段长按尺寸自动选宽度（`RING_XY_T`）**。竖屏 240×320 / 横屏 320×170 的坐标会超过 255，
   写死 `uint8_t` 会被静默截断（实测白斑画到屏幕另一侧、行段长度也会溢出）；写死 `uint16_t`
   又让 240×240 圆屏白吃 320B RAM。所以由导出宏推出来：
   ```c
   maxX/maxY = 圆心 + 外沿(px) + 1;   maxLen = 周长(px) × (4×范围° + 档位上限) / 720 + 8
   #if maxX > 255 || maxY > 255 || maxLen > 255  →  RING_XY_T = uint16_t;  否则 uint8_t
   ```
   实测：圆环 240×240 / 矩形 240×240(±42°) / 135×240(±12°) → `uint8_t`（bss 1633，与改动前一致）；
   320×170、240×320、以及范围 ≥±50° → 自动 `uint16_t`（bss 1953，只多那 320B）。`LCD_RingRun()`
   的 x/y 形参保持 `uint16_t`（CASET/RASET 本来就是 16 位地址，高字节为 0 时与老写法逐字节相同，
   形参加宽不吃 RAM）；坐标超过 16 位地址范围直接 `#error`，不会静默画错。

## 2. 第 2 步：网页整数镜像（已完成）

`ringrender.js` 新增（纯函数、可对拍）：`ringAtanUQ8`（Q8 域一象限整数 atan：倒数表按像素刻度
索引 + 被除数留 4 位亚像素，无除法器）、`ringRectPointAtQ8`（端帽圆心）、`ringRectArcGeom/ArcW`、
`ringRectGain8`、`ringRectTableR`（倒数表容量 = `ceil(max(oHx,oHy)/256)+2`）。
`drawRing` 的 `shape='rect'` 现在**也走「与 MCU 同步」整数路径**（行跨度 + 覆盖率 + 弧 + 白斑 +
RGB565 混合 + Bayer 抖动），圆心 `floor((w−1)/2)` 与导出/固件一致。

自检：`check-ringrecti.mjs` 7 条（跨度/覆盖率/周长参数/等效角/端点往返/端帽 AA/白斑增益），
`check-ringarc.mjs` 320 种组合（圆+矩形 × 顺逆 × 8 起始角 × 5 档位 × 端帽）逐像素对几何 oracle。

## 3. 第 3 步：固件（已完成）

- 导出（`store.js` `buildRingConfig`）：`RING_SHAPE=1` + 设计参数（`RING_RECT_W/H/RAD/RADIN/
  THICK/INSET`）+ **派生 Q8**（`RING_HX/HY/RC/HT/O_HX/O_HY/O_RC/I_HX/I_HY/I_RC/PER_Q8/INVPER`）；
  圆环那支照旧 `RING_R_IN/R_OUT`，矩形时 `R_IN=0`、`R_OUT=ringRectTableR()`（只当表容量）。
- `gen_tables.py`：矩形不出半径覆盖率表与断面表，但**要出 atan/倒数表**（角弧要用，白斑关掉也得有）。
- `bsp_ring.c`：`#if RING_SHAPE == 1` 整块（`ring_rect_update/span/cov/s/point_q8/arc_w/gain/
  win/run_s/bisect/run_win/compute/blit/render/paint_arc`），共用 `ring_mix / ring_arc_color /
  s_bayer / 窗口缓冲 / 查表工具`；上层 `Ring_Init/Tick/SetXxx` 一行没改（形状分派是宏）。
- 白斑窗口 = 新光斑 ∪ 旧光斑的**路径区间**（沿路径采样定行范围）+ 行内**二分**裁 x
  （s 在每段内单调；覆盖式两端各放 3px —— 多写的像素增益算出来是 0，写回底色不会画错）。

## 4. 第 4 步：验收（已完成）

- `tools/ring_sim/parity.py`：圆环用工程配置；矩形用**真导出器**（`scripts/emit-ring-config.mjs`）
  在临时目录出一份 `ring_config.h` + `gen_tables.py` 出表，`-include` 编一份真 `bsp_ring.c`；
  网页侧 `emit-ring-frame.mjs` 传 `shape:'rect'` 并**逐项核对 Q8 几何**（不一致直接报错）。
  可换几何：`RECT_DESIGN='{"shape":"rect","w":240,"h":320,...}' make check-parity`。
- `arc_dir.c` 扩到矩形（`make check-arcdir-rect`）：镜像差异必须 **0 像素**。
- `glint_switch.c` 扩到矩形（`make check-glint-rect`）：两种总开关各编一遍 + 体积对比。
- armcc (AC5) 全工程：圆环配置 / 矩形 240×240 / 矩形 240×320 / 矩形 + `RING_GLINT_DEF=0`，
  四种都是 33 个 .c **0 error 0 warning**。
- 清理：删掉"矩形按内切圆等效导出"的兜底与导出面板警告、`RingDialog`/`ringrender.js` 里
  "预览版: 板子上还没这"的注释；`check-store.mjs` 新增 4 条导出断言（含 Q8 逐项一致）。

## 5. 顺手修掉的三个网页侧 bug（用户现场）

1. **留边只对圆角矩形生效** → 圆环的 `rOut/rIn` 现在也扣：整条带向内收 `留边/2`，**厚度不变**
   （`ringInsetPx()` 一处定义，渲染/导出/一圈弧长都用它）。导出成 `RING_R_OUT/R_IN` 同步生效。
   三个字段（`inset / fitPad / pad`）都没有时按 **0** 算 —— 自检/对拍里的临时 ring 对象不该被扣。
2. **主预览光斑不动** → 圆环的"与 MCU 同步"分支以前读静态 `glintDeg`，自动动画的相位
   （`animAngles`）只在理想渲染里生效。改成读 `gDeg`（没有动画时两者相等 → 对拍一个像素不变）。
3. **"立体感好像关不掉"** → 0% 确实是平色（与不设置逐字节相同，已加断言）；只是 0% 时
   样式/光照控件还摆在那儿像开着。现在 0% 收起那两行并标注「(关)」。
   另外：圆环外沿正好压在圆屏可用圆上时，圆屏 mask 会把外圈 AA 切出锯齿 —— 留边生效后
   （外沿内收 4px）这圈锯齿也一并消失。

## 6. 已知取舍

- 角上带厚随内外圆角变化（与网页 SDF 一致）——不是等厚环；要等厚就把内圆角设成 `外圆角 − 厚度`。
  （内圆角还会夹到 `min(内框半宽, 内框半高)`，与网页理想渲染的 SDF 同一个形状。）
- 矩形的白斑沿**周长**分布（等效角），不是按几何角度；与圆环的"角度高斯"观感略有差别，
  但两端一致、且复用同一张增益表。
- 立体感（断面方向光）圆环与圆角矩形都上板了：同一套公式，只是断面表按"离外边界的深度"
  预烘（圆环按半径）——见下面第 8 节。
- 一个工程只支持一个环（板上是单例引擎 + 一份 `ring_config.h`），导出面板会拦。

## 7. 边缘 AA 改成"到边界的垂直距离"（用户现场：接缝 + 圆弧不够平滑）

旧实现的覆盖率是**行跨度与像素区间的重叠**（`ringRectCov8` / `ring_rect_cov`），只有边界竖直时
才等于面积覆盖，两个后果：

1. **接缝**：与像素行方向垂直的边（上下长边、内孔上下沿）整行都算"带内" → 硬边、比真值胖 1px；
   角弧那边是逐行 AA 的 → "角弧 ↔ 上下直边"交界处出现 1px 台阶。
2. **圆弧台阶**：角弧是斜的，覆盖率只沿 x 渐变 → 弧线看起来一格一格。

现在两边都改成**到最近边界的垂直距离 m 做斜坡**，与圆环板子上那条公式同一约定
（`gen_tables.py`: `v = min(r+0.5−R_IN, R_OUT+0.5−r)/aa`）：

| | 网页 | 固件 |
|---|---|---|
| 距离 | `ringRectDistQ8()`（IQ rounded-box SDF，负=框内） | `ring_rect_dist()` |
| 覆盖率 | `ringRectCovSdf8()`：`m ≤ −0.5px → 0`／`m = 0 → 64`(aa=2)／`m ≥ aa−0.5px → 255` | `ring_rect_cov()` |
| AA 宽度 | `aaPx = (round(aa×10)+5)/10`，`aaQ8 = aaPx×256`，`invAa = 65536/aaQ8` | `RING_RECT_AA_PX/_Q8/_INV_AA`（`bsp_ring.h`） |
| 行的 x 范围 | 逐像素扫，不需要 | `ring_rect_span_rng()`：`dy ∓0.5px` 两次跨度的并集（软边会越过硬边界） |

只有角上（`qx,qy` 都 > 0）才开方，直边段只是一次比较；平方先 `>>2` 再相加，避免大屏
（`oHx` 到 40960）时 `qx²+qy²` 超 int32。

实测（用户那份几何 226×140，角弧区）：覆盖率梯度与真实边界法线的夹角 **9.1° → 2.5°**，
>30° 的像素 2% → 0%；四个方向（上下长边、左右边、四段角弧）在"同样距离"处给出同一个覆盖率
（0 / 64 / 192 / 255）。

验收：`make check-rect-aa`（`rect_aa.c`，用用户那份几何断言四条水平边 + 左右边同一条斜坡、
交界处亚像素边界连续）；`check-ringrecti.mjs` ②/②b（边界点各向同性 + 极值行不再是硬边）；
网页↔固件逐像素对拍 200+3 例仍然完全一致。

> 网页「与 MCU 同步」关掉时的理想渲染仍用 SDF + `aa` 宽的**向内**渐隐（0 在硬边界上），
> 与同步路径的"边界上 1/4 覆盖"差半个像素 —— 同步路径才是板子的样子。

## 8. 第二批（用户现场）：矩形立体感、内圆角开关、锁定中心的环心

### 8.1 圆角矩形的立体感（"圆角矩形的立体感功能坏了，圆环是好的"）

同步预览与板子那支以前对矩形**只有平色**（`gen_tables.py` 明确跳过矩形断面表，导出还把
`RING_DEPTH_DEF` 强制写成 0）。现在矩形与圆环**同一套断面光照**，只把"径向"换成"带宽方向"：

| | 圆环 | 圆角矩形 |
|---|---|---|
| 断面参数 | `u = (r − 中径)/半厚` | `u = (离外边界深度 − 半厚)/半厚` |
| 表索引 | `(r² − R_IN²) >> 5` | `(深度 Q8) >> RING_SHADE_SHIFT`（1/8 px 一档） |
| 面内光分量 | `t = 256·(L·r̂)`（`Nx/Ny = Lx/r, Ly/r` Q16） | `t = 256·(L·n̂)`（`n̂` = 单位外法线, Q8） |
| 亮度 | `k = A[i] + (B[i]·t >> 8)`，`k>0` 提亮 / `k<0` 压暗 | 同 |

- `n̂` 由几何直接给：直边段是轴向，角上从角心放射（`ringRectNormalQ8` / `ring_rect_normal`），
  逐像素只有乘加，没有三角函数也没有开方。
- 表：`gen_tables.py` 的矩形分支出 `ringShadeA/B` + `RING_SHADE_SHIFT/N/NX/NY`，
  与网页 `ringRectShadeTables()` 生成的**逐项相同**；`bsp_ring.c` 的编译期 `#error` 现在也校验
  深度/样式/光源三个宏（以前只校验 SHAPE/R/SIGMA/AA —— 改了立体感忘了重生成表会悄悄画错明暗）。
- 导出：不再强制 `RING_DEPTH_DEF=0`，导出面板的"只有网页预览"警告也去掉了。
- 自检：`make check-rect-shade`（方向指纹 = 四条边"外沿−内沿"的符号与 `L·n̂` 相反；凸起时正中
  最亮）；对拍新增"立体感那一版"（深度 65%，25 例逐像素一致）。

### 8.2 「内圆角自动」单独开关

内圆角以前靠"把输入框清空"表示自动（placeholder = 自动），用户要求单独开关。
现在是一行「内圆角 [x] 自动 [    ]px」：勾上 = `外圆角 − 厚度`（同心、环带等厚），
取消勾选才会把当前实际值填进输入框让你改；旁边会提示"角上与直边不等厚: 差 Npx"。

### 8.3 锁定屏幕中心：环心不再漂 + 显示环心

两个问题：① 锁定后改尺寸，图层矩形被居中了，但**环心**（= `floor(x + (w−1)/2)`，就是导出的
`RING_CX/CY`）在图层里的位置是 `floor((w−1)/2)` → 偶数宽差 1px、奇数宽差 0.5px，
尺寸一变环心就在两三个像素之间跳（舞台拖角更明显：`syncRingSize` 对矩形直接 return，压根没重新落位）。
② 对话框只显示图层左上角，还把它叫「圆心」。

现在：`centerRingRect()` 反过来解 `x = 目标环心 − floor((w−1)/2)`（整数解 → 图层偏移保持整数，
与固件逐像素对拍的前提不变），目标环心 = 屏幕中央像素（圆屏 = 可用圆心，方屏 = `floor((W−1)/2)`）；
尺寸一变（含舞台拖角）就重新落位。对话框把左上角改名「位置」，另起一行显示真实环心
`(x, y)` 与"屏幕中心 (x, y) · 已居中 ✓ / 偏 (dx, dy) px"，并给一个「居中」按钮。
自检：`check-store` 断言任意尺寸下环心恒为 119 且偏移保持整数；`check-ui-render` 断言开关/显示/重落位都在。
