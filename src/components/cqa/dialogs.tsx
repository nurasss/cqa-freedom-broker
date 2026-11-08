import { useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Play, Trash2, Upload } from "lucide-react";
import { parseImport } from "@/lib/cqa/engine";
import { evaluateConversation, getLlmInfo, importOrganizerGroup, type LlmInfo } from "@/lib/cqa/ai-fns";
import { createBatchRunner, mapCancelledItem } from "@/lib/cqa/queue";
import { filterConversations, getDatasetGroupStats, latestEvaluation, selectBatchTargets, useCqa } from "@/lib/cqa/store";
import { resultRows, resultsToCsv } from "@/lib/cqa/benchmark";
import { controlConversations } from "@/lib/cqa/control";
import type { BatchItemStatus } from "@/lib/cqa/types";
import { MODEL_ID, PROMPT_VERSION } from "@/lib/cqa/types";
import { Button, channelLabel, cx, evalStatusLabel, evalStatusTooltip, formatTotal, inputClass, sourceLabel } from "./ui";

export const DEFAULT_COST_ESTIMATE_USD = 0.05;

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
  const deleteDatasetGroup = useCqa((state) => state.deleteDatasetGroup);
  const version = versions.find((item) => item.id === activeVersionId);
  const [language, setLanguage] = useState("all");
  const [channel, setChannel] = useState("all");
  const [selectedGroup, setSelectedGroup] = useState("all");
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<string | null>(null);
  const [groupId, setGroupId] = useState("DEV");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmAi, setConfirmAi] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [modelId, setModelId] = useState(MODEL_ID);
  const [llmInfo, setLlmInfo] = useState<LlmInfo | null>(null);
  const [costCap, setCostCap] = useState(8);
  const [maxDialogs, setMaxDialogs] = useState<number | "">("");
  const [spent, setSpent] = useState(0);
  const cancelRef = useRef(false);
  const runnerRef = useRef(createBatchRunner());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getLlmInfo()
      .then((info) => {
        setLlmInfo(info);
        if (info.model) {
          setModelId(info.model);
        }
      })
      .catch(() => {});
  }, []);

  const aiEvaluationsWithCost = useMemo(
    () =>
      evaluations.filter(
        (e) => e.source === "ai" && typeof e.usage?.estimatedCostUsd === "number" && e.usage.estimatedCostUsd > 0,
      ),
    [evaluations],
  );

  const avgCostPerDialog = useMemo(() => {
    if (!aiEvaluationsWithCost.length) return 0;
    const total = aiEvaluationsWithCost.reduce((sum, e) => sum + (e.usage?.estimatedCostUsd ?? 0), 0);
    return total / aiEvaluationsWithCost.length;
  }, [aiEvaluationsWithCost]);

  const datasetGroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of conversations) {
      counts.set(c.datasetGroupId, (counts.get(c.datasetGroupId) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([id, count]) => ({
      groupId: id,
      count,
    }));
  }, [conversations]);

  const rows = useMemo(
    () =>
      filterConversations(conversations, {
        language,
        channel,
        group: selectedGroup,
      }),
    [conversations, language, channel, selectedGroup],
  );

  const candidateTargets = useMemo(() => {
    const versionNow = versions.find((item) => item.id === activeVersionId);
    if (!versionNow) return [];
    const defaultModel = llmInfo?.model ?? MODEL_ID;
    const requestedModel = /^[A-Za-z0-9._:/-]{1,128}$/.test(modelId.trim()) ? modelId.trim() : defaultModel;
    const selected = selectBatchTargets({
      conversationIds: rows.map((conversation) => conversation.id),
      evaluations,
      versionId: versionNow.id,
      configHash: versionNow.configHash,
      mode: "ai",
      modelId: requestedModel,
      promptVersion: PROMPT_VERSION,
      onlyFailed: false,
    });
    const parsedLimit = typeof maxDialogs === "number" && maxDialogs > 0 ? maxDialogs : undefined;
    return rows
      .filter((conversation) => selected.includes(conversation.id))
      .slice(0, parsedLimit ? parsedLimit : selected.length);
  }, [rows, evaluations, versions, activeVersionId, modelId, maxDialogs, llmInfo?.model]);

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
      setSelectedGroup(parsed.groupId);
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
      setSelectedGroup(parsed.groupId);
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
    const defaultModel = llmInfo?.model ?? MODEL_ID;
    const requestedModel = /^[A-Za-z0-9._:/-]{1,128}$/.test(modelId.trim()) ? modelId.trim() : defaultModel;
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
    const parsedLimit = typeof maxDialogs === "number" && maxDialogs > 0 ? maxDialogs : undefined;
    const targets = rows
      .filter((conversation) => selected.includes(conversation.id))
      .slice(0, mode === "ai" && !onlyFailed && parsedLimit ? parsedLimit : selected.length);
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
    setConfirmAi(false);
    let spentNow = 0;
    setSpent(0);
    try {
      const outcome = await runnerRef.current.run({
        items: targets.map((conversation) => ({ id: conversation.id, payload: conversation })),
        concurrency: mode === "ai" ? concurrency : 4,
        maxAttempts: 3,
        retryDelayMs: mode === "ai" ? 600 : 0,
        costCap: mode === "ai" ? costCap : undefined,
        estimateCostUsd:
          mode === "ai"
            ? avgCostPerDialog > 0
              ? avgCostPerDialog
              : llmInfo?.isLocal || (llmInfo?.priceSource === "env" && llmInfo.priceInputPerM === 0 && llmInfo.priceOutputPerM === 0)
                ? 0
                : DEFAULT_COST_ESTIMATE_USD
            : 0,
        isCancelled: () => cancelRef.current,
        onUpdate: (items) => {
          const resolvedItems = items.map((item) => (cancelRef.current ? mapCancelledItem(item) : item));
          const needsReview = resolvedItems.filter((item) => item.status === "needs_review").length;
          const failed = resolvedItems.filter((item) => item.status === "failed").length;
          const completed = resolvedItems.filter((item) => item.status === "completed" || item.status === "needs_review").length;
          patchJob(jobId, {
            completed,
            failed,
            needsReview,
            items: resolvedItems.map((item) => ({
              conversationId: item.id,
              status: item.status as BatchItemStatus,
              attempts: item.attempts,
              message: item.message,
            })),
            errors: resolvedItems
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
          const response = await evaluateConversation({
            data: { conversation, criteria: frozen.criteria, model: requestedModel },
          });
          const actualCost = response.usage?.estimatedCostUsd;
          if (typeof actualCost === "number") {
            spentNow += actualCost;
            setSpent(Math.round(spentNow * 10_000) / 10_000);
          }
          if (!response.ok) {
            const err = new Error(response.error);
            if (typeof actualCost === "number") {
              (err as { costUsd?: number }).costUsd = actualCost;
            }
            if (response.code) {
              (err as { code?: string }).code = response.code;
            }
            if (response.code === "no_api_key" || response.code === "auth" || response.code === "model_not_found") {
              (err as { fatal?: boolean }).fatal = true;
            }
            throw err;
          }
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
          return {
            status: response.status === "needs_review" ? "needs_review" : "completed",
            costUsd: actualCost,
          };
        },
      });
      const processed = outcome.completed + outcome.needsReview;
      if (outcome.stoppedByFatal) {
        const fatalNotice =
          outcome.fatalCode === "no_api_key"
            ? "Пакет остановлен: на сервере нет ключа модели"
            : outcome.fatalCode === "auth"
              ? "Пакет остановлен: ключ отклонён"
              : outcome.fatalCode === "model_not_found"
                ? `Пакет остановлен: провайдер не знает модель ${requestedModel}`
                : `Пакет остановлен: ${outcome.fatalMessage ?? "фатальная ошибка"}`;
        patchJob(jobId, {
          status: outcome.status,
          completed: processed,
          failed: outcome.failed,
          needsReview: outcome.needsReview,
          errors: [{ conversationId: "-", message: fatalNotice }],
        });
        setError(fatalNotice);
      } else if (outcome.stoppedByBudget) {
        const budgetMessage = `Остановлено по лимиту расходов $${costCap}: обработано ${processed} из ${targets.length}. Оставшиеся можно запустить повторно — уже оценённые не будут оплачены второй раз.`;
        patchJob(jobId, {
          status: outcome.status,
          completed: processed,
          failed: outcome.failed,
          needsReview: outcome.needsReview,
          errors: [{ conversationId: "-", message: budgetMessage }],
        });
        setError(budgetMessage);
      } else {
        patchJob(jobId, {
          status: outcome.status,
          completed: processed,
          failed: outcome.failed,
          needsReview: outcome.needsReview,
        });
      }
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
          Откройте диалог и запустите AI или эвристику. Клик по цитате подсвечивает реплику. У звонка есть плеер.
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
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              importDemo();
              setSelectedGroup("DEMO");
            }}
          >
            Демо, 14
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              importControl();
              setSelectedGroup("STUDY");
            }}
          >
            Учебные, {controlConversations().length}
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
          {importNote} Импорт group_id всегда идёт в API организаторов, включая DEV. Демо и учебные диалоги — отдельные кнопки, не официальный контроль и не результат модели.
        </p>
        {error ? <p className="mt-2 text-sm text-critical">{error}</p> : null}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <button
          className={cx(
            "h-10 rounded-full px-3 text-sm font-semibold",
            selectedGroup === "all" ? "bg-ink text-on-ink" : "bg-surface text-muted border border-line",
          )}
          onClick={() => {
            setSelectedGroup("all");
            setConfirmDeleteGroup(null);
          }}
        >
          Все наборы
        </button>
        {datasetGroups.map((item) => (
          <button
            key={item.groupId}
            className={cx(
              "h-10 rounded-full px-3 text-sm font-semibold",
              selectedGroup === item.groupId ? "bg-ink text-on-ink" : "bg-surface text-muted border border-line",
            )}
            onClick={() => {
              setSelectedGroup(item.groupId);
              setConfirmDeleteGroup(null);
            }}
          >
            {item.groupId} · {item.count}
          </button>
        ))}
        {selectedGroup !== "all" ? (
          <Button
            variant="danger"
            className="h-10 px-3 text-xs"
            onClick={() => setConfirmDeleteGroup(selectedGroup)}
          >
            <Trash2 className="size-3.5" />
            Удалить набор {selectedGroup}
          </Button>
        ) : null}
      </div>

      {confirmDeleteGroup ? (() => {
        const stats = getDatasetGroupStats(useCqa.getState(), confirmDeleteGroup);
        return (
          <div className="rounded-2xl border border-critical bg-critical-soft p-4 text-sm text-ink">
            <p className="font-semibold text-critical">
              Подтвердите удаление набора «{confirmDeleteGroup}»
            </p>
            <p className="mt-1 text-sm text-ink">
              Будет удалено: {stats.conversations} диалогов, {stats.evaluations} оценок, {stats.appeals} апелляций{stats.decisions > 0 ? `, ${stats.decisions} решений` : ""}.
            </p>
            <p className="mt-1 text-xs text-muted">
              Действие необратимо. Оценки и апелляции этого набора будут полностью удалены.
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                variant="danger"
                onClick={() => {
                  deleteDatasetGroup(confirmDeleteGroup);
                  setSelectedGroup("all");
                  setConfirmDeleteGroup(null);
                }}
              >
                Да, удалить набор
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDeleteGroup(null)}>
                Отмена
              </Button>
            </div>
          </div>
        );
      })() : null}

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
        <Button variant="primary" disabled={busy || !rows.length} onClick={() => setConfirmAi(true)}>
          AI по списку
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
        <label className="flex flex-wrap items-center gap-2 text-sm text-muted">
          Модель
          <input
            className="h-11 w-36 rounded-xl border border-line px-2 text-ink"
            aria-label="модель"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
          />
          {llmInfo ? (
            <span className="text-xs text-muted">
              {llmInfo.isLocal
                ? `локальная: ${llmInfo.provider}`
                : llmInfo.priceSource === "env" && llmInfo.priceInputPerM === 0 && llmInfo.priceOutputPerM === 0
                  ? `${llmInfo.provider} (бесплатно)`
                  : llmInfo.provider}
            </span>
          ) : null}
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          Диалогов
          <input
            className="h-11 w-16 rounded-xl border border-line px-2 text-ink"
            type="number"
            min={1}
            max={200}
            aria-label="лимит диалогов"
            placeholder="все"
            value={maxDialogs}
            onChange={(event) => {
              const val = event.target.value.trim();
              if (!val) {
                setMaxDialogs("");
              } else {
                const num = Number(val);
                setMaxDialogs(Number.isFinite(num) && num > 0 ? Math.max(1, Math.min(200, Math.floor(num))) : "");
              }
            }}
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
      {confirmAi ? (
        <div className="rounded-2xl border border-line bg-accent-soft p-4 text-sm text-ink">
          Пакет оценит {candidateTargets.length} диалогов фильтра, у которых ещё нет AI-оценки с моделью {modelId || MODEL_ID}, промптом {PROMPT_VERSION} и текущей версией чек-листа.{" "}
          {aiEvaluationsWithCost.length > 0
            ? `Примерная стоимость: ~$${(avgCostPerDialog * candidateTargets.length).toFixed(4)} (средняя прошлых AI-оценок $${avgCostPerDialog.toFixed(4)} × ${candidateTargets.length}). `
            : "Прошлых AI-оценок нет, примерная стоимость неизвестна. "}
          Параллельность {concurrency}, лимит расходов ${costCap}. Повтор сети — до трёх попыток. Демо и эвристика не записываются как AI.
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void runBatch("ai")}>Запустить</Button>
            <Button variant="ghost" onClick={() => setConfirmAi(false)}>
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
          onClick={() => downloadText("cqa-results.json", JSON.stringify(resultRows(rows, evaluations, { versionId: version?.id }), null, 2), "application/json")}
        >
          Экспорт JSON
        </Button>
        <Button
          variant="ghost"
          onClick={() => downloadText("cqa-results.csv", resultsToCsv(resultRows(rows, evaluations, { versionId: version?.id })), "text/csv;charset=utf-8")}
        >
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
                <span className="shrink-0 text-right">
                  <span className="block font-mono text-lg font-medium text-ink">
                    {formatTotal(evaluation?.finalTotal)}
                  </span>
                  <span className="text-xs text-muted">
                    {evaluation ? (
                      <>
                        {sourceLabel(evaluation.source)} ·{" "}
                        {evaluation.finalCritical ? "крит. флаг · " : ""}
                        <span
                          title={evalStatusTooltip(evaluation.status)}
                          className={evalStatusTooltip(evaluation.status) ? "cursor-help underline decoration-dotted underline-offset-2" : ""}
                        >
                          {evalStatusLabel(evaluation.status)}
                        </span>
                      </>
                    ) : (
                      "не оценён"
                    )}
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
