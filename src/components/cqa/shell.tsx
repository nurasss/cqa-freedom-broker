import { useEffect, useState } from "react";
import { AlertTriangle, ClipboardCheck, ListChecks, MessagesSquare, Scale } from "lucide-react";
import { useCqa } from "@/lib/cqa/store";
import type { Role } from "@/lib/cqa/types";
import { AppealsView } from "./appeals";
import { CardView } from "./card";
import { ChecklistView } from "./checklist";
import { DialogsView } from "./dialogs";
import { cx } from "./ui";

type View = "dialogs" | "card" | "appeals" | "checklist";

const roles: { id: Role; label: string }[] = [
  { id: "analyst", label: "Аналитик" },
  { id: "reviewer", label: "Проверяющий" },
  { id: "editor", label: "Настройщик" },
];

export function Shell() {
  const [view, setView] = useState<View>("dialogs");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [evaluationId, setEvaluationId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const role = useCqa((state) => state.role);
  const setRole = useCqa((state) => state.setRole);
  const importDemo = useCqa((state) => state.importDemo);
  const storageError = useCqa((state) => state.storageError);
  const clearStorageError = useCqa((state) => state.clearStorageError);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      await useCqa.persist.rehydrate();
      if (cancel) return;
      if (useCqa.getState().conversations.length === 0) importDemo();
      setReady(true);
    })();
    return () => {
      cancel = true;
    };
  }, [importDemo]);

  function open(id: string, evalId?: string) {
    setConversationId(id);
    setEvaluationId(evalId ?? null);
    setView("card");
  }

  const nav = [
    { id: "dialogs" as const, label: "Диалоги", icon: MessagesSquare },
    { id: "appeals" as const, label: "Апелляции", icon: Scale },
    { id: "checklist" as const, label: "Чек-лист", icon: ListChecks },
  ];

  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-line bg-ink px-4 text-on-ink">
        <div className="min-w-0">
          <p className="text-xs tracking-widest uppercase opacity-70">Freedom Broker</p>
          <h1 className="truncate text-lg font-semibold">CQA · качество диалогов</h1>
        </div>
        <label className="text-xs">
          <span className="sr-only">Роль</span>
          <select
            className="h-11 rounded-xl bg-surface px-2 text-sm font-semibold text-ink"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            {roles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </header>
      {storageError ? (
        <aside
          role="alert"
          aria-live="assertive"
          className="sticky top-16 z-20 border-b border-critical bg-critical-soft px-4 py-3 text-sm text-critical shadow-sm"
        >
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-5 shrink-0" />
              <span>
                Хранилище браузера переполнено — последние изменения не сохранены. Сделайте «Экспорт JSON» и удалите старые наборы.
              </span>
            </div>
            <button
              type="button"
              className="shrink-0 text-xs font-semibold underline hover:no-underline"
              onClick={clearStorageError}
            >
              Закрыть
            </button>
          </div>
        </aside>
      ) : null}
      <div className="mx-auto grid w-full max-w-6xl lg:grid-cols-[220px_1fr]">
        <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface lg:static lg:flex-col lg:border-t-0 lg:border-r lg:pt-4">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = view === item.id || (item.id === "dialogs" && view === "card");
            return (
              <button
                key={item.id}
                className={cx(
                  "flex h-16 flex-1 flex-col items-center justify-center gap-1 text-xs font-semibold lg:h-12 lg:flex-row lg:justify-start lg:px-4 lg:text-sm",
                  active ? "text-accent" : "text-muted",
                )}
                onClick={() => setView(item.id)}
              >
                <Icon className="size-5" />
                {item.label}
              </button>
            );
          })}
        </nav>
        <main className="px-4 pt-4 pb-24 lg:pb-10">
          {!ready ? (
            <p className="text-sm text-muted">Открываю рабочее место и демо-диалоги…</p>
          ) : view === "card" && conversationId ? (
            <CardView
              conversationId={conversationId}
              evaluationId={evaluationId ?? undefined}
              onBack={() => {
                setView("dialogs");
                setEvaluationId(null);
              }}
            />
          ) : view === "appeals" ? (
            <AppealsView onOpen={open} />
          ) : view === "checklist" ? (
            <ChecklistView />
          ) : (
            <DialogsView onOpen={open} />
          )}
          <p className="mt-8 flex items-center gap-2 text-xs text-muted">
            <ClipboardCheck className="size-4" />
            Официальные веса C01–C07 = 100. C08 — флаг без вычета.
          </p>
        </main>
      </div>
    </div>
  );
}
