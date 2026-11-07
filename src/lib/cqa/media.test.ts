import assert from "node:assert/strict";
import test from "node:test";
import { mediaOffset } from "./media.ts";

test("media.ts: MM:SS, HH:MM:SS, ISO с разными часовыми поясами, мусор", () => {
  // 1. Точные значения MM:SS и HH:MM:SS
  const exactMessages = [
    { messageIndex: 0, timestampRaw: "00:05" },
    { messageIndex: 1, timestampRaw: "02:15" },
    { messageIndex: 2, timestampRaw: "01:02:03" },
  ];

  assert.deepEqual(mediaOffset(exactMessages, 0), { seconds: 5, approximate: false });
  assert.deepEqual(mediaOffset(exactMessages, 1), { seconds: 135, approximate: false });
  assert.deepEqual(mediaOffset(exactMessages, 2), { seconds: 3723, approximate: false });

  // 2. ISO 8601 с разными часовыми поясами
  // Сообщения:
  // 0: 10:00:00+03:00 (07:00:00 UTC) -> база (0 сек)
  // 1: 09:00:45+02:00 (07:00:45 UTC) -> +45 сек
  // 2: 07:01:20Z (07:01:20 UTC) -> +80 сек
  // 3: 13:02:00+06:00 (07:02:00 UTC) -> +120 сек
  const isoMessages = [
    { messageIndex: 0, timestampRaw: "2026-03-01T10:00:00+03:00" },
    { messageIndex: 1, timestampRaw: "2026-03-01T09:00:45+02:00" },
    { messageIndex: 2, timestampRaw: "2026-03-01T07:01:20Z" },
    { messageIndex: 3, timestampRaw: "2026-03-01T13:02:00+06:00" },
  ];

  assert.deepEqual(mediaOffset(isoMessages, 0), { seconds: 0, approximate: true });
  assert.deepEqual(mediaOffset(isoMessages, 1), { seconds: 45, approximate: true });
  assert.deepEqual(mediaOffset(isoMessages, 2), { seconds: 80, approximate: true });
  assert.deepEqual(mediaOffset(isoMessages, 3), { seconds: 120, approximate: true });

  // Если первой репликой идёт мусор, база отсчёта берётся от первой реплики с корректным ISO
  const isoWithLeadingGarbage = [
    { messageIndex: 0, timestampRaw: "invalid-time" },
    { messageIndex: 1, timestampRaw: "2026-03-01T07:00:00Z" },
    { messageIndex: 2, timestampRaw: "2026-03-01T07:00:30Z" },
  ];

  assert.equal(mediaOffset(isoWithLeadingGarbage, 0), null);
  assert.deepEqual(mediaOffset(isoWithLeadingGarbage, 1), { seconds: 0, approximate: true });
  assert.deepEqual(mediaOffset(isoWithLeadingGarbage, 2), { seconds: 30, approximate: true });

  // 3. Мусор
  const garbageMessages = [
    { messageIndex: 0, timestampRaw: "undefined" },
    { messageIndex: 1, timestampRaw: "not-a-timestamp" },
    { messageIndex: 2, timestampRaw: "99:99" }, // секунды >= 60
    { messageIndex: 3, timestampRaw: "" },
    { messageIndex: 4, timestampRaw: "12345" },
  ];

  assert.equal(mediaOffset(garbageMessages, 0), null);
  assert.equal(mediaOffset(garbageMessages, 1), null);
  assert.equal(mediaOffset(garbageMessages, 2), null);
  assert.equal(mediaOffset(garbageMessages, 3), null);
  assert.equal(mediaOffset(garbageMessages, 4), null);
  assert.equal(mediaOffset(garbageMessages, 99), null); // несуществующий индекс
});
