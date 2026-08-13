# KnockChat 自定义主题功能说明与扩展规范

版本：1.2

---

## 1. 功能说明

### 1.1 功能入口

- 设置页 →「外观」→「主题」：打开主题选择对话框。
- 主题对话框中可以：
  - **选择主题**：点击任意主题卡片即实时预览整体视觉效果（无需刷新页面，全局 UI 同步生效）；
  - **应用主题**：点击「应用」正式生效并持久化；
  - **取消**：关闭对话框时自动回退到打开前的主题；
  - **导入主题文件**：从本地选择 `.json` 主题文件（自动校验，成功后立即预览）；
  - **下载主题模板**：下载一份标准主题文件样板，方便新建主题；
  - **删除主题**：自定义主题卡片悬停后出现删除按钮（删除当前使用中的主题会自动回退到暗黑模式）。

### 1.2 内置主题与自定义主题的关系

| 项目 | 内置主题（暗黑 / 明亮） | 自定义主题 |
| --- | --- | --- |
| 来源 | 程序内置 | 用户从本地导入 |
| 状态管理 | ThemeManager 内置定义 | 导入后存入 localStorage |
| 明暗切换 | 可自由切换 | **自定义主题生效时，明暗切换/主题色同步失效**（设置页对应项置灰） |
| 持久化 | 加密设置（本地） | 本地 localStorage（`cika_theme_store_v1`） |

> 主题与字体均为**本地设置**，不写入服务端 `user_settings`（不同步到其他设备）。
> 自定义主题以「暗色」或「亮色」为基础（主题文件中的 `base` 字段），只覆盖需要修改的变量，其余继承基础主题，因此任何自定义主题都不会出现颜色溢出或样式错乱。

### 1.3 关键行为约定

1. **实时切换**：切换/预览主题只更新 `<html>` 属性与一个内联 `<style>` 节点，不触发页面刷新。
2. **重启恢复**：程序启动时（`src/js/theme.js` 加载阶段）自动从 localStorage 恢复上次使用的主题。
3. **仅本地生效**：主题与字体/排版选择只持久化到本机（主题：`cika_theme_store_v1` + 加密设置；字体/排版：`cika_font_store_v1` + 加密设置），不同步到服务端。
4. **主题色联动**：自定义主题生效期间，设置页「主题色」与明暗切换均标记为不可用；切回内置主题后恢复。
5. **字体/排版独立于主题**：设置页「字体」「字号缩放」「字重」为应用级设置，通过 `--app-font-family`、`--app-font-scale`、`--app-font-weight-*` 层叠生效（见 §2.1），自定义主题文件无法覆盖用户选择的字体、字号与字重。

---

## 2. 架构设计

主题功能由新增文件 `src/js/theme.js` 承载，采用模块化设计，职责分离：

```
src/js/theme.js（ThemeManager，全局单例）
├── 主题配置 config
│   ├── 内置主题定义（dark / light）
│   ├── 主题文件校验规则（schema）
│   └── 变量命名空间白名单（--md- / --font- / --space- / --radius- / --shadow-）
├── 状态管理 state
│   ├── activeThemeId：当前激活的主题
│   └── themes[]：已导入的自定义主题列表
├── 持久化 persist
│   ├── loadState() / saveState()：localStorage 读写（cika_theme_store_v1）
│   └── 启动自动恢复（init()）
└── 样式注入 inject
    ├── applyTheme()：写 <html data-theme> / <html data-custom-theme> + 内联 <style>
    └── buildCss()：生成「仅覆盖增量变量」的 CSS 规则
```

调用关系：

```
other.js（设置页 UI / 对话框）
storage.js（登录后 applyUserSettings 同步）
chat.js / api.js / features.js（仅使用 CSS 变量，无需改动）
        └──> ThemeManager.activate() / preview() / importTheme() / removeTheme()
              └──> applyTheme() → DOM 属性 + <style> 注入 → saveState() → onChange 回调
```

**扩展新内置主题**：只需在 `src/js/theme.js` 的 `BUILTIN_THEMES` 中追加一项，并在 `src/css/tokens.css` 增加对应的 `[data-theme="xxx"]` 变量块。

### 2.1 应用级字体与排版（独立于主题系统）

字体与排版由 `src/js/fonts.js` 承载（全局暴露 `FontManager` 与 `TypographyManager` 两个单例），与主题系统完全解耦：

```
src/js/fonts.js
├── FontManager（字体族）
│   ├── 预设字体列表（系统默认 / Roboto / 微软雅黑 / 苹方 / Noto Sans SC / 等线 / 衬线体 / 等宽字体）
│   ├── 状态 state：activeFontId
│   ├── 持久化 persist：localStorage（cika_font_store_v1，仅本地，不同步服务端）
│   └── 样式注入 inject：写 <html> 内联样式 --app-font-family
│           └── body { font-family: var(--app-font-family, var(--md-font-family)) }
└── TypographyManager（字号缩放 / 字重）
    ├── 预设字号档位（默认 / 小 90% / 标准 100% / 大 110% / 特大 120%）：activeScaleId
    ├── 预设字重档位（默认 / 偏细 / 标准 / 偏粗）：activeWeightId
    ├── 持久化 persist：同上 localStorage（cika_font_store_v1）
    └── 样式注入 inject：写 <html> 内联样式 --app-font-scale 与 --app-font-weight-normal/-medium/-bold
```

