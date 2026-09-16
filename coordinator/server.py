import json
import os
import sqlite3
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


HOST = "127.0.0.1"
PORT = 8765
MAX_CONCURRENCY = 5
ACTIVE_TTL_SECONDS = 180
ROOT_DIR = Path(__file__).resolve().parent
DB_PATH = ROOT_DIR / "coordinator.db"
PID_PATH = ROOT_DIR / "coordinator.pid"
TERMINAL_STATUSES = {"complete", "stopped", "error", "limit"}
ALLOWED_EXTENSION_ORIGINS = ("chrome-extension://", "edge-extension://")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def connect_db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=10000")
    return connection


def initialize_db() -> None:
    with connect_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS clients (
                client_id TEXT PRIMARY KEY,
                browser_name TEXT NOT NULL DEFAULT '',
                account_email TEXT NOT NULL DEFAULT '',
                forward_email TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'idle',
                current_count INTEGER NOT NULL DEFAULT 0,
                total_count INTEGER NOT NULL DEFAULT 0,
                results_json TEXT NOT NULL DEFAULT '[]',
                message TEXT NOT NULL DEFAULT '',
                batch_id TEXT NOT NULL DEFAULT '',
                active INTEGER NOT NULL DEFAULT 0,
                last_seen REAL NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS batches (
                batch_id TEXT PRIMARY KEY,
                client_id TEXT NOT NULL,
                browser_name TEXT NOT NULL DEFAULT '',
                account_email TEXT NOT NULL DEFAULT '',
                forward_email TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'running',
                current_count INTEGER NOT NULL DEFAULT 0,
                total_count INTEGER NOT NULL DEFAULT 0,
                results_json TEXT NOT NULL DEFAULT '[]',
                message TEXT NOT NULL DEFAULT '',
                started_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                finished_at TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS idx_clients_active ON clients(active, last_seen);
            CREATE INDEX IF NOT EXISTS idx_batches_updated ON batches(updated_at DESC);
            """
        )


def expire_stale_clients(db: sqlite3.Connection) -> None:
    cutoff = time.time() - ACTIVE_TTL_SECONDS
    timestamp = now_iso()
    db.execute(
        """
        UPDATE batches
        SET status = 'offline',
            message = CASE
                WHEN message = '' THEN '浏览器连接中断，已保留当前结果'
                ELSE message
            END,
            updated_at = ?,
            finished_at = ?
        WHERE status IN ('running', 'claimed')
          AND batch_id IN (
              SELECT batch_id FROM clients
              WHERE active = 1 AND last_seen < ? AND batch_id <> ''
          )
        """,
        (timestamp, timestamp, cutoff),
    )
    db.execute(
        """
        UPDATE clients
        SET active = 0,
            status = CASE WHEN status IN ('running', 'claimed') THEN 'offline' ELSE status END
        WHERE active = 1 AND last_seen < ?
        """,
        (cutoff,),
    )


def row_to_client(row: sqlite3.Row) -> dict:
    last_seen = float(row["last_seen"] or 0)
    return {
        "clientId": row["client_id"],
        "browserName": row["browser_name"],
        "accountEmail": row["account_email"],
        "forwardEmail": row["forward_email"],
        "status": row["status"],
        "current": row["current_count"],
        "total": row["total_count"],
        "results": json.loads(row["results_json"] or "[]"),
        "message": row["message"],
        "batchId": row["batch_id"],
        "active": bool(row["active"]),
        "online": time.time() - last_seen < ACTIVE_TTL_SECONDS,
        "updatedAt": row["updated_at"],
    }


def row_to_batch(row: sqlite3.Row) -> dict:
    return {
        "batchId": row["batch_id"],
        "clientId": row["client_id"],
        "browserName": row["browser_name"],
        "accountEmail": row["account_email"],
        "forwardEmail": row["forward_email"],
        "status": row["status"],
        "current": row["current_count"],
        "total": row["total_count"],
        "results": json.loads(row["results_json"] or "[]"),
        "message": row["message"],
        "startedAt": row["started_at"],
        "updatedAt": row["updated_at"],
        "finishedAt": row["finished_at"],
    }


class CoordinatorHandler(BaseHTTPRequestHandler):
    server_version = "HMECoordinator/1.0"

    def log_message(self, format_string: str, *args) -> None:
        print(f"[{now_iso()}] {self.client_address[0]} {format_string % args}")

    def do_OPTIONS(self) -> None:
        if not self._origin_allowed():
            self._json_response({"ok": False, "error": "Origin not allowed"}, status=403)
            return
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        if not self._origin_allowed():
            self._json_response({"ok": False, "error": "Origin not allowed"}, status=403)
            return
        path = urlparse(self.path).path
        if path == "/api/health":
            with connect_db() as db:
                expire_stale_clients(db)
                active = db.execute("SELECT COUNT(*) FROM clients WHERE active = 1").fetchone()[0]
            self._json_response(
                {
                    "ok": True,
                    "maxConcurrency": MAX_CONCURRENCY,
                    "activeCount": active,
                    "time": now_iso(),
                }
            )
            return

        if path == "/api/dashboard":
            with connect_db() as db:
                expire_stale_clients(db)
                clients = [
                    row_to_client(row)
                    for row in db.execute(
                        "SELECT * FROM clients ORDER BY active DESC, last_seen DESC LIMIT 50"
                    ).fetchall()
                ]
                batches = [
                    row_to_batch(row)
                    for row in db.execute(
                        "SELECT * FROM batches ORDER BY updated_at DESC LIMIT 50"
                    ).fetchall()
                ]
                active = sum(1 for client in clients if client["active"])
            self._json_response(
                {
                    "ok": True,
                    "maxConcurrency": MAX_CONCURRENCY,
                    "activeCount": active,
                    "clients": clients,
                    "batches": batches,
                }
            )
            return

        self._json_response({"ok": False, "error": "Not found"}, status=404)

    def do_POST(self) -> None:
        if not self._origin_allowed():
            self._json_response({"ok": False, "error": "Origin not allowed"}, status=403)
            return
        path = urlparse(self.path).path
        try:
            data = self._read_json()
            if path == "/api/register":
                self._handle_register(data)
            elif path == "/api/claim":
                self._handle_claim(data)
            elif path == "/api/release":
                self._handle_release(data)
            elif path == "/api/update":
                self._handle_update(data)
            else:
                self._json_response({"ok": False, "error": "Not found"}, status=404)
        except ValueError as error:
            self._json_response({"ok": False, "error": str(error)}, status=400)
        except Exception as error:
            self._json_response({"ok": False, "error": str(error)}, status=500)

    def _handle_register(self, data: dict) -> None:
        client_id = require_string(data, "clientId")
        browser_name = clean_string(data.get("browserName"), 80)
        timestamp = now_iso()
        with connect_db() as db:
            db.execute(
                """
                INSERT INTO clients(client_id, browser_name, last_seen, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(client_id) DO UPDATE SET
                    browser_name = excluded.browser_name,
                    last_seen = excluded.last_seen,
                    updated_at = excluded.updated_at
                """,
                (client_id, browser_name, time.time(), timestamp),
            )
        self._json_response({"ok": True})

    def _handle_claim(self, data: dict) -> None:
        client_id = require_string(data, "clientId")
        browser_name = clean_string(data.get("browserName"), 80)
        account_email = clean_string(data.get("accountEmail"), 254).lower()
        forward_email = clean_string(data.get("forwardEmail"), 254).lower()
        total = clamp_int(data.get("total"), 1, 50, 20)
        if not account_email:
            raise ValueError("没有读取到 Apple 登录账号")
        if not forward_email:
            raise ValueError("没有读取到转发邮箱")

        timestamp = now_iso()
        with connect_db() as db:
            db.execute("BEGIN IMMEDIATE")
            expire_stale_clients(db)
            duplicate = db.execute(
                """
                SELECT client_id FROM clients
                WHERE active = 1 AND account_email = ? AND client_id <> ?
                LIMIT 1
                """,
                (account_email, client_id),
            ).fetchone()
            if duplicate:
                db.rollback()
                self._json_response(
                    {"ok": False, "error": "同一个 Apple 账号已有任务正在运行"},
                    status=409,
                )
                return

            active_count = db.execute(
                "SELECT COUNT(*) FROM clients WHERE active = 1 AND client_id <> ?",
                (client_id,),
            ).fetchone()[0]
            if active_count >= MAX_CONCURRENCY:
                db.rollback()
                self._json_response(
                    {"ok": False, "error": f"已达到最大并发数 {MAX_CONCURRENCY}"},
                    status=409,
                )
                return

            db.execute(
                """
                INSERT INTO clients(
                    client_id, browser_name, account_email, forward_email,
                    status, total_count, active, last_seen, updated_at
                ) VALUES (?, ?, ?, ?, 'claimed', ?, 1, ?, ?)
                ON CONFLICT(client_id) DO UPDATE SET
                    browser_name = excluded.browser_name,
                    account_email = excluded.account_email,
                    forward_email = excluded.forward_email,
                    status = 'claimed',
                    current_count = 0,
                    total_count = excluded.total_count,
                    results_json = '[]',
                    message = '',
                    batch_id = '',
                    active = 1,
                    last_seen = excluded.last_seen,
                    updated_at = excluded.updated_at
                """,
                (
                    client_id,
                    browser_name,
                    account_email,
                    forward_email,
                    total,
                    time.time(),
                    timestamp,
                ),
            )
            db.commit()
        self._json_response({"ok": True, "maxConcurrency": MAX_CONCURRENCY})

    def _handle_release(self, data: dict) -> None:
        client_id = require_string(data, "clientId")
        message = clean_string(data.get("message"), 500)
        with connect_db() as db:
            db.execute(
                """
                UPDATE clients
                SET active = 0,
                    status = CASE WHEN status = 'claimed' THEN 'idle' ELSE status END,
                    message = CASE WHEN ? <> '' THEN ? ELSE message END,
                    last_seen = ?,
                    updated_at = ?
                WHERE client_id = ?
                """,
                (message, message, time.time(), now_iso(), client_id),
            )
        self._json_response({"ok": True})

    def _handle_update(self, data: dict) -> None:
        client_id = require_string(data, "clientId")
        browser_name = clean_string(data.get("browserName"), 80)
        payload = data.get("payload") or {}
        if not isinstance(payload, dict):
            raise ValueError("payload 必须是对象")

        batch_id = clean_string(payload.get("batchId"), 120)
        account_email = clean_string(payload.get("accountEmail"), 254).lower()
        forward_email = clean_string(payload.get("forwardEmail"), 254).lower()
        status = clean_string(payload.get("status"), 40) or "idle"
        running = bool(payload.get("running"))
        current = clamp_int(payload.get("current"), 0, 1000, 0)
        total = clamp_int(payload.get("total"), 0, 1000, 0)
        results = payload.get("results") if isinstance(payload.get("results"), list) else []
        results = [clean_string(item, 254) for item in results if clean_string(item, 254)]
        message = clean_string(payload.get("message"), 1000)
        timestamp = now_iso()
        active = 1 if running else 0
        results_json = json.dumps(results, ensure_ascii=False)

        with connect_db() as db:
            existing = db.execute(
                "SELECT account_email, forward_email FROM clients WHERE client_id = ?",
                (client_id,),
            ).fetchone()
            if existing:
                account_email = account_email or existing["account_email"]
                forward_email = forward_email or existing["forward_email"]

            db.execute(
                """
                INSERT INTO clients(
                    client_id, browser_name, account_email, forward_email,
                    status, current_count, total_count, results_json, message,
                    batch_id, active, last_seen, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(client_id) DO UPDATE SET
                    browser_name = excluded.browser_name,
                    account_email = excluded.account_email,
                    forward_email = excluded.forward_email,
                    status = excluded.status,
                    current_count = excluded.current_count,
                    total_count = excluded.total_count,
                    results_json = excluded.results_json,
                    message = excluded.message,
                    batch_id = excluded.batch_id,
                    active = excluded.active,
                    last_seen = excluded.last_seen,
                    updated_at = excluded.updated_at
                """,
                (
                    client_id,
                    browser_name,
                    account_email,
                    forward_email,
                    status,
                    current,
                    total,
                    results_json,
                    message,
                    batch_id,
                    active,
                    time.time(),
                    timestamp,
                ),
            )

            if batch_id:
                finished_at = timestamp if status in TERMINAL_STATUSES and not running else ""
                db.execute(
                    """
                    INSERT INTO batches(
                        batch_id, client_id, browser_name, account_email, forward_email,
                        status, current_count, total_count, results_json, message,
                        started_at, updated_at, finished_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(batch_id) DO UPDATE SET
                        browser_name = excluded.browser_name,
                        account_email = excluded.account_email,
                        forward_email = excluded.forward_email,
                        status = excluded.status,
                        current_count = excluded.current_count,
                        total_count = excluded.total_count,
                        results_json = excluded.results_json,
                        message = excluded.message,
                        updated_at = excluded.updated_at,
                        finished_at = CASE
                            WHEN excluded.finished_at <> '' THEN excluded.finished_at
                            ELSE batches.finished_at
                        END
                    """,
                    (
                        batch_id,
                        client_id,
                        browser_name,
                        account_email,
                        forward_email,
                        status,
                        current,
                        total,
                        results_json,
                        message,
                        timestamp,
                        timestamp,
                        finished_at,
                    ),
                )

        self._json_response({"ok": True})

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0 or length > 1_000_000:
            raise ValueError("请求内容为空或过大")
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("请求必须是 JSON 对象")
        return data

    def _json_response(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_cors_headers(self) -> None:
        origin = self.headers.get("Origin", "").strip()
        if origin and self._origin_allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin", "").strip().lower()
        return not origin or origin.startswith(ALLOWED_EXTENSION_ORIGINS)


def require_string(data: dict, key: str) -> str:
    value = clean_string(data.get(key), 200)
    if not value:
        raise ValueError(f"缺少 {key}")
    return value


def clean_string(value, max_length: int) -> str:
    return str(value or "").strip()[:max_length]


def clamp_int(value, minimum: int, maximum: int, fallback: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return min(maximum, max(minimum, number))


def main() -> None:
    ROOT_DIR.mkdir(parents=True, exist_ok=True)
    initialize_db()
    PID_PATH.write_text(str(os.getpid()), encoding="ascii")
    server = ThreadingHTTPServer((HOST, PORT), CoordinatorHandler)
    print(f"iCloud Hide My Email coordinator: http://{HOST}:{PORT}")
    print(f"Max concurrency: {MAX_CONCURRENCY}")
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        PID_PATH.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
