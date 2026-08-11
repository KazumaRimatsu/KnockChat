/* KnockChat 功能模块：语音、图片、文件、链接、表情、文本特效、通知音、Agent、头像、搜索 */

        // 文件类型分类（模块级常量：图片/视频判定、粘贴识别、群文件共用；fview.js 复用）
        const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'psd'];
        const VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'avi', 'mkv', 'flv', 'wmv', '3gp', 'mpeg', 'mpg', 'ogv', 'm3u8'];
        const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'wma', 'amr', 'mid', 'midi'];

        // Blob → base64（S3 upload_media RPC 走 base64 传输）
        function blobToBase64(blob) {
            return new Promise(function(resolve, reject) {
                const reader = new FileReader();
                reader.onload = function() {
                    const result = reader.result || '';
                    const idx = result.indexOf(',');
                    resolve(idx >= 0 ? result.slice(idx + 1) : result);
                };
                reader.onerror = function(e) { reject(e); };
                reader.readAsDataURL(blob);
            });
        }

        // 通用上传：返回公网 URL，失败时提示并返回 null
        async function uploadToBucket(filePath, blob, contentType, bucket) {
            const _ = bucket; // 单桶架构：所有文件统一存 media/ 前缀，忽略旧桶名
            try {
                const b64 = await blobToBase64(blob);
                const res = await s3.rpc('upload_media', {
                    p_key: filePath,
                    p_base64: b64,
                    p_content_type: contentType || 'application/octet-stream',
                    p_uid: currentUid,
                    p_session_token: getSessionToken()
                });
                if (res.error) {
                    showSnackbar('上传失败: ' + res.error.message);
                    return null;
                }
                if (res.data && res.data.success === false) {
                    showSnackbar(res.data.message || '上传失败');
                    return null;
                }
                return (res.data && res.data.url) || null;
            } catch (e) {
                showSnackbar('上传失败: ' + (e.message || ''));
                return null;
            }
        }

        // 统一文件大小校验（本地首道防线，先校验再上传）：超限返回提示文案，未超限返回空串。
        // 所有上传入口（头像/背景/公私聊图片/文件/语音）共用此方法，避免各入口校验分散不一致。
        function fileSizeError(fileOrBlob, maxBytes, label) {
            const size = fileOrBlob && typeof fileOrBlob.size === 'number' ? fileOrBlob.size : 0;
            if (size > maxBytes) return `${label}不能超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB`;
            return '';
        }

        // 语音录制工厂：公聊/私聊共用同一套录音、计时、上传流程
        function createVoiceRecorder(config) {
            const RECORD_MIC_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>';
            const RECORD_STOP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
            const state = { recorder: null, chunks: [], startTime: null, timerInterval: null, maxTimer: null };

            function reset() {
                const btn = document.getElementById(config.ids.btn);
                const timer = document.getElementById(config.ids.timer);
                const hint = document.getElementById(config.ids.hint);
                const stopBtn = document.getElementById(config.ids.stopBtn);
                btn.classList.remove('recording');
                btn.innerHTML = RECORD_MIC_ICON;
                timer.textContent = '00:00';
                hint.textContent = '点击开始录音';
                stopBtn.classList.remove('show');
                if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
                if (state.maxTimer) { clearTimeout(state.maxTimer); state.maxTimer = null; }
            }

            async function toggle() {
                const btn = document.getElementById(config.ids.btn);
                const timer = document.getElementById(config.ids.timer);
                const hint = document.getElementById(config.ids.hint);
                const stopBtn = document.getElementById(config.ids.stopBtn);
                if (!state.recorder || state.recorder.state === 'inactive') {
                    try {
                        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                        state.chunks = [];
                        const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
                        state.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
                        state.recorder.ondataavailable = (e) => { if (e.data.size > 0) state.chunks.push(e.data); };
                        state.recorder.onstop = async () => {
                            stream.getTracks().forEach(t => t.stop());
                            const audioBlob = new Blob(state.chunks, { type: mimeType || 'audio/webm' });
                            if (audioBlob.size < 1000) {
                                showSnackbar(config.tooShortMsg);
                                reset();
                                return;
                            }
                            // 语音大小上限校验（先校验再上传）
                            const sizeErr = fileSizeError(audioBlob, MAX_VOICE_SIZE, '语音');
                            if (sizeErr) {
                                showSnackbar(sizeErr);
                                reset();
                                return;
                            }
                            await upload(audioBlob, mimeType || 'audio/webm');
                            reset();
                        };
                        state.recorder.start();
                        state.startTime = Date.now();
                        // 最长录制时长：到点自动停止（onstop 内还会做大小校验）
                        state.maxTimer = setTimeout(() => {
                            if (state.recorder && state.recorder.state === 'recording') {
                                showSnackbar(`语音最长 ${MAX_VOICE_DURATION} 秒`);
                                state.recorder.stop();
                            }
                        }, MAX_VOICE_DURATION * 1000);
                        btn.classList.add('recording');
                        btn.innerHTML = RECORD_STOP_ICON;
                        hint.textContent = '正在录音...';
                        stopBtn.classList.add('show');
                        state.timerInterval = setInterval(() => {
                            timer.textContent = formatDuration(Math.floor((Date.now() - state.startTime) / 1000));
                        }, 1000);
                    } catch (e) {
                        showSnackbar('无法访问麦克风');
                    }
                } else if (state.recorder.state === 'recording') {
                    state.recorder.stop();
                }
            }

            async function upload(blob, mimeType) {
                const ext = mimeType.includes('webm') ? 'webm' : 'm4a';
                const filePath = config.makePath(ext);
                showSnackbar('正在上传语音...');
                try {
                    const url = await uploadToBucket(filePath, blob, mimeType);
                    if (!url) return;
                    const duration = state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0;
                    await config.onUploaded(duration, url);
                } catch (e) { showSnackbar('上传失败'); }
            }

            return { toggle: toggle, reset: reset, state: state };
        }

        const publicRecorder = createVoiceRecorder({
            ids: { btn: 'recordBtn', timer: 'recordTimer', hint: 'recordHint', stopBtn: 'recordStopBtn' },
            tooShortMsg: '录音太短',
            // v100.x: 群聊语音存储路径（目录式：groups/<gid>/voice/，不计入群文件用量与列表）
            makePath: (ext) => `groups/${currentGroupId || 'unknown'}/voice/${Date.now()}-${generateId()}.${ext}`,
            onUploaded: async (duration, url) => {
                if (!currentGroupId) { showSnackbar('请先选择群聊'); return; }
                // v101: 统一 contents 协议——语音消息 audio 类型
                const audioResult = await sendGroupMessageSecure(currentGroupId, {
                    contents: buildContents('audio', { url: url, dur: duration }),
                    is_system: false
                });
                if (!audioResult.success) showSnackbar('发送语音失败: ' + (audioResult.message || ''));
                else if (audioResult.message) {
                    handleGroupMessage(currentGroupId, audioResult.message);
                    const mContainer = document.getElementById('publicMessages');
                    if (mContainer) { scrollToBottom(mContainer); updateScrollButton(mContainer); mContainer._userScrolledUp = false; }
                }
            }
        });

        const privateRecorder = createVoiceRecorder({
            ids: { btn: 'privateRecordBtn', timer: 'privateRecordTimer', hint: 'privateRecordHint', stopBtn: 'privateRecordStopBtn' },
            tooShortMsg: '录音时间太短',
            makePath: (ext) => `private/${privateSessionId || 'unknown'}/files/${Date.now()}-${generateId()}.${ext}`,
            onUploaded: async (duration, url) => {
                // v101: 统一 contents 协议——语音消息 audio 类型
                const content = buildContents('audio', { url: url, dur: duration });
                try {
                    const newMsg = await safeInsertPrivateMsg(privateSessionId, currentUser, content);
                    appendPrivateMsgLocally(newMsg, false);
                } catch (ie) {
                    const msg = ie.message || '';
                    showSnackbar(msg.includes('隐私') || msg.includes('拒收') ? msg : '发送失败: ' + msg);
                }
            }
        });

        function toggleRecording() { return publicRecorder.toggle(); }
        function privateToggleRecording() { return privateRecorder.toggle(); }
        let activeAudio = null;
        let linkMode = 'public';

        let _notifyAudio = null;
        let _audioUnlocked = false;

        // 在首次用户交互（点击/触摸/按键）时播放一段静音音频，
        // 解锁浏览器/WKWebView 的自动播放限制，否则 WebSocket 事件里播放提示音会被拦截
        function unlockNotifyAudio() {
            if (_audioUnlocked) return;
            _audioUnlocked = true;
            try {
                var silent = new Audio();
                silent.src = 'data:audio/wav;base64,UklGRogAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YWQAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
                silent.volume = 0.001;
                silent.play().catch(function() {});
            } catch (e) {}
        }
        document.addEventListener('pointerdown', unlockNotifyAudio, true);
        document.addEventListener('touchstart', unlockNotifyAudio, true);
        document.addEventListener('keydown', unlockNotifyAudio, true);

        function playNotifySound() {
            if (!_userSettingsCache) return;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            const ns = _userSettingsCache.notify;
            const sound = NOTIFY_SOUNDS[ns.sound] || NOTIFY_SOUNDS['three_note'];
            try {
                if (!_notifyAudio) _notifyAudio = new Audio();
                _notifyAudio.src = sound.file;
                _notifyAudio.volume = 1;
                var p = _notifyAudio.play();
                if (p && p.catch) {
                    p.catch(function(err) {
                        console.warn('[notify] 提示音被自动播放策略拦截:', err && err.name);
                    });
                }
            } catch (e) {
                console.warn('[notify] 提示音播放异常:', e);
            }
        }

        // 消息提示音开关读取（公聊/私聊共用，key 区分）
        function getNotifyEnabled(key) {
            if (!_userSettingsCache) return false;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            return !!_userSettingsCache.notify[key];
        }
        function getPublicNotifyEnabled() { return getNotifyEnabled('publicEnabled'); }
        function getPrivateNotifyEnabled() { return getNotifyEnabled('privateEnabled'); }

        function refreshNotifySettingsUI() {
            if (!_userSettingsCache) return;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            const ns = _userSettingsCache.notify;

            // Update settings page（提示音选择始终可见）
            const soundValue = document.getElementById('settingsNotifySoundValue');
            if (soundValue) {
                const snd = NOTIFY_SOUNDS[ns.sound];
                soundValue.textContent = snd ? snd.label : '经典三全音';
            }

            // Update chat menu items：免打扰关闭时显示「消息提示音」开关，开启时隐藏（v099: 按当前群判断）
            const publicMenuItem = document.getElementById('publicMenuNotifyItem');
            if (publicMenuItem) {
                const publicMuted = currentGroupId && _muteGroups && _muteGroups[currentGroupId];
                publicMenuItem.style.display = publicMuted ? 'none' : '';
                const publicLabel = document.getElementById('publicNotifyLabel');
                if (publicLabel) {
                    publicLabel.textContent = ns.publicEnabled ? '关闭消息提示音' : '开启消息提示音';
                }
            }

            const privateMenuItem = document.getElementById('privateMenuNotifyItem');
            if (privateMenuItem) {
                const privateMuted = privateSessionId && _mutePerPrivateSession && _mutePerPrivateSession[privateSessionId];
                privateMenuItem.style.display = privateMuted ? 'none' : '';
                const privateLabel = document.getElementById('privateNotifyLabel');
                if (privateLabel) {
                    privateLabel.textContent = ns.privateEnabled ? '关闭消息提示音' : '开启消息提示音';
                }
            }
        }

        function showNotifySoundDialog() {
            if (!_userSettingsCache) return;
            // 兼容旧版本：如果 notify 不存在，自动用默认值初始化
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
                syncSettingsToEncryptedStore();
            }
            const dialog = document.getElementById('notifySoundDialog');
            if (dialog) {
                dialog.classList.remove('hidden');
                updateNotifySoundDialog();
            }
        }

        function closeNotifySoundDialog() {
            const dialog = document.getElementById('notifySoundDialog');
            if (dialog) dialog.classList.add('hidden');
        }

        function updateNotifySoundDialog() {
            if (!_userSettingsCache) return;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            const currentSound = _userSettingsCache.notify.sound || 'three_note';
            const items = document.querySelectorAll('.notify-sound-item');
            items.forEach(function(item) {
                if (item.dataset.sound === currentSound) {
                    item.classList.add('selected');
                } else {
                    item.classList.remove('selected');
                }
            });
        }

        async function selectNotifySound(sound) {
            if (!_userSettingsCache) return;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            _userSettingsCache.notify.sound = sound;
            await syncSettingsToEncryptedStore();
            updateNotifySoundDialog();
            refreshNotifySettingsUI();
        }

        function previewNotifySound(sound) {
            const snd = NOTIFY_SOUNDS[sound];
            if (snd) {
                try {
                    var preview = new Audio(snd.file);
                    var p = preview.play();
                    if (p && p.catch) {
                        p.catch(function(err) {
                            console.warn('[notify] 试听被自动播放策略拦截:', err && err.name);
                        });
                    }
                } catch (e) {}
            }
        }

        // 消息提示音开关切换（公聊/私聊共用）
        async function toggleNotifyMode(key, onText, offText) {
            if (!_userSettingsCache) return;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            _userSettingsCache.notify[key] = !_userSettingsCache.notify[key];
            await syncSettingsToEncryptedStore();
            refreshNotifySettingsUI();
            showSnackbar(_userSettingsCache.notify[key] ? onText : offText);
        }
        function togglePublicNotify() { return toggleNotifyMode('publicEnabled', '群聊消息提示音已开启', '群聊消息提示音已关闭'); }
        function togglePrivateNotify() { return toggleNotifyMode('privateEnabled', '私聊消息提示音已开启', '私聊消息提示音已关闭'); }

        // 功能面板控制器工厂：公聊/私聊的常驻功能条、子面板（表情/文字特效/语音）、
        // 表情插入、文字特效、图片/文件选择入口共用同一套逻辑，仅元素 id 与差异项不同。
        // v090: 面板常驻平铺（桌面端），不再需要「+」按钮的展开/收起；closePanel 仅保留
        // 关闭子面板语义，moreBtn 已移除故做空值保护。
        function createFeaturePanelController(cfg) {
            const el = id => document.getElementById(id);
            return {
                closePanel: function() {
                    el(cfg.panelId).classList.remove('show');
                    const btn = el(cfg.moreBtnId);
                    if (btn) btn.classList.remove('active');
                    this.closeSubPanel();
                },
                closeSubPanel: function() {
                    if (cfg.recorder && cfg.recorder.state && cfg.recorder.state.recorder && cfg.recorder.state.recorder.state === 'recording') {
                        cfg.recorder.state.recorder.stop();
                    }
                    el(cfg.emojiSubPanelId).classList.remove('active');
                    el(cfg.textEffectSubPanelId).classList.remove('active');
                    el(cfg.voiceSubPanelId).classList.remove('active');
                    el(cfg.featurePanelMainId).style.display = 'block';
                },
                openImagePicker: function() {
                    if (cfg.closePanelOnPick) this.closePanel(); else this.closeSubPanel();
                    el(cfg.imageInputId).click();
                },
                openFilePicker: function() {
                    if (cfg.closePanelOnPick) this.closePanel(); else this.closeSubPanel();
                    el(cfg.fileInputId).click();
                },
                insertEmoji: function(emoji) {
                    const input = el(cfg.inputId);
                    input.value += emoji;
                    autoResize(input);
                    cfg.toggleSendBtn();
                },
                openEmojiSubPanel: function() {
                    el(cfg.featurePanelMainId).style.display = 'none';
                    el(cfg.emojiSubPanelId).classList.add('active');
                    // v091: 每次打开面板刷新自定义表情（新增/删除后保证最新）
                    loadEmojiList(true);
                },
                openTextEffectSubPanel: function() {
                    el(cfg.featurePanelMainId).style.display = 'none';
                    el(cfg.textEffectSubPanelId).classList.add('active');
                },
                openVoiceSubPanel: function() {
                    el(cfg.featurePanelMainId).style.display = 'none';
                    el(cfg.voiceSubPanelId).classList.add('active');
                },
                applyTextEffect: function(tag) {
                    applyTextEffectTo(el(cfg.inputId), cfg.toggleSendBtn, tag);
                }
            };
        }

        const publicPanelCtrl = createFeaturePanelController({
            panelId: 'publicFeaturePanel', moreBtnId: 'publicMoreBtn',
            featurePanelMainId: 'featurePanelMain',
            emojiSubPanelId: 'emojiSubPanel', textEffectSubPanelId: 'textEffectSubPanel', voiceSubPanelId: 'voiceSubPanel',
            emojiGridId: 'emojiGrid', inputId: 'publicMsgInput',
            imageInputId: 'imageInput', fileInputId: 'fileInput',
            recorder: publicRecorder, closePanelOnPick: false,
            // v099: 群聊发送按钮开关
            toggleSendBtn: toggleGroupSendBtn
        });
        const privatePanelCtrl = createFeaturePanelController({
            panelId: 'privateFeaturePanel', moreBtnId: 'privateMoreBtn',
            featurePanelMainId: 'privateFeaturePanelMain',
            emojiSubPanelId: 'privateEmojiSubPanel', textEffectSubPanelId: 'privateTextEffectSubPanel', voiceSubPanelId: 'privateVoiceSubPanel',
            emojiGridId: 'privateEmojiGrid', inputId: 'privateMsgInput',
            imageInputId: 'privateImageInput', fileInputId: 'privateFileInput',
            recorder: privateRecorder, closePanelOnPick: false,
            toggleSendBtn: togglePrivateSendBtn
        });

        // 保留原全局函数名（index.html 内联 onclick 依赖）
        function closeFeaturePanel() { publicPanelCtrl.closePanel(); }
        function openImagePicker() { publicPanelCtrl.openImagePicker(); }
        function openFilePicker() { publicPanelCtrl.openFilePicker(); }
        function insertEmoji(emoji) { publicPanelCtrl.insertEmoji(emoji); }
        function openEmojiSubPanel() { publicPanelCtrl.openEmojiSubPanel(); }
        function openTextEffectSubPanel() { publicPanelCtrl.openTextEffectSubPanel(); }
        function openVoiceSubPanel() { publicPanelCtrl.openVoiceSubPanel(); }
        function closeSubPanel() { publicPanelCtrl.closeSubPanel(); }
        function applyTextEffect(tag) { publicPanelCtrl.applyTextEffect(tag); }

        function privateCloseSubPanel() { privatePanelCtrl.closeSubPanel(); }
        function privateOpenImagePicker() { privatePanelCtrl.openImagePicker(); }
        function privateOpenFilePicker() { privatePanelCtrl.openFilePicker(); }
        function privateInsertEmoji(emoji) { privatePanelCtrl.insertEmoji(emoji); }
        function privateOpenEmojiSubPanel() { privatePanelCtrl.openEmojiSubPanel(); }
        function privateOpenTextEffectSubPanel() { privatePanelCtrl.openTextEffectSubPanel(); }
        function privateOpenVoiceSubPanel() { privatePanelCtrl.openVoiceSubPanel(); }
        function privateApplyTextEffect(tag) { privatePanelCtrl.applyTextEffect(tag); }

        // ==================== 自定义表情（v091） ====================
        // 用户级表情：上限 64，图片存 media/emoji/{uid}/（不在群文件白名单内，群文件不显示）。
        // 消息协议：mjv064 emoji 码（CQ 码）与图片文件分开——发送文本只含 CQ 码引用 URL，
        // 渲染端解析 CQ 码展示图片；会话预览（getMjV064Preview）归为 [表情]。
        const EMOJI_LIMIT = 64;
        let _emojiList = null; // null = 未加载
        let _emojiLoading = false;

        // 表情 CQ 码：<mjv064 type="emoji" name="..." url="...">[表情]</mjv064>
        function _wrapEmojiCq(e) {
            return '<mjv064 type="emoji" name="' + escapeHtml(e.name || '表情') + '" url="' + escapeHtml(e.url) + '">[表情]</mjv064>';
        }

        // v091: 发送前保护 mjv064 表情码不被 cleanHtml 剥离（白名单无 mjv064 标签），
        // 用控制字符占位，cleanHtml 还原后再交给发送逻辑（纯表情消息识别为 emoji 类型，混排文本由渲染端内联展示）
        function sanitizeWithEmoji(text) {
            const saved = [];
            let t = String(text || '');
            t = t.replace(/<mjv064 type="emoji"([\s\S]*?)<\/mjv064>/g, function(m) {
                saved.push(m);
                return '\u0001MJE' + (saved.length - 1) + '\u0001';
            });
            t = cleanHtml(t);
            t = t.replace(/\u0001MJE(\d+)\u0001/g, function(m, i) { return saved[parseInt(i, 10)] || ''; });
            return t;
        }

        async function loadEmojiList(force) {
            if (_emojiLoading) return;
            if (!force && _emojiList) { renderEmojiGrids(); return; }
            if (!currentUid) return;
            _emojiLoading = true;
            try {
                const { data, error } = await s3.rpc('list_emoji', { p_uid: currentUid, p_session_token: getSessionToken() });
                _emojiList = (!error && Array.isArray(data)) ? data : [];
            } catch (e) {
                _emojiList = _emojiList || [];
            }
            _emojiLoading = false;
            renderEmojiGrids();
        }

        function renderEmojiGrids() {
            renderEmojiGrid('emojiGrid', 'insertEmoji');
            renderEmojiGrid('privateEmojiGrid', 'privateInsertEmoji');
        }

        function renderEmojiGrid(gridId, insertFnName) {
            const grid = document.getElementById(gridId);
            if (!grid) return;
            const list = _emojiList || [];
            let html = '';
            for (const e of list) {
                const cq = _wrapEmojiCq(e);
                html += '<div class="emoji-item-wrap" title="' + escapeAttr(e.name || '表情') + '">'
                    + '<button class="emoji-item" onclick="' + insertFnName + '(\'' + escapeJsString(cq) + '\')">'
                    + '<img src="' + escapeAttr(e.url) + '" alt="[表情]" loading="lazy"></button>'
                    + '<button class="emoji-del" onclick="deleteEmoji(\'' + escapeJsString(e.key) + '\')" title="删除表情">✕</button>'
                    + '</div>';
            }
            const atLimit = list.length >= EMOJI_LIMIT;
            html += '<div class="emoji-item-wrap">'
                + '<button class="emoji-item emoji-add"' + (atLimit ? '' : ' onclick="pickEmojiUpload()"') + ' title="'
                + (atLimit ? '已达上限 ' + EMOJI_LIMIT + ' 个' : '添加表情') + '">'
                + '<svg viewBox="0 0 24 24"><use href="#icon-plus" xlink:href="#icon-plus"/></svg></button></div>';
            if (list.length === 0) {
                html = '<div class="emoji-empty">暂无自定义表情，点击右下 + 添加</div>' + html;
            }
            grid.innerHTML = html;
        }

        function pickEmojiUpload() {
            if (!_emojiList || _emojiList.length >= EMOJI_LIMIT) {
                showSnackbar('表情数量已达上限（' + EMOJI_LIMIT + ' 个）');
                return;
            }
            document.getElementById('emojiUploadInput').click();
        }

        // v091: 判断图片是否超过指定边长（表情上传用：小图直接传原文件，避免 JPEG 重编码丢透明）
        function _emojiNeedsCompress(file, maxEdge) {
            return new Promise(function(resolve) {
                let url = null;
                try { url = URL.createObjectURL(file); } catch (e) { resolve(false); return; }
                const img = new Image();
                img.onload = function() { URL.revokeObjectURL(url); resolve(img.width > maxEdge || img.height > maxEdge); };
                img.onerror = function() { URL.revokeObjectURL(url); resolve(false); };
                img.src = url;
            });
        }

        async function handleEmojiUpload(event) {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            if (files.length === 0) return;
            for (const file of files) {
                if (_emojiList && _emojiList.length >= EMOJI_LIMIT) {
                    showSnackbar('表情已达上限（' + EMOJI_LIMIT + ' 个）');
                    break;
                }
                const sizeErr = fileSizeError(file, 2 * 1024 * 1024, '表情图片');
                if (sizeErr) { showSnackbar(sizeErr); continue; }
                try {
                    // v091: GIF 保留动画直接上传（2MB 内）；其他格式仅当超过 400px 时压缩，
                    // 小表情保持原文件，保留透明通道与原始细节
                    const isGif = file.type === 'image/gif';
                    let blob = file;
                    if (!isGif && await _emojiNeedsCompress(file, 400)) {
                        blob = await compressImage(file, 400, 0.9);
                    }
                    const b64 = await blobToBase64(blob);
                    const { data, error } = await s3.rpc('upload_emoji', {
                        p_uid: currentUid,
                        p_session_token: getSessionToken(),
                        p_base64: b64,
                        p_content_type: (file.type && file.type.indexOf('image/') === 0) ? file.type : 'image/png'
                    });
                    if (error) { showSnackbar('表情上传失败: ' + error.message); break; }
                    if (data && data.success === false) { showSnackbar(data.message || '表情上传失败'); break; }
                } catch (e) {
                    showSnackbar('表情上传失败: ' + (e.message || ''));
                    break;
                }
            }
            _emojiList = null;
            await loadEmojiList(true);
        }

        function deleteEmoji(key) {
            if (!key) return;
            showConfirm('删除表情', '确定删除该表情吗？', async function() {
                try {
                    const { data, error } = await s3.rpc('delete_emoji', {
                        p_uid: currentUid, p_session_token: getSessionToken(), p_key: key
                    });
                    if (error) { showSnackbar('删除失败: ' + error.message); return; }
                    if (data && data.success === false) { showSnackbar(data.message || '删除失败'); return; }
                    _emojiList = null;
                    await loadEmojiList(true);
                    showSnackbar('表情已删除');
                } catch (e) {
                    showSnackbar('删除失败: ' + (e.message || ''));
                }
            });
        }

        // 图片选择事件（公聊/私聊共用，isPrivate 区分发送目标）
        async function handleImageSelect(event, isPrivate) {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            if (files.length === 0) {
                showSnackbar('未选择图片');
                return;
            }
            await uploadImagesAndSend(files, !!isPrivate);
        }
        function privateHandleImageSelect(event) { handleImageSelect(event, true); }

        // 核心：图片文件列表 → 压缩上传 → 发送（公共/私聊共用，剪贴板粘贴也复用）
        async function uploadImagesAndSend(files, isPrivate) {
            if (!files || files.length === 0) return;
            if (files.length > MAX_IMAGES_PER_MSG) {
                showSnackbar(`一次最多发送 ${MAX_IMAGES_PER_MSG} 张图片`);
                return;
            }
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const sizeErr = fileSizeError(file, MAX_IMAGE_SIZE, `图片 ${file.name}`);
                if (sizeErr) { showSnackbar(sizeErr); return; }
                if (!file.type.startsWith('image/')) { showSnackbar(`文件 ${file.name} 不是图片`); return; }
            }

            showSnackbar(`正在上传 ${files.length} 张图片...`);
            // v086: 上传+发送期间发送按钮禁用并显示加载动画（公聊/私聊各自按钮）
            const sendBtnId = isPrivate ? 'privateSendBtn' : 'publicSendBtn';
            setSendState(sendBtnId, true);
            // v089: try/finally 兜底——无论压缩/上传/发送环节是否抛错或挂起（配合 s3.rpc 超时保护），
            // 发送按钮最终必定恢复，杜绝「发送中」动画一直转圈
            try {
                // v069: 逐张压缩 + 上传，单张失败跳过继续（不整批中止）；GIF 跳过压缩保留动画
                const imageUrls = [];
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    const isGif = file.type === 'image/gif' || (file.name.split('.').pop() || '').toLowerCase() === 'gif';
                    let blobToUpload = file;
                    // 未压缩时保留原扩展名/类型；压缩或 GIF 时使用对应格式
                    let ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
                    let contentType = file.type || 'image/jpeg';
                    if (isGif) {
                        ext = 'gif';
                        contentType = 'image/gif';
                    } else if (file.size > COMPRESS_THRESHOLD) {
                        try {
                            blobToUpload = await compressImage(file, 1920, 0.7);
                            ext = 'jpg';
                            contentType = 'image/jpeg';
                        } catch (e) {
                            console.warn('[v069] 图片压缩失败，使用原图:', e);
                        }
                    }
                    // 压缩/GIF 后最终 blob 二次校验（先校验再上传）
                    const finalErr = fileSizeError(blobToUpload, MAX_IMAGE_SIZE, `图片 ${file.name}（压缩后）`);
                    if (finalErr) { showSnackbar(finalErr); continue; }
                    // v100.x: 群聊图片存储路径（目录式：groups/<gid>/image/，群文件页不展示图片）；
                    // 私聊图片仍为 private/<sid>/files/
                    const filePath = (isPrivate ? `private/${privateSessionId}/files/` : `groups/${currentGroupId}/image/`) + `${Date.now()}-${generateId()}-${i}.${ext}`;
                    try {
                        const url = await uploadToBucket(filePath, blobToUpload, contentType);
                        if (url) imageUrls.push(url);
                        else console.warn('[v069] 图片上传失败，跳过该张:', file.name);
                    } catch (e) {
                        console.warn('[v069] 图片上传失败，跳过该张:', e);
                    }
                }
                if (imageUrls.length === 0) {
                    showSnackbar('没有成功上传的图片');
                    return;
                }

                // v101: 统一 contents 协议——单图走 image 类型，多图走 richtext（内联 <img>）保留网格展示
                let contentsJson;
                if (imageUrls.length === 1) {
                    contentsJson = buildContents('image', { url: imageUrls[0] });
                } else {
                    const imgs = imageUrls.map(url => `<img src="${escapeAttr(url)}" alt="图片" width="160">`).join('');
                    contentsJson = buildContents('richtext', { content: imgs });
                }

                if (isPrivate) {
                    try {
                        const newMsg = await safeInsertPrivateMsg(privateSessionId, currentUser, contentsJson);
                        appendPrivateMsgLocally(newMsg, true);
                    } catch (ie) {
                        const msg = ie.message || '';
                        showSnackbar(msg.includes('隐私') || msg.includes('拒收') ? msg : '发送失败: ' + msg);
                    }
                } else {
                    // v099: 群聊图片发送（替代原公聊）
                    if (!currentGroupId) { showSnackbar('请先选择群聊'); return; }
                    const payload = {
                        sender: currentUser,
                        contents: contentsJson,
                        is_system: false
                    };
                    const result = await sendGroupMessageSecure(currentGroupId, payload);
                    if (!result.success) {
                        showSnackbar('发送图片失败: ' + (result.message || ''));
                    } else if (result.message) {
                        // v089: 服务端已落库，立即本地渲染并计入缓存（不等下一轮轮询）
                        handleGroupMessage(currentGroupId, result.message);
                        // v090: 自己刚发送的消息强制滚动到视野（与文本发送路径一致）
                        const mContainer = document.getElementById('publicMessages');
                        if (mContainer) {
                            scrollToBottom(mContainer);
                            updateScrollButton(mContainer);
                            mContainer._userScrolledUp = false;
                        }
                    }
                }
            } finally {
                setSendState(sendBtnId, false);
                if (isPrivate) togglePrivateSendBtn(); else toggleGroupSendBtn();
            }
        }

        // 剪贴板粘贴图片直接发送
        function handlePasteImage(e, isPrivate) {
            const imageFiles = [];
            const collect = (file) => {
                if (!file) return;
                const isImageByType = file.type && file.type.startsWith('image/');
                const ext = (file.name || '').split('.').pop().toLowerCase();
                const isImageByName = IMAGE_EXTS.includes(ext);
                if (isImageByType || isImageByName) imageFiles.push(file);
            };

            if (e.clipboardData) {
                const items = e.clipboardData.items || [];
                for (const item of items) {
                    if (item.kind === 'file') collect(item.getAsFile());
                }
                // 兼容部分环境 items 不可用、仅提供 files 的情况
                if (imageFiles.length === 0 && e.clipboardData.files) {
                    for (const file of e.clipboardData.files) collect(file);
                }
            }
            if (imageFiles.length === 0) return; // 剪贴板中没有图片，不拦截默认粘贴

            e.preventDefault();
            showConfirm('发送图片', `确认发送 ${imageFiles.length} 张图片吗？`, () => {
                uploadImagesAndSend(imageFiles, isPrivate);
            });
        }

        function initPasteImage() {
            const publicInput = document.getElementById('publicMsgInput');
            const privateInput = document.getElementById('privateMsgInput');
            if (publicInput) {
                publicInput.addEventListener('paste', (e) => handlePasteImage(e, false));
            }
            if (privateInput) {
                privateInput.addEventListener('paste', (e) => handlePasteImage(e, true));
            }
        }

        // v089: 压缩永不挂起——解码失败/画布异常/toBlob 为空时一律回退原图，
        // 防止 Promise 永不 resolve 导致「发送中」按钮一直转圈
        function compressImage(file, maxSize, quality) {
            return new Promise((resolve) => {
                const fallback = () => { console.warn('[v089] 图片压缩失败，使用原图'); resolve(file); };
                const reader = new FileReader();
                reader.onload = (e) => {
                    const img = new Image();
                    img.onload = () => {
                        try {
                            let w = img.width,
                                h = img.height;
                            if (w > maxSize || h > maxSize) {
                                if (w > h) { h = h * maxSize / w;
                                    w = maxSize; } else { w = w * maxSize / h;
                                    h = maxSize; }
                            }
                            const canvas = document.createElement('canvas');
                            canvas.width = w;
                            canvas.height = h;
                            const ctx = canvas.getContext('2d');
                            if (!ctx) { fallback(); return; }
                            ctx.drawImage(img, 0, 0, w, h);
                            canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', quality);
                        } catch (err) {
                            console.warn('[v089] 图片压缩异常，使用原图:', err);
                            resolve(file);
                        }
                    };
                    img.onerror = fallback;
                    img.src = e.target.result;
                };
                reader.onerror = fallback;
                reader.readAsDataURL(file);
            });
        }

        async function handleFileSelect(event) {
            const file = event.target.files[0];
            if (!file) return;
            event.target.value = '';
            const sizeErr = fileSizeError(file, MAX_FILE_SIZE, '文件');
            if (sizeErr) { showSnackbar(sizeErr); return; }
            if (!currentGroupId) { showSnackbar('请先选择群聊'); return; }
            showSnackbar('正在上传文件...');
            // v086: 上传+发送期间发送按钮禁用并显示加载动画
            setSendState('publicSendBtn', true);
            const ext = file.name.split('.').pop() || 'file';
            // v100: 群聊文件存储路径（目录式：groups/<gid>/files/）
            const filePath = `groups/${currentGroupId}/files/${Date.now()}-${generateId()}.${ext}`;
            // v089: try/finally 兜底——无论上传/发送是否抛错或挂起，发送按钮都必须恢复
            try {
                const url = await uploadToBucket(filePath, file, file.type || 'application/octet-stream');
                if (!url) return;
                const fileSize = (file.size / 1024).toFixed(1);
                // v101: 统一 contents 协议——文件消息 file 类型
                const ieResult = await sendGroupMessageSecure(currentGroupId, {
                    contents: buildContents('file', { url: url, name: file.name, size: fileSize }),
                    is_system: false
                });
                if (!ieResult.success) showSnackbar('发送文件失败: ' + (ieResult.message || ''));
                else if (ieResult.message) handleGroupMessage(currentGroupId, ieResult.message);
            } catch (e) { showSnackbar('上传失败'); }
            finally {
                setSendState('publicSendBtn', false);
                toggleGroupSendBtn();
            }
        }

        function openLinkDialog(mode) {
            closeFeaturePanel();
            linkMode = mode || 'public';
            document.getElementById('linkDialog').classList.remove('hidden');
            document.getElementById('linkText').focus();
        }

        function hideLinkDialog() {
            document.getElementById('linkDialog').classList.add('hidden');
            document.getElementById('linkText').value = '';
            document.getElementById('linkUrl').value = '';
        }

        function showOpensourceDialog() {
            document.getElementById('opensourceDialog').classList.remove('hidden');
        }

        function closeOpensourceDialog() {
            document.getElementById('opensourceDialog').classList.add('hidden');
        }

        async function sendLink() {
            const text = document.getElementById('linkText').value.trim();
            const url = document.getElementById('linkUrl').value.trim();
            if (!url) { showSnackbar('请输入链接地址'); return; }
            if (!isSafeUrl(url)) { showSnackbar('链接地址无效，仅支持 http/https/mailto/tel'); return; }
            const displayText = text || url;
            // v101: 统一 contents 协议——链接消息走 richtext 类型（渲染端白名单清洗 <a>）
            const linkContents = buildContents('richtext', {
                content: `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(displayText)}</a>`
            });
            hideLinkDialog();

            if (linkMode === 'private') {
                try {
                    const newMsg = await safeInsertPrivateMsg(privateSessionId, currentUser, linkContents);
                    appendPrivateMsgLocally(newMsg, false);
                } catch (e) {
                    const msg = e.message || '';
                    showSnackbar(msg.includes('隐私') || msg.includes('拒收') ? msg : '发送失败: ' + msg);
                }
            } else {
                // v099: 群聊链接发送（替代原公聊）
                if (!currentGroupId) { showSnackbar('请先选择群聊'); return; }
                const linkResult = await sendGroupMessageSecure(currentGroupId, { contents: linkContents, is_system: false });
                if (!linkResult.success) showSnackbar('发送链接失败: ' + (linkResult.message || ''));
                else if (linkResult.message) handleGroupMessage(currentGroupId, linkResult.message);
            }
        }

        function applyTextEffectTo(input, toggleFn, tag) {
            const start = input.selectionStart;
            const end = input.selectionEnd;
            if (start === end) { showSnackbar('请先选中文字'); return; }
            const selected = input.value.substring(start, end);
            let wrapped;
            switch (tag) {
                case 'b':
                    wrapped = `<b>${selected}</b>`;
                    break;
                case 'i':
                    wrapped = `<i>${selected}</i>`;
                    break;
                case 'u':
                    wrapped = `<u>${selected}</u>`;
                    break;
                case 's':
                    wrapped = `<s>${selected}</s>`;
                    break;
                default:
                    wrapped = selected;
            }
            input.setRangeText(wrapped, start, end, 'end');
            autoResize(input);
            toggleFn();
            const newPos = start + wrapped.length;
            input.setSelectionRange(newPos, newPos);
        }

        function toggleVoicePlay(wrap, event) {
            event.stopPropagation();
            const audioUrl = wrap.dataset.audio;
            if (!audioUrl) return;

            function resetBtn(w) {
                const b = w.querySelector('.voice-play-btn');
                if (b) b.innerHTML = ICON_PLAY;
            }

            if (activeAudio && activeAudio.wrap === wrap && !activeAudio.audio.paused) {
                activeAudio.audio.pause();
                wrap.classList.remove('playing');
                resetBtn(wrap);
                activeAudio = null;
                return;
            }

            if (activeAudio) {
                activeAudio.audio.pause();
                activeAudio.wrap.classList.remove('playing');
                resetBtn(activeAudio.wrap);
            }

            const audio = new Audio(audioUrl);
            wrap.classList.add('playing');
            const btn = wrap.querySelector('.voice-play-btn');
            btn.innerHTML = ICON_PAUSE;

            audio.onended = () => {
                wrap.classList.remove('playing');
                resetBtn(wrap);
                if (activeAudio && activeAudio.wrap === wrap) activeAudio = null;
            };
            audio.onerror = () => {
                wrap.classList.remove('playing');
                resetBtn(wrap);
                if (activeAudio && activeAudio.wrap === wrap) activeAudio = null;
                showSnackbar('播放失败');
            };
            audio.play().catch(() => {
                wrap.classList.remove('playing');
                resetBtn(wrap);
                showSnackbar('播放失败');
            });
            activeAudio = { audio, wrap };
        }

        function parseMarkedText(text) {
            if (!text) return null;
            if (text.startsWith('🔗 ') && text.includes(' → ')) {
                const rest = text.substring(4);
                const sep = rest.indexOf(' → ');
                if (sep > 0) {
                    const url = rest.substring(sep + 3).trim();
                    // 渲染时校验 URL，防止 javascript: 等危险协议被点击执行
                    if (!isSafeUrl(url)) return null;
                    return { type: 'link', displayText: rest.substring(0, sep), url: url };
                }
            }
            if (text.startsWith('📎 ') && text.includes(' → ')) {
                const rest = text.substring(3);
                const sep = rest.indexOf(' → ');
                if (sep > 0) {
                    const url = rest.substring(sep + 3).trim();
                    if (!isSafeUrl(url)) return null;
                    return { type: 'file', fileInfo: rest.substring(0, sep), url: url };
                }
            }
            if (text.startsWith('🎤 ') && text.includes('语音')) {
                const match = text.match(/🎤\s*语音\s*(\d+):(\d+)\s*→\s*(.*)/);
                if (match) {
                    const duration = parseInt(match[1]) * 60 + parseInt(match[2]);
                    var url = match[3] && match[3].startsWith('http') ? match[3].trim() : null;
                    return { type: 'voice', duration: duration, url: url };
                }
                const match2 = text.match(/🎤\s*语音\s*(\d+):(\d+)/);
                if (match2) {
                    const duration = parseInt(match2[1]) * 60 + parseInt(match2[2]);
                    return { type: 'voice', duration: duration, url: null };
                }
            }
            return null;
        }

        // 文件图标 SVG path 与扩展名映射（模块级常量，避免每次调用重建）
        const FILE_ICONS = {
            audio: '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm-1 13h-2v3.5c0 1.38-1.12 2.5-2.5 2.5S6 19.88 6 18.5s1.12-2.5 2.5-2.5c.42 0 .8.11 1.14.29V11h3.36v4z"/>',
            video: '<path d="M4 6.47L5.76 10H20v8H4V6.47M22 4h-4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4z"/>',
            archive: '<path d="M20 6h-2.18c.11-.31.18-.65.18-1a2.996 2.996 0 0 0-5.5-1.65l-.5.67-.5-.68C10.96 2.54 10.05 2 9 2 7.34 2 6 3.34 6 5c0 .35.07.69.18 1H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-5-2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM9 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm11 15H4v-2h16v2zm0-5H4V8h5.08L7 10.83 8.62 12 11 8.76l1-1.36 1 1.36L15.38 12 17 10.83 14.92 8H20v6z"/>',
            image: '<path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>',
            document: '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>',
            code: '<path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>',
            default: '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>'
        };
        const FILE_EXT_MAP = {
            audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus'],
            video: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'mpeg', 'mpg'],
            archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
            image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'psd'],
            document: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'odt', 'ods',
                'odp'
            ],
            code: ['js', 'html', 'css', 'py', 'java', 'cpp', 'c', 'h', 'json', 'xml', 'php', 'rb', 'go', 'rs',
                'ts', 'jsx', 'tsx', 'vue', 'sh', 'bat', 'sql', 'yml', 'yaml', 'toml', 'ini', 'md'
            ]
        };

        function getFileIconSvg(filename) {
            const ext = (filename.split('.').pop() || '').toLowerCase();
            for (const [type, exts] of Object.entries(FILE_EXT_MAP)) {
                if (exts.includes(ext)) return FILE_ICONS[type];
            }
            return FILE_ICONS.default;
        }

        function isImageFile(filename) {
            const ext = (filename.split('.').pop() || '').toLowerCase();
            return IMAGE_EXTS.includes(ext);
        }

        function isVideoFile(filename) {
            const ext = (filename.split('.').pop() || '').toLowerCase();
            return VIDEO_EXTS.includes(ext);
        }

        // 私聊文件上传发送（与公聊路径/发送方式不同，保留独立实现）
        async function privateHandleFileSelect(event) {
            const file = event.target.files[0];
            if (!file) return;
            event.target.value = '';
            const sizeErr = fileSizeError(file, MAX_FILE_SIZE, '文件');
            if (sizeErr) { showSnackbar(sizeErr); return; }
            showSnackbar('正在上传文件...');
            const ext = file.name.split('.').pop() || 'file';
            const filePath = `private/${privateSessionId}/files/${Date.now()}-${generateId()}.${ext}`;
            try {
                const url = await uploadToBucket(filePath, file, file.type || 'application/octet-stream');
                if (!url) return;
                const fileSize = (file.size / 1024).toFixed(1);
                // v101: 统一 contents 协议——私聊文件消息 file 类型
                const content = buildContents('file', { url: url, name: file.name, size: fileSize });
                try {
                    const newMsg = await safeInsertPrivateMsg(privateSessionId, currentUser, content);
                    appendPrivateMsgLocally(newMsg, true);
                } catch (ie) { const msg = ie.message || ''; showSnackbar(msg.includes('隐私') || msg.includes('拒收') ? msg : '发送失败: ' + msg); }
            } catch (e) { showSnackbar('上传失败'); }
        }

        async function doSearch(query) {
            const container = document.getElementById('searchResults');
            if (!query.trim()) {
                container.innerHTML = '<div class="empty">输入昵称开始搜索</div>';
                return;
            }
            try {
                let users = null;
                try {
                    const { data: rpcData, error: rpcError } = await s3.rpc('search_users', { p_query: query.trim(), p_limit: 20 });
                    if (!rpcError && rpcData) { users = rpcData; }
                } catch (e) { /* ignore */ }
                if (!users) {
                    container.innerHTML = '<div class="empty">搜索失败</div>';
                    return;
                }
                if (!users || users.length === 0) {
                    container.innerHTML = '<div class="empty">未找到用户</div>';
                    return;
                }
                container.innerHTML = users.map(u => {
                    const idx = hashStr(u.username) % 8;
                    let avatarStyle = '';
                    if (u.avatar_url) {
                        avatarStyle = 'background-image:url(' + escapeAttr(sanitizeAvatarUrl(u.avatar_url)) + ');background-size:cover;background-position:center;';
                    }
                    // v097: 搜索结果快捷操作——已是好友直接发消息，否则一键发起好友申请（免好友私聊不受影响）
                    let action = '';
                    if (u.username && u.username !== currentUser) {
                        const isF = (window.friendModule && (window.friendModule.isFriend(u.uid) || window.friendModule.isFriend(u.username)));
                        if (isF) {
                            action = '<button class="search-act-btn" onclick="event.stopPropagation();quickChat(' + Number(u.uid || 0) + ')">发消息</button>';
                        } else {
                            action = '<button class="search-act-btn primary" onclick="event.stopPropagation();showAddFriendDialog(' + Number(u.uid || 0) + ',\'' + escapeJsString(u.username) + '\')">添加好友</button>';
                        }
                    }
                    return `<div class="result-item" onclick="showUserProfile('${escapeJsString(u.username)}')">
                                <div class="av av-${idx}" style="${avatarStyle}">${u.avatar_url ? '' : escapeHtml(u.username.charAt(0).toUpperCase())}</div>
                                <span class="name">${escapeHtml(u.username)}</span>
                                ${action}
                            </div>`;
                }).join('');
            } catch (e) { container.innerHTML = '<div class="empty">搜索出错</div>'; }
        }

        function showAgentList() {
            document.getElementById('agentListModal').classList.remove('hidden');
            loadAgentList();
        }

        // ============================================================
        // v100: 群文件：仅枚举当前群的群文件（groups/<gid>/files/），
        // 排除私聊附件/头像/背景以及桶内配置、会话等敏感文件（后端同样强制过滤）
        // ============================================================
        function showGroupFiles() {
            if (!currentGroupId) { showSnackbar('请先选择群聊'); return; }
            pushPageHistory('groupFiles');
            switchPage('groupFilesPage', true);
            _loadGroupFiles();
        }

        // v073 性能优化：群文件列表短期缓存（TTL 30s，按群隔离），频繁进入页面时跳过重复的并行请求
        let _groupFilesCache = null;
        const _GROUP_FILES_TTL = 30 * 1000;

        /** 字节数格式化 */
        function _fmtBytes(n) {
            if (!n || n <= 0) return '0 B';
            if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
            return (n / 1024).toFixed(1) + ' KB';
        }

        /** 群文件用量条（v100.x：直观展示本群群文件用量，含已用/上限与进度条） */
        function _groupFilesUsageHtml(resp) {
            const total = resp && resp.total_size ? resp.total_size : 0;
            const max = resp && resp.max_size ? resp.max_size : 0;
            const pct = max ? Math.min(100, (total / max) * 100) : 0;
            return '<div class="gf-usage">' +
                '<div class="gf-usage-text">群文件用量：<b>' + _fmtBytes(total) + '</b> / ' + _fmtBytes(max) + '</div>' +
                '<div class="gf-usage-bar"><div class="gf-usage-bar-inner" style="width:' + pct.toFixed(1) + '%"></div></div>' +
                '</div>';
        }

        async function _loadGroupFiles(force) {
            const container = document.getElementById('groupFilesContainer');
            if (!container) return;
            if (!currentGroupId) { container.innerHTML = '<div class="gf-empty">请先选择群聊</div>'; return; }
            const gid = currentGroupId;
            if (!force && _groupFilesCache && _groupFilesCache.gid === gid && Date.now() - _groupFilesCache.at < _GROUP_FILES_TTL) {
                _renderGroupFiles(_groupFilesCache.resp, gid);
                return;
            }
            container.innerHTML = '<div style="display:flex;justify-content:center;padding:24px;"><span class="md-circular-loader"><svg viewBox="0 0 22 22"><circle cx="11" cy="11" r="9.5"/></svg></span></div>';
            try {
                const { data, error } = await s3.rpc('list_media', { p_prefix: `groups/${gid}/files/`, p_uid: currentUid, p_session_token: getSessionToken() });
                if (error) {
                    container.innerHTML = '<div class="gf-empty">加载失败: ' + (error.message || '未知错误') + '</div>';
                    return;
                }
                // v100.x: list_media 返回 { files, total_size, file_count, max_size }；兼容旧数组响应
                const arr = Array.isArray(data) ? data : (data && Array.isArray(data.files) ? data.files : []);
                const files = arr
                    .filter(function(f) {
                        if (!f || !f.key) return false;
                        // 安全过滤：群文件仅展示当前群的「文件」（groups/<gid>/files/）。
                        // 图片（image/）与语音（voice/）不计入群文件列表；后端已强制同样过滤，此为前端兜底。
                        return f.key.indexOf(`groups/${gid}/files/`) === 0;
                    })
                    .sort(function(a, b) {
                        return new Date(b.created_at) - new Date(a.created_at);
                    });
                const resp = {
                    files: files,
                    total_size: Array.isArray(data) && data.length
                        ? data.reduce(function(s, f) { return s + (f.size || 0); }, 0)
                        : (data && data.total_size) || 0,
                    max_size: (data && data.max_size) || (256 * 1024 * 1024),
                };
                _groupFilesCache = { at: Date.now(), gid: gid, resp: resp };
                _renderGroupFiles(resp, gid);
            } catch (e) {
                container.innerHTML = '<div class="gf-empty">加载失败: ' + escapeHtml(e.message || '未知错误') + '</div>';
            }
        }

        function _renderGroupFiles(resp, gid) {
            const container = document.getElementById('groupFilesContainer');
            if (!container) return;
            const allFiles = (resp && resp.files) || [];
            // v100.x: 管理员/群主可删除群文件
            const isMod = currentGroupInfo && (currentGroupInfo.my_role === 'owner' || currentGroupInfo.my_role === 'admin');
            let html = _groupFilesUsageHtml(resp);
            if (!allFiles.length) {
                html += '<div class="gf-empty">暂无群文件</div>';
                container.innerHTML = html;
                return;
            }
            for (let idx = 0; idx < allFiles.length; idx++) {
                const file = allFiles[idx];
                const sizeStr = file.size ? _fmtBytes(file.size) : '';
                const dateStr = file.created_at ? new Date(file.created_at).toLocaleDateString('zh-CN') : '';
                const fileUrl = file.url || '';
                // 图片/视频：点击在预览器直接预览；其余文件：点击进入文件预览器（Office/代码/不支持）
                const ext = (file.name.split('.').pop() || '').toLowerCase();
                const isImage = IMAGE_EXTS.includes(ext);
                const isVideo = VIDEO_EXTS.includes(ext);
                if (isImage || isVideo) {
                    if (isImage) {
                        html += '<div class="gf-file-item" onclick="previewImage(\'' + escapeJsString(fileUrl) + '\')">';
                        html += '<div class="gf-file-icon"><img src="' + escapeAttr(fileUrl) + '" loading="lazy" onerror="this.style.display=\'none\'"></div>';
                    } else {
                        html += '<div class="gf-file-item" onclick="openVideoPreview(\'' + escapeJsString(fileUrl) + '\')">';
                        html += '<div class="gf-file-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M10 8.5v7l6-3.5-6-3.5zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg></div>';
                    }
                } else {
                    const iconHtml = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">' + getFileIconSvg(file.name) + '</svg>';
                    html += '<div class="gf-file-item" onclick="openFilePreview(\'' + escapeJsString(fileUrl) + '\', \'' + escapeJsString(file.name) + '\')">';
                    html += '<div class="gf-file-icon">' + iconHtml + '</div>';
                }
                html += '<div class="gf-file-info"><div class="gf-file-name">' + escapeHtml(file.name) + '</div>';
                html += '<div class="gf-file-meta">' + (sizeStr ? sizeStr + ' · ' : '') + dateStr + '</div></div>';
                if (isMod) {
                    html += '<button class="gf-file-del" onclick="event.stopPropagation();deleteGroupFile(\'' + escapeJsString(file.key) + '\')">删除</button>';
                }
                html += '</div>';
            }
            container.innerHTML = html;
        }

        /** v100.x: 删除群文件（管理员/群主），删除后刷新列表与用量 */
        async function deleteGroupFile(key) {
            if (!currentGroupId || !key) return;
            if (!window.confirm('确定删除该群文件吗？')) return;
            try {
                const { error } = await s3.rpc('delete_group_file', {
                    p_uid: currentUid,
                    p_session_token: getSessionToken(),
                    p_group_id: currentGroupId,
                    p_key: key
                });
                if (error) { showSnackbar('删除失败: ' + (error.message || '未知错误')); return; }
                showSnackbar('已删除');
                _loadGroupFiles(true);
            } catch (e) {
                showSnackbar('删除失败: ' + (e.message || '未知错误'));
            }
        }

        function closeAgentList() {
            document.getElementById('agentListModal').classList.add('hidden');
        }

        function showAddAgentDialog() {
            document.getElementById('addAgentDialog').classList.remove('hidden');
            document.getElementById('agentName').value = '';
            document.getElementById('agentApiKey').value = '';
            document.getElementById('agentProvider').value = 'openai';
            document.getElementById('agentModel').value = 'gpt-3.5-turbo';
        }

        function updateAgentModelDefault() {
            const provider = document.getElementById('agentProvider').value;
            const modelInput = document.getElementById('agentModel');
            modelInput.value = AGENT_DEFAULT_MODELS[provider] || AGENT_DEFAULT_MODELS['custom'];
        }

        function closeAddAgentDialog() {
            document.getElementById('addAgentDialog').classList.add('hidden');
            document.getElementById('agentApiKey').value = '';
        }

        let activeAgent = null;

        async function useAgent(agentId) {
            closeAgentList();
            const input = document.getElementById('publicMsgInput');
            if (!input) return;
            if (activeAgent && activeAgent.id === agentId) {
                activeAgent = null;
                input.value = input.value.replace(/@[\w\u4e00-\u9fa5]+\s?/, '').trim();
                autoResize(input);
                toggleGroupSendBtn();
                showSnackbar('已取消智能体');
                return;
            }
            const agentName = await getAgentName(agentId);
            activeAgent = { id: agentId, name: agentName };
            input.value = `@${agentName} `;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            autoResize(input);
            toggleGroupSendBtn();
            showSnackbar(`已选择 ${agentName}，输入消息后发送`);
        }

        async function getAgentName(agentId) {
            try {
                let agentName = null;
                try {
                    const { data: rpcData, error: rpcError } = await s3.rpc('get_agents');
                    if (!rpcError && rpcData) {
                        const agents = Array.isArray(rpcData) ? rpcData : [];
                        const agent = agents.find(a => a.id === agentId);
                        if (agent) agentName = agent.name;
                    }
                } catch (e) { /* ignore */ }
                return agentName || '智能体';
            } catch (e) { return '智能体'; }
        }