- **生效方式**：FontManager 将选中的字体族写入 `<html>` 内联样式 `--app-font-family`；`body` 优先读取它，未选择时回退 `--md-font-family`（跟随主题/系统字体）。TypographyManager 将字号缩放写入 `--app-font-scale`、字重写入 `--app-font-weight-*`，与字体族一同层叠到全局文本（见 §4.4）。
- **不向自定义主题开放**：`--app-*` 命名空间**不在**主题变量白名单（`--md-` / `--font-` / `--space-` / `--radius-` / `--shadow-`）内，因此主题文件即使声明字体类变量也无法覆盖用户选择的字体、字号与字重。主题文件中的 `--md-font-family` 仅在用户未选择字体/排版（系统默认）时作为回退生效。
- **持久化**：与主题一致，仅存本机（自身 localStorage + 设置页加密存储中的 `fontId` / `fontScaleId` / `fontWeightId` 字段），不写入服务端。

---

## 3. 主题文件格式（Schema）

主题文件为 UTF-8 编码的 JSON，扩展名 `.json`，最大 512KB，最多 128 个变量。

```json
{
    "type": "#theme#",
    "app": "com.cika.chatapp",
    "version": 1,
    "id": "my-theme",
    "name": "我的主题",
    "base": "dark",
    "description": "可选，最多 120 字符",
    "variables": {
        "--md-primary": "#A0CAFD",
        "--md-on-primary": "#003258",
        "--md-surface-container": "#262A2C",
        "--md-on-surface": "#E2E2E5"
    }
}
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `type` | 是 | 固定为 `#theme#` |
| `app` | 否 | 应用标识，默认 `com.cika.chatapp` |
| `version` | 否 | 主题 schema 版本，默认 1 |
| `id` | 是 | 1~64 位，仅允许字母、数字、`_`、`-`；与已有主题冲突时自动追加 `-2`、`-3` 后缀 |
| `name` | 是 | 1~40 字符，展示名 |
| `base` | 是 | `dark` 或 `light`，指定继承的基础主题 |
| `description` | 否 | 最多 120 字符 |
| `variables` | 是 | 变量对象，键必须符合下方「变量白名单前缀」，值必须是字符串（≤256 字符） |

校验失败的文件会被拒绝并给出明确错误提示。

---

## 4. 主题变量清单

自定义主题只声明需要覆盖的变量（增量），未声明的自动继承 `base` 基础主题。所有变量均为 CSS 自定义属性，可直接用于任意组件样式。

### 4.1 变量命名空间白名单

| 前缀 | 用途 | 示例 |
| --- | --- | --- |
| `--md-*` | 颜色、表面、文字、圆角半径、阴影、字体、行高等 | `--md-primary` |
| `--font-*` | 字体族与字号 | `--font-family`（实际用 `--md-font-family`） |
| `--space-*` | 间距 | `--space-4` |
| `--radius-*` | 圆角 | `--radius-md` |
| `--shadow-*` | 阴影（预留，当前阴影走 `--md-elevation-*`） | `--shadow-md` |

> 只要新增 CSS 变量遵循上述前缀，主题文件无需改动即可识别新变量，方便后续扩展。

### 4.2 颜色类变量（暗色默认值 / 亮色默认值）

