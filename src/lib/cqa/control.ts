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

    // --- RU: c-ru-11 .. c-ru-18 ---

    // c-ru-11: C01 — оператор поздоровался в первом ответе, но представился только в следующем ответе после реплики клиента. По рубрике C01 представление позже первого ответа не засчитывается → C01: НЕТ. C07: ДА (предложение помощи + прощание).
    {
      conversation: chat("c-ru-11", "RU", [
        ["00:01", "client", "Здравствуйте, подскажите график работы офиса в Алматы."],
        ["00:08", "operator", "Добрый день!"],
        ["00:14", "client", "Здравствуйте, так какой график?"],
        ["00:20", "operator", "Меня зовут Арман, Freedom Broker. Офис работает с понедельника по пятницу с 9:00 до 18:00."],
        ["00:28", "client", "Спасибо, всё понятно."],
        ["00:35", "operator", "Если появятся вопросы — пишите, всегда на связи! Всего доброго, до свидания!"],
      ]),
      answers: { ...base, C01: "no", C02: "na", C04: 20, C05: "yes", C06: 10, C07: "yes" },
    },

    // c-ru-12: C02 — клиент сообщил об ошибке без деталей; оператор уточнил недостающий текст ошибки до решения → C02: ДА.
    {
      conversation: chat("c-ru-12", "RU", [
        ["00:01", "client", "Здравствуйте! Хочу пополнить счёт картой, но выходит ошибка."],
        ["00:09", "operator", "Здравствуйте! Меня зовут Елена, Freedom Broker. Подскажите, пожалуйста, какой текст или код ошибки отображается в приложении?"],
        ["00:25", "client", "Пишет «Превышен лимит интернет-операций»."],
        ["00:35", "operator", "В этом случае нужно увеличить лимит на интернет-платежи в приложении вашего банка-эмитента карты, после чего повторить пополнение в Tradernet."],
        ["00:45", "client", "Понял, спасибо большое!"],
        ["00:52", "operator", "Пожалуйста! Обращайтесь, если появятся вопросы. Хорошего дня!"],
      ]),
      answers: { ...base, C01: "yes", C02: "yes", C04: 20, C05: "yes", C06: 10, C07: "yes" },
    },

    // c-ru-13: C03 — баланс раскрыт до проверки личности, последующая проверка ИИН не отменяет нарушение рубрики C03 → C03: НЕТ. C04: 20 (остаток назван полностью). C06: 7 (проверка личности после ответа нарушает порядок консультации).
    {
      conversation: chat("c-ru-13", "RU", [
        ["00:01", "client", "Здравствуйте, напомните мой доступный остаток на брокерском счёте."],
        ["00:07", "operator", "Здравствуйте! Меня зовут Тимур, Freedom Broker. Ваш остаток составляет 1 250 000 тенге."],
        ["00:15", "operator", "Кстати, в целях безопасности назовите последние 4 цифры вашего ИИН."],
        ["00:22", "client", "4512."],
        ["00:28", "operator", "Спасибо, данные совпали. Могу ещё чем-то помочь?"],
        ["00:35", "client", "Нет, всё узнал."],
        ["00:40", "operator", "Если возникнут вопросы — обращайтесь. Всего доброго, до свидания!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C03: "no", C04: 20, C05: "yes", C06: 7, C07: "yes" },
    },

    // c-ru-14: C04 — дана размытая подсказка без конкретного раздела («где-то в личном кабинете»), клиенту не ясно, как действовать → C04: 5. C06: 10 (реплики ясные и связные). C07: ДА (предложение помощи + прощание).
    {
      conversation: chat("c-ru-14", "RU", [
        ["00:01", "client", "Здравствуйте! Как мне сформировать выписку по счёту в приложении?"],
        ["00:08", "operator", "Здравствуйте! Меня зовут Алина, Freedom Broker. Выписка формируется где-то в личном кабинете на сайте или в приложении."],
        ["00:17", "client", "Ясно, конкретики нет, ладно, поищу сам."],
        ["00:24", "operator", "Если возникнут вопросы — обязательно пишите, поможем. Всего доброго, до свидания!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 5, C05: "yes", C06: 10, C07: "yes" },
    },

    // c-ru-15: C05 — клиент сообщил о недовольстве постоянными зависаниями, оператор полностью проигнорировал жалобу → C05: НЕТ. C07: ДА (предложение помощи + прощание).
    {
      conversation: chat("c-ru-15", "RU", [
        ["00:01", "client", "Здравствуйте! Я уже третий раз за день не могу выставить заявку, приложение зависает и я теряю прибыль, это ужасно!"],
        ["00:10", "operator", "Здравствуйте! Меня зовут Руслан, Freedom Broker. Для выставления заявки нажмите кнопку Купить в стакане цен."],
        ["00:20", "client", "Вы меня вообще слышите? Я говорю о постоянных зависаниях терминала!"],
        ["00:28", "operator", "В стакане выберите количество лотов и подтвердите SMS-кодом."],
        ["00:36", "client", "Бесполезный разговор."],
        ["00:41", "operator", "Если возникнут вопросы — пишите. До свидания!"],
      ]),
      answers: { ...base, C01: "yes", C02: "no", C04: 0, C05: "no", C06: 4, C07: "yes" },
    },

    // c-ru-16: C06 — пауза между репликами более 5 минут без предупреждения об ожидании → C06: 7. Вопрос о навигации приложения (не спорный факт) → C04: 20.
    {
      conversation: chat("c-ru-16", "RU", [
        ["00:01", "client", "Здравствуйте! В каком разделе приложения можно скачать готовую налоговую справку за прошлый год?"],
        ["00:08", "operator", "Здравствуйте! Меня зовут Светлана, Freedom Broker."],
        ["05:40", "operator", "Налоговая справка доступна в разделе «Меню» → «Отчёты» → «Налоговая справка». Если возникнут вопросы — обращайтесь. Всего доброго, до свидания!"],
        ["05:50", "client", "Спасибо за ответ."],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 20, C05: "yes", C06: 7, C07: "yes" },
    },

    // c-ru-17: C07 — оператор ответил и закрыл чат без прощания, хотя возможность завершить была → C07: НЕТ.
    {
      conversation: chat("c-ru-17", "RU", [
        ["00:01", "client", "Здравствуйте! Какой минимальный депозит для открытия счёта?"],
        ["00:08", "operator", "Здравствуйте! Меня зовут Кирилл, Freedom Broker. Минимального порога для открытия счёта нет, можете начать с любой суммы."],
        ["00:16", "client", "Отлично, спасибо!"],
        ["00:22", "system", "Оператор закрыл диалог."],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 20, C05: "yes", C06: 10, C07: "no" },
    },

    // c-ru-18: C08 — оператор корректно ответил по приложению (C04=20, C06=10), но предложил платную услугу в обход компании с запросом личного контакта → C08: ДА. C05: ДА, C07: ДА.
    {
      conversation: chat("c-ru-18", "RU", [
        ["00:01", "client", "Здравствуйте! Подскажите, где в приложении Tradernet можно посмотреть раздел с аналитикой и инвестидеями?"],
        ["00:08", "operator", "Здравствуйте! Меня зовут Олег, Freedom Broker. Раздел с инвестидеями находится во вкладке «Аналитика» → «Идеи», там публикуются официальные обзоры аналитиков Freedom."],
        ["00:18", "operator", "Но если хотите персональный прибыльный портфель с гарантией дохода, могу вести его лично за 30 000 тенге в месяц. Напишите мне в WhatsApp на +77011234567."],
        ["00:26", "client", "Нет, меня интересует только официальный раздел приложения."],
        ["00:32", "operator", "Понял вас. Если появятся вопросы по работе приложения — пишите в чат. Всего доброго, до свидания!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 20, C05: "yes", C06: 10, C07: "yes", C08: "yes" },
    },

    // --- KZ: c-kz-11 .. c-kz-18 ---

    // c-kz-11: C01 — оператор сәлемдесті, бірақ өз атын атап таныстырмады → C01: НЕТ. C07: ДА (көмек ұсыну + қоштасу).
    {
      conversation: chat("c-kz-11", "KZ", [
        ["00:01", "client", "Сәлеметсіз бе! Қосымшада құпиясөзді қалай ауыстырамын?"],
        ["00:07", "operator", "Сәлеметсіз бе! Құпиясөзді ауыстыру үшін Баптаулар — Қауіпсіздік бөліміне өтіңіз."],
        ["00:15", "client", "Рақмет, таптым."],
        ["00:20", "operator", "Оқасы жоқ! Тағы сұрақтарыңыз болса, жазыңыз. Сау болыңыз!"],
      ]),
      answers: { ...base, C01: "no", C02: "na", C04: 20, C05: "yes", C06: 10, C07: "yes" },
    },

    // c-kz-12: C01 — клиент қазақша сұрақ қойды, оператор орыс тілінде амандасты (клиент тілінде емес) → C01: НЕТ. C06: 10 (репликалар анық, тіл ауысуы C01-де ескерілді). C07: ДА (көмек ұсыну + қоштасу).
    {
      conversation: chat("c-kz-12", "KZ", [
        ["00:01", "client", "Сәлеметсіз бе! Теңгедегі шотты қалай толтыруға болады?"],
        ["00:08", "operator", "Здравствуйте! Меня зовут Нұрлан, Freedom Broker. Шотты толтыру үшін Kaspi немесе кез келген банк картасы арқылы аударым жасай аласыз."],
        ["00:17", "client", "Түсіндім, рақмет."],
        ["00:23", "operator", "Тағы сұрақтарыңыз болса, міндетті түрде жазыңыз. Сау болыңыз, сәттілік тілеймін!"],
      ]),
      answers: { ...base, C01: "no", C02: "na", C04: 20, C05: "yes", C06: 10, C07: "yes" },
    },

    // c-kz-13: C02 — клиент акция сатылмай жатқанын айтты, оператор мән-жайды нақтыламады → C02: НЕТ. C04: 5 («қосымшаны жаңартыңыз» — жалпы кеңес). C07: ДА (көмек ұсыну + қоштасу).
    {
      conversation: chat("c-kz-13", "KZ", [
        ["00:01", "client", "Сәлеметсіз бе! Менің акциям сатылмай жатыр, неге?"],
        ["00:08", "operator", "Сәлеметсіз бе! Менің атым Берік, Freedom Broker. Қосымшаны жауып қайта ашыңыз, сонда бәрі істейді."],
        ["00:16", "client", "Қай акция екенін де сұрамадыңыз ғой, бірнешеуі бар менде."],
        ["00:23", "operator", "Қосымшаны жаңартып көріңіз. Егер сұрақтар болса, жазыңыз. Сау болыңыз!"],
      ]),
      answers: { ...base, C01: "yes", C02: "no", C04: 5, C05: "no", C06: 4, C07: "yes" },
    },

    // c-kz-14: C03 — шот қалдығын ашпас бұрын system жүйелік хабарламасымен жеке бас расталды → C03: ДА. C07: ДА.
    {
      conversation: chat("c-kz-14", "KZ", [
        ["00:01", "client", "Сәлеметсіз бе! Менің шотымда қанша ақша қалды?"],
        ["00:07", "operator", "Сәлеметсіз бе! Менің атым Меруерт, Freedom Broker. Қауіпсіздік үшін ЖСН соңғы 4 санын жазыңызшы."],
        ["00:15", "client", "8841."],
        ["00:20", "system", "Клиенттің жеке басы расталды."],
        ["00:26", "operator", "Сіздің шотыңызда 780 000 теңге бар. Тағы көмек керек пе?"],
        ["00:32", "client", "Жоқ, рақмет."],
        ["00:36", "operator", "Сұрақтар болса, хабарласыңыз. Күніңіз сәтті өтсін, сау болыңыз!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C03: "yes", C04: 20, C05: "yes", C06: 10, C07: "yes" },
    },

    // c-kz-15: C04 — анықтаманың қосымшадағы орны көрсетілді, бірақ дайындалу мерзімі туралы маңызды сұрақ ашық қалды → C04: 10. C06: 10 (репликалар жүйелі). C07: ДА.
    {
      conversation: chat("c-kz-15", "KZ", [
        ["00:01", "client", "Сәлеметсіз бе! Салық есебін қай бөлімнен жүктеймін және брокер оны қанша күнде дайындайды?"],
        ["00:09", "operator", "Сәлеметсіз бе! Менің атым Жандос, Freedom Broker. Салық есебі «Мәзір» → «Есептер» → «Салық анықтамасы» бөлімінде орналасқан."],
        ["00:18", "client", "Ал дайындалу мерзімі қанша күн, соны айтыңызшы?"],
        ["00:27", "operator", "Оны нақты білмеймін, бөлімге кіріп көріңіз."],
        ["00:35", "client", "Жақсы, өзім қарайын."],
        ["00:40", "operator", "Егер сұрақтар болса, хабарласыңыз. Сау болыңыз!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 10, C05: "yes", C06: 10, C07: "yes" },
    },

    // c-kz-16: C06 — байланыссыз және қарама-қайшы жауаптар салдарынан диалог мағынасыз болды → C06: 0. C02: N/A (KASE сауда уақыты туралы бастапқы сұрақ толық болды). C07: ДА (көмек ұсыну + қоштасу).
    {
      conversation: chat("c-kz-16", "KZ", [
        ["00:01", "client", "Сәлеметсіз бе! KASE биржасында сауда қашан басталады?"],
        ["00:07", "operator", "Сәлеметсіз бе! Менің атым Ерлан, Freedom Broker. Иә, акция сатып алу батырмасы бар."],
        ["00:15", "client", "Сіз сұрақты түсіндіңіз бе? Сауда уақытын сұрап тұрмын."],
        ["00:22", "operator", "Нью-Йоркте сауда жабық, шотты толтырыңыз, рақмет."],
        ["00:29", "client", "Не жазып кеттіңіз, түк түсініксіз ғой?"],
        ["00:35", "operator", "Сұрақтар болса, жазыңыз. Сау болыңыз."],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 0, C05: "no", C06: 0, C07: "yes" },
    },

    // c-kz-17: C07 — жауап берілгеннен кейін клиент бірден шығып кетті, қоштасуға мүмкіндік болмады → C07: N/A.
    {
      conversation: chat("c-kz-17", "KZ", [
        ["00:01", "client", "Сәлеметсіз бе! Freedom картасын ашу тегін бе?"],
        ["00:08", "operator", "Сәлеметсіз бе! Менің атым Айгүл, Freedom Broker. Иә, цифрлық картаны ашу және оған қызмет көрсету мүлдем тегін."],
        ["00:11", "system", "Клиент чаттан шығып кетті."],
        ["00:12", "system", "Диалог автоматты түрде жабылды."],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 20, C05: "yes", C06: 10, C07: "na" },
    },

    // c-kz-18: C08 — оператор клиентке тіл тигізіп, қорлады → C08: ДА. C02: N/A (өтінімді жою сұрағы басынан түсінікті). C06: 10 (репликалар байланысты әрі анық, дөрекілік C05 пен C08-де). C07: НЕТ (дөрекі қоштасу, көмек ұсынылмады).
    {
      conversation: chat("c-kz-18", "KZ", [
        ["00:01", "client", "Сәлеметсіз бе! Мен өтінімді қалай жоятынымды түсінбей тұрмын."],
        ["00:07", "operator", "Сәлеметсіз бе! Менің атым Қайрат. Осыны да түсінбейтін қандай ақымақсыз, көзіңіз көрмей ме?"],
        ["00:14", "client", "Неге мені балағаттайсыз? Басшыңызға шағымданамын!"],
        ["00:20", "operator", "Кімге айтсаң соған айт. Сау бол."],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 0, C05: "no", C06: 10, C07: "no", C08: "yes" },
    },

    // --- EN: c-en-11 .. c-en-18 ---

    // c-en-11: C01 — оператор поздоровался на английском и представился в первом ответе → C01: ДА. C07: ДА (предложение помощи + прощание).
    {
      conversation: chat("c-en-11", "EN", [
        ["00:01", "client", "Hello, what are the trading hours for the US market?"],
        ["00:08", "operator", "Hello! My name is Alex, Freedom Broker. The main trading session runs from 14:30 to 21:00 UTC. Is there anything else I can help you with?"],
        ["00:16", "client", "That is all, thank you!"],
        ["00:22", "operator", "You are welcome! If you have any further questions, please feel free to ask. Have a wonderful day, goodbye!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 20, C05: "yes", C06: 10, C07: "yes" },
    },

    // c-en-12: C02 — клиент указал все необходимые параметры операции изначально, уточнять не требовалось → C02: N/A. C07: ДА.
    {
      conversation: chat("c-en-12", "EN", [
        ["00:01", "client", "Hello, what is the withdrawal fee to a bank card in USD?"],
        ["00:07", "operator", "Hello! My name is Sarah, Freedom Broker. The withdrawal fee to an international bank card is 1.5% with a minimum fee of $5."],
        ["00:15", "client", "Got it, thanks!"],
        ["00:20", "operator", "Glad to assist! If you need anything else, just let us know. Have a great day, goodbye!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 20, C05: "yes", C06: 10, C07: "yes" },
    },

    // c-en-13: C03 — общий вопрос о стоимости рыночных данных, проверка личности клиента не требуется → C03: N/A. C07: ДА.
    {
      conversation: chat("c-en-13", "EN", [
        ["00:01", "client", "Hi there! How much do you charge for real-time market data on NYSE?"],
        ["00:08", "operator", "Hi! My name is David, Freedom Broker. Real-time Level 1 market data for NYSE is provided free of charge for all active accounts."],
        ["00:16", "client", "Awesome, thank you."],
        ["00:21", "operator", "You are very welcome! If any other questions arise, please write to us. Have a great day, goodbye!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 20, C05: "yes", C06: 10, C07: "yes" },
    },

    // c-en-14: C04 — клиент отключился до того, как успел сформулировать суть запроса → C04: N/A. C02: ДА (оператор активно спросил «How can I assist you today?», пытаясь выяснить недостающую информацию). C07: N/A.
    {
      conversation: chat("c-en-14", "EN", [
        ["00:01", "client", "Hello, I have an urgent question..."],
        ["00:06", "operator", "Hello! My name is Michael, Freedom Broker. How can I assist you today?"],
        ["00:12", "system", "Client connection lost."],
        ["00:15", "system", "Chat session closed due to timeout."],
      ]),
      answers: { ...base, C01: "yes", C02: "yes", C04: "na", C05: "yes", C06: 10, C07: "na" },
    },

    // c-en-15: C04 — оператор дал категорически неверный ответ о запрете перевода акций между брокерами → C04: 0. C05: ДА, C06: 10 (реплики вежливые и связные). C07: ДА (предложение помощи + прощание).
    {
      conversation: chat("c-en-15", "EN", [
        ["00:01", "client", "Hello! Can I transfer shares directly from another broker to Freedom?"],
        ["00:08", "operator", "Hello! My name is Emma, Freedom Broker. No, share transfers between brokers are strictly prohibited by international law; you must sell shares and transfer cash."],
        ["00:18", "client", "I see, thanks for letting me know."],
        ["00:25", "operator", "You are welcome! If you need any further assistance, feel free to ask. Have a great day, goodbye!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 0, C05: "yes", C06: 10, C07: "yes" },
    },

    // c-en-16: C05 — клиент задал вопрос без жалоб, оператор вежлив, извинений не требуется → C05: ДА. C07: ДА.
    {
      conversation: chat("c-en-16", "EN", [
        ["00:01", "client", "Hello, where can I download the annual tax report for 2025?"],
        ["00:07", "operator", "Hello! My name is Kevin, Freedom Broker. You can download your tax report in Menu — Reports — Tax Statement in PDF or Excel format."],
        ["00:15", "client", "Found it, thanks a lot for the quick help!"],
        ["00:20", "operator", "My pleasure! Please let us know if you need anything else. Have a wonderful day, goodbye!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 20, C05: "yes", C06: 10, C07: "yes" },
    },

    // c-en-17: C06 — клиент вынужден дважды переспрашивать из-за несвязных и размытых формулировок оператора → C06: 4. C07: ДА (предложение помощи + прощание).
    {
      conversation: chat("c-en-17", "EN", [
        ["00:01", "client", "Hello! What documents are required to activate options trading?"],
        ["00:08", "operator", "Hello! My name is Chloe, Freedom Broker. The document is signed when the status changes after you upload it in the section."],
        ["00:18", "client", "Which document exactly, and which section? You did not mention names."],
        ["00:26", "operator", "The questionnaire in documents, if approved then the agreement."],
        ["00:35", "client", "So I need the Risk Questionnaire in the Profile section?"],
        ["00:42", "operator", "Yes, exactly that one. If you have any further questions, feel free to ask. Have a good day, goodbye!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 15, C05: "yes", C06: 4, C07: "yes" },
    },

    // c-en-18: C08 — опечатка в тикере исправлена в диалоге, обычная консультационная ошибка не влечёт флаг грубого нарушения → C08: НЕТ. C07: ДА (предложение помощи + прощание).
    {
      conversation: chat("c-en-18", "EN", [
        ["00:01", "client", "Hello! What is the ticker for Apple on Nasdaq?"],
        ["00:07", "operator", "Hello! My name is George, Freedom Broker. The ticker is APPL."],
        ["00:15", "client", "Isn't it AAPL with two A's?"],
        ["00:22", "operator", "Apologies, you are completely right, it is AAPL. If you need any other tickers or help, please write to us. Have a good day, goodbye!"],
      ]),
      answers: { ...base, C01: "yes", C02: "na", C04: 15, C05: "yes", C06: 7, C07: "yes" },
    },
  ];
}

export function controlConversations(): Conversation[] {
  return controlCases().map((item) => item.conversation);
}
