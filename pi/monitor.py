#!/usr/bin/env python3
"""WiFi monitor — runs every minute via cron.

Pings router and external target, writes to local SQLite, then flushes
unpushed rows to the Railway API (backfills automatically on reconnect).
"""

import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")

API_URL = os.environ["API_URL"].rstrip("/")
API_KEY = os.environ["API_KEY"]
ROUTER_IP = os.environ.get("ROUTER_IP", "192.168.1.1")
EXTERNAL_IP = "1.1.1.1"
PING_COUNT = 10
DB_PATH = BASE_DIR / "metrics.db"
ERROR_LOG = BASE_DIR / "errors.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(ERROR_LOG),
    ],
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            measured_at TEXT NOT NULL,
            router_latency_ms REAL,
            external_latency_ms REAL,
            router_packet_loss REAL NOT NULL,
            external_packet_loss REAL NOT NULL,
            router_reachable INTEGER NOT NULL,
            external_reachable INTEGER NOT NULL,
            pushed INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.commit()
    return conn


def insert_metric(conn: sqlite3.Connection, measured_at: str, data: dict) -> None:
    conn.execute(
        """
        INSERT INTO metrics (
            measured_at, router_latency_ms, external_latency_ms,
            router_packet_loss, external_packet_loss,
            router_reachable, external_reachable
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            measured_at,
            data["routerLatencyMs"],
            data["externalLatencyMs"],
            data["routerPacketLoss"],
            data["externalPacketLoss"],
            int(data["routerReachable"]),
            int(data["externalReachable"]),
        ),
    )
    conn.commit()


def get_unpushed(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM metrics WHERE pushed = 0 ORDER BY measured_at ASC"
    ).fetchall()


def mark_pushed(conn: sqlite3.Connection, row_id: int) -> None:
    conn.execute("UPDATE metrics SET pushed = 1 WHERE id = ?", (row_id,))
    conn.commit()


# ---------------------------------------------------------------------------
# Ping
# ---------------------------------------------------------------------------

def ping(host: str, count: int = PING_COUNT) -> dict:
    """Return dict with reachable, latencyMs, packetLoss."""
    try:
        result = subprocess.run(
            ["ping", "-c", str(count), "-W", "2", host],
            capture_output=True,
            text=True,
            timeout=count * 3 + 5,
        )
        output = result.stdout + result.stderr

        # Packet loss — "X% packet loss"
        loss_match = re.search(r"(\d+(?:\.\d+)?)% packet loss", output)
        packet_loss = float(loss_match.group(1)) if loss_match else 100.0

        reachable = result.returncode == 0 and packet_loss < 100

        # Average latency from "rtt min/avg/max/mdev = X/X/X/X ms"
        rtt_match = re.search(r"rtt min/avg/max/mdev = [\d.]+/([\d.]+)/", output)
        latency_ms = float(rtt_match.group(1)) if rtt_match and reachable else None

        return {
            "reachable": reachable,
            "latencyMs": latency_ms,
            "packetLoss": packet_loss,
        }

    except (subprocess.TimeoutExpired, OSError) as exc:
        log.warning("ping %s failed: %s", host, exc)
        return {"reachable": False, "latencyMs": None, "packetLoss": 100.0}


# ---------------------------------------------------------------------------
# API flush
# ---------------------------------------------------------------------------

def push_row(row: sqlite3.Row) -> bool:
    payload = {
        "measuredAt": row["measured_at"],
        "routerLatencyMs": row["router_latency_ms"],
        "externalLatencyMs": row["external_latency_ms"],
        "routerPacketLoss": row["router_packet_loss"],
        "externalPacketLoss": row["external_packet_loss"],
        "routerReachable": bool(row["router_reachable"]),
        "externalReachable": bool(row["external_reachable"]),
    }
    try:
        resp = requests.post(
            f"{API_URL}/metrics",
            json=payload,
            headers={"Authorization": f"Bearer {API_KEY}"},
            timeout=10,
        )
        resp.raise_for_status()
        return True
    except requests.RequestException as exc:
        log.warning("push failed (row %s): %s", row["id"], exc)
        return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    measured_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # 1. Collect ping metrics
    router = ping(ROUTER_IP)
    external = ping(EXTERNAL_IP)

    metric = {
        "routerLatencyMs": router["latencyMs"],
        "externalLatencyMs": external["latencyMs"],
        "routerPacketLoss": router["packetLoss"],
        "externalPacketLoss": external["packetLoss"],
        "routerReachable": router["reachable"],
        "externalReachable": external["reachable"],
    }

    log.info("collected: %s", json.dumps(metric))

    # 2. Write to local SQLite
    conn = get_db()
    insert_metric(conn, measured_at, metric)

    # 3. Flush unpushed rows
    unpushed = get_unpushed(conn)
    log.info("%d unpushed row(s) to flush", len(unpushed))

    for row in unpushed:
        ok = push_row(row)
        if ok:
            mark_pushed(conn, row["id"])
            log.info("pushed row %s (%s)", row["id"], row["measured_at"])
        else:
            log.warning("stopping flush — connectivity issue")
            break

    conn.close()


if __name__ == "__main__":
    main()
