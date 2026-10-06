import { FileQuestion } from "lucide-react";
import { Link } from "react-router";

import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

export function NotFoundPage() {
  return (
    <Page className="min-h-[70svh] justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestion />
          </EmptyMedia>
          <EmptyTitle>Page not found</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" asChild>
            <Link to="/">Back to catalogs</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </Page>
  );
}
