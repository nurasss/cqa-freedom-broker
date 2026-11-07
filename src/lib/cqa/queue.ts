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
  spent?: number;
  stoppedByBudget?: boolean;
  stoppedByFatal?: boolean;
  fatalCode?: string;
  fatalMessage?: string;
}

export interface WorkResult {
  status: "completed" | "needs_review";
  costUsd?: number;
}

export type WorkReturn = "completed" | "needs_review" | WorkResult;

export interface QueueOptions<T> {
  items: { id: string; payload: T }[];
  concurrency: number;
  maxAttempts: number;
  retryDelayMs: number;
  costCap?: number;
  estimateCostUsd?: number | ((payload: T) => number);
  isCancelled?: () => boolean;
  onUpdate?: (items: QueueSnapshot[]) => void;
  work: (payload: T, attempt: number) => Promise<WorkReturn>;
}

export function isFatalQueueError(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  if ("fatal" in reason && Boolean((reason as { fatal?: unknown }).fatal)) return true;
  if ("code" in reason) {
    const code = (reason as { code?: unknown }).code;
    if (code === "no_api_key" || code === "auth" || code === "model_not_found") return true;
  }
  return false;
}

export function resolveCancelledStatus(
  status: QueueItemStatus,
  currentMessage?: string,
): { status: QueueItemStatus; message?: string } {
  if (status === "running") {
    return { status: "failed", message: "отменено" };
  }
  if (status === "pending" || status === "cancelled") {
    return { status: "pending", message: undefined };
  }
  return { status, message: currentMessage };
}

export function mapCancelledItem<T extends { status: QueueItemStatus; message?: string }>(
  item: T,
): T & { status: QueueItemStatus; message?: string } {
  const resolved = resolveCancelledStatus(item.status, item.message);
  return { ...item, status: resolved.status, message: resolved.message };
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
  let spent = 0;
  let reserved = 0;
  let stoppedByBudget = false;
  let stoppedByFatal = false;
  let fatalCode: string | undefined;
  let fatalMessage: string | undefined;

  const costCap = typeof options.costCap === "number" && options.costCap > 0 ? options.costCap : undefined;

  function getEstimate(payload: T): number {
    if (typeof options.estimateCostUsd === "function") {
      return options.estimateCostUsd(payload) ?? 0;
    }
    if (typeof options.estimateCostUsd === "number") {
      return options.estimateCostUsd ?? 0;
    }
    return 0;
  }

  const publish = () => options.onUpdate?.(items.map((item) => ({ ...item })));

  async function runOne(index: number, estimate: number) {
    const snapshot = items[index]!;
    const payload = byId.get(snapshot.id)!;
    while (snapshot.attempts < maxAttempts) {
      if (options.isCancelled?.()) {
        snapshot.status = "failed";
        snapshot.message = "отменено";
        publish();
        return;
      }
      snapshot.attempts += 1;
      snapshot.status = "running";
      publish();
      try {
        const result = await options.work(payload, snapshot.attempts);
        const status = typeof result === "object" && result !== null ? result.status : result;
        const factCost =
          typeof result === "object" && result !== null && typeof result.costUsd === "number"
            ? result.costUsd
            : estimate;

        if (costCap !== undefined) {
          reserved -= estimate;
          spent += factCost;
        }

        snapshot.status = status;
        snapshot.message = undefined;
        publish();
        return;
      } catch (reason) {
        const costFromError =
          reason && typeof reason === "object" && "costUsd" in reason && typeof (reason as { costUsd?: unknown }).costUsd === "number"
            ? (reason as { costUsd: number }).costUsd
            : undefined;

        if (costCap !== undefined) {
          reserved -= estimate;
          if (costFromError !== undefined) spent += costFromError;
        }

        const isFatal = isFatalQueueError(reason);
        if (isFatal) {
          stoppedByFatal = true;
          if (typeof reason === "object" && reason !== null) {
            if ("code" in reason && typeof (reason as { code?: unknown }).code === "string") {
              fatalCode = (reason as { code: string }).code;
            }
          }
          if (!fatalCode) {
            fatalCode = "auth";
          }
          fatalMessage = reason instanceof Error ? reason.message : "фатальная ошибка";
        }

        if (options.isCancelled?.()) {
          snapshot.status = "failed";
          snapshot.message = "отменено";
          publish();
          return;
        }

        snapshot.status = "failed";
        snapshot.message = reason instanceof Error ? reason.message : "ошибка";
        publish();
        if (isFatal || snapshot.attempts >= maxAttempts) return;
        if (options.retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
        if (costCap !== undefined) {
          reserved += estimate;
        }
      }
    }
  }

  async function worker() {
    while (cursor < items.length) {
      if (options.isCancelled?.()) return;
      if (stoppedByFatal) return;

      const nextIndex = cursor;
      const nextItem = items[nextIndex];
      if (!nextItem) return;

      const payload = byId.get(nextItem.id)!;
      const estimate = getEstimate(payload);

      if (costCap !== undefined) {
        // Не запускай новый, если потрачено плюс резерв ≥ лимита
        if (spent + reserved >= costCap) {
          stoppedByBudget = true;
          return;
        }
        // Перед запуском диалога резервируй оценку его стоимости
        if (spent + reserved + estimate > costCap && (spent > 0 || reserved > 0)) {
          stoppedByBudget = true;
          return;
        }
        reserved += estimate;
      }

      cursor += 1;
      await runOne(nextIndex, estimate);
    }
  }

  publish();
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

  if (options.isCancelled?.()) {
    for (let i = 0; i < items.length; i++) {
      items[i] = mapCancelledItem(items[i]!);
    }
  }
  publish();

  const completed = items.filter((item) => item.status === "completed").length;
  const needsReview = items.filter((item) => item.status === "needs_review").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const pending = items.filter((item) => item.status === "pending").length;
  const cancelled = options.isCancelled?.() || items.some((item) => item.message === "отменено");

  const status = cancelled
    ? "cancelled"
    : failed && (completed || needsReview)
      ? "partial"
      : pending && (completed || needsReview)
        ? "partial"
        : failed
          ? "failed"
          : "completed";

  const hasPendingFromBudget = items.some((item) => item.status === "pending") && stoppedByBudget;
  const outcomeStoppedByBudget = !options.isCancelled?.() && hasPendingFromBudget;

  return {
    status,
    items,
    completed,
    failed,
    needsReview,
    spent,
    stoppedByBudget: outcomeStoppedByBudget,
    stoppedByFatal,
    fatalCode,
    fatalMessage,
  };
}
