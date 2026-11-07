import { useCqa } from "@/lib/cqa/store";
import { formatAnswer } from "@/lib/cqa/score";
import { Button, formatTotal } from "./ui";

export function AppealsView({ onOpen }: { onOpen: (conversationId: string) => void }) {
  const appeals = useCqa((state) => state.appeals);
  const decisions = useCqa((state) => state.decisions);
  const evaluations = useCqa((state) => state.evaluations);
  const conversations = useCqa((state) => state.conversations);
  const role = useCqa((state) => state.role);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-6 text-muted">
        Очередь возражений. Решение принимает роль «Проверяющий»: подтверждение оставляет балл, изменение пересчитывает итог по той же формуле, без нового запроса к модели.
        {role !== "reviewer" ? " Сейчас решение скрыто — переключите роль." : ""}
      </p>
      {!appeals.length ? <p className="text-sm text-ink">Апелляций пока нет.</p> : null}
      <ul className="flex flex-col gap-2">
        {appeals.map((appeal) => {
          const evaluation = evaluations.find((item) => item.id === appeal.evaluationId);
          const conversation = conversations.find((item) => item.id === evaluation?.conversationId);
          const result = evaluation?.finalResults.find((item) => item.criterionId === appeal.criterionId);
          const decision = decisions.find((item) => item.appealId === appeal.id);
          return (
            <li key={appeal.id} className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-sm text-ink">{conversation?.externalId ?? "диалог удалён"}</p>
                  <p className="text-sm text-muted">
                    {appeal.criterionId} · {result ? formatAnswer(result.answer) : "—"} · итог {formatTotal(evaluation?.finalTotal)}
                  </p>
                </div>
                <span className="text-xs font-semibold text-accent">{appeal.status}</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-ink">{appeal.comment}</p>
              {decision ? (
                <p className="mt-2 text-sm text-muted">
                  {formatAnswer(decision.oldAnswer)} → {formatAnswer(decision.newAnswer)}. {decision.reason}
                </p>
              ) : null}
              {conversation ? (
                <Button className="mt-3" variant="ghost" onClick={() => onOpen(conversation.id)}>
                  Открыть карточку
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted">Предыдущие оценки не переписываются: новая проверка создаёт отдельную запись.</p>
    </div>
  );
}
