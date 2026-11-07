import { create } from "zustand";
import { createJSONStorage, persist, type PersistStorage, type StateStorage } from "zustand/middleware";
import { buildDemo } from "./demo.ts";
import { controlConversations } from "./control.ts";
import { assemble, type DraftAnswer } from "./engine.ts";
import { hashConfig, uid } from "./hash.ts";
import { rulesDrafts } from "./rules.ts";
import { answerAllowed, computeScore, validateChecklist } from "./score.ts";
import { officialVersion } from "./seed.ts";
import type {
  Answer,
  Appeal,
  BatchJob,
  ChecklistVersion,
  Conversation,
  Criterion,
  CriterionResult,
  Evaluation,
  ReviewDecision,
  Role,
  UsageInfo,
} from "./types.ts";

export interface EvalBinding {
  conversationId: string;
  checklistVersionId: string;
  configHash: string;
  modelId: string;
  promptVersion: string;
  startedAt: string;
}

export interface ModelPayload {
  status: Evaluation["status"];
  results: CriterionResult[];
  total: number | null;
  raw: number | null;
  critical: boolean;
  model: string;
  promptVersion: string;
  usage: UsageInfo | null;
  trace: string[];
  error?: string;
}

export interface DatasetGroupStats {
  conversations: number;
  evaluations: number;
  appeals: number;
  decisions: number;
  conversationsCount: number;
  evaluationsCount: number;
  appealsCount: number;
  decisionsCount: number;
}

export interface DeleteDatasetGroupResult {
  conversations: number;
  evaluations: number;
  appeals: number;
  decisions: number;
  conversationsCount: number;
  evaluationsCount: number;
  appealsCount: number;
  decisionsCount: number;
}

export interface CqaData {
  versions: ChecklistVersion[];
  activeVersionId: string;
  conversations: Conversation[];
  evaluations: Evaluation[];
  appeals: Appeal[];
  decisions: ReviewDecision[];
  jobs: BatchJob[];
  role: Role;
  importNote: string;
  storageError: boolean;
}

export interface CqaState extends CqaData {
  setRole: (role: Role) => void;
  setActiveVersion: (id: string) => void;
  importDemo: () => number;
  importControl: () => number;
  importConversations: (incoming: Conversation[], note?: string) => { added: number; note: string };
  saveVersion: (criteria: Criterion[]) => string[];
  evaluateRules: (conversationId: string, versionId?: string) => string | null;
  evaluateManual: (conversationId: string, drafts: DraftAnswer[]) => string | null;
  saveModelEvaluation: (binding: EvalBinding, payload: ModelPayload) => string | null;
  submitAppeal: (evaluationId: string, criterionId: string, comment: string) => string | null;
  decideAppeal: (
    appealId: string,
    action: "confirmed" | "overridden",
    reason: string,
    newAnswer?: Answer,
  ) => string | null;
  startJob: (mode: BatchJob["mode"], total: number) => string;
  patchJob: (id: string, patch: Partial<BatchJob>) => void;
  exportSnapshot: () => string;
  importSnapshot: (raw: string) => string | null;
  resetLocal: () => void;
  clearStorageError: () => void;
  deleteDatasetGroup: (groupId: string) => DeleteDatasetGroupResult;
}

export function getDatasetGroupStats(state: CqaData, groupId: string): DatasetGroupStats {
  const targetConvIds = new Set(
    state.conversations.filter((c) => c.datasetGroupId === groupId).map((c) => c.id),
  );
  const targetEvalIds = new Set(
    state.evaluations.filter((e) => targetConvIds.has(e.conversationId)).map((e) => e.id),
  );
  const targetAppealIds = new Set(
    state.appeals.filter((a) => targetEvalIds.has(a.evaluationId)).map((a) => a.id),
  );
  const targetDecisionCount = state.decisions.filter((d) => targetAppealIds.has(d.appealId)).length;
  return {
    conversations: targetConvIds.size,
    evaluations: targetEvalIds.size,
    appeals: targetAppealIds.size,
    decisions: targetDecisionCount,
    conversationsCount: targetConvIds.size,
    evaluationsCount: targetEvalIds.size,
    appealsCount: targetAppealIds.size,
    decisionsCount: targetDecisionCount,
  };
}

