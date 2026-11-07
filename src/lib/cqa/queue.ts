export type QueueItemStatus = "pending" | "running" | "completed" | "failed" | "needs_review" | "cancelled";

export interface QueueSnapshot {
  id: string;
  status: QueueItemStatus;
  attempts: number;
  message?: string;
}

export interface QueueOutcome {
  status: "completed" | "partial" | "failed" | "cancelled";
  items: QueueSnapshot[];
  completed: number;
  failed: number;
  needsReview: number;
}

export interface QueueOptions<T> {
  items: { id: string; payload: T }[];
  concurrency: number;
  maxAttempts: number;
  retryDelayMs: number;
  isCancelled?: () => boolean;
  onUpdate?: (items: QueueSnapshot[]) => void;
  work: (payload: T, attempt: number) => Promise<"completed" | "needs_review">;
}

export function createBatchRunner() {
  let active = false;
  return {
    get running() {
      return active;
    },
    async run<T>(options: QueueOptions<T>): Promise<QueueOutcome> {
      if (active) throw new Error("Пакет уже выполняется");
      active = true;
      try {
        return await runQueue(options);
      } finally {
        active = false;
      }
    },
  };
}

export async function runQueue<T>(options: QueueOptions<T>): Promise<QueueOutcome> {
  const concurrency = Math.max(1, Math.min(4, Math.floor(options.concurrency) || 1));
  const maxAttempts = Math.max(1, Math.min(3, Math.floor(options.maxAttempts) || 1));
  const items: QueueSnapshot[] = options.items.map((item) => ({ id: item.id, status: "pending", attempts: 0 }));
  const byId = new Map(options.items.map((item) => [item.id, item.payload]));
  let cursor = 0;

  const publish = () => options.onUpdate?.(items.map((item) => ({ ...item })));

  async function runOne(index: number) {
    const snapshot = items[index]!;
    const payload = byId.get(snapshot.id)!;
    while (snapshot.attempts < maxAttempts) {
      if (options.isCancelled?.()) {
        snapshot.status = "cancelled";
        publish();
        return;
      }
      snapshot.attempts += 1;
      snapshot.status = "running";
      publish();
      try {
        snapshot.status = await options.work(payload, snapshot.attempts);
        snapshot.message = undefined;
        publish();
        return;
      } catch (reason) {
        snapshot.status = "failed";
        snapshot.message = reason instanceof Error ? reason.message : "ошибка";
        publish();
        if (snapshot.attempts >= maxAttempts || options.isCancelled?.()) return;
        if (options.retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
      }
    }
  }

  async function worker() {
    while (cursor < items.length) {
      if (options.isCancelled?.()) return;
      const index = cursor;
      cursor += 1;
      await runOne(index);
    }
  }

  publish();
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  if (options.isCancelled?.()) {
    for (const item of items) {
      if (item.status === "pending" || item.status === "running") item.status = "cancelled";
    }
  }
  publish();
  const completed = items.filter((item) => item.status === "completed").length;
  const needsReview = items.filter((item) => item.status === "needs_review").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const cancelled = items.some((item) => item.status === "cancelled");
  const status = cancelled ? "cancelled" : failed && (completed || needsReview) ? "partial" : failed ? "failed" : "completed";
  return { status, items, completed, failed, needsReview };
}
