# 第三方组件与字体来源 / Third-party notices

本仓库包含以下第三方代码或字体。再次分发时请保留本文件及对应许可证。

## MultiTimer (legacy)

- 来源：<https://github.com/0x1abin/MultiTimer/tree/legacy>
- 作者：Zibin Zheng `<znbin@qq.com>`
- 许可证：MIT
- 本仓库位置：`examples/render-port/code/timer/multi_timer.c/.h`
- 修改：示例把 tick 改为 CW32L011 `BTIM1`，并保留 legacy 分支的定时器链表/回调接口。
- 完整 MIT 文本：`examples/render-port/code/timer/LICENSE`

## 字体 / Fonts

### MiSans

- 文件：`src/assets/fonts/misans-300/400/500/600/700.woff2`
- 来源：小米 HyperOS 字体官网 <https://hyperos.mi.com/font/>
- 版权：© Xiaomi
- 说明：官方页面标注为免费商用字体；仓库内是供网页预览用的 WOFF2 子集。
  再分发字体文件前请以官网最新许可条款为准。

### HarmonyOS Sans SC

- 文件：`src/assets/fonts/harmonyos-sc-300/400/500/700.woff2`
- 来源：华为开发者联盟 HarmonyOS 设计文档
  <https://developer.huawei.com/consumer/cn/doc/design-guides/font-0000001157868583>
- 版权：© Huawei
- 说明：按官方 HarmonyOS Sans 许可使用；仓库内是网页预览用的 WOFF2 子集。

### OPPO Sans 4.0

- 文件：`src/assets/fonts/oppo-sans-var.woff2`
- 来源：OPPO ColorOS 官方站点 <https://www.coloros.com/>（OPPO Sans 为 ColorOS 系统字体）
- 版权：© OPPO
- 说明：OPPO Sans 4.0 可变字体（wght 100–700）；仓库内是网页预览用的 WOFF2 版本。

### DSEG7 Classic

- 文件：`examples/render-port/source/lcd-font-DSEG7Classic-Bold.ttf`
- 来源：<https://github.com/keshikan/DSEG>
- 作者：keshikan（<https://www.keshikan.net>），Reserved Font Name "DSEG"
- 许可证：SIL Open Font License 1.1
- 完整 OFL 文本：`examples/render-port/source/DSEG-LICENSE.txt`

## 运行期 npm 依赖

- Vue 3 — MIT
- Vite — MIT
- `@vitejs/plugin-vue` — MIT

版本与完整依赖树见 `package.json` / `pnpm-lock.yaml`。这些依赖不随本仓库源码一起 vendored，安装时由包管理器获取。
