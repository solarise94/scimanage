import { NextRequest, NextResponse } from "next/server";
import { completeInvitation } from "@/lib/user-management/invitations";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const { token, password } = body;
  if (typeof token !== "string" || !token) {
    return NextResponse.json({ error: "链接无效或已过期" }, { status: 400 });
  }
  if (typeof password !== "string" || !password) {
    return NextResponse.json({ error: "密码不能为空" }, { status: 400 });
  }

  const result = await completeInvitation(token, password);
  if (!result.ok) {
    // Distinguish password validation errors (400) from token errors (400)
    // Both return 400, but message differs
    const isTokenError = result.error === "链接无效或已过期";
    return NextResponse.json(
      { error: result.error },
      { status: isTokenError ? 400 : 400 },
    );
  }

  return NextResponse.json({ success: true });
}
