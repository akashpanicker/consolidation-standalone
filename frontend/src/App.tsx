import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAppStore } from "@/store/app-store";
import { AuthGate } from "@/auth/AuthGate";
import { Layout } from "@/components/layout";
import { ConsolidationPage } from "@/components/consolidation/consolidation-page";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
});

export default function App() {
  const darkMode = useAppStore((s) => s.darkMode);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  return (
    <AuthGate>
      <QueryClientProvider client={queryClient}>
        <Layout sidebar={null}>
          <ConsolidationPage />
        </Layout>
      </QueryClientProvider>
    </AuthGate>
  );
}
