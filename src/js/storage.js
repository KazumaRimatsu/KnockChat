/* KnockChat 存储与加密：SHA-256 加密、用户加密配置存取、未读/会话状态持久化 */

        function getUnreadState() {
            // Read from encrypted settings cache
            if (_userSettingsCache && _userSettingsCache.unread) {
                return _userSettingsCache.unread;
            }
            return { publicLastRead: null, privateLastRead: {} };
        }
        // v058: 上次登录时间（mjchat_last_login_time），作为未读计数的兜底基准
        function getLastLoginTime() {
            try { return localStorage.getItem(LS_KEYS.LAST_LOGIN_TIME) || ''; } catch (e) { return ''; }
        }
        // v073 性能优化：未读状态高频变更（每条新消息到达）防抖合并落盘，
        // 避免对整份用户设置反复做 JSON.stringify + AES-GCM 加密 + localStorage 全量写入
        let _unreadSyncTimer = null;
        function saveUnreadState(state) {
            // Update encrypted settings cache
            if (_userSettingsCache) {
                _userSettingsCache.unread = state;
                if (_unreadSyncTimer) clearTimeout(_unreadSyncTimer);
                _unreadSyncTimer = setTimeout(function() {
                    _unreadSyncTimer = null;
                    syncSettingsToEncryptedStore();
                }, 800);
            }
        }
        function markPrivateRead(sessionId, timestamp) {
            const state = getUnreadState();
            state.privateLastRead[sessionId] = timestamp || new Date().toISOString();
            saveUnreadState(state);
        }
        function restorePrivateUnreadFromSessions() {
            const state = getUnreadState();
            privateUnreadCounts = {};
            if (window.privateSessions) {
                window.privateSessions.forEach(s => {
                    // 私聊免打扰开启的会话不恢复红点
                    if (_mutePerPrivateSession && _mutePerPrivateSession[s.id]) return;
                    const lastRead = state.privateLastRead[s.id];
                    // v058: 无 lastRead 时以 lastLogin 时间为兜底基准
                    const baseline = lastRead || getLastLoginTime() || null;
                    if (baseline && s.updated_at) {
                        if (new Date(s.updated_at) > new Date(baseline)) {
                            countUnreadPrivateMessages(s.id, baseline);
                        }
                    } else if (!baseline) {
                        if (s.last_message) {
                            countUnreadPrivateMessages(s.id, null);
                        }
                    }
                });
            }
        }
        async function hashPassword(password) {
            // SECURITY MODEL (Defense in Depth):
            // 1. Client side: SHA-256(password + salt) as a transport hash
            //    This is NOT the final stored hash. It prevents raw passwords
            //    from being sent over the network even though HTTPS is used.
            // 2. Server side: bcrypt(client_hash) is stored in the database.
            //    The server-side verify_login_secure() function applies bcrypt
            //    using PostgreSQL's crypt() + gen_salt('bf', 10).
            // Legacy users with plain SHA-256 hashes are auto-upgraded to
            // bcrypt on their next login (see verify_login_secure SQL).
            //
            // The SHA-256 here is intentional and secure because:
            // - The actual password storage is bcrypt (cost factor 10)
            // - SHA-256 is only a client-side pre-hash transport layer
            // - Changing this would invalidate all existing user passwords

            // Use crypto.subtle if available (modern browsers)
            if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
                var encoder = new TextEncoder();
                var data = encoder.encode(SALT + password + SALT);
                var hashBuffer = await crypto.subtle.digest('SHA-256', data);
                var hashArray = new Uint8Array(hashBuffer);
                var result = '';
                for (var i = 0; i < hashArray.length; i++) {
                    var hex = hashArray[i].toString(16);
                    result += hex.length === 1 ? '0' + hex : hex;
                }
                return result;
            }
            // Fallback: pure JS SHA-256 implementation for old WebViews
            return sha256Pure(SALT + password + SALT);
        }

        // ============================================
        // User Settings Encryption (AES-GCM)
        // Encrypts per-user local settings with password hash as key.
        // Supports multiple users on the same device.
        // ============================================

        // Convert hex string to Uint8Array bytes
        function hexToBytes(hex) {
            const bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < bytes.length; i++) {
                bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
            }
            return bytes;
        }

        // ============================================
        // AES 密钥派生（v073 安全升级）
        // 原实现：静态盐 SHA-256 的 hex 字节直接作 AES 密钥 —— 无 KDF，弱密码可被离线爆破。
        // 新实现：PBKDF2-HMAC-SHA256（10 万次迭代）+ 每用户随机盐（meta 存 localStorage）。
        // 存量数据一次性迁移：先用旧派生方式解密，成功即用新密钥重加密落盘。
        // ============================================
        const PBKDF2_ITERATIONS = 100000;
        const KEY_META_PREFIX = LS_KEYS.KEYMETA_PREFIX;

        function _keyMetaKey(username) {
            return KEY_META_PREFIX + (username || (currentUser || ''));
        }

        function loadKeyMeta(username) {
            try {
                const raw = localStorage.getItem(_keyMetaKey(username));
                if (raw) {
                    const m = JSON.parse(raw);
                    if (m && m.salt) return { salt: m.salt, iterations: m.iterations || PBKDF2_ITERATIONS };
                }
            } catch (e) {}
            return null;
        }

        function saveKeyMeta(username, meta) {
            try { localStorage.setItem(_keyMetaKey(username), JSON.stringify(meta)); } catch (e) {}
        }

        // 生成 16 字节随机盐（base64 字符串）
        function _generateKeySalt() {
            const salt = crypto.getRandomValues(new Uint8Array(16));
            return btoa(String.fromCharCode.apply(null, salt));
        }

        // PBKDF2 派生 AES-GCM 密钥（新格式，passwordHash 为客户端 SHA-256 预哈希串）
        async function _pbkdf2DeriveKey(passwordHash, saltB64, iterations) {
            const saltBytes = new Uint8Array(atob(saltB64).split('').map(function(c) { return c.charCodeAt(0); }));
            const baseKey = await crypto.subtle.importKey(
                'raw', new TextEncoder().encode(passwordHash), 'PBKDF2', false, ['deriveKey']
            );
            return await crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt: saltBytes, iterations: iterations || PBKDF2_ITERATIONS, hash: 'SHA-256' },
                baseKey,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        }

        // 旧派生方式（SHA-256 hex 字节直作 AES 密钥），仅用于存量数据一次性迁移
        async function _legacyDeriveKey(passwordHash) {
            const keyBytes = hexToBytes(passwordHash);
            return await crypto.subtle.importKey(
                'raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
            );
        }

        // Encrypt plaintext string with AES-GCM. Returns {iv, data} as base64 strings.
        async function encryptData(key, plaintext) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encoded = new TextEncoder().encode(plaintext);
            const ciphertext = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv }, key, encoded
            );
            return {
                iv: btoa(String.fromCharCode(...iv)),
                data: btoa(String.fromCharCode(...new Uint8Array(ciphertext)))
            };
        }

        // Decrypt AES-GCM encrypted data. Returns plaintext string.
        async function decryptData(key, ivBase64, dataBase64) {
            const iv = new Uint8Array(atob(ivBase64).split('').map(c => c.charCodeAt(0)));
            const ciphertext = new Uint8Array(atob(dataBase64).split('').map(c => c.charCodeAt(0)));
            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv }, key, ciphertext
            );
            return new TextDecoder().decode(decrypted);
        }

        // In-memory cache: holds decrypted settings for the current user
        let _userSettingsCache = null;
        let _encryptionKey = null;
        // v073：迁移期保留的旧派生密钥（仅当本次登录解密过旧格式加密数据时存在）
        let _legacyEncryptionKey = null;
        // AI 设置解密缓存（模型/翻译），登录时从加密存储加载
        let _aiSettingsCache = null;

        // Load the raw per-user configs object from localStorage
        function loadAllUserConfigs() {
            try {
                const raw = localStorage.getItem(LS_KEYS.USER_CONFIGS);
                return raw ? JSON.parse(raw) : {};
            } catch (e) { return {}; }
        }

        // Save the raw per-user configs object to localStorage
        function saveAllUserConfigs(configs) {
            try { localStorage.setItem(LS_KEYS.USER_CONFIGS, JSON.stringify(configs)); } catch (e) {}
        }

        // Initialize user settings: derive key, decrypt config, migrate old data if needed
        async function initUserSettings(passwordHash, username) {
            // v073：密钥派生升级为 PBKDF2 + 每用户随机盐；旧密钥加密的存量数据自动迁移
            _legacyEncryptionKey = null;
            const allConfigs = loadAllUserConfigs();
            let userConfig = null;
            let legacyFallback = false;

            if (allConfigs[username]) {
                const encrypted = allConfigs[username];
                // 1) 优先用新密钥（PBKDF2 + 已保存的每用户盐）解密
                const keyMeta = loadKeyMeta(username);
                if (keyMeta) {
                    try {
                        _encryptionKey = await _pbkdf2DeriveKey(passwordHash, keyMeta.salt, keyMeta.iterations);
                        userConfig = JSON.parse(await decryptData(_encryptionKey, encrypted.iv, encrypted.data));
                    } catch (e) { _encryptionKey = null; }
                }
                // 2) 迁移路径：新密钥解不开时回退旧派生方式，成功后本次会话保留旧密钥供其余密文迁移
                if (!userConfig) {
                    try {
                        const legacyKey = await _legacyDeriveKey(passwordHash);
                        userConfig = JSON.parse(await decryptData(legacyKey, encrypted.iv, encrypted.data));
                        _legacyEncryptionKey = legacyKey;
                        legacyFallback = true;
                    } catch (e2) {
                        // 新老密钥均失败（密码错误或数据损坏）— 视为新用户处理
                        console.warn('Failed to decrypt settings for', username, '- starting fresh');
                        userConfig = null;
                    }
                }
            }

            // 3) 确保会话使用新密钥：无 meta 时生成每用户随机盐并落盘
            let keyMeta = loadKeyMeta(username);
            if (!keyMeta) {
                keyMeta = { salt: _generateKeySalt(), iterations: PBKDF2_ITERATIONS };
                saveKeyMeta(username, keyMeta);
            }
            if (legacyFallback || !_encryptionKey) {
                _encryptionKey = await _pbkdf2DeriveKey(passwordHash, keyMeta.salt, keyMeta.iterations);
            }

            let wasMigrated = false;
            if (!userConfig) {
                // No encrypted config yet - migrate from old localStorage keys (one-time)
                userConfig = {
                    theme: localStorage.getItem(LS_KEYS.LEGACY_THEME) || 'dark',
                    themeColor: localStorage.getItem(LS_KEYS.LEGACY_THEME_COLOR) || '',
                    unread: { publicLastRead: null, privateLastRead: {} },
                    dismissedPrivacyBanners: [],
                    notify: Object.assign({}, DEFAULT_NOTIFY),
                    version: 1
                };
                wasMigrated = true;
                // Migrate old unread state if it exists
                try {
                    const oldUnread = JSON.parse(localStorage.getItem(LS_KEYS.LEGACY_UNREAD));
                    if (oldUnread) {
                        userConfig.unread = oldUnread;
                    }
                } catch (e) {}
                // Migrate old dismissed banners
                try {
                    const oldBanners = JSON.parse(localStorage.getItem(LS_KEYS.LEGACY_BANNERS));
                    if (oldBanners) {
                        userConfig.dismissedPrivacyBanners = oldBanners;
                    }
                } catch (e) {}
                // Delete old unencrypted data after migration
                try { localStorage.removeItem(LS_KEYS.LEGACY_THEME); } catch (e) {}
                try { localStorage.removeItem(LS_KEYS.LEGACY_THEME_COLOR); } catch (e) {}
                try { localStorage.removeItem(LS_KEYS.LEGACY_UNREAD); } catch (e) {}
                try { localStorage.removeItem(LS_KEYS.LEGACY_BANNERS); } catch (e) {}
            }

            // Cache decrypted settings in memory
            _userSettingsCache = userConfig;

            // v057 修复：迁移/新建出的配置立即加密落盘，
            // 否则下次启动解不到配置，设置（主题色、通知等）会退回默认
            // v073：旧密钥迁移成功时同样立即用新密钥重加密
            if (wasMigrated || legacyFallback) {
                await syncSettingsToEncryptedStore();
            }

            // Migrate: ensure notify settings exist for existing users
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
                await syncSettingsToEncryptedStore();
            }

            // Apply settings immediately
            applyUserSettings();

            // 解密 AI 设置（模型/翻译）到内存缓存
            await loadAISettingsToCache();

            // 兜底清理旧版迁移遗留键：此时旧数据已并入加密用户配置（无配置时上面已迁移并删除），
            // 残留旧键仅是无用垃圾，删除避免占位（曾存在“已有配置但旧键未清”的过渡版本）
            try { localStorage.removeItem(LS_KEYS.LEGACY_THEME); } catch (e) {}
            try { localStorage.removeItem(LS_KEYS.LEGACY_THEME_COLOR); } catch (e) {}
            try { localStorage.removeItem(LS_KEYS.LEGACY_UNREAD); } catch (e) {}
            try { localStorage.removeItem(LS_KEYS.LEGACY_BANNERS); } catch (e) {}

            // 云端设置同步：本地设置就绪后拉取云端设置并应用（云端为权威）。
            // 云同步模块 cloudsync.js 可能尚未加载（老版本客户端），做存在性检查。
            try {
                if (window.CloudSync && typeof window.CloudSync.onLocalSettingsReady === 'function') {
                    window.CloudSync.onLocalSettingsReady();
                }
            } catch (e) {
                console.warn('cloud settings pull hook failed:', e);
            }
        }

        // Apply cached settings to the app state
        function applyUserSettings() {
            if (!_userSettingsCache) return;

            // Apply theme（内置 dark/light 或自定义主题统一由 ThemeManager 处理）
            const themeId = _userSettingsCache.themeId || _userSettingsCache.theme || 'dark';
            if (window.ThemeManager) {
                ThemeManager.activate(themeId);
            } else {
                document.documentElement.setAttribute('data-theme', _userSettingsCache.theme || 'dark');
            }
            updateThemeLabel();

            // Apply font（应用级设置，独立于主题；字体仅本地生效）
            if (window.FontManager) {
                FontManager.activate(_userSettingsCache.fontId || 'default');
            }

            // Apply typography（字号/字重，应用级设置，仅本地生效）
            if (window.TypographyManager) {
                TypographyManager.activateScale(_userSettingsCache.fontScaleId || 'default');
                TypographyManager.activateWeight(_userSettingsCache.fontWeightId || 'default');
            }

            // Apply theme color（自定义主题生效时主题色被主题接管）
            if (_userSettingsCache.themeColor && !(window.ThemeManager && ThemeManager.isCustomThemeActive())) {
                applyThemeColor(_userSettingsCache.themeColor);
                const picker = document.getElementById('themeColorPicker');
                if (picker) picker.value = _userSettingsCache.themeColor;
            }

            // Apply dismissed banners
            dismissedPrivacyBanners = new Set(_userSettingsCache.dismissedPrivacyBanners || []);

            // Apply notification settings to settings page UI
            refreshNotifySettingsUI();
        }

        // 云设置同步通知：本地可同步设置变更后交给 cloudsync.js 防抖推送
        // （cloudsync.js 加载于 s3.js 之后；未登录/未初始化时内部自行跳过）
        function notifyCloudSettingsChanged() {
            try {
                if (window.CloudSync && typeof window.CloudSync.onLocalSettingsChanged === 'function') {
                    window.CloudSync.onLocalSettingsChanged();
                }
            } catch (e) {}
        }

        // Sync in-memory settings to encrypted localStorage
        async function syncSettingsToEncryptedStore() {
            if (!_encryptionKey || !_userSettingsCache || !currentUser) return;
            try {
                const allConfigs = loadAllUserConfigs();
                const plaintext = JSON.stringify(_userSettingsCache);
                const encrypted = await encryptData(_encryptionKey, plaintext);
                allConfigs[currentUser] = encrypted;
                saveAllUserConfigs(allConfigs);
            } catch (e) {
                console.warn('Failed to sync encrypted settings:', e);
            }
            notifyCloudSettingsChanged();
        }

        // Clear encryption key and settings cache from memory
        function clearEncryptionKey() {
            _encryptionKey = null;
            _legacyEncryptionKey = null;
            _userSettingsCache = null;
            _aiSettingsCache = null;
            // 清空聊天记录缓存的内存态（localStorage 中的加密数据保留，重新登录可恢复）
            _privateMsgCacheMap = {};
            _privateMsgCacheOrder = [];
            _cachedSessions = null;
            if (_msgCacheTimer) { clearTimeout(_msgCacheTimer); _msgCacheTimer = null; }
        }

        // ============================================
        // AI 设置加密存取（模型/翻译，含 API Key）
        // 与用户设置共用 AES-GCM 密钥；旧版明文在下次登录时自动迁移为加密格式
        // ============================================

        // 读取并解密单个 AI 设置键；旧版明文自动加密迁移；
        // v073：旧密钥加密的存量数据回退用迁移期旧密钥解密并转新密钥落盘
        async function decryptAISettingsValue(key, raw) {
            if (!raw) return null;
            let obj = null;
            try { obj = JSON.parse(raw); } catch (e) { return null; }
            if (obj && typeof obj === 'object' && obj.iv && obj.data) {
                // 已是加密格式
                if (!_encryptionKey) return null;
                try {
                    const plain = await decryptData(_encryptionKey, obj.iv, obj.data);
                    return JSON.parse(plain);
                } catch (e) {
                    if (_legacyEncryptionKey) {
                        try {
                            const plain = await decryptData(_legacyEncryptionKey, obj.iv, obj.data);
                            const parsed = JSON.parse(plain);
                            // 迁移：立即用新密钥重写
                            try {
                                const enc = await encryptData(_encryptionKey, JSON.stringify(parsed));
                                localStorage.setItem(key, JSON.stringify(enc));
                            } catch (e3) {}
                            return parsed;
                        } catch (e2) { return null; }
                    }
                    return null;
                }
            }
            // 旧版明文：用当前密钥加密迁移
            if (_encryptionKey) {
                try {
                    const enc = await encryptData(_encryptionKey, JSON.stringify(obj));
                    localStorage.setItem(key, JSON.stringify(enc));
                } catch (e) {}
            }
            return obj;
        }

        // 加密写入单个 AI 设置键；v073：密钥未就绪时不再明文降级，
        // 避免 API Key 等敏感数据以明文落盘（此函数仅在登录后调用，密钥必已就绪）
        async function encryptAISettingsValue(key, obj) {
            if (obj === null || obj === undefined) { localStorage.removeItem(key); return; }
            if (!_encryptionKey) return;
            try {
                const enc = await encryptData(_encryptionKey, JSON.stringify(obj));
                localStorage.setItem(key, JSON.stringify(enc));
            } catch (e) {
                console.warn('AI 设置加密保存失败:', e);
            }
        }

        // 登录时解密全部 AI 设置到内存缓存
        async function loadAISettingsToCache() {
            _aiSettingsCache = {
                model: await decryptAISettingsValue(LS_KEYS.AI_MODEL_SETTINGS, localStorage.getItem(LS_KEYS.AI_MODEL_SETTINGS)),
                translate: await decryptAISettingsValue(LS_KEYS.AI_TRANSLATE_SETTINGS, localStorage.getItem(LS_KEYS.AI_TRANSLATE_SETTINGS))
            };
        }

        // 同步读取已解密的 AI 模型设置
        function getAIModelSettings() {
            return _aiSettingsCache ? _aiSettingsCache.model : null;
        }

        // 同步读取已解密的 AI 翻译设置
        function getAITranslateSettings() {
            return _aiSettingsCache ? _aiSettingsCache.translate : null;
        }

        // 保存 AI 模型设置（更新缓存 + 加密落盘）
        async function saveAIModelSettings(settings) {
            if (!_aiSettingsCache) _aiSettingsCache = { model: null, translate: null };
            _aiSettingsCache.model = settings || null;
            await encryptAISettingsValue(LS_KEYS.AI_MODEL_SETTINGS, _aiSettingsCache.model);
            notifyCloudSettingsChanged();
        }

        // 保存 AI 翻译设置（更新缓存 + 加密落盘）
        async function saveAITranslateSettings(settings) {
            if (!_aiSettingsCache) _aiSettingsCache = { model: null, translate: null };
            _aiSettingsCache.translate = settings || null;
            await encryptAISettingsValue(LS_KEYS.AI_TRANSLATE_SETTINGS, _aiSettingsCache.translate);
            notifyCloudSettingsChanged();
        }

        // ============================================
        // 聊天记录本地加密缓存（AES-GCM，与用户设置同密钥）
        // 缓存公聊最近 200 条与私聊各会话最近 200 条，用于离线查看与加速首屏；
        // 仅缓存消息文本与媒体 URL，媒体文件本身不缓存。
        // 数据按用户隔离（mjchat_msgcache_<username>）；登出保留（加密保存，同密码重新登录可恢复），注销账号时清除。
        // ============================================
        const MSG_CACHE_PREFIX = LS_KEYS.MSG_CACHE_PREFIX;
        const MSG_CACHE_GROUP_LIMIT = 200;  // v099: 群聊消息缓存每群上限（替代原公聊 MSG_CACHE_PUBLIC_LIMIT）
        const MSG_CACHE_PRIVATE_LIMIT = 200;
        const MSG_CACHE_MAX_SESSIONS = 20;
        let _msgCacheTimer = null;
        let _privateMsgCacheMap = {};   // sessionId -> 消息数组（时间正序）
        let _privateMsgCacheOrder = []; // 最近更新的会话 id（头部最新，用于裁剪会话数）
        let _cachedSessions = null;     // 私聊会话列表缓存（离线时恢复列表）

        // 只保留渲染所需字段，避免缓存体积膨胀与易变字段污染
        function _trimMsg(m) {
            if (!m || typeof m !== 'object') return null;
            const out = { id: m.id, sender: m.sender, sender_uid: m.sender_uid, created_at: m.created_at };
            // v101: 统一消息内容协议——contents JSON 优先缓存；历史 text/content 字段兜底
            if (m.contents) out.contents = m.contents;
            if (typeof m.text === 'string') out.text = m.text;
            if (typeof m.content === 'string') out.content = m.content;
            if (m.image_url) out.image_url = m.image_url;
            if (m.audio_url) out.audio_url = m.audio_url;
            if (m.audio_dur) out.audio_dur = m.audio_dur;
            if (m.msg_version) out.msg_version = m.msg_version;
            if (m.reply_to_id) out.reply_to_id = m.reply_to_id;
            if (m.reply_content) out.reply_content = m.reply_content;
            if (m.sender_deleted) out.sender_deleted = m.sender_deleted;
            if (m.is_system) out.is_system = m.is_system;
            // v071: 一并缓存译文与屏蔽词判断，离线/重渲染时可恢复
            if (typeof m.translation === 'string') out.translation = m.translation;
            if (typeof m.blocked_warn === 'string') out.blocked_warn = m.blocked_warn;
            return out;
        }

        function _msgCacheKey() {
            return MSG_CACHE_PREFIX + (currentUser || '');
        }

        // 消息时间戳（解析失败按 0 处理，避免影响排序）
        function _msgTimeOf(m) {
            const t = m && m.created_at ? new Date(m.created_at).getTime() : NaN;
            return isNaN(t) ? 0 : t;
        }

        // 消息 id 数值化（用于同一时间戳时的兜底排序；bigint 字符串可能超出安全整数，仅作近似比较）
        function _msgIdNum(m) {
            const id = m ? m.id : undefined;
            const n = (typeof id === 'number') ? id : Number(id);
            return isNaN(n) ? null : n;
        }

        // 消息统一按时间正序排序（时间戳相同按 id 兜底），不信任服务端/缓存原有顺序，
        // 避免旧消息被排到列表底部；返回新数组，不改动入参
        function _sortMsgAsc(msgs) {
            if (!Array.isArray(msgs)) return msgs || [];
            return msgs.slice().sort(function(a, b) {
                const ta = _msgTimeOf(a), tb = _msgTimeOf(b);
                if (ta !== tb) return ta - tb;
                const ia = _msgIdNum(a), ib = _msgIdNum(b);
                if (ia !== null && ib !== null) return ia - ib;
                return String(a && a.id || '').localeCompare(String(b && b.id || ''));
            });
        }

        // 读取并解密当前用户的聊天记录缓存；返回 { public, private, sessions } 或 null
        async function loadChatMessageCache() {
            if (!_encryptionKey || !currentUser) return null;
            try {
                const raw = localStorage.getItem(_msgCacheKey());
                if (!raw) return null;
                const obj = JSON.parse(raw);
                if (!obj || !obj.iv || !obj.data) return null;
                let plain = null;
                try {
                    plain = await decryptData(_encryptionKey, obj.iv, obj.data);
                } catch (e) {
                    // v073：旧密钥加密的缓存，迁移期用旧密钥读取（下次保存时自然用新密钥重写）
                    if (_legacyEncryptionKey) {
                        try { plain = await decryptData(_legacyEncryptionKey, obj.iv, obj.data); }
                        catch (e2) { return null; }
                    } else { return null; }
                }
                const cache = JSON.parse(plain);
                if (!cache || typeof cache !== 'object') return null;
                _privateMsgCacheMap = {};
                _privateMsgCacheOrder = [];
                if (cache.private && typeof cache.private === 'object') {
                    Object.keys(cache.private).forEach(sid => {
                        _privateMsgCacheMap[sid] = _sortMsgAsc((Array.isArray(cache.private[sid]) ? cache.private[sid] : [])
                            .map(_trimMsg).filter(Boolean));
                        _privateMsgCacheOrder.push(sid);
                    });
                }
                _cachedSessions = Array.isArray(cache.sessions) ? cache.sessions : null;
                // v099: 群聊消息缓存（按群隔离，离线兜底；服务端仍为准）
                const groups = {};
                if (cache.groups && typeof cache.groups === 'object') {
                    Object.keys(cache.groups).forEach(gid => {
                        const list = Array.isArray(cache.groups[gid]) ? cache.groups[gid] : [];
                        if (list.length) groups[gid] = _sortMsgAsc(list.map(_trimMsg).filter(Boolean));
                    });
                }
                return {
                    groups: groups,
                    private: _privateMsgCacheMap,
                    sessions: _cachedSessions
                };
            } catch (e) {
                console.warn('聊天记录缓存读取失败（密钥不匹配或数据损坏）:', e);
                return null;
            }
        }

        // 加密写入当前用户的聊天记录缓存
        async function saveChatMessageCache() {
            if (!_encryptionKey || !currentUser) return;
            try {
                // v099: 群聊消息缓存（按群隔离；仅缓存当前打开群，服务端为准）
                const groups = {};
                if (currentGroupId && typeof groupMessages !== 'undefined' && Array.isArray(groupMessages) && groupMessages.length) {
                    groups[currentGroupId] = _sortMsgAsc(groupMessages.slice(-MSG_CACHE_GROUP_LIMIT)).map(_trimMsg).filter(Boolean);
                }
                const priv = {};
                _privateMsgCacheOrder.slice(0, MSG_CACHE_MAX_SESSIONS).forEach(sid => {
                    const list = _privateMsgCacheMap[sid];
                    if (list && list.length) priv[sid] = list.slice(-MSG_CACHE_PRIVATE_LIMIT);
                });
                const payload = {
                    savedAt: new Date().toISOString(),
                    groups: groups,
                    private: priv,
                    sessions: _cachedSessions || undefined
                };
                const encrypted = await encryptData(_encryptionKey, JSON.stringify(payload));
                localStorage.setItem(_msgCacheKey(), JSON.stringify(encrypted));
            } catch (e) {
                // 配额不足或密钥缺失时静默失败（缓存非关键功能）
                console.warn('聊天记录缓存保存失败:', e);
            }
        }

        // 防抖保存（消息频繁到达时合并写入）
        function scheduleMessageCacheSave() {
            if (!_encryptionKey || !currentUser) return;
            if (_msgCacheTimer) clearTimeout(_msgCacheTimer);
            _msgCacheTimer = setTimeout(function() {
                _msgCacheTimer = null;
                saveChatMessageCache();
            }, 800);
        }

        // 页面隐藏/关闭前立即落盘，补上防抖间隙
        function flushMessageCacheSave() {
            if (_msgCacheTimer) { clearTimeout(_msgCacheTimer); _msgCacheTimer = null; }
            if (_encryptionKey && currentUser) {
                saveChatMessageCache();
            }
        }

        // 覆盖某个私聊会话的缓存（参数为时间正序消息数组）
        function upsertPrivateMsgCache(sessionId, msgs) {
            if (!sessionId) return;
            const list = _sortMsgAsc(msgs).map(_trimMsg).filter(Boolean).slice(-MSG_CACHE_PRIVATE_LIMIT);
            if (!list.length && !_privateMsgCacheMap[sessionId]) return;
            _privateMsgCacheMap[sessionId] = list;
            const i = _privateMsgCacheOrder.indexOf(sessionId);
            if (i >= 0) _privateMsgCacheOrder.splice(i, 1);
            _privateMsgCacheOrder.unshift(sessionId);
            scheduleMessageCacheSave();
        }

        // 追加一条私聊消息到缓存（按 id 去重）
        function appendPrivateMsgCache(sessionId, msg) {
            if (!sessionId || !msg || !msg.id) return;
            let list = _privateMsgCacheMap[sessionId] || [];
            if (list.some(function(m) { return m.id === msg.id; })) return;
            list = _sortMsgAsc(list.concat([_trimMsg(msg)])).filter(Boolean).slice(-MSG_CACHE_PRIVATE_LIMIT);
            _privateMsgCacheMap[sessionId] = list;
            const i = _privateMsgCacheOrder.indexOf(sessionId);
            if (i >= 0) _privateMsgCacheOrder.splice(i, 1);
            _privateMsgCacheOrder.unshift(sessionId);
            scheduleMessageCacheSave();
        }

        // 读取某个私聊会话的缓存消息（时间正序）
        function getPrivateMsgCache(sessionId) {
            return _privateMsgCacheMap[sessionId] || null;
        }

        // v072: 就地同步某条私聊消息的易变字段（译文/屏蔽词判断）到缓存，
        // 供渲染后补充写回，避免"先渲染再入缓存"导致的重排
        function updateCachedMessageFields(sessionId, msg) {
            if (!sessionId || !msg || !msg.id) return;
            const list = _privateMsgCacheMap[sessionId];
            if (!Array.isArray(list)) return;
            for (let i = 0; i < list.length; i++) {
                if (list[i].id === msg.id) {
                    if (typeof msg.translation === 'string') list[i].translation = msg.translation;
                    else if (list[i].translation) delete list[i].translation;
                    if (typeof msg.blocked_warn === 'string') list[i].blocked_warn = msg.blocked_warn;
                    else if (list[i].blocked_warn) delete list[i].blocked_warn;
                    scheduleMessageCacheSave();
                    return;
                }
            }
        }

        // 记录私聊会话列表缓存（离线时恢复私聊入口）
        function setCachedSessions(sessions) {
            const trimmed = Array.isArray(sessions) && sessions.length
                ? sessions.map(function(s) {
                    return {
                        id: s.id, user1: s.user1, user2: s.user2, updated_at: s.updated_at,
                        last_message: s.last_message, deleted_by_user1: s.deleted_by_user1, deleted_by_user2: s.deleted_by_user2
                    };
                }) : null;
            // v102: 只序列化一次，避免每轮轮询对同一列表做两次 stringify
            const next = JSON.stringify(trimmed);
            if (next === _cachedSessionsJson) return;
            _cachedSessions = trimmed;
            _cachedSessionsJson = next;
            scheduleMessageCacheSave();
        }

        function getCachedSessions() {
            return _cachedSessions;
        }

        // 清空当前用户的聊天记录缓存（注销账号时调用）
        function clearChatMessageCache() {
            _privateMsgCacheMap = {};
            _privateMsgCacheOrder = [];
            _cachedSessions = null;
            _cachedSessionsJson = 'null';
            if (_msgCacheTimer) { clearTimeout(_msgCacheTimer); _msgCacheTimer = null; }
            if (currentUser) {
                try { localStorage.removeItem(_msgCacheKey()); } catch (e) {}
            }
        }

        // v073: 注销账号时彻底清除本地数据——
        // AI 设置（含 API Key）、用户配置、密钥盐、聊天记录缓存全部移除，
        // 防止同名同密码重新注册后旧数据（旧 API Key）"复活"
        function clearAllUserLocalData() {
            try { localStorage.removeItem(LS_KEYS.AI_MODEL_SETTINGS); } catch (e) {}
            try { localStorage.removeItem(LS_KEYS.AI_TRANSLATE_SETTINGS); } catch (e) {}
            try { localStorage.removeItem(LS_KEYS.USER_CONFIGS); } catch (e) {}
            if (currentUser) {
                try { localStorage.removeItem(_keyMetaKey(currentUser)); } catch (e) {}
            }
            clearChatMessageCache();
            clearEncryptionKey();
        }

        // 页面关闭/隐藏前立即落盘防抖中的缓存（含未读状态），补上防抖间隙
        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', function() {
                flushMessageCacheSave();
                if (_unreadSyncTimer) {
                    clearTimeout(_unreadSyncTimer);
                    _unreadSyncTimer = null;
                    syncSettingsToEncryptedStore();
                }
            });
        }

        // ============================================
        // 设置导入导出
        // ============================================

        // v073 安全修复：导出前对 AI API Key 脱敏，防止备份文件泄露密钥
        function _maskApiKey(key) {
            if (!key || typeof key !== 'string') return '';
            if (key.length <= 8) return '••••••••';
            return key.slice(0, 4) + '••••••••' + key.slice(-4);
        }

        function _sanitizeAIForExport(s) {
            const copy = Object.assign({}, s);
            if (copy.apiKey) copy.apiKey = _maskApiKey(copy.apiKey);
            copy.apiKeyExported = false; // 标记：导入时识别为脱敏值，保留本机密钥
            return copy;
        }

        // 导出设置：应用设置（主题/通知等）+ AI 设置（API Key 脱敏）打包为 JSON 文件
        function exportSettings() {
            if (!_userSettingsCache) { showSnackbar('设置尚未加载'); return; }
            const userSettings = Object.assign({}, _userSettingsCache);
            delete userSettings.unread; // 未读状态属设备临时数据，不随设置迁移
            const aiModel = getAIModelSettings() || null;
            const aiTranslate = getAITranslateSettings() || null;
            const data = {
                app: 'com.cika.chatapp',
                type: '#settings#',
                version: "1.0.0",
                exportedAt: new Date().toISOString(),
                user: currentUser || '',
                settings: {
                    user: userSettings,
                    aiModel: aiModel ? _sanitizeAIForExport(aiModel) : null,
                    aiTranslate: aiTranslate ? _sanitizeAIForExport(aiTranslate) : null
                }
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const fileName = 'knockchat-backup-' + new Date().toISOString().slice(0, 10) + '.json';
            saveBlobFile(fileName, blob).then(function(r) {
                if (r === 'cancelled') return;
                showSnackbar('设置已导出（AI API Key 已脱敏，导入后需重新输入）');
            });
        }

        // 导入设置：选择 JSON 文件并确认后恢复设置
        function importSettings() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.onchange = function() {
                const file = input.files && input.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = function() {
                    let data = null;
                    try {
                        data = JSON.parse(reader.result);
                    } catch (e) { showSnackbar('导入失败: 文件解析错误'); return; }
                    if (!data || data.type !== '#settings#' || !data.settings) {
                        showSnackbar('导入失败: 不是有效的 KnockChat 设置文件');
                        return;
                    }
                    showConfirm('导入设置', '导入后将覆盖当前的主题、通知与 AI 设置，是否继续？', function() {
                        applyImportedSettings(data.settings);
                    });
                };
                reader.readAsText(file);
            };
            input.click();
        }

        // 应用导入的设置：写入加密存储与 localStorage 并立即生效
        async function applyImportedSettings(settings) {
            if (settings.user && typeof settings.user === 'object') {
                _userSettingsCache = Object.assign({}, _userSettingsCache, settings.user);
                if (!_userSettingsCache.notify) _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
                syncSettingsToEncryptedStore();
                applyUserSettings();
            }
            if (settings.aiModel) {
                // v073：导入文件中的密钥为脱敏值（apiKeyExported === false）时保留本机密钥
                if (settings.aiModel.apiKeyExported === false) {
                    const cur = getAIModelSettings() || {};
                    if (cur.apiKey) settings.aiModel.apiKey = cur.apiKey;
                    else settings.aiModel.apiKey = '';
                }
                await saveAIModelSettings(settings.aiModel);
            }
            if (settings.aiTranslate) {
                if (settings.aiTranslate.apiKeyExported === false) {
                    const cur = getAITranslateSettings() || {};
                    if (cur.apiKey) settings.aiTranslate.apiKey = cur.apiKey;
                    else settings.aiTranslate.apiKey = '';
                }
                await saveAITranslateSettings(settings.aiTranslate);
            }
            showSnackbar('设置导入成功');
        }

        // ============================================
        // Notification Sound Settings
        // ============================================

        function sha256Pure(message) {
            function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }
            var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
            var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
                     0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
                     0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
                     0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
                     0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
                     0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
                     0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
                     0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
            // Convert message to byte array (UTF-8)
            var bytes = [];
            for (var i = 0; i < message.length; i++) {
                var c = message.charCodeAt(i);
                if (c < 128) { bytes.push(c); }
                else if (c < 2048) { bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
                else { bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
            }
            // Padding
            var bitLen = bytes.length * 8;
            bytes.push(0x80);
            while (bytes.length % 64 !== 56) bytes.push(0);
            // Append length as 64-bit big-endian
            for (var b = 56; b >= 0; b -= 8) bytes.push((bitLen >>> b) & 0xFF);
            // Process blocks
            for (var off = 0; off < bytes.length; off += 64) {
                var W = [];
                for (var t = 0; t < 16; t++) {
                    W[t] = (bytes[off + t*4] << 24) | (bytes[off + t*4 + 1] << 16) | (bytes[off + t*4 + 2] << 8) | bytes[off + t*4 + 3];
                }
                for (var t2 = 16; t2 < 64; t2++) {
                    var s0 = rotr(7, W[t2-15]) ^ rotr(18, W[t2-15]) ^ (W[t2-15] >>> 3);
                    var s1 = rotr(17, W[t2-2]) ^ rotr(19, W[t2-2]) ^ (W[t2-2] >>> 10);
                    W[t2] = (W[t2-16] + s0 + W[t2-7] + s1) | 0;
                }
                var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
                for (var t3 = 0; t3 < 64; t3++) {
                    var S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
                    var ch = (e & f) ^ (~e & g);
                    var temp1 = (h + S1 + ch + K[t3] + W[t3]) | 0;
                    var S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
                    var maj = (a & b) ^ (a & c) ^ (b & c);
                    var temp2 = (S0 + maj) | 0;
                    h=g; g=f; f=e; e=(d + temp1)|0; d=c; c=b; b=a; a=(temp1 + temp2)|0;
                }
                H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
                H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
            }
            var hex = '';
            for (var hi = 0; hi < 8; hi++) {
                var h = H[hi];
                hex += ((h >>> 28) & 0xF).toString(16);
                hex += ((h >>> 24) & 0xF).toString(16);
                hex += ((h >>> 20) & 0xF).toString(16);
                hex += ((h >>> 16) & 0xF).toString(16);
                hex += ((h >>> 12) & 0xF).toString(16);
                hex += ((h >>> 8) & 0xF).toString(16);
                hex += ((h >>> 4) & 0xF).toString(16);
                hex += (h & 0xF).toString(16);
            }
            return hex;
        }

        // v043: API Key 加盐哈希，用于客户端预混淆
        async function hashApiKey(apiKey) {
            // 复用与 hashPassword 同样的 SHA-256 预哈希逻辑
            // 服务端再用 bcrypt 加固存储，是多层防御（Defense in Depth）
            if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
                const encoder = new TextEncoder();
                const data = encoder.encode('agentkey:' + apiKey + ':' + SALT);
                const hashBuffer = await crypto.subtle.digest('SHA-256', data);
                const hashArray = new Uint8Array(hashBuffer);
                let result = '';
                for (let i = 0; i < hashArray.length; i++) {
                    const hex = hashArray[i].toString(16);
                    result += hex.length === 1 ? '0' + hex : hex;
                }
                return result;
            }
            return sha256Pure('agentkey:' + apiKey + ':' + SALT);
        }