| 变量 | 含义 | 暗色默认 | 亮色默认 |
| --- | --- | --- | --- |
| `--md-primary` | 主色 | `#A0CAFD` | `#1976D2` |
| `--md-on-primary` | 主色上的文字/图标 | `#003258` | `#FFFFFF` |
| `--md-primary-container` | 主色容器底（选中/悬停背景） | `#00497D` | `#D1E4FF` |
| `--md-on-primary-container` | 主色容器上的文字 | `#D1E4FF` | `#001D36` |
| `--md-primary-highlight` | 主色高亮（消息定位闪烁） | `rgba(160,202,253,0.25)` | `rgba(25,118,210,0.18)` |
| `--md-secondary` | 辅助色 | `#BBC7DB` | `#535F70` |
| `--md-on-secondary` | 辅助色上的文字 | `#253140` | `#FFFFFF` |
| `--md-secondary-container` | 辅助色容器底 | `#3B4858` | `#D7E3F7` |
| `--md-on-secondary-container` | 辅助色容器上的文字 | `#D7E3F7` | `#101C2B` |
| `--md-tertiary` | 第三色 | `#D6BEE4` | `#6B5778` |
| `--md-on-tertiary` | 第三色上的文字 | `#3B2948` | `#FFFFFF` |
| `--md-tertiary-container` | 第三色容器底 | `#523F5F` | `#F2DAFF` |
| `--md-on-tertiary-container` | 第三色容器上的文字 | `#F2DAFF` | `#251431` |
| `--md-background` | 页面背景 | `#1A1C1E` | `#FDFCFF` |
| `--md-on-background` | 背景上的文字 | `#E2E2E5` | `#1A1C1E` |
| `--md-surface` | 表面 | `#1A1C1E` | `#FDFCFF` |
| `--md-on-surface` | 表面上的文字 | `#E2E2E5` | `#1A1C1E` |
| `--md-surface-variant` | 表面变体 | `#43474E` | `#DFE2EB` |
| `--md-on-surface-variant` | 表面弱化文字 | `#C3C7CF` | `#43474E` |
| `--md-surface-dim` | 表面（暗淡） | `#1A1C1E` | `#DAD9DD` |
| `--md-surface-bright` | 表面（明亮） | `#3A3C3F` | `#FDFCFF` |
| `--md-surface-container-lowest` | 表面容器（最浅层） | `#0F1113` | `#FFFFFF` |
| `--md-surface-container-low` | 表面容器（浅层） | `#222426` | `#F3F3F6` |
| `--md-surface-container` | 表面容器（默认层） | `#262A2C` | `#EDEEF1` |
| `--md-surface-container-high` | 表面容器（高层） | `#313436` | `#E8E8EB` |
| `--md-surface-container-highest` | 表面容器（最高层） | `#3C3F41` | `#E2E2E5` |
| `--md-surface-hover` | 悬停背景 | `#313436` | `#E2E2E5` |
| `--md-surface-active` | 按压背景 | `#3C3F41` | `#DAD9DD` |
| `--md-inverse-surface` | 反转表面（Snackbar 等） | `#E2E2E5` | `#2F3033` |
| `--md-inverse-on-surface` | 反转表面上的文字 | `#2F3033` | `#F1F0F4` |
| `--md-inverse-primary` | 反转主色 | `#1976D2` | `#A0CAFD` |
| `--md-outline` | 描边/分隔线 | `#8D9199` | `#73777F` |
| `--md-outline-variant` | 描边变体（弱分隔线） | `#43474E` | `#C3C7CF` |
| `--md-error` | 错误/危险色 | `#FFB4AB` | `#BA1A1A` |
| `--md-on-error` | 错误色上的文字（徽标、录音按钮、退出登录等） | `#690005` | `#FFFFFF` |
| `--md-error-container` | 错误容器底 | `#93000A` | `#FFDAD6` |
| `--md-on-error-container` | 错误容器文字 | `#FFDAD6` | `#410002` |
| `--md-error-container-border` | 错误容器描边 | `rgba(255,180,171,0.2)` | `rgba(186,26,26,0.15)` |
| `--md-error-glow` | 录音脉冲光晕 | `rgba(255,180,171,0.4)` | `rgba(186,26,26,0.3)` |
| `--md-success` | 成功/在线色 | `#9CD67D` | `#386A20` |
| `--md-success-container` | 成功容器底（在线徽标） | `#1F5107` | `#B7F397` |
| `--md-on-success-container` | 成功容器文字 | `#B7F397` | `#042100` |
| `--md-success-container-hover` | 在线徽标悬停背景 | `rgba(156,214,125,0.15)` | `rgba(183,243,151,0.2)` |
| `--md-link` | 链接色 | `#90CAF9` | `#1565C0` |
| `--md-ripple-effect` | 涟漪动画色 | `rgba(255,255,255,0.2)` | `rgba(0,0,0,0.1)` |
| `--md-shadow` | 阴影色 | `#000000` | `#000000` |
| `--md-scrim` | 轻遮罩（头像菜单等） | `rgba(0,0,0,0.3)` | `rgba(0,0,0,0.2)` |
| `--md-scrim-mid` | 中遮罩（对话框等） | `rgba(0,0,0,0.5)` | `rgba(0,0,0,0.4)` |
| `--md-scrim-high` | 重遮罩（图片预览等） | `rgba(0,0,0,0.9)` | `rgba(0,0,0,0.75)` |
| `--md-scrim-dialog` | 对话框遮罩（暗色加强） | `rgba(0,0,0,0.48)` | `rgba(0,0,0,0.32)` |
| `--md-avatar-text` | 头像文字 | `#FFFFFF` | `#FFFFFF` |

### 4.2.1 组件级独立令牌（控件专属）

组件级令牌用于将「每个大控件」的配色与其使用到的通用令牌解耦：**默认值是 `var()` 引用**，自动随明/暗主题（以及覆盖通用令牌的自定义主题）联动；主题文件也可直接覆盖任意组件令牌，只影响对应控件，不会「牵一发而动全身」。

