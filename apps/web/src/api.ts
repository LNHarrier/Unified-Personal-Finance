const API_URL = import.meta.env.VITE_API_URL
  ?? (import.meta.env.DEV ? "http://127.0.0.1:3001" : "");

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
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? "Request failed");
  return body as T;
}

export async function downloadCsv(path: string, filename: string): Promise<void> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
  });
  if (!response.ok) {
    const body = await response.json() as { message?: string };
    throw new Error(body.message ?? "Download failed");
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
