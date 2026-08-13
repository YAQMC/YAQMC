# 设计系统

> **简体中文** | [English](../design-system.md)

视觉系统保持小而一致。`src/styles/tokens.css` 定义颜色、字体、间距、圆角、阴影和动画原语，
`theme-tokens.ts` 叠加实际明暗模式、主副色、安全表面透明度和材质。页面不能创建自己的设计语言，也
不能把用户颜色直接写入零散控件。

中性界面让专辑封面承担主要色彩；单个受控色彩 wash 可用于层级，但渐变/半透明不是通用卡片装饰。
焦点环、语义按钮、键盘操作和减少动画属于组件契约，关键状态不能只靠颜色表达。

## 设置控件

设置页统一使用标题/说明/控件行、分隔线和间距，不堆叠嵌套卡片。Toggle、slider、颜色、文本、数字、
按钮和预览共享表面、圆角、焦点与禁用层级。

`src/components/ui/Select.tsx` 替代主要原生 select：portal 菜单相对 trigger 定位并限制在视口内，提供
combobox/listbox 语义、选中/活动状态、可见焦点、禁用项、点击外部关闭，以及 Enter、Space、方向键、
Home、End、Escape 键盘行为。

应用外观和歌词窗口外观是两个领域；主窗口透明不会偷偷改变歌词文字或歌词窗不透明度。最小 Tauri
窗口为 1000×680，并为 1120px 以下和低高度提供收紧布局。

## 沉浸歌词

沉浸歌词不是第二套设计系统：Normal 保留侧栏与 PlayerBar，Focus 使用完整内容宽度，原生全屏用居中
transport 替换 PlayerBar。transport 最大 560px，视觉隐藏时仍可键盘访问，减少动画时关闭 transition。
Escape 只退出最上层呈现，错误恢复不能隐藏唯一控制界面。最小窗口下歌词可滚动，Follow 可达，
PlayerBar 不覆盖内容。

相关契约：[外观](appearance.md)、[国际化](i18n.md)、[歌词窗口](lyrics-surfaces.md)。
