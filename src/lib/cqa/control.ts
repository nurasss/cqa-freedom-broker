import type { Answer, Conversation } from "./types.ts";

export interface ControlCase {
  conversation: Conversation;
  answers: Record<string, Answer>;
}

function chat(externalId: string, language: string, lines: [string, string, string][], channel = "agent chat"): Conversation {
  return {
    id: `STUDY::${externalId}`,
    datasetGroupId: "STUDY",
    externalId,
    channel,
    language,
    audioUrl: null,
    origin: "study",
    messages: lines.map(([timestampRaw, speaker, text], messageIndex) => ({ messageIndex, timestampRaw, speaker, text })),
  };
}

const base = {
  C02: "no",
  C03: "na",
  C04: 0,
  C05: "no",
  C06: 0,
  C07: "no",
  C08: "no",
} as const;

export function controlCases(): ControlCase[] {
  return [
    {
      conversation: chat("c-ru-01", "RU", [
        ["00:01", "client", "Здравствуйте"],
        ["00:08", "operator", "Какой у вас вопрос по счёту?"],
      ]),
      answers: { ...base, C01: "no", C02: "yes", C06: 7 },
    },
    {
      conversation: chat("c-ru-02", "RU", [
        ["00:01", "client", "Подскажите комиссию тарифа Стандарт по акциям США."],
        ["00:10", "operator", "Здравствуйте! Меня зовут Айгерим, Freedom Broker. Комиссия 0,3%, заявка в разделе Рынки. Могу ещё чем-то помочь. Хорошего дня!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 15, C05: "yes", C06: 10, C07: "yes" },
    },
    {
      conversation: chat("c-ru-03", "RU", [
        ["00:02", "client", "Это уже проблема, вы не отвечаете."],
        ["00:09", "operator", "Здравствуйте! Меня зовут Илья. Не пишите ерунду, вы зря отнимаете время."],
      ]),
      answers: { ...base, C01: "yes", C05: "no", C06: 4, C08: "yes" },
    },
    {
      conversation: chat("c-ru-04", "RU", [
        ["00:01", "client", "Скажите остаток на счёте."],
        ["00:12", "operator", "Здравствуйте! Меня зовут Мадина. Назовите последние 4 цифры ИИН, затем раскрою остаток."],
        ["00:20", "client", "7730"],
        ["00:30", "operator", "Личность подтверждена. На вашем счёте 430000 тенге. Итого остаток назван. Хорошего дня!"],
      ]),
      answers: { ...base, C01: "yes", C03: "yes", C04: 15, C05: "yes", C06: 10, C07: "yes" },
    },
    {
      conversation: chat("c-ru-05", "RU", [
        ["00:01", "client", "Какой остаток?"],
        ["00:06", "operator", "Здравствуйте! Меня зовут Данияр. На вашем счёте 12000 тенге, проверка личности не нужна."],
      ]),
      answers: { ...base, C01: "yes", C03: "no", C04: 10, C05: "yes", C06: 7 },
    },
    {
      conversation: chat("c-kz-06", "KZ", [
        ["00:01", "client", "АҚШ акциясының комиссиясы қандай?"],
        ["00:09", "operator", "Сәлеметсіз бе! Менің атым Айгерім, Freedom Broker. Комиссия 0,3%, өтінім Markets бөлімінде. Тағы көмек керек пе? Сау болыңыз!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 15, C05: "yes", C06: 10, C07: "yes" },
    },
    {
      conversation: chat("c-kz-07", "KZ", [
        ["00:02", "client", "Шотты қалай толтырамын?"],
        ["00:11", "operator", "Сәлем! Менің атым Данияр. Қосымшадағы Толықтыру бөлімін ашыңыз, комиссия 0."],
      ]),
      answers: { ...base, C01: "yes", C04: 10, C05: "yes", C06: 7, C07: "no" },
    },
    {
      conversation: chat("c-en-08", "EN", [
        ["00:01", "client", "What is the Standard tariff fee for US stocks?"],
        ["00:08", "operator", "Hello! My name is Aigerim, Freedom Broker. The fee is 0.3% and the order is placed in Markets. Anything else I can help with? Have a good day!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 15, C05: "yes", C06: 10, C07: "yes" },
    },
    {
      conversation: chat("c-en-09", "EN", [
        ["00:01", "client", "This delay is a real problem and I am unhappy."],
        ["00:07", "operator", "Hello! My name is Ilyas. The fee is 0.3% in the Markets section."],
      ]),
      answers: { ...base, C01: "yes", C04: 10, C05: "no", C06: 7, C07: "no" },
    },
    {
      conversation: chat("c-en-10", "EN", [
        ["00:01", "client", "Hello"],
        ["00:04", "system", "Client disconnected."],
      ]),
      answers: { ...base, C01: "no", C04: "na", C07: "na" },
    },
  ];
}

export function controlConversations(): Conversation[] {
  return controlCases().map((item) => item.conversation);
}
