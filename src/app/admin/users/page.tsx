"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  Save,
  Shield,
  User,
  Handshake,
  UserPlus,
  Mail,
  KeyRound,
  MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DataTable, DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface InvitationInfo {
  id: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

interface UserItem {
  id: string;
  name: string;
  email: string;
  role: string;
  /** 所属部门（FIELD_SALES | ONLINE_OPS） */
  department: string;
  passwordInitialized: boolean;
  createdAt: string;
  invitations: InvitationInfo[];
}

const DEPARTMENT_LABELS: Record<string, string> = {
  FIELD_SALES: "地推销售部",
  ONLINE_OPS: "网络运营部",
};

const DEPARTMENT_OPTIONS = [
  { value: "FIELD_SALES", label: "地推销售部" },
  { value: "ONLINE_OPS", label: "网络运营部" },
] as const;

function getDepartmentLabel(department: string): string {
  return DEPARTMENT_LABELS[department] ?? department;
}

function getRoleMeta(role: string) {
  switch (role) {
    case "ADMIN":
      return {
        label: "管理员",
        icon: Shield,
        variant: "default" as const,
        className: "",
      };
    case "REPRESENTATIVE":
      return {
        label: "代表",
        icon: Handshake,
        variant: "outline" as const,
        className: "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-50",
      };
    case "REGIONAL_MANAGER":
      return {
        label: "地区经理",
        icon: MapPin,
        variant: "outline" as const,
        className: "border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-50",
      };
    default:
      return {
        label: "用户",
        icon: User,
        variant: "secondary" as const,
        className: "",
      };
  }
}

function isSalesRole(role: string): boolean {
  return role === "REPRESENTATIVE" || role === "REGIONAL_MANAGER";
}

function getAccountStatus(user: UserItem): {
  label: string;
  className: string;
} {
  if (isSalesRole(user.role)) {
    return { label: "销售账号", className: "text-muted-foreground" };
  }

  if (!user.passwordInitialized) {
    const latestInvitation = user.invitations?.[0];
    if (latestInvitation && !latestInvitation.revokedAt) {
      const expired = new Date(latestInvitation.expiresAt) < new Date();
      if (expired) {
        return { label: "邀请已过期", className: "text-orange-600" };
      }
      return { label: "待激活", className: "text-blue-600" };
    }
    return { label: "待激活", className: "text-blue-600" };
  }

  return { label: "已激活", className: "text-green-600" };
}

export default function AdminUsersPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const [search, setSearch] = useState("");
  const [editUser, setEditUser] = useState<UserItem | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    email: "",
    role: "USER",
    department: "FIELD_SALES",
  });
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    email: "",
    role: "USER",
    department: "FIELD_SALES",
  });

  const { data, isLoading, error } = useQuery<{ users: UserItem[] }>({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const res = await fetch("/api/users");
      if (res.status === 403) throw new Error("无权访问");
      if (!res.ok) throw new Error("Failed to load users");
      return res.json();
    },
    enabled: status === "authenticated" && session?.user?.role === "ADMIN",
  });

  useEffect(() => {
    if (status === "authenticated" && session?.user?.role !== "ADMIN") {
      router.push("/dashboard");
    }
    if (error?.message === "无权访问") {
      router.push("/dashboard");
    }
  }, [status, session, error, router]);

  const updateMutation = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: Record<string, unknown> }) => {
      const res = await fetch(`/api/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "更新失败");
      return data;
    },
    onSuccess: (data) => {
      if (data.invitation?.deliveryStatus === "FAILED") {
        toast.warning("资料已更新，但新邮箱邀请发送失败，可在列表中重发");
      } else if (data.invitation?.deliveryStatus === "TEST_TRANSPORT") {
        toast.warning("资料已更新；邀请经测试通道发出，收件人可能收不到正式邮件");
      } else {
        toast.success("用户更新成功");
      }
      setEditUser(null);
      setEditForm({ name: "", email: "", role: "USER", department: "FIELD_SALES" });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createMutation = useMutation({
    mutationFn: async (payload: {
      name: string;
      email: string;
      role: string;
      department: string;
    }) => {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建失败");
      return data;
    },
    onSuccess: (data) => {
      if (data.invitation?.deliveryStatus === "FAILED") {
        toast.warning("用户已创建，但邀请邮件发送失败，可在列表中重发");
      } else if (data.invitation?.deliveryStatus === "TEST_TRANSPORT") {
        toast.warning("用户已创建；邀请经测试通道发出，收件人可能收不到正式邮件");
      } else {
        toast.success("用户创建成功，邀请邮件已发送");
      }
      setShowCreateDialog(false);
      setCreateForm({ name: "", email: "", role: "USER", department: "FIELD_SALES" });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const invitationMutation = useMutation({
    mutationFn: async ({
      userId,
      purpose,
    }: {
      userId: string;
      purpose: "ACCOUNT_SETUP" | "PASSWORD_RESET";
    }) => {
      const res = await fetch(`/api/users/${userId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "发送失败");
      return data;
    },
    onSuccess: (data) => {
      if (data.deliveryStatus === "FAILED") {
        toast.warning("邀请已创建，但邮件发送失败，可稍后重发");
      } else if (data.deliveryStatus === "TEST_TRANSPORT") {
        toast.warning("邀请经测试通道发出，收件人可能收不到正式邮件");
      } else {
        toast.success("邀请邮件已发送");
      }
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleSaveEdit = async () => {
    if (!editUser) return;
    const isDemotion = editUser.role === "ADMIN" && editForm.role === "USER";
    if (isDemotion) {
      const ok = await confirm({
        title: "确认降低管理员权限",
        description:
          "降权后该用户将失去管理权限，权限在其下一次请求时立即生效。确定继续？",
        confirmText: "确认降权",
        variant: "destructive",
      });
      if (!ok) return;
    }
    updateMutation.mutate({
      id: editUser.id,
      payload: {
        name: editForm.name.trim(),
        email: editForm.email.trim(),
        role: editForm.role,
        department: editForm.department,
      },
    });
  };

  if (status === "loading") return null;
  if (!session || session.user.role !== "ADMIN") return null;
  if (error?.message === "无权访问") return null;

  const users = data?.users || [];
  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase())
  );

  const openEdit = (user: UserItem) => {
    setEditUser(user);
    setEditForm({
      name: user.name,
      email: user.email,
      role: user.role,
      department: user.department,
    });
  };

  const columns: DataTableColumn<UserItem>[] = [
    {
      key: "name",
      header: "用户",
      render: (user) => (
        <div className="flex items-center gap-2">
          <div
            className={`h-8 w-8 rounded-full text-xs flex items-center justify-center shrink-0 ${
              isSalesRole(user.role)
                ? user.role === "REGIONAL_MANAGER"
                  ? "bg-purple-100 text-purple-700"
                  : "bg-amber-100 text-amber-700"
                : "bg-primary text-primary-foreground"
            }`}
          >
            {user.name?.slice(0, 2)?.toUpperCase() || "U"}
          </div>
          <span className="font-medium">{user.name}</span>
        </div>
      ),
    },
    {
      key: "email",
      header: "邮箱",
      render: (user) => <span className="text-muted-foreground">{user.email}</span>,
    },
    {
      key: "role",
      header: "角色",
      render: (user) => {
        const roleMeta = getRoleMeta(user.role);
        const RoleIcon = roleMeta.icon;
        return (
          <Badge variant={roleMeta.variant} className={`text-xs ${roleMeta.className}`}>
            <span className="flex items-center gap-1">
              <RoleIcon className="h-3 w-3" />
              {roleMeta.label}
            </span>
          </Badge>
        );
      },
    },
    {
      key: "department",
      header: "部门",
      render: (user) => (
        <Badge variant="outline" className="text-xs">
          {getDepartmentLabel(user.department)}
        </Badge>
      ),
    },
    {
      key: "status",
      header: "状态",
      render: (user) => {
        const status = getAccountStatus(user);
        return <span className={`text-sm font-medium ${status.className}`}>{status.label}</span>;
      },
    },
    {
      key: "createdAt",
      header: "注册时间",
      render: (user) => (
        <span className="text-muted-foreground">
          {new Date(user.createdAt).toLocaleDateString("zh-CN")}
        </span>
      ),
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (user) => {
        if (isSalesRole(user.role)) {
          return (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                router.push(
                  user.role === "REPRESENTATIVE"
                    ? "/admin/representatives"
                    : "/crm/region-managers",
                )
              }
            >
              前往管理
            </Button>
          );
        }

        return (
          <div className="flex items-center gap-1 justify-end">
            <Button variant="ghost" size="sm" onClick={() => openEdit(user)}>
              <Save className="h-3 w-3 mr-1" />
              编辑
            </Button>
            {!user.passwordInitialized ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={invitationMutation.isPending}
                onClick={() =>
                  invitationMutation.mutate({ userId: user.id, purpose: "ACCOUNT_SETUP" })
                }
              >
                <Mail className="h-3 w-3 mr-1" />
                重发邀请
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={invitationMutation.isPending}
                onClick={() =>
                  invitationMutation.mutate({ userId: user.id, purpose: "PASSWORD_RESET" })
                }
              >
                <KeyRound className="h-3 w-3 mr-1" />
                密码重置
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  const renderMobileCard = (user: UserItem) => {
    const roleMeta = getRoleMeta(user.role);
    const RoleIcon = roleMeta.icon;
    const status = getAccountStatus(user);
    return (
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className={`h-8 w-8 rounded-full text-xs flex items-center justify-center shrink-0 ${
                isSalesRole(user.role)
                  ? user.role === "REGIONAL_MANAGER"
                    ? "bg-purple-100 text-purple-700"
                    : "bg-amber-100 text-amber-700"
                  : "bg-primary text-primary-foreground"
              }`}
            >
              {user.name?.slice(0, 2)?.toUpperCase() || "U"}
            </div>
            <span className="font-medium truncate">{user.name}</span>
          </div>
          <Badge variant={roleMeta.variant} className={`text-xs shrink-0 ${roleMeta.className}`}>
            <span className="flex items-center gap-1">
              <RoleIcon className="h-3 w-3" />
              {roleMeta.label}
            </span>
          </Badge>
        </div>
        <div className="text-sm text-muted-foreground truncate">{user.email}</div>
        <div className="flex items-center justify-between text-xs">
          <span className={`font-medium ${status.className}`}>{status.label}</span>
          <Badge variant="outline" className="text-xs">
            {getDepartmentLabel(user.department)}
          </Badge>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>注册时间</span>
          <span>{new Date(user.createdAt).toLocaleDateString("zh-CN")}</span>
        </div>
        <div className="flex justify-end gap-1">
          {isSalesRole(user.role) ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                router.push(
                  user.role === "REPRESENTATIVE"
                    ? "/admin/representatives"
                    : "/crm/region-managers",
                )
              }
            >
              前往管理
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => openEdit(user)}>
                <Save className="h-3 w-3 mr-1" />
                编辑
              </Button>
              {!user.passwordInitialized ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={invitationMutation.isPending}
                  onClick={() =>
                    invitationMutation.mutate({ userId: user.id, purpose: "ACCOUNT_SETUP" })
                  }
                >
                  <Mail className="h-3 w-3 mr-1" />
                  重发
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={invitationMutation.isPending}
                  onClick={() =>
                    invitationMutation.mutate({ userId: user.id, purpose: "PASSWORD_RESET" })
                  }
                >
                  <KeyRound className="h-3 w-3 mr-1" />
                  重置
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <PageShell>
      <PageHeader
        title="用户管理"
        description="管理系统中的所有用户与代表账号"
        actions={
          <Button onClick={() => setShowCreateDialog(true)}>
            <UserPlus className="h-4 w-4 mr-2" />
            添加用户
          </Button>
        }
      />

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="搜索用户..."
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error ? (
        <div className="rounded-lg border bg-card p-12 text-center">
          <p className="text-destructive">加载失败：{error.message}</p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={filtered}
          keyExtractor={(user) => user.id}
          isLoading={isLoading}
          emptyTitle="未找到用户"
          emptyDescription="请尝试更换搜索关键词"
          renderMobileCard={renderMobileCard}
        />
      )}

      {/* Create user dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>添加用户</DialogTitle>
            <DialogDescription>
              创建后将向该邮箱发送设置密码链接
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>姓名</Label>
              <Input
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                placeholder="请输入姓名"
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label>邮箱</Label>
              <Input
                type="email"
                value={createForm.email}
                onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                placeholder="user@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label>角色</Label>
              <Select
                value={createForm.role}
                onValueChange={(v) => setCreateForm({ ...createForm, role: v || "USER" })}
              >
                <SelectTrigger>
                  <SelectValue>
                    {createForm.role === "ADMIN" ? "管理员" : "普通用户"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">普通用户</SelectItem>
                  <SelectItem value="ADMIN">管理员</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>部门</Label>
              <Select
                value={createForm.department}
                onValueChange={(v) =>
                  setCreateForm({ ...createForm, department: v || "FIELD_SALES" })
                }
              >
                <SelectTrigger>
                  <SelectValue>
                    {getDepartmentLabel(createForm.department)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {DEPARTMENT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="w-full"
              disabled={createMutation.isPending}
              onClick={() => {
                if (!createForm.name.trim() || !createForm.email.trim()) {
                  toast.error("姓名和邮箱不能为空");
                  return;
                }
                createMutation.mutate({
                  name: createForm.name.trim(),
                  email: createForm.email.trim(),
                  role: createForm.role,
                  department: createForm.department,
                });
              }}
            >
              <UserPlus className="mr-2 h-4 w-4" />
              {createMutation.isPending ? "创建中..." : "创建并发送邀请"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit user dialog */}
      <Dialog open={!!editUser} onOpenChange={(open) => !open && setEditUser(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>编辑用户</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {editUser && isSalesRole(editUser.role) ? (
              <>
                <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                  <Badge
                    variant="outline"
                    className={
                      editUser.role === "REPRESENTATIVE"
                        ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-50"
                        : "border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-50"
                    }
                  >
                    <span className="flex items-center gap-1">
                      {editUser.role === "REPRESENTATIVE" ? (
                        <Handshake className="h-3 w-3" />
                      ) : (
                        <MapPin className="h-3 w-3" />
                      )}
                      {editUser.role === "REPRESENTATIVE" ? "代表" : "地区经理"}
                    </span>
                  </Badge>
                  <p className="text-xs text-muted-foreground">
                    {editUser.role === "REPRESENTATIVE"
                      ? "代表账号的昵称、邮箱和密码由「代表管理」统一维护，此处仅展示信息。"
                      : "地区经理身份由「地区经理配置」维护，此处仅展示账号信息。"}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>昵称</Label>
                  <Input value={editForm.name} disabled />
                </div>
                <div className="space-y-2">
                  <Label>邮箱</Label>
                  <Input value={editForm.email} disabled />
                </div>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() =>
                    router.push(
                      editUser.role === "REPRESENTATIVE"
                        ? "/admin/representatives"
                        : "/crm/region-managers",
                    )
                  }
                >
                  前往{editUser.role === "REPRESENTATIVE" ? "代表管理" : "地区经理配置"}
                </Button>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>昵称</Label>
                  <Input
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>邮箱</Label>
                  <Input
                    type="email"
                    value={editForm.email}
                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>角色</Label>
                  <Select
                    value={editForm.role}
                    onValueChange={(v) => setEditForm({ ...editForm, role: v || "USER" })}
                  >
                    <SelectTrigger>
                      <SelectValue>
                        {editForm.role === "ADMIN" ? "管理员" : "用户"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USER">用户</SelectItem>
                      <SelectItem value="ADMIN">管理员</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>部门</Label>
                  <Select
                    value={editForm.department}
                    onValueChange={(v) =>
                      setEditForm({ ...editForm, department: v || "FIELD_SALES" })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue>
                        {getDepartmentLabel(editForm.department)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {DEPARTMENT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {editUser && editUser.department !== editForm.department && (
                    <p className="text-xs text-amber-700">
                      部门变更需通过前置检查（未完成跟进、已认领客户、客服号、项目成员）。
                      若存在遗留工作将提示具体原因。
                    </p>
                  )}
                </div>
                {editUser &&
                  editUser.role === "ADMIN" &&
                  editForm.role === "USER" && (
                    <div className="rounded-lg border border-orange-200 bg-orange-50 p-3">
                      <p className="text-xs text-orange-700">
                        确认将管理员降为普通用户？降权后该用户将失去管理权限，
                        权限在其下一次请求时立即生效。
                      </p>
                    </div>
                  )}
                <Button
                  className="w-full"
                  disabled={updateMutation.isPending}
                  onClick={() => {
                    void handleSaveEdit();
                  }}
                >
                  <Save className="mr-2 h-4 w-4" />
                  {updateMutation.isPending ? "保存中..." : "保存更改"}
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
