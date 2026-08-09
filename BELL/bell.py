#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KnockChat 管理工具（BELL）
==========================
基于 Python + tkinter 的 KnockChat 服务端管理工具，直连雨云 S3 兼容存储桶。

功能：
  1. 用户管理：浏览用户、细分限制（登录/公聊文字/公聊媒体链接/新私聊/私聊消息/改头像背景）、
     定时解封、强制下线（清除会话）、查看详情
  2. 消息管理：公聊消息搜索与删除（可选连带删除关联媒体文件）。
     私聊消息涉及用户隐私，本工具不提供私聊管理。
  3. 群文件：按前缀浏览媒体对象（群文件/私聊附件/头像/背景），删除选中或清空

数据存储结构（与 src-tauri/src/s3rpc.rs 一致）：
  users/<uid>.json            用户资料
                               banned=true 完全封禁（登录限制）
                               restrictions.<name> = {enabled, until} 细分限制
                               until 为 ISO-8601 到期时间，后端到期自动解封（懒清除）
  users/_index.json           { username: uid } 统一索引
  users/_meta.json            { next_uid }
  sessions/<token>.json       登录会话
  public/messages/<id>.json   公聊消息
  private/sessions/<sid>.json 私聊会话（sid = 较小uid__较大uid）
  private/messages/<sid>/<id>.json 私聊消息
  media/<chat|public|private|avatars|background>/... 媒体对象

运行：python bell.py            （图形界面）
      python bell.py --selftest  （仅测试连接并统计，不启动 GUI）
