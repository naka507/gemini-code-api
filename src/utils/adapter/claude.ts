// Claude API compatibility layer over Gemini
// Implements /v1/messages (Anthropic) on top of Gemini GenerateContent APIs

// NOTE: This module is designed to run in Nitro (Cloudflare Pages/Workers preset).
// It only uses Web Platform APIs (fetch, TransformStream, TextEncoder/Decoder, crypto.randomUUID).

// -----------------------------
// Utilities
// -----------------------------

function generateUUID(): string {
	try {
		// Workers/Nitro usually provides crypto.randomUUID
		// @ts-ignore
		const v = globalThis?.crypto?.randomUUID?.();
		if (typeof v === 'string' && v.length > 0) return v;
	} catch { }
	// Simple fallback
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

function json(obj: unknown): string {
	return JSON.stringify(obj);
}

// -----------------------------
// Model mapping
// -----------------------------

const MODEL_MAP: Record<string, string> = {
	'claude-3-7-sonnet-20250219': 'gemini-2.5-flash',
	'claude-sonnet-4-20250514': 'gemini-2.5-flash',
	'claude-opus-4-20250514': 'gemini-2.5-pro',
};

function mapClaudeToGeminiModel(model: string): string {
	if (MODEL_MAP[model]) return MODEL_MAP[model];
	// Fallback
	return 'gemini-2.0-flash';
}

// -----------------------------
// Tool schema pruning (Gemini constraints)
// -----------------------------

function pruneToolSchema(schema: any): any {
	const visit = (node: any): any => {
		if (Array.isArray(node)) return node.map(visit);
		if (node && typeof node === 'object') {
			const result: any = {};
			for (const [k, v] of Object.entries(node)) {
				if (k === '$schema' || k === 'additionalProperties' || k === 'strict' || k === 'default') continue;
				// Gemini only supports enum/date-time for string formats; remove others to be safe
				if (k === 'format' && typeof v === 'string' && v !== 'enum' && v !== 'date-time') continue;
				result[k] = visit(v);
			}
			return result;
		}
		return node;
	};
	return visit(schema ?? {});
}

// -----------------------------
// Anthropic <-> Gemini conversion
// -----------------------------

function claudeToGemini(claudeRequest: any) {
	const {
		model,
		messages,
		stream = false,
		max_tokens = 1024,
		temperature = 1.0,
		top_p,
		top_k,
		stop_sequences,
		system,
		tools,
		tool_choice,
	} = claudeRequest || {};

	const geminiModel = mapClaudeToGeminiModel(model);

	const contents: any[] = [];
	let systemInstruction: any = undefined;

	// system can be string or content-block array
	if (system) {
		if (typeof system === 'string') {
			systemInstruction = { parts: [{ text: system }] };
		} else if (Array.isArray(system)) {
			const txt = system
				.filter((b: any) => b?.type === 'text')
				.map((b: any) => b?.text || '')
				.join('\n');
			if (txt) systemInstruction = { parts: [{ text: txt }] };
		}
	}

	for (const msg of messages || []) {
		if (msg?.role === 'system') {
			// Allow system message embedded in messages
			const txt = typeof msg.content === 'string'
				? msg.content
				: Array.isArray(msg.content)
					? msg.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('\n')
					: '';
			if (txt && !systemInstruction) systemInstruction = { parts: [{ text: txt }] };
			continue;
		}

		const role = msg?.role === 'user' ? 'user' : 'model';
		const parts: any[] = [];

		if (typeof msg?.content === 'string') {
			parts.push({ text: msg.content });
		} else if (Array.isArray(msg?.content)) {
			for (const block of msg.content) {
				switch (block?.type) {
					case 'text':
						parts.push({ text: block.text || '' });
						break;
					case 'image': {
						const src = block.source || {};
						if (src?.data) {
							parts.push({ inlineData: { mimeType: src.media_type || 'image/jpeg', data: src.data } });
						}
						break;
					}
					case 'tool_use':
						parts.push({ functionCall: { name: block.name, args: block.input || {} } });
						break;
					case 'tool_result': {
						const content = block.content;
						let resultText = '';
						if (typeof content === 'string') resultText = content;
						else if (Array.isArray(content)) resultText = content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '').join('\n');
						else resultText = json(content ?? {});
						parts.push({ functionResponse: { name: block.tool_use_id, response: { result: resultText } } });
						break;
					}
				}
			}
		}

		if (parts.length > 0) contents.push({ role, parts });
	}

	const generationConfig: any = { maxOutputTokens: max_tokens, temperature };
	if (typeof top_p === 'number') generationConfig.topP = top_p;
	if (typeof top_k === 'number') generationConfig.topK = top_k;
	if (Array.isArray(stop_sequences) && stop_sequences.length > 0) generationConfig.stopSequences = stop_sequences;

	const body: any = { contents, generationConfig };
	if (systemInstruction) body.systemInstruction = systemInstruction;

	if (Array.isArray(tools) && tools.length > 0) {
		const functionDeclarations = tools.map((t: any) => {
			const cleaned = pruneToolSchema(t?.input_schema || {});
			const parameters = Object.keys(cleaned).length ? cleaned : { type: 'object', properties: {} };
			return { name: t?.name, description: t?.description || '', parameters };
		});
		body.tools = [{ functionDeclarations }];

		const choice = tool_choice || { type: 'auto' };
		if (choice?.type === 'tool' && choice?.name) {
			body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } };
		} else if (choice?.type === 'any') {
			body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
		} else if (choice?.type === 'none') {
			body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
		} else {
			body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
		}
	}

	return { model: geminiModel, body, stream };
}

