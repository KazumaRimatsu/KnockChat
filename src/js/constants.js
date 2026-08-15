/* KnockChat 常量定义：存储结构说明、表名/路径、版本、限制、通知音等全局常量 */

        // 本应用已弃用 Supabase，后端为 Cloudflare Worker 托管 API（服务端读写雨云存储桶）。
        // 凭证只保存在 Worker 的 Secret 环境变量（及 BELL 管理端本机配置），
        // 客户端（含打包后的 exe）不包含任何云存储密钥。
        // 前端统一通过 src/js/s3.js 桥接层调用 HTTP API（POST /rpc）。
        // 单存储桶目录结构（对象 Key 前缀，v100 目录式）：
        //   users/<uid>/            用户目录：info.json 资料、friends.json 好友列表、groups.json 群索引
        //   users/_index.json        用户名 → UID 索引；users/_meta.json UID 计数器
        //   sessions/               登录会话（<token code>.json）
        //   groups/<gid>/           群聊目录：info.json 资料、members.json 成员表、messages/ 群消息、files/ 群文件
        //   groups/_meta.json       GID 计数器
        //   invites/<uid>/          邀请列表：groups.json 群邀请、friends.json 好友申请（收发双向同文件）
        //   private/<sid>/          私聊目录：<sid>.json 会话、messages/ 消息、files/ 附件
        //   resrc/                  usr_ava/ 用户头像、usr_bkg/ 主页背景、group_ava/ 群头像
        //   media/emoji/            用户表情（v100 保留历史前缀）
        //   agents/               智能体配置
        //   upd/                  应用更新包（latest.json 元数据 + 安装包）
        //   config/               云控等全局配置（预留）
        // 服务端 API 地址：打包前请替换为实际部署的 Worker 地址
        //（也可在应用内 localStorage 写入 cika_api_base 覆盖，便于调试/多环境切换）
        const API_BASE_URL = 'https://api.cika-meow.top/';
        // v105: 运行环境探测——Tauri 打包客户端为 true（withGlobalTauri 注入 window.__TAURI__），浏览器中为 false。
        // 用于区分桌面端独有功能（如应用更新）的显示。
        const IS_TAURI = !!(window.__TAURI__);
        // v105: 客户端操作系统探测（Tauri WebView 的 UA 与桌面系统一致），
        // 更新推送按系统分发不同安装包：windows → .exe/.msi，macos → .dmg，linux → .AppImage/.deb
        const CLIENT_OS = (function() {
            var ua = String(navigator.userAgent || '');
            if (/Windows/i.test(ua)) return 'windows';
            if (/Macintosh|Mac OS X|MacIntel/i.test(ua)) return 'macos';
            if (/Linux/i.test(ua)) return 'linux';
            return 'other';
        })();
        const HISTORY_LIMIT = 200;
        // v088: 内核版本号——关于页「内核版本」的显示来源，发布新版本时只需更新此常量
        const KERNEL_VERSION = 111;
        const CC_BANNER_TITLE = '系统维护';
        const CC_BANNER_MSG = '系统正在维护，暂时无法登录。';
        const SALT = 'mjchat_2026_salt_v1';
        // 昵称禁止的隐藏字符：控制字符（C0/C1）与零宽/不可见格式字符（Cf）
        const HIDDEN_UNICODE_RE = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
        const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
        const COMPRESS_THRESHOLD = 2 * 1024 * 1024;
        const MAX_IMAGES_PER_MSG = 8;
        const MAX_FILE_SIZE = 32 * 1024 * 1024;
        // 上传大小/时长限制（本地首道校验，与后端 Worker mediaUploadLimit 保持一致）
        const MAX_AVATAR_SIZE = 5 * 1024 * 1024;        // 头像原图上限 5MB（裁剪压缩后通常 100-200KB）
        const MAX_AVATAR_FINAL_SIZE = 1 * 1024 * 1024;  // 头像裁剪后最终上传上限 1MB
        const MAX_BG_SIZE = 8 * 1024 * 1024;            // 背景原图上限 8MB
        const MAX_BG_FINAL_SIZE = 3 * 1024 * 1024;      // 背景裁剪后最终上传上限 3MB
        const MAX_VOICE_SIZE = 8 * 1024 * 1024;         // 语音消息上限 8MB
        const MAX_VOICE_DURATION = 120;                 // 语音最长 120 秒（到点自动停止录音）

        const PAGE_SIZE = 200;

        const NOTIFY_SOUNDS = {
            'qq': { file: 'assets/notify/qq.mp3', label: 'QQ' },
            'wechat': { file: 'assets/notify/wechat.mp3', label: '微信' },
            'whatsapp': { file: 'assets/notify/whatsapp.mp3', label: 'WhatsApp' },
            'three_note': { file: 'assets/notify/three_note.mp3', label: '三全音' }
        };

        // 通知默认设置（多处复用；写入缓存前必须拷贝，避免共享引用被修改）
        // enabled 主开关已废弃（v057：合并为「消息免打扰」后删除）；publicEnabled/privateEnabled 即各聊天「消息提示音」开关
        const DEFAULT_NOTIFY = { sound: 'three_note', publicEnabled: false, privateEnabled: true };

        // AI 服务商 → 默认模型（ai.js / 智能体设置共用，避免三处各自维护）
        const AGENT_DEFAULT_MODELS = {
            'openai': 'gpt-3.5-turbo',
            'google': 'gemini-1.5-flash',
            'anthropic': 'claude-3-5-sonnet-20241022',
            'baidu': 'ernie-4.0-8k-latest',
            'ali': 'qwen3.7-flash',
            'bytedance': 'doubao-pro-4k',
            'zhipu': 'glm-4-flash',
            'deepseek': 'deepseek-v4-flash',
            'custom': 'gpt-3.5-turbo'
        };

        // 语音消息播放/暂停按钮图标（渲染语音气泡与切换播放状态共用）
        const ICON_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

        // 圆形加载动画（md-circular-loader）：全局共享常量，避免 10+ 处重复内联 SVG。
        // 默认版无尺寸样式（由 CSS .md-circular-loader 定宽高）；需要内联尺寸时用 mdLoaderSvg(size, spanExtraStyle)
        const MD_LOADER_SVG = '<span class="md-circular-loader"><svg viewBox="0 0 22 22"><circle cx="11" cy="11" r="9.5"/></svg></span>';
        function mdLoaderSvg(size, spanExtraStyle) {
            var px = size ? 'width:' + size + 'px;height:' + size + 'px;' : '';
            var spanStyle = px + (spanExtraStyle || '');
            return '<span class="md-circular-loader"' + (spanStyle ? ' style="' + spanStyle + '"' : '') + '>' +
                '<svg viewBox="0 0 22 22"' + (px ? ' style="' + px + '"' : '') + '><circle cx="11" cy="11" r="9.5"/></svg></span>';
        }

        // 文件扩展名分类（图片/视频/音频判定、粘贴识别、群文件、文件预览共用；
        // features.js 与 fview.js 统一引用，避免两处各自维护）
        const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'psd'];
        const VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'avi', 'mkv', 'flv', 'wmv', '3gp', 'mpeg', 'mpg', 'ogv', 'm3u8'];
        const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'wma', 'amr', 'mid', 'midi'];
        // Office Web Viewer 支持的文档格式
        const OFFICE_EXTS = ['doc', 'docx', 'docm', 'dotx', 'dotm', 'rtf',
            'xls', 'xlsx', 'xlsb', 'xlsm',
            'ppt', 'pptx', 'pps', 'ppsx', 'pot', 'potx',
            'odt', 'ods', 'odp'
        ];
        const CODE_EXTS = [
            'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
            'html', 'htm', 'css', 'scss', 'sass', 'less', 'json',
            'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'cs',
            'go', 'rs', 'php', 'rb', 'sh', 'bash', 'zsh', 'sql',
            'xml', 'yaml', 'yml', 'toml', 'ini', 'conf',
            'md', 'markdown', 'swift', 'kt', 'kts', 'lua', 'r', 'dart',
            'scala', 'pl', 'perl', 'vue', 'svelte', 'dockerfile', 'makefile',
            'cmake', 'bat', 'ps1', 'diff', 'groovy', 'tex', 'proto', 'graphql', 'gql'
        ];

        // 列表时间格式化：当天显示 HH:mm，否则显示 M-d（群列表 / 好友申请 / 消息列表共用）
        function fmtListTime(iso) {
            if (!iso) return '';
            var d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            var now = new Date();
            if (d.toDateString() === now.toDateString()) {
                return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            }
            return (d.getMonth() + 1) + '-' + d.getDate();
        }

        // 本地存储键集中定义：全部 localStorage/IndexedDB/Cache 键名统一在此维护，
        // 其余文件一律通过 LS_KEYS 引用，避免散落字符串。
        // 警告：键名即实际存储 key，改动会破坏现有用户数据/配置/缓存，非必要勿修改。
        const LS_KEYS = {
            SESSION: 'mjchat_session',                          // 登录会话（{username,uid,token,pwhash}）
            LAST_LOGIN: 'mjchat_last_login',                    // 上次登录账号（快捷登录展示）
            LAST_LOGIN_TIME: 'mjchat_last_login_time',          // 上次登录时间（未读计数兜底基准）
            USER_CONFIGS: 'mjchat_user_configs',                // 各用户加密设置表 {username: AES密文}
            KEYMETA_PREFIX: 'mjchat_keymeta_',                  // 每用户 AES 密钥元数据（盐+迭代次数）
            PUBLIC_MUTED: 'mjchat_public_muted',                // 公聊免打扰 '1'/'0'（公聊已移除，兼容清理用）
            PRIVATE_MUTED: 'mjchat_private_muted',              // 私聊会话免打扰 {sessionId:true}
            GROUP_MUTED: 'mjchat_group_muted',                  // 群聊免打扰 {gid:true}（v099）
            BLOCKWORD: 'mjchat_blockword_settings',             // 屏蔽词设置
            AVATAR_PREFIX: 'mjchat_avatar_',                    // 头像 URL 缓存键前缀（按用户名）
            AVATAR_INDEX: 'mjchat_avatar_index',                // 头像缓存索引（LRU 裁剪用）
            BG_PREFIX: 'mjchat_ud_bg_',                         // 用户背景缓存键前缀（按用户名）
            MSG_CACHE_PREFIX: 'mjchat_msgcache_',               // 聊天记录加密缓存键前缀（按用户名）
            AI_MODEL_SETTINGS: 'cika_ai_model_settings',        // AI 模型设置（AES 加密，含 API Key）
            AI_TRANSLATE_SETTINGS: 'cika_ai_translate_settings',// AI 翻译设置（AES 加密）
            THEME_STORE: 'cika_theme_store_v1',                 // 主题状态（当前主题/自定义主题列表）
            FONT_STORE: 'cika_font_store_v1',                   // 字体设置
            IMGCACHE_DB: 'cika-imgcache-v1',                    // 图片字节缓存（Cache API）
            PAGE_STACK: 'mjchat_page_stack',                    // 页面导航栈（恢复上次所在页）
            API_BASE: 'cika_api_base',                          // 服务端 API 地址覆盖（调试/多环境；留空用 API_BASE_URL）
            CSRF: 'mjchat_csrf',                                // CSRF 令牌（sessionStorage，短期）
            BANNER_DISMISSED: 'mjchat_banner_dismissed',        // 隐私横幅已关闭标记（sessionStorage，单次会话）
            // 旧版遗留键：数据已并入加密用户配置，仅启动兜底清理时删除，不再写入
            LEGACY_THEME: 'mjchat_theme',
            LEGACY_THEME_COLOR: 'mjchat_theme_color',
            LEGACY_UNREAD: 'mjchat_unread',
            LEGACY_BANNERS: 'dismissedPrivacyBanners'
        };

        const PAGE_STACK_KEY = LS_KEYS.PAGE_STACK;
