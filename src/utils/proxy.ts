// src/utils/proxy.ts
import { H3Event } from 'h3';

function getApiKeysFromRequest(event: H3Event): string[] {
  const authHeader = getHeader(event, 'Authorization');
  const googHeader = getHeader(event, 'x-goog-api-key');

  let keys: string[] = [];

  if (authHeader && authHeader.startsWith('Bearer ')) {
    keys = authHeader.substring(7).split(',').map(k => k.trim()).filter(Boolean);
  } else if (googHeader) {
    keys = googHeader.split(',').map(k => k.trim()).filter(Boolean);
  }

  return keys;
}

function selectApiKey(keys: string[]): string | null {
  if (keys.length === 0) {
    return null;
  }
  const index = Math.floor(Math.random() * keys.length);
  return keys[index];
}

export const proxyRequest = async (event: H3Event, geminiRequest: any) => {
  const clientApiKeys = getApiKeysFromRequest(event);
  const selectedKey = selectApiKey(clientApiKeys);

  if (!selectedKey) {
    throw createError({
      statusCode: 401,
      statusMessage: 'API key not provided. Please include it in the `Authorization` header (e.g., `Bearer YOUR_API_KEY`) or `x-goog-api-key` header.',
    });
  }

  // Extract model and stream status for logging
  const model = geminiRequest.model || 'gemini-pro';
  const isStream = geminiRequest.stream || false;
  event.context.logData.model = model;
  event.context.logData.isStream = isStream;

  const basePath = 'https://generativelanguage.googleapis.com';
  const modelPath = `/v1beta/models/${model}:${isStream ? 'streamGenerateContent' : 'generateContent'}`;
  const targetUrl = new URL(modelPath, basePath);

  // The original Gemini API uses `alt=sse` for streaming, but the path is also different.
  // Let's stick to the more common path-based differentiation.

  try {
    return await fetch(targetUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': selectedKey,
      },
      body: JSON.stringify(geminiRequest.body),
    });
  } catch (error: any) {
    event.context.logData.errorMessage = error.message;
    throw createError({
      statusCode: 500,
      statusMessage: `Failed to proxy request to Gemini: ${error.message}`,
    });
  }
};