function geminiToClaude(gemini: any, model: string) {
	const msgId = `msg_${generateUUID()}`;
	if (!gemini || !Array.isArray(gemini?.candidates) || gemini.candidates.length === 0) {
		return {
			id: msgId,
			type: 'message',
			role: 'assistant',
			content: [],
			model,
			stop_reason: 'error',
			stop_sequence: null,
			usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
		};
	}

	const cand = gemini.candidates[0];
	const content: any[] = [];
	let stopReason = 'end_turn';

	if (cand?.content?.parts) {
		for (const part of cand.content.parts) {
			if (part?.text) content.push({ type: 'text', text: part.text });
			if (part?.functionCall) {
				const toolUseId = `toolu_${generateUUID().replace(/-/g, '').slice(0, 24)}`;
				content.push({ type: 'tool_use', id: toolUseId, name: part.functionCall.name, input: part.functionCall.args || {} });
				stopReason = 'tool_use';
			}
		}
	}

	if (cand?.finishReason === 'MAX_TOKENS') stopReason = 'max_tokens';
	else if (cand?.finishReason === 'STOP') stopReason = content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn';
	else if (cand?.finishReason && cand.finishReason !== 'STOP') stopReason = 'error';

	const usage = {
		input_tokens: gemini?.usageMetadata?.promptTokenCount || 0,
		output_tokens: gemini?.usageMetadata?.candidatesTokenCount || 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	};

	return { id: msgId, type: 'message', role: 'assistant', content, model, stop_reason: stopReason, stop_sequence: null, usage };
}

// -----------------------------
// Streaming transformer (Gemini SSE -> Anthropic SSE)
// -----------------------------

