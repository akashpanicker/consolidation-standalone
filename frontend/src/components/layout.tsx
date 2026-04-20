import type { ReactNode } from "react";
import { useAppStore } from "@/store/app-store";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";

/**
 * Standalone consolidation bundle — only the Consolidation view is wired up.
 * The production Layout has a multi-view nav (Documents / Clustering /
 * Search / Taxonomy); those depend on backend routers that aren't part of
 * this bundle, so the nav is reduced to a single label.
 */
export function Layout({
  sidebar: _sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const { darkMode, toggleDarkMode } = useAppStore();
  const authUser = useAuth();

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <header className="h-12 border-b border-b-primary/20 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2.5">
          <img src={darkMode ? "/hp-logo-dark.svg" : "/hp-logo.svg"} alt="H&P" className="h-5 w-auto" />
          <h1 className="text-lg font-semibold">Consolidation (Standalone)</h1>
        </div>

        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={toggleDarkMode}>
            {darkMode ? "Light" : "Dark"}
          </Button>
          {authUser && (
            <div className="flex items-center gap-2 ml-2 pl-2 border-l border-primary/20">
              <span className="text-xs text-muted-foreground">{authUser.name}</span>
            </div>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
