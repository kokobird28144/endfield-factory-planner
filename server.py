#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
节点式工厂配平编辑器 —— 零依赖本地后端。

职责：
  1. 托管前端静态资源（web/）与物品图标（data/item_icons/*.webp）。
  2. 提供只读配方接口   GET /api/recipes
  3. 只读特殊配方        GET /api/special-recipes           （与主配方分离、长久有效）
  4. 临时配方读写        GET/PUT /api/temp-recipes          （整表读取/整表覆盖保存）
  5. 配平方案 CRUD       GET/POST/PUT/DELETE /api/plans[/{id}]
  6. 黑盒组件 CRUD       GET/POST/PUT/DELETE /api/components[/{id}]

所有写盘操作使用「临时文件 + 原子替换」，避免写入过程崩溃损坏数据。
所有 id 都经过白名单校验，杜绝目录穿越。

运行：
    python server.py            # 默认 http://127.0.0.1:8770
    python server.py 9000       # 指定端口
"""

import json
import os
import re
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

# ---------------------------------------------------------------------------
# 路径与常量
# ---------------------------------------------------------------------------
ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, "web")
DATA_DIR = os.path.join(ROOT, "data")
ICON_DIR = os.path.join(DATA_DIR, "item_icons")
RECIPES_FILE = os.path.join(DATA_DIR, "recipes", "recipes_industrial.json")
SPECIAL_RECIPES_FILE = os.path.join(DATA_DIR, "recipes", "special_recipes.json")
RUNTIME_DIR = os.path.join(DATA_DIR, "runtime")
TEMP_RECIPES_FILE = os.path.join(RUNTIME_DIR, "temp_recipes.json")
PLANS_DIR = os.path.join(RUNTIME_DIR, "plans")
COMPONENTS_DIR = os.path.join(RUNTIME_DIR, "components")

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".json": "application/json; charset=utf-8",
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".map": "application/json; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def ensure_dirs():
    os.makedirs(PLANS_DIR, exist_ok=True)
    os.makedirs(COMPONENTS_DIR, exist_ok=True)


def read_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def atomic_write_json(path, data):
    """先写临时文件，再原子替换目标文件，避免中途崩溃损坏数据。"""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp_", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise


def valid_id(value):
    return isinstance(value, str) and bool(ID_RE.match(value))


def new_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# ---------------------------------------------------------------------------
# 请求处理
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "ZmdRecipeServer/1.0"

    # -- 基础响应助手 ------------------------------------------------------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status, message):
        self._send_json({"error": message}, status=status)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return None
        raw = self.rfile.read(length)
        try:
            # 用 utf-8-sig 容忍可能的 BOM
            return json.loads(raw.decode("utf-8-sig"))
        except ValueError:
            return _BadBody

    # -- 路由分发 ----------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path.startswith("/api/"):
            return self._api_get(path)
        return self._serve_static(path)

    def do_HEAD(self):
        # 复用 GET 逻辑但不写 body（_send_json / 静态均已按 command 处理）
        return self.do_GET()

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        if path.startswith("/api/"):
            return self._api_write("POST", path)
        return self._error(404, "Not found")

    def do_PUT(self):
        path = unquote(urlparse(self.path).path)
        if path.startswith("/api/"):
            return self._api_write("PUT", path)
        return self._error(404, "Not found")

    def do_DELETE(self):
        path = unquote(urlparse(self.path).path)
        if path.startswith("/api/"):
            return self._api_delete(path)
        return self._error(404, "Not found")

    # -- 静态资源 ----------------------------------------------------------
    def _serve_static(self, path):
        if path == "/" or path == "":
            path = "/index.html"

        if path.startswith("/item_icons/"):
            base = ICON_DIR
            rel = path[len("/item_icons/"):]
        else:
            base = WEB_DIR
            rel = path.lstrip("/")

        # 归一化并阻止目录穿越
        target = os.path.normpath(os.path.join(base, rel))
        if not (target == base or target.startswith(base + os.sep)):
            return self._error(403, "Forbidden")
        if not os.path.isfile(target):
            return self._error(404, "Not found")

        ext = os.path.splitext(target)[1].lower()
        ctype = MIME_TYPES.get(ext, "application/octet-stream")
        try:
            with open(target, "rb") as f:
                data = f.read()
        except OSError:
            return self._error(404, "Not found")

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    # -- API: GET ----------------------------------------------------------
    def _api_get(self, path):
        if path == "/api/recipes":
            return self._send_json(read_json(RECIPES_FILE, []))

        if path == "/api/special-recipes":
            # 特殊配方：与主配方分离存放，只读、长久有效
            return self._send_json(read_json(SPECIAL_RECIPES_FILE, []))

        if path == "/api/temp-recipes":
            return self._send_json(read_json(TEMP_RECIPES_FILE, []))

        if path == "/api/plans":
            return self._send_json(self._list_dir_json(PLANS_DIR, summary=True))
        if path.startswith("/api/plans/"):
            pid = path[len("/api/plans/"):]
            return self._get_item(PLANS_DIR, pid)

        if path == "/api/components":
            return self._send_json(self._list_dir_json(COMPONENTS_DIR, summary=False))
        if path.startswith("/api/components/"):
            cid = path[len("/api/components/"):]
            return self._get_item(COMPONENTS_DIR, cid)

        return self._error(404, "Unknown endpoint")

    def _list_dir_json(self, directory, summary):
        items = []
        if not os.path.isdir(directory):
            return items
        for name in sorted(os.listdir(directory)):
            if not name.endswith(".json"):
                continue
            data = read_json(os.path.join(directory, name), None)
            if data is None:
                continue
            if summary:
                meta = data.get("meta", {}) if isinstance(data, dict) else {}
                nodes = data.get("nodes") if isinstance(data, dict) else None
                edges = data.get("edges") if isinstance(data, dict) else None
                items.append({
                    "id": meta.get("id") or data.get("id") or name[:-5],
                    "name": meta.get("name") or data.get("name") or name[:-5],
                    "icon_item_id": meta.get("icon_item_id", ""),
                    "updated_at": meta.get("updated_at") or data.get("updated_at"),
                    "created_at": meta.get("created_at") or data.get("created_at"),
                    "node_count": len(nodes) if isinstance(nodes, list) else 0,
                    "edge_count": len(edges) if isinstance(edges, list) else 0,
                })
            else:
                items.append(data)
        return items

    def _get_item(self, directory, item_id):
        if not valid_id(item_id):
            return self._error(400, "Invalid id")
        path = os.path.join(directory, item_id + ".json")
        if not os.path.isfile(path):
            return self._error(404, "Not found")
        return self._send_json(read_json(path, {}))

    # -- API: POST / PUT ---------------------------------------------------
    def _api_write(self, method, path):
        body = self._read_body()
        if body is _BadBody:
            return self._error(400, "Invalid JSON body")

        # 临时配方：整表覆盖保存
        if path == "/api/temp-recipes":
            if not isinstance(body, list):
                return self._error(400, "Body must be an array")
            cleaned = self._normalize_temp_recipes(body)
            try:
                atomic_write_json(TEMP_RECIPES_FILE, cleaned)
            except OSError as exc:
                return self._error(500, f"Write failed: {exc}")
            return self._send_json(cleaned)

        # 方案
        if path == "/api/plans" and method == "POST":
            return self._create_item(PLANS_DIR, body, "plan")
        if path.startswith("/api/plans/") and method == "PUT":
            return self._update_item(PLANS_DIR, path[len("/api/plans/"):], body, "plan")

        # 组件
        if path == "/api/components" and method == "POST":
            return self._create_item(COMPONENTS_DIR, body, "cmp")
        if path.startswith("/api/components/") and method == "PUT":
            return self._update_item(COMPONENTS_DIR, path[len("/api/components/"):], body, "cmp")

        return self._error(404, "Unknown endpoint")

    def _normalize_temp_recipes(self, arr):
        out = []
        for item in arr:
            if not isinstance(item, dict):
                continue
            item = dict(item)
            item["temporary"] = True
            if not valid_id(item.get("id")):
                item["id"] = new_id("tmp")
            out.append(item)
        return out

    def _create_item(self, directory, body, prefix):
        if not isinstance(body, dict):
            return self._error(400, "Body must be an object")
        meta = body.get("meta")
        if isinstance(meta, dict):
            item_id = meta.get("id")
            if not valid_id(item_id):
                item_id = new_id(prefix)
                meta["id"] = item_id
            meta.setdefault("created_at", now_iso())
            meta["updated_at"] = now_iso()
        else:
            item_id = body.get("id")
            if not valid_id(item_id):
                item_id = new_id(prefix)
                body["id"] = item_id
            body.setdefault("created_at", now_iso())
            body["updated_at"] = now_iso()
        try:
            atomic_write_json(os.path.join(directory, item_id + ".json"), body)
        except OSError as exc:
            return self._error(500, f"Write failed: {exc}")
        return self._send_json(body, status=201)

    def _update_item(self, directory, item_id, body, prefix):
        if not valid_id(item_id):
            return self._error(400, "Invalid id")
        if not isinstance(body, dict):
            return self._error(400, "Body must be an object")
        meta = body.get("meta")
        if isinstance(meta, dict):
            meta["id"] = item_id
            meta.setdefault("created_at", now_iso())
            meta["updated_at"] = now_iso()
        else:
            body["id"] = item_id
            body.setdefault("created_at", now_iso())
            body["updated_at"] = now_iso()
        try:
            atomic_write_json(os.path.join(directory, item_id + ".json"), body)
        except OSError as exc:
            return self._error(500, f"Write failed: {exc}")
        return self._send_json(body)

    # -- API: DELETE -------------------------------------------------------
    def _api_delete(self, path):
        if path.startswith("/api/plans/"):
            return self._delete_item(PLANS_DIR, path[len("/api/plans/"):])
        if path.startswith("/api/components/"):
            return self._delete_item(COMPONENTS_DIR, path[len("/api/components/"):])
        return self._error(404, "Unknown endpoint")

    def _delete_item(self, directory, item_id):
        if not valid_id(item_id):
            return self._error(400, "Invalid id")
        target = os.path.join(directory, item_id + ".json")
        if os.path.isfile(target):
            try:
                os.remove(target)
            except OSError as exc:
                return self._error(500, f"Delete failed: {exc}")
        return self._send_json({"ok": True, "id": item_id})

    # 安静一点的日志
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


class _BadBody:
    """哨兵：标记请求体 JSON 解析失败。"""


def main():
    ensure_dirs()
    port = 8770
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"节点式工厂配平编辑器已启动： {url}")
    print("按 Ctrl+C 停止。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
