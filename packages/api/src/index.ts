import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env";
import { metricsRouter } from "./routes/metrics";
import { eventsRouter } from "./routes/events";

const app = new Hono();

app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true }));

app.route("/metrics", metricsRouter);
app.route("/events", eventsRouter);

serve({ fetch: app.fetch, port: env.PORT }, () => {
  console.log(`API running on port ${env.PORT}`);
});
