#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared client for the MimirLink local debug harness."""
import json
import os
import urllib.request
import urllib.error
import http.cookiejar

INSTANCES = {
    "anon": {"base": "http://127.0.0.1:8001", "user": "admin",
             "config": r"C:\Users\20633\MimirLink\config.json",
             "character": "Anon_Chihaya", "group": "993146337"},
    "soyo": {"base": "http://127.0.0.1:8002", "user": "admin",
             "config": r"C:\Users\20633\MimirLink-soyo\config.json",
             "character": "Soyo_Nagasaki", "group": "993146337"},
}


def panel_password(config_path: str) -> str:
    """面板密码从实例自己的 config.json 读。

    ⚠ 这里以前是硬编码的明文密码。本文件会随 tools/ 一起发布到公开仓库，
    硬编码等于把面板密码送出去（2026-10-11 修）。
    """
    try:
        with open(config_path, encoding="utf-8") as fh:
            return str(json.load(fh).get("auth", {}).get("password") or "")
    except Exception:
        return os.environ.get("MIMIR_PANEL_PASSWORD", "")


def _local_opener():
    """只连本机，**必须显式禁用代理**。

    踩过的坑：环境里设了 http_proxy 时，urllib 会把 127.0.0.1:8002 也丢给代理，
    拿回 `502 upstream connect failed ... os error 10061`，看起来像"面板没起"。
    """
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPCookieProcessor(cj),
    )
    return op, cj


class Client:
    def __init__(self, which):
        cfg = INSTANCES[which]
        self.which = which
        self.base = cfg["base"]
        self.character = cfg["character"]
        self.user = cfg["user"]
        self.pwd = panel_password(cfg["config"])
        self.op, self.cj = _local_opener()

    def post(self, path, payload, timeout=180):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            self.base + path, data=data,
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST")
        try:
            with self.op.open(req, timeout=timeout) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception as e:
            return -1, str(e)

    def get(self, path, timeout=60):
        req = urllib.request.Request(self.base + path, method="GET")
        try:
            with self.op.open(req, timeout=timeout) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception as e:
            return -1, str(e)

    def login(self):
        st, r = self.post("/api/auth/login", {"username": self.user, "password": self.pwd})
        return st == 200 and isinstance(r, dict) and r.get("success")

    def refresh_cards(self):
        return self.post("/api/characters/refresh", {})

    def preview(self, user_message, recent_messages=None, summaries=None,
                group_id=None, user_id="2063362809", message_type="group"):
        payload = {
            "characterName": self.character,
            "userMessage": user_message,
            "messageType": message_type,
            "groupId": group_id or INSTANCES[self.which]["group"],
            "userId": user_id,
            "context": {
                "recentMessages": recent_messages or [],
                "summaries": summaries or [],
            },
            # ⚠ 预览 API 只把 messageType 用在 chatScopeKey 上，**没有传进
            # buildCurrentMessageFocus**（它读 runtimeContext.messageType）。
            # 不显式带上，焦点块会固定写成「事件: message / group」，
            # 于是 意图/策略 判成群聊那套 —— 量出来的风格就不是私聊的真实行为。
            "runtimeContext": {"messageType": message_type},
        }
        return self.post("/api/runtime/prompt-preview", payload)