let isSyncingStorage = false;
let storeApi: {
  getState: () => { storageError: boolean };
  setState: (patch: Partial<CqaState>) => void;
} | null = null;

export function setStorageErrorState(error: boolean) {
  const api = storeApi ?? (typeof useCqa !== "undefined" ? useCqa : null);
  if (!api) return;
  if (api.getState().storageError === error) return;
  isSyncingStorage = true;
  try {
    api.setState({ storageError: error });
  } finally {
    isSyncingStorage = false;
  }
}

export function createSafeStorage<S = unknown>(
  getStorage: () => Storage | StateStorage,
  options?: {
    onError?: (error: unknown) => void;
    onSuccess?: () => void;
  },
): PersistStorage<S> {
  const jsonStorage = createJSONStorage<S>(getStorage as () => StateStorage);
  return {
    getItem: (name: string) => {
      try {
        return jsonStorage?.getItem(name) ?? null;
      } catch {
        return null;
      }
    },
    removeItem: (name: string) => {
      try {
        return jsonStorage?.removeItem(name);
      } catch {
        // ignore removal error
      }
    },
    setItem: (name: string, value: any) => {
      if (isSyncingStorage) return;
      try {
        const res = jsonStorage?.setItem(name, value);
        if (res instanceof Promise) {
          return res
            .then(() => {
              if (options?.onSuccess) {
                options.onSuccess();
              } else {
                setStorageErrorState(false);
              }
            })
            .catch((err) => {
              if (options?.onError) {
                options.onError(err);
              } else {
                setStorageErrorState(true);
              }
            }) as any;
        }
        if (options?.onSuccess) {
          options.onSuccess();
        } else {
          setStorageErrorState(false);
        }
      } catch (err) {
        if (options?.onError) {
          options.onError(err);
        } else {
          setStorageErrorState(true);
        }
      }
    },
  };
}

function memoryStorage(): Storage {
  const bag = new Map<string, string>();
  return {
    getItem: (key) => bag.get(key) ?? null,
    setItem: (key, value) => void bag.set(key, value),
    removeItem: (key) => void bag.delete(key),
    clear: () => bag.clear(),
    key: (index) => [...bag.keys()][index] ?? null,
    get length() {
      return bag.size;
    },
  };
}

function fresh(): CqaData {
  const version = officialVersion();
  return {
    versions: [version],
    activeVersionId: version.id,
    conversations: buildDemo(),
    evaluations: [],
    appeals: [],
    decisions: [],
    jobs: [],
    role: "analyst",
    importNote: "Демонстрационный режим: 14 учебных диалогов. Это не официальные 65 DEV.",
    storageError: false,
  };
}

