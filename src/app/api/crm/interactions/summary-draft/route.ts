import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isDraftAIConfigured } from "@/lib/draft/providers";

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || "";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || "MiniMax-M2.7";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isDraftAIConfigured()) {
    return NextResponse.json({ error: "AI 服务未配置" }, { status: 503 });
  }

  const body = await req.json();
  const detail = (body.detail as string)?.trim();
  if (!detail) return NextResponse.json({ error: "detail is required" }, { status: 400 });

  try {
    const res = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MINIMAX_API_KEY}`,
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [
          {
            role: "system",
            content: "你是沟通记录摘要助手。根据沟通详情，生成一句简短摘要（15-30字），概括沟通核心内容。只输出摘要文本，不要输出其他内容。如果内容太短或无法判断，输出\"客户沟通记录\"。",
          },
          { role: "user", content: detail },
        ],
        temperature: 0.1,
        max_tokens: 128,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Draft summary error:", res.status, text);
      return NextResponse.json({ error: "AI 摘要生成失败" }, { status: 500 });
    }

    const data = await res.json();
    let content: string = data.choices?.[0]?.message?.content || "";
    content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    content = content.replace(/```\n?/g, "").trim();

    const summary = content || "客户沟通记录";
    return NextResponse.json({ summary: summary.slice(0, 100) });
  } catch (err) {
    console.error("Draft summary failed:", err);
    return NextResponse.json({ error: "AI 摘要生成失败" }, { status: 500 });
  }
}
