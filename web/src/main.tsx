import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router";

import { ApiError, consumeTokenFromUrl } from "@/api/client";
import { ConfirmProvider } from "@/components/confirm";
import { Layout } from "@/components/Layout";
import { ThemeProvider } from "@/components/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CatalogFormPage } from "@/pages/CatalogForm";
import { CatalogPage } from "@/pages/CatalogPage";
import { HomePage } from "@/pages/Home";
import { JobsPage } from "@/pages/JobsPage";
import { NamespacePage } from "@/pages/NamespacePage";
import { NotFoundPage } from "@/pages/NotFound";
import { Loading, Page } from "@/components/page";
import { TablePage } from "@/pages/TablePage";
import "./index.css";

// The SQL editor (CodeMirror) is the largest dependency; load it with its page.
const SqlPage = lazy(() => import("@/pages/SqlPage").then((module) => ({ default: module.SqlPage })));

consumeTokenFromUrl();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Client errors (bad input, missing table, auth) will not fix themselves.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
    },
  },
});

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/catalogs/new", element: <CatalogFormPage /> },
      { path: "/catalogs/:id", element: <CatalogPage /> },
      { path: "/catalogs/:id/edit", element: <CatalogFormPage /> },
      { path: "/catalogs/:id/namespaces/*", element: <NamespacePage /> },
      { path: "/catalogs/:id/tables/*", element: <TablePage /> },
      {
        path: "/sql",
        element: (
          <Suspense
            fallback={
              <Page>
                <Loading label="Loading the editor…" />
              </Page>
            }
          >
            <SqlPage />
          </Suspense>
        ),
      },
      { path: "/jobs", element: <JobsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <ConfirmProvider>
            <RouterProvider router={router} />
            <Toaster position="bottom-right" closeButton />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
