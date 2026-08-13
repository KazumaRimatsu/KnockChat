/* KnockChat Golem 机器人账号管理模块（v103）
 * 依赖：api.js（currentUid / getSessionToken）、storage.js（hashPassword）、
 *       s3.js（s3.rpc）、other.js（showSnackbar / showConfirm / navigateTo）。
 *
 * 职责：机器人账号列表与状态筛选、申请（创建）/编辑/删除、
 *       登录密钥展示与轮换（128 位，轮换后旧密钥失效）、定期密钥轮换提醒、
 *       机器人「进入的群聊」管理。
 */

let golemBots = [];
let golemFilter = 'all';
let golemEditingUid = 0; // 0 = 新增模式
let golemEditingData = null; // 编辑中的机器人数据
let golemGroups = []; // 当前编辑机器人的群聊
let golemKeyAction = null; // 密码验证弹窗动作：{ type: 'delete'|'rotate', botUid }
let golemKeyResult = ''; // 待展示的登录密钥
let golemKeyRemindDone = false; // 本次会话是否已触发密钥轮换提醒

function _golemEl(id) {
    return document.getElementById(id);
}
function _golemToken() {
    return (typeof getSessionToken === 'function') ? getSessionToken() : '';
}
function _golemEscapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 状态中文与样式标记 */
function _golemStatusMeta(status) {
    if (status === 'normal') return { label: '正常', cls: 'normal' };
    if (status === 'disabled') return { label: '已停用', cls: 'disabled' };
    return { label: '归属停用', cls: 'stopped' };
}

/** 密钥是否临近/已过轮换期（7 天内触发提醒） */
function _golemKeyExpiring(bot) {
    if (!bot || !bot.key_expire_at) return false;
    var t = Date.parse(bot.key_expire_at);
    if (isNaN(t)) return false;
    return (t - Date.now()) <= 7 * 24 * 3600 * 1000;
}

function _golemKeyExpireText(bot) {
    if (!bot || !bot.key_expire_at) return '';
    var t = Date.parse(bot.key_expire_at);
    if (isNaN(t)) return '';
    if (t <= Date.now()) return '登录密钥已到期，请及时轮换';
    var days = Math.ceil((t - Date.now()) / (24 * 3600 * 1000));
    return '登录密钥将于 ' + days + ' 天后到期';
}

// ==================== 列表 ====================

function loadGolemBots() {
    var box = _golemEl('golemList');
    if (!box) return;
    if (!currentUid) {
        box.innerHTML = '<div class="empty">请先登录</div>';
        return;
    }
    box.innerHTML = '<div class="empty">加载中...</div>';
    s3.rpc('get_my_bots', { p_uid: currentUid, p_session_token: _golemToken() }).then(function(res) {
        if (res.error) {
            box.innerHTML = '<div class="empty">' + _golemEscapeHtml(res.error.message) + '</div>';
            return;
        }
        golemBots = (res.data && Array.isArray(res.data.bots)) ? res.data.bots : [];
        renderGolemList();
        updateSettingsGolemCount();
        checkGolemKeyReminder();
    });
}

function renderGolemList() {
    var box = _golemEl('golemList');
    if (!box) return;
    var list = golemBots.filter(function(b) {
        if (golemFilter === 'all') return true;
        if (golemFilter === 'normal') return b.status === 'normal';
        if (golemFilter === 'disabled') return b.status === 'disabled' || b.status === 'stopped';
        if (golemFilter === 'expiring') return _golemKeyExpiring(b);
        return true;
    });
    if (list.length === 0) {
        box.innerHTML = '<div class="empty">' + (golemBots.length === 0
            ? '还没有机器人账号，点击右下角按钮申请'
            : '当前筛选条件下没有机器人') + '</div>';
        return;
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
        var b = list[i];
        var meta = _golemStatusMeta(b.status);
        var av = b.avatar_url
            ? ' style="background-image:url(' + _golemEscapeHtml(b.avatar_url) + ')"'
            : '';
        var expire = _golemKeyExpiring(b) ? '<div class="golem-meta golem-key-warn">' + _golemEscapeHtml(_golemKeyExpireText(b)) + '</div>' : '';
        html +=
            '<div class="golem-item">' +
                '<div class="golem-avatar"' + av + '>' + (b.avatar_url ? '' : _golemEscapeHtml((b.username || 'G').charAt(0).toUpperCase())) + '</div>' +
                '<div class="golem-info">' +
                    '<div class="golem-name">' + _golemEscapeHtml(b.username) +
                        '<span class="golem-badge ' + meta.cls + '">' + meta.label + '</span>' +
                        (b.bio ? '<div class="golem-bio">' + _golemEscapeHtml(b.bio) + '</div>' : '') +
                    '</div>' +
                    '<div class="golem-meta">UID ' + b.uid + '</div>' +
                    expire +
                '</div>' +
                '<div class="golem-actions">' +
                    '<button class="gm-btn" onclick="showGolemForm(' + b.uid + ')">编辑</button>' +
                    '<button class="gm-btn" onclick="rotateGolemKeyFlow(' + b.uid + ')">轮换密钥</button>' +
                    '<button class="gm-btn gm-btn-danger" onclick="confirmGolemDelete(' + b.uid + ')">删除</button>' +
                '</div>' +
            '</div>';
    }
    box.innerHTML = html;
}

