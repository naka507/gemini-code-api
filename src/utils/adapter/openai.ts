//Author: PublicAffairs
//Project: https://github.com/PublicAffairs/openai-gemini
//MIT License : https://github.com/PublicAffairs/openai-gemini/blob/main/LICENSE

import { Buffer } from "node:buffer";

// Type definitions
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ContentPart {
  type: 'text' | 'image_url' | 'input_audio';
  text?: string;
  image_url?: { url: string };
  input_audio?: { format: string; data: string };
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIRequest {
  model?: string;
  messages?: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: Tool[];
  tool_choice?: string | { type: 'function'; function: { name: string } };
  response_format?: ResponseFormat;
  reasoning_effort?: 'low' | 'medium' | 'high';
  seed?: number;
  n?: number;
  input?: string | string[];
  dimensions?: number;
  extra_body?: {
    google?: {
      safety_settings?: any[];
      cached_content?: string;
      thinking_config?: any;
    };
  };
}

interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: any;
    strict?: boolean;
  };
}

interface ResponseFormat {
  type: 'json_schema' | 'json_object' | 'text';
  json_schema?: {
    schema: any;
  };
}

interface GeminiRequest {
  contents?: any[];
  system_instruction?: any;
  safetySettings?: any[];
  generationConfig?: any;
  tools?: any[];
  tool_config?: any;
  cachedContent?: string;
}

interface GeminiCandidate {
  index?: number;
  content?: {
    parts?: any[];
  };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    candidatesTokenCount?: number;
    promptTokenCount?: number;
    totalTokenCount?: number;
  };
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: any[];
  };
  modelVersion?: string;
}

interface OpenAIChoice {
  index: number;
  message?: any;
  delta?: any;
  logprobs: null;
  finish_reason: string | null;
}

interface OpenAIResponse {
  id: string;
  choices: OpenAIChoice[];
  created: number;
  model: string;
  object: string;
  usage?: {
    completion_tokens?: number;
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

interface CorsOptions {
  headers?: Headers;
  status?: number;
  statusText?: string;
}

class HttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

const fixCors = ({ headers, status, statusText }: CorsOptions): CorsOptions => {
  const newHeaders = new Headers(headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  return { headers: newHeaders, status, statusText };
};

const handleOPTIONS = async (): Promise<Response> => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    }
  });
};

const BASE_URL = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";

// https://github.com/google-gemini/generative-ai-js/blob/cf223ff4a1ee5a2d944c53cddb8976136382bee6/src/requests/request.ts#L71
const API_CLIENT = "genai-js/0.21.0"; // npm view @google/generative-ai version

const makeHeaders = (apiKey?: string, more?: Record<string, string>): Record<string, string> => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "x-goog-api-key": apiKey }),
  ...more
});

async function handleModels(apiKey?: string): Promise<Response> {
  const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
    headers: makeHeaders(apiKey),
  });
  let responseBody: string;
  if (response.ok) {
    const { models } = JSON.parse(await response.text());
    responseBody = JSON.stringify({
      object: "list",
      data: models.map(({ name }: { name: string }) => ({
        id: name.replace("models/", ""),
        object: "model",
        created: 0,
        owned_by: "",
      })),
    }, null, "  ");
  } else {
    responseBody = await response.text();
  }
  return new Response(responseBody, fixCors(response));
}

const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-004";

async function handleEmbeddings(req: OpenAIRequest, apiKey?: string): Promise<Response> {
  if (typeof req.model !== "string") {
    throw new HttpError("model is not specified", 400);
  }
  let model: string;
  if (req.model.startsWith("models/")) {
    model = req.model;
  } else {
    if (!req.model.startsWith("gemini-")) {
      req.model = DEFAULT_EMBEDDINGS_MODEL;
    }
    model = "models/" + req.model;
  }
  
  const input = Array.isArray(req.input) ? req.input : [req.input];
  
  const response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      "requests": input.map((text: string) => ({
        model,
        content: { parts: { text } },
        outputDimensionality: req.dimensions,
      }))
    })
  });
  let responseBody: string;
  if (response.ok) {
    const { embeddings } = JSON.parse(await response.text());
    responseBody = JSON.stringify({
      object: "list",
      data: embeddings.map(({ values }: { values: number[] }, index: number) => ({
        object: "embedding",
        index,
        embedding: values,
      })),
      model: req.model,
    }, null, "  ");
  } else {
    responseBody = await response.text();
  }
  return new Response(responseBody, fixCors(response));
}

