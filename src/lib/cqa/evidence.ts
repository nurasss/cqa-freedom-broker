import type { Answer, Criterion, TranscriptMessage } from "./types.ts";
import { answerAllowed } from "./score.ts";
import { officialCriteria } from "./seed.ts";

export interface LocatedHit {
  message: TranscriptMessage;
  exactIndex: boolean;
}

const greetRe =
  /здравств|добрый\s+(день|вечер|утро)|привет|сәлеметсіз|сәлем|салем|hello|hi\b|good\s+(morning|afternoon|evening)/i;
const introRe =
  /меня зовут|мо[её] имя|менің атым|my name is|this is\s+\p{L}{2,}|(?:i am|i'm)\s+[A-ZА-ЯЁӘІҢҒҮҰҚӨҺ][\p{L}'-]{1,}/iu;
export const confirmRe =
  /личность подтвержден\p{L}*|жеке бас\p{L}{0,4} растал(?:ды|ған)|identity (?:is |has been )?confirmed|идентификация пройден\p{L}*/iu;
const confirmDeniedRe =
  /личность\s+не\s+подтвержден|идентификация\s+не\s+пройден|identity\s+(?:is\s+)?not\s+confirmed|жеке бас\p{L}{0,4}\s+расталма/iu;
export const protectedRe =
  /на вашем сч[её]те|на счету\s+\d|шотыңызда|your balance is|the withdrawal is|вывод могу|(?:остаток|баланс|қалдық)\s*[-—:]?\s*\d|(?:ваш\s+)?(?:иин|жсн|паспорт)\s*[:№]?\s*\d{6,}/iu;
export const protectedRequestRe =
  /остаток|баланс|статус вывода|withdrawal|my balance|шотымда|на моём сч|на моем сч|мой иин|мой паспорт|номер карты/iu;

export function isIdentityConfirmation(text: string): boolean {
  if (confirmDeniedRe.test(text)) return false;
  return confirmRe.test(text);
}

export function hasProtectedDisclosure(text: string): boolean {
  return protectedRe.test(text);
}

export function canonicalSpeaker(raw: string): string {
  const speaker = raw.trim().toLowerCase();
  if (speaker === "operator" || speaker === "agent" || speaker === "оператор" || speaker === "агент") return "operator";
  if (speaker === "client" || speaker === "customer" || speaker === "клиент" || speaker === "user") return "client";
  if (speaker === "bot" || speaker === "бот") return "bot";
  if (speaker === "system" || speaker === "система") return "system";
  return raw.trim() || "unknown";
}

export function normText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function quoteHits(message: string, quote: string): boolean {
  const needle = normText(quote);
  return needle.length > 0 && normText(message).includes(needle);
}

export function locateQuote(
  messages: TranscriptMessage[],
  quote: string,
  preferred?: number,
): { hit: TranscriptMessage | null; elsewhere: TranscriptMessage | null } {
  const elsewhere = messages.find((item) => quoteHits(item.text, quote)) ?? null;
  if (preferred === undefined || !Number.isInteger(preferred)) {
    return { hit: null, elsewhere };
  }
  const exact = messages.find((item) => item.messageIndex === preferred) ?? null;
  if (exact && quoteHits(exact.text, quote)) return { hit: exact, elsewhere: exact };
  return { hit: null, elsewhere };
}

function claimKind(criterion: Criterion, answer: Answer): "action" | "violation" | "absence" | "na" {
  if (answer === "na") return "na";
  if (criterion.answerType === "flag" && answer === "yes") return "violation";
  if (answer === "no" || answer === 0) return "absence";
  return "action";
}

function greetingLanguageMismatch(messages: Pick<TranscriptMessage, "speaker" | "text">[]): boolean {
  const first = messages.find((item) => canonicalSpeaker(item.speaker) === "operator");
  const client = messages
    .filter((item) => canonicalSpeaker(item.speaker) === "client")
    .map((item) => item.text)
    .join("\n");
  if (!first || !client.trim()) return false;
  const clientKz = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/u.test(client);
  const clientCyr = /[А-Яа-яЁё]/u.test(client);
  const clientLatin = /[A-Za-z]/.test(client) && !clientCyr;
  const op = first.text;
  const ruGreet = /здравств|добрый\s+(день|вечер|утро)|привет/i.test(op);
  const kzGreet = /сәлеметсіз|сәлем|салем/i.test(op);
  const enGreet = /hello|hi\b|good\s+(morning|afternoon|evening)/i.test(op);
  if (clientKz && !kzGreet) return true;
  if (clientLatin && !enGreet) return true;
  if (!clientKz && clientCyr && !ruGreet) return true;
  return false;
}

export function contactEstablished(messages: Pick<TranscriptMessage, "speaker" | "text">[]): boolean {
  const first = messages.find((item) => canonicalSpeaker(item.speaker) === "operator");
  if (!first) return false;
  return greetRe.test(first.text) && introRe.test(first.text) && !greetingLanguageMismatch(messages);
}