function createClaudeStreamTransformer(
	model: string,
	options?: { emitPrelude?: boolean }
): TransformStream<Uint8Array, Uint8Array> {
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	const MESSAGE_ID = `msg_${generateUUID()}`;
	let started = false;
	let contentBlockOpen = false;
	let contentBlockIndex = 0;
	let totalOutput = 0;
	let lineBuffer = '';
	let tailEmitted = false;

	return new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			const emitPrelude = options?.emitPrelude !== false;
			if (emitPrelude) {
				const startEvt = { type: 'message_start', message: { id: MESSAGE_ID, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } };
				controller.enqueue(enc.encode(`event: message_start\n`));
				controller.enqueue(enc.encode(`data: ${json(startEvt)}\n\n`));
				controller.enqueue(enc.encode(`event: ping\n`));
				controller.enqueue(enc.encode(`data: ${json({ type: 'ping' })}\n\n`));
			}
			started = true;
		},
		transform(chunk, controller) {
			// Buffer lines across chunks to avoid truncating JSON at boundaries
			lineBuffer += dec.decode(chunk, { stream: true });
			let nlIndex;
			while ((nlIndex = lineBuffer.indexOf('\n')) !== -1) {
				const line = lineBuffer.slice(0, nlIndex);
				lineBuffer = lineBuffer.slice(nlIndex + 1);
				const trimmed = line.trim();
				if (!trimmed || !trimmed.startsWith('data: ')) continue;
				const data = trimmed.slice(6).trim();
				if (!data) continue;
				if (data === '[DONE]') {
					// finalization handled in flush to avoid duplication
					continue;
				}
				try {
					const obj = JSON.parse(data);
					if (obj?.usageMetadata?.candidatesTokenCount) totalOutput = obj.usageMetadata.candidatesTokenCount;
					const cand = Array.isArray(obj?.candidates) ? obj.candidates[0] : undefined;
					const parts = cand?.content?.parts || [];
					for (const part of parts) {
						if (part?.text) {
							if (!contentBlockOpen) {
								const startBlock = { type: 'content_block_start', index: contentBlockIndex, content_block: { type: 'text', text: '' } };
								controller.enqueue(enc.encode(`event: content_block_start\n`));
								controller.enqueue(enc.encode(`data: ${json(startBlock)}\n\n`));
								contentBlockOpen = true;
							}
							const deltaEvt = { type: 'content_block_delta', index: contentBlockIndex, delta: { type: 'text_delta', text: part.text } };
							controller.enqueue(enc.encode(`event: content_block_delta\n`));
							controller.enqueue(enc.encode(`data: ${json(deltaEvt)}\n\n`));
						}
						if (part?.functionCall) {
							if (contentBlockOpen) {
								controller.enqueue(enc.encode(`event: content_block_stop\n`));
								controller.enqueue(enc.encode(`data: ${json({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`));
								contentBlockOpen = false;
								contentBlockIndex++;
							}
							const toolUseId = `toolu_${generateUUID().replace(/-/g, '').slice(0, 24)}`;
							const toolStart = { type: 'content_block_start', index: contentBlockIndex, content_block: { type: 'tool_use', id: toolUseId, name: part.functionCall.name, input: {} } };
							controller.enqueue(enc.encode(`event: content_block_start\n`));
							controller.enqueue(enc.encode(`data: ${json(toolStart)}\n\n`));
							if (part.functionCall.args) {
								const toolDelta = { type: 'content_block_delta', index: contentBlockIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args) } };
								controller.enqueue(enc.encode(`event: content_block_delta\n`));
								controller.enqueue(enc.encode(`data: ${json(toolDelta)}\n\n`));
							}
							controller.enqueue(enc.encode(`event: content_block_stop\n`));
							controller.enqueue(enc.encode(`data: ${json({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`));
							contentBlockIndex++;
						}
					}
					const fr = cand?.finishReason;
					if (!tailEmitted && (fr === 'STOP' || fr === 'MAX_TOKENS')) {
						if (contentBlockOpen) {
							controller.enqueue(enc.encode(`event: content_block_stop\n`));
							controller.enqueue(enc.encode(`data: ${json({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`));
							contentBlockOpen = false;
						}
						const stop_reason = fr === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
						const msgDelta = { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: totalOutput } };
						controller.enqueue(enc.encode(`event: message_delta\n`));
						controller.enqueue(enc.encode(`data: ${json(msgDelta)}\n\n`));
						controller.enqueue(enc.encode(`event: message_stop\n`));
						controller.enqueue(enc.encode(`data: ${json({ type: 'message_stop' })}\n\n`));
						tailEmitted = true;
					}
				} catch { }
			}
		},
		flush(controller) {
			if (!started) return;
			if (contentBlockOpen) {
				controller.enqueue(enc.encode(`event: content_block_stop\n`));
				controller.enqueue(enc.encode(`data: ${json({ type: 'content_block_stop', index: contentBlockIndex })}\n\n`));
			}
			if (!tailEmitted) {
				const msgDelta = { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: totalOutput } };
				controller.enqueue(enc.encode(`event: message_delta\n`));
				controller.enqueue(enc.encode(`data: ${json(msgDelta)}\n\n`));
				controller.enqueue(enc.encode(`event: message_stop\n`));
				controller.enqueue(enc.encode(`data: ${json({ type: 'message_stop' })}\n\n`));
			}
			controller.enqueue(enc.encode('data: [DONE]\n\n'));
		},
	});
}