| 变量 | 控件 / 作用 | 默认值（引用通用令牌） |
| --- | --- | --- |
| **顶栏** | | |
| `--md-appbar-bg` | 顶栏背景 | `var(--md-surface-container)` |
| `--md-appbar-text` | 顶栏标题/图标 | `var(--md-on-surface)` |
| `--md-appbar-text-muted` | 顶栏次级文字（在线状态等） | `var(--md-on-surface-variant)` |
| **侧边栏聊天列表** | | |
| `--md-sidebar-bg` | 侧边栏背景 | `var(--md-surface-container-low)` |
| `--md-sidebar-text` | 列表昵称 | `var(--md-on-surface)` |
| `--md-sidebar-text-muted` | 最后消息/时间/空态 | `var(--md-on-surface-variant)` |
| `--md-sidebar-item-hover` | 私聊列表项悬停背景 | `var(--md-surface-container)` |
| `--md-sidebar-item-bg` | 私聊列表项未选中背景 | `var(--md-sidebar-bg)` |
| `--md-sidebar-item-active` | 私聊列表项选中背景（当前打开的会话） | `var(--md-surface-container-high)` |
| `--md-sidebar-item-text` | 私聊列表项未选中文字 | `var(--md-sidebar-text)` |
| `--md-sidebar-item-text-muted` | 私聊列表项未选中次文字（最后消息/时间） | `var(--md-sidebar-text-muted)` |
| `--md-sidebar-item-text-active` | 私聊列表项悬停/选中文字 | `var(--md-on-surface)` |
| `--md-sidebar-entry-bg` | 公会频道入口背景 | `var(--md-surface-container)` |
| `--md-sidebar-entry-hover` | 公会频道入口悬停背景 | `var(--md-surface-container-high)` |
| **聊天区** | | |
| `--md-chat-bg` | 消息区背景 | `var(--md-background)` |
| `--md-chat-sender` | 群聊对方昵称 | `var(--md-on-surface-variant)` |
| `--md-chat-sender-dim` | 私聊昵称/已删除昵称 | `var(--md-on-surface-variant)` |
| `--md-chat-sender-own` | 己方昵称 | `var(--md-primary)` |
| `--md-chat-time` | 消息时间 | `var(--md-on-surface-variant)` |
| **消息气泡** | | |
| `--md-bubble-bg` | 对方气泡背景 | `var(--md-surface-container-high)` |
| `--md-bubble-text` | 对方气泡文字 | `var(--md-on-surface)` |
| `--md-bubble-own-bg` | 己方气泡背景 | `var(--md-primary-container)` |
| `--md-bubble-own-text` | 己方气泡文字 | `var(--md-on-primary-container)` |
| **输入栏** | | |
| `--md-chatbar-bg` | 输入栏整体背景 | `var(--md-surface-container)` |
| `--md-chatbar-input-bg` | 输入框背景（含回复预览条） | `var(--md-surface-container-lowest)` |
| `--md-chatbar-input-bg-focus` | 输入框聚焦背景 | `var(--md-surface-container-low)` |
| `--md-chatbar-text` | 输入文字 | `var(--md-on-surface)` |
| `--md-chatbar-text-muted` | 占位符/辅助文字/禁用发送 | `var(--md-on-surface-variant)` |
| `--md-chatbar-btn-bg` | 「+」按钮背景 | `var(--md-primary-container)` |
| `--md-chatbar-btn-hover` | 「+」按钮悬停 | `var(--md-surface-container-high)` |
| `--md-chatbar-btn-active` | 「+」按钮按压/发送禁用 | `var(--md-surface-container-highest)` |
| **功能面板（+ 面板）** | | |
| `--md-panel-bg` | 面板背景 | `var(--md-surface-container-low)` |
| `--md-panel-icon-bg` | 功能图标/音效按钮背景 | `var(--md-surface-container)` |
| `--md-panel-icon-active` | 图标按压背景 | `var(--md-surface-container-high)` |
| `--md-panel-icon-pressed` | 音效按钮深按压背景 | `var(--md-surface-container-highest)` |
| `--md-panel-text` | 图标/标签/返回/标题文字 | `var(--md-on-surface-variant)` |
| `--md-panel-text-dim` | 面板提示文字 | `var(--md-on-surface-variant)` |
| `--md-panel-text-strong` | 录音计时/停止按钮文字 | `var(--md-on-surface)` |
| **菜单（长按/头像/用户菜单）** | | |
| `--md-menu-bg` | 消息长按菜单背景 | `var(--md-surface-container)` |
| `--md-menu-bg-card` | 用户菜单卡片背景 | `var(--md-surface-container-low)` |
| `--md-menu-bg-sheet` | 头像底部菜单背景 | `var(--md-surface)` |
| `--md-menu-text` | 菜单项文字 | `var(--md-on-surface)` |
| `--md-menu-text-muted` | 用户菜单项文字 | `var(--md-on-surface-variant)` |
| `--md-menu-text-dim` | 菜单取消按钮文字 | `var(--md-on-surface-variant)` |
| `--md-menu-hover` | 菜单项悬停/按压背景 | `var(--md-surface-container-high)` |
| `--md-menu-item-active` | 用户菜单项按压背景 | `var(--md-surface-container-highest)` |
| `--md-menu-item-bg` | 用户菜单项（主页/聊天菜单按钮）未选中背景 | `transparent` |
| `--md-menu-item-hover` | 用户菜单项悬停背景 | `var(--md-surface-container-high)` |
| **对话框** | | |
| `--md-dialog-bg` | 对话框背景 | `var(--md-surface-container-high)` |
| `--md-dialog-text` | 标题/主文字 | `var(--md-on-surface)` |
| `--md-dialog-text-muted` | 说明文字 | `var(--md-on-surface-variant)` |
| `--md-dialog-text-dim` | 次级标签/徽标文字 | `var(--md-on-surface-variant)` |
| `--md-dialog-border` | 列表/操作按钮分隔线 | `var(--md-outline-variant)` |
| `--md-dialog-btn-bg` | 小圆按钮背景（音效预览等） | `var(--md-surface-container-high)` |
| `--md-dialog-btn-hover` | 操作按钮悬停背景 | `var(--md-surface-container-highest)` |
| `--md-dialog-btn-active` | 操作按钮按压背景 | `var(--md-surface-container-highest)` |
| **提示条** | | |
| `--md-snackbar-bg` | 提示条背景 | `var(--md-inverse-surface)` |
| `--md-snackbar-text` | 提示条文字 | `var(--md-inverse-on-surface)` |
| **设置页** | | |
| `--md-settings-bg` | 设置项背景 | `var(--md-surface-container-low)` |
| `--md-settings-hover` | 设置项悬停背景 | `var(--md-surface-container)` |
| `--md-settings-active` | 设置项按压背景 | `var(--md-surface-container-high)` |
| `--md-settings-icon-bg` | 设置项图标圆底 | `var(--md-surface-container)` |
| `--md-settings-text` | 设置项标签 | `var(--md-on-surface)` |
| `--md-settings-text-muted` | 设置项图标 | `var(--md-on-surface-variant)` |
| `--md-settings-text-dim` | 分区标题/箭头/当前值 | `var(--md-on-surface-variant)` |
| **聊天辅助信息** | | |
| `--md-hint-bg` | 系统消息背景 | `var(--md-surface-container-low)` |
| `--md-hint-bg-alt` | 日期分隔背景 | `var(--md-surface-container)` |
| `--md-hint-text` | 系统消息/日期文字 | `var(--md-on-surface-variant)` |
| **语音消息条** | | |
| `--md-voice-bg` | 对方语音条背景 | `var(--md-surface-container)` |
| `--md-voice-bg-own` | 己方语音条背景 | `var(--md-primary-container)` |
| `--md-voice-text` | 语音时长文字 | `var(--md-on-surface-variant)` |
| **搜索页** | | |
| `--md-search-bg` | 搜索框区域背景 | `var(--md-surface-container-low)` |
| `--md-search-input-bg` | 搜索输入框背景 | `var(--md-surface-container)` |
| `--md-search-input-focus-border` | 输入框聚焦边框 | `var(--md-primary)` |
| `--md-search-text` | 搜索结果昵称 | `var(--md-on-surface)` |
| `--md-search-text-dim` | 状态/空态/占位符 | `var(--md-on-surface-variant)` |
| `--md-search-item-hover` | 结果项悬停背景 | `var(--md-surface-container)` |
| **描边属性** | | |
| `--md-outline-width` | 全局描边宽度（分隔线/边框），默认 `1px` | `1px` |
| `--md-outline-style` | 全局描边线型（`solid`/`dashed` 等），默认 `solid` | `solid` |
| `--md-outline-dashed` | 虚线场景使用的线型，默认 `dashed` | `dashed` |
| `--md-sidebar-border` | 侧边栏描边颜色（右分隔线、公会入口、私聊列表） | `var(--md-outline-variant)` |
| `--md-menu-border` | 菜单描边颜色（用户卡片/头像菜单分隔线） | `var(--md-outline-variant)` |
| `--md-search-border` | 搜索页描边颜色（搜索框区域/输入框/结果项） | `var(--md-outline-variant)` |
| `--md-settings-border` | 设置页描边颜色（设置项分隔线） | `var(--md-outline-variant)` |
| `--md-field-border` | 表单输入框描边颜色（登录/对话框输入、下拉框） | `var(--md-outline-variant)` |
| `--md-dialog-border` | 对话框描边颜色（见「对话框」分组） | `var(--md-outline-variant)` |
| **头像调色板** | | |
| `--md-avatar-0` ~ `--md-avatar-7` | 头像背景色板（8 色，`.av-0` ~ `.av-7` 引用，可整体更换配色；v073 起为标准 800 色阶，保证白色头像文字对比度 ≥ 4.5:1） | `#1565C0` / `#6A1B9A` / `#00695C` / `#0277BD` / `#E65100` / `#5D4037` / `#455A64` / `#C2185B` |
| **强调描边（主色）** | | |
| `--md-focus-border` | 聚焦描边（输入框/下拉框聚焦态，复合简写可整体覆盖） | `2px solid var(--md-primary)` |
| `--md-accent-border` | 强调左边框（回复引用块 / AI 翻译块） | `3px solid var(--md-primary)` |

