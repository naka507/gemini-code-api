// src/server/routes/v1/models.get.ts
import openaiHandler from '~/utils/adapter/openai';
import { getDb } from '~/utils/db';
import { requestLogs } from '~/utils/db/schema';
import { createHash, randomUUID } from 'node:crypto';

function getApiKeysFromRequest(event: any): string[] {
  const authHeader = getHeader(event, 'Authorization');
  const googHeader = getHeader(event, 'x-goog-api-key');
  const { key, api_key, apiKey } = getQuery(event) as Record<string, string | undefined>;
  let keys: string[] = [];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    keys = authHeader.substring(7).split(',').map(k => k.trim()).filter(Boolean);
  } else if (googHeader) {
    keys = googHeader.split(',').map(k => k.trim()).filter(Boolean);
  } else if (key || api_key || apiKey) {
    const candidate = key || api_key || apiKey;
    keys = String(candidate).split(',').map(k => k.trim()).filter(Boolean);
  }
  return keys;
}

function selectApiKey(keys: string[]): string | null {
  if (keys.length === 0) return null;
  return keys[Math.floor(Math.random() * keys.length)];
}

export default defineEventHandler(async (event) => {
  const startTime = Date.now();
  
  // 获取API密钥
  const keys = getApiKeysFromRequest(event);
  const selectedKey = selectApiKey(keys);
  const apiKey = selectedKey || process.env.GEMINI_API_KEY;
  
  if (!selectedKey) {
    return createError({ statusCode: 401, statusMessage: 'API key not provided.' });
  }
  
  // 创建请求
  const request = new Request(getRequestURL(event).toString(), {
    method: getMethod(event),
    headers: {
      ...getHeaders(event),
      'Authorization': `Bearer ${apiKey}`
    }
  });
  
  // 使用 openai.mjs 处理 models 请求
  const response = await openaiHandler.fetch(request);
  
  // 设置响应头
  setHeaders(event, {
    'Content-Type': response.headers.get('Content-Type') || 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
  });
  
  // 添加日志记录
  try {
    const d1 = (event as any).context?.cloudflare?.env?.DB;
    if (d1 && selectedKey) {
      const db = getDb(d1);
      const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-forwarded-for') || '127.0.0.1';
      const apiKeyHash = createHash('sha256').update(selectedKey).digest('hex');
      const logEntry = {
        id: randomUUID(),
        apiKeyHash,
        model: 'models-list',
        ipAddress: ip,
        statusCode: response.status,
        requestTimestamp: new Date(startTime).toISOString(),
        responseTimeMs: Date.now() - startTime,
        isStream: false,
        userAgent: getHeader(event, 'user-agent') || 'unknown',
        errorMessage: undefined as any,
        requestUrl: event.node.req.url,
        requestModel: 'models-list',
        inputTokens: null,
        outputTokens: null,
      };
      await db.insert(requestLogs).values(logEntry as any).execute();
    } else {
      // 开发环境下记录到控制台
      const apiKeyHash = createHash('sha256').update(selectedKey).digest('hex');
      console.log('DB not available, logging to console:', {
        apiKeyHash,
        model: 'models-list',
        statusCode: response.status,
        responseTimeMs: Date.now() - startTime
      });
    }
  } catch (error) {
    console.warn('Failed to log models request:', error.message);
  }
  
  return response.body;
});