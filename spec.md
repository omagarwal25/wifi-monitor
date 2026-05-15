# WiFi Monitor — Claude Code Spec

Build a full-stack WiFi monitoring system. A Raspberry Pi polls network health every minute and POSTs metrics to a Railway-hosted API. A Vite + React dashboard visualises the data with Recharts.

---

## Monorepo Structure

```
wifi-monitor/
├── package.json              ← workspace root
├── packages/
│   ├── api/                  ← Hono + Prisma + Postgres
│   │   ├── package.json
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   └── src/
│   │       ├── index.ts
│   │       └── routes/
│   │           └── metrics.ts
│   └── web/                  ← Vite + React + Recharts
│       ├── package.json
│       ├── vite.config.ts
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           └── components/
│               └── Dashboard.tsx
└── pi/
    └── monitor.py            ← Python cron script for the Pi
```

---

## API (`packages/api`)

### Stack

- **Runtime**: Node.js
- **Framework**: Hono
- **ORM**: Prisma
- **Database**: Postgres (Railway-managed)
- **Validation**: Zod (request body parsing)
- **Env safety**: envsafe (validates all env vars at startup, throws if missing/wrong type)

### Prisma Schema

```prisma
model Metric {
  id                 Int      @id @default(autoincrement())
  measuredAt         DateTime // set by Pi, not server — preserves backfill accuracy
  createdAt          DateTime @default(now())
  routerLatencyMs    Float?   // null = total dropout
  externalLatencyMs  Float?
  routerPacketLoss   Float    // 0–100 %
  externalPacketLoss Float    // 0–100 %
  routerReachable    Boolean
  externalReachable  Boolean

  @@index([measuredAt])
}
```

### Environment & Validation

**envsafe** — call at the top of `src/env.ts`, import and use throughout instead of `process.env` directly:

```typescript
import { envsafe, str, port } from "envsafe";

export const env = envsafe({
  DATABASE_URL: str(),
  API_KEY: str(),
  PORT: port({ default: 3000 }),
});
```

**Zod** — define a shared schema for the metric payload in `src/schemas.ts`:

```typescript
import { z } from "zod";

export const MetricSchema = z.object({
  routerLatencyMs: z.number().positive().nullable(),
  externalLatencyMs: z.number().positive().nullable(),
  routerPacketLoss: z.number().min(0).max(100),
  externalPacketLoss: z.number().min(0).max(100),
  routerReachable: z.boolean(),
  externalReachable: z.boolean(),
  // Pi also sends the measured-at timestamp so backfilled rows use the correct time
  measuredAt: z.string().datetime(),
});

export type Metric = z.infer<typeof MetricSchema>;
```

Use `MetricSchema.parse(await c.req.json())` in the POST handler — return 400 on ZodError.

### Endpoints

#### `POST /metrics`

Accepts a JSON body from the Pi. Writes a new `Metric` row.

Request body:

```json
{
  "measuredAt": "2026-05-15T10:00:00Z",
  "routerLatencyMs": 3.2,
  "externalLatencyMs": 14.7,
  "routerPacketLoss": 0,
  "externalPacketLoss": 0,
  "routerReachable": true,
  "externalReachable": true
}
```

Response: `{ "ok": true }`

Protected by a static API key passed as `Authorization: Bearer <API_KEY>` header. Key is read from `process.env.API_KEY`.

#### `GET /metrics`

Returns the last N metrics (default 720 = 12 hours at 1/min). Accepts optional query param `?limit=N`.

Response:

```json
[
  {
    "id": 1,
    "createdAt": "2026-05-15T10:00:00Z",
    "routerLatencyMs": 3.2,
    "externalLatencyMs": 14.7,
    "routerPacketLoss": 0,
    "externalPacketLoss": 0,
    "routerReachable": true,
    "externalReachable": true
  }
]
```

Results ordered oldest → newest (for charting left-to-right).

#### `GET /health`

Returns `{ "ok": true }`. No auth required.

### Environment Variables (API)

```
DATABASE_URL=postgresql://...
API_KEY=<random secret>
PORT=3000
```

---

## Frontend (`packages/web`)

### Stack

- **Bundler**: Vite
- **Framework**: React + TypeScript
- **Charts**: Recharts
- **Styling**: Plain CSS (no Tailwind) — see aesthetic notes below

### Aesthetic Direction

Dark theme. Utilitarian/industrial — this is a network diagnostics tool, not a marketing page. Think terminal-adjacent but clean. Monospace font for metric values. Tight, dense layout. Accent colour: a sharp amber/yellow (`#F5A623`) against a near-black background (`#0D0D0D`). No rounded corners on chart containers. Subtle grid lines only.

### Dashboard Features

1. **Status banner** — top of page. Shows current state based on the most recent metric:

   - 🟢 All good
   - 🟡 ISP issue (router reachable, external not)
   - 🔴 Router/WiFi issue (router not reachable)

2. **Latency chart** — `ComposedChart` from Recharts:

   - Line for `routerLatencyMs` (amber)
   - Line for `externalLatencyMs` (white/dim)
   - Reference areas highlighting dropout periods (where `routerReachable === false` or `externalReachable === false`)
   - X-axis: time (formatted as HH:mm)
   - Y-axis: ms

