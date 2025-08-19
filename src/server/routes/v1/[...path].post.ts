// src/server/routes/v1/[...path].post.ts
import { H3Event, sendStream, getHeader, getHeaders, getMethod, getRequestURL, getQuery, getRouterParam, readBody, setHeaders, setResponseStatus, createError, defineEventHandler } from 'h3';
import openaiHandler from '~/utils/adapter/openai';
import claudeHandler from '~/utils/adapter/claude';
import { getDb } from '~/utils/db';
import { requestLogs } from '~/utils/db/schema';
import { createHash, randomUUID } from 'node:crypto';

// Simple transformation functions for Gemini to OpenAI format
function geminiToOpenai(geminiBody: any): any {
  // Basic transformation - this is a simplified version
  // In a real implementation, you'd want more comprehensive transformation
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-3.5-turbo',
    choices: geminiBody.candidates?.map((candidate: any, index: number) => ({
      index,
      message: {
        role: 'assistant',
        content: candidate.content?.parts?.[0]?.text || ''
      },
      finish_reason: candidate.finishReason === 'STOP' ? 'stop' : 'length'
    })) || [],
    usage: {
      prompt_tokens: geminiBody.usageMetadata?.promptTokenCount || 0,
      completion_tokens: geminiBody.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: geminiBody.usageMetadata?.totalTokenCount || 0
    }
  };
}

