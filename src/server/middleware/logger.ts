// src/server/middleware/logger.ts
import { getDb } from '~/utils/db';
import { requestLogs } from '~/utils/db/schema';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

export default defineEventHandler(async (event) => {
  const start = Date.now();

  event.context.logData = {
    id: randomUUID(),
    requestTimestamp: new Date().toISOString(),
  };

  // This runs after the route handler
  event.node.res.on('finish', async () => {
    const end = Date.now();
    const responseTimeMs = end - start;

    // Prefer the actual key used by the handler if present
    const usedKey = (event as any).context?.selectedApiKey as string | undefined;
    const apiKey = usedKey || getHeader(event, 'Authorization')?.replace('Bearer ', '') || getHeader(event, 'x-goog-api-key') || (getQuery(event).key as string) || (getQuery(event).api_key as string) || (getQuery(event).apiKey as string);
    const apiKeyHash = apiKey ? createHash('sha256').update(apiKey).digest('hex') : 'none';

    const logEntry = {
      id: event.context.logData.id,
      apiKeyHash,
      model: event.context.logData.model || 'unknown',
      ipAddress: getRequestIP(event, { xForwardedFor: true }),
      statusCode: event.node.res.statusCode,
      requestTimestamp: event.context.logData.requestTimestamp,
      responseTimeMs,
      isStream: event.context.logData.isStream || false,
      userAgent: getHeader(event, 'User-Agent'),
      errorMessage: event.context.logData.errorMessage,
      requestUrl: event.context.logData.requestUrl || event.node.req.url,
      requestModel: event.context.logData.requestModel,
      inputTokens: event.context.logData.inputTokens,
      outputTokens: event.context.logData.outputTokens,
    };

    // Persist the log - handle missing DB binding gracefully
    try {
      const d1 = event.context.cloudflare?.env?.DB;
      if (d1) {
        const db = getDb(d1);
        await db.insert(requestLogs).values(logEntry).execute();
      } else {
        // DB not available, just log to console
        console.log('DB not available, logging to console:', {
          apiKeyHash: logEntry.apiKeyHash,
          model: logEntry.model,
          statusCode: logEntry.statusCode,
          responseTimeMs: logEntry.responseTimeMs
        });
      }
    } catch (e) {
      console.error('Failed to log request:', e);
    }
  });
});