const DEFAULT_MODEL = "gemini-2.5-flash";

async function handleCompletions(req: OpenAIRequest, apiKey?: string): Promise<Response> {
  let model = DEFAULT_MODEL;
  switch (true) {
    case typeof req.model !== "string":
      break;
    case req.model?.startsWith("models/"):
      model = req.model.substring(7);
      break;
    case req.model?.startsWith("gemini-"):
    case req.model?.startsWith("gemma-"):
    case req.model?.startsWith("learnlm-"):
      model = req.model;
  }
  
  let body: GeminiRequest = await transformRequest(req);
  const extra = req.extra_body?.google;
  if (extra) {
    if (extra.safety_settings) {
      body.safetySettings = extra.safety_settings;
    }
    if (extra.cached_content) {
      body.cachedContent = extra.cached_content;
    }
    if (extra.thinking_config) {
      body.generationConfig = body.generationConfig || {};
      (body.generationConfig as any).thinkingConfig = extra.thinking_config;
    }
  }
  
  switch (true) {
    case model.endsWith(":search"):
      model = model.substring(0, model.length - 7);
      // eslint-disable-next-line no-fallthrough
    case req.model?.endsWith("-search-preview"):
    case req.tools?.some(tool => tool.function?.name === 'googleSearch'):
      body.tools = body.tools || [];
      body.tools.push({ googleSearch: {} });
  }
  
  console.log(body.tools);
  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) { url += "?alt=sse"; }
  
  const response = await fetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  let responseBody: any = response.body;
  if (response.ok) {
    const id = "chatcmpl-" + generateId();
    const shared: any = {};
    if (req.stream) {
      responseBody = response.body
        ?.pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "",
          shared,
        } as any))
        .pipeThrough(new TransformStream({
          transform: toOpenAiStream,
          flush: toOpenAiStreamFlush,
          streamIncludeUsage: req.stream_options?.include_usage,
          model, id, last: [],
          shared,
        } as any))
        .pipeThrough(new TextEncoderStream());
    } else {
      responseBody = await response.text();
      try {
        responseBody = JSON.parse(responseBody);
        if (!responseBody.candidates) {
          throw new Error("Invalid completion object");
        }
      } catch (err) {
        console.error("Error parsing response:", err);
        return new Response(responseBody, fixCors(response)); // output as is
      }
      responseBody = processCompletionsResponse(responseBody, model, id);
    }
  }
  return new Response(responseBody, fixCors(response));
}

const adjustProps = (schemaPart: any): void => {
  if (typeof schemaPart !== "object" || schemaPart === null) {
    return;
  }
  if (Array.isArray(schemaPart)) {
    schemaPart.forEach(adjustProps);
  } else {
    if (schemaPart.type === "object" && schemaPart.properties && schemaPart.additionalProperties === false) {
      delete schemaPart.additionalProperties;
    }
    Object.values(schemaPart).forEach(adjustProps);
  }
};

const adjustSchema = (schema: any): void => {
  const obj = schema[schema.type];
  delete obj.strict;
  return adjustProps(schema);
};

const harmCategory = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
];

const safetySettings = harmCategory.map(category => ({
  category,
  threshold: "BLOCK_NONE",
}));

const fieldsMap: Record<string, string> = {
  frequency_penalty: "frequencyPenalty",
  max_completion_tokens: "maxOutputTokens",
  max_tokens: "maxOutputTokens",
  n: "candidateCount", // not for streaming
  presence_penalty: "presencePenalty",
  seed: "seed",
  stop: "stopSequences",
  temperature: "temperature",
  top_k: "topK", // non-standard
  top_p: "topP",
};

const thinkingBudgetMap: Record<string, number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
};

