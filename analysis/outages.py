#!/usr/bin/env python3
"""
Analyze wifi-monitor Postgres data for short outages (consecutive external packet loss).

Usage:
    python outages.py --db <DATABASE_PUBLIC_URL>
    python outages.py  # reads DATABASE_URL from env or .env
"""

import argparse
import os
import sys
from datetime import timezone

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    sys.exit("Missing dependency: pip install psycopg2-binary")

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ── config ────────────────────────────────────────────────────────────────────
MIN_LOSS_PCT = 10       # % threshold to count a minute as "lossy"
MIN_RUN_SAMPLES = 2     # consecutive lossy minutes to call it an outage
DETAIL_WINDOW_MIN = 10  # minutes of context to show around each outage
DATA_GAP_MIN = 5        # minutes gap in data = possible complete outage
# ─────────────────────────────────────────────────────────────────────────────


def connect(url: str):
    return psycopg2.connect(url, cursor_factory=psycopg2.extras.RealDictCursor)


def overview(cur):
    cur.execute("""
        SELECT
            COUNT(*) AS total_rows,
            MIN("measuredAt") AS earliest,
            MAX("measuredAt") AS latest,
            ROUND(AVG(EXTRACT(EPOCH FROM (lead - "measuredAt"))/60)::numeric, 2) AS avg_interval_min
        FROM (
            SELECT "measuredAt", LEAD("measuredAt") OVER (ORDER BY "measuredAt") AS lead
            FROM "Metric"
        ) t
    """)
    return cur.fetchone()


def find_outage_runs(cur, min_loss: int, min_samples: int):
    cur.execute("""
        WITH flagged AS (
            SELECT
                "measuredAt",
                "externalPacketLoss",
                "routerPacketLoss",
                "externalLatencyMs",
                "routerLatencyMs",
                CASE WHEN "externalPacketLoss" >= %(min_loss)s THEN 1 ELSE 0 END AS is_lossy,
                ROW_NUMBER() OVER (ORDER BY "measuredAt")
                    - ROW_NUMBER() OVER (
                        PARTITION BY ("externalPacketLoss" >= %(min_loss)s)
                        ORDER BY "measuredAt"
                      ) AS grp
            FROM "Metric"
        ),
        runs AS (
            SELECT
                grp,
                MIN("measuredAt") AS run_start,
                MAX("measuredAt") AS run_end,
                COUNT(*) AS samples,
                ROUND(EXTRACT(EPOCH FROM MAX("measuredAt") - MIN("measuredAt"))/60::numeric, 1) AS duration_min,
                ROUND(AVG("externalPacketLoss")::numeric, 1) AS avg_ext_loss,
                ROUND(MAX("externalPacketLoss")::numeric, 0) AS max_ext_loss,
                ROUND(AVG("routerPacketLoss")::numeric, 1) AS avg_rtr_loss,
                ROUND(AVG("externalLatencyMs")::numeric, 0) AS avg_ext_lat_ms
            FROM flagged
            WHERE is_lossy = 1
            GROUP BY grp
        )
        SELECT * FROM runs
        WHERE samples >= %(min_samples)s
        ORDER BY run_start
    """, {"min_loss": min_loss, "min_samples": min_samples})
    return cur.fetchall()


def find_data_gaps(cur, gap_min: int):
    cur.execute("""
        WITH gaps AS (
            SELECT
                "measuredAt",
                LEAD("measuredAt") OVER (ORDER BY "measuredAt") AS next_at,
                EXTRACT(EPOCH FROM
                    LEAD("measuredAt") OVER (ORDER BY "measuredAt") - "measuredAt"
                ) / 60 AS gap_min
            FROM "Metric"
        )
        SELECT
            "measuredAt" AS last_before,
            next_at AS first_after,
            ROUND(gap_min::numeric, 1) AS gap_minutes
        FROM gaps
        WHERE gap_min > %(gap_min)s
        ORDER BY gap_min DESC
    """, {"gap_min": gap_min})
    return cur.fetchall()


def fetch_window(cur, start, end, buffer_min: int):
    cur.execute("""
        SELECT
            "measuredAt",
            ROUND("externalLatencyMs"::numeric) AS ext_lat_ms,
            ROUND("routerLatencyMs"::numeric) AS rtr_lat_ms,
            "externalPacketLoss" AS ext_loss,
            "routerPacketLoss" AS rtr_loss,
            "externalReachable" AS ext_up,
            "routerReachable" AS rtr_up
        FROM "Metric"
        WHERE "measuredAt" BETWEEN
            %(start)s - INTERVAL '1 minute' * %(buf)s
            AND
            %(end)s + INTERVAL '1 minute' * %(buf)s
        ORDER BY "measuredAt"
    """, {"start": start, "end": end, "buf": buffer_min})
    return cur.fetchall()


def fmt_ts(ts):
    if ts is None:
        return "—"
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def cause(avg_rtr_loss):
    return "ISP" if avg_rtr_loss == 0 else "router+ISP"


