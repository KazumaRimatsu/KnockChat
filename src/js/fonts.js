/* KnockChat 应用字体设置 v1.0
 *
 * 应用级字体选择，与主题系统完全解耦（「不向自定义主题开放」）：
 *   1) 生效方式：在 <html> 内联样式写入 --app-font-family。
 *      --app-* 命名空间不在主题白名单（--md- / --font- / --space- / --radius- / --shadow-）内，
 *      因此自定义主题文件永远无法覆盖用户选择的字体；body 通过
 *      font-family: var(--app-font-family, var(--md-font-family)) 层叠引用。
 *   2) 「系统默认」不写入变量：回退到 --md-font-family（跟随主题/系统字体）。
 *   3) 仅本地持久化（localStorage），不随用户设置同步到服务端。
 *
 * 使用方式：
 *   FontManager.init()                  启动时恢复上次选择的字体（脚本加载时自动执行）
 *   FontManager.list()                  全部预设字体（含展示名与字体族）
 *   FontManager.getFont(id)             按 id 获取字体
 *   FontManager.getActiveFontId()       当前生效字体 id
 *   FontManager.preview(id)             应用但不持久化（预览）
 *   FontManager.activate(id)            应用并持久化（正式生效）
 *   FontManager.onChange = fn           字体正式生效后回调（用于同步设置页 UI）
 */
