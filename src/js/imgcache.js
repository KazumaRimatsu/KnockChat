/* KnockChat 图片字节缓存 imgcache.js
 * 通过 Cache API 持久化图片字节：首次拉取后写入缓存，再次渲染直接以 objectURL 显示，
 * 减少对服务器的重复请求与流量开支；命中/拉取失败（CORS、配额、非图片等）时自动回退原 url。
 * 缓存按时间（7 天）与条数（500 条）自动淘汰；仅 HTTPS / localhost 安全上下文可用。
 * v073：新增并发去重（同 URL 在途共享 Promise）、拉取超时、objectURL 释放（revokeImageObjectUrl）、
 * 写入后增量淘汰。
 * 依赖：无（独立模块，供 chat.js / profile.js / fview.js 使用）。
 */

        const IMGCACHE_NAME = LS_KEYS.IMGCACHE_DB;
        const IMGCACHE_MAX_AGE = 7 * 24 * 3600 * 1000; // 7 天
        const IMGCACHE_MAX_ENTRIES = 500;              // 条目上限，超出按最旧淘汰
        const IMGCACHE_MAX_BLOB = 8 * 1024 * 1024;     // 单图上限 8MB，过大不入缓存
        const IMGCACHE_FETCH_TIMEOUT = 15000;          // v073：拉取超时（毫秒）

        let _imgCachePromise = null;
        const _pendingFetches = new Map();   // v073：url -> in-flight Promise，并发去重
        const _issuedObjectUrls = new Set(); // v073：已签发的 objectURL 跟踪，供调用方释放

        function _imgCache() {
            if (_imgCachePromise) return _imgCachePromise;
            try {
                if (typeof caches === 'undefined') {
                    _imgCachePromise = Promise.resolve(null);
                } else {
                    _imgCachePromise = caches.open(IMGCACHE_NAME).catch(function() { return null; });
                }
            } catch (e) {
                _imgCachePromise = Promise.resolve(null);
            }
            return _imgCachePromise;
        }

        // v073：安全释放缓存签发的 objectURL（调用方在 img onload/onerror 后调用），
        // 解决原实现 objectURL 只创建不释放导致的内存持续增长
        function revokeImageObjectUrl(url) {
            if (url && _issuedObjectUrls.has(url)) {
                try { URL.revokeObjectURL(url); } catch (e) {}
                _issuedObjectUrls.delete(url);
            }
        }

        // 命中缓存则返回 objectURL，否则返回 null（不触发网络请求）
        async function cachedImageUrl(url) {
            if (!url || typeof caches === 'undefined' || !/^https?:\/\//i.test(url)) return null;
            try {
                const cache = await _imgCache();
                if (!cache) return null;
                const res = await cache.match(url);
                if (!res) return null;
                const blob = await res.blob();
                if (!blob || !blob.size) return null;
                const objUrl = URL.createObjectURL(blob);
                _issuedObjectUrls.add(objUrl);
                return objUrl;
            } catch (e) { return null; }
        }

        // 按 URL 取回已缓存的图片字节（blob），供保存图片等场景复用已验证的有效数据。
        // 原始预签名链接可能已过期，但缓存键为 mediaUrlToPublic 规范化后的公开直链，永续有效。
        async function getCachedImageBlob(url) {
            const norm = (typeof mediaUrlToPublic === 'function') ? mediaUrlToPublic(url) : url;
            if (!norm || typeof caches === 'undefined' || !/^https?:\/\//i.test(norm)) return null;
            try {
                const cache = await _imgCache();
                if (!cache) return null;
                const res = await cache.match(norm);
                if (!res) return null;
                const blob = await res.blob();
                if (!blob || !blob.size) return null;
                return blob;
            } catch (e) { return null; }
        }

        // 删除指定媒体 URL 的缓存字节（消息删除/清空时同步清理本地缓存）。
        // 缓存键与 getCachedImageBlob 一致：mediaUrlToPublic 规范化后的公开直链；
        // 未命中该 URL 的缓存条目时 delete 返回 false，静默忽略即可。
        async function removeCachedImage(url) {
            const norm = (typeof mediaUrlToPublic === 'function') ? mediaUrlToPublic(url) : url;
            if (!norm || typeof caches === 'undefined' || !/^https?:\/\//i.test(norm)) return;
            try {
                const cache = await _imgCache();
                if (!cache) return;
                await cache.delete(norm);
            } catch (e) { /* 忽略 */ }
        }

        async function _fetchAndCacheImage(url) {
            try {
                // v073：AbortController 超时，避免坏 URL 长时间挂起
                const controller = new AbortController();
                const timer = setTimeout(function() { controller.abort(); }, IMGCACHE_FETCH_TIMEOUT);
                let res;
                try {
                    res = await fetch(url, { mode: 'cors', signal: controller.signal });
                } finally {
                    clearTimeout(timer);
                }
                if (!res.ok) return null;
                const blob = await res.blob();
                if (!blob || !blob.size || !blob.type || blob.type.indexOf('image') !== 0) return null;
                if (blob.size > IMGCACHE_MAX_BLOB) return null;
                const cache = await _imgCache();
                if (cache) {
                    const headers = new Headers();
                    headers.set('Content-Type', blob.type);
                    headers.set('X-Cika-Cached-At', String(Date.now()));
                    try {
                        await cache.put(url, new Response(blob, { headers: headers }));
                        // v073：写入后增量检查条数，超限即淘汰最旧
                        _evictIfNeeded(cache).catch(function() {});
                    } catch (e) { /* 配额不足等：仅丢弃写入，不影响本次显示 */ }
                }
                const objUrl = URL.createObjectURL(blob);
                _issuedObjectUrls.add(objUrl);
                return objUrl;
            } catch (e) { return null; }
        }

        // v073：并发去重 —— 同一 URL 在途时共享同一 Promise，避免重复拉取同一字节
        function fetchAndCacheImage(url) {
            if (!url || typeof caches === 'undefined' || !/^https?:\/\//i.test(url)) return Promise.resolve(null);
            const pending = _pendingFetches.get(url);
            if (pending) return pending;
            const p = _fetchAndCacheImage(url).then(function(r) {
                _pendingFetches.delete(url);
                return r;
            }, function() {
                _pendingFetches.delete(url);
                return null;
            });
            _pendingFetches.set(url, p);
            return p;
        }

        // 优先命中缓存；未命中则拉取并缓存。均失败返回 null
        async function getCachedImageUrl(url) {
            // 统一把（可能已过期/换 AK 失效的）预签名链接还原为公开直链，
            // 保证缓存键与拉取 URL 一致、且对象可被公共读直接访问（see other.js mediaUrlToPublic）
            const norm = (typeof mediaUrlToPublic === 'function') ? mediaUrlToPublic(url) : url;
            if (!norm) return null;
            const hit = await cachedImageUrl(norm);
            if (hit) return hit;
            return fetchAndCacheImage(norm);
        }

        // v073：运行期淘汰 —— 写入后检查条数，超限时按最旧增量删除
        async function _evictIfNeeded(cache) {
            const keys = await cache.keys();
            if (keys.length <= IMGCACHE_MAX_ENTRIES) return;
            const now = Date.now();
            const list = [];
            for (let i = 0; i < keys.length; i++) {
                const res = await cache.match(keys[i]);
                if (!res) continue;
                const at = parseInt(res.headers.get('X-Cika-Cached-At') || '0', 10) || now;
                list.push({ req: keys[i], at: at });
            }
            if (list.length <= IMGCACHE_MAX_ENTRIES) return;
            list.sort(function(a, b) { return a.at - b.at; });
            const excess = list.length - IMGCACHE_MAX_ENTRIES;
            for (let i = 0; i < excess; i++) {
                await cache.delete(list[i].req);
            }
        }

        // 启动清理：删除过期条目；条数超限时按最旧淘汰（fire-and-forget）
        async function _imgCacheCleanup() {
            const cache = await _imgCache();
            if (!cache) return;
            const keys = await cache.keys();
            const now = Date.now();
            const list = [];
            for (let i = 0; i < keys.length; i++) {
                const res = await cache.match(keys[i]);
                if (!res) continue;
                const at = parseInt(res.headers.get('X-Cika-Cached-At') || '0', 10) || 0;
                if (at && now - at > IMGCACHE_MAX_AGE) {
                    await cache.delete(keys[i]);
                    continue;
                }
                list.push({ req: keys[i], at: at || now });
            }
            if (list.length > IMGCACHE_MAX_ENTRIES) {
                list.sort(function(a, b) { return a.at - b.at; });
                const excess = list.length - IMGCACHE_MAX_ENTRIES;
                for (let i = 0; i < excess; i++) {
                    await cache.delete(list[i].req);
                }
            }
        }

        if (typeof window !== 'undefined') {
            try { _imgCacheCleanup().catch(function() {}); } catch (e) { /* ignore */ }
        }
