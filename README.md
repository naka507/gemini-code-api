# Gemini Code API

这是一个智能的 Gemini API 协议适配网关。它接收来自 OpenAI, Anthropic Claude, 和 Google Gemini 客户端的请求，将它们统一转换为 Gemini API 格式，并通过多 Key 负载均衡机制安全、可靠地转发至 Google Gemini API。

项目还实现了请求日志的持久化存储，并提供一个前端看板用于查询请求记录。