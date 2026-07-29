"use client";

import { UserPlus } from "lucide-react";
import { Fab } from "@/components/ui/fab";
import { CustomerApplicationFormDialog } from "@/components/crm/customer-application-form-dialog";

/**
 * 移动端悬浮"申请新增客户"按钮。仅在 isMobile 时由调用方渲染。
 * 抽出此组件以消除 /customers 与 /crm/customers 两处 FAB trigger 的重复。
 */
export function CustomerCreateFab() {
  return (
    <CustomerApplicationFormDialog
      trigger={
        <Fab aria-label="申请新增客户">
          <UserPlus className="h-6 w-6" />
        </Fab>
      }
    />
  );
}