// Resilient wrapper: emits prelude immediately, proxies upstream; if no data within timeout, emits minimal text to avoid client hanging
function resilientClaudeStream(
	upstreamFactory: () => Promise<Response>,
	model: string,
	attemptTimeoutMs = 3000,
	maxRetries = 2
): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	const prelude = (controller: ReadableStreamDefaultController<Uint8Array>, messageId: string) => {
		const startEvt = { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } };
		controller.enqueue(enc.encode(`event: message_start\n`));
		controller.enqueue(enc.encode(`data: ${json(startEvt)}\n\n`));
		controller.enqueue(enc.encode(`event: ping\n`));
		controller.enqueue(enc.encode(`data: ${json({ type: 'ping' })}\n\n`));
	};

	const tailOk = (controller: ReadableStreamDefaultController<Uint8Array>, usageOut = 0) => {
		controller.enqueue(enc.encode(`event: message_delta\n`));
		controller.enqueue(enc.encode(`data: ${json({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usageOut } })}\n\n`));
		controller.enqueue(enc.encode(`event: message_stop\n`));
		controller.enqueue(enc.encode(`data: ${json({ type: 'message_stop' })}\n\n`));
		controller.enqueue(enc.encode('data: [DONE]\n\n'));
	};

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const msgId = `msg_${generateUUID()}`;
			prelude(controller, msgId);

			let attempt = 0;
			let receivedAny = false;

			while (attempt <= maxRetries && !receivedAny) {
				try {
					const resp = await upstreamFactory();
					if (!resp.ok || !resp.body) throw new Error(`upstream ${resp.status}`);

					const transformed = resp.body.pipeThrough(createClaudeStreamTransformer(model, { emitPrelude: false }) as any);
					const reader = transformed.getReader();

					let timedOut = false;
					const timer = setTimeout(() => { timedOut = true; }, attemptTimeoutMs);

					// pump a few chunks; if first chunk arrives, continue without timeout gate
					const pump = async (): Promise<void> => {
						const { value, done } = await reader.read();
						if (done) return;
						if (value && value.byteLength > 0) {
							receivedAny = true;
							clearTimeout(timer);
							controller.enqueue(value);
						}
						await pump();
					};

					await Promise.race([
						pump(),
						(async () => {
							while (!timedOut && !receivedAny) await new Promise(r => setTimeout(r, 50));
						})()
					]);

					if (!receivedAny) {
						// cancel and retry
						try { reader.cancel(); } catch { }
						attempt++;
						continue;
					}

					// after first bytes, stream rest until end
					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						if (value) controller.enqueue(value);
					}
					// transformer flush will emit tail; just return
					controller.close();
					return;
				} catch {
					attempt++;
				}
			}

			if (!receivedAny) {
				// emit minimal text to satisfy client stream expectations
				controller.enqueue(enc.encode(`event: content_block_start\n`));
				controller.enqueue(enc.encode(`data: ${json({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`));
				controller.enqueue(enc.encode(`event: content_block_delta\n`));
				controller.enqueue(enc.encode(`data: ${json({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' ' } })}\n\n`));
				controller.enqueue(enc.encode(`event: content_block_stop\n`));
				controller.enqueue(enc.encode(`data: ${json({ type: 'content_block_stop', index: 0 })}\n\n`));
				tailOk(controller, 0);
			}
			controller.close();
		}
	});
}

// -----------------------------
// Error helpers
// -----------------------------

function anthropicError(status: number, message: string, type?: string) {
	let t = type;
	if (!t) {
		switch (status) {
			case 400: t = 'invalid_request_error'; break;
			case 401: t = 'authentication_error'; break;
			case 403: t = 'permission_error'; break;
			case 404: t = 'not_found_error'; break;
			case 429: t = 'rate_limit_error'; break;
			default: t = status >= 500 ? 'api_error' : 'invalid_request_error';
		}
	}
	return { type: 'error', error: { type: t, message } };
}

// -----------------------------
// Main handler
// -----------------------------

const BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';

