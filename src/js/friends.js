/* KnockChat 好友功能模块（v097）
 * 覆盖：好友申请（发起/接收/同意/拒绝）、好友列表（分组管理/备注/删除）、
 *       关系状态校验、在线状态实时同步、好友专属差异化能力（备注、
 *       消息好友标记、快捷聊天），并与现有「免好友私聊」完全兼容。
 */

(function() {
    'use strict';

    // ==================== 状态 ====================
    var _friends = [];        // [{friend_uid, friend_username, note, group_id, group_name, avatar_url, online}]
    var _groups = [];         // [{id, name}]
    var _requestsIn = [];     // 收到的申请
    var _requestsOut = [];    // 发出的申请
    var _loaded = false;
    var _requestSending = false; // 好友申请发送防重（连点/并发）
    var _byUid = {};          // uid -> friend record
    var _byName = {};         // username -> friend record

    var _detailTarget = null; // 当前用户详情页目标（username）
    var _formOk = null;       // 通用输入对话框确认回调

    function token() {
        return typeof getSessionToken === 'function' ? getSessionToken() : '';
    }
    function el(id) { return document.getElementById(id); }

    function reset() {
        _friends = []; _groups = []; _requestsIn = []; _requestsOut = [];
        _byUid = {}; _byName = {}; _loaded = false; _requestSending = false;
        var b = el('friendReqBadge');
        if (b) { b.style.display = 'none'; b.textContent = '0'; }
        var e = el('friendReqEntry');
        if (e) e.style.display = 'none';
        refreshBadge();
    }

    // 登录成功后初始化（enterApp 中调用）
    function init() {
        if (!currentUser) return;
        _loaded = false;
        loadAll();
    }

    // 懒加载：进入好友相关页面时确保数据已就绪
    function ensureLoaded() {
        if (!_loaded && currentUser) loadAll();
    }

    async function loadAll() {
        if (!currentUser) return;
        try {
            const [listRes, reqRes] = await Promise.all([
                s3.rpc('get_friend_list', { p_uid: currentUid, p_session_token: token() }),
                s3.rpc('get_friend_requests', { p_uid: currentUid, p_session_token: token(), p_direction: 'in' })
            ]);
            const list = listRes && listRes.data;
            if (list && list.success !== false) {
                _friends = Array.isArray(list.friends) ? list.friends : [];
                _groups = Array.isArray(list.groups) ? list.groups : [];
                _byUid = {}; _byName = {};
                _friends.forEach(function(f) {
                    _byUid[String(f.friend_uid)] = f;
                    _byName[f.friend_username] = f;
                });
                _loaded = true;
            }
            const req = reqRes && reqRes.data;
            if (req && req.success !== false) {
                _requestsIn = Array.isArray(req.requests) ? req.requests : [];
            }
            try {
                const outRes = await s3.rpc('get_friend_requests', { p_uid: currentUid, p_session_token: token(), p_direction: 'out' });
                const out = outRes && outRes.data;
                if (out && out.success !== false) _requestsOut = Array.isArray(out.requests) ? out.requests : [];
            } catch (e) { /* ignore */ }
            refreshBadge();
            refreshPresenceUi();
            renderPrivateFriendBadges();
            if (isPageActive('friendsPage')) renderFriendsPage();
            if (isPageActive('addFriendPage')) renderAddFriendPage();
            if (isPageActive('userDetailPage')) renderDetailActions(_detailTarget);
            updatePrivateFriendUi();
        } catch (e) {
            console.warn('[friends] loadAll failed:', e);
        }
    }

    function isPageActive(id) {
        var p = document.getElementById(id);
        return p && p.classList.contains('active');
    }

    // ==================== 关系查询（供其他模块同步调用） ====================
    function isFriend(nameOrUid) {
        if (_byUid[String(nameOrUid)]) return true;
        return !!_byName[nameOrUid];
    }
    function getFriend(nameOrUid) {
        return _byUid[String(nameOrUid)] || _byName[nameOrUid] || null;
    }
    function displayName(name) {
        var f = _byName[name];
        return (f && f.note) ? f.note : name;
    }

    // ==================== 未读申请角标 ====================
    function refreshBadge() {
        var pending = _requestsIn.filter(function(r) { return r.status === 'pending'; }).length;
        var b = el('friendReqBadge');
        if (b) {
            if (pending > 0) { b.style.display = ''; b.textContent = pending > 99 ? '99+' : String(pending); }
            else b.style.display = 'none';
        }
        var e = el('friendReqEntry');
        if (e) {
            if (pending > 0) {
                e.style.display = '';
                e.querySelector('.freq-text').textContent = '收到 ' + pending + ' 条好友申请';
            } else {
                e.style.display = 'none';
            }
        }
    }

    // ==================== 在线状态实时同步 ====================
    // 由 chat.js 的 __rtOnOnlineList / __rtOnPresence 调用（存在性守卫）
    function refreshPresenceUi() {
        // 好友列表页圆点
        var dots = document.querySelectorAll('.friends-page .fr-av-dot');
        for (var i = 0; i < dots.length; i++) {
            var d = dots[i];
            var un = d.getAttribute('data-username');
            if (!un) continue;
            d.className = 'fr-av-dot' + (_onlineUsers && _onlineUsers[un] ? ' online' : '');
        }
        // 详情页状态行（好友在线提示）
        var udStatus = el('udStatusText');
        if (udStatus && _detailTarget && !_detailTargetIsSelf && isFriend(_detailTarget)) {
            var online = _onlineUsers && _onlineUsers[_detailTarget];
            udStatus.textContent = online ? '在线' : '离线';
            udStatus.style.color = online ? 'var(--md-online, #22c55e)' : '';
        }
    }

    // ==================== 页面导航 ====================
    function openFriendsPage() {
        ensureLoaded();
        pushPageHistory('friends');
        switchPage('friendsPage', true);
        updateSidebarHighlight();
        renderFriendsPage();
        updateBackBadge();
    }
    function openAddFriendPage() {
        ensureLoaded();
        pushPageHistory('addFriend');
        switchPage('addFriendPage', true);
        updateBackBadge();
        renderAddFriendPage();
        var input = el('friendSearchInput');
        if (input) { input.value = ''; input.focus(); }
    }

    // ==================== 好友列表页 ====================
    function renderFriendsPage() {
        var container = el('friendsContainer');
        if (!container) return;
        refreshBadge();
        if (!_loaded) {
            container.innerHTML = '<div style="text-align:center;padding:40px;"><span class="md-circular-loader" style="width:32px;height:32px;margin:0 auto;"><svg viewBox="0 0 22 22" style="width:32px;height:32px;"><circle cx="11" cy="11" r="9.5"/></svg></span></div>';
            return;
        }
        if (_friends.length === 0) {
            container.innerHTML = '<div class="empty">还没有好友，点击右上角 + 添加好友，或从搜索/名片进入私聊后发起申请</div>';
            return;
        }
        // 按分组聚合（未分组放最后）
        var groupById = { '': { id: '', name: '未分组' } };
        _groups.forEach(function(g) { groupById[String(g.id)] = { id: g.id, name: g.name }; });
        var order = [];
        var map = {};
        _groups.forEach(function(g) { order.push(String(g.id)); map[String(g.id)] = []; });
        order.push('');
        map[''] = [];
        _friends.forEach(function(f) {
            var gid = String(f.group_id || '');
            if (!map[gid]) { map[gid] = []; }
            map[gid].push(f);
        });

        var html = '';
        order.forEach(function(gid) {
            var list = map[gid] || [];
            if (list.length === 0) return;
            var g = groupById[gid] || { id: gid, name: '未分组' };
            html += '<div class="fr-group">';
            html += '<div class="fr-group-head" onclick="toggleFriendGroup(\'' + escapeJsString(gid) + '\')">' +
                    '<span class="fr-group-caret" id="frgCaret_' + gid + '">▾</span>' +
                    '<span class="fr-group-name">' + escapeHtml(g.name) + '</span>' +
                    '<span class="fr-group-count">' + list.length + '</span>';
            if (gid !== '') {
                html += '<span class="fr-group-ops" onclick="event.stopPropagation()">' +
                        '<button class="fr-op-btn" title="重命名" onclick="renameFriendGroup(\'' + escapeJsString(gid) + '\')">✎</button>' +
                        '<button class="fr-op-btn" title="删除分组" onclick="deleteFriendGroup(\'' + escapeJsString(gid) + '\')">✕</button>' +
                        '</span>';
            }
            html += '</div>';
            html += '<div class="fr-group-body" id="frgBody_' + gid + '">';
            list.forEach(function(f) {
                var avUrl = f.avatar_url || userAvatarCache[f.friend_username] || '';
                var idx = hashStr(f.friend_username) % 8;
                var showName = f.note || f.friend_username;
                var avStyle = avUrl ? ' style="background-image:url(\'' + escapeAttr(sanitizeAvatarUrl(avUrl)) + '\');background-size:cover;background-position:center;"' : '';
                var avText = avUrl ? '' : escapeHtml(f.friend_username.charAt(0).toUpperCase());
                html += '<div class="fr-item" onclick="openFriendDetail(\'' + escapeJsString(f.friend_username) + '\')">' +
                        '<div class="av-wrap">' +
                        '<div class="av av-' + idx + '" data-username="' + escapeAttr(f.friend_username) + '"' + avStyle + '>' + avText + '</div>' +
                        '<div class="fr-av-dot' + (_onlineUsers && _onlineUsers[f.friend_username] ? ' online' : '') + '" data-username="' + escapeAttr(f.friend_username) + '"></div>' +
                        '</div>' +
                        '<div class="fr-info">' +
                        '<div class="fr-name">' + escapeHtml(showName) + '</div>' +
                        '<div class="fr-sub">' + (f.note ? escapeHtml(f.friend_username) : '已互加好友') + '</div>' +
                        '</div>' +
                        '<div class="fr-actions" onclick="event.stopPropagation()">' +
                        '<button class="fr-chat-btn" title="发消息" onclick="quickChat(\'' + String(f.friend_uid) + '\')">💬</button>' +
                        '</div>' +
                        '</div>';
            });
            html += '</div></div>';
        });
        container.innerHTML = html;
    }

    function toggleFriendGroup(gid) {
        var body = el('frgBody_' + gid);
        var caret = el('frgCaret_' + gid);
        if (!body) return;
        var collapsed = body.style.display === 'none';
        body.style.display = collapsed ? '' : 'none';
        if (caret) caret.textContent = collapsed ? '▾' : '▸';
    }

    function openFriendDetail(username) {
        if (typeof openUserDetailPage === 'function') openUserDetailPage(username);
    }

    // ==================== 添加好友页 ====================
    function renderAddFriendPage() {
        renderFriendRequests();
        var s = el('friendSearchResults');
        if (s && !s.dataset.rendered) s.innerHTML = '';
    }

    function doFriendSearch() {
        var input = el('friendSearchInput');
        var q = (input ? input.value : '').trim();
        var container = el('friendSearchResults');
        if (!container) return;
        if (!q) { container.innerHTML = '<div class="empty">输入昵称搜索用户</div>'; return; }
        container.dataset.rendered = '1';
        container.innerHTML = '<div style="text-align:center;padding:30px;">' + mdLoaderSvg(28, 'margin:0 auto;') + '</div>';
        searchUsers(q, function(results) {
            if (!results || results.length === 0) {
                container.innerHTML = '<div class="empty">未找到用户「' + escapeHtml(q) + '」</div>';
                return;
            }
            var html = results.map(function(u) {
                var isSelf = u.username === currentUser;
                var idx = hashStr(u.username) % 8;
                var avUrl = u.avatar_url || '';
                var avStyle = avUrl ? ' style="background-image:url(\'' + escapeAttr(sanitizeAvatarUrl(avUrl)) + '\');background-size:cover;background-position:center;"' : '';
                var avText = avUrl ? '' : escapeHtml(u.username.charAt(0).toUpperCase());
                var state = '';
                var action = '';
                if (isSelf) {
                    state = '<span class="fr-state">自己</span>';
                } else if (isFriend(u.uid) || isFriend(u.username)) {
                    state = '<span class="fr-state ok">已是好友</span>';
                    action = '<button class="fr-btn" onclick="quickChat(\'' + String(u.uid) + '\')">发消息</button>';
                } else {
                    action = '<button class="fr-btn primary" onclick="showAddFriendDialog(\'' + String(u.uid) + '\',\'' + escapeJsString(u.username) + '\')">添加好友</button>';
                }
                return '<div class="fr-search-item" onclick="openFriendDetail(\'' + escapeJsString(u.username) + '\')">' +
                        '<div class="av av-' + idx + '" data-username="' + escapeAttr(u.username) + '"' + avStyle + '>' + avText + '</div>' +
                        '<div class="fr-info"><div class="fr-name">' + escapeHtml(u.username) + (state ? ' ' + state : '') + '</div>' +
                        '<div class="fr-sub">UID ' + escapeHtml(String(u.uid)) + '</div></div>' +
                        '<div class="fr-actions" onclick="event.stopPropagation()">' + action + '</div>' +
                        '</div>';
            }).join('');
            container.innerHTML = html;
            results.forEach(function(u) {
                if (!u.avatar_url) return;
                var av = container.querySelector('.fr-search-item .av[data-username="' + escapeAttr(u.username) + '"]');
                if (av) { av.style.backgroundImage = 'url(' + u.avatar_url + ')'; av.textContent = ''; }
                userAvatarCache[u.username] = u.avatar_url;
            });
        });
    }

    function renderFriendRequests() {
        var inC = el('friendReqIn');
        var outC = el('friendReqOut');
        if (inC) {
            var pendingIn = _requestsIn.filter(function(r) { return r.status === 'pending'; });
            if (pendingIn.length === 0) {
                inC.innerHTML = '<div class="empty">暂无待处理的好友申请</div>';
            } else {
                inC.innerHTML = pendingIn.map(function(r) {
                    var name = r.from_username;
                    var idx = hashStr(name) % 8;
                    var avUrl = r.other_avatar || '';
                    var avStyle = avUrl ? ' style="background-image:url(\'' + escapeAttr(sanitizeAvatarUrl(avUrl)) + '\');background-size:cover;background-position:center;"' : '';
                    var avText = avUrl ? '' : escapeHtml(name.charAt(0).toUpperCase());
                    var time = fmtListTime(r.created_at);
                    return '<div class="fr-req-item" id="frReq_' + escapeJsString(r.id) + '">' +
                            '<div class="av av-' + idx + '"' + avStyle + '>' + avText + '</div>' +
                            '<div class="fr-req-info"><div class="fr-req-name">' + escapeHtml(name) + '</div>' +
                            '<div class="fr-req-msg">' + (r.message ? escapeHtml(r.message) : '请求添加你为好友') + '</div>' +
                            '<div class="fr-req-time">' + time + '</div></div>' +
                            '<div class="fr-req-actions">' +
                            '<button class="fr-btn primary" data-action="accept" onclick="acceptFriendRequest(\'' + escapeJsString(r.id) + '\')"><span class="fr-spinner"><svg viewBox="0 0 22 22"><circle cx="11" cy="11" r="9.5"/></svg></span>同意</button>' +
                            '<button class="fr-btn danger" data-action="reject" onclick="rejectFriendRequest(\'' + escapeJsString(r.id) + '\')"><span class="fr-spinner"><svg viewBox="0 0 22 22"><circle cx="11" cy="11" r="9.5"/></svg></span>拒绝</button>' +
                            '</div></div>';
                }).join('');
            }
        }
        if (outC) {
            if (_requestsOut.length === 0) {
                outC.innerHTML = '<div class="empty">暂无发出的申请</div>';
            } else {
                outC.innerHTML = _requestsOut.map(function(r) {
                    var statusText = r.status === 'pending' ? '等待验证' : (r.status === 'accepted' ? '已通过' : '已拒绝');
                    var cls = r.status === 'pending' ? '' : (r.status === 'accepted' ? ' ok' : ' fail');
                    return '<div class="fr-req-item">' +
                            '<div class="fr-req-info"><div class="fr-req-name">' + escapeHtml(r.to_username) + '</div>' +
                            '<div class="fr-req-time">' + (r.message ? escapeHtml(r.message) + ' · ' : '') + fmtListTime(r.created_at) + '</div></div>' +
                            '<span class="fr-state' + cls + '">' + statusText + '</span></div>';
                }).join('');
            }
        }
    }

    // ==================== 好友申请：发起 ====================
    function showAddFriendDialog(uid, name) {
        // 兼容仅提供用户名（uid 为 0/NaN 时按用户名解析）
        if (!Number(uid)) {
            (async function() {
                try {
                    const { data } = await s3.rpc('get_user_profile', { p_username: name });
                    if (data && data.success !== false && data.uid) {
                        showAddFriendDialog(Number(data.uid), name);
                    } else {
                        showSnackbar('无法获取用户信息');
                    }
                } catch (e) { showSnackbar('无法获取用户信息'); }
            })();
            return;
        }
        // 复用通用输入对话框，输入附言
        _openFormDialog('添加好友', '申请附言（可选，最多100字）', '', 100, function(message) {
            sendFriendRequest(uid, name, message);
        });
    }

    async function sendFriendRequest(uid, name, message) {
        // 防重复申请：本地已存在对该用户的待处理申请（出向）
        if (_requestsOut.some(function(r) { return Number(r.to_uid) === Number(uid) && r.status === 'pending'; })) {
            showSnackbar('已发送过好友申请，等待对方处理');
            return;
        }
        // 防连点：上一次请求尚未返回时忽略再次提交
        if (_requestSending) {
            showSnackbar('正在发送，请稍候');
            return;
        }
        _requestSending = true;
        try {
            const res = await s3.rpc('send_friend_request', {
                p_uid: currentUid, p_session_token: token(),
                p_to_uid: Number(uid), p_message: message || ''
            });
            if (res && res.data && res.data.success === false) {
                showSnackbar(res.data.message || '发送失败');
                return;
            }
            showSnackbar('好友申请已发送');
            // 刷新发出的申请
            try {
                const outRes = await s3.rpc('get_friend_requests', { p_uid: currentUid, p_session_token: token(), p_direction: 'out' });
                const out = outRes && outRes.data;
                if (out && out.success !== false) _requestsOut = Array.isArray(out.requests) ? out.requests : [];
                renderFriendRequests();
            } catch (e) { /* ignore */ }
        } catch (e) {
            showSnackbar('发送失败: ' + (e.message || ''));
        } finally {
            _requestSending = false;
        }
    }

    // ==================== 好友申请：处理 ====================
    async function handleFriendRequest(id, action) {
        // 受理中：禁用该申请的操作按钮，并在被点击按钮上显示加载动画
        var item = el('frReq_' + id);
        if (item) {
            item.querySelectorAll('.fr-btn').forEach(function(b) {
                b.disabled = true;
                if (b.getAttribute('data-action') === action) b.classList.add('loading');
            });
        }
        try {
            const res = await s3.rpc('handle_friend_request', {
                p_uid: currentUid, p_session_token: token(),
                p_request_id: id, p_action: action
            });
            if (res && res.data && res.data.success === false) {
                showSnackbar(res.data.message || '操作失败');
                await loadAll();
                return;
            }
            showSnackbar(action === 'accept' ? '已添加为好友' : '已拒绝申请');
            // 即时刷新：本地先移除已处理的申请并重绘列表/徽标，再全量同步兜底
            _requestsIn = _requestsIn.filter(function(r) { return r.id !== id; });
            refreshBadge();
            renderFriendRequests();
            await loadAll();
            // 受理后若正与该用户私聊，同步隐藏「临时私聊」提示（已是好友）
            if (typeof checkPrivacyBanner === 'function') checkPrivacyBanner();
        } catch (e) {
            showSnackbar('操作失败: ' + (e.message || ''));
            await loadAll();
        }
    }
    function acceptFriendRequest(id) { handleFriendRequest(id, 'accept'); }
    function rejectFriendRequest(id) { handleFriendRequest(id, 'reject'); }

    // ==================== 好友管理 ====================
    function quickChat(friendUid) {
        var f = _byUid[String(friendUid)];
        var name = f ? (f.friend_username || '') : '';
        if (!name) { showSnackbar('无法定位好友'); return; }
        (async function() {
            var sessionId = await createPrivateSession(name, Number(friendUid));
            if (sessionId) {
                await loadPrivateSessions();
                openPrivateChat(sessionId, name, Number(friendUid));
            }
        })();
    }

    function setFriendNote(friendUid) {
        var f = _byUid[String(friendUid)];
        if (!f) return;
        _openFormDialog('设置备注', '备注名（最多30字，留空清除）', f.note || '', 30, function(note) {
            saveFriendNote(friendUid, note);
        });
    }
    async function saveFriendNote(friendUid, note) {
        try {
            const res = await s3.rpc('set_friend_note', {
                p_uid: currentUid, p_session_token: token(),
                p_friend_uid: Number(friendUid), p_note: note
            });
            if (res && res.data && res.data.success === false) { showSnackbar(res.data.message || '设置失败'); return; }
            showSnackbar('备注已保存');
            await loadAll();
            if (typeof loadPrivateSessions === 'function') loadPrivateSessions();
        } catch (e) { showSnackbar('设置失败: ' + (e.message || '')); }
    }

    function removeFriendAction(friendUid) {
        var f = _byUid[String(friendUid)];
        var name = f ? (f.note || f.friend_username) : String(friendUid);
        showConfirm('删除好友', '确定删除好友「' + name + '」吗？双方将不再是好友，聊天记录保留。', function() {
            removeFriend(friendUid);
        });
    }
    async function removeFriend(friendUid) {
        try {
            const res = await s3.rpc('remove_friend', {
                p_uid: currentUid, p_session_token: token(), p_friend_uid: Number(friendUid)
            });
            if (res && res.data && res.data.success === false) { showSnackbar(res.data.message || '删除失败'); return; }
            showSnackbar('已删除好友');
            await loadAll();
        } catch (e) { showSnackbar('删除失败: ' + (e.message || '')); }
    }

    // ==================== 分组管理 ====================
    function chooseFriendGroup(friendUid) {
        var f = _byUid[String(friendUid)];
        if (!f) return;
        var opts = [];
        opts.push({ value: '', label: '未分组', selected: String(f.group_id || '') === '' });
        _groups.forEach(function(g) {
            opts.push({ value: String(g.id), label: String(g.name), selected: String(f.group_id) === String(g.id) });
        });
        _openPickerDialog('移动好友到分组', opts, function(gid) {
            setFriendGroup(friendUid, gid);
        });
    }
    async function setFriendGroup(friendUid, gid) {
        try {
            const res = await s3.rpc('set_friend_group', {
                p_uid: currentUid, p_session_token: token(),
                p_friend_uid: Number(friendUid), p_group_id: gid
            });
            if (res && res.data && res.data.success === false) { showSnackbar(res.data.message || '操作失败'); return; }
            showSnackbar('已移动分组');
            await loadAll();
        } catch (e) { showSnackbar('操作失败: ' + (e.message || '')); }
    }

    function createFriendGroup() {
        _openFormDialog('新建分组', '分组名称（最多12字）', '', 12, function(name) {
            (async function() {
                try {
                    const res = await s3.rpc('create_friend_group', { p_uid: currentUid, p_session_token: token(), p_name: name });
                    if (res && res.data && res.data.success === false) { showSnackbar(res.data.message || '创建失败'); return; }
                    showSnackbar('分组已创建');
                    await loadAll();
                } catch (e) { showSnackbar('创建失败: ' + (e.message || '')); }
            })();
        });
    }
    function renameFriendGroup(gid) {
        var g = _groups.find(function(x) { return String(x.id) === String(gid); });
        if (!g) return;
        _openFormDialog('重命名分组', '分组名称（最多12字）', String(g.name), 12, function(name) {
            (async function() {
                try {
                    const res = await s3.rpc('rename_friend_group', { p_uid: currentUid, p_session_token: token(), p_group_id: gid, p_name: name });
                    if (res && res.data && res.data.success === false) { showSnackbar(res.data.message || '重命名失败'); return; }
                    showSnackbar('已重命名');
                    await loadAll();
                } catch (e) { showSnackbar('重命名失败: ' + (e.message || '')); }
            })();
        });
    }
    function deleteFriendGroup(gid) {
        var g = _groups.find(function(x) { return String(x.id) === String(gid); });
        showConfirm('删除分组', '确定删除分组「' + (g ? g.name : '') + '」吗？组内好友将移至「未分组」。', function() {
            (async function() {
                try {
                    const res = await s3.rpc('delete_friend_group', { p_uid: currentUid, p_session_token: token(), p_group_id: gid });
                    if (res && res.data && res.data.success === false) { showSnackbar(res.data.message || '删除失败'); return; }
                    showSnackbar('分组已删除');
                    await loadAll();
                } catch (e) { showSnackbar('删除失败: ' + (e.message || '')); }
            })();
        });
    }

    // ==================== 用户详情页：好友操作栏 ====================
    var _detailTargetIsSelf = false;
    function renderDetailActions(username, isSelf) {
        _detailTarget = username;
        _detailTargetIsSelf = !!isSelf;
        var bar = el('udActionBar');
        if (!bar) return;
        if (!username || _detailTargetIsSelf) {
            bar.innerHTML = '';
            return;
        }
        var f = getFriend(username);
        var html = '';
        if (f) {
            // 好友：差异化操作
            html += '<button class="ud-act-btn primary" onclick="quickChat(\'' + String(f.friend_uid) + '\')">发消息</button>';
            html += '<button class="ud-act-btn" onclick="setFriendNote(\'' + String(f.friend_uid) + '\')">备注</button>';
            html += '<button class="ud-act-btn" onclick="chooseFriendGroup(\'' + String(f.friend_uid) + '\')">分组</button>';
            html += '<button class="ud-act-btn danger" onclick="removeFriendAction(\'' + String(f.friend_uid) + '\')">删除好友</button>';
            // 备注名展示
            var nameEl = el('udUsername');
            if (nameEl && f.note) nameEl.textContent = f.note + '（' + username + '）';
        } else {
            // 非好友：发起申请快捷入口
            html += '<button class="ud-act-btn primary" onclick="openFriendAddFromDetail()">添加好友</button>';
            html += '<button class="ud-act-btn" onclick="startPrivateChatFromDetail()">发消息</button>';
        }
        bar.innerHTML = html;
    }

    // 从详情页发起好友申请（按用户名解析 uid）
    function openFriendAddFromDetail() {
        var username = _detailTarget;
        if (!username) return;
        (async function() {
            try {
                const { data } = await s3.rpc('get_user_profile', { p_username: username });
                if (data && data.success !== false && data.uid) {
                    showAddFriendDialog(data.uid, username);
                } else {
                    showSnackbar('无法获取用户信息');
                }
            } catch (e) { showSnackbar('无法获取用户信息'); }
        })();
    }

    // ==================== 私聊页：好友标记 + 快捷加好友 ====================
    // 由 openPrivateChat 调用：标题旁「好友」标记 + 菜单「添加好友」项显隐
    function getPrivateOtherUser() {
        // chat.js 中为全局 let 绑定（非 window 属性）
        return typeof privateOtherUser !== 'undefined' ? privateOtherUser : '';
    }
    function updatePrivateFriendUi() {
        var tag = el('privateFriendTag');
        if (tag) {
            var isF = isFriend(getPrivateOtherUser());
            tag.style.display = isF ? '' : 'none';
            tag.textContent = isF ? '好友' : '';
        }
        var item = el('privateMenuAddFriendItem');
        if (item) {
            var other = getPrivateOtherUser();
            item.style.display = (other && other !== currentUser && !isFriend(other)) ? '' : 'none';
        }
        // 已是好友的私聊页永久隐藏「临时私聊」提示（受理或被添加为好友后即时生效）
        if (typeof checkPrivacyBanner === 'function') checkPrivacyBanner();
    }

    // 私聊菜单：快捷发起好友申请（当前私聊对象）
    function togglePrivateAddFriend() {
        var other = getPrivateOtherUser();
        if (!other || other === currentUser) return;
        closePrivateMenu();
        (async function() {
            try {
                const { data } = await s3.rpc('get_user_profile', { p_username: other });
                if (data && data.success !== false && data.uid) {
                    showAddFriendDialog(data.uid, other);
                } else {
                    showSnackbar('无法获取用户信息');
                }
            } catch (e) { showSnackbar('无法获取用户信息'); }
        })();
    }

    // 私聊列表/私聊消息里的好友徽标重绘（由统一聊天列表 renderChatList 之后调用）
    function renderPrivateFriendBadges() {
        var list = document.getElementById('chatList');
        if (!list) return;
        var items = list.querySelectorAll('.list-item');
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var avEl = item.querySelector('.av[data-username]');
            if (!avEl) continue;
            var name = avEl.getAttribute('data-username');
            if (!name) continue;
            var nameEl = item.querySelector('.name');
            if (!nameEl || nameEl.querySelector('.fr-list-badge')) continue;
            if (isFriend(name)) {
                var span = document.createElement('span');
                span.className = 'fr-list-badge';
                span.textContent = '好友';
                nameEl.appendChild(span);
            }
        }
    }

    // 供其他模块在渲染消息后调用：返回好友徽标 HTML（sender 为好友时）
    function friendBadgeHtml(name) {
        if (!name || name === currentUser) return '';
        return isFriend(name) ? '<span class="fr-msg-badge">好友</span>' : '';
    }

    // ==================== 通用对话框（动态创建） ====================
    function _dialogEl() {
        var d = document.getElementById('frFormDialog');
        if (d) return d;
        d = document.createElement('div');
        d.id = 'frFormDialog';
        d.className = 'dialog-overlay hidden';
        d.innerHTML =
            '<div class="md-dialog">' +
            '<div class="dialog-header"><h2 id="frFormTitle">输入</h2><button class="theme-dialog-close" onclick="closeFriendFormDialog()">✕</button></div>' +
            '<div class="fr-dialog-body"><input id="frFormInput" class="md-text-field" maxlength="100"><div class="fr-dialog-hint" id="frFormHint"></div></div>' +
            '<div class="dialog-actions">' +
            '<button class="md-button text" onclick="closeFriendFormDialog()">取消</button>' +
            '<button class="md-button text" id="frFormOkBtn">确定</button>' +
            '</div></div>';
        document.body.appendChild(d);
        return d;
    }
    function _pickerEl() {
        var d = document.getElementById('frPickerDialog');
        if (d) return d;
        d = document.createElement('div');
        d.id = 'frPickerDialog';
        d.className = 'dialog-overlay hidden';
        d.innerHTML =
            '<div class="md-dialog">' +
            '<div class="dialog-header"><h2 id="frPickerTitle">请选择</h2><button class="theme-dialog-close" onclick="closeFriendPicker()">✕</button></div>' +
            '<div class="fr-picker-list" id="frPickerList"></div>' +
            '<div class="dialog-actions">' +
            '<button class="md-button text" onclick="closeFriendPicker()">取消</button>' +
            '</div></div>';
        document.body.appendChild(d);
        return d;
    }

    function _openFormDialog(title, hint, value, maxlen, onOk) {
        var d = _dialogEl();
        document.getElementById('frFormTitle').textContent = title;
        document.getElementById('frFormHint').textContent = hint || '';
        var input = document.getElementById('frFormInput');
        input.value = value || '';
        input.maxLength = maxlen || 100;
        _formOk = onOk;
        d.classList.remove('hidden');
        setTimeout(function() { input.focus(); }, 50);
        input.onkeydown = function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                _confirmForm();
            }
        };
        document.getElementById('frFormOkBtn').onclick = _confirmForm;
    }
    function _confirmForm() {
        var val = document.getElementById('frFormInput').value.trim();
        var cb = _formOk;
        closeFriendFormDialog();
        if (cb) cb(val);
    }
    function closeFriendFormDialog() {
        var d = document.getElementById('frFormDialog');
        if (d) d.classList.add('hidden');
        _formOk = null;
    }

    function _openPickerDialog(title, opts, onPick) {
        var d = _pickerEl();
        document.getElementById('frPickerTitle').textContent = title;
        var list = document.getElementById('frPickerList');
        list.innerHTML = opts.map(function(o) {
            return '<div class="fr-picker-item' + (o.selected ? ' selected' : '') + '" data-val="' + escapeAttr(String(o.value)) + '" onclick="pickFriendOption(this)">' +
                    (o.selected ? '✓ ' : '') + escapeHtml(o.label) + '</div>';
        }).join('');
        _formOk = onPick;
        d.classList.remove('hidden');
    }
    function pickFriendOption(node) {
        var val = node.getAttribute('data-val') || '';
        var cb = _formOk;
        closeFriendPicker();
        if (cb) cb(val);
    }
    function closeFriendPicker() {
        var d = document.getElementById('frPickerDialog');
        if (d) d.classList.add('hidden');
        _formOk = null;
    }

    // ==================== 搜索用户（复用后端 search_users） ====================
    function searchUsers(q, cb) {
        s3.rpc('search_users', { p_query: q, p_limit: 20 }).then(function(res) {
            // search_users 直接返回用户数组
            var data = res && res.data;
            if (Array.isArray(data)) cb(data);
            else if (data && data.success !== false && Array.isArray(data.users)) cb(data.users);
            else cb([]);
        }).catch(function() { cb([]); });
    }

    // ==================== 好友关系实时同步 ====================
    // 由 realtime.js 的 __rtOnFriendUpdate 调用：加/删好友后服务端实时推送，
    // 防抖重载好友列表（loadAll 内部一并刷新徽标、在线状态、好友专属 UI）。
    var _friendUpdateTimer = null;
    window.__rtOnFriendUpdate = function() {
        if (!currentUser) return;
        clearTimeout(_friendUpdateTimer);
        _friendUpdateTimer = setTimeout(function() {
            _loaded = false;
            loadAll();
        }, 300);
    };

    // ==================== 导出（全局，供 inline onclick / 其他模块调用） ====================
    window.friendModule = {
        init: init,
        reset: reset,
        ensureLoaded: ensureLoaded,
        isFriend: isFriend,
        getFriend: getFriend,
        displayName: displayName,
        // v099: 好友列表只读快照（群聊建群/邀请好友选人用）
        getFriends: function() { return _friends.slice(); },
        friendBadgeHtml: friendBadgeHtml,
        refreshBadge: refreshBadge,
        refreshPresenceUi: refreshPresenceUi,
        renderPrivateFriendBadges: renderPrivateFriendBadges,
        updatePrivateFriendUi: updatePrivateFriendUi,
        renderDetailActions: renderDetailActions,
        showAddFriendDialog: showAddFriendDialog,
        quickChat: quickChat
    };

    window.openFriendsPage = openFriendsPage;
    window.renderFriendsPage = renderFriendsPage;
    window.openAddFriendPage = openAddFriendPage;
    window.openFriendDetail = openFriendDetail;
    window.toggleFriendGroup = toggleFriendGroup;
    window.doFriendSearch = doFriendSearch;
    window.showAddFriendDialog = showAddFriendDialog;
    window.sendFriendRequest = sendFriendRequest;
    window.acceptFriendRequest = acceptFriendRequest;
    window.rejectFriendRequest = rejectFriendRequest;
    window.quickChat = quickChat;
    window.setFriendNote = setFriendNote;
    window.removeFriendAction = removeFriendAction;
    window.chooseFriendGroup = chooseFriendGroup;
    window.createFriendGroup = createFriendGroup;
    window.renameFriendGroup = renameFriendGroup;
    window.deleteFriendGroup = deleteFriendGroup;
    window.openFriendAddFromDetail = openFriendAddFromDetail;
    window.renderDetailActions = renderDetailActions;
    window.togglePrivateAddFriend = togglePrivateAddFriend;
    window.closeFriendFormDialog = closeFriendFormDialog;
    window.closeFriendPicker = closeFriendPicker;
    window.pickFriendOption = pickFriendOption;
})();
