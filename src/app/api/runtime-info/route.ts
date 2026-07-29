import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getRuntimeInfo } from "@/lib/runtime-info";

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (request.headers.get("x-runtime-debug") !== "1") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(getRuntimeInfo(), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