> 宽度与线型统一由 `--md-outline-width` / `--md-outline-style` / `--md-outline-dashed` 控制；**描边颜色**默认引用 `--md-outline-variant`，但可按控件独立覆盖（上述 `--md-*-border`），避免「牵一发而动全身」。聚焦 / 回复引用等**主色强调描边**统一由 `--md-focus-border` / `--md-accent-border` 控制，主题文件可直接整体覆盖这两个复合变量。
> 主题文件示例：`"--md-outline-width": "2px"`、`"--md-outline-style": "dashed"`、`"--md-sidebar-border": "#FFDF00"`、`"--md-accent-border": "3px solid #CAF903"`。

### 4.2.2 角色标记与按钮状态层（明暗分值不同）

| 变量 | 含义 | 暗色默认 | 亮色默认 |
| --- | --- | --- | --- |
| **群主标记** | | | |
| `--md-owner-tag-bg` | 群主标记背景（`g-owner-tag`） | `rgba(255,199,130,0.16)` | `rgba(241,175,99,0.16)` |
| `--md-owner-tag` | 群主标记文字 | `#FFC782` | `#8A5A00` |
| **好友专属标记** | | | |
| `--md-friend-tag-bg` | 好友专属标记背景（`fr-*` / `private-friend-tag`） | `rgba(197,177,255,0.16)` | `rgba(125,99,241,0.16)` |
| `--md-friend-tag` | 好友专属标记文字 | `#C9B8FF` | `#4F46D6` |
| **智能体标记** | | | |
| `--md-agent-tag-bg` | 智能体标记背景（`mention-role.agent`） | `rgba(156,214,125,0.18)` | `rgba(150,184,4,0.18)` |
| `--md-agent-tag` | 智能体标记文字 | `#C4E8A4` | `#5F7300` |
| **按钮状态层（MD3）** | | | |
| `--md-btn-state-hover` | 实心按钮悬停叠加层（叠加于 `on-primary`） | `rgba(0,50,88,0.12)` | `rgba(255,255,255,0.08)` |
| `--md-btn-state-active` | 实心按钮按压叠加层 | `rgba(0,50,88,0.2)` | `rgba(255,255,255,0.12)` |
| `--md-btn-text-hover` | 文字按钮悬停叠加层（叠加于 `primary`） | `rgba(160,202,253,0.1)` | `rgba(25,118,210,0.08)` |
| `--md-btn-text-active` | 文字按钮按压叠加层 | `rgba(160,202,253,0.16)` | `rgba(25,118,210,0.12)` |

