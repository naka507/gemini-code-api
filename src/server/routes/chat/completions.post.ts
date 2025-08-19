// src/server/routes/chat/completions.post.ts
import openaiHandler from '~/utils/adapter/openai';

export default defineEventHandler(async (event) => {
  // 获取环境变量中的 API Key
  const apiKey = process.env.GEMINI_API_KEY;
  
  // 创建新的请求对象，添加 Authorization 头
  const request = new Request(getRequestURL(event).toString(), {
    method: getMethod(event),
    headers: {
      ...getHeaders(event),
      'Authorization': `Bearer ${apiKey}`
    },
    body: getMethod(event) === 'POST' ? JSON.stringify(await readBody(event)) : undefined
  });
  
  // 使用 openai.mjs 处理请求
  const response = await openaiHandler.fetch(request);
  
  // 设置响应头
  setHeaders(event, {
    'Content-Type': response.headers.get('Content-Type') || 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  
  // 返回响应体
  return response.body;
});