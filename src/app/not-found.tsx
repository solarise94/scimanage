import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Compass } from "lucide-react";

/**
 * Root 404 (App Router convention). Offers a return-to-dashboard action.
 */
export default function NotFound() {
  return (
    <PageShell className="p-4 md:p-8">
      <EmptyState
        icon={Compass}
        title="页面不存在"
        description="该地址可能已被移除或链接有误。"
        action={
          <Button render={<Link href="/dashboard" />}>返回工作台</Button>
        }
      />
    </PageShell>
  );
}
