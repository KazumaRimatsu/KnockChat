/* KnockChat 群聊功能模块（v099）
 * 覆盖：创建群聊（名称/头像/描述/好友批量选人/输入校验/防重复提交）、
 *       收到邀请处理（同意/拒绝）、群聊信息/群成员查看、邀请好友进群、退出群聊、收到邀请角标。
 * 依赖：chat.js（群聊状态/收发/列表）、friends.js（好友列表选人）、other.js（UI 工具）。
 */
(function() {
    'use strict';

    // ==================== 状态 ====================
    var _selected = {};          // 建群弹窗：已选好友 {uid:true}
    var _inviteSelected = {};    // 邀请好友弹窗：已选 {uid:true}
    var _inviteBotSelected = {}; // 邀请好友弹窗：已选机器人 {uid:true}
    var _inviteBots = [];        // 当前用户拥有的机器人列表缓存
    var _cgAvatarUrl = '';       // 建群弹窗已上传头像 URL
    var _invites = [];           // 收到的群邀请缓存
    var _invitesLoaded = false;
    var _inviteBadgeAt = 0;      // 邀请拉取最小间隔保护（ms）
    var _creating = false;       // 创建请求进行中（防重复提交）
    var _sendingInvite = false;  // 邀请请求进行中
    var _inviteHandling = false; // 邀请处理进行中

    function el(id) { return document.getElementById(id); }
    function token() { return typeof getSessionToken === 'function' ? getSessionToken() : ''; }
    function myUid() { return typeof currentUid !== 'undefined' ? currentUid : 0; }

    function fmtDateTime(iso) {
        if (!iso) return '';
        try {
            var d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch (e) { return ''; }
    }

    function getFriendsList() {
        try {
            if (window.friendModule && typeof window.friendModule.getFriends === 'function') {
                return window.friendModule.getFriends() || [];
            }
        } catch (e) { /* ignore */ }
        return [];
    }

    function friendDisplayName(f) {
        return f && (f.note || f.friend_username) ? (f.note || f.friend_username) : '?';
    }

    function friendAvatarHtml(f) {
        var avUrl = (f.avatar_url && typeof sanitizeAvatarUrl === 'function') ? sanitizeAvatarUrl(f.avatar_url) : '';
        if (!avUrl && f.friend_username && typeof userAvatarCache !== 'undefined' && userAvatarCache[f.friend_username]) {
            avUrl = (typeof sanitizeAvatarUrl === 'function') ? sanitizeAvatarUrl(userAvatarCache[f.friend_username]) : '';
        }
        var name = friendDisplayName(f);
        if (avUrl) {
            return '<div class="av" style="background-image:url(\'' + escapeAttr(avUrl) + '\');background-size:cover;background-position:center;"></div>';
        }
        return '<div class="av av-' + (hashStr(name) % 8) + '">' + escapeHtml(name.charAt(0).toUpperCase()) + '</div>';
    }

    // 成员勾选列表公共渲染（建群/邀请好友共用）
    function renderMemberCheckList(containerId, map, emptyText) {
        var c = el(containerId);
        if (!c) return;
        var friends = getFriendsList();
        if (!friends.length) {
            c.innerHTML = '<div class="empty">' + escapeHtml(emptyText || '暂无可选好友，请先添加好友') + '</div>';
            return;
        }
        c.innerHTML = friends.map(function(f) {
            var fuid = String(f.friend_uid);
            var checked = map[fuid] ? ' checked' : '';
            return '<label class="cg-member-item">' +
                friendAvatarHtml(f) +
                '<span class="cg-member-name">' + escapeHtml(friendDisplayName(f)) + '</span>' +
                '<input type="checkbox" class="cg-member-check" data-uid="' + escapeAttr(fuid) + '"' + checked + '>' +
                '</label>';
        }).join('');
    }

    // 勾选列表事件绑定（change 委托，更新对应选中集合与计数）
    // countFn 可选：自定义计数函数（如邀请弹窗需合并好友+机器人计数）；默认更新 countId 文本
    function bindMemberCheckChange(containerId, map, countId, countFn) {
        var c = el(containerId);
        if (!c || c._memberBound) return;
        c._memberBound = true;
        c.addEventListener('change', function(e) {
            var cb = e.target;
            if (!cb || !cb.classList || !cb.classList.contains('cg-member-check')) return;
            var fuid = cb.dataset.uid;
            if (cb.checked) map[fuid] = true; else delete map[fuid];
            if (typeof countFn === 'function') { countFn(); return; }
            var n = Object.keys(map).length;
            var ce = el(countId);
            if (ce) ce.textContent = '已选 ' + n + ' 人';
        });
    }

    function updateCgCount() {
        var n = Object.keys(_selected).length;
        var ce = el('cgMemberCount');
        if (ce) ce.textContent = '已选 ' + n + ' 人';
    }

    // ==================== 邀请弹窗 Tab 切换 ====================

    function switchInviteTab(tab) {
        var friendsTab = el('gifTabFriends');
        var botsTab = el('gifTabBots');
        var friendsPanel = el('gifFriendsPanel');
        var botsPanel = el('gifBotsPanel');
        if (tab === 'bots') {
            if (friendsTab) friendsTab.classList.remove('active');
            if (botsTab) botsTab.classList.add('active');
            if (friendsPanel) friendsPanel.style.display = 'none';
            if (botsPanel) botsPanel.style.display = '';
            _updateInviteCount();
        } else {
            if (botsTab) botsTab.classList.remove('active');
            if (friendsTab) friendsTab.classList.add('active');
            if (botsPanel) botsPanel.style.display = 'none';
            if (friendsPanel) friendsPanel.style.display = '';
            _updateInviteCount();
        }
    }

    function _updateInviteCount() {
        var n = Object.keys(_inviteSelected).length + Object.keys(_inviteBotSelected).length;
        var ce = el('gifMemberCount');
        if (ce) ce.textContent = '已选 ' + n + ' 人';
    }

    // 加载并渲染机器人勾选列表（邀请好友弹窗内 Tab）
    function _loadInviteBots(callback) {
        if (!currentUid) { _inviteBots = []; if (callback) callback(); return; }
        s3.rpc('get_my_bots', { p_uid: currentUid, p_session_token: token() }).then(function(res) {
            _inviteBots = (res && res.data && Array.isArray(res.data.bots)) ? res.data.bots.filter(function(b) { return b.status === 'normal'; }) : [];
            if (callback) callback();
        }).catch(function() { _inviteBots = []; if (callback) callback(); });
    }

    function renderBotCheckList(containerId, map) {
        var c = el(containerId);
        if (!c) return;
        if (!_inviteBots.length) {
            c.innerHTML = '<div class="empty">暂无可用的机器人，请先在「Golem」中申请</div>';
            return;
        }
        c.innerHTML = _inviteBots.map(function(b) {
            var buid = String(b.uid);
            var checked = map[buid] ? ' checked' : '';
            var avHtml = b.avatar_url
                ? '<div class="av" style="background-image:url(\'' + escapeAttr(b.avatar_url) + '\');background-size:cover;background-position:center;"></div>'
                : '<div class="av av-' + (hashStr(b.username || '') % 8) + '">' + escapeHtml((b.username || 'G').charAt(0).toUpperCase()) + '</div>';
            return '<label class="cg-member-item">' +
                avHtml +
                '<span class="cg-member-name">' + escapeHtml(b.username || '未知') + ' <span class="gif-bot-tag">Bot</span></span>' +
                '<input type="checkbox" class="cg-member-check" data-uid="' + escapeAttr(buid) + '"' + checked + '>' +
                '</label>';
        }).join('');
    }

    function bindBotCheckChange(containerId, map) {
        var c = el(containerId);
        if (!c || c._botBound) return;
        c._botBound = true;
        c.addEventListener('change', function(e) {
            var cb = e.target;
            if (!cb || !cb.classList || !cb.classList.contains('cg-member-check')) return;
            var buid = cb.dataset.uid;
            if (cb.checked) map[buid] = true; else delete map[buid];
            _updateInviteCount();
        });
    }

    // ==================== 创建群聊 ====================

    function openCreateGroupDialog() {
        if (!currentUser) { showSnackbar('请先登录'); return; }
        try { if (window.friendModule && typeof window.friendModule.ensureLoaded === 'function') window.friendModule.ensureLoaded(); } catch (e) { /* ignore */ }
        _selected = {};
        _cgAvatarUrl = '';
        var nameEl = el('cgName');
        if (nameEl) nameEl.value = '';
        var descEl = el('cgDesc');
        if (descEl) descEl.value = '';
        var errEl = el('cgError');
        if (errEl) errEl.classList.remove('show');
        var av = el('cgAvatar');
        if (av) { av.style.backgroundImage = ''; av.textContent = '群'; }
        updateCgCount();
        renderMemberCheckList('cgMemberList', _selected, '暂无可选好友，请先添加好友');
        bindMemberCheckChange('cgMemberList', _selected, 'cgMemberCount');
        var d = el('createGroupDialog');
        if (d) d.classList.remove('hidden');
        setTimeout(function() { if (nameEl) nameEl.focus(); }, 60);
    }

    function closeCreateGroupDialog() {
        var d = el('createGroupDialog');
        if (d) d.classList.add('hidden');
    }

    // 群头像选择：本地校验 → 上传 → 预览
    async function handleCgAvatarSelect(e) {
        var file = e && e.target && e.target.files && e.target.files[0];
        if (e && e.target) e.target.value = '';
        if (!file) return;
        var sizeErr = (typeof fileSizeError === 'function') ? fileSizeError(file, MAX_AVATAR_SIZE, '头像') : '';
        if (sizeErr) { showSnackbar(sizeErr); return; }
        try {
            showSnackbar('正在上传群头像...');
            var path = 'resrc/group_ava/' + Date.now() + '-' + generateId() + '.jpg';
            var url = await uploadToBucket(path, file, file.type || 'image/jpeg');
            if (!url) return;
            _cgAvatarUrl = url;
            var av = el('cgAvatar');
            if (av) {
                av.style.backgroundImage = "url('" + escapeAttr(mediaUrlToPublic(url)) + "')";
                av.style.backgroundSize = 'cover';
                av.style.backgroundPosition = 'center';
                av.textContent = '';
            }
            showSnackbar('群头像已上传');
        } catch (ex) {
            showSnackbar('头像上传失败: ' + (ex.message || ''));
        }
    }

    // 创建群聊：输入校验（群名 2-50 字符、成员 2-1000 人）+ 防重复提交
    async function submitCreateGroup() {
        if (_creating) return;
        if (!currentUser) { showSnackbar('请先登录'); return; }
        var errEl = el('cgError');
        var name = (el('cgName').value || '').trim();
        var desc = (el('cgDesc').value || '').trim();
        if (name.length < 2 || name.length > 50) {
            if (errEl) { errEl.textContent = '群聊名称长度需为 2-50 个字符'; errEl.classList.add('show'); }
            return;
        }
        var uids = Object.keys(_selected).map(Number);
        if (uids.length < 1) {
            if (errEl) { errEl.textContent = '群聊人数不能少于 2 人，请至少选择 1 位好友'; errEl.classList.add('show'); }
            return;
        }
        if (uids.length + 1 > 1000) {
            if (errEl) { errEl.textContent = '群聊人数不能超过 1000 人'; errEl.classList.add('show'); }
            return;
        }
        if (errEl) errEl.classList.remove('show');

        _creating = true;
        var btn = el('cgCreateBtn');
        if (btn) { btn.disabled = true; btn.textContent = '创建中...'; }
        try {
            var { data, error } = await s3.rpc('create_group', {
                p_uid: myUid(),
                p_session_token: token(),
                p_name: name,
                p_avatar_url: _cgAvatarUrl || '',
                p_description: desc,
                p_member_ids: uids
            });
            if (error) { showSnackbar('创建失败: ' + error.message); return; }
            if (!data || data.success === false) {
                showSnackbar((data && data.message) || '创建失败');
                return;
            }
            closeCreateGroupDialog();
            showSnackbar('群聊创建成功');
            // 同步所有群成员的群聊列表（get_my_groups）+ 跳转到新群聊
            if (typeof pollMyGroups === 'function') { try { await pollMyGroups(); } catch (e) { /* ignore */ } }
            if (data.group && data.group.id && typeof openGroupChat === 'function') {
                openGroupChat(data.group.id);
            }
        } catch (e) {
            showSnackbar('创建失败: ' + (e.message || ''));
        } finally {
            _creating = false;
            if (btn) { btn.disabled = false; btn.textContent = '创建'; }
        }
    }

    // ==================== 收到邀请 ====================

    // 拉取群邀请（force 强制刷新；否则受最小间隔保护，供群列表轮询复用）
    async function loadGroupInvites(force) {
        if (!currentUser) return _invites;
        if (!force && Date.now() - _inviteBadgeAt < 20000) return _invites;
        _inviteBadgeAt = Date.now();
        try {
            var { data, error } = await s3.rpc('get_group_invites', {
                p_uid: myUid(),
                p_session_token: token()
            });
            if (error || !data || data.success === false) return _invites;
            _invites = data.invites || [];
            _invitesLoaded = true;
        } catch (e) { /* ignore */ }
        return _invites;
    }

    // 收到邀请角标（群列表轮询每 10s 调用；首次静默拉取，之后靠缓存 + 懒刷新）
    function refreshInviteBadge() {
        if (!currentUser) {
            var entry0 = el('groupInviteEntry');
            if (entry0) entry0.style.display = 'none';
            return;
        }
        if (!_invitesLoaded) {
            loadGroupInvites(false).then(updateInviteBadgeDom);
        }
        updateInviteBadgeDom();
    }

    function updateInviteBadgeDom() {
        var pending = 0;
        for (var i = 0; i < _invites.length; i++) {
            if (_invites[i].status === 'pending') pending++;
        }
        var entry = el('groupInviteEntry');
        if (!entry) return;
        var badge = el('groupInviteBadge');
        var sub = el('groupInviteSub');
        if (pending > 0) {
            entry.style.display = '';
            if (badge) { badge.style.display = 'flex'; badge.textContent = pending > 99 ? '99+' : String(pending); }
            if (sub) sub.textContent = pending + ' 条待处理';
        } else {
            entry.style.display = 'none';
            if (badge) badge.style.display = 'none';
        }
    }

    function openGroupInvitesDialog() {
        var d = el('groupInvitesDialog');
        if (!d) return;
        d.classList.remove('hidden');
        var c = el('groupInvitesContainer');
        if (c) c.innerHTML = '<div class="empty">加载中...</div>';
        loadGroupInvites(true).then(function() {
            renderInvites();
            refreshInviteBadge();
        });
    }

    function closeGroupInvitesDialog() {
        var d = el('groupInvitesDialog');
        if (d) d.classList.add('hidden');
    }

    function renderInvites() {
        var c = el('groupInvitesContainer');
        if (!c) return;
        if (!_invites.length) {
            c.innerHTML = '<div class="empty">暂无群聊邀请</div>';
            return;
        }
        var pending = _invites.filter(function(i) { return i.status === 'pending'; });
        var done = _invites.filter(function(i) { return i.status !== 'pending'; });
        var html = pending.map(inviteRowHtml).join('');
        if (done.length) {
            html += '<div class="ginv-done-title">已处理</div>' + done.map(inviteRowHtml).join('');
        }
        c.innerHTML = html || '<div class="empty">暂无群聊邀请</div>';
    }

    function inviteRowHtml(inv) {
        var gname = inv.group_name || '群聊';
        var avStyle = inv.group_avatar ? ' style="background-image:url(\'' + escapeAttr(sanitizeAvatarUrl(inv.group_avatar)) + '\');background-size:cover;background-position:center;"' : '';
        var avText = inv.group_avatar ? '' : escapeHtml(gname.charAt(0).toUpperCase());
        var actions = '';
        if (inv.status === 'pending') {
            actions = '<div class="ginv-actions">' +
                '<button class="md-button text ginv-btn" onclick="groupModule.handleInvite(\'' + escapeJsString(String(inv.id)) + '\',\'accept\')">同意</button>' +
                '<button class="md-button text ginv-btn" onclick="groupModule.handleInvite(\'' + escapeJsString(String(inv.id)) + '\',\'reject\')">拒绝</button>' +
                '</div>';
        } else {
            actions = '<span class="ginv-status">' + (inv.status === 'accepted' ? '已同意' : '已拒绝') + '</span>';
        }
        var msg = inv.message ? '<div class="ginv-msg">' + escapeHtml(inv.message) + '</div>' : '';
        return '<div class="ginv-item">' +
            '<div class="av av-' + (hashStr(gname) % 8) + '"' + avStyle + '>' + avText + '</div>' +
            '<div class="ginv-info">' +
                '<div class="ginv-name">' + escapeHtml(gname) + '</div>' +
                '<div class="ginv-from">来自 ' + escapeHtml(inv.from_username || '') + '</div>' +
                msg +
            '</div>' +
            actions +
        '</div>';
    }

    // 处理邀请（同意/拒绝）：成功后刷新邀请列表与群列表，同意则跳转进入群聊
    async function handleInvite(inviteId, action) {
        if (_inviteHandling) return;
        _inviteHandling = true;
        try {
            var { data, error } = await s3.rpc('handle_group_invite', {
                p_uid: myUid(),
                p_session_token: token(),
                p_invite_id: inviteId,
                p_action: action
            });
            if (error) { showSnackbar('操作失败: ' + error.message); return; }
            if (!data || data.success === false) {
                showSnackbar((data && data.message) || '操作失败');
                return;
            }
            showSnackbar(action === 'accept' ? '已加入群聊' : '已拒绝邀请');
            await loadGroupInvites(true);
            renderInvites();
            refreshInviteBadge();
            if (typeof pollMyGroups === 'function') { try { await pollMyGroups(); } catch (e) { /* ignore */ } }
            if (action === 'accept' && data.group_id && typeof openGroupChat === 'function') {
                openGroupChat(data.group_id);
            }
        } catch (e) {
            showSnackbar('操作失败: ' + (e.message || ''));
        } finally {
            _inviteHandling = false;
        }
    }

    // ==================== 群聊信息 ====================

    function showGroupInfoDialog() {
        if (!currentGroupId) return;
        var d = el('groupInfoDialog');
        if (d) d.classList.remove('hidden');
        var c = el('groupInfoContent');
        if (c) c.innerHTML = '<div class="empty">加载中...</div>';
        var gid = currentGroupId;
        s3.rpc('get_group_info', {
            p_uid: myUid(),
            p_session_token: token(),
            p_group_id: gid
        }).then(function(res) {
            var data = res && res.data;
            if (!data || data.success === false || !data.group) {
                if (c) c.innerHTML = '<div class="empty">群聊信息加载失败</div>';
                return;
            }
            var g = data.group;
            var avStyle = g.avatar_url ? ' style="background-image:url(\'' + escapeAttr(sanitizeAvatarUrl(g.avatar_url)) + '\');background-size:cover;background-position:center;"' : '';
            var avText = g.avatar_url ? '' : escapeHtml((g.name || '群').charAt(0).toUpperCase());
            var desc = g.description ? escapeHtml(g.description) : '<span class="gi-muted">暂无描述</span>';
            var myRole = g.my_role === 'owner' ? '<span class="g-owner-tag">群主</span>'
                : g.my_role === 'admin' ? '<span class="g-admin-tag">管理员</span>' : '';
            var allMute = '';
            if (g.mute_all_until) {
                var allUntil = new Date(g.mute_all_until).getTime();
                if (allUntil > Date.now()) {
                    allMute = '<div class="gi-muted gm-mute-note">全体禁言中，' + fmtDateTime(g.mute_all_until) + ' 解除</div>';
                }
            }
            // v100.x: 管理员/群主可编辑群资料
            var editBtn = (g.my_role === 'owner' || g.my_role === 'admin')
                ? '<button class="md-button text gi-edit-btn" onclick="openGroupInfoEdit()">编辑群资料</button>' : '';
            if (c) c.innerHTML =
                '<div class="gi-head">' +
                    '<div class="av av-' + (hashStr(g.name || '群') % 8) + '"' + avStyle + '>' + avText + '</div>' +
                    '<div class="gi-title">' + escapeHtml(g.name || '群聊') + myRole + '</div>' +
                    '<div class="gi-sub">' + escapeHtml(g.owner_name || '') + ' · ' + (Number(g.member_count) || 0) + ' 人</div>' +
                '</div>' +
                '<div class="gi-desc">' + desc + '</div>' +
                allMute +
                '<div class="gi-meta">群 ID：' + escapeHtml(g.id) + '</div>' +
                '<div class="gi-meta">创建于：' + escapeHtml(fmtDateTime(g.created_at)) + '</div>' +
                editBtn;
        }).catch(function() {
            if (c) c.innerHTML = '<div class="empty">群聊信息加载失败</div>';
        });
    }

    function closeGroupInfoDialog() {
        var d = el('groupInfoDialog');
        if (d) d.classList.add('hidden');
    }

    // v100.x: 编辑群资料（管理员/群主）
    var _giEditAvatarUrl = '';

    function openGroupInfoEdit() {
        if (!currentGroupId) return;
        if (!currentUser) { showSnackbar('请先登录'); return; }
        _giEditAvatarUrl = '';
        var d = el('groupInfoEditDialog');
        if (!d) return;
        var gid = currentGroupId;
        s3.rpc('get_group_info', {
            p_uid: myUid(),
            p_session_token: token(),
            p_group_id: gid
        }).then(function(res) {
            var data = res && res.data;
            if (!data || data.success === false || !data.group) { showSnackbar('群聊信息加载失败'); return; }
            var g = data.group;
            var nameEl = el('gieName');
            if (nameEl) nameEl.value = g.name || '';
            var descEl = el('gieDesc');
            if (descEl) descEl.value = g.description || '';
            _giEditAvatarUrl = g.avatar_url || '';
            var av = el('gieAvatar');
            if (av) {
                if (_giEditAvatarUrl) {
                    av.style.backgroundImage = "url('" + escapeAttr(mediaUrlToPublic(_giEditAvatarUrl)) + "')";
                    av.style.backgroundSize = 'cover';
                    av.style.backgroundPosition = 'center';
                    av.textContent = '';
                } else {
                    av.style.backgroundImage = '';
                    av.textContent = '群';
                }
            }
            var errEl = el('gieError');
            if (errEl) errEl.classList.remove('show');
            d.classList.remove('hidden');
        }).catch(function() { showSnackbar('群聊信息加载失败'); });
    }

    function closeGroupInfoEditDialog() {
        var d = el('groupInfoEditDialog');
        if (d) d.classList.add('hidden');
    }

    // 编辑群头像：本地校验 → 上传 → 预览
    async function handleGieAvatarSelect(e) {
        var file = e && e.target && e.target.files && e.target.files[0];
        if (e && e.target) e.target.value = '';
        if (!file) return;
        var sizeErr = (typeof fileSizeError === 'function') ? fileSizeError(file, MAX_AVATAR_SIZE, '头像') : '';
        if (sizeErr) { showSnackbar(sizeErr); return; }
        try {
            showSnackbar('正在上传群头像...');
            var path = 'resrc/group_ava/' + Date.now() + '-' + generateId() + '.jpg';
            var url = await uploadToBucket(path, file, file.type || 'image/jpeg');
            if (!url) return;
            _giEditAvatarUrl = url;
            var av = el('gieAvatar');
            if (av) {
                av.style.backgroundImage = "url('" + escapeAttr(mediaUrlToPublic(url)) + "')";
                av.style.backgroundSize = 'cover';
                av.style.backgroundPosition = 'center';
                av.textContent = '';
            }
            showSnackbar('群头像已上传');
        } catch (ex) {
            showSnackbar('头像上传失败: ' + (ex.message || ''));
        }
    }

    // 保存群资料（仅提交有变动的字段）
    async function submitGroupInfoEdit() {
        if (!currentGroupId) return;
        if (!currentUser) { showSnackbar('请先登录'); return; }
        var errEl = el('gieError');
        var name = (el('gieName').value || '').trim();
        if (name.length < 2 || name.length > 50) {
            if (errEl) { errEl.textContent = '群聊名称长度需为 2-50 个字符'; errEl.classList.add('show'); }
            return;
        }
        if (errEl) errEl.classList.remove('show');
        var params = {
            p_uid: myUid(),
            p_session_token: token(),
            p_group_id: currentGroupId,
            p_name: name,
            p_description: (el('gieDesc').value || '').trim(),
            p_avatar_url: _giEditAvatarUrl
        };
        var btn = el('gieSaveBtn');
        if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }
        try {
            var { data, error } = await s3.rpc('update_group_info', params);
            if (error) { showSnackbar('保存失败: ' + error.message); return; }
            if (!data || data.success === false) { showSnackbar((data && data.message) || '保存失败'); return; }
            showSnackbar('群资料已更新');
            closeGroupInfoEditDialog();
            // 刷新群信息与群列表（名称/头像变化）
            if (typeof renderGroupList === 'function') renderGroupList();
            if (typeof updateGroupHeader === 'function') updateGroupHeader();
            if (typeof showGroupInfoDialog === 'function') showGroupInfoDialog();
        } catch (e) {
            showSnackbar('保存失败: ' + (e.message || ''));
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '保存'; }
        }
    }

    // ==================== 群成员 ====================

    function showGroupMembersDialog() {
        if (!currentGroupId) return;
        var d = el('groupMembersDialog');
        if (d) d.classList.remove('hidden');
        var c = el('groupMembersContainer');
        if (c) c.innerHTML = '<div class="empty">加载中...</div>';
        var gid = currentGroupId;
        s3.rpc('get_group_members', {
            p_uid: myUid(),
            p_session_token: token(),
            p_group_id: gid
        }).then(function(res) {
            var data = res && res.data;
            if (!data || data.success === false) {
                if (c) c.innerHTML = '<div class="empty">成员加载失败</div>';
                return;
            }
            var members = data.members || [];
            var myRole = data.my_role || 'member';
            if (!members.length) { if (c) c.innerHTML = '<div class="empty">暂无成员</div>'; return; }
            // 群主排最前，其余按角色与 UID（后端已排序，此处兜底）
            var rank = function(r) { return r === 'owner' ? 0 : r === 'admin' ? 1 : 2; };
            members.sort(function(a, b) { return rank(a.role) - rank(b.role) || Number(a.uid) - Number(b.uid); });
            // v100.x: 群主/管理员显示成员管理操作
            var isOwner = myRole === 'owner';
            var isAdmin = myRole === 'admin';
            if (c) c.innerHTML = members.map(function(m) {
                var isMe = Number(m.uid) === myUid();
                var roleTag = m.role === 'owner' ? '<span class="g-owner-tag">群主</span>'
                    : m.role === 'admin' ? '<span class="g-admin-tag">管理员</span>' : '';
                var meTag = isMe ? '<span class="gm-me-tag">我</span>' : '';
                var muteTag = m.is_muted ? '<span class="gm-mute-tag">禁言中</span>' : '';
                var avUrl = (typeof userAvatarCache !== 'undefined' && m.username && userAvatarCache[m.username])
                    ? sanitizeAvatarUrl(userAvatarCache[m.username]) : '';
                var avStyle = avUrl ? ' style="background-image:url(\'' + escapeAttr(avUrl) + '\');background-size:cover;background-position:center;"' : '';
                var avText = avUrl ? '' : escapeHtml((m.username || '?').charAt(0).toUpperCase());
                var actions = '';
                if (!isMe && (isOwner || (isAdmin && m.role === 'member'))) {
                    var btns = [];
                    if (isOwner) {
                        btns.push(m.role === 'admin'
                            ? '<button class="gm-btn" onclick="groupModule.toggleAdmin(\'' + m.uid + '\',false)">取消管理员</button>'
                            : '<button class="gm-btn" onclick="groupModule.toggleAdmin(\'' + m.uid + '\',true)">设为管理员</button>');
                        // v102: 群主可将群聊转让给任意成员
                        btns.push('<button class="gm-btn" onclick="transferGroup(\'' + m.uid + '\',\'' + escapeJsString(m.username || '') + '\')">转让群主</button>');
                    }
                    if (isOwner || m.role === 'member') {
                        btns.push(m.is_muted
                            ? '<button class="gm-btn" onclick="unmuteGroupMember(\'' + m.uid + '\')">解除禁言</button>'
                            : '<button class="gm-btn" onclick="openGroupMuteDialog(\'' + m.uid + '\',\'' + escapeJsString(m.username || '') + '\')">禁言</button>');
                    }
                    btns.push('<button class="gm-btn gm-btn-danger" onclick="kickGroupMember(\'' + m.uid + '\',\'' + escapeJsString(m.username || '') + '\')">移出</button>');
                    actions = '<div class="gm-actions">' + btns.join('') + '</div>';
                }
                return '<div class="gm-item">' +
                    '<div class="av av-' + (hashStr(m.username || '?') % 8) + '"' + avStyle + '>' + avText + '</div>' +
                    '<div class="gm-info">' +
                        '<div class="gm-name">' + escapeHtml(m.username || '') + ' ' + roleTag + meTag + muteTag + '</div>' +
                        '<div class="gm-joined">加入于 ' + escapeHtml(fmtDateTime(m.joined_at)) + '</div>' +
                        actions +
                    '</div>' +
                '</div>';
            }).join('');
        }).catch(function() {
            if (c) c.innerHTML = '<div class="empty">成员加载失败</div>';
        });
    }

    function closeGroupMembersDialog() {
        var d = el('groupMembersDialog');
        if (d) d.classList.add('hidden');
    }

    // ==================== 群管理操作（管理员/群主） ====================

    // 禁言时长预设（分钟）：1分钟 ~ 7天
    var MUTE_PRESETS = [
        { label: '1 分钟', minutes: 1 },
        { label: '10 分钟', minutes: 10 },
        { label: '30 分钟', minutes: 30 },
        { label: '1 小时', minutes: 60 },
        { label: '12 小时', minutes: 720 },
        { label: '1 天', minutes: 1440 },
        { label: '3 天', minutes: 4320 },
        { label: '7 天', minutes: 10080 }
    ];
    var _muteTarget = { uid: 0, name: '', isAll: false }; // 当前禁言弹窗目标

    // 打开禁言弹窗（成员禁言）
    function openGroupMuteDialog(uid, name) {
        if (!currentGroupId) return;
        _muteTarget = { uid: Number(uid), name: name || '', isAll: false };
        renderMuteDialog('禁言 ' + (name || '该成员'));
        var d = el('groupMuteDialog');
        if (d) d.classList.remove('hidden');
    }

    // 打开禁言弹窗（全体禁言，来自群管理弹窗）
    function openGroupMuteAllDialog() {
        if (!currentGroupId) return;
        closeGroupManageDialog();
        _muteTarget = { uid: 0, name: '', isAll: true };
        renderMuteDialog('全体禁言');
        var d = el('groupMuteDialog');
        if (d) d.classList.remove('hidden');
    }

    function renderMuteDialog(title) {
        var t = el('gmTitle');
        if (t) t.textContent = title;
        var c = el('gmPresets');
        if (!c) return;
        c.innerHTML = MUTE_PRESETS.map(function(p) {
            return '<button class="gm-btn" onclick="groupModule.applyMute(' + p.minutes + ')">' + p.label + '</button>';
        }).join('');
        var um = el('gmUnmute');
        if (um) um.style.display = _muteTarget.isAll ? 'none' : '';
        // 打开时清空自定义时长输入
        var cv = el('gmCustomValue');
        if (cv) cv.value = '';
    }

    function closeGroupMuteDialog() {
        var d = el('groupMuteDialog');
        if (d) d.classList.add('hidden');
    }

    // v102: 群管理弹窗（管理员/群主）：全体禁言；群主：清空群消息
    function openGroupManageDialog() {
        if (!currentGroupId) { showSnackbar('请先进入群聊'); return; }
        var isOwner = !!(typeof currentGroupInfo !== 'undefined' && currentGroupInfo && currentGroupInfo.my_role === 'owner');
        var muteAllLabel = el('gmgMuteAllLabel');
        if (muteAllLabel) {
            var allUntil = currentGroupInfo && currentGroupInfo.mute_all_until ? new Date(currentGroupInfo.mute_all_until).getTime() : 0;
            muteAllLabel.textContent = (allUntil > Date.now()) ? '解除全体禁言' : '全体禁言';
        }
        var clearRow = el('gmgClearMsgRow');
        if (clearRow) clearRow.style.display = isOwner ? '' : 'none';
        var d = el('groupManageDialog');
        if (d) d.classList.remove('hidden');
    }

    function closeGroupManageDialog() {
        var d = el('groupManageDialog');
        if (d) d.classList.add('hidden');
    }

    // v102: 自定义禁言时长（数值 × 单位，钳制 1 ~ 10080 分钟）
    function applyCustomMute() {
        var input = el('gmCustomValue');
        var v = input ? parseInt(input.value, 10) : NaN;
        if (!v || isNaN(v) || v < 1) { showSnackbar('请输入有效时长（1 ~ 10080 分钟）'); return; }
        var unitEl = el('gmCustomUnit');
        var unit = unitEl ? parseInt(unitEl.value, 10) : 1;
        var minutes = Math.min(10080, Math.max(1, v * unit));
        applyMute(minutes);
    }

    // 应用禁言/解除（成员或全体）
    async function applyMute(minutes) {
        if (!currentGroupId) return;
        var params = {
            p_uid: myUid(),
            p_session_token: token(),
            p_group_id: currentGroupId
        };
        var rpcName = _muteTarget.isAll ? 'mute_group_all' : 'mute_group_member';
        if (!_muteTarget.isAll) params.p_target_uid = _muteTarget.uid;
        params.p_minutes = minutes;
        try {
            var { data, error } = await s3.rpc(rpcName, params);
            if (error) { showSnackbar('操作失败: ' + error.message); return; }
            if (!data || data.success === false) { showSnackbar((data && data.message) || '操作失败'); return; }
            showSnackbar(_muteTarget.isAll
                ? (minutes > 0 ? '已开启全体禁言' : '已解除全体禁言')
                : (minutes > 0 ? '已禁言' : '已解除禁言'));
            closeGroupMuteDialog();
            // 刷新成员弹窗与群信息（全体禁言状态）
            if (typeof showGroupMembersDialog === 'function') showGroupMembersDialog();
            if (typeof updatePublicMenu === 'function') updatePublicMenu();
        } catch (e) {
            showSnackbar('操作失败: ' + (e.message || ''));
        }
    }

    // 一键解除成员禁言
    async function unmuteGroupMember(uid) {
        if (!currentGroupId) return;
        try {
            var { data, error } = await s3.rpc('mute_group_member', {
                p_uid: myUid(),
                p_session_token: token(),
                p_group_id: currentGroupId,
                p_target_uid: Number(uid),
                p_minutes: 0
            });
            if (error) { showSnackbar('操作失败: ' + error.message); return; }
            if (!data || data.success === false) { showSnackbar((data && data.message) || '操作失败'); return; }
            showSnackbar('已解除禁言');
            if (typeof showGroupMembersDialog === 'function') showGroupMembersDialog();
        } catch (e) {
            showSnackbar('操作失败: ' + (e.message || ''));
        }
    }

    // 统一确认弹窗：优先应用内 showConfirm，回退 window.confirm（群管理多处确认共用）
    function confirmWith(title, message, cb) {
        if (typeof showConfirm === 'function') { showConfirm(title, message, cb); return; }
        if (window.confirm(message)) cb();
    }

    // 设为/取消管理员（仅群主）
    async function toggleAdmin(uid, isAdmin) {
        if (!currentGroupId) return;
        var actionName = isAdmin ? '设为管理员' : '取消管理员';
        confirmWith(actionName, isAdmin ? '确定将 TA 设为群管理员吗？' : '确定取消 TA 的管理员身份吗？', async function() {
            try {
                var { data, error } = await s3.rpc('set_group_admin', {
                    p_uid: myUid(),
                    p_session_token: token(),
                    p_group_id: currentGroupId,
                    p_target_uid: Number(uid),
                    p_is_admin: isAdmin
                });
                if (error) { showSnackbar('操作失败: ' + error.message); return; }
                if (!data || data.success === false) { showSnackbar((data && data.message) || '操作失败'); return; }
                showSnackbar(isAdmin ? '已设为管理员' : '已取消管理员');
                if (typeof showGroupMembersDialog === 'function') showGroupMembersDialog();
            } catch (e) {
                showSnackbar('操作失败: ' + (e.message || ''));
            }
        });
    }

    // 移出群成员（管理员/群主）
    async function kickGroupMember(uid, name) {
        if (!currentGroupId) return;
        confirmWith('移出群聊', '确定将「' + (name || '该成员') + '」移出群聊吗？', async function() {
            try {
                var { data, error } = await s3.rpc('kick_group_member', {
                    p_uid: myUid(),
                    p_session_token: token(),
                    p_group_id: currentGroupId,
                    p_target_uid: Number(uid)
                });
                if (error) { showSnackbar('操作失败: ' + error.message); return; }
                if (!data || data.success === false) { showSnackbar((data && data.message) || '操作失败'); return; }
                showSnackbar('已移出群聊');
                if (typeof showGroupMembersDialog === 'function') showGroupMembersDialog();
            } catch (e) {
                showSnackbar('操作失败: ' + (e.message || ''));
            }
        });
    }

    // v102: 转让群主（仅群主）——转让后当前账号降为普通成员
    async function transferGroup(uid, name) {
        if (!currentGroupId) return;
        confirmWith('群主转让', '确定将群主转让给「' + (name || '该成员') + '」吗？转让后您将降为普通成员。', async function() {
            try {
                var { data, error } = await s3.rpc('transfer_group', {
                    p_uid: myUid(),
                    p_session_token: token(),
                    p_group_id: currentGroupId,
                    p_target_uid: Number(uid)
                });
                if (error) { showSnackbar('操作失败: ' + error.message); return; }
                if (!data || data.success === false) { showSnackbar((data && data.message) || '操作失败'); return; }
                showSnackbar('已转让群主');
                // 刷新成员列表 / 群菜单权限 / 群信息
                if (typeof showGroupMembersDialog === 'function') showGroupMembersDialog();
                if (typeof updatePublicMenu === 'function') updatePublicMenu();
                if (typeof refreshGroupInfo === 'function') refreshGroupInfo(currentGroupId);
            } catch (e) {
                showSnackbar('操作失败: ' + (e.message || ''));
            }
        });
    }

    // 清空群消息（仅群主）
    async function clearGroupMessages() {
        if (!currentGroupId) return;
        closeGroupManageDialog();
        confirmWith('清空群消息', '确定清空本群全部消息吗？该操作不可恢复，多媒体文件将一并删除。', async function() {
            try {
                var { data, error } = await s3.rpc('clear_group_messages', {
                    p_uid: myUid(),
                    p_session_token: token(),
                    p_group_id: currentGroupId
                });
                if (error) { showSnackbar('操作失败: ' + error.message); return; }
                if (!data || data.success === false) { showSnackbar((data && data.message) || '操作失败'); return; }
                showSnackbar('已清空群消息');
                // 本地清空并插入后端返回的系统提示
                if (typeof clearLocalGroupMessages === 'function') {
                    clearLocalGroupMessages(data.system_message);
                }
            } catch (e) {
                showSnackbar('操作失败: ' + (e.message || ''));
            }
        });
    }

    // ==================== 邀请好友进群 ====================

    function openGroupInviteFriendsDialog() {
        if (!currentGroupId) { showSnackbar('请先进入群聊'); return; }
        try { if (window.friendModule && typeof window.friendModule.ensureLoaded === 'function') window.friendModule.ensureLoaded(); } catch (e) { /* ignore */ }
        _inviteSelected = {};
        _inviteBotSelected = {};
        var ce = el('gifMemberCount');
        if (ce) ce.textContent = '已选 0 人';
        renderMemberCheckList('gifFriendList', _inviteSelected, '暂无可邀请的好友，请先添加好友');
        bindMemberCheckChange('gifFriendList', _inviteSelected, 'gifMemberCount', _updateInviteCount);
        // 重置 Tab 到「好友」
        switchInviteTab('friends');
        // 异步加载机器人列表并渲染（Tab 已就绪，用户可先看好友）
        _loadInviteBots(function() {
            renderBotCheckList('gifBotList', _inviteBotSelected);
            bindBotCheckChange('gifBotList', _inviteBotSelected);
        });
        var d = el('groupInviteFriendsDialog');
        if (d) d.classList.remove('hidden');
    }

    function closeGroupInviteFriendsDialog() {
        var d = el('groupInviteFriendsDialog');
        if (d) d.classList.add('hidden');
    }

    // 发送邀请：好友走 send_group_invite，机器人走 bot_add_group（直接加入）
    async function submitGroupInviteFriends() {
        if (_sendingInvite) return;
        if (!currentGroupId) { showSnackbar('请先进入群聊'); return; }
        var uids = Object.keys(_inviteSelected).map(Number);
        var botUids = Object.keys(_inviteBotSelected).map(Number);
        if (!uids.length && !botUids.length) { showSnackbar('请至少选择 1 项'); return; }
        _sendingInvite = true;
        var btn = el('gifSendBtn');
        if (btn) { btn.disabled = true; btn.textContent = '操作中...'; }
        var ok = 0, fail = 0, firstErr = '';
        try {
            // 好友邀请（走邀请流程）
            for (var i = 0; i < uids.length; i++) {
                var { data, error } = await s3.rpc('send_group_invite', {
                    p_uid: myUid(),
                    p_session_token: token(),
                    p_group_id: currentGroupId,
                    p_to_uid: uids[i],
                    p_message: ''
                });
                if (error || !data || data.success === false) {
                    fail++;
                    if (!firstErr) firstErr = ((data && data.message) || (error && error.message) || '发送失败');
                } else {
                    ok++;
                }
            }
            // 机器人入群（直接加入，无需邀请确认）
            for (var j = 0; j < botUids.length; j++) {
                var res = await s3.rpc('bot_add_group', {
                    p_uid: myUid(),
                    p_session_token: token(),
                    p_bot_uid: botUids[j],
                    p_gid: currentGroupId
                });
                if (res.error || !res.data || res.data.success === false) {
                    fail++;
                    if (!firstErr) firstErr = ((res.data && res.data.message) || (res.error && res.error.message) || '添加失败');
                } else {
                    ok++;
                }
            }
        } catch (e) {
            fail++;
            if (!firstErr) firstErr = (e && e.message) || '操作失败';
        } finally {
            _sendingInvite = false;
            if (btn) { btn.disabled = false; btn.textContent = '确定'; }
        }
        closeGroupInviteFriendsDialog();
        if (ok > 0) {
            var parts = [];
            if (uids.length) parts.push(ok + ' 条邀请已发送');
            if (botUids.length) parts.push(botUids.length + ' 个机器人已入群');
            showSnackbar(parts.join('，') + (fail > 0 ? '，' + fail + ' 条失败' : ''));
        } else {
            showSnackbar(firstErr || '操作失败');
        }
    }

    // ==================== 退出群聊 ====================

    function quitCurrentGroup() {
        if (!currentGroupId) return;
        var gid = currentGroupId;
        if (typeof showConfirm === 'function') {
            showConfirm('退出群聊', '确定退出该群聊？退出后需重新接受邀请才能加入。', function() { doQuitGroup(gid); });
        } else if (window.confirm('确定退出该群聊？')) {
            doQuitGroup(gid);
        }
    }

    async function doQuitGroup(gid) {
        try {
            var { data, error } = await s3.rpc('quit_group', {
                p_uid: myUid(),
                p_session_token: token(),
                p_group_id: gid
            });
            if (error) { showSnackbar('操作失败: ' + error.message); return; }
            if (!data || data.success === false) { showSnackbar((data && data.message) || '操作失败'); return; }
            showSnackbar('已退出群聊');
            // 清理本地状态并返回
            if (typeof leaveGroupChat === 'function') leaveGroupChat();
            if (typeof groupUnreadByGid !== 'undefined') { delete groupUnreadByGid[gid]; }
            if (typeof myGroups !== 'undefined' && Array.isArray(myGroups)) {
                myGroups = myGroups.filter(function(g) { return g.id !== gid; });
            }
            if (typeof renderGroupList === 'function') renderGroupList();
            if (typeof updateBackBadge === 'function') updateBackBadge();
            if (typeof navigateBack === 'function') navigateBack();
        } catch (e) {
            showSnackbar('操作失败: ' + (e.message || ''));
        }
    }

    // ==================== 模块生命周期 ====================

    function reset() {
        _selected = {};
        _inviteSelected = {};
        _inviteBotSelected = {};
        _cgAvatarUrl = '';
        _invites = [];
        _invitesLoaded = false;
        _inviteBadgeAt = 0;
        _creating = false;
        _sendingInvite = false;
        _inviteHandling = false;
        refreshInviteBadge();
    }

    function init() {
        if (!currentUser) return;
        refreshInviteBadge();
    }

    // ==================== 导出 ====================
    window.groupModule = {
        init: init,
        reset: reset,
        refreshInviteBadge: refreshInviteBadge,
        handleInvite: handleInvite,
        toggleAdmin: toggleAdmin,
        applyMute: applyMute,
        applyCustomMute: applyCustomMute
    };

    window.openCreateGroupDialog = openCreateGroupDialog;
    window.closeCreateGroupDialog = closeCreateGroupDialog;
    window.handleCgAvatarSelect = handleCgAvatarSelect;
    window.submitCreateGroup = submitCreateGroup;
    window.openGroupInvitesDialog = openGroupInvitesDialog;
    window.closeGroupInvitesDialog = closeGroupInvitesDialog;
    window.showGroupInfoDialog = showGroupInfoDialog;
    window.closeGroupInfoDialog = closeGroupInfoDialog;
    window.showGroupMembersDialog = showGroupMembersDialog;
    window.closeGroupMembersDialog = closeGroupMembersDialog;
    window.openGroupInviteFriendsDialog = openGroupInviteFriendsDialog;
    window.closeGroupInviteFriendsDialog = closeGroupInviteFriendsDialog;
    window.submitGroupInviteFriends = submitGroupInviteFriends;
    window.switchInviteTab = switchInviteTab;
    window.quitCurrentGroup = quitCurrentGroup;
    window.openGroupInfoEdit = openGroupInfoEdit;
    window.closeGroupInfoEditDialog = closeGroupInfoEditDialog;
    window.handleGieAvatarSelect = handleGieAvatarSelect;
    window.submitGroupInfoEdit = submitGroupInfoEdit;
    window.openGroupMuteDialog = openGroupMuteDialog;
    window.openGroupMuteAllDialog = openGroupMuteAllDialog;
    window.closeGroupMuteDialog = closeGroupMuteDialog;
    window.openGroupManageDialog = openGroupManageDialog;
    window.closeGroupManageDialog = closeGroupManageDialog;
    window.transferGroup = transferGroup;
    window.unmuteGroupMember = unmuteGroupMember;
    window.kickGroupMember = kickGroupMember;
    window.clearGroupMessages = clearGroupMessages;
})();
