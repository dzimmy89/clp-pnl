export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 18_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "omnifolio",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Timed out calling ${new URL(url).host}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Request failed";
}
