/* KnockChat S3 后端桥接层：所有服务端数据访问经由 Tauri invoke 转发到 Rust 侧（s3rpc_* 命令）。
 * 凭证只存在于 src-tauri Rust 侧，前端永远接触不到 AccessKey/SecretKey。
 * 用法：
 *   const { data, error } = await s3.rpc('send_public_message_secure', { p_username, ... });
 *   const status = await s3.status();
 */

window.s3 = (function() {
    function invoke(cmd, args) {
        if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
            return window.__TAURI__.core.invoke(cmd, args || {});
        }
        return Promise.reject(new Error('Tauri 后端不可用：请通过桌面应用（KnockChat）运行本程序'));
    }

    // v085: 调试浮窗 RPC 日志——错误必记；成功只记"关键 RPC"或耗时超阈值的慢请求，避免轮询刷屏
    var RPC_IMPORTANT = {
        // 认证/注册
        verify_login_secure_rate_limited: 1, verify_login_secure: 1, verify_login: 1,
        verify_session_secure: 1, verify_session: 1, record_login: 1,
        check_username_exists: 1, register_user_secure: 1, register_user: 1,
        // 消息
        send_public_message_secure: 1, send_private_message: 1, send_agent_message: 1,
        delete_public_message: 1, delete_private_message: 1, mark_private_messages_read: 1,
        // 智能体
        get_agents: 1, save_agent: 1, delete_agent_rpc: 1, call_agent_llm_rate_limited: 1,
        // 账号/会话/媒体
        change_password_secure: 1, delete_my_account: 1, update_username: 1, update_avatar: 1,
        upsert_user_profile: 1, toggle_block_user: 1, get_blocked_users: 1,
        create_private_session: 1, delete_private_session: 1, upload_media: 1
    };
    // 高频轮询/静默类 RPC：成功时一律不记
    var RPC_NOISY = {
        get_public_messages: 1, get_private_messages: 1, get_private_sessions: 1,
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

    // 与旧 sb.rpc 返回结构一致：{ data, error }
    async function rpc(name, params) {
        var t0 = Date.now();
        try {
            const data = await invoke('s3rpc_call', { name: name, params: params || {} });
            logRpc(name, Date.now() - t0, null);
            return { data: data, error: null };
        } catch (e) {
            const msg = (e && e.message) ? String(e.message) : String(e);
            logRpc(name, Date.now() - t0, msg);
            return { data: null, error: { message: msg } };
        }
    }

    return {
        rpc: rpc,
        invoke: invoke,
        status: function() {
            return invoke('s3_status', {});
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
