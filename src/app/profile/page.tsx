"use client";

import { useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Save, Lock, User, Mail, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

function BasicInfoForm({
  initialName,
  initialEmail,
}: {
  initialName: string;
  initialEmail: string;
}) {
  const { update } = useSession();
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);

  const profileMutation = useMutation({
    mutationFn: async (payload: { name?: string; email?: string }) => {
      const res = await fetch("/api/me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "更新失败");
      return data;
    },
    onSuccess: async () => {
      toast.success("基本信息已更新，请重新登录以查看最新信息");
      await update();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const canSave =
    name.trim() &&
    email.trim() &&
    (name !== initialName || email !== initialEmail);

  return (
    <CardContent className="space-y-4">
      <div className="space-y-2">
        <Label>昵称</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="您的昵称"
        />
      </div>
      <div className="space-y-2">
        <Label>邮箱</Label>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
        />
      </div>
      <Button
        className="w-full"
        disabled={!canSave || profileMutation.isPending}
        onClick={() =>
          profileMutation.mutate({ name: name.trim(), email: email.trim() })
        }
      >
        <Save className="mr-2 h-4 w-4" />
        {profileMutation.isPending ? "保存中..." : "保存基本信息"}
      </Button>
    </CardContent>
  );
}

function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const passwordMutation = useMutation({
    mutationFn: async (payload: {
      currentPassword: string;
      newPassword: string;
    }) => {
      const res = await fetch("/api/me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "修改失败");
      return data;
    },
    onSuccess: () => {
      toast.success("密码已修改，请重新登录");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const canSave =
    currentPassword &&
    newPassword &&
    confirmPassword &&
    newPassword === confirmPassword;

  return (
    <CardContent className="space-y-4">
      <div className="space-y-2">
        <Label>当前密码</Label>
        <Input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder="输入当前密码"
        />
      </div>
      <div className="space-y-2">
        <Label>新密码</Label>
        <Input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="输入新密码"
        />
      </div>
      <div className="space-y-2">
        <Label>确认新密码</Label>
        <Input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="再次输入新密码"
        />
        {newPassword &&
          confirmPassword &&
          newPassword !== confirmPassword && (
            <p className="text-xs text-red-500">
              两次输入的密码不一致
            </p>
          )}
      </div>
      <Button
        className="w-full"
        disabled={!canSave || passwordMutation.isPending}
        onClick={() =>
          passwordMutation.mutate({ currentPassword, newPassword })
        }
      >
        <Lock className="mr-2 h-4 w-4" />
        {passwordMutation.isPending ? "修改中..." : "修改密码"}
      </Button>
    </CardContent>
  );
}

function EmailTestCard() {
  const [sent, setSent] = useState(false);
  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/test-email", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "发送失败");
      return data;
    },
    onSuccess: (data: { to?: string }) => {
      toast.success(`测试邮件已发送至 ${data.to || "您的邮箱"}`);
      setSent(true);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="h-4 w-4" />
          邮件服务测试
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          邮件通知由系统 SMTP 账号自动发送
        </p>
        <Button
          className="w-full"
          disabled={testMutation.isPending || sent}
          onClick={() => testMutation.mutate()}
        >
          <Mail className="mr-2 h-4 w-4" />
          {testMutation.isPending
            ? "发送中..."
            : sent
            ? "已发送"
            : "发送测试邮件"}
        </Button>
      </CardContent>
    </Card>
  );
}

function NotificationPrefsCard({
  initialPrefs,
}: {
  initialPrefs: {
    emailOnReminder: boolean;
    emailOnStatusChange: boolean;
    emailOnTicketReply: boolean;
    emailOnComment: boolean;
  };
}) {
  const [prefs, setPrefs] = useState(initialPrefs);

  const queryClient = useQueryClient();
  const saveMutation = useMutation({
    mutationFn: async (payload: typeof prefs) => {
      const res = await fetch("/api/me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存失败");
      return data;
    },
    onSuccess: () => {
      toast.success("通知偏好已保存");
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const changed =
    prefs.emailOnReminder !== initialPrefs.emailOnReminder ||
    prefs.emailOnStatusChange !== initialPrefs.emailOnStatusChange ||
    prefs.emailOnTicketReply !== initialPrefs.emailOnTicketReply ||
    prefs.emailOnComment !== initialPrefs.emailOnComment;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Bell className="h-4 w-4" />
          通知设置
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {[
          { key: "emailOnReminder" as const, label: "提醒邮件", desc: "工单提醒和 CRM 跟进提醒到期时发送邮件通知" },
          { key: "emailOnStatusChange" as const, label: "项目状态变更邮件", desc: "项目状态发生变化时发送邮件" },
          { key: "emailOnTicketReply" as const, label: "工单回复邮件", desc: "有人回复您的工单时发送邮件" },
          { key: "emailOnComment" as const, label: "项目评论邮件", desc: "有人评论您的项目时发送邮件" },
        ].map((item) => (
          <label
            key={item.key}
            className="flex items-start gap-3 cursor-pointer"
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
              checked={prefs[item.key]}
              onChange={(e) =>
                setPrefs((p) => ({ ...p, [item.key]: e.target.checked }))
              }
            />
            <div className="text-sm">
              <div className="font-medium">{item.label}</div>
              <div className="text-muted-foreground">{item.desc}</div>
            </div>
          </label>
        ))}
        <Button
          className="w-full"
          disabled={!changed || saveMutation.isPending}
          onClick={() => saveMutation.mutate(prefs)}
        >
          <Save className="mr-2 h-4 w-4" />
          {saveMutation.isPending ? "保存中..." : "保存通知设置"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default function ProfilePage() {
  const { data: session } = useSession();
  const user = session?.user;

  const { data: meData } = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error("Failed to load profile");
      return res.json();
    },
    enabled: !!user,
  });

  const prefs = meData?.user
    ? {
        emailOnReminder: meData.user.emailOnReminder ?? true,
        emailOnStatusChange: meData.user.emailOnStatusChange ?? true,
        emailOnTicketReply: meData.user.emailOnTicketReply ?? true,
        emailOnComment: meData.user.emailOnComment ?? true,
      }
    : null;

  if (!user) return null;

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight">我的</h1>

      <Card>
        <CardHeader className="flex flex-row items-center gap-4">
          <Avatar className="h-16 w-16">
            <AvatarFallback className="bg-primary text-primary-foreground text-xl">
              {user.name?.slice(0, 2)?.toUpperCase() || "U"}
            </AvatarFallback>
          </Avatar>
          <div>
            <CardTitle>{user.name}</CardTitle>
            <p className="text-sm text-muted-foreground">{user.email}</p>
            <p className="text-xs text-muted-foreground capitalize mt-1">
              角色: {user.role === "ADMIN" ? "管理员" : "用户"}
            </p>
          </div>
        </CardHeader>
      </Card>

      {/* Basic Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <User className="h-4 w-4" />
            基本信息
          </CardTitle>
        </CardHeader>
        <BasicInfoForm
          key={user.id + user.name + user.email}
          initialName={user.name || ""}
          initialEmail={user.email || ""}
        />
      </Card>

      {/* Change Password */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Lock className="h-4 w-4" />
            修改密码
          </CardTitle>
        </CardHeader>
        <PasswordForm />
      </Card>

      {/* Notification Settings */}
      {prefs && (
        <NotificationPrefsCard
          key={
            prefs.emailOnReminder +
            "/" +
            prefs.emailOnStatusChange +
            "/" +
            prefs.emailOnTicketReply +
            "/" +
            prefs.emailOnComment
          }
          initialPrefs={prefs}
        />
      )}

      {/* Email Test */}
      <EmailTestCard />

      <Button
        variant="destructive"
        className="w-full"
        onClick={() => signOut({ callbackUrl: "/login" })}
      >
        <LogOut className="mr-2 h-4 w-4" />
        退出登录
      </Button>
    </div>
  );
}
