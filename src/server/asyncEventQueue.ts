/**
 * Tiny producer/consumer queue with an async iterator front-end.
 * Used by ShowEngine to emit ClientServerEvent values that either a
 * Fastify WebSocket or a Next.js SSE Route Handler can pump out.
 *
 * Producers call `push(event)` synchronously. Consumers do
 * `for await (const event of queue)` and receive each event in
 * order. `close()` ends the iterator after pending events drain.
 *
 * Single consumer only — that's all the show loop needs (one
 * transport per session). Adding fan-out would require buffering
 * decisions we don't yet have to make.
 */

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Drain any waiting consumers with done=true so the for-await
    // exits cleanly. Buffered values are still consumed first.
    while (this.resolvers.length > 0 && this.buffer.length === 0) {
      const resolver = this.resolvers.shift()!;
      resolver({ value: undefined as unknown as T, done: true });
    }
  }

  /** Drop pending values (used when a consumer disconnects mid-show). */
  clear(): void {
    this.buffer.length = 0;
  }

  size(): number {
    return this.buffer.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        // Caller broke the loop — drain any waiters and signal done so
        // queued resolvers don't leak.
        this.closed = true;
        while (this.resolvers.length > 0) {
          const resolver = this.resolvers.shift()!;
          resolver({ value: undefined as unknown as T, done: true });
        }
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      }
    };
  }
}