function geminiToOpenaiStream(model: string): TransformStream {
  return new TransformStream({
    transform(chunk, controller) {
      // Basic stream transformation - simplified version
      const decoder = new TextDecoder();
      const text = decoder.decode(chunk);
      
      // Process SSE data
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            const openaiChunk = {
              id: `chatcmpl-${randomUUID()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'gpt-3.5-turbo',
              choices: data.candidates?.map((candidate: any, index: number) => ({
                index,
                delta: {
                  content: candidate.content?.parts?.[0]?.text || ''
                },
                finish_reason: candidate.finishReason === 'STOP' ? 'stop' : null
              })) || []
            };
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
          } catch (e) {
            // Pass through non-JSON lines
            controller.enqueue(chunk);
          }
        } else {
          controller.enqueue(new TextEncoder().encode(line + '\n'));
        }
      }
    }
  });
}

// --- Helper functions ---
function getApiKeysFromRequest(event: H3Event): string[] {
  const authHeader = getHeader(event, 'Authorization');
  const googHeader = getHeader(event, 'x-goog-api-key');
  const claudeHeader = getHeader(event, 'x-api-key');
  const { key, api_key, apiKey } = getQuery(event) as Record<string, string | undefined>;
  let keys: string[] = [];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    keys = authHeader.substring(7).split(',').map(k => k.trim()).filter(Boolean);
  } else if (googHeader) {
    keys = googHeader.split(',').map(k => k.trim()).filter(Boolean);
  } else if (claudeHeader) {
    keys = claudeHeader.split(',').map(k => k.trim()).filter(Boolean);
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
// ---

export default defineEventHandler(async (event) => {
  const startTime = Date.now();
  const originalPath = getRouterParam(event, 'path') || '';

  // Handle Claude messages first (direct return)
  if (originalPath === 'messages' || originalPath.startsWith('messages/')) {
    const requestBody = await readBody(event);
    const keys = getApiKeysFromRequest(event);
    const selectedKey = selectApiKey(keys);
    
    if (!selectedKey) {
      return createError({ statusCode: 401, statusMessage: 'API key not provided.' });
    }
    
    // 确保包含必需的 Anthropic API 头部
    const requestHeaders = {
      ...getHeaders(event),
      'Authorization': `Bearer ${selectedKey}`,
      'x-api-key': selectedKey,
      'anthropic-version': '2023-06-01'  // 添加必需的版本头
    };
    
    const request = new Request(getRequestURL(event).toString(), {
      method: getMethod(event),
      headers: requestHeaders,
      body: JSON.stringify(requestBody)
    });
    
    const response = await claudeHandler.fetch(request, event.context.cloudflare?.env);
    
    // 设置必需的 Anthropic API 响应头
    const responseHeaders: Record<string, string> = {
      'Content-Type': response.headers.get('Content-Type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
      'request-id': response.headers.get('request-id') || `req_${randomUUID()}`,
      'anthropic-version': '2023-06-01'
    };
    
    // 如果是流式响应，添加流式响应头
    if (requestBody.stream) {
      responseHeaders['Cache-Control'] = 'no-cache';
      responseHeaders['Connection'] = 'keep-alive';
      responseHeaders['X-Accel-Buffering'] = 'no';
    }
    
    setHeaders(event, responseHeaders);
    
    const isStream = !!requestBody.stream;
    let responseText = '';
    let inputTokens = null;
    let outputTokens = null;
    
    // 对于非流式响应，先读取内容以提取token信息
    if (!isStream && response.ok && response.body) {
      try {
        responseText = await response.text();
        const responseData = JSON.parse(responseText);
        
        // 提取token信息
        if (responseData.usage) {
          inputTokens = responseData.usage.input_tokens || null;
          outputTokens = responseData.usage.output_tokens || null;
        }
      } catch (e) {
        console.warn('Failed to parse Claude response for token extraction:', e);
      }
    } else if (isStream && response.ok && response.body) {
      // 对于流式响应，解析SSE数据以提取token信息
      try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const chunks: Uint8Array[] = [];
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          chunks.push(value);
          buffer += decoder.decode(value, { stream: true });
        }
        
        // 解析message_delta事件以提取token信息
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && line.includes('message_delta')) {
            try {
              const data = JSON.parse(line.substring(6));
              if (data.type === 'message_delta' && data.usage) {
                outputTokens = data.usage.output_tokens || null;
              }
            } catch (e) {
              // 继续查找下一行
            }
          } else if (line.startsWith('data: ') && line.includes('message_start')) {
            try {
              const data = JSON.parse(line.substring(6));
              if (data.type === 'message_start' && data.message && data.message.usage) {
                inputTokens = data.message.usage.input_tokens || null;
              }
            } catch (e) {
              // 继续查找下一行
            }
          }
        }
        
        // 重新创建响应体
        response = new Response(new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk);
            }
            controller.close();
          }
        }), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      } catch (e) {
        console.warn('Failed to parse Claude streaming response for token extraction:', e);
      }
    }
    
    // 添加日志记录
    try {
      const d1 = (event as any).context?.cloudflare?.env?.DB;
      if (d1) {
        const db = getDb(d1);
        const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-forwarded-for') || '127.0.0.1';
        const apiKeyHash = createHash('sha256').update(selectedKey).digest('hex');
        const clientModel = requestBody.model || 'claude-3-sonnet-20240229';
        
        // 获取映射后的实际Gemini模型名称
        const MODEL_MAP: Record<string, string> = {
          'claude-sonnet-4-20250514': 'gemini-2.5-flash',
          'claude-opus-4-20250514': 'gemini-2.5-pro',
        };
        const actualGeminiModel = MODEL_MAP[clientModel] || 'gemini-2.0-flash';
        
        const logEntry = {
          id: randomUUID(),
          apiKeyHash,
          model: actualGeminiModel, // 记录实际的Gemini模型
          ipAddress: ip,
          statusCode: response.status,
          requestTimestamp: new Date(startTime).toISOString(),
          responseTimeMs: Date.now() - startTime,
          isStream,
          userAgent: getHeader(event, 'user-agent') || 'unknown',
          errorMessage: undefined as any,
          requestUrl: event.node.req.url,
          requestModel: clientModel, // 记录客户端提交的模型
          inputTokens,
          outputTokens,
        };
        // fire-and-forget
        await db.insert(requestLogs).values(logEntry as any).execute();
      }
    } catch (error) {
      // Silently ignore logging errors in development
      console.warn('Failed to log Claude request:', error.message);
    }
    
    // 正确处理响应体
    if (response.body) {
      // 对于流式响应，使用 sendStream 处理
      if (isStream) {
        setResponseStatus(event, response.status);
        return sendStream(event, response.body);
      } else {
        // 对于非流式响应，返回已读取的文本
        setResponseStatus(event, response.status);
        return responseText || await response.text();
      }
    } else {
      setResponseStatus(event, response.status || 500);
      return { error: 'No response body from Claude handler' };
    }
  }

  // 1. Identify protocol and adapt request for remaining endpoints
  const requestBody = await readBody(event);
  let geminiRequest: { body: any; model: string; stream: boolean };
  let finalBody: any;
  let protocol = 'gemini';

  if (originalPath.startsWith('chat/completions')) {
    // 使用 openai.mjs 处理 OpenAI 兼容请求
    const keys = getApiKeysFromRequest(event);
    const selectedKey = selectApiKey(keys);
    const apiKey = selectedKey || process.env.GEMINI_API_KEY;
    const request = new Request(getRequestURL(event).toString(), {
      method: getMethod(event),
      headers: {
        ...getHeaders(event),
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });
    
    const response = await openaiHandler.fetch(request);
    
    // 设置响应头
    setHeaders(event, {
      'Content-Type': response.headers.get('Content-Type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
    });
    
    const isStream = !!requestBody.stream;
    let responseBody = response.body;
    let inputTokens = null;
    let outputTokens = null;
    
    // 对于非流式响应，先读取内容以提取token信息
    if (!isStream && response.ok) {
      try {
        const responseText = await response.text();
        const responseData = JSON.parse(responseText);
        
        // 提取token信息
        if (responseData.usage) {
          inputTokens = responseData.usage.prompt_tokens || null;
          outputTokens = responseData.usage.completion_tokens || null;
        }
        
        // 重新创建响应体
        responseBody = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(responseText));
            controller.close();
          }
        });
      } catch (e) {
        console.warn('Failed to parse OpenAI response for token extraction:', e);
      }
    } else if (isStream && response.ok && response.body) {
      // 对于流式响应，解析SSE数据以提取token信息
      try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const chunks: Uint8Array[] = [];
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          chunks.push(value);
          buffer += decoder.decode(value, { stream: true });
        }
        
        // 解析最后的chunk以提取token信息
        const lines = buffer.split('\n').reverse();
        for (const line of lines) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const data = JSON.parse(line.substring(6));
              if (data.usage) {
                inputTokens = data.usage.prompt_tokens || null;
                outputTokens = data.usage.completion_tokens || null;
                break;
              }
            } catch (e) {
              // 继续查找下一行
            }
          }
        }
        
        // 重新创建响应体
        responseBody = new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk);
            }
            controller.close();
          }
        });
      } catch (e) {
        console.warn('Failed to parse OpenAI streaming response for token extraction:', e);
      }
    }
    
    // 添加日志记录
    try {
      const d1 = (event as any).context?.cloudflare?.env?.DB;
      if (d1 && selectedKey) {
        const db = getDb(d1);
        const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-forwarded-for') || '127.0.0.1';
        const apiKeyHash = createHash('sha256').update(selectedKey).digest('hex');
        const clientModel = requestBody.model || 'gpt-3.5-turbo';
        
        // 获取映射后的实际Gemini模型名称
        let actualGeminiModel = 'gemini-2.5-flash'; // 默认模型
        if (typeof clientModel === 'string') {
          if (clientModel.startsWith('models/')) {
            actualGeminiModel = clientModel.substring(7);
          } else if (clientModel.startsWith('gemini-') || clientModel.startsWith('gemma-') || clientModel.startsWith('learnlm-')) {
            actualGeminiModel = clientModel;
          }
        }
        
        const logEntry = {
          id: randomUUID(),
          apiKeyHash,
          model: actualGeminiModel, // 记录实际的Gemini模型
          ipAddress: ip,
          statusCode: response.status,
          requestTimestamp: new Date(startTime).toISOString(),
          responseTimeMs: Date.now() - startTime,
          isStream,
          userAgent: getHeader(event, 'user-agent') || 'unknown',
          errorMessage: undefined as any,
          requestUrl: event.node.req.url,
          requestModel: clientModel, // 记录客户端提交的模型
          inputTokens,
          outputTokens,
        };
        await db.insert(requestLogs).values(logEntry as any).execute();
      }
    } catch (error) {
      console.warn('Failed to log OpenAI chat request:', error.message);
    }
    
    return new Response(responseBody, { status: response.status, statusText: response.statusText, headers: response.headers });
  } else if (originalPath.startsWith('embeddings')) {
    // 使用 openai.mjs 处理 embeddings 请求
    const keys = getApiKeysFromRequest(event);
    const selectedKey = selectApiKey(keys);
    const apiKey = selectedKey || process.env.GEMINI_API_KEY;
    const request = new Request(getRequestURL(event).toString(), {
      method: getMethod(event),
      headers: {
        ...getHeaders(event),
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });
    
    const response = await openaiHandler.fetch(request);
    
    // 设置响应头
    setHeaders(event, {
      'Content-Type': response.headers.get('Content-Type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
    });
    
    // 添加日志记录
    try {
      const d1 = (event as any).context?.cloudflare?.env?.DB;
      if (d1 && selectedKey) {
        const db = getDb(d1);
        const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-forwarded-for') || '127.0.0.1';
        const apiKeyHash = createHash('sha256').update(selectedKey).digest('hex');
        const model = requestBody.model || 'text-embedding-ada-002';
        
        // 尝试从响应中提取token信息
        let inputTokens = null;
        let outputTokens = null;
        try {
          if (response.body) {
            const responseText = await response.clone().text();
            const responseData = JSON.parse(responseText);
            if (responseData.usage) {
              inputTokens = responseData.usage.prompt_tokens || responseData.usage.total_tokens;
              // embeddings通常没有output tokens
            }
          }
        } catch (e) {
          // 忽略token提取错误
        }
        
        const logEntry = {
          id: randomUUID(),
          apiKeyHash,
          model,
          ipAddress: ip,
          statusCode: response.status,
          requestTimestamp: new Date(startTime).toISOString(),
          responseTimeMs: Date.now() - startTime,
          isStream: false,
          userAgent: getHeader(event, 'user-agent') || 'unknown',
          errorMessage: undefined as any,
          requestUrl: event.node.req.url,
          requestModel: model,
          inputTokens,
          outputTokens,
        };
        await db.insert(requestLogs).values(logEntry as any).execute();
      }
    } catch (error) {
      console.warn('Failed to log embeddings request:', error.message);
    }
    
    return response.body;
  } else if (originalPath.startsWith('models')) {
    // 使用 openai.mjs 处理 models 请求
    const keys = getApiKeysFromRequest(event);
    const selectedKey = selectApiKey(keys);
    const apiKey = selectedKey || process.env.GEMINI_API_KEY;
    const request = new Request(getRequestURL(event).toString(), {
      method: getMethod(event),
      headers: {
        ...getHeaders(event),
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
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
      }
    } catch (error) {
      console.warn('Failed to log models request:', error.message);
    }
    
    return response.body;
  } else { // Native Gemini
    const modelFromPath = originalPath.split('/')[1]?.split(':')[0] || 'gemini-pro';
    geminiRequest = { body: requestBody, model: modelFromPath, stream: originalPath.includes('stream') };
    finalBody = requestBody;
  }

  // 2. Perform the proxy request
  const clientApiKeys = getApiKeysFromRequest(event);
  const selectedKey = selectApiKey(clientApiKeys);
  if (!selectedKey) {
    return createError({ statusCode: 401, statusMessage: 'API key not provided.' });
  }

  // Expose the actual key used to the logger middleware
  // so the hashed value matches queries in /logs.
  // Do not log the raw key; the middleware will hash it.
  (event as any).context.selectedApiKey = selectedKey;

  event.context.logData.model = geminiRequest.model;
  event.context.logData.isStream = geminiRequest.stream;

  // Build target URL based on protocol
  let targetUrl: string;
  if (protocol === 'openai') {
    const op = geminiRequest.stream ? 'streamGenerateContent' : 'generateContent';
    const alt = geminiRequest.stream ? '?alt=sse' : '';
    targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiRequest.model)}:${op}${alt}`;
  } else if (protocol === 'openai-embeddings') {
    // OpenAI embeddings -> batchEmbedContents
    const model = (requestBody?.model && typeof requestBody.model === 'string') ? requestBody.model : 'text-embedding-004';
    const inputs = Array.isArray(requestBody?.input) ? requestBody.input : [requestBody?.input];
    const reqs = inputs.map((text: string) => ({
      model: `models/${model.startsWith('models/') ? model.substring(7) : model}`,
      content: { parts: { text } },
      outputDimensionality: requestBody?.dimensions,
    }));
    finalBody = { requests: reqs } as any;
    targetUrl = 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents';
  } else {
    // Native Gemini passthrough, preserve any query string
    const search = getRequestURL(event).search;
    targetUrl = `https://generativelanguage.googleapis.com/v1beta/${originalPath}${search}`;
  }

  // Use mock server in development for testing (only in local development)
  // const isDev = process.env.NODE_ENV === 'development' && !process.env.CF_PAGES;
  // if (isDev && targetUrl.includes('generativelanguage.googleapis.com')) {
  //   targetUrl = targetUrl.replace('https://generativelanguage.googleapis.com/v1beta/', 'http://localhost:8080/');
  // }

  const geminiResponse = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': selectedKey },
    body: JSON.stringify(finalBody),
  });

  // 3. **Explicitly Reconstruct the Response**
  const responseHeaders = new Headers();
  
  // Handle errors from Gemini
  if (!geminiResponse.ok) {
    const errorBody = await geminiResponse.text();
    let errorResponse;
    
    try {
      const geminiError = JSON.parse(errorBody);
      // Convert Gemini error to protocol-specific format
      if (protocol === 'openai') {
        errorResponse = {
          error: {
            message: geminiError.error?.message || 'Request failed',
            type: 'invalid_request_error',
            code: geminiError.error?.code || 'unknown_error'
          }
        };
      } else if (protocol === 'claude') {
        errorResponse = {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: geminiError.error?.message || 'Request failed'
          }
        };
      } else {
        errorResponse = geminiError;
      }
    } catch {
      // Fallback for non-JSON errors
      errorResponse = { error: { message: errorBody || 'Request failed' } };
    }
    
    responseHeaders.set('Content-Type', 'application/json');
    return new Response(JSON.stringify(errorResponse), {
      status: geminiResponse.status,
      statusText: geminiResponse.statusText,
      headers: responseHeaders,
    });
  }
  
  responseHeaders.set('Content-Type', geminiResponse.headers.get('Content-Type') || 'application/json');

  // Handle successful responses
  if (geminiRequest.stream) {
    let transformer;
    let finalStream = geminiResponse.body;
    responseHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
    responseHeaders.set('Cache-Control', 'no-cache');
    responseHeaders.set('Connection', 'keep-alive');
    responseHeaders.set('X-Accel-Buffering', 'no');

    if (protocol === 'openai') {
      transformer = geminiToOpenaiStream(geminiRequest.model);
      finalStream = geminiResponse.body?.pipeThrough(transformer);
    }
    // Async log for streaming
    try {
      const d1 = (event as any).context?.cloudflare?.env?.DB;
      if (d1) {
        const db = getDb(d1);
        const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-forwarded-for') || '127.0.0.1';
        const apiKeyHash = createHash('sha256').update(selectedKey).digest('hex');
        const logEntry = {
          id: randomUUID(),
          apiKeyHash,
          model: geminiRequest.model,
          ipAddress: ip,
          statusCode: geminiResponse.status,
          requestTimestamp: new Date(startTime).toISOString(),
          responseTimeMs: Date.now() - startTime,
          isStream: true,
          userAgent: getHeader(event, 'user-agent') || 'unknown',
          errorMessage: undefined as any,
          requestUrl: event.node.req.url,
          requestModel: geminiRequest.model,
          inputTokens: null, // 流式响应无法获取token信息
          outputTokens: null,
        };
        // fire-and-forget
        await db.insert(requestLogs).values(logEntry as any).execute();
      }
    } catch (error) {
      // Silently ignore logging errors in development
      console.warn('Failed to log request:', error.message);
    }
    return new Response(finalStream, { status: 200, headers: responseHeaders });
  } else {
    const geminiBody = await geminiResponse.json();
    let finalResponseBody;
    switch (protocol) {
      case 'openai':
        finalResponseBody = geminiToOpenai(geminiBody);
        responseHeaders.set('Content-Type', 'application/json');
        break;
      case 'openai-embeddings':
        // Handle embeddings response format
        const embeddings = geminiBody.embeddings || [];
        finalResponseBody = {
          object: 'list',
          data: embeddings.map((emb: any, index: number) => ({
            object: 'embedding',
            embedding: emb.values || [],
            index: index
          })),
          model: 'text-embedding-004',
          usage: {
            prompt_tokens: geminiBody.usage?.promptTokenCount || 0,
            total_tokens: geminiBody.usage?.totalTokenCount || 0
          }
        };
        responseHeaders.set('Content-Type', 'application/json');
        break;
      default:
        finalResponseBody = geminiBody;
        responseHeaders.set('Content-Type', 'application/json');
    }
    // Log non-stream
    try {
      const d1 = (event as any).context?.cloudflare?.env?.DB;
      if (d1) {
        const db = getDb(d1);
        const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-forwarded-for') || '127.0.0.1';
        const apiKeyHash = createHash('sha256').update(selectedKey).digest('hex');
        
        // 尝试从原始Gemini响应中提取token信息
        let inputTokens = null;
        let outputTokens = null;
        try {
          if (geminiBody && geminiBody.usageMetadata) {
            inputTokens = geminiBody.usageMetadata.promptTokenCount || null;
            outputTokens = geminiBody.usageMetadata.candidatesTokenCount || null;
          }
        } catch (e) {
          // 忽略token提取错误
          console.warn('Failed to extract token usage:', e);
        }
        
        const logEntry = {
          id: randomUUID(),
          apiKeyHash,
          model: geminiRequest.model,
          ipAddress: ip,
          statusCode: 200,
          requestTimestamp: new Date(startTime).toISOString(),
          responseTimeMs: Date.now() - startTime,
          isStream: false,
          userAgent: getHeader(event, 'user-agent') || 'unknown',
          errorMessage: undefined as any,
          requestUrl: event.node.req.url,
          requestModel: geminiRequest.model,
          inputTokens,
          outputTokens,
        };
        await db.insert(requestLogs).values(logEntry as any).execute();
      }
    } catch (error) {
      // Silently ignore logging errors in development
      console.warn('Failed to log request:', error.message);
    }
    return new Response(JSON.stringify(finalResponseBody), { status: 200, headers: responseHeaders });
  }
});


