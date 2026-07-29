"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical, Loader2, ArrowLeft, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { getSafeRedirect } from "@/lib/safe-redirect";

export default function RepresentativeLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);

    try {
      // Read redirect from current URL so the replacement link lands at the original destination
      const rawRedirect = new URLSearchParams(window.location.search).get("redirect");
      const safeRedirect = getSafeRedirect(rawRedirect, "");
      const body: Record<string, string> = { email: email.trim().toLowerCase() };
      if (safeRedirect) body.redirect = safeRedirect;

      const res = await fetch("/api/representatives/request-magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setSent(true);
        toast.success("登录链接正在发送到您的邮箱，请稍候查收");
      } else {
        const data = await res.json().catch(() => ({}));
        if (res.status === 403 && data.error) {
          toast.error(data.error);
        } else {
          toast.error(data.error || "发送失败，请检查邮箱是否正确");
        }
      }
    } catch {
      toast.error("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-muted/30">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
            <FlaskConical className="h-6 w-6 text-primary-foreground" />
          </div>
          <CardTitle className="text-2xl">代表登录</CardTitle>
          <CardDescription>输入邮箱获取 Magic Link 登录链接</CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="text-center space-y-4">
              <Mail className="h-12 w-12 text-primary mx-auto" />
              <p className="text-muted-foreground">
                登录链接正在发送到 <strong>{email}</strong>
              </p>
              <p className="text-xs text-muted-foreground">
                请稍候查收邮箱（包括垃圾邮件文件夹），点击邮件中的链接即可登录。
                链接有效期 24 小时。
              </p>
              <Button variant="outline" className="w-full" onClick={() => { setSent(false); setEmail(""); }}>
                使用其他邮箱
              </Button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">邮箱</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="your@email.com"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                发送登录链接
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => router.push("/login")}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                返回普通用户登录
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