export function materialize(
  evaluation: Evaluation,
  version: ChecklistVersion,
  appeals: Appeal[],
  decisions: ReviewDecision[],
): Evaluation {
  const answers: Record<string, Answer> = {};
  for (const result of evaluation.baseResults) answers[result.criterionId] = result.answer;
  const relatedAppeals = appeals.filter((appeal) => appeal.evaluationId === evaluation.id);
  const related = decisions
    .filter((decision) => relatedAppeals.some((appeal) => appeal.id === decision.appealId))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const reasonOverride = new Map<string, string>();
  for (const decision of related) {
    if (decision.action !== "overridden") continue;
    const appeal = relatedAppeals.find((item) => item.id === decision.appealId);
    if (!appeal) continue;
    const criterion = version.criteria.find((item) => item.id === appeal.criterionId);
    if (!criterion || !answerAllowed(criterion, decision.newAnswer)) continue;
    answers[appeal.criterionId] = decision.newAnswer;
    reasonOverride.set(appeal.criterionId, decision.reason);
  }
  const outcome = computeScore(version.criteria, answers);
  const finalResults = evaluation.baseResults.map((result) => {
    const line = outcome.lines.find((item) => item.criterionId === result.criterionId);
    const answer = answers[result.criterionId] ?? result.answer;
    return {
      ...result,
      answer,
      reason: reasonOverride.get(result.criterionId) ?? result.reason,
      isNa: answer === "na",
      critical: line?.critical ?? false,
      normalized: line?.normalized ?? null,
      contribution: line?.contribution ?? null,
      weight: line?.weight ?? result.weight,
      naReason: answer === "na" ? (reasonOverride.get(result.criterionId) ?? result.naReason) : null,
      validationStatus: result.validationStatus,
      evidenceError: result.evidenceError,
      judgeNote: result.judgeNote,
    };
  });
  return {
    ...evaluation,
    finalResults,
    finalTotal: outcome.status === "ok" ? outcome.total : outcome.status === "not_scorable" ? null : evaluation.finalTotal,
    finalRaw: outcome.raw,
    finalCritical: outcome.critical,
    status:
      outcome.status === "not_scorable"
        ? "not_scorable"
        : outcome.status === "invalid"
          ? "failed"
          : evaluation.status,
  };
}

function fromDrafts(
  conversation: Conversation,
  version: ChecklistVersion,
  drafts: DraftAnswer[],
  source: Evaluation["source"],
  model: string,
  promptVersion: string,
): Evaluation {
  const assembled = assemble(version.criteria, conversation.messages, drafts);
  const now = new Date().toISOString();
  return {
    id: uid("ev"),
    conversationId: conversation.id,
    checklistVersionId: version.id,
    configHash: version.configHash,
    model,
    promptVersion,
    source,
    status: assembled.status,
    startedAt: now,
    createdAt: now,
    baseResults: assembled.results,
    finalResults: assembled.results,
    baseTotal: assembled.outcome.total,
    finalTotal: assembled.outcome.total,
    baseRaw: assembled.outcome.raw,
    finalRaw: assembled.outcome.raw,
    baseCritical: assembled.outcome.critical,
    finalCritical: assembled.outcome.critical,
    usage: null,
    error: assembled.status === "failed" ? assembled.errors[0] : undefined,
    trace: [
      source === "heuristic" ? "Локальная эвристика, без вызова модели" : "Ручная разметка, без вызова модели",
      ...assembled.errors.slice(0, 8),
    ],
  };
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    if (!item?.id || map.has(item.id)) continue;
    map.set(item.id, item);
  }
  return [...map.values()];
}

function normalizeEvaluation(evaluation: Evaluation): Evaluation {
  const source = evaluation.source as string;
  const mapped: Evaluation["source"] =
    source === "ai" || source === "grok"
      ? "ai"
      : source === "heuristic" || source === "rules"
        ? "heuristic"
        : source === "demo"
          ? "demo"
          : "manual";
  return { ...evaluation, source: mapped, startedAt: evaluation.startedAt || evaluation.createdAt };
}

function normalizeJob(job: BatchJob): BatchJob {
  const mode = job.mode === "ai" || (job.mode as string) === "grok" ? "ai" : "heuristic";
  return { ...job, mode, needsReview: job.needsReview ?? 0, items: job.items ?? [] };
}

