import { NextRequest, NextResponse } from "next/server";
import {
  verifyInvitationToken,
  maskEmail,
} from "@/lib/user-management/invitations";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const { token } = body;
  if (typeof token !== "string" || !token) {
    return NextResponse.json({ error: "链接无效或已过期" }, { status: 400 });
  }

  const result = await verifyInvitationToken(token);
  if (!result.valid) {
    return NextResponse.json({ error: "链接无效或已过期" }, { status: 400 });
  }

  const { data } = result;
  return NextResponse.json({
    email: maskEmail(data.email),
    purpose: data.purpose,
    expiresAt: data.expiresAt,
  });
}
