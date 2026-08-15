#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OneBot 11 ↔ Milky 本地兼容层（gateway）

让基于 OneBot 11 协议的机器人框架（如 Bot）
无需改造即可直接接入 KnockChat 的 Milky 协议后端：

    OneBot 客户端
      │  ① POST /send_group_msg ...  → 本网关 :5700（伪装 OneBot API 实现端）
      │  ② 事件上报 POST /  ◄── 本网关 → 监听服务器 :5701
      ▼
    本网关（onebot_gateway）
      │  ③ POST https://…/bot/api/{endpoint}   （转发 API 调用到 Milky）
      │  ④ WSS wss://…/bot/event               （订阅 Milky 实时事件）
      ▼
    KnockChat Milky 服务端（LockAPI Worker）

依赖：pip install websocket-client pyyaml

注意：机器人的
    api.host/port 与本网关 onebot.api_host/api_port 一致，
    server.host/port 与本网关 onebot.event_host/event_port 一致
"""

import base64
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 强制 IPv4：本机网络无 IPv6 路由，而 getaddrinfo 默认 IPv6 优先，
# 会导致 websocket/HTTP 先尝试 IPv6 连接挂死（Windows 下表现为 WinError 10060）。
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_only_getaddrinfo(*args, **kwargs):
    return [r for r in _orig_getaddrinfo(*args, **kwargs) if r[0] == socket.AF_INET]


socket.getaddrinfo = _ipv4_only_getaddrinfo

# ==================== 配置 ====================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.yml")

DEFAULT_CONFIG = """\
#兼容层配置
milky:
  base_url: "https://api.cika-meow.top"   # KnockChat Worker 地址（结尾不带 /）
  uid: 12                                 # 机器人 uid
  login_key: ""                           # 机器人 login_key

onebot:
  api_host: "127.0.0.1"   # 本网关监听地址：接收机器人 API 调用
  api_port: 5700
  event_host: "127.0.0.1" # 监听服务器地址：本网关向其 POST 事件上报
  event_port: 5701

heartbeat:
  interval: 30            # 心跳上报间隔（秒）