### 4.2.3 文件预览多窗口（fview，明暗分值不同）

| 变量 | 含义 | 暗色默认 | 亮色默认 |
| --- | --- | --- | --- |
| `--md-fview-window-bg` | 预览窗口背景 | `#000000` | `var(--md-surface-container-low)` |
| `--md-fview-window-border` | 预览窗口描边 | `rgba(255,255,255,0.16)` | `var(--md-outline-variant)` |
| `--md-fview-shadow` | 预览窗口阴影 | `0 10px 32px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35)` | `var(--md-elevation-3)` |
| `--md-fview-bar-bg` | 顶栏背景 | `rgba(0,0,0,0.85)` | `var(--md-surface-container)` |
| `--md-fview-bar-text` | 顶栏文字 | `#FFFFFF` | `var(--md-on-surface)` |
| `--md-fview-bar-divider` | 顶栏分隔线 | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.08)` |
| `--md-fview-body-bg` | 内容区背景 | `#000000` | `var(--md-surface-container-lowest)` |
| `--md-fview-loading-bg` | 加载区背景 | `#000000` | `var(--md-surface-container-lowest)` |
| `--md-fview-loading-text` | 加载提示文字 | `rgba(255,255,255,0.85)` | `var(--md-on-surface-variant)` |
| `--md-fview-btn-bg` | 工具按钮背景 | `rgba(255,255,255,0.16)` | `rgba(0,0,0,0.06)` |
| `--md-fview-btn-border` | 工具按钮描边 | `rgba(255,255,255,0.35)` | `rgba(0,0,0,0.22)` |
| `--md-fview-btn-text` | 工具按钮文字 | `#FFFFFF` | `var(--md-on-surface)` |
| `--md-fview-btn-hover-bg` | 工具按钮悬停背景 | `rgba(255,255,255,0.32)` | `rgba(0,0,0,0.14)` |
| `--md-fview-btn-hover-border` | 工具按钮悬停描边 | `rgba(255,255,255,0.55)` | `rgba(0,0,0,0.35)` |
| `--md-fview-close-hover-bg` | 关闭按钮悬停背景 | `rgba(255,92,92,0.5)` | `rgba(211,47,47,0.12)` |
| `--md-fview-close-hover-border` | 关闭按钮悬停描边 | `rgba(255,120,120,0.65)` | `rgba(211,47,47,0.5)` |
| `--md-fview-capsule-bg` | 文件名胶囊背景 | `#000000` | `var(--md-surface-container-lowest)` |
| `--md-fview-capsule-border` | 文件名胶囊描边 | `rgba(255,255,255,0.18)` | `var(--md-outline-variant)` |
| `--md-fview-capsule-text` | 文件名胶囊文字 | `#FFFFFF` | `var(--md-on-surface)` |
| `--md-fview-capsule-hover-bg` | 文件名胶囊悬停背景 | `#1a1f2e` | `var(--md-surface-container-high)` |
| `--md-fview-capsule-shadow` | 文件名胶囊阴影 | `0 4px 16px rgba(0,0,0,0.5)` | `var(--md-elevation-3)` |
| `--md-fview-cap-close-text` | 胶囊关闭文字 | `rgba(255,255,255,0.7)` | `var(--md-on-surface-variant)` |
| `--md-fview-cap-close-hover-bg` | 胶囊关闭悬停背景 | `rgba(255,255,255,0.15)` | `rgba(0,0,0,0.1)` |
| `--md-fview-unsupported-text` | 不支持格式提示文字 | `rgba(255,255,255,0.55)` | `var(--md-on-surface-variant)` |

