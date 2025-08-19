// src/server/routes/logs.get.ts
import { getDb } from '~/utils/db';
import { requestLogs } from '~/utils/db/schema';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';

export default defineEventHandler(async (event) => {
  const { apiKey } = getQuery(event);

  if (!apiKey || typeof apiKey !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'API key is required',
    });
  }

  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

  const d1 = event.context.cloudflare.env.DB;
  const db = getDb(d1);

  const logs = await db.select().from(requestLogs).where(eq(requestLogs.apiKeyHash, apiKeyHash)).all();

  return { logs };
});


