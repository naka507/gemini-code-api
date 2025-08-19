// src/server/routes/v1beta/[...path].post.ts
import type { H3Event } from 'h3';
import { getDb } from '~/utils/db';
import { requestLogs } from '~/utils/db/schema';
import { createHash, randomUUID } from 'node:crypto';

function getApiKeysFromRequest(event: H3Event): string[] {
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
  const originalPath = getRouterParam(event, 'path') || '';
  const requestBody = await readBody(event);

  const clientApiKeys = getApiKeysFromRequest(event);
  const selectedKey = selectApiKey(clientApiKeys);
  if (!selectedKey) {
    return createError({ statusCode: 401, statusMessage: 'API key not provided.' });
  }

  (event as any).context.selectedApiKey = selectedKey;

  const targetUrl = `https://generativelanguage.googleapis.com/v1beta/${originalPath}${getRequestURL(event).search}`;

  const geminiResponse = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': selectedKey },
    body: JSON.stringify(requestBody ?? {}),
  });

  const contentType = geminiResponse.headers.get('Content-Type') || 'application/json';
  const responseHeaders = new Headers({ 'Content-Type': contentType });
  const isStream = contentType.includes('text/event-stream');
  
  // 获取真实的模型名称
  const realModel = originalPath.split('/')[1]?.split(':')[0] || 'unknown';
  
  // 读取响应内容以提取token信息
  let responseBody = geminiResponse.body;
  let inputTokens = null;
  let outputTokens = null;
  
  if (geminiResponse.ok) {
    try {
      const responseText = await geminiResponse.text();
      
      if (isStream) {
        // 处理流式响应，解析SSE数据
        const lines = responseText.split('\n');
        for (const line of lines.reverse()) { // 从后往前查找usageMetadata
          if (line.startsWith('data: ')) {
            try {
              const jsonStr = line.substring(6).trim();
              if (jsonStr && jsonStr !== '[DONE]') {
                const data = JSON.parse(jsonStr);
                if (data.usageMetadata && data.usageMetadata.candidatesTokenCount) {
                  inputTokens = data.usageMetadata.promptTokenCount || null;
                  outputTokens = data.usageMetadata.candidatesTokenCount || null;
                  break;
                }
              }
            } catch (e) {
              // 忽略解析错误，继续查找
            }
          }
        }
      } else {
        // 处理非流式响应
        const responseData = JSON.parse(responseText);
        if (responseData.usageMetadata) {
          inputTokens = responseData.usageMetadata.promptTokenCount || null;
          outputTokens = responseData.usageMetadata.candidatesTokenCount || null;
        }
      }
      
      // 重新创建响应体
      responseBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(responseText));
          controller.close();
        }
      });
    } catch (e) {
      // 如果解析失败，保持原始响应体
      console.warn('Failed to parse response for token extraction:', e);
    }
  }

  // Log entry
  try {
    const d1 = (event as any).context.cloudflare.env.DB;
    const db = getDb(d1);
    const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-forwarded-for');
    const apiKeyHash = createHash('sha256').update(selectedKey).digest('hex');
    
    const logEntry = {
      id: randomUUID(),
      apiKeyHash,
      model: realModel,
      ipAddress: ip,
      statusCode: geminiResponse.status,
      requestTimestamp: new Date(startTime).toISOString(),
      responseTimeMs: Date.now() - startTime,
      isStream,
      userAgent: getHeader(event, 'user-agent'),
      errorMessage: undefined as any,
      requestUrl: event.node.req.url,
      requestModel: realModel,
      inputTokens,
      outputTokens,
    };
    await db.insert(requestLogs).values(logEntry as any).execute();
  } catch (e) {
    console.warn('Failed to log request:', e);
  }

  return new Response(responseBody, { status: geminiResponse.status, statusText: geminiResponse.statusText, headers: responseHeaders });
});


