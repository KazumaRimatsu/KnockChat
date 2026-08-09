/* KnockChat 文件预览器 fview.js
 * 多窗口预览：不同文件各自新建独立的预览窗口（支持多开）；
 * 同一文件（按 url 标识，url 为空时按文件名）只保留一个窗口，重复打开时恢复并置顶已有窗口。
 * 窗口由 JS 动态注入顶层容器 #fviewContainer，可拖动 / 8 方向缩放；
 * 点击最小化按钮在窗口原位收缩为胶囊（用文件类型 SVG 图标提示，可拖动/点击恢复）；
 * 关闭按钮只销毁自身窗口，不影响聊天页面与其它窗口。
 * 每个窗口独立持有 img/video/audio/iframe/code 元素与图片缩放状态，
 * 因此多个音视频窗口之间互不干扰、播放连续。
 * Office 文档（docx/pptx/xlsx 等）：通过 Office Web Viewer 在线渲染。
 * 代码文件：fetch 原文后用 highlight.js 高亮。
 * 其余类型：居中提示“该文件不支持预览”。
 * 依赖：other.js（escapeHtml 等）。
 */

        // ============================================================
        // 文件类型分类（图片/视频扩展名复用 features.js 的 IMAGE_EXTS / VIDEO_EXTS 常量）
        // ============================================================
        // Office Web Viewer 支持的文档格式
        var FVIEW_OFFICE_EXTS = ['doc', 'docx', 'docm', 'dotx', 'dotm', 'rtf',
            'xls', 'xlsx', 'xlsb', 'xlsm',
            'ppt', 'pptx', 'pps', 'ppsx', 'pot', 'potx',
            'odt', 'ods', 'odp'
        ];
        var FVIEW_CODE_EXTS = [
            'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
            'html', 'htm', 'css', 'scss', 'sass', 'less', 'json',
            'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'cs',
            'go', 'rs', 'php', 'rb', 'sh', 'bash', 'zsh', 'sql',
            'xml', 'yaml', 'yml', 'toml', 'ini', 'conf',
            'md', 'markdown', 'swift', 'kt', 'kts', 'lua', 'r', 'dart',
            'scala', 'pl', 'perl', 'vue', 'svelte', 'dockerfile', 'makefile',
            'cmake', 'bat', 'ps1', 'diff', 'groovy', 'tex', 'proto', 'graphql', 'gql'
        ];
        // 扩展名 → highlight.js 语言名
        var FVIEW_CODE_LANG_MAP = {
            js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
            ts: 'typescript', tsx: 'typescript',
            py: 'python', rb: 'ruby', php: 'php', go: 'go', rs: 'rust', java: 'java',
            c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
            cs: 'csharp', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
            html: 'xml', htm: 'xml', xml: 'xml', vue: 'xml',
            css: 'css', scss: 'scss', less: 'less', json: 'json',
            yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini',
            md: 'markdown', markdown: 'markdown', swift: 'swift',
            kt: 'kotlin', kts: 'kotlin', lua: 'lua', r: 'r', dart: 'dart',
            scala: 'scala', pl: 'perl', perl: 'perl', groovy: 'groovy',
            bat: 'dos', ps1: 'powershell', diff: 'diff', dockerfile: 'dockerfile',
            makefile: 'makefile', cmake: 'cmake', tex: 'tex', proto: 'protobuf',
            graphql: 'graphql', gql: 'graphql'
        };
        var OFFICE_VIEWER_BASE = 'https://view.officeapps.live.com/op/view.aspx?src=';

        // v073 性能优化：highlight.js 按需加载（仅打开代码文件时），避免启动时阻塞与常驻内存
        var _hljsPromise = null;
        function _ensureHighlightJs() {
            if (typeof hljs !== 'undefined') return Promise.resolve();
            if (_hljsPromise) return _hljsPromise;
            _hljsPromise = new Promise(function(resolve, reject) {
                var s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js';
                s.integrity = 'sha384-F/bZzf7p3Joyp5psL90p/p89AZJsndkSoGwRpXcZhleCWhd8SnRuoYo4d0yirjJp';
                s.crossOrigin = 'anonymous';
                s.onload = resolve;
                s.onerror = function() { _hljsPromise = null; reject(new Error('highlight.js 加载失败')); };
                document.head.appendChild(s);
            });
            return _hljsPromise;
        }

        // ============================================================
        // 多窗口状态
        // ============================================================
        let fviewWindows = []; // 已打开的窗口（含最小化胶囊）
        let fviewWinSeq = 0;   // 窗口自增 id
        let fviewFocusZ = 560; // 置顶 z-index 基准
        const FVIEW_MIN_W = 260;
        const FVIEW_MIN_H = 180;
        const FVIEW_DEF_W = 480;
        const FVIEW_DEF_H = 360;

        // 文件类型 → 标题栏/胶囊图标 与 默认标题
        const FVIEW_TYPE_ICON = {
            image: 'icon-image',
            video: 'icon-play',
            audio: 'icon-audio',
            office: 'icon-file',
            code: 'icon-file',
            unsupported: 'icon-file'
        };
        const FVIEW_TYPE_LABEL = {
            image: '图片', video: '视频', audio: '音频',
            office: '文档', code: '代码', unsupported: '文件'
        };

        // 顶层容器：全屏固定层，不拦截事件，由子窗口独立响应
        function _fviewEnsureContainer() {
            let c = document.getElementById('fviewContainer');
            if (!c) {
                c = document.createElement('div');
                c.id = 'fviewContainer';
                document.body.appendChild(c);
            }
            return c;
        }

        // 窗口是否仍存活（异步加载代码文件时防止窗口已关闭后继续写入）
        function _fviewAlive(win) {
            return win && win.el && win.el.isConnected;
        }

        // 点击窗口置顶
        function _fviewFocusWindow(win) {
            fviewFocusZ++;
            win.el.style.zIndex = fviewFocusZ;
        }

        function _fviewApplyRect(win) {
            const r = win.rect;
            win.el.style.left = r.x + 'px';
            win.el.style.top = r.y + 'px';
            win.el.style.width = r.w + 'px';
            win.el.style.height = r.h + 'px';
        }

        // 创建独立预览窗口骨架，返回 win 对象
        function _fviewCreateWindow(type, url, filename) {
            const container = _fviewEnsureContainer();
            const id = 'fview-win-' + (++fviewWinSeq);
            const title = filename || FVIEW_TYPE_LABEL[type] + '预览';

            const win = {
                id: id,
                type: type,
                title: title,
                url: url,
                key: url || filename || '', // 文件唯一标识：url 为空时回退到文件名
                minimized: false,
                rect: null,
                zoom: { scale: 1, tx: 0, ty: 0, lastDist: 0, lastX: 0, lastY: 0, touchStart: false },
                el: null,
                bar: null,
                body: null,
                capsule: null,
                media: null
            };

            // 默认位置：居中并级联偏移，避免新窗口完全盖住旧窗口
            const vw = window.innerWidth,
                vh = window.innerHeight;
            const w = Math.min(FVIEW_DEF_W, vw - 16);
            const h = Math.min(FVIEW_DEF_H, vh - 96);
            const off = (fviewWindows.length % 6) * 30;
            let x = Math.max(8, Math.min(Math.round((vw - w) / 2) + off, vw - w - 8));
            let y = Math.max(8, Math.min(Math.round((vh - h) / 2) + off * 0.6, vh - h - 8));
            win.rect = { x: x, y: y, w: w, h: h };

            const icon = FVIEW_TYPE_ICON[type];
            // 仅图片窗口带缩放控件
            const zoomCtl = type === 'image' ?
                '<div class="media-zoom-controls fview-zoom">' +
                '<button class="media-zoom-btn fview-zoom-out" title="缩小"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M19 13H5v-2h14v2z" fill="currentColor"/></svg></button>' +
                '<button class="media-zoom-reset fview-zoom-reset" title="还原缩放"><span class="fview-zoom-label">100%</span></button>' +
                '<button class="media-zoom-btn fview-zoom-in" title="放大"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="currentColor"/></svg></button>' +
                '</div>' : '';

            win.el = document.createElement('div');
            win.el.className = 'fview-window';
            win.el.id = id;
            win.el.style.cssText = 'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;z-index:' + (++fviewFocusZ) + ';';
            win.el.innerHTML =
                '<div class="app-bar media-viewer-bar fview-bar">' +
                    '<div class="title-block">' +
                        '<svg class="fview-type-icon" viewBox="0 0 24 24"><use href="#' + icon + '" xlink:href="#' + icon + '"/></svg>' +
                        '<span class="title fview-title">' + escapeHtml(title) + '</span>' +
                    '</div>' +
                    zoomCtl +
                    '<button class="fview-min-btn" title="最小化"><svg viewBox="0 0 24 24" width="18" height="18"><use href="#icon-minus" xlink:href="#icon-minus"/></svg></button>' +
                    '<button class="fview-close-btn" title="关闭"><svg viewBox="0 0 24 24" width="18" height="18"><use href="#icon-close" xlink:href="#icon-close"/></svg></button>' +
                '</div>' +
                '<div class="media-viewer-body fview-body">' +
                    '<div class="media-loading fview-loading hidden">' +
                        '<span class="md-circular-loader"><svg viewBox="0 0 22 22"><circle cx="11" cy="11" r="9.5"/></svg></span>' +
                        '<span class="media-loading-text fview-loading-text"></span>' +
                    '</div>' +
                    '<img class="fview-img hidden" src="" draggable="false">' +
                    '<video class="fview-video hidden" controls autoplay playsinline></video>' +
                    '<audio class="fview-audio hidden" controls playsinline></audio>' +
                    '<iframe class="fview-office hidden" src="" title="文档预览"></iframe>' +
                    '<pre class="fview-code hidden"><code class="hljs"></code></pre>' +
                    '<div class="fview-unsupported hidden"><span></span></div>' +
                '</div>' +
                '<div class="fview-handles">' +
                    '<span class="mfh mfh-n" data-dir="n"></span>' +
                    '<span class="mfh mfh-s" data-dir="s"></span>' +
                    '<span class="mfh mfh-e" data-dir="e"></span>' +
                    '<span class="mfh mfh-w" data-dir="w"></span>' +
                    '<span class="mfh mfh-ne" data-dir="ne"></span>' +
                    '<span class="mfh mfh-nw" data-dir="nw"></span>' +
                    '<span class="mfh mfh-se" data-dir="se"></span>' +
                    '<span class="mfh mfh-sw" data-dir="sw"></span>' +
                '</div>';

            win.bar = win.el.querySelector('.fview-bar');
            win.body = win.el.querySelector('.fview-body');
            win.media = {
                loading: win.el.querySelector('.fview-loading'),
                loadingText: win.el.querySelector('.fview-loading-text'),
                img: win.el.querySelector('.fview-img'),
                video: win.el.querySelector('.fview-video'),
                audio: win.el.querySelector('.fview-audio'),
                office: win.el.querySelector('.fview-office'),
                code: win.el.querySelector('.fview-code'),
                unsupported: win.el.querySelector('.fview-unsupported')
            };

            container.appendChild(win.el);
            _fviewBindWindow(win);
            fviewWindows.push(win);
            return win;
        }

        // ============================================================
        // 窗口交互：拖动 / 缩放 / 媒体事件 / 图片缩放
        // ============================================================
        function _fviewBindWindow(win) {
            // 点击窗口任意处置顶
            win.el.addEventListener('pointerdown', function() {
                _fviewFocusWindow(win);
            });
            // 关闭按钮：只销毁自身窗口，不影响聊天页面与其它窗口
            win.el.querySelector('.fview-close-btn').addEventListener('click', function() {
                _fviewCloseWindow(win);
            });
            // 最小化按钮：收缩为顶部胶囊
            win.el.querySelector('.fview-min-btn').addEventListener('click', function() {
                _fviewMinimizeWindow(win);
            });
            _fviewBindDrag(win);
            _fviewBindResize(win);
            _fviewBindMedia(win);
            if (win.type === 'image') _fviewBindImage(win);
        }

        // 拖动标题栏移动窗口
        function _fviewBindDrag(win) {
            const bar = win.bar;
            bar.addEventListener('pointerdown', function(e) {
                if (e.target.closest('button')) return; // 忽略按钮点击
                e.preventDefault();
                const startX = e.clientX,
                    startY = e.clientY;
                const rect = win.el.getBoundingClientRect();
                const baseX = rect.left,
                    baseY = rect.top;
                const vw = window.innerWidth,
                    vh = window.innerHeight;
                if (bar.setPointerCapture) {
                    try { bar.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件等无活动指针时忽略 */ }
                }
                const onMove = function(ev) {
                    let nx = baseX + (ev.clientX - startX);
                    let ny = baseY + (ev.clientY - startY);
                    // 保证窗口部分可见（至少露出 120px 宽 / 48px 高）
                    nx = Math.max(-rect.width + 120, Math.min(nx, vw - 120));
                    ny = Math.min(ny, vh - 48);
                    if (ny < 0) ny = 0;
                    win.el.style.left = nx + 'px';
                    win.el.style.top = ny + 'px';
                };
                const onUp = function() {
                    bar.removeEventListener('pointermove', onMove);
                    bar.removeEventListener('pointerup', onUp);
                    bar.removeEventListener('pointercancel', onUp);
                    if (bar.hasPointerCapture && bar.hasPointerCapture(e.pointerId)) {
                        try { bar.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                    }
                    const r = win.el.getBoundingClientRect();
                    win.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
                };
                bar.addEventListener('pointermove', onMove);
                bar.addEventListener('pointerup', onUp);
                bar.addEventListener('pointercancel', onUp);
            });
        }

        // 8 方向缩放
        function _fviewBindResize(win) {
            const handles = win.el.querySelectorAll('.fview-handles .mfh');
            handles.forEach(function(handle) {
                handle.addEventListener('pointerdown', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    const dir = handle.getAttribute('data-dir') || '';
                    const rect = win.el.getBoundingClientRect();
                    const base = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
                    const startX = e.clientX,
                        startY = e.clientY;
                    const vw = window.innerWidth,
                        vh = window.innerHeight;
                    if (win.el.setPointerCapture) {
                        try { win.el.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件等无活动指针时忽略 */ }
                    }
                    const onMove = function(ev) {
                        const dx = ev.clientX - startX;
                        const dy = ev.clientY - startY;
                        let nx = base.x,
                            ny = base.y,
                            nw = base.w,
                            nh = base.h;
                        if (dir.indexOf('e') !== -1) nw = base.w + dx;
                        if (dir.indexOf('s') !== -1) nh = base.h + dy;
                        if (dir.indexOf('w') !== -1) { nw = base.w - dx; nx = base.x + (base.w - nw); }
                        if (dir.indexOf('n') !== -1) { nh = base.h - dy; ny = base.y + (base.h - nh); }
                        nw = Math.max(FVIEW_MIN_W, Math.min(nw, vw - nx));
                        nh = Math.max(FVIEW_MIN_H, Math.min(nh, vh - ny));
                        win.el.style.left = nx + 'px';
                        win.el.style.top = ny + 'px';
                        win.el.style.width = nw + 'px';
                        win.el.style.height = nh + 'px';
                    };
                    const onUp = function() {
                        win.el.removeEventListener('pointermove', onMove);
                        win.el.removeEventListener('pointerup', onUp);
                        win.el.removeEventListener('pointercancel', onUp);
                        if (win.el.hasPointerCapture && win.el.hasPointerCapture(e.pointerId)) {
                            try { win.el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                        }
                        const r = win.el.getBoundingClientRect();
                        win.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
                    };
                    win.el.addEventListener('pointermove', onMove);
                    win.el.addEventListener('pointerup', onUp);
                    win.el.addEventListener('pointercancel', onUp);
                });
            });
        }

        // 媒体元素事件（canplay/error）——每个窗口独立绑定，互不影响
        function _fviewBindMedia(win) {
            const m = win.media;

            m.video.addEventListener('canplay', function() {
                if (!_fviewAlive(win)) return;
                m.loading.classList.add('hidden');
                m.video.classList.remove('hidden');
                if (m.video.paused) {
                    m.video.play().catch(function() { /* 浏览器自动播放策略拦截时忽略 */ });
                }
            });
            m.video.addEventListener('error', function() {
                // 仅在设置过真实 src 时提示失败（清空 src 触发的 error 忽略）
                if (!m.video.hasAttribute('src') || !m.video.getAttribute('src')) return;
                if (!_fviewAlive(win)) return;
                m.loadingText.textContent = '视频加载失败';
                m.loading.classList.remove('hidden');
            });

            m.audio.addEventListener('canplay', function() {
                if (!_fviewAlive(win)) return;
                m.loading.classList.add('hidden');
                m.audio.classList.remove('hidden');
                if (m.audio.paused) {
                    m.audio.play().catch(function() { /* 浏览器自动播放策略拦截时忽略 */ });
                }
            });
            m.audio.addEventListener('error', function() {
                if (!m.audio.hasAttribute('src') || !m.audio.getAttribute('src')) return;
                if (!_fviewAlive(win)) return;
                m.loadingText.textContent = '音频加载失败';
                m.loading.classList.remove('hidden');
            });

            m.office.addEventListener('load', function() {
                if (m.loading) m.loading.classList.add('hidden');
            });
            m.office.addEventListener('error', function() {
                if (m.loading) m.loading.classList.add('hidden');
            });
        }

        // 图片缩放 / 平移（每个窗口独立状态）
        function _fviewBindImage(win) {
            const m = win.media;
            const z = win.zoom;

            win.el.querySelector('.fview-zoom-out').addEventListener('click', function() { _fviewZoom(win, 0.8); });
            win.el.querySelector('.fview-zoom-in').addEventListener('click', function() { _fviewZoom(win, 1.25); });
            win.el.querySelector('.fview-zoom-reset').addEventListener('click', function() { _fviewResetZoom(win); });
            m.img.addEventListener('dblclick', function() { _fviewToggleZoom(win); });
            m.img.addEventListener('contextmenu', function(e) { e.preventDefault(); });

            // 触摸：单指拖动、双指缩放（仅作用于图片）
            win.body.addEventListener('touchstart', function(e) {
                if (e.target.tagName !== 'IMG') return;
                const t = e.touches;
                if (t.length === 1) {
                    z.touchStart = true;
                    z.lastX = t[0].clientX;
                    z.lastY = t[0].clientY;
                } else if (t.length === 2) {
                    z.lastDist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
                }
            }, { passive: true });
            win.body.addEventListener('touchmove', function(e) {
                if (e.target.tagName !== 'IMG') return;
                const t = e.touches;
                if (t.length === 1 && z.touchStart) {
                    z.tx += t[0].clientX - z.lastX;
                    z.ty += t[0].clientY - z.lastY;
                    z.lastX = t[0].clientX;
                    z.lastY = t[0].clientY;
                    _fviewApplyImg(win);
                } else if (t.length === 2) {
                    const dist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
                    z.scale = Math.min(Math.max(z.scale * (dist / (z.lastDist || dist)), 0.25), 5);
                    z.lastDist = dist;
                    _fviewApplyImg(win);
                    _fviewZoomLabel(win);
                }
            }, { passive: true });
            win.body.addEventListener('touchend', function() {
                z.touchStart = false;
            }, { passive: true });

            // 鼠标左键按住拖动（桌面端）：仅作用于图片
            win.body.addEventListener('mousedown', function(e) {
                if (e.button !== 0) return;
                if (e.target.tagName !== 'IMG') return;
                z.mouseDown = true;
                z.lastX = e.clientX;
                z.lastY = e.clientY;
                win.body.classList.add('dragging');
                e.preventDefault();
                document.addEventListener('mousemove', onDocMove);
                document.addEventListener('mouseup', onDocUp);
            });
            function onDocMove(e) {
                if (!z.mouseDown) return;
                z.tx += e.clientX - z.lastX;
                z.ty += e.clientY - z.lastY;
                z.lastX = e.clientX;
                z.lastY = e.clientY;
                _fviewApplyImg(win);
            }
            function onDocUp() {
                if (!z.mouseDown) return;
                z.mouseDown = false;
                win.body.classList.remove('dragging');
                document.removeEventListener('mousemove', onDocMove);
                document.removeEventListener('mouseup', onDocUp);
            }
        }

        function _fviewApplyImg(win) {
            const img = win.media.img;
            img.style.transform = 'scale(' + win.zoom.scale + ') translate(' + win.zoom.tx + 'px, ' + win.zoom.ty + 'px)';
        }

        function _fviewZoom(win, factor) {
            win.zoom.scale = Math.min(Math.max(win.zoom.scale * factor, 0.25), 5);
            _fviewApplyImg(win);
            _fviewZoomLabel(win);
        }

        function _fviewResetZoom(win) {
            win.zoom.scale = 1;
            win.zoom.tx = 0;
            win.zoom.ty = 0;
            _fviewApplyImg(win);
            _fviewZoomLabel(win);
        }

        function _fviewToggleZoom(win) {
            if (win.zoom.scale > 1.01) {
                _fviewResetZoom(win);
            } else {
                win.zoom.scale = 2;
                _fviewApplyImg(win);
                _fviewZoomLabel(win);
            }
        }

        function _fviewZoomLabel(win) {
            const label = win.el.querySelector('.fview-zoom-label');
            if (label) label.textContent = Math.round(win.zoom.scale * 100) + '%';
        }

        // ============================================================
        // 最小化胶囊 / 恢复 / 关闭
        // ============================================================
        function _fviewMinimizeWindow(win) {
            if (win.minimized) return;
            win.minimized = true;
            win.el.classList.remove('fview-restoring');

            // 原位缩小：胶囊出现在窗口当前位置（左上角对齐），窗口收缩动画指向胶囊
            const rect = win.el.getBoundingClientRect();
            const vw = window.innerWidth,
                vh = window.innerHeight;
            const capW = 200,
                capH = 36; // 与 CSS .fview-capsule 一致（max-width 200 / height 36）
            let capX = Math.max(0, Math.min(rect.left, vw - capW));
            let capY = Math.max(0, Math.min(rect.top, vh - capH));

            // 窗口收缩动画：以左上角为原点，平移到胶囊位置并缩放到胶囊尺寸
            const dx = capX - rect.left,
                dy = capY - rect.top;
            const scaleX = capW / rect.width,
                scaleY = capH / rect.height;
            win.el.style.transformOrigin = '0 0';
            win.el.style.transition = 'transform 0.22s ease-in, opacity 0.22s ease-in';
            win.el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + scaleX + ',' + scaleY + ')';
            win.el.style.opacity = '0';

            // 创建胶囊并放到窗口原位（动画期间与收缩中的窗口重叠，形成原位缩小效果）
            const cap = document.createElement('div');
            cap.className = 'fview-capsule';
            cap.title = win.title + '（点击恢复，可拖动）';
            cap.style.left = capX + 'px';
            cap.style.top = capY + 'px';
            const icon = FVIEW_TYPE_ICON[win.type];
            cap.innerHTML =
                '<svg viewBox="0 0 24 24"><use href="#' + icon + '" xlink:href="#' + icon + '"/></svg>' +
                '<span class="fview-cap-title">' + escapeHtml(win.title) + '</span>' +
                '<button class="fview-cap-close" title="关闭"><svg viewBox="0 0 24 24" width="14" height="14"><use href="#icon-close" xlink:href="#icon-close"/></svg></button>';
            win.capsule = cap;
            _fviewEnsureContainer().appendChild(cap);
            _fviewBindCapsuleDrag(cap, win);

            // 动画结束后隐藏窗口并清理动画样式（期间被恢复则跳过，避免误隐藏已恢复的窗口）
            if (win._minTimer) clearTimeout(win._minTimer);
            win._minTimer = setTimeout(function() {
                win._minTimer = null;
                if (!win.minimized || !_fviewAlive(win)) return;
                win.el.classList.add('fview-minimized'); // display:none，媒体播放状态保留
                win.el.style.transform = '';
                win.el.style.transition = '';
                win.el.style.transformOrigin = '';
                win.el.style.opacity = '';
            }, 230);
        }

        // 胶囊：按住拖动可自由移动，未拖动（轻点）则恢复窗口
        function _fviewBindCapsuleDrag(cap, win) {
            cap.addEventListener('pointerdown', function(e) {
                if (e.target.closest('.fview-cap-close')) return; // 关闭按钮
                e.preventDefault();
                const startX = e.clientX,
                    startY = e.clientY;
                const rect = cap.getBoundingClientRect();
                const baseLeft = rect.left,
                    baseTop = rect.top;
                const vw = window.innerWidth,
                    vh = window.innerHeight;
                let moved = false;
                if (cap.setPointerCapture) {
                    try { cap.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件等无活动指针时忽略 */ }
                }
                const onMove = function(ev) {
                    const dx = ev.clientX - startX,
                        dy = ev.clientY - startY;
                    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
                    if (!moved) return;
                    let nx = baseLeft + dx,
                        ny = baseTop + dy;
                    nx = Math.max(0, Math.min(nx, vw - cap.offsetWidth));
                    ny = Math.max(0, Math.min(ny, vh - cap.offsetHeight));
                    cap.style.left = nx + 'px';
                    cap.style.top = ny + 'px';
                };
                const onUp = function() {
                    cap.removeEventListener('pointermove', onMove);
                    cap.removeEventListener('pointerup', onUp);
                    cap.removeEventListener('pointercancel', onUp);
                    if (cap.hasPointerCapture && cap.hasPointerCapture(e.pointerId)) {
                        try { cap.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                    }
                    if (!moved) _fviewRestoreWindow(win); // 轻点 → 恢复
                };
                cap.addEventListener('pointermove', onMove);
                cap.addEventListener('pointerup', onUp);
                cap.addEventListener('pointercancel', onUp);
            });
            cap.addEventListener('click', function(e) {
                if (e.target.closest('.fview-cap-close')) {
                    e.stopPropagation();
                    _fviewCloseWindow(win);
                }
            });
        }

        function _fviewRestoreWindow(win) {
            if (!win.minimized) return;
            win.minimized = false;
            // 取消最小化动画的收尾定时器，并清理收缩动画残留样式
            if (win._minTimer) { clearTimeout(win._minTimer); win._minTimer = null; }
            win.el.style.transform = '';
            win.el.style.transition = '';
            win.el.style.transformOrigin = '';
            win.el.style.opacity = '';
            // 以胶囊当前位置恢复窗口（胶囊未被拖动时即窗口原位）
            let rx = win.rect.x,
                ry = win.rect.y;
            if (win.capsule) {
                const cr = win.capsule.getBoundingClientRect();
                rx = cr.left;
                ry = cr.top;
            }
            if (win.capsule) {
                win.capsule.remove();
                win.capsule = null;
            }
            const vw = window.innerWidth,
                vh = window.innerHeight;
            const r = win.rect;
            // 尽量让窗口完整落在视口内，避免恢复后大片超出网页边界影响观感
            // （窗口大于视口时退化为保证左上角/标题栏可见）
            let x = Math.max(8, Math.min(rx, vw - r.w - 8));
            let y = Math.max(8, Math.min(ry, vh - r.h - 8));
            win.rect = { x: x, y: y, w: r.w, h: r.h };
            win.el.classList.remove('fview-minimized');
            win.el.classList.remove('fview-restoring');
            win.el.classList.add('fview-restoring'); // 缩放入场动画
            _fviewApplyRect(win);
            _fviewFocusWindow(win);
        }

        // 关闭单个窗口：清理媒体并移除 DOM，不影响其它窗口与聊天页面
        function _fviewCloseWindow(win) {
            const i = fviewWindows.indexOf(win);
            if (i !== -1) fviewWindows.splice(i, 1);
            const m = win.media;
            if (m.video) { m.video.pause(); m.video.removeAttribute('src'); m.video.load(); }
            if (m.audio) { m.audio.pause(); m.audio.removeAttribute('src'); m.audio.load(); }
            if (m.img) m.img.removeAttribute('src');
            if (m.office) { m.office.onload = m.office.onerror = null; m.office.removeAttribute('src'); }
            if (win.el && win.el.parentNode) win.el.remove();
            if (win.capsule) win.capsule.remove();
        }

        // 关闭所有预览窗口
        function closeMediaViewer() {
            while (fviewWindows.length) {
                _fviewCloseWindow(fviewWindows[0]);
            }
        }

        // 视口变化时把窗口与胶囊约束回可视区域内（胶囊保持自由位置，仅做 clamp）
        window.addEventListener('resize', function() {
            const vw = window.innerWidth,
                vh = window.innerHeight;
            fviewWindows.forEach(function(win) {
                if (win.minimized) {
                    if (win.capsule) {
                        const cw = win.capsule.offsetWidth,
                            ch = win.capsule.offsetHeight;
                        let cl = parseInt(win.capsule.style.left, 10) || 0;
                        let ct = parseInt(win.capsule.style.top, 10) || 0;
                        cl = Math.max(0, Math.min(cl, vw - cw));
                        ct = Math.max(0, Math.min(ct, vh - ch));
                        win.capsule.style.left = cl + 'px';
                        win.capsule.style.top = ct + 'px';
                    }
                    return;
                }
                const r = win.rect;
                r.x = Math.max(-r.w + 120, Math.min(r.x, vw - 120));
                r.y = Math.max(0, Math.min(r.y, vh - 48));
                _fviewApplyRect(win);
            });
        });

        // ============================================================
        // 预览入口：不同文件各自开窗（多开）；同一文件复用已有窗口
        // ============================================================
        // 同一文件是否已有窗口：已有则恢复（若最小化）并置顶，返回 true，不再新建
        function _fviewReuseExisting(url, filename) {
            const key = url || filename || '';
            if (!key) return false;
            const existing = fviewWindows.find(function(w) { return w.key === key; });
            if (!existing) return false;
            if (existing.minimized) _fviewRestoreWindow(existing);
            _fviewFocusWindow(existing);
            return true;
        }

        function previewImage(url, filename) {
            if (!url) return;
            if (_fviewReuseExisting(url, filename)) return;
            const win = _fviewCreateWindow('image', url, filename || '');
            const m = win.media;
            m.img.classList.remove('hidden');
            // 优先使用本地图片缓存（未命中时拉取并写入），减少对服务器的重复请求；不可用时直接加载原 url
            if (typeof getCachedImageUrl === 'function') {
                getCachedImageUrl(url).then(function(src) {
                    if (!_fviewAlive(win)) {
                        // v073：预览窗口已关闭时立即释放缓存 objectURL
                        if (typeof revokeImageObjectUrl === 'function') revokeImageObjectUrl(src);
                        return;
                    }
                    m.img.src = src || url;
                    if (src && typeof revokeImageObjectUrl === 'function') {
                        // v073：加载完成/失败后释放缓存 objectURL，防内存增长
                        const done = function() {
                            revokeImageObjectUrl(src);
                            m.img.removeEventListener('load', done);
                            m.img.removeEventListener('error', done);
                        };
                        m.img.addEventListener('load', done);
                        m.img.addEventListener('error', done);
                    }
                });
            } else {
                m.img.src = url;
            }
        }

        // 文件型图片消息点击时复用图片预览
        function viewImage(url) {
            previewImage(url);
        }

        function openVideoPreview(url, filename) {
            if (!url) return;
            if (_fviewReuseExisting(url, filename)) return;
            const win = _fviewCreateWindow('video', url, filename || '');
            const m = win.media;
            m.loadingText.textContent = '视频加载中...';
            m.loading.classList.remove('hidden');
            m.video.src = url;
        }

        function openAudioPreview(url, filename) {
            if (!url) return;
            if (_fviewReuseExisting(url, filename)) return;
            const win = _fviewCreateWindow('audio', url, filename || '');
            const m = win.media;
            m.loadingText.textContent = '音频加载中...';
            m.loading.classList.remove('hidden');
            m.audio.src = url;
        }

        // 文件预览总入口：按扩展名分发
        // v086: 从（可能已过期的）预签名 URL 中提取对象 Key。
        // public_base 为空时 public_url 返回 7 天有效的签名链接，消息发送时写死进文本，
        // 过期后 Office 预览会报"原始文件无效/不可公开访问"；群文件每次重新生成所以正常。
        // 预签名 URL 形如 https://<endpoint>/<bucket>/<key>?X-Amz-*，去掉端点与桶名前缀即得 Key。
        function _presignedKeyOf(url) {
            try {
                const u = new URL(url);
                if (!/X-Amz-/i.test(u.search)) return null; // 非预签名链接（如公共读直链）无需刷新
                const p = u.pathname.replace(/^\//, '');     // <bucket>/<key>
                const slash = p.indexOf('/');
                if (slash <= 0) return null;
                return p.slice(slash + 1);
            } catch (e) { return null; }
        }

        async function _refreshMediaUrl(url) {
            const key = _presignedKeyOf(url);
            if (!key) return url;
            try {
                const fresh = await s3.mediaUrl(key); // presign_get(key, 3600) 换取新签名
                if (window.__debugLog && fresh !== url) window.__debugLog('预览刷新过期URL: ' + key);
                return fresh || url;
            } catch (e) { return url; }
        }

        async function openFilePreview(url, filename) {
            if (!url) return;
            filename = filename || '';
            // 先刷新可能已过期的预签名 URL，再决定预览方式
            url = await _refreshMediaUrl(url);
            if (!url) return;
            const ext = (filename.split('.').pop() || '').toLowerCase();
            if (IMAGE_EXTS.indexOf(ext) !== -1) { previewImage(url, filename); return; }
            if (VIDEO_EXTS.indexOf(ext) !== -1) { openVideoPreview(url, filename); return; }
            if (AUDIO_EXTS.indexOf(ext) !== -1) { openAudioPreview(url, filename); return; }
            if (FVIEW_OFFICE_EXTS.indexOf(ext) !== -1) { _previewOffice(url, filename); return; }
            if (FVIEW_CODE_EXTS.indexOf(ext) !== -1) { _previewCode(url, filename); return; }
            _previewUnsupported(filename);
        }

        // Office 文档：Office Web Viewer
        function _previewOffice(url, filename) {
            if (!url) return;
            if (_fviewReuseExisting(url, filename)) return;
            const win = _fviewCreateWindow('office', url, filename || '');
            const m = win.media;
            m.loadingText.textContent = '文档加载中...';
            m.loading.classList.remove('hidden');
            m.office.src = OFFICE_VIEWER_BASE + encodeURIComponent(url);
            m.office.classList.remove('hidden');
            win.body.classList.add('file-mode');
        }

        // 代码文件：highlight.js 高亮
        async function _previewCode(url, filename) {
            if (!url) return;
            if (_fviewReuseExisting(url, filename)) return;
            const win = _fviewCreateWindow('code', url, filename || '');
            const m = win.media;
            win.body.classList.add('file-mode');
            m.loadingText.textContent = '文件加载中...';
            m.loading.classList.remove('hidden');
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const text = await res.text();
                if (!_fviewAlive(win)) return; // 窗口已被关闭
                const ext = (filename.split('.').pop() || '').toLowerCase();
                const lang = FVIEW_CODE_LANG_MAP[ext] || null;
                let html;
                if (typeof hljs === 'undefined') {
                    try { await _ensureHighlightJs(); } catch (e) { /* 加载失败则走纯文本兜底 */ }
                }
                if (typeof hljs !== 'undefined') {
                    if (lang && hljs.getLanguage(lang)) {
                        html = hljs.highlight(text, { language: lang }).value;
                    } else {
                        html = hljs.highlightAuto(text).value;
                    }
                } else {
                    html = escapeHtml(text); // highlight.js 未加载时的兜底
                }
                const codeEl = m.code.querySelector('code');
                if (codeEl) codeEl.innerHTML = html;
                m.code.classList.remove('hidden');
                m.loading.classList.add('hidden');
            } catch (e) {
                if (!_fviewAlive(win)) return;
                m.loading.classList.add('hidden');
                m.unsupported.querySelector('span').textContent = '文件加载失败';
                m.unsupported.classList.remove('hidden');
            }
        }

        // 不支持的格式：居中提示
        function _previewUnsupported(filename) {
            if (_fviewReuseExisting('', filename)) return;
            const win = _fviewCreateWindow('unsupported', '', filename || '');
            const m = win.media;
            m.unsupported.querySelector('span').textContent = '该文件不支持预览';
            m.unsupported.classList.remove('hidden');
            win.body.classList.add('file-mode');
        }
