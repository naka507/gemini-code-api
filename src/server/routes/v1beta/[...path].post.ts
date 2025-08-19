// src/server/routes/v1beta/[...path].post.ts
import { H3Event, sendStream, getHeader, getHeaders, getMethod, getRequestURL, getQuery, getRouterParam, readBody, setHeaders, setResponseStatus, createError, defineEventHandler } from 'h3';
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
  const isStream = contentType.includes('text/event-stream');
  
  // 获取真实的模型名称
  const realModel = originalPath.split('/')[1]?.split(':')[0] || 'unknown';
  
  let inputTokens = null;
  let outputTokens = null;
  
  if (isStream) {
    // 流式响应处理
    const stream = new ReadableStream({
      async start(controller) {
        const reader = geminiResponse.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        const pump = async (): Promise<void> => {
          try {
            const { done, value } = await reader.read();
            
            if (done) {
              // Log request when stream completes
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
                  isStream: true,
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
              controller.close();
              return;
            }
            
            // Forward chunk immediately
            controller.enqueue(value);
            
            // Accumulate for token extraction
            buffer += decoder.decode(value, { stream: true });
            
            // Parse for token information
            const lines = buffer.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const jsonStr = line.substring(6).trim();
                  if (jsonStr && jsonStr !== '[DONE]') {
                    const data = JSON.parse(jsonStr);
                    if (data.usageMetadata) {
                      inputTokens = data.usageMetadata.promptTokenCount || null;
                      outputTokens = data.usageMetadata.candidatesTokenCount || null;
                    }
                  }
                } catch {}
              }
            }
            
            return pump();
          } catch (error) {
            controller.error(error);
          }
        };
        
        await pump();
      }
    });
    
    // Set response headers for streaming
    setResponseStatus(event, geminiResponse.status);
    for (const [key, value] of geminiResponse.headers.entries()) {
      setHeaders(event, { [key]: value });
    }
    
    return sendStream(event, stream);
  } else {
    // 非流式响应处理
    const responseText = await geminiResponse.text();
    
    try {
      const responseData = JSON.parse(responseText);
      if (responseData.usageMetadata) {
        inputTokens = responseData.usageMetadata.promptTokenCount || null;
        outputTokens = responseData.usageMetadata.candidatesTokenCount || null;
      }
    } catch (e) {
       console.warn('Failed to parse response for token extraction:', e);
     }
     
     // Log entry for non-streaming
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
         isStream: false,
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
     
     return new Response(responseText, { 
       status: geminiResponse.status, 
       statusText: geminiResponse.statusText, 
       headers: geminiResponse.headers 
     });
  }
});


