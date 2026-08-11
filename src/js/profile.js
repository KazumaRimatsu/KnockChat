/* KnockChat 用户资料模块：用户详情页 / 编辑资料页 / 图片裁剪编辑器（移植自 MJChat v69） */

        // ============ 状态与本地缓存 ============
        let _udTargetUser = null;
        let _udTargetIsSelf = false;
        let _udBgUrl = null;
        let _udProfileData = null;
        let _udUserData = null;

        const _AVATAR_LS_PREFIX = LS_KEYS.AVATAR_PREFIX;
        const _AVATAR_CACHE_MAX = 200;        // v073：头像缓存条目上限，超出按写入顺序淘汰最旧
        const _AVATAR_INDEX_KEY = LS_KEYS.AVATAR_INDEX;

        function _avatarIndex() {
            try {
                const raw = localStorage.getItem(_AVATAR_INDEX_KEY);
                if (raw) {
                    const arr = JSON.parse(raw);
                    if (Array.isArray(arr)) return arr;
                }
            } catch (e) {}
            return [];
        }

        function _pruneAvatarCache() {
            try {
                const idx = _avatarIndex();
                if (idx.length <= _AVATAR_CACHE_MAX) return;
                const excess = idx.length - _AVATAR_CACHE_MAX;
                for (let i = 0; i < excess; i++) {
                    try { localStorage.removeItem(_AVATAR_LS_PREFIX + encodeURIComponent(idx[i])); } catch (e) {}
                }
                localStorage.setItem(_AVATAR_INDEX_KEY, JSON.stringify(idx.slice(excess)));
            } catch (e) {}
        }

        function _lsGetAvatar(username) {
            try { return localStorage.getItem(_AVATAR_LS_PREFIX + encodeURIComponent(username)); } catch (e) { return null; }
        }
        function _lsSetAvatar(username, url) {
            try {
                const key = _AVATAR_LS_PREFIX + encodeURIComponent(username);
                if (url) {
                    localStorage.setItem(key, url);
                    // 维护写入顺序索引，超限时淘汰最旧
                    const idx = _avatarIndex();
                    const k = idx.indexOf(username);
                    if (k !== -1) idx.splice(k, 1);
                    idx.push(username);
                    localStorage.setItem(_AVATAR_INDEX_KEY, JSON.stringify(idx));
                    _pruneAvatarCache();
                } else {
                    localStorage.removeItem(key);
                    const idx = _avatarIndex();
                    const k = idx.indexOf(username);
                    if (k !== -1) { idx.splice(k, 1); localStorage.setItem(_AVATAR_INDEX_KEY, JSON.stringify(idx)); }
                }
            } catch (e) {}
        }

        // v073：背景缓存 TTL（30 天），避免他人更换背景后本地长期显示陈旧 URL
        const _BG_CACHE_PREFIX = LS_KEYS.BG_PREFIX;
        const _BG_CACHE_TTL = 30 * 24 * 3600 * 1000;
        function _bgCacheKey(user) { return _BG_CACHE_PREFIX + user; }
        function _getBgCache(user) {
            try {
                const raw = localStorage.getItem(_bgCacheKey(user));
                if (!raw) return null;
                // 兼容旧版纯 URL 字符串格式
                if (raw.indexOf('{') !== 0) return raw;
                const obj = JSON.parse(raw);
                if (obj && obj.u && obj.t && (Date.now() - obj.t) < _BG_CACHE_TTL) return obj.u;
            } catch (e) {}
            return null;
        }
        function _setBgCache(user, url) {
            try { localStorage.setItem(_bgCacheKey(user), JSON.stringify({ u: url, t: Date.now() })); } catch (e) {}
        }

        // 资料图片加载：字节优先走本地缓存（命中 objectURL，未命中拉取并写入缓存），
        // 缓存不可用/失败时回退原 url 直接加载；onOk 收到最终用于展示的 url
        function _loadProfileImage(url, onOk, onFail) {
            // 统一把（已过期/换 AK 失效的）预签名链接还原为公开直链（see other.js mediaUrlToPublic）
            url = (typeof mediaUrlToPublic === 'function') ? mediaUrlToPublic(url) : url;
            if (!url) { if (onFail) onFail(); return; }
            const load = function(finalUrl) {
                const img = new Image();
                img.onload = function() {
                    // v073 回归修复：finalUrl 若是缓存 objectURL，此处不能提前 revoke——
                    // onOk 会把该 URL 赋给元素 backgroundImage，CSS 背景在赋值后才解码，
                    // 提前 revoke 会导致头像/背景图无法显示。仅错误路径释放。
                    if (onOk) onOk(finalUrl);
                };
                img.onerror = function() {
                    if (typeof revokeImageObjectUrl === 'function') revokeImageObjectUrl(finalUrl);
                    if (onFail) onFail();
                };
                img.src = finalUrl;
            };
            if (typeof getCachedImageUrl === 'function') {
                getCachedImageUrl(url).then(function(src) { load(src || url); });
            } else {
                load(url);
            }
        }

        // ============ 用户详情页 ============
        function openUserDetailPage(username) {
            if (!username) return;
            _udTargetUser = username;
            _udTargetIsSelf = (username === currentUser);
            _udBgUrl = null;
            _udProfileData = null;
            navigateTo('userDetail');
            loadUserDetailPage();
        }

        // 从头像弹窗的「查看资料」按钮进入详情页
        function openUserDetailFromProfile() {
            const usernameEl = document.getElementById('userProfileUsername');
            const username = usernameEl ? usernameEl.textContent : '';
            if (!username || username === '加载中' || username === '-') return;
            closeUserProfile();
            openUserDetailPage(username);
        }

        function closeUserDetailMenu() {
            const overlay = document.getElementById('udMenuOverlay');
            if (overlay) overlay.classList.remove('show');
        }

        async function startPrivateChatFromDetail() {
            if (!_udTargetUser || _udTargetUser === currentUser) return;
            closeUserDetailMenu();
            const sessionId = await createPrivateSession(_udTargetUser);
            if (sessionId) {
                await loadPrivateSessions();
                openPrivateChat(sessionId, _udTargetUser);
            }
        }

        async function loadUserDetailPage() {
            if (!_udTargetUser) return;
            const avatarEl = document.getElementById('udAvatar');
            const nameEl = document.getElementById('udUsername');
            // v090: 昵称旁的 UID（参考 QQ 资料页布局）
            const uidEl = document.getElementById('udUid');
            const statusEl = document.getElementById('udStatusText');
            const bgEl = document.getElementById('udBg');
            const infoList = document.getElementById('udInfoList');
            const editBtn = document.getElementById('udEditBtn');

            // Avatar: 先显示加载动画
            avatarEl.innerHTML = '<div class="md-circular-loader" style="width:24px;height:24px;"><svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="20"/></svg></div>';
            avatarEl.style.backgroundImage = '';
            avatarEl.style.backgroundColor = '#fff';
            avatarEl.className = 'ud-avatar';
            avatarEl.textContent = '';
            nameEl.textContent = _udTargetUser;
            if (uidEl) uidEl.textContent = '';
            statusEl.textContent = '';
            // Info list 加载动画
            infoList.innerHTML = '<div style="text-align:center;padding:40px;"><div class="md-circular-loader" style="width:32px;height:32px;margin:0 auto;"><svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="20"/></svg></div></div>';
            editBtn.style.display = _udTargetIsSelf ? 'flex' : 'none';

            // 背景加载动画
            bgEl.style.backgroundImage = '';
            const bgLoader = document.createElement('div');
            bgLoader.id = 'udBgLoader';
            bgLoader.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1;';
            bgLoader.innerHTML = '<div class="md-circular-loader" style="width:32px;height:32px;color:#fff;"><svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="20"/></svg></div>';
            bgEl.appendChild(bgLoader);

            function removeBgLoader() {
                const loader = document.getElementById('udBgLoader');
                if (loader) loader.remove();
            }

            // 本地缓存背景（立即显示）
            let cachedBgUrl = null;
            try { cachedBgUrl = _getBgCache(_udTargetUser); } catch (ex) { }
            if (cachedBgUrl) {
                _loadProfileImage(cachedBgUrl,
                    function(url) { bgEl.style.backgroundImage = 'url(' + url + ')'; removeBgLoader(); },
                    removeBgLoader);
            }

            // 本地缓存头像（立即显示）
            const cachedAvatarUrl = _lsGetAvatar(_udTargetUser) || userAvatarCache[_udTargetUser] || '';
            if (cachedAvatarUrl) {
                _loadProfileImage(cachedAvatarUrl, function(url) {
                    avatarEl.innerHTML = '';
                    avatarEl.style.backgroundImage = 'url(' + url + ')';
                    avatarEl.style.backgroundColor = '';
                    avatarEl.className = 'ud-avatar av-' + (hashStr(_udTargetUser) % 8);
                });
            }

            try {
                // 优先 RPC 获取完整资料（含邮箱/生日/简介/标签/背景）
                let profileData = null;
                try {
                    const { data: rpcData, error: rpcError } = await s3.rpc('get_user_profile', { p_username: _udTargetUser });
                    if (!rpcError && rpcData && rpcData.success !== false) {
                        profileData = rpcData;
                    }
                } catch (e) { /* ignore */ }

                _udUserData = profileData;
                if (!profileData) {
                    infoList.innerHTML = '<div style="text-align:center;padding:40px;color:var(--md-error);">用户不存在</div>';
                    removeBgLoader();
                    return;
                }

                // 头像：与缓存不同才重新预加载，加载完成后才显示
                if (profileData.avatar_url) {
                    if (profileData.avatar_url !== cachedAvatarUrl) {
                        _loadProfileImage(profileData.avatar_url, function(url) {
                            avatarEl.innerHTML = '';
                            avatarEl.style.backgroundImage = 'url(' + url + ')';
                            avatarEl.style.backgroundColor = '';
                            avatarEl.className = 'ud-avatar av-' + (hashStr(_udTargetUser) % 8);
                        });
                    }
                    userAvatarCache[_udTargetUser] = profileData.avatar_url;
                    _lsSetAvatar(_udTargetUser, profileData.avatar_url);
                } else {
                    avatarEl.innerHTML = '';
                    avatarEl.style.backgroundImage = '';
                    avatarEl.style.backgroundColor = '';
                    avatarEl.textContent = _udTargetUser.charAt(0).toUpperCase();
                    avatarEl.className = 'ud-avatar av-' + (hashStr(_udTargetUser) % 8);
                }

                // 背景：从资料预加载
                const rpcBgUrl = profileData.bg_url || '';
                if (rpcBgUrl && rpcBgUrl !== cachedBgUrl) {
                    _loadProfileImage(rpcBgUrl,
                        function(url) {
                            bgEl.style.backgroundImage = 'url(' + url + ')';
                            removeBgLoader();
                            _setBgCache(_udTargetUser, rpcBgUrl);
                        },
                        removeBgLoader);
                } else if (!rpcBgUrl && !cachedBgUrl) {
                    removeBgLoader();
                }

                nameEl.textContent = _udTargetUser;
                // v090: 昵称旁显示 UID（服务端用户资料含 uid 字段）
                if (uidEl) uidEl.textContent = profileData.uid ? ('UID ' + profileData.uid) : '';

                const banned = !!profileData.banned;
                if (banned) {
                    statusEl.textContent = '已封禁';
                    statusEl.style.color = 'var(--md-error)';
                } else {
                    statusEl.textContent = '正常';
                    statusEl.style.color = '';
                }

                const email = profileData.email || '';
                const birthday = profileData.birthday || '';
                const bio = profileData.bio || '';
                _udProfileData = { email: email, birthday: birthday, bio: bio };

                const items = [];
                items.push({
                    icon: '<path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>',
                    value: email || '未设置',
                    label: '邮箱',
                    isEmpty: !email
                });
                items.push({
                    icon: '<path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM9 10H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z"/>',
                    value: birthday || '未设置',
                    label: '生日',
                    isEmpty: !birthday
                });
                const roleText = profileData.role === 'admin' ? '管理员' : (profileData.role === 'agent' ? '智能体' : '普通用户');
                items.push({
                    icon: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>',
                    value: roleText,
                    label: '身份',
                    isEmpty: false
                });
                items.push({
                    icon: '<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>',
                    value: bio || '未设置',
                    label: '个人简介',
                    isEmpty: !bio
                });

                let html = '';
                for (let i = 0; i < items.length; i++) {
                    html += '<div class="ud-info-item">';
                    html += '<svg class="ud-info-icon" viewBox="0 0 24 24">' + items[i].icon + '</svg>';
                    html += '<div class="ud-info-content">';
                    html += '<div class="ud-info-value' + (items[i].isEmpty ? ' empty' : '') + '">' + escapeHtml(items[i].value) + '</div>';
                    html += '<div class="ud-info-label">' + escapeHtml(items[i].label) + '</div>';
                    html += '</div></div>';
                }
                infoList.innerHTML = html;
            } catch (e) {
                infoList.innerHTML = '<div style="text-align:center;padding:40px;color:var(--md-error);">加载失败: ' + escapeHtml(e.message || '') + '</div>';
                removeBgLoader();
            }
            // v097: 好友操作栏（好友/非好友差异化按钮），独立于资料加载结果渲染
            try {
                if (typeof window.renderDetailActions === 'function') {
                    window.renderDetailActions(_udTargetUser, _udTargetIsSelf);
                }
            } catch (ex) { /* ignore */ }
        }

        // ============ 编辑资料页 ============
        let _epAvatarFile = null;
        let _epBgFile = null;
        let _epAvatarUrl = null;
        let _epBgUrl = null;
        let _epExistingAvatarUrl = null;
        let _epExistingBgUrl = null;

        function openEditProfilePage() {
            // 支持从主页菜单直接进入（此时可能尚未打开过自己的详情页）
            if (!_udTargetUser || _udTargetUser !== currentUser) {
                _udTargetUser = currentUser;
                _udTargetIsSelf = true;
            }
            navigateTo('editProfile');
            loadEditProfilePage();
        }

        function loadEditProfilePage() {
            const epAvatar = document.getElementById('epAvatar');
            const epBg = document.getElementById('epBg');
            const epUsername = document.getElementById('epUsername');
            const epEmail = document.getElementById('epEmail');
            const epBirthday = document.getElementById('epBirthday');
            const epBio = document.getElementById('epBio');

            _epAvatarFile = null;
            _epBgFile = null;
            _epAvatarUrl = null;
            _epBgUrl = null;

            epUsername.value = currentUser;
            epEmail.value = '';
            epBirthday.value = '';
            epBio.value = '';
            // 昵称输入时即时清除错误提示
            epUsername.oninput = clearEpUsernameError;

            // 生日选择器：上限为今天，禁止选择未来日期
            const _today = new Date();
            epBirthday.max = _today.getFullYear() + '-' +
                (_today.getMonth() + 1 < 10 ? '0' : '') + (_today.getMonth() + 1) + '-' +
                (_today.getDate() < 10 ? '0' : '') + _today.getDate();
            // 邮箱输入时即时清除错误提示
            epEmail.oninput = clearEpEmailError;

            // 头像预览：优先 currentAvatarUrl / 内存缓存 / 本地缓存
            const idx = hashStr(currentUser) % 8;
            epAvatar.className = 'ep-avatar av-' + idx;
            const epCachedAvatar = currentAvatarUrl || userAvatarCache[currentUser] || _lsGetAvatar(currentUser);
            _epExistingAvatarUrl = epCachedAvatar || null;
            if (_epExistingAvatarUrl) {
                _loadProfileImage(_epExistingAvatarUrl, function(url) {
                    epAvatar.style.backgroundImage = 'url(' + url + ')';
                    epAvatar.textContent = '';
                });
            } else {
                epAvatar.style.backgroundImage = '';
                epAvatar.textContent = currentUser.charAt(0).toUpperCase();
            }

            // 背景预览
            _epExistingBgUrl = null;
            try {
                const cachedBg = _getBgCache(currentUser);
                if (cachedBg) {
                    _epExistingBgUrl = cachedBg;
                    // 统一把（已过期/换 AK 失效的）预签名链接还原为公开直链（see other.js mediaUrlToPublic）
                    const cleanCachedBg = (typeof mediaUrlToPublic === 'function') ? mediaUrlToPublic(cachedBg) : cachedBg;
                    if (cleanCachedBg) epBg.style.backgroundImage = 'url(' + cleanCachedBg + ')';
                } else {
                    epBg.style.backgroundImage = '';
                }
            } catch (ex) { epBg.style.backgroundImage = ''; }

            // 从 RPC 回填已有资料
            (async function() {
                try {
                    const { data: rpcData, error: rpcError } = await s3.rpc('get_user_profile', { p_uid: currentUid, p_username: currentUser });
                    if (!rpcError && rpcData && rpcData.success !== false) {
                        epEmail.value = rpcData.email || '';
                        epBirthday.value = normalizeDateToISO(rpcData.birthday) || '';
                        epBio.value = rpcData.bio || '';
                        const rpcBgUrl = rpcData.bg_url || '';
                        if (rpcBgUrl && rpcBgUrl !== _epExistingBgUrl) {
                            // 统一把（已过期/换 AK 失效的）预签名链接还原为公开直链（see other.js mediaUrlToPublic）
                            const cleanBgUrl = (typeof mediaUrlToPublic === 'function') ? mediaUrlToPublic(rpcBgUrl) : rpcBgUrl;
                            _epExistingBgUrl = rpcBgUrl;
                            if (cleanBgUrl) epBg.style.backgroundImage = 'url(' + cleanBgUrl + ')';
                            _setBgCache(currentUser, rpcBgUrl);
                        }
                    }
                } catch (ex) { /* ignore */ }
            })();
        }

        function handleEpAvatarSelect(e) {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            if (!file.type.startsWith('image/')) { showSnackbar('请选择图片'); return; }
            const sizeErr = fileSizeError(file, MAX_AVATAR_SIZE, '图片');
            if (sizeErr) { showSnackbar(sizeErr); return; }
            const reader = new FileReader();
            reader.onload = function(ev) {
                openImageEditor(ev.target.result, '1-1', function(blob) {
                    _epAvatarFile = blob;
                    const url = URL.createObjectURL(blob);
                    if (_epAvatarUrl && _epAvatarUrl.startsWith('blob:')) URL.revokeObjectURL(_epAvatarUrl);
                    _epAvatarUrl = url;
                    const epAvatar = document.getElementById('epAvatar');
                    epAvatar.style.backgroundImage = 'url(' + url + ')';
                    epAvatar.textContent = '';
                });
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        }

        function handleEpBgSelect(e) {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            if (!file.type.startsWith('image/')) { showSnackbar('请选择图片'); return; }
            const sizeErr = fileSizeError(file, MAX_BG_SIZE, '图片');
            if (sizeErr) { showSnackbar(sizeErr); return; }
            const reader = new FileReader();
            reader.onload = function(ev) {
                openImageEditor(ev.target.result, '16-9', function(blob) {
                    _epBgFile = blob;
                    const url = URL.createObjectURL(blob);
                    if (_epBgUrl && _epBgUrl.startsWith('blob:')) URL.revokeObjectURL(_epBgUrl);
                    _epBgUrl = url;
                    document.getElementById('epBg').style.backgroundImage = 'url(' + url + ')';
                });
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        }

        // 邮箱/生日字段校验与规范化
        function isValidEmail(email) {
            if (!email) return true; // 允许为空
            if (email.length > 254) return false;
            return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
        }

        function normalizeDateToISO(text) {
            if (!text) return '';
            text = String(text).trim();
            let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
            if (!m) m = text.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
            if (!m) return '';
            const y = +m[1], mo = +m[2], d = +m[3];
            if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
            return y + '-' + (mo < 10 ? '0' + mo : mo) + '-' + (d < 10 ? '0' + d : d);
        }

        function showEpEmailError(msg) {
            const item = document.getElementById('epEmailItem');
            const err = document.getElementById('epEmailError');
            if (item) item.classList.add('error');
            if (err) { err.textContent = msg; err.classList.add('show'); }
        }

        function clearEpEmailError() {
            const item = document.getElementById('epEmailItem');
            const err = document.getElementById('epEmailError');
            if (item) item.classList.remove('error');
            if (err) { err.textContent = ''; err.classList.remove('show'); }
        }

        function showEpUsernameError(msg) {
            const err = document.getElementById('epUsernameError');
            if (err) { err.textContent = msg; err.classList.add('show'); }
        }

        function clearEpUsernameError() {
            const err = document.getElementById('epUsernameError');
            if (err) { err.textContent = ''; err.classList.remove('show'); }
        }

        async function saveEditProfile() {
            const btn = document.getElementById('epSaveBtn');
            const newName = document.getElementById('epUsername').value.trim();
            const email = document.getElementById('epEmail').value.trim();
            const birthday = document.getElementById('epBirthday').value.trim();
            const bio = document.getElementById('epBio').value.trim();

            // 昵称校验：与注册一致（isSafeUsername 白名单），仅改动时才校验
            clearEpUsernameError();
            if (newName !== currentUser) {
                if (!newName) { showEpUsernameError('请输入昵称'); showSnackbar('请输入昵称'); return; }
                if (newName.length < 2 || newName.length > 15) { showEpUsernameError('昵称需 2-15 个字符'); showSnackbar('昵称需 2-15 个字符'); return; }
                if (HIDDEN_UNICODE_RE.test(newName)) { showEpUsernameError('昵称不能包含零宽或控制字符'); showSnackbar('昵称不能包含零宽或控制字符'); return; }
                if (!isSafeUsername(newName)) { showEpUsernameError('昵称包含不安全字符'); showSnackbar('昵称包含不安全字符'); return; }
            }

            // 邮箱校验：非空必须为合法邮箱
            clearEpEmailError();
            if (email && !isValidEmail(email)) {
                showEpEmailError('请输入有效的邮箱地址');
                const epEmailEl = document.getElementById('epEmail');
                if (epEmailEl) epEmailEl.focus();
                showSnackbar('邮箱格式不正确');
                return;
            }
            // 生日规范化（后端为纯文本，统一保存为 YYYY-MM-DD）
            const birthdayISO = normalizeDateToISO(birthday);

            btn.disabled = true;
            // 全屏保存遮罩
            const overlay = document.createElement('div');
            overlay.id = 'epSavingOverlay';
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:99998;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = '<div class="md-circular-loader" style="width:48px;height:48px;color:#fff;"><svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="20"/></svg></div>';
            document.body.appendChild(overlay);
            try {

                let newAvatarUrl = _epExistingAvatarUrl;
                let newBgUrl = _epExistingBgUrl;

                // 昵称有改动先改昵称（最易受每日 5 次限制影响，失败则中止后续保存）
                let renameDone = false;
                const oldName = currentUser;
                if (newName !== currentUser) {
                    const { data: unData, error: unErr } = await s3.rpc('update_username', { p_uid: currentUid, p_new_username: newName });
                    if (unErr) { if (overlay) overlay.remove(); btn.disabled = false; showSnackbar('修改昵称失败: ' + unErr.message); return; }
                    if (unData && unData.success === false) { if (overlay) overlay.remove(); btn.disabled = false; showSnackbar(unData.message || '修改昵称失败'); return; }
                    renameDone = true;
                    migrateLocalIdentity(oldName, newName);
                    showSnackbar('昵称已修改' + (unData && unData.renames_left != null ? '，今日剩余 ' + unData.renames_left + ' 次' : ''));
                }

                // 头像有改动才上传（已在裁剪器压缩为 512x512）；裁剪后最终 blob 二次校验
                if (_epAvatarFile) {
                    const avErr = fileSizeError(_epAvatarFile, MAX_AVATAR_FINAL_SIZE, '头像');
                    if (avErr) { if (overlay) overlay.remove(); btn.disabled = false; showSnackbar(avErr); return; }
                    const avPath = 'resrc/usr_ava/' + hashStr(currentUser) + '-' + Date.now() + '.jpg';
                    const uploadedAvatarUrl = await uploadToBucket(avPath, _epAvatarFile, 'image/jpeg');
                    if (!uploadedAvatarUrl) { if (overlay) overlay.remove(); btn.disabled = false; return; }
                    newAvatarUrl = uploadedAvatarUrl;
                    const { error: upErr } = await s3.rpc('update_avatar', { p_uid: currentUid, p_avatar_url: newAvatarUrl });
                    if (upErr) { if (overlay) overlay.remove(); btn.disabled = false; showSnackbar('更新头像失败: ' + upErr.message); return; }
                    currentAvatarUrl = newAvatarUrl;
                    userAvatarCache[currentUser] = newAvatarUrl;
                    _lsSetAvatar(currentUser, newAvatarUrl);
                    updateAllAvatars();
                    updateHomeMenu();
                    updatePublicMenu();
                    // 已移除实时广播：其他客户端头像由下次渲染/轮询刷新
                }

                // 背景有改动才上传（已在裁剪器压缩为 1920x1080）；裁剪后最终 blob 二次校验
                if (_epBgFile) {
                    const bgErr = fileSizeError(_epBgFile, MAX_BG_FINAL_SIZE, '背景图');
                    if (bgErr) { if (overlay) overlay.remove(); btn.disabled = false; showSnackbar(bgErr); return; }
                    const bgPath = 'resrc/usr_bkg/' + currentUser + '_' + Date.now() + '.jpg';
                    const uploadedBgUrl = await uploadToBucket(bgPath, _epBgFile, 'image/jpeg');
                    if (!uploadedBgUrl) { if (overlay) overlay.remove(); btn.disabled = false; return; }
                    newBgUrl = uploadedBgUrl;
                    try { localStorage.setItem(LS_KEYS.BG_PREFIX + currentUser, newBgUrl); } catch (ex) { }
                }

                // 保存资料（含背景）
                const { data: saveData, error: saveErr } = await s3.rpc('upsert_user_profile', {
                    p_uid: currentUid,
                    p_email: email,
                    p_birthday: birthdayISO,
                    p_bio: bio,
                    p_bg_url: newBgUrl || ''
                });
                if (saveErr) { if (overlay) overlay.remove(); btn.disabled = false; showSnackbar('保存失败: ' + saveErr.message); return; }
                if (saveData && saveData.success === false) { if (overlay) overlay.remove(); btn.disabled = false; showSnackbar('保存失败'); return; }

                if (overlay) overlay.remove();
                navigateBack();
                setTimeout(function() {
                    loadUserDetailPage();
                    // 昵称已变更：刷新侧边栏/主页菜单等展示昵称的位置
                    if (renameDone) {
                        if (typeof loadPrivateSessions === 'function') loadPrivateSessions();
                        if (typeof updateHomeMenu === 'function') updateHomeMenu();
                        if (typeof updatePublicMenu === 'function') updatePublicMenu();
                    }
                }, 100);
            } catch (e) {
                if (overlay) overlay.remove();
                showSnackbar('保存失败: ' + (e.message || ''));
            }
            btn.disabled = false;
        }

        // 改名成功后迁移本地身份相关缓存（头像/设置/背景/会话），保证下次启动不丢
        function migrateLocalIdentity(oldName, newName) {
            const avatarUrl = currentAvatarUrl || userAvatarCache[oldName] || '';
            if (avatarUrl) {
                userAvatarCache[newName] = avatarUrl;
                _lsSetAvatar(newName, avatarUrl);
            }
            delete userAvatarCache[oldName];
            try {
                const key = _AVATAR_LS_PREFIX + encodeURIComponent(oldName);
                localStorage.removeItem(key);
            } catch (e) {}
            // 本地加密设置 key 迁移（mjchat_user_configs + keymeta）
            try {
                const configs = loadAllUserConfigs();
                if (configs[oldName]) {
                    configs[newName] = configs[oldName];
                    delete configs[oldName];
                    saveAllUserConfigs(configs);
                }
            } catch (e) {}
            try {
                const km = localStorage.getItem(LS_KEYS.KEYMETA_PREFIX + oldName);
                if (km) { localStorage.setItem(LS_KEYS.KEYMETA_PREFIX + newName, km); localStorage.removeItem(LS_KEYS.KEYMETA_PREFIX + oldName); }
            } catch (e) {}
            // 背景缓存迁移
            try {
                const bg = _getBgCache(oldName);
                if (bg) _setBgCache(newName, bg);
                localStorage.removeItem(_bgCacheKey(oldName));
            } catch (e) {}
            // 登录会话记录（mjchat_session 的 username）
            try {
                const sess = JSON.parse(localStorage.getItem(LS_KEYS.SESSION) || '{}');
                sess.username = newName;
                localStorage.setItem(LS_KEYS.SESSION, JSON.stringify(sess));
            } catch (e) {}
            // 全局身份
            currentUser = newName;
            // 详情页目标同步为新名，避免改名后按旧名索引查不到用户
            if (_udTargetUser === oldName) _udTargetUser = newName;
        }

        // ============ 图片裁剪编辑器 ============
        let _ieCallback = null;
        let _ieRatio = '1-1';
        let _ieScale = 1;
        let _ieMinScale = 0.1;
        let _ieOffsetX = 0;
        let _ieOffsetY = 0;
        let _ieStartX = 0;
        let _ieStartY = 0;
        let _ieStartOffsetX = 0;
        let _ieStartOffsetY = 0;
        let _ieNaturalW = 0;
        let _ieNaturalH = 0;
        let _ieDisplayW = 0;
        let _ieDisplayH = 0;
        let _iePinchStartDist = 0;
        let _iePinchStartScale = 1;

        function openImageEditor(dataUrl, ratio, callback) {
            _ieCallback = callback;
            _ieRatio = ratio;
            _ieScale = 1;
            _ieOffsetX = 0;
            _ieOffsetY = 0;
            const img = document.getElementById('ieImage');
            const frame = document.getElementById('ieCropFrame');
            frame.className = 'ie-crop-frame ratio-' + ratio;
            const page = document.getElementById('imageEditorPage');
            page.classList.add('active');
            // 等待布局完成后读取裁剪框尺寸
            requestAnimationFrame(function() {
                img.onload = function() {
                    _ieNaturalW = img.naturalWidth;
                    _ieNaturalH = img.naturalHeight;
                    // 让图片 cover 裁剪框
                    const frameEl = document.getElementById('ieCropFrame');
                    const fw = frameEl.offsetWidth;
                    const fh = frameEl.offsetHeight;
                    const scaleW = fw / _ieNaturalW;
                    const scaleH = fh / _ieNaturalH;
                    _ieScale = Math.max(scaleW, scaleH);
                    _ieMinScale = _ieScale;
                    _ieDisplayW = _ieNaturalW * _ieScale;
                    _ieDisplayH = _ieNaturalH * _ieScale;
                    _ieOffsetX = 0;
                    _ieOffsetY = 0;
                    updateImageTransform();
                    updateZoomLabel();
                };
                img.src = dataUrl;
            });
            img.addEventListener('touchstart', ieOnPointerDown, { passive: false });
            img.addEventListener('mousedown', ieOnPointerDown);
            img.addEventListener('wheel', ieOnWheel, { passive: false });
        }

        function ieClampOffset() {
            // 约束平移范围，保证图片始终覆盖裁剪框
            const frame = document.getElementById('ieCropFrame');
            const fw = frame.offsetWidth;
            const fh = frame.offsetHeight;
            const maxX = Math.max(0, (_ieDisplayW - fw) / 2);
            const maxY = Math.max(0, (_ieDisplayH - fh) / 2);
            _ieOffsetX = Math.max(-maxX, Math.min(maxX, _ieOffsetX));
            _ieOffsetY = Math.max(-maxY, Math.min(maxY, _ieOffsetY));
        }

        function updateImageTransform() {
            const img = document.getElementById('ieImage');
            img.style.width = _ieDisplayW + 'px';
            img.style.height = _ieDisplayH + 'px';
            img.style.transform = 'translate(-50%, -50%) translate(' + _ieOffsetX + 'px, ' + _ieOffsetY + 'px)';
        }

        function ieGetDist(touches) {
            const dx = touches[0].clientX - touches[1].clientX;
            const dy = touches[0].clientY - touches[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        }

        function ieOnPointerDown(e) {
            e.preventDefault();
            if (e.touches && e.touches.length === 2) {
                _iePinchStartDist = ieGetDist(e.touches);
                _iePinchStartScale = _ieScale;
            } else {
                const pt = e.touches ? e.touches[0] : e;
                _ieStartX = pt.clientX;
                _ieStartY = pt.clientY;
                _ieStartOffsetX = _ieOffsetX;
                _ieStartOffsetY = _ieOffsetY;
                document.addEventListener('touchmove', ieOnPointerMove, { passive: false });
                document.addEventListener('touchend', ieOnPointerUp);
                document.addEventListener('mousemove', ieOnPointerMove);
                document.addEventListener('mouseup', ieOnPointerUp);
            }
        }

        function ieOnPointerMove(e) {
            e.preventDefault();
            if (e.touches && e.touches.length === 2) {
                const dist = ieGetDist(e.touches);
                _ieScale = Math.max(_ieMinScale, Math.min(_iePinchStartScale * (dist / _iePinchStartDist), 10));
                _ieDisplayW = _ieNaturalW * _ieScale;
                _ieDisplayH = _ieNaturalH * _ieScale;
                ieClampOffset();
                updateImageTransform();
            } else {
                const pt = e.touches ? e.touches[0] : e;
                const dx = pt.clientX - _ieStartX;
                const dy = pt.clientY - _ieStartY;
                _ieOffsetX = _ieStartOffsetX + dx;
                _ieOffsetY = _ieStartOffsetY + dy;
                ieClampOffset();
                updateImageTransform();
            }
        }

        function ieOnPointerUp() {
            document.removeEventListener('touchmove', ieOnPointerMove);
            document.removeEventListener('touchend', ieOnPointerUp);
            document.removeEventListener('mousemove', ieOnPointerMove);
            document.removeEventListener('mouseup', ieOnPointerUp);
        }

        function cancelImageEdit() {
            const page = document.getElementById('imageEditorPage');
            page.classList.remove('active');
            const img = document.getElementById('ieImage');
            img.removeEventListener('touchstart', ieOnPointerDown);
            img.removeEventListener('mousedown', ieOnPointerDown);
            img.removeEventListener('wheel', ieOnWheel);
            img.src = '';
            _ieCallback = null;
        }

        // 缩放控制：滚轮缩放 + 放大/缩小/重置按钮（桌面端交互）
        function ieSetScale(newScale) {
            _ieScale = Math.max(_ieMinScale, Math.min(newScale, 10));
            _ieDisplayW = _ieNaturalW * _ieScale;
            _ieDisplayH = _ieNaturalH * _ieScale;
            ieClampOffset();
            updateImageTransform();
            updateZoomLabel();
        }

        function ieZoomIn() { ieSetScale(_ieScale * 1.2); }

        function ieZoomOut() { ieSetScale(_ieScale / 1.2); }

        function ieResetTransform() {
            _ieScale = _ieMinScale;
            _ieOffsetX = 0;
            _ieOffsetY = 0;
            updateImageTransform();
            updateZoomLabel();
        }

        function updateZoomLabel() {
            const el = document.getElementById('ieZoomValue');
            if (el) el.textContent = Math.round(_ieScale / _ieMinScale * 100) + '%';
        }

        function ieOnWheel(e) {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 0.9;
            ieSetScale(_ieScale * factor);
        }

        function confirmImageEdit() {
            const img = document.getElementById('ieImage');
            const frame = document.getElementById('ieCropFrame');
            const canvas = document.getElementById('ieCanvas');
            // 按比例决定输出尺寸
            let cropW, cropH;
            if (_ieRatio === '1-1') { cropW = 512; cropH = 512; }
            else { cropW = 1920; cropH = 1080; }
            const outCanvas = document.createElement('canvas');
            outCanvas.width = cropW;
            outCanvas.height = cropH;
            const ctx = outCanvas.getContext('2d');
            // 黑色底（JPEG 无透明通道）
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, cropW, cropH);
            // 计算原图上对应裁剪框的源区域
            const frameRect = frame.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            const imgRect = img.getBoundingClientRect();
            const fcx = frameRect.left + frameRect.width / 2 - canvasRect.left;
            const fcy = frameRect.top + frameRect.height / 2 - canvasRect.top;
            const icx = imgRect.left + imgRect.width / 2 - canvasRect.left;
            const icy = imgRect.top + imgRect.height / 2 - canvasRect.top;
            const ox = icx - fcx;
            const oy = icy - fcy;
            const sf = _ieNaturalW / _ieDisplayW;
            const frameW = frameRect.width;
            const frameH = frameRect.height;
            let srcW = frameW * sf;
            let srcH = frameH * sf;
            let srcX = (_ieNaturalW - srcW) / 2 - ox * sf;
            let srcY = (_ieNaturalH - srcH) / 2 - oy * sf;
            // 防越界
            srcX = Math.max(0, Math.min(srcX, _ieNaturalW - srcW));
            srcY = Math.max(0, Math.min(srcY, _ieNaturalH - srcH));
            ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, cropW, cropH);
            outCanvas.toBlob(function(blob) {
                if (!blob) return;
                // v069: 先回调再关闭编辑器——cancelImageEdit 会清空 _ieCallback，
                // 顺序颠倒会导致裁剪结果回调被静默丢弃（背景/头像无法更新）
                if (_ieCallback) {
                    const cb = _ieCallback;
                    _ieCallback = null;
                    cb(blob);
                }
                cancelImageEdit();
            }, 'image/jpeg', 0.9);
        }