### 4.2.4 固定值令牌（特殊场景专用，不随明暗主题联动）

以下令牌服务于固定视觉场景（品牌渐变、专业工具黑底、视频/代码块等），明暗主题共用同一默认值，主题文件可直接覆盖。

| 变量 | 含义 | 默认值 |
| --- | --- | --- |
| **用户资料页（profile）** | | |
| `--md-profile-banner-gradient` | 资料页横幅渐变（品牌紫渐变） | `linear-gradient(135deg, #667eea 0%, #764ba2 100%)` |
| `--md-profile-bar-hover` | 资料页返回栏悬停背景 | `rgba(255,255,255,0.15)` |
| `--md-profile-bar-active` | 资料页返回栏按压背景 | `rgba(255,255,255,0.3)` |
| `--md-profile-icon-shadow` | 资料页图标阴影 | `rgba(0,0,0,0.3)` |
| `--md-profile-hint-bg` | 资料页提示条背景 | `rgba(0,0,0,0.5)` |
| `--md-profile-hint-text` | 资料页提示条文字 | `#FFFFFF` |
| **图片裁剪编辑器（固定黑底专业工具场景，不随主题）** | | |
| `--md-image-editor-bg` | 编辑器整体背景 | `#000000` |
| `--md-image-editor-grid` | 网格线 | `rgba(255,255,255,0.08)` |
| `--md-image-editor-crop-border` | 裁剪框描边 | `#FFFFFF` |
| `--md-image-editor-scrim` | 裁剪区外遮罩 | `rgba(0,0,0,0.65)` |
| `--md-image-editor-btn` | 工具按钮/图标 | `#FFFFFF` |
| `--md-image-editor-zoom-bg` | 缩放按钮背景 | `rgba(255,255,255,0.1)` |
| `--md-image-editor-zoom-active` | 缩放按钮按压背景 | `rgba(255,255,255,0.22)` |
| `--md-image-editor-zoom-pressed` | 缩放按钮深按压背景 | `rgba(255,255,255,0.35)` |
| `--md-image-editor-text` | 提示文字 | `rgba(255,255,255,0.85)` |
| `--md-image-editor-backdrop` | 编辑器外层背景 | `rgba(0,0,0,0.85)` |
| `--md-image-editor-shadow` | 编辑器阴影 | `0 12px 48px rgba(0,0,0,0.6)` |
| **视频消息（聊天气泡缩略图 / 文件预览播放器，固定黑底不随主题）** | | |
| `--md-video-bubble-bg` | 视频缩略图背景 | `#000000` |
| `--md-video-overlay` | 播放按钮遮罩 | `rgba(0,0,0,0.35)` |
| `--md-video-overlay-hover` | 播放按钮悬停遮罩 | `rgba(0,0,0,0.5)` |
| `--md-video-name-gradient` | 视频名渐变（透明→黑） | `linear-gradient(transparent, rgba(0,0,0,0.7))` |
| `--md-video-name-text` | 视频名文字 | `#FFFFFF` |
| **代码块（固定暗色，类 GitHub 风格）** | | |
| `--md-fview-code-bg` | 文件预览代码块背景 | `#0d1117` |

### 4.3 阴影类变量

| 变量 | 含义 |
| --- | --- |
| `--md-elevation-1` / `--md-elevation-2` / `--md-elevation-3` / `--md-elevation-4` / `--md-elevation-5` | Material 风格阴影，覆盖卡片、菜单、对话框等 |

### 4.4 字体类变量

| 变量 | 默认值 |
| --- | --- |
| `--md-font-family` | `'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` |
| `--md-font-size-xs` / `-sm` / `-base` / `-md` / `-lg` / `-xl` / `-xxl` | `0.6875rem` / `0.75rem` / `0.875rem` / `0.9375rem` / `1rem` / `1.25rem` / `1.5rem` |
| `--md-font-weight-normal` / `-medium` / `-bold` | `400` / `500` / `700` |
| `--md-line-height-base` | `1.43` |

> **应用级排版变量**（`--app-font-family` / `--app-font-scale` / `--app-font-weight-*`）由 FontManager / TypographyManager 写入 `<html>` 内联样式（见 §2.1），供 `base.css` 等以「应用级优先、主题回退」的方式引用（如 `font-size: calc(16px * var(--app-font-scale, 1))`、`font-weight: var(--app-font-weight-medium, var(--md-font-weight-medium))`）。它们属于 `--app-*` 命名空间，**不在**主题变量白名单内，主题文件无法覆盖。

### 4.5 间距类变量

`--space-1`(4px) `--space-2`(8px) `--space-3`(12px) `--space-4`(16px) `--space-5`(20px) `--space-6`(24px) `--space-8`(32px) `--space-10`(40px) `--space-12`(48px)

### 4.6 圆角类变量

`--radius-xs`(4px) `--radius-sm`(8px) `--radius-md`(12px) `--radius-lg`(16px) `--radius-xl`(28px) `--radius-full`(9999px)

---

## 5. 主题扩展开发规范