function filterGolemBots(status, el) {
    golemFilter = status;
    var bar = _golemEl('golemFilterBar');
    if (bar) {
        var chips = bar.querySelectorAll('.golem-chip');
        for (var i = 0; i < chips.length; i++) chips[i].classList.remove('selected');
        if (el) el.classList.add('selected');
    }
    renderGolemList();
}

// ==================== 设置入口角标 ====================

function updateSettingsGolemCount() {
    var el2 = _golemEl('settingsGolemCount');
    if (!el2) return;
    el2.textContent = golemBots.length > 0 ? (golemBots.length + ' 个') : '';
}

// ==================== 新增 / 编辑弹窗 ====================

function showGolemForm(uid) {
    var title = _golemEl('golemFormTitle');
    var nameEl = _golemEl('golemName');
    var pwWrap = _golemEl('golemPasswordWrap');
    var pw = _golemEl('golemPassword');
    var pwHint = _golemEl('golemPasswordHint');
    var bio = _golemEl('golemBio');
    var avatar = _golemEl('golemAvatarUrl');
    var newPw = _golemEl('golemNewPassword');
    var keySec = _golemEl('golemKeySection');
    var statusSec = _golemEl('golemStatusSection');
    var groupsSec = _golemEl('golemGroupsSection');
    var disabled = _golemEl('golemDisabled');
    var keyExpire = _golemEl('golemKeyExpire');
    _golemEl('golemFormError').classList.remove('show');

    golemEditingUid = uid || 0;
    golemEditingData = null;

    if (golemEditingUid) {
        for (var i = 0; i < golemBots.length; i++) {
            if (golemBots[i].uid === golemEditingUid) { golemEditingData = golemBots[i]; break; }
        }
        var b = golemEditingData || {};
        title.textContent = '编辑机器人';
        nameEl.value = b.username || '';
        avatar.value = b.avatar_url || '';
        bio.value = b.bio || '';
        pw.value = '';
        newPw.value = '';
        pwHint.textContent = '修改昵称 / 停用状态 / 更换密码等关键设置时需验证机器人密码';
        keySec.classList.remove('hidden');
        statusSec.classList.remove('hidden');
        groupsSec.classList.remove('hidden');
        disabled.checked = !(b.disabled === true);
        keyExpire.textContent = b.key_expire_at
            ? ('密钥有效期至 ' + b.key_expire_at.replace('T', ' ').slice(0, 16) + '，到期后需轮换')
            : '密钥有效期为 90 天，到期后需轮换';
        loadGolemGroups();
    } else {
        title.textContent = '申请机器人账号';
        nameEl.value = '';
        avatar.value = '';
        bio.value = '';
        pw.value = '';
        newPw.value = '';
        pwHint.textContent = '用于归属账号验证机器人关键设置，登录时将由密码生成登录密钥';
        keySec.classList.add('hidden');
        statusSec.classList.add('hidden');
        groupsSec.classList.add('hidden');
    }
    _golemEl('golemBotDialog').classList.remove('hidden');
    setTimeout(function() { nameEl.focus(); }, 50);
}

function closeGolemForm() {
    _golemEl('golemBotDialog').classList.add('hidden');
    golemEditingUid = 0;
    golemEditingData = null;
    golemGroups = [];
}

function _golemShowFormError(msg) {
    var e = _golemEl('golemFormError');
    e.textContent = msg || '';
    e.classList.toggle('show', !!msg);
}