def print_section(title):
    print(f"\n{'━' * 60}")
    print(f"  {title}")
    print('━' * 60)


def main():
    parser = argparse.ArgumentParser(description="Analyze wifi-monitor outages")
    parser.add_argument("--db", help="Postgres connection URL (overrides env)")
    parser.add_argument("--min-loss", type=int, default=MIN_LOSS_PCT,
                        help=f"Min packet loss %% to flag a minute (default {MIN_LOSS_PCT})")
    parser.add_argument("--min-minutes", type=int, default=MIN_RUN_SAMPLES,
                        help=f"Min consecutive lossy minutes to call an outage (default {MIN_RUN_SAMPLES})")
    parser.add_argument("--detail", action="store_true",
                        help="Print minute-by-minute breakdown for each outage")
    args = parser.parse_args()

    url = args.db or os.environ.get("DATABASE_PUBLIC_URL") or os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("No database URL. Pass --db or set DATABASE_PUBLIC_URL in env.")

    print("Connecting…")
    conn = connect(url)
    cur = conn.cursor()

    # ── overview ──────────────────────────────────────────────────────────────
    row = overview(cur)
    print_section("Dataset overview")
    print(f"  Rows:          {int(row['total_rows']):,}")
    print(f"  From:          {fmt_ts(row['earliest'])}")
    print(f"  To:            {fmt_ts(row['latest'])}")
    print(f"  Avg interval:  {row['avg_interval_min']} min")

    # ── data gaps ─────────────────────────────────────────────────────────────
    gaps = find_data_gaps(cur, DATA_GAP_MIN)
    print_section(f"Data gaps > {DATA_GAP_MIN} min  (Pi offline / complete outage)")
    if not gaps:
        print("  None found.")
    else:
        print(f"  {'Gap start':<26} {'Gap end':<26} {'Minutes':>7}")
        print(f"  {'-'*24} {'-'*24} {'-'*7}")
        for g in gaps:
            print(f"  {fmt_ts(g['last_before']):<26} {fmt_ts(g['first_after']):<26} {g['gap_minutes']:>7}")

    # ── packet-loss outages ───────────────────────────────────────────────────
    runs = find_outage_runs(cur, args.min_loss, args.min_minutes)
    print_section(
        f"Consecutive packet-loss events  "
        f"(≥{args.min_loss}% loss, ≥{args.min_minutes} consecutive minutes)"
    )
    if not runs:
        print("  None found.")
    else:
        hdr = f"  {'Start':<26} {'End':<26} {'Min':>4} {'Samp':>5} {'AvgExtLoss':>10} {'MaxExtLoss':>10} {'AvgRtrLoss':>10} {'Cause':<10}"
        print(hdr)
        print(f"  {'-'*24} {'-'*24} {'-'*4} {'-'*5} {'-'*10} {'-'*10} {'-'*10} {'-'*10}")
        for r in runs:
            print(
                f"  {fmt_ts(r['run_start']):<26} {fmt_ts(r['run_end']):<26}"
                f" {r['duration_min']:>4}"
                f" {r['samples']:>5}"
                f" {str(r['avg_ext_loss'])+'%':>10}"
                f" {str(int(r['max_ext_loss']))+'%':>10}"
                f" {str(r['avg_rtr_loss'])+'%':>10}"
                f"  {cause(r['avg_rtr_loss']):<10}"
            )

        if args.detail:
            for r in runs:
                print(f"\n  ── {fmt_ts(r['run_start'])} → {fmt_ts(r['run_end'])} "
                      f"({r['duration_min']} min, {cause(r['avg_rtr_loss'])}) ──")
                rows = fetch_window(cur, r['run_start'], r['run_end'], DETAIL_WINDOW_MIN)
                in_outage = lambda ts: r['run_start'] <= ts <= r['run_end']
                print(f"  {'Time (UTC)':<22} {'ExtLat':>7} {'RtrLat':>7} {'ExtLoss':>8} {'RtrLoss':>8}")
                print(f"  {'-'*22} {'-'*7} {'-'*7} {'-'*8} {'-'*8}")
                for m in rows:
                    marker = " ◀" if in_outage(m['measuredAt']) else ""
                    ts = m['measuredAt'].astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M")
                    ext_lat = f"{int(m['ext_lat_ms'])}ms" if m['ext_lat_ms'] is not None else "—"
                    rtr_lat = f"{int(m['rtr_lat_ms'])}ms" if m['rtr_lat_ms'] is not None else "—"
                    print(
                        f"  {ts:<22} {ext_lat:>7} {rtr_lat:>7}"
                        f" {str(int(m['ext_loss']))+'%':>8} {str(int(m['rtr_loss']))+'%':>8}"
                        f"{marker}"
                    )

    cur.close()
    conn.close()
    print()


if __name__ == "__main__":
    main()
