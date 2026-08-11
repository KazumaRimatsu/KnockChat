#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KnockChat 管理工具（BELL）
==========================
基于 Python + tkinter 的 KnockChat 服务端管理工具，通过 Cloudflare Worker 管理 API 访问数据
（不再直连云存储：S3 凭证只存在于 Worker Secret 环境变量，BELL 仅持有 API 地址与管理密钥）。

功能：
  1. 用户管理：浏览用户、细分限制（登录/公聊文字/公聊媒体链接/新私聊/私聊消息/改头像背景）、
     定时解封、强制下线（清除会话）、查看详情
  2. 群文件：按前缀浏览媒体对象（群文件/私聊附件/头像/背景/表情），删除选中或清空
     （v100：公聊已移除，群媒体位于 groups/<gid>/files/，私聊消息涉及用户隐私，本工具不提供私聊管理。）

数据存储结构（v100 目录式，详见 docs/s3-config-guide.md）：
  users/<uid>/info.json        用户资料
                               banned=true 完全封禁（登录限制）
                               restrictions.<name> = {enabled, until} 细分限制
                               until 为 ISO-8601 到期时间，后端到期自动解封（懒清除）
  users/<uid>/friends.json     好友列表（含好友分组）；users/<uid>/groups.json 用户群索引
  users/_index.json            { username: uid } 统一索引
  users/_meta.json             { next_uid }
  sessions/<token>.json        登录会话
  groups/<gid>/info.json       群聊基础信息；groups/_meta.json
  groups/<gid>/members.json    群成员表
  groups/<gid>/messages/<id>.json 群消息（id 即时间序）
  groups/<gid>/files/          群文件（每群 ≤256MB）
  invites/<uid>/groups.json    群邀请列表（收发双向同文件）
  invites/<uid>/friends.json   好友申请列表（收发双向同文件）
  private/<sid>.json           私聊会话（sid = 较小uid__较大uid）
  private/<sid>/messages/<id>.json 私聊消息
  private/<sid>/files/         私聊附件（每会话 ≤32MB）
  resrc/usr_ava/、usr_bkg/、group_ava/  用户头像/主页背景/群头像
  media/emoji/                 用户表情（v100 保留历史前缀）


运行：python bell.py            （图形界面）
      python bell.py --selftest  （仅测试连接并统计，不启动 GUI）
