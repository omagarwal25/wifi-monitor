import { z } from "zod";

export const MetricSchema = z.object({
  routerLatencyMs: z.number().positive().nullable(),
  externalLatencyMs: z.number().positive().nullable(),
  routerPacketLoss: z.number().min(0).max(100),
  externalPacketLoss: z.number().min(0).max(100),
  routerReachable: z.boolean(),
  externalReachable: z.boolean(),
  measuredAt: z.string().datetime(),
  downloadMbps: z.number().positive().nullable().optional(),
  uploadMbps: z.number().positive().nullable().optional(),
});

export type Metric = z.infer<typeof MetricSchema>;
