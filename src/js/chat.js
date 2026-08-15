/* KnockChat 聊天核心功能：公共聊天/私聊的渲染、发送、交互、账号状态、未读提示 */

        // ==================== 群聊状态（v099 替代原公聊） ====================
        let groupMessages = []; // 当前打开群的消息列表
        let groupMessageById = new Map(); // 消息 id 索引，用于 O(1) 去重与回复查找
        let groupLastDateLabel = '';
        let currentGroupId = null; // 当前打开的群聊 id
        let currentGroupInfo = null; // 当前群信息（get_group_info 返回）
        let myGroups = []; // 我的群聊列表（get_my_groups 返回，按 updated_at 倒序）
        let groupUnreadByGid = {}; // gid -> 本地未读计数（红点）
        let groupHasMore = true; // 当前群是否还有更早历史
        let groupLoadingMore = false;
        let groupPollTimer = null; // 当前群消息增量轮询定时器
        let groupListTimer = null; // 群列表周期刷新定时器
        let _muteGroups = {}; // 群聊免打扰（per-group）
        let _lastGroupMsgAt = {}; // gid -> 上次列表轮询看到的 last_message_at（用于检测新消息通知）
        // v099: 群消息发送中标记（防重复提交）
        let _groupSending = false;
        // v090: 群聊新消息自动贴底（防抖，避免批量渲染/轮询时重复滚动）
        let groupScrollTimer = null;
        let privateMessages = [];
        let privateLastDateLabel = '';
        let privateSessionId = null;
        let privateOtherUser = '';
        // v080: 私聊对方 uid（类 QQ 号，从 1 递增）——身份判断/黑名单一律以此为准
        let privateOtherUid = 0;
        let privateChatActive = false;
        let privateStatusInterval = null;
        // v089: 实时在线用户表（username → bool，由 /ws 网关推送）+ 对方已读时间戳（会话级）
        let _onlineUsers = {};
        let privateOtherReadTs = '';
        let dismissedPrivacyBanners = new Set();
        try {
            dismissedPrivacyBanners = new Set(JSON.parse(localStorage.getItem(LS_KEYS.LEGACY_BANNERS) || '[]'));
        } catch (e) { /* 本地数据损坏时保持空集合 */ }
        let replyTarget = null;
        let privateReplyTarget = null;
        let contextTarget = null;
        let lastPokeTime = 0;
        let currentAvatarUrl = '';
        let scrollTimeout = null;
        let privateUnreadCounts = {};
        let privatePollTimer = null;
        // v040: Public chat polling timers for retry logic
        let userAvatarCache = {};
        let privateHasMore = true;
        let privateLoadingMore = false;

        // ============ v071: 屏蔽词检测（src/stpwords/*.stpw 为 base64 编码、每行一个词，应用运行时解码加载） ============
        const STPWORD_SOURCES = [
            { file: 'stpwords/stpword.sex.stpw', label: '黄色内容' },
            { file: 'stpwords/stpword.baokong.stpw', label: '暴力恐怖A' },
            { file: 'stpwords/stpword.fandong.stpw', label: '反动内容' },
            { file: 'stpwords/stpword.gfw.stpw', label: '其他不良内容' },
            { file: 'stpwords/stpword.gun.stpw', label: '暴力恐怖B' },
            { file: 'stpwords/stpword.zz.stpw', label: '政治敏感' }
        ];
        let blockedWordsByLabel = null;
        // v073 性能优化：词表加载后预编译为分块正则（单次扫描替代 label×词数 的 indexOf 双重循环）
        let blockedWordsRegexByLabel = null;
        const WORD_REGEX_CHUNK = 3000;

        function _escapeRegex(s) {
            return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        async function loadBlockedWords() {
            const lists = {};
            await Promise.all(STPWORD_SOURCES.map(async function(src) {
                let b64 = '';
                try {
                    const res = await fetch(src.file);
                    if (res.ok) b64 = await res.text();
                } catch (e) {
                    // file:// 直开页面等无 CORS 环境：fetch 被拦截，改用内嵌副本兜底
                }
                // v073: 内嵌副本兜底（stpwords-data.js 提供，与 .stpw 的 base64 内容一致）
                if (!b64 && window.STPWORD_EMBEDDED && window.STPWORD_EMBEDDED[src.file]) {
                    b64 = window.STPWORD_EMBEDDED[src.file];
                }
                if (!b64) return;
                try {
                    const bin = atob(b64.replace(/\s+/g, ''));
                    const decoded = new TextDecoder('utf-8').decode(Uint8Array.from(bin, function(c) { return c.charCodeAt(0); }));
                    const words = decoded.split(/\r?\n/).map(function(w) { return w.trim(); }).filter(Boolean);
                    if (words.length) {
                        lists[src.label] = (lists[src.label] || []).concat(words);
                    }
                } catch (e) { /* 单个词表加载失败不影响其他词表 */ }
            }));
            blockedWordsByLabel = lists;
            // 预编译分块正则，避免每次消息渲染都做双层 indexOf 遍历
            blockedWordsRegexByLabel = {};
            for (var label in lists) {
                var words = lists[label];
                if (!words || !words.length) continue;
                var rex = [];
                for (var i = 0; i < words.length; i += WORD_REGEX_CHUNK) {
                    rex.push(new RegExp(words.slice(i, i + WORD_REGEX_CHUNK).map(_escapeRegex).join('|')));
                }
                if (rex.length) blockedWordsRegexByLabel[label] = rex;
            }
        }

        // 命中返回对应提示文案（广告/危险网页/黄色 优先于通用不良内容），未命中返回 null
        function checkBlockedWords(text) {
            if (!blockedWordsByLabel || !text) return null;
            // v073：优先用预编译正则（一次扫描替代 label×词数 的 indexOf 双重循环）
            if (blockedWordsRegexByLabel) {
                for (var label in blockedWordsRegexByLabel) {
                    var rex = blockedWordsRegexByLabel[label];
                    for (var j = 0; j < rex.length; j++) {
                        if (rex[j].test(text)) return label;
                    }
                }
                return null;
            }
            for (var label2 in blockedWordsByLabel) {
                var words = blockedWordsByLabel[label2];
                for (var i = 0; i < words.length; i++) {
                    if (text.indexOf(words[i]) !== -1) return label2;
                }
            }
            return null;
        }

        // 启动即加载（异步，不阻塞消息渲染；词表就绪前不显示提示）
        loadBlockedWords();

        // ============ v072: 屏蔽词检测设置（仅公聊生效；类型与方式可配置） ============
        const BLOCKWORD_TYPES = ['黄色内容', '其他不良内容', '暴力恐怖A', '反动内容', '暴力恐怖B', '政治敏感'];
        const BLOCKWORD_TIPS = ['包含不适宜展示的成人内容', '包含其他不良内容', '包含诱导药物滥用等不良内容', '包含敏感内容', '包含暴力及恐怖内容', '包含敏感内容'];
        const BLOCKWORD_SETTINGS_KEY = LS_KEYS.BLOCKWORD;
        const DEFAULT_BLOCKWORD_SETTINGS = { enabled: true, types: BLOCKWORD_TYPES.slice(), method: 'hint' };

        function loadBlockwordSettings() {
            try {
                const raw = localStorage.getItem(BLOCKWORD_SETTINGS_KEY);
                if (raw) {
                    // v073: 屏蔽词类型与提示信息可配置
                    const s = JSON.parse(raw);
                    const types = Array.isArray(s.types) ? s.types.filter(function(t) { return BLOCKWORD_TYPES.indexOf(t) !== -1; }) : null;
                    return {
                        enabled: s.enabled !== false,
                        types: types && types.length ? types : BLOCKWORD_TYPES.slice(),
                        method: s.method === 'hide' ? 'hide' : 'hint'
                    };
                }
            } catch (e) { }
            return Object.assign({}, DEFAULT_BLOCKWORD_SETTINGS, { types: DEFAULT_BLOCKWORD_SETTINGS.types.slice() });
        }

        function saveBlockwordSettings(settings) {
            try {
                // 保存时过滤无效类型
                // 保存时过滤无效提示信息
                localStorage.setItem(BLOCKWORD_SETTINGS_KEY, JSON.stringify({
                    enabled: !!settings.enabled,
                    types: Array.isArray(settings.types) ? settings.types.filter(function(t) { return BLOCKWORD_TYPES.indexOf(t) !== -1; }) : BLOCKWORD_TYPES.slice(),
                    method: settings.method === 'hide' ? 'hide' : 'hint'
                }));
            } catch (e) { }
            // 屏蔽词设置属可云同步设置，变更后通知云同步模块（防抖推送）
            if (typeof notifyCloudSettingsChanged === 'function') {
                notifyCloudSettingsChanged();
            }
        }

        // 设置页入口值显示
        function updateBlockwordSettingsUI() {
            const el = document.getElementById('settingsBlockwordValue');
            if (!el) return;
            const s = loadBlockwordSettings();
            el.textContent = !s.enabled ? '关闭' : (s.method === 'hide' ? '隐藏消息' : '气泡提示');
        }

        function showBlockwordSettings() {
            const dialog = document.getElementById('blockwordSettingsDialog');
            if (dialog) dialog.classList.remove('hidden');
            const s = loadBlockwordSettings();
            const enabledEl = document.getElementById('bwEnabled');
            if (enabledEl) enabledEl.checked = s.enabled;
            document.querySelectorAll('#bwTypeOptions input[type="checkbox"]').forEach(function(cb) {
                cb.checked = s.types.indexOf(cb.value) !== -1;
            });
            document.querySelectorAll('#bwMethodOptions input[type="radio"]').forEach(function(rb) {
                rb.checked = rb.value === s.method;
            });
        }

        function closeBlockwordSettings() {
            const dialog = document.getElementById('blockwordSettingsDialog');
            if (dialog) dialog.classList.add('hidden');
        }

        function saveBlockwordSettingsDialog() {
            const enabledEl = document.getElementById('bwEnabled');
            const enabled = !!enabledEl && enabledEl.checked;
            const types = [];
            document.querySelectorAll('#bwTypeOptions input[type="checkbox"]').forEach(function(cb) {
                if (cb.checked) types.push(cb.value);
            });
            let method = 'hint';
            document.querySelectorAll('#bwMethodOptions input[type="radio"]').forEach(function(rb) {
                if (rb.checked) method = rb.value;
            });
            saveBlockwordSettings({ enabled: enabled, types: types, method: method });
            updateBlockwordSettingsUI();
            closeBlockwordSettings();
            showSnackbar('屏蔽词检测设置已保存');
            // 立即按新设置重渲染当前群消息（当前页面不可见，无视觉跳动）
            refreshGroupMessages();
        }

        // v072: 隐藏消息模式——点击占位条在折叠/展开间切换
        function toggleBlockedMessage(row, warnLabel) {
            if (!row) return;
            const bubble = row.querySelector('.bubble');
            const ph = row.querySelector('.msg-blocked-placeholder');
            if (!bubble || !ph) return;
            const hidden = bubble.style.display === 'none';
            bubble.style.display = hidden ? '' : 'none';
            ph.style.display = hidden ? 'none' : '';
            if (hidden && warnLabel && !bubble.querySelector('.msg-warning')) {
                // 展开时在气泡下方附带屏蔽提示
                const warnEl = document.createElement('div');
                warnEl.className = 'msg-warning';
                warnEl.innerHTML = '<span class="msg-warning-label">' + warnLabel + '</span>';
                bubble.appendChild(warnEl);
            }
        }

        function updateAllAvatars() {
            loadUserAvatars(Object.keys(userAvatarCache).concat([currentUser])).then(() => {
                renderPrivateList();
                document.querySelectorAll('#publicMessages .msg-row .avatar').forEach(av => {
                    const sender = av.dataset.sender;
                    if (sender && userAvatarCache[sender]) {
                        av.style.backgroundImage = `url(${userAvatarCache[sender]})`;
                        av.textContent = '';
                    }
                });
                document.querySelectorAll('#privateMessages .msg-row .avatar').forEach(av => {
                    const sender = av.dataset.username;
                    if (sender && userAvatarCache[sender]) {
                        av.style.backgroundImage = `url(${userAvatarCache[sender]})`;
                        av.textContent = '';
                    }
                });
                updateHomeMenu();
                updatePublicMenu();
            });
        }

        function applyAvatarToElement(el, username) {
            fillUserAvatar(el, username, userAvatarCache[username]);
        }

        let recentPrivateNotifications = {};

        // 兜底通知：实时广播丢失/延迟时（网络不佳），通过广播或轮询补拉的新消息也要播放提示音
        function maybeNotifyPrivateSound(sessionId) {
            if (privateChatActive && privateSessionId === sessionId) return;
            if (!getPrivateNotifyEnabled()) return;
            // v053: 私聊按会话免打扰
            if (_mutePerPrivateSession[sessionId]) return;
            if (document.getElementById('privatePage').classList.contains('active')) return;
            playNotifySound();
        }

        function handlePrivateNotification(sessionId, sender) {
            const mySessions = (window.privateSessions || []);
            const isMySession = mySessions.some(s => s.id === sessionId);
            if (!isMySession && sender !== currentUser) {
                loadPrivateSessions().then(() => {
                    const updated = (window.privateSessions || []);
                    if (updated.some(s => s.id === sessionId) && sender !== currentUser) {
                        // 免打扰时不显示红点、不播放提示音
                        if (!_mutePerPrivateSession[sessionId]) incrementUnread(sessionId);
                        maybeNotifyPrivateSound(sessionId);
                    }
                });
                return;
            }
            if (privateChatActive && privateSessionId === sessionId) return;
            const now = Date.now();
            const key = sessionId + ':' + Math.floor(now / 3000);
            if (recentPrivateNotifications[key]) return;
            recentPrivateNotifications[key] = true;
            Object.keys(recentPrivateNotifications).forEach(k => {
                if (now - parseInt(k.split(':')[1]) * 3000 > 10000) delete recentPrivateNotifications[k];
            });
            loadPrivateSessions().then(() => {
                if (sender !== currentUser) {
                    // 免打扰时不显示红点、不播放提示音
                    if (!_mutePerPrivateSession[sessionId]) incrementUnread(sessionId);
                    maybeNotifyPrivateSound(sessionId);
                }
            });
        }

        let recentSystemMsgs = {};

        function isGarbledText(text) {
            if (!text) return false;
            if (text.includes('\uFFFD')) return true;
            if (text.includes('锟斤拷')) return true;
            let rareCharCount = 0;
            let consecutiveRare = 0;
            let maxConsecutiveRare = 0;
            for (let i = 0; i < text.length; i++) {
                const c = text.charCodeAt(i);
                if (c >= 0x3400 && c <= 0x4DBF) {
                    rareCharCount++;
                    consecutiveRare++;
                    maxConsecutiveRare = Math.max(maxConsecutiveRare, consecutiveRare);
                } else if (c >= 0x4E00 && c <= 0x9FFF) {
                    consecutiveRare = 0;
                } else {
                    consecutiveRare = 0;
                }
                if (c >= 0x20000) {
                    rareCharCount++;
                    consecutiveRare++;
                    maxConsecutiveRare = Math.max(maxConsecutiveRare, consecutiveRare);
                }
            }
            if (rareCharCount > 3 || maxConsecutiveRare >= 2) return true;
            let uncommonCount = 0;
            const commonRange = /^[\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEFa-zA-Z0-9\s\u3001\u3002\uff0c\uff01\uff1f\uff1a\uff1b\u300a\u300b\u3010\u3011+\-_=!@#$%^&*(){}[\]|;:'",.<>?\/\\`~]*$/;
            if (!commonRange.test(text)) {
                for (let i = 0; i < text.length; i++) {
                    const c = text.charCodeAt(i);
                    if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x3400 && c <= 0x4DBF)) {
                        uncommonCount++;
                    }
                }
                if (uncommonCount > 2) return true;
            }
            return false;
        }

        function showLoadMoreIndicator(containerId, indicatorId, show) {
            let indicator = document.getElementById(indicatorId);
            if (show) {
                if (!indicator) {
                    indicator = document.createElement('div');
                    indicator.id = indicatorId;
                    indicator.className = 'load-more-indicator';
                    indicator.innerHTML = '<div class="loading-spinner"><svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="20"/></svg></div><span>正在加载更多消息...</span>';
                    const container = document.getElementById(containerId);
                    container.insertBefore(indicator, container.firstChild);
                }
                indicator.style.display = 'flex';
            } else {
                if (indicator) indicator.style.display = 'none';
            }
        }

        function showGroupLoadMore(show) {
            showLoadMoreIndicator('publicMessages', 'groupLoadMoreIndicator', show);
        }

        // v099: 群消息到达统一入口（轮询/发送回包共用）。gid 为消息所属群聊。
        function handleGroupMessage(gid, msg, isHistory = false, container) {
            const existing = groupMessageById.get(msg.id);
            if (existing) {
                // 旧版本地缓存缺 sender_uid，用服务端数据补齐，并就地修正消息行归属
                if (!existing.sender_uid && msg.sender_uid) {
                    existing.sender_uid = msg.sender_uid;
                    if (msg.sender) existing.sender = msg.sender;
                    const row = document.querySelector('#publicMessages .msg-row[data-msg-id="' + CSS.escape(msg.id) + '"]');
                    if (row) row.classList.toggle('own', isMsgFromMe(existing));
                    scheduleMessageCacheSave();
                }
                return;
            }
            if (msg.is_system) {
                const sysText = (parseMsgContents(msg).content || '').toString();
                if (isGarbledText(sysText)) return;
                if (sysText && (
                    sysText.includes('加入了CikaChat') || sysText.includes('离开了CikaChat') ||
                    sysText.includes('加入了MJChat') || sysText.includes('离开了MJChat') ||
                    sysText.includes('加入了KnockChat') || sysText.includes('离开了KnockChat')
                )) return;
            }
            const nm = {
                id: msg.id,
                sender: msg.sender,
                sender_uid: msg.sender_uid || 0,
                contents: msg.contents || null,
                text: msg.text || '',
                image_url: msg.image_url || null,
                audio_url: msg.audio_url || null,
                audio_dur: msg.audio_dur || 0,
                msg_version: msg.msg_version || null,
                created_at: msg.created_at,
                reply_to_id: msg.reply_to_id || null,
                reply_content: msg.reply_content || null,
                sender_deleted: msg.sender_deleted || false,
                is_system: msg.is_system || false
            };
            groupMessages.push(nm);
            groupMessageById.set(nm.id, nm);
            if (!userAvatarCache.hasOwnProperty(nm.sender) && !nm.is_system) {
                loadUserAvatars([nm.sender]).then(() => {
                    if (gid === currentGroupId && document.getElementById('publicPage').classList.contains('active')) {
                        document.querySelectorAll(`[data-sender="${CSS.escape(nm.sender)}"]`).forEach(el => {
                            applyAvatarToElement(el, nm.sender);
                        });
                    }
                });
            }
            const isCurrent = gid === currentGroupId;
            if (isCurrent && document.getElementById('publicPage').classList.contains('active')) {
                renderGroupMessage(nm, container);
                if (!nm.is_system) {
                    markGroupRead(nm.created_at);
                }
                // v090: 新消息渲染后自动滚动到最新处（用户上翻查看历史时除外）
                if (!isHistory) {
                    const pm = document.getElementById('publicMessages');
                    if (pm && !pm._userScrolledUp) {
                        clearTimeout(groupScrollTimer);
                        groupScrollTimer = setTimeout(function() {
                            if (pm._userScrolledUp) return;
                            scrollToBottom(pm);
                            updateScrollButton(pm);
                        }, 50);
                    }
                }
            } else if (!isHistory && !isMsgFromMe(nm) && !nm.is_system) {
                // 群聊免打扰：开启时不显示红点、不播放提示音；@提及绕过免打扰
                var isMentioned = _checkMention(nm.text || '');
                if (!_muteGroups[gid] || isMentioned) {
                    groupUnreadByGid[gid] = (groupUnreadByGid[gid] || 0) + 1;
                    renderGroupList();
                    updateBackBadge();
                    // 提示音：免打扰开启时仅 @ 消息播放；关闭时按「消息提示音」开关
                    if (isMentioned && _muteGroups[gid]) {
                        playNotifySound();
                    } else if (!_muteGroups[gid] && getPublicNotifyEnabled()) {
                        playNotifySound();
                    }
                }
            }
            // v070: 本地加密缓存——新消息到达即防抖落盘
            scheduleMessageCacheSave();
            // 群聊列表摘要同步刷新（当前群最新消息/未读）
            refreshCurrentGroupSummary(nm);
        }

        // v099: 新群消息到达后更新本地群列表摘要与排序（不重新请求后端）
        function refreshCurrentGroupSummary(nm) {
            for (var i = 0; i < myGroups.length; i++) {
                if (myGroups[i].id === currentGroupId) {
                    myGroups[i].last_message_at = nm.created_at;
                    myGroups[i].last_message = getContentsPreview(parseMsgContents(nm));
                    break;
                }
            }
            renderGroupList();
        }

        // v058: 图片加载占位动画——图片加载完成前显示 MD 圆圈动画（对齐新版 MJChat v055/v056）
        const _mdLoaderSvg = MD_LOADER_SVG;
        // 缓存解析前的 1px 透明占位（避免占位图提前触发 onload 隐藏加载动画）
        const _IMG_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        function _wrapImgWithLoader(url, extraAttrs, extraStyle) {
            // 统一把（已过期/换 AK 失效的）预签名链接还原为公开直链（see other.js mediaUrlToPublic）
            url = (typeof mediaUrlToPublic === 'function') ? mediaUrlToPublic(url) : url;
            if (!url) return '';
            const uid = 'img_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
            const style = extraStyle || '';
            const attrs = extraAttrs || '';
            // 先渲染占位图，再异步解析本地图片缓存（命中返回 objectURL；未命中拉取并写入缓存；
            // 缓存不可用/失败时回退原 url 直接加载，行为与旧版一致）
            _resolveCachedImage(uid, url);
            return '<div class="img-loading-wrap" id="' + uid + '">' + _mdLoaderSvg +
                '<img src="' + _IMG_PLACEHOLDER + '" ' + attrs + ' style="' + style + '" ' +
                'draggable="false" oncontextmenu="return false;">' +
                '</div>';
        }

        // 异步解析图片缓存并设置真实 src；加载完成/失败时切换加载动画状态
        // v073 性能优化：批量渲染进 DocumentFragment 时元素尚未入 DOM，
        // 改为推迟到下一宏任务（渲染与 append 同在一个同步栈，setTimeout 0 必然晚于插入），
        // 替代原 50ms×40 次的空转轮询
        function _resolveCachedImage(uid, url) {
            // 统一把（已过期/换 AK 失效的）预签名链接还原为公开直链（see other.js mediaUrlToPublic）
            url = (typeof mediaUrlToPublic === 'function') ? mediaUrlToPublic(url) : url;
            if (!url) return;
            setTimeout(function() {
                const wrap = document.getElementById(uid);
                if (!wrap) return; // 元素已被移除/重渲染，放弃（重渲染会再次调用）
                const img = wrap.querySelector('img');
                if (!img) return;
            const bindLoad = function(src) {
                if (!img.isConnected) return; // 元素已被移除/重渲染
                img.addEventListener('load', function() {
                    img.classList.add('img-loaded');
                    wrap.classList.add('loaded');
                    // v073：缓存 objectURL 用后即释放，防止内存持续增长
                    if (typeof revokeImageObjectUrl === 'function') revokeImageObjectUrl(src);
                    // v08x 滚动修复：图片加载使消息变高（占位图 1px → 真实图），
                    // 若容器此前贴底且用户未上翻，则布局应用后继续贴底，避免新消息被顶出视野
                    const container = wrap.closest('#publicMessages, #privateMessages');
                    if (container && !container._userScrolledUp && container._atBottomNow) {
                        requestAnimationFrame(function() {
                            if (container._userScrolledUp) return;
                            scrollToBottom(container);
                            updateScrollButton(container);
                        });
                    }
                });
                img.addEventListener('error', function() {
                    img.classList.add('img-loaded');
                    img.style.display = 'none';
                    wrap.classList.add('loaded');
                    if (typeof revokeImageObjectUrl === 'function') revokeImageObjectUrl(src);
                    if (!wrap.querySelector('.img-load-fail')) {
                        const span = document.createElement('span');
                        span.className = 'img-load-fail';
                        span.style.cssText = 'font-size:0.75rem;color:var(--md-on-surface-variant);padding:4px';
                        span.textContent = '图片加载失败';
                        wrap.appendChild(span);
                    }
                    const container = wrap.closest('#publicMessages, #privateMessages');
                    if (container && !container._userScrolledUp && container._atBottomNow) {
                        requestAnimationFrame(function() {
                            if (container._userScrolledUp) return;
                            scrollToBottom(container);
                            updateScrollButton(container);
                        });
                    }
                });
                img.src = src || url;
            };
            if (typeof getCachedImageUrl === 'function') {
                getCachedImageUrl(url).then(function(src) {
                    if (!img.isConnected) {
                        // v073：元素已被移除时立即释放缓存 objectURL
                        if (typeof revokeImageObjectUrl === 'function') revokeImageObjectUrl(src);
                        return;
                    }
                    bindLoad(src);
                });
            } else {
                bindLoad(null);
            }
            });
        }

        // 消息气泡构建辅助（公聊/私聊渲染共用，消除视频/文件气泡 HTML 重复）
        function buildVideoBubbleHtml(url, name) {
            // 统一把（已过期/换 AK 失效的）预签名链接还原为公开直链（see other.js mediaUrlToPublic）
            url = (typeof mediaUrlToPublic === 'function') ? mediaUrlToPublic(url) : url;
            if (!url) return `<div class="file-msg">${escapeHtml(name || '视频')}</div>`;
            return `<div class="video-bubble" onclick="openVideoPreview('${escapeJsString(url)}')"><video src="${escapeAttr(url)}" preload="metadata" muted playsinline></video><div class="video-play-overlay"><svg viewBox="0 0 24 24" width="40" height="40" fill="#fff"><path d="M8 5v14l11-7z"/></svg></div><div class="video-name">${escapeHtml(name)}</div></div>`;
        }
        function buildFileBubbleHtml(url, name, sizeKb) {
            // 统一把（已过期/换 AK 失效的）预签名链接还原为公开直链（see other.js mediaUrlToPublic）
            url = (typeof mediaUrlToPublic === 'function') ? mediaUrlToPublic(url) : url;
            if (!url) return `<div class="file-msg">${escapeHtml(name || '文件')}</div>`;
            const iconPath = getFileIconSvg(name);
            return `<div class="file-msg" onclick="openFilePreview('${escapeJsString(url)}', '${escapeJsString(name)}')"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">${iconPath}</svg><span>${escapeHtml(name)}${sizeKb ? ` (${escapeHtml(sizeKb)} KB)` : ''}</span></div>`;
        }

        // v073 性能优化：container 可传 DocumentFragment（批量渲染历史消息），
        // 传入时对行加 no-anim 类，避免上百条历史消息同时播放入场动画
        // v099: 由公聊渲染改为群聊渲染（渲染逻辑对消息对象结构完全兼容，仅计数归因按各消息 sender_uid 判断）
        function renderGroupMessage(msg, container) {
            const c = container || document.getElementById('publicMessages');
            const isOwn = isMsgFromMe(msg);
            const isDeleted = msg.sender_deleted || false;
            const contents = parseMsgContents(msg);
            const isSystem = contents.type === 'system' || msg.is_system || false;

            if (isSystem) {
                const sysText = String(contents.content || '');
                if (isGarbledText(sysText)) {
                    return; // skip garbled messages
                }
                const d = document.createElement('div');
                d.className = 'system-msg';
                d.innerHTML = `<span>${escapeHtml(sysText)}</span>`;
                c.appendChild(d);
                return;
            }

            const date = new Date(msg.created_at);
            const dl = date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
            if (dl !== groupLastDateLabel) {
                groupLastDateLabel = dl;
                const s = document.createElement('div');
                s.className = 'date-divider';
                s.innerHTML = `<span>${dl}</span>`;
                c.appendChild(s);
            }
            const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            const ci = hashStr(msg.sender) % 8;
            let bubbleContent = '';
            let msgType = 'text';
            let linkUrl = null;
            let imageUrl = null;

            let replyHtml = '';
            if (msg.reply_to_id) {
                const repliedMsg = groupMessageById.get(msg.reply_to_id);
                let replyPreviewContent = '';
                if (repliedMsg) {
                    const senderDisplay = repliedMsg.sender_deleted ? `[用户已注销] ${repliedMsg.sender}` : repliedMsg.sender;
                    const rContents = parseMsgContents(repliedMsg);
                    let contentPreview = '';
                    if (rContents.type === 'image' || rContents.type === 'emoji') {
                        contentPreview = _wrapImgWithLoader(rContents.url || '', '', 'max-width:100px;max-height:100px;border-radius:4px;');
                    } else if (rContents.type === 'audio') {
                        contentPreview = `[语音] ${formatDuration(repliedMsg.audio_dur || parseInt(rContents.dur) || 0)}`;
                    } else if (rContents.type === 'system') {
                        contentPreview = escapeHtml(rContents.content || '');
                    } else {
                        contentPreview = escapeHtml(getContentsPreview(rContents));
                    }
                    replyPreviewContent =
                        `<span class="reply-sender">${escapeHtml(senderDisplay)}</span><br><span class="reply-content">${contentPreview}</span>`;
                } else {
                    replyPreviewContent = escapeHtml(msg.reply_content || '');
                }
                if (replyPreviewContent) {
                    replyHtml = `<div class="reply-preview-block" data-reply-id="${escapeAttr(msg.reply_to_id)}" onclick="jumpToMessage('${escapeJsString(msg.reply_to_id)}', 'group')">↩ ${replyPreviewContent}</div>`;
                }
            }

            // mjv064 协议消息（历史缓存消息回退解析）
            const mjMatch = msg.text && msg.text.match(/<mjv064\s+([^>]*)>([\s\S]*?)<\/mjv064>/);
            // v101: 统一 contents 协议渲染（type: text/image/video/file/audio/emoji/richtext）；
            // 无 contents 的历史消息回退旧协议（mjv064/image_url/audio_url/🔗📎🎤 marked 文本）
            const hasContents = !!msg.contents;
            if (hasContents) {
                bubbleContent = renderContentsBubble(contents, msg);
                msgType = contentsMsgType(contents);
                if (contents.type === 'image' || contents.type === 'emoji') imageUrl = contents.url || '';
                if (contents.type === 'file' || contents.type === 'video') linkUrl = contents.url || '';
            } else if (mjMatch) {
                const mjAttrs = _parseMjV064(mjMatch);
                const mjType = mjAttrs.type;
                if (mjType === 'voice') {
                    // v069: mjv064 无 url 时回退到消息 audio_url 字段（兼容公聊语音发送格式）
                    bubbleContent = buildVoiceBubbleHtml(mjAttrs.url || msg.audio_url || '', parseInt(mjAttrs.dur) || msg.audio_dur || 0, '请升级到最新版本播放');
                    msgType = 'voice';
                } else if (mjType === 'link') {
                    const mjLink = mjAttrs.url || '';
                    if (isSafeUrl(mjLink)) {
                        linkUrl = mjLink;
                        bubbleContent =
                            `<a href="${escapeAttr(linkUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(mjAttrs.text || linkUrl)}</a>`;
                        msgType = 'link';
                    } else {
                        // v073 安全修复：mjv064 链接未过协议白名单时回退为纯文本，防止 javascript: 注入
                        bubbleContent = escapeHtml(mjAttrs.text || mjMatch[2] || mjLink);
                        msgType = 'text';
                    }
                } else if (mjType === 'file') {
                    const mjFname = mjAttrs.name || 'file';
                    const mjFsize = mjAttrs.size || '';
                    const mjFurl = mjAttrs.url || '';
                    linkUrl = mjFurl;
                    if (isImageFile(mjFname)) {
                        bubbleContent = _wrapImgWithLoader(mjFurl, `onclick="previewImage('${escapeJsString(mjFurl)}')" alt="${escapeAttr(mjFname)}"`, 'max-width:280px;max-height:280px;border-radius:12px;cursor:pointer;');
                        msgType = 'image';
                        imageUrl = mjFurl;
                    } else if (isVideoFile(mjFname)) {
                        bubbleContent = buildVideoBubbleHtml(mjFurl, mjFname);
                        msgType = 'video';
                    } else {
                        bubbleContent = buildFileBubbleHtml(mjFurl, mjFname, mjFsize);
                        msgType = 'file';
                    }
                } else if (mjType === 'emoji') {
                    // v091: 自定义表情——CQ 码引用图片 URL，渲染为 80px 表情图
                    const mjEmojiUrl = mjAttrs.url || '';
                    if (mjEmojiUrl) {
                        bubbleContent = _wrapImgWithLoader(mjEmojiUrl, `onclick="previewImage('${escapeJsString(mjEmojiUrl)}')" alt="${escapeAttr(mjAttrs.name || '表情')}"`, 'width:80px;height:80px;object-fit:contain;border-radius:8px;cursor:pointer;');
                        msgType = 'emoji';
                        imageUrl = mjEmojiUrl;
                    } else {
                        bubbleContent = escapeHtml(mjAttrs.name || mjMatch[2] || '[表情]');
                        msgType = 'text';
                    }
                } else {
                    bubbleContent = escapeHtml(mjMatch[2]);
                    msgType = 'text';
                }
            } else if (msg.image_url) {
                imageUrl = msg.image_url;
                let imageUrls = [];
                if (msg.text && msg.text.startsWith('🖼️ ')) {
                    const matches = msg.text.match(/!\[.*?\]\((.*?)\)/g);
                    if (matches && matches.length > 0) {
                        imageUrls = matches.map(m => {
                            const match = m.match(/!\[.*?\]\((.*?)\)/);
                            return match ? match[1] : null;
                        }).filter(Boolean);
                    }
                }
                if (imageUrls.length > 1) {
                    bubbleContent = `<div class="image-grid">${imageUrls.map(url => _wrapImgWithLoader(url, `onclick="previewImage('${escapeJsString(url)}')"`)).join('')}</div>`;
                    msgType = 'image';
                } else {
                    bubbleContent = _wrapImgWithLoader(msg.image_url, `onclick="previewImage('${escapeJsString(msg.image_url)}')"`);
                    msgType = 'image';
                }
                if (msg.text && !msg.text.startsWith('🖼️ ')) {
                    bubbleContent += `<div style="margin-top:4px;">${cleanHtml(msg.text)}</div>`;
                }
            } else if (msg.audio_url) {
                bubbleContent = buildVoiceBubbleHtml(msg.audio_url, msg.audio_dur || 0);
                msgType = 'voice';
            } else {
                const marked = parseMarkedText(msg.text);
                if (marked && marked.type === 'voice') {
                    bubbleContent = buildVoiceBubbleHtml(marked.url, marked.duration || 0, '请升级到最新版本播放');
                    msgType = 'voice';
                } else if (marked && marked.type === 'link') {
                    linkUrl = marked.url;
                    bubbleContent =
                        `<a href="${escapeAttr(marked.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(marked.displayText)}</a>`;
                    msgType = 'link';
                } else if (marked && marked.type === 'file') {
                    const fileParts = marked.fileInfo.match(/^(.*?)\s*\(([\d.]+)\s*KB\)$/);
                    const fileName = fileParts ? fileParts[1] : marked.fileInfo;
                    const fileSize = fileParts ? fileParts[2] : '';
                    if (isImageFile(fileName)) {
                        const mdImgUid = 'img_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
                        _resolveCachedImage(mdImgUid, marked.url);
                        bubbleContent = `<img src="${_IMG_PLACEHOLDER}" id="${mdImgUid}" alt="${escapeAttr(fileName)}" loading="lazy" style="max-width:280px;max-height:280px;border-radius:12px;cursor:pointer;" onclick="previewImage('${escapeJsString(marked.url)}')">`;
                        msgType = 'image';
                        imageUrl = marked.url;
                    } else if (isVideoFile(fileName)) {
                        bubbleContent = buildVideoBubbleHtml(marked.url, fileName);
                        msgType = 'video';
                        linkUrl = marked.url;
                    } else {
                        bubbleContent = buildFileBubbleHtml(marked.url, fileName, fileSize);
                        msgType = 'file';
                        linkUrl = marked.url;
                    }
                } else {
                    let cleaned = cleanHtml(msg.text);
                    cleaned = cleaned.replace(/@([\w\u4e00-\u9fa5]+)/g, '<b>@$1</b>');
                    bubbleContent = cleaned;
                    msgType = 'text';
                }
            }

            const senderDisplay = isDeleted ? `[用户已注销] ${msg.sender}` : msg.sender;
            const senderClass = isDeleted ? 'sender deleted' : 'sender';
            const avatarClass = isDeleted ? 'avatar av-' + ci + ' deleted' : 'avatar av-' + ci;
            // v102: 群聊消息发送者标签——群主/管理员优先显示角色标签，否则为好友徽标
            let senderBadge = '';
            if (!isOwn && !isDeleted) {
                const sRole = msg.sender_role || '';
                if (sRole === 'owner') senderBadge = '<span class="g-owner-tag">群主</span>';
                else if (sRole === 'admin') senderBadge = '<span class="g-admin-tag">管理员</span>';
                else if (window.friendModule && typeof window.friendModule.friendBadgeHtml === 'function') {
                    senderBadge = window.friendModule.friendBadgeHtml(msg.sender);
                }
            }

            // v101: 文本类消息的复制/翻译数据（richtext 去标签）
            let textContent = '';
            if (contents.type === 'text') textContent = String(contents.content || '');
            else if (contents.type === 'richtext') textContent = String(contents.content || '').replace(/<[^>]+>/g, '');

            const row = document.createElement('div');
            row.className = `msg-row ${isOwn ? 'own' : ''}${container ? ' no-anim' : ''}`;
            row.dataset.msgId = msg.id;
            row.dataset.msgSender = msg.sender;
            row.dataset.msgUid = msg.sender_uid || '';
            row.dataset.msgText = textContent || msg.text || '';
            row.dataset.msgType = msgType;
            row.dataset.linkUrl = linkUrl || '';
            row.dataset.imageUrl = imageUrl || '';
            row.dataset.replyToId = msg.reply_to_id || '';
            row.dataset.replyContent = msg.reply_content || '';
            row.dataset.replySender = msg.reply_to_id ? ((function(){ var _f = groupMessageById.get(msg.reply_to_id); return _f ? _f.sender : ''; })() || '') :
            '';

            let bubbleClass = 'bubble';
            if (msgType === 'image') {
                // 历史多图网格（contents 协议下的多图走 richtext 内联 img）
                if (!hasContents && msg.text && msg.text.startsWith('🖼️ ') && msg.text.match(/!\[.*?\]\(.*?\)/g) && msg.text.match(
                    /!\[.*?\]\(.*?\)/g).length > 1) {
                    bubbleClass += ' image-bubble';
                } else {
                    bubbleClass += ' image-single';
                }
            }

            row.innerHTML = `
                <div class="${avatarClass}" data-sender="${escapeAttr(msg.sender)}" onclick="showUserProfile('${escapeJsString(msg.sender)}')">${escapeHtml(msg.sender.charAt(0).toUpperCase())}</div>
                <div class="content">
                    <div class="meta"><span class="${senderClass}">${escapeHtml(senderDisplay)}</span>${senderBadge}<span class="time">${time}</span></div>
                    <div class="${bubbleClass}">${replyHtml}${bubbleContent}</div>
                </div>
            `;
            const avatarElem = row.querySelector('.avatar');
            if (userAvatarCache[msg.sender]) {
                // 统一把（已过期/换 AK 失效的）预签名链接还原为公开直链（see other.js mediaUrlToPublic）
                const cleanAvatar = (typeof mediaUrlToPublic === 'function') ? mediaUrlToPublic(userAvatarCache[msg.sender]) : userAvatarCache[msg.sender];
                if (cleanAvatar) {
                    avatarElem.style.backgroundImage = `url(${cleanAvatar})`;
                    avatarElem.textContent = '';
                }
            }
            row.dataset.elementId = msg.id;
            // v072: 屏蔽词检测（仅公聊）——按设置选择命中的类型与处理方式；判断结果写入消息对象随缓存落盘
            if (typeof msg.blocked_warn !== 'string') msg.blocked_warn = checkBlockedWords(textContent);
            if (msg.blocked_warn) {
                const bwSettings = loadBlockwordSettings();
                if (bwSettings.enabled && bwSettings.types.indexOf(msg.blocked_warn) !== -1) {
                    const bubbleEl = row.querySelector('.bubble');
                    if (bubbleEl) {
                        if (bwSettings.method === 'hide') {
                            // 隐藏消息：折叠原文，点击占位条展开查看
                            bubbleEl.style.display = 'none';
                            const phEl = document.createElement('div');
                            phEl.className = 'msg-blocked-placeholder';
                            phEl.textContent = BLOCKWORD_TIPS[BLOCKWORD_TYPES.indexOf(msg.blocked_warn)];
                            const contentEl = row.querySelector('.content');
                            if (contentEl) {
                                contentEl.insertBefore(phEl, bubbleEl);
                                phEl.addEventListener('click', function(ev) {
                                    ev.stopPropagation();
                                    toggleBlockedMessage(row, msg.blocked_warn);
                                });
                            }
                        } else {
                            // 气泡提示：消息下方显示提示（样式与翻译文本一致）
                            const warnEl = document.createElement('div');
                            warnEl.className = 'msg-warning';
                            warnEl.innerHTML = '<span class="msg-warning-label">' + BLOCKWORD_TIPS[BLOCKWORD_TYPES.indexOf(msg.blocked_warn)] + '</span>';
                            bubbleEl.appendChild(warnEl);
                        }
                    }
                }
            }
            // v071: 恢复已缓存译文（若有）
            if (typeof msg.translation === 'string' && msg.translation && typeof window.CikaAI_renderStoredTranslation === 'function') {
                window.CikaAI_renderStoredTranslation(row, msg.translation);
            }
            c.appendChild(row);
        }

        function jumpToMessage(msgId, type) {
            const container = document.getElementById(type === 'private' ? 'privateMessages' : 'publicMessages');
            const targetRow = container.querySelector(`.msg-row[data-msg-id="${msgId}"]`);
            if (targetRow) {
                targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
                targetRow.style.transition = 'background 1s';
                targetRow.style.background = 'var(--md-primary-highlight)';
                targetRow.style.marginLeft = '-16px';
                targetRow.style.marginRight = '-16px';
                targetRow.style.paddingLeft = '16px';
                targetRow.style.paddingRight = '16px';
                setTimeout(() => {
                    targetRow.style.background = 'transparent';
                    targetRow.style.marginLeft = '';
                    targetRow.style.marginRight = '';
                    targetRow.style.paddingLeft = '';
                    targetRow.style.paddingRight = '';
                }, 2000);
            } else {
                showSnackbar('无法定位到此消息');
            }
        }

        function refreshGroupMessages() {
            const c = document.getElementById('publicMessages');
            c.innerHTML = '';
            groupLastDateLabel = '';
            // v073 性能优化：DocumentFragment 批量插入，避免逐条 append 反复触发布局
            const frag = document.createDocumentFragment();
            groupMessages.forEach(m => renderGroupMessage(m, frag));
            c.appendChild(frag);
            const container = document.getElementById('publicMessages');
            if (container && document.getElementById('publicPage').classList.contains('active')) {
                setTimeout(() => {
                    scrollToBottom(container);
                    updateScrollButton(container);
                }, 50);
            }
        }

        function addSystemMsg(container, text) {
            const d = document.createElement('div');
            d.className = 'system-msg';
            d.innerHTML = `<span>${escapeHtml(text)}</span>`;
            container.appendChild(d);
        }

        function addGroupSystemMsg(text) {
            if (isGarbledText(text)) return;
            addSystemMsg(document.getElementById('publicMessages'), text);
        }

        // v086: 发送期间按钮状态——禁用同时显示加载动画（spinner）
        // sending=true 置位 .sending 类 + disabled；sending=false 恢复后由 toggle*SendBtn 按输入内容重算
        function setSendState(btnId, sending) {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.disabled = !!sending;
            btn.classList.toggle('sending', !!sending);
            if (window.__debugLog) window.__debugLog('发送按钮 ' + btnId + (sending ? ' 禁用+动画(发送中)' : ' 恢复'));
        }

        function toggleGroupSendBtn() {
            const btn = document.getElementById('publicSendBtn');
            if (btn.classList.contains('sending')) return; // 发送中不干预，防止 oninput 误恢复按钮
            btn.disabled = !readInputValue(document.getElementById('publicMsgInput')).trim() &&
                !replyTarget;
        }

        // ==================== @ 提及快速选择 ====================
        // 输入 @ 弹出候选（普通用户 + 智能体），方向键/Enter/Tab 选择，Esc 关闭；
        // 选择后光标处插入 "@名字 "，checkAgentMention 发送时仍按名字触发智能体。
        let mentionActive = false;
        let mentionCandidates = [];
        let mentionFilter = '';
        let mentionSel = -1;
        // v102: @ 候选加载防抖——连续输入 @abc 时只发一次 mention_candidates RPC
        let mentionDebounceTimer = null;

        function getMentionMenu() { return document.getElementById('publicMentionMenu'); }

        function scheduleMentionLoad(query) {
            if (mentionDebounceTimer) clearTimeout(mentionDebounceTimer);
            mentionDebounceTimer = setTimeout(function() {
                mentionDebounceTimer = null;
                loadMentionCandidates(query);
            }, 250);
        }

        async function updateMentionFromInput(input) {
            if (!input || input.id !== 'publicMsgInput') return;
            const before = getTextBeforeCursor(input);
            const m = before.match(/@([\w\u4e00-\u9fa5]*)$/);
            if (m) {
                const prefix = m[1] || '';
                if (mentionActive) {
                    if (mentionFilter !== prefix) {
                        mentionFilter = prefix;
                        mentionSel = -1;
                        scheduleMentionLoad(prefix);
                    }
                } else {
                    mentionActive = true;
                    mentionFilter = prefix;
                    mentionSel = -1;
                    scheduleMentionLoad(prefix);
                }
            } else if (mentionActive) {
                closeMentionMenu();
            }
        }

        async function loadMentionCandidates(query) {
            try {
                const { data, error } = await s3.rpc('mention_candidates', { p_query: query || '', p_limit: 30 });
                mentionCandidates = (!error && Array.isArray(data)) ? data : [];
            } catch (e) {
                mentionCandidates = [];
            }
            renderMentionMenu();
        }

        function renderMentionMenu() {
            const menu = getMentionMenu();
            if (!menu) return;
            if (!mentionActive || mentionCandidates.length === 0) {
                menu.style.display = 'none';
                return;
            }
            if (mentionSel < 0) mentionSel = 0;
            if (mentionSel >= mentionCandidates.length) mentionSel = mentionCandidates.length - 1;
            // 定位：以输入框为锚点，在公聊页（position:relative）内计算坐标，
            // 避免被 .chat-bar 的 overflow:hidden 裁剪
            try {
                const input = document.getElementById('publicMsgInput');
                const page = document.getElementById('publicPage');
                const inputRect = input.getBoundingClientRect();
                const pageRect = page.getBoundingClientRect();
                menu.style.left = (inputRect.left - pageRect.left) + 'px';
                menu.style.width = inputRect.width + 'px';
                menu.style.bottom = (pageRect.bottom - inputRect.top + 8) + 'px';
            } catch (e) { /* 忽略定位异常，按默认位置显示 */ }
            menu.style.display = 'block';
            menu.innerHTML = mentionCandidates.map(function(c, i) {
                const name = c.username || '';
                const roleBadge = c.role === 'agent'
                    ? '<span class="mention-role agent">智能体</span>'
                    : '<span class="mention-role">用户</span>';
                const avatarUrl = (c.avatar_url && typeof sanitizeAvatarUrl === 'function') ? sanitizeAvatarUrl(c.avatar_url) : '';
                const avatarAttr = avatarUrl ? ' style="background-image:url(\'' + escapeAttr(avatarUrl) + '\')"' : '';
                const avatarText = avatarAttr ? '' : escapeHtml(String(name.charAt(0) || '?').toUpperCase());
                return '<div class="mention-item' + (i === mentionSel ? ' active' : '') + '" data-index="' + i + '"' +
                    ' onmousedown="pickMention(' + i + ')">' +
                    '<span class="mention-avatar"' + avatarAttr + '>' + avatarText + '</span>' +
                    '<span class="mention-name">' + escapeHtml(name) + '</span>' + roleBadge +
                    '</div>';
            }).join('');
        }

        function moveMentionSel(delta) {
            if (!mentionActive || mentionCandidates.length === 0) return;
            mentionSel = (mentionSel + delta + mentionCandidates.length) % mentionCandidates.length;
            renderMentionMenu();
            // 手动滚动菜单内选中项可见（不用 scrollIntoView，避免带动消息区滚动）
            const menu = getMentionMenu();
            const active = menu.querySelector('.mention-item.active');
            if (active) {
                const mRect = active.getBoundingClientRect();
                const menuRect = menu.getBoundingClientRect();
                if (mRect.top < menuRect.top) menu.scrollTop -= (menuRect.top - mRect.top);
                else if (mRect.bottom > menuRect.bottom) menu.scrollTop += (mRect.bottom - menuRect.bottom);
            }
        }

        function selectMention() {
            const c = mentionCandidates[mentionSel];
            if (!c) { closeMentionMenu(); return; }
            const input = document.getElementById('publicMsgInput');
            const atText = '@' + c.username + ' ';
            if (!replaceMentionText(input, atText)) {
                // 光标不在文本节点（如紧邻表情图）时兜底：按光标前后文本重建
                const before = getTextBeforeCursor(input);
                const replaced = before.replace(/@[\w\u4e00-\u9fa5]*$/, atText);
                clearInput(input);
                insertTextAtCursor(input, replaced);
                insertTextAtCursor(input, getTextAfterCursor(input));
            }
            autoResize(input);
            toggleGroupSendBtn();
            closeMentionMenu();
            input.focus();
        }

        function pickMention(index) {
            mentionSel = index;
            selectMention();
        }

        function closeMentionMenu() {
            if (mentionDebounceTimer) { clearTimeout(mentionDebounceTimer); mentionDebounceTimer = null; }
            mentionActive = false;
            mentionCandidates = [];
            mentionFilter = '';
            mentionSel = -1;
            const menu = getMentionMenu();
            if (menu) menu.style.display = 'none';
        }

        function handleGroupKeyDown(e) {
            // 中文输入法组合中按 Enter 确认候选词：不发送、不触发 @ 选择
            if (e.isComposing || e.keyCode === 229) return;
            // @ 菜单打开时优先响应选择键
            if (mentionActive && mentionCandidates.length > 0) {
                if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionSel(1); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); moveMentionSel(-1); return; }
                if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); selectMention(); return; }
                if (e.key === 'Tab') { e.preventDefault(); selectMention(); return; }
                if (e.key === 'Escape') { e.preventDefault(); closeMentionMenu(); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                sendGroupMsg();
            }
        }

        async function sendGroupMsg() {
            const input = document.getElementById('publicMsgInput');
            if (!currentGroupId) {
                showSnackbar('请先选择群聊');
                return;
            }
            // v099: 防重复提交——发送中忽略再次触发
            if (_groupSending) return;
            let text = readInputValue(input).trim();
            if (!text && !replyTarget) {
                showSnackbar('请输入内容');
                return;
            }
            if (text) {
                // v091: 自定义表情码（mjv064 emoji）先保护再 cleanHtml，避免标签被剥离
                text = sanitizeWithEmoji(text);
                if (!text) {
                    showSnackbar('消息包含不安全内容');
                    return;
                }
            }
            // v086: 发送中禁用按钮并显示加载动画
            setSendState('publicSendBtn', true);
            _groupSending = true;
            // v101: 统一 contents 协议——纯表情消息走 emoji 类型，其余走 text 类型
            const emojiUrl = emojiOnlyUrl(text);
            const payload = {
                sender: currentUser,
                contents: emojiUrl ? buildContents('emoji', { url: emojiUrl }) : buildContents('text', { content: text || '' }),
                msg_version: KERNEL_VERSION,
                is_system: false
            };
            if (replyTarget) {
                // v073 性能优化：Map O(1) 查找替代数组线性 find
                const replied = groupMessageById.get(replyTarget.id);
                if (replied) {
                    payload.reply_content = `回复 @${replyTarget.sender}：${getContentsPreview(parseMsgContents(replied))}`;
                } else {
                    payload.reply_content = `回复 @${replyTarget.sender}：${replyTarget.content}`;
                }
                payload.reply_to_id = replyTarget.id;
            }
            const result = await sendGroupMessageSecure(currentGroupId, payload);
            if (!result.success) {
                addGroupSystemMsg('发送失败: ' + (result.message || '未知错误'));
                _groupSending = false;
                setSendState('publicSendBtn', false);
                return;
            }
            // 已移除实时通道：直接用服务端返回的消息对象本地渲染，避免等轮询延迟
            if (result.message) {
                handleGroupMessage(currentGroupId, result.message);
            }
            clearInput(input);
            cancelGroupReply();
            _groupSending = false;
            setSendState('publicSendBtn', false); // 先恢复再重算（清空输入后按钮应为禁用态）
            toggleGroupSendBtn();
            activeAgent = null;
            const container = document.getElementById('publicMessages');
            if (container) {
                scrollToBottom(container);
                updateScrollButton(container);
                container._userScrolledUp = false;
            }
            closeMentionMenu();
            // v099: 群聊不接入智能体（原公聊 @智能体 流程 checkAgentMention/triggerAgentResponse 已删除）
        }

        // 清理单条消息在本地缓存的媒体残留（图片/表情字节缓存；缓存键为规范化公开直链）。
        // 视频/文件/语音不进入 Cache API 字节缓存，但统一尝试删除无害（未命中时静默忽略）。
        function purgeMsgMediaCache(msg) {
            if (!msg || typeof msg !== 'object') return;
            if (typeof removeCachedImage !== 'function') return;
            const c = (typeof parseMsgContents === 'function') ? parseMsgContents(msg) : null;
            if (c && c.url && (c.type === 'image' || c.type === 'emoji' || c.type === 'video' || c.type === 'file' || c.type === 'audio')) {
                removeCachedImage(c.url);
            }
            // 历史消息字段兜底（contents 协议前的 image_url）
            if (msg.image_url) removeCachedImage(msg.image_url);
        }

        function handleGroupDeleted(gid, msgId) {
            // 先取回被删消息对象，供清理其本地媒体缓存（删除后索引中不再可查）
            const removed = groupMessageById.get(msgId) || groupMessages.find(m => m.id === msgId);
            groupMessages = groupMessages.filter(m => m.id !== msgId);
            groupMessageById.delete(msgId);
            const rows = document.querySelectorAll('#publicMessages .msg-row');
            rows.forEach(row => { if (row.dataset.msgId === msgId) row.remove(); });
            // 本地缓存同步删除：媒体字节缓存 + 聊天记录加密缓存重建（否则离线缓存残留被删消息）
            if (removed) purgeMsgMediaCache(removed);
            scheduleMessageCacheSave();
            // 若删除的是群内最后一条非系统消息，摘要回退为群内现存最后一条消息
            updateGroupEntrySummary();
        }

        // v100.x: 群主清空群消息后的本地同步（清空列表与 DOM，插入后端返回的系统提示）
        function clearLocalGroupMessages(sysMsg) {
            // 同步清理本地缓存：先清媒体字节缓存，再重建聊天记录加密缓存
            groupMessages.forEach(function(m) { purgeMsgMediaCache(m); });
            groupMessages = [];
            groupMessageById.clear();
            const pm = document.getElementById('publicMessages');
            if (pm) pm.innerHTML = '';
            groupLastDateLabel = '';
            if (currentGroupId && groupUnreadByGid) delete groupUnreadByGid[currentGroupId];
            if (sysMsg && typeof handleGroupMessage === 'function') {
                try { handleGroupMessage(sysMsg); } catch (e) { /* ignore */ }
            }
            scheduleMessageCacheSave();
            // 重置群列表摘要与未读
            for (var i = 0; i < myGroups.length; i++) {
                if (myGroups[i].id === currentGroupId) {
                    myGroups[i].last_message = '';
                    myGroups[i].last_message_at = (sysMsg && sysMsg.created_at) || new Date().toISOString();
                    myGroups[i].has_unread = false;
                    break;
                }
            }
            if (typeof renderGroupList === 'function') renderGroupList();
            if (typeof updateBackBadge === 'function') updateBackBadge();
            if (typeof refreshGroupMessages === 'function') {
                try { refreshGroupMessages(); } catch (e) { /* ignore */ }
            }
        }

        // v099: 删除消息后回退群列表摘要
        function updateGroupEntrySummary() {
            for (var i = 0; i < myGroups.length; i++) {
                if (myGroups[i].id === currentGroupId) {
                    const nonSystem = groupMessages.filter(m => !m.is_system);
                    const last = nonSystem[nonSystem.length - 1];
                    if (last) {
                        myGroups[i].last_message_at = last.created_at;
                        myGroups[i].last_message = getContentsPreview(parseMsgContents(last));
                    }
                    break;
                }
            }
            renderGroupList();
        }

        function setGroupReplyTarget(msgId, sender, content) {
            replyTarget = { id: msgId, sender, content };
            const preview = document.getElementById('publicReplyPreview');
            document.getElementById('publicReplyContent').textContent = `回复 @${sender}：${content}`;
            preview.style.display = 'flex';
            document.getElementById('publicMsgInput').focus();
            toggleGroupSendBtn();
        }

        function cancelGroupReply() {
            replyTarget = null;
            document.getElementById('publicReplyPreview').style.display = 'none';
            toggleGroupSendBtn();
        }

        // v073 性能优化：长按状态与 document 级监听提升到模块级——
        // 多个聊天区（公聊/私聊）与多次登录共享同一套状态，document 监听只绑一次
        let _pressTimer = null;
        let _pressStartX = 0,
            _pressStartY = 0;
        let _pressMoved = false;
        let _pressTargetRow = null;
        let _pressChatType = 'public';
        let _documentPressBound = false;

        function _startPress(e, chatType) {
            const target = e.target;
            if (target.closest('.msg-input')) return;
            const bubble = target.closest('.bubble');
            if (!bubble) return;
            const row = bubble.closest('.msg-row');
            if (!row) return;
            const cx = e.touches ? e.touches[0].clientX : e.clientX;
            const cy = e.touches ? e.touches[0].clientY : e.clientY;
            _pressStartX = cx;
            _pressStartY = cy;
            _pressMoved = false;
            _pressTargetRow = row;
            _pressChatType = chatType;
            _pressTimer = setTimeout(() => {
                if (!_pressMoved && _pressTargetRow) {
                    showContextMenuForRow(_pressTargetRow, _pressStartX, _pressStartY, _pressChatType);
                    _pressTargetRow = null;
                }
            }, 500);
        }

        function _movePress(e) {
            if (!_pressTimer) return;
            const cx = e.touches ? e.touches[0].clientX : e.clientX;
            const cy = e.touches ? e.touches[0].clientY : e.clientY;
            if (Math.abs(cx - _pressStartX) > 10 || Math.abs(cy - _pressStartY) > 10) {
                _pressMoved = true;
                clearTimeout(_pressTimer);
                _pressTimer = null;
                _pressTargetRow = null;
            }
        }

        function _endPress() {
            if (_pressTimer) {
                clearTimeout(_pressTimer);
                _pressTimer = null;
                _pressTargetRow = null;
            }
        }

        function _bindDocumentPressListeners() {
            if (_documentPressBound) return;
            _documentPressBound = true;
            document.addEventListener('mousemove', _movePress);
            document.addEventListener('mouseup', _endPress);
        }

        function initMessageInteractions(messagesEl, chatType) {
            if (!messagesEl) return;
            // v102: 防止重复绑定——登录→登出→再登录会多次走到 init 路径，
            // 消息区元素常驻，不加守卫会累积 contextmenu/touch/mouse 监听器
            if (messagesEl.dataset.interactionsBound === '1') return;
            messagesEl.dataset.interactionsBound = '1';
            const isPublic = chatType === 'public';

            messagesEl.addEventListener('contextmenu', (e) => {
                const target = e.target;
                if (!e.target.closest('.msg-input')) {
                    e.preventDefault();
                    // 头像右键：弹出 @ / 拍一拍 菜单
                    const avatar = target.closest('.avatar');
                    if (avatar) {
                        const sender = avatar.dataset.sender || avatar.dataset.username;
                        if (sender && sender !== currentUser) {
                            showAvatarContextMenu(e, sender, chatType);
                        }
                        return;
                    }
                    const bubble = target.closest('.bubble');
                    if (bubble) {
                        const row = bubble.closest('.msg-row');
                        if (row) {
                            showContextMenuForRow(row, e.clientX, e.clientY, chatType);
                        }
                    }
                }
            });

            messagesEl.addEventListener('touchstart', (e) => {
                const target = e.target;
                if (target.tagName === 'IMG') {
                    e.preventDefault();
                }
            }, { passive: false });

            // v073 性能优化：长按状态提升为模块级，document 级 mousemove/mouseup
            // 监听全局只绑定一次（原实现每次登录重复绑定，造成监听器累积泄漏）
            _bindDocumentPressListeners();

            messagesEl.addEventListener('touchstart', (e) => {
                if (e.target.closest('.msg-input')) return;
                _startPress(e, chatType);
            }, { passive: true });
            messagesEl.addEventListener('touchmove', _movePress, { passive: true });
            messagesEl.addEventListener('touchend', _endPress);
            messagesEl.addEventListener('touchcancel', _endPress);
            messagesEl.addEventListener('mousedown', (e) => { if (e.button === 0) _startPress(e, chatType); });

            if (isPublic) {
                // 已移除 Realtime poke 广播：拍一拍只对本地/对方轮询感知
            }
        }

        function initInteractions() {
            initMessageInteractions(document.getElementById('publicMessages'), 'group');
        }

        function insertAtMention(sender) {
            if (!sender) return;
            const input = document.getElementById('publicMsgInput');
            if (!input) return;
            const atText = `@${sender} `;
            // Avoid duplicate consecutive @mentions
            if (getTextBeforeCursor(input).endsWith(atText)) return;
            insertTextAtCursor(input, atText);
            input.focus();
            autoResize(input);
            toggleGroupSendBtn();
        }

        function insertAtMentionPrivate(sender) {
            const input = document.getElementById('privateMsgInput');
            const atText = `@${sender} `;
            insertTextAtCursor(input, atText);
            input.focus();
            autoResize(input);
            togglePrivateSendBtn();
        }

        function pokeUser(sender) {
            if (sender === currentUser) return;
            const now = Date.now();
            if (now - lastPokeTime < 60000) {
                showSnackbar('拍一拍冷却中');
                return;
            }
            lastPokeTime = now;
            // v099: 公聊已删除——群聊内显示为本地系统提示
            if (currentGroupId && document.getElementById('publicPage').classList.contains('active')) {
                addGroupSystemMsg(`你拍了拍 ${sender}`);
                showSnackbar(`你拍了拍 ${sender}`);
            }
        }

        function addContextMenuItem(menu, label, iconSvg, action) {
            const item = document.createElement('div');
            item.className = 'menu-item';
            item.innerHTML = iconSvg + ' ' + label;
            item.addEventListener('click', (ev) => {
                ev.stopPropagation();
                closeContextMenu();
                action();
            });
            menu.appendChild(item);
        }

        function positionContextMenu(menu, x, y, fallbackW, fallbackH) {
            menu.classList.add('show');
            let left = x, top = y;
            const menuW = menu.offsetWidth || (fallbackW || 120);
            const menuH = menu.offsetHeight || (fallbackH || 80);
            if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
            if (top + menuH > window.innerHeight - 8) top = window.innerHeight - menuH - 8;
            if (left < 8) left = 8;
            if (top < 8) top = 8;
            menu.style.left = left + 'px';
            menu.style.top = top + 'px';
        }

        function copyToClipboardWithToast(text) {
            navigator.clipboard.writeText(text).then(() => showSnackbar('已复制'))
                .catch(() => {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    showSnackbar('已复制');
                });
        }

        function showAvatarContextMenu(e, sender, chatType) {
            e.preventDefault();
            e.stopPropagation();
            if (sender === currentUser) return;
            closeContextMenu();
            const menu = document.getElementById('msgContextMenu');
            menu.innerHTML = '';

            const atIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c5.07 0 9.22-3.77 9.86-8.67h-2.1c-.62 3.86-3.92 6.85-7.76 6.85-4.42 0-8-3.58-8-8s3.58-8 8-8c2.92 0 5.44 1.59 6.84 3.97L17.8 9H20V5l-1.69 1.69C16.82 4.01 14.52 3 12 3 7.03 3 3 7.03 3 12s4.03 9 9 9c3.69 0 6.83-2.17 8.25-5.29l1.89.65C20.38 20.52 16.46 23 12 23 5.93 23 1 18.07 1 12S5.93 1 12 1c3.75 0 7.06 1.87 9.02 4.74L23 3v6h-6l2.24-2.24C17.84 4.34 15.08 3 12 3z"/></svg>';
            const pokeIcon = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6.5 20.5L7 21h9l1.5-.5L20 17h-5l-1 2h-3l.5-4h4l1 2h1l-1-4-8-8-4 4 1 1.5V15l-3 3 .5 2.5zM14 3l-3 3h2v3h2V6h2l-3-3z" fill="currentColor"/></svg>';

            addContextMenuItem(menu, `@${sender}`, atIcon, () => {
                if (chatType === 'private') {
                    insertAtMentionPrivate(sender);
                } else {
                    insertAtMention(sender);
                }
            });
            addContextMenuItem(menu, '拍一拍', pokeIcon, () => pokeUser(sender));

            positionContextMenu(menu, e.clientX, e.clientY, 120, 80);
        }

        function initPrivateInteractions() {
            initMessageInteractions(document.getElementById('privateMessages'), 'private');
        }

        function showContextMenuForRow(row, x, y, type) {
            closeContextMenu();
            const menu = document.getElementById('msgContextMenu');
            menu.innerHTML = '';

            const msgId = row.dataset.msgId;
            const sender = row.dataset.msgSender;
            const senderUid = row.dataset.msgUid ? parseInt(row.dataset.msgUid, 10) : 0;
            const text = row.dataset.msgText || '';
            const msgType = row.dataset.msgType || 'text';
            const linkUrl = row.dataset.linkUrl || '';
            const imageUrl = row.dataset.imageUrl || '';
            const replyToId = row.dataset.replyToId || '';
            const replyContent = row.dataset.replyContent || '';

            contextTarget = { row, msgId, sender, text, type: msgType, linkUrl, imageUrl, replyToId, replyContent,
                chatType: type };

            // 消息归属一律以 uid 判断；群主与管理员可删除群内任意成员消息（v100.x）
            const isOwn = senderUid === currentUid;
            const canDelete = isOwn ||
                (type === 'group' && currentGroupInfo &&
                    (currentGroupInfo.my_role === 'owner' || currentGroupInfo.my_role === 'admin'));

            const icons = {
                save: '<svg viewBox="0 0 24 24"><path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2v9.67z"/></svg>',
                open: '<svg viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>',
                copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
                delete: '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
                reply: '<svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>',
                translate: '<svg viewBox="0 0 24 24"><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>'
            };

            const addDeleteItem = () => {
                addContextMenuItem(menu, '删除', icons.delete, () => {
                    showConfirm('确认删除', '确定要删除此消息吗？将会对所有人删除此消息。', () => {
                        contextDeleteMsg();
                    });
                });
            };

            // 回复预览文案：媒体消息归一为 [图片]/[语音] 等，文本消息取原文
            const replyContentText = (function() {
                if (msgType === 'voice') return '[语音]';
                if (msgType === 'image') return '[图片]';
                if (msgType === 'emoji') return '[表情]';
                if (msgType === 'link') return '[链接]';
                if (msgType === 'video') return '[视频]';
                if (msgType === 'file' && row && row.dataset.linkUrl) return '[文件] ' + fileNameFromUrl(row.dataset.linkUrl);
                return text || '消息';
            })();
            addContextMenuItem(menu, '回复', icons.reply, () => {
                if (type === 'group' || type === 'public') {
                    setGroupReplyTarget(msgId, sender, replyContentText);
                } else {
                    setPrivateReplyTarget(msgId, sender, replyContentText);
                }
            });

            const iconsExt = {
                play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
                download: '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>'
            };

            if (msgType === 'image') {
                addContextMenuItem(menu, '保存图片', icons.save, () => {
                    const url = imageUrl;
                    if (url) {
                        // 优先取缓存中已验证的图片字节（原始预签名 URL 可能已过期，而缓存键是永续的公开直链）；
                        // 未命中则拉取规范化后的公开直链，并校验响应确为图片，避免把 403/HTML 错误页存成损坏文件
                        const fetchPublic = () => fetch((typeof mediaUrlToPublic === 'function') ? mediaUrlToPublic(url) : url)
                            .then(r => r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status)));
                        const loadBlob = (typeof getCachedImageBlob === 'function')
                            ? getCachedImageBlob(url).then(b => b || fetchPublic())
                            : fetchPublic();
                        loadBlob.then(blob => {
                            if (!blob || !blob.size || (blob.type && blob.type.indexOf('image') !== 0)) {
                                showSnackbar('保存失败：图片数据异常');
                                return;
                            }
                            const urlName = decodeURIComponent((url.split('?')[0] || '').split('/').pop() || '');
                            const name = (urlName && urlName.includes('.')) ? urlName : 'image.jpg';
                            return saveBlobFile(name, blob);
                        }).then(r => {
                            if (r === 'cancelled') return;
                            if (r !== 'saved') showSnackbar('保存失败');
                        }).catch(() => showSnackbar('保存失败：图片加载失败，可能链接已失效'));
                    } else {
                        showSnackbar('图片地址无效');
                    }
                });
                if (canDelete) addDeleteItem();
            } else if (msgType === 'video') {
                if (linkUrl) {
                    addContextMenuItem(menu, '预览视频', iconsExt.play, () => openVideoPreview(linkUrl));
                    addContextMenuItem(menu, '下载视频', iconsExt.download, () => {
                        fetch((typeof mediaUrlToPublic === 'function') ? mediaUrlToPublic(linkUrl) : linkUrl)
                            .then(r => r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status)))
                            .then(blob => {
                                if (!blob || !blob.size) { showSnackbar('下载失败：文件数据异常'); return; }
                                const name = (linkUrl.split('?')[0] || '').split('/').pop() || 'video.mp4';
                                return saveBlobFile(name, blob);
                            }).then(r => {
                                if (r === 'cancelled') return;
                                if (r !== 'saved') showSnackbar('下载失败');
                            }).catch(() => showSnackbar('下载失败：链接可能已失效'));
                    });
                    addContextMenuItem(menu, '在新标签页打开', icons.open, () => {
                        // v073 安全修复：打开前统一过协议白名单，并使用 noopener
                        if (isSafeUrl(linkUrl)) window.open(linkUrl, '_blank', 'noopener');
                    });
                }
                if (canDelete) addDeleteItem();
            } else if (msgType === 'link' || msgType === 'file') {
                if (linkUrl) {
                    addContextMenuItem(menu, '打开链接', icons.open, () => {
                        // v073 安全修复：打开前统一过协议白名单，并使用 noopener
                        if (isSafeUrl(linkUrl)) window.open(linkUrl, '_blank', 'noopener');
                    });
                }
                const copyText = text || linkUrl;
                if (copyText) {
                    addContextMenuItem(menu, '复制文字', icons.copy, () => copyToClipboardWithToast(copyText));
                }
                if (canDelete) addDeleteItem();
            } else if (msgType === 'voice') {
                if (canDelete) addDeleteItem();
            } else if (msgType === 'text') {
                if (text) {
                    addContextMenuItem(menu, '复制文字', icons.copy, () => copyToClipboardWithToast(text));
                    // 翻译：仅当已配置 AI 模型时才显示
                    var _hasAiConfig = false;
                    try {
                        var _aiSettings = (typeof getAIModelSettings === 'function') ? (getAIModelSettings() || {}) : null;
                        _hasAiConfig = !!(_aiSettings && _aiSettings.apiKey);
                    } catch (_) {}
                    if (_hasAiConfig) {
                        addContextMenuItem(menu, '翻译', icons.translate, () => {
                            if (typeof CikaAI_doTranslate === 'function') {
                                CikaAI_doTranslate(row);
                            } else {
                                showSnackbar('AI 功能未加载');
                            }
                        });
                    }
                }
                if (canDelete) addDeleteItem();
            } else {
                if (canDelete) addDeleteItem();
            }

            if (menu.children.length === 0) return;

            positionContextMenu(menu, x, y, 160, 80);
        }

        function closeContextMenu() {
            const menu = document.getElementById('msgContextMenu');
            menu.classList.remove('show');
            menu.innerHTML = '';
        }

        // 全局 Esc：逐层关闭浮层（消息右键菜单 → 用户菜单 → 表情/特效浮层 → 语音模式 → 对话框）。
        // @ 提及菜单的 Esc 已在其内部处理（e.preventDefault），此处通过 defaultPrevented 跳过避免重复。
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            // 1. 消息右键菜单
            const ctxMenu = document.getElementById('msgContextMenu');
            if (ctxMenu && ctxMenu.classList.contains('show')) { closeContextMenu(); return; }
            // 2. 用户菜单（home/公聊/私聊）
            const menuOverlays = ['homeMenuOverlay', 'publicMenuOverlay', 'privateMenuOverlay'];
            for (const id of menuOverlays) {
                const o = document.getElementById(id);
                if (o && o.classList.contains('show')) { o.classList.remove('show'); return; }
            }
            // 3. 表情浮窗 / 文字特效子面板
            if (document.querySelector('.emoji-popup.show')) {
                if (typeof closeSubPanel === 'function') closeSubPanel();
                if (typeof privateCloseSubPanel === 'function') privateCloseSubPanel();
                return;
            }
            if (document.querySelector('.feature-panel .sub-panel.active')) {
                if (typeof closeSubPanel === 'function') closeSubPanel();
                if (typeof privateCloseSubPanel === 'function') privateCloseSubPanel();
                return;
            }
            // 4. 语音模式（按住说话）：Esc 退出语音模式恢复文本输入
            const voiceMode = document.querySelector('.voice-mode:not(.hidden)');
            if (voiceMode && typeof toggleVoiceMode === 'function') {
                toggleVoiceMode(voiceMode.id.startsWith('public') ? 'public' : 'private', true);
                return;
            }
            // 5. 对话框遮罩（从最上层向下找可见的，模拟遮罩点击关闭）
            const overlays = document.querySelectorAll('.dialog-overlay');
            for (let i = overlays.length - 1; i >= 0; i--) {
                const d = overlays[i];
                if (!d.classList.contains('hidden')) { d.click(); return; }
            }
        });

        async function contextDeleteMsg() {
            if (!contextTarget) { showSnackbar('无效操作'); return; }
            const target = contextTarget;
            contextTarget = null;
            const msgId = target.msgId;
            const chatType = target.chatType || 'public';
            if (!msgId) { showSnackbar('无效消息'); return; }
            const uuidRegex = /^[0-9a-f]{16,64}$/i; // S3 后端消息 id：十六进制时间戳+随机数
            if (!uuidRegex.test(msgId)) { showSnackbar('无效的消息ID'); return; }
            try {
                if (chatType === 'group' || chatType === 'public') {
                    const { data: delData, error: delError } = await s3.rpc('delete_group_message', {
                        p_group_id: currentGroupId,
                        p_msg_id: msgId,
                        p_uid: currentUid,
                        p_session_token: getSessionToken()
                    });
                    if (delError || (delData && delData.success === false)) {
                        showSnackbar('删除失败: ' + (delData?.message || delError?.message || ''));
                        return;
                    }
                    handleGroupDeleted(currentGroupId, msgId);
                    // v100.x: 管理员/群主删除他人消息时，后端落库系统提示并返回，前端立即渲染
                    if (delData && delData.system_message && typeof handleGroupMessage === 'function') {
                        try { handleGroupMessage(delData.system_message); } catch (e) { /* ignore */ }
                    }
                } else {
                    // Private messages: delete via S3 RPC (session id 用于定位消息对象)
                    var deleted = false;
                    var rpcFailMsg = null;
                    try {
                        var rpcResult = await s3.rpc('delete_private_message', {
                            p_session_id: privateSessionId,
                            p_msg_id: msgId,
                            p_uid: currentUid,
                            p_session_token: getSessionToken()
                        });
                        if (!rpcResult.error && rpcResult.data) {
                            var rpcData = rpcResult.data;
                            if (typeof rpcData === 'string') {
                                try { rpcData = JSON.parse(rpcData); } catch (e) { rpcData = {}; }
                            }
                            if (rpcData.success === true) {
                                deleted = true;
                            } else if (rpcData.success === false) {
                                showSnackbar(rpcData.message || '删除失败');
                                return;
                            }
                        } else if (rpcResult.error) {
                            rpcFailMsg = rpcResult.error.message || 'RPC error';
                        }
                    } catch (e) { rpcFailMsg = e.message || 'exception'; }
                    if (!deleted) {
                        if (rpcFailMsg) {
                            showSnackbar('删除失败: ' + rpcFailMsg);
                        } else {
                            showSnackbar('删除失败');
                        }
                        return;
                    }
                    // 已移除实时广播：对方列表由轮询感知
                    privateMessages = privateMessages.filter(m => m.id !== msgId);
                    var rows = document.querySelectorAll('#privateMessages .msg-row');
                    for (var i = 0; i < rows.length; i++) { if (rows[i].dataset.msgId === msgId) rows[i].remove(); }
                }
                showSnackbar('消息已删除');
            } catch (e) { showSnackbar('删除失败'); }
            closeContextMenu();
        }

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.msg-context-menu') && !e.target.closest('.bubble')) {
                closeContextMenu();
            }
        });

        // Tauri 环境下，外部链接交给系统默认浏览器打开；浏览器模式下保持默认行为
        document.addEventListener('click', (e) => {
            if (!window.__TAURI__ || !window.__TAURI__.opener || !window.__TAURI__.opener.openUrl) return;
            if (e.defaultPrevented) return;
            const anchor = e.target.closest ? e.target.closest('a[href]') : null;
            if (!anchor) return;
            const href = anchor.getAttribute('href');
            if (!href || !/^(https?:|mailto:|tel:)/i.test(href)) return;
            e.preventDefault();
            window.__TAURI__.opener.openUrl(href).catch((err) => {
                // 打开失败（如 ACL 未授权）时不再产生未处理的 Promise 拒绝
                if (window.__debugLog) window.__debugLog('外链打开失败: ' + href + ' -> ' + ((err && err.message) || err));
            });
        });

        // 统一更新侧边栏选中高亮：群聊列表、好友入口与私聊列表项互斥。
        // 依据当前激活页面（.page.active）判定：群聊页高亮对应群条目，私聊页高亮对应会话，其余清空。
        // 侧边栏当前页高亮（好友/群聊/私聊互斥；v099：好友入口已移至菜单，仅保留群聊/私聊/分组高亮）
        function updateSidebarHighlight() {
            var items = document.querySelectorAll('.home-page .private-list .list-item');
            for (var i = 0; i < items.length; i++) items[i].classList.remove('active');
            // v099: 群聊列表高亮互斥
            var groupItems = document.querySelectorAll('.home-page .group-list .group-item');
            for (var i = 0; i < groupItems.length; i++) groupItems[i].classList.remove('active');
            var activePage = document.querySelector('.page.active');
            if (activePage && activePage.id === 'publicPage' && currentGroupId) {
                var activeGroup = document.querySelector('.home-page .group-list .group-item[data-group="' + CSS.escape(currentGroupId) + '"]');
                if (activeGroup) activeGroup.classList.add('active');
                return;
            }
            // v099: 好友入口已移至菜单，friendsPage 无需侧边栏高亮
            if (activePage && activePage.id === 'privatePage' && privateSessionId) {
                var activeItem = document.querySelector('.home-page .private-list .list-item[data-session="' + privateSessionId + '"]');
                if (activeItem) activeItem.classList.add('active');
            }
        }

        // v100: 统一聊天列表渲染——群聊与私聊共用单个容器（#chatList），
        // 群聊项以 data-group 标记、私聊项以 data-session 标记，选中高亮互斥；
        // 群聊邀请入口行常驻列表顶部（有未处理邀请时由 group.js 控制显示）。
        function renderChatList() {
            var container = document.getElementById('chatList');
            if (!container) return;
            if (!currentUser) { container.innerHTML = '<div class="empty">登录后查看会话</div>'; return; }
            var groups = myGroups || [];
            var sessions = window.privateSessions || [];
            // 邀请行骨架（display:none，由 group.js updateInviteBadgeDom 控制显示）
            var html = '<div class="group-invite-row" id="groupInviteEntry" onclick="openGroupInvitesDialog()" style="display:none;">' +
                        '<div class="ginv-row-icon"><svg viewBox="0 0 24 24"><use href="#icon-friends" xlink:href="#icon-friends"/></svg></div>' +
                        '<div class="info">' +
                            '<div class="name">群聊邀请</div>' +
                            '<div class="last-msg" id="groupInviteSub">收到新的群聊邀请</div>' +
                        '</div>' +
                        '<div class="unread-badge" id="groupInviteBadge" style="display:none;">0</div>' +
                        '</div>';
            if (groups.length === 0 && sessions.length === 0) {
                container.innerHTML = html;
                if (window.groupModule && typeof window.groupModule.refreshInviteBadge === 'function') window.groupModule.refreshInviteBadge();
                return;
            }
            html += groups.map(groupItemHtml).join('');
            html += sessions.map(privateItemHtml).join('');
            container.innerHTML = html;
            updatePrivateListStatusDots();
            // v097: 好友会话标记（私聊列表「好友」徽标）
            if (window.friendModule && typeof window.friendModule.renderPrivateFriendBadges === 'function') window.friendModule.renderPrivateFriendBadges();
            if (window.groupModule && typeof window.groupModule.refreshInviteBadge === 'function') window.groupModule.refreshInviteBadge();
            // 恢复/清除选中态：由 updateSidebarHighlight 统一判定（群聊项与私聊项互斥）
            updateSidebarHighlight();
        }

        // 群聊列表项 HTML（data-group 标识，供选中高亮定位）
        function groupItemHtml(g) {
            var localUnread = groupUnreadByGid[g.id] || 0;
            var showUnread = localUnread || (g.has_unread && g.id !== currentGroupId) ? (localUnread || 1) : 0;
            var unreadBadge = showUnread > 0
                ? '<div class="unread-badge">' + (showUnread > 99 ? '99+' : showUnread) + '</div>'
                : '<div class="unread-badge hidden"></div>';
            var avUrl = g.avatar_url || '';
            var avStyle = avUrl ? ' style="background-image:url(\'' + escapeAttr(sanitizeAvatarUrl(avUrl)) + '\');background-size:cover;background-position:center;"' : '';
            var avText = avUrl ? '' : escapeHtml((g.name || '群').charAt(0).toUpperCase());
            var lastMsg = getMessagePreview(g.last_message) || '';
            var time = fmtListTime(g.last_message_at);
            // v102: 群列表项显示己方角色（群主/管理员）
            var roleTag = g.my_role === 'owner' ? '<span class="g-owner-tag">群主</span>'
                : g.my_role === 'admin' ? '<span class="g-admin-tag">管理员</span>' : '';
            var lastMsgHtml = lastMsg ? '<div class="last-msg">' + escapeHtml(lastMsg) + '</div>' : '';
            return '<div class="group-item" data-group="' + escapeAttr(g.id) + '" onclick="openGroupChat(\'' + escapeJsString(g.id) + '\')">' +
                        '<div class="av-wrap"><div class="av av-' + (hashStr(g.name || '群') % 8) + '"' + avStyle + '>' + avText + '</div></div>' +
                        '<div class="info">' +
                            '<div class="name">' + escapeHtml(g.name || '群聊') + roleTag + '</div>' +
                            lastMsgHtml +
                        '</div>' +
                        '<div class="time">' + time + '</div>' +
                        unreadBadge +
                    '</div>';
        }

        // 私聊会话项 HTML（data-session 标识，供选中高亮定位）
        function privateItemHtml(s) {
            // 对方以 uid 判断
            var u1 = s.user1_uid || 0, u2 = s.user2_uid || 0;
            var other = u1 === currentUid ? s.user2 : s.user1;
            var otherUid = u1 === currentUid ? u2 : u1;
            var idx = hashStr(other) % 8;
            var lastMsg = getMessagePreview(s.last_message) || '';
            var time = s.updated_at ? new Date(s.updated_at).toLocaleTimeString('zh-CN', { hour: '2-digit',
                minute: '2-digit' }) : '';
            var unread = privateUnreadCounts[s.id] || 0;
            var unreadBadge = unread > 0 ? '<div class="unread-badge">' + (unread > 99 ? '99+' : unread) + '</div>' : '<div class="unread-badge hidden"></div>';
            var avUrl = userAvatarCache[other];
            var avStyle = avUrl ? ' style="background-image:url(\'' + escapeAttr(sanitizeAvatarUrl(avUrl)) + '\');background-size:cover;background-position:center;"' : '';
            var avText = avUrl ? '' : escapeHtml(other.charAt(0).toUpperCase());
            var lastMsgHtml = lastMsg ? '<div class="last-msg">' + escapeHtml(lastMsg) + '</div>' : '';
            return '<div class="list-item" data-session="' + escapeAttr(s.id) + '" onclick="openPrivateChat(\'' + escapeJsString(s.id) + '\',\'' + escapeJsString(other) + '\',' + (otherUid || 0) + ')">' +
                        '<div class="av-wrap">' +
                            '<div class="av av-' + idx + '" data-username="' + escapeAttr(other) + '"' + avStyle + '>' + avText + '</div>' +
                            '<div class="av-status-dot" data-username="' + escapeAttr(other) + '"></div>' +
                        '</div>' +
                        '<div class="info">' +
                            '<div class="name">' + escapeHtml(other) + '</div>' +
                            lastMsgHtml +
                        '</div>' +
                        '<div class="time">' + time + '</div>' +
                        unreadBadge +
                    '</div>';
        }

        // v102: 列表渲染去抖——轮询周期内多个 RPC 完成后可能连续触发列表重建，
        // 将同一窗口内的重复调用合并为一次渲染，减少全量 innerHTML 重建与状态点查询。
        var _chatListRenderPending = false;
        function scheduleChatListRender() {
            if (_chatListRenderPending) return;
            _chatListRenderPending = true;
            setTimeout(function() {
                _chatListRenderPending = false;
                renderChatList();
            }, 0);
        }

        // 兼容旧调用点：渲染统一聊天列表（经去抖调度合并）
        function renderPrivateList() {
            scheduleChatListRender();
        }

        function updatePrivateListStatusDots() {
            var dots = document.querySelectorAll('.home-page .private-list .av-status-dot');
            for (var i = 0; i < dots.length; i++) {
                var dot = dots[i];
                var username = dot.getAttribute('data-username');
                if (!username) continue;
                var avatar = dot.previousElementSibling;
                // v089: 实时在线优先（绿点）；封禁/注销仍由服务端账号状态覆盖为灰
                (function(d, un, av) {
                    var apply = function() {
                        var isOnline = !!_onlineUsers[un];
                        d.className = isOnline ? 'av-status-dot online' : 'av-status-dot';
                        if (av) av.style.filter = '';
                    };
                    apply();
                    resolveUserStatus(un).then(function(status) {
                        if (status === 'banned' || status === 'deleted') {
                            d.className = 'av-status-dot banned';
                            if (av) av.style.filter = 'grayscale(1)';
                        } else {
                            apply();
                        }
                    });
                })(dot, username, avatar);
            }
        }

        // ===== v089: 实时回调（由 realtime.js 分发）=====

        // v099: 群聊顶栏成员数（原公聊在线人数回调保留函数名，real-time 网关调用无副作用）
        function __rtOnOnlineCount(count) {
            const el = document.getElementById('publicOnlineCount');
            if (!el) return;
            if (currentGroupInfo && currentGroupInfo.member_count) {
                el.textContent = currentGroupInfo.member_count + ' 人';
            } else {
                el.textContent = '';
            }
        }

        // 新连接初始化：当前在线用户列表
        function __rtOnOnlineList(users) {
            _onlineUsers = {};
            (users || []).forEach(function(u) {
                if (u && u.username) _onlineUsers[u.username] = true;
            });
            refreshRealtimePresenceUi();
            // v097: 好友在线状态实时同步
            if (window.friendModule && typeof window.friendModule.refreshPresenceUi === 'function') window.friendModule.refreshPresenceUi();
        }

        // 用户上下线
        function __rtOnPresence(uid, username, online) {
            if (!username) return;
            _onlineUsers[username] = !!online;
            refreshRealtimePresenceUi();
            // v097: 好友在线状态实时同步
            if (window.friendModule && typeof window.friendModule.refreshPresenceUi === 'function') window.friendModule.refreshPresenceUi();
        }

        function refreshRealtimePresenceUi() {
            updatePrivateListStatusDots();
            updatePrivateChatStatus();
        }

        // 对方已读回执：本端发出的消息标记已读
        function __rtOnRead(sessionId, uid, ts) {
            if (sessionId && sessionId !== privateSessionId) return;
            if (uid !== privateOtherUid) return;
            if (ts && (!privateOtherReadTs || ts > privateOtherReadTs)) privateOtherReadTs = ts;
            updatePrivateReadStatus(privateOtherUser);
        }

        async function openPrivateChat(sessionId, otherUser, otherUid) {
            privateSessionId = sessionId;
            privateOtherUser = otherUser;
            // 对方 uid：优先入参，其次从会话列表推导
            privateOtherUid = otherUid || 0;
            if (!privateOtherUid) {
                const sess = (window.privateSessions || []).find(x => x.id === sessionId);
                if (sess) {
                    privateOtherUid = sess.user1_uid === currentUid ? (sess.user2_uid || 0) : (sess.user1_uid || 0);
                }
            }
            // v089: 会话级已读时间戳（对方 read_by[privateOtherUid]），用于渲染时判断历史消息是否已被对方读过
            privateOtherReadTs = '';
            {
                const sess = (window.privateSessions || []).find(x => x.id === sessionId);
                if (sess && sess.read_by && privateOtherUid) {
                    privateOtherReadTs = sess.read_by[String(privateOtherUid)] || '';
                }
            }
            privateChatActive = true;
            privateHasMore = true;
            privateLoadingMore = false;
            document.getElementById('privateChatTitle').textContent = otherUser;
            // 已添加为好友的私聊永久不显示「临时私聊」提示；其余按用户是否关闭过该提示
            if (isFriendPrivateChat() || dismissedPrivacyBanners.has(otherUser)) {
                document.getElementById('privacyBanner').classList.add('hidden-banner');
            } else {
                document.getElementById('privacyBanner').classList.remove('hidden-banner');
            }
            switchPage('privatePage', true);
            updateSidebarHighlight();
            pushPageHistory('private');
            clearUnread(sessionId);
            await loadPrivateMessages(sessionId);
            if (privateMessages.length > 0) {
                markPrivateRead(sessionId, privateMessages[privateMessages.length - 1].created_at);
            } else {
                markPrivateRead(sessionId);
            }
            // v069: 进入会话即标记已读并回执发送方
            await markPrivateMessagesRead(sessionId);
            checkPrivacyBanner();
            updatePrivateChatStatus();
            // v097: 私聊页好友标记 + 快捷加好友入口显隐
            if (window.friendModule && typeof window.friendModule.updatePrivateFriendUi === 'function') window.friendModule.updatePrivateFriendUi();
            if (privateStatusInterval) clearInterval(privateStatusInterval);
            privateStatusInterval = setInterval(updatePrivateChatStatus, 10000);
            const privateMessagesEl = document.getElementById('privateMessages');
            setupScrollHandlers(privateMessagesEl);
            setTimeout(() => {
                scrollToBottom(privateMessagesEl);
                updateScrollButton(privateMessagesEl);
            }, 50);
        }

        // 是否与好友私聊：已添加为好友的私聊永久隐藏「临时私聊」提示
        function isFriendPrivateChat() {
            try {
                if (!window.friendModule || typeof window.friendModule.isFriend !== 'function') return false;
                return !!(window.friendModule.isFriend(privateOtherUid) ||
                    (privateOtherUser && window.friendModule.isFriend(privateOtherUser)));
            } catch (e) { return false; }
        }

        function checkPrivacyBanner() {
            if (isFriendPrivateChat() || dismissedPrivacyBanners.has(privateOtherUser)) {
                document.getElementById('privacyBanner').classList.add('hidden-banner');
                return;
            }
            const senders = new Set(privateMessages.map(m => m.sender));
            if (senders.size >= 2) {
                document.getElementById('privacyBanner').classList.add('hidden-banner');
            } else {
                document.getElementById('privacyBanner').classList.remove('hidden-banner');
            }
        }

        function incrementUnread(sessionId) {
            privateUnreadCounts[sessionId] = (privateUnreadCounts[sessionId] || 0) + 1;
            renderPrivateList();
            updateBackBadge();
        }

        function clearUnread(sessionId) {
            if (privateUnreadCounts[sessionId]) {
                delete privateUnreadCounts[sessionId];
                renderPrivateList();
                updateBackBadge();
            }
        }

        // v069: 标记私聊消息已读（RPC 落库）；v089: 落库成功后发实时回执（对方在线即时收到，离线由 read_by 兜底）
        async function markPrivateMessagesRead(sessionId) {
            if (!currentUser || !sessionId) return;
            try {
                const res = await s3.rpc('mark_private_messages_read', {
                    p_session_id: sessionId,
                    p_reader_uid: currentUid,
                    p_session_token: getSessionToken()
                });
                if (res && res.data && res.data.success === false) {
                    console.warn('[markPrivateMessagesRead]', res.data.message);
                    return;
                }
            } catch (e) {
                console.warn('[markPrivateMessagesRead] RPC failed:', e);
            }
            if (window.rt && typeof window.rt.sendRead === 'function') {
                window.rt.sendRead(sessionId, privateOtherUid, new Date().toISOString());
            }
        }

        // v069: 对方已读回执 —— 将本端发出的私聊消息状态更新为「已读」
        function updatePrivateReadStatus(reader) {
            if (!reader || reader !== privateOtherUser) return;
            const rows = document.querySelectorAll('#privateMessages .msg-row');
            rows.forEach(function(row) {
                const suid = row.dataset.msgUid ? parseInt(row.dataset.msgUid, 10) : 0;
                const isOwnRow = suid === currentUid;
                if (isOwnRow) {
                    const statusEl = row.querySelector('.read-status');
                    if (statusEl) {
                        statusEl.textContent = '已读';
                        statusEl.classList.remove('unread');
                        statusEl.classList.add('read');
                    }
                }
            });
        }

        function getGroupUnreadTotal() {
            return Object.values(groupUnreadByGid).reduce((a, b) => a + b, 0);
        }

        function getTotalUnread() {
            return Object.values(privateUnreadCounts).reduce((a, b) => a + b, 0) + getGroupUnreadTotal();
        }

        function updateBackBadge() {
            const total = getTotalUnread();
            const badges = document.querySelectorAll('.back-badge');
            badges.forEach(b => {
                if (total > 0) {
                    b.classList.remove('hidden');
                    b.textContent = total > 99 ? '99+' : total;
                } else {
                    b.classList.add('hidden');
                }
            });
        }

        // v099: 群聊未读红点总刷（替换原公聊总未读徽标；逐群红点在 renderGroupList 内渲染）
        function updatePublicBadge() {
            renderGroupList();
            updateBackBadge();
        }

        // ==================== v099 群聊核心 ====================

        // 本地已读时间戳（gid -> ts），避免对同一批消息重复 RPC
        let _groupReadAt = {};
        let _markGroupReadTimer = null;
        // 当前群消息增量轮询的 after_id
        let _groupMsgPollAfterId = null;

        // 群聊免打扰（per-group，本地持久化）
        function loadGroupMutes() {
            try { _muteGroups = JSON.parse(localStorage.getItem(LS_KEYS.GROUP_MUTED) || '{}') || {}; } catch (e) { _muteGroups = {}; }
        }
        function isGroupMuted(gid) { return !!_muteGroups[gid]; }

        // 群聊列表时间：今天显示时分，更早显示 月-日
        // v099: 标记当前群已读（本地时间戳 + 防抖同步服务端 mark_group_read）
        function markGroupRead(ts) {
            if (!currentGroupId) return;
            const gid = currentGroupId;
            if (!_groupReadAt[gid] || (ts && ts > _groupReadAt[gid])) {
                _groupReadAt[gid] = ts || new Date().toISOString();
            }
            if (groupUnreadByGid[gid]) {
                delete groupUnreadByGid[gid];
                renderGroupList();
                updateBackBadge();
            }
            clearTimeout(_markGroupReadTimer);
            _markGroupReadTimer = setTimeout(async function() {
                try {
                    await s3.rpc('mark_group_read', {
                        p_uid: currentUid,
                        p_session_token: getSessionToken(),
                        p_group_id: gid
                    });
                } catch (e) { /* 忽略网络抖动 */ }
            }, 500);
        }

        function clearGroupUnread(gid) {
            if (groupUnreadByGid[gid]) {
                delete groupUnreadByGid[gid];
                renderGroupList();
                updateBackBadge();
            }
        }

        // v099: 顶栏群名与成员数 + 群菜单同步
        function updateGroupHeader() {
            const title = document.getElementById('publicChatTitle');
            const count = document.getElementById('publicOnlineCount');
            if (title) title.textContent = (currentGroupInfo && currentGroupInfo.name) ? currentGroupInfo.name : '群聊';
            if (count) count.textContent = (currentGroupInfo && currentGroupInfo.member_count) ? currentGroupInfo.member_count + ' 人' : '';
            // v102: 群聊页顶栏显示己方角色（群主/管理员）
            const roleTag = document.getElementById('publicChatRoleTag');
            const myRole = (currentGroupInfo && currentGroupInfo.my_role) || '';
            if (roleTag) {
                if (myRole === 'owner') {
                    roleTag.textContent = '群主';
                    roleTag.className = 'g-owner-tag';
                    roleTag.style.display = '';
                } else if (myRole === 'admin') {
                    roleTag.textContent = '管理员';
                    roleTag.className = 'g-admin-tag';
                    roleTag.style.display = '';
                } else {
                    roleTag.style.display = 'none';
                }
            }
            if (typeof updatePublicMenu === 'function') updatePublicMenu();
        }

        // v100: 群聊列表渲染已并入统一聊天列表 renderChatList（群聊 + 私聊同容器）；
        // 保留函数名兼容旧调用点。无群聊时不渲染「暂无群聊」空态，避免列表顶部出现多余字样。
        function renderGroupList() {
            scheduleChatListRender();
        }

        // v099: 拉取群信息并刷新顶栏/菜单/列表缓存
        async function refreshGroupInfo(gid) {
            try {
                const { data, error } = await s3.rpc('get_group_info', {
                    p_uid: currentUid,
                    p_session_token: getSessionToken(),
                    p_group_id: gid
                });
                if (!error && data && data.success !== false && data.group) {
                    currentGroupInfo = data.group;
                    for (var i = 0; i < myGroups.length; i++) {
                        if (myGroups[i].id === gid) {
                            myGroups[i].name = data.group.name;
                            myGroups[i].avatar_url = data.group.avatar_url;
                            myGroups[i].member_count = data.group.member_count;
                            myGroups[i].my_role = data.group.my_role;
                            break;
                        }
                    }
                } else if (data && data.message === '请重新登录') {
                    return;
                }
            } catch (e) { /* ignore */ }
            updateGroupHeader();
        }

        // v099: 加载群历史消息（beforeId 缺省为首屏加载）
        async function loadGroupHistory(gid, beforeId) {
            if (groupLoadingMore) return;
            groupLoadingMore = true;
            try {
                const params = {
                    p_uid: currentUid,
                    p_session_token: getSessionToken(),
                    p_group_id: gid,
                    p_limit: 100
                };
                if (beforeId) params.p_before_id = beforeId;
                const { data, error } = await s3.rpc('get_group_messages', params);
                if (error || !data || data.success === false) {
                    if (data && data.message === '请重新登录') return;
                    showSnackbar((data && data.message) || '加载失败');
                    return;
                }
                const msgs = data.messages || [];
                const beforeScroll = beforeId ? (document.getElementById('publicMessages').scrollHeight) : 0;
                const prevLen = groupMessages.length;
                // v073 性能优化：DocumentFragment 批量插入，避免逐条 append 反复触发布局
                const frag = document.createDocumentFragment();
                // 服务端按 created_at 倒序返回；转正序渲染
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i]) handleGroupMessage(gid, msgs[i], true, frag);
                }
                document.getElementById('publicMessages').appendChild(frag);
                groupHasMore = msgs.length >= 100;
                if (beforeId) {
                    // 上翻加载：保持视口稳定
                    const c = document.getElementById('publicMessages');
                    if (c) c.scrollTop = c.scrollHeight - beforeScroll;
                } else if (prevLen === 0 && document.getElementById('publicPage').classList.contains('active')) {
                    // 首屏加载：贴底
                    const c = document.getElementById('publicMessages');
                    setTimeout(() => { scrollToBottom(c); updateScrollButton(c); }, 50);
                }
            } catch (e) {
                showSnackbar('加载失败');
            } finally {
                groupLoadingMore = false;
            }
        }

        // v099: 触顶加载更早历史（供 setupScrollHandlers 调用）
        function loadMoreGroupMessages() {
            if (!currentGroupId || groupLoadingMore || !groupHasMore) return;
            const first = groupMessages[0];
            if (!first) return;
            showGroupLoadMore(true);
            loadGroupHistory(currentGroupId, first.id).finally(function() { showGroupLoadMore(false); });
        }

        // v099: 打开群聊窗口
        async function openGroupChat(gid) {
            if (!gid) return;
            // 同群重复点击：恢复群聊页并滚动到底部
            // （v102 修复：从设置等其他页面点击当前群时，须先切回群聊页，否则页面停留在原页）
            if (currentGroupId === gid) {
                switchPage('publicPage', true);
                pushPageHistory('group');
                updateSidebarHighlight();
                clearGroupUnread(gid);
                const c = document.getElementById('publicMessages');
                if (c) scrollToBottom(c);
                return;
            }
            currentGroupId = gid;
            groupMessages = [];
            groupMessageById = new Map();
            groupLastDateLabel = '';
            groupHasMore = true;
            groupLoadingMore = false;
            _groupMsgPollAfterId = null;
            const c = document.getElementById('publicMessages');
            if (c) c.innerHTML = '';
            const input = document.getElementById('publicMsgInput');
            if (input) clearInput(input);
            cancelGroupReply();
            switchPage('publicPage', true);
            pushPageHistory('group');
            updateSidebarHighlight();
            clearGroupUnread(gid);
            await refreshGroupInfo(gid);
            await loadGroupHistory(gid);
            const lastMsg = groupMessages[groupMessages.length - 1];
            _groupMsgPollAfterId = lastMsg ? lastMsg.id : null;
            markGroupRead();
            const messagesEl = document.getElementById('publicMessages');
            setupScrollHandlers(messagesEl);
            setTimeout(() => { scrollToBottom(messagesEl); updateScrollButton(messagesEl); }, 60);
            startGroupMsgPolling();
        }

        // v099: 退出群聊窗口（返回首页/私聊时调用）
        function leaveGroupChat() {
            stopGroupMsgPolling();
            currentGroupId = null;
            currentGroupInfo = null;
            _groupMsgPollAfterId = null;
            cancelGroupReply();
            const c = document.getElementById('publicMessages');
            if (c) c.innerHTML = '';
            const input = document.getElementById('publicMsgInput');
            if (input) clearInput(input);
            updateGroupHeader();
            updateSidebarHighlight();
        }

        // v099: 当前群消息增量轮询（打开群时启动，退出时停止）
        async function pollCurrentGroupMessages() {
            if (!currentGroupId || !currentUser) return;
            const gid = currentGroupId;
            try {
                const params = {
                    p_uid: currentUid,
                    p_session_token: getSessionToken(),
                    p_group_id: gid,
                    p_limit: 50
                };
                if (_groupMsgPollAfterId) params.p_after_id = _groupMsgPollAfterId;
                const { data, error } = await s3.rpc('get_group_messages', params);
                if (error || !data || data.success === false) return;
                const msgs = data.messages || [];
                let lastId = _groupMsgPollAfterId;
                // 服务端按 created_at 倒序返回；按 id 升序逐个处理
                for (let i = msgs.length - 1; i >= 0; i--) {
                    const m = msgs[i];
                    if (!m || !m.id) continue;
                    handleGroupMessage(gid, m, false);
                    if (!lastId || m.id > lastId) lastId = m.id;
                }
                _groupMsgPollAfterId = lastId;
            } catch (e) { /* 忽略网络抖动 */ }
        }

        function startGroupMsgPolling() {
            stopGroupMsgPolling();
            groupPollTimer = setInterval(pollCurrentGroupMessages, 4000);
            pollCurrentGroupMessages();
        }
        function stopGroupMsgPolling() {
            if (groupPollTimer) { clearInterval(groupPollTimer); groupPollTimer = null; }
        }

        // v099: 群列表周期刷新（登录后启动）——所有群成员的列表同步更新 + 新消息通知
        async function pollMyGroups() {
            if (!currentUser) return;
            try {
                const { data, error } = await s3.rpc('get_my_groups', {
                    p_uid: currentUid,
                    p_session_token: getSessionToken()
                });
                if (error || !data || data.success === false) {
                    if (data && data.message === '请重新登录') return;
                    return;
                }
                const list = data.groups || [];
                const nowById = {};
                list.forEach(function(g) {
                    nowById[g.id] = g;
                    // 新消息检测：非当前群、非自己发送、last_message_at 变化
                    const prevAt = _lastGroupMsgAt[g.id];
                    if (prevAt !== undefined && prevAt !== g.last_message_at && g.last_message_at &&
                        Number(g.last_message_sender_uid || 0) !== currentUid && g.id !== currentGroupId) {
                        if (g.has_unread) {
                            groupUnreadByGid[g.id] = (groupUnreadByGid[g.id] || 0) + 1;
                            if (!isGroupMuted(g.id) && getPublicNotifyEnabled()) playNotifySound();
                        }
                    }
                    _lastGroupMsgAt[g.id] = g.last_message_at;
                });
                for (const gid of Object.keys(_lastGroupMsgAt)) {
                    if (!nowById[gid]) delete _lastGroupMsgAt[gid];
                }
                myGroups = list;
                renderGroupList();
                updateBackBadge();
                // v102: 同步当前群角色（被提升/降级为管理员或群主后立即刷新群菜单与页内角色标签）
                if (currentGroupId && currentGroupInfo) {
                    const curGroup = nowById[currentGroupId];
                    if (curGroup && curGroup.my_role && curGroup.my_role !== currentGroupInfo.my_role) {
                        currentGroupInfo.my_role = curGroup.my_role;
                        updateGroupHeader();
                    }
                }
                // 群邀请角标同步（group.js 提供）
                if (window.groupModule && typeof window.groupModule.refreshInviteBadge === 'function') {
                    window.groupModule.refreshInviteBadge();
                }
            } catch (e) { /* ignore */ }
        }

        function startGroupListPolling() {
            stopGroupListPolling();
            groupListTimer = setInterval(pollMyGroups, 10000);
            pollMyGroups();
        }
        function stopGroupListPolling() {
            if (groupListTimer) { clearInterval(groupListTimer); groupListTimer = null; }
        }

        // v099: 登录后初始化（mute 配置 + 群列表 + 邀请角标）
        function initGroupFeature() {
            loadGroupMutes();
            if (currentUser) {
                startGroupListPolling();
                if (window.groupModule && typeof window.groupModule.init === 'function') {
                    window.groupModule.init();
                }
            }
        }

        function showPrivateLoadMore(show) {
            showLoadMoreIndicator('privateMessages', 'privateLoadMoreIndicator', show);
        }

        // v073 性能优化：同 renderPublicMessage，container 支持 DocumentFragment
        function renderPrivateMessage(msg, container) {
            const c = container || document.getElementById('privateMessages');
            const isOwn = isMsgFromMe(msg);
            const date = new Date(msg.created_at);
            const dl = date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
            if (dl !== privateLastDateLabel) {
                privateLastDateLabel = dl;
                const s = document.createElement('div');
                s.className = 'date-divider';
                s.innerHTML = `<span>${dl}</span>`;
                c.appendChild(s);
            }
            const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            const ci = hashStr(msg.sender) % 8;

            const contents = parseMsgContents(msg);

            // 私聊回复：__RPL__ 前缀内嵌于 text 类型 contents 的 content 中（历史消息回退 msg.content）
            let replyHtml = '';
            let actualContent = '';
            let replyToId = '';
            let replyContentStr = '';
            let renderContents = contents;
            if (contents.type === 'text') {
                let textContent = String(contents.content || '');
                const rplMatch = textContent.match(/^__RPL__(.*?)__ENDRPL__/);
                if (rplMatch) {
                    try {
                        const rpl = JSON.parse(rplMatch[1]);
                        replyToId = rpl.i || '';
                        replyContentStr = rpl.c || '';
                        actualContent = textContent.substring(rplMatch[0].length);
                        const senderDisplay = rpl.s || '';
                        const rplPreviewStr = getContentsPreview(parseMsgContents({ contents: replyContentStr })) || replyContentStr;
                        replyHtml = `<div class="reply-preview-block" onclick="jumpToMessage('${escapeJsString(replyToId)}', 'private')">↩ <span class="reply-sender">${escapeHtml(senderDisplay)}</span><br><span class="reply-content">${escapeHtml(rplPreviewStr)}</span></div>`;
                        renderContents = { type: 'text', content: actualContent };
                    } catch (e) { actualContent = textContent; }
                } else {
                    actualContent = textContent;
                }
            } else {
                actualContent = contents.type === 'richtext' ? String(contents.content || '').replace(/<[^>]+>/g, '') : String(contents.content || contents.url || '');
            }

            // v101: 私聊系统消息（统一协议兜底）
            if (contents.type === 'system') {
                const d = document.createElement('div');
                d.className = 'system-msg';
                d.innerHTML = `<span>${escapeHtml(contents.content || '')}</span>`;
                c.appendChild(d);
                return;
            }

            let contentHtml = '';
            let fileIsImage = false;
            let linkMatch = null;
            let fileMatch = null;
            let imgMatch = null;
            let voiceMatch = null;
            const hasContents = !!msg.contents;
            if (hasContents) {
                contentHtml = renderContentsBubble(renderContents, msg);
            } else {
                // 历史消息回退：mjv064 / 🔗📎🎤 文本 / markdown 图片
                const mjMatch = actualContent.match(/<mjv064\s+([^>]*)>([\s\S]*?)<\/mjv064>/);
                if (mjMatch) {
                    const mjAttrs = _parseMjV064(mjMatch);
                    const mjType = mjAttrs.type;
                    const mjUrl = mjAttrs.url || '';
                    const mjFname = mjAttrs.name || '';
                    if (mjType === 'voice') {
                        // v069: mjv064 无 url 时回退到消息 audio_url 字段
                        contentHtml = buildVoiceBubbleHtml(mjUrl || msg.audio_url || '', parseInt(mjAttrs.dur) || msg.audio_dur || 0, '语音消息');
                    } else if (mjType === 'link') {
                        if (isSafeUrl(mjUrl)) {
                            contentHtml =
                                `<a href="${escapeAttr(mjUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--md-link);text-decoration:underline;">${escapeHtml(mjAttrs.text || mjUrl)}</a>`;
                        } else {
                            // v073 安全修复：未过协议白名单的链接回退为纯文本
                            contentHtml = escapeHtml(mjAttrs.text || mjUrl);
                        }
                    } else if (mjType === 'file') {
                        const fsize = mjAttrs.size || '';
                        if (isImageFile(mjFname)) {
                            contentHtml = _wrapImgWithLoader(mjUrl, `alt="${escapeAttr(mjFname)}" onclick="previewImage('${escapeJsString(mjUrl)}')"`, 'max-width:280px;max-height:280px;border-radius:12px;cursor:pointer;');
                            fileIsImage = true;
                        } else if (isVideoFile(mjFname)) {
                            contentHtml = buildVideoBubbleHtml(mjUrl, mjFname);
                        } else {
                            contentHtml = buildFileBubbleHtml(mjUrl, mjFname, fsize);
                        }
                    } else if (mjType === 'emoji') {
                        // v091: 自定义表情——CQ 码引用图片 URL，渲染为 80px 表情图
                        if (mjUrl) {
                            contentHtml = _wrapImgWithLoader(mjUrl, `alt="${escapeAttr(mjAttrs.name || '表情')}" onclick="previewImage('${escapeJsString(mjUrl)}')"`, 'width:80px;height:80px;object-fit:contain;border-radius:8px;cursor:pointer;');
                        } else {
                            contentHtml = escapeHtml(mjAttrs.name || '[表情]');
                        }
                    } else {
                        contentHtml = cleanHtml(actualContent);
                    }
                } else {
                    contentHtml = cleanHtml(actualContent);
                    linkMatch = actualContent.match(/🔗 (.*?) → (.*)/);
                    fileMatch = actualContent.match(/📎 (.*?) \(([\d.]+) KB\) → (.*)/);
                    imgMatch = actualContent.match(/!\[.*?\]\((.*?)\)/);
                    voiceMatch = actualContent.match(/🎤\s*语音\s*(\d+):(\d+)\s*→\s*(.*)/);
                    if (voiceMatch) {
                        const duration = parseInt(voiceMatch[1]) * 60 + parseInt(voiceMatch[2]);
                        const audioUrl = voiceMatch[3] && voiceMatch[3].startsWith('http') ? voiceMatch[3].trim() : null;
                        contentHtml = buildVoiceBubbleHtml(audioUrl, duration, '语音消息');
                    } else if (imgMatch) {
                        contentHtml = _wrapImgWithLoader(imgMatch[1], `onclick="previewImage('${escapeJsString(imgMatch[1])}')" alt="图片"`, 'max-width:180px;max-height:180px;border-radius:2px;display:block;');
                        const extraText = actualContent.replace(/!\[.*?\]\(.*?\)/, '').trim();
                        if (extraText) {
                            contentHtml += `<div style="margin-top:4px;">${escapeHtml(extraText)}</div>`;
                        }
                    } else if (linkMatch && isSafeUrl(linkMatch[2])) {
                        contentHtml =
                            `<a href="${escapeAttr(linkMatch[2])}" target="_blank" rel="noopener noreferrer" style="color:var(--md-link);text-decoration:underline;">${escapeHtml(linkMatch[1])}</a>`;
                    } else if (fileMatch && isSafeUrl(fileMatch[3])) {
                        if (isImageFile(fileMatch[1])) {
                            contentHtml = _wrapImgWithLoader(fileMatch[3], `alt="${escapeAttr(fileMatch[1])}" onclick="previewImage('${escapeJsString(fileMatch[3])}')"`, 'max-width:280px;max-height:280px;border-radius:12px;cursor:pointer;');
                            fileIsImage = true;
                        } else if (isVideoFile(fileMatch[1])) {
                            contentHtml = buildVideoBubbleHtml(fileMatch[3], fileMatch[1]);
                        } else {
                            contentHtml = buildFileBubbleHtml(fileMatch[3], fileMatch[1], fileMatch[2]);
                        }
                    } else {
                        contentHtml = contentHtml.replace(/@([\w\u4e00-\u9fa5]+)/g, '<b>@$1</b>');
                    }
                }
            }

            const msgType = contentsMsgType(renderContents);

            const row = document.createElement('div');
            row.className = `msg-row ${isOwn ? 'own' : ''}${container ? ' no-anim' : ''}`;
            row.dataset.msgId = msg.id;
            row.dataset.msgSender = msg.sender;
            row.dataset.msgUid = msg.sender_uid || '';
            row.dataset.msgText = actualContent || '';
            if (replyToId) {
                row.dataset.replyToId = replyToId;
                row.dataset.replyContent = replyContentStr;
            }
            row.dataset.msgType = msgType;
            if (hasContents) {
                if (renderContents.type === 'image' || renderContents.type === 'emoji') row.dataset.imageUrl = renderContents.url || '';
                if (renderContents.type === 'file' || renderContents.type === 'video' || msgType === 'link') {
                    let u = renderContents.url || '';
                    if (!u && msgType === 'link') {
                        const am = String(renderContents.content || '').match(/<a\s+href="([^"]+)"/);
                        if (am && isSafeUrl(am[1])) u = am[1];
                    }
                    row.dataset.linkUrl = u;
                }
            } else {
                if (voiceMatch) row.dataset.msgType = 'voice';
                else if (imgMatch) { row.dataset.msgType = 'image'; row.dataset.imageUrl = imgMatch[1] || ''; }
                else if (linkMatch && isSafeUrl(linkMatch[2])) { row.dataset.msgType = 'link'; row.dataset.linkUrl = linkMatch[2] || ''; }
                else if (fileMatch && isSafeUrl(fileMatch[3])) { row.dataset.msgType = fileIsImage ? 'image' : (isVideoFile(fileMatch[1]) ? 'video' : 'file'); row.dataset.linkUrl = fileMatch[3] || ''; if (fileIsImage) row.dataset.imageUrl = fileMatch[3] || ''; }
            }
            // v069: 自己发出的私聊消息显示已读/未读状态（v089: 会话级对方已读时间戳兜底离线场景）
            let readStatus = '';
            if (isOwn) {
                const otherRead = !!msg.read_at || (privateOtherReadTs && msg.created_at && msg.created_at <= privateOtherReadTs);
                readStatus = otherRead ? '<span class="read-status read">已读</span>' : '<span class="read-status unread">未读</span>';
            }
            // v097: 好友专属消息标记（对方为好友时在昵称旁显示「好友」徽标）
            let friendBadge = '';
            if (!isOwn && window.friendModule && typeof window.friendModule.friendBadgeHtml === 'function') {
                friendBadge = window.friendModule.friendBadgeHtml(msg.sender);
            }
            row.innerHTML = `
                <div class="avatar av-${ci}" data-username="${escapeAttr(msg.sender)}" onclick="showUserProfile('${escapeJsString(msg.sender)}')">${escapeHtml(msg.sender.charAt(0).toUpperCase())}</div>
                <div class="content">
                    <div class="meta"><span class="sender">${isOwn ? '我' : escapeHtml(msg.sender)}</span>${friendBadge}<span class="time">${time}</span></div>
                    <div class="bubble">${replyHtml}${contentHtml}</div>
                    ${readStatus}
                </div>
            `;
            if (userAvatarCache[msg.sender]) {
                const avEl = row.querySelector('.avatar');
                avEl.style.backgroundImage = `url(${userAvatarCache[msg.sender]})`;
                avEl.textContent = '';
            }
            // v071: 恢复已缓存译文（若有）
            if (typeof msg.translation === 'string' && msg.translation && typeof window.CikaAI_renderStoredTranslation === 'function') {
                window.CikaAI_renderStoredTranslation(row, msg.translation);
            }
            c.appendChild(row);
        }

        function addPrivateSystemMsg(text) {
            addSystemMsg(document.getElementById('privateMessages'), text);
        }

        function togglePrivateSendBtn() {
            const btn = document.getElementById('privateSendBtn');
            if (btn.classList.contains('sending')) return; // 发送中不干预
            const hasText = readInputValue(document.getElementById('privateMsgInput')).trim();
            const hasReply = !!privateReplyTarget;
            btn.disabled = !hasText && !hasReply;
        }

        function handlePrivateKeyDown(e) {
            // 中文输入法组合中按 Enter 确认候选词不发送
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                sendPrivateMsg();
            }
        }

        // 私聊消息本地追加/渲染/通知的统一流程（发送与附件、语音、链接共用）
        function appendPrivateMsgLocally(newMsg, withBannerCheck) {
            // 已移除 Realtime 广播：对方会话由轮询拉取
            privateMessages.push(newMsg);
            appendPrivateMsgCache(privateSessionId, newMsg);
            if (document.getElementById('privatePage').classList.contains('active')) {
                renderPrivateMessage(newMsg);
                if (withBannerCheck) checkPrivacyBanner();
                const container = document.getElementById('privateMessages');
                if (container) {
                    scrollToBottom(container);
                    updateScrollButton(container);
                    container._userScrolledUp = false;
                }
            }
            loadPrivateSessions();
        }

        async function sendPrivateMsg() {
            if (!privateSessionId || !privateChatActive) return;
            const input = document.getElementById('privateMsgInput');
            let text = readInputValue(input).trim();
            if (!text && !privateReplyTarget) return;
            // v091: 自定义表情码（mjv064 emoji）先保护再 cleanHtml，避免标签被剥离
            text = sanitizeWithEmoji(text || '');
            if (!text && !privateReplyTarget) { showSnackbar('消息包含不安全内容'); return; }
            // v086: 发送中禁用按钮并显示加载动画
            setSendState('privateSendBtn', true);

            let replyPrefix = '';
            if (privateReplyTarget) {
                const replyData = JSON.stringify({
                    i: privateReplyTarget.id,
                    s: privateReplyTarget.sender,
                    c: privateReplyTarget.content
                });
                replyPrefix = `__RPL__${replyData}__ENDRPL__`;
            }
            // v101: 统一 contents 协议——纯表情消息走 emoji 类型，其余走 text 类型（回复前缀内嵌于 text content）
            const fullContent = replyPrefix + text;
            const emojiUrl = privateReplyTarget ? '' : emojiOnlyUrl(fullContent);
            const contentsJson = emojiUrl ? buildContents('emoji', { url: emojiUrl }) : buildContents('text', { content: fullContent });

            const hasReply = privateMessages.some(m => !isMsgFromMe(m));
            if (!hasReply) {
                const myMsgCount = privateMessages.filter(m => isMsgFromMe(m)).length;
                if (myMsgCount >= 3) {
                    showSnackbar('对方暂未回复，请稍后再发送');
                    setSendState('privateSendBtn', false);
                    return;
                }
            }

            const payload = {
                session_id: privateSessionId,
                sender: currentUser,
                contents: contentsJson
            };
            let newMsg = null;
            let sendError = null;
            let blockedMsg = null;
            try {
                const { data: rpcData, error: rpcError } = await s3.rpc('send_private_message', {
                    p_session_id: privateSessionId,
                    p_sender_uid: currentUid,
                    p_contents: contentsJson,
                    p_session_token: getSessionToken()
                });
                if (!rpcError && rpcData && rpcData.success !== false && rpcData.message) {
                    newMsg = rpcData.message;
                } else if (rpcData && rpcData.success === false) {
                    blockedMsg = rpcData.message || '发送失败';
                } else if (rpcError) {
                    sendError = rpcError;
                }
            } catch (e) { sendError = e; }

            if (blockedMsg) {
                showSnackbar(blockedMsg);
                setSendState('privateSendBtn', false);
                return;
            }

            if (!newMsg && sendError) {
                showSnackbar('发送失败: ' + (sendError.message || '请重新登录'));
                setSendState('privateSendBtn', false);
                return;
            }

            appendPrivateMsgLocally(newMsg, true);
            clearInput(input);
            cancelPrivateReply();
            setSendState('privateSendBtn', false); // 先恢复再重算（清空输入后按钮应为禁用态）
            togglePrivateSendBtn();
        }

        function leavePrivateChat() {
            leavePrivateChatAnimated();
        }

        async function startPrivateChatFromProfile() {
            const username = document.getElementById('userProfileUsername').textContent;
            if (username === currentUser) { showSnackbar('不能和自己私聊'); return; }
            closeUserProfile();
            const sessionId = await createPrivateSession(username);
            if (sessionId) {
                await loadPrivateSessions();
                openPrivateChat(sessionId, username);
            }
        }

        // v097: 公开名片「添加好友」快捷入口
        async function addFriendFromProfile() {
            const username = document.getElementById('userProfileUsername').textContent;
            if (!username || username === currentUser) return;
            const modal = document.getElementById('userProfileModal');
            const chatBtn = document.getElementById('userProfileChatBtn');
            if (chatBtn && chatBtn.style.display === 'none' && document.getElementById('userProfileStatus').textContent === '已注销') {
                showSnackbar('该用户已注销');
                return;
            }
            closeUserProfile();
            if (window.friendModule && typeof window.friendModule.showAddFriendDialog === 'function') {
                // 已有 uid 缓存优先，否则按用户名解析
                const uidText = document.getElementById('userProfileUid').textContent;
                const uid = uidText && /^\d+$/.test(uidText) ? Number(uidText) : 0;
                window.friendModule.showAddFriendDialog(uid || username, username);
            }
        }

        function setPrivateReplyTarget(msgId, sender, content) {
            privateReplyTarget = { id: msgId, sender, content };
            const preview = document.getElementById('privateReplyPreview');
            const displayContent = getMjV064Preview(content) || content;
            document.getElementById('privateReplyContent').textContent = `回复 @${sender}：${displayContent}`;
            preview.style.display = 'flex';
            document.getElementById('privateMsgInput').focus();
            togglePrivateSendBtn();
        }

        function cancelPrivateReply() {
            privateReplyTarget = null;
            document.getElementById('privateReplyPreview').style.display = 'none';
            togglePrivateSendBtn();
        }

        async function showUserProfile(username) {
            if (!username) return;
            const modal = document.getElementById('userProfileModal');
            const avatarEl = document.getElementById('userProfileAvatar');

            avatarEl.className = 'profile-avatar';
            avatarEl.style.backgroundImage = '';
            avatarEl.textContent = '...';
            document.getElementById('userProfileUsername').textContent = '加载中';
            document.getElementById('userProfileUid').textContent = '加载中';
            document.getElementById('userProfileStatus').textContent = '加载中';
            document.getElementById('userProfileChatBtn').style.display = 'none';
            document.getElementById('userProfileViewBtn').style.display = 'none';
            // v097: 公开名片快捷「添加好友」按钮
            var profileAddFriendBtn = document.getElementById('userProfileAddFriendBtn');
            if (profileAddFriendBtn) profileAddFriendBtn.style.display = 'none';
            // v049: 管理员按钮可能不存在，需空值保护
            var banBtn = document.getElementById('userProfileBanBtn');
            if (banBtn) banBtn.style.display = 'none';
            var forceLogoutBtn = document.getElementById('userProfileForceLogoutBtn');
            if (forceLogoutBtn) forceLogoutBtn.style.display = 'none';
            var deleteBtn = document.getElementById('userProfileDeleteBtn');
            if (deleteBtn) deleteBtn.style.display = 'none';
            modal.classList.remove('hidden');

            function renderUserProfile(data) {
                const idx = hashStr(data.username) % 8;
                avatarEl.className = 'profile-avatar av-' + idx;
                fillUserAvatar(avatarEl, data.username, data.avatar_url);
                if (data.avatar_url) userAvatarCache[data.username] = data.avatar_url;
                document.getElementById('userProfileUsername').textContent = data.username;
                document.getElementById('userProfileUid').textContent = data.uid ? String(data.uid) : '-';
                let statusText = '正常';
                if (data.banned) statusText = '已封禁';
                document.getElementById('userProfileStatus').textContent = statusText;

                const chatBtn = document.getElementById('userProfileChatBtn');
                // 已在与该用户的私聊中时不显示「发起私聊」
                chatBtn.style.display = (data.username === currentUser || data.username === privateOtherUser) ? 'none' : 'block';
                document.getElementById('userProfileViewBtn').style.display = 'block';
                // v097: 非好友时显示「添加好友」（自己或已是好友都不显示）
                const addFriendBtn = document.getElementById('userProfileAddFriendBtn');
                if (addFriendBtn) {
                    const isF = data.username === currentUser || (window.friendModule && window.friendModule.isFriend(data.username));
                    addFriendBtn.style.display = isF ? 'none' : 'block';
                }
            }

            function renderDeletedUser(name) {
                const idx = hashStr(name) % 8;
                avatarEl.className = 'profile-avatar av-' + idx;
                fillUserAvatar(avatarEl, name, '');
                document.getElementById('userProfileUsername').textContent = name;
                document.getElementById('userProfileUid').textContent = '-';
                document.getElementById('userProfileStatus').textContent = '已注销';
                document.getElementById('userProfileChatBtn').style.display = 'none';
                document.getElementById('userProfileViewBtn').style.display = 'block';
            }

            try {
                let profileData = null;
                try {
                    const { data: rpcData, error: rpcError } = await s3.rpc('get_user_profile', { p_username: username });
                    if (!rpcError && rpcData && rpcData.success !== false) {
                        profileData = rpcData;
                    }
                } catch (e) { /* RPC not found, continue */ }

                if (profileData) {
                    renderUserProfile(profileData);
                } else {
                    renderDeletedUser(username);
                }
            } catch (e) {
                const idx = hashStr(username) % 8;
                avatarEl.className = 'profile-avatar av-' + idx;
                fillUserAvatar(avatarEl, username, '');
                document.getElementById('userProfileUsername').textContent = username;
                document.getElementById('userProfileUid').textContent = '-';
                document.getElementById('userProfileStatus').textContent = '未知';
                document.getElementById('userProfileChatBtn').style.display = 'none';
                document.getElementById('userProfileViewBtn').style.display = 'block';
                document.getElementById('userProfileBanBtn').style.display = 'none';
                document.getElementById('userProfileForceLogoutBtn').style.display = 'none';
                document.getElementById('userProfileDeleteBtn').style.display = 'none';
            }
        }

        function closeUserProfile() {
            document.getElementById('userProfileModal').classList.add('hidden');
        }

        /* Removed: showLoginHistory and closeLoginHistoryModal */
/* Removed: admin functions (banUserFromProfile, forceLogoutUser, adminDeleteUser, showAllUsers, closeAllUsersModal, simulateLogin, showStats, closeStatsModal) */

        function setAvatarStatusDot(dotEl, avatarEl, status) {
            if (!dotEl) return;
            dotEl.className = 'avatar-status-dot' + (status ? ' ' + status : '');
            if (avatarEl) {
                if (status === 'banned' || status === 'deleted') {
                    avatarEl.style.filter = 'grayscale(1)';
                } else {
                    avatarEl.style.filter = '';
                }
            }
        }

        // 当前登录用户的圆点仅反映服务端账号状态（封禁/注销）；在线状态已随 Realtime 移除
        async function applyCurrentUserStatus(dotEl, avatarEl) {
            try {
                const { data: rpcData } = await s3.rpc('get_user_profile', { p_uid: currentUid, p_username: currentUser });
                if (rpcData && rpcData.success !== false && rpcData.banned) {
                    setAvatarStatusDot(dotEl, avatarEl, 'banned');
                } else {
                    setAvatarStatusDot(dotEl, avatarEl, '');
                }
            } catch (e) { /* RPC not found */ }
        }
