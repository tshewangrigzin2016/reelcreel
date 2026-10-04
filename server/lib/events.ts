type Event = { type: "library" } | { type: "removed"; ids: string[] };
const subscribers = new Set<(event: Event) => void>();
export function publish(event: Event): void {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {}
  }
}
export function subscribeEvents(fn: (event: Event) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
