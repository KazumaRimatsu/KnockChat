/* KnockChat 实时层（v089）：WebSocket 连接管理
 * - 登录后 window.rt.connect(uid, username)，登出时 disconnect()
 * - 心跳 25s（与 Worker 超时 90s 匹配）；断线指数退避重连 2s → 最大 30s
 * - 服务端事件交给 chat.js 注册的全局回调：
 *     __rtOnOnlineCount(count)  在线人数
 *     __rtOnOnlineList(users)   新连接初始化（当前在线用户列表）
 *     __rtOnPresence(uid, username, online)  某用户上下线
 *     __rtOnRead(sessionId, uid, ts)  对方已读回执
 */

window.rt = (function() {
    var ws = null;
    var heartbeat = null;
    var retryTimer = null;
    var retryDelay = 2000;
    var running = false;
    var myUid = 0;
    var myUsername = '';
    var HEARTBEAT_MS = 25000;
    var MAX_RETRY_MS = 30000;

    function wsUrl() {
        var base = '';
        try { base = s3.apiBase(); } catch (e) {}
        if (!base) return '';
        return base.replace(/^http/, 'ws') + '/ws';
    }

    function dispatch(fn, args) {
        try {
            if (typeof window[fn] === 'function') window[fn].apply(null, args);
        } catch (e) { console.warn('[rt] 事件处理失败:', fn, e); }
    }

    function scheduleRetry() {
        if (!running) return;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    }

    function connect() {
        if (!running) return;
        try {
            if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
        } catch (e) {}
        var url = wsUrl();
        if (!url) { scheduleRetry(); return; }
        var socket;
        try { socket = new WebSocket(url); } catch (e) { scheduleRetry(); return; }
        ws = socket;
        socket.onopen = function() {
            retryDelay = 2000;
            try {
                socket.send(JSON.stringify({ type: 'hello', uid: myUid, token: getSessionToken(), username: myUsername }));
            } catch (e) {}
            clearInterval(heartbeat);
            heartbeat = setInterval(function() {
                try {
                    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
                } catch (e) {}
            }, HEARTBEAT_MS);
        };
        socket.onmessage = function(ev) {
            var data = null;
            try { data = JSON.parse(ev.data); } catch (e) { return; }
            if (!data || typeof data !== 'object') return;
            if (data.type === 'online_count') dispatch('__rtOnOnlineCount', [data.count]);
            else if (data.type === 'online_list') dispatch('__rtOnOnlineList', [data.users || []]);
            else if (data.type === 'presence') dispatch('__rtOnPresence', [data.uid, data.username, data.online]);
            else if (data.type === 'read') dispatch('__rtOnRead', [data.session_id, data.uid, data.ts]);
        };
        socket.onclose = function() {
            clearInterval(heartbeat);
            scheduleRetry();
        };
        socket.onerror = function() {
            try { socket.close(); } catch (e) {}
        };
    }

    return {
        connect: function(uid, username) {
            myUid = uid;
            myUsername = username || '';
            running = true;
            retryDelay = 2000;
            clearTimeout(retryTimer);
            connect();
        },
        disconnect: function() {
            running = false;
            clearInterval(heartbeat);
            clearTimeout(retryTimer);
            try { if (ws) ws.close(); } catch (e) {}
            ws = null;
        },
        // 进入私聊会话时发送已读回执（仅在线时即时转发，离线由 RPC 落库兜底）
        sendRead: function(sessionId, toUid, ts) {
            try {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'read', session_id: sessionId, to_uid: toUid, ts: ts || new Date().toISOString() }));
                }
            } catch (e) {}
        },
        isOpen: function() { return !!(ws && ws.readyState === WebSocket.OPEN); }
    };
})();
