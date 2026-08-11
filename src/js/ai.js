/* ============================================
   KnockChat AI 功能模块
   ============================================ */
var CikaAI = (function() {
    'use strict';

    // ============ 默认配置 ============
    var DEFAULTS = {
        provider: 'openai',
        baseUrl: '',
        apiKey: '',
        model: AGENT_DEFAULT_MODELS['openai'],
        translateTargetLang: 'zh-CN'
    };

    // 各服务商 baseUrl；默认模型统一复用 constants.js 的 AGENT_DEFAULT_MODELS
    var PROVIDER_BASE_URLS = {
        'openai': 'https://api.openai.com/v1',
        'google': 'https://generativelanguage.googleapis.com/v1beta',
        'anthropic': 'https://api.anthropic.com/v1',
        'deepseek': 'https://api.deepseek.com/v1'
    };
    var PROVIDER_CONFIGS = {};
    Object.keys(AGENT_DEFAULT_MODELS).forEach(function(p) {
        PROVIDER_CONFIGS[p] = { baseUrl: PROVIDER_BASE_URLS[p] || '', model: AGENT_DEFAULT_MODELS[p] };
    });

    // ============ 存储操作（解密缓存由 storage.js 维护，落盘为 AES-GCM 加密） ============
    function loadModelSettings() {
        if (typeof getAIModelSettings === 'function') {
            var cached = getAIModelSettings();
            if (cached) return cached;
        }
        return {};
    }

    function saveModelSettings(settings) {
        if (typeof saveAIModelSettings === 'function') {
            return saveAIModelSettings(settings);
        }
        return Promise.resolve();
    }

    function loadTranslateSettings() {
        if (typeof getAITranslateSettings === 'function') {
            var cached = getAITranslateSettings();
            if (cached) return cached;
        }
        return { targetLang: DEFAULTS.translateTargetLang };
    }

    function saveTranslateSettings(settings) {
        if (typeof saveAITranslateSettings === 'function') {
            return saveAITranslateSettings(settings);
        }
        return Promise.resolve();
    }

    // ============ 模型设置弹窗 ============
    function showModelSettings() {
        var dialog = document.getElementById('aiModelSettingsDialog');
        if (dialog) { dialog.classList.remove('hidden'); }

        var settings = loadModelSettings();
        var provider = settings.provider || DEFAULTS.provider;
        document.getElementById('aiModelProvider').value = provider;
        document.getElementById('aiModelBaseUrl').value = settings.baseUrl || '';
        document.getElementById('aiModelApiKey').value = settings.apiKey || '';
        document.getElementById('aiModelId').value = settings.model || '';
        updateAIModelPlaceholder(provider);
    }

    function closeModelSettings() {
        var dialog = document.getElementById('aiModelSettingsDialog');
        if (dialog) { dialog.classList.add('hidden'); }
    }

    function updateAIModelPlaceholder(provider) {
        var modelInput = document.getElementById('aiModelId');
        if (!modelInput) return;
        var config = PROVIDER_CONFIGS[provider] || {};
        var defaultModel = config.model || AGENT_DEFAULT_MODELS['openai'];
        modelInput.placeholder = defaultModel;

        // Toggle base_url visibility: only show for custom provider
        var wrapper = document.getElementById('aiBaseUrlWrapper');
        if (wrapper) {
            if (provider === 'custom') {
                wrapper.classList.remove('hidden');
            } else {
                wrapper.classList.add('hidden');
                // Clear base_url when switching away from custom
                var baseUrlInput = document.getElementById('aiModelBaseUrl');
                if (baseUrlInput) baseUrlInput.value = '';
            }
        }

        // Update baseUrl placeholder
        var baseUrlInput = document.getElementById('aiModelBaseUrl');
        if (baseUrlInput) {
            if (provider === 'custom') {
                baseUrlInput.placeholder = '请输入 OpenAI 兼容 API 地址';
            } else {
                baseUrlInput.placeholder = config.baseUrl || '';
            }
        }
    }

    async function saveModelSettingsHandler() {
        var provider = document.getElementById('aiModelProvider').value;
        var baseUrl = document.getElementById('aiModelBaseUrl').value.trim();
        var apiKey = document.getElementById('aiModelApiKey').value.trim();
        var model = document.getElementById('aiModelId').value.trim();

        if (!apiKey) { showSnackbar('请输入 API Key'); return; }
        if (!model) { showSnackbar('请输入模型 ID'); return; }

        await saveModelSettings({
            provider: provider,
            baseUrl: baseUrl,
            apiKey: apiKey,
            model: model
        });
        showSnackbar('模型设置已保存');
        closeModelSettings();
    }

    // ============ 翻译设置弹窗 ============
    var LANG_OPTIONS = [
        { value: 'zh-CN', label: '简体中文' },
        { value: 'zh-TW', label: '繁体中文' },
        { value: 'en', label: 'English' },
        { value: 'ja', label: '日本語' },
        { value: 'ko', label: '한국어' },
        { value: 'fr', label: 'Français' },
        { value: 'de', label: 'Deutsch' },
        { value: 'es', label: 'Español' },
        { value: 'pt', label: 'Português' },
        { value: 'ru', label: 'Русский' },
        { value: 'ar', label: 'العربية' },
        { value: 'th', label: 'ภาษาไทย' },
        { value: 'vi', label: 'Tiếng Việt' }
    ];

    function showTranslationSettings() {
        var dialog = document.getElementById('aiTranslateSettingsDialog');
        if (dialog) { dialog.classList.remove('hidden'); }

        var settings = loadTranslateSettings();
        var targetLang = settings.targetLang || DEFAULTS.translateTargetLang;
        document.getElementById('aiTranslateTargetLang').value = targetLang;
    }

    function closeTranslationSettings() {
        var dialog = document.getElementById('aiTranslateSettingsDialog');
        if (dialog) { dialog.classList.add('hidden'); }
    }

    async function saveTranslationSettingsHandler() {
        var targetLang = document.getElementById('aiTranslateTargetLang').value;
        await saveTranslateSettings({ targetLang: targetLang });
        showSnackbar('翻译设置已保存');
        closeTranslationSettings();
    }

    // ============ 翻译功能 ============
    function getTargetLangLabel() {
        var settings = loadTranslateSettings();
        var targetLang = settings.targetLang || DEFAULTS.translateTargetLang;
        for (var i = 0; i < LANG_OPTIONS.length; i++) {
            if (LANG_OPTIONS[i].value === targetLang) return LANG_OPTIONS[i].label;
        }
        return targetLang;
    }

    function translateMessage(text, callback) {
        var modelSettings = loadModelSettings();
        var baseUrl = modelSettings.baseUrl || '';
        var apiKey = modelSettings.apiKey || '';
        var model = modelSettings.model || AGENT_DEFAULT_MODELS['openai'];

        if (!apiKey) {
            showSnackbar('请先在设置中配置 AI 模型');
            callback(null, '请先在设置中配置 AI 模型');
            return;
        }

        var translateSettings = loadTranslateSettings();
        var targetLang = translateSettings.targetLang || DEFAULTS.translateTargetLang;
        var targetLangLabel = getTargetLangLabel();

        // Determine API endpoint
        var apiUrl;
        if (baseUrl) {
            apiUrl = baseUrl.replace(/\/+$/, '') + '/chat/completions';
        } else {
            var config = PROVIDER_CONFIGS[modelSettings.provider];
            if (config && config.baseUrl) {
                apiUrl = config.baseUrl.replace(/\/+$/, '') + '/chat/completions';
            } else {
                apiUrl = 'https://api.openai.com/v1/chat/completions';
            }
        }

        var requestBody = {
            model: model,
            messages: [
                { role: 'system', content: '你是一个翻译助手。请将用户输入的内容翻译成' + targetLangLabel + '。只输出翻译结果，不要包含任何解释、引号或额外内容。如果输入已经是' + targetLangLabel + '，则直接原样输出。' },
                { role: 'user', content: text }
            ],
            temperature: 0.3,
            max_tokens: 4096
        };

        fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey
            },
            body: JSON.stringify(requestBody)
        }).then(function(response) {
            if (!response.ok) {
                return response.text().then(function(errText) {
                    var errMsg;
                    try {
                        var errJson = JSON.parse(errText);
                        errMsg = errJson.error?.message || ('HTTP ' + response.status);
                    } catch (e) {
                        errMsg = 'HTTP ' + response.status + ': ' + (errText || '未知错误');
                    }
                    throw new Error(errMsg);
                });
            }
            return response.json();
        }).then(function(data) {
            var result = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
            if (result) {
                callback(result, null);
            } else {
                callback(null, '翻译返回为空');
            }
        }).catch(function(err) {
            callback(null, err.message || '翻译请求失败');
        });
    }

    // ============ 翻译结果显示/隐藏 ============
    function toggleTranslation(row) {
        var bubble = row.querySelector('.bubble');
        if (!bubble) return;
        var translateEl = bubble.querySelector('.ai-translation');
        if (translateEl) {
            // Toggle visibility
            if (translateEl.style.display === 'none') {
                translateEl.style.display = '';
            } else {
                translateEl.style.display = 'none';
            }
        }
    }

    function showTranslationLoading(row) {
        removeTranslation(row);
        var bubble = row.querySelector('.bubble');
        if (!bubble) return;
        var loadingEl = document.createElement('div');
        loadingEl.className = 'ai-translation ai-translation-loading';
        loadingEl.innerHTML = '<span class="ai-translation-label">翻译中...</span>';
        bubble.appendChild(loadingEl);
        return loadingEl;
    }

    // v071: 根据消息行定位消息对象（私聊/群聊），用于把译文写入消息并随缓存落盘
    function findMessageByRow(row) {
        if (!row) return null;
        var id = row.dataset.msgId;
        if (!id) return null;
        // v099: 群聊消息容器复用了 #publicMessages DOM（原公聊已移除），消息对象从 groupMessages 查
        var inPrivate = !!(row.closest && row.closest('#privateMessages'));
        var list = inPrivate ? privateMessages : groupMessages;
        if (!Array.isArray(list)) return null;
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].id === id) return list[i];
        }
        return null;
    }

    // 仅渲染译文 DOM（不读写消息缓存；renderTranslation 与缓存恢复共用）
    function _renderTranslationHtml(row, text) {
        if (!text) return;
        var bubble = row.querySelector('.bubble');
        if (!bubble) return;
        var targetLabel = getTargetLangLabel();
        var el = document.createElement('div');
        el.className = 'ai-translation';
        el.innerHTML = '<span class="ai-translation-label">翻译 (' + CikaAI._escapeHtml(targetLabel) + ')</span><div class="ai-translation-text">' + CikaAI._escapeHtml(text) + '</div>';
        el.addEventListener('click', function(e) {
            e.stopPropagation();
            el.style.display = 'none';
        });
        bubble.appendChild(el);
    }

    function renderTranslation(row, text) {
        removeTranslation(row);
        _renderTranslationHtml(row, text);
        // v071: 译文写入消息对象，随消息缓存落盘（离线/重渲染可恢复）
        var msgObj = findMessageByRow(row);
        if (msgObj) {
            msgObj.translation = text;
            // v072: 私聊译文就地同步到会话缓存（群聊缓存在落盘时从 groupMessages 重取）
            if (typeof privateSessionId === 'string' && privateSessionId) updateCachedMessageFields(privateSessionId, msgObj);
            scheduleMessageCacheSave();
        }
    }

    function removeTranslation(row) {
        if (!row) return;
        var bubble = row.querySelector('.bubble');
        if (!bubble) return;
        var existing = bubble.querySelectorAll('.ai-translation');
        existing.forEach(function(el) { el.remove(); });
        // v071: 同步清除消息对象上的缓存译文
        var msgObj = findMessageByRow(row);
        if (msgObj && msgObj.translation) {
            delete msgObj.translation;
            // v072: 私聊译文删除时同步到会话缓存
            if (typeof privateSessionId === 'string' && privateSessionId) updateCachedMessageFields(privateSessionId, msgObj);
            scheduleMessageCacheSave();
        }
    }

    // ============ 对外翻译入口（上下文菜单调用） ============
    function doTranslate(row) {
        var text = row.dataset.msgText || '';
        if (!text) { showSnackbar('消息内容为空，无法翻译'); return; }

        var loadingEl = showTranslationLoading(row);

        translateMessage(text, function(result, error) {
            if (error) {
                removeTranslation(row);
                showSnackbar('翻译失败: ' + error);
                return;
            }
            renderTranslation(row, result);
        });
    }

    // ============ 工具函数 ============
    // 复用全局 escapeHtml（other.js 提供，行为一致）
    function escapeHtml(str) {
        return window.escapeHtml(str);
    }

    // ============ 初始化 ============
    function init() {
        // 暴露全局方法供 index.html onclick 和 app.js 调用
        window.showAIModelSettings = showModelSettings;
        window.closeAIModelSettings = closeModelSettings;
        // 弹窗保存处理器挂到独立全局名，避免覆盖 storage.js 的 saveAIModelSettings（同名会导致递归）
        window.saveAIModelSettingsDialog = saveModelSettingsHandler;
        window.updateAIModelPlaceholder = updateAIModelPlaceholder;
        window.showAITranslationSettings = showTranslationSettings;
        window.closeAITranslationSettings = closeTranslationSettings;
        window.saveAITranslationSettings = saveTranslationSettingsHandler;
        window.CikaAI_doTranslate = doTranslate;
        window.CikaAI_toggleTranslation = toggleTranslation;
        window.CikaAI_removeTranslation = removeTranslation;
        // v071: 恢复已缓存译文（chat.js 渲染消息时调用，不重复写入缓存）
        // 注意：只清理旧译文 DOM，不能调用 removeTranslation（那会删除消息对象上的缓存值）
        window.CikaAI_renderStoredTranslation = function(row, text) {
            if (!row || !text) return;
            var bubble = row.querySelector('.bubble');
            if (!bubble) return;
            var existing = bubble.querySelectorAll('.ai-translation');
            existing.forEach(function(el) { el.remove(); });
            _renderTranslationHtml(row, text);
        };
    }

    return {
        init: init,
        translateMessage: translateMessage,
        doTranslate: doTranslate,
        renderTranslation: renderTranslation,
        removeTranslation: removeTranslation,
        toggleTranslation: toggleTranslation,
        showModelSettings: showModelSettings,
        closeModelSettings: closeModelSettings,
        saveModelSettings: saveModelSettingsHandler,
        showTranslationSettings: showTranslationSettings,
        closeTranslationSettings: closeTranslationSettings,
        saveTranslationSettings: saveTranslationSettingsHandler,
        _escapeHtml: escapeHtml
    };
})();

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
    CikaAI.init();
});
