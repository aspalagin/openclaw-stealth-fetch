/** Bound decoded bytes before copying/parsing; never call response.text/arrayBuffer. */
export class ResponseLimitError extends Error {
  constructor() { super("response_body_too_large"); this.name = "ResponseLimitError"; }
}
export async function readBoundedText(response: Response, maxBytes: number, onLimit?: () => void): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let received = 0;
  let completed = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { completed = true; break; }
      // No post-download slice or retained chunks. Even a single oversized chunk
      // is rejected before copying. Tiny/zero chunks cannot grow an array of parts.
      if (value.byteLength > maxBytes - received) {
        onLimit?.();
        try { await reader.cancel(); } catch { /* already aborted */ }
        throw new ResponseLimitError();
      }
      bytes.set(value, received);
      received += value.byteLength;
    }
    return new TextDecoder().decode(bytes.subarray(0, received));
  } finally {
    if (!completed) { try { await reader.cancel(); } catch { /* closed */ } }
    reader.releaseLock();
  }
}
