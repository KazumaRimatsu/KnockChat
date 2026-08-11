/* KnockChat 服务端桥接层：所有服务端数据访问经由 HTTP 调用 Cloudflare Worker API（POST /rpc）。
 * 云存储凭证只存在于 Worker Secret 环境变量与 BELL 管理端配置，客户端（含打包 exe）不包含任何密钥。
 * 用法：
 *   const { data, error } = await s3.rpc('send_private_message', { p_username, ... });
 *   const status = await s3.status();
 */

window.s3 = (function() {
    // v102: API 地址内存缓存——localStorage 覆盖（cika_api_base）几乎不会在运行中变化，
    // 避免每次 RPC 都重复读 localStorage；调试面板改动后调用 resetApiBaseCache() 刷新。
    var _apiBaseCache = null;
    function apiBase() {
        if (_apiBaseCache !== null) return _apiBaseCache;
        var b = '';
        try { b = localStorage.getItem('cika_api_base') || ''; } catch (e) {}
        if (b && b.trim()) _apiBaseCache = b.trim().replace(/\/+$/, '');
        else _apiBaseCache = (typeof API_BASE_URL !== 'undefined' && API_BASE_URL)
            ? String(API_BASE_URL).replace(/\/+$/, '')
            : 'https://YOUR_WORKER_SUBDOMAIN.workers.dev';
        return _apiBaseCache;
    }
    function resetApiBaseCache() { _apiBaseCache = null; }

    // v085: 调试浮窗 RPC 日志——错误必记；成功只记"关键 RPC"或耗时超阈值的慢请求，避免轮询刷屏
    var RPC_IMPORTANT = {
        // 认证/注册
        verify_login_secure_rate_limited: 1, verify_login_secure: 1, verify_login: 1,
        verify_session_secure: 1, verify_session: 1, record_login: 1,
        check_username_exists: 1, register_user_secure: 1, register_user: 1,
        // 消息（v100：公聊已移除，群聊走 send_group_message_secure）
        send_group_message_secure: 1, send_private_message: 1,
        delete_group_message: 1, delete_private_message: 1, mark_private_messages_read: 1,
        // 智能体
        get_agents: 1, save_agent: 1, delete_agent_rpc: 1, call_agent_llm_rate_limited: 1,
        // 账号/会话/媒体
        change_password_secure: 1, delete_my_account: 1, update_username: 1, update_avatar: 1,
        upsert_user_profile: 1, toggle_block_user: 1, get_blocked_users: 1,
        create_private_session: 1, delete_private_session: 1, upload_media: 1
    };
    // 高频轮询/静默类 RPC：成功时一律不记
    var RPC_NOISY = {
        get_group_messages: 1, get_my_groups: 1, get_private_messages: 1, get_private_sessions: 1,
        get_user_profile: 1, get_media_url: 1, get_cloud_control: 1, mention_candidates: 1
    };
    function logRpc(name, ms, err) {
        try {
            if (!window.__debugLog) return;
            if (err) {
                window.__debugLog('RPC ' + name + ' 失败 (' + ms + 'ms): ' + err);
                return;
            }
            if (RPC_NOISY[name]) return;
            if (RPC_IMPORTANT[name] || ms >= 3000) {
                window.__debugLog('RPC ' + name + ' OK (' + ms + 'ms)');
            }
        } catch (e) {}
    }

    // v088: 会话失效集中检测——后端校验会话失败统一返回 { success:false, message:"请重新登录" }
    // 或 { success:true, valid:false }；检测到即通知上层（api.js 注册的 __onSessionInvalid）直接退出登录
    function checkSessionInvalid(name, data) {
        try {
            if (!data || typeof data !== 'object') return;
            var invalid = false;
            if (data.success === false && data.message === '请重新登录') invalid = true;
            else if (data.success !== false && data.valid === false) invalid = true;
            if (invalid && typeof window.__onSessionInvalid === 'function') {
                window.__onSessionInvalid(name, data);
            }
        } catch (e) { /* 检测失败不影响业务 */ }
    }

    // v089: RPC 请求超时保护——无超时的 fetch 在网络抖动/响应丢失/Worker 卡顿时会永远挂起，
    // 调用方（如图片发送流程）await 永远不返回，导致「发送中」按钮动画一直转圈。
    // 默认 30s；大体积 base64 上传（upload_media/upload_emoji）放宽到 120s。可传第三参覆盖。
    var RPC_DEFAULT_TIMEOUT = 30000;
    var RPC_MEDIA_TIMEOUT = 120000;

    async function rpc(name, params, timeoutMs) {
        var t0 = Date.now();
        var t = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs
            : (name === 'upload_media' || name === 'upload_emoji' ? RPC_MEDIA_TIMEOUT : RPC_DEFAULT_TIMEOUT);
        var ctrl = null;
        var timer = null;
        try {
            if (typeof AbortController !== 'undefined') {
                ctrl = new AbortController();
                timer = setTimeout(function() { try { ctrl.abort(); } catch (e) {} }, t);
            }
            try {
                const resp = await fetch(apiBase() + '/rpc', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: name, params: params || {} }),
                    signal: ctrl ? ctrl.signal : undefined
                });
                let body = null;
                try { body = await resp.json(); } catch (e) { /* 非 JSON 响应 */ }
                // 统一结构：{ ok:true, data } | { ok:false, error:{message} }
                if (body && body.ok === true) {
                    const data = body.data !== undefined ? body.data : null;
                    logRpc(name, Date.now() - t0, null);
                    checkSessionInvalid(name, data);
                    return { data: data, error: null };
                }
                const msg = (body && body.error && body.error.message) ? String(body.error.message)
                    : (body && body.error && typeof body.error === 'string') ? body.error
                    : ('HTTP ' + resp.status);
                logRpc(name, Date.now() - t0, msg);
                return { data: null, error: { message: msg } };
            } finally {
                if (timer) clearTimeout(timer);
            }
        } catch (e) {
            const aborted = !!(ctrl && ctrl.signal && ctrl.signal.aborted);
            const msg = aborted ? ('请求超时(' + (t / 1000) + 's)，请检查网络后重试') : ((e && e.message) ? String(e.message) : String(e));
            logRpc(name, Date.now() - t0, msg);
            return { data: null, error: { message: msg } };
        }
    }

    return {
        rpc: rpc,
        apiBase: apiBase,
        resetApiBaseCache: resetApiBaseCache,
        // 服务端配置状态（连通性自检）
        status: function() {
            var ctrl = null;
            var timer = null;
            if (typeof AbortController !== 'undefined') {
                ctrl = new AbortController();
                // 状态自检加超时保护，避免 DNS/网络挂起时界面一直转圈
                timer = setTimeout(function() { try { ctrl.abort(); } catch (e) {} }, 8000);
            }
            var p = fetch(apiBase() + '/status', { signal: ctrl ? ctrl.signal : undefined })
                .then(function(resp) {
                    return resp.json().then(function(body) {
                        if (body && body.ok === true && body.data) return body.data;
                        if (body && body.data) return body.data;
                        return { configured: false, message: '服务端状态异常' };
                    }).catch(function() {
                        return { configured: false, message: '服务端状态异常' };
                    });
                })
                .catch(function() {
                    return { configured: false, message: '服务端不可达' };
                });
            return p.finally(function() { if (timer) clearTimeout(timer); });
        },
        // 获取媒体访问 URL（私有桶场景用预签名 URL；公共读桶返回直链）
        mediaUrl: function(key) {
            return rpc('get_media_url', { p_key: key }).then(function(res) {
                if (res.error || !res.data || res.data.success === false) return '';
                return res.data.url || '';
            });
        }
    };
})();
