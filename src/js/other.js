/* KnockChat 其他：通用 UI 工具、导航、菜单、主题、应用初始化 */

        let confirmCallback = null;
        function escapeHtml(t) { if (t == null) return ''; const d = document.createElement('div');
            d.textContent = String(t); return d.innerHTML; }

        function escapeAttr(t) { if (t == null) return ''; return String(t).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;'); }

        // 用于内联 onclick="fn('...')" 的 JS 字符串上下文转义。
        // 注意：HTML 实体（如 &#39;）在 JS 执行前会被浏览器解码为 '，会提前闭合 JS 字符串，
        // 因此不能复用 escapeAttr（只适用于 HTML 属性值上下文）。此处先做 JS 转义再转义 & 防实体注入。
        function escapeJsString(t) { if (t == null) return ''; return String(t).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/&/g, '&amp;'); }

        // ============ mjv064 消息协议（对齐 MJChat v1.6.1） ============
        // 封装一段 mjv064 标签：<mjv064 type="file" name="..." size="..." url="...">fallback</mjv064>
        function _wrapMjV064(type, attrs, fallbackText) {
            var parts = ['type="' + type + '"'];
            for (var k in attrs) {
                if (attrs.hasOwnProperty(k)) {
                    parts.push(k + '="' + escapeHtml(String(attrs[k])) + '"');
                }
            }
            return '<mjv064 ' + parts.join(' ') + '>' + (fallbackText || '') + '</mjv064>';
        }

        // 解析 mjv064 标签开头的属性（[1] 为属性串，[2] 为标签内容）
        // 属性值写入时经 escapeHtml 转义，解析时需还原（&amp; → & 等），
        // 否则预签名 URL 里的 & 会变成字面 &amp;，导致签名参数错乱、图片/文件加载 403。
        function _decodeMjV064Value(s) {
            if (s == null) return '';
            const d = document.createElement('div');
            d.innerHTML = String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return d.textContent;
        }
        function _parseMjV064(matchResult) {
            var attrs = {};
            if (!matchResult) return attrs;
            matchResult[1].replace(/(\w+)="([^"]*)"/g, function(m, k, v) { attrs[k] = _decodeMjV064Value(v); });
            return attrs;
        }

        // 取 mjv064 消息的会话/回复预览文案（非 mjv064 返回空串）
        function getMjV064Preview(text) {
            if (!text) return '';
            var m = String(text).match(/<mjv064\s+([^>]*)>/);
            if (!m) return '';
            var a = _parseMjV064(m);
            if (a.type === 'voice') return '[语音]';
            // v089: 链接预览不再拼接 url/text，避免侧边栏/回复预览暴露完整链接
            if (a.type === 'link') return '[链接]';
            if (a.type === 'file') return '[文件] ' + (a.name || '');
            // v091: 自定义表情预览（CQ 码与图片分开，预览只显示占位文案）
            if (a.type === 'emoji') return '[表情]';
            return '[消息]';
        }

        // 旧 CQ 码（[CQ:type,param=value,...]）替换为版本升级提示
        function _replaceCQCodes(text) {
            if (!text) return text;
            var cqPattern = /\[CQ:[\w]+(?:,[\w]+=[^\]]+)*\]/g;
            if (cqPattern.test(text)) {
                return text.replace(cqPattern, '<span style="color:var(--md-on-surface-variant);font-size:0.8rem;font-style:italic;">[当前版本不支持查看，请更新MJChat版本]</span>');
            }
            return text;
        }

        // 秒数 → mm:ss（语音消息时长多处共用）
        function formatDuration(seconds) {
            seconds = Math.max(0, Math.floor(Number(seconds) || 0));
            return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
        }

        // 生成语音气泡波形条（高度随机，渲染时调用）
        function buildVoiceWaves(count) {
            const n = count || 12;
            let bars = '';
            for (let i = 0; i < n; i++) {
                bars += `<div class="voice-wave" style="height:${Math.floor(Math.random() * 16 + 4)}px"></div>`;
            }
            return bars;
        }

        // 语音消息气泡 HTML（公聊/私聊共用；无 audio_url 时显示升级提示）
        function buildVoiceBubbleHtml(audioUrl, duration, noUrlText) {
            const durStr = formatDuration(duration);
            const cleanAudioUrl = mediaUrlToPublic(audioUrl);
            if (cleanAudioUrl) {
                return `<div class="voice-msg-wrap" data-audio="${escapeAttr(cleanAudioUrl)}" data-dur="${Number(duration) || 0}" onclick="toggleVoicePlay(this, event)"><button class="voice-play-btn">${ICON_PLAY}</button><div class="voice-waves">${buildVoiceWaves()}</div><span class="voice-dur">${durStr}</span></div>`;
            }
            return `<div class="voice-msg-wrap"><span class="voice-dur">${durStr}</span><span style="font-size:0.75rem;color:var(--md-on-surface-variant);margin-left:8px;">${escapeHtml(noUrlText || '请升级到最新版本播放')}</span></div>`;
        }

        // 填充用户头像元素：有 URL 用背景图，否则显示首字母
        function fillUserAvatar(avatarEl, user, avatarUrl) {
            if (!avatarEl || !user) return;
            const cleanUrl = mediaUrlToPublic(avatarUrl);
            if (cleanUrl) {
                avatarEl.style.backgroundImage = `url(${cleanUrl})`;
                avatarEl.textContent = '';
            } else {
                avatarEl.style.backgroundImage = '';
                avatarEl.textContent = user.charAt(0).toUpperCase();
            }
        }

        function isSafeUrl(url) {
            if (!url || typeof url !== 'string') return false;
            const u = url.trim();
            // 与 cleanHtml 的 href 白名单保持一致，并显式排除 javascript:
            if (!/^(https?:|mailto:|tel:|#|\/)/i.test(u)) return false;
            if (/^javascript:/i.test(u)) return false;
            return true;
        }

        function sanitizeAvatarUrl(url) {
            if (!url || typeof url !== 'string') return '';
            const u = mediaUrlToPublic(url);
            if (!/^https?:\/\//i.test(u)) return '';
            return u.replace(/['"\\]/g, '');
        }

        // 将（已过期/更换 AK 后失效的）预签名媒体链接还原为同源的公开直链：
        // 去掉 ?X-Amz-* 签名参数。桶为公共读，直链永久有效（已验证 GET 200），
        // 避免头像、背景、图片、文件因 7 天签名过期或旧 AK 失效而 403 无法加载。
        // 非预签名链接（已是公开直链）原样返回。
        function mediaUrlToPublic(url) {
            if (!url || typeof url !== 'string') return '';
            const u = url.trim();
            if (!/^https?:\/\//i.test(u)) return '';
            try {
                const parsed = new URL(u);
                if (/X-Amz-/i.test(parsed.search)) parsed.search = '';
                return parsed.toString();
            } catch (e) {
                return u.replace(/['"\\]/g, '');
            }
        }

        function getMessagePreview(text) {
            if (!text) return '';
            if (text.startsWith('__RPL__')) {
                const m = text.match(/^__RPL__.*?__ENDRPL__/);
                if (m) text = text.substring(m[0].length);
            }
            const mjPreview = getMjV064Preview(text);
            if (mjPreview) return mjPreview;
            // v089: 纯图片 markdown（![](...)）预览归一为 [图片]
            if (/^!\[[^\]]*\]\([^)]*\)/.test(text)) return '[图片]';
            if (text.startsWith('🎤 ')) return text.replace(/ → .*$/, '');
            if (text.startsWith('🔗 ')) return '[链接]';
            if (text.startsWith('📎 ')) {
                const m = text.match(/📎 (.*?) \(/);
                return m ? m[1] : text;
            }
            if (text.startsWith('🖼️ ')) return '[图片]';
            return text.length > 40 ? text.substring(0, 40) + '…' : text;
        }

        function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i);
                h |= 0; } return Math.abs(h); }

        function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 9); }

        function autoResize(el) { el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 100) + 'px'; }

        let snackbarTimer = null;

        function showSnackbar(msg) {
            const ex = document.querySelector('.snackbar');
            if (ex) ex.remove();
            if (snackbarTimer) clearTimeout(snackbarTimer);
            const s = document.createElement('div');
            s.className = 'snackbar';
            s.textContent = msg;
            document.body.appendChild(s);
            snackbarTimer = setTimeout(() => {
                s.style.opacity = '0';
                s.style.transition = 'opacity 0.3s';
                setTimeout(() => s.remove(), 300);
            }, 3000);
        }

        function showGlobalLoading(text, sub) {
            const el = document.getElementById('globalLoading');
            el.classList.remove('hidden');
            if (text) el.querySelector('.loading-text').textContent = text;
            if (sub) el.querySelector('.loading-sub').textContent = sub;
        }

        function hideGlobalLoading() {
            document.getElementById('globalLoading').classList.add('hidden');
        }

        function updateLoadingText(text, sub) {
            const el = document.getElementById('globalLoading');
            if (text) el.querySelector('.loading-text').textContent = text;
            if (sub) el.querySelector('.loading-sub').textContent = sub;
        }

        function showEl(id, msg) {
            const el = document.getElementById(id);
            el.textContent = msg;
            el.classList.add('show');
        }

        function hideEl(id) {
            document.getElementById(id).classList.remove('show');
        }

        function isScrolledToBottom(el) {
            if (!el) return true;
            const threshold = 20;
            return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
        }

        function scrollToBottom(el) {
            if (!el) return;
            el.scrollTop = el.scrollHeight;
            // v08x：贴底同时重置容器级滚动标志（公聊/私聊各自独立）
            el._userScrolledUp = false;
            el._atBottomNow = true;
        }

        function updateScrollButton(messagesContainer) {
            const btn = messagesContainer.querySelector('.scroll-to-bottom-btn');
            if (!btn) return;
            if (isScrolledToBottom(messagesContainer)) {
                btn.classList.remove('show');
            } else {
                btn.classList.add('show');
            }
        }

        function setupScrollHandlers(messagesContainer) {
            if (!messagesContainer) return;
            const oldBtn = messagesContainer.querySelector('.scroll-to-bottom-btn');
            if (oldBtn) oldBtn.remove();
            // 移除上一次绑定的滚动/手势监听器，避免反复进入聊天后监听器累积
            if (messagesContainer._scrollHandler) {
                messagesContainer.removeEventListener('scroll', messagesContainer._scrollHandler);
                messagesContainer._scrollHandler = null;
            }
            ['_wheelHandler', '_touchStartHandler', '_touchMoveHandler', '_keydownHandler'].forEach(function(k) {
                if (messagesContainer[k]) {
                    const evt = k === '_wheelHandler' ? 'wheel' : k === '_touchStartHandler' ? 'touchstart' : k === '_touchMoveHandler' ? 'touchmove' : 'keydown';
                    messagesContainer.removeEventListener(evt, messagesContainer[k]);
                    messagesContainer[k] = null;
                }
            });

            const btn = document.createElement('button');
            btn.className = 'scroll-to-bottom-btn';
            btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>';
            btn.title = '回到最新消息';
            btn.onclick = function(e) {
                e.stopPropagation();
                scrollToBottom(messagesContainer);
                messagesContainer._userScrolledUp = false;
                updateScrollButton(messagesContainer);
                setTimeout(() => updateScrollButton(messagesContainer), 100);
            };
            messagesContainer.appendChild(btn);

            let topLoadTimer = null;
            // v08x 滚动修复：
            // 1) 改用容器级标志（_userScrolledUp/_atBottomNow），公聊/私聊互不污染；
            // 2) 仅真实用户手势（滚轮/触摸/键盘翻页）才标记"用户已上翻"，
            //    程序化滚动与内容高度变化（如图片加载）不再误标，聊天记录才能持续自动贴底。
            let userGestureTimer = null;
            const markUserGesture = function() {
                messagesContainer._userGesture = true;
                clearTimeout(userGestureTimer);
                userGestureTimer = setTimeout(function() { messagesContainer._userGesture = false; }, 600);
            };
            const wheelHandler = function(e) {
                if (e.deltaY !== 0) markUserGesture();
            };
            const touchStartHandler = markUserGesture;
            const touchMoveHandler = markUserGesture;
            const keydownHandler = function(e) {
                if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].indexOf(e.key) !== -1) markUserGesture();
            };
            messagesContainer._wheelHandler = wheelHandler;
            messagesContainer._touchStartHandler = touchStartHandler;
            messagesContainer._touchMoveHandler = touchMoveHandler;
            messagesContainer._keydownHandler = keydownHandler;
            messagesContainer.addEventListener('wheel', wheelHandler, { passive: true });
            messagesContainer.addEventListener('touchstart', touchStartHandler, { passive: true });
            messagesContainer.addEventListener('touchmove', touchMoveHandler, { passive: true });
            messagesContainer.addEventListener('keydown', keydownHandler);

            const scrollHandler = function() {
                const atBottom = isScrolledToBottom(messagesContainer);
                messagesContainer._atBottomNow = atBottom;
                if (atBottom) {
                    messagesContainer._userScrolledUp = false;
                } else if (messagesContainer._userGesture) {
                    messagesContainer._userScrolledUp = true;
                }
                updateScrollButton(messagesContainer);
                if (messagesContainer.scrollTop <= 5) {
                    clearTimeout(topLoadTimer);
                    topLoadTimer = setTimeout(() => {
                        if (messagesContainer.id === 'publicMessages' && publicHasMore) {
                            loadMorePublicMessages();
                        } else if (messagesContainer.id === 'privateMessages' && privateHasMore && privateSessionId) {
                            loadMorePrivateMessages(privateSessionId);
                        }
                    }, 300);
                }
                clearTimeout(scrollTimeout);
                scrollTimeout = setTimeout(() => {
                    if (isScrolledToBottom(messagesContainer)) {
                        messagesContainer._userScrolledUp = false;
                        messagesContainer._atBottomNow = true;
                    }
                    updateScrollButton(messagesContainer);
                }, 500);
            };
            messagesContainer._scrollHandler = scrollHandler;
            messagesContainer.addEventListener('scroll', scrollHandler);

            setTimeout(() => {
                scrollToBottom(messagesContainer);
                updateScrollButton(messagesContainer);
            }, 100);
        }

        function cleanHtml(html) {
            if (!html) return '';
            // 旧 CQ 码先替换为升级提示（与 MJChat v1.6.1 一致）
            html = _replaceCQCodes(html);
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const body = doc.body;
            const allowedTags = ['b', 'i', 'u', 's', 'a', 'img', 'span', 'div', 'br', 'svg', 'path', 'audio', 'source',
                'button'
            ];
            const allowedAttrs = {
                'a': ['href', 'target', 'rel'],
                'img': ['src', 'alt', 'width', 'height'],
                'audio': ['src', 'controls'],
                'source': ['src', 'type'],
                'button': ['type']
            };

            function cleanNode(node) {
                if (node.nodeType === Node.TEXT_NODE) return node.cloneNode(true);
                if (node.nodeType !== Node.ELEMENT_NODE) return null;
                const tag = node.tagName.toLowerCase();
                if (!allowedTags.includes(tag)) return null;
                const newNode = document.createElement(tag);
                const allowed = allowedAttrs[tag] || [];
                for (const attr of allowed) {
                    if (node.hasAttribute(attr)) {
                        const val = node.getAttribute(attr);
                        // v073 安全修复：src/href 统一协议白名单（src 额外允许 data:image/ 与 blob:）
                        if ((attr === 'href' || attr === 'src') && !/^(https?:|data:image\/|blob:)/i.test(val)) continue;
                        if (attr === 'href' && !val.match(/^(https?:|mailto:|tel:|#|\/)/i)) continue;
                        newNode.setAttribute(attr, val);
                    }
                }
                for (const child of node.childNodes) {
                    const cleanChild = cleanNode(child);
                    if (cleanChild) newNode.appendChild(cleanChild);
                }
                return newNode;
            }
            let result = '';
            for (const child of body.childNodes) {
                const cleanChild = cleanNode(child);
                if (cleanChild) {
                    result += cleanChild.outerHTML || cleanChild.textContent || '';
                }
            }
            return result;
        }

        // v073 安全修复：用户名严格字符白名单（字母/数字/下划线/中文，2-15 位），
        // 禁止 / \ . 与任意控制字符 —— 防止用户名作为存储路径时造成路径穿越
        function isSafeUsername(username) {
            if (!username) return false;
            if (username.length < 2 || username.length > 15) return false;
            return /^[A-Za-z0-9_\u4e00-\u9fa5]{2,15}$/.test(username);
        }

        function showConfirm(title, message, callback) {
            document.getElementById('confirmTitle').textContent = title;
            document.getElementById('confirmMessage').textContent = message;
            confirmCallback = callback;
            document.getElementById('confirmOkBtn').onclick = function() {
                var cb = confirmCallback;
                document.getElementById('confirmDialog').classList.add('hidden');
                confirmCallback = null;
                if (cb) cb();
            };
            document.getElementById('confirmDialog').classList.remove('hidden');
        }

        function closeConfirmDialog() {
            document.getElementById('confirmDialog').classList.add('hidden');
            confirmCallback = null;
        }

        let pageHistory = ['home']; // default page
        let isNavigating = false;

        function pushPageHistory(page) {
            pageHistory.push(page);
            try {
                history.pushState({ page: page, mjchat_nav: true }, '', '#' + page);
            } catch (e) { /* ignore */ }
        }

        function popPageHistory() {
            if (pageHistory.length > 1) {
                pageHistory.pop();
                return pageHistory[pageHistory.length - 1];
            }
            return 'home';
        }

        function switchPage(targetId, forward) {
            if (isNavigating) return;
            isNavigating = true;
            // 切换页面时关闭 @ 提及菜单（避免返回公聊页后残留旧弹层）
            if (typeof closeMentionMenu === 'function') closeMentionMenu();
            const pages = document.querySelectorAll('.page');
            const targetPage = document.getElementById(targetId);
            if (!targetPage) { isNavigating = false; return; }
            pages.forEach(p => p.classList.remove('active'));
            targetPage.classList.add('active');
            isNavigating = false;
        }

        function navigateTo(page) {
            if (page === 'home') {
                pushPageHistory('home');
                switchPage('homePage', true);
                updateSidebarHighlight();
                loadPrivateSessions();
                updatePublicEntry();
                updatePublicBadge();
            } else if (page === 'public') {
                pushPageHistory('public');
                switchPage('publicPage', true);
                updateSidebarHighlight();
                if (publicMessages.length > 0) {
                    const lastMsg = publicMessages[publicMessages.length - 1];
                    markPublicRead(lastMsg.created_at);
                } else {
                    markPublicRead();
                }
                publicUnread = 0;
                updatePublicBadge();
                updateBackBadge();
                document.getElementById('publicMessages').innerHTML = '';
                publicLastDateLabel = '';
                publicMessages.forEach(m => renderPublicMessage(m));
                const container = document.getElementById('publicMessages');
                setTimeout(() => {
                    scrollToBottom(container);
                    updateScrollButton(container);
                }, 50);
            } else if (page === 'search') {
                pushPageHistory('search');
                switchPage('searchPage', true);
                document.getElementById('searchInput').value = '';
                document.getElementById('searchResults').innerHTML = '<div class="empty">输入昵称开始搜索</div>';
            } else if (page === 'settings') {
                pushPageHistory('settings');
                switchPage('settingsPage', true);
                updateThemeLabel();
                refreshNotifySettingsUI();
                // v072: 刷新屏蔽词检测设置入口显示值
                updateBlockwordSettingsUI();
            } else if (page === 'about') {
                pushPageHistory('about');
                switchPage('aboutPage', true);
                // v088: 内核版本来源为 constants.js 的 KERNEL_VERSION 常量，更新版本只需维护该常量
                const mjchatVersion = document.getElementById('aboutMjchatVersion');
                if (mjchatVersion) mjchatVersion.textContent = '内核版本 v' + String(KERNEL_VERSION).padStart(3, '0');
            } else if (page === 'groupFiles') {
                pushPageHistory('groupFiles');
                switchPage('groupFilesPage', true);
                _loadGroupFiles();
            } else if (page === 'userDetail') {
                pushPageHistory('userDetail');
                switchPage('userDetailPage', true);
            } else if (page === 'editProfile') {
                pushPageHistory('editProfile');
                switchPage('editProfilePage', true);
            }
            updateBackBadge();
        }

        let isHandlingPopstate = false;
        function navigateBack() {
            // 图片裁剪器：全屏覆盖层，直接取消并回到编辑页
            const iePage = document.getElementById('imageEditorPage');
            if (iePage && iePage.classList.contains('active')) {
                cancelImageEdit();
                return;
            }
            // 预览多窗口：存在打开的预览窗口时，返回键先全部关闭（不影响聊天页面）
            if (typeof fviewWindows !== 'undefined' && fviewWindows.length > 0) {
                closeMediaViewer();
                return;
            }
            // 用户详情菜单弹层：导航时收起
            const udMenu = document.getElementById('udMenuOverlay');
            if (udMenu && udMenu.classList.contains('show')) {
                udMenu.classList.remove('show');
            }
            const currentPage = pageHistory[pageHistory.length - 1];
            if (privateChatActive) {
                leavePrivateChatAnimated();
                return;
            }
            if (currentPage !== 'home' && pageHistory.length > 1) {
                popPageHistory();
                const prevPage = pageHistory[pageHistory.length - 1];
                const targetId = prevPage === 'public' ? 'publicPage' :
                                 prevPage === 'search' ? 'searchPage' :
                                 prevPage === 'settings' ? 'settingsPage' :
                                 prevPage === 'about' ? 'aboutPage' :
                                 prevPage === 'groupFiles' ? 'groupFilesPage' :
                                 prevPage === 'userDetail' ? 'userDetailPage' :
                                 prevPage === 'editProfile' ? 'editProfilePage' : 'homePage';
                switchPage(targetId, false);
                updateBackBadge();
            } else {
                try { history.pushState({ page: 'home', mjchat_nav: true }, '', '#home'); } catch (e) {}
            }
        }

        function leavePrivateChatAnimated() {
            privateChatActive = false;
            if (privateStatusInterval) { clearInterval(privateStatusInterval); privateStatusInterval = null; }
            privateSessionId = null;
            privateOtherUser = '';
            privateMessages = [];
            document.getElementById('privateMessages').innerHTML = '<div class="system-msg"><span>加载中...</span></div>';
            const statusEl = document.getElementById('privateChatStatus');
            if (statusEl) { statusEl.textContent = ''; statusEl.className = 'private-status'; }
            switchPage('homePage', false);
            updateSidebarHighlight();
            if (pageHistory.length > 1) {
                popPageHistory();
            }
            loadPrivateSessions();
            updateBackBadge();
            updatePublicBadge();
        }

        // Resolve a user's status for display. Returns one of:
        // 'online' | 'banned' | 'deleted' | 'offline'.
        // Uses the SECURITY DEFINER `get_user_profile` RPC first (bypasses RLS) so
        // that RLS-restricted queries are not misread as "account deleted". Only
        // concludes 'deleted' when we are certain the user no longer exists.
        function toggleHomeMenu() {
            const overlay = document.getElementById('homeMenuOverlay');
            if (overlay.classList.contains('show')) {
                closeHomeMenu();
            } else {
                overlay.classList.add('show');
                updateHomeMenu();
            }
        }

        function closeHomeMenu(e) {
            if (e && e.target !== e.currentTarget) return;
            document.getElementById('homeMenuOverlay').classList.remove('show');
        }

        // 点击菜单以外的区域时自动关闭主页菜单
        document.addEventListener('click', (e) => {
            const overlay = document.getElementById('homeMenuOverlay');
            if (overlay.classList.contains('show') &&
                !e.target.closest('#homeMenuOverlay') &&
                !e.target.closest('#homeMenuBtn')) {
                closeHomeMenu();
            }
        });

        function updateHomeMenu() {
            const avatar = document.getElementById('homeMenuAvatar');
            const name = document.getElementById('homeMenuName');
            const dot = document.getElementById('homeAvatarDot');
            const idx = hashStr(currentUser) % 8;
            avatar.className = 'user-avatar av-' + idx;
            fillUserAvatar(avatar, currentUser, currentAvatarUrl);
            name.textContent = currentUser;
            // 头像圆点仅反映账号状态（封禁/注销）；在线状态已随 Realtime 移除
            applyCurrentUserStatus(dot, avatar);
        }

        function togglePublicMenu() {
            const overlay = document.getElementById('publicMenuOverlay');
            if (overlay.classList.contains('show')) {
                closePublicMenu();
            } else {
                overlay.classList.add('show');
                updatePublicMenu();
            }
        }

        function closePublicMenu(e) {
            if (e && e.target !== e.currentTarget) return;
            document.getElementById('publicMenuOverlay').classList.remove('show');
        }

        function updatePublicMenu() {
            const avatar = document.getElementById('publicMenuAvatar');
            const name = document.getElementById('publicMenuName');
            const dot = document.getElementById('publicAvatarDot');
            const idx = hashStr(currentUser) % 8;
            avatar.className = 'user-avatar av-' + idx;
            fillUserAvatar(avatar, currentUser, currentAvatarUrl);
            name.textContent = currentUser;
            // 头像圆点仅反映账号状态（封禁/注销）；在线状态已随 Realtime 移除
            applyCurrentUserStatus(dot, avatar);
            refreshNotifySettingsUI();
            // v053: 更新群聊免打扰标签
            var muteLabel = document.getElementById('publicMuteLabel');
            if (muteLabel) muteLabel.textContent = (typeof _mutePublic !== 'undefined' && _mutePublic) ? '取消群聊免打扰' : '群聊免打扰';
        }

        let privateBlockedStatus = false;

        function togglePrivateMenu() {
            const overlay = document.getElementById('privateMenuOverlay');
            if (overlay.classList.contains('show')) {
                closePrivateMenu();
            } else {
                overlay.classList.add('show');
                updatePrivateMenu();
            }
        }

        function closePrivateMenu(e) {
            if (e && e.target !== e.currentTarget) return;
            document.getElementById('privateMenuOverlay').classList.remove('show');
        }

        async function updatePrivateMenu() {
            const avatar = document.getElementById('privateMenuAvatar');
            const name = document.getElementById('privateMenuName');
            const dot = document.getElementById('privateAvatarDot');
            const idx = hashStr(privateOtherUser) % 8;
            avatar.className = 'user-avatar av-' + idx;
            fillUserAvatar(avatar, privateOtherUser, userAvatarCache[privateOtherUser]);
            name.textContent = privateOtherUser;
            const labelEl = document.getElementById('privateBlockLabel');
            // 头像圆点仅反映账号状态（封禁/注销），与私聊头部状态逻辑一致
            resolveUserStatus(privateOtherUser).then(status => setAvatarStatusDot(dot, avatar, status));
            try {
                const { data: rpcData, error: rpcError } = await s3.rpc('check_blocked', {
                    p_blocker_uid: currentUid,
                    p_target_uid: privateOtherUid || 0
                });
                if (!rpcError) {
                    privateBlockedStatus = rpcData === true;
                } else { privateBlockedStatus = false; }
            } catch (e) { privateBlockedStatus = false; }
            labelEl.textContent = privateBlockedStatus ? '移出黑名单' : '加入黑名单';
            refreshNotifySettingsUI();
            // v053: 更新私聊免打扰标签
            var muteLabel = document.getElementById('privateMuteLabel');
            if (muteLabel && privateSessionId) {
                muteLabel.textContent = (_mutePerPrivateSession[privateSessionId]) ? '取消消息免打扰' : '消息免打扰';
            }
        }

        function showBlocklistModal() {
            document.getElementById('blocklistModal').classList.remove('hidden');
            loadBlocklist();
        }

        function closeBlocklistModal() {
            document.getElementById('blocklistModal').classList.add('hidden');
        }

        function showProfileDialog() {
            const avatar = document.getElementById('profileDialogAvatar');
            const name = document.getElementById('profileDialogUsername');
            const uid = document.getElementById('profileDialogUid');
            const role = document.getElementById('profileDialogRole');
            const status = document.getElementById('profileDialogStatus');
            const idx = hashStr(currentUser) % 8;
            avatar.className = 'profile-avatar av-' + idx;
            fillUserAvatar(avatar, currentUser, currentAvatarUrl);
            name.textContent = currentUser;
            uid.textContent = currentUid ? String(currentUid) : '-';
            role.textContent = '普通用户';
            (async () => {
                try {
                    const { data: rpcData } = await s3.rpc('get_user_profile', { p_uid: currentUid, p_username: currentUser });
                    if (rpcData && rpcData.success !== false) {
                        status.textContent = rpcData.banned ? '已封禁' : '正常';
                        if (rpcData.role === 'admin') role.textContent = '管理员';
                        else if (rpcData.role === 'agent') role.textContent = '智能体';
                        // v090: 以服务端返回的 uid 为准（本地缓存可能过期）
                        if (rpcData.uid) uid.textContent = String(rpcData.uid);
                        return;
                    }
                } catch (e) { /* ignore */ }
                status.textContent = '正常';
            })();
            document.getElementById('profileDialog').classList.remove('hidden');
        }

        function closeProfileDialog() {
            document.getElementById('profileDialog').classList.add('hidden');
        }

        function loadTheme() {
            // 主题统一由 ThemeManager 管理（内置 dark/light + 自定义主题）
            // theme.js 加载时已自动恢复上次使用的主题；此处仅同步设置页 UI
            updateThemeLabel();
        }

        // 主题/字体均为本地设置，不同步到服务端（v1.x 起移除 saveThemeToServer）

        function updateThemeLabel() {
            const settingsValue = document.getElementById('settingsThemeValue');
            const themeColorItem = document.getElementById('settingsThemeColorItem');
            const customActive = !!(window.ThemeManager && ThemeManager.isCustomThemeActive());
            const current = (window.ThemeManager && ThemeManager.getActiveThemeId()) || document.documentElement.getAttribute('data-theme') || 'dark';
            const theme = window.ThemeManager ? ThemeManager.getTheme(current) : null;
            const name = theme ? theme.name : (current === 'dark' ? '暗黑模式' : '明亮模式');
            if (settingsValue) settingsValue.textContent = name;
            // 自定义主题生效时主题色被主题接管，主题色设置项不再显示
            if (themeColorItem) themeColorItem.style.display = customActive ? 'none' : '';
            const swatch = document.getElementById('themeColorSwatch');
            if (swatch) swatch.style.background = 'var(--md-primary)';
        }

        function loadCustomColor() {
            const color = (_userSettingsCache && _userSettingsCache.themeColor) || null;
            // 自定义主题生效时主题色被主题接管，不再叠加内联覆盖
            if (color && !(window.ThemeManager && ThemeManager.isCustomThemeActive())) {
                applyThemeColor(color);
            }
            const picker = document.getElementById('themeColorPicker');
            if (picker) {
                picker.value = color || '#4A9EFF';
            }
        }

        function setCustomColor(color) {
            // 自定义主题生效时主题色设置失效
            if (window.ThemeManager && ThemeManager.isCustomThemeActive()) {
                showSnackbar('自定义主题生效中，主题色不可调整');
                return;
            }
            // Update encrypted settings cache
            if (_userSettingsCache) {
                _userSettingsCache.themeColor = color;
                syncSettingsToEncryptedStore();
            }
            applyThemeColor(color);
        }

        function applyThemeColor(color) {
            const root = document.documentElement;
            root.style.setProperty('--md-primary', color);
            root.style.setProperty('--md-primary-container', darkenColor(color, 0.3));
        }

        function darkenColor(hex, factor) {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            const dr = Math.round(r * (1 - factor));
            const dg = Math.round(g * (1 - factor));
            const db = Math.round(b * (1 - factor));
            return '#' + [dr, dg, db].map(c => c.toString(16).padStart(2, '0')).join('');
        }

        // ============================================================
        // 主题选择对话框（设置页入口：预览 / 导入 / 删除）
        // ============================================================
        var _themeDialogOriginalId = null; // 打开对话框时正在使用的主题
        var _themeDialogPendingId = null;  // 当前预览中的主题

        function showThemeDialog() {
            const dialog = document.getElementById('themeDialog');
            if (!dialog) return;
            if (!window.ThemeManager) {
                showSnackbar('主题功能未初始化，请刷新页面重试');
                return;
            }
            _themeDialogOriginalId = ThemeManager.getActiveThemeId();
            _themeDialogPendingId = _themeDialogOriginalId;
            renderThemeList();
            dialog.classList.remove('hidden');
        }

        function closeThemeDialog() {
            const dialog = document.getElementById('themeDialog');
            if (!dialog) return;
            // 取消/关闭：回退到打开对话框前的主题（预览不持久化）
            if (_themeDialogPendingId && _themeDialogPendingId !== _themeDialogOriginalId) {
                ThemeManager.preview(_themeDialogOriginalId);
                updateThemeLabel();
            }
            _themeDialogPendingId = _themeDialogOriginalId;
            dialog.classList.add('hidden');
        }

        function renderThemeList() {
            const container = document.getElementById('themeList');
            if (!container) return;
            const themes = ThemeManager.list();
            container.innerHTML = '';
            themes.forEach(function(t) {
                const card = document.createElement('div');
                card.className = 'theme-card' + (t.id === _themeDialogPendingId ? ' selected' : '');
                card.onclick = function() { selectThemeCard(t.id); };
                card.appendChild(buildThemeSwatch(t));
                const info = document.createElement('div');
                info.className = 'theme-card-info';
                const nameEl = document.createElement('div');
                nameEl.className = 'theme-card-name';
                nameEl.textContent = t.name;
                const baseEl = document.createElement('div');
                baseEl.className = 'theme-card-base';
                baseEl.textContent = t.builtin
                    ? (t.base === 'dark' ? '内置 · 暗色' : '内置 · 亮色')
                    : ('自定义 · 基于' + (t.base === 'dark' ? '暗色' : '亮色') + (t.description ? ' · ' + t.description : ''));
                info.appendChild(nameEl);
                info.appendChild(baseEl);
                card.appendChild(info);
                if (!t.builtin) {
                    const del = document.createElement('button');
                    del.className = 'theme-card-delete';
                    del.title = '删除主题';
                    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
                    del.onclick = function(e) {
                        e.stopPropagation();
                        deleteCustomTheme(t.id);
                    };
                    card.appendChild(del);
                }
                container.appendChild(card);
            });
        }

        function buildThemeSwatch(t) {
            const swatch = document.createElement('div');
            swatch.className = 'theme-swatch';
            const cells = [
                { cls: 'bg',         val: t.preview.background },
                { cls: 'surface',    val: t.preview.surface },
                { cls: 'primary',    val: t.preview.primary },
                { cls: 'on-surface', val: t.preview.onSurface }
            ];
            cells.forEach(function(c) {
                const cell = document.createElement('div');
                cell.className = 'swatch-cell ' + c.cls;
                cell.style.setProperty('--sw-' + c.cls, c.val);
                swatch.appendChild(cell);
            });
            return swatch;
        }

        function selectThemeCard(id) {
            _themeDialogPendingId = id;
            ThemeManager.preview(id); // 实时预览，不持久化
            renderThemeList();
            updateThemeLabel();
        }

        function applyThemeDialog() {
            if (_themeDialogPendingId && _themeDialogPendingId !== ThemeManager.getActiveThemeId()) {
                ThemeManager.activate(_themeDialogPendingId);
                // 同步到加密本地设置（主题不再同步到服务端）
                const t = ThemeManager.getTheme(_themeDialogPendingId);
                if (_userSettingsCache) {
                    _userSettingsCache.themeId = _themeDialogPendingId;
                    _userSettingsCache.theme = t ? t.base : 'dark';
                    syncSettingsToEncryptedStore();
                }
            }
            // 标记已提交，避免 closeThemeDialog 回退预览
            _themeDialogPendingId = _themeDialogOriginalId;
            closeThemeDialog();
            updateThemeLabel();
        }

        function openThemeImport() {
            const input = document.getElementById('themeFileInput');
            if (input) input.click();
        }

        function handleThemeFileSelect(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            ThemeManager.importThemeFromFile(file).then(function(res) {
                event.target.value = '';
                if (!res.ok) {
                    showSnackbar('导入失败：' + res.error);
                    return;
                }
                // 导入成功后自动预览新主题
                _themeDialogPendingId = res.theme.id;
                ThemeManager.preview(res.theme.id);
                renderThemeList();
                updateThemeLabel();
                showSnackbar('主题导入成功：' + res.theme.name);
            });
        }

        function deleteCustomTheme(id) {
            const theme = ThemeManager.getTheme(id);
            showConfirm('删除主题', '确定删除主题「' + (theme ? theme.name : id) + '」吗？', function() {
                const wasActive = ThemeManager.getActiveThemeId() === id;
                ThemeManager.removeTheme(id);
                if (wasActive) {
                    _themeDialogPendingId = 'dark';
                } else if (_themeDialogPendingId === id) {
                    _themeDialogPendingId = ThemeManager.getActiveThemeId();
                }
                renderThemeList();
                updateThemeLabel();
            });
        }

        function downloadThemeTemplate() {
            const sample = ThemeManager.buildThemeFileSample();
            const blob = new Blob([JSON.stringify(sample, null, 4)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'cika-theme-template.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        // ============================================================
        // 字体选择对话框（应用级设置，独立于主题文件）
        // ============================================================
        var _fontDialogOriginalId = null; // 打开对话框时正在使用的字体
        var _fontDialogPendingId = null;  // 当前预览中的字体

        function showFontDialog() {
            const dialog = document.getElementById('fontDialog');
            if (!dialog) return;
            if (!window.FontManager || !window.TypographyManager) {
                showSnackbar('字体功能未初始化，请刷新页面重试');
                return;
            }
            _fontDialogOriginalId = FontManager.getActiveFontId();
            _fontDialogPendingId = _fontDialogOriginalId;
            _fontSizeDialogOriginalId = TypographyManager.getActiveScaleId();
            _fontSizeDialogPendingId = _fontSizeDialogOriginalId;
            _fontWeightDialogOriginalId = TypographyManager.getActiveWeightId();
            _fontWeightDialogPendingId = _fontWeightDialogOriginalId;
            renderFontList();
            renderFontSizeList();
            renderFontWeightList();
            updateFontPreview();
            dialog.classList.remove('hidden');
        }

        function closeFontDialog() {
            const dialog = document.getElementById('fontDialog');
            if (!dialog) return;
            // 取消/关闭：回退到打开对话框前的字体/字号/字重（预览不持久化）
            if (_fontDialogPendingId && _fontDialogPendingId !== _fontDialogOriginalId) {
                FontManager.preview(_fontDialogOriginalId);
            }
            if (_fontSizeDialogPendingId && _fontSizeDialogPendingId !== _fontSizeDialogOriginalId) {
                TypographyManager.previewScale(_fontSizeDialogOriginalId);
            }
            if (_fontWeightDialogPendingId && _fontWeightDialogPendingId !== _fontWeightDialogOriginalId) {
                TypographyManager.previewWeight(_fontWeightDialogOriginalId);
            }
            _fontDialogPendingId = _fontDialogOriginalId;
            _fontSizeDialogPendingId = _fontSizeDialogOriginalId;
            _fontWeightDialogPendingId = _fontWeightDialogOriginalId;
            dialog.classList.add('hidden');
            updateFontLabel();
        }

        function renderFontList() {
            const container = document.getElementById('fontList');
            if (!container) return;
            const fonts = FontManager.list().filter(function(f) { return f.id !== 'default'; });
            container.innerHTML = '';
            fonts.forEach(function(f) {
                const card = document.createElement('div');
                card.className = 'font-card-item' + (f.id === _fontDialogPendingId ? ' selected' : '');
                card.onclick = function() { selectFontCard(f.id); };

                const preview = document.createElement('div');
                preview.className = 'font-card-preview';
                preview.textContent = 'Aa';
                if (f.family) preview.style.fontFamily = f.family;
                card.appendChild(preview);

                const nameEl = document.createElement('div');
                nameEl.className = 'font-card-name';
                nameEl.textContent = f.name;
                card.appendChild(nameEl);

                container.appendChild(card);
            });
        }

        function selectFontCard(id) {
            _fontDialogPendingId = id;
            FontManager.preview(id); // 实时预览，不持久化
            renderFontList();
            updateFontPreview();
            updateFontLabel();
        }

        /** 更新对话框顶部预览区 */
        function updateFontPreview() {
            const area = document.getElementById('fontPreviewArea');
            if (!area) return;
            const font = FontManager.getFont(_fontDialogPendingId);
            const scale = TypographyManager.getScale(_fontSizeDialogPendingId);
            const weight = TypographyManager.getWeight(_fontWeightDialogPendingId);
            const family = (font && font.family) || '';
            var basePx = 14;
            const size = (scale && typeof scale.scale === 'number') ? Math.round(basePx * scale.scale) : basePx;
            const w = (weight && weight.medium) || 400;
            const els = area.querySelectorAll('.font-preview-primary, .font-preview-secondary, .font-preview-tertiary');
            els.forEach(function(el) {
                if (family) el.style.fontFamily = family;
                el.style.fontWeight = w;
            });
            const primary = area.querySelector('.font-preview-primary');
            if (primary) primary.style.fontSize = (size + 6) + 'px';
            const secondary = area.querySelector('.font-preview-secondary');
            if (secondary) secondary.style.fontSize = (size + 2) + 'px';
            const tertiary = area.querySelector('.font-preview-tertiary');
            if (tertiary) tertiary.style.fontSize = size + 'px';
        }

        function applyFontDialog() {
            if (_fontDialogPendingId && _fontDialogPendingId !== FontManager.getActiveFontId()) {
                FontManager.activate(_fontDialogPendingId);
                // 同步到加密本地设置（字体仅本地生效）
                if (_userSettingsCache) {
                    _userSettingsCache.fontId = _fontDialogPendingId;
                    syncSettingsToEncryptedStore();
                }
            }
            if (_fontSizeDialogPendingId && _fontSizeDialogPendingId !== TypographyManager.getActiveScaleId()) {
                TypographyManager.activateScale(_fontSizeDialogPendingId);
                // 同步到加密本地设置（字号仅本地生效）
                if (_userSettingsCache) {
                    _userSettingsCache.fontScaleId = _fontSizeDialogPendingId;
                    syncSettingsToEncryptedStore();
                }
            }
            if (_fontWeightDialogPendingId && _fontWeightDialogPendingId !== TypographyManager.getActiveWeightId()) {
                TypographyManager.activateWeight(_fontWeightDialogPendingId);
                // 同步到加密本地设置（字重仅本地生效）
                if (_userSettingsCache) {
                    _userSettingsCache.fontWeightId = _fontWeightDialogPendingId;
                    syncSettingsToEncryptedStore();
                }
            }
            // 标记已提交，避免 closeFontDialog 回退预览
            _fontDialogPendingId = _fontDialogOriginalId;
            _fontSizeDialogPendingId = _fontSizeDialogOriginalId;
            _fontWeightDialogPendingId = _fontWeightDialogOriginalId;
            closeFontDialog();
            updateFontLabel();
        }

        function updateFontLabel() {
            const settingsValue = document.getElementById('settingsFontValue');
            if (!window.FontManager || !window.TypographyManager) return;
            const font = FontManager.getFont(FontManager.getActiveFontId());
            const scale = TypographyManager.getScale(TypographyManager.getActiveScaleId());
            const weight = TypographyManager.getWeight(TypographyManager.getActiveWeightId());
            if (settingsValue) {
                const parts = [font ? font.name : '系统默认', scale ? scale.name : '', weight ? weight.name : ''];
                settingsValue.textContent = parts.filter(Boolean).join(' · ');
            }
        }

        // ============================================================
        // 字号选择列表（合并进「字体」对话框）
        // ============================================================
        var _fontSizeDialogOriginalId = null; // 打开对话框时正在使用的字号
        var _fontSizeDialogPendingId = null;  // 当前预览中的字号

        function renderFontSizeList() {
            const container = document.getElementById('fontSizeList');
            if (!container) return;
            const scales = TypographyManager.listScales().filter(function(s) { return s.id !== 'default'; });
            container.innerHTML = '';
            scales.forEach(function(s) {
                var basePx = 14; // 基准字号 14px
                var px = (typeof s.scale === 'number') ? Math.round(basePx * s.scale) : basePx;
                const chip = document.createElement('button');
                chip.className = 'font-chip' + (s.id === _fontSizeDialogPendingId ? ' selected' : '');
                chip.textContent = px + 'px';
                chip.title = s.name;
                chip.onclick = function() { selectFontSizeCard(s.id); };
                container.appendChild(chip);
            });
        }

        function selectFontSizeCard(id) {
            _fontSizeDialogPendingId = id;
            TypographyManager.previewScale(id); // 实时预览，不持久化
            renderFontSizeList();
            updateFontPreview();
            updateFontLabel();
        }

        // ============================================================
        // 字重选择列表（合并进「字体」对话框）
        // ============================================================
        var _fontWeightDialogOriginalId = null; // 打开对话框时正在使用的字重
        var _fontWeightDialogPendingId = null;  // 当前预览中的字重

        function renderFontWeightList() {
            const container = document.getElementById('fontWeightList');
            if (!container) return;
            const weights = TypographyManager.listWeights().filter(function(w) { return w.id !== 'default'; });
            container.innerHTML = '';
            weights.forEach(function(w) {
                const chip = document.createElement('button');
                chip.className = 'font-chip' + (w.id === _fontWeightDialogPendingId ? ' selected' : '');
                chip.textContent = w.name;
                chip.style.fontWeight = (typeof w.medium === 'number') ? String(w.medium) : '400';
                chip.onclick = function() { selectFontWeightCard(w.id); };
                container.appendChild(chip);
            });
        }

        function selectFontWeightCard(id) {
            _fontWeightDialogPendingId = id;
            TypographyManager.previewWeight(id); // 实时预览，不持久化
            renderFontWeightList();
            updateFontPreview();
            updateFontLabel();
        }

        // 左侧边栏拖动调整宽度：初始 20% 占屏，拖拽改为像素宽，min/max 由 CSS 钳制
        function initSidebarResizer() {
            var sidebar = document.querySelector('.chat-sidebar');
            var resizer = document.getElementById('sidebarResizer');
            if (!sidebar || !resizer) return;

            resizer.addEventListener('mousedown', function(e) {
                if (e.button !== 0) return;
                e.preventDefault();
                var startX = e.clientX;
                var startW = sidebar.getBoundingClientRect().width;
                document.body.classList.add('sidebar-resizing');
                resizer.classList.add('dragging');

                function onMove(ev) {
                    var w = startW + (ev.clientX - startX);
                    sidebar.style.width = w + 'px';
                }

                function onUp() {
                    document.body.classList.remove('sidebar-resizing');
                    resizer.classList.remove('dragging');
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                }

                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }

        function init() {
            // v047: safety timeout 保存在外部以便在 enterApp 后清除
            // 未完成初始化并且 loading 页仍可见时，50s 后才强制跳转登录页
            window.__mjchatSafetyTimeout = setTimeout(function() {
                var loadingEl = document.getElementById('globalLoading');
                if (loadingEl && !loadingEl.classList.contains('hidden')) {
                    if (_loginBlockedByCC) {
                        console.warn('Safety timeout: login_blocked=true, keeping loading page');
                        return;
                    }
                    console.warn('Safety timeout: forcing login page');
                    hideGlobalLoading();
                    if (!isEntered) showLogin();
                }
            }, 50000);

            loadTheme();
            loadCustomColor();
            updateFontLabel();
            initSidebarResizer();

            // 主题变更回调：同步设置页 UI，并清除主题色内联覆盖（避免覆盖自定义主题颜色）
            if (window.ThemeManager) {
                ThemeManager.onChange = function() {
                    if (ThemeManager.isCustomThemeActive()) {
                        document.documentElement.style.removeProperty('--md-primary');
                        document.documentElement.style.removeProperty('--md-primary-container');
                    }
                    updateThemeLabel();
                };
            }

            // 字体/字号/字重变更回调：同步设置页「字体」入口的当前值
            if (window.FontManager) {
                FontManager.onChange = function() {
                    updateFontLabel();
                };
            }
            if (window.TypographyManager) {
                TypographyManager.onChange = function() {
                    updateFontLabel();
                };
            }

            // v040: S3 桥接层（src/js/s3.js）已由 index.html 注入，凭证仅在 Tauri Rust 侧
            clientId = generateId();

            // v049: Initialize cloud control system
            initCloudControl();

            try {
                history.pushState({ page: 'home', mjchat_nav: true, initial: true }, '', '#home');
            } catch (e) {}

            window.addEventListener('popstate', function(e) {
                if (e.state && e.state.mjchat_nav) {
                    navigateBack();
                } else {
                    try { history.pushState({ page: 'home', mjchat_nav: true, initial: true }, '', '#home'); } catch (e2) {}
                    navigateBack();
                }
            });

            document.getElementById('privacyBanner').addEventListener('click', function() {
                if (privateOtherUser) {
                    dismissedPrivacyBanners.add(privateOtherUser);
                    // Update encrypted settings cache
                    if (_userSettingsCache) {
                        _userSettingsCache.dismissedPrivacyBanners = [...dismissedPrivacyBanners];
                        syncSettingsToEncryptedStore();
                    }
                    document.getElementById('privacyBanner').classList.add('hidden-banner');
                }
            });

            // v040: Fixed init flow - loading is hidden by default in HTML
            // Only show it for returning users who need session verification
            var savedSession = null;
            try {
                savedSession = localStorage.getItem(LS_KEYS.SESSION);
            } catch (e) { /* ignore */ }

            if (savedSession) {
                // Has a saved session - show loading and verify
                showGlobalLoading('登录中…', '正在验证身份');
                // Add a timeout fallback - if verification takes too long, show login
                var _sessionTimeout = setTimeout(function() {
                    var loadingEl = document.getElementById('globalLoading');
                    if (loadingEl && loadingEl.classList.contains('hidden')) return;
                    console.warn('Session verification timeout, showing login');
                    try { localStorage.removeItem(LS_KEYS.SESSION); } catch (e) {}
                    hideGlobalLoading();
                    showLogin();
                }, 10000);

                restoreSession(_sessionTimeout);
            } else {
                // No saved session - loading is already hidden, just show login
                hideGlobalLoading();
                showLogin();
            }
        }

        function restoreSession(timeoutId) {
            const saved = localStorage.getItem(LS_KEYS.SESSION);
            if (!saved) {
                if (timeoutId) clearTimeout(timeoutId);
                hideGlobalLoading();
                showLogin();
                return;
            }
            // v040: 会话恢复——直接调用后端校验（S3 桥接始终可用）
            try {
                const session = JSON.parse(saved);
                if (!session.username || !session.token) {
                    localStorage.removeItem(LS_KEYS.SESSION);
                    if (timeoutId) clearTimeout(timeoutId);
                    hideGlobalLoading();
                    showLogin();
                    return;
                }
                const verifyWithSecure = async (ip, region) => {
                    const { data, error } = await s3.rpc('verify_session_secure', {
                        p_uid: session.uid || 0, p_username: session.username, p_token: session.token,
                        p_ip: ip || 'unknown', p_region: region || ''
                    });
                    if (!error && data && data.success !== false) return data;
                    return null;
                };
                const verifyWithLegacy = async (ip, region) => {
                    const { data, error } = await s3.rpc('verify_session', {
                        p_uid: session.uid || 0, p_username: session.username, p_token: session.token,
                        p_ip: ip || 'unknown', p_region: region || ''
                    });
                    if (!error && data && data.success !== false) return data;
                    throw error || new Error('Session verify failed');
                };

                (async () => {
                    // v089: 会话恢复同样记录登录 IP 与地区（后端 get_client_ip 获取，带超时不阻塞会话校验）
                    var rIp = 'unknown';
                    var rRegion = '';
                    try {
                        var rLoc = await Promise.race([
                            getClientIP(),
                            new Promise(function(resolve) { setTimeout(function() { resolve({ ip: 'unknown', region: '' }); }, 3000); })
                        ]);
                        rIp = rLoc.ip || 'unknown';
                        rRegion = rLoc.region || '';
                    } catch (e) { rIp = 'unknown'; rRegion = ''; }
                    let userData = null;
                    try { userData = await verifyWithSecure(rIp, rRegion); } catch (e) { /* ignore */ }
                    if (!userData) {
                        try { userData = await verifyWithLegacy(rIp, rRegion); } catch (e) {
                            localStorage.removeItem(LS_KEYS.SESSION);
                            if (timeoutId) clearTimeout(timeoutId);
                            hideGlobalLoading();
                            showLogin();
                            return;
                        }
                    }
                    if (timeoutId) clearTimeout(timeoutId);
                    if (isEntered) return;
                    if (userData.banned) {
                        localStorage.removeItem(LS_KEYS.SESSION);
                        hideGlobalLoading();
                        showLogin();
                        showEl('loginError', '您已被封禁');
                        return;
                    }
                    currentUser = userData.username || session.username;
                    currentUid = userData.uid || session.uid || 0;
                    currentAvatarUrl = userData.avatar_url || '';
                    userAvatarCache[currentUser] = currentAvatarUrl;
                    recordLastLogin(currentUser);
                    if (session.pwhash) {
                        // v049: 用会话中保存的密码哈希重新加载加密设置
                        try {
                            await initUserSettings(session.pwhash, currentUser);
                            // 重新应用主题和颜色（init 中已调用过但当时 _userSettingsCache 为空）
                            loadTheme();
                            loadCustomColor();
                        } catch (e) {
                            console.warn('Session restore: initUserSettings failed:', e);
                        }
                    } else {
                        // v057 修复：旧版本保存的会话没有密码哈希，无法解密本地设置。
                        // 直接进入会导致本地设置无法加载/保存（加密密钥为空），
                        // 改为要求重新输入一次密码（保留会话，走快速登录），登录后会重新写入带 pwhash 的会话。
                        if (timeoutId) clearTimeout(timeoutId);
                        hideGlobalLoading();
                        showLogin();
                        showEl('loginError', '请重新登录以恢复本地设置');
                        return;
                    }
                    updateLoadingText('登录中…', '欢迎回来 ' + currentUser);
                    authorizeEnterApp();
                    enterApp();
                    // v089: 会话恢复登录后同样自动检查一次更新（静默模式）
                    checkUpdate(true);
                    if (userData.needs_relogin) {
                        setTimeout(() => {
                            showSnackbar('安全提示：请退出后重新登录以更新安全凭证');
                        }, 2000);
                    }
                })().catch(() => {
                    localStorage.removeItem(LS_KEYS.SESSION);
                    if (timeoutId) clearTimeout(timeoutId);
                    hideGlobalLoading();
                    showLogin();
                });
            } catch (e) {
                localStorage.removeItem(LS_KEYS.SESSION);
                if (timeoutId) clearTimeout(timeoutId);
                hideGlobalLoading();
                showLogin();
            }
        }

        // v089: 打开外部链接——Tauri 环境走系统默认浏览器（opener 插件，裸 window.open
        // 会被 WebView 拦截导致"点击无反应"），浏览器环境回退 window.open
        function openExternalUrl(url) {
            if (!url) return;
            if (window.__TAURI__ && window.__TAURI__.opener && window.__TAURI__.opener.openUrl) {
                window.__TAURI__.opener.openUrl(url).catch(function(err) {
                    if (window.__debugLog) window.__debugLog('外链打开失败: ' + url + ' -> ' + ((err && err.message) || err));
                });
                return;
            }
            window.open(url, '_blank', 'noopener');
        }

        // v089: 检查更新——从存储桶 upd/latest.json 读取最新版本元数据并展示下载入口。
        // silent=true 为登录时自动检查：无新版本或最新版本号与客户端相同 → 静默不打扰；
        // 有新版本 → 弹确认框提示下载。手动点击「检查更新」→ 内联展示完整结果。
        async function checkUpdate(silent) {
            const box = document.getElementById('aboutUpdateInfo');
            let data = null;
            try {
                const { data: rpcData, error } = await s3.rpc('get_update_info', {});
                if (!error && rpcData && rpcData.success !== false) data = rpcData;
            } catch (e) { data = null; }
            if (!data) {
                if (!silent && box) {
                    box.style.display = 'block';
                    box.innerHTML = '检查更新失败：服务异常';
                }
                return;
            }
            // v089: 最新版本号不高于客户端版本号时视为无更新（不展示更新提示）
            const hasUpdate = data.available && (data.version || 0) > (KERNEL_VERSION || 0);
            if (!hasUpdate) {
                if (silent) {
                    if (box) box.style.display = 'none';
                    return;
                }
                if (box) {
                    box.style.display = 'block';
                    box.innerHTML = '当前已是最新版本（内核 v' + String(KERNEL_VERSION).padStart(3, '0') + '）';
                }
                return;
            }
            const newTag = data.version_tag || ('v' + String(data.version || 0).padStart(3, '0'));
            const sizeText = data.size ? formatBytes(data.size) : '';
            if (silent) {
                // 登录时自动检查：弹确认框，确认后打开下载链接
                const msg = '最新版本：' + newTag +
                    (sizeText ? '，大小：' + sizeText : '') +
                    (data.notes ? '\n更新说明：' + data.notes : '') +
                    '\n\n是否立即下载安装包？';
                showConfirm('发现新版本 ' + newTag, msg, function() {
                    openExternalUrl(data.download_url);
                });
                return;
            }
            // 手动检查：内联展示详情 + 下载按钮
            const curTag = 'v' + String(KERNEL_VERSION).padStart(3, '0');
            const pubText = data.published_at ? String(data.published_at).replace('T', ' ').replace(/\..+?Z?$/, '').trim() : '';
            const lines = [
                '最新版本：' + newTag,
                '当前版本：内核 ' + curTag,
                '文件：' + (data.filename || '未知'),
                sizeText ? '大小：' + sizeText : '',
                pubText ? '发布时间：' + pubText : '',
                data.notes ? '更新说明：\n' + data.notes : ''
            ].filter(Boolean);
            let html = lines.map(escapeHtml).join('<br>');
            if (data.download_url) {
                html += '<br><button class="md-button primary" id="updateDownloadBtn">下载安装包</button>';
            }
            if (box) {
                box.style.display = 'block';
                box.innerHTML = html;
                const dl = document.getElementById('updateDownloadBtn');
                if (dl) dl.onclick = function() { openExternalUrl(data.download_url); };
            }
        }

        function formatBytes(n) {
            if (!n || n <= 0) return '';
            if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
            if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
            return n + ' B';
        }

        document.querySelectorAll('.dialog-overlay').forEach(el => {
            el.addEventListener('click', function(e) {
                if (e.target === this && !this.dataset.lockOverlay) {
                    this.classList.add('hidden');
                }
            });
        });

        // v040: Global error handler - only act during initial loading phase
        // This prevents non-critical runtime errors from disrupting the app
        window.addEventListener('error', function(e) {
            console.error('Global error:', e.error || e.message);
            try {
                // Only hide loading and show login if we're still on the auth/loading screen
                var loadingEl = document.getElementById('globalLoading');
                if (loadingEl && !loadingEl.classList.contains('hidden') && !isEntered) {
                    hideGlobalLoading();
                    showLogin();
                }
            } catch (err) { /* ignore */ }
        });

        // v040: Unhandled promise rejection handler - only act during loading phase
        window.addEventListener('unhandledrejection', function(e) {
            console.error('Unhandled promise rejection:', e.reason);
            try {
                var loadingEl = document.getElementById('globalLoading');
                if (loadingEl && !loadingEl.classList.contains('hidden') && !isEntered) {
                    hideGlobalLoading();
                    showLogin();
                }
            } catch (err) { /* ignore */ }
        });

        window.addEventListener('DOMContentLoaded', init);
