import { expect, it } from "vitest";
import { SaveQueue } from "./saveQueue";
it("keeps newest contents last even when the first save is slow, and recovers after errors", async () => {
  const queue = new SaveQueue();
  let release!: () => void;
  const written: string[] = [];
  const a = queue.run(async () => { await new Promise<void>(resolve => { release = resolve; }); written.push("old"); });
  const b = queue.run(async () => { written.push("new"); });
  await Promise.resolve();
  expect(written).toEqual([]);
  release(); await Promise.all([a,b]);
  expect(written).toEqual(["old", "new"]);
  await expect(queue.run(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  await queue.run(async () => { written.push("retry"); });
  expect(written.at(-1)).toBe("retry");
});
