#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KnockChat 清除全部聊天消息工具
=============================
一次性清空所有群聊/私聊的消息与附件（v101 contents 协议迁移、压测、演示重置等场景使用），
仅删除「聊天内容」，保留用户体系与群/会话骨架：

删除范围：
  groups/<gid>/messages/*.json   群聊消息
  groups/<gid>/files/*           群文件（每群 ≤256MB）
  groups/<gid>/image/*           群聊图片
  groups/<gid>/voice/*           群聊语音
  private/<sid>.json             私聊会话记录（含 last_message 等）
  private/<sid>/messages/*.json  私聊消息
  private/<sid>/files/*          私聊附件（图片/语音/文件）

保留范围（一概不动）：
  users/、sessions/、invites/、resrc/、media/、upd/、groups/_meta.json、
  groups/<gid>/info.json、groups/<gid>/members.json

附带处理：
  - 清空群聊消息后重置 groups/<gid>/info.json 中与消息相关的字段
    （last_message / last_message_at / last_message_sender_uid），
    使成员未读判定自动归零（后端以 last_message_at 为空判断无未读）；
  - 私聊会话记录整体删除（前端首条新消息时会自动重建会话）。

安全说明：
  - 默认 dry-run：仅枚举对象、按群/会话汇总统计并导出备份清单，不写存储桶；
  - 加 --yes 才真正执行删除（先落盘备份清单，再分批删除，每批 ≤1000）；
  - 全程可重复执行（幂等）：再次运行时未发现对象即直接结束；
  - 只碰上方删除范围内的前缀，其余对象一律不处理。

配置（读取 BELL/s3-config.json，可用 --config 覆盖，同 migrate_structure.py）：
  {
    "endpoint":   "https://cn-nb1.rains3.com",
    "region":     "us-east-1",
    "bucket":     "knockchat",
    "access_key": "……",
    "secret_key": "……",
    "path_style": true,
    "public_base":"https://cn-nb1.rains3.com/knockchat"
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

# 群媒体子前缀（目录式结构，见 migrate_structure.py 头部说明）
GROUP_CHAT_SUBPREFIXES = ("messages/", "files/", "image/", "voice/")
# 私聊会话记录：private/<sid>.json（sid 为 两 UID 下划线连接，如 1__2）
PRIV_SESSION_RX = re.compile(r"^private/(\d+__\d+)\.json$")
# 私聊消息/附件：private/<sid>/messages/、private/<sid>/files/
PRIV_CHILD_RX = re.compile(r"^private/(\d+__\d+)/(messages|files)/")
# 群目录：groups/<gid>/...（gid 为纯数字，排除 groups/_meta.json 等）
GROUP_DIR_RX = re.compile(r"^groups/(\d+)/")


# ---------------------------------------------------------------------------
# 配置 / 客户端（与 migrate_structure.py 保持一致）
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
    return resp["Body"].read()


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
# 清除聊天消息
# ---------------------------------------------------------------------------


def _collect_chat_objects(client, cfg):
    """枚举删除范围内的全部对象，返回汇总结构。

    返回：
      groups: {gid: {subprefix: [obj,...]}}  群聊天对象（messages/files/image/voice）
      priv_sessions: [obj,...]               私聊会话记录 private/<sid>.json
      priv_chats: {sid: {subprefix: [obj,...]}}  私聊消息/附件
    """
    bucket = cfg["bucket"]
    groups = {}
    priv_sessions = []
    priv_chats = {}

    # ---- 群：先枚举 groups/ 发现 gid，再按媒体子前缀收集 ----
    try:
        group_objs = list_all(client, bucket, "groups/")
    except ClientError as e:
        print(f"错误：列出 groups/ 失败：{e}")
        sys.exit(1)
    gids = []
    for o in group_objs:
        m = GROUP_DIR_RX.match(o["Key"])
        if m and m.group(1) not in gids:
            gids.append(m.group(1))
    for gid in gids:
        entry = {}
        for sub in GROUP_CHAT_SUBPREFIXES:
            prefix = f"groups/{gid}/{sub}"
            try:
                items = list_all(client, bucket, prefix)
            except ClientError as e:
                print(f"错误：列出 {prefix} 失败：{e}")
                sys.exit(1)
            if items:
                entry[sub] = items
        if entry:
            groups[gid] = entry

    # ---- 私聊：一次枚举 private/ 前缀，按正则分派 ----
    try:
        priv_objs = list_all(client, bucket, "private/")
    except ClientError as e:
        print(f"错误：列出 private/ 失败：{e}")
        sys.exit(1)
    for o in priv_objs:
        key = o["Key"]
        m = PRIV_SESSION_RX.match(key)
        if m:
            priv_sessions.append(o)
            continue
        m = PRIV_CHILD_RX.match(key)
        if m:
            sid, sub = m.group(1), m.group(2)
            priv_chats.setdefault(sid, {}).setdefault(sub + "/", []).append(o)
            continue
        # 其余 private/ 对象（未知结构）不动，仅提示
        print(f"  跳过未知结构对象：{key}")

    return groups, priv_sessions, priv_chats


def _reset_group_info(client, cfg, gids):
    """重置群信息中与消息相关的字段（last_message/last_message_at/last_message_sender_uid）。

    后端判定未读依赖 last_message_at，置空后各成员 has_unread 自动为 false。
    仅在执行模式（--yes）调用。
    """
    bucket = cfg["bucket"]
    for gid in gids:
        key = f"groups/{gid}/info.json"
        try:
            body = get_obj(client, bucket, key)
            info = json.loads(body.decode("utf-8"))
        except Exception:
            continue  # info.json 缺失或损坏则跳过（对象本身不动）
        changed = False
        for field in ("last_message", "last_message_at"):
            if info.get(field):
                info[field] = ""
                changed = True
        if info.get("last_message_sender_uid"):
            info["last_message_sender_uid"] = 0
            changed = True
        if changed:
            info["updated_at"] = datetime.now(timezone.utc).isoformat()
            put_obj(client, bucket, key,
                    json.dumps(info, ensure_ascii=False).encode("utf-8"), "application/json")
            print(f"  已重置 {key} 的消息相关字段")


def _run_clear_messages(client, cfg, backup_dir, do_delete):
    bucket = cfg["bucket"]
    print(f"连接 {cfg['endpoint']}  bucket={bucket}")
    print("模式：清除全部群聊/私聊消息与附件" + ("（dry-run）" if not do_delete else "（执行删除）"))

    groups, priv_sessions, priv_chats = _collect_chat_objects(client, cfg)

    # ---- 汇总打印 ----
    group_keys, priv_keys = [], []
    total_count, total_size = 0, 0
    for gid, entry in sorted(groups.items()):
        subs = ", ".join(f"{sub[:-1]}/{len(items)}" for sub, items in entry.items())
        print(f"  群 {gid}: {subs}")
        for items in entry.values():
            group_keys += [i["Key"] for i in items]
    for sid in sorted(priv_chats):
        entry = priv_chats[sid]
        subs = ", ".join(f"{sub[:-1]}/{len(items)}" for sub, items in entry.items())
        print(f"  私聊 {sid}: {subs}")
        for items in entry.values():
            priv_keys += [i["Key"] for i in items]
    if priv_sessions:
        print(f"  私聊会话记录: {len(priv_sessions)} 个")

    group_count = len(group_keys)
    group_size = sum(i["Size"] for it in groups.values() for v in it.values() for i in v)
    priv_msg_count = len(priv_keys)
    priv_msg_size = sum(i["Size"] for it in priv_chats.values() for v in it.values() for i in v)
    sess_count = len(priv_sessions)
    sess_size = sum(i["Size"] for i in priv_sessions)
    total_count = group_count + priv_msg_count + sess_count
    total_size = group_size + priv_msg_size + sess_size

    print(f"\n合计：{group_count} 个群对象（{fmt_size(group_size)}）+ "
          f"{priv_msg_count} 个私聊消息/附件（{fmt_size(priv_msg_size)}）+ "
          f"{sess_count} 个私聊会话记录（{fmt_size(sess_size)}）= {total_count} 个对象，{fmt_size(total_size)}")

    if total_count == 0:
        print("未发现聊天对象，无需清理。")
        return 0

    # ---- 导出备份清单（先落盘，无论 dry-run 还是执行） ----
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    os.makedirs(backup_dir, exist_ok=True)
    manifest_path = os.path.join(backup_dir, f"clear_messages_manifest_{stamp}.json")
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bucket": bucket,
        "note": "清除全部聊天消息：被删除对象清单（内容不下载，仅记录 key/大小/时间）",
        "executed": do_delete,
        "groups": {gid: {sub[:-1]: [{"key": i["Key"], "size": i["Size"]} for i in items]}
                   for gid, entry in groups.items() for sub, items in entry.items()},
        "private_sessions": [{"key": i["Key"], "size": i["Size"]} for i in priv_sessions],
        "private_chats": {sid: {sub[:-1]: [{"key": i["Key"], "size": i["Size"]} for i in items]}
                          for sid, entry in priv_chats.items() for sub, items in entry.items()},
        "totals": {"group_objects": group_count, "private_chat_objects": priv_msg_count,
                   "private_sessions": sess_count, "total": total_count, "bytes": total_size},
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"备份清单已导出：{manifest_path}（{total_count} 条）")

    if not do_delete:
        print("\ndry-run：未执行删除。确认无误后加 --yes 执行真正删除。")
        return 0

    # ---- 执行删除（先删对象，再重置群信息） ----
    all_keys = group_keys + priv_keys + [i["Key"] for i in priv_sessions]
    try:
        # 按群/会话分组删除，便于失败定位
        deleted = 0
        for gid, entry in sorted(groups.items()):
            keys = [i["Key"] for items in entry.values() for i in items]
            if keys:
                delete_batch(client, bucket, keys)
                deleted += len(keys)
                print(f"  已删除群 {gid} 的 {len(keys)} 个聊天对象")
        for sid in sorted(priv_chats):
            keys = [i["Key"] for items in priv_chats[sid].values() for i in items]
            if keys:
                delete_batch(client, bucket, keys)
                deleted += len(keys)
                print(f"  已删除私聊 {sid} 的 {len(keys)} 个消息/附件")
        if priv_sessions:
            keys = [i["Key"] for i in priv_sessions]
            delete_batch(client, bucket, keys)
            deleted += len(keys)
            print(f"  已删除 {len(keys)} 个私聊会话记录")
        print(f"\n删除完成：共删除 {deleted} 个对象")
    except (BotoCoreError, ClientError, RuntimeError) as e:
        print(f"错误：删除中止：{e}")
        print("已删除部分保留备份清单，可再次运行本脚本清理剩余对象。")
        return 1

    # 重置群信息中与消息相关的字段（成员未读判定自动归零）
    reset_gids = [gid for gid in groups if any(
        sub in ("messages/", "files/", "image/", "voice/") for sub in groups[gid])]
    if reset_gids:
        print("重置群信息的消息相关字段…")
        _reset_group_info(client, cfg, reset_gids)

    print(f"清理完成：共删除 {total_count} 个聊天对象（清单：{manifest_path}）")
    return 0


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="KnockChat 清除全部聊天消息工具（群聊/私聊消息与附件）")
    parser.add_argument("--config", help="s3-config.json 路径（缺省 BELL/s3-config.json）")
    parser.add_argument("--backup-dir", help="备份清单输出目录（缺省 BELL/backup/）")
    parser.add_argument("--yes", action="store_true",
                        help="确认执行：导出备份清单后真正删除（缺省仅 dry-run）")
    args = parser.parse_args()

    cfg = load_config(args.config)
    client = make_client(cfg)
    backup_dir = args.backup_dir or os.path.join(SCRIPT_DIR, "backup")
    return _run_clear_messages(client, cfg, backup_dir, args.yes)


if __name__ == "__main__":
    raise SystemExit(main())
