import type { Conversation, Criterion } from "./types.ts";
import type { DraftAnswer } from "./engine.ts";
import { confirmRe, contactEstablished, hasProtectedDisclosure, isIdentityConfirmation, protectedRe, protectedRequestRe } from "./evidence.ts";
import { officialCriteria } from "./seed.ts";

type Msg = Conversation["messages"][number];

const questionRe = /\?/;
const complaintRe = /недово|жалоб|ужас|проблем|unhappy|angry|pending|наразы|ыңғайсыз|опять не|delay/i;
const empathyRe = /сожал|неудобств|понимаю|sorry|inconvenience|кешір|exactly the issue|проверю именно|эта задержк/i;
const politeRe = /пожалуйста|благодар|спасибо|здравствуйте|сәлем|hello|рахмет|хорошего|goodbye/i;
const byeRe = /до свидан|всего доброго|хорошего дня|сау бол|goodbye|good day|көріскенше/i;
const summaryRe = /итого|қорытынды|summary|могу ещё|чем-то помочь|anything else|тағы көмек|если появятся|happy to help/i;
const brokeRe = /покинул чат|закрыл чат|обрыв|disconnected|left the chat/i;
const insultRe = /дурак|идиот|туп(ой|ая)|ерунд|ақымақ|stupid|idiot|зря отнимаете/i;
const bypassRe = /на мою карту|личн\p{L}{0,3} карт|мой kaspi|мой каспи|в обход компан|private consult|платно проконсультир|переведите мне/iu;
const leakRe = /друг(ого|ой) клиент|чуж\p{L}{0,3} паспорт|another client'?s/iu;
const concreteRe = /\d|рынки|раздел|приложение|қалдық|комисси|0,3%|0\.3%/i;
const wrongRe = /всегда бесплатно|комиссия ноль/i;
const messyRe = /хотя нет|неважно,/i;

function ops(messages: Msg[]): Msg[] {
  return messages.filter((item) => item.speaker === "operator");
}

function quoteOf(message: Msg | undefined): DraftAnswer["quotes"] {
  if (!message) return [];
  const quote = message.text.length > 220 ? message.text.slice(0, 220) : message.text;
  return [{ messageIndex: message.messageIndex, quote }];
}

function fullRange(messages: Msg[]): { from: number; to: number } | null {
  if (!messages.length) return null;
  return { from: 0, to: messages.length - 1 };
}

function c01(messages: Msg[]): DraftAnswer["answer"] {
  return contactEstablished(messages) ? "yes" : "no";
}

function c02(messages: Msg[]): DraftAnswer["answer"] {
  const operators = ops(messages);
  if (operators.some((item) => questionRe.test(item.text))) return "yes";
  const client = messages
    .filter((item) => item.speaker === "client")
    .map((item) => item.text)
    .join(" ");
  const rich = client.length > 100 && /\d|AAPL|тариф|қалдық|withdraw/i.test(client);
  return rich ? "na" : "no";
}

function c03(messages: Msg[]): DraftAnswer["answer"] {
  let confirmed = false;
  let protectedHit = false;
  let disclosedBefore = false;
  const clientAsked = messages.some((item) => item.speaker === "client" && protectedRequestRe.test(item.text));
  for (const message of messages) {
    if (message.speaker !== "operator") continue;
    const confirmAt = isIdentityConfirmation(message.text) ? message.text.search(confirmRe) : -1;
    const protectedAt = hasProtectedDisclosure(message.text) ? message.text.search(protectedRe) : -1;
    if (protectedAt !== -1) protectedHit = true;
    if (protectedAt !== -1 && !confirmed && (confirmAt === -1 || protectedAt < confirmAt)) disclosedBefore = true;
    if (confirmAt !== -1) confirmed = true;
  }
  if (disclosedBefore || ((protectedHit || clientAsked) && !confirmed)) return "no";
  if (!protectedHit && !clientAsked) return "na";
  return "yes";
}

function c04(messages: Msg[]): DraftAnswer["answer"] {
  const client = messages
    .filter((item) => item.speaker === "client")
    .map((item) => item.text)
    .join(" ");
  const operator = ops(messages)
    .map((item) => item.text)
    .join(" ");
  const broke = messages.some((item) => brokeRe.test(item.text));
  const formulated = /комисс|тариф|акци|пополн|заявк|fee|tariff|stock|order/i.test(client);
  if (broke && client.trim().length < 40 && !formulated) return "na";
  if (wrongRe.test(operator)) return 0;
  if (/не знаю|не подскажу/i.test(operator) && !concreteRe.test(operator)) return 5;
  const asksTransfer = /между счетами|перевести бумаги/i.test(client);
  const answersTransfer = /перевод бумаг|депозитар|между счетами/i.test(operator);
  if (asksTransfer && !answersTransfer && concreteRe.test(operator)) return 10;
  if (concreteRe.test(operator) && summaryRe.test(operator)) return 20;
  if (concreteRe.test(operator)) return 15;
  if (!operator.trim()) return 0;
  return 5;
}

function c05(messages: Msg[]): DraftAnswer["answer"] {
  const client = messages
    .filter((item) => item.speaker === "client")
    .map((item) => item.text)
    .join(" ");
  const operator = ops(messages)
    .map((item) => item.text)
    .join(" ");
  if (complaintRe.test(client)) return empathyRe.test(operator) ? "yes" : "no";
  return politeRe.test(operator) ? "yes" : "no";
}

