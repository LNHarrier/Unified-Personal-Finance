const API_URL = import.meta.env.VITE_API_URL
  ?? (import.meta.env.DEV ? "http://127.0.0.1:3001" : "");

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const contentType = response.headers.get("content-type") ?? "";
    const responseType = contentType.includes("json") ? "invalid JSON" : "a non-JSON response";
    throw new Error(
      `API returned ${responseType} (HTTP ${response.status}). Check the Vercel API function routing.`,
    );
  }
}

function responseError(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null
    && "message" in body && typeof body.message === "string") {
    return body.message;
  }
  return fallback;
}

export function getToken() {
  return localStorage.getItem("upf_token");
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem("upf_token", token);
  else localStorage.removeItem("upf_token");
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...options.headers,
    },
  });
  const body = await responseJson(response);
  if (!response.ok) throw new Error(responseError(body, `Request failed (${response.status})`));
  return body as T;
}

export async function downloadCsv(path: string, filename: string): Promise<void> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
  });
  const body = response.ok ? null : await responseJson(response);
  if (!response.ok) throw new Error(responseError(body, `Download failed (${response.status})`));
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
