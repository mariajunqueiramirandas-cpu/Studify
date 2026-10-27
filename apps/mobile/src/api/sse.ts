// Incremental Server-Sent Events parser (api.md §2.6). Pure, so it is unit-tested in Node.
export interface SseMessage {
  event: string;
  data: string;
}

export interface SseParser {
  feed(chunk: string): void;
  /** Dispatches a trailing message that was not terminated by a blank line. */
  flush(): void;
}

export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  let buffer = '';
  let event = 'message';
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) {
      onMessage({ event, data: data.join('\n') });
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
      const rest = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      buffer = '';
      if (rest.length > 0) handleLine(rest);
      dispatch();
    },
  };
}
