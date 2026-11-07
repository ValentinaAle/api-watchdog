import { z } from "zod";

export {
  monitorCreateSchema,
  monitorUpdateSchema,
  normalizeMonitorUrl,
} from "./monitor.ts";
export type {
  MonitorCreateInput,
  MonitorHttpMethod,
  MonitorStatus,
  MonitorUpdateInput,
} from "./monitor.ts";

const environmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  MAILPIT_SMTP_HOST: z.string().min(1),
  MAILPIT_SMTP_PORT: z.coerce.number().int().positive(),
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(input: NodeJS.ProcessEnv): Environment {
  return environmentSchema.parse(input);
}
