#!/usr/bin/env python3
"""Local lease inbox: store lease PDFs in a folder and log them for parsing.

Everything stays on this machine. PDFs go to ./storage/ and each one gets a row
in ./lease_inbox.sqlite with status `received`. The parser picks up those rows.

    python3 lease_inbox.py store lease.pdf --sender a@b.com --subject "Unit 4"
    python3 lease_inbox.py serve            # http://127.0.0.1:8765
    python3 lease_inbox.py list

Standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
STORAGE = os.environ.get("LEASE_INBOX_STORAGE", os.path.join(HERE, "storage"))
DB_PATH = os.environ.get("LEASE_INBOX_DB", os.path.join(HERE, "lease_inbox.sqlite"))
MAX_BYTES = 25 * 1024 * 1024
STATUSES = ("received", "parsing", "parsed", "failed")

SCHEMA = """
create table if not exists lease_documents (
    id           integer primary key autoincrement,
    source       text not null default 'email',
    sender       text,
    subject      text,
    message_id   text,
    received_at  text,
    filename     text not null,
    storage_path text not null unique,
    sha256       text not null unique,
    size_bytes   integer not null,
    status       text not null default 'received'
                 check (status in ('received', 'parsing', 'parsed', 'failed')),
    error        text,
    created_at   text not null
);
create index if not exists lease_documents_status on lease_documents (status, created_at);
"""


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def safe_name(name: str) -> str:
    """Reduce a filename to characters that are safe in a path."""
    base = os.path.basename(name or "").strip() or "document.pdf"
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", base).strip("-.") or "document.pdf"
    return base[:120]


def check_pdf(data: bytes) -> str | None:
    """Return a reason to reject the file, or None if it looks like a usable PDF."""
    if not data:
        return "file is empty"
    if len(data) > MAX_BYTES:
        return f"file is {len(data)} bytes, over the {MAX_BYTES} byte limit"
    if b"%PDF-" not in data[:1024]:
        return "not a PDF (no %PDF- header)"
    return None


def store(data: bytes, filename: str, *, sender: str | None = None,
          subject: str | None = None, message_id: str | None = None,
          received_at: str | None = None, source: str = "email") -> dict:
    """Save one PDF and log it. Returns a dict whose `result` is stored, duplicate or rejected."""
    filename = safe_name(filename)
    reason = check_pdf(data)
    if reason:
        return {"result": "rejected", "filename": filename, "reason": reason}

    sha256 = hashlib.sha256(data).hexdigest()
    now = dt.datetime.now(dt.timezone.utc)
    rel_path = f"{now:%Y/%m/%d}/{sha256[:12]}-{filename}"

    with db() as conn:
        row = conn.execute(
            "select id, storage_path, status from lease_documents where sha256 = ?",
            (sha256,)).fetchone()
        if row:  # the same PDF sent twice is stored once
            return {"result": "duplicate", "sha256": sha256, **dict(row)}

        # Write the file first, then the row, so a row always points at a real file.
        full_path = os.path.join(STORAGE, rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as fh:
            fh.write(data)

        cur = conn.execute(
            "insert into lease_documents (source, sender, subject, message_id, received_at,"
            " filename, storage_path, sha256, size_bytes, created_at)"
            " values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (source, sender, subject, message_id,
             received_at or now.isoformat(timespec="seconds"),
             filename, rel_path, sha256, len(data), now.isoformat(timespec="seconds")))
        return {"result": "stored", "id": cur.lastrowid, "status": "received",
                "filename": filename, "storage_path": rel_path, "sha256": sha256,
                "size_bytes": len(data)}


def list_documents(status: str | None = None) -> list[dict]:
    with db() as conn:
        if status:
            rows = conn.execute(
                "select * from lease_documents where status = ? order by id", (status,))
        else:
            rows = conn.execute("select * from lease_documents order by id")
        return [dict(r) for r in rows]


def set_status(doc_id: int, status: str, error: str | None = None) -> bool:
    if status not in STATUSES:
        raise ValueError(f"status must be one of {STATUSES}")
    with db() as conn:
        cur = conn.execute("update lease_documents set status = ?, error = ? where id = ?",
                           (status, error, doc_id))
        return cur.rowcount == 1


class Handler(BaseHTTPRequestHandler):
    """POST /leases with the PDF as the body. GET /leases lists what is stored."""

    token = os.environ.get("LEASE_INBOX_TOKEN", "")

    def _send(self, code: int, payload: object) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self) -> bool:
        # A token is only enforced when one is set, e.g. before exposing through a tunnel.
        return not self.token or self.headers.get("X-Inbox-Token", "") == self.token

    def do_GET(self) -> None:  # noqa: N802 (name fixed by http.server)
        url = urlparse(self.path)
        if url.path == "/health":
            return self._send(200, {"ok": True})
        if not self._authorised():
            return self._send(401, {"error": "bad or missing X-Inbox-Token"})
        if url.path == "/leases":
            status = dict(p.split("=", 1) for p in url.query.split("&") if "=" in p).get("status")
            return self._send(200, list_documents(status))
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/leases":
            return self._send(404, {"error": "not found"})
        if not self._authorised():
            return self._send(401, {"error": "bad or missing X-Inbox-Token"})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BYTES:
            return self._send(413, {"result": "rejected", "reason": "file too large"})
        data = self.rfile.read(length)
        head = lambda name: unquote(self.headers.get(name, "")) or None  # noqa: E731
        result = store(data, head("X-Filename") or "document.pdf",
                       sender=head("X-Sender"), subject=head("X-Subject"),
                       message_id=head("X-Message-Id"), received_at=head("X-Received-At"),
                       source=head("X-Source") or "email")
        self._send({"stored": 201, "duplicate": 200}.get(result["result"], 422), result)

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("lease-inbox: " + fmt % args + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("store", help="store one PDF from disk")
    p.add_argument("file")
    p.add_argument("--sender")
    p.add_argument("--subject")
    p.add_argument("--message-id")
    p.add_argument("--received-at")
    p.add_argument("--source", default="manual")

    p = sub.add_parser("serve", help="run the local HTTP inbox")
    p.add_argument("--port", type=int, default=8765)

    p = sub.add_parser("list", help="list stored documents")
    p.add_argument("--status", choices=STATUSES)

    p = sub.add_parser("mark", help="set a document's status (for the parser)")
    p.add_argument("id", type=int)
    p.add_argument("status", choices=STATUSES)
    p.add_argument("--error")

    args = ap.parse_args()

    if args.command == "store":
        try:
            with open(args.file, "rb") as fh:
                data = fh.read()
        except OSError as err:
            print(json.dumps({"result": "rejected", "reason": f"cannot read file: {err}"}))
            return 1
        result = store(data, args.file, sender=args.sender, subject=args.subject,
                       message_id=args.message_id, received_at=args.received_at,
                       source=args.source)
        print(json.dumps(result))
        return 0 if result["result"] in ("stored", "duplicate") else 1

    if args.command == "serve":
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
        print(f"lease inbox on http://127.0.0.1:{args.port}  storage: {STORAGE}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        return 0

    if args.command == "list":
        print(json.dumps(list_documents(args.status), indent=2))
        return 0

    if args.command == "mark":
        ok = set_status(args.id, args.status, args.error)
        print(json.dumps({"updated": ok, "id": args.id, "status": args.status}))
        return 0 if ok else 1

    return 1


if __name__ == "__main__":
    sys.exit(main())
