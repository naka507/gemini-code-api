// src/server/middleware/cors.ts
export default defineEventHandler((event) => {
  // Apply CORS to both /api/* and root-level API routes like /v1/*, /logs
  const pathname = getRequestURL(event).pathname;
  if (pathname.startsWith('/api/') || pathname.startsWith('/v1') || pathname.startsWith('/v1beta') || pathname === '/logs' || pathname === '/chat' || pathname === '/embeddings' || pathname === '/models') {
    // Set the necessary CORS headers
    setResponseHeaders(event, {
      'Access-Control-Allow-Origin': '*', // Allow requests from any origin
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-goog-api-key, x-api-key, anthropic-version',
      'Access-Control-Max-Age': '86400', // Cache preflight response for 1 day
    });

    // Specifically handle the OPTIONS preflight request
    if (event.method === 'OPTIONS') {
      // Send a successful (204 No Content) response
      // This tells the client that the actual request is allowed.
      return sendNoContent(event, 204);
    }
  }
});
