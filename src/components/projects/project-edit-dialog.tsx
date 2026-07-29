"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { DraftInputPanel } from "@/components/draft-input-panel";
import { CustomerSelect } from "@/components/customer-select";
import { OrganizationSelect } from "@/components/organization-select";
import { RepresentativeSelect } from "@/components/representative-select";
import { SourceBrandSelect } from "@/components/source-brand-select";
import { TechSupportSelect } from "@/components/tech-support-select";
import { getProjectTypeLabel } from "@/lib/project-type";
import {
  ProjectEditForm,
  ProjectEditMember,
  ProjectMemberSearchResult,
  STATUS_CONFIG,
} from "@/components/projects/project-detail-shared";

/**
 * 项目编辑 Dialog（含协作者搜索 + 商品信息折叠区）。
 *
 * 纯结构搬迁自 `src/app/projects/[id]/page.tsx`（原行 568-931 内联表单）。
 * 所有受控状态由父组件（page.tsx）持有并通过 props 注入；本组件不持有任何业务状态，
 * 以保持 mutation/权限/校验链路不变。
 */
export interface ProjectEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  editForm: ProjectEditForm;
  onEditFormChange: (next: ProjectEditForm) => void;
  editOrgId: string;
  onEditOrgIdChange: (id: string) => void;
  editCustomerOrgId: string | null;
  onEditCustomerOrgIdChange: (id: string | null) => void;
  onRepTouchedChange: (v: boolean) => void;
  onCustomerTouchedChange: (v: boolean) => void;
  editMembers: ProjectEditMember[];
  onEditMembersChange: (members: ProjectEditMember[]) => void;
  memberSearch: string;
  onMemberSearchChange: (v: string) => void;
  memberSearchResults: ProjectMemberSearchResult[];
  onMemberSearchResultsChange: (results: ProjectMemberSearchResult[]) => void;
  memberSearching: boolean;
  onMemberSearchingChange: (v: boolean) => void;
  channels: { id: string; name: string }[];
  /** 提交时调用（保存项目 + 协作者 + 客户关联单位）。 */
  onSubmit: () => void | Promise<void>;
  isSaving: boolean;
}

