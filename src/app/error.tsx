"use client";

import { useEffect } from "react";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

/**
 * Root error boundary (App Router convention). Catches unexpected render
 * errors and offers a retry action. Business/API error handling stays in-page.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the error to the console for debugging; no telemetry added.
    console.error(error);
  }, [error]);

  return (
    <PageShell className="p-4 md:p-8">
      <EmptyState
        icon={AlertTriangle}
        title="页面加载出错"
        description="刷新或稍后重试；如问题持续，请联系管理员。"
        action={
          <Button onClick={reset} variant="default">
            重试
          </Button>
        }
      />
    </PageShell>
  );
}
