import type {
  Answer,
  Conversation,
  Criterion,
  CriterionResult,
  EvalStatus,
  TranscriptMessage,
} from "./types.ts";
import { answerAllowed, computeScore, type ScoreOutcome } from "./score.ts";
import { canonicalSpeaker, judgeEvidence } from "./evidence.ts";

export { quoteHits } from "./evidence.ts";

export interface DraftAnswer {
  criterionId: string;
  answer: Answer;
  reason: string;
  quotes: { messageIndex: number; quote: string }[];
  checkedRange: { from: number; to: number } | null;
  naReason: string | null;
  unbound?: boolean;
}

export function coerceAnswer(value: unknown, criterion: Criterion): Answer | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return answerAllowed(criterion, value) ? value : null;
  }
  if (typeof value === "boolean") {
    const answer: Answer = value ? "yes" : "no";
    return answerAllowed(criterion, answer) ? answer : null;
  }
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  const mapped: Answer | null =
    token === "yes" || token === "да" || token === "y" || token === "true"
      ? "yes"
      : token === "no" || token === "нет" || token === "n" || token === "false"
        ? "no"
        : token === "na" || token === "n/a" || token === "н/д" || token === "н/п" || token === "not applicable"
          ? "na"
          : /^-?\d+$/.test(token)
            ? Number(token)
            : null;
  if (mapped === null) return null;
  return answerAllowed(criterion, mapped) ? mapped : null;
}

export function parseMediaOffset(timestampRaw: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timestampRaw.trim());
  if (!match) return null;
  const head = Number(match[1]);
  const mid = Number(match[2]);
  const tail = match[3] === undefined ? null : Number(match[3]);
  if (tail === null) return head * 60 + mid;
  return head * 3600 + mid * 60 + tail;
}

export interface Assembled {
  results: CriterionResult[];
  outcome: ScoreOutcome;
  status: EvalStatus;
  errors: string[];
}

export function assemble(
  criteria: Criterion[],
  messages: TranscriptMessage[],
  drafts: DraftAnswer[],
): Assembled {
  const errors: string[] = [];
  const byId = new Map(drafts.map((draft) => [draft.criterionId, draft]));
  const results: CriterionResult[] = [];
  const answers: Record<string, Answer> = {};
  let evidenceBad = false;
  let answerBad = false;

  const known = new Set(criteria.map((item) => item.id));
  for (const draft of drafts) {
    if (!known.has(draft.criterionId)) errors.push(`Неизвестный критерий ${draft.criterionId}`);
  }

  for (const criterion of criteria) {
    const draft = byId.get(criterion.id);
    if (!draft) {
      answerBad = true;
      errors.push(`Нет результата ${criterion.id}`);
      continue;
    }
    if (!answerAllowed(criterion, draft.answer)) {
      answerBad = true;
      errors.push(`${criterion.id}: недопустимый ответ`);
      continue;
    }
    const judged = judgeEvidence(criterion, draft.answer, draft.quotes, draft.checkedRange, messages);
    if (judged.invalid) evidenceBad = true;
    errors.push(...judged.errors);
    const critErrors: string[] = [...judged.errors];
    if (draft.reason.trim().length < 4) {
      evidenceBad = true;
      errors.push(`${criterion.id}: нет объяснения`);
      critErrors.push(`${criterion.id}: нет объяснения`);
    }
    if (draft.unbound) {
      evidenceBad = true;
      errors.push(`${criterion.id}: формулировка изменена, старая семантика идентификатора не применяется`);
      critErrors.push(`${criterion.id}: формулировка изменена, старая семантика идентификатора не применяется`);
    }
    if (draft.answer === "na" && !(draft.naReason && draft.naReason.trim().length >= 4)) {
      evidenceBad = true;
      errors.push(`${criterion.id}: N/A без причины`);
      critErrors.push(`${criterion.id}: N/A без причины`);
    }
    answers[criterion.id] = draft.answer;
    const weight = criterion.weight;
    const needsProof = judged.invalid;
    results.push({
      criterionId: criterion.id,
      answer: draft.answer,
      reason: draft.reason.trim(),
      evidence: judged.evidence,
      checkedRange: judged.checkedRange,
      naReason: draft.answer === "na" ? draft.naReason : null,
      validationStatus: needsProof || draft.unbound ? "invalid_evidence" : "ok",
      evidenceError: (needsProof || draft.unbound) && critErrors.length ? critErrors.join("; ") : undefined,
      weight,
      normalized: null,
      contribution: null,
      isNa: draft.answer === "na",
      critical: criterion.answerType === "flag" && draft.answer === "yes" && !needsProof,
    });
  }

  if (answerBad || Object.keys(answers).length !== criteria.length) {
    return {
      results,
      outcome: {
        status: "invalid",
        total: null,
        raw: null,
        critical: false,
        denominator: 0,
        lines: [],
        sections: [],
        error: errors[0] ?? "Неполный ответ",
      },
      status: "failed",
      errors,
    };
  }

  const outcome = computeScore(criteria, answers);
  const lineById = new Map(outcome.lines.map((line) => [line.criterionId, line]));
  for (const result of results) {
    const line = lineById.get(result.criterionId);
    if (!line) continue;
    result.normalized = line.normalized;
    result.contribution = line.contribution;
    result.isNa = result.answer === "na";
    result.critical = line.critical && result.validationStatus === "ok";
    result.weight = line.weight;
  }
  outcome.critical = results.some((result) => result.critical);

  let status: EvalStatus = "completed";
  if (outcome.status === "not_scorable") status = "not_scorable";
  else if (outcome.status === "invalid") status = "failed";
  else if (evidenceBad) status = "needs_review";

  return { results, outcome, status, errors };
}