3. **Packet loss chart** — simple `AreaChart`:

   - `routerPacketLoss` and `externalPacketLoss` as two areas
   - Y-axis: 0–100%

4. **Summary stats** — row of stat cards below charts:

   - Uptime % (last 24h)
   - Avg latency to router
   - Avg latency to external
   - Total dropout events (periods where external was unreachable)

5. **Time range selector** — buttons: Last 1h / 6h / 12h / 24h. Changes the `?limit=` param on the API call.

### API Base URL

Read from `import.meta.env.VITE_API_URL` — set this in Railway env vars pointing at the API service URL.

### Data Fetching

Poll `GET /metrics?limit=N` every 60 seconds. No auth needed on the GET endpoint.

---

## Pi Script (`pi/monitor.py`)

### Behaviour

Runs every minute via cron. Pings two targets:

- Router: `192.168.1.1` (10 packets)
- External: `1.1.1.1` (10 packets)

Parses avg latency and packet loss from `ping` output. Writes the metric to a **local SQLite DB first**, then attempts to flush all unpushed rows to Railway. This means outage data is never lost — it backfills automatically when connectivity is restored.

### Local SQLite Schema

```sql
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
);
```

### Run Order (each cron tick)

1. Collect ping metrics for both targets
2. Write new row to local SQLite with `pushed = 0`
3. Query all rows where `pushed = 0`, ordered by `measured_at` ascending
4. For each unpushed row, attempt `POST /metrics` to Railway
   - On success: mark row `pushed = 1`
   - On failure (no internet): stop flushing, leave rows unpushed
5. Log result to `cron.log`

### Key Details

- If ping completely fails (host unreachable), set `reachable: false`, `latencyMs: null`, `packetLoss: 100`
- Read API URL and key from a local `.env` file (`python-dotenv`)
- Dependencies: `requests`, `python-dotenv`, `sqlite3` (stdlib)
- Log errors to `/home/pi/wifi-monitor/errors.log`
- Backfill sends rows one at a time (not batched) to keep the POST handler simple

### Environment Variables (Pi)

```
API_URL=https://your-api.up.railway.app
API_KEY=<same secret as API>
ROUTER_IP=192.168.1.1
```

### Cron entry

```
* * * * * /usr/bin/python3 /home/pi/wifi-monitor/monitor.py >> /home/pi/wifi-monitor/cron.log 2>&1
```

---

## Pi Zero W Setup (`pi/Makefile`)

Target OS: **Raspberry Pi OS Lite (64-bit)**, pre-configured in Raspberry Pi Imager before flashing (WiFi credentials, SSH key, hostname). No monitor or keyboard needed.

The Makefile is run once over SSH after first boot. It handles everything — no manual steps beyond filling in `.env`.

```makefile
.PHONY: install cron update logs errors status clean

install:
	sudo apt update && sudo apt install -y python3-pip git sqlite3
	pip3 install requests python-dotenv
	cp -n .env.example .env
	@echo "-----"
	@echo "Edit .env with your API_URL and API_KEY, then run: make cron"
	@echo "-----"

cron:
	(crontab -l 2>/dev/null; echo "* * * * * /usr/bin/python3 $(PWD)/monitor.py >> $(PWD)/cron.log 2>&1") | crontab -
	@echo "Cron job installed."

update:
	git pull
	pip3 install -r requirements.txt

logs:
	tail -f cron.log

errors:
	tail -f errors.log

status:
	@echo "=== Cron ===" && crontab -l
	@echo "=== Last 5 rows ===" && sqlite3 metrics.db \
		"SELECT measured_at, router_reachable, external_reachable, router_latency_ms, external_latency_ms FROM metrics ORDER BY id DESC LIMIT 5;"
	@echo "=== Unpushed rows ===" && sqlite3 metrics.db \
		"SELECT COUNT(*) FROM metrics WHERE pushed = 0;"

clean:
	rm -f metrics.db cron.log errors.log
```

### First boot workflow

```bash
git clone https://github.com/you/wifi-monitor
cd wifi-monitor/pi
make install
nano .env        # paste API_URL and API_KEY
make cron
```

After that: `make update` to pull changes, `make status` to inspect the DB, `make logs` to tail the cron output.

---

## Railway Deployment

Two services from the same GitHub repo:

### Service 1: `wifi-monitor-api`

- Root directory: `packages/api`
- Build command: `npm install && npx prisma generate && npx prisma migrate deploy && npm run build`
- Start command: `node dist/index.js`
- Env vars: `DATABASE_URL`, `API_KEY`, `PORT`
- Attach a Railway Postgres plugin — `DATABASE_URL` is injected automatically

### Service 2: `wifi-monitor-web`

- Root directory: `packages/web`
- Build command: `npm install && npm run build`
- Start command: serve `dist/` as static — use Railway's static site option or a tiny `serve` script
- Env vars: `VITE_API_URL` (set to the API service's public URL)

---

## Notes

- CORS: the API should allow requests from the web service's domain. Use Hono's CORS middleware.
- The `POST /metrics` endpoint requires the `Authorization: Bearer` header. The `GET /metrics` endpoint does not (dashboard fetches publicly).
- Prisma migrations: run `npx prisma migrate dev --name init` locally to generate the initial migration, commit the `prisma/migrations/` folder.
- The Pi script should be tested manually before adding to cron: `python3 monitor.py` should print the JSON payload it's about to send.
