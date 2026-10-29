// Incremental Server-Sent Events parser (api.md §2.6). Pure, so it is unit-tested in Node.
export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

export interface SseParser {
  feed(chunk: string): void;
  /** Ends the input; an incomplete final event is discarded so a reconnect can safely replay it. */
  flush(): void;
}

export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  let id: string | undefined;

  const dispatch = () => {
    if (data.length > 0) {
      onMessage({ event, data: data.join('\n'), ...(id !== undefined ? { id } : {}) });
    }
    event = 'message';
    data = [];
  };

  const handleLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) id = value;
  };

  return {
    feed(chunk: string) {
      buffer += chunk;
      // A trailing CR may be the first half of a CRLF that continues in the next chunk: hold it back.
      const hold = buffer.endsWith('\r') ? '\r' : '';
      const body = hold ? buffer.slice(0, -1) : buffer;
      const lines = body.split(/\r\n|\r|\n/);
      buffer = (lines.pop() ?? '') + hold;
      for (const line of lines) handleLine(line);
    },
    flush() {
      // A held CR is itself a valid line ending. Other trailing text has no delimiter and is incomplete.
      if (buffer.endsWith('\r')) handleLine(buffer.slice(0, -1));
      buffer = '';
      event = 'message';
      data = [];
    },
  };
}
