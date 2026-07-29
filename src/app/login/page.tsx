"use client";

import { Suspense } from "react";
import { useState } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { FlaskConical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { getSafeRedirect } from "@/lib/safe-redirect";

function getSafeCallbackUrl(callbackUrl: string | null) {
  return getSafeRedirect(callbackUrl, "/dashboard");
}

function formatLockTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "即将解锁";
  const mins = Math.ceil(diff / 60000);
  return `${mins} 分钟`;
}

function LoginForm() {
  const searchParams = useSearchParams();
  const callbackUrl = getSafeCallbackUrl(searchParams.get("callbackUrl"));
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ email: "", password: "" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const email = form.email.trim().toLowerCase();

    try {
      const result = await signIn("credentials", {
        email,
        password: form.password,
        redirect: false,
        callbackUrl,
      });

      if (result?.error) {
        if (result.error.startsWith("LOCKED:")) {
          const lockedUntil = result.error.replace("LOCKED:", "");
          toast.error("账号已锁定", {
            description: `登录失败次数过多，请 ${formatLockTime(lockedUntil)} 后再试`,
          });
        } else if (result.error.startsWith("INVALID:")) {
          const remaining = parseInt(result.error.replace("INVALID:", ""), 10);
          toast.error("登录失败", {
            description: `邮箱或密码错误，剩余 ${Math.max(0, remaining)} 次尝试机会`,
          });
        } else {
          toast.error("登录失败", { description: "邮箱或密码错误" });
        }
        return;
      }

      toast.success("登录成功", { description: "欢迎回来！" });

      void fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "欢迎回来",
          content: "您已成功登录 SciManage，祝您科研顺利！",
          type: "SYSTEM",
        }),
      }).catch(() => {
        // Ignore notification creation errors during login redirect.
      });

      const nextUrl = getSafeCallbackUrl(result?.url || callbackUrl);
      window.location.assign(nextUrl);
    } catch {
      toast.error("登录失败", { description: "网络错误，请稍后重试" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">邮箱</Label>
        <Input
          id="email"
          type="email"
          placeholder="your@email.com"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">密码</Label>
        <Input
          id="password"
          type="password"
          required
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
      </div>
      <Button type="submit" className="w-full" disabled={loading}>
        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        登录
      </Button>
      <div className="text-center">
        <a href="/login/representative" className="text-sm text-primary hover:underline">
          我是代表，使用 Magic Link 登录
        </a>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-muted/30">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
            <FlaskConical className="h-6 w-6 text-primary-foreground" />
          </div>
          <CardTitle className="text-2xl">SciManage</CardTitle>
          <CardDescription>科研项目管理平台</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<div className="h-32 bg-muted animate-pulse rounded" />}>
            <LoginForm />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
