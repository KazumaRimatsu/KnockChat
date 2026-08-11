#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KnockChat 存储桶文件结构迁移工具（v100）
========================================
v100 起存储桶收敛为「目录式」结构（详见 docs/s3-config-guide.md 第 2 节）：

新结构：
  users/<uid>/info.json          用户资料（昵称/密码哈希/状态/云设置密文）
  users/<uid>/friends.json       好友列表（含好友分组）
  users/<uid>/groups.json        用户群索引
  users/_index.json、users/_meta.json  用户名→UID 索引、UID 计数器
  sessions/<token code>.json     登录会话
  groups/<gid>/info.json         群聊信息
  groups/<gid>/members.json      群成员表
  groups/<gid>/messages/*.json   群消息
  groups/<gid>/files/*           群文件（每群 ≤256MB，逐文件 ≤8MB）
  groups/_meta.json              GID 计数器
  invites/<uid>/groups.json      群邀请列表（收发双向同文件，未受理）
  invites/<uid>/friends.json     好友申请列表（收发双向同文件，未受理）
  private/<sid>.json             私聊会话
  private/<sid>/messages/*.json  私聊消息
  private/<sid>/files/*          私聊附件（每会话 ≤32MB）
  resrc/usr_ava/、resrc/usr_bkg/、resrc/group_ava/  用户头像/主页背景/群头像
  media/emoji/                   用户表情（v100 保留历史前缀）
  upd/                           应用更新包

旧（扁平）结构 → 新结构迁移对照：
  users/<uid>.json                 → users/<uid>/info.json
  friends/<uid>.json               → users/<uid>/friends.json
  friend_groups/<uid>.json         → 并入 users/<uid>/friends.json（groups 字段）
  groups/by_user/<uid>.json        → users/<uid>/groups.json
  groups/<gid>.json                → groups/<gid>/info.json
  group_members/<gid>.json         → groups/<gid>/members.json
  group_messages/<gid>/<id>.json   → groups/<gid>/messages/<id>.json
  group_invites/<to_uid>/<id>.json → 并入 invites/<to_uid>/groups.json 与 invites/<from_uid>/groups.json
  friend_requests/in/<to>/<id>.json   → 并入 invites/<to>/friends.json
  friend_requests/out/<from>/<id>.json → 并入 invites/<from>/friends.json
  private/sessions/<sid>.json      → private/<sid>.json
  private/messages/<sid>/<id>.json → private/<sid>/messages/<id>.json
  media/avatars/g_*                → resrc/group_ava/（群头像按 g_ 前缀区分）
  media/avatars/*                  → resrc/usr_ava/
  media/background/*               → resrc/usr_bkg/
  media/group/<gid>/*              → groups/<gid>/files/
  media/private/<sid>/*            → private/<sid>/files/

迁移时会对 JSON 中的内嵌媒体 URL（头像/背景/群文件/私聊附件引用）一并改写，
例如 https://.../media/group/12/a.png → https://.../groups/12/files/a.png。

安全说明：
  - 默认 dry-run：仅枚举旧对象、统计并导出「旧→新」备份清单，不写存储桶；
  - 加 --yes 才真正执行：先复制到新 Key（含 URL 改写），全部成功后按批删除旧对象；
  - 全程可重复执行（幂等）：重复迁移时按 id/Key 去重，不会产生重复数据；
  - 只碰下方迁移对照表中的旧前缀，其余对象（sessions/、upd/、media/emoji/ 等）一概不动。

子命令：
  migrate_structure.py                    迁移扁平结构 → v100 目录结构（dry-run）
  migrate_structure.py --yes              确认后执行结构迁移（复制 → 删除旧对象）
  migrate_structure.py clean-public       清理 v099 遗留的公聊数据（public/messages/、media/chat/、media/public/）

配置（读取 BELL/s3-config.json，可用 --config 覆盖）：
  {
    "endpoint":   "https://cn-nb1.rains3.com",   // 私有 S3 API 地址
    "region":     "us-east-1",
    "bucket":     "knockchat",
    "access_key": "……",
    "secret_key": "……",
    "path_style": true,                           // 雨云/对象存储一般为 true
    "public_base":"https://cn-nb1.rains3.com/knockchat"   // 可省略
  }
  配置项缺失时回退读取环境变量 S3_ENDPOINT / S3_REGION / S3_BUCKET /
  S3_ACCESS_KEY / S3_SECRET_KEY / S3_PATH_STYLE。
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone

try:
    import boto3
    from botocore.config import Config as BotoConfig
    from botocore.exceptions import BotoCoreError, ClientError
except ImportError:
    boto3 = None
    BotoCoreError = ClientError = Exception

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------


def load_config(path=None):
    """读取 s3-config.json；缺失字段回退环境变量"""
    cfg_path = path or os.path.join(SCRIPT_DIR, "s3-config.json")
    cfg = {}
    if os.path.isfile(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception as e:
            print(f"警告：读取配置 {cfg_path} 失败（{e}），改用环境变量。")
    cfg = {k: cfg.get(k) for k in (
        "endpoint", "region", "bucket", "access_key", "secret_key", "path_style", "public_base")}
    env_map = {
        "endpoint": "S3_ENDPOINT", "region": "S3_REGION", "bucket": "S3_BUCKET",
        "access_key": "S3_ACCESS_KEY", "secret_key": "S3_SECRET_KEY",
        "path_style": "S3_PATH_STYLE", "public_base": "S3_PUBLIC_BASE",
    }
    for k, env in env_map.items():
        if not cfg.get(k) and os.environ.get(env):
            cfg[k] = os.environ.get(env)
    missing = [k for k in ("endpoint", "bucket", "access_key", "secret_key") if not cfg.get(k)]
    if missing:
        print("错误：缺少必填配置 " + ", ".join(missing))
        print(f"请在 {cfg_path} 中填写，或设置对应环境变量。")
        print("配置示例见本脚本头部说明。")
        sys.exit(1)
    if cfg.get("path_style") in (None, ""):
        cfg["path_style"] = True
    else:
        cfg["path_style"] = str(cfg["path_style"]).lower() in ("1", "true", "yes")
    return cfg


def make_client(cfg):
    """创建 boto3 客户端"""
    if boto3 is None:
        print("错误：需要 boto3（python -m pip install boto3）才能直连存储桶。")
        sys.exit(1)
    session = boto3.session.Session(
        aws_access_key_id=cfg["access_key"],
        aws_secret_access_key=cfg["secret_key"],
        region_name=cfg.get("region") or "us-east-1",
    )
    client = session.client(
        "s3",
        endpoint_url=cfg["endpoint"],
        config=BotoConfig(s3={"addressing_style": "path" if cfg.get("path_style") else "virtual"},
                          signature_version="s3v4"),
    )
    _ensure_delete_md5(client)
    return client


def _ensure_delete_md5(client):
    """雨云等 S3 兼容端点要求 DeleteObjects 请求携带 Content-MD5 头。

    新版 boto3 可通过 delete_objects(ContentMD5='') 触发自动计算，但旧版
    botocore 的 API 模型没有该参数（直接传会报 Unknown parameter）。
    这里统一通过请求事件在签名前按请求体（XML 字节）计算 MD5 并注入该头，
    对全部 boto3/botocore 版本均生效，且请求签名会覆盖该头，兼容性最好。
    """
    import base64
    import hashlib

    def inject_md5(request, **kwargs):
        body = request.body
        if isinstance(body, bytes) and body:
            digest = base64.b64encode(hashlib.md5(body).digest()).decode()
            request.headers["Content-MD5"] = digest

    client.meta.events.register("before-sign.s3.DeleteObjects", inject_md5)


# ---------------------------------------------------------------------------
# S3 基础操作
# ---------------------------------------------------------------------------


def list_all(client, bucket, prefix):
    """分页列出前缀下全部对象，返回 [{Key, Size, LastModified}]"""
    out = []
    kw = {"Bucket": bucket, "Prefix": prefix}
    while True:
        resp = client.list_objects_v2(**kw)
        for o in resp.get("Contents", []):
            out.append({"Key": o["Key"], "Size": o.get("Size", 0),
                        "LastModified": o.get("LastModified")})
        if not resp.get("IsTruncated"):
            break
        kw["ContinuationToken"] = resp.get("NextContinuationToken")
    return out


def get_obj(client, bucket, key):
    resp = client.get_object(Bucket=bucket, Key=key)
    return resp["Body"].read(), resp.get("ContentType") or "application/octet-stream"


def put_obj(client, bucket, key, body, ctype):
    client.put_object(Bucket=bucket, Key=key, Body=body, ContentType=ctype)


def delete_batch(client, bucket, keys):
    """分批删除（每批 ≤1000），失败抛出异常"""
    for i in range(0, len(keys), 1000):
        chunk = keys[i:i + 1000]
        resp = client.delete_objects(
            Bucket=bucket,
            Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": True},
        )
        errors = resp.get("Errors") or []
        if errors:
            raise RuntimeError(f"删除失败 {len(errors)} 个对象，首个错误：{errors[0]}")


def fmt_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024


# ---------------------------------------------------------------------------
# URL 改写（旧媒体路径 → 新目录式路径）
# ---------------------------------------------------------------------------

# 顺序重要：media/avatars/g_*（群头像）必须先于 media/avatars/*（用户头像）处理
URL_REWRITES = [
    (re.compile(r"media/avatars/g_"), "resrc/group_ava/g_"),
    (re.compile(r"media/avatars/"), "resrc/usr_ava/"),
    (re.compile(r"media/background/"), "resrc/usr_bkg/"),
    (re.compile(r"media/group/(\d+)/"), r"groups/\1/files/"),
    (re.compile(r"media/private/(\d+__\d+)/"), r"private/\1/files/"),
]


def rewrite_url(value):
    for rx, rep in URL_REWRITES:
        value = rx.sub(rep, value)
    return value


def rewrite_json(obj):
    """深度改写 JSON 中所有字符串里的旧媒体路径，返回是否发生改写"""
    changed = False
    if isinstance(obj, dict):
        for k, v in list(obj.items()):
            if isinstance(v, str):
                nv = rewrite_url(v)
                if nv != v:
                    obj[k] = nv
                    changed = True
            elif isinstance(v, (dict, list)):
                changed = rewrite_json(v) or changed
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            if isinstance(v, str):
                nv = rewrite_url(v)
                if nv != v:
                    obj[i] = nv
                    changed = True
            elif isinstance(v, (dict, list)):
                changed = rewrite_json(v) or changed
    return changed


# ---------------------------------------------------------------------------
# 结构迁移
# ---------------------------------------------------------------------------


def _json_list(client, bucket, key, field):
    try:
        body, _ = get_obj(client, bucket, key)
        v = json.loads(body.decode("utf-8"))
    except Exception:
        return []
    arr = v.get(field) if isinstance(v, dict) else None
    return arr if isinstance(arr, list) else []


def _save_json_list(client, bucket, key, uid, field, items):
    put_obj(client, bucket, key,
            json.dumps({"uid": uid, field: items}, ensure_ascii=False).encode("utf-8"),
            "application/json")


def _upsert_list(client, bucket, key, uid, field, item):
    """按 id 去重后把对象并入列表文件（幂等，可重复执行）"""
    items = _json_list(client, bucket, key, field)
    if not any(str(x.get("id")) == str(item.get("id")) for x in items):
        items.append(item)
        _save_json_list(client, bucket, key, uid, field, items)
        return True
    return False


def _move_json(client, bucket, from_key, to_key, manifest):
    """复制 JSON 对象（深度改写 URL）并登记迁移记录"""
    body, ctype = get_obj(client, bucket, from_key)
    obj = json.loads(body.decode("utf-8"))
    rewrite_json(obj)
    put_obj(client, bucket, to_key,
            json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json")
    manifest.append({"from": from_key, "to": to_key, "size": len(body), "action": "move"})


def _move_binary(client, bucket, from_key, to_key, manifest):
    """复制二进制对象（原样拷贝）并登记迁移记录"""
    body, ctype = get_obj(client, bucket, from_key)
    put_obj(client, bucket, to_key, body, ctype)
    manifest.append({"from": from_key, "to": to_key, "size": len(body), "action": "move"})


def _run_structure_migration(client, cfg, backup_dir, do_delete):
    bucket = cfg["bucket"]
    print(f"连接 {cfg['endpoint']}  bucket={bucket}")
    print("模式：扁平结构 → v100 目录结构" + ("（dry-run）" if not do_delete else "（执行迁移）"))

    # 1. 枚举旧前缀对象，按正则分派
    collected = {}
    old_prefixes = [
        "users/", "friends/", "friend_groups/", "groups/", "group_members/",
        "group_messages/", "group_invites/", "friend_requests/in/",
        "friend_requests/out/", "private/sessions/", "private/messages/",
        "media/avatars/", "media/background/", "media/group/", "media/private/",
    ]
    for prefix in old_prefixes:
        try:
            items = list_all(client, bucket, prefix)
        except ClientError as e:
            print(f"错误：列出 {prefix} 失败：{e}")
            sys.exit(1)
        collected[prefix] = items
        print(f"  旧前缀 {prefix}: {len(items)} 个对象，{fmt_size(sum(i['Size'] for i in items))}")

    if not any(collected[p] for p in collected):
        print("未发现旧结构对象，无需迁移。")
        return 0

    # 预生成备份清单（含规划映射；dry-run 与执行时均先落盘）
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    os.makedirs(backup_dir, exist_ok=True)
    manifest_path = os.path.join(backup_dir, f"migrate_manifest_{stamp}.json")
    manifest = []  # [{from, to, size, action}]

    # 2. 逐类迁移（写入存储桶）
    ops = []

    def files_of(prefix, pattern):
        rx = re.compile(pattern)
        return [i for i in collected.get(prefix, []) if rx.match(i["Key"])]

    # ---- 用户：users/<uid>.json → users/<uid>/info.json ----
    user_rx = re.compile(r"^users/(\d+)\.json$")
    for i in collected.get("users/", []):
        m = user_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_move_json", i["Key"], f"users/{m.group(1)}/info.json"))

    # ---- 好友：friends/<uid>.json → users/<uid>/friends.json ----
    friends_rx = re.compile(r"^friends/(\d+)\.json$")
    for i in collected.get("friends/", []):
        m = friends_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_move_json", i["Key"], f"users/{m.group(1)}/friends.json"))

    # ---- 好友分组：friend_groups/<uid>.json → 并入 users/<uid>/friends.json ----
    fgroups_rx = re.compile(r"^friend_groups/(\d+)\.json$")
    for i in collected.get("friend_groups/", []):
        m = fgroups_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_merge_friend_groups", i["Key"], m.group(1)))

    # ---- 群索引：groups/by_user/<uid>.json → users/<uid>/groups.json ----
    gbyuser_rx = re.compile(r"^groups/by_user/(\d+)\.json$")
    for i in collected.get("groups/", []):
        m = gbyuser_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_move_json", i["Key"], f"users/{m.group(1)}/groups.json"))

    # ---- 群信息：groups/<gid>.json → groups/<gid>/info.json ----
    ginfo_rx = re.compile(r"^groups/(\d+)\.json$")
    for i in collected.get("groups/", []):
        m = ginfo_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_move_json", i["Key"], f"groups/{m.group(1)}/info.json"))

    # ---- 群成员：group_members/<gid>.json → groups/<gid>/members.json ----
    gmem_rx = re.compile(r"^group_members/(\d+)\.json$")
    for i in collected.get("group_members/", []):
        m = gmem_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_move_json", i["Key"], f"groups/{m.group(1)}/members.json"))

    # ---- 群消息：group_messages/<gid>/<id>.json → groups/<gid>/messages/<id>.json ----
    gmsg_rx = re.compile(r"^group_messages/(\d+)/([^/]+)\.json$")
    for i in collected.get("group_messages/", []):
        m = gmsg_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_move_json", i["Key"], f"groups/{m.group(1)}/messages/{m.group(2)}.json"))

    # ---- 群邀请：group_invites/<to_uid>/<id>.json → 双侧列表文件 ----
    ginv_rx = re.compile(r"^group_invites/(\d+)/([^/]+)\.json$")
    for i in collected.get("group_invites/", []):
        m = ginv_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_merge_group_invite", i["Key"], m.group(1)))

    # ---- 好友申请（入）：friend_requests/in/<to>/<id>.json → invites/<to>/friends.json ----
    fr_in_rx = re.compile(r"^friend_requests/in/(\d+)/([^/]+)\.json$")
    for i in collected.get("friend_requests/in/", []):
        m = fr_in_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_merge_friend_request", i["Key"], m.group(1), "in"))

    # ---- 好友申请（出）：friend_requests/out/<from>/<id>.json → invites/<from>/friends.json ----
    fr_out_rx = re.compile(r"^friend_requests/out/(\d+)/([^/]+)\.json$")
    for i in collected.get("friend_requests/out/", []):
        m = fr_out_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_merge_friend_request", i["Key"], m.group(1), "out"))

    # ---- 私聊会话：private/sessions/<sid>.json → private/<sid>.json ----
    psess_rx = re.compile(r"^private/sessions/([^/]+)\.json$")
    for i in collected.get("private/sessions/", []):
        m = psess_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_move_json", i["Key"], f"private/{m.group(1)}.json"))

    # ---- 私聊消息：private/messages/<sid>/<id>.json → private/<sid>/messages/<id>.json ----
    pmsg_rx = re.compile(r"^private/messages/([^/]+)/([^/]+)\.json$")
    for i in collected.get("private/messages/", []):
        m = pmsg_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_move_json", i["Key"], f"private/{m.group(1)}/messages/{m.group(2)}.json"))

    # ---- 媒体：avatars（g_ 群头像/其他用户头像）、background、group、private ----
    ava_rx = re.compile(r"^media/avatars/(.+)$")
    for i in collected.get("media/avatars/", []):
        m = ava_rx.match(i["Key"])
        if not m:
            continue
        name = m.group(1)
        to = f"resrc/group_ava/{name}" if name.startswith("g_") else f"resrc/usr_ava/{name}"
        ops.append(("_move_binary", i["Key"], to))

    bg_rx = re.compile(r"^media/background/(.+)$")
    for i in collected.get("media/background/", []):
        m = bg_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_move_binary", i["Key"], f"resrc/usr_bkg/{m.group(1)}"))

    gmed_rx = re.compile(r"^media/group/(\d+)/(.+)$")
    for i in collected.get("media/group/", []):
        m = gmed_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_move_binary", i["Key"], f"groups/{m.group(1)}/files/{m.group(2)}"))

    pmed_rx = re.compile(r"^media/private/([^/]+)/(.+)$")
    for i in collected.get("media/private/", []):
        m = pmed_rx.match(i["Key"])
        if not m:
            continue
        ops.append(("_move_binary", i["Key"], f"private/{m.group(1)}/files/{m.group(2)}"))

    # 3. 导出备份清单（先落盘，无论 dry-run 还是执行）
    def _find_size(key):
        for items in collected.values():
            for it in items:
                if it["Key"] == key:
                    return it["Size"]
        return 0

    plan = [{
        "from": o[1], "to": o[2] if len(o) > 2 else "",
        "size": _find_size(o[1]),
    } for o in ops]
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump({
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "bucket": bucket,
            "mode": "flat-to-directory",
            "note": "v100 扁平结构 → 目录式结构迁移规划清单",
            "plan": plan,
            "executed": do_delete,
        }, f, ensure_ascii=False, indent=2)
    print(f"备份清单已导出：{manifest_path}（{len(plan)} 条）")

    if not do_delete:
        print(f"\ndry-run：共规划 {len(ops)} 次复制，未写入存储桶。确认无误后加 --yes 执行。")
        return 0

    # 4. 执行迁移（先复制/合并，全部成功后删除旧对象）
    from_keys = []
    try:
        for op in ops:
            kind = op[0]
            if kind == "_move_json":
                _move_json(client, bucket, op[1], op[2], manifest)
            elif kind == "_move_binary":
                _move_binary(client, bucket, op[1], op[2], manifest)
            elif kind == "_merge_friend_groups":
                body, _ = get_obj(client, bucket, op[1])
                v = json.loads(body.decode("utf-8"))
                groups = v.get("groups", []) if isinstance(v, dict) else []
                target = f"users/{op[2]}/friends.json"
                if groups:
                    try:
                        tbody, _ = get_obj(client, bucket, target)
                        tv = json.loads(tbody.decode("utf-8"))
                    except Exception:
                        tv = {"uid": int(op[2]), "friends": []}
                    tv["groups"] = groups
                    put_obj(client, bucket, target,
                            json.dumps(tv, ensure_ascii=False).encode("utf-8"), "application/json")
                manifest.append({"from": op[1], "to": target, "size": len(body), "action": "merge-groups"})
            elif kind == "_merge_group_invite":
                body, _ = get_obj(client, bucket, op[1])
                inv = json.loads(body.decode("utf-8"))
                rewrite_json(inv)
                from_uid = int(inv.get("from_uid") or 0)
                to_uid = int(inv.get("to_uid") or 0)
                if not to_uid:
                    to_uid = int(op[2])
                for u in {from_uid, to_uid}:
                    if u <= 0:
                        continue
                    if _upsert_list(client, bucket, f"invites/{u}/groups.json", u, "invites", inv):
                        manifest.append({"from": op[1], "to": f"invites/{u}/groups.json",
                                         "size": len(body), "action": "merge-invite"})
            elif kind == "_merge_friend_request":
                body, _ = get_obj(client, bucket, op[1])
                req = json.loads(body.decode("utf-8"))
                rewrite_json(req)
                uid = int(op[2])
                if uid > 0:
                    if _upsert_list(client, bucket, f"invites/{uid}/friends.json", uid, "requests", req):
                        manifest.append({"from": op[1], "to": f"invites/{uid}/friends.json",
                                         "size": len(body), "action": "merge-request"})
            from_keys.append(op[1])
            if len(from_keys) % 100 == 0:
                print(f"  已迁移 {len(from_keys)}/{len(ops)} …")
    except (BotoCoreError, ClientError) as e:
        print(f"错误：迁移中止于 {len(from_keys)}/{len(ops)}：{e}")
        print("旧对象未被删除；请修正后重新执行（幂等，可安全重跑）。")
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump({"generated_at": datetime.now(timezone.utc).isoformat(), "bucket": bucket,
                       "mode": "flat-to-directory", "note": "迁移中止（部分完成）", "plan": plan,
                       "manifest": manifest, "executed": False}, f, ensure_ascii=False, indent=2)
        print(f"中止状态已写入：{manifest_path}")
        return 1

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump({"generated_at": datetime.now(timezone.utc).isoformat(), "bucket": bucket,
                   "mode": "flat-to-directory", "note": "v100 结构迁移（已完成复制）", "plan": plan,
                   "manifest": manifest, "executed": True}, f, ensure_ascii=False, indent=2)
    print(f"复制阶段完成（{len(from_keys)}/{len(ops)}），清单已更新：{manifest_path}")

    # 5. 删除旧对象（--yes 已确认）：仅删除本次实际迁移的 Key，
    #    保留 users/_index.json、users/_meta.json、groups/_meta.json 等元数据文件。
    from_set = set(from_keys)
    by_prefix = {}
    for key in from_set:
        prefix = next((p for p in old_prefixes if key.startswith(p)), None)
        if prefix:
            by_prefix.setdefault(prefix, []).append(key)
    for prefix, keys in by_prefix.items():
        print(f"正在删除旧前缀 {prefix}（{len(keys)} 个）…")
        try:
            delete_batch(client, bucket, keys)
        except (BotoCoreError, ClientError, RuntimeError) as e:
            print(f"错误：删除 {prefix} 失败：{e}")
            print("新结构数据已就位；可再次运行本脚本清理残留旧对象。")
            return 1
    print(f"迁移完成：共迁移 {len(ops)} 个旧对象为 {len(manifest)} 条新记录（清单：{manifest_path}）")
    return 0


# ---------------------------------------------------------------------------
# 公聊清理（v099 遗留）
# ---------------------------------------------------------------------------

OLD_PUBLIC_PREFIXES = {
    "历史公聊消息（public/messages/）": "public/messages/",
    "历史公聊图片（media/chat/）": "media/chat/",
    "历史公聊文件/语音（media/public/）": "media/public/",
}


def _run_clean_public(client, cfg, backup_dir, do_delete):
    bucket = cfg["bucket"]
    print(f"连接 {cfg['endpoint']}  bucket={bucket}")
    found = {}
    for label, prefix in OLD_PUBLIC_PREFIXES.items():
        try:
            items = list_all(client, bucket, prefix)
        except ClientError as e:
            print(f"错误：列出 {prefix} 失败：{e}")
            sys.exit(1)
        found[label] = items
        print(f"  {label} : {len(items)} 个对象，{fmt_size(sum(i['Size'] for i in items))}")

    total_count = sum(len(v) for v in found.values())
    if total_count == 0:
        print("未发现旧公聊对象，无需清理。")
        return 0

    backup_dir = backup_dir or os.path.join(SCRIPT_DIR, "backup")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    manifest_path = os.path.join(backup_dir, f"clean_public_manifest_{stamp}.json")
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bucket": bucket,
        "note": "v100 公聊移除：旧公聊数据对象清单（内容不下载，仅记录 key/大小/时间）",
        "prefixes": {label: prefix for label, prefix in OLD_PUBLIC_PREFIXES.items()},
        "objects": [{"key": i["Key"], "size": i["Size"],
                     "last_modified": str(i["LastModified"]) if i["LastModified"] else ""}
                    for items in found.values() for i in items],
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"备份清单已导出：{manifest_path}（{len(manifest['objects'])} 条）")

    if not do_delete:
        print("\ndry-run：未执行删除。确认无误后加 --yes 执行真正删除。")
        return 0
    for label, items in found.items():
        keys = [i["Key"] for i in items]
        if not keys:
            continue
        print(f"正在删除 {label}（{len(keys)} 个）…")
        try:
            delete_batch(client, bucket, keys)
        except (BotoCoreError, ClientError, RuntimeError) as e:
            print(f"错误：删除 {label} 失败：{e}")
            return 1
    print(f"清理完成：共删除 {total_count} 个旧公聊对象（清单：{manifest_path}）")
    return 0


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="KnockChat v100 存储桶文件结构迁移工具")
    parser.add_argument("mode", nargs="?", default="structure",
                        choices=["structure", "clean-public"],
                        help="structure：扁平结构→v100 目录结构（默认）；clean-public：清理历史公聊数据")
    parser.add_argument("--config", help="s3-config.json 路径（缺省 BELL/s3-config.json）")
    parser.add_argument("--backup-dir", help="备份清单输出目录（缺省 BELL/backup/）")
    parser.add_argument("--yes", action="store_true",
                        help="确认执行：导出备份清单后真正迁移/删除（缺省仅 dry-run）")
    args = parser.parse_args()

    cfg = load_config(args.config)
    client = make_client(cfg)
    backup_dir = args.backup_dir or os.path.join(SCRIPT_DIR, "backup")

    if args.mode == "clean-public":
        return _run_clean_public(client, cfg, backup_dir, args.yes)
    return _run_structure_migration(client, cfg, backup_dir, args.yes)


if __name__ == "__main__":
    raise SystemExit(main())