export function isSubstantiveReply(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const greetingOrIntroOnlyRe =
    /^(?:здравств\p{L}*|добр\p{L}+\s+(?:день|вечер|утро)|привет\p{L}*|сәлем\p{L}*|hello|hi\b|good\s+(?:morning|afternoon|evening))[!.,\s]*(?:меня зовут\s+[\p{L}'-]+|мо[её] имя\s+[\p{L}'-]+|this is\s+[\p{L}'-]+|i am\s+[\p{L}'-]+)?[!.,\s]*(?:чем\s+(?:я\s+)?могу\s+(?:вам\s+)?помочь|слушаю вас|какой у вас вопрос)?[?.,!\s]*$/iu;
  const waitPhraseRe =
    /(?:^|[.,!?\s])(?:минуту|секунду|ожидайте|сейчас уточню|проверяю|подождите|один момент|сейчас посмотрю|секундочку|минуточку|күте тұрыңыз|please wait|one moment)/i;
  if (greetingOrIntroOnlyRe.test(trimmed)) return false;
  if (waitPhraseRe.test(trimmed) && !/\d|http|раздел|комисси|тариф|шотыңызда|баланс/i.test(trimmed)) {
    return false;
  }
  const isQuestionOnly =
    trimmed.endsWith("?") &&
    /^(?:уточните|подскажите|назовите|о каком|какой именно|правильно ли я понимаю)/i.test(trimmed);
  if (isQuestionOnly && !/\d|http|раздел|тариф|комисси/i.test(trimmed)) return false;
  return true;
}

export function expectedRange(
  messages: TranscriptMessage[],
  criterionOrId: Criterion | string,
): { from: number; to: number } | null {
  if (!messages.length) return null;
  const full = { from: messages[0]!.messageIndex, to: messages[messages.length - 1]!.messageIndex };
  const id = typeof criterionOrId === "string" ? criterionOrId : criterionOrId.id;
  const official = officialCriteria.find((item) => item.id === id);
  if (!official) return full;
  if (typeof criterionOrId === "object" && criterionOrId.rubric !== official.rubric) {
    return full;
  }
  if (id === "C01") {
    const firstOp = messages.find((item) => canonicalSpeaker(item.speaker) === "operator");
    return {
      from: messages[0]!.messageIndex,
      to: firstOp ? firstOp.messageIndex : messages[messages.length - 1]!.messageIndex,
    };
  }
  if (id === "C07") {
    const slice = messages.slice(-3);
    return {
      from: slice[0]!.messageIndex,
      to: messages[messages.length - 1]!.messageIndex,
    };
  }
  if (id === "C02") {
    const firstSubstantiveOp = messages.find(
      (item) => canonicalSpeaker(item.speaker) === "operator" && isSubstantiveReply(item.text),
    );
    if (firstSubstantiveOp) {
      return {
        from: messages[0]!.messageIndex,
        to: firstSubstantiveOp.messageIndex,
      };
    }
    return full;
  }
  return full;
}

function rangeOk(messages: TranscriptMessage[], range: { from: number; to: number } | null): range is { from: number; to: number } {
  if (!range) return false;
  const indexes = messages.map((item) => item.messageIndex);
  const min = Math.min(...indexes);
  const max = Math.max(...indexes);
  return range.from >= min && range.to <= max && range.from <= range.to;
}

export interface JudgedEvidence {
  evidence: { messageIndex: number; quote: string; speaker: string; timestampRaw: string }[];
  checkedRange: { from: number; to: number } | null;
  errors: string[];
  invalid: boolean;
}

export function judgeEvidence(
  criterion: Criterion,
  answer: Answer,
  quotes: { messageIndex: number; quote: string }[],
  checkedRange: { from: number; to: number } | null,
  messages: TranscriptMessage[],
): JudgedEvidence {
  const errors: string[] = [];
  const evidence: JudgedEvidence["evidence"] = [];
  let invalid = false;
  if (!answerAllowed(criterion, answer)) {
    invalid = true;
    errors.push(`${criterion.id}: недопустимый ответ для этой версии чек-листа`);
  }
  const kind = claimKind(criterion, answer);
  const defaultSpeakers: ("operator" | "system" | "bot")[] = ["operator"];
  const allowedSpeakers: ("operator" | "system" | "bot")[] =
    criterion.id === "C08" || kind === "violation"
      ? ["operator"]
      : criterion.evidenceSpeakers?.length
        ? criterion.evidenceSpeakers
        : defaultSpeakers;

  for (const quote of quotes) {
    const text = quote.quote?.trim() ?? "";
    if (!text) continue;
    const located = locateQuote(messages, text, quote.messageIndex);
    if (!located.hit) {
      invalid = true;
      if (located.elsewhere) {
        errors.push(
          `${criterion.id}: цитата есть в реплике ${located.elsewhere.messageIndex} (${canonicalSpeaker(located.elsewhere.speaker)}), но не в указанном индексе ${String(quote.messageIndex)}`,
        );
      } else {
        errors.push(`${criterion.id}: цитата не найдена в транскрипте`);
      }
      continue;
    }
    const speaker = canonicalSpeaker(located.hit.speaker);
    evidence.push({
      messageIndex: located.hit.messageIndex,
      quote: text,
      speaker,
      timestampRaw: located.hit.timestampRaw,
    });
    const isAllowed = (allowedSpeakers as string[]).includes(speaker);
    if ((kind === "action" || kind === "violation") && (!isAllowed || speaker === "client")) {
      invalid = true;
      errors.push(
        `${criterion.id}: цитата ${speaker} не подтверждает ${kind === "violation" ? "нарушение" : "действие"} оператора`,
      );
    }
  }

  let range = rangeOk(messages, checkedRange) ? checkedRange : null;
  if (checkedRange && !range) {
    invalid = true;
    errors.push(`${criterion.id}: диапазон вне транскрипта`);
  }
  if (kind === "absence" && !range && messages.length) {
    range = expectedRange(messages, criterion);
  }
  if (
    (kind === "action" || kind === "violation") &&
    !evidence.some(
      (item) => (allowedSpeakers as string[]).includes(item.speaker) && item.speaker !== "client",
    )
  ) {
    invalid = true;
    if (!errors.some((line) => line.startsWith(criterion.id))) {
      errors.push(`${criterion.id}: нет подтверждённой цитаты оператора`);
    }
  }
  return { evidence, checkedRange: range, errors, invalid };
}
