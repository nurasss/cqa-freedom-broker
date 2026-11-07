import { useMemo, useRef, useState } from "react";
import { AudioLines, Play, Upload } from "lucide-react";
import { parseImport } from "@/lib/cqa/engine";
import { evaluateConversation, importOrganizerGroup } from "@/lib/cqa/ai-fns";
import { createBatchRunner } from "@/lib/cqa/queue";
import { latestEvaluation, selectBatchTargets, useCqa } from "@/lib/cqa/store";
import { resultRows, resultsToCsv } from "@/lib/cqa/benchmark";
import { MODEL_ID, PROMPT_VERSION } from "@/lib/cqa/types";
import { Button, channelLabel, cx, formatTotal, inputClass, sourceLabel } from "./ui";

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function DialogsView({ onOpen }: { onOpen: (id: string) => void }) {
  const conversations = useCqa((state) => state.conversations);
  const evaluations = useCqa((state) => state.evaluations);
  const activeVersionId = useCqa((state) => state.activeVersionId);
  const versions = useCqa((state) => state.versions);
  const importNote = useCqa((state) => state.importNote);
  const jobs = useCqa((state) => state.jobs);
  const importConversations = useCqa((state) => state.importConversations);
  const importDemo = useCqa((state) => state.importDemo);
  const importControl = useCqa((state) => state.importControl);
  const startJob = useCqa((state) => state.startJob);
  const patchJob = useCqa((state) => state.patchJob);
  const version = versions.find((item) => item.id === activeVersionId);
  const [language, setLanguage] = useState("all");
  const [channel, setChannel] = useState("all");
  const [groupId, setGroupId] = useState("DEV");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmGrok, setConfirmGrok] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [modelId, setModelId] = useState(MODEL_ID);
  const [costCap, setCostCap] = useState(8);
  const [maxDialogs, setMaxDialogs] = useState(3);
  const [spent, setSpent] = useState(0);
  const cancelRef = useRef(false);
  const runnerRef = useRef(createBatchRunner());
  const fileRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(
    () =>
      conversations.filter((item) => {
        if (language !== "all" && item.language !== language) return false;
        if (channel !== "all" && item.channel !== channel) return false;
        return true;
      }),
    [conversations, language, channel],
  );

  async function onImportGroup() {
    setError("");
    const id = groupId.trim();
    if (!id) {
      setError("Укажите group_id. Демонстрация не подменяет DEV.");
      return;
    }
    setBusy(true);
    try {
      const response = await importOrganizerGroup({ data: { groupId: id } });
      if (!response.ok) {
        setError(response.error);
        return;
      }
      const parsed = parseImport(JSON.parse(response.bodyText), id, "organizer");
      if (!parsed.conversations.length) {
        setError(parsed.error ?? "Пустой ответ");
        return;
      }
      const result = importConversations(
        parsed.conversations,
        `API ${parsed.groupId}: чаты ${parsed.channels.chat}, звонки ${parsed.channels.call}`,
      );
      const expected =
        parsed.expected && parsed.expected !== parsed.conversations.length
          ? `Ожидалось ${parsed.expected}, разобрано ${parsed.conversations.length}.`
          : "";
      if (expected || parsed.error) setError([expected, parsed.error, result.note].filter(Boolean).join(" "));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Импорт не выполнен");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File) {
    setError("");
    try {
      const parsed = parseImport(JSON.parse(await file.text()), groupId.trim() || "UPLOAD", "upload");
      if (!parsed.conversations.length) {
        setError(parsed.error ?? "Файл пуст");
        return;
      }
      importConversations(parsed.conversations, `Файл ${parsed.groupId}`);
      if (parsed.error) setError(parsed.error);
    } catch {
      setError("Файл не является JSON набора диалогов");
    }
  }

  async function runBatch(mode: "heuristic" | "ai", onlyFailed = false) {
    const state = useCqa.getState();
    const versionNow = state.versions.find((item) => item.id === state.activeVersionId);
    if (!versionNow || runnerRef.current.running) return;
    const frozen = {
      id: versionNow.id,
      configHash: versionNow.configHash,
      criteria: versionNow.criteria.map((criterion) => ({
        ...criterion,
        scale: criterion.scale ? { ...criterion.scale, steps: [...criterion.scale.steps] } : undefined,
      })),
    };
    const aiJob = state.jobs.find((item) => item.mode === "ai");
    const failedJobIds = (aiJob?.items ?? []).filter((item) => item.status === "failed").map((item) => item.conversationId);
    const requestedModel = /^[A-Za-z0-9._-]{1,64}$/.test(modelId.trim()) ? modelId.trim() : MODEL_ID;
    const selected = selectBatchTargets({
      conversationIds: rows.map((conversation) => conversation.id),
      evaluations: state.evaluations,
      versionId: frozen.id,
      configHash: frozen.configHash,
      mode,
      modelId: requestedModel,
      promptVersion: PROMPT_VERSION,
      onlyFailed,
      failedJobIds,
    });
    const limit = Math.max(1, Math.min(200, Math.floor(maxDialogs) || 1));
    const targets = rows
      .filter((conversation) => selected.includes(conversation.id))
      .slice(0, mode === "ai" && !onlyFailed ? limit : selected.length);
    if (!targets.length) {
      setError(
        onlyFailed
          ? "Нет неудачных AI-оценок этой модели, версии чек-листа и промпта. Эвристика не считается ошибкой модели."
          : mode === "ai"
            ? "В фильтре нет диалогов без AI-оценки с этими параметрами. Эвристика и ручная разметка запуск не закрывают."
            : "В фильтре нет диалогов без эвристики по этой версии чек-листа.",
      );
      return;
    }
    cancelRef.current = false;
    const jobId = startJob(mode, targets.length);
    setBusy(true);
    setConfirmGrok(false);
    let spentNow = 0;
    setSpent(0);
    try {
      const outcome = await runnerRef.current.run({
        items: targets.map((conversation) => ({ id: conversation.id, payload: conversation })),
        concurrency: mode === "ai" ? concurrency : 4,
        maxAttempts: 3,
        retryDelayMs: mode === "ai" ? 600 : 0,
        isCancelled: () => cancelRef.current,
        onUpdate: (items) => {
          const needsReview = items.filter((item) => item.status === "needs_review").length;
          const failed = items.filter((item) => item.status === "failed").length;
          const completed = items.filter((item) => item.status === "completed" || item.status === "needs_review").length;
          patchJob(jobId, {
            completed,
            failed,
            needsReview,
            items: items.map((item) => ({
              conversationId: item.id,
              status: item.status === "cancelled" ? "failed" : item.status,
              attempts: item.attempts,
              message: item.message,
            })),
            errors: items
              .filter((item) => item.message && item.status === "failed")
              .map((item) => ({ conversationId: item.id, message: item.message ?? "ошибка" })),
          });
        },
        work: async (conversation) => {
          if (mode === "heuristic") {
            useCqa.getState().evaluateRules(conversation.id, frozen.id);
            const saved = latestEvaluation(useCqa.getState().evaluations, conversation.id, frozen.id);
            if (!saved || saved.status === "failed") throw new Error(saved?.error ?? "Эвристика не сохранила оценку");
            return saved.status === "needs_review" ? "needs_review" : "completed";
          }
          const startedAt = new Date().toISOString();
          if (spentNow >= costCap) {
            cancelRef.current = true;
            throw new Error("Достигнут лимит расходов. Успешные оценки сохранены.");
          }
          const response = await evaluateConversation({
            data: { conversation, criteria: frozen.criteria, model: requestedModel },
          });
          if (!response.ok) throw new Error(response.error);
          spentNow += response.usage?.estimatedCostUsd ?? 0;
          setSpent(Math.round(spentNow * 10_000) / 10_000);
          if (spentNow >= costCap) cancelRef.current = true;
          useCqa.getState().saveModelEvaluation(
            {
              conversationId: conversation.id,
              checklistVersionId: frozen.id,
              configHash: frozen.configHash,
              modelId: response.model || requestedModel,
              promptVersion: response.promptVersion || PROMPT_VERSION,
              startedAt,
            },
            response,
          );
          if (response.status === "failed") throw new Error(response.error ?? "Оценка не принята");
          return response.status === "needs_review" ? "needs_review" : "completed";
        },
      });
      patchJob(jobId, {
        status: outcome.status,
        completed: outcome.completed + outcome.needsReview,
        failed: outcome.failed,
        needsReview: outcome.needsReview,
      });
    } catch (reason) {
      patchJob(jobId, {
        status: "failed",
        errors: [{ conversationId: "-", message: reason instanceof Error ? reason.message : "пакет не запущен" }],
      });
    } finally {
      setBusy(false);
    }
  }

  const job = jobs[0];

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <p className="text-xs font-semibold tracking-wide text-accent uppercase">Сценарий защиты</p>
        <p className="mt-2 text-sm leading-6 text-ink">
          Откройте диалог и запустите Grok или эвристику. Клик по цитате подсвечивает реплику. У звонка есть плеер.
          Оспорьте критерий, переключитесь на «Проверяющий» и измените балл — итог пересчитается без нового вызова модели.
          В чек-листе сохраните новую версию и оцените другой диалог.
        </p>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <input
            className={inputClass}
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
            aria-label="group_id"
            placeholder="group_id"
          />
          <Button className="sm:w-40" disabled={busy} onClick={() => void onImportGroup()}>
            Импорт
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="size-4" />
            JSON
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => importDemo()}>
            Демо, 14
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => importControl()}>
            Учебные, 10
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onFile(file);
              event.target.value = "";
            }}
          />
        </div>
        <p className="mt-3 text-sm text-muted">
          {importNote} Импорт group_id всегда идёт в API организаторов, включая DEV. Демо и учебные 10 — отдельные кнопки, не официальный контроль и не результат модели.
        </p>
        {error ? <p className="mt-2 text-sm text-critical">{error}</p> : null}
      </section>

      <div className="flex flex-wrap gap-2">
        {["all", "RU", "KZ", "EN"].map((item) => (
          <button
            key={item}
            className={cx(
              "h-10 rounded-full px-3 text-sm font-semibold",
              language === item ? "bg-ink text-on-ink" : "bg-surface text-muted border border-line",
            )}
            onClick={() => setLanguage(item)}
          >
            {item === "all" ? "Все языки" : item}
          </button>
        ))}
        {["all", "agent chat", "voice call"].map((item) => (
          <button
            key={item}
            className={cx(
              "h-10 rounded-full px-3 text-sm font-semibold",
              channel === item ? "bg-accent text-on-accent" : "bg-surface text-muted border border-line",
            )}
            onClick={() => setChannel(item)}
          >
            {item === "all" ? "Все каналы" : channelLabel(item)}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" disabled={busy || !rows.length} onClick={() => void runBatch("heuristic")}>
          <Play className="size-4" />
          Эвристика по списку
        </Button>
        <Button variant="primary" disabled={busy || !rows.length} onClick={() => setConfirmGrok(true)}>
          Grok по списку
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void runBatch("ai", true)}>
          Повторить неудачные
        </Button>
        <label className="flex items-center gap-2 text-sm text-muted">
          Параллельно
          <input
            className="h-11 w-16 rounded-xl border border-line px-2 text-ink"
            type="number"
            min={1}
            max={4}
            aria-label="параллельность"
            value={concurrency}
            onChange={(event) => setConcurrency(Math.max(1, Math.min(4, Number(event.target.value) || 1)))}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          Модель
          <input
            className="h-11 w-36 rounded-xl border border-line px-2 text-ink"
            aria-label="модель"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          Диалогов
          <input
            className="h-11 w-16 rounded-xl border border-line px-2 text-ink"
            type="number"
            min={1}
            max={200}
            aria-label="лимит диалогов"
            value={maxDialogs}
            onChange={(event) => setMaxDialogs(Math.max(1, Math.min(200, Number(event.target.value) || 1)))}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          Лимит $
          <input
            className="h-11 w-20 rounded-xl border border-line px-2 text-ink"
            type="number"
            min={0}
            step={0.5}
            aria-label="лимит расходов"
            value={costCap}
            onChange={(event) => setCostCap(Math.max(0, Number(event.target.value) || 0))}
          />
        </label>
        {busy ? (
          <Button variant="quiet" onClick={() => (cancelRef.current = true)}>
            Остановить
          </Button>
        ) : null}
      </div>
      {confirmGrok ? (
        <div className="rounded-2xl border border-line bg-accent-soft p-4 text-sm text-ink">
          Пакет оценит до {maxDialogs} диалогов фильтра, у которых ещё нет AI-оценки с моделью {modelId || MODEL_ID}, промптом {PROMPT_VERSION} и текущей версией чек-листа. Эвристика и ручная разметка такой оценкой не считаются. Параллельность {concurrency}, лимит расходов ${costCap}. Повтор сети — до трёх попыток. Демо и эвристика не записываются как AI.
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void runBatch("ai")}>Запустить</Button>
            <Button variant="ghost" onClick={() => setConfirmGrok(false)}>
              Отмена
            </Button>
          </div>
        </div>
      ) : null}
      {job ? (
        <p className="text-sm text-muted">
          Пакет {job.mode === "ai" ? "AI" : "эвристика"}: {job.completed}/{job.total}, ошибок {job.failed}, на проверке {job.needsReview ?? 0}, статус {job.status}
          {job.mode === "ai" ? `, расход $${spent.toFixed(4)}` : ""}
          {job.errors[0] ? ` — ${job.errors[0].message}` : ""}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          onClick={() => downloadText("cqa-results.json", JSON.stringify(resultRows(conversations, evaluations), null, 2), "application/json")}
        >
          Экспорт JSON
        </Button>
        <Button variant="ghost" onClick={() => downloadText("cqa-results.csv", resultsToCsv(resultRows(conversations, evaluations)), "text/csv")}>
          Экспорт CSV
        </Button>
      </div>

      <ul className="flex flex-col gap-2">
        {rows.map((conversation) => {
          const evaluation = latestEvaluation(evaluations, conversation.id, version?.id);
          return (
            <li key={conversation.id}>
              <button
                className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-left hover:border-accent"
                onClick={() => onOpen(conversation.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-sm font-medium text-ink">{conversation.externalId}</span>
                  <span className="mt-1 block text-sm text-muted">
                    {conversation.language} · {channelLabel(conversation.channel)} · {conversation.datasetGroupId}
                    {conversation.origin === "demo" ? " · демо" : conversation.origin === "study" || conversation.origin === "control" ? " · учебный" : ""}
                    {conversation.channel === "voice call" ? " · аудио" : ""}
                  </span>
                </span>
                {conversation.channel === "voice call" ? <AudioLines className="size-4 text-accent" /> : null}
                <span className="text-right">
                  <span className="block font-mono text-lg font-medium text-ink">
                    {formatTotal(evaluation?.finalTotal)}
                  </span>
                  <span className="text-xs text-muted">
                    {evaluation ? `${sourceLabel(evaluation.source)} · ${evaluation.finalCritical ? "крит. флаг" : evaluation.status}` : "не оценён"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!rows.length ? <p className="text-sm text-muted">В этом фильтре диалогов нет.</p> : null}
    </div>
  );
}
