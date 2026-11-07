export interface MediaOffsetResult {
  seconds: number;
  approximate: boolean;
}

const ISO_REGEX = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i;

function parseIso(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!ISO_REGEX.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

function parseExact(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const head = Number(match[1]);
  const mid = Number(match[2]);
  const tail = match[3] === undefined ? null : Number(match[3]);
  if (mid >= 60 || (tail !== null && tail >= 60)) return null;
  if (tail === null) return head * 60 + mid;
  return head * 3600 + mid * 60 + tail;
}

export function mediaOffset(
  messages: { timestampRaw?: string; messageIndex?: number }[],
  messageIndex: number,
): MediaOffsetResult | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const target = messages.find((item) => item.messageIndex === messageIndex);
  if (!target || !target.timestampRaw) return null;

  const exactSeconds = parseExact(target.timestampRaw);
  if (exactSeconds !== null) {
    return { seconds: exactSeconds, approximate: false };
  }

  const targetIsoMs = parseIso(target.timestampRaw);
  if (targetIsoMs !== null) {
    let firstIsoMs: number | null = null;
    for (const msg of messages) {
      const parsed = parseIso(msg.timestampRaw);
      if (parsed !== null) {
        firstIsoMs = parsed;
        break;
      }
    }

    if (firstIsoMs !== null) {
      const diffSec = Math.max(0, (targetIsoMs - firstIsoMs) / 1000);
      return { seconds: diffSec, approximate: true };
    }
  }

  return null;
}

export function parseTimestampToSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const exact = parseExact(value);
  if (exact !== null) return exact;
  const isoMs = parseIso(value);
  if (isoMs !== null) return Math.floor(isoMs / 1000);
  return null;
}

export function formatPause(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded >= 3600) {
    const h = Math.floor(rounded / 3600);
    const m = Math.floor((rounded % 3600) / 60);
    const s = rounded % 60;
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  const m = Math.floor(rounded / 60);
  const s = rounded % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function getPauseNote(
  current: { timestampRaw?: string },
  previous?: { timestampRaw?: string },
): string {
  if (!previous || !previous.timestampRaw || !current.timestampRaw) return "";
  const tPrev = parseTimestampToSeconds(previous.timestampRaw);
  const tCurr = parseTimestampToSeconds(current.timestampRaw);
  if (tPrev === null || tCurr === null) return "";
  const diffSec = tCurr - tPrev;
  if (diffSec >= 60) {
    return ` (пауза ${formatPause(diffSec)})`;
  }
  return "";
}