(function (global) {
    'use strict';

    // ============================================================
    // 常量与预设字体列表
    // ============================================================
    var STORAGE_KEY = LS_KEYS.FONT_STORE;
    var FONT_VAR = '--app-font-family';
    var SCALE_VAR = '--app-font-scale';
    var WEIGHT_NORMAL_VAR = '--app-font-weight-normal';
    var WEIGHT_MEDIUM_VAR = '--app-font-weight-medium';
    var WEIGHT_BOLD_VAR = '--app-font-weight-bold';

    // 预设字体：family 为 null 表示「系统默认」（回退主题字体，不写入变量）
    var BUILTIN_FONTS = [
        { id: 'default',   name: '系统默认', family: null, note: '跟随主题/系统字体' },
        { id: 'roboto',    name: 'Roboto', family: "'Roboto', -apple-system, 'Segoe UI', sans-serif", note: '无衬线（默认风格）' },
        { id: 'msyh',      name: '微软雅黑', family: "'Microsoft YaHei', 'PingFang SC', sans-serif", note: 'Windows 黑体' },
        { id: 'pingfang',  name: '苹方', family: "'PingFang SC', 'Microsoft YaHei', sans-serif", note: 'macOS / iOS 系统字体' },
        { id: 'noto-sans', name: 'Noto Sans SC', family: "'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei', sans-serif", note: '思源黑体' },
        { id: 'dengxian',  name: '等线', family: "'DengXian', 'Microsoft YaHei', sans-serif", note: 'Windows 等线' },
        { id: 'serif',     name: '衬线体', family: "Georgia, 'Times New Roman', 'Songti SC', serif", note: '宋体 / 衬线风格' },
        { id: 'mono',      name: '等宽字体', family: "'JetBrains Mono', Consolas, 'Courier New', monospace", note: '代码等宽风格' }
    ];

    var BUILTIN_SCALES = [
        { id: 'default', name: '默认', scale: null, note: '100%' },
        { id: 'sm', name: '小', scale: 0.9, note: '90%' },
        { id: 'md', name: '标准', scale: 1, note: '100%' },
        { id: 'lg', name: '大', scale: 1.1, note: '110%' },
        { id: 'xl', name: '特大', scale: 1.2, note: '120%' }
    ];

    var BUILTIN_WEIGHTS = [
        { id: 'default', name: '默认', normal: null, medium: null, bold: null, note: '跟随主题' },
        { id: 'light', name: '偏细', normal: 350, medium: 450, bold: 600, note: '更轻' },
        { id: 'md', name: '标准', normal: 400, medium: 500, bold: 700, note: '推荐' },
        { id: 'strong', name: '偏粗', normal: 450, medium: 600, bold: 800, note: '更醒目' }
    ];

    // ============================================================
    // 状态
    // ============================================================
    var state = { version: 1, activeFontId: 'default', activeScaleId: 'default', activeWeightId: 'default' };
    var stateLoaded = false;

    // ============================================================
    // 工具函数
    // ============================================================
    function storage() {
        try { return global.localStorage; } catch (e) { return null; }
    }

    function safeParse(text) {
        try { return JSON.parse(text); } catch (e) { return null; }
    }

    // 在预设列表中按 id 查找（字体 / 字号 / 字重三套预设共用）
    function findIn(list, id) {
        if (!id) return null;
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return list[i];
        }
        return null;
    }

    // ============================================================
    // 持久化：localStorage（仅本地，不同步服务端）
    // ============================================================
    function loadState() {
        if (stateLoaded) return;
        stateLoaded = true;
        var s = storage();
        if (!s) return;
        try {
            var raw = s.getItem(STORAGE_KEY);
            if (!raw) return;
            var data = safeParse(raw);
            if (!data || typeof data !== 'object') return;
            if (typeof data.activeFontId === 'string' && findIn(BUILTIN_FONTS, data.activeFontId)) {
                state.activeFontId = data.activeFontId;
            }
            if (typeof data.activeScaleId === 'string' && findIn(BUILTIN_SCALES, data.activeScaleId)) {
                state.activeScaleId = data.activeScaleId;
            }
            if (typeof data.activeWeightId === 'string' && findIn(BUILTIN_WEIGHTS, data.activeWeightId)) {
                state.activeWeightId = data.activeWeightId;
            }
        } catch (e) { /* 数据损坏时保持默认 */ }
    }

    function saveState() {
        var s = storage();
        if (!s) return;
        try {
            s.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) { /* 存储不可用时静默 */ }
    }

    // ============================================================
    // 样式注入：--app-* 变量仅写 <html> 内联样式
    // ============================================================
    // commit=true 表示正式生效（持久化 + 回调）；false 表示预览

    // 写入单个 CSS 变量（value 为 null 时移除变量，回退默认）
    function writeCssVar(name, value) {
        var root = document.documentElement;
        if (value != null) root.style.setProperty(name, String(value));
        else root.style.removeProperty(name);
    }

    // 提交当前选择：更新状态并持久化 + 触发对应回调（三套 API 共用）
    function commitItem(stateKey, onChangeFn, item) {
        state[stateKey] = item.id;
        saveState();
        if (typeof onChangeFn === 'function') onChangeFn();
    }

    function applyFont(font, commit) {
        if (!font) return false;
        try {
            writeCssVar(FONT_VAR, font.family);
        } catch (e) {
            return false;
        }
        if (commit) commitItem('activeFontId', notify, font);
        return true;
    }

    function notify() {
        if (typeof api.onChange === 'function') {
            try { api.onChange(); } catch (e) { /* 回调异常不影响字体切换 */ }
        }
    }

    function notifyTypography() {
        if (typeof typographyApi.onChange === 'function') {
            try { typographyApi.onChange(); } catch (e) {}
        }
    }

    function applyScale(item, commit) {
        if (!item) return false;
        try {
            writeCssVar(SCALE_VAR, item.scale);
        } catch (e) {
            return false;
        }
        if (commit) commitItem('activeScaleId', notifyTypography, item);
        return true;
    }

    function applyWeight(item, commit) {
        if (!item) return false;
        try {
            writeCssVar(WEIGHT_NORMAL_VAR, item.normal);
            writeCssVar(WEIGHT_MEDIUM_VAR, item.medium);
            writeCssVar(WEIGHT_BOLD_VAR, item.bold);
        } catch (e) {
            return false;
        }
        if (commit) commitItem('activeWeightId', notifyTypography, item);
        return true;
    }

    // ============================================================
    // 对外 API
    // ============================================================

    // 三套同构 API（字体 / 字号 / 字重）由工厂统一生成：
    // list / get / getActiveId / activate / preview 结构一致，仅命名与数据源不同。
    function makeChoiceApi(cfg) {
        var api = { onChange: null };
        api[cfg.names.list] = function () { return cfg.items.slice(); };
        api[cfg.names.get] = function (id) { return findIn(cfg.items, id); };
        api[cfg.names.getActiveId] = function () { return state[cfg.stateKey]; };
        api[cfg.names.activate] = function (id) {
            var item = findIn(cfg.items, id) || findIn(cfg.items, 'default');
            return cfg.apply(item, true);
        };
        api[cfg.names.preview] = function (id) {
            var item = findIn(cfg.items, id);
            if (!item) return false;
            return cfg.apply(item, false);
        };
        return api;
    }

    var api = makeChoiceApi({
        items: BUILTIN_FONTS,
        stateKey: 'activeFontId',
        apply: applyFont,
        names: { list: 'list', get: 'getFont', getActiveId: 'getActiveFontId', activate: 'activate', preview: 'preview' }
    });
    api.STORAGE_KEY = STORAGE_KEY;
    api.FONT_VAR = FONT_VAR;
    // 启动恢复：从 localStorage 读取并应用上次选择的字体
    api.init = function () {
        loadState();
        applyFont(findIn(BUILTIN_FONTS, state.activeFontId) || findIn(BUILTIN_FONTS, 'default'), false);
        notify();
    };

    var typographyApi = makeChoiceApi({
        items: BUILTIN_SCALES,
        stateKey: 'activeScaleId',
        apply: applyScale,
        names: { list: 'listScales', get: 'getScale', getActiveId: 'getActiveScaleId', activate: 'activateScale', preview: 'previewScale' }
    });
    typographyApi.STORAGE_KEY = STORAGE_KEY;
    typographyApi.SCALE_VAR = SCALE_VAR;
    typographyApi.WEIGHT_NORMAL_VAR = WEIGHT_NORMAL_VAR;
    typographyApi.WEIGHT_MEDIUM_VAR = WEIGHT_MEDIUM_VAR;
    typographyApi.WEIGHT_BOLD_VAR = WEIGHT_BOLD_VAR;
    typographyApi.init = function () {
        loadState();
        applyScale(findIn(BUILTIN_SCALES, state.activeScaleId) || findIn(BUILTIN_SCALES, 'default'), false);
        applyWeight(findIn(BUILTIN_WEIGHTS, state.activeWeightId) || findIn(BUILTIN_WEIGHTS, 'default'), false);
        notifyTypography();
    };
    // 字重组并入同一对象：与字号组共用 onChange，命名不同但结构一致
    Object.assign(typographyApi, makeChoiceApi({
        items: BUILTIN_WEIGHTS,
        stateKey: 'activeWeightId',
        apply: applyWeight,
        names: { list: 'listWeights', get: 'getWeight', getActiveId: 'getActiveWeightId', activate: 'activateWeight', preview: 'previewWeight' }
    }));

    global.FontManager = api;
    global.TypographyManager = typographyApi;

    // 自动初始化：脚本位于 body 尾部，DOM 已就绪，直接恢复上次选择的字体
    try {
        api.init();
        typographyApi.init();
    } catch (e) {
        // 初始化失败时保持系统默认，不影响其他功能
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
