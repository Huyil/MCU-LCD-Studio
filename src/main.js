import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { installBuiltinAssets, ensureProjectFontsAndRefresh } from './store.js'

const app = createApp(App)
// 全局错误兜底: 渲染/计算异常不再导致整棵组件树被卸载 (面板消失)
app.config.errorHandler = (err, inst, info) => {
  console.error('[lcd-layout]', info, err)
}
app.mount('#app')
// 内置固件素材库 (幂等, 打开编辑器即可用)
setTimeout(() => { try { installBuiltinAssets() } catch (e) { console.warn('内置素材安装失败', e) } }, 0)

/* ===== 字体加载完之后重算"系统字的字宽/字高" =====
 * ！为什么必须做: @font-face 是 font-display: swap —— 首帧用**回退字体**渲染, 而
 *   numFontForSys()/renderSysFontCanvas() 都是同步函数 (没法 await 字体), 首帧量出来的
 *   字宽会被 numFontSysCache / sysRenderCache 缓存住。预览的缓存 key 与导出的不同,
 *   于是"导出那一次已是真字体、预览还留着回退字体的度量" ⇒ 网页预览与板子宽度不一致
 *   (2026-10-12 现场: OPPO Sans 4.0/size 100/spacing -3 → 每格 53 vs 59, 两位数字差 12px,
 *    板上右边多出 12px 把 26x34 的 "s" 左 4 列擦掉)。
 *   这里在字体就绪后清度量缓存 + 重同步系统字图层尺寸 + 重绘; 1.2s 再兜一次。 */
{
  const fix = () => { ensureProjectFontsAndRefresh().catch(e => console.warn('[lcd-layout] 字体度量刷新失败', e)) }
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    document.fonts.ready.then(fix)
    setTimeout(fix, 1200)
  }
}

