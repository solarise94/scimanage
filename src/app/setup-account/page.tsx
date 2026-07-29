"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldCheck, KeyRound, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;

function SetupAccountInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  // If no token at all, start in the error state without an effect.
  const noToken = !token;
  const [loading, setLoading] = useState(!noToken);
  const [error, setError] = useState(noToken ? "链接无效或已过期" : "");
  const [verified, setVerified] = useState(false);
  const [purpose, setPurpose] = useState<string>("");
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/account-invitations/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error || "链接无效或已过期");
          setLoading(false);
          return;
        }
        setVerified(true);
        setPurpose(data.purpose);
        setEmail(data.email);
        setLoading(false);
      } catch {
        if (cancelled) return;
        setError("链接无效或已过期");
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async () => {
    if (!token) return;

    if (password.trim().length < PASSWORD_MIN_LENGTH) {
      toast.error(`密码至少 ${PASSWORD_MIN_LENGTH} 个字符`);
      return;
    }
    if (password.trim().length > PASSWORD_MAX_LENGTH) {
      toast.error(`密码不能超过 ${PASSWORD_MAX_LENGTH} 个字符`);
      return;
    }
    if (password !== confirmPassword) {
      toast.error("两次输入的密码不一致");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/account-invitations/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "设置失败");
        return;
      }
      setSuccess(true);
      toast.success("密码设置成功");
    } catch {
      toast.error("设置失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>正在验证链接...</span>
        </div>
      </div>
    );
  }

  if (error && !verified) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-md w-full space-y-6 text-center">
          <div className="mx-auto h-14 w-14 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertCircle className="h-7 w-7 text-destructive" />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-bold">链接无效</h1>
            <p className="text-sm text-muted-foreground">{error}</p>
            <p className="text-xs text-muted-foreground">
              链接可能已过期、已使用或被撤销。请联系管理员重新发送邀请。
            </p>
          </div>
          <Button variant="outline" onClick={() => router.push("/login")}>
            返回登录
          </Button>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-md w-full space-y-6 text-center">
          <div className="mx-auto h-14 w-14 rounded-full bg-green-100 flex items-center justify-center">
            <CheckCircle2 className="h-7 w-7 text-green-600" />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-bold">密码设置成功</h1>
            <p className="text-sm text-muted-foreground">
              请使用邮箱和新密码登录。
            </p>
          </div>
          <Button onClick={() => router.push("/login")}>
            前往登录
          </Button>
        </div>
      </div>
    );
  }

  if (!verified) return null;

  const isAccountSetup = purpose === "ACCOUNT_SETUP";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center space-y-2">
          <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center">
            {isAccountSetup ? (
              <ShieldCheck className="h-7 w-7 text-primary" />
            ) : (
              <KeyRound className="h-7 w-7 text-primary" />
            )}
          </div>
          <h1 className="text-xl font-bold">
            {isAccountSetup ? "设置账号密码" : "重置密码"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {email}（{isAccountSetup ? "新账号" : "密码重置"}）
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>密码</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`至少 ${PASSWORD_MIN_LENGTH} 个字符`}
              maxLength={PASSWORD_MAX_LENGTH}
            />
          </div>
          <div className="space-y-2">
            <Label>确认密码</Label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="再次输入密码"
              maxLength={PASSWORD_MAX_LENGTH}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !submitting) handleSubmit();
              }}
            />
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">
              密码要求：{PASSWORD_MIN_LENGTH}-{PASSWORD_MAX_LENGTH} 个字符，不强制大小写/数字/符号组合。
              不建议使用与邮箱相同的密码。
            </p>
          </div>
          <Button
            className="w-full"
            disabled={submitting || !password || !confirmPassword}
            onClick={handleSubmit}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                设置中...
              </>
            ) : (
              "设置密码"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function SetupAccountPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-background">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <SetupAccountInner />
    </Suspense>
  );
}
