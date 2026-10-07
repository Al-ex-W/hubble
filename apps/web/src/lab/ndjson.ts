/**
 * Parses an NDJSON response body into objects as lines complete.
 *
 * Why a buffer: network chunks end mid-line (and mid UTF-8 character), so
 * splitting each chunk on "\n" would hand JSON.parse half an object. The
 * server's events are small, but the split still happens in practice.
 *
 * It stops itself after an event the caller names as terminal (`isLast`), so a
 * server that forgets to close the stream cannot hang the page's Run button.
 */
export async function* readNdjson<T>(body: ReadableStream<Uint8Array>, isLast: (event: T) => boolean): AsyncGenerator<T> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1)
        if (!line) continue
        const event = JSON.parse(line) as T
        yield event
        if (isLast(event)) return
      }
    }
  } finally { void reader.cancel().catch(() => {}) }
}
