import { describe, expect, it } from "vitest";
import { AsyncEventQueue } from "../server/asyncEventQueue";

describe("AsyncEventQueue", () => {
  it("delivers values pushed before the consumer iterates", async () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();
    const collected: number[] = [];
    for await (const value of q) collected.push(value);
    expect(collected).toEqual([1, 2, 3]);
  });

  it("resolves a pending consumer when a value is pushed", async () => {
    const q = new AsyncEventQueue<string>();
    const iterator = q[Symbol.asyncIterator]();
    const pending = iterator.next();
    q.push("hello");
    const result = await pending;
    expect(result).toEqual({ value: "hello", done: false });
  });

  it("ends the iterator with done=true after close", async () => {
    const q = new AsyncEventQueue<number>();
    q.close();
    const iterator = q[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  it("drains buffered values even after close", async () => {
    const q = new AsyncEventQueue<number>();
    q.push(7);
    q.push(8);
    q.close();
    const collected: number[] = [];
    for await (const value of q) collected.push(value);
    expect(collected).toEqual([7, 8]);
  });

  it("ignores push after close — the closed contract is one-way", () => {
    const q = new AsyncEventQueue<number>();
    q.close();
    q.push(99);
    expect(q.size()).toBe(0);
  });

  it("notifies a waiting consumer when close fires after the consumer subscribed", async () => {
    const q = new AsyncEventQueue<number>();
    const iterator = q[Symbol.asyncIterator]();
    const pending = iterator.next();
    q.close();
    const result = await pending;
    expect(result.done).toBe(true);
  });

  it("drops queued values when clear is called", () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    q.push(2);
    expect(q.size()).toBe(2);
    q.clear();
    expect(q.size()).toBe(0);
  });

  it("releases waiting consumers when the iterator's return() is called (consumer hung up)", async () => {
    const q = new AsyncEventQueue<number>();
    const iterator = q[Symbol.asyncIterator]();
    const pending = iterator.next();
    await iterator.return!();
    const result = await pending;
    expect(result.done).toBe(true);
  });
});
