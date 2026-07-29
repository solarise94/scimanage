"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectDetailView } from "@/components/projects/project-detail-view";

/**
 * Standalone project detail page — thin shell.
 *
 * All data loading, mutations, dialogs and inline Tabs live in
 * {@link ProjectDetailView}, which is shared with the embedded Agent workspace
 * resource view (`ProjectResourceView`).
 *
 * The shell reads the optional `?tab=` search param to seed the initial tab
 * and passes it through as `initialTab`. `useSearchParams` requires a Suspense
 * boundary, so we wrap the inner content in one (matching the repo convention,
 * e.g. `src/app/costing/rules/page.tsx`).
 */
export default function ProjectDetailPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32" />
        </PageShell>
      }
    >
      <ProjectDetailPageContent />
    </Suspense>
  );
}

function ProjectDetailPageContent() {
  const { id } = useParams();
  const searchParams = useSearchParams();
  const projectId = id as string;
  const initialTab = searchParams.get("tab") || "timeline";
  return <ProjectDetailView projectId={projectId} mode="page" initialTab={initialTab} />;
}