export const useCqa = create<CqaState>()(
  persist(
    (set, get) => ({
      ...fresh(),
      setRole: (role) => set({ role }),
      setActiveVersion: (id) => {
        if (get().versions.some((version) => version.id === id)) set({ activeVersionId: id });
      },
      importDemo: () => get().importConversations(buildDemo(), "Демонстрационный набор, не API организаторов").added,
      importControl: () =>
        get().importConversations(
          controlConversations(),
          `Локальный учебный набор из ${controlConversations().length} диалогов, не официальный контроль`,
        ).added,
      importConversations: (incoming, note) => {
        let added = 0;
        set((state) => {
          const keys = new Set(state.conversations.map((item) => `${item.datasetGroupId}::${item.externalId}`));
          const add = incoming.filter((item) => {
            const key = `${item.datasetGroupId}::${item.externalId}`;
            if (keys.has(key)) return false;
            keys.add(key);
            return true;
          });
          added = add.length;
          return {
            conversations: [...add, ...state.conversations],
            importNote: note
              ? `${note}: ${add.length ? `добавлено ${add.length}` : "дубли пропущены"}`
              : state.importNote,
          };
        });
        return { added, note: get().importNote };
      },
      saveVersion: (criteria) => {
        const errors = validateChecklist(criteria);
        if (errors.length) return errors;
        const hash = hashConfig(criteria);
        set((state) => {
          const versionNumber = Math.max(...state.versions.map((version) => version.versionNumber), 0) + 1;
          const version: ChecklistVersion = {
            id: `checklist-v${versionNumber}-${hash.slice(0, 6)}`,
            name: "Чек-лист чатов",
            versionNumber,
            label: `Версия ${versionNumber}`,
            createdAt: new Date().toISOString(),
            official: false,
            rounding: "HALF_UP",
            criteria,
            configHash: hash,
          };
          return { versions: [...state.versions, version], activeVersionId: version.id };
        });
        return [];
      },
      evaluateRules: (conversationId, versionId) => {
        const state = get();
        const conversation = state.conversations.find((item) => item.id === conversationId);
        const version = state.versions.find((item) => item.id === (versionId ?? state.activeVersionId));
        if (!conversation || !version) return null;
        const evaluation = fromDrafts(
          conversation,
          version,
          rulesDrafts(version.criteria, conversation),
          "heuristic",
          "rules-heuristic-v1",
          "rules-v1",
        );
        set((current) => ({ evaluations: [evaluation, ...current.evaluations] }));
        return evaluation.id;
      },
      evaluateManual: (conversationId, drafts) => {
        const state = get();
        const conversation = state.conversations.find((item) => item.id === conversationId);
        const version = state.versions.find((item) => item.id === state.activeVersionId);
        if (!conversation || !version) return null;
        const evaluation = fromDrafts(conversation, version, drafts, "manual", "manual", "manual-v1");
        set((current) => ({ evaluations: [evaluation, ...current.evaluations] }));
        return evaluation.id;
      },
      saveModelEvaluation: (binding, payload) => {
        const conversation = get().conversations.find((item) => item.id === binding.conversationId);
        if (!conversation || !binding.checklistVersionId || !binding.configHash || !binding.startedAt) return null;
        const evaluation: Evaluation = {
          id: uid("ev"),
          conversationId: binding.conversationId,
          checklistVersionId: binding.checklistVersionId,
          configHash: binding.configHash,
          model: payload.model || binding.modelId,
          promptVersion: payload.promptVersion || binding.promptVersion,
          startedAt: binding.startedAt,
          source: "ai",
          status: payload.status,
          createdAt: new Date().toISOString(),
          baseResults: payload.results,
          finalResults: payload.results,
          baseTotal: payload.total,
          finalTotal: payload.total,
          baseRaw: payload.raw,
          finalRaw: payload.raw,
          baseCritical: payload.critical,
          finalCritical: payload.critical,
          usage: payload.usage,
          error: payload.error,
          trace: payload.trace,
        };
        set((current) => ({ evaluations: [evaluation, ...current.evaluations] }));
        return evaluation.id;
      },
      submitAppeal: (evaluationId, criterionId, comment) => {
        if (comment.trim().length < 4) return "Комментарий слишком короткий";
        const appeal: Appeal = {
          id: uid("ap"),
          evaluationId,
          criterionId,
          comment: comment.trim(),
          status: "submitted",
          createdAt: new Date().toISOString(),
        };
        set((state) => ({ appeals: [appeal, ...state.appeals] }));
        return null;
      },
      decideAppeal: (appealId, action, reason, newAnswer) => {
        if (reason.trim().length < 4) return "Укажите причину решения";
        const state = get();
        const appeal = state.appeals.find((item) => item.id === appealId);
        if (!appeal) return "Апелляция не найдена";
        if (appeal.status !== "submitted") return "Решение уже сохранено";
        const evaluation = state.evaluations.find((item) => item.id === appeal.evaluationId);
        const version = state.versions.find((item) => item.id === evaluation?.checklistVersionId);
        if (!evaluation || !version) return "Оценка не найдена";
        const current = evaluation.finalResults.find((item) => item.criterionId === appeal.criterionId);
        if (!current) return "Критерий не входит в эту оценку";
        const next = action === "confirmed" ? current.answer : newAnswer;
        if (next === undefined) return "Выберите новый ответ";
        const criterion = version.criteria.find((item) => item.id === appeal.criterionId);
        if (!criterion || !answerAllowed(criterion, next)) return "Ответ вне допустимой шкалы";
        const decision: ReviewDecision = {
          id: uid("rd"),
          appealId,
          action,
          oldAnswer: current.answer,
          newAnswer: next,
          reason: reason.trim(),
          createdAt: new Date().toISOString(),
        };
        set((currentState) => {
          const appeals = currentState.appeals.map((item) =>
            item.id === appealId ? { ...item, status: action } : item,
          );
          const decisions = [...currentState.decisions, decision];
          const evaluations = currentState.evaluations.map((item) => {
            if (item.id !== evaluation.id) return item;
            const bound = currentState.versions.find((entry) => entry.id === item.checklistVersionId);
            return bound ? materialize(item, bound, appeals, decisions) : item;
          });
          return { appeals, decisions, evaluations };
        });
        return null;
      },
      startJob: (mode, total) => {
        const job: BatchJob = {
          id: uid("job"),
          mode,
          status: "running",
          total,
          completed: 0,
          failed: 0,
          needsReview: 0,
          errors: [],
          items: [],
          createdAt: new Date().toISOString(),
        };
        set((state) => ({ jobs: [job, ...state.jobs].slice(0, 8) }));
        return job.id;
      },
      patchJob: (id, patch) =>
        set((state) => ({
          jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)),
        })),
      exportSnapshot: () => {
        const state = get();
        return JSON.stringify({
          versions: state.versions,
          activeVersionId: state.activeVersionId,
          conversations: state.conversations,
          evaluations: state.evaluations,
          appeals: state.appeals,
          decisions: state.decisions,
          importNote: state.importNote,
        });
      },
      importSnapshot: (raw) => {
        let parsed: Partial<CqaData>;
        try {
          parsed = JSON.parse(raw) as Partial<CqaData>;
        } catch {
          return "Файл архива не JSON";
        }
        if (!parsed || typeof parsed !== "object") return "Пустой архив";
        set((state) => {
          const versions = mergeById(state.versions, parsed.versions ?? []);
          const conversations = mergeById(state.conversations, parsed.conversations ?? []);
          const evaluations = mergeById(state.evaluations, (parsed.evaluations ?? []).map(normalizeEvaluation));
          const appeals = mergeById(state.appeals, parsed.appeals ?? []);
          const decisions = mergeById(state.decisions, parsed.decisions ?? []);
          const activeVersionId = versions.some((item) => item.id === state.activeVersionId)
            ? state.activeVersionId
            : (versions[0]?.id ?? state.activeVersionId);
          return { versions, conversations, evaluations, appeals, decisions, activeVersionId };
        });
        return null;
      },
      resetLocal: () => set({ ...fresh(), conversations: buildDemo(), importNote: "Данные сброшены. Загружен демонстрационный набор, не официальный DEV." }),
      clearStorageError: () => {
        isSyncingStorage = true;
        try {
          set({ storageError: false });
        } finally {
          isSyncingStorage = false;
        }
      },
      deleteDatasetGroup: (groupId: string): DeleteDatasetGroupResult => {
        const state = get();
        const targetConvIds = new Set(
          state.conversations.filter((c) => c.datasetGroupId === groupId).map((c) => c.id),
        );
        if (targetConvIds.size === 0) {
          return {
            conversations: 0,
            evaluations: 0,
            appeals: 0,
            decisions: 0,
            conversationsCount: 0,
            evaluationsCount: 0,
            appealsCount: 0,
            decisionsCount: 0,
          };
        }
        const targetEvalIds = new Set(
          state.evaluations.filter((e) => targetConvIds.has(e.conversationId)).map((e) => e.id),
        );
        const targetAppealIds = new Set(
          state.appeals.filter((a) => targetEvalIds.has(a.evaluationId)).map((a) => a.id),
        );
        const targetDecisionIds = new Set(
          state.decisions.filter((d) => targetAppealIds.has(d.appealId)).map((d) => d.id),
        );

        const result: DeleteDatasetGroupResult = {
          conversations: targetConvIds.size,
          evaluations: targetEvalIds.size,
          appeals: targetAppealIds.size,
          decisions: targetDecisionIds.size,
          conversationsCount: targetConvIds.size,
          evaluationsCount: targetEvalIds.size,
          appealsCount: targetAppealIds.size,
          decisionsCount: targetDecisionIds.size,
        };

        set((current) => ({
          conversations: current.conversations.filter((c) => !targetConvIds.has(c.id)),
          evaluations: current.evaluations.filter((e) => !targetEvalIds.has(e.id)),
          appeals: current.appeals.filter((a) => !targetAppealIds.has(a.id)),
          decisions: current.decisions.filter((d) => !targetDecisionIds.has(d.id)),
          jobs: current.jobs.map((j) => ({
            ...j,
            items: j.items.filter((item) => !targetConvIds.has(item.conversationId)),
            errors: j.errors.filter((err) => !targetConvIds.has(err.conversationId)),
          })),
        }));

        return result;
      },
    }),
    {
      name: "cqa-freedom-v1",
      skipHydration: true,
      storage: createSafeStorage(() => (typeof window === "undefined" ? memoryStorage() : localStorage)),
      partialize: (state) => ({
        versions: state.versions,
        activeVersionId: state.activeVersionId,
        conversations: state.conversations,
        evaluations: state.evaluations,
        appeals: state.appeals,
        decisions: state.decisions,
        jobs: state.jobs.filter((job) => job.status !== "running"),
        role: state.role,
        importNote: state.importNote,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<CqaData>;
        const currentOfficial = current.versions.find((v) => v.official) ?? officialVersion();
        const savedVersions = saved.versions ?? [];
        let versions: ChecklistVersion[];
        const archiveMap = new Map<string, string>();

        if (!savedVersions.length) {
          versions = current.versions;
        } else {
          const hasMatchingOfficial = savedVersions.some(
            (v) => v.configHash === currentOfficial.configHash,
          );
          if (hasMatchingOfficial) {
            versions = savedVersions;
          } else {
            const preserved = savedVersions.map((v) => {
              if (v.id === currentOfficial.id && v.configHash !== currentOfficial.configHash) {
                const archiveId = `${v.id}-${v.configHash.slice(0, 6)}`;
                archiveMap.set(`${v.id}::${v.configHash}`, archiveId);
                return {
                  ...v,
                  id: archiveId,
                  official: false,
                  label: `${v.label} (архив ${v.configHash.slice(0, 6)})`,
                };
              }
              return v;
            });
            versions = [currentOfficial, ...preserved];
          }
        }

        const evaluations = (saved.evaluations ?? []).map((raw) => {
          const norm = normalizeEvaluation(raw);
          const key = `${norm.checklistVersionId}::${norm.configHash}`;
          if (archiveMap.has(key)) {
            return { ...norm, checklistVersionId: archiveMap.get(key)! };
          }
          return norm;
        });

        const jobs = (saved.jobs ?? []).map((raw) => {
          const norm = normalizeJob(raw) as BatchJob & { checklistVersionId?: string; configHash?: string };
          if (norm.checklistVersionId && norm.configHash) {
            const key = `${norm.checklistVersionId}::${norm.configHash}`;
            if (archiveMap.has(key)) {
              return { ...norm, checklistVersionId: archiveMap.get(key)! };
            }
          }
          return norm;
        });

        let activeVersionId = currentOfficial.id;
        if (saved.activeVersionId) {
          if (saved.activeVersionId === currentOfficial.id) {
            activeVersionId = currentOfficial.id;
          } else if (versions.some((v) => v.id === saved.activeVersionId)) {
            activeVersionId = saved.activeVersionId;
          }
        }

        return {
          ...current,
          ...saved,
          versions,
          activeVersionId,
          conversations: saved.conversations?.length ? saved.conversations : current.conversations,
          evaluations,
          appeals: saved.appeals ?? [],
          decisions: saved.decisions ?? [],
          jobs,
        };
      },
    },
  ),
);