export function safeAudioUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return url;
  } catch {
    return null;
  }
  return null;
}

interface RawRecord {
  conversation_id?: string;
  channel?: string;
  language?: string;
  transcript?: { timestamp?: string; speaker?: string; text?: string }[];
  audio_url?: string | null;
}

export function parseImport(
  payload: unknown,
  fallbackGroup: string,
  origin: Conversation["origin"] = "upload",
): { conversations: Conversation[]; groupId: string; error?: string; expected?: number; channels: { chat: number; call: number } } {
  let groupId = fallbackGroup.trim() || "UPLOAD";
  let records: RawRecord[] = [];
  let expected: number | undefined;

  if (Array.isArray(payload)) {
    records = payload as RawRecord[];
  } else if (payload && typeof payload === "object") {
    const body = payload as {
      isSuccess?: boolean;
      error?: string;
      data?: { dataset_group_id?: string; total_records?: number; records?: RawRecord[] };
      records?: RawRecord[];
    };
    if (body.isSuccess === false) {
      return {
        conversations: [],
        groupId,
        channels: { chat: 0, call: 0 },
        error: body.error?.trim() || "Источник вернул isSuccess=false",
      };
    }
    if (body.data?.dataset_group_id) groupId = body.data.dataset_group_id;
    if (typeof body.data?.total_records === "number") expected = body.data.total_records;
    records = body.data?.records ?? body.records ?? [];
  } else {
    return { conversations: [], groupId, channels: { chat: 0, call: 0 }, error: "JSON не похож на набор диалогов" };
  }

  if (!Array.isArray(records) || records.length === 0) {
    return { conversations: [], groupId, channels: { chat: 0, call: 0 }, error: "В наборе нет records" };
  }

  const conversations: Conversation[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  records.forEach((record, index) => {
    const externalId = String(record.conversation_id ?? "").trim();
    const transcript = record.transcript;
    if (!externalId || !Array.isArray(transcript) || transcript.length === 0) {
      skipped.push(`запись ${index + 1}`);
      return;
    }
    if (seen.has(externalId)) {
      skipped.push(`дубль ${externalId}`);
      return;
    }
    seen.add(externalId);
    const messages = transcript.map((item, messageIndex) => ({
      messageIndex,
      timestampRaw: item?.timestamp === undefined || item.timestamp === null ? "" : String(item.timestamp),
      speaker: canonicalSpeaker(String(item?.speaker ?? "unknown")),
      text: String(item?.text ?? ""),
    }));
    if (messages.every((item) => !item.text.trim())) {
      skipped.push(`пустой текст ${externalId}`);
      return;
    }
    conversations.push({
      id: `${groupId}::${externalId}`,
      datasetGroupId: groupId,
      externalId,
      channel: String(record.channel ?? "agent chat"),
      language: String(record.language ?? "RU"),
      audioUrl: record.audio_url ?? null,
      origin,
      messages,
    });
  });

  if (!conversations.length) {
    return { conversations: [], groupId, channels: { chat: 0, call: 0 }, error: "Все записи повреждены" };
  }
  const notes: string[] = [];
  if (skipped.length) notes.push(`Пропущены: ${skipped.join(", ")}`);
  if (expected !== undefined && expected !== conversations.length) {
    notes.push(`total_records=${expected}, разобрано ${conversations.length}`);
  }
  const call = conversations.filter((item) => item.channel === "voice call").length;
  return {
    conversations,
    groupId,
    expected,
    channels: { chat: conversations.length - call, call },
    error: notes.length ? notes.join(". ") : undefined,
  };
}

export function draftsFromModelPayload(criteria: Criterion[], payload: unknown): { drafts: DraftAnswer[]; errors: string[] } {
  const errors: string[] = [];
  const record = payload && typeof payload === "object" ? (payload as { criteria?: unknown }) : null;
  const list = Array.isArray(record?.criteria) ? record.criteria : Array.isArray(payload) ? payload : null;
  if (!list) return { drafts: [], errors: ["Модель вернула не список criteria"] };
  const drafts: DraftAnswer[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      criterion_id?: string;
      answer?: unknown;
      reason?: string;
      evidence?: { message_index?: number; quote?: string }[];
      checked_range?: { from?: number; to?: number } | null;
      na_reason?: string | null;
    };
    const id = String(row.criterion_id ?? "");
    const criterion = criteria.find((entry) => entry.id === id);
    if (!criterion) {
      errors.push(`Лишний id ${id}`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`Дубль ${id}`);
      continue;
    }
    seen.add(id);
    const answer = coerceAnswer(row.answer, criterion);
    if (answer === null) {
      errors.push(`${id}: ответ ${JSON.stringify(row.answer)} недопустим`);
      continue;
    }
    const range = row.checked_range;
    drafts.push({
      criterionId: id,
      answer,
      reason: String(row.reason ?? ""),
      quotes: Array.isArray(row.evidence)
        ? row.evidence
            .filter((quote) => quote && typeof quote.quote === "string")
            .map((quote) => ({ messageIndex: Number(quote.message_index), quote: String(quote.quote) }))
        : [],
      checkedRange:
        range && typeof range.from === "number" && typeof range.to === "number" ? { from: range.from, to: range.to } : null,
      naReason: row.na_reason ? String(row.na_reason) : null,
    });
  }
  for (const criterion of criteria) {
    if (!seen.has(criterion.id)) errors.push(`Нет ${criterion.id}`);
  }
  return { drafts, errors };
}
