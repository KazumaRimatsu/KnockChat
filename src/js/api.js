/* KnockChat API 请求：S3 RPC、轮询驱动、认证登录、云控、数据加载 */

        let currentUser = '';
        // v080: uid 是区分用户的唯一身份标记（类 QQ 号，从 1 递增）；username 仅作展示。
        // 所有身份判断（消息归属/私聊会话双方/黑名单）一律以 uid 为准，旧消息无 sender_uid 时回退到用户名。
        let currentUid = 0;
        // v039: Global flag for login blocked by cloud control
        var _loginBlockedByCC = false;
        // v046: 云控 login_blocked 状态跟踪
        var _prevLoginBlocked = false;
        let clientId = '';
        let isEntered = false;
        let _publicPollTimer = null;
        let _publicBackupPollTimer = null;
        let _publicRetryCount = 0;
        var _rateLimits = {};
        // v053: 免打扰系统
        let _mutePublic = false;
        let _mutePerPrivateSession = {};
        // v053: 恢复静音状态
        try {
            var _savedMutePublic = localStorage.getItem(LS_KEYS.PUBLIC_MUTED);
            if (_savedMutePublic === '1') _mutePublic = true;
            var _savedPrivateMuted = localStorage.getItem(LS_KEYS.PRIVATE_MUTED);
            if (_savedPrivateMuted) _mutePerPrivateSession = JSON.parse(_savedPrivateMuted);
        } catch(e) {}

        function checkRateLimit(action, maxCount, windowMs) {
            var now = Date.now();
            if (!_rateLimits[action]) _rateLimits[action] = [];
            _rateLimits[action] = _rateLimits[action].filter(function(t) { return now - t < windowMs; });
            if (_rateLimits[action].length >= maxCount) {
                return false;
            }
            _rateLimits[action].push(now);
            return true;
        }
        function rateLimitedAction(action, maxCount, windowMs, fn) {
            if (!checkRateLimit(action, maxCount, windowMs)) {
                showSnackbar('操作过于频繁，请稍后再试');
                return Promise.resolve(null);
            }
            return fn();
        }

        var _csrfToken = '';
        function getCsrfToken() {
            if (!_csrfToken) {
                _csrfToken = sessionStorage.getItem(LS_KEYS.CSRF) || '';
                if (!_csrfToken) {
                    var arr = new Uint8Array(32);
                    if (window.crypto && window.crypto.getRandomValues) {
                        window.crypto.getRandomValues(arr);
                    } else {
                        for (var i = 0; i < 32; i++) arr[i] = Math.floor(Math.random() * 256);
                    }
                    _csrfToken = Array.from(arr).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
                    sessionStorage.setItem(LS_KEYS.CSRF, _csrfToken);
                }
            }
            return _csrfToken;
        }

        // ============================================
        // Security Helper Functions (v030)
        // All sensitive operations must use these
        // ============================================

        function getSessionToken() {
            try {
                const session = JSON.parse(localStorage.getItem(LS_KEYS.SESSION));
                return (session && session.token) ? session.token : '';
            } catch (e) { return ''; }
        }

        // v080: 消息是否由「我」发出——优先按 sender_uid 判断，旧消息（无 sender_uid）回退到用户名
        function isMsgFromMe(msg) {
            if (!msg) return false;
            if (typeof msg.sender_uid === 'number' && msg.sender_uid > 0) return msg.sender_uid === currentUid;
            return msg.sender !== undefined && msg.sender === currentUser;
        }

        // v080: 按用户名解析 uid（get_user_profile 兼容按用户名查询）
        async function resolveUserUid(username) {
            if (!username) return 0;
            try {
                const { data: rpcData } = await s3.rpc('get_user_profile', { p_username: username });
                return (rpcData && rpcData.uid) ? rpcData.uid : 0;
            } catch (e) { return 0; }
        }



        async function sendPublicMessageSecure(payload) {
            if (!checkRateLimit('send_msg', 30, 60000)) {
                return { success: false, message: '发送过于频繁，请稍后再试' };
            }
            const token = getSessionToken();
            if (!token) { return { success: false, message: '请重新登录' }; }
            try {
                const { data, error } = await s3.rpc('send_public_message_secure', {
                    p_uid: currentUid,
                    p_session_token: token,
                    p_text: payload.text || '',
                    p_image_url: payload.image_url || null,
                    p_audio_url: payload.audio_url || null,
                    p_audio_dur: payload.audio_dur || null,
                    p_reply_to_id: payload.reply_to_id || null,
                    p_reply_content: payload.reply_content || null,
                    p_is_system: payload.is_system || false
                });
                if (error) return { success: false, message: error.message };
                return data || { success: false, message: '发送失败' };
            } catch (e) { return { success: false, message: e.message }; }
        }

        async function sendSystemMessageSecure(text) {
            const token = getSessionToken();
            if (!token) return { success: false };
            try {
                const { data, error } = await s3.rpc('send_public_message_secure', {
                    p_uid: currentUid,
                    p_session_token: token,
                    p_text: text,
                    p_is_system: true
                });
                if (error) return { success: false };
                return data || { success: false };
            } catch (e) { return { success: false }; }
        }

        async function countUnreadPrivateMessages(sessionId, lastReadTime) {
            try {
                let data = null;
                try {
                    const { data: rpcData, error } = await s3.rpc('get_private_messages', {
                        p_session_id: sessionId,
                        p_uid: currentUid,
                        p_limit: 200
                    });
                    if (!error && rpcData) data = rpcData;
                } catch (e) {}
                if (!data || data.length === 0) return;
                let count = 0;
                if (lastReadTime) {
                    data.forEach(m => {
                        if (!isMsgFromMe(m) && new Date(m.created_at) > new Date(lastReadTime)) count++;
                    });
                } else {
                    data.forEach(m => {
                        if (!isMsgFromMe(m)) count++;
                    });
                }
                if (count > 0) {
                    privateUnreadCounts[sessionId] = count;
                    renderPrivateList();
                    updateBackBadge();
                }
            } catch (e) { /* ignore */ }
        }
        function generateLocalNonce() {
            const arr = new Uint8Array(16);
            crypto.getRandomValues(arr);
            return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        }

        async function recordLogin(username, ip) {
            try {
                await s3.rpc('record_login', {
                    p_uid: currentUid,
                    p_ip: ip || 'unknown'
                });
            } catch (e) { /* ignore */ }
        }

        // v058: 记录上次登录账号与时间（对齐新版 MJChat 的 mjchat_last_login），
        // 快捷登录界面展示用；mjchat_last_login_time 作为未读计数的时间兜底基准
        function recordLastLogin(username) {
            try { localStorage.setItem(LS_KEYS.LAST_LOGIN, username); } catch (e) {}
            try { localStorage.setItem(LS_KEYS.LAST_LOGIN_TIME, new Date().toISOString()); } catch (e) {}
        }

        async function getClientIP() {
            try {
                const res = await fetch('https://api.ipify.org?format=json');
                const data = await res.json();
                return data.ip;
            } catch (e) { return 'unknown'; }
        }

        function showLogin() {
            document.getElementById('registerScreen').classList.add('hidden');
            document.getElementById('loginScreen').classList.remove('hidden');
            hideEl('regError');
            hideEl('regSuccess');
            document.getElementById('authContainer').style.display = 'flex';
            document.getElementById('appContainer').style.display = 'none';
            // v040: 快速登录——有上次登录记录时显示简化界面
            updateQuickLoginUI();
        }

        function showRegister() {
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('registerScreen').classList.remove('hidden');
            hideEl('loginError');
            // v040: 注册时隐藏快速登录界面
            var quickInfo = document.getElementById('quickLoginInfo');
            var normalForm = document.getElementById('loginNormalForm');
            if (quickInfo) quickInfo.classList.add('hidden');
            if (normalForm) normalForm.classList.remove('hidden');
        }

        // v040+: 一键登录——有有效会话时直接验证进入（对齐新版 MJChat），无会话/会话过期则转密码表单
        async function quickLogin() {
            // 解锁浏览器音频限制（对齐新版 MJChat quickLogin 行为）
            try {
                var silentAudio = new Audio('data:audio/mp3;base64,//NExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq');
                silentAudio.volume = 0.001;
                silentAudio.play().catch(function() {});
            } catch (e) { /* ignore */ }

            var lastLogin = '';
            try { lastLogin = localStorage.getItem(LS_KEYS.LAST_LOGIN) || ''; } catch (e) {}
            var savedSession = null;
            try {
                var raw = localStorage.getItem(LS_KEYS.SESSION);
                if (raw) savedSession = JSON.parse(raw);
            } catch (e) {}

            if (savedSession && savedSession.username && savedSession.token) {
                // 与上次登录账号不一致时不允许一键登录
                if (lastLogin && savedSession.username !== lastLogin) return showLoginForm();
                currentUser = savedSession.username;
                currentUid = savedSession.uid || 0;
                if (savedSession.pwhash) {
                    // 一键登录：服务端校验会话后进入（复用启动时的会话恢复逻辑）
                    showGlobalLoading('欢迎回来…', '正在登录 ' + currentUser);
                    restoreSession(null);
                    return;
                }
                // 旧会话缺少 pwhash 无法解密本地设置：预填用户名并转密码表单
                showLoginForm(savedSession.username);
                return;
            }
            // 无会话：转普通登录表单（不删除 LAST_LOGIN，保留给下次刷新后快捷登录使用）
            var quickInfo = document.getElementById('quickLoginInfo');
            var normalForm = document.getElementById('loginNormalForm');
            var loginHeader = document.getElementById('loginAuthHeader');
            if (quickInfo) quickInfo.classList.add('hidden');
            if (normalForm) normalForm.classList.remove('hidden');
            if (loginHeader) loginHeader.classList.remove('hidden');
            var unameEl = document.getElementById('loginUsername');
            var pwdEl = document.getElementById('loginPassword');
            if (lastLogin && unameEl) {
                unameEl.value = lastLogin;
                if (pwdEl) pwdEl.focus();
            } else if (unameEl) {
                unameEl.focus();
            }
        }

        // v040: 切换到普通登录表单（可预填用户名，用于旧会话缺少 pwhash 的场景）
        function showLoginForm(prefillUser) {
            // 切换账号时清除上次登录记录（对齐新版 MJChat）
            try { localStorage.removeItem(LS_KEYS.LAST_LOGIN); } catch (e) {}
            try { localStorage.removeItem(LS_KEYS.LAST_LOGIN_TIME); } catch (e) {}
            var quickInfo = document.getElementById('quickLoginInfo');
            var normalForm = document.getElementById('loginNormalForm');
            var loginHeader = document.getElementById('loginAuthHeader');
            if (quickInfo) quickInfo.classList.add('hidden');
            if (normalForm) normalForm.classList.remove('hidden');
            if (loginHeader) loginHeader.classList.remove('hidden');
            var unameEl = document.getElementById('loginUsername');
            var pwdEl = document.getElementById('loginPassword');
            if (prefillUser && unameEl) {
                unameEl.value = prefillUser;
                if (pwdEl) pwdEl.focus();
            } else if (unameEl) {
                unameEl.focus();
            }
        }

        // v040: 切换到普通登录（从快速登录模式切换）
        function switchToNormalLogin() {
            showLoginForm();
        }

        // v040: 快速登录界面——以 mjchat_last_login 记录为基准展示上次登录账号
        function updateQuickLoginUI() {
            var quickInfo = document.getElementById('quickLoginInfo');
            var normalForm = document.getElementById('loginNormalForm');
            var quickUserEl = document.getElementById('quickLoginUser');
            var quickAvatarEl = document.getElementById('quickLoginAvatar');
            var loginHeader = document.getElementById('loginAuthHeader');
            var lastLogin = '';
            try { lastLogin = localStorage.getItem(LS_KEYS.LAST_LOGIN) || ''; } catch (e) {}
            // v040: 快捷登录需要有效的会话（含 pwhash），无会话时显示普通登录表单
            var hasValidQuickSession = false;
            try {
                var raw = localStorage.getItem(LS_KEYS.SESSION);
                if (raw) {
                    var sess = JSON.parse(raw);
                    hasValidQuickSession = !!(sess && sess.username && sess.token && sess.pwhash);
                }
            } catch (e) {}
            if (lastLogin && hasValidQuickSession) {
                if (quickInfo) quickInfo.classList.remove('hidden');
                if (normalForm) normalForm.classList.add('hidden');
                // 一键登录模式隐藏品牌 logo（对齐新版 MJChat 登录页布局）
                if (loginHeader) loginHeader.classList.add('hidden');
                if (quickUserEl) quickUserEl.textContent = lastLogin;
                if (quickAvatarEl) {
                    // 渐变底色 + 首字母，云端头像异步加载（加载中显示 MD 圆圈动画）
                    quickAvatarEl.textContent = lastLogin.charAt(0).toUpperCase();
                    quickAvatarEl.removeAttribute('src');
                    quickAvatarEl.style.backgroundImage = '';
                    quickAvatarEl.className = 'quick-login-avatar';
                    quickAvatarEl.style.background = 'linear-gradient(135deg, hsl(' + (hashStr(lastLogin) % 360) +
                        ',70%,60%), hsl(' + ((hashStr(lastLogin) + 60) % 360) + ',70%,48%))';
                    quickAvatarEl.style.backgroundSize = 'cover';
                    quickAvatarEl.style.backgroundPosition = 'center';
                    quickAvatarEl.innerHTML = '';
                    var loader = document.createElement('span');
                    loader.className = 'md-circular-loader';
                    loader.innerHTML = '<svg viewBox="0 0 22 22"><circle cx="11" cy="11" r="9.5"/></svg>';
                    quickAvatarEl.appendChild(loader);
                    loadQuickLoginAvatar(lastLogin, quickAvatarEl, loader);
                }
            } else {
                if (quickInfo) quickInfo.classList.add('hidden');
                if (normalForm) normalForm.classList.remove('hidden');
                if (loginHeader) loginHeader.classList.remove('hidden');
            }
        }

        // 异步加载上次登录账号的云端头像；成功则替换为图片，失败则保留首字母渐变
        async function loadQuickLoginAvatar(username, avatarEl, loader) {
            var avatarUrl = '';
            try {
                var rpcRes = await s3.rpc('get_user_profile', { p_username: username });
                if (rpcRes && rpcRes.data && rpcRes.data.success !== false && rpcRes.data.avatar_url) {
                    avatarUrl = rpcRes.data.avatar_url;
                }
            } catch (e) { /* ignore */ }
            if (!avatarEl || !avatarEl.isConnected) return;
            if (loader && loader.parentNode) loader.parentNode.removeChild(loader);
            var cleanUrl = sanitizeAvatarUrl(avatarUrl);
            if (cleanUrl) {
                avatarEl.textContent = '';
                avatarEl.style.backgroundImage = 'url(' + cleanUrl + ')';
                avatarEl.style.backgroundSize = 'cover';
                avatarEl.style.backgroundPosition = 'center';
            }
        }

        async function doRegister() {
            hideEl('regError');
            hideEl('regSuccess');
            const username = document.getElementById('regUsername').value.trim();
            const password = document.getElementById('regPassword').value;
            const password2 = document.getElementById('regPassword2').value;
            if (!username) return showEl('regError', '请输入昵称');
            if (username.length < 2) return showEl('regError', '昵称至少 2 个字符');
            if (username.length > 15) return showEl('regError', '昵称最多 15 个字符');
            if (HIDDEN_UNICODE_RE.test(username)) {
                return showEl('regError', '昵称不能包含零宽或控制字符');
            }
            if (!isSafeUsername(username)) {
                return showEl('regError', '昵称包含不安全字符，请重新输入');
            }
            if (password.length < 6) return showEl('regError', '密码至少 6 个字符');
            if (password !== password2) return showEl('regError', '两次密码不一致');

            try {
                // 先检查用户名是否已存在（RPC）
                let usernameExists = false;
                try {
                    const { data: rpcData } = await s3.rpc('check_username_exists', { p_username: username });
                    if (rpcData && rpcData.exists) usernameExists = true;
                } catch (e) { /* RPC not found, fallback */ }
                if (!usernameExists) {
                    try {
                        const { data: rpcData } = await s3.rpc('get_user_profile', { p_username: username });
                        if (rpcData && rpcData.success !== false) usernameExists = true;
                    } catch (e) { /* RPC not found */ }
                }
                if (usernameExists) return showEl('regError', '该昵称已被使用');

                const passwordHash = await hashPassword(password);
                let regError = null;
                let regSessionToken = null;
                let regUid = 0;
                try {
                    const { data: regData, error: rpcError } = await s3.rpc('register_user_secure', {
                        p_username: username,
                        p_password_hash: passwordHash
                    });
                    if (rpcError) {
                        regError = rpcError;
                    } else if (regData && regData.session_token) {
                        regSessionToken = regData.session_token;
                        regUid = regData.uid || 0;
                    }
                } catch (e) { regError = e; }

                if (regError) {
                    const { error } = await s3.rpc('register_user', {
                        p_username: username,
                        p_password_hash: passwordHash
                    });
                    if (error) {
                        if (error.message.includes('duplicate') || error.message.includes('unique')) return showEl(
                            'regError', '该昵称已被使用');
                        return showEl('regError', '注册失败: ' + error.message);
                    }
                }

                currentUser = username;
                currentUid = regUid || 0;
                // v049: 云控 login_blocked 时直接拦截注册，不进入主页面
                try {
                    if (await shouldBlockSessionForLoginLocked()) {
                        _loginBlockedByCC = true;
                        _prevLoginBlocked = true;
                        hideGlobalLoading();
                        showLogin();
                        showAuthBannerDynamic(CC_BANNER_TITLE, CC_BANNER_MSG, false, true);
                        return;
                    }
                } catch (ccErr) { /* ignore */ }
                recordLastLogin(username);
                const sessionToken = regSessionToken || generateLocalNonce();
                localStorage.setItem(LS_KEYS.SESSION, JSON.stringify({ username: username, uid: currentUid, token: sessionToken, pwhash: passwordHash }));
                // Initialize encrypted user settings with password hash as key (new user, starts fresh)
                initUserSettings(passwordHash, username).catch(function(e) { console.warn('initUserSettings failed:', e); });
                showEl('regSuccess', '注册成功！正在进入...');
                setTimeout(() => {
                    clearRegForm();
                    showGlobalLoading('登录中', '欢迎 ' + currentUser);
                    authorizeEnterApp();
                    enterApp();
                }, 1200);
            } catch (e) {
                showEl('regError', '注册失败，请重试');
            }
        }

        function clearRegForm() {
            document.getElementById('regUsername').value = '';
            document.getElementById('regPassword').value = '';
            document.getElementById('regPassword2').value = '';
        }

        async function doLogin() {
            hideEl('loginError');
            const username = document.getElementById('loginUsername').value.trim();
            const password = document.getElementById('loginPassword').value;
            if (!username) return showEl('loginError', '请输入昵称');
            if (!password) return showEl('loginError', '请输入密码');
            if (!checkRateLimit('login', 5, 60000)) {
                showEl('loginError', '登录尝试过于频繁，请1分钟后再试');
                return;
            }

            // v040: Check if backend is available before attempting login
            if (!window.s3 || typeof window.s3.rpc !== 'function') {
                showEl('loginError', '连接服务失败，请刷新页面重试');
                return;
            }

            showGlobalLoading('登录中', '验证身份');

            // v040: Login timeout - abort if login takes too long
            var _loginTimedOut = false;
            var _loginTimeout = setTimeout(function() {
                _loginTimedOut = true;
                hideGlobalLoading();
                showEl('loginError', '登录超时，请检查网络后重试');
            }, 20000);

            try {
                const passwordHash = await hashPassword(password);
                let userData = null;
                let loginError = null;

                // v040: First attempt with secure rate-limited RPC
                try {
                    const { data: secureData, error: secureError } = await s3.rpc('verify_login_secure_rate_limited', {
                        p_username: username,
                        p_password_hash: passwordHash
                    });
                    if (!secureError && secureData) {
                        userData = secureData;
                    } else if (secureError) {
                        // 若限流 RPC 明确返回"过于频繁"，立即终止，
                        // 避免回退到无内置限流的 verify_login_secure / verify_login 绕过限流
                        const em = (secureError.message || '') + '';
                        if (/过于频繁|too many|rate.?limit|429/i.test(em)) {
                            clearTimeout(_loginTimeout);
                            hideGlobalLoading();
                            return showEl('loginError', secureError.message || '登录尝试过于频繁，请稍后再试');
                        }
                        console.warn('[login] verify_login_secure_rate_limited returned error:', secureError.code, secureError.message);
                        loginError = secureError;
                    }
                } catch (e) {
                    // v040: Rate-limited RPC might not exist, fall through
                    loginError = e;
                    console.warn('[login] verify_login_secure_rate_limited failed:', e.message || e);
                }

                // v040: Fallback to regular secure login
                if (!userData && loginError) {
                    try {
                        const { data: secureData, error: secureError } = await s3.rpc('verify_login_secure', {
                            p_username: username,
                            p_password_hash: passwordHash
                        });
                        if (!secureError && secureData) {
                            userData = secureData;
                            loginError = null;
                        } else if (secureError) {
                            loginError = secureError;
                        }
                    } catch (e) { loginError = e;
                        console.warn('[login] verify_login_secure failed:', e.message || e); }
                }

                // v040: If first attempts failed, try legacy RPC
                if (!userData && loginError) {
                    try {
                        const { data: legacyData, error: legacyError } = await s3.rpc('verify_login', {
                            p_username: username,
                            p_password_hash: passwordHash
                        });
                        if (!legacyError && legacyData) {
                            userData = legacyData;
                            loginError = null;
                        } else if (legacyError) {
                            loginError = legacyError;
                        }
                    } catch (e) {
                        // All RPC calls failed, keep the original loginError
                    }
                }

                // v040: Check if timeout occurred during RPC calls
                if (_loginTimedOut) return;

                if (loginError) {
                    clearTimeout(_loginTimeout);
                    hideGlobalLoading();
                    return showEl('loginError', '登录失败: ' + (loginError.message || loginError));
                }
                if (!userData || userData.success === false) {
                    clearTimeout(_loginTimeout);
                    hideGlobalLoading();
                    return showEl('loginError', (userData && userData.message) || '昵称或密码错误');
                }
                if (userData.banned) {
                    clearTimeout(_loginTimeout);
                    hideGlobalLoading();
                    return showEl('loginError', '您的账户已被封禁，无法登录');
                }
                currentUser = username;
                currentUid = userData.uid || 0;
                currentAvatarUrl = userData.avatar_url || '';
                userAvatarCache[currentUser] = currentAvatarUrl;
                const sessionToken = userData.session_token || await hashPassword(passwordHash);
                localStorage.setItem(LS_KEYS.SESSION, JSON.stringify({ username: username, uid: currentUid, token: sessionToken, pwhash: passwordHash }));
                // Initialize encrypted user settings with password hash as key
                initUserSettings(passwordHash, username).catch(function(e) { console.warn('initUserSettings failed:', e); });
                document.getElementById('loginPassword').value = '';
                updateLoadingText('登录中', '欢迎 ' + currentUser);

                // v040: getClientIP with timeout - don't block login if IP fetch fails
                var ip = 'unknown';
                try {
                    ip = await Promise.race([
                        getClientIP(),
                        new Promise(function(resolve) { setTimeout(function() { resolve('unknown'); }, 3000); })
                    ]);
                } catch (e) { ip = 'unknown'; }

                // v040: recordLogin with timeout - don't block login if recording fails
                try {
                    await Promise.race([
                        recordLogin(username, ip),
                        new Promise(function(resolve) { setTimeout(resolve, 5000); })
                    ]);
                } catch (e) { /* ignore */ }

                // v040: Check if timeout occurred during post-login operations
                if (_loginTimedOut) return;

                clearTimeout(_loginTimeout);
                // v047/v049: 登录即将成功进入主页面，清除 init 阶段的 safety timeout
                if (window.__mjchatSafetyTimeout) {
                    clearTimeout(window.__mjchatSafetyTimeout);
                    window.__mjchatSafetyTimeout = null;
                }
                // v049: 再次检查云控——防范后端未拦截 login_blocked 的情况
                try {
                    if (await shouldBlockSessionForLoginLocked()) {
                        _loginBlockedByCC = true;
                        _prevLoginBlocked = true;
                        hideGlobalLoading();
                        showLogin();
                        showAuthBannerDynamic(CC_BANNER_TITLE, CC_BANNER_MSG, false, true);
                        return;
                    }
                } catch (ccErr) { /* ignore */ }
                recordLastLogin(username);
                authorizeEnterApp();
                enterApp();
            } catch (e) {
                clearTimeout(_loginTimeout);
                hideGlobalLoading();
                if (!_loginTimedOut) {
                    showEl('loginError', '登录失败，请重试');
                }
            }
        }

        let _enterAppAuthorized = false;
        function authorizeEnterApp() {
            _enterAppAuthorized = true;
            // v049: 授权即清掉 safety timeout，避免跳回登录
            if (window.__mjchatSafetyTimeout) {
                clearTimeout(window.__mjchatSafetyTimeout);
                window.__mjchatSafetyTimeout = null;
            }
        }
        async function enterApp() {
            if (isEntered) return;
            if (!_enterAppAuthorized) {
                console.error('enterApp 未授权调用');
                showLogin();
                return;
            }
            // v047/v049: 进入 enterApp，清除 safety timeout（不再需要 init 阶段的安全检测）
            if (window.__mjchatSafetyTimeout) {
                clearTimeout(window.__mjchatSafetyTimeout);
                window.__mjchatSafetyTimeout = null;
            }
            _enterAppAuthorized = false;
            showGlobalLoading('连接中', '正在加载数据');
            document.getElementById('authContainer').style.display = 'none';
            document.getElementById('appContainer').style.display = 'flex';

            // v070: 本地加密缓存——等待密钥就绪后恢复已缓存记录（加速首屏，离线可用）
            for (let _kw = 0; _kw < 40 && !_encryptionKey; _kw++) {
                await new Promise(r => setTimeout(r, 50));
            }
            try {
                const msgCache = await loadChatMessageCache();
                if (msgCache && msgCache.public && msgCache.public.length && publicMessages.length === 0) {
                    msgCache.public.forEach(m => {
                        publicMessages.push(m);
                        publicMessageById.set(m.id, m);
                    });
                }
            } catch (e) {
                console.warn('聊天记录缓存恢复失败:', e);
            }

            try {
                // v040: Make connectPublic non-blocking - if it fails or takes too long,
                // still enter app and retry public chat connection in background
                try {
                    // v040: Race connectPublic against a 20-second timeout
                    await Promise.race([
                        connectPublic(),
                        new Promise(function(_, reject) {
                            setTimeout(function() { reject(new Error('公聊连接超时')); }, 20000);
                        })
                    ]);
                } catch (pubErr) {
                    console.error('[enterApp] connectPublic failed, will retry:', pubErr);
                    // Don't block the entire app - continue with private chat
                }
                // v044: 启动公聊轮询备份
                startPublicPollingBackup();
                await loadPrivateSessions();
                setupGlobalPrivateListener();
                restoreUnreadCounts();
                restorePrivateUnreadFromSessions();
                updatePublicBadge();
                updateBackBadge();
                pageHistory = ['home'];
                document.getElementById('homePage').classList.add('active');
                document.getElementById('publicPage').classList.remove('active');
                document.getElementById('privatePage').classList.remove('active');
                document.getElementById('searchPage').classList.remove('active');
                isEntered = true;
                hideGlobalLoading();
                updateHomeMenu();
                updatePublicMenu();
                renderPrivateList();
                initEmojiPicker();
                initPrivateEmojiPicker();
                initInteractions();
                initPrivateInteractions();
                initPasteImage();
                updatePublicEntry();
                updatePublicBadge();
                updateAllAvatars();

                const publicMessagesEl = document.getElementById('publicMessages');
                setupScrollHandlers(publicMessagesEl);

            } catch (err) {
                hideGlobalLoading();
                showLogin();
                showEl('loginError', '连接失败: ' + (err.message || '请检查网络'));
                console.error('enterApp error:', err);
            }
        }

        // ============================================
        // Cloud Control System (v049)
        // ============================================
        var _authBannerDynamic = null;
        var _bannerClickCountDyn = 0;
        var _bannerClickTimerDyn = null;
        var _cloudControlInterval = null;
        // v041: Track previous force_logout_all state to detect state CHANGES
        var _prevForceLogoutAll = false;
        // v041: Track if we've already been force-logged-out by the current force_logout_all event
        var _forceLogoutAllProcessed = false;

        function showAuthBannerDynamic(title, message, allowClose, isLoginBlocked) {
            hideAuthBannerDynamic();
            var overlay = document.createElement('div');
            overlay.id = 'dynAuthBanner';
            overlay.style.cssText = 'position:fixed;inset:0;background:var(--md-scrim-mid);display:flex;align-items:center;justify-content:center;z-index:99999;animation:fade-in 0.2s ease;';
            var dialog = document.createElement('div');
            dialog.style.cssText = 'background:var(--md-surface, #1c1c1e);border-radius:16px;padding:24px;max-width:380px;width:86vw;position:relative;box-shadow:0 8px 32px rgba(0,0,0,0.4);';
            var titleEl = document.createElement('h2');
            titleEl.textContent = title || '公告';
            titleEl.style.cssText = 'margin:0 0 12px 0;font-size:1.1rem;color:var(--md-on-surface, #fff);cursor:default;user-select:none;';
            var textEl = document.createElement('p');
            textEl.textContent = message || '';
            textEl.style.cssText = 'margin:0 0 20px 0;font-size:0.875rem;line-height:1.5;color:var(--md-on-surface-variant, #aaa);white-space:pre-wrap;cursor:default;user-select:none;';
            dialog.appendChild(titleEl);
            dialog.appendChild(textEl);
            if (allowClose && !isLoginBlocked) {
                var actionsDiv = document.createElement('div');
                actionsDiv.style.cssText = 'display:flex;justify-content:flex-end;';
                var closeBtn = document.createElement('button');
                closeBtn.textContent = '我知道了';
                closeBtn.style.cssText = 'background:none;border:none;color:var(--md-primary, #4A9EFF);font-size:0.875rem;padding:8px 16px;cursor:pointer;font-weight:500;';
                closeBtn.addEventListener('click', function() {
                    hideAuthBannerDynamic();
                    sessionStorage.setItem(LS_KEYS.BANNER_DISMISSED, '1');
                    window._bannerManuallyDismissed = true;
                });
                actionsDiv.appendChild(closeBtn);
                dialog.appendChild(actionsDiv);
            }
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            _authBannerDynamic = overlay;
        }

        function hideAuthBannerDynamic() {
            if (_authBannerDynamic && _authBannerDynamic.parentNode) {
                _authBannerDynamic.parentNode.removeChild(_authBannerDynamic);
                _authBannerDynamic = null;
            }
            var origModal = document.getElementById('authBannerModal');
            if (origModal) origModal.classList.add('hidden');
        }

        // v046: 检查 cloud_control.login_blocked
        async function shouldBlockSessionForLoginLocked() {
            try {
                var result = await s3.rpc('get_cloud_control');
                if (result && result.data && result.data.success !== false) {
                    return result.data.login_blocked === true;
                }
            } catch (e) {
                console.warn('[SessionLock] check error:', e);
            }
            return false;
        }

        async function checkCloudControl() {
            try {
                var result = await Promise.race([
                    s3.rpc('get_cloud_control'),
                    new Promise(function(resolve) {
                        setTimeout(function() { resolve({ data: null, error: 'timeout' }); }, 10000);
                    })
                ]);
                var data = result.data;
                var error = result.error;
                if (error || !data || !data.success) {
                    console.warn('[CC] RPC failed:', { error: error, data: data });
                    return false;
                }

                // v041: Only force logout when force_logout_all transitions from false->true
                var currentForceLogoutAll = (data.force_logout_all === true);
                var forceLogoutJustActivated = currentForceLogoutAll && !_prevForceLogoutAll;
                _prevForceLogoutAll = currentForceLogoutAll;

                // v046: Track login_blocked transitions
                var currentLoginBlocked = (data.login_blocked === true);
                _prevLoginBlocked = currentLoginBlocked;

                if (forceLogoutJustActivated && isEntered && !_forceLogoutAllProcessed) {
                    var except = data.force_logout_except || '';
                    if (currentUser && currentUser !== except) {
                        _forceLogoutAllProcessed = true;
                        localStorage.removeItem(LS_KEYS.SESSION);
                        alert('您已被强制下线，请重新登录');
                        window.location.reload();
                        return true;
                    }
                }

                // v041: Reset the processed flag when force_logout_all is turned off
                if (!currentForceLogoutAll) {
                    _forceLogoutAllProcessed = false;
                }

                // On auth page, handle banner and login_blocked
                if (!isEntered) {
                    var isBlocked = (data.login_blocked === true);
                    _loginBlockedByCC = isBlocked;
                    var showBanner = false;
                    var bannerTitle = data.banner_title || '公告';
                    var bannerMsg = data.banner_message || '';
                    var allowClose = data.banner_show_close !== false;

                    if (data.banner_enabled) {
                        var dismissed = sessionStorage.getItem(LS_KEYS.BANNER_DISMISSED);
                        if (dismissed !== '1' || isBlocked) {
                            showBanner = true;
                        }
                    } else if (isBlocked) {
                        bannerTitle = CC_BANNER_TITLE;
                        bannerMsg = CC_BANNER_MSG;
                        allowClose = false;
                        showBanner = true;
                    }

                    if (showBanner) {
                        if (isBlocked) allowClose = false;
                        showAuthBannerDynamic(bannerTitle, bannerMsg, allowClose, isBlocked);
                        var origModal = document.getElementById('authBannerModal');
                        if (origModal) {
                            origModal.dataset.bannerEnabled = 'true';
                            if (isBlocked) origModal.dataset.lockOverlay = '1';
                        }
                    }
                }

                return true;
            } catch (e) {
                console.error('[CC] checkCloudControl error:', e);
                return false;
            }
        }

        function initCloudControl() {
            var _ccRetryCount = 0;
            var _ccMaxRetries = 8;
            function initialCheck() {
                checkCloudControl().then(function(success) {
                    if (!success && _ccRetryCount < _ccMaxRetries && !isEntered) {
                        _ccRetryCount++;
                        setTimeout(initialCheck, 2000);
                    }
                });
            }
            initialCheck();
            if (_cloudControlInterval) clearInterval(_cloudControlInterval);
            _cloudControlInterval = setInterval(checkCloudControl, 30000);
        }

        async function loadUserAvatars(usernames) {
            const unique = [...new Set(usernames.filter(n => n && !userAvatarCache.hasOwnProperty(n)))];
            if (unique.length === 0) return;
            // 并发拉取用户资料（头像 URL），避免串行阻塞
            const BATCH = 8;
            for (let i = 0; i < unique.length; i += BATCH) {
                const chunk = unique.slice(i, i + BATCH);
                const results = await Promise.all(chunk.map(async (name) => {
                    try {
                        const { data: rpcData } = await s3.rpc('get_user_profile', { p_username: name });
                        return { name, avatar: (rpcData && rpcData.success !== false) ? (rpcData.avatar_url || '') : '' };
                    } catch (e) {
                        return { name, avatar: '' };
                    }
                }));
                results.forEach(r => { userAvatarCache[r.name] = r.avatar || ''; });
            }
        }

        function setupGlobalPrivateListener() {
            if (privatePollTimer) { clearInterval(privatePollTimer); privatePollTimer = null; }

            // 已移除 Supabase Realtime 广播（private_msg_notification / avatar_changed / session_deleted）：
            // 私聊新消息与会话更新统一由下方轮询驱动（loadPrivateSessions 变更检测 + loadPrivateMessages 增量）。

            // v073 性能优化：私聊轮询改为指纹对比——每 10s 只计算会话列表的 FNV-1a 指纹，
            // 不再构造 id:updated_at:last_message 字符串数组再 JSON.stringify 全量对比（省内存与 GC）
            privatePollTimer = setInterval(async () => {
                if (!currentUser) return;
                try {
                    const prevSig = window._privateSessionsSig || '';
                    await loadPrivateSessions();
                    if (prevSig !== (window._privateSessionsSig || '')) {
                        if (privateChatActive && privateSessionId) {
                            await loadPrivateMessages(privateSessionId, true);
                        }
                    }
                } catch (e) { /* ignore */ }
            }, 10000);
        }

        // 会话列表指纹：FNV-1a 双重哈希（id/updated_at/last_message 参与计算）
        function _hashPrivateSessions(sessions) {
            if (!sessions || !sessions.length) return '';
            let h1 = 0x811c9dc5, h2 = 0x811c9dc5;
            for (let i = 0; i < sessions.length; i++) {
                const s = sessions[i] || {};
                const str = s.id + '|' + (s.updated_at || '') + '|' + (s.last_message || '');
                for (let j = 0; j < str.length; j++) {
                    h1 = Math.imul(h1 ^ str.charCodeAt(j), 16777619) >>> 0;
                }
                h2 = Math.imul(h2 ^ h1, 16777619) >>> 0;
            }
            return h1.toString(36) + ':' + h2.toString(36);
        }

        async function broadcastSystemMsg(text) {
            if (!text || typeof text !== 'string') return;
            if (isGarbledText(text)) {
                console.warn('拦截到乱码系统消息，已阻止:', text);
                return;
            }
            const now = Date.now();
            if (recentSystemMsgs[text] && now - recentSystemMsgs[text] < 5000) return;
            recentSystemMsgs[text] = now;
            Object.keys(recentSystemMsgs).forEach(k => {
                if (now - recentSystemMsgs[k] > 10000) delete recentSystemMsgs[k];
            });
            try {
                sendSystemMessageSecure(text).then(r => {
                    if (r && r.success !== false) updatePublicEntry();
                }).catch(e => {});
            } catch (e) { /* ignore */ }
        }

        async function connectPublic() {
            // 已移除 Supabase Realtime 实时通道：改为「加载历史 + 定时轮询增量」
            return new Promise((resolve, reject) => {
                let resolved = false;
                loadPublicHistory()
                    .then(() => {
                        updatePublicConn(true);
                        if (!resolved) { resolved = true; resolve(); }
                    })
                    .catch(err => {
                        updatePublicConn(false);
                        if (!resolved) { resolved = true; reject(err); }
                    });
                setTimeout(() => {
                    if (!resolved) { resolved = true; reject(new Error('连接超时，请检查网络')); }
                }, 15000);
            });
        }

        // v044: 公聊轻量轮询——S3 无实时通道，轮询增量拉取
        function startPublicPollingBackup() {
            if (_publicBackupPollTimer) clearInterval(_publicBackupPollTimer);
            _publicBackupPollTimer = setInterval(async () => {
                if (!currentUser || !isEntered) return;
                try {
                    await _pollPublicMessages();
                } catch (e) { /* ignore */ }
            }, 10000);
        }

        async function _pollPublicMessages() {
            if (!isEntered) return;
            try {
                var lastId = '';
                if (publicMessages && publicMessages.length > 0) {
                    for (var i = publicMessages.length - 1; i >= 0; i--) {
                        if (publicMessages[i].id) {
                            lastId = publicMessages[i].id;
                            break;
                        }
                    }
                }
                var res = await s3.rpc('get_public_messages', {
                    p_after_id: lastId,
                    p_limit: 20
                });
                if (res.error || !res.data || !Array.isArray(res.data)) return;
                if (res.data.length === 0) return;
                res.data.reverse().forEach(function(msg) {
                    if (publicMessageById.has(msg.id)) return;
                    handlePublicMessage(msg);
                    updatePublicEntry();
                    var container = document.getElementById('publicMessages');
                    if (container && !container._userScrolledUp) {
                        scrollToBottom(container);
                        updateScrollButton(container);
                    }
                });
            } catch (e) { /* silent fail */ }
        }

        async function loadPublicHistory() {
            try {
                const res = await s3.rpc('get_public_messages', { p_limit: HISTORY_LIMIT });
                if (res.error || !Array.isArray(res.data)) {
                    console.error('loadPublicHistory error:', res.error);
                    if (publicMessages.length === 0) {
                        addPublicSystemMsg('加载历史消息失败');
                    } else {
                        // v070: 已有本地缓存时保留展示，不显示失败提示
                        publicHasMore = false;
                        if (typeof showSnackbar === 'function') showSnackbar('网络异常，正在显示本地缓存记录');
                    }
                    return;
                }
                const data = res.data;
                const el = document.querySelector('#publicMessages .system-msg');
                if (el) el.remove();
                if (!data || data.length === 0) {
                    publicHasMore = false;
                    return;
                }
                publicHasMore = data.length >= HISTORY_LIMIT;
                _sortMsgAsc(data).forEach(m => handlePublicMessage(m, true));
                const senders = [...new Set(data.map(m => m.sender).filter(s => s && s !== 'system'))];
                await loadUserAvatars(senders);
                document.querySelectorAll('#publicMessages .msg-row .avatar').forEach(av => {
                    const sender = av.dataset.sender;
                    if (sender && userAvatarCache[sender]) {
                        av.style.backgroundImage = `url(${userAvatarCache[sender]})`;
                        av.textContent = '';
                    }
                });
                const container = document.getElementById('publicMessages');
                if (container) {
                    setTimeout(() => {
                        scrollToBottom(container);
                        updateScrollButton(container);
                    }, 50);
                }
            } catch (e) {
                console.error('loadPublicHistory exception:', e);
            }
        }

        async function loadMorePublicMessages() {
            if (publicLoadingMore || publicMessages.length === 0) return;
            publicLoadingMore = true;
            showPublicLoadMore(true);
            try {
                const oldestId = publicMessages[0].id;
                const res = await s3.rpc('get_public_messages', {
                    p_before_id: oldestId,
                    p_limit: PAGE_SIZE
                });
                const data = res.error ? null : (res.data || []);
                if (!data || data.length === 0) {
                    publicHasMore = false;
                    return;
                }
                const senders = [...new Set(data.map(m => m.sender).filter(s => s && s !== 'system'))];
                await loadUserAvatars(senders);
                const newMsgs = data.reverse().map(msg => ({
                    id: msg.id, sender: msg.sender, sender_uid: msg.sender_uid || 0, text: msg.text || '',
                    image_url: msg.image_url || null, audio_url: msg.audio_url || null,
                    audio_dur: msg.audio_dur || 0, msg_version: msg.msg_version || null,
                    created_at: msg.created_at, reply_to_id: msg.reply_to_id || null,
                    reply_content: msg.reply_content || null, sender_deleted: msg.sender_deleted || false,
                    is_system: msg.is_system || false
                }));
                const unique = newMsgs.filter(m => !publicMessageById.has(m.id));
                const filtered = unique.filter(m => !(m.is_system && isGarbledText(m.text)));
                publicMessages = filtered.concat(publicMessages);
                filtered.forEach(m => publicMessageById.set(m.id, m));
                const container = document.getElementById('publicMessages');
                const prevScrollHeight = container.scrollHeight;
                const prevScrollTop = container.scrollTop;
                // v073 性能优化：仅渲染新增的旧消息并批量插入（DocumentFragment），
                // 不再整列表销毁重建（保留已渲染消息的 DOM、图片加载态与滚动状态）
                const frag = document.createDocumentFragment();
                if (filtered.length) {
                    publicLastDateLabel = '';
                    filtered.forEach(m => renderPublicMessage(m, frag));
                }
                container.insertBefore(frag, container.firstChild);
                requestAnimationFrame(() => {
                    container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
                });
            } catch (e) {
                console.error('loadMorePublicMessages error:', e);
            } finally {
                publicLoadingMore = false;
                showPublicLoadMore(false);
            }
        }

        async function ensureAgentUserAccount(agentName) {
            // 智能体账号由服务端创建；本地仅确保头像缓存已初始化
            try {
                if (!userAvatarCache.hasOwnProperty(agentName)) {
                    userAvatarCache[agentName] = '';
                }
            } catch (e) { /* ignore */ }
        }

        // callLLM removed - AI calls now go through server-side call_agent_llm RPC
        // API keys are NEVER exposed to the client

        async function safeInsertPrivateMsg(sessionId, sender, content) {
            try {
                const { data: rpcData, error: rpcError } = await s3.rpc('send_private_message', {
                    p_session_id: sessionId,
                    p_sender_uid: currentUid,
                    p_content: content,
                    p_session_token: getSessionToken()
                });
                if (!rpcError && rpcData && rpcData.success === false) {
                    throw new Error(rpcData.message || '发送失败');
                } else if (!rpcError && rpcData && rpcData.success !== false && rpcData.message) {
                    return rpcData.message;
                }
                if (rpcError) throw rpcError;
            } catch (e) {
                throw e;
            }
            throw new Error('发送失败: 私聊RPC不可用');
        }

        async function loadPrivateSessions() {
            try {
                let sessions = null;
                try {
                    const { data: rpcData, error: rpcError } = await s3.rpc('get_private_sessions', { p_uid: currentUid });
                    if (!rpcError && rpcData) {
                        sessions = Array.isArray(rpcData) ? rpcData : [];
                    }
                } catch (e) { /* RPC not found, fallback */ }
                if (!sessions) {
                    // v070: 离线回退——用本地加密缓存恢复会话列表
                    const cachedSessions = getCachedSessions();
                    if (cachedSessions && cachedSessions.length) {
                        window.privateSessions = cachedSessions;
                        renderPrivateList();
                        return window.privateSessions;
                    }
                    return;
                }
                // v080: 会话归属按 uid 判断（旧会话无 user1_uid/user2_uid 时回退用户名）
                const filtered = sessions.filter(s => {
                    const u1 = s.user1_uid || 0, u2 = s.user2_uid || 0;
                    if (u1) {
                        if (u1 === currentUid) return !s.deleted_by_user1;
                        if (u2 === currentUid) return !s.deleted_by_user2;
                        return false;
                    }
                    if (s.user1 === currentUser) return !s.deleted_by_user1;
                    if (s.user2 === currentUser) return !s.deleted_by_user2;
                    return false;
                });
                window.privateSessions = filtered;
                window._privateSessionsSig = _hashPrivateSessions(filtered);
                // v070: 缓存会话列表，供离线时恢复私聊入口
                setCachedSessions(filtered);
                const otherUsers = filtered.map(s => {
                    const u1 = s.user1_uid || 0, u2 = s.user2_uid || 0;
                    if (u1) return u1 === currentUid ? s.user2 : s.user1;
                    return s.user1 === currentUser ? s.user2 : s.user1;
                });
                await loadUserAvatars(otherUsers);
                renderPrivateList();
                return filtered;
            } catch (e) {
                console.error('loadPrivateSessions exception:', e);
                return [];
            }
        }

        async function createPrivateSession(otherUser, otherUid) {
            if (otherUser === currentUser) { showSnackbar('不能和自己私聊'); return null; }
            try {
                // v080: 会话双方以 uid 标识；调用方未提供对方 uid 时按用户名解析
                if (!otherUid) {
                    otherUid = await resolveUserUid(otherUser);
                }
                if (!otherUid) { showSnackbar('用户不存在'); return null; }
                const { data: rpcData, error: rpcError } = await s3.rpc('create_private_session', {
                    p_user1_uid: currentUid,
                    p_user2_uid: otherUid
                });
                if (!rpcError && rpcData && rpcData.success !== false && rpcData.session_id) {
                    return rpcData.session_id;
                }
                const failMsg = (rpcData && rpcData.message) || (rpcError && rpcError.message) || '创建私聊失败';
                showSnackbar(failMsg);
                return null;
            } catch (e) { showSnackbar('创建私聊失败'); return null; }
        }

        async function updatePrivateChatStatus() {
            if (!privateOtherUser || !privateChatActive) return;
            const statusEl = document.getElementById('privateChatStatus');
            if (!statusEl) return;
            const status = await resolveUserStatus(privateOtherUser);
            // 在线状态已随 Realtime 移除；仅展示服务端账号状态（封禁/注销）
            const textMap = { banned: '已封禁', deleted: '已注销' };
            statusEl.textContent = textMap[status] || '';
            statusEl.className = 'private-status';
        }

        async function loadPrivateMessages(sessionId, notifyNew) {
            try {
                let messages = null;
                try {
                    const { data: rpcData, error: rpcError } = await s3.rpc('get_private_messages', {
                        p_session_id: sessionId,
                        p_uid: currentUid,
                        p_session_token: getSessionToken(),
                        p_limit: PAGE_SIZE
                    });
                    if (!rpcError && rpcData) {
                        if (Array.isArray(rpcData)) {
                            messages = rpcData;
                        } else if (rpcData.success === false) {
                            console.error('loadPrivateMessages access denied:', rpcData.message);
                            return;
                        }
                    }
                } catch (e) { /* RPC error */ }
                let usedCache = false;
                if (!messages) {
                    // v070: 离线回退——使用本地加密缓存
                    const cached = getPrivateMsgCache(sessionId);
                    if (cached && cached.length) {
                        messages = cached;
                        usedCache = true;
                    } else {
                        console.error('loadPrivateMessages: RPC unavailable or failed');
                        return;
                    }
                }
                const prevIds = notifyNew ? new Set(privateMessages.map(m => m.id)) : null;
                // v071: 服务端重拉后，合并上次缓存中的译文，避免重新渲染时丢失（屏蔽词仅公聊，不涉及私聊）
                if (!usedCache) {
                    const cached = getPrivateMsgCache(sessionId);
                    if (cached && cached.length) {
                        const cachedById = {};
                        cached.forEach(function(cm) { if (cm && cm.id) cachedById[cm.id] = cm; });
                        messages.forEach(function(m) {
                            const cm = cachedById[m.id];
                            if (cm) {
                                if (typeof cm.translation === 'string') m.translation = cm.translation;
                            }
                        });
                    }
                }
                if (notifyNew && privateMessages.length > 0) {
                    // v073: 轮询改为增量合并——保留上滑已加载的更早消息，只并入新拉到/缓存的消息，
                    // 避免轮询整体替换把列表截断回最新一页
                    const mergedById = new Map(privateMessages.map(m => [m.id, m]));
                    messages.forEach(function(m) {
                        if (m && m.id && !mergedById.has(m.id)) mergedById.set(m.id, m);
                    });
                    privateMessages = _sortMsgAsc(Array.from(mergedById.values()));
                } else {
                    // 服务端返回顺序不做信任（RPC 可能是升序/非确定序），统一按时间正序排序，
                    // 避免旧消息被 reverse 后跑到列表底部（离线缓存同样正序排序）
                    privateMessages = _sortMsgAsc(messages);
                    privateHasMore = usedCache ? false : privateMessages.length === PAGE_SIZE;
                }
                const c = document.getElementById('privateMessages');
                // v08x 滚动修复：重渲染前记录是否贴底，渲染后保持贴底（避免新消息落在视野之外）
                const wasAtBottom = isScrolledToBottom(c);
                c.innerHTML = '';
                privateLastDateLabel = '';
                if (privateMessages.length > 0) {
                    // v073 性能优化：DocumentFragment 批量插入，避免逐条 append 反复触发布局
                    const frag = document.createDocumentFragment();
                    privateMessages.forEach(m => renderPrivateMessage(m, frag));
                    c.appendChild(frag);
                    const senders = [...new Set(privateMessages.map(m => m.sender))];
                    await loadUserAvatars(senders);
                    document.querySelectorAll('#privateMessages .msg-row .avatar').forEach(av => {
                        const sender = av.dataset.username;
                        if (sender && userAvatarCache[sender]) {
                            av.style.backgroundImage = `url(${userAvatarCache[sender]})`;
                            av.textContent = '';
                        }
                    });
                }
                if (wasAtBottom && c && !c._userScrolledUp) {
                    scrollToBottom(c);
                    updateScrollButton(c);
                }
                // 网络不佳时实时广播可能丢失，轮询补拉发现的新消息需要正常播放提示音（免打扰时不播放）
                if (notifyNew && prevIds && !usedCache) {
                    const fresh = privateMessages.filter(m => !prevIds.has(m.id) && !isMsgFromMe(m));
                    if (fresh.length > 0 && !_mutePerPrivateSession[privateSessionId] && getPrivateNotifyEnabled() &&
                        !document.getElementById('privatePage').classList.contains('active')) {
                        playNotifySound();
                    }
                }
                // v070: 拉取成功后更新本地加密缓存
                if (!usedCache) {
                    upsertPrivateMsgCache(sessionId, privateMessages);
                }
            } catch (e) { /* ignore */ }
        }

        async function loadMorePrivateMessages(sessionId) {
            if (privateLoadingMore || !privateHasMore || privateMessages.length === 0) return;
            privateLoadingMore = true;
            showPrivateLoadMore(true);
            try {
                const oldest = privateMessages[0].created_at;
                let moreMessages = null;
                try {
                    // RPC get_private_messages 固定返回最新 p_limit 条（无游标参数），
                    // 通过把 limit 放大到「已加载条数 + 一页」，再按 id/时间过滤出尚未加载的更早一页。
                    const loadedIds = new Set(privateMessages.map(m => m.id));
                    const needLimit = Math.min(privateMessages.length + PAGE_SIZE, 1000);
                    const { data: rpcData, error: rpcError } = await s3.rpc('get_private_messages', {
                        p_session_id: sessionId,
                        p_uid: currentUid,
                        p_session_token: getSessionToken(),
                        p_limit: needLimit
                    });
                    if (!rpcError && rpcData && Array.isArray(rpcData)) {
                        moreMessages = rpcData
                            .filter(m => new Date(m.created_at) < new Date(oldest) && !loadedIds.has(m.id))
                            .slice(0, PAGE_SIZE);
                    }
                } catch (e) { /* RPC error */ }
                if (!moreMessages) {
                    privateHasMore = false;
                    return;
                }
                if (!moreMessages || moreMessages.length === 0) {
                    privateHasMore = false;
                    return;
                }
                const senders = [...new Set(moreMessages.map(m => m.sender))];
                await loadUserAvatars(senders);
                const unique = _sortMsgAsc(moreMessages).filter(m => !privateMessages.some(e => e.id === m.id));
                privateMessages = unique.concat(privateMessages);
                upsertPrivateMsgCache(sessionId, privateMessages);
                const container = document.getElementById('privateMessages');
                const prevScrollHeight = container.scrollHeight;
                const prevScrollTop = container.scrollTop;
                // v073 性能优化：仅渲染新增的更早消息并批量插入，保留已渲染消息与滚动状态
                const frag = document.createDocumentFragment();
                if (unique.length) {
                    privateLastDateLabel = '';
                    unique.forEach(m => renderPrivateMessage(m, frag));
                }
                container.insertBefore(frag, container.firstChild);
                requestAnimationFrame(() => {
                    container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
                });
            } catch (e) {
                console.error('loadMorePrivateMessages error:', e);
            } finally {
                privateLoadingMore = false;
                showPrivateLoadMore(false);
            }
        }

        function subscribePrivateChannel(sessionId) {
            // 已移除 Supabase Realtime：私聊新消息统一由 loadPrivateMessages 轮询驱动，
            // 本函数保留为空实现以兼容旧调用方（openPrivateChat 等）。
            void sessionId;
        }

        async function deletePrivateChat() {
            if (!privateSessionId || !privateChatActive) return;
            if (!confirm(`确定要删除与 ${privateOtherUser} 的聊天吗？\n删除后双方的所有聊天记录将被彻底清除。`)) return;
            const sessionIdToDelete = privateSessionId;
            const otherUserToDelete = privateOtherUser;
            try {
                let deleted = false;
                try {
                    const { data: rpcData, error: rpcError } = await s3.rpc('delete_private_session', {
                        p_session_id: sessionIdToDelete,
                        p_uid: currentUid,
                        p_session_token: getSessionToken()
                    });
                    if (!rpcError && rpcData && rpcData.success) {
                        deleted = true;
                    } else if (rpcData && rpcData.success === false) {
                        showSnackbar(rpcData.message || '删除失败');
                        return;
                    } else if (rpcError) {
                        showSnackbar('删除失败: ' + rpcError.message);
                        return;
                    }
                } catch (e) {
                    showSnackbar('删除失败: ' + (e.message || ''));
                    return;
                }
                // 已移除实时广播：对方会话列表由轮询自动感知（会话被删除后不再出现）
                window.privateSessions = (window.privateSessions || []).filter(s => s.id !== sessionIdToDelete);
                showSnackbar('已删除聊天');
                leavePrivateChat();
            } catch (e) { showSnackbar('删除失败: ' + (e.message || '')); }
        }

        async function loadAgentList() {
            const container = document.getElementById('agentListContainer');
            container.innerHTML = '<p style="text-align:center;color:var(--md-on-surface-variant);">加载中...</p>';
            try {
                let agents = null;
                try {
                    const { data: rpcData, error: rpcError } = await s3.rpc('get_agents');
                    if (!rpcError && rpcData !== null && rpcData !== undefined) {
                        agents = Array.isArray(rpcData) ? rpcData : [];
                    }
                } catch (e) { /* ignore */ }
                if (!agents) agents = [];
                // v049: 只显示 enabled 的智能体
                agents = agents.filter(function(a){ return a.enabled !== false; });
                if (!agents || agents.length === 0) {
                    container.innerHTML = '<p style="text-align:center;color:var(--md-on-surface-variant);">暂无智能体</p>';
                    return;
                }
                const providerLabels = {
                    'openai': 'OpenAI', 'google': 'Google', 'anthropic': 'Anthropic',
                    'baidu': '百度', 'ali': '阿里', 'bytedance': '字节', 'zhipu': '智谱',
                    'deepseek': 'DeepSeek', 'custom': '自定义'
                };
                const agentNames = agents.map(a => a.name).filter(Boolean);
                if (agentNames.length > 0) {
                    await loadUserAvatars(agentNames);
                }
                container.innerHTML = agents.map(agent => {
                    const canDelete = (agent.created_by === currentUser);
                    const providerText = providerLabels[agent.provider] || agent.provider || '自定义';
                    const modelText = agent.model ? ' · ' + escapeHtml(agent.model) : '';
                    const isActive = activeAgent && activeAgent.id === agent.id;
                    const avatarIdx = hashStr(agent.name) % 8;
                    let avatarStyle = '';
                    if (userAvatarCache[agent.name]) {
                        avatarStyle = 'background-image:url(' + escapeAttr(sanitizeAvatarUrl(userAvatarCache[agent.name])) + ');';
                    }
                    var activeStyle = isActive ? 'border-color:var(--md-primary);background:var(--md-primary-container);' : '';
                    var useBtnStyle = 'background:' + (isActive ? 'var(--md-primary)' : 'transparent') + ';color:' + (isActive ? '#fff' : 'var(--md-primary)') + ';border:1px solid var(--md-primary);border-radius:8px;padding:6px 16px;font-size:0.75rem;font-weight:500;cursor:pointer;';
                    return '<div class="agent-item" style="' + activeStyle + '">' +
                                '<div class="avatar av-' + avatarIdx + '" style="' + avatarStyle + '">' + (userAvatarCache[agent.name] ? '' : escapeHtml(agent.name.charAt(0).toUpperCase())) + '</div>' +
                                '<div class="info">' +
                                    '<div class="name">' + escapeHtml(agent.name) + (isActive ? ' <span style="color:var(--md-primary);font-size:0.7rem;">使用中</span>' : '') + '</div>' +
                                    '<div class="provider">' + escapeHtml(providerText) + modelText + '</div>' +
                                    '<div class="creator">添加者：' + escapeHtml(agent.created_by || '未知') + '</div>' +
                                '</div>' +
                                '<div style="display:flex;gap:8px;align-items:center;">' +
                                    '<button class="use-agent-btn" onclick="useAgent(\'' + escapeJsString(agent.id) + '\')" style="' + useBtnStyle + '">' + (isActive ? '取消' : '使用') + '</button>' +
                                    (canDelete ? '<button class="delete-btn" onclick="deleteAgent(\'' + escapeJsString(agent.id) + '\')"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>' : '') +
                                '</div>' +
                            '</div>';
                }).join('');
            } catch (e) {
                container.innerHTML = '<p style="text-align:center;color:var(--md-on-surface-variant);">加载失败：' + escapeHtml(e.message || '未知错误') + '</p>';
            }
        }

        async function deleteAgent(agentId) {
            if (!confirm('确定要删除此智能体吗？\n智能体的用户账号也将被删除。')) return;
            try {
                const { data: rpcData, error: rpcError } = await s3.rpc('delete_agent_rpc', {
                    p_agent_id: agentId,
                    p_username: currentUser,
                    p_session_token: getSessionToken()
                });
                if (rpcError) { showSnackbar('删除失败: ' + rpcError.message); return; }
                if (rpcData && rpcData.success === false) {
                    showSnackbar(rpcData.message || '删除失败'); return;
                }
                showSnackbar('智能体已删除');
                loadAgentList();
            } catch (e) { showSnackbar('删除失败'); }
        }

        async function saveAgent() {
            const name = document.getElementById('agentName').value.trim();
            const provider = document.getElementById('agentProvider').value;
            const apiKey = document.getElementById('agentApiKey').value.trim();
            const model = document.getElementById('agentModel').value.trim() || 'gpt-3.5-turbo';
            if (!name) { showSnackbar('请输入智能体名称'); return; }
            if (!apiKey) { showSnackbar('请输入 API Key'); return; }
            try {
                // v082: API Key 经本机 Tauri IPC 明文传输给后端，由后端 AES-256-GCM 加密落盘；
                // 不再前端单向哈希（哈希后后端无法用于调用 LLM），API Key 永不回传前端
                const { data: rpcData, error: rpcError } = await s3.rpc('save_agent', {
                    p_name: name,
                    p_provider: provider,
                    p_api_key: apiKey,
                    p_model: model,
                    p_created_by: currentUser,
                    p_session_token: getSessionToken()
                });
                if (rpcError) { showSnackbar('保存失败: ' + rpcError.message); return; }
                if (rpcData && rpcData.success === false) {
                    showSnackbar(rpcData.message || '保存失败'); return;
                }
                showSnackbar('智能体已添加');
                document.getElementById('agentApiKey').value = '';
                closeAddAgentDialog();
                broadcastSystemMsg(`智能体 ${name} 已加入聊天室`);
                loadAgentList();
            } catch (e) {
                showSnackbar('保存失败');
            }
        }

        function showChangePasswordDialog() {
            document.getElementById('changePasswordDialog').classList.remove('hidden');
            document.getElementById('changeOldPassword').value = '';
            document.getElementById('changeNewPassword').value = '';
            document.getElementById('changeConfirmPassword').value = '';
        }

        function closeChangePasswordDialog() {
            document.getElementById('changePasswordDialog').classList.add('hidden');
        }

        async function doChangePassword() {
            const oldPwd = document.getElementById('changeOldPassword').value;
            const newPwd = document.getElementById('changeNewPassword').value;
            const confirmPwd = document.getElementById('changeConfirmPassword').value;
            if (!oldPwd || !newPwd || !confirmPwd) {
                showSnackbar('请完整填写密码字段');
                return;
            }
            if (newPwd.length < 6) {
                showSnackbar('新密码至少6位');
                return;
            }
            if (newPwd !== confirmPwd) {
                showSnackbar('两次输入的新密码不一致');
                return;
            }
            const oldHash = await hashPassword(oldPwd);
            const newHash = await hashPassword(newPwd);
            let newSessionToken = null;
            const { data: changeData, error: secureError } = await s3.rpc('change_password_secure', {
                p_uid: currentUid,
                p_old_password_hash: oldHash,
                p_new_password_hash: newHash
            });
            if (secureError) {
                showSnackbar('更改密码失败: ' + secureError.message);
                return;
            }
            if (changeData && changeData.success === false) {
                showSnackbar(changeData.message || '更改密码失败');
                return;
            }
            newSessionToken = changeData.session_token || null;
            if (newSessionToken) {
                localStorage.setItem(LS_KEYS.SESSION, JSON.stringify({ username: currentUser, uid: currentUid, token: newSessionToken, pwhash: newHash }));
                // Re-initialize encrypted settings with new password hash
                initUserSettings(newHash, currentUser).catch(function(e) { console.warn('initUserSettings failed:', e); });
            }
            showSnackbar('密码更改成功');
            closeChangePasswordDialog();
        }

        /* Removed: cleanupGarbledMsgs */

        function logout() {
            if (privatePollTimer) { clearInterval(privatePollTimer); privatePollTimer = null; }
            // v040: Clean up public chat polling timers
            if (_publicPollTimer) { clearInterval(_publicPollTimer); _publicPollTimer = null; }
            if (_publicBackupPollTimer) { clearInterval(_publicBackupPollTimer); _publicBackupPollTimer = null; }
            _publicRetryCount = 0;
            // 清理登出后仍会运行的后台定时器
            if (privateStatusInterval) { clearInterval(privateStatusInterval); privateStatusInterval = null; }
            if (_cloudControlInterval) { clearInterval(_cloudControlInterval); _cloudControlInterval = null; }
            localStorage.removeItem(LS_KEYS.SESSION);
            // v053: 登出时重置免打扰状态
            _mutePublic = false;
            _mutePerPrivateSession = {};
            localStorage.removeItem(LS_KEYS.PUBLIC_MUTED);
            localStorage.removeItem(LS_KEYS.PRIVATE_MUTED);
            currentUser = '';
            currentUid = 0;
            publicMessages = [];
            publicMessageById.clear();
            privateMessages = [];
            isEntered = false;
            privateChatActive = false;
            publicUnread = 0;
            privateUnreadCounts = {};
            userAvatarCache = {};
            publicHasMore = true;
            privateHasMore = true;
            publicLoadingMore = false;
            privateLoadingMore = false;
            document.getElementById('authContainer').style.display = 'flex';
            document.getElementById('appContainer').style.display = 'none';
            document.getElementById('loginScreen').classList.remove('hidden');
            document.getElementById('registerScreen').classList.add('hidden');
            document.getElementById('loginUsername').value = '';
            document.getElementById('loginPassword').value = '';
            hideGlobalLoading();
            // v038: Reset banner dismissal so it can show again after logout
            try { sessionStorage.removeItem(LS_KEYS.BANNER_DISMISSED); } catch (e) {}
            window._bannerManuallyDismissed = false;
            clearEncryptionKey();
            // v041: Reset force_logout tracking on logout
            _forceLogoutAllProcessed = false;
            showLogin();
        }

        async function deleteAccount() {
            if (!currentUser) return;
            // v043: 用自定义模态对话框替代原生 prompt，防止浏览器弹窗被脚本注入
            showDeleteAccountModal();
        }

        // v043: 账号注销专用模态对话框
        function showDeleteAccountModal() {
            var existing = document.getElementById('deleteAccountModalDyn');
            if (existing) existing.remove();

            var overlay = document.createElement('div');
            overlay.id = 'deleteAccountModalDyn';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:100000;animation:fade-in 0.2s ease;';

            var dialog = document.createElement('div');
            dialog.style.cssText = 'background:var(--md-surface-container-high, #1c1c1e);border-radius:8px;padding:24px;max-width:350px;width:86vw;box-shadow:var(--md-elevation-8, 0 8px 32px rgba(0,0,0,0.4));';

            var title = document.createElement('h2');
            title.textContent = '注销账号';
            title.style.cssText = 'margin:0 0 12px 0;font-size:1.1rem;color:var(--md-on-surface, #fff);';
            dialog.appendChild(title);

            var desc = document.createElement('p');
            desc.textContent = '请输入您的密码以确认注销账号：\n注销后，您的所有数据将被永久删除，此操作不可恢复。';
            desc.style.cssText = 'margin:0 0 16px 0;font-size:0.8rem;color:var(--md-on-surface-variant, #aaa);white-space:pre-line;line-height:1.5;';
            dialog.appendChild(desc);

            var inputContainer = document.createElement('div');
            inputContainer.style.cssText = 'width:100%;margin-bottom:16px;position:relative;';
            var input = document.createElement('input');
            input.type = 'password';
            input.id = 'deleteAccountPasswordInput';
            input.placeholder = ' ';
            input.style.cssText = 'width:100%;padding:12px 0;background:transparent;border:none;border-bottom:1px solid var(--md-outline, #555);color:var(--md-on-surface, #fff);font-size:1rem;outline:none;';
            input.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') doDeleteAccountConfirm();
            });
            inputContainer.appendChild(input);
            var label = document.createElement('label');
            label.textContent = '账号密码';
            label.style.cssText = 'position:absolute;left:0;bottom:32px;font-size:0.75rem;color:var(--md-on-surface-variant, #888);pointer-events:none;';
            inputContainer.appendChild(label);
            dialog.appendChild(inputContainer);

            var errorEl = document.createElement('div');
            errorEl.id = 'deleteAccountError';
            errorEl.style.cssText = 'color:var(--md-error, #cf6679);font-size:0.75rem;margin-bottom:8px;display:none;';
            dialog.appendChild(errorEl);

            var actions = document.createElement('div');
            actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
            var cancelBtn = document.createElement('button');
            cancelBtn.textContent = '取消';
            cancelBtn.style.cssText = 'background:transparent;color:var(--md-on-surface, #fff);border:none;border-radius:8px;font-size:0.875rem;padding:10px 20px;cursor:pointer;font-weight:500;';
            cancelBtn.addEventListener('click', function() { overlay.remove(); });
            actions.appendChild(cancelBtn);
            var okBtn = document.createElement('button');
            okBtn.textContent = '确认注销';
            okBtn.id = 'deleteAccountConfirmBtn';
            okBtn.style.cssText = 'background:var(--md-error, #cf6679);color:#fff;border:none;border-radius:8px;font-size:0.875rem;padding:10px 20px;cursor:pointer;font-weight:500;';
            okBtn.addEventListener('click', function() { doDeleteAccountConfirm(); });
            actions.appendChild(okBtn);
            dialog.appendChild(actions);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            setTimeout(function() { input.focus(); }, 100);
        }

        async function doDeleteAccountConfirm() {
            var input = document.getElementById('deleteAccountPasswordInput');
            var errorEl = document.getElementById('deleteAccountError');
            var okBtn = document.getElementById('deleteAccountConfirmBtn');
            if (!input) return;
            var password = input.value;
            errorEl.style.display = 'none';
            if (!password) {
                errorEl.textContent = '请输入密码';
                errorEl.style.display = 'block';
                return;
            }
            if (okBtn) {
                okBtn.textContent = '注销中...';
                okBtn.disabled = true;
                okBtn.style.opacity = '0.6';
            }
            var passwordHash = await hashPassword(password);
            var overlay = document.getElementById('deleteAccountModalDyn');
            const classifyDeleteError = (rawMsg) => {
                const msg = (rawMsg || '') + '';
                if (msg.includes('Could not find') || msg.includes('schema cache') || msg.includes('delete_my_account')) {
                    return '注销功能暂不可用，请联系管理员';
                }
                if (msg.toLowerCase().includes('password') || msg.includes('身份') || msg.includes('验证')) {
                    return '密码错误，请重试';
                }
                return '注销失败: ' + msg;
            };
            try {
                const { data, error } = await s3.rpc('delete_my_account', {
                    p_uid: currentUid,
                    p_password_hash: passwordHash
                });
                if (error) {
                    if (overlay) overlay.remove();
                    showSnackbar(classifyDeleteError(error.message));
                    return;
                }
                if (data && data.success === false) {
                    if (overlay) overlay.remove();
                    showSnackbar(data.message || '密码错误，请重试');
                    return;
                }
                if (overlay) overlay.remove();
                localStorage.removeItem(LS_KEYS.SESSION);
                // v070: 账号注销时同步清除本地聊天记录缓存
                // v073: 升级为彻底清除本地数据（AI 设置含 API Key、用户配置、密钥盐、消息缓存）
                clearAllUserLocalData();
                showSnackbar('账号已彻底注销');
                setTimeout(function() {
                    location.reload();
                }, 500);
            } catch (e) {
                if (overlay) overlay.remove();
                showSnackbar(classifyDeleteError(e && e.message));
            }
        }

        async function resolveUserStatus(username) {
            if (!username) return 'offline';
            try {
                const { data: rpcData, error: rpcError } = await s3.rpc('get_user_profile', { p_username: username });
                if (!rpcError && rpcData) {
                    if (rpcData.success === false) return 'deleted';
                    return rpcData.banned ? 'banned' : 'offline';
                }
            } catch (e) { /* ignore */ }
            return 'offline';
        }

        // 向服务端核实账号真实状态（banned/deleted/active），用于抵御伪造的广播事件
        async function verifyServerAccountState(username) {
            if (!username) return 'unknown';
            try {
                const { data: rpcData, error: rpcError } = await s3.rpc('get_user_profile', { p_username: username });
                if (!rpcError && rpcData) {
                    if (rpcData.success === false) return 'deleted';
                    return rpcData.banned ? 'banned' : 'active';
                }
            } catch (e) { /* ignore */ }
            return 'unknown';
        }

        // Apply a status to an avatar's status dot, and grey-out the avatar when
        // the user is banned or deleted.
        async function toggleBlockUser() {
            if (!privateOtherUser) return;
            const newBlockState = !privateBlockedStatus;
            try {
                const { data: rpcData, error: rpcError } = await s3.rpc('toggle_block_user', {
                    p_blocker_uid: currentUid,
                    p_blocked_uid: privateOtherUid || 0,
                    p_block: newBlockState
                });
                if (rpcError) { showSnackbar('操作失败: ' + rpcError.message); return; }
                if (rpcData && rpcData.success === false) {
                    showSnackbar(rpcData.message || '操作失败'); return;
                }
                privateBlockedStatus = newBlockState;
                showSnackbar(newBlockState ? '已加入黑名单' : '已移出黑名单');
            } catch (e) { showSnackbar('操作失败'); }
        }

        // v053: 群聊免打扰切换
        function togglePublicMute() {
            _mutePublic = !_mutePublic;
            showSnackbar(_mutePublic ? '已开启群聊消息免打扰' : '已关闭群聊消息免打扰');
            try { localStorage.setItem(LS_KEYS.PUBLIC_MUTED, _mutePublic ? '1' : '0'); } catch(e) {}
            updatePublicMenu();
            updatePublicBadge();
            updateBackBadge();
        }

        // v053: 私聊按会话免打扰切换
        function togglePrivateMute() {
            if (!privateSessionId) return;
            const cur = !!_mutePerPrivateSession[privateSessionId];
            _mutePerPrivateSession[privateSessionId] = !cur;
            showSnackbar(!cur ? '已开启消息免打扰' : '已关闭消息免打扰');
            try { localStorage.setItem(LS_KEYS.PRIVATE_MUTED, JSON.stringify(_mutePerPrivateSession)); } catch(e) {}
            updatePrivateMenu();
            renderPrivateList();
            updateBackBadge();
        }

        // v046: 检测消息文本中是否@提到了当前用户
        function _checkMention(text) {
            if (!text || !currentUser) return false;
            var mentionPattern = '@' + currentUser;
            return text.indexOf(mentionPattern) !== -1;
        }

        async function loadBlocklist() {
            const container = document.getElementById('blocklistContainer');
            container.innerHTML = '<p style="text-align:center;color:var(--md-on-surface-variant);">加载中...</p>';
            try {
                const { data: rpcData, error: rpcError } = await s3.rpc('get_blocked_users', {
                    p_uid: currentUid
                });
                if (rpcError) { container.innerHTML = '<p>加载失败</p>'; return; }
                const blocked = rpcData || [];
                if (blocked.length === 0) {
                    container.innerHTML = '<p style="text-align:center;color:var(--md-on-surface-variant);">黑名单为空</p>';
                    return;
                }
                container.innerHTML = blocked.map(u =>
                    `<div class="block-item">
                        <span class="name">${escapeHtml(u.username || u.blocked)}</span>
                        <button class="unblock-btn" onclick="unblockUser('${escapeJsString(String(u.blocked))}')">移除</button>
                    </div>`
                ).join('');
            } catch (e) { container.innerHTML = '<p>加载失败</p>'; }
        }

        async function unblockUser(blockedUidStr) {
            const blockedUid = parseInt(blockedUidStr, 10) || 0;
            if (!blockedUid) { showSnackbar('无效用户'); return; }
            try {
                const { data: rpcData, error: rpcError } = await s3.rpc('toggle_block_user', {
                    p_blocker_uid: currentUid,
                    p_blocked_uid: blockedUid,
                    p_block: false
                });
                if (rpcError) { showSnackbar('操作失败: ' + rpcError.message); return; }
                showSnackbar('已移出黑名单');
                loadBlocklist();
            } catch (e) { showSnackbar('操作失败'); }
        }