export default {
	async fetch(request: Request, env?: any) {
		try {
			if (request.method === 'OPTIONS') {
				return new Response(null, { status: 200, headers: corsHeaders() });
			}

			const url = new URL(request.url);
			const debug = url.searchParams.get('debug') === '1';
			const ab = url.searchParams.get('ab'); // 'minimal' | 'notools' | undefined
			const requestId = `req_${generateUUID()}`;
			if (!url.pathname.endsWith('/messages')) {
				return new Response(json(anthropicError(404, 'Endpoint not supported', 'not_found_error')), { status: 404, headers: { ...jsonHeaders(), 'x-request-id': requestId } });
			}

			// API key (Anthropic uses x-api-key)
			let apiKey = request.headers.get('x-api-key');
			if (!apiKey) {
				const auth = request.headers.get('Authorization');
				if (auth && auth.startsWith('Bearer ')) apiKey = auth.slice(7);
			}
			if (!apiKey) apiKey = env?.GEMINI_API_KEY;
			if (!apiKey) {
				return new Response(json(anthropicError(401, 'API key not valid. Please pass a valid API key.', 'authentication_error')), { status: 401, headers: { ...jsonHeaders(), 'x-request-id': requestId } });
			}

			const body = await request.json();
			let g = claudeToGemini(body);

			// Honor Accept: text/event-stream as streaming signal (SDKs may omit body.stream)
			const acceptHeader = request.headers.get('accept') || '';
			const wantsStream = (body?.stream === true) || acceptHeader.toLowerCase().includes('text/event-stream');
			g.stream = wantsStream;

			// A/B: minimal - only last user text, drop history/tools/system
			if (ab === 'minimal') {
				const lastUser = (() => {
					for (let i = (body?.messages?.length || 0) - 1; i >= 0; i--) {
						const m = body.messages[i];
						if (m?.role === 'user') {
							if (typeof m.content === 'string') return m.content;
							if (Array.isArray(m.content)) {
								return m.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('\n');
							}
						}
					}
					return '';
				})();
				g.body = {
					contents: [{ role: 'user', parts: [{ text: lastUser }] }],
					generationConfig: {
						maxOutputTokens: Math.max(256, body?.max_tokens || 256),
						temperature: body?.temperature ?? 0.7,
						topP: body?.top_p ?? 0.95,
					},
				};
				// ensure no tools
				delete (g.body as any).tools;
				delete (g.body as any).toolConfig;
			}

			// A/B: notools - strip tool declarations and config
			if (ab === 'notools') {
				delete (g.body as any).tools;
				delete (g.body as any).toolConfig;
			}

			const modelPath = encodeURIComponent(g.model);

			if (debug) {
				try {
					const out = JSON.stringify(g.body);
					console.log('[DEBUG][', requestId, '] model=', g.model, ' stream=', !!g.stream, ' body.len=', out.length);
					console.log('[DEBUG][', requestId, '] body.sample=', out.slice(0, 800));
				} catch { }
			}

			if (g.stream) {
				const endpoint = `${BASE_URL}/${API_VERSION}/models/${modelPath}:streamGenerateContent?alt=sse`;

				const stream = resilientClaudeStream(
					async () => {
						return fetch(endpoint, {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
								'Accept': 'text/event-stream',
								'x-goog-api-key': apiKey,
							},
							body: json(g.body),
						});
					},
					body?.model || 'claude',
					3000,
					2
				);

				return new Response(stream as any, { status: 200, headers: { ...sseHeaders(), 'x-request-id': requestId } });
			}

			// non-stream
			const endpoint = `${BASE_URL}/${API_VERSION}/models/${modelPath}:generateContent?key=${encodeURIComponent(apiKey)}`;
			const resp = await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: json(g.body),
			});

			const txt = await resp.text();
			if (!resp.ok) {
				const msg = safeExtractGeminiError(txt) || 'Upstream error';
				return new Response(json(anthropicError(resp.status, msg)), { status: resp.status, headers: { ...jsonHeaders(), 'x-request-id': requestId } });
			}

			const payload = txt ? JSON.parse(txt) : {};
			const result = geminiToClaude(payload, body?.model || 'claude');
			return new Response(json(result), { status: 200, headers: { ...jsonHeaders(), 'x-request-id': requestId } });
		} catch (e: any) {
			const msg = e?.message || 'Internal server error';
			return new Response(json(anthropicError(500, msg, 'api_error')), { status: 500, headers: jsonHeaders() });
		}
	},
};

// -----------------------------
// Headers helpers
// -----------------------------

function baseHeaders() {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
	};
}

function jsonHeaders() {
	return { ...baseHeaders(), 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' } as Record<string, string>;
}

function sseHeaders() {
	return { ...baseHeaders(), 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'anthropic-version': '2023-06-01' } as Record<string, string>;
}

function corsHeaders() {
	return baseHeaders() as Record<string, string>;
}

function safeExtractGeminiError(txt: string): string | null {
	try {
		const obj = JSON.parse(txt);
		return obj?.error?.message || null;
	} catch {
		return txt || null;
	}
}