"""

import argparse
import hashlib
import hmac
import json
import os
import queue
import re
import threading
import time
import tkinter as tk
import tkinter.messagebox
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from tkinter import ttk

import requests

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_REGION = "us-east-1"  # s3-config.json 未填 region 时与 Rust 侧默认一致


def default_config_paths():
    """配置查找顺序：BELL/s3-config.json → 项目 src-tauri/s3-config.json"""
    return [
        os.path.join(SCRIPT_DIR, "s3-config.json"),
        os.path.join(SCRIPT_DIR, "..", "src-tauri", "s3-config.json"),
    ]


def load_config(path=None):
    """加载 S3 配置；找不到时返回含空字段的 dict"""
    paths = [path] if path else default_config_paths()
    for p in paths:
        if p and os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                cfg["_source"] = p
                return cfg
            except Exception:
                continue
    return {"endpoint": "", "region": "", "bucket": "", "access_key": "",
            "secret_key": "", "path_style": True, "_source": ""}


def save_config(cfg, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# S3 客户端（AWS Signature V4，与 src-tauri/src/s3.rs 同算法，纯 requests 实现）
# ---------------------------------------------------------------------------

def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac_sha256(key: bytes, data: str) -> bytes:
    return hmac.new(key, data.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret: str, date: str, region: str) -> bytes:
    k_date = _hmac_sha256(("AWS4" + secret).encode("utf-8"), date)
    k_region = _hmac_sha256(k_date, region)
    k_service = _hmac_sha256(k_region, "s3")
    return _hmac_sha256(k_service, "aws4_request")


def _sigv4_encode(s: str) -> str:
    """AWS SigV4 UriEncode：除 A-Za-z0-9-._~ 外全部百分号编码（大写 hex）"""
    return urllib.parse.quote(s, safe="-._~")


def _canonical_query_str(qmap) -> str:
    q = sorted(qmap.items())
    return "&".join(f"{_sigv4_encode(k)}={_sigv4_encode(str(v))}" for k, v in q)


class S3Client:
    def __init__(self, cfg: dict):
        self.endpoint = (cfg.get("endpoint") or "").rstrip("/")
        self.region = cfg.get("region") or DEFAULT_REGION
        self.bucket = cfg.get("bucket") or ""
        self.access_key = cfg.get("access_key") or ""
        self.secret_key = cfg.get("secret_key") or ""
        self.path_style = bool(cfg.get("path_style", True))
        self.public_base = (cfg.get("public_base") or "").rstrip("/")

    def is_configured(self) -> bool:
        return bool(self.endpoint and self.bucket and self.access_key and self.secret_key)

    def object_url(self, key: str) -> str:
        if self.path_style:
            return f"{self.endpoint}/{self.bucket}/{key}"
        return f"{self.endpoint}/{key}"

    def canonical_uri(self, key: str) -> str:
        if self.path_style:
            return f"/{self.bucket}/{key}"
        return f"/{key}"

    def _send(self, method: str, key: str, query: dict = None, body: bytes = None,
              extra_headers: dict = None):
        """执行一次带 SigV4 签名的 S3 请求，返回 (status, bytes)"""
        url = self.object_url(key)
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname or ""

        amz_date = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        date = amz_date[:8]

        payload_hash = _sha256_hex(body if body is not None else b"")

        # 规范化请求头（小写键排序）
        headers = {"host": host, "x-amz-content-sha256": payload_hash,
                   "x-amz-date": amz_date}
        for k, v in (extra_headers or {}).items():
            headers[k.lower()] = str(v)
        canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
        signed_headers = ";".join(sorted(headers))

        qmap = query or {}
        canonical_query = _canonical_query_str(qmap)

        canonical_request = "\n".join([
            method.upper(), self.canonical_uri(key), canonical_query,
            canonical_headers, signed_headers, payload_hash,
        ])
        scope = f"{date}/{self.region}/s3/aws4_request"
        string_to_sign = "\n".join([
            "AWS4-HMAC-SHA256", amz_date, scope,
            _sha256_hex(canonical_request.encode("utf-8")),
        ])
        signature = hmac.new(
            _signing_key(self.secret_key, date, self.region),
            string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

        authorization = (f"AWS4-HMAC-SHA256 Credential={self.access_key}/{scope}, "
                         f"SignedHeaders={signed_headers}, Signature={signature}")

        request_url = url
        if canonical_query:
            request_url = f"{url}?{canonical_query}"

        req_headers = {k: headers[k] for k in headers}
        req_headers["Authorization"] = authorization
        resp = requests.request(method.upper(), request_url, headers=req_headers,
                                data=body if body is not None else None,
                                timeout=(15, 120))
        return resp.status_code, resp.content

    # ---- 底层对象操作 ----

    def put_object(self, key: str, body: bytes, content_type: str = "application/octet-stream"):
        status, data = self._send("PUT", key, body=body,
                                  extra_headers={"content-type": content_type})
        if not (200 <= status < 300):
            raise RuntimeError(f"PUT {key} 失败: HTTP {status} {data[:300]!r}")

    def get_object(self, key: str):
        """GET 对象；404 返回 None"""
        status, data = self._send("GET", key)
        if status == 200:
            return data
        if status == 404:
            return None
        raise RuntimeError(f"GET {key} 失败: HTTP {status} {data[:300]!r}")

    def delete_object(self, key: str):
        """DELETE 对象；404 视为成功"""
        status, data = self._send("DELETE", key)
        if not (200 <= status < 300) and status != 404:
            raise RuntimeError(f"DELETE {key} 失败: HTTP {status} {data[:300]!r}")

    def list_objects(self, prefix: str):
        """列出前缀下全部对象（自动翻页），返回 [{key,size,last_modified}]"""
        out = []
        token = None
        while True:
            query = {"list-type": "2", "prefix": prefix}
            if token:
                query["continuation-token"] = token
            status, body = self._send("GET", "", query=query)
            if status != 200:
                raise RuntimeError(f"list_objects({prefix}) 失败: HTTP {status} {body[:300]!r}")
            try:
                root = ET.fromstring(body)
            except ET.ParseError as e:
                raise RuntimeError(f"list_objects({prefix}) XML 解析失败: {e}")
            ns = re.match(r"\{.*\}", root.tag)
            ns = ns.group(0) if ns else ""
            for c in root.iter(f"{ns}Contents"):
                key = c.findtext(f"{ns}Key") or ""
                size = int(c.findtext(f"{ns}Size") or 0)
                lm = c.findtext(f"{ns}LastModified") or ""
                out.append({"key": key, "size": size, "last_modified": lm})
            truncated = (root.findtext(f"{ns}IsTruncated") or "").strip() == "true"
            nxt = root.findtext(f"{ns}NextContinuationToken") or ""
            if not truncated or not nxt:
                break
            token = nxt
            if len(out) > 20000:
                break  # 安全上限
        return out

    def get_json(self, key: str):
        """GET 并解析 JSON；不存在返回 None"""
        data = self.get_object(key)
        if data is None:
            return None
        return json.loads(data.decode("utf-8"))

    def put_json(self, key: str, obj):
        self.put_object(key, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                        "application/json")

    def public_url(self, key: str) -> str:
        return f"{self.public_base}/{key}" if self.public_base else ""


# ---------------------------------------------------------------------------
# 业务数据访问层
# ---------------------------------------------------------------------------

class Store:
    """封装 KnockChat 存储桶的读写操作"""

    def __init__(self, s3: S3Client):
        self.s3 = s3
        self._user_cache = {}  # uid -> user dict

    # ---- 用户 ----

    def list_users(self, refresh=False):
        """枚举 users/ 前缀，返回用户 dict 列表（过滤索引文件）"""
        if self._user_cache and not refresh:
            return list(self._user_cache.values())
        metas = self.s3.list_objects("users/")
        keys = [m["key"] for m in metas
                if m["key"].startswith("users/") and m["key"].endswith(".json")
                and m["key"] not in ("users/_index.json", "users/_meta.json")
                and "/by_name/" not in m["key"]]
        users = []
        for k in keys:
            try:
                uid = int(os.path.basename(k)[:-5])
            except ValueError:
                continue
            obj = self.s3.get_json(k)
            if obj:
                users.append(obj)
        users.sort(key=lambda u: u.get("uid", 0))
        self._user_cache = {u.get("uid"): u for u in users}
        return users

    def get_user(self, uid):
        if uid in self._user_cache:
            return self._user_cache[uid]
        obj = self.s3.get_json(f"users/{uid}.json")
        if obj:
            self._user_cache[uid] = obj
        return obj

    def get_user_by_name(self, name):
        index = self.s3.get_json("users/_index.json") or {}
        uid = index.get(name)
        if isinstance(uid, (int, str)):
            return self.get_user(int(uid))
        return None

    def save_user(self, user):
        uid = user.get("uid", 0)
        self.s3.put_json(f"users/{uid}.json", user)
        self._user_cache[uid] = user

    def kick_user_sessions(self, uid):
        """删除该 uid 的全部登录会话（强制下线），返回删除数量"""
        metas = self.s3.list_objects("sessions/")
        keys = [m["key"] for m in metas
                if m["key"].startswith("sessions/") and m["key"].endswith(".json")]
        n = 0
        for k in keys:
            obj = self.s3.get_json(k)
            if obj and obj.get("uid") == uid:
                self.s3.delete_object(k)
                n += 1
        return n

    # ---- 公聊消息 ----

    def list_public_messages(self, limit=800):
        """返回最新 limit 条公聊消息（字典序即时间序）"""
        metas = self.s3.list_objects("public/messages/")
        keys = [m["key"] for m in metas
                if m["key"].startswith("public/messages/") and m["key"].endswith(".json")]
        keys.sort()
        keys = keys[-limit:]
        out = []
        for k in keys:
            obj = self.s3.get_json(k)
            if obj:
                obj["_key"] = k
                out.append(obj)
        out.sort(key=lambda m: m.get("created_at", ""), reverse=True)
        return out

    def delete_public_message(self, msg_id, delete_media=False):
        key = f"public/messages/{msg_id}.json"
        if delete_media:
            obj = self.s3.get_json(key)
            if obj:
                self._delete_msg_media(obj)
        self.s3.delete_object(key)

    # ---- 细分限制（restrictions） ----

    # 限制项 → 中文名（与后端 s3rpc.rs restriction_msg 对应）
    RESTRICTION_LABELS = {
        "login": "禁止登录",
        "public_text": "公聊发送文字",
        "public_media": "公聊发送媒体/链接",
        "new_private": "发起新的私聊",
        "private_msg": "发送私聊消息",
        "profile_edit": "修改头像/背景",
    }

    def active_restriction_names(self, user):
        """返回 {限制名: until} 当前生效的限制（已过期的忽略）"""
        out = {}
        for name in self.RESTRICTION_LABELS:
            r = (user.get("restrictions") or {}).get(name) or {}
            if r.get("enabled"):
                until = r.get("until") or ""
                if until:
                    try:
                        exp = datetime.fromisoformat(until.replace("Z", "+00:00"))
                        if exp <= datetime.now(timezone.utc):
                            continue  # 已过期
                    except Exception:
                        pass
                out[name] = until
        return out

    def set_restrictions(self, uid, items, until=""):
        """设置用户细分限制。items: {name: bool}，until 为 UTC ISO 串（空=永久）。
        勾选"登录"时同步置 banned=true，限制全清时恢复 banned=false。"""
        user = self.get_user(uid)
        if not user:
            raise RuntimeError(f"用户 {uid} 不存在")
        res = dict(user.get("restrictions") or {})
        for name, on in items.items():
            if on:
                res[name] = {"enabled": True, "until": until}
            else:
                res.pop(name, None)
        user["restrictions"] = res
        user["banned"] = bool(res.get("login"))
        self.save_user(user)
        return user

    def clear_restrictions(self, uid):
        """解除全部限制（含 banned）"""
        user = self.get_user(uid)
        if not user:
            raise RuntimeError(f"用户 {uid} 不存在")
        user["restrictions"] = {}
        user["banned"] = False
        self.save_user(user)
        return user

    # ---- 媒体 ----

    MEDIA_PREFIXES = {
        "群文件（图片/文件，media/chat + media/public）": ["media/chat/", "media/public/"],
        "私聊附件（media/private/）": ["media/private/"],
        "用户头像（media/avatars/）": ["media/avatars/"],
        "主页背景（media/background/）": ["media/background/"],
    }

    def list_media(self, prefix):
        """列出前缀下全部媒体对象"""
        if prefix == "群文件（图片/文件，media/chat + media/public）":
            items = []
            for p in self.MEDIA_PREFIXES[prefix]:
                items.extend(self.s3.list_objects(p))
            return items
        return self.s3.list_objects(prefix)

    @staticmethod
    def media_key_from_url(url):
        """从消息中的媒体 URL 提取 S3 对象 Key（media/ 开头才返回，防误删）"""
        if not url:
            return None
        path = url.split("?", 1)[0]
        try:
            parsed = urllib.parse.urlsplit(path)
            path = urllib.parse.unquote(parsed.path)
        except Exception:
            pass
        idx = path.find("media/")
        if idx < 0:
            return None
        return path[idx:]

    def _delete_msg_media(self, msg):
        """删除消息关联的媒体对象（公聊 image_url/audio_url；私聊 content 中的 URL）"""
        urls = []
        for f in ("image_url", "audio_url"):
            v = msg.get(f)
            if v:
                urls.append(v)
        content = msg.get("content") or msg.get("text") or ""
        for m in re.finditer(r"https?://[^\s\"'<>]+", content):
            urls.append(m.group(0))
        for u in urls:
            key = self.media_key_from_url(u)
            if key:
                try:
                    self.s3.delete_object(key)
                except Exception:
                    pass


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def fmt_time(iso):
    if not iso:
        return ""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo:
            dt = dt.astimezone()
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return iso


def parse_local_dt(s):
    """解析本地时间串（YYYY-MM-DD HH:MM[:SS]），失败返回 None"""
    s = s.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def to_utc_iso(dt_local):
    """本地 naive datetime → UTC ISO 串（后端 chrono rfc3339 可解析）"""
    if dt_local.tzinfo is None:
        dt_local = dt_local.astimezone()
    return dt_local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fmt_until(iso):
    """UTC 解封时间 → 本地显示串"""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.astimezone().strftime("%Y-%m-%d %H:%M")
    except Exception:
        return iso


def fmt_size(n):
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024
    return f"{n:.1f}GB"


def msg_kind(msg):
    if msg.get("is_system"):
        return "系统"
    if msg.get("image_url"):
        return "图片"
    if msg.get("audio_url"):
        return "语音"
    return "文本"


def msg_preview(msg, maxlen=40):
    if msg.get("is_system"):
        return "[系统] " + (msg.get("text") or "")[:maxlen]
    if msg.get("image_url"):
        return "[图片] " + (msg.get("text") or "")[:maxlen]
    if msg.get("audio_url"):
        return "[语音] " + (msg.get("text") or "")[:maxlen]
    return (msg.get("text") or msg.get("content") or "")[:maxlen]


# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------

class App:
    def __init__(self, root, cfg, store):
        self.root = root
        self.cfg = cfg
        self.store = store
        self.busy = False
        self.media_opts = {"delete_media": False}
        self._all_users = []
        self._queue = queue.Queue()
        self._build_ui()
        self.log(f"配置来源：{cfg.get('_source') or '未找到，请先设置'}")
        if store.s3.is_configured():
            self.log("S3 已配置，点击各面板的「刷新」加载数据。")
        else:
            self.log("S3 未配置：点击右上角「设置」填写 Endpoint/Bucket/密钥。")

    # ---------------- UI 构建 ----------------

    def _build_ui(self):
        self.root.title("Bell 门铃")
        self.root.geometry("1180x760")

        top = ttk.Frame(self.root, padding=(8, 6))
        top.pack(fill="x")
        self.status_label = ttk.Label(
            top,
            text=f"Endpoint: {self.cfg.get('endpoint') or '-'}  Bucket: {self.cfg.get('bucket') or '-'}",
            foreground="#666")
        self.status_label.pack(side="left")
        ttk.Button(top, text="设置…", command=self.on_settings).pack(side="right")
        ttk.Button(top, text="重新连接", command=self.on_reconnect).pack(side="right", padx=4)

        self.nb = ttk.Notebook(self.root)
        self.nb.pack(fill="both", expand=True, padx=8, pady=4)
        self._build_users_tab()
        self._build_messages_tab()
        self._build_media_tab()

        logf = ttk.Frame(self.root, padding=(8, 0, 8, 6))
        logf.pack(fill="x")
        ttk.Label(logf, text="日志：").pack(side="left")
        self.log_text = tk.Text(logf, height=6, state="disabled", wrap="word")
        self.log_text.pack(fill="both", expand=True)

    def _build_users_tab(self):
        tab = ttk.Frame(self.nb)
        self.nb.add(tab, text="用户管理")

        bar = ttk.Frame(tab, padding=6)
        bar.pack(fill="x")
        ttk.Label(bar, text="搜索（UID / 昵称）：").pack(side="left")
        self.user_search = tk.StringVar()
        ttk.Entry(bar, textvariable=self.user_search, width=20).pack(side="left", padx=4)
        self.user_search.trace_add("write", lambda *_: self._apply_user_filter())
        ttk.Button(bar, text="刷新", command=self.refresh_users).pack(side="left", padx=6)
        ttk.Button(bar, text="限制操作…", command=self.on_restrict).pack(side="left")
        ttk.Button(bar, text="解除限制", command=self.on_unrestrict).pack(side="left", padx=4)
        ttk.Button(bar, text="强制下线", command=self.on_kick).pack(side="left")
        ttk.Button(bar, text="查看详情", command=self.on_user_detail).pack(side="left", padx=4)

        cols = ("uid", "username", "role", "banned", "restrictions", "created", "last_login")
        self.user_tree = ttk.Treeview(tab, columns=cols, show="headings", selectmode="extended")
        heads = {"uid": ("UID", 55), "username": ("昵称", 110), "role": ("角色", 55),
                 "banned": ("状态", 60), "restrictions": ("当前限制", 230),
                 "created": ("注册时间", 130), "last_login": ("最近登录", 130)}
        for c, (t, w) in heads.items():
            self.user_tree.heading(c, text=t)
            self.user_tree.column(c, width=w, anchor="w")
        self.user_tree.pack(fill="both", expand=True, padx=6, pady=(0, 6))

    def _build_messages_tab(self):
        tab = ttk.Frame(self.nb)
        self.nb.add(tab, text="消息管理（公聊）")

        # 顶部操作条
        mode = ttk.Frame(tab, padding=6)
        mode.pack(fill="x")
        ttk.Label(mode, text="私聊消息涉及用户隐私，本工具不提供私聊管理。",
                  foreground="#999").pack(side="left")
        self.delete_media_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(mode, text="删除消息时连带删除关联媒体文件",
                        variable=self.delete_media_var).pack(side="right")

        # 公聊过滤区
        self.pub_bar = ttk.Frame(tab, padding=6)
        ttk.Label(self.pub_bar, text="按发送者（UID/昵称）：").pack(side="left")
        self.pub_sender = tk.StringVar()
        ttk.Entry(self.pub_bar, textvariable=self.pub_sender, width=14).pack(side="left", padx=4)
        ttk.Label(self.pub_bar, text="关键词：").pack(side="left")
        self.pub_kw = tk.StringVar()
        ttk.Entry(self.pub_bar, textvariable=self.pub_kw, width=20).pack(side="left", padx=4)
        ttk.Button(self.pub_bar, text="搜索", command=self.refresh_public).pack(side="left", padx=6)
        ttk.Button(self.pub_bar, text="删除选中", command=self.on_delete_public_selected).pack(side="left")
        ttk.Button(self.pub_bar, text="删除筛选结果", command=self.on_delete_public_filtered).pack(side="left", padx=4)

        self.pub_bar.pack(fill="x")

        cols = ("time", "sender", "kind", "preview", "id")
        self.msg_tree = ttk.Treeview(tab, columns=cols, show="headings", selectmode="extended")
        heads = {"time": ("时间", 140), "sender": ("发送者", 120), "kind": ("类型", 50),
                 "preview": ("内容", 400), "id": ("消息ID", 190)}
        for c, (t, w) in heads.items():
            self.msg_tree.heading(c, text=t)
            self.msg_tree.column(c, width=w, anchor="w")
        self.msg_tree.pack(fill="both", expand=True, padx=6, pady=(0, 6))

        self.msg_count = tk.StringVar(value="")
        ttk.Label(tab, textvariable=self.msg_count).pack(anchor="w", padx=8, pady=(0, 4))

    def _build_media_tab(self):
        tab = ttk.Frame(self.nb)
        self.nb.add(tab, text="群文件")

        bar = ttk.Frame(tab, padding=6)
        bar.pack(fill="x")
        ttk.Label(bar, text="范围：").pack(side="left")
        self.media_prefix = tk.StringVar(value=next(iter(Store.MEDIA_PREFIXES)))
        combo = ttk.Combobox(bar, textvariable=self.media_prefix, width=40, state="readonly",
                             values=list(Store.MEDIA_PREFIXES))
        combo.pack(side="left", padx=4)
        ttk.Label(bar, text="名称过滤：").pack(side="left")
        self.media_kw = tk.StringVar()
        ttk.Entry(bar, textvariable=self.media_kw, width=18).pack(side="left", padx=4)
        ttk.Button(bar, text="刷新", command=self.refresh_media).pack(side="left", padx=6)
        ttk.Button(bar, text="删除选中", command=self.on_delete_media_selected).pack(side="left")
        ttk.Button(bar, text="清空该范围", command=self.on_clear_media).pack(side="left", padx=4)

        cols = ("name", "size", "time", "key")
        self.media_tree = ttk.Treeview(tab, columns=cols, show="headings", selectmode="extended")
        heads = {"name": ("名称", 260), "size": ("大小", 90), "time": ("上传时间", 150),
                 "key": ("对象 Key", 420)}
        for c, (t, w) in heads.items():
            self.media_tree.heading(c, text=t)
            self.media_tree.column(c, width=w, anchor="w")
        self.media_tree.pack(fill="both", expand=True, padx=6, pady=(0, 6))

        self.media_count = tk.StringVar(value="")
        ttk.Label(tab, textvariable=self.media_count).pack(anchor="w", padx=8, pady=(0, 4))

    # ---------------- 后台执行 ----------------

    def _bg(self, task, done):
        """在后台线程执行 task()，完成后由主线程回调 done(result, error)。
        后台线程不直接触碰 tkinter，只向队列投递结果，主线程定时轮询。"""
        if self.busy:
            self.log("已有任务在执行，请稍候…")
            return
        self.busy = True
        self.root.config(cursor="watch")

        def wrap():
            err, result = None, None
            try:
                result = task()
            except Exception as e:
                err = e
            self._queue.put((done, result, err))

        threading.Thread(target=wrap, daemon=True).start()
        self._poll_queue()

    def _poll_queue(self):
        try:
            while True:
                done, result, err = self._queue.get_nowait()
                self._bg_done(done, result, err)
        except queue.Empty:
            pass
        if self.busy:
            self.root.after(100, self._poll_queue)

    def _bg_done(self, done, result, err):
        self.busy = False
        self.root.config(cursor="")
        if err:
            self.log(f"错误：{err}")
            return
        done(result)

    # ---------------- 日志 ----------------

    def log(self, msg):
        self.log_text.config(state="normal")
        self.log_text.insert("end", f"[{time.strftime('%H:%M:%S')}] {msg}\n")
        self.log_text.see("end")
        self.log_text.config(state="disabled")

    def confirm(self, msg):
        return tk.messagebox.askyesno("确认操作", msg, parent=self.root)

    # ---------------- 用户管理 ----------------

    def refresh_users(self):
        self._bg(lambda: self.store.list_users(refresh=True), self._render_users)

    def _apply_user_filter(self):
        """按搜索词重新渲染用户列表"""
        self._render_users(self._all_users)

    def _fmt_restrictions(self, user):
        """将生效限制格式化为可读文本"""
        acts = self.store.active_restriction_names(user)
        if not acts:
            return ""
        parts = []
        for name, until in acts.items():
            label = Store.RESTRICTION_LABELS.get(name, name)
            parts.append(f"{label}~{fmt_until(until)}" if until else label)
        return "；".join(parts)

    def _render_users(self, users):
        self._all_users = users
        q = self.user_search.get().strip().lower()
        self.user_tree.delete(*self.user_tree.get_children())
        shown = 0
        for u in users:
            if q and q not in f"{u.get('uid')} {u.get('username', '')}".lower():
                continue
            shown += 1
            role = "智能体" if u.get("role") == "agent" else ("管理员" if u.get("role") == "admin" else "用户")
            status = "已封禁" if u.get("banned") else "正常"
            self.user_tree.insert("", "end", iid=str(u.get("uid")), values=(
                u.get("uid"), u.get("username", ""), role, status,
                self._fmt_restrictions(u),
                fmt_time(u.get("created_at")), fmt_time(u.get("last_login_at"))))
        self.log(f"用户列表已加载：{len(users)} 个账户，显示 {shown} 个")

    def _selected_uids(self):
        out = []
        for iid in self.user_tree.selection():
            uid = self.user_tree.item(iid, "values")[0]
            try:
                out.append(int(uid))
            except (ValueError, IndexError):
                pass
        return out

    def on_restrict(self):
        uids = self._selected_uids()
        if not uids:
            self.log("请先选择用户")
            return
        # 取第一个选中用户的当前限制作为初始勾选（多选时保持一致并提示）
        cur = {}
        u = self.store.get_user(uids[0])
        if u:
            cur = self.store.active_restriction_names(u)
        dlg = tk.Toplevel(self.root)
        dlg.title(f"限制操作（{len(uids)} 个用户）")
        dlg.transient(self.root)
        dlg.grab_set()
        dlg.resizable(False, False)

        if len(uids) > 1:
            ttk.Label(dlg, text=f"将应用于选中的 {len(uids)} 个用户", foreground="#c33").grid(
                row=0, column=0, columnspan=2, sticky="w", padx=10, pady=(8, 0))
        row = 1
        check_vars = {}
        for name, label in Store.RESTRICTION_LABELS.items():
            v = tk.BooleanVar(value=name in cur)
            ttk.Checkbutton(dlg, text=label, variable=v).grid(
                row=row, column=0, columnspan=2, sticky="w", padx=14)
            check_vars[name] = v
            row += 1

        ttk.Label(dlg, text="解封时间（本地时间，留空=永久）：").grid(
            row=row, column=0, columnspan=2, sticky="w", padx=10, pady=(10, 0))
        until_var = tk.StringVar()
        if cur:
            # 预填最早的解封时间作为参考
            times = [u for u in cur.values() if u]
            if times:
                until_var.set(fmt_until(min(times)))
        ttk.Entry(dlg, textvariable=until_var, width=26).grid(
            row=row + 1, column=0, columnspan=2, sticky="w", padx=10)
        ttk.Label(dlg, text="格式：YYYY-MM-DD HH:MM 或 YYYY-MM-DD HH:MM:SS", foreground="#999").grid(
            row=row + 2, column=0, columnspan=2, sticky="w", padx=10)

        btns = ttk.Frame(dlg)
        btns.grid(row=row + 3, column=0, columnspan=2, pady=10)

        def save():
            items = {name: v.get() for name, v in check_vars.items()}
            if not any(items.values()):
                if not self.confirm("未勾选任何限制项，继续将清除全部限制，是否继续？"):
                    return
            until_raw = until_var.get().strip()
            until = ""
            if until_raw:
                dt = parse_local_dt(until_raw)
                if dt is None:
                    tk.messagebox.showwarning("格式错误", "解封时间格式应为 YYYY-MM-DD HH:MM 或 YYYY-MM-DD HH:MM:SS", parent=dlg)
                    return
                if dt <= datetime.now():
                    tk.messagebox.showwarning("时间错误", "解封时间必须晚于当前时间", parent=dlg)
                    return
                until = to_utc_iso(dt)
            dlg.destroy()
            self._bg(lambda: [self.store.set_restrictions(u, items, until) for u in uids],
                     lambda r: self._after_restrict(uids))

        ttk.Button(btns, text="保存", command=save).pack(side="left", padx=4)
        ttk.Button(btns, text="取消", command=dlg.destroy).pack(side="left", padx=4)

    def _after_restrict(self, uids):
        self.log(f"已更新 {len(uids)} 个用户的限制")
        self.refresh_users()

    def on_unrestrict(self):
        uids = self._selected_uids()
        if not uids:
            self.log("请先选择用户")
            return
        if not self.confirm(f"确定解除以下用户的全部限制吗？\nUID: {', '.join(map(str, uids))}"):
            return
        self._bg(lambda: [self.store.clear_restrictions(u) for u in uids],
                 lambda r: self._after_restrict(uids))

    def on_kick(self):
        uids = self._selected_uids()
        if not uids:
            self.log("请先选择用户")
            return
        if not self.confirm(f"强制下线将删除这些用户的全部登录会话，使其立即失效。\nUID: {', '.join(map(str, uids))}\n确定继续？"):
            return
        self._bg(lambda: {u: self.store.kick_user_sessions(u) for u in uids},
                 lambda r: self._after_kick(r))

    def _after_kick(self, result):
        for uid, n in result.items():
            self.log(f"UID {uid}：已清除 {n} 个会话")
        self.refresh_users()

    def on_user_detail(self):
        uids = self._selected_uids()
        if len(uids) != 1:
            self.log("请选择一个用户查看详情")
            return
        self._bg(lambda: self.store.get_user(uids[0]), lambda u: self._show_user_detail(u))

    def _show_user_detail(self, u):
        if not u:
            self.log("用户不存在")
            return
        lines = [
            f"UID：{u.get('uid')}",
            f"昵称：{u.get('username')}",
            f"角色：{u.get('role')}",
            f"封禁：{'是' if u.get('banned') else '否'}",
            f"头像：{u.get('avatar_url') or '-'}",
            f"背景：{u.get('bg_url') or '-'}",
            f"邮箱：{u.get('email') or '-'}",
            f"生日：{u.get('birthday') or '-'}",
            f"简介：{u.get('bio') or '-'}",
            f"标签：{', '.join(u.get('tags') or [])}",
            f"黑名单：{', '.join(map(str, u.get('blocked') or []))}",
            f"注册时间：{fmt_time(u.get('created_at'))}",
            f"最近登录：{fmt_time(u.get('last_login_at'))}",
            f"最近IP：{u.get('last_login_ip') or '-'}",
        ]
        tk.messagebox.showinfo("用户详情", "\n".join(lines), parent=self.root)

    # ---------------- 消息管理 ----------------

    def refresh_public(self):
        self._bg(lambda: self.store.list_public_messages(), self._render_public)

    def _matches_public(self, msg):
        q_sender = self.pub_sender.get().strip().lower()
        q_kw = self.pub_kw.get().strip().lower()
        if q_sender:
            sender = str(msg.get("sender_uid") or "").lower()
            name = str(msg.get("sender") or "").lower()
            if q_sender not in sender and q_sender not in name:
                return False
        if q_kw:
            text = (msg.get("text") or "").lower()
            if q_kw not in text:
                return False
        return True

    def _render_public(self, msgs):
        self.msg_tree.delete(*self.msg_tree.get_children())
        shown = 0
        for m in msgs:
            if not self._matches_public(m):
                continue
            shown += 1
            self.msg_tree.insert("", "end", iid=str(m.get("id")), values=(
                fmt_time(m.get("created_at")),
                f"{m.get('sender', '')}（{m.get('sender_uid', '-')}）",
                msg_kind(m), msg_preview(m), m.get("id")))
        self.msg_count.set(f"共 {len(msgs)} 条，筛选后 {shown} 条（最多加载 800 条）")

    def on_delete_public_selected(self):
        ids = self.msg_tree.selection()
        if not ids:
            self.log("请先选择要删除的消息")
            return
        self._confirm_delete_public(list(ids), f"确定删除选中的 {len(ids)} 条公聊消息吗？")

    def on_delete_public_filtered(self):
        ids = [self.msg_tree.item(i, "values")[4] for i in self.msg_tree.get_children()]
        if not ids:
            self.log("当前筛选结果为空")
            return
        self._confirm_delete_public(ids, f"确定删除当前筛选出的 {len(ids)} 条公聊消息吗？")

    def _confirm_delete_public(self, ids, prompt):
        if not self.confirm(prompt):
            return
        del_media = self.delete_media_var.get()
        self._bg(lambda: [self.store.delete_public_message(i, del_media) for i in ids],
                 lambda r: self._after_delete_public(ids))

    def _after_delete_public(self, ids):
        self.log(f"已删除 {len(ids)} 条公聊消息")
        self.refresh_public()

    # ---------------- 群文件 ----------------

    def refresh_media(self):
        prefix = self.media_prefix.get()
        self._bg(lambda: self.store.list_media(prefix), self._render_media)

    def _render_media(self, items):
        self.media_tree.delete(*self.media_tree.get_children())
        kw = self.media_kw.get().strip().lower()
        total = 0
        for it in sorted(items, key=lambda x: x.get("last_modified", ""), reverse=True):
            name = it["key"].rsplit("/", 1)[-1]
            if kw and kw not in name.lower():
                continue
            total += 1
            self.media_tree.insert("", "end", iid=it["key"], values=(
                name, fmt_size(it.get("size")), fmt_time(it.get("last_modified")), it["key"]))
        self.media_count.set(f"共 {total} 个对象（范围：{self.media_prefix.get()}）")

    def on_delete_media_selected(self):
        keys = self.media_tree.selection()
        if not keys:
            self.log("请先选择要删除的文件")
            return
        if not self.confirm(f"确定删除选中的 {len(keys)} 个文件吗？\n此操作不可恢复！"):
            return
        self._bg(lambda: [self.store.s3.delete_object(k) for k in keys],
                 lambda r: self._after_delete_media(keys))

    def on_clear_media(self):
        items = [self.media_tree.item(i, "values")[3] for i in self.media_tree.get_children()]
        if not items:
            self.log("当前范围为空")
            return
        if not self.confirm(f"确定清空当前范围（{self.media_prefix.get()}）下的 {len(items)} 个文件吗？\n此操作不可恢复！"):
            return
        self._bg(lambda: [self.store.s3.delete_object(k) for k in items],
                 lambda r: self._after_delete_media(items))

    def _after_delete_media(self, keys):
        self.log(f"已删除 {len(keys)} 个文件")
        self.refresh_media()

    # ---------------- 设置 / 重新连接 ----------------

    def _rebuild_store(self):
        """按当前 cfg 重建 Store，刷新状态栏并重新加载当前标签页数据"""
        self.store = Store(S3Client(self.cfg))
        self.status_label.config(
            text=f"Endpoint: {self.cfg.get('endpoint') or '-'}  "
                 f"Bucket: {self.cfg.get('bucket') or '-'}")
        idx = self.nb.index(self.nb.select())
        if idx == 0:
            self.refresh_users()
        elif idx == 1:
            self.refresh_public()
        else:
            self.refresh_media()

    def on_reconnect(self):
        """直接按当前配置重建连接并刷新数据，不再弹出设置窗口"""
        self.log("正在重新连接…")
        self._rebuild_store()
        self.log("已重新连接。")

    def on_settings(self):
        dlg = tk.Toplevel(self.root)
        dlg.title("设置")
        dlg.transient(self.root)
        dlg.grab_set()
        dlg.resizable(False, False)

        nb = ttk.Notebook(dlg)
        nb.pack(fill="both", expand=True, padx=8, pady=(8, 0))

        # ---- 连接设置页 ----
        page = ttk.Frame(nb, padding=8)
        nb.add(page, text="连接设置")
        fields = [("endpoint", "Endpoint", "如 https://cn-nb1.rains3.com"),
                  ("region", "Region", "如 ap-shanghai，留空默认 us-east-1"),
                  ("bucket", "Bucket", "存储桶名称"),
                  ("access_key", "Access Key", ""),
                  ("secret_key", "Secret Key", ""),
                  ("public_base", "Public Base（可留空）", "公开读域名，如 https://xx.com/bucket")]
        vars_ = {}
        for i, (k, label, hint) in enumerate(fields):
            ttk.Label(page, text=label).grid(row=i, column=0, sticky="w", padx=8, pady=3)
            v = tk.StringVar(value=str(self.cfg.get(k) or ""))
            e = ttk.Entry(page, textvariable=v, width=46,
                          show="*" if k in ("secret_key", "access_key") else "")
            e.grid(row=i, column=1, padx=8, pady=3, sticky="w")
            if hint:
                ttk.Label(page, text=hint, foreground="#999").grid(row=i, column=2, padx=8, sticky="w")
            vars_[k] = v

        # ---- 关于页 ----
        about = ttk.Frame(nb, padding=8)
        nb.add(about, text="关于")
        ttk.Label(about, text="Bell 门铃", font=("", 16, "bold")).pack(anchor="w")
        ttk.Label(about, text="KnockChat 管理工具",
                  foreground="#666").pack(anchor="w", pady=(2, 8))
        about_text = (
            "功能：\n"
            "  · 用户管理：浏览账户、细分限制（禁止登录 / 公聊文字 / 公聊媒体与链接 /\n"
            "     发起新私聊 / 私聊消息 / 修改头像与背景）、定时解封、强制下线\n"
            "  · 消息管理：搜索并删除公聊消息（可选连带删除关联媒体文件）\n"
            "  · 群文件：按前缀浏览与删除媒体对象\n"
            "\n"
            "隐私说明：私聊消息涉及用户隐私，本工具不提供私聊管理。\n"
            "\n"
            "运行：\n"
            "  python bell.py               启动图形界面\n"
            "  python bell.py --selftest    仅测试连接并统计\n"
            "\n"
            "配置：首次使用请点击「设置」填写 S3 连接信息，保存后立即生效；\n"
            "也可直接编辑 BELL/s3-config.json（参考 src-tauri/s3-config.json）。"
        )
        tk.Label(about, text=about_text, justify="left", anchor="w",
                 font=("", 9)).pack(anchor="w")

        def save():
            new = {k: v.get().strip() for k, v in vars_.items()}
            path = os.path.join(SCRIPT_DIR, "s3-config.json")
            save_config(new, path)
            self.cfg.update(new)
            self.cfg["_source"] = path
            dlg.destroy()
            self._rebuild_store()
            self.log(f"配置已保存到 {path} 并立即生效。")

        btns = ttk.Frame(dlg)
        btns.pack(fill="x", padx=8, pady=8)
        ttk.Button(btns, text="取消", command=dlg.destroy).pack(side="right")
        ttk.Button(btns, text="保存", command=save).pack(side="right", padx=4)

        dlg.update_idletasks()
        w = dlg.winfo_width()
        h = dlg.winfo_height()
        x = self.root.winfo_x() + (self.root.winfo_width() - w) // 2
        y = self.root.winfo_y() + (self.root.winfo_height() - h) // 2
        dlg.geometry(f"+{x}+{y}")


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def selftest(cfg):
    """不启动 GUI，仅验证连接并统计数据量"""
    s3 = S3Client(cfg)
    if not s3.is_configured():
        print("S3 未配置。请提供 s3-config.json 或使用 --config 指定。")
        return 1
    store = Store(s3)
    print(f"Endpoint : {s3.endpoint}")
    print(f"Bucket   : {s3.bucket}")
    print("连接测试中…")
    t0 = time.time()
    users = store.list_users(refresh=True)
    print(f"用户账户        : {len(users)}  （耗时 {time.time()-t0:.1f}s）")
    for u in users[:20]:
        rs = "、".join(Store.RESTRICTION_LABELS.get(n, n) for n in store.active_restriction_names(u)) or "无"
        print(f"  UID {u.get('uid')}  {u.get('username')}  role={u.get('role')}  "
              f"banned={u.get('banned')}  限制: {rs}  created={fmt_time(u.get('created_at'))}")
    if len(users) > 20:
        print(f"  … 其余 {len(users)-20} 个略")
    pm = store.list_public_messages()
    print(f"公聊消息        : {len(pm)} 条（最新 {len(pm)} 条内）")
    for p in Store.MEDIA_PREFIXES:
        items = store.list_media(p)
        total = sum(i.get("size", 0) for i in items)
        print(f"  媒体 {p} : {len(items)} 个对象，{fmt_size(total)}")
    print("自测通过")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Bell 门铃")
    parser.add_argument("--config", help="指定 s3-config.json 路径")
    parser.add_argument("--selftest", action="store_true", help="仅测试连接并统计，不启动 GUI")
    args = parser.parse_args()

    cfg = load_config(args.config)
    if args.selftest:
        raise SystemExit(selftest(cfg))

    root = tk.Tk()
    store = Store(S3Client(cfg))
    App(root, cfg, store)
    root.mainloop()


if __name__ == "__main__":
    main()
