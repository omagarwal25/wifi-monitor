import { Hono } from "hono";
import { PrismaClient } from "@prisma/client";
import { env } from "../env";

const prisma = new PrismaClient();

export const eventsRouter = new Hono();

eventsRouter.get("/", async (c) => {
  const events = await prisma.piEvent.findMany({
    orderBy: { occurredAt: "asc" },
    select: { id: true, occurredAt: true, label: true },
  });
  return c.json(events);
});

eventsRouter.post("/", async (c) => {
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

  const { occurredAt, label } = body as { occurredAt?: string; label?: string };
  if (!occurredAt || !label) {
    return c.json({ error: "occurredAt and label are required" }, 400);
  }

  const event = await prisma.piEvent.create({
    data: { occurredAt: new Date(occurredAt), label },
  });

  return c.json(event, 201);
});
