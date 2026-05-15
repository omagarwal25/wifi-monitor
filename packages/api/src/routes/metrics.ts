import { Hono } from "hono";
import { ZodError } from "zod";
import { PrismaClient } from "@prisma/client";
import { env } from "../env";
import { MetricSchema } from "../schemas";

const prisma = new PrismaClient();

export const metricsRouter = new Hono();

metricsRouter.post("/", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (authHeader !== `Bearer ${env.API_KEY}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  let data;
  try {
    data = MetricSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return c.json({ error: "Validation error", issues: err.issues }, 400);
    }
    throw err;
  }

  await prisma.metric.create({
    data: {
      measuredAt: new Date(data.measuredAt),
      routerLatencyMs: data.routerLatencyMs,
      externalLatencyMs: data.externalLatencyMs,
      routerPacketLoss: data.routerPacketLoss,
      externalPacketLoss: data.externalPacketLoss,
      routerReachable: data.routerReachable,
      externalReachable: data.externalReachable,
      downloadMbps: data.downloadMbps ?? null,
      uploadMbps: data.uploadMbps ?? null,
    },
  });

  return c.json({ ok: true });
});

metricsRouter.get("/", async (c) => {
  const limitParam = c.req.query("limit");
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), 10000) : 720;

  const metrics = await prisma.metric.findMany({
    orderBy: { measuredAt: "asc" },
    take: limit,
    select: {
      id: true,
      measuredAt: true,
      createdAt: true,
      routerLatencyMs: true,
      externalLatencyMs: true,
      routerPacketLoss: true,
      externalPacketLoss: true,
      routerReachable: true,
      externalReachable: true,
      downloadMbps: true,
      uploadMbps: true,
    },
  });

  return c.json(metrics);
});