export function ProjectEditDialog({
  open,
  onOpenChange,
  projectId,
  editForm,
  onEditFormChange,
  editOrgId,
  onEditOrgIdChange,
  editCustomerOrgId,
  onEditCustomerOrgIdChange,
  onRepTouchedChange,
  onCustomerTouchedChange,
  editMembers,
  onEditMembersChange,
  memberSearch,
  onMemberSearchChange,
  memberSearchResults,
  onMemberSearchResultsChange,
  memberSearching,
  onMemberSearchingChange,
  channels,
  onSubmit,
  isSaving,
}: ProjectEditDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>编辑项目</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit();
          }}
          className="contents"
        >
          <div className="-mx-4 min-h-0 overflow-y-auto overscroll-contain px-4 pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
            <div className="space-y-4">
              <DraftInputPanel
                formKey="project.edit"
                projectId={projectId}
                fieldLabels={{
                  name: "项目名称",
                  description: "描述",
                  organization: "单位",
                  client: "客户",
                  representative: "代表",
                  status: "状态",
                  progress: "进度",
                  projectType: "项目类型",
                  projectContent: "项目内容",
                  quantity: "数量",
                  procurementSource: "采购来源",
                  brand: "品牌",
                  techSupport: "技术支持",
                }}
                onApply={(fields) => {
                  onEditFormChange({ ...editForm, ...fields });
                }}
                fallbackPlugin="project.smart-fill"
              />
              <div className="space-y-2">
                <label className="text-sm font-medium">项目名称</label>
                <Input value={editForm.name || ""} onChange={(e) => onEditFormChange({ ...editForm, name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">描述</label>
                <Textarea value={editForm.description || ""} onChange={(e) => onEditFormChange({ ...editForm, description: e.target.value })} rows={3} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">状态</label>
                  <Select value={editForm.status || "NOT_STARTED"} onValueChange={(v) => onEditFormChange({ ...editForm, status: v || "NOT_STARTED" })}>
                    <SelectTrigger><span>{STATUS_CONFIG[editForm.status || "NOT_STARTED"]?.label || "未开始"}</span></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NOT_STARTED">未开始</SelectItem>
                      <SelectItem value="IN_PROGRESS">进行中</SelectItem>
                      <SelectItem value="COMPLETED">已完成</SelectItem>
                      <SelectItem value="ON_HOLD">暂停</SelectItem>
                      <SelectItem value="TERMINATED">终止</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">进度 ({editForm.progress}%)</label>
                  <Input type="range" min={0} max={100} value={editForm.progress || 0} onChange={(e) => onEditFormChange({ ...editForm, progress: Number(e.target.value) })} />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">项目号</label>
                  <Input value={editForm.projectNo || ""} onChange={(e) => onEditFormChange({ ...editForm, projectNo: e.target.value })} placeholder="PRJ-YYYYMMDD-0001" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">单位</label>
                  <OrganizationSelect
                    value={editOrgId}
                    displayValue={editForm.organization || undefined}
                    disabled={!!editCustomerOrgId}
                    onChange={(id, name) => {
                      onEditOrgIdChange(id || "");
                      onEditFormChange({ ...editForm, organization: name });
                    }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">客户</label>
                  <CustomerSelect
                    value={editForm.profileId || ""}
                    displayValue={editForm.client || ""}
                    onChange={(id, name, org, orgId) => {
                      onEditFormChange({ ...editForm, profileId: id || "", client: name, organization: org || "" });
                      onEditCustomerOrgIdChange(orgId || null);
                      onEditOrgIdChange(orgId || "");
                      onCustomerTouchedChange(true);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">代表</label>
                  <RepresentativeSelect
                    value={editForm.representativeId || ""}
                    displayValue={editForm.representative || ""}
                    onChange={(id, name) => { onEditFormChange({ ...editForm, representativeId: id || "", representative: name }); onRepTouchedChange(true); }}
                  />
                </div>
              </div>
              {/* Collaborator management */}
              <div className="space-y-2">
                <label className="text-sm font-medium">协作者</label>
                {/* Current members */}
                {editMembers.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {editMembers.map((m, i) => (
                      <Badge key={m.userId} variant="secondary" className="gap-1 text-xs">
                        <Select
                          value={m.role}
                          onValueChange={(v) => {
                            const updated = [...editMembers];
                            updated[i] = { ...updated[i], role: v || "MEMBER" };
                            onEditMembersChange(updated);
                          }}
                        >
                          <SelectTrigger className="h-auto border-0 bg-transparent p-0 text-xs shadow-none hover:bg-transparent">
                            {m.role === "OWNER" ? "负责人" : "成员"}
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="OWNER">负责人</SelectItem>
                            <SelectItem value="MEMBER">成员</SelectItem>
                          </SelectContent>
                        </Select>
                        <span className="text-muted-foreground">{m.user.name || m.user.email}</span>
                        <X
                          className="h-3 w-3 cursor-pointer hover:text-destructive"
                          onClick={() => onEditMembersChange(editMembers.filter((_, j) => j !== i))}
                        />
                      </Badge>
                    ))}
                  </div>
                )}
                {/* Search + add */}
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <Input
                      className="h-8 text-xs"
                      placeholder="搜索用户名或邮箱添加..."
                      value={memberSearch}
                      onChange={async (e) => {
                        onMemberSearchChange(e.target.value);
                        if (e.target.value.length < 2) { onMemberSearchResultsChange([]); return; }
                        onMemberSearchingChange(true);
                        try {
                          const res = await fetch(`/api/users?search=${encodeURIComponent(e.target.value)}`);
                          if (res.ok) {
                            const d = await res.json();
                            onMemberSearchResultsChange((d.users || []).filter(
                              (u: { id: string }) => !editMembers.some((m) => m.userId === u.id),
                            ));
                          }
                        } finally { onMemberSearchingChange(false); }
                      }}
                    />
                    {memberSearchResults.length > 0 && (
                      <div className="absolute top-full left-0 right-0 z-50 mt-1 border rounded-md bg-popover shadow-lg max-h-40 overflow-y-auto">
                        {memberSearchResults.map((u) => (
                          <button
                            key={u.id}
                            type="button"
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted flex items-center justify-between"
                            onClick={() => {
                              onEditMembersChange([...editMembers, { userId: u.id, role: "MEMBER", user: { id: u.id, name: u.name, email: u.email } }]);
                              onMemberSearchChange("");
                              onMemberSearchResultsChange([]);
                            }}
                          >
                            <span>{u.name} <span className="text-muted-foreground">{u.email}</span></span>
                            <Badge variant="outline" className="text-[10px]">{u.role}</Badge>
                          </button>
                        ))}
                      </div>
                    )}
                    {memberSearching && <div className="absolute top-full left-0 right-0 z-50 mt-1 border rounded-md bg-popover shadow p-2 text-xs text-muted-foreground">搜索中...</div>}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">开始日期</label>
                  <Input type="date" value={editForm.startDate ? new Date(editForm.startDate).toISOString().split("T")[0] : ""} onChange={(e) => onEditFormChange({ ...editForm, startDate: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">结束日期</label>
                  <Input type="date" value={editForm.endDate ? new Date(editForm.endDate).toISOString().split("T")[0] : ""} onChange={(e) => onEditFormChange({ ...editForm, endDate: e.target.value })} />
                </div>
              </div>
              <details className="border rounded-lg p-3 space-y-3">
                <summary className="text-sm font-medium cursor-pointer select-none text-muted-foreground">商品信息</summary>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">项目类型</label>
                    <Select value={editForm.projectType || ""} onValueChange={(v) => onEditFormChange({ ...editForm, projectType: v })}>
                      <SelectTrigger><span>{getProjectTypeLabel(editForm.projectType)}</span></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="商品">商品</SelectItem>
                        <SelectItem value="服务">服务</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">项目内容</label>
                    <Input value={editForm.projectContent || ""} onChange={(e) => onEditFormChange({ ...editForm, projectContent: e.target.value })} placeholder="如 C57/雌/7周" />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">数量</label>
                    <Input type="number" value={editForm.quantity ?? ""} onChange={(e) => onEditFormChange({ ...editForm, quantity: e.target.value ? Number(e.target.value) : null })} />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">采购渠道</label>
                    <Select value={editForm.procurementSource || ""} onValueChange={(v) => onEditFormChange({ ...editForm, procurementSource: v || "" })}>
                      <SelectTrigger><span>{editForm.procurementSource || "选择渠道"}</span></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">无</SelectItem>
                        {editForm.procurementSource && !channels.some((c) => c.name === editForm.procurementSource) && (
                          <SelectItem value={editForm.procurementSource}>历史：{editForm.procurementSource}</SelectItem>
                        )}
                        {channels.map((c) => (
                          <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">品牌</label>
                    <SourceBrandSelect value={editForm.brand || ""} onChange={(name) => onEditFormChange({ ...editForm, brand: name })} />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">技术支持</label>
                    <TechSupportSelect
                      value={editForm.techSupport || ""}
                      onChange={(name) => onEditFormChange({ ...editForm, techSupport: name })}
                      placeholder="搜索内部员工转交，或手改姓名"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">项目金额（元）</label>
                    <Input type="number" step="0.01" value={editForm.budgetAmount ?? ""} disabled className="text-muted-foreground" placeholder="暂无关联订单金额" />
                    <p className="text-xs text-muted-foreground">由关联订单同步，请在订单中修改</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">项目成本（元）</label>
                    <Input type="number" step="0.01" value={editForm.budgetCost ?? ""} disabled className="text-muted-foreground" placeholder="暂无订单成本" />
                    <p className="text-xs text-muted-foreground">由订单生成时写入，请在订单中管理成本</p>
                  </div>
                </div>
              </details>
            </div>
          </div>
          <div className="-mx-4 -mb-4 border-t bg-popover/95 px-4 py-3">
            <Button type="submit" className="w-full" disabled={isSaving}>
              {isSaving ? "保存中..." : "保存更改"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
