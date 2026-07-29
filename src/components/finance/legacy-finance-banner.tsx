import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface LegacyFinanceBannerProps {
  message?: string;
  className?: string;
}

export function LegacyFinanceBanner({
  message = "项目发票已停用新建和编辑。新开票、回款、成本请从订单详情页操作。",
  className,
}: LegacyFinanceBannerProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground",
        className
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground/70" />
      <div>
        <span className="font-medium">历史只读：</span>
        {message}
      </div>
    </div>
  );
}