storeApi = useCqa;

export interface BatchTargetQuery {
  conversationIds: string[];
  evaluations: Pick<Evaluation, "conversationId" | "checklistVersionId" | "configHash" | "source" | "model" | "promptVersion" | "status" | "createdAt">[];
  versionId: string;
  configHash: string;
  mode: "heuristic" | "ai";
  modelId: string;
  promptVersion: string;
  onlyFailed: boolean;
  /** Conversation ids that failed in the latest AI job before an evaluation was stored. */
  failedJobIds?: string[];
}

function sameBatchRun(item: BatchTargetQuery["evaluations"][number], query: BatchTargetQuery): boolean {
  if (item.checklistVersionId !== query.versionId || item.configHash !== query.configHash) return false;
  if (query.mode === "ai") return item.source === "ai" && item.model === query.modelId && item.promptVersion === query.promptVersion;
  return item.source === "heuristic";
}

export function selectBatchTargets(query: BatchTargetQuery): string[] {
  return query.conversationIds.filter((conversationId) => {
    const latest = query.evaluations
      .filter((item) => item.conversationId === conversationId && sameBatchRun(item, query))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (query.onlyFailed) {
      if (latest && latest.status !== "failed") return false;
      if (latest?.status === "failed") return true;
      return query.mode === "ai" && (query.failedJobIds ?? []).includes(conversationId);
    }
    return !latest || latest.status === "failed";
  });
}
export function latestEvaluation(
  evaluations: Evaluation[],
  conversationId: string,
  versionId?: string,
): Evaluation | undefined {
  return evaluations
    .filter((item) => item.conversationId === conversationId && (!versionId || item.checklistVersionId === versionId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export interface ConversationFilterOptions {
  language?: string;
  channel?: string;
  group?: string;
}

export function filterConversations(
  conversations: Conversation[],
  options?: ConversationFilterOptions,
): Conversation[] {
  if (!options) return conversations;
  const { language = "all", channel = "all", group = "all" } = options;
  return conversations.filter((item) => {
    if (language !== "all" && item.language.toLowerCase() !== language.toLowerCase()) {
      return false;
    }
    if (channel !== "all" && item.channel.toLowerCase() !== channel.toLowerCase()) {
      return false;
    }
    if (group !== "all" && item.datasetGroupId.toLowerCase() !== group.toLowerCase()) {
      return false;
    }
    return true;
  });
}