### 5.1 新增自定义主题（最终用户）

1. 设置页 →「外观」→「主题」→「下载主题模板」，或直接复制 `themes/sample.theme.json`；
2. 修改 `id`、`name`、`base`，并按需添加/修改 `variables` 中的变量；
3. 保存为 `.json` 文件，在「主题」对话框中点击「导入主题文件」导入。

### 5.2 新增内置主题（开发者）

1. 在 `src/js/theme.js` 的 `BUILTIN_THEMES` 数组追加一项 `{ id, name, base, builtin: true, description }`；
2. 在 `src/css/tokens.css` 增加对应的 `[data-theme="{id}"] { ... }` 变量块（可复制暗色/亮色块修改）；
3. 若需要默认预览色，在 `BUILTIN_PREVIEW` 中追加 `{ background, surface, primary, onSurface }`。

### 5.3 新增 CSS 变量（开发者）

1. 变量名遵循白名单前缀：`--md-`、`--font-`、`--space-`、`--radius-`、`--shadow-`；
2. **通用令牌**（如 `--md-primary`）：在 `:root`（亮色，默认）与 `[data-theme="dark"]`（暗色）两处同步定义默认值；
3. **组件级令牌**（如 `--md-appbar-bg`，见 §4.2.1）：只需在 `:root` 定义一次，默认值写作 `var(--通用令牌)` 的引用，自动随明/暗主题联动；
4. **属性令牌**（如 `--md-outline-width`、`--md-outline-style`，默认值不随明暗变化）：只需在 `:root` 定义一次，值写作字面量；
5. 在 `docs/theme-guide.md` 变量清单中登记默认值；
6. 自定义主题文件无需修改即可识别新变量（白名单校验通过）。
7. 组件样式中**禁止**直接书写边框宽度/线型字面量（如 `1px solid`），一律引用 `--md-outline-width` + `--md-outline-style`（虚线场景用 `--md-outline-dashed`）；仅颜色使用控件专属色。

### 5.4 组件样式改造约定

- **禁止**在组件样式中硬编码颜色，一律引用 `--md-*` 变量；
- 每个大控件（顶栏、侧边栏、输入栏、菜单、对话框等）的样式只使用其**专属组件令牌**（见 §4.2.1），避免直接引用通用表面/文字令牌造成「牵一发而动全身」；
- 新增控件样式时，若现有组件令牌无法表达，先按 §5.3 新增组件级令牌，再在样式规则中引用；
- 需要主题可调的尺寸/间距/阴影，一律引用 `--space-*`、`--radius-*`、`--md-elevation-*`（最大值 `--md-elevation-5`）；
- 头像底色 `av-0`~`av-7` 为品牌固定色板，不参与主题化（文字色使用 `--md-avatar-text`）。

### 5.5 校验规则摘要

| 规则 | 限制 |
| --- | --- |
| 自定义主题数量 | 最多 64 个 |
| 变量数量 | 最多 128 个 |
| 变量值长度 | ≤ 256 字符 |
| 文件大小 | ≤ 512KB |
| id | 字母/数字/`_`/`-`，≤ 64 位 |
| 变量键 | 必须命中白名单前缀，否则拒绝导入 |

---

## 6. 测试与兼容性

### 6.1 自动化单元测试

- `tests/theme.test.cjs`：Node 环境可执行（`node tests/theme.test.cjs`），覆盖主题状态管理与样式加载逻辑；
- `tests/theme-tests.html`：浏览器直接打开即可运行同一套断言，实时显示通过/失败结果（Chrome / Edge / Firefox / Safari 通用）。

覆盖点：
1. 内置主题激活与 `data-theme` 属性写入；
2. 自定义主题导入校验（合法/非法/内置 id 冲突/变量白名单）；
3. 自定义主题激活后的样式注入内容（选择器、变量写入）；
4. 自定义主题生效时内置切换失效标志（`isCustomThemeActive`）；
5. 预览不持久化、应用后持久化、重启自动恢复；
6. 删除主题及其回退逻辑；
7. id 冲突自动加后缀、主题样板生成与可导入性。

### 6.2 跨设备 / 跨浏览器兼容性

- **浏览器**：Chrome ≥ 76、Edge ≥ 79、Firefox ≥ 71、Safari ≥ 13（CSS 自定义属性与 `Promise` 均支持）；
- **桌面端**：Windows / macOS 原生 WebView；
- **移动端**：iOS / Android WebView（含低版本 Android WebView，`src/js/theme.js` 与 `src/js/fonts.js` 采用 ES5 语法编写）；
- **建议人工回归项**：登录页、聊天页（明/暗气泡、语音条、回复引用）、设置页、弹窗/菜单、图片预览、头像菜单、隐私横幅、录音按钮、在线状态徽标 —— 逐一切换内置与自定义主题检查无颜色溢出、无错位。

### 6.3 性能说明

- 主题切换只更新 1 个 `<style>` 节点文本与 2 个 `<html>` 属性，无 DOM 重建、无页面刷新；
- 主题数据仅导入时写入 localStorage，运行期不产生额外读写；
- 主题系统不引入任何第三方依赖，对既有功能运行性能无影响。
