/**
 * Pure HTTP transport layer for Kimi Server REST API.
 * Handles authentication, base URL, response envelope, and error formatting.
 *
 * Extracted from WireClient to give this concern its own module —
 * independently testable with a mock fetch.
 */

interface KimiApiResponse<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

export interface TransportConfig {
  baseUrl: string;
  token: string;
}

export class WireTransport {
  baseUrl: string;
  token: string;

  constructor(config: TransportConfig) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
  }

  async apiGet<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

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

  async apiPost<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

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
