import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || "";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || "MiniMax-M2.7";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ interactionId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { interactionId } = await params;
  const interaction = await prisma.crmInteraction.findUnique({
    where: { id: interactionId },
    select: { id: true, createdByUserId: true, transcript: true },
  });

  if (!interaction) return NextResponse.json({ error: "Interaction not found" }, { status: 404 });
  if (interaction.createdByUserId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!interaction.transcript?.trim()) {
    return NextResponse.json({ error: "没有转写文本可供摘要" }, { status: 400 });
  }
  if (!MINIMAX_API_KEY) {
    return NextResponse.json({ error: "AI 未配置" }, { status: 503 });
  }

  const systemPrompt = `你是科研客户拜访记录摘要助手。根据沟通语音转写文本，生成简短标题和摘要。直接输出结果，不要输出思考过程。

严格按以下 JSON 格式返回，不要包含其他文字：
{"title":"标题（10-20字）","summary":"摘要（1-3句话）"}

规则：
- 标题 10-20 字，概括沟通核心内容
- 摘要 1-3 句，提炼关键信息
- 不编造客户、单位、地点
- 如果语音内容太短或无法判断，标题用"客户沟通记录"，摘要用"沟通过程中进行了交流。"`;

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
          { role: "system", content: systemPrompt },
          { role: "user", content: interaction.transcript },
        ],
        temperature: 0.1,
        max_tokens: 256,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Interaction summarize error:", res.status, text);
      return NextResponse.json({ error: "AI 摘要生成失败" }, { status: 500 });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    let jsonStr = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    jsonStr = jsonStr.replace(/```json?\n?/g, "").replace(/```/g, "").trim();

    let title = "客户沟通记录";
    let summary = "沟通过程中进行了交流。";
    let fallback = false;
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.title) title = String(parsed.title).slice(0, 40);
      if (parsed.summary) summary = String(parsed.summary).slice(0, 500);
    } catch (err) {
      console.warn(`[AI-SUMMARY] interaction ${interactionId} JSON parse failed:`, err);
      fallback = true;
    }

    await prisma.crmInteraction.update({
      where: { id: interactionId },
      data: { summaryTitle: title, summaryNote: summary },
    });

    return NextResponse.json({ title, summary, fallback });
  } catch (err) {
    console.error("Interaction summarize failed:", err);
    return NextResponse.json({ error: "AI 摘要生成失败" }, { status: 500 });
  }
}