"""


def load_config():
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            f.write(DEFAULT_CONFIG)
        print(f"已生成默认配置文件：{CONFIG_PATH}，请填写 milky.uid / milky.login_key 后重新运行")
    try:
        import yaml
    except ImportError:
        print("缺少依赖 pyyaml，请先执行：pip install pyyaml")
        raise SystemExit(1)
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


CFG = load_config()
MILKY = CFG.get("milky", {})
ONEBOT = CFG.get("onebot", {})
HEARTBEAT_INTERVAL = int(CFG.get("heartbeat", {}).get("interval", 30))

BASE_URL = str(MILKY.get("base_url", "")).rstrip("/")
UID = int(MILKY.get("uid", 0))
LOGIN_KEY = str(MILKY.get("login_key", ""))
TOKEN = f"{UID}.{LOGIN_KEY}"
API_BASE = f"{BASE_URL}/bot/api"

API_HOST = str(ONEBOT.get("api_host", "127.0.0.1"))
API_PORT = int(ONEBOT.get("api_port", 5700))
EVENT_HOST = str(ONEBOT.get("event_host", "127.0.0.1"))
EVENT_PORT = int(ONEBOT.get("event_port", 5701))

# 浏览器 UA：Cloudflare Bot Fight Mode 会屏蔽 Python-urllib 等已知机器人 UA（返回 403）
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


class MilkyError(Exception):
    """Milky 协议返回的业务错误。"""


def call(endpoint, body=None):
    """调用一个 Milky API，成功返回 data 字段，失败抛出 MilkyError。"""
    url = f"{API_BASE}/{endpoint}"
    payload = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("User-Agent", USER_AGENT)

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            result = json.loads(e.read().decode("utf-8"))
        except Exception:
            raise MilkyError(f"HTTP {e.code}") from e

    if result.get("status") != "ok":
        raise MilkyError(result.get("message", "未知错误"))
    return result.get("data")


# ==================== 消息 id 映射（Milky message_seq ↔ OneBot int message_id） ====================
class MsgIndex:
    def __init__(self):
        self.lock = threading.Lock()
        self.by_id = {}       # int message_id -> {scene, peer, seq}
        self.friend_req = {}  # friend_request flag(request_id) -> 发起者 uid

    def add(self, seq, scene, peer):
        mid = seq_to_id(seq)
        with self.lock:
            self.by_id[mid] = {"scene": scene, "peer": int(peer or 0), "seq": str(seq)}
        return mid

    def get(self, mid):
        with self.lock:
            return self.by_id.get(int(mid))

    def remember_friend_req(self, flag, initiator_uid):
        with self.lock:
            self.friend_req[str(flag)] = int(initiator_uid)

    def initiator_of(self, flag):
        with self.lock:
            return self.friend_req.get(str(flag))


def seq_to_id(seq):
    """Milky 的 message_seq 是十六进制时间序 id → 转成 OneBot 的 int message_id（稳定可逆）。"""
    try:
        return int(str(seq), 16)
    except (ValueError, TypeError):
        return abs(hash(str(seq)))


def id_to_seq(mid):
    """int message_id → Milky message_seq（仅当它是本网关生成/记录的十六进制 id 时可逆）。"""
    try:
        s = format(int(mid), "x")
        if seq_to_id(s) == int(mid):
            return s
    except (ValueError, TypeError):
        pass
    return str(mid)


# ==================== 消息段转换 ====================
def normalize_media_uri(file):
    """OneBot 的 file（URL / base64:// / 本地路径）→ Milky 的 uri（只接受 http(s):// 与 base64://）。"""
    file = str(file or "").strip()
    if not file:
        return ""
    if file.startswith("http://") or file.startswith("https://") or file.startswith("base64://"):
        return file
    if file.startswith("file://"):
        file = file[len("file://"):].lstrip("/")
    try:
        with open(file, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        return "base64://" + b64
    except OSError:
        return file  # 本地文件不存在时原样传递（可能是服务端已有的 file id）


def onebot_segments_to_milky(message):
    """OneBot CQ 段数组 → Milky OutgoingSegment[]。"""
    if isinstance(message, str):
        return [{"type": "text", "data": {"text": message}}]
    out = []
    for s in message or []:
        if not isinstance(s, dict):
            continue
        t = s.get("type")
        d = s.get("data") or {}
        if t == "text":
            out.append({"type": "text", "data": {"text": str(d.get("text", ""))}})
        elif t == "at":
            qq = str(d.get("qq", ""))
            if qq in ("all", "0"):
                out.append({"type": "mention_all", "data": {}})
            else:
                out.append({"type": "mention", "data": {"user_id": qq}})
        elif t == "face":
            out.append({"type": "face", "data": {"id": str(d.get("id", ""))}})
        elif t == "image":
            out.append({"type": "image", "data": {"uri": normalize_media_uri(d.get("file", d.get("url", "")))}})
        elif t == "record":
            out.append({"type": "record", "data": {"uri": normalize_media_uri(d.get("file", "")), "duration": 0}})
        elif t == "video":
            out.append({"type": "video", "data": {"uri": normalize_media_uri(d.get("file", ""))}})
        elif t == "reply":
            out.append({"type": "reply", "data": {"id": str(d.get("id", ""))}})
        elif t == "forward":
            out.append({"type": "forward", "data": {"id": str(d.get("id", ""))}})
        else:
            # 其余类型（share/music/json/xml/poke 等）Milky 不支持，降级为文本占位
            out.append({"type": "text", "data": {"text": f"[{t}]"}})
    if not out:
        out.append({"type": "text", "data": {"text": ""}})
    return out


def cq_encode(text):
    return str(text).replace("&", "&amp;").replace("[", "&#91;").replace("]", "&#93;")


def milky_segments_to_onebot(segments):
    """Milky IncomingMessage.segments → OneBot CQ 段数组。"""
    out = []
    for s in segments or []:
        t = s.get("type")
        d = s.get("data") or {}
        if t == "text":
            out.append({"type": "text", "data": {"text": str(d.get("text", ""))}})
        elif t == "mention":
            out.append({"type": "at", "data": {"qq": str(d.get("user_id", ""))}})
        elif t == "mention_all":
            out.append({"type": "at", "data": {"qq": "all"}})
        elif t == "face":
            out.append({"type": "face", "data": {"id": str(d.get("id", ""))}})
        elif t == "image":
            url = str(d.get("url", ""))
            out.append({"type": "image", "data": {"file": url, "url": url}})
        elif t == "record":
            out.append({"type": "record", "data": {"file": str(d.get("url", ""))}})
        elif t == "video":
            out.append({"type": "video", "data": {"file": str(d.get("url", ""))}})
        elif t == "reply":
            out.append({"type": "reply", "data": {"id": str(d.get("id", ""))}})
        elif t == "file":
            out.append({"type": "file", "data": {"file": str(d.get("url", "")), "name": str(d.get("name", "")), "size": str(d.get("size", ""))}})
        elif t == "forward":
            out.append({"type": "forward", "data": {"id": str(d.get("id", ""))}})
        elif t == "light_app":
            out.append({"type": "json", "data": {"data": str(d.get("content", ""))}})
        else:
            out.append({"type": "text", "data": {"text": f"[{t}]"}})
    return out


def segments_to_raw(segments):
    """CQ 段数组 → raw_message 纯文本 CQ 码字符串。"""
    raw = ""
    for s in segments:
        t = s.get("type")
        d = s.get("data") or {}
        if t == "text":
            raw += cq_encode(d.get("text", ""))
        elif t == "at":
            qq = str(d.get("qq", ""))
            raw += f"[CQ:at,qq={cq_encode(qq)}]"
        elif t == "image":
            raw += f"[CQ:image,file={cq_encode(d.get('file', ''))}]"
        elif t == "record":
            raw += f"[CQ:record,file={cq_encode(d.get('file', ''))}]"
        elif t == "video":
            raw += f"[CQ:video,file={cq_encode(d.get('file', ''))}]"
        elif t == "reply":
            raw += f"[CQ:reply,id={cq_encode(d.get('id', ''))}]"
        elif t == "face":
            raw += f"[CQ:face,id={cq_encode(d.get('id', ''))}]"
        else:
            raw += cq_encode(d.get("text", f"[{t}]"))
    return raw


def num(b, k):
    v = b.get(k)
    if isinstance(v, bool):
        return 0
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


MSG_INDEX = MsgIndex()

# ==================== OneBot API → Milky 转发 ====================
def api_dispatch(action, body):
    a = action.strip("/")

    if a == "send_private_msg":
        uid_ = num(body, "user_id")
        if not uid_:
            raise MilkyError("缺少 user_id")
        r = call("send_private_message", {"user_id": uid_, "message": onebot_segments_to_milky(body.get("message"))})
        seq = str(r.get("message_seq", ""))
        return {"message_id": MSG_INDEX.add(seq, "friend", uid_) if seq else 0}

    if a == "send_group_msg":
        gid = num(body, "group_id")
        if not gid:
            raise MilkyError("缺少 group_id")
        r = call("send_group_message", {"group_id": gid, "message": onebot_segments_to_milky(body.get("message"))})
        seq = str(r.get("message_seq", ""))
        return {"message_id": MSG_INDEX.add(seq, "group", gid) if seq else 0}

    if a == "send_msg":
        if num(body, "user_id") > 0:
            return api_dispatch("send_private_msg", body)
        if num(body, "group_id") > 0:
            return api_dispatch("send_group_msg", body)
        raise MilkyError("user_id 与 group_id 均为空")

    if a == "delete_msg":
        mid = num(body, "message_id")
        info = MSG_INDEX.get(mid)
        if not info:
            raise MilkyError(f"未知的 message_id: {mid}")
        if info["scene"] == "group":
            call("recall_group_message", {"group_id": info["peer"], "message_seq": info["seq"]})
        else:
            call("recall_private_message", {"user_id": info["peer"], "message_seq": info["seq"]})
        return {}

    if a == "get_msg":
        mid = num(body, "message_id")
        info = MSG_INDEX.get(mid)
        if not info:
            raise MilkyError(f"未知的 message_id: {mid}")
        r = call("get_message", {"message_scene": info["scene"], "peer_id": info["peer"], "message_seq": info["seq"]})
        m = r.get("message") or {}
        segments = milky_segments_to_onebot(m.get("segments"))
        return {
            "time": num(m, "time") or int(time.time()),
            "message_type": info["scene"],
            "message_id": mid,
            "real_id": mid,
            "sender": {"user_id": num(m, "sender_id"), "nickname": str(m.get("sender_name", ""))},
            "message": segments,
            "raw_message": segments_to_raw(segments),
        }

    if a == "get_forward_msg":
        return {"message": []}

    if a == "send_like":
        return {}  # Milky 无点赞接口，静默成功

    if a == "set_group_kick":
        call("kick_group_member", {"group_id": num(body, "group_id"), "user_id": num(body, "user_id")})
        return {}

    if a == "set_group_ban":
        call("set_group_member_mute", {
            "group_id": num(body, "group_id"),
            "user_id": num(body, "user_id"),
            "duration": num(body, "duration"),
        })
        return {}

    if a == "set_group_anonymous_ban":
        return {}

    if a == "set_group_whole_ban":
        call("set_group_whole_mute", {"group_id": num(body, "group_id"), "is_mute": bool(body.get("enable"))})
        return {}

    if a == "set_group_admin":
        return {}  # Milky 无群管理接口

    if a == "set_group_card":
        return {}  # Milky 无群名片接口

    if a == "set_group_name":
        call("set_group_name", {"group_id": num(body, "group_id"), "new_group_name": str(body.get("group_name", ""))})
        return {}

    if a == "set_group_leave":
        call("quit_group", {"group_id": num(body, "group_id")})
        return {}

    if a == "set_group_special_title":
        return {}

    if a == "set_friend_add_request":
        flag = str(body.get("flag", ""))
        approve = bool(body.get("approve", True))
        initiator = MSG_INDEX.initiator_of(flag) or flag
        endpoint = "accept_friend_request" if approve else "reject_friend_request"
        call(endpoint, {"initiator_uid": str(initiator)})
        return {}

    if a == "set_group_add_request":
        # Milky 侧的群邀请事件 flag 即 invite_id（invitation_seq）
        invite_id = str(body.get("flag", ""))
        approve = bool(body.get("approve", True))
        endpoint = "accept_group_invitation" if approve else "reject_group_invitation"
        call(endpoint, {"invitation_seq": invite_id})
        return {}

    if a == "get_login_info":
        r = call("get_login_info")
        return {"user_id": num(r, "uin") or UID, "nickname": str(r.get("nickname", ""))}

    if a == "get_stranger_info":
        r = call("get_user_profile", {"user_id": num(body, "user_id")})
        return {"user_id": num(body, "user_id"), "nickname": str(r.get("nickname", "")), "sex": "unknown", "age": 0}

    if a == "get_friend_list":
        r = call("get_friend_list")
        return [{"user_id": f.get("user_id"), "nickname": f.get("nickname"), "remark": f.get("remark", "")}
                for f in r.get("friends", [])]

    if a == "get_group_info":
        r = call("get_group_info", {"group_id": num(body, "group_id")})
        g = r.get("group") or {}
        return {"group_id": g.get("group_id", 0), "group_name": g.get("group_name", ""),
                "member_count": g.get("member_count", 0), "max_member_count": g.get("max_member_count", 0),
                "remark": g.get("remark", "")}

    if a == "get_group_list":
        r = call("get_group_list")
        return [{"group_id": g.get("group_id", 0), "group_name": g.get("group_name", ""),
                 "member_count": g.get("member_count", 0), "max_member_count": g.get("max_member_count", 0),
                 "remark": g.get("remark", "")} for g in r.get("groups", [])]

    if a == "get_group_member_info":
        r = call("get_group_member_info", {"group_id": num(body, "group_id"), "user_id": num(body, "user_id")})
        m = r.get("member") or {}
        return {"user_id": m.get("user_id", 0), "nickname": m.get("nickname", ""), "sex": "unknown",
                "group_id": m.get("group_id", 0), "card": m.get("card", ""), "title": m.get("title", ""),
                "level": m.get("level", 0), "role": m.get("role", "member"), "join_time": m.get("join_time", 0),
                "last_sent_time": m.get("last_sent_time", 0), "shut_up_end_time": m.get("shut_up_end_time")}

    if a == "get_group_member_list":
        r = call("get_group_member_list", {"group_id": num(body, "group_id")})
        return r.get("members", [])

    if a == "get_group_honor_info":
        return {"group_honor_info": {"talkative_list": [], "performer_list": [], "legend_list": [],
                                     "strong_newbie_list": [], "emotion_list": []}}

    if a == "get_cookies":
        return {}
    if a == "get_csrf_token":
        return {"token": ""}
    if a == "get_credentials":
        return {}
    if a == "get_record":
        return {}
    if a == "get_image":
        return {}
    if a == "can_send_image":
        return {"yes": True}
    if a == "can_send_record":
        return {"yes": True}

    if a == "get_status":
        return {"online": True, "good": True}

    if a == "get_version_info":
        r = call("get_impl_info")
        return {"app_name": r.get("impl_name", "KnockChat"), "app_version": r.get("impl_version", "0.0.0"),
                "protocol_version": "v11", "protocol_name": "Milky"}

    if a == "set_restart":
        return {}  # 网关常驻：重启无意义，静默成功

    if a == "clean_cache":
        return {}

    raise MilkyError(f"不支持的 OneBot API: /{a}")


def handle_action(action, body):
    try:
        data = api_dispatch(action, body)
        return 200, {"status": "ok", "retcode": 0, "data": data if data is not None else {}}
    except MilkyError as e:
        return 200, {"status": "failed", "retcode": 1, "message": str(e)}
    except Exception as e:
        return 200, {"status": "failed", "retcode": 1, "message": f"网关内部错误: {e!r}"}


# ==================== OneBot API HTTP 服务器（伪 OneBot 实现端 :5700） ====================
def make_api_server(host, port):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def _respond_json(self, obj, status=200):
            payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                body = json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                body = {}
            action = self.path.split("?")[0].rstrip("/")
            print(f"[API] {action} {json.dumps(body, ensure_ascii=False)}")
            status, resp = handle_action(action, body)
            self._respond_json(resp, status)

        def do_GET(self):
            self._respond_json({"status": "ok", "retcode": 0, "data": {}})

        do_HEAD = do_GET

    return ThreadingHTTPServer((host, port), Handler)


# ==================== Milky 事件 → OneBot 上报 ====================
def report_event(ev):
    """把 OneBot 事件上报 JSON POST 给 Bot 的监听服务器（:5701）。"""
    payload = json.dumps(ev, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"http://{EVENT_HOST}:{EVENT_PORT}/", data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", USER_AGENT)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except Exception as e:
        print(f"[上报失败] 无法送达 Bot ({EVENT_HOST}:{EVENT_PORT})：{e}")


def base_event(frame):
    data = frame.get("data") or {}
    return {
        "time": int(frame.get("time") or data.get("time") or time.time()),
        "self_id": int(frame.get("self_id") or UID),
    }


def build_message_event(frame):
    ev = base_event(frame)
    data = frame.get("data") or {}
    scene = data.get("message_scene")
    seq = str(data.get("message_seq", ""))
    mid = MSG_INDEX.add(seq, scene, data.get("peer_id", 0)) if seq else 0
    segments = milky_segments_to_onebot(data.get("segments"))
    sender_id = num(data, "sender_id")
    sender = {"user_id": sender_id, "nickname": str(data.get("sender_name", "")), "sex": "unknown", "age": 0,
              "card": "", "role": str(data.get("sender_role", "member"))}
    ev.update({
        "post_type": "message",
        "message_type": scene,
        "sub_type": "normal" if scene == "group" else "friend",
        "message_id": mid,
        "message": segments,
        "raw_message": segments_to_raw(segments),
        "user_id": sender_id,
        "sender": sender,
        "font": 0,
    })
    if scene == "group":
        ev["group_id"] = num(data, "peer_id")
    return ev


def build_notice_event(frame):
    ev = base_event(frame)
    data = frame.get("data") or {}
    et = frame.get("event_type")

    if et == "message_recall":
        if "group_id" in data:
            ev.update({"post_type": "notice", "notice_type": "group_recall",
                       "group_id": num(data, "group_id"), "user_id": num(data, "operator_id"),
                       "operator_id": num(data, "operator_id"), "message_id": seq_to_id(data.get("message_seq", ""))})
        else:
            ev.update({"post_type": "notice", "notice_type": "friend_recall",
                       "user_id": num(data, "peer_id"), "message_id": seq_to_id(data.get("message_seq", ""))})
        return ev

    if et == "group_file_upload":
        f = data.get("file") or {}
        ev.update({"post_type": "notice", "notice_type": "group_upload", "group_id": num(data, "group_id"),
                   "user_id": num(data, "operator_id"),
                   "file": {"id": str(f.get("id", "")), "name": str(f.get("name", "")),
                            "size": num(f, "size"), "busid": 0, "url": str(f.get("url", ""))}})
        return ev

    if et == "group_member_increase":
        uid_ = num(data, "user_id")
        ev.update({"post_type": "notice", "notice_type": "group_increase", "group_id": num(data, "group_id"),
                   "user_id": uid_, "operator_id": uid_, "sub_type": "invite"})
        return ev

    if et == "group_member_decrease":
        uid_ = num(data, "user_id")
        ev.update({"post_type": "notice", "notice_type": "group_decrease", "group_id": num(data, "group_id"),
                   "user_id": uid_, "operator_id": uid_, "sub_type": "leave"})
        return ev

    if et == "group_mute":
        duration = num(data, "duration")
        ev.update({"post_type": "notice", "notice_type": "group_ban", "group_id": num(data, "group_id"),
                   "user_id": num(data, "user_id"), "operator_id": num(data, "operator_id"),
                   "duration": duration, "sub_type": "ban" if duration > 0 else "lift_ban"})
        return ev

    if et == "group_whole_mute":
        duration = num(data, "duration")
        op = num(data, "operator_id")
        ev.update({"post_type": "notice", "notice_type": "group_ban", "group_id": num(data, "group_id"),
                   "user_id": op, "operator_id": op, "duration": duration,
                   "sub_type": "ban" if duration > 0 else "lift_ban"})
        return ev

    if et == "group_nudge":
        ev.update({"post_type": "notice", "notice_type": "notify", "sub_type": "poke",
                   "group_id": num(data, "group_id"), "user_id": num(data, "from_user_id"),
                   "target_id": num(data, "user_id")})
        return ev

    return None  # 无法映射的 notice，忽略


def build_request_event(frame):
    ev = base_event(frame)
    data = frame.get("data") or {}
    et = frame.get("event_type")

    if et == "friend_request":
        flag = str(data.get("request_id", ""))
        MSG_INDEX.remember_friend_req(flag, num(data, "user_id"))
        ev.update({"post_type": "request", "request_type": "friend", "user_id": num(data, "user_id"),
                   "comment": str(data.get("comment", "")), "flag": flag})
        return ev

    if et == "group_invitation":
        ev.update({"post_type": "request", "request_type": "group", "sub_type": "invite",
                   "group_id": num(data, "group_id"), "user_id": num(data, "inviter_id"),
                   "comment": str(data.get("message", "")), "flag": str(data.get("invite_id", ""))})
        return ev

    return None


def on_milky_frame(frame):
    """Milky 事件帧 {event_type, time, self_id, data} → OneBot 事件 → 上报 Bot。"""
    # 用户协议广播帧（presence/online_count/read 等）不是机器人事件
    if "type" in frame:
        return
    et = frame.get("event_type")
    if et == "message_receive":
        ev = build_message_event(frame)
        print(f"[事件] message {frame.get('data', {}).get('message_scene')} "
              f"{frame.get('data', {}).get('sender_name')}({frame.get('data', {}).get('sender_id')}) -> "
              f"{frame.get('data', {}).get('peer_id')}")
    elif et in ("message_recall", "group_file_upload", "group_member_increase", "group_member_decrease",
                "group_mute", "group_whole_mute", "group_nudge"):
        ev = build_notice_event(frame)
    elif et in ("friend_request", "group_invitation"):
        ev = build_request_event(frame)
    else:
        print(f"[事件] 忽略未映射的 Milky 事件: {et} {json.dumps(frame, ensure_ascii=False)}")
        return

    if ev is None:
        return
    report_event(ev)


def heartbeat_loop():
    """周期向 Bot 上报 OneBot 心跳包（meta_event heartbeat），防止其触发自动重启。"""
    while True:
        time.sleep(HEARTBEAT_INTERVAL)
        report_event({"time": int(time.time()), "self_id": UID, "post_type": "meta_event",
                      "meta_event_type": "heartbeat", "status": {"online": True, "good": True},
                      "interval": HEARTBEAT_INTERVAL * 1000})


# ==================== 主流程 ====================
def run():
    try:
        import websocket  # websocket-client
    except ImportError:
        print("缺少依赖 websocket-client，请先执行：pip install websocket-client")
        return

    # 启动 OneBot API 服务器（接收 Bot 的 API 调用）
    try:
        api_server = make_api_server(API_HOST, API_PORT)
    except OSError as e:
        print(f"无法监听 {API_HOST}:{API_PORT}：{e}")
        return
    threading.Thread(target=api_server.serve_forever, daemon=True).start()
    print(f"[网关] OneBot API 服务已启动：http://{API_HOST}:{API_PORT}/ （Bot config 的 api.host/port 需指向此处）")
    print(f"[网关] 事件上报目标：http://{EVENT_HOST}:{EVENT_PORT}/ （Bot config 的 server.host/port 需指向此处）")

    threading.Thread(target=heartbeat_loop, daemon=True).start()

    # 订阅 Milky 实时事件
    ws_base = BASE_URL.replace("https://", "wss://").replace("http://", "ws://")
    ws_url = f"{ws_base}/bot/event?access_token={TOKEN}"

    # 应用层心跳：服务端只凭应用层消息刷新存活时间（90s 无消息判掉线），必须发 JSON 心跳
    _ws_ref = [None]
    _last_recv = [0.0]

    def on_message(ws, message):
        _last_recv[0] = time.time()
        try:
            frame = json.loads(message)
        except json.JSONDecodeError:
            print(f"[原始帧] {message}")
            return
        try:
            on_milky_frame(frame)
        except Exception as e:
            print(f"[处理失败] {e!r}")

    def on_pong(ws, message):
        _last_recv[0] = time.time()

    def on_error(ws, error):
        print(f"[连接错误] {error}")

    def on_close(ws, close_status_code, close_msg):
        _ws_ref[0] = None
        print(f"[连接关闭] {close_status_code} {close_msg}")

    def on_open(ws):
        _ws_ref[0] = ws
        _last_recv[0] = time.time()
        print("[已连接] Milky 事件流已接通")
        # OneBot lifecycle connect 元事件
        report_event({"time": int(time.time()), "self_id": UID, "post_type": "meta_event",
                      "meta_event_type": "lifecycle", "sub_type": "connect"})

    def ws_heartbeat():
        while True:
            time.sleep(10)
            ws = _ws_ref[0]
            if ws is None:
                continue
            try:
                ws.send('{"type":"ping"}')
            except Exception:
                pass

    threading.Thread(target=ws_heartbeat, daemon=True).start()

    print(f"[网关] 连接 Milky 事件流 {ws_url}")
    while True:
        ws = websocket.WebSocketApp(
            ws_url,
            header=["User-Agent: " + USER_AGENT],
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
            on_pong=on_pong,
        )
        ws.run_forever(ping_interval=30, ping_timeout=10)
        print("连接断开，5 秒后重连…")
        time.sleep(5)


if __name__ == "__main__":
    # 先验证 Milky 登录信息
    try:
        info = call("get_login_info")
        print(f"登录成功：uin={info.get('uin')} nickname={info.get('nickname')}")
    except MilkyError as e:
        print(f"登录失败：{e}")
        raise SystemExit(1)
    run()
