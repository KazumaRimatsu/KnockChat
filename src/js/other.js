/* KnockChat 其他：通用 UI 工具、导航、菜单、主题、应用初始化 */

        let confirmCallback = null;
        function escapeHtml(t) { if (t == null) return ''; const d = document.createElement('div');
            d.textContent = String(t); return d.innerHTML; }

        function escapeAttr(t) { if (t == null) return ''; return String(t).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;'); }

        // 用于内联 onclick="fn('...')" 的 JS 字符串上下文转义。
        // 注意：HTML 实体（如 &#39;）在 JS 执行前会被浏览器解码为 '，会提前闭合 JS 字符串，
        // 因此不能复用 escapeAttr（只适用于 HTML 属性值上下文）。此处先做 JS 转义再转义 & 防实体注入。
        // 内联事件属性（onclick="fn('<arg>')"）参数转义：单引号做 JS 转义；
        // 双引号用 &quot; 实体（HTML 属性不认 \"，若保留反斜杠会把属性截断，导致页面残文/事件失效）
        function escapeJsString(t) { if (t == null) return ''; return String(t).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\r/g, '\\r').replace(/\n/g, '\\n'); }

        // ============ 保存文件到本地 ============
        // 打包后的 WebView 不支持 <a download> 触发的 Blob 下载（静默失败），
        // Tauri 环境弹系统保存对话框写入文件；浏览器环境回退原 <a download> 方式。
        // 返回 'saved' | 'cancelled' | 'failed'

        // 从 blob 的 MIME 推断扩展名
        function _extFromMime(type) {
            var map = {
                'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
                'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico',
                'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
                'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
                'application/json': 'json', 'application/pdf': 'pdf', 'text/plain': 'txt',
                'application/zip': 'zip', 'application/gzip': 'gz', 'application/x-7z-compressed': '7z'
            };
            if (!type) return '';
            var base = String(type).split(';')[0].toLowerCase();
            return map[base] || '';
        }

        // 清洗文件名：去掉非法字符、补扩展名（按 MIME 推断，缺省 .bin）、截断过长基础名
        function _sanitizeFileName(name, blob) {
            var n = String(name || '').trim();
            n = n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
            if (!n) n = 'download';
            var m = n.match(/\.([a-zA-Z0-9]{1,10})$/);
            var ext = m ? m[1].toLowerCase() : (_extFromMime(blob && blob.type) || 'bin');
            var base = m ? n.slice(0, m.index) : n;
            if (base.length > 30) base = base.slice(0, 30);
            return base + '.' + ext;
        }

        async function saveBlobFile(fileName, blob) {
            var safeName = _sanitizeFileName(fileName, blob);
            if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
                try {
                    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
                    const saved = await window.__TAURI__.core.invoke('save_binary_file', { fileName: safeName, data: bytes });
                    return saved === false ? 'cancelled' : 'saved';
                } catch (e) {
                    if (window.__debugLog) window.__debugLog('Tauri 保存失败，回退浏览器下载: ' + (e.message || e));
                }
            }
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = safeName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
            return 'saved';
        }

        // ============ mjv064 消息协议（对齐 MJChat v1.6.1） ============
        // 封装一段 mjv064 标签：<mjv064 type="file" name="..." size="..." url="...">fallback</mjv064>
        function _wrapMjV064(type, attrs, fallbackText) {
            var parts = ['type="' + type + '"'];
            for (var k in attrs) {
                if (attrs.hasOwnProperty(k)) {
                    parts.push(k + '="' + escapeHtml(String(attrs[k])) + '"');
                }
            }
            return '<mjv064 ' + parts.join(' ') + '>' + (fallbackText || '') + '</mjv064>';
        }

        // 解析 mjv064 标签开头的属性（[1] 为属性串，[2] 为标签内容）
        // 属性值写入时经 escapeHtml 转义，解析时需还原（&amp; → & 等），
        // 否则预签名 URL 里的 & 会变成字面 &amp;，导致签名参数错乱、图片/文件加载 403。
        function _decodeMjV064Value(s) {
            if (s == null) return '';
            const d = document.createElement('div');
            d.innerHTML = String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return d.textContent;
        }
        function _parseMjV064(matchResult) {
            var attrs = {};
            if (!matchResult) return attrs;
            matchResult[1].replace(/(\w+)="([^"]*)"/g, function(m, k, v) { attrs[k] = _decodeMjV064Value(v); });
            return attrs;
        }

        // 取 mjv064 消息的会话/回复预览文案（非 mjv064 返回空串）
        function getMjV064Preview(text) {
            if (!text) return '';
            var m = String(text).match(/<mjv064\s+([^>]*)>/);
            if (!m) return '';
            var a = _parseMjV064(m);
            if (a.type === 'voice') return '[语音]';
            // v089: 链接预览不再拼接 url/text，避免侧边栏/回复预览暴露完整链接
            if (a.type === 'link') return '[链接]';
            if (a.type === 'file') return '[文件] ' + (a.name || '');
            // v091: 自定义表情预览（CQ 码与图片分开，预览只显示占位文案）
            if (a.type === 'emoji') return '[表情]';
            return '[消息]';
        }

        // 旧 CQ 码（[CQ:type,param=value,...]）替换为版本升级提示
        function _replaceCQCodes(text) {
            if (!text) return text;
            var cqPattern = /\[CQ:[\w]+(?:,[\w]+=[^\]]+)*\]/g;
            if (cqPattern.test(text)) {
                return text.replace(cqPattern, '<span style="color:var(--md-on-surface-variant);font-size:0.8rem;font-style:italic;">[当前版本不支持查看，请更新MJChat版本]</span>');
            }
            return text;
        }

        // 秒数 → mm:ss（语音消息时长多处共用）
        function formatDuration(seconds) {
            seconds = Math.max(0, Math.floor(Number(seconds) || 0));
            return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
        }

        // 生成语音气泡波形条（高度随机，渲染时调用）
        function buildVoiceWaves(count) {
            const n = count || 12;
            let bars = '';
            for (let i = 0; i < n; i++) {
                bars += `<div class="voice-wave" style="height:${Math.floor(Math.random() * 16 + 4)}px"></div>`;
            }
            return bars;
        }

        // 语音消息气泡 HTML（公聊/私聊共用；无 audio_url 时显示升级提示）
        function buildVoiceBubbleHtml(audioUrl, duration, noUrlText) {
            const durStr = formatDuration(duration);
            const cleanAudioUrl = mediaUrlToPublic(audioUrl);
            if (cleanAudioUrl) {
                return `<div class="voice-msg-wrap" data-audio="${escapeAttr(cleanAudioUrl)}" data-dur="${Number(duration) || 0}" onclick="toggleVoicePlay(this, event)"><button class="voice-play-btn">${ICON_PLAY}</button><div class="voice-waves">${buildVoiceWaves()}</div><span class="voice-dur">${durStr}</span></div>`;
            }
            return `<div class="voice-msg-wrap"><span class="voice-dur">${durStr}</span><span style="font-size:0.75rem;color:var(--md-on-surface-variant);margin-left:8px;">${escapeHtml(noUrlText || '请升级到最新版本播放')}</span></div>`;
        }

        // 填充用户头像元素：有 URL 用背景图，否则显示首字母
        function fillUserAvatar(avatarEl, user, avatarUrl) {
            if (!avatarEl || !user) return;
            const cleanUrl = mediaUrlToPublic(avatarUrl);
            if (cleanUrl) {
                avatarEl.style.backgroundImage = `url(${cleanUrl})`;
                avatarEl.textContent = '';
            } else {
                avatarEl.style.backgroundImage = '';
                avatarEl.textContent = user.charAt(0).toUpperCase();
            }
        }

        function isSafeUrl(url) {
            if (!url || typeof url !== 'string') return false;
            const u = url.trim();
            // 与 cleanHtml 的 href 白名单保持一致，并显式排除 javascript:
            if (!/^(https?:|mailto:|tel:|#|\/)/i.test(u)) return false;
            if (/^javascript:/i.test(u)) return false;
            return true;
        }

        function sanitizeAvatarUrl(url) {
            if (!url || typeof url !== 'string') return '';
            const u = mediaUrlToPublic(url);
            if (!/^https?:\/\//i.test(u)) return '';
            return u.replace(/['"\\]/g, '');
        }

        // 将（已过期/更换 AK 后失效的）预签名媒体链接还原为同源的公开直链：
        // 去掉 ?X-Amz-* 签名参数。桶为公共读，直链永久有效（已验证 GET 200），
        // 避免头像、背景、图片、文件因 7 天签名过期或旧 AK 失效而 403 无法加载。
        // 非预签名链接（已是公开直链）原样返回。
        function mediaUrlToPublic(url) {
            if (!url || typeof url !== 'string') return '';
            const u = url.trim();
            if (!/^https?:\/\//i.test(u)) return '';
            try {
                const parsed = new URL(u);
                if (/X-Amz-/i.test(parsed.search)) parsed.search = '';
                return parsed.toString();
            } catch (e) {
                return u.replace(/['"\\]/g, '');
            }
        }

        function getMessagePreview(text) {
            if (!text) return '';
            if (text.startsWith('__RPL__')) {
                const m = text.match(/^__RPL__.*?__ENDRPL__/);
                if (m) text = text.substring(m[0].length);
            }
            const mjPreview = getMjV064Preview(text);
            if (mjPreview) return mjPreview;
            // v089: 纯图片 markdown（![](...)）预览归一为 [图片]
            if (/^!\[[^\]]*\]\([^)]*\)/.test(text)) return '[图片]';
            if (text.startsWith('🎤 ')) return text.replace(/ → .*$/, '');
            if (text.startsWith('🔗 ')) return '[链接]';
            if (text.startsWith('📎 ')) {
                const m = text.match(/📎 (.*?) \(/);
                return m ? m[1] : text;
            }
            if (text.startsWith('🖼️ ')) return '[图片]';
            return text.length > 40 ? text.substring(0, 40) + '…' : text;
        }

        // ============ v101: 统一消息内容协议（contents JSON） ============
        // 所有消息（含系统消息）的内容统一存储于消息对象的 contents 字段，
        // 值为 {type, ...} JSON，替代旧的 text/image_url/audio_url/mjv064 混合协议：
        //   text → { type:"text", content:"123456" }        纯文本
        //   image → { type:"image", url:"xxx" }             图片
        //   video → { type:"video", url:"xxx" }             视频
        //   file → { type:"file", url:"xxx", name?, size? } 文件
        //   audio → { type:"audio", url:"xxx", dur? }       语音（dur 为时长秒）
        //   emoji → { type:"emoji", url:"xxx" }             自定义表情
        //   system → { type:"system", content:"xxx加入了群聊" } 系统消息
        //   richtext → { type:"richtext", content:"<h1>xxx</h1>" } 富文本（渲染端白名单清洗）

        // 构造 contents JSON 字符串（发送用）
        function buildContents(type, payload) {
            const obj = { type: type };
            for (var k in payload) {
                if (payload.hasOwnProperty(k)) {
                    // v103: 文本消息内容 Base58 编码后提交（b58: 前缀），后端原样存储密文、读取时解码
                    obj[k] = (type === 'text' && k === 'content') ? 'b58:' + base58EncodeText(payload[k]) : payload[k];
                }
            }
            return JSON.stringify(obj);
        }

        // Base58 字符集（比特币风格：去掉易混淆的 0 O I l），与后端 util.ts 保持一致
        const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

        // 文本 → Base58（UTF-8 字节 + BigInt 大数，前导零字节映射为 '1'）
        function base58EncodeText(text) {
            const bytes = new TextEncoder().encode(String(text));
            let x = 0n;
            for (const b of bytes) x = x * 256n + BigInt(b);
            let out = '';
            while (x > 0n) { out = B58_ALPHABET[Number(x % 58n)] + out; x /= 58n; }
            for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
            return out;
        }

        // 解析消息 contents：兼容字符串/对象；旧消息回退 text/image_url/audio_url 字段
        function parseMsgContents(msg) {
            if (!msg) return { type: 'text', content: '' };
            if (msg.contents) {
                if (typeof msg.contents === 'string') {
                    try {
                        const o = JSON.parse(msg.contents);
                        if (o && typeof o === 'object' && typeof o.type === 'string') return o;
                    } catch (e) { /* 回退 */ }
                } else if (typeof msg.contents === 'object' && msg.contents.type) {
                    return msg.contents;
                }
            }
            // 历史消息兜底
            if (msg.image_url) return { type: 'image', url: msg.image_url };
            if (msg.audio_url) return { type: 'audio', url: msg.audio_url, dur: msg.audio_dur || 0 };
            if (msg.text) return { type: 'text', content: msg.text };
            return { type: 'text', content: '' };
        }

        // URL → 文件名（去 query/hash，URI 解码）
        function fileNameFromUrl(url) {
            if (!url) return '文件';
            const clean = String(url).split('?')[0].split('#')[0];
            const name = clean.split('/').pop() || '文件';
            try { return decodeURIComponent(name); } catch (e) { return name; }
        }

        // contents → 会话/回复预览文案（与后端 contentsPreview 保持一致）
        function getContentsPreview(contents) {
            const c = contents || {};
            const content = String(c.content || '');
            switch (c.type) {
                case 'system': return content || '';
                case 'image': return '[图片]';
                case 'video': return '[视频]';
                case 'file': return '[文件] ' + fileNameFromUrl(c.url);
                case 'audio': return '[语音]';
                case 'emoji': return '[表情]';
                case 'richtext':
                    if (content.indexOf('<a ') !== -1) return '[链接]';
                    if (content.indexOf('<img') !== -1) return '[图片]';
                    return '[消息]';
                default: {
                    // 文本：剥离内联表情码与私聊回复前缀后截断
                    let t = content.replace(/<mjv064[\s\S]*?<\/mjv064>/g, '[表情]');
                    t = t.replace(/^__RPL__.*?__ENDRPL__/, '');
                    return t.length > 40 ? t.substring(0, 40) + '…' : t;
                }
            }
        }

        // contents.type → dataset.msgType（历史值：text/image/link/voice/video/file/emoji）
        function contentsMsgType(c) {
            const t = c && c.type;
            if (t === 'image' || t === 'emoji') return t;
            if (t === 'video') return 'video';
            if (t === 'audio') return 'voice';
            if (t === 'file') return 'file';
            if (t === 'richtext') {
                const content = String((c && c.content) || '');
                if (content.indexOf('<a ') !== -1) return 'link';
                return 'richtext';
            }
            return 'text';
        }

        // 文本内容渲染：清洗 HTML → 自动链接 URL → 内联表情码还原为小图 → @提及高亮
        function renderTextContent(text) {
            if (!text) return '';
            let t = String(text);
            // 1. 保护内联表情码（mjv064 emoji），避免被 cleanHtml 剥离
            const saved = [];
            t = t.replace(/<mjv064\s+type="emoji"([\s\S]*?)<\/mjv064>/g, function(m) {
                saved.push(m);
                return '\u0001MJE' + (saved.length - 1) + '\u0001';
            });
            // 2. 自动识别 URL 并链接（在清洗前进行；标签属性内（=、"、' 后）的 URL 跳过，避免破坏已有标签）
            t = t.replace(/(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi, function(m, p1, offset, full) {
                const prev = offset > 0 ? full[offset - 1] : '';
                if (prev === '=' || prev === '"' || prev === "'") return m;
                let url = m;
                if (!/^https?:/i.test(url)) url = 'https://' + url;
                if (!isSafeUrl(url)) return m;
                return '<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer" style="color:var(--md-link);text-decoration:underline;">' + escapeHtml(m) + '</a>';
            });
            // 3. 清洗其余 HTML（白名单）
            t = cleanHtml(t);
            // 4. 还原表情码为小表情图
            t = t.replace(/\u0001MJE(\d+)\u0001/g, function(m, i) {
                const code = saved[parseInt(i, 10)] || '';
                const mm = code.match(/<mjv064\s+([^>]*)>/);
                const a = mm ? _parseMjV064(mm) : null;
                if (a && a.url) {
                    return _wrapImgWithLoader(a.url, 'alt="表情" onclick="previewImage(\'' + escapeJsString(a.url) + '\')"', 'width:28px;height:28px;object-fit:contain;vertical-align:middle;border-radius:4px;cursor:pointer;');
                }
                return '[表情]';
            });
            // 5. @提及高亮
            t = t.replace(/@([\w\u4e00-\u9fa5]+)/g, '<b>@$1</b>');
            return t;
        }

        // contents → 气泡 HTML（system 类型由调用方单独处理，此函数不渲染）
        function renderContentsBubble(contents, msg) {
            const c = contents || {};
            const url = c.url || '';
            switch (c.type) {
                case 'image':
                    return _wrapImgWithLoader(url, 'onclick="previewImage(\'' + escapeJsString(url) + '\')" alt="图片"', 'max-width:280px;max-height:280px;border-radius:12px;cursor:pointer;');
                case 'video':
                    return buildVideoBubbleHtml(url, fileNameFromUrl(url));
                case 'file':
                    return buildFileBubbleHtml(url, fileNameFromUrl(url), c.size || '');
                case 'audio':
                    return buildVoiceBubbleHtml(url, parseInt(c.dur) || (msg && msg.audio_dur) || 0, '请升级到最新版本播放');
                case 'emoji':
                    if (url) {
                        return _wrapImgWithLoader(url, 'alt="表情" onclick="previewImage(\'' + escapeJsString(url) + '\')"', 'width:80px;height:80px;object-fit:contain;border-radius:8px;cursor:pointer;');
                    }
                    return escapeHtml(c.content || '[表情]');
                case 'richtext':
                    return cleanHtml(c.content || '');
                case 'text':
                default:
                    return renderTextContent(c.content || '');
            }
        }

        // 若文本整体是一个表情码，返回其 URL；否则返回空串
        function emojiOnlyUrl(text) {
            const m = String(text || '').match(/^<mjv064\s+type="emoji"([\s\S]*?)<\/mjv064>$/);
            if (!m) return '';
            const a = _parseMjV064(m);
            return a && a.url ? a.url : '';
        }

        function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i);
                h |= 0; } return Math.abs(h); }

        function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 9); }

        function autoResize(el) { el.style.height = 'auto';
            var target = Math.min(el.scrollHeight, 100);
            // 输入区高度可调：聊天栏被拖高后，输入框随容器高度填充（容器上下 padding 各 8px）
            var container = el.closest('.input-container');
            if (container) {
                var avail = container.clientHeight - 16;
                if (avail > 100) target = avail;
            }
            el.style.height = target + 'px';
            if (typeof updateInputPlaceholder === 'function') updateInputPlaceholder(el);
            // 输入框增高会使输入区变高，回到底部按钮需同步上移
            if (typeof updateAllScrollButtonPositions === 'function') updateAllScrollButtonPositions(); }

        // ==================== contenteditable 输入框工具 ====================
        // 输入框为 contenteditable div，表情以 <img class="input-emoji"> 直接渲染在框内；
        // 读取/写入走协议文本（mjv064 CQ 码 + b/i/u/s 特效标签 + \n 换行），发送链路与旧版完全一致。

        // 占位提示：输入框空时显示 data-placeholder（:empty 对残留 <br> 不生效，故用类控制）
        function updateInputPlaceholder(input) {
            if (!input || !input.dataset || !input.dataset.placeholder) return;
            const empty = (input.innerText || '').trim() === '' && !input.querySelector('.input-emoji');
            input.classList.toggle('empty', empty);
        }

        // 读取输入框协议文本：表情图还原为 CQ 码、块级元素/<br> 还原为 \n、特效标签还原为 b/i/u/s
        function serializeInputContent(node) {
            if (node.nodeType === 3) return node.nodeValue;
            if (node.nodeType !== 1) return '';
            const tag = (node.tagName || '').toLowerCase();
            if (tag === 'br') return '\n';
            if (tag === 'img' && node.dataset && node.dataset.emojiUrl) {
                return '<mjv064 type="emoji" name="' + escapeHtml(node.dataset.emojiName || '表情') + '" url="' + escapeHtml(node.dataset.emojiUrl) + '">[表情]</mjv064>';
            }
            let inner = '';
            for (let i = 0; i < node.childNodes.length; i++) inner += serializeInputContent(node.childNodes[i]);
            if (tag === 'div' || tag === 'p') return inner + '\n';
            if (tag === 'b' || tag === 'strong') return '<b>' + inner + '</b>';
            if (tag === 'i' || tag === 'em') return '<i>' + inner + '</i>';
            if (tag === 'u') return '<u>' + inner + '</u>';
            if (tag === 's' || tag === 'strike' || tag === 'del') return '<s>' + inner + '</s>';
            return inner; // span 等：仅保留文本内容
        }

        function readInputValue(input) {
            return input ? serializeInputContent(input) : '';
        }

        function clearInput(input) {
            if (!input) return;
            input.innerHTML = '';
            autoResize(input);
        }

        // 光标前的文本（innerText 形式，供 @ 匹配/搜索）
        function getTextBeforeCursor(input) {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return '';
            const range = sel.getRangeAt(0);
            if (!input.contains(range.startContainer)) return '';
            const pre = range.cloneRange();
            pre.selectNodeContents(input);
            pre.setEnd(range.startContainer, range.startOffset);
            const div = document.createElement('div');
            div.appendChild(pre.cloneContents());
            return div.innerText;
        }

        // 光标后的文本（innerText 形式，与 getTextBeforeCursor 配套）
        function getTextAfterCursor(input) {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return '';
            const range = sel.getRangeAt(0);
            if (!input.contains(range.endContainer)) return '';
            const post = range.cloneRange();
            post.selectNodeContents(input);
            post.setStart(range.endContainer, range.endOffset);
            const div = document.createElement('div');
            div.appendChild(post.cloneContents());
            return div.innerText;
        }

        // 在光标处插入纯文本（选区替换；含换行拆为 <br>）
        function insertTextAtCursor(input, text) {
            if (text == null) text = '';
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return;
            const range = sel.getRangeAt(0);
            if (!input.contains(range.commonAncestorContainer)) {
                input.appendChild(document.createTextNode(text));
                return;
            }
            range.deleteContents();
            const frag = range.createContextualFragment(escapeHtml(text).replace(/\n/g, '<br>'));
            range.insertNode(frag);
            range.setStartAfter(frag.lastChild);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            autoResize(input);
        }

        // 在光标处插入表情（渲染为行内小图，发送时序列化还原为 CQ 码）
        function insertEmojiAtCursor(input, emojiCq) {
            const m = emojiCq.match(/<mjv064\s+([^>]*)>/);
            const a = m ? _parseMjV064(m) : null;
            if (!a || !a.url) {
                insertTextAtCursor(input, emojiCq || '');
                return;
            }
            const img = document.createElement('img');
            img.className = 'input-emoji';
            img.src = a.url;
            img.dataset.emojiName = a.name || '表情';
            img.dataset.emojiUrl = a.url;
            img.alt = '';
            const sel = window.getSelection();
            if (sel && sel.rangeCount && input.contains(sel.getRangeAt(0).commonAncestorContainer)) {
                const range = sel.getRangeAt(0);
                range.deleteContents();
                range.insertNode(img);
                range.setStartAfter(img);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            } else {
                input.appendChild(img);
            }
            autoResize(input);
            input.focus();
        }

        // 替换光标前的 @xxx 文本（@ 候选选择 / 智能体切换）
        function replaceMentionText(input, atText) {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return false;
            const range = sel.getRangeAt(0);
            if (!input.contains(range.startContainer)) return false;
            const container = range.startContainer;
            if (container.nodeType !== 3) return false; // 光标不在文本节点内则放弃
            const text = container.nodeValue;
            const m = text.substring(0, range.startOffset).match(/@[\w\u4e00-\u9fa5]*$/);
            if (!m) return false;
            const rmStart = range.startOffset - m[0].length;
            container.nodeValue = text.substring(0, rmStart) + atText + text.substring(range.startOffset);
            const newRange = document.createRange();
            newRange.setStart(container, rmStart + atText.length);
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
            autoResize(input);
            return true;
        }

        let snackbarTimer = null;

        function showSnackbar(msg) {
            const ex = document.querySelector('.snackbar');
            if (ex) ex.remove();
            if (snackbarTimer) clearTimeout(snackbarTimer);
            const s = document.createElement('div');
            s.className = 'snackbar';
            s.textContent = msg;
            document.body.appendChild(s);
            snackbarTimer = setTimeout(() => {
                s.style.opacity = '0';
                s.style.transition = 'opacity 0.3s';
                setTimeout(() => s.remove(), 300);
            }, 3000);
        }

        function showGlobalLoading(text, sub) {
            const el = document.getElementById('globalLoading');
            el.classList.remove('hidden');
            if (text) el.querySelector('.loading-text').textContent = text;
            if (sub) el.querySelector('.loading-sub').textContent = sub;
        }

        function hideGlobalLoading() {
            document.getElementById('globalLoading').classList.add('hidden');
        }

        function updateLoadingText(text, sub) {
            const el = document.getElementById('globalLoading');
            if (text) el.querySelector('.loading-text').textContent = text;
            if (sub) el.querySelector('.loading-sub').textContent = sub;
        }

        function showEl(id, msg) {
            const el = document.getElementById(id);
            el.textContent = msg;
            el.classList.add('show');
        }

        function hideEl(id) {
            document.getElementById(id).classList.remove('show');
        }

        function isScrolledToBottom(el) {
            if (!el) return true;
            const threshold = 20;
            return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
        }

        function scrollToBottom(el) {
            if (!el) return;
            el.scrollTop = el.scrollHeight;
            // v08x：贴底同时重置容器级滚动标志（公聊/私聊各自独立）
            el._userScrolledUp = false;
            el._atBottomNow = true;
        }

        // 回到底部按钮已挂在聊天页 .page 上（定位祖先），不随消息滚动；从容器或其父级查找
        function findScrollBtn(messagesContainer) {
            if (!messagesContainer) return null;
            return messagesContainer.querySelector('.scroll-to-bottom-btn') ||
                messagesContainer.parentNode.querySelector('.scroll-to-bottom-btn');
        }

        // 输入区高度可变（拖拽/自动增高），按钮 bottom 始终钉在输入区上方
        function updateScrollButtonPosition(messagesContainer) {
            const btn = findScrollBtn(messagesContainer);
            if (!btn) return;
            const chatBar = messagesContainer.parentNode.querySelector('.chat-bar');
            if (!chatBar) return;
            btn.style.bottom = (chatBar.offsetHeight + 16) + 'px';
        }

        function updateAllScrollButtonPositions() {
            ['publicMessages', 'privateMessages'].forEach(function(id) {
                const mc = document.getElementById(id);
                if (mc) updateScrollButtonPosition(mc);
            });
        }

        function updateScrollButton(messagesContainer) {
            const btn = findScrollBtn(messagesContainer);
            if (!btn) return;
            if (isScrolledToBottom(messagesContainer)) {
                btn.classList.remove('show');
            } else {
                btn.classList.add('show');
            }
        }

        function setupScrollHandlers(messagesContainer) {
            if (!messagesContainer) return;
            const oldBtn = findScrollBtn(messagesContainer);
            if (oldBtn) oldBtn.remove();
            // 移除上一次绑定的滚动/手势监听器，避免反复进入聊天后监听器累积
            if (messagesContainer._scrollHandler) {
                messagesContainer.removeEventListener('scroll', messagesContainer._scrollHandler);
                messagesContainer._scrollHandler = null;
            }
            ['_wheelHandler', '_touchStartHandler', '_touchMoveHandler', '_keydownHandler'].forEach(function(k) {
                if (messagesContainer[k]) {
                    const evt = k === '_wheelHandler' ? 'wheel' : k === '_touchStartHandler' ? 'touchstart' : k === '_touchMoveHandler' ? 'touchmove' : 'keydown';
                    messagesContainer.removeEventListener(evt, messagesContainer[k]);
                    messagesContainer[k] = null;
                }
            });

            const btn = document.createElement('button');
            btn.className = 'scroll-to-bottom-btn';
            btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>';
            btn.title = '回到最新消息';
            btn.onclick = function(e) {
                e.stopPropagation();
                scrollToBottom(messagesContainer);
                messagesContainer._userScrolledUp = false;
                updateScrollButton(messagesContainer);
                setTimeout(() => updateScrollButton(messagesContainer), 100);
            };
            // 按钮挂在聊天页 .page 上（而非消息滚动区内），滚动消息时按钮固定不动
            messagesContainer.parentNode.appendChild(btn);

            let topLoadTimer = null;
            // v08x 滚动修复：
            // 1) 改用容器级标志（_userScrolledUp/_atBottomNow），公聊/私聊互不污染；
            // 2) 仅真实用户手势（滚轮/触摸/键盘翻页）才标记"用户已上翻"，
            //    程序化滚动与内容高度变化（如图片加载）不再误标，聊天记录才能持续自动贴底。
            let userGestureTimer = null;
            const markUserGesture = function() {
                messagesContainer._userGesture = true;
                clearTimeout(userGestureTimer);
                userGestureTimer = setTimeout(function() { messagesContainer._userGesture = false; }, 600);
            };
            const wheelHandler = function(e) {
                if (e.deltaY !== 0) markUserGesture();
            };
            const touchStartHandler = markUserGesture;
            const touchMoveHandler = markUserGesture;
            const keydownHandler = function(e) {
                if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].indexOf(e.key) !== -1) markUserGesture();
            };
            messagesContainer._wheelHandler = wheelHandler;
            messagesContainer._touchStartHandler = touchStartHandler;
            messagesContainer._touchMoveHandler = touchMoveHandler;
            messagesContainer._keydownHandler = keydownHandler;
            messagesContainer.addEventListener('wheel', wheelHandler, { passive: true });
            messagesContainer.addEventListener('touchstart', touchStartHandler, { passive: true });
            messagesContainer.addEventListener('touchmove', touchMoveHandler, { passive: true });
            messagesContainer.addEventListener('keydown', keydownHandler);

            const scrollHandler = function() {
                const atBottom = isScrolledToBottom(messagesContainer);
                messagesContainer._atBottomNow = atBottom;
                if (atBottom) {
                    messagesContainer._userScrolledUp = false;
                } else if (messagesContainer._userGesture) {
                    messagesContainer._userScrolledUp = true;
                }
                updateScrollButton(messagesContainer);
                if (messagesContainer.scrollTop <= 5) {
                    clearTimeout(topLoadTimer);
                    topLoadTimer = setTimeout(() => {
                        // v099: 群聊触顶加载（替代原公聊）
                        if (messagesContainer.id === 'publicMessages' && groupHasMore) {
                            loadMoreGroupMessages();
                        } else if (messagesContainer.id === 'privateMessages' && privateHasMore && privateSessionId) {
                            loadMorePrivateMessages(privateSessionId);
                        }
                    }, 300);
                }
                clearTimeout(scrollTimeout);
                scrollTimeout = setTimeout(() => {
                    if (isScrolledToBottom(messagesContainer)) {
                        messagesContainer._userScrolledUp = false;
                        messagesContainer._atBottomNow = true;
                    }
                    updateScrollButton(messagesContainer);
                }, 500);
            };
            messagesContainer._scrollHandler = scrollHandler;
            messagesContainer.addEventListener('scroll', scrollHandler);

            // 初始定位 + 输入区高度变化（窗口尺寸/拖拽/自动增高）时保持钉在输入区上方
            updateScrollButtonPosition(messagesContainer);
            if (!window._scrollBtnResizeBound) {
                window._scrollBtnResizeBound = true;
                window.addEventListener('resize', updateAllScrollButtonPositions);
            }

            setTimeout(() => {
                scrollToBottom(messagesContainer);
                updateScrollButton(messagesContainer);
            }, 100);
        }

        function cleanHtml(html) {
            if (!html) return '';
            // 旧 CQ 码先替换为升级提示（与 MJChat v1.6.1 一致）
            html = _replaceCQCodes(html);
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const body = doc.body;
            const allowedTags = ['b', 'i', 'u', 's', 'a', 'img', 'span', 'div', 'br', 'svg', 'path', 'audio', 'source',
                'button'
            ];
            const allowedAttrs = {
                'a': ['href', 'target', 'rel'],
                'img': ['src', 'alt', 'width', 'height'],
                'audio': ['src', 'controls'],
                'source': ['src', 'type'],
                'button': ['type']
            };

            function cleanNode(node) {
                if (node.nodeType === Node.TEXT_NODE) return node.cloneNode(true);
                if (node.nodeType !== Node.ELEMENT_NODE) return null;
                const tag = node.tagName.toLowerCase();
                if (!allowedTags.includes(tag)) return null;
                const newNode = document.createElement(tag);
                const allowed = allowedAttrs[tag] || [];
                for (const attr of allowed) {
                    if (node.hasAttribute(attr)) {
                        const val = node.getAttribute(attr);
                        // v073 安全修复：src/href 统一协议白名单（src 额外允许 data:image/ 与 blob:）
                        if ((attr === 'href' || attr === 'src') && !/^(https?:|data:image\/|blob:)/i.test(val)) continue;
                        if (attr === 'href' && !val.match(/^(https?:|mailto:|tel:|#|\/)/i)) continue;
                        newNode.setAttribute(attr, val);
                    }
                }
                for (const child of node.childNodes) {
                    const cleanChild = cleanNode(child);
                    if (cleanChild) newNode.appendChild(cleanChild);
                }
                return newNode;
            }
            let result = '';
            for (const child of body.childNodes) {
                const cleanChild = cleanNode(child);
                if (cleanChild) {
                    result += cleanChild.outerHTML || cleanChild.textContent || '';
                }
            }
            return result;
        }

        // v073 安全修复：用户名严格字符白名单（字母/数字/下划线/中文，2-15 位），
        // 禁止 / \ . 与任意控制字符 —— 防止用户名作为存储路径时造成路径穿越
        function isSafeUsername(username) {
            if (!username) return false;
            if (username.length < 2 || username.length > 15) return false;
            return /^[A-Za-z0-9_\u4e00-\u9fa5]{2,15}$/.test(username);
        }

        function showConfirm(title, message, callback) {
            document.getElementById('confirmTitle').textContent = title;
            document.getElementById('confirmMessage').textContent = message;
            confirmCallback = callback;
            document.getElementById('confirmOkBtn').onclick = function() {
                var cb = confirmCallback;
                document.getElementById('confirmDialog').classList.add('hidden');
                confirmCallback = null;
                if (cb) cb();
            };
            document.getElementById('confirmDialog').classList.remove('hidden');
        }

        function closeConfirmDialog() {
            document.getElementById('confirmDialog').classList.add('hidden');
            confirmCallback = null;
        }

        let pageHistory = ['home']; // default page
        let isNavigating = false;

        function pushPageHistory(page) {
            pageHistory.push(page);
            try {
                history.pushState({ page: page, mjchat_nav: true }, '', '#' + page);
            } catch (e) { /* ignore */ }
        }

        function popPageHistory() {
            if (pageHistory.length > 1) {
                pageHistory.pop();
                return pageHistory[pageHistory.length - 1];
            }
            return 'home';
        }

        function switchPage(targetId, forward) {
            if (isNavigating) return;
            isNavigating = true;
            // 切换页面时关闭 @ 提及菜单（避免返回公聊页后残留旧弹层）
            if (typeof closeMentionMenu === 'function') closeMentionMenu();
            const pages = document.querySelectorAll('.page');
            const targetPage = document.getElementById(targetId);
            if (!targetPage) { isNavigating = false; return; }
            pages.forEach(p => p.classList.remove('active'));
            targetPage.classList.add('active');
            isNavigating = false;
        }

        function navigateTo(page) {
            if (page === 'home') {
                pushPageHistory('home');
                switchPage('homePage', true);
                updateSidebarHighlight();
                loadPrivateSessions();
                // v099: 群列表摘要/未读由 renderGroupList 内部同步（原公聊 updatePublicEntry 已删除）
                updatePublicBadge();
            } else if (page === 'public') {
                // v099: 群聊窗口（openGroupChat 为主要入口；此处兜底处理 popstate/历史恢复）
                pushPageHistory('group');
                switchPage('publicPage', true);
                updateSidebarHighlight();
                if (currentGroupId && groupMessages.length > 0) {
                    refreshGroupMessages();
                    markGroupRead();
                }
                updateBackBadge();
            } else if (page === 'search') {
                pushPageHistory('search');
                switchPage('searchPage', true);
                document.getElementById('searchInput').value = '';
                document.getElementById('searchResults').innerHTML = '<div class="empty">输入昵称开始搜索</div>';
            } else if (page === 'settings') {
                pushPageHistory('settings');
                switchPage('settingsPage', true);
                updateThemeLabel();
                refreshNotifySettingsUI();
                // v072: 刷新屏蔽词检测设置入口显示值
                updateBlockwordSettingsUI();
            } else if (page === 'about') {
                pushPageHistory('about');
                switchPage('aboutPage', true);
                // v088: 内核版本来源为 constants.js 的 KERNEL_VERSION 常量，更新版本只需维护该常量
                const mjchatVersion = document.getElementById('aboutMjchatVersion');
                if (mjchatVersion) mjchatVersion.textContent = '内核版本 v' + String(KERNEL_VERSION).padStart(3, '0');
            } else if (page === 'groupFiles') {
                pushPageHistory('groupFiles');
                switchPage('groupFilesPage', true);
                _loadGroupFiles();
            } else if (page === 'userDetail') {
                pushPageHistory('userDetail');
                switchPage('userDetailPage', true);
            } else if (page === 'editProfile') {
                pushPageHistory('editProfile');
                switchPage('editProfilePage', true);
            } else if (page === 'golem') {
                pushPageHistory('golem');
                switchPage('golemPage', true);
                loadGolemBots();
            }
            updateBackBadge();
        }

        let isHandlingPopstate = false;
        function navigateBack() {
            // 图片裁剪器：全屏覆盖层，直接取消并回到编辑页
            const iePage = document.getElementById('imageEditorPage');
            if (iePage && iePage.classList.contains('active')) {
                cancelImageEdit();
                return;
            }
            // 预览多窗口：存在打开的预览窗口时，返回键先全部关闭（不影响聊天页面）
            if (typeof fviewWindows !== 'undefined' && fviewWindows.length > 0) {
                closeMediaViewer();
                return;
            }
            // 用户详情菜单弹层：导航时收起
            const udMenu = document.getElementById('udMenuOverlay');
            if (udMenu && udMenu.classList.contains('show')) {
                udMenu.classList.remove('show');
            }
            const currentPage = pageHistory[pageHistory.length - 1];
            if (privateChatActive) {
                leavePrivateChatAnimated();
                return;
            }
            // v099: 从群聊窗口返回时清理当前群状态并停止消息轮询
            if (currentPage === 'group' || currentPage === 'public') {
                leaveGroupChat();
            }
            if (currentPage !== 'home' && pageHistory.length > 1) {
                popPageHistory();
                const prevPage = pageHistory[pageHistory.length - 1];
                const targetId = prevPage === 'group' || prevPage === 'public' ? 'publicPage' :
                                 prevPage === 'search' ? 'searchPage' :
                                 prevPage === 'settings' ? 'settingsPage' :
                                 prevPage === 'about' ? 'aboutPage' :
                                 prevPage === 'groupFiles' ? 'groupFilesPage' :
                                 prevPage === 'userDetail' ? 'userDetailPage' :
                                 prevPage === 'editProfile' ? 'editProfilePage' :
                                 // v097: 好友相关页面
                                 prevPage === 'friends' ? 'friendsPage' :
                                 prevPage === 'addFriend' ? 'addFriendPage' :
                                 prevPage === 'golem' ? 'golemPage' : 'homePage';
                switchPage(targetId, false);
                updateBackBadge();
                // v099: 返回群聊页时恢复消息轮询（上一步 leaveGroupChat 已停止）
                if (targetId === 'publicPage' && currentGroupId) {
                    startGroupMsgPolling();
                }
                // v097: 返回好友列表时刷新渲染（申请处理/分组变更等可能已过期）
                if (targetId === 'friendsPage') {
                    try {
                        if (window.friendModule && typeof window.friendModule.ensureLoaded === 'function') window.friendModule.ensureLoaded();
                        if (typeof window.renderFriendsPage === 'function') window.renderFriendsPage();
                    } catch (e) { /* ignore */ }
                }
            } else {
                try { history.pushState({ page: 'home', mjchat_nav: true }, '', '#home'); } catch (e) {}
            }
        }

        function leavePrivateChatAnimated() {
            privateChatActive = false;
            if (privateStatusInterval) { clearInterval(privateStatusInterval); privateStatusInterval = null; }
            privateSessionId = null;
            privateOtherUser = '';
            privateMessages = [];
            document.getElementById('privateMessages').innerHTML = '<div class="system-msg"><span>加载中...</span></div>';
            const statusEl = document.getElementById('privateChatStatus');
            if (statusEl) { statusEl.textContent = ''; statusEl.className = 'private-status'; }
            switchPage('homePage', false);
            updateSidebarHighlight();
            if (pageHistory.length > 1) {
                popPageHistory();
            }
            loadPrivateSessions();
            updateBackBadge();
            updatePublicBadge();
        }

        // Resolve a user's status for display. Returns one of:
        // 'online' | 'banned' | 'deleted' | 'offline'.
        // Uses the SECURITY DEFINER `get_user_profile` RPC first (bypasses RLS) so
        // that RLS-restricted queries are not misread as "account deleted". Only
        // concludes 'deleted' when we are certain the user no longer exists.
        function toggleHomeMenu() {
            const overlay = document.getElementById('homeMenuOverlay');
            if (overlay.classList.contains('show')) {
                closeHomeMenu();
            } else {
                overlay.classList.add('show');
                updateHomeMenu();
            }
        }

        function closeHomeMenu(e) {
            if (e && e.target !== e.currentTarget) return;
            document.getElementById('homeMenuOverlay').classList.remove('show');
        }

        // 点击菜单以外的区域时自动关闭主页菜单
        document.addEventListener('click', (e) => {
            const overlay = document.getElementById('homeMenuOverlay');
            if (overlay.classList.contains('show') &&
                !e.target.closest('#homeMenuOverlay') &&
                !e.target.closest('#homeMenuBtn')) {
                closeHomeMenu();
            }
        });

        function updateHomeMenu() {
            const avatar = document.getElementById('homeMenuAvatar');
            const name = document.getElementById('homeMenuName');
            const dot = document.getElementById('homeAvatarDot');
            const idx = hashStr(currentUser) % 8;
            avatar.className = 'user-avatar av-' + idx;
            fillUserAvatar(avatar, currentUser, currentAvatarUrl);
            name.textContent = currentUser;
            // 头像圆点仅反映账号状态（封禁/注销）；在线状态已随 Realtime 移除
            applyCurrentUserStatus(dot, avatar);
        }

        function togglePublicMenu() {
            const overlay = document.getElementById('publicMenuOverlay');
            if (overlay.classList.contains('show')) {
                closePublicMenu();
            } else {
                overlay.classList.add('show');
                updatePublicMenu();
            }
        }

        function closePublicMenu(e) {
            if (e && e.target !== e.currentTarget) return;
            document.getElementById('publicMenuOverlay').classList.remove('show');
        }

        function updatePublicMenu() {
            const avatar = document.getElementById('publicMenuAvatar');
            const name = document.getElementById('publicMenuName');
            const dot = document.getElementById('publicAvatarDot');
            // v099: 群聊菜单显示当前群的头像与名称（替代原公聊的当前用户信息）
            const gname = (currentGroupInfo && currentGroupInfo.name) ? currentGroupInfo.name : (currentGroupId ? '群聊' : '');
            const gavatar = (currentGroupInfo && currentGroupInfo.avatar_url) ? currentGroupInfo.avatar_url : '';
            const idx = hashStr(gname || '群') % 8;
            avatar.className = 'user-avatar av-' + idx;
            if (sanitizeAvatarUrl(gavatar)) {
                avatar.style.backgroundImage = "url('" + escapeAttr(sanitizeAvatarUrl(gavatar)) + "')";
                avatar.style.backgroundSize = 'cover';
                avatar.style.backgroundPosition = 'center';
                avatar.textContent = '';
            } else {
                avatar.style.backgroundImage = '';
                avatar.textContent = (gname || '群').charAt(0).toUpperCase();
            }
            name.textContent = gname;
            // 头像圆点：群聊无在线状态，隐藏
            if (dot) dot.classList.add('hidden');
            refreshNotifySettingsUI();
            // v099: 更新群聊免打扰标签（按当前群判断）
            var muteLabel = document.getElementById('publicMuteLabel');
            var muted = !!(currentGroupId && _muteGroups && _muteGroups[currentGroupId]);
            if (muteLabel) muteLabel.textContent = muted ? '取消群聊免打扰' : '群聊免打扰';
            // v102: 群管理菜单项（管理员/群主）：全体禁言 + 清空群消息（群主）、群转让（群主）
            var isMod = !!(currentGroupInfo && (currentGroupInfo.my_role === 'owner' || currentGroupInfo.my_role === 'admin'));
            var manageItem = document.getElementById('publicMenuManageItem');
            if (manageItem) manageItem.style.display = isMod ? '' : 'none';
        }

        let privateBlockedStatus = false;

        function togglePrivateMenu() {
            const overlay = document.getElementById('privateMenuOverlay');
            if (overlay.classList.contains('show')) {
                closePrivateMenu();
            } else {
                overlay.classList.add('show');
                updatePrivateMenu();
            }
        }

        function closePrivateMenu(e) {
            if (e && e.target !== e.currentTarget) return;
            document.getElementById('privateMenuOverlay').classList.remove('show');
        }

        async function updatePrivateMenu() {
            const avatar = document.getElementById('privateMenuAvatar');
            const name = document.getElementById('privateMenuName');
            const dot = document.getElementById('privateAvatarDot');
            const idx = hashStr(privateOtherUser) % 8;
            avatar.className = 'user-avatar av-' + idx;
            fillUserAvatar(avatar, privateOtherUser, userAvatarCache[privateOtherUser]);
            name.textContent = privateOtherUser;
            const labelEl = document.getElementById('privateBlockLabel');
            // 头像圆点仅反映账号状态（封禁/注销），与私聊头部状态逻辑一致
            resolveUserStatus(privateOtherUser).then(status => setAvatarStatusDot(dot, avatar, status));
            try {
                const { data: rpcData, error: rpcError } = await s3.rpc('check_blocked', {
                    p_blocker_uid: currentUid,
                    p_target_uid: privateOtherUid || 0
                });
                if (!rpcError) {
                    privateBlockedStatus = rpcData === true;
                } else { privateBlockedStatus = false; }
            } catch (e) { privateBlockedStatus = false; }
            labelEl.textContent = privateBlockedStatus ? '移出黑名单' : '加入黑名单';
            refreshNotifySettingsUI();
            // v053: 更新私聊免打扰标签
            var muteLabel = document.getElementById('privateMuteLabel');
            if (muteLabel && privateSessionId) {
                muteLabel.textContent = (_mutePerPrivateSession[privateSessionId]) ? '取消消息免打扰' : '消息免打扰';
            }
        }

        function showBlocklistModal() {
            document.getElementById('blocklistModal').classList.remove('hidden');
            loadBlocklist();
        }

        function closeBlocklistModal() {
            document.getElementById('blocklistModal').classList.add('hidden');
        }

        function showProfileDialog() {
            const avatar = document.getElementById('profileDialogAvatar');
            const name = document.getElementById('profileDialogUsername');
            const uid = document.getElementById('profileDialogUid');
            const role = document.getElementById('profileDialogRole');
            const status = document.getElementById('profileDialogStatus');
            const idx = hashStr(currentUser) % 8;
            avatar.className = 'profile-avatar av-' + idx;
            fillUserAvatar(avatar, currentUser, currentAvatarUrl);
            name.textContent = currentUser;
            uid.textContent = currentUid ? String(currentUid) : '-';
            role.textContent = '普通用户';
            (async () => {
                try {
                    const { data: rpcData } = await s3.rpc('get_user_profile', { p_uid: currentUid, p_username: currentUser });
                    if (rpcData && rpcData.success !== false) {
                        status.textContent = rpcData.banned ? '已封禁' : '正常';
                        if (rpcData.role === 'admin') role.textContent = '管理员';
                        else if (rpcData.role === 'agent') role.textContent = '智能体';
                        // v090: 以服务端返回的 uid 为准（本地缓存可能过期）
                        if (rpcData.uid) uid.textContent = String(rpcData.uid);
                        return;
                    }
                } catch (e) { /* ignore */ }
                status.textContent = '正常';
            })();
            document.getElementById('profileDialog').classList.remove('hidden');
        }

        function closeProfileDialog() {
            document.getElementById('profileDialog').classList.add('hidden');
        }

        function loadTheme() {
            // 主题统一由 ThemeManager 管理（内置 dark/light + 自定义主题）
            // theme.js 加载时已自动恢复上次使用的主题；此处仅同步设置页 UI
            updateThemeLabel();
        }

        // 主题/字体均为本地设置，不同步到服务端（v1.x 起移除 saveThemeToServer）

        function updateThemeLabel() {
            const settingsValue = document.getElementById('settingsThemeValue');
            const themeColorItem = document.getElementById('settingsThemeColorItem');
            const customActive = !!(window.ThemeManager && ThemeManager.isCustomThemeActive());
            const current = (window.ThemeManager && ThemeManager.getActiveThemeId()) || document.documentElement.getAttribute('data-theme') || 'dark';
            const theme = window.ThemeManager ? ThemeManager.getTheme(current) : null;
            const name = theme ? theme.name : (current === 'dark' ? '暗黑模式' : '明亮模式');
            if (settingsValue) settingsValue.textContent = name;
            // 自定义主题生效时主题色被主题接管，主题色设置项不再显示
            if (themeColorItem) themeColorItem.style.display = customActive ? 'none' : '';
            const swatch = document.getElementById('themeColorSwatch');
            if (swatch) swatch.style.background = 'var(--md-primary)';
        }

        function loadCustomColor() {
            const color = (_userSettingsCache && _userSettingsCache.themeColor) || null;
            // 自定义主题生效时主题色被主题接管，不再叠加内联覆盖
            if (color && !(window.ThemeManager && ThemeManager.isCustomThemeActive())) {
                applyThemeColor(color);
            }
            const picker = document.getElementById('themeColorPicker');
            if (picker) {
                picker.value = color || '#4A9EFF';
            }
        }

        function setCustomColor(color) {
            // 自定义主题生效时主题色设置失效
            if (window.ThemeManager && ThemeManager.isCustomThemeActive()) {
                showSnackbar('自定义主题生效中，主题色不可调整');
                return;
            }
            // Update encrypted settings cache
            if (_userSettingsCache) {
                _userSettingsCache.themeColor = color;
                syncSettingsToEncryptedStore();
            }
            applyThemeColor(color);
        }

        function applyThemeColor(color) {
            const root = document.documentElement;
            root.style.setProperty('--md-primary', color);
            root.style.setProperty('--md-primary-container', darkenColor(color, 0.3));
        }

        function darkenColor(hex, factor) {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            const dr = Math.round(r * (1 - factor));
            const dg = Math.round(g * (1 - factor));
            const db = Math.round(b * (1 - factor));
            return '#' + [dr, dg, db].map(c => c.toString(16).padStart(2, '0')).join('');
        }

        // ============================================================
        // 主题选择对话框（设置页入口：预览 / 导入 / 删除）
        // ============================================================
        var _themeDialogOriginalId = null; // 打开对话框时正在使用的主题
        var _themeDialogPendingId = null;  // 当前预览中的主题

        function showThemeDialog() {
            const dialog = document.getElementById('themeDialog');
            if (!dialog) return;
            if (!window.ThemeManager) {
                showSnackbar('主题功能未初始化，请刷新页面重试');
                return;
            }
            _themeDialogOriginalId = ThemeManager.getActiveThemeId();
            _themeDialogPendingId = _themeDialogOriginalId;
            renderThemeList();
            dialog.classList.remove('hidden');
        }

        function closeThemeDialog() {
            const dialog = document.getElementById('themeDialog');
            if (!dialog) return;
            // 取消/关闭：回退到打开对话框前的主题（预览不持久化）
            if (_themeDialogPendingId && _themeDialogPendingId !== _themeDialogOriginalId) {
                ThemeManager.preview(_themeDialogOriginalId);
                updateThemeLabel();
            }
            _themeDialogPendingId = _themeDialogOriginalId;
            dialog.classList.add('hidden');
        }

        function renderThemeList() {
            const container = document.getElementById('themeList');
            if (!container) return;
            const themes = ThemeManager.list();
            container.innerHTML = '';
            themes.forEach(function(t) {
                const card = document.createElement('div');
                card.className = 'theme-card' + (t.id === _themeDialogPendingId ? ' selected' : '');
                card.onclick = function() { selectThemeCard(t.id); };
                card.appendChild(buildThemeSwatch(t));
                const info = document.createElement('div');
                info.className = 'theme-card-info';
                const nameEl = document.createElement('div');
                nameEl.className = 'theme-card-name';
                nameEl.textContent = t.name;
                const baseEl = document.createElement('div');
                baseEl.className = 'theme-card-base';
                baseEl.textContent = t.builtin
                    ? (t.base === 'dark' ? '内置 · 暗色' : '内置 · 亮色')
                    : ('自定义 · 基于' + (t.base === 'dark' ? '暗色' : '亮色') + (t.description ? ' · ' + t.description : ''));
                info.appendChild(nameEl);
                info.appendChild(baseEl);
                card.appendChild(info);
                if (!t.builtin) {
                    const del = document.createElement('button');
                    del.className = 'theme-card-delete';
                    del.title = '删除主题';
                    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
                    del.onclick = function(e) {
                        e.stopPropagation();
                        deleteCustomTheme(t.id);
                    };
                    card.appendChild(del);
                }
                container.appendChild(card);
            });
        }

        function buildThemeSwatch(t) {
            const swatch = document.createElement('div');
            swatch.className = 'theme-swatch';
            const cells = [
                { cls: 'bg',         val: t.preview.background },
                { cls: 'surface',    val: t.preview.surface },
                { cls: 'primary',    val: t.preview.primary },
                { cls: 'on-surface', val: t.preview.onSurface }
            ];
            cells.forEach(function(c) {
                const cell = document.createElement('div');
                cell.className = 'swatch-cell ' + c.cls;
                cell.style.setProperty('--sw-' + c.cls, c.val);
                swatch.appendChild(cell);
            });
            return swatch;
        }

        function selectThemeCard(id) {
            _themeDialogPendingId = id;
            ThemeManager.preview(id); // 实时预览，不持久化
            renderThemeList();
            updateThemeLabel();
        }

        function applyThemeDialog() {
            if (_themeDialogPendingId && _themeDialogPendingId !== ThemeManager.getActiveThemeId()) {
                ThemeManager.activate(_themeDialogPendingId);
                // 同步到加密本地设置（主题不再同步到服务端）
                const t = ThemeManager.getTheme(_themeDialogPendingId);
                if (_userSettingsCache) {
                    _userSettingsCache.themeId = _themeDialogPendingId;
                    _userSettingsCache.theme = t ? t.base : 'dark';
                    syncSettingsToEncryptedStore();
                }
            }
            // 标记已提交，避免 closeThemeDialog 回退预览
            _themeDialogPendingId = _themeDialogOriginalId;
            closeThemeDialog();
            updateThemeLabel();
        }

        function openThemeImport() {
            const input = document.getElementById('themeFileInput');
            if (input) input.click();
        }

        function handleThemeFileSelect(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            ThemeManager.importThemeFromFile(file).then(function(res) {
                event.target.value = '';
                if (!res.ok) {
                    showSnackbar('导入失败：' + res.error);
                    return;
                }
                // 导入成功后自动预览新主题
                _themeDialogPendingId = res.theme.id;
                ThemeManager.preview(res.theme.id);
                renderThemeList();
                updateThemeLabel();
                showSnackbar('主题导入成功：' + res.theme.name);
            });
        }

        function deleteCustomTheme(id) {
            const theme = ThemeManager.getTheme(id);
            showConfirm('删除主题', '确定删除主题「' + (theme ? theme.name : id) + '」吗？', function() {
                const wasActive = ThemeManager.getActiveThemeId() === id;
                ThemeManager.removeTheme(id);
                if (wasActive) {
                    _themeDialogPendingId = 'dark';
                } else if (_themeDialogPendingId === id) {
                    _themeDialogPendingId = ThemeManager.getActiveThemeId();
                }
                renderThemeList();
                updateThemeLabel();
            });
        }

        function downloadThemeTemplate() {
            const sample = ThemeManager.buildThemeFileSample();
            const blob = new Blob([JSON.stringify(sample, null, 4)], { type: 'application/json' });
            saveBlobFile('cika-theme-template.json', blob);
        }

        // ============================================================
        // 字体选择对话框（应用级设置，独立于主题文件）
        // ============================================================
        var _fontDialogOriginalId = null; // 打开对话框时正在使用的字体
        var _fontDialogPendingId = null;  // 当前预览中的字体

        function showFontDialog() {
            const dialog = document.getElementById('fontDialog');
            if (!dialog) return;
            if (!window.FontManager || !window.TypographyManager) {
                showSnackbar('字体功能未初始化，请刷新页面重试');
                return;
            }
            _fontDialogOriginalId = FontManager.getActiveFontId();
            _fontDialogPendingId = _fontDialogOriginalId;
            _fontSizeDialogOriginalId = TypographyManager.getActiveScaleId();
            _fontSizeDialogPendingId = _fontSizeDialogOriginalId;
            _fontWeightDialogOriginalId = TypographyManager.getActiveWeightId();
            _fontWeightDialogPendingId = _fontWeightDialogOriginalId;
            renderFontList();
            renderFontSizeList();
            renderFontWeightList();
            updateFontPreview();
            dialog.classList.remove('hidden');
        }

        function closeFontDialog() {
            const dialog = document.getElementById('fontDialog');
            if (!dialog) return;
            // 取消/关闭：回退到打开对话框前的字体/字号/字重（预览不持久化）
            if (_fontDialogPendingId && _fontDialogPendingId !== _fontDialogOriginalId) {
                FontManager.preview(_fontDialogOriginalId);
            }
            if (_fontSizeDialogPendingId && _fontSizeDialogPendingId !== _fontSizeDialogOriginalId) {
                TypographyManager.previewScale(_fontSizeDialogOriginalId);
            }
            if (_fontWeightDialogPendingId && _fontWeightDialogPendingId !== _fontWeightDialogOriginalId) {
                TypographyManager.previewWeight(_fontWeightDialogOriginalId);
            }
            _fontDialogPendingId = _fontDialogOriginalId;
            _fontSizeDialogPendingId = _fontSizeDialogOriginalId;
            _fontWeightDialogPendingId = _fontWeightDialogOriginalId;
            dialog.classList.add('hidden');
            updateFontLabel();
        }

        function renderFontList() {
            const container = document.getElementById('fontList');
            if (!container) return;
            const fonts = FontManager.list().filter(function(f) { return f.id !== 'default'; });
            container.innerHTML = '';
            fonts.forEach(function(f) {
                const card = document.createElement('div');
                card.className = 'font-card-item' + (f.id === _fontDialogPendingId ? ' selected' : '');
                card.onclick = function() { selectFontCard(f.id); };

                const preview = document.createElement('div');
                preview.className = 'font-card-preview';
                preview.textContent = 'Aa';
                if (f.family) preview.style.fontFamily = f.family;
                card.appendChild(preview);

                const nameEl = document.createElement('div');
                nameEl.className = 'font-card-name';
                nameEl.textContent = f.name;
                card.appendChild(nameEl);

                container.appendChild(card);
            });
        }

        function selectFontCard(id) {
            _fontDialogPendingId = id;
            FontManager.preview(id); // 实时预览，不持久化
            renderFontList();
            updateFontPreview();
            updateFontLabel();
        }

        /** 更新对话框顶部预览区 */
        function updateFontPreview() {
            const area = document.getElementById('fontPreviewArea');
            if (!area) return;
            const font = FontManager.getFont(_fontDialogPendingId);
            const scale = TypographyManager.getScale(_fontSizeDialogPendingId);
            const weight = TypographyManager.getWeight(_fontWeightDialogPendingId);
            const family = (font && font.family) || '';
            var basePx = 14;
            const size = (scale && typeof scale.scale === 'number') ? Math.round(basePx * scale.scale) : basePx;
            const w = (weight && weight.medium) || 400;
            const els = area.querySelectorAll('.font-preview-primary, .font-preview-secondary, .font-preview-tertiary');
            els.forEach(function(el) {
                if (family) el.style.fontFamily = family;
                el.style.fontWeight = w;
            });
            const primary = area.querySelector('.font-preview-primary');
            if (primary) primary.style.fontSize = (size + 6) + 'px';
            const secondary = area.querySelector('.font-preview-secondary');
            if (secondary) secondary.style.fontSize = (size + 2) + 'px';
            const tertiary = area.querySelector('.font-preview-tertiary');
            if (tertiary) tertiary.style.fontSize = size + 'px';
        }

        function applyFontDialog() {
            if (_fontDialogPendingId && _fontDialogPendingId !== FontManager.getActiveFontId()) {
                FontManager.activate(_fontDialogPendingId);
                // 同步到加密本地设置（字体仅本地生效）
                if (_userSettingsCache) {
                    _userSettingsCache.fontId = _fontDialogPendingId;
                    syncSettingsToEncryptedStore();
                }
            }
            if (_fontSizeDialogPendingId && _fontSizeDialogPendingId !== TypographyManager.getActiveScaleId()) {
                TypographyManager.activateScale(_fontSizeDialogPendingId);
                // 同步到加密本地设置（字号仅本地生效）
                if (_userSettingsCache) {
                    _userSettingsCache.fontScaleId = _fontSizeDialogPendingId;
                    syncSettingsToEncryptedStore();
                }
            }
            if (_fontWeightDialogPendingId && _fontWeightDialogPendingId !== TypographyManager.getActiveWeightId()) {
                TypographyManager.activateWeight(_fontWeightDialogPendingId);
                // 同步到加密本地设置（字重仅本地生效）
                if (_userSettingsCache) {
                    _userSettingsCache.fontWeightId = _fontWeightDialogPendingId;
                    syncSettingsToEncryptedStore();
                }
            }
            // 标记已提交，避免 closeFontDialog 回退预览
            _fontDialogPendingId = _fontDialogOriginalId;
            _fontSizeDialogPendingId = _fontSizeDialogOriginalId;
            _fontWeightDialogPendingId = _fontWeightDialogOriginalId;
            closeFontDialog();
            updateFontLabel();
        }

        function updateFontLabel() {
            const settingsValue = document.getElementById('settingsFontValue');
            if (!window.FontManager || !window.TypographyManager) return;
            const font = FontManager.getFont(FontManager.getActiveFontId());
            const scale = TypographyManager.getScale(TypographyManager.getActiveScaleId());
            const weight = TypographyManager.getWeight(TypographyManager.getActiveWeightId());
            if (settingsValue) {
                const parts = [font ? font.name : '系统默认', scale ? scale.name : '', weight ? weight.name : ''];
                settingsValue.textContent = parts.filter(Boolean).join(' · ');
            }
        }

        // ============================================================
        // 字号选择列表（合并进「字体」对话框）
        // ============================================================
        var _fontSizeDialogOriginalId = null; // 打开对话框时正在使用的字号
        var _fontSizeDialogPendingId = null;  // 当前预览中的字号

        function renderFontSizeList() {
            const container = document.getElementById('fontSizeList');
            if (!container) return;
            const scales = TypographyManager.listScales().filter(function(s) { return s.id !== 'default'; });
            container.innerHTML = '';
            scales.forEach(function(s) {
                var basePx = 14; // 基准字号 14px
                var px = (typeof s.scale === 'number') ? Math.round(basePx * s.scale) : basePx;
                const chip = document.createElement('button');
                chip.className = 'font-chip' + (s.id === _fontSizeDialogPendingId ? ' selected' : '');
                chip.textContent = px + 'px';
                chip.title = s.name;
                chip.onclick = function() { selectFontSizeCard(s.id); };
                container.appendChild(chip);
            });
        }

        function selectFontSizeCard(id) {
            _fontSizeDialogPendingId = id;
            TypographyManager.previewScale(id); // 实时预览，不持久化
            renderFontSizeList();
            updateFontPreview();
            updateFontLabel();
        }

        // ============================================================
        // 字重选择列表（合并进「字体」对话框）
        // ============================================================
        var _fontWeightDialogOriginalId = null; // 打开对话框时正在使用的字重
        var _fontWeightDialogPendingId = null;  // 当前预览中的字重

        function renderFontWeightList() {
            const container = document.getElementById('fontWeightList');
            if (!container) return;
            const weights = TypographyManager.listWeights().filter(function(w) { return w.id !== 'default'; });
            container.innerHTML = '';
            weights.forEach(function(w) {
                const chip = document.createElement('button');
                chip.className = 'font-chip' + (w.id === _fontWeightDialogPendingId ? ' selected' : '');
                chip.textContent = w.name;
                chip.style.fontWeight = (typeof w.medium === 'number') ? String(w.medium) : '400';
                chip.onclick = function() { selectFontWeightCard(w.id); };
                container.appendChild(chip);
            });
        }

        function selectFontWeightCard(id) {
            _fontWeightDialogPendingId = id;
            TypographyManager.previewWeight(id); // 实时预览，不持久化
            renderFontWeightList();
            updateFontPreview();
            updateFontLabel();
        }

        // 聊天输入区高度拖拽调整：向上拖动增大输入区（min=自然高度，max≈屏高 60%）
        function initChatBarResizer() {
            ['publicChatBar', 'privateChatBar'].forEach(function(barId) {
                var bar = document.getElementById(barId);
                if (!bar) return;
                var handle = document.getElementById(barId + 'Resizer');
                if (!handle) return;
                var minH = null;

                handle.addEventListener('mousedown', function(e) {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    var startY = e.clientY;
                    var startH = bar.offsetHeight;
                    if (minH === null) minH = startH;
                    var maxH = Math.round(window.innerHeight * 0.6);
                    document.body.classList.add('chatbar-resizing');
                    handle.classList.add('dragging');

                    function onMove(ev) {
                        // 鼠标上移（deltaY 为负）时高度增大
                        var h = startH + (startY - ev.clientY);
                        bar.style.height = Math.max(minH, Math.min(maxH, h)) + 'px';
                        // 输入框跟随新高度（autoResize 内部会读取容器高度）
                        var input = bar.querySelector('.msg-input');
                        if (input && typeof autoResize === 'function') autoResize(input);
                    }

                    function onUp() {
                        document.body.classList.remove('chatbar-resizing');
                        handle.classList.remove('dragging');
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                    }

                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                });
            });
        }

        // 左侧边栏拖动调整宽度：初始 20% 占屏，拖拽改为像素宽，min/max 由 CSS 钳制
        function initSidebarResizer() {
            var sidebar = document.querySelector('.chat-sidebar');
            var resizer = document.getElementById('sidebarResizer');
            if (!sidebar || !resizer) return;

            resizer.addEventListener('mousedown', function(e) {
                if (e.button !== 0) return;
                e.preventDefault();
                var startX = e.clientX;
                var startW = sidebar.getBoundingClientRect().width;
                document.body.classList.add('sidebar-resizing');
                resizer.classList.add('dragging');

                function onMove(ev) {
                    var w = startW + (ev.clientX - startX);
                    sidebar.style.width = w + 'px';
                }

                function onUp() {
                    document.body.classList.remove('sidebar-resizing');
                    resizer.classList.remove('dragging');
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                }

                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }

        function init() {
            // v047: safety timeout 保存在外部以便在 enterApp 后清除
            // 未完成初始化并且 loading 页仍可见时，50s 后才强制跳转登录页
            window.__mjchatSafetyTimeout = setTimeout(function() {
                var loadingEl = document.getElementById('globalLoading');
                if (loadingEl && !loadingEl.classList.contains('hidden')) {
                    if (_loginBlockedByCC) {
                        console.warn('Safety timeout: login_blocked=true, keeping loading page');
                        return;
                    }
                    console.warn('Safety timeout: forcing login page');
                    hideGlobalLoading();
                    if (!isEntered) showLogin();
                }
            }, 50000);

            loadTheme();
            loadCustomColor();
            updateFontLabel();
            initSidebarResizer();
            initChatBarResizer();

            // 主题变更回调：同步设置页 UI，并清除主题色内联覆盖（避免覆盖自定义主题颜色）
            if (window.ThemeManager) {
                ThemeManager.onChange = function() {
                    if (ThemeManager.isCustomThemeActive()) {
                        document.documentElement.style.removeProperty('--md-primary');
                        document.documentElement.style.removeProperty('--md-primary-container');
                    }
                    updateThemeLabel();
                };
            }

            // 字体/字号/字重变更回调：同步设置页「字体」入口的当前值
            if (window.FontManager) {
                FontManager.onChange = function() {
                    updateFontLabel();
                };
            }
            if (window.TypographyManager) {
                TypographyManager.onChange = function() {
                    updateFontLabel();
                };
            }

            // v040: S3 桥接层（src/js/s3.js）已由 index.html 注入，凭证仅在 Tauri Rust 侧
            clientId = generateId();

            // v049: Initialize cloud control system
            initCloudControl();

            try {
                history.pushState({ page: 'home', mjchat_nav: true, initial: true }, '', '#home');
            } catch (e) {}

            window.addEventListener('popstate', function(e) {
                if (e.state && e.state.mjchat_nav) {
                    navigateBack();
                } else {
                    try { history.pushState({ page: 'home', mjchat_nav: true, initial: true }, '', '#home'); } catch (e2) {}
                    navigateBack();
                }
            });

            document.getElementById('privacyBanner').addEventListener('click', function() {
                if (privateOtherUser) {
                    dismissedPrivacyBanners.add(privateOtherUser);
                    // Update encrypted settings cache
                    if (_userSettingsCache) {
                        _userSettingsCache.dismissedPrivacyBanners = [...dismissedPrivacyBanners];
                        syncSettingsToEncryptedStore();
                    }
                    document.getElementById('privacyBanner').classList.add('hidden-banner');
                }
            });

            // v040: Fixed init flow - loading is hidden by default in HTML
            // Only show it for returning users who need session verification
            var savedSession = null;
            try {
                savedSession = localStorage.getItem(LS_KEYS.SESSION);
            } catch (e) { /* ignore */ }

            if (savedSession) {
                // Has a saved session - show loading and verify
                showGlobalLoading('登录中…', '正在验证身份');
                // Add a timeout fallback - if verification takes too long, show login
                var _sessionTimeout = setTimeout(function() {
                    var loadingEl = document.getElementById('globalLoading');
                    if (loadingEl && loadingEl.classList.contains('hidden')) return;
                    console.warn('Session verification timeout, showing login');
                    try { localStorage.removeItem(LS_KEYS.SESSION); } catch (e) {}
                    hideGlobalLoading();
                    showLogin();
                }, 10000);

                restoreSession(_sessionTimeout);
            } else {
                // No saved session - loading is already hidden, just show login
                hideGlobalLoading();
                showLogin();
            }
        }

        function restoreSession(timeoutId) {
            const saved = localStorage.getItem(LS_KEYS.SESSION);
            if (!saved) {
                if (timeoutId) clearTimeout(timeoutId);
                hideGlobalLoading();
                showLogin();
                return;
            }
            // v040: 会话恢复——直接调用后端校验（S3 桥接始终可用）
            try {
                const session = JSON.parse(saved);
                if (!session.username || !session.token) {
                    localStorage.removeItem(LS_KEYS.SESSION);
                    if (timeoutId) clearTimeout(timeoutId);
                    hideGlobalLoading();
                    showLogin();
                    return;
                }
                const verifyWithSecure = async (ip, region) => {
                    const { data, error } = await s3.rpc('verify_session_secure', {
                        p_uid: session.uid || 0, p_username: session.username, p_token: session.token,
                        p_ip: ip || 'unknown', p_region: region || ''
                    });
                    if (!error && data && data.success !== false) return data;
                    return null;
                };
                const verifyWithLegacy = async (ip, region) => {
                    const { data, error } = await s3.rpc('verify_session', {
                        p_uid: session.uid || 0, p_username: session.username, p_token: session.token,
                        p_ip: ip || 'unknown', p_region: region || ''
                    });
                    if (!error && data && data.success !== false) return data;
                    throw error || new Error('Session verify failed');
                };

                (async () => {
                    // v089: 会话恢复同样记录登录 IP 与地区（后端 get_client_ip 获取，带超时不阻塞会话校验）
                    var rIp = 'unknown';
                    var rRegion = '';
                    try {
                        var rLoc = await Promise.race([
                            getClientIP(),
                            new Promise(function(resolve) { setTimeout(function() { resolve({ ip: 'unknown', region: '' }); }, 3000); })
                        ]);
                        rIp = rLoc.ip || 'unknown';
                        rRegion = rLoc.region || '';
                    } catch (e) { rIp = 'unknown'; rRegion = ''; }
                    let userData = null;
                    try { userData = await verifyWithSecure(rIp, rRegion); } catch (e) { /* ignore */ }
                    if (!userData) {
                        try { userData = await verifyWithLegacy(rIp, rRegion); } catch (e) {
                            localStorage.removeItem(LS_KEYS.SESSION);
                            if (timeoutId) clearTimeout(timeoutId);
                            hideGlobalLoading();
                            showLogin();
                            return;
                        }
                    }
                    if (timeoutId) clearTimeout(timeoutId);
                    if (isEntered) return;
                    if (userData.banned) {
                        localStorage.removeItem(LS_KEYS.SESSION);
                        hideGlobalLoading();
                        showLogin();
                        showEl('loginError', '您已被封禁');
                        return;
                    }
                    currentUser = userData.username || session.username;
                    currentUid = userData.uid || session.uid || 0;
                    currentAvatarUrl = userData.avatar_url || '';
                    userAvatarCache[currentUser] = currentAvatarUrl;
                    recordLastLogin(currentUser);
                    if (session.pwhash) {
                        // v049: 用会话中保存的密码哈希重新加载加密设置
                        try {
                            await initUserSettings(session.pwhash, currentUser);
                            // 重新应用主题和颜色（init 中已调用过但当时 _userSettingsCache 为空）
                            loadTheme();
                            loadCustomColor();
                        } catch (e) {
                            console.warn('Session restore: initUserSettings failed:', e);
                        }
                    } else {
                        // v057 修复：旧版本保存的会话没有密码哈希，无法解密本地设置。
                        // 直接进入会导致本地设置无法加载/保存（加密密钥为空），
                        // 改为要求重新输入一次密码（保留会话，走快速登录），登录后会重新写入带 pwhash 的会话。
                        if (timeoutId) clearTimeout(timeoutId);
                        hideGlobalLoading();
                        showLogin();
                        showEl('loginError', '请重新登录以恢复本地设置');
                        return;
                    }
                    updateLoadingText('登录中…', '欢迎回来 ' + currentUser);
                    authorizeEnterApp();
                    enterApp();
                    // v089: 会话恢复登录后同样自动检查一次更新（静默模式）
                    checkUpdate(true);
                    if (userData.needs_relogin) {
                        setTimeout(() => {
                            showSnackbar('安全提示：请退出后重新登录以更新安全凭证');
                        }, 2000);
                    }
                })().catch(() => {
                    localStorage.removeItem(LS_KEYS.SESSION);
                    if (timeoutId) clearTimeout(timeoutId);
                    hideGlobalLoading();
                    showLogin();
                });
            } catch (e) {
                localStorage.removeItem(LS_KEYS.SESSION);
                if (timeoutId) clearTimeout(timeoutId);
                hideGlobalLoading();
                showLogin();
            }
        }

        // v089: 打开外部链接——Tauri 环境走系统默认浏览器（opener 插件，裸 window.open
        // 会被 WebView 拦截导致"点击无反应"），浏览器环境回退 window.open
        function openExternalUrl(url) {
            if (!url) return;
            if (window.__TAURI__ && window.__TAURI__.opener && window.__TAURI__.opener.openUrl) {
                window.__TAURI__.opener.openUrl(url).catch(function(err) {
                    if (window.__debugLog) window.__debugLog('外链打开失败: ' + url + ' -> ' + ((err && err.message) || err));
                });
                return;
            }
            window.open(url, '_blank', 'noopener');
        }

        // v089: 检查更新——从存储桶 upd/latest.json 读取最新版本元数据并展示下载入口。
        // silent=true 为登录时自动检查：无新版本或最新版本号与客户端相同 → 静默不打扰；
        // 有新版本 → 弹确认框提示下载。手动点击「检查更新」→ 内联展示完整结果。
        async function checkUpdate(silent) {
            const box = document.getElementById('aboutUpdateInfo');
            let data = null;
            try {
                const { data: rpcData, error } = await s3.rpc('get_update_info', {});
                if (!error && rpcData && rpcData.success !== false) data = rpcData;
            } catch (e) { data = null; }
            if (!data) {
                if (!silent && box) {
                    box.style.display = 'block';
                    box.innerHTML = '检查更新失败：服务异常';
                }
                return;
            }
            // v089: 最新版本号不高于客户端版本号时视为无更新（不展示更新提示）
            const hasUpdate = data.available && (data.version || 0) > (KERNEL_VERSION || 0);
            if (!hasUpdate) {
                if (silent) {
                    if (box) box.style.display = 'none';
                    return;
                }
                if (box) {
                    box.style.display = 'block';
                    box.innerHTML = '当前已是最新版本（内核 v' + String(KERNEL_VERSION).padStart(3, '0') + '）';
                }
                return;
            }
            const newTag = data.version_tag || ('v' + String(data.version || 0).padStart(3, '0'));
            const sizeText = data.size ? formatBytes(data.size) : '';
            if (silent) {
                // 登录时自动检查：弹确认框，确认后打开下载链接
                const msg = '最新版本：' + newTag +
                    (sizeText ? '，大小：' + sizeText : '') +
                    (data.notes ? '\n更新说明：' + data.notes : '') +
                    '\n\n是否立即下载安装包？';
                showConfirm('发现新版本 ' + newTag, msg, function() {
                    openExternalUrl(data.download_url);
                });
                return;
            }
            // 手动检查：内联展示详情 + 下载按钮
            const curTag = 'v' + String(KERNEL_VERSION).padStart(3, '0');
            const pubText = data.published_at ? String(data.published_at).replace('T', ' ').replace(/\..+?Z?$/, '').trim() : '';
            const lines = [
                '最新版本：' + newTag,
                '当前版本：内核 ' + curTag,
                '文件：' + (data.filename || '未知'),
                sizeText ? '大小：' + sizeText : '',
                pubText ? '发布时间：' + pubText : '',
                data.notes ? '更新说明：\n' + data.notes : ''
            ].filter(Boolean);
            let html = lines.map(escapeHtml).join('<br>');
            if (data.download_url) {
                html += '<br><button class="md-button primary" id="updateDownloadBtn">下载安装包</button>';
            }
            if (box) {
                box.style.display = 'block';
                box.innerHTML = html;
                const dl = document.getElementById('updateDownloadBtn');
                if (dl) dl.onclick = function() { openExternalUrl(data.download_url); };
            }
        }

        function formatBytes(n) {
            if (!n || n <= 0) return '';
            if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
            if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
            return n + ' B';
        }

        document.querySelectorAll('.dialog-overlay').forEach(el => {
            el.addEventListener('click', function(e) {
                if (e.target === this && !this.dataset.lockOverlay) {
                    this.classList.add('hidden');
                }
            });
        });

        // v040: Global error handler - only act during initial loading phase
        // This prevents non-critical runtime errors from disrupting the app
        window.addEventListener('error', function(e) {
            console.error('Global error:', e.error || e.message);
            try {
                // Only hide loading and show login if we're still on the auth/loading screen
                var loadingEl = document.getElementById('globalLoading');
                if (loadingEl && !loadingEl.classList.contains('hidden') && !isEntered) {
                    hideGlobalLoading();
                    showLogin();
                }
            } catch (err) { /* ignore */ }
        });

        // v040: Unhandled promise rejection handler - only act during loading phase
        window.addEventListener('unhandledrejection', function(e) {
            console.error('Unhandled promise rejection:', e.reason);
            try {
                var loadingEl = document.getElementById('globalLoading');
                if (loadingEl && !loadingEl.classList.contains('hidden') && !isEntered) {
                    hideGlobalLoading();
                    showLogin();
                }
            } catch (err) { /* ignore */ }
        });

        window.addEventListener('DOMContentLoaded', init);

        /* ==========================================================================
           对话框焦点管理（MD3 无障碍）
           - 打开对话框：记录失焦元素，并把焦点移入对话框内首个可聚焦控件；
           - 关闭对话框：焦点还原到打开前的元素；
           - 焦点陷阱：对话框内 Tab 循环，防止焦点逃逸到背景页面。
           通过 MutationObserver 监听 .dialog-overlay 的 hidden 类切换，
           无需改动各对话框的开关调用点。键盘可达性兜底在 base.css :focus-visible。
           ========================================================================== */
        function initDialogFocus() {
            var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
            var lastFocusEl = null;

            function getVisibleOverlay() {
                var overlays = document.querySelectorAll('.dialog-overlay');
                for (var i = 0; i < overlays.length; i++) {
                    if (!overlays[i].classList.contains('hidden')) return overlays[i];
                }
                return null;
            }

            function getFocusable(el) {
                if (!el) return [];
                var nodes = el.querySelectorAll(FOCUSABLE);
                var out = [];
                for (var i = 0; i < nodes.length; i++) {
                    if (nodes[i].getClientRects().length > 0) out.push(nodes[i]);
                }
                return out;
            }

            function focusFirst(el) {
                var list = getFocusable(el);
                if (list.length) {
                    list[0].focus();
                } else {
                    el.setAttribute('tabindex', '-1');
                    el.focus({ preventScroll: true });
                }
            }

            // 监听每个对话框的 hidden 类切换
            var dialogMo = new MutationObserver(function(muts) {
                for (var i = 0; i < muts.length; i++) {
                    var m = muts[i];
                    if (m.type !== 'attributes' || m.attributeName !== 'class') continue;
                    var el = m.target;
                    if (!el.classList || !el.classList.contains('dialog-overlay')) continue;
                    var shown = !el.classList.contains('hidden');
                    if (shown) {
                        lastFocusEl = document.activeElement;
                        focusFirst(el);
                    } else if (el.contains(document.activeElement)) {
                        if (lastFocusEl && document.body.contains(lastFocusEl)) {
                            lastFocusEl.focus();
                        } else {
                            document.activeElement.blur();
                        }
                        lastFocusEl = null;
                    }
                }
            });

            // 监听动态新增的对话框并纳入观察
            var bodyMo = new MutationObserver(function(muts) {
                for (var i = 0; i < muts.length; i++) {
                    var m = muts[i];
                    if (m.type !== 'childList') continue;
                    for (var j = 0; j < m.addedNodes.length; j++) {
                        var n = m.addedNodes[j];
                        if (n.nodeType !== 1) continue;
                        var found = n.classList && n.classList.contains('dialog-overlay') ? [n] : (n.querySelectorAll ? n.querySelectorAll('.dialog-overlay') : []);
                        for (var k = 0; k < found.length; k++) {
                            dialogMo.observe(found[k], { attributes: true, attributeFilter: ['class'] });
                        }
                    }
                }
            });

            // 焦点陷阱：对话框内 Tab 循环
            document.addEventListener('keydown', function(e) {
                if (e.key !== 'Tab') return;
                var overlay = getVisibleOverlay();
                if (!overlay) return;
                var list = getFocusable(overlay);
                if (!list.length) {
                    e.preventDefault();
                    overlay.focus({ preventScroll: true });
                    return;
                }
                var first = list[0];
                var last = list[list.length - 1];
                var active = document.activeElement;
                if (e.shiftKey) {
                    if (active === first || !overlay.contains(active)) {
                        e.preventDefault();
                        last.focus();
                    }
                } else if (active === last || !overlay.contains(active)) {
                    e.preventDefault();
                    first.focus();
                }
            });

            var overlays = document.querySelectorAll('.dialog-overlay');
            for (var i = 0; i < overlays.length; i++) {
                dialogMo.observe(overlays[i], { attributes: true, attributeFilter: ['class'] });
            }
            bodyMo.observe(document.body, { childList: true, subtree: true });
        }

        window.addEventListener('DOMContentLoaded', initDialogFocus);
