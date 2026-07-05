/**
 * Low-level HTTP transport for the Kimi Server REST API.
 * Handles base URL, auth token, and API response unwrapping.
 * Pure transport — no business logic, no content processing.
 */

interface KimiApiResponse<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

export interface KimiApiTransportConfig {
  baseUrl: string;
  token: string;
}

export class KimiApiTransport {
  private baseUrl: string;
  private token: string;

  constructor(config: KimiApiTransportConfig) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`API GET ${path} failed: ${resp.status}`);
    }
    const json: KimiApiResponse<T> = await resp.json();
    if (json.code !== 0) {
      throw new Error(`API error: ${json.msg} (code ${json.code})`);
    }
    return json.data;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`API POST ${path} failed: ${resp.status}`);
    }
    const json: KimiApiResponse<T> = await resp.json();
    if (json.code !== 0) {
      throw new Error(`API error: ${json.msg} (code ${json.code})`);
    }
    return json.data;
  }
}