function c06(messages: Msg[]): DraftAnswer["answer"] {
  const client = messages
    .filter((item) => item.speaker === "client")
    .map((item) => item.text)
    .join(" ");
  const operator = ops(messages)
    .map((item) => item.text)
    .join(" ");
  if (messyRe.test(operator) || wrongRe.test(operator)) return 0;
  if (/не понял|повторите|what do you mean/i.test(client)) return 4;
  if (/поправлю формулировку|уточню мысль/i.test(operator)) return 7;
  return 10;
}

function c07(messages: Msg[]): DraftAnswer["answer"] {
  const operator = ops(messages)
    .map((item) => item.text)
    .join(" ");
  const broke = messages.some((item) => brokeRe.test(item.text));
  const bye = byeRe.test(operator);
  if (broke && !bye) return "na";
  if (bye && summaryRe.test(operator)) return "yes";
  return "no";
}

function c08(messages: Msg[]): DraftAnswer["answer"] {
  const operator = ops(messages)
    .map((item) => item.text)
    .join(" ");
  if (insultRe.test(operator) || bypassRe.test(operator) || leakRe.test(operator)) return "yes";
  return "no";
}

const HANDLERS: Record<string, (messages: Msg[]) => Answerish> = {
  C01: c01,
  C02: c02,
  C03: c03,
  C04: c04,
  C05: c05,
  C06: c06,
  C07: c07,
  C08: c08,
};

type Answerish = DraftAnswer["answer"];

function reasonFor(id: string, answer: Answerish): string {
  const label = typeof answer === "number" ? String(answer) : answer === "yes" ? "ДА" : answer === "no" ? "НЕТ" : "N/A";
  return `Эвристика ${id}: ${label}. Это не эталон жюри — для контрольной точности запустите Grok.`;
}

function usesOfficialHandler(criterion: Criterion): boolean {
  const official = officialCriteria.find((item) => item.id === criterion.id);
  if (!official || !(criterion.id in HANDLERS)) return false;
  return (
    official.rubric === criterion.rubric &&
    official.answerType === criterion.answerType &&
    official.naAllowed === criterion.naAllowed
  );
}

export function rulesDrafts(criteria: Criterion[], conversation: Conversation): DraftAnswer[] {
  const messages = conversation.messages;
  const firstOp = ops(messages)[0];
  const pick = (pred: (text: string) => boolean) => ops(messages).find((item) => pred(item.text));
  return criteria.map((criterion) => {
    const officialHandler = usesOfficialHandler(criterion);
    const fallback: Answerish = criterion.answerType === "scale" ? (criterion.scale?.steps[0] ?? 0) : "no";
    let answer: Answerish = officialHandler ? HANDLERS[criterion.id]!(messages) : fallback;
    if (criterion.answerType === "yes_no" || criterion.answerType === "flag") {
      if (answer !== "yes" && answer !== "no") answer = "no";
    }
    if (criterion.answerType === "yes_no_na" && answer !== "yes" && answer !== "no" && answer !== "na") {
      answer = "no";
    }
    if (criterion.answerType === "scale") {
      const steps = criterion.scale?.steps ?? [];
      if (answer === "na") {
        if (!criterion.naAllowed) answer = steps.includes(0) ? 0 : (steps[0] ?? 0);
      } else if (typeof answer !== "number" || !steps.includes(answer)) {
        answer = steps.includes(0) ? 0 : (steps[0] ?? 0);
      }
    }
    const quoted =
      criterion.id === "C01"
        ? firstOp
        : criterion.id === "C02" && answer === "yes"
          ? pick((text) => questionRe.test(text))
          : criterion.id === "C03" && answer === "yes"
            ? pick((text) => isIdentityConfirmation(text))
            : criterion.id === "C05" && answer === "yes"
              ? pick((text) => empathyRe.test(text) || politeRe.test(text))
              : criterion.id === "C07" && answer === "yes"
                ? pick((text) => byeRe.test(text))
                : criterion.id === "C08" && answer === "yes"
                  ? pick((text) => insultRe.test(text) || bypassRe.test(text) || leakRe.test(text))
                  : criterion.id === "C04" && answer !== "na"
                    ? pick((text) => wrongRe.test(text) || concreteRe.test(text)) ?? ops(messages).at(-1)
                    : ops(messages).at(-1) ?? firstOp;
    const quotes = !officialHandler || answer === "na" || !quoted ? [] : quoteOf(quoted);
    return {
      criterionId: criterion.id,
      answer,
      reason: officialHandler
        ? reasonFor(criterion.id, answer)
        : "Формулировка не совпадает с официальной эвристикой. Старый смысл идентификатора не применяется.",
      quotes,
      checkedRange: !officialHandler || answer === "na" || answer === "no" || answer === 0 ? fullRange(messages) : null,
      naReason:
        answer === "na"
          ? criterion.id === "C03"
            ? "Запрос не требовал раскрытия защищённых данных."
            : criterion.id === "C04"
              ? "Клиент не успел сформулировать запрос."
              : criterion.id === "C07"
                ? "Диалог оборвался до возможности завершения."
                : "По тексту данных для содержательного ответа хватало с начала."
          : null,
      unbound: !officialHandler,
    };
  });
}
