/** A tiny Map-compatible LRU used only for reconstructable runtime hints. */
export class BoundedLruMap<K, V> extends Map<K, V> {
  readonly capacity: number;

  constructor(capacity: number) {
    super();
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError('LRU capacity must be a positive safe integer');
    }
    this.capacity = capacity;
  }

  override get(key: K): V | undefined {
    const value = super.get(key);
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.capacity) {
      const oldest = this.keys().next();
      if (oldest.done === true) break;
      super.delete(oldest.value);
    }
    return this;
  }
}
