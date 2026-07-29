"use client";

import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * W5.1：兼容层审计已下线（API 410、审计写入 no-op）。
 * 保留路由以免旧书签 404，页面静态说明、不再请求 API。
 */
export default function CustomerCompatAuditPage() {
  return (
    <PageShell>
      <PageHeader title="兼容层审计" description="已下线" />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">本能力已退役（W5.1）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            `/api/admin/customer-compat-audit` 已返回 410；`CustomerApiAuditLog` 历史行保留，但不再写入与展示。
          </p>
          <p>
            客户主路径请使用 <code className="text-foreground">/api/crm/profiles/[profileId]</code>。
          </p>
        </CardContent>
      </Card>
    </PageShell>
  );
}