async function saveGolemBot() {
    var name = (_golemEl('golemName').value || '').trim();
    var pw = _golemEl('golemPassword').value || '';
    var bio = _golemEl('golemBio').value || '';
    var avatar = _golemEl('golemAvatarUrl').value || '';
    _golemShowFormError('');

    if (!name) { _golemShowFormError('请输入机器人昵称'); return; }

    if (!golemEditingUid) {
        // 新增模式：密码必填
        if (!pw) { _golemShowFormError('请为机器人设置密码'); return; }
        var pwHash = await hashPassword(pw);
        var res = await s3.rpc('create_bot', {
            p_uid: currentUid, p_session_token: _golemToken(),
            p_username: name, p_password_hash: pwHash, p_bio: bio, p_avatar_url: avatar,
        });
        if (res.error || (res.data && res.data.success === false)) {
            _golemShowFormError((res.error ? res.error.message : (res.data && res.data.message)) || '创建失败');
            return;
        }
        closeGolemForm();
        loadGolemBots();
        showSnackbar('机器人账号已创建');
        if (res.data && res.data.login_key) showGolemKey(res.data.login_key);
        return;
    }

    // 编辑模式
    var b = golemEditingData || {};
    var disabled = !_golemEl('golemDisabled').checked;
    var newPw = _golemEl('golemNewPassword').value || '';
    var keyChanged = (name !== (b.username || '')) || (disabled !== (b.disabled === true)) || newPw !== '';
    var params = {
        p_uid: currentUid, p_session_token: _golemToken(),
        p_bot_uid: golemEditingUid,
        p_username: name, p_bio: bio, p_avatar_url: avatar,
    };
    if (keyChanged) {
        if (!pw) { _golemShowFormError('修改关键设置需验证机器人密码'); return; }
        params.p_bot_password_hash = await hashPassword(pw);
        if (newPw) params.p_new_password_hash = await hashPassword(newPw);
    }
    params.p_disabled = disabled;

    var res2 = await s3.rpc('update_bot', params);
    if (res2.error || (res2.data && res2.data.success === false)) {
        _golemShowFormError((res2.error ? res2.error.message : (res2.data && res2.data.message)) || '保存失败');
        return;
    }
    closeGolemForm();
    loadGolemBots();
    showSnackbar('已保存');
    if (res2.data && res2.data.login_key) showGolemKey(res2.data.login_key);
}

// ==================== 群聊管理 ====================

function loadGolemGroups() {
    var listEl = _golemEl('golemGroupsList');
    if (!listEl || !golemEditingUid) return;
    listEl.innerHTML = '<div class="empty">加载中...</div>';
    s3.rpc('get_bot_groups', { p_uid: currentUid, p_session_token: _golemToken(), p_bot_uid: golemEditingUid }).then(function(res) {
        if (res.error || !res.data || res.data.success === false) {
            listEl.innerHTML = '<div class="empty">加载失败</div>';
            return;
        }
        golemGroups = Array.isArray(res.data.groups) ? res.data.groups : [];
        if (golemGroups.length === 0) {
            listEl.innerHTML = '<div class="empty">暂未加入任何群聊</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < golemGroups.length; i++) {
            var g = golemGroups[i];
            html +=
                '<div class="golem-group-item">' +
                    '<div class="golem-group-info"><span class="golem-group-name">' + _golemEscapeHtml(g.name || '未命名群聊') + '</span>' +
                    '<span class="golem-meta">' + (g.member_count || 0) + ' 人</span></div>' +
                    '<button class="gm-btn gm-btn-danger" onclick="botGroupRemove(' + _golemEscapeHtml(String(g.gid)) + ')">退出</button>' +
                '</div>';
        }
        listEl.innerHTML = html;
    });
}

async function botGroupRemove(gid) {
    var listEl = _golemEl('golemGroupsList');
    var res = await s3.rpc('bot_remove_group', {
        p_uid: currentUid, p_session_token: _golemToken(), p_bot_uid: golemEditingUid, p_gid: String(gid),
    });
    if (res.error || (res.data && res.data.success === false)) {
        showSnackbar((res.error ? res.error.message : (res.data && res.data.message)) || '操作失败');
        return;
    }
    showSnackbar('已移出群聊');
    loadGolemGroups();
}

// ==================== 删除 / 轮换密钥（需机器人密码） ====================

