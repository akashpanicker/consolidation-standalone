const BASE = "";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText);
  }
  return res.json();
}

export function apiSSE(
  path: string,
  onEvent: (event: Record<string, unknown>) => void,
  onDone?: () => void,
): () => void {
  const es = new EventSource(`${BASE}${path}`);
  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    onEvent(data);
    if (["complete", "error", "cancelled"].includes(data.type)) {
      es.close();
      onDone?.();
    }
  };
  es.onerror = () => {
    es.close();
    onDone?.();
  };
  return () => es.close();
}
