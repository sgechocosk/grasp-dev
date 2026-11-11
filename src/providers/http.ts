export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

/** JSONをPOSTし、SSEの data: 行をJSONとして順に返す。429/5xx は接続前に限りリトライする。 */
export async function* postSSE(
  url: string,
  apiKey: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<any> {
  let res: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    let networkError: unknown;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      networkError = e;
    }
    if (res?.ok) break;
    const retryable = !res || res.status === 429 || res.status >= 500;
    if (retryable && attempt < 3) {
      await sleep(1000 * 2 ** attempt, signal);
      continue;
    }
    if (!res) throw new Error(`APIに接続できません: ${(networkError as Error)?.message ?? networkError}`);
    const text = await res.text();
    let message = text;
    try { message = JSON.parse(text).error?.message ?? text; } catch { /* JSONでなければ本文のまま */ }
    throw new ApiError(res.status, `API error ${res.status}: ${message}`);
  }

  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res!.body as any as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      yield JSON.parse(data);
    }
  }
}
