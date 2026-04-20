import type { ReactNode } from "react";
import { AppHeader } from "./shared/AppHeader";

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
  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <AppHeader breadcrumb={[{ label: "Home", path: "/" }, { label: "Consolidation" }]} />

      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
