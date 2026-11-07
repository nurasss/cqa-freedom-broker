export type Answer = "yes" | "no" | "na" | number;

export type AnswerType = "yes_no" | "yes_no_na" | "scale" | "flag";

export type SectionId = "opening" | "safety_resolution" | "dialogue" | "critical" | "custom";

export interface Criterion {
  id: string;
  title: string;
  section: SectionId;
  weight: number;
  answerType: AnswerType;
  naAllowed: boolean;
  scale?: { steps: number[]; max: number };
  rubric: string;
  evidenceSpeakers?: ("operator" | "system" | "bot")[];
}

export interface ChecklistVersion {
  id: string;
  name: string;
  versionNumber: number;
  label: string;
  createdAt: string;
  official: boolean;
  rounding: "HALF_UP";
  criteria: Criterion[];
  configHash: string;
}

export interface TranscriptMessage {
  messageIndex: number;
  timestampRaw: string;
  speaker: string;
  text: string;
}

export interface Conversation {
  id: string;
  datasetGroupId: string;
  externalId: string;
  channel: string;
  language: string;
  audioUrl: string | null;
  messages: TranscriptMessage[];
  origin?: "demo" | "organizer" | "upload" | "study" | "control";
}

export type ValidationStatus = "ok" | "invalid_evidence" | "invalid_answer";

export interface CriterionResult {
  criterionId: string;
  answer: Answer;
  reason: string;
  evidence: { messageIndex: number; quote: string; speaker?: string; timestampRaw?: string }[];
  checkedRange: { from: number; to: number } | null;
  naReason: string | null;
  validationStatus: ValidationStatus;
  weight: number;
  normalized: number | null;
  contribution: number | null;
  isNa: boolean;
  critical: boolean;
  evidenceError?: string;
  judgeNote?: string;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  calls: number;
  reasoningTokens?: number;
  costSource?: "provider" | "estimate";
}

export type EvalSource = "ai" | "heuristic" | "manual" | "demo";

export type EvalStatus = "completed" | "needs_review" | "failed" | "not_scorable";

export function evalStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  switch (status) {
    case "completed":
      return "принято";
    case "needs_review":
      return "на проверке";
    case "failed":
      return "ошибка";
    case "not_scorable":
      return "не рассчитывается";
    default:
      return status;
  }
}

export function evalStatusTooltip(status: string | null | undefined): string | undefined {
  if (!status) return undefined;
  switch (status) {
    case "completed":
      return "принято";
    case "needs_review":
      return "на проверке: судья или проверка цитат не подтвердили часть ответов";
    case "failed":
      return "ошибка";
    case "not_scorable":
      return "не рассчитывается";
    default:
      return undefined;
  }
}

export interface Evaluation {
  id: string;
  conversationId: string;
  checklistVersionId: string;
  configHash: string;
  model: string;
  promptVersion: string;
  startedAt: string;
  source: EvalSource;
  status: EvalStatus;
  createdAt: string;
  baseResults: CriterionResult[];
  finalResults: CriterionResult[];
  baseTotal: number | null;
  finalTotal: number | null;
  baseRaw: number | null;
  finalRaw: number | null;
  baseCritical: boolean;
  finalCritical: boolean;
  usage: UsageInfo | null;
  error?: string;
  trace: string[];
}

export interface Appeal {
  id: string;
  evaluationId: string;
  criterionId: string;
  comment: string;
  status: "submitted" | "confirmed" | "overridden";
  createdAt: string;
}

export interface ReviewDecision {
  id: string;
  appealId: string;
  action: "confirmed" | "overridden";
  oldAnswer: Answer;
  newAnswer: Answer;
  reason: string;
  createdAt: string;
}

export type Role = "analyst" | "reviewer" | "editor";

export type BatchItemStatus = "pending" | "running" | "completed" | "failed" | "needs_review";

export interface BatchJob {
  id: string;
  mode: "heuristic" | "ai";
  status: "running" | "completed" | "partial" | "failed" | "cancelled";
  total: number;
  completed: number;
  failed: number;
  needsReview: number;
  errors: { conversationId: string; message: string }[];
  items: { conversationId: string; status: BatchItemStatus; attempts: number; message?: string }[];
  createdAt: string;
}

export const SECTION_LABEL: Record<SectionId, string> = {
  opening: "Начало и понимание запроса",
  safety_resolution: "Безопасность и решение",
  dialogue: "Ведение и завершение диалога",
  critical: "Грубые нарушения",
  custom: "Дополнительно",
};

export const PROMPT_VERSION = "cqa-s5-v5";
export const MODEL_ID = "grok-4.7";
export const INPUT_USD_PER_M = 2;
export const OUTPUT_USD_PER_M = 6;
