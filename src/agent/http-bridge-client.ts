const HTTP_BRIDGE_BASE_URL = 'http://127.0.0.1:9847';

type BridgeQueryValue = string | number | boolean | null | undefined;

interface AgentdocConfig {
  windowId?: string;
  documentId?: string;
  bridgeAuthToken?: string;
}

export interface BridgeRequestOptions {
  agentId?: string;
  query?: Record<string, BridgeQueryValue>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function getAgentdocConfig(): AgentdocConfig {
  const config = (window as Window & { __AGENTDOC_CONFIG__?: AgentdocConfig }).__AGENTDOC_CONFIG__;
  return config ?? {};
}

export function getRoutingHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const config = getAgentdocConfig();

  if (config.bridgeAuthToken && config.bridgeAuthToken.trim()) {
    headers['X-Agentdoc-Bridge-Token'] = config.bridgeAuthToken;
  }

  if (config.windowId && config.windowId.trim()) {
    headers['X-Window-Id'] = config.windowId;
    return headers;
  }

  if (config.documentId && config.documentId.trim()) {
    headers['X-Document-Id'] = config.documentId;
  }

  return headers;
}

function hasContentTypeHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');
}

function buildHeaders(options: BridgeRequestOptions, includeJsonContentType: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    ...getRoutingHeaders(),
  };

  if (options.agentId) {
    headers['X-Agent-Id'] = options.agentId;
  }

  if (options.headers) {
    Object.assign(headers, options.headers);
  }

  if (includeJsonContentType && !hasContentTypeHeader(headers)) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

function buildUrl(path: string, query?: Record<string, BridgeQueryValue>): string {
  const url = new URL(path, HTTP_BRIDGE_BASE_URL);
  if (!query) return url.toString();

  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim()) {
      return error;
    }
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  return fallback;
}

async function handleResponse<T>(response: Response): Promise<T> {
  const body = await parseJsonBody(response);
  if (response.ok) {
    return body as T;
  }

  const statusText = `${response.status} ${response.statusText}`.trim();
  const message = extractErrorMessage(body, statusText || 'Bridge request failed');
  throw new Error(`[Bridge] ${message} (${statusText})`);
}

export async function bridgeGet<T = unknown>(
  path: string,
  options: BridgeRequestOptions = {}
): Promise<T> {
  const url = buildUrl(path, options.query);
  const headers = buildHeaders(options, false);
  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: options.signal,
  });
  return handleResponse<T>(response);
}

function serializeBody(path: string, body: unknown): string {
  if (body === undefined) {
    throw new Error(`[Bridge] Refusing to POST undefined body to ${path}`);
  }
  if (body === null) {
    throw new Error(`[Bridge] Refusing to POST null body to ${path}`);
  }
  if (typeof body === 'string') {
    throw new Error(`[Bridge] Refusing to POST string body to ${path}; expected an object`);
  }
  if (typeof body !== 'object') {
    throw new Error(`[Bridge] Refusing to POST non-object body (${typeof body}) to ${path}`);
  }

  let payload: string | undefined;
  try {
    payload = JSON.stringify(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[Bridge] Failed to serialize request body for ${path}: ${message}`);
  }

  if (!payload) {
    throw new Error(`[Bridge] Serialized empty request body for ${path}`);
  }

  return payload;
}

export async function bridgePost<T = unknown>(
  path: string,
  body: unknown,
  options: BridgeRequestOptions = {}
): Promise<T> {
  const url = buildUrl(path, options.query);
  const headers = buildHeaders(options, true);
  const payload = serializeBody(path, body);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: payload,
    signal: options.signal,
  });
  return handleResponse<T>(response);
}

export { HTTP_BRIDGE_BASE_URL };
