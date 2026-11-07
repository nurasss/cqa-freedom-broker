import { useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { evaluateConversation } from "@/lib/cqa/ai-fns";
import type { DraftAnswer } from "@/lib/cqa/engine";
import { safeAudioUrl } from "@/lib/cqa/engine";
import { mediaOffset } from "@/lib/cqa/media";
import { allowedAnswers, computeScore, formatAnswer } from "@/lib/cqa/score";
import { latestEvaluation, useCqa } from "@/lib/cqa/store";
import type { Answer, Criterion, Evaluation } from "@/lib/cqa/types";
import { MODEL_ID, PROMPT_VERSION, SECTION_LABEL } from "@/lib/cqa/types";
import { Button, channelLabel, cx, formatTotal, inputClass, sourceLabel } from "./ui";

export function CardView({ conversationId, onBack }: { conversationId: string; onBack: () => void }) {
  const conversation = useCqa((state) => state.conversations.find((item) => item.id === conversationId));
  const version = useCqa((state) => state.versions.find((item) => item.id === state.activeVersionId));
  const evaluations = useCqa((state) => state.evaluations);
  const appeals = useCqa((state) => state.appeals);
  const decisions = useCqa((state) => state.decisions);
  const role = useCqa((state) => state.role);
  const evaluateRules = useCqa((state) => state.evaluateRules);
  const evaluateManual = useCqa((state) => state.evaluateManual);
  const saveModelEvaluation = useCqa((state) => state.saveModelEvaluation);
  const submitAppeal = useCqa((state) => state.submitAppeal);
  const decideAppeal = useCqa((state) => state.decideAppeal);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState(false);
  const [picks, setPicks] = useState<Record<string, Answer>>({});
  const [seekNote, setSeekNote] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const evaluation = conversation && version ? latestEvaluation(evaluations, conversation.id, version.id) : undefined;
  const outcome = useMemo(() => {
    if (!version || !evaluation) return null;
    const answers = Object.fromEntries(evaluation.finalResults.map((item) => [item.criterionId, item.answer]));
    return computeScore(version.criteria, answers);
  }, [version, evaluation]);

  if (!conversation || !version) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-4">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-4" />
          К диалогам
        </Button>
        <p className="mt-3 text-sm text-muted">Диалог не найден.</p>
      </div>
    );
  }

  const dialog = conversation;
  const checklist = version;
  const audio = safeAudioUrl(dialog.audioUrl);

  function focusEvidence(index: number | null, checked: { from: number; to: number } | null) {
    setHighlight(index);
    setRange(checked);
    const target = index ?? checked?.from;
    if (target === undefined) return;
    const offset = mediaOffset(dialog.messages, target);
    if (offset !== null) {
      if (audioRef.current) audioRef.current.currentTime = offset.seconds;
      setSeekNote(offset.approximate ? "≈ по времени первой реплики" : null);
    } else {
      setSeekNote(null);
    }
    document.getElementById(`msg-${conversationId}-${target}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function onGrok() {
    setBusy(true);
    setError("");
    const startedAt = new Date().toISOString();
    const binding = {
      conversationId: dialog.id,
      checklistVersionId: checklist.id,
      configHash: checklist.configHash,
      modelId: MODEL_ID,
      promptVersion: PROMPT_VERSION,
      startedAt,
    };
    const criteria = checklist.criteria;
    try {
      const response = await evaluateConversation({ data: { conversation: dialog, criteria } });
      if (!response.ok) {
        setError(response.error);
        return;
      }
      saveModelEvaluation(
        { ...binding, modelId: response.model || binding.modelId, promptVersion: response.promptVersion || binding.promptVersion },
        response,
      );
      if (response.error && response.status !== "completed") setError(response.error);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Оценка не выполнена");
    } finally {
      setBusy(false);
    }
  }

  function saveManual() {
    const drafts: DraftAnswer[] = checklist.criteria.map((criterion) => {
      const answer = picks[criterion.id] ?? allowedAnswers(criterion)[0] ?? "no";
      const message =
        dialog.messages.find((item) => item.messageIndex === highlight) ??
        dialog.messages.find((item) => item.speaker === "operator") ??
        dialog.messages[0];
      return {
        criterionId: criterion.id,
        answer,
        reason: "Ручная разметка. Цитата — выбранная или первая реплика оператора.",
        quotes:
          answer === "na" || !message
            ? []
            : [{ messageIndex: message.messageIndex, quote: message.text.slice(0, 220) }],
        checkedRange: dialog.messages.length
          ? { from: 0, to: dialog.messages.length - 1 }
          : null,
        naReason: answer === "na" ? "Аналитик отметил критерий как неприменимый" : null,
      };
    });
    evaluateManual(dialog.id, drafts);
    setManual(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Назад
        </Button>
        <div className="min-w-0">
          <p className="truncate font-mono text-sm text-ink">{dialog.externalId}</p>
          <p className="text-xs text-muted">
            {dialog.language} · {channelLabel(dialog.channel)} · {checklist.label}
          </p>
        </div>
      </div>

      <section className="rounded-2xl bg-ink p-4 text-on-ink">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-xs tracking-wide uppercase opacity-70">Итог после апелляций</p>
            <p className="mt-1 font-mono text-4xl font-medium">{formatTotal(evaluation?.finalTotal)}</p>
          </div>
          <div className="text-right text-sm">
            <p>{evaluation ? `${sourceLabel(evaluation.source)} · ${evaluation.status}` : "нет оценки"}</p>
            <p className="opacity-70">применимый вес {outcome?.denominator ?? "—"}</p>
          </div>
        </div>
        {evaluation?.finalCritical ? (
          <p className="mt-3 rounded-xl bg-critical px-3 py-2 text-sm font-semibold text-on-accent">
            Грубая ошибка: да. Балл не обнуляется.
          </p>
        ) : (
          <p className="mt-3 text-sm opacity-80">Грубая ошибка: нет</p>
        )}
        {evaluation && evaluation.baseTotal !== evaluation.finalTotal ? (
          <p className="mt-2 text-sm">
            Было {formatTotal(evaluation.baseTotal)} → стало {formatTotal(evaluation.finalTotal)}
          </p>
        ) : null}
        {dialog.channel === "voice call" ? (
          <p className="mt-3 text-xs leading-5 opacity-80">
            Чек-лист чатов применён к транскрипту звонка. Это адаптация: отдельной голосовой рубрики организаторы не публиковали. Интонация по тексту не оценивается.
          </p>
        ) : null}
      </section>

      {audio ? (
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="mb-2 text-sm font-semibold text-ink">Запись</p>
          <audio ref={audioRef} controls preload="none" src={audio} className="w-full" />
          <p className="mt-2 text-xs text-muted">Клик по реплике с меткой времени перематывает запись. Отдельной голосовой рубрики организаторы не публиковали.</p>
          {seekNote ? <p className="mt-1 text-xs font-medium text-accent">{seekNote}</p> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void onGrok()}>
          {busy ? "Считаю…" : "Оценить Grok"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => evaluateRules(dialog.id)}>
          Эвристика
        </Button>
        <Button variant="ghost" onClick={() => setManual((value) => !value)}>
          Ручная разметка
        </Button>
      </div>
      {error ? <p className="text-sm text-critical">{error}</p> : null}
      {evaluation?.source === "ai" ? (
        <p className="text-xs leading-5 text-muted">
          AI Evaluation: {evaluation.trace.find((line) => line.startsWith("evaluation:"))?.replace("evaluation: ", "") ?? evaluation.status}. AI Judge:{" "}
          {evaluation.trace.some((line) => line.startsWith("judge error"))
            ? "ошибка"
            : evaluation.trace.some((line) => line.startsWith("judge ") && !line.startsWith("judge: пропущен"))
              ? "выполнен"
              : evaluation.trace.some((line) => line.includes("пропущен"))
                ? "пропущен"
                : "нет данных"}
          . Итог карточки: {evaluation.status}. Ответы модели не переписываются.
        </p>
      ) : null}
      {evaluation?.usage ? (
        <p className="text-xs leading-5 text-muted">
          {evaluation.model}, вызовов {evaluation.usage.calls}, токены {evaluation.usage.promptTokens} /{" "}
          {evaluation.usage.completionTokens}. Ориентир стоимости ${evaluation.usage.estimatedCostUsd.toFixed(4)} по
          публичному тарифу $2 / $6 за 1М токенов.
        </p>
      ) : null}

      {manual ? (
        <section className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-sm text-muted">
            Ручная разметка хранится локально и не является Ground Truth организаторов. Выделите реплику — она станет цитатой.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            {checklist.criteria.map((criterion) => (
              <label key={criterion.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-ink">
                  {criterion.id} · {criterion.title}
                </span>
                <select
                  className={cx(inputClass, "w-28")}
                  value={String(picks[criterion.id] ?? allowedAnswers(criterion)[0])}
                  onChange={(event) => {
                    const raw = event.target.value;
                    const answer: Answer = raw === "yes" || raw === "no" || raw === "na" ? raw : Number(raw);
                    setPicks((current) => ({ ...current, [criterion.id]: answer }));
                  }}
                >
                  {allowedAnswers(criterion).map((answer) => (
                    <option key={String(answer)} value={String(answer)}>
                      {formatAnswer(answer)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <Button className="mt-4" onClick={saveManual}>
            Сохранить ручную оценку
          </Button>
        </section>
      ) : null}

      {outcome && outcome.sections.length ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {outcome.sections
            .filter((section) => section.id !== "critical")
            .map((section) => (
              <div key={section.id} className="rounded-2xl border border-line bg-surface px-3 py-2">
                <p className="text-xs text-muted">{section.label}</p>
                <p className="font-mono text-lg text-ink">{section.percent === null ? "—" : `${section.percent}%`}</p>
                <p className="text-xs text-muted">Диагностика секции, не официальный итог</p>
              </div>
            ))}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3">
          {checklist.criteria.map((criterion) => (
            <CriterionCard
              key={criterion.id}
              criterion={criterion}
              evaluation={evaluation}
              appeals={appeals.filter((appeal) => appeal.evaluationId === evaluation?.id && appeal.criterionId === criterion.id)}
              decisions={decisions}
              role={role}
              onFocus={focusEvidence}
              onAppeal={(comment) => (evaluation ? submitAppeal(evaluation.id, criterion.id, comment) : "Нет оценки")}
              onDecide={(appealId, action, reason, next) => decideAppeal(appealId, action, reason, next)}
            />
          ))}
          {evaluation?.trace?.length ? (
            <details className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">
              <summary className="cursor-pointer font-semibold text-ink">Трасса расчёта</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {evaluation.trace.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
        <section className="rounded-2xl border border-line bg-surface p-3 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-auto">
          <h2 className="px-2 py-2 text-sm font-semibold text-ink">Транскрипт</h2>
          <ol className="flex flex-col gap-2">
            {dialog.messages.map((message) => {
              const active = highlight === message.messageIndex;
              const inside = range ? message.messageIndex >= range.from && message.messageIndex <= range.to : false;
              const operator = message.speaker === "operator";
              return (
                <li
                  id={`msg-${dialog.id}-${message.messageIndex}`}
                  key={message.messageIndex}
                  className={cx(
                    "rounded-2xl px-3 py-2",
                    active ? "bg-accent-soft ring-2 ring-accent" : inside ? "bg-bg" : "bg-surface",
                  )}
                >
                  <button className="w-full text-left" onClick={() => focusEvidence(message.messageIndex, null)}>
                    <span className="font-mono text-xs text-muted">
                      {message.messageIndex} · {message.timestampRaw} · {message.speaker}
                      {active && seekNote ? (
                        <span className="ml-2 font-sans font-medium text-accent">({seekNote})</span>
                      ) : null}
                    </span>
                    <span className={cx("mt-1 block text-sm leading-6", operator ? "text-ink font-medium" : "text-ink")}>
                      {message.text}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}

function CriterionCard({
  criterion,
  evaluation,
  appeals,
  decisions,
  role,
  onFocus,
  onAppeal,
  onDecide,
}: {
  criterion: Criterion;
  evaluation?: Evaluation;
  appeals: { id: string; comment: string; status: string; createdAt: string }[];
  decisions: { appealId: string; action: string; oldAnswer: Answer; newAnswer: Answer; reason: string }[];
  role: string;
  onFocus: (index: number | null, range: { from: number; to: number } | null) => void;
  onAppeal: (comment: string) => string | null;
  onDecide: (
    appealId: string,
    action: "confirmed" | "overridden",
    reason: string,
    next?: Answer,
  ) => string | null;
}) {
  const result = evaluation?.finalResults.find((item) => item.criterionId === criterion.id);
  const base = evaluation?.baseResults.find((item) => item.criterionId === criterion.id);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [next, setNext] = useState<Answer>(allowedAnswers(criterion)[0] ?? "no");
  const [formError, setFormError] = useState("");
  const open = appeals.find((appeal) => appeal.status === "submitted");

  return (
    <article className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted">
            {criterion.id} · {SECTION_LABEL[criterion.section]} · вес {criterion.weight}
          </p>
          <h3 className="text-base font-semibold text-ink">{criterion.title}</h3>
        </div>
        <p className="font-mono text-xl text-ink">{result ? formatAnswer(result.answer) : "—"}</p>
      </div>
      {result ? (
        <>
          <p className="mt-2 text-sm leading-6 text-ink">{result.reason}</p>
          <p className="mt-1 text-xs text-muted">
            вклад {result.contribution === null ? "вне суммы" : result.contribution.toFixed(2)}
            {result.validationStatus !== "ok" ? ` · ${result.validationStatus}` : ""}
            {base && base.answer !== result.answer ? ` · исходная оценка ${formatAnswer(base.answer)}` : ""}
          </p>
          {result.naReason ? <p className="mt-2 text-sm text-muted">N/A: {result.naReason}</p> : null}
          <div className="mt-2 flex flex-col gap-1">
            {result.evidence.map((item, index) => (
              <button
                key={index}
                className="rounded-xl bg-accent-soft px-3 py-2 text-left text-sm text-ink"
                onClick={() => onFocus(item.messageIndex, null)}
              >
                Реплика {item.messageIndex}{item.speaker ? ` · ${item.speaker}` : ""}: {item.quote}
              </button>
            ))}
            {result.checkedRange ? (
              <button
                className="rounded-xl bg-bg px-3 py-2 text-left text-sm text-muted"
                onClick={() => onFocus(null, result.checkedRange)}
              >
                Проверен интервал {result.checkedRange.from}–{result.checkedRange.to}
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted">Критерий ещё не оценён.</p>
      )}

      {evaluation && role !== "reviewer" ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setFormError(onAppeal(comment) ?? "");
            setComment("");
          }}
        >
          <textarea
            className="min-h-20 rounded-xl border border-line px-3 py-2 text-sm text-ink"
            placeholder="Почему оценка спорна"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <Button variant="ghost" type="submit">
            Оспорить
          </Button>
          {formError ? <p className="text-sm text-critical">{formError}</p> : null}
        </form>
      ) : null}

      {appeals.map((appeal) => {
        const decision = decisions.find((item) => item.appealId === appeal.id);
        return (
          <div key={appeal.id} className="mt-3 rounded-xl bg-bg p-3 text-sm">
            <p className="text-ink">{appeal.comment}</p>
            <p className="mt-1 text-xs text-muted">{appeal.status}</p>
            {decision ? (
              <p className="mt-1 text-ink">
                {formatAnswer(decision.oldAnswer)} → {formatAnswer(decision.newAnswer)}. {decision.reason}
              </p>
            ) : null}
            {open?.id === appeal.id && role === "reviewer" && result ? (
              <form
                className="mt-2 flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-action");
                  if (action !== "confirmed" && action !== "overridden") return;
                  setFormError(onDecide(appeal.id, action, reason, action === "overridden" ? next : result.answer) ?? "");
                }}
              >
                <select
                  className={inputClass}
                  value={String(next)}
                  onChange={(event) => {
                    const raw = event.target.value;
                    setNext(raw === "yes" || raw === "no" || raw === "na" ? raw : Number(raw));
                  }}
                >
                  {allowedAnswers(criterion).map((answer) => (
                    <option key={String(answer)} value={String(answer)}>
                      {formatAnswer(answer)}
                    </option>
                  ))}
                </select>
                <textarea
                  className="min-h-20 rounded-xl border border-line px-3 py-2 text-sm"
                  placeholder="Причина решения"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <div className="flex gap-2">
                  <Button variant="ghost" type="submit" data-action="confirmed">
                    Подтвердить
                  </Button>
                  <Button type="submit" data-action="overridden">
                    Изменить
                  </Button>
                </div>
                {formError ? <p className="text-sm text-critical">{formError}</p> : null}
              </form>
            ) : null}
          </div>
        );
      })}
    </article>
  );
}
