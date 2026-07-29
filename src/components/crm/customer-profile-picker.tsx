"use client";

import * as React from "react";
import { useState } from "react";
import { useSession } from "next-auth/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { CustomerSelect } from "@/components/customer-select";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useMediaQuery } from "@/hooks/use-media-query";

interface CustomerProfilePickerProps {
  trigger: React.ReactElement<{ onClick?: React.MouseEventHandler<HTMLElement> }>;
  title: string;
  actionLabel: string;
  /** 第二参为遗留 Customer 锚点；Profile-only 为 null。 */
  onPick: (profileId: string, customerName: string) => void;
}

export function CustomerProfilePicker({ trigger, title, actionLabel, onPick }: CustomerProfilePickerProps) {
  const { data: session } = useSession();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [open, setOpen] = useState(false);
  // CustomerSelect 返回的是 profileId
  const [profileId, setProfileId] = useState("");
  const [customerName, setCustomerName] = useState("");

  // REGIONAL_MANAGER cannot create new profiles (POST /api/crm/profiles rejects them),
  // so restrict the picker to CRM-scoped customers only. REPRESENTATIVE can create
  // profiles for project-linked customers, so they get the default (wider) list.
  const restrictToCrmScope = session?.user?.role === "REGIONAL_MANAGER";

  const resolveMutation = useMutation({
    mutationFn: async () => {
      // CustomerSelect 已给出 profileId；按 Profile 主键读取（含 Profile-only）。
      const res = await fetch(`/api/crm/profiles/${encodeURIComponent(profileId)}`);
      if (!res.ok) throw new Error("查找客户档案失败");
      const data = await res.json();
      const profile = data.profile ?? data;
      if (!profile?.id) throw new Error("客户档案不存在");
      return {
        profileId: profile.id as string,
        customerName: (profile.name as string) || customerName,
      };
    },
    onSuccess: (result) => {
      onPick(result.profileId, result.customerName);
      setOpen(false);
      setProfileId("");
      setCustomerName("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) { setProfileId(""); setCustomerName(""); }
  };

  const content = (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium">选择客户</label>
        <CustomerSelect
          value={profileId}
          displayValue={customerName || undefined}
          onChange={(id, name) => { setProfileId(id || ""); setCustomerName(name || ""); }}
          crmScopeOnly={restrictToCrmScope}
        />
      </div>
      <Button
        className="w-full"
        disabled={!profileId || resolveMutation.isPending}
        onClick={() => resolveMutation.mutate()}
      >
        {resolveMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
        {actionLabel}
      </Button>
    </div>
  );

  const triggerEl = React.cloneElement(trigger, {
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      trigger.props.onClick?.(e);
      setOpen(true);
    },
  });

  if (isMobile) {
    return (
      <>
        {triggerEl}
        <Sheet open={open} onOpenChange={handleOpenChange}>
          <SheetContent side="bottom" className="max-h-[85vh]">
            <SheetHeader>
              <SheetTitle>{title}</SheetTitle>
            </SheetHeader>
            <div className="mt-4">{content}</div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <>
      {triggerEl}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {content}
        </DialogContent>
      </Dialog>
    </>
  );
}
