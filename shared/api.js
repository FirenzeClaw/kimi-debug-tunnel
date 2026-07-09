/**
 * API client for Tunnel and Kimi Server.
 * Uses GM_xmlhttpRequest in Tampermonkey (bypasses CORS), fetch() in Chrome extension.
 */

const FETCH_TIMEOUT = 5000;

/**
 * Cross-origin HTTP GET. Uses GM_xmlhttpRequest if available (Tampermonkey),
 * falls back to fetch() (Chrome extension with host_permissions).
 */
function crossOriginGet(url) {
  return new Promise((resolve) => {
    if (typeof GM_xmlhttpRequest !== "undefined") {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        timeout: FETCH_TIMEOUT,
        onload: (resp) => resolve(resp),
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      fetch(url, { signal: controller.signal })
        .then((resp) => { clearTimeout(timer); resolve(resp); })
        .catch(() => { clearTimeout(timer); resolve(null); });
    }
  });
}

/**
 * Fetch all known orchestration relationships from tunnel.
 * @param {number} tunnelPort
 * @returns {Promise<Array|null>} OrchestrationEntry[] or null on failure
 */
async function fetchOrchestrations(tunnelPort) {
  const url = `http://127.0.0.1:${tunnelPort}/api/orchestrations`;
  const resp = await crossOriginGet(url);
  if (!resp) return null;
  // GM_xmlhttpRequest returns responseText; fetch returns Response object
  const text = typeof resp.responseText !== "undefined" ? resp.responseText : await resp.text();
  try {
    const data = JSON.parse(text);
    return data.orchestrations || [];
  } catch {
    return null;
  }
}

/**
 * Fetch session list from Kimi Server API (same-origin with Bearer auth).
 * @param {string} kimiOrigin - window.location.origin
 * @param {string} token - Kimi Server token
 * @returns {Promise<Array|null>} SessionInfo[] or null on failure
 */
async function fetchSessions(kimiOrigin, token) {
  const url = `${kimiOrigin}/api/v1/sessions?limit=50`;
  try {
    const headers = token ? { "Authorization": `Bearer ${token}` } : {};
    const resp = await fetch(url, { headers });
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data && data.data && data.data.items) ? data.data.items : (data.data || []);
  } catch {
    return null;
  }
}

/**
 * Get Kimi Server token from tunnel.
 * @param {number} tunnelPort
 * @returns {Promise<string|null>} Token string or null on failure
 */
async function getToken(tunnelPort) {
  const url = `http://127.0.0.1:${tunnelPort}/api/token`;
  const resp = await crossOriginGet(url);
  if (!resp) return null;
  const text = typeof resp.responseText !== "undefined" ? resp.responseText : await resp.text();
  try {
    const data = JSON.parse(text);
    return data.token || null;
  } catch {
    return null;
  }
}
