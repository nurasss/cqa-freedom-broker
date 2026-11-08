import { useEffect, useState } from "react";
import { officialCriteria } from "@/lib/cqa/seed";
import { benchmarkByRun, evaluateBenchmark } from "@/lib/cqa/benchmark";
import { controlCases } from "@/lib/cqa/control";
import { rulesDrafts } from "@/lib/cqa/rules";
import { computeScore, validateChecklist } from "@/lib/cqa/score";
import { useCqa } from "@/lib/cqa/store";
import type { AnswerType, Criterion, SectionId } from "@/lib/cqa/types";
import { SECTION_LABEL } from "@/lib/cqa/types";
import type { BenchmarkReport } from "@/lib/cqa/benchmark";
import { Button, cx, evalStatusTooltip, inputClass } from "./ui";

const sections = Object.keys(SECTION_LABEL) as SectionId[];
const types: AnswerType[] = ["yes_no", "yes_no_na", "scale", "flag"];

export function ChecklistView() {
  const versions = useCqa((state) => state.versions);
  const activeVersionId = useCqa((state) => state.activeVersionId);
  const setActiveVersion = useCqa((state) => state.setActiveVersion);
  const saveVersion = useCqa((state) => state.saveVersion);
  const resetLocal = useCqa((state) => state.resetLocal);
  const exportSnapshot = useCqa((state) => state.exportSnapshot);
  const importSnapshot = useCqa((state) => state.importSnapshot);
  const evaluations = useCqa((state) => state.evaluations);
  const conversations = useCqa((state) => state.conversations);
  const active = versions.find((version) => version.id === activeVersionId) ?? versions[0]!;
  const [draft, setDraft] = useState<Criterion[]>(active.criteria);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState("");
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [runs, setRuns] = useState<Record<string, BenchmarkReport>>({});
  const [archiveError, setArchiveError] = useState("");

  useEffect(() => {
    setDraft(active.criteria.map((criterion) => ({ ...criterion, scale: criterion.scale ? { ...criterion.scale, steps: [...criterion.scale.steps] } : undefined })));
    setSaved("");
    setErrors([]);
  }, [active.id]);

  function patch(id: string, partial: Partial<Criterion>) {
    setDraft((current) => current.map((criterion) => (criterion.id === id ? { ...criterion, ...partial } : criterion)));
  }

  function addCriterion() {
    setDraft((current) => {
      let number = current.length + 1;
      let id = `X${String(number).padStart(2, "0")}`;
      while (current.some((item) => item.id === id)) {
        number += 1;
        id = `X${String(number).padStart(2, "0")}`;
      }
      return [
        ...current,
        {
          id,
          title: "Новый критерий",
          section: "custom",
          weight: 10,
          answerType: "yes_no",
          naAllowed: false,
          rubric: "Опишите, когда ставится ДА и когда НЕТ.",
        },
      ];
    });
  }

  const exampleA = computeScore(officialCriteria, {
    C01: "yes",
    C02: "yes",
    C03: "no",
    C04: 15,
    C05: "yes",
    C06: 7,
    C07: "no",
    C08: "yes",
  });
  const exampleB = computeScore(officialCriteria, {
    C01: "yes",
    C02: "yes",
    C03: "na",
    C04: 15,
    C05: "yes",
    C06: 7,
    C07: "no",
    C08: "no",
  });
  const weight = draft.filter((criterion) => criterion.answerType !== "flag").reduce((sum, criterion) => sum + Number(criterion.weight || 0), 0);

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <p className="text-sm text-muted">Активная версия для новых оценок. Старые оценки остаются на своём снимке.</p>
        <div className="mt-3 flex flex-col gap-2">
          {versions.map((version) => (
            <button
              key={version.id}
              className={cx(
                "rounded-xl border px-3 py-2 text-left",
                version.id === active.id ? "border-accent bg-accent-soft" : "border-line",
              )}
              onClick={() => setActiveVersion(version.id)}
            >
              <span className="block text-sm font-semibold text-ink">
                {version.label}
                {version.official ? " · официальный S5" : ""}
              </span>
              <span className="font-mono text-xs text-muted">
                {version.id} · {version.configHash}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4 text-sm leading-6 text-ink">
        <p className="font-semibold">Формула</p>
        <p className="mt-1 text-muted">
          Итог = 100 × сумма(вес × балл / максимум) по применимым критериям / сумма их весов. N/A выпадает из обеих сумм. Округление HALF_UP до 2 знаков. Флаг грубой ошибки в сумму не входит. Если применимых весов нет — статус not_scorable и прочерк, не ноль.
        </p>
        <p className="mt-2 font-mono text-ink">
          Пример A: {exampleA.total?.toFixed(2)} при C08=ДА. Пример B (C03=N/A): {exampleB.total?.toFixed(2)}.
        </p>
        <p className="mt-2 text-muted">
          Ориентир стоимости: $2 за 1М входных и $6 за 1М выходных токенов (базовые тарифы Grok 4.5 или значения из env), на диалог 2 вызова (оценка и AI Judge), при спорных ответах или сбоях — до 6. Оценка стоимости: npm run estimate:cost.
        </p>
      </section>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">Сумма весов без флагов: {weight}</p>
        <Button variant="ghost" onClick={addCriterion}>
          Добавить критерий
        </Button>
      </div>

      {draft.map((criterion, index) => (
        <article key={index} className="rounded-2xl border border-line bg-surface p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-muted">
              Id
              <input className={cx(inputClass, "mt-1")} value={criterion.id} onChange={(event) => patch(criterion.id, { id: event.target.value.trim() })} />
            </label>
            <label className="text-sm text-muted">
              Название
              <input className={cx(inputClass, "mt-1")} value={criterion.title} onChange={(event) => patch(criterion.id, { title: event.target.value })} />
            </label>
            <label className="text-sm text-muted">
              Вес
              <input
                className={cx(inputClass, "mt-1")}
                type="number"
                value={criterion.weight}
                onChange={(event) => patch(criterion.id, { weight: Number(event.target.value) })}
              />
            </label>
            <label className="text-sm text-muted">
              Тип ответа
              <select
                className={cx(inputClass, "mt-1")}
                value={criterion.answerType}
                onChange={(event) => {
                  const answerType = event.target.value as AnswerType;
                  patch(criterion.id, {
                    answerType,
                    naAllowed: answerType === "yes_no_na",
                    weight: answerType === "flag" ? 0 : criterion.weight || 10,
                    scale:
                      answerType === "scale"
                        ? (criterion.scale ?? { steps: [0, 5, 10], max: 10 })
                        : undefined,
                  });
                }}
              >
                {types.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-muted">
              Секция
              <select
                className={cx(inputClass, "mt-1")}
                value={criterion.section}
                onChange={(event) => patch(criterion.id, { section: event.target.value as SectionId })}
              >
                {sections.map((section) => (
                  <option key={section} value={section}>
                    {SECTION_LABEL[section]}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-6 flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={criterion.naAllowed}
                disabled={criterion.answerType === "flag"}
                onChange={(event) => {
                  const checked = event.target.checked;
                  if (criterion.answerType === "scale") {
                    patch(criterion.id, { naAllowed: checked });
                  } else {
                    patch(criterion.id, {
                      naAllowed: checked,
                      answerType: checked ? "yes_no_na" : "yes_no",
                    });
                  }
                }}
              />
              N/A допустим
            </label>
          </div>
          {criterion.answerType === "scale" ? (
            <label className="mt-3 block text-sm text-muted">
              Ступени через запятую
              <input
                className={cx(inputClass, "mt-1")}
                value={(criterion.scale?.steps ?? []).join(", ")}
                onChange={(event) => {
                  const steps = event.target.value
                    .split(",")
                    .map((part) => Number(part.trim()))
                    .filter((part) => Number.isFinite(part));
                  patch(criterion.id, { scale: { steps, max: steps.length ? Math.max(...steps) : 0 } });
                }}
              />
            </label>
          ) : null}
          <label className="mt-3 block text-sm text-muted">
            Формулировка для модели и аналитика
            <textarea
              className="mt-1 min-h-24 w-full rounded-xl border border-line px-3 py-2 text-sm text-ink"
              value={criterion.rubric}
              onChange={(event) => patch(criterion.id, { rubric: event.target.value })}
            />
          </label>
          {!active.official || criterion.id.startsWith("NEW") ? null : null}
          <Button
            variant="quiet"
            className="mt-2"
            onClick={() => setDraft((current) => current.filter((item) => item.id !== criterion.id))}
          >
            Убрать из черновика
          </Button>
        </article>
      ))}

      {errors.length ? (
        <ul className="text-sm text-critical">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      {saved ? <p className="text-sm text-accent">{saved}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            const nextErrors = saveVersion(draft);
            setErrors(nextErrors);
            setSaved(nextErrors.length ? "" : "Новая версия сохранена и выбрана для следующих оценок");
          }}
        >
          Сохранить новую версию
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            const local = validateChecklist(draft);
            setErrors(local);
            setSaved(local.length ? "" : "Черновик проходит проверку");
          }}
        >
          Проверить
        </Button>
      </div>
      <section className="rounded-2xl border border-line bg-surface p-4 text-sm leading-6">
        <p className="font-semibold text-ink">Локальный benchmark</p>
        <p className="mt-1 text-muted">
          10 локальных учебных транскриптов с ручной разметкой и, отдельно, пары «ручная метка / AI» по активной версии, включая DEV, если он импортирован. Это не официальный контрольный набор организаторов и не подмена ответа модели.
        </p>
        <Button
          className="mt-3"
          variant="ghost"
          onClick={() => {
            const cases = controlCases();
            const pairs = cases.map((item) => ({
              id: item.conversation.id,
              language: item.conversation.language,
              model: "rules-heuristic-v1",
              promptVersion: "rules-v1",
              gold: item.answers,
              predicted: Object.fromEntries(rulesDrafts(officialCriteria, item.conversation).map((draft) => [draft.criterionId, draft.answer])),
            }));
            setReport(evaluateBenchmark(officialCriteria, pairs));
            const aiPairs = cases.flatMap((item) =>
              evaluations
                .filter((evaluation) => evaluation.conversationId === item.conversation.id && evaluation.source === "ai" && evaluation.status !== "failed")
                .map((evaluation) => ({
                  id: item.conversation.id,
                  language: item.conversation.language,
                  model: evaluation.model,
                  promptVersion: evaluation.promptVersion,
                  gold: item.answers,
                  predicted: Object.fromEntries(evaluation.baseResults.map((result) => [result.criterionId, result.answer])),
                })),
            );
            setRuns(aiPairs.length ? benchmarkByRun(officialCriteria, aiPairs) : {});
          }}
        >
          Сравнить эвристику с ручной разметкой
        </Button>
        <Button
          className="mt-3"
          variant="ghost"
          onClick={() => {
            const versionId = active.id;
            const pairs = conversations.flatMap((conversation) => {
              const manual = evaluations
                .filter((item) => item.conversationId === conversation.id && item.checklistVersionId === versionId && item.source === "manual")
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
              const ai = evaluations
                .filter(
                  (item) =>
                    item.conversationId === conversation.id &&
                    item.checklistVersionId === versionId &&
                    item.source === "ai" &&
                    item.status !== "failed" &&
                    item.baseResults.length > 0,
                )
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
              if (!manual || !ai) return [];
              return [
                {
                  id: conversation.id,
                  language: conversation.language,
                  model: ai.model,
                  promptVersion: ai.promptVersion,
                  needsReview: ai.status === "needs_review",
                  gold: Object.fromEntries(manual.baseResults.map((result) => [result.criterionId, result.answer])),
                  predicted: Object.fromEntries(ai.baseResults.map((result) => [result.criterionId, result.answer])),
                },
              ];
            });
            setReport(pairs.length ? evaluateBenchmark(active.criteria, pairs) : null);
            setRuns(pairs.length ? benchmarkByRun(active.criteria, pairs) : {});
            setSaved(
              pairs.length
                ? ""
                : "Нет пар ручная разметка + AI по активной версии. Локальные метки не являются Ground Truth организаторов.",
            );
          }}
        >
          Сравнить AI с ручной разметкой
        </Button>
        {report ? (
          <div className="mt-3 text-ink">
            <p>MAE итога: {report.mae ?? "—"} · N/A precision {report.naPrecision ?? "—"} · N/A recall {report.naRecall ?? "—"}</p>
            <p title={evalStatusTooltip("needs_review")}>На проверке (needs_review): {report.needsReview}</p>
            <ul className="mt-2">
              {Object.entries(report.criterionAccuracy).map(([id, value]) => (
                <li key={id}>
                  {id}: {value === null ? "—" : value}
                </li>
              ))}
            </ul>
            <p>
              C08 precision {report.critical.precision ?? "—"} · recall {report.critical.recall ?? "—"} · F1 {report.critical.f1 ?? "—"}
            </p>
            <p className="text-muted">{report.disclaimer}</p>
            <ul className="mt-2">
              {Object.entries(report.byLanguage).map(([language, bucket]) => (
                <li key={language}>
                  {language}: n={bucket.count}, MAE {bucket.mae ?? "—"}, расхождений {bucket.mismatches}
                </li>
              ))}
            </ul>
            {Object.keys(runs).length ? (
              <ul className="mt-2">
                {Object.entries(runs).map(([label, item]) => (
                  <li key={label}>
                    {label}: MAE {item.mae ?? "—"}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">Оценок AI на учебном наборе пока нет — сравнение моделей появится после реального вызова.</p>
            )}
          </div>
        ) : null}
      </section>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            const blob = new Blob([exportSnapshot()], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "cqa-archive.json";
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          Скачать архив
        </Button>
        <label className="inline-flex h-11 cursor-pointer items-center rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-ink">
          Загрузить архив
          <input
            className="hidden"
            type="file"
            accept="application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void file.text().then((raw) => setArchiveError(importSnapshot(raw) ?? ""));
              event.target.value = "";
            }}
          />
        </label>
      </div>
      {archiveError ? <p className="text-sm text-critical">{archiveError}</p> : null}
      <button className="text-left text-sm text-muted underline" onClick={() => resetLocal()}>
        Сбросить локальные оценки и вернуть демо-набор
      </button>
    </div>
  );
}
