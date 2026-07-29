"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Loader2, FlaskConical, CheckCircle, XCircle, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getSafeRedirect } from "@/lib/safe-redirect";

type ValidateResult = {
  valid: boolean;
  reason?: "MISSING" | "INVALID" | "EXPIRED" | "ARCHIVED";
  expiresAt?: string;
};

type PageState =
  | { step: "validating" }
  | { step: "valid"; expiresAt: string }
  | { step: "signing_in" }
  | { step: "error"; reason: string; detail: string };

function MagicLinkContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");
  const rawRedirect = searchParams.get("redirect");
  const redirect = getSafeRedirect(rawRedirect);

  const [state, setState] = useState<PageState>(
    token ? { step: "validating" } : { step: "error", reason: "MISSING", detail: "缺少登录 token，请重新获取 Magic Link" }
  );
  const [confirming, setConfirming] = useState(false);

  // Validate on mount (read-only, does not consume token)
  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/representatives/magic-link/validate?token=${encodeURIComponent(token)}`);
        const data: ValidateResult = await res.json();

        if (cancelled) return;

        if (!data.valid) {
          const r = data.reason || "INVALID";
          const messages: Record<string, string> = {
            MISSING: "缺少登录 token",
            INVALID: "登录链接无效或已被使用",
            EXPIRED: "登录链接已过期（有效期 24 小时）",
            ARCHIVED: "该代表账号已归档，无法登录",
          };
          setState({ step: "error", reason: r, detail: messages[r] || "未知错误" });
        } else {
          setState({ step: "valid", expiresAt: data.expiresAt! });
        }
      } catch {
        if (!cancelled) setState({ step: "error", reason: "NETWORK", detail: "网络错误，请重试" });
      }
    })();

    return () => { cancelled = true; };
  }, [token]);

  async function handleConfirmLogin() {
    if (!token) return;
    setConfirming(true);

    try {
      const result = await signIn("representative", {
        token,
        redirect: false,
        callbackUrl: redirect,
      });

      if (result?.error) {
        const messages: Record<string, string> = {
          ARCHIVED: "该代表账号已归档，无法登录。请联系管理员恢复账号。",
          EXPIRED: "登录链接已过期，请重新获取 Magic Link。",
        };
        setState({ step: "error", reason: result.error, detail: messages[result.error] || "登录链接无效，请重新获取 Magic Link" });
        return;
      }

      const safeUrl = redirect.startsWith("/") ? redirect : "/dashboard";
      window.location.assign(safeUrl);
    } catch {
      setState({ step: "error", reason: "NETWORK", detail: "网络错误，请稍后重试" });
    } finally {
      setConfirming(false);
    }
  }

  function formatExpiry(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-muted/30">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
            <FlaskConical className="h-6 w-6 text-primary-foreground" />
          </div>
          <CardTitle className="text-2xl">SciManage</CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          {state.step === "validating" && (
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-muted-foreground">正在验证登录链接...</p>
            </div>
          )}

          {state.step === "valid" && (
            <div className="space-y-4">
              <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
              <div>
                <p className="font-medium">此登录链接有效</p>
                <p className="text-sm text-muted-foreground mt-1">
                  点击下方按钮即可登录系统
                </p>
              </div>
              <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                <span>链接有效期至 {formatExpiry(state.expiresAt)}</span>
              </div>
              <Button
                className="w-full"
                onClick={handleConfirmLogin}
                disabled={confirming}
              >
                {confirming ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    正在登录...
                  </>
                ) : (
                  "确认登录"
                )}
              </Button>
              <p className="text-xs text-muted-foreground">
                链接有效期 24 小时，失效后请重新获取
              </p>
            </div>
          )}

          {state.step === "error" && (
            <div className="space-y-4">
              <XCircle className="h-12 w-12 text-red-500 mx-auto" />
              <div>
                <p className="font-medium text-red-600">登录链接无效</p>
                <p className="text-sm text-muted-foreground mt-1">{state.detail}</p>
              </div>
              <Button
                className="w-full"
                onClick={() => {
                  const params = new URLSearchParams();
                  if (redirect) params.set("redirect", redirect);
                  const qs = params.toString();
                  router.push(qs ? `/login/representative?${qs}` : "/login/representative");
                }}
              >
                前往代表登录页重新获取链接
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function MagicLinkPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-muted/30">
        <Card className="w-full max-w-sm">
          <CardContent className="p-8 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
            <p className="text-muted-foreground mt-3">加载中...</p>
          </CardContent>
        </Card>
      </div>
    }>
      <MagicLinkContent />
    </Suspense>
  );
}