function confirmGolemDelete(uid) {
    showConfirm('删除机器人账号', '删除后机器人账号将无法恢复，确定删除？', function() {
        golemKeyAction = { type: 'delete', botUid: uid };
        _golemEl('golemPasswordTitle').textContent = '删除机器人账号';
        _golemEl('golemPasswordHintText').textContent = '删除操作需要验证机器人账号的密码。';
        openGolemPasswordDialog();
    });
}

function rotateGolemKeyFlow(uid) {
    var botUid = uid || golemEditingUid;
    if (!botUid) return;
    golemKeyAction = { type: 'rotate', botUid: botUid };
    _golemEl('golemPasswordTitle').textContent = '轮换登录密钥';
    _golemEl('golemPasswordHintText').textContent = '轮换后旧密钥立即失效，新密钥仅展示一次，请妥善保存。';
    openGolemPasswordDialog();
}

function openGolemPasswordDialog() {
    var input = _golemEl('golemPasswordInput');
    var err = _golemEl('golemPasswordError');
    input.value = '';
    err.classList.remove('show');
    _golemEl('golemPasswordDialog').classList.remove('hidden');
    setTimeout(function() { input.focus(); }, 50);
}

function closeGolemPasswordDialog() {
    _golemEl('golemPasswordDialog').classList.add('hidden');
    golemKeyAction = null;
}

async function confirmGolemPasswordAction() {
    var action = golemKeyAction;
    if (!action) return;
    var input = _golemEl('golemPasswordInput');
    var err = _golemEl('golemPasswordError');
    var pw = input.value || '';
    if (!pw) { err.textContent = '请输入机器人密码'; err.classList.add('show'); return; }
    var pwHash = await hashPassword(pw);

    if (action.type === 'delete') {
        var del = await s3.rpc('delete_bot', {
            p_uid: currentUid, p_session_token: _golemToken(),
            p_bot_uid: action.botUid, p_bot_password_hash: pwHash,
        });
        if (del.error || (del.data && del.data.success === false)) {
            err.textContent = (del.error ? del.error.message : (del.data && del.data.message)) || '删除失败';
            err.classList.add('show');
            return;
        }
        closeGolemPasswordDialog();
        loadGolemBots();
        showSnackbar('机器人账号已删除');
    } else if (action.type === 'rotate') {
        var rot = await s3.rpc('rotate_bot_key', {
            p_uid: currentUid, p_session_token: _golemToken(),
            p_bot_uid: action.botUid, p_bot_password_hash: pwHash,
        });
        if (rot.error || (rot.data && rot.data.success === false)) {
            err.textContent = (rot.error ? rot.error.message : (rot.data && rot.data.message)) || '轮换失败';
            err.classList.add('show');
            return;
        }
        closeGolemPasswordDialog();
        loadGolemBots();
        showSnackbar('登录密钥已轮换，旧密钥已失效');
        if (rot.data && rot.data.login_key) showGolemKey(rot.data.login_key);
    }
}

// ==================== 登录密钥展示 ====================

function showGolemKey(key) {
    golemKeyResult = key || '';
    _golemEl('golemKeyResultText').textContent = golemKeyResult;
    _golemEl('golemKeyDialog').classList.remove('hidden');
}

function closeGolemKeyDialog() {
    _golemEl('golemKeyDialog').classList.add('hidden');
}

function copyGolemKey() {
    if (!golemKeyResult) return;
    function done(ok) {
        showSnackbar(ok ? '密钥已复制' : '复制失败，请手动长按选择复制');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(golemKeyResult).then(function() { done(true); }, function() { done(false); });
    } else {
        var ta = document.createElement('textarea');
        ta.value = golemKeyResult;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        done(ok);
    }
}

// ==================== 定期密钥轮换提醒 ====================

function checkGolemKeyReminder() {
    try {
        if (golemKeyRemindDone === true) return;
        var need = golemBots.some(function(b) { return _golemKeyExpiring(b); });
        if (!need) return;
        // 同一设备每天最多提醒一次
        var today = new Date().toISOString().slice(0, 10);
        var last = localStorage.getItem('golem_key_remind_at') || '';
        if (last === today) return;
        localStorage.setItem('golem_key_remind_at', today);
        golemKeyRemindDone = true;
        var first = null;
        for (var i = 0; i < golemBots.length; i++) {
            if (_golemKeyExpiring(golemBots[i])) { first = golemBots[i]; break; }
        }
        showSnackbar('机器人「' + (first ? first.username : '') + '」的登录密钥即将到期，请及时轮换');
    } catch (e) { /* 提醒失败不影响主流程 */ }
}
