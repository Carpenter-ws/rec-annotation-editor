/** Serialize writes so an older, slower save cannot overwrite newer edits. */
export class SaveQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(write: () => Promise<T>): Promise<T> {
    const result = this.tail.then(write, write);
    this.tail = result.catch(() => {});
    return result;
  }
  async idle(): Promise<void> { await this.tail; }
}
