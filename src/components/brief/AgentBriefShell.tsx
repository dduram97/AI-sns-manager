export function AgentBriefShell({ children }: { children?: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-28 pt-6">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Supervisor Console
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
        <p className="text-sm text-muted-foreground">
          오늘 할 일과 이번 주 활동을 한눈에 확인합니다.
        </p>
      </header>
      {children}
    </div>
  );
}
