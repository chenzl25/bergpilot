import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router";

import { ApiError, consumeTokenFromUrl } from "./api/client";
import { Layout } from "./components/Layout";
import { CatalogFormPage } from "./pages/CatalogForm";
import { HomePage } from "./pages/Home";
import { NotFoundPage } from "./pages/NotFound";
import { SqlPage } from "./pages/SqlPage";
import { TablePage } from "./pages/TablePage";
import "./styles.css";

consumeTokenFromUrl();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Client errors (bad input, missing table, auth) will not fix themselves.
      retry: (count, error) =>
        !(error instanceof ApiError && error.status < 500) && count < 1,
    },
  },
});

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/catalogs/new", element: <CatalogFormPage /> },
      { path: "/catalogs/:id/edit", element: <CatalogFormPage /> },
      { path: "/catalogs/:id/tables/*", element: <TablePage /> },
      { path: "/sql", element: <SqlPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