"""

import argparse
import base64
import json
import os
import queue
import re
import threading
import time
import tkinter as tk
import tkinter.filedialog
import tkinter.messagebox
from datetime import datetime, timezone
from tkinter import ttk

import requests

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def default_config_paths():
    """配置查找顺序：BELL/api-config.json → BELL/s3-config.json（旧版直连配置，仅作迁移提示）"""
    return [
        os.path.join(SCRIPT_DIR, "api-config.json"),
        os.path.join(SCRIPT_DIR, "s3-config.json"),
    ]


def load_config(path=None):
    """加载 Worker API 配置；找不到时返回含空字段的 dict"""
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
    return {"api_url": "", "admin_key": "", "_source": ""}


def save_config(cfg, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Worker API 客户端（经 Cloudflare Worker /admin/rpc 调用管理接口）
# ---------------------------------------------------------------------------

class AdminClient:
    """BELL 不再直连 S3：云存储凭证只存在于 Worker Secret 环境变量，
    本工具仅通过 Worker 管理 API 访问（每个请求携带管理密钥鉴权）。"""

    def __init__(self, cfg: dict):
        self.api_url = (cfg.get("api_url") or "").rstrip("/")
        self.admin_key = cfg.get("admin_key") or ""

    def is_configured(self) -> bool:
        return bool(self.api_url and self.admin_key)

    def rpc(self, name: str, params: dict = None, timeout: int = 600):
        """调用 POST /admin/rpc {name, params}，返回 data；失败抛出 RuntimeError"""
        if not self.is_configured():
            raise RuntimeError("Worker API 未配置：请点击「设置」填写 API 地址与管理密钥")
        try:
            resp = requests.post(
                f"{self.api_url}/admin/rpc",
                json={"name": name, "params": params or {}},
                headers={"Authorization": "Bearer " + self.admin_key},
                timeout=(15, timeout))
            body = resp.json()
        except requests.RequestException as e:
            raise RuntimeError(f"无法连接 Worker API（{self.api_url}）：{e}")
        except ValueError:
            raise RuntimeError(f"Worker API 响应非 JSON（HTTP {resp.status_code}）")
        if body.get("ok"):
            return body.get("data")
        msg = (body.get("error") or {}).get("message") or f"HTTP {resp.status_code}"
        raise RuntimeError(msg)

    def status(self):
        """GET /admin/status 连通性自检"""
        try:
            resp = requests.get(
                f"{self.api_url}/admin/status",
                headers={"Authorization": "Bearer " + self.admin_key},
                timeout=15)
            body = resp.json()
        except Exception as e:
            raise RuntimeError(f"连接 Worker API 失败：{e}")
        if body.get("ok"):
            return body["data"]
        raise RuntimeError((body.get("error") or {}).get("message") or f"HTTP {resp.status_code}")


# ---------------------------------------------------------------------------
# 业务数据访问层
# ---------------------------------------------------------------------------

class Store:
    """业务数据访问层：所有操作经 Worker 管理 API（AdminClient）完成，不再直连云存储。"""

    def __init__(self, client: AdminClient):
        self.s3 = client  # 保留旧属性名（App 中 store.s3.is_configured() 仍可用）
        self._user_cache = {}  # uid -> user dict

    def is_configured(self):
        return self.s3.is_configured()

    def rpc(self, name, params=None):
        return self.s3.rpc(name, params)

    # ---- 用户 ----

    def list_users(self, refresh=False):
        """返回用户 dict 列表（按 uid 排序）"""
        if self._user_cache and not refresh:
            return list(self._user_cache.values())
        data = self.rpc("list_users", {"limit": 20000, "offset": 0})
        users = data.get("users") or []
        self._user_cache = {u.get("uid"): u for u in users}
        return users

    def get_user(self, uid):
        if uid in self._user_cache:
            return self._user_cache[uid]
        data = self.rpc("get_user", {"uid": uid})
        user = data.get("user")
        if user:
            self._user_cache[uid] = user
        return user

    def get_user_by_name(self, name):
        data = self.rpc("get_user_by_name", {"username": name})
        return data.get("user")

    def save_user(self, user):
        self.rpc("save_user", {"user": user})
        uid = user.get("uid", 0)
        self._user_cache[uid] = user

    def kick_user_sessions(self, uid):
        """强制下线：删除该 uid 的全部登录会话，返回删除数量"""
        data = self.rpc("kick_user_sessions", {"uid": uid})
        return data.get("deleted", 0)

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
        勾选"登录"时服务端同步置 banned=true，限制全清时恢复 banned=false。"""
        if not self.get_user(uid):
            raise RuntimeError(f"用户 {uid} 不存在")
        self.rpc("set_restrictions", {"uid": uid, "items": items, "until": until})
        # 刷新缓存（服务端已同步 banned 与限制）
        self._user_cache.pop(uid, None)
        return self.get_user(uid)

    def clear_restrictions(self, uid):
        """解除全部限制（含 banned）"""
        if not self.get_user(uid):
            raise RuntimeError(f"用户 {uid} 不存在")
        self.rpc("clear_restrictions", {"uid": uid})
        self._user_cache.pop(uid, None)
        return self.get_user(uid)

    # ---- 媒体 ----

    MEDIA_PREFIXES = {
        "群文件（groups/<gid>/files/）": ["groups/"],
        "私聊附件（private/<sid>/files/）": ["private/"],
        "用户头像（resrc/usr_ava/）": ["resrc/usr_ava/"],
        "主页背景（resrc/usr_bkg/）": ["resrc/usr_bkg/"],
        "群头像（resrc/group_ava/）": ["resrc/group_ava/"],
        "表情（media/emoji/）": ["media/emoji/"],
    }

    def list_media(self, prefix):
        """列出前缀下全部媒体对象（prefix 为下拉框显示文本，服务端统一映射为真实前缀）"""
        return self.rpc("list_media", {"prefix": prefix}) or []

    def delete_media(self, keys):
        """批量删除媒体对象（服务端校验新结构媒体前缀，防误删非媒体对象）"""
        data = self.rpc("delete_media", {"keys": list(keys)})
        return data.get("deleted", 0)

    # ---- 更新推送（客户端「检查更新」从 upd/latest.json 读取） ----

    def get_update_info(self):
        """读取更新元数据；不存在返回 None"""
        data = self.rpc("get_update_info", {})
        return data.get("update")

    def publish_update(self, version, filepath, notes=""):
        """推送更新包：安装包 base64 经管理 API 上传（服务端写入元数据并自动清理旧版本）。
        返回 (安装包 key, 元数据 dict)。"""
        with open(filepath, "rb") as f:
            data = f.read()
        b64 = base64.b64encode(data).decode("ascii")
        res = self.rpc("publish_update", {
            "version": int(version),
            "base64": b64,
            "filename": os.path.basename(filepath),
            "notes": notes,
        })
        return res.get("key"), res.get("meta")


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
        if store.is_configured():
            self.log("Worker API 已配置，点击各面板的「刷新」加载数据。")
        else:
            self.log("Worker API 未配置：点击右上角「设置」填写 API 地址与管理密钥。")

    # ---------------- UI 构建 ----------------

    def _build_ui(self):
        self.root.title("Bell 门铃")
        self.root.geometry("1180x760")

        top = ttk.Frame(self.root, padding=(8, 6))
        top.pack(fill="x")
        self.status_label = ttk.Label(
            top,
            text=f"API: {self.cfg.get('api_url') or '-'}",
            foreground="#666")
        self.status_label.pack(side="left")
        ttk.Button(top, text="设置…", command=self.on_settings).pack(side="right")
        ttk.Button(top, text="重新连接", command=self.on_reconnect).pack(side="right", padx=4)

        self.nb = ttk.Notebook(self.root)
        self.nb.pack(fill="both", expand=True, padx=8, pady=4)
        self._build_users_tab()
        self._build_media_tab()
        self._build_update_tab()

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

    def _build_update_tab(self):
        """更新管理：查看当前推送版本、推送新安装包（客户端「检查更新」从 upd/latest.json 读取）"""
        tab = ttk.Frame(self.nb)
        self.nb.add(tab, text="更新管理")

        # 当前推送信息
        info = ttk.Frame(tab, padding=6)
        info.pack(fill="x")
        ttk.Button(info, text="刷新", command=self.refresh_update_info).pack(side="right")
        self.update_info_var = tk.StringVar(value="尚未读取更新信息，点击「刷新」")
        ttk.Label(info, textvariable=self.update_info_var, foreground="#666",
                  wraplength=880, justify="left").pack(side="left", fill="x", expand=True)

        # 推送表单
        form = ttk.LabelFrame(tab, text="推送更新包", padding=8)
        form.pack(fill="x", padx=6, pady=6)

        row1 = ttk.Frame(form)
        row1.pack(fill="x", pady=2)
        ttk.Label(row1, text="版本号（整数）：").pack(side="left")
        self.upd_version = tk.StringVar()
        ttk.Entry(row1, textvariable=self.upd_version, width=10).pack(side="left", padx=4)
        ttk.Label(row1, text="如：89（与客户端 constants.js 的 KERNEL_VERSION 对应）",
                  foreground="#999").pack(side="left")

        row2 = ttk.Frame(form)
        row2.pack(fill="x", pady=2)
        ttk.Label(row2, text="安装包：").pack(side="left")
        self.upd_file = tk.StringVar()
        ttk.Entry(row2, textvariable=self.upd_file, width=56).pack(side="left", padx=4)
        ttk.Button(row2, text="浏览…", command=self._pick_update_file).pack(side="left")

        ttk.Label(form, text="更新说明：").pack(anchor="w", pady=(4, 0))
        self.upd_notes = tk.Text(form, height=5, width=80)
        self.upd_notes.pack(fill="x", pady=(2, 4))

        ttk.Button(form, text="推送到存储桶", command=self.on_publish_update).pack(anchor="w")
        ttk.Label(form, text="提示：客户端在「关于」页点击「检查更新」即可看到新版本并下载安装包。",
                  foreground="#999").pack(anchor="w", pady=(4, 0))

    def _pick_update_file(self):
        path = tkinter.filedialog.askopenfilename(
            title="选择安装包",
            filetypes=[("安装包", "*.exe *.msi *.zip"), ("所有文件", "*.*")])
        if path:
            self.upd_file.set(path)

    def refresh_update_info(self):
        self._bg(lambda: self.store.get_update_info(), self._after_update_info)

    def _after_update_info(self, info):
        if not info:
            self.update_info_var.set("存储桶中暂无更新元数据（upd/latest.json 不存在），可直接推送新版本。")
            return
        ver = info.get("version", 0)
        sha = info.get("sha256") or "-"
        try:
            ver = int(ver)
        except (TypeError, ValueError):
            ver = 0
        self.update_info_var.set(
            f"当前推送：v{ver:03d} | 文件：{info.get('filename') or '-'} | "
            f"大小：{fmt_size(info.get('size') or 0)} | 发布时间：{fmt_time(info.get('published_at') or '')} | "
            f"SHA256：{sha[:16]}…")

    def on_publish_update(self):
        ver_text = self.upd_version.get().strip()
        path = self.upd_file.get().strip()
        notes = self.upd_notes.get("1.0", "end").strip()
        if not ver_text.isdigit():
            tkinter.messagebox.showwarning("提示", "版本号必须为整数（与客户端 KERNEL_VERSION 一致）")
            return
        if not path or not os.path.isfile(path):
            tkinter.messagebox.showwarning("提示", "请先选择有效的安装包文件")
            return
        version = int(ver_text)
        ext = os.path.splitext(path)[1] or ""
        new_name = f"KnockChat_v{version:03d}{ext}"
        if not self.confirm(f"确认推送更新包 v{version:03d}？\n"
                            f"安装包将自动命名为：{new_name}\n"
                            f"推送后仅保留最新 3 个版本，更旧的安装包会被自动删除。\n"
                            f"客户端「检查更新」即可看到并下载。"):
            return
        self._bg(lambda: self.store.publish_update(version, path, notes),
                 self._after_publish_update)

    def _after_publish_update(self, result):
        key, meta = result
        self.log(f"更新包已推送：{key}（v{meta['version']:03d}）")
        self.update_info_var.set(f"推送成功：v{meta['version']:03d}，文件 {meta['filename']}")
        # 推送成功后清空表单，便于下次输入
        self.upd_version.set("")
        self.upd_file.set("")
        self.upd_notes.delete("1.0", "end")
        self.refresh_update_info()

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
            f"登录地区：{u.get('last_login_region') or '-'}",
        ]
        tk.messagebox.showinfo("用户详情", "\n".join(lines), parent=self.root)

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
        self._bg(lambda: self.store.delete_media(keys),
                 lambda r: self._after_delete_media(keys))

    def on_clear_media(self):
        items = [self.media_tree.item(i, "values")[3] for i in self.media_tree.get_children()]
        if not items:
            self.log("当前范围为空")
            return
        if not self.confirm(f"确定清空当前范围（{self.media_prefix.get()}）下的 {len(items)} 个文件吗？\n此操作不可恢复！"):
            return
        self._bg(lambda: self.store.delete_media(items),
                 lambda r: self._after_delete_media(items))

    def _after_delete_media(self, keys):
        self.log(f"已删除 {len(keys)} 个文件")
        self.refresh_media()

    # ---------------- 设置 / 重新连接 ----------------

    def _rebuild_store(self):
        """按当前 cfg 重建 Store，刷新状态栏并重新加载当前标签页数据"""
        self.store = Store(AdminClient(self.cfg))
        self.status_label.config(
            text=f"API: {self.cfg.get('api_url') or '-'}")
        idx = self.nb.index(self.nb.select())
        if idx == 0:
            self.refresh_users()
        elif idx == 1:
            self.refresh_media()
        else:
            self.refresh_update_info()

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
        fields = [("api_url", "Worker API 地址", "如 https://knockchat-api.xxx.workers.dev"),
                  ("admin_key", "管理密钥", "与 Worker 的 ADMIN_KEY Secret 一致")]
        vars_ = {}
        for i, (k, label, hint) in enumerate(fields):
            ttk.Label(page, text=label).grid(row=i, column=0, sticky="w", padx=8, pady=3)
            v = tk.StringVar(value=str(self.cfg.get(k) or ""))
            e = ttk.Entry(page, textvariable=v, width=46,
                          show="*" if k == "admin_key" else "")
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
            "  · 群文件：按前缀浏览与删除媒体对象（群文件 / 私聊附件 / 头像 / 背景）\n"
            "\n"
            "隐私说明：私聊消息涉及用户隐私，本工具不提供私聊管理。\n"
            "\n"
            "运行：\n"
            "  python bell.py               启动图形界面\n"
            "  python bell.py --selftest    仅测试连接并统计\n"
            "\n"
            "配置：首次使用请点击「设置」填写 Worker API 地址与管理密钥，保存后立即生效；\n"
            "也可直接编辑 BELL/api-config.json。\n"
            "说明：本工具经 Cloudflare Worker 管理 API 访问数据，不持有任何云存储凭证。"
        )
        tk.Label(about, text=about_text, justify="left", anchor="w",
                 font=("", 9)).pack(anchor="w")

        def save():
            new = {k: v.get().strip() for k, v in vars_.items()}
            path = os.path.join(SCRIPT_DIR, "api-config.json")
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
    """不启动 GUI，仅验证 Worker API 连接并统计数据量"""
    client = AdminClient(cfg)
    if not client.is_configured():
        print("Worker API 未配置。请提供 api-config.json 或使用 --config 指定。")
        return 1
    store = Store(client)
    print(f"API : {client.api_url}")
    print("连接测试中…")
    t0 = time.time()
    try:
        st = client.status()
    except RuntimeError as e:
        print(f"连接失败：{e}")
        return 1
    print(f"服务端 : {st.get('endpoint')}  bucket={st.get('bucket')}  "
          f"server_time={st.get('server_time')}  （耗时 {time.time()-t0:.1f}s）")
    users = store.list_users(refresh=True)
    print(f"用户账户        : {len(users)}  （耗时 {time.time()-t0:.1f}s）")
    for u in users[:20]:
        rs = "、".join(Store.RESTRICTION_LABELS.get(n, n) for n in store.active_restriction_names(u)) or "无"
        print(f"  UID {u.get('uid')}  {u.get('username')}  role={u.get('role')}  "
              f"banned={u.get('banned')}  限制: {rs}  created={fmt_time(u.get('created_at'))}")
    if len(users) > 20:
        print(f"  … 其余 {len(users)-20} 个略")
    for p in Store.MEDIA_PREFIXES:
        items = store.list_media(p)
        total = sum(i.get("size", 0) for i in items)
        print(f"  媒体 {p} : {len(items)} 个对象，{fmt_size(total)}")
    print("自测通过")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Bell 门铃")
    parser.add_argument("--config", help="指定 api-config.json 路径")
    parser.add_argument("--selftest", action="store_true", help="仅测试连接并统计，不启动 GUI")
    args = parser.parse_args()

    cfg = load_config(args.config)
    if args.selftest:
        raise SystemExit(selftest(cfg))

    root = tk.Tk()
    store = Store(AdminClient(cfg))
    App(root, cfg, store)
    root.mainloop()


if __name__ == "__main__":
    main()