const transformConfig = (req: OpenAIRequest): any => {
  const cfg: any = {};
  for (const key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) {
      cfg[matchedKey] = (req as any)[key];
    }
  }
  
  if (req.response_format) {
    switch (req.response_format.type) {
      case "json_schema":
        adjustSchema(req.response_format);
        cfg.responseSchema = req.response_format.json_schema?.schema;
        if (cfg.responseSchema && "enum" in cfg.responseSchema) {
          cfg.responseMimeType = "text/x.enum";
          break;
        }
        // eslint-disable-next-line no-fallthrough
      case "json_object":
        cfg.responseMimeType = "application/json";
        break;
      case "text":
        cfg.responseMimeType = "text/plain";
        break;
      default:
        throw new HttpError("Unsupported response_format.type", 400);
    }
  }
  
  if (req.reasoning_effort) {
    cfg.thinkingConfig = { thinkingBudget: thinkingBudgetMap[req.reasoning_effort] };
  }
  
  return cfg;
};

const parseImg = async (url: string): Promise<any> => {
  let mimeType: string, data: string;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} (${url})`);
      }
      mimeType = response.headers.get("content-type") || "";
      data = Buffer.from(await response.arrayBuffer()).toString("base64");
    } catch (err) {
      throw new Error("Error fetching image: " + err.toString());
    }
  } else {
    const match = url.match(/^data:(.*?)(;base64)?,(.*)$/);
    if (!match) {
      throw new HttpError("Invalid image data: " + url, 400);
    }
    mimeType = match[1];
    data = match[3];
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformFnResponse = ({ content, tool_call_id }: { content: string; tool_call_id?: string }, parts: any): void => {
  if (!parts.calls) {
    throw new HttpError("No function calls found in the previous message", 400);
  }
  let response: any;
  try {
    response = JSON.parse(content);
  } catch (err) {
    console.error("Error parsing function response content:", err);
    throw new HttpError("Invalid function response: " + content, 400);
  }
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    response = { result: response };
  }
  if (!tool_call_id) {
    throw new HttpError("tool_call_id not specified", 400);
  }
  const { i, name } = parts.calls[tool_call_id] ?? {};
  if (!name) {
    throw new HttpError("Unknown tool_call_id: " + tool_call_id, 400);
  }
  if (parts[i]) {
    throw new HttpError("Duplicated tool_call_id: " + tool_call_id, 400);
  }
  parts[i] = {
    functionResponse: {
      id: tool_call_id.startsWith("call_") ? null : tool_call_id,
      name,
      response,
    }
  };
};

const transformFnCalls = ({ tool_calls }: { tool_calls: ToolCall[] }): any => {
  const calls: Record<string, any> = {};
  const parts = tool_calls.map(({ function: { arguments: argstr, name }, id, type }, i) => {
    if (type !== "function") {
      throw new HttpError(`Unsupported tool_call type: "${type}"`, 400);
    }
    let args: any;
    try {
      args = JSON.parse(argstr);
    } catch (err) {
      console.error("Error parsing function arguments:", err);
      throw new HttpError("Invalid function arguments: " + argstr, 400);
    }
    calls[id] = { i, name };
    return {
      functionCall: {
        id: id.startsWith("call_") ? null : id,
        name,
        args,
      }
    };
  });
  (parts as any).calls = calls;
  return parts;
};

const transformMsg = async ({ content }: { content: string | ContentPart[] | null }): Promise<any[]> => {
  const parts: any[] = [];
  if (!Array.isArray(content)) {
    // system, user: string
    // assistant: string or null (Required unless tool_calls is specified.)
    parts.push({ text: content });
    return parts;
  }
  // user:
  // An array of content parts with a defined type.
  // Supported options differ based on the model being used to generate the response.
  // Can contain text, image, or audio inputs.
  for (const item of content) {
    switch (item.type) {
      case "text":
        parts.push({ text: item.text });
        break;
      case "image_url":
        if (item.image_url) {
          parts.push(await parseImg(item.image_url.url));
        }
        break;
      case "input_audio":
        if (item.input_audio) {
          parts.push({
            inlineData: {
              mimeType: "audio/" + item.input_audio.format,
              data: item.input_audio.data,
            }
          });
        }
        break;
      default:
        throw new HttpError(`Unknown "content" item type: "${item.type}"`, 400);
    }
  }
  if (content.every(item => item.type === "image_url")) {
    parts.push({ text: "" }); // to avoid "Unable to submit request because it must have a text parameter"
  }
  return parts;
};

const transformMessages = async (messages?: OpenAIMessage[]): Promise<{ system_instruction?: any; contents?: any[] }> => {
  if (!messages) { return {}; }
  const contents: any[] = [];
  let system_instruction: any;
  for (const item of messages) {
    switch (item.role) {
      case "system":
        system_instruction = { parts: await transformMsg(item) };
        continue;
      case "tool":
        // eslint-disable-next-line no-case-declarations
        let { role, parts } = contents[contents.length - 1] ?? {};
        if (role !== "function") {
          const calls = parts?.calls;
          parts = []; parts.calls = calls;
          contents.push({
            role: "function", // ignored
            parts
          });
        }
        transformFnResponse(item as any, parts);
        continue;
      case "assistant":
        (item as any).role = "model";
        break;
      case "user":
        break;
      default:
        throw new HttpError(`Unknown message role: "${item.role}"`, 400);
    }
    contents.push({
      role: item.role,
      parts: item.tool_calls ? transformFnCalls(item as any) : await transformMsg(item)
    });
  }
  if (system_instruction) {
    if (!contents[0]?.parts.some((part: any) => part.text)) {
      contents.unshift({ role: "user", parts: { text: " " } });
    }
  }
  return { system_instruction, contents };
};

const transformTools = (req: OpenAIRequest): { tools?: any[]; tool_config?: any } => {
  let tools: any[], tool_config: any;
  if (req.tools) {
    const funcs = req.tools.filter(tool => tool.type === "function" && tool.function?.name !== 'googleSearch');
    if (funcs.length > 0) {
      funcs.forEach(adjustSchema);
      tools = [{ function_declarations: funcs.map(schema => schema.function) }];
    }
  }
  if (req.tool_choice) {
    const allowed_function_names = typeof req.tool_choice === 'object' && req.tool_choice.type === "function" ? [req.tool_choice.function?.name] : undefined;
    if (allowed_function_names || typeof req.tool_choice === "string") {
      tool_config = {
        function_calling_config: {
          mode: allowed_function_names ? "ANY" : (req.tool_choice as string).toUpperCase(),
          allowed_function_names
        }
      };
    }
  }
  return { tools, tool_config };
};

const transformRequest = async (req: OpenAIRequest): Promise<GeminiRequest> => ({
  ...await transformMessages(req.messages),
  safetySettings,
  generationConfig: transformConfig(req),
  ...transformTools(req),
});

const generateId = (): string => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return Array.from({ length: 29 }, randomChar).join("");
};

const reasonsMap: Record<string, string> = { //https://ai.google.dev/api/rest/v1/GenerateContentResponse#finishreason
  //"FINISH_REASON_UNSPECIFIED": // Default value. This value is unused.
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
  //"OTHER": "OTHER",
};

const SEP = "\n\n|>";

const transformCandidates = (key: string, cand: GeminiCandidate): OpenAIChoice => {
  const message: any = { role: "assistant", content: [] };
  for (const part of cand.content?.parts ?? []) {
    if (part.functionCall) {
      const fc = part.functionCall;
      message.tool_calls = message.tool_calls ?? [];
      message.tool_calls.push({
        id: fc.id ?? "call_" + generateId(),
        type: "function",
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args),
        }
      });
    } else {
      message.content.push(part.text);
    }
  }
  message.content = message.content.join(SEP) || null;
  return {
    index: cand.index || 0, // 0-index is absent in new -002 models response
    [key]: message,
    logprobs: null,
    finish_reason: message.tool_calls ? "tool_calls" : reasonsMap[cand.finishReason || ""] || cand.finishReason || null,
  };
};

const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");

const transformUsage = (data: any) => ({
  completion_tokens: data.candidatesTokenCount,
  prompt_tokens: data.promptTokenCount,
  total_tokens: data.totalTokenCount
});

const checkPromptBlock = (choices: OpenAIChoice[], promptFeedback: any, key: string): boolean => {
  if (choices.length) { return false; }
  if (promptFeedback?.blockReason) {
    console.log("Prompt block reason:", promptFeedback.blockReason);
    if (promptFeedback.blockReason === "SAFETY") {
      promptFeedback.safetyRatings
        ?.filter((r: any) => r.blocked)
        .forEach((r: any) => console.log(r));
    }
    choices.push({
      index: 0,
      [key]: null,
      logprobs: null,
      finish_reason: "content_filter",
    });
  }
  return true;
};

const processCompletionsResponse = (data: GeminiResponse, model: string, id: string): string => {
  const obj: OpenAIResponse = {
    id,
    choices: data.candidates?.map(transformCandidatesMessage) || [],
    created: Math.floor(Date.now() / 1000),
    model: data.modelVersion ?? model,
    object: "chat.completion",
    usage: data.usageMetadata && transformUsage(data.usageMetadata),
  };
  if (obj.choices.length === 0) {
    checkPromptBlock(obj.choices, data.promptFeedback, "message");
  }
  return JSON.stringify(obj);
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;

function parseStream(this: any, chunk: string, controller: any): void {
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true); // eslint-disable-line no-constant-condition
}

function parseStreamFlush(this: any, controller: any): void {
  if (this.buffer) {
    console.error("Invalid data:", this.buffer);
    controller.enqueue(this.buffer);
    this.shared.is_buffers_rest = true;
  }
}

const delimiter = "\n\n";
const sseline = (obj: any): string => {
  obj.created = Math.floor(Date.now() / 1000);
  return "data: " + JSON.stringify(obj) + delimiter;
};

function toOpenAiStream(this: any, line: string, controller: any): void {
  let data: any;
  try {
    data = JSON.parse(line);
    if (!data.candidates) {
      throw new Error("Invalid completion chunk object");
    }
  } catch (err) {
    console.error("Error parsing response:", err);
    if (!this.shared.is_buffers_rest) { line += delimiter; }
    controller.enqueue(line); // output as is
    return;
  }
  const obj: any = {
    id: this.id,
    choices: data.candidates.map(transformCandidatesDelta),
    model: data.modelVersion ?? this.model,
    object: "chat.completion.chunk",
    usage: data.usageMetadata && this.streamIncludeUsage ? null : undefined,
  };
  if (checkPromptBlock(obj.choices, data.promptFeedback, "delta")) {
    controller.enqueue(sseline(obj));
    return;
  }
  console.assert(data.candidates.length === 1, "Unexpected candidates count: %d", data.candidates.length);
  const cand = obj.choices[0];
  cand.index = cand.index || 0; // absent in new -002 models response
  const finish_reason = cand.finish_reason;
  cand.finish_reason = null;
  if (!this.last[cand.index]) { // first
    controller.enqueue(sseline({
      ...obj,
      choices: [{ ...cand, tool_calls: undefined, delta: { role: "assistant", content: "" } }],
    }));
  }
  delete cand.delta.role;
  if ("content" in cand.delta) { // prevent empty data (e.g. when MAX_TOKENS)
    controller.enqueue(sseline(obj));
  }
  cand.finish_reason = finish_reason;
  if (data.usageMetadata && this.streamIncludeUsage) {
    obj.usage = transformUsage(data.usageMetadata);
  }
  cand.delta = {};
  this.last[cand.index] = obj;
}

function toOpenAiStreamFlush(this: any, controller: any): void {
  if (this.last.length > 0) {
    for (const obj of this.last) {
      controller.enqueue(sseline(obj));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }
    const errHandler = (err: any): Response => {
      console.error(err);
      return new Response(err.message, fixCors({ status: err.status ?? 500 }));
    };
    try {
      const auth = request.headers.get("Authorization");
      let apiKey = auth?.split(" ")[1];
      if (apiKey && apiKey.includes(',')) {
        const apiKeys = apiKey.split(',').map(k => k.trim()).filter(k => k);
        apiKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];
        console.log(`OpenAI Selected API Key: ${apiKey}`);
      }
      const assert = (success: boolean): void => {
        if (!success) {
          throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
        }
      };
      const { pathname } = new URL(request.url);
      switch (true) {
        case pathname.endsWith("/chat/completions"):
          assert(request.method === "POST");
          return handleCompletions(await request.json(), apiKey)
            .catch(errHandler);
        case pathname.endsWith("/embeddings"):
          assert(request.method === "POST");
          return handleEmbeddings(await request.json(), apiKey)
            .catch(errHandler);
        case pathname.endsWith("/models"):
          assert(request.method === "GET");
          return handleModels(apiKey)
            .catch(errHandler);
        default:
          throw new HttpError("404 Not Found", 404);
      }
    } catch (err) {
      return errHandler(err);
    }
  }
};