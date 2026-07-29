import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertProjectContextReadable, isRepresentative } from "@/lib/permissions";
import { MinimaxChatProvider } from "@/lib/draft/providers/minimax-chat";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isRepresentative(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: projectId } = await params;
  try {
    await assertProjectContextReadable(projectId, session.user.id, session.user.role);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const userPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      name: true, description: true, orderNumber: true, organization: true,
      profile: { select: { name: true, organization: true } },
    },
  });
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const recentInvoices = await prisma.projectInvoice.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: {
      invoiceType: true, contentSummary: true, buyerOrganizationName: true, contactName: true,
      items: { select: { itemName: true, spec: true, unit: true, quantity: true, amount: true } },
    },
  });

  const contextLines: string[] = [
    `项目名称：${project.name}`,
  ];
  if (project.description) contextLines.push(`项目描述：${project.description}`);
  if (project.orderNumber) contextLines.push(`合同/订单号：${project.orderNumber}`);
  if (project.organization) contextLines.push(`所属机构：${project.organization}`);
  if (project.profile) {
    contextLines.push(`客户：${project.profile.name ?? ""}${project.profile.organization ? `（${project.profile.organization}）` : ""}`);
  }

  if (recentInvoices.length > 0) {
    contextLines.push("", "该项目最近的开票记录：");
    for (const inv of recentInvoices) {
      const parts = [
        inv.invoiceType === "SPECIAL" ? "专票" : "普票",
        inv.buyerOrganizationName,
        inv.contentSummary,
      ].filter(Boolean);
      contextLines.push(`- ${parts.join(" / ")}`);
      if (inv.items.length > 0) {
        for (const it of inv.items) {
          contextLines.push(`  · ${it.itemName}${it.spec ? `(${it.spec})` : ""} ${it.quantity ?? ""}${it.unit ?? ""} ¥${it.amount}`);
        }
      }
    }
  }

  const systemPrompt = `你是一个科研项目管理系统的开票助手。根据项目信息，帮用户预填开票申请表单。

你只能填写以下字段：
- contactName: 联系人姓名
- invoiceType: "NORMAL"（普票）或 "SPECIAL"（专票）
- contentSummary: 开票内容摘要（如"技术服务费"、"小鼠售卖"等）
- remark: 备注
- items: 明细行数组，每行包含 itemName(项目名称), spec(规格,可选), unit(单位,可选), quantity(数量,可选), amount(金额)

你绝对不能填写：税号、银行信息、卖方信息、买方税号等财务敏感字段。

请根据项目上下文合理推断开票内容。如果信息不足以推断某个字段，就不要填。
金额字段如果无法确定，设为 0。

返回 JSON 格式：
{
  "contactName": "...",
  "invoiceType": "NORMAL",
  "contentSummary": "...",
  "remark": "...",
  "items": [{ "itemName": "...", "spec": null, "unit": null, "quantity": null, "amount": 0 }],
  "summary": "一句话说明你的填写依据"
}`;

  const userMessage = [
    "项目信息：",
    contextLines.join("\n"),
    userPrompt ? `\n用户补充说明：${userPrompt}` : "",
    "\n请生成开票申请草稿 JSON。",
  ].join("\n");

  try {
    const provider = new MinimaxChatProvider();
    const { content } = await provider.chat({
      systemPrompt,
      userMessage,
      temperature: 0.3,
      maxTokens: 2048,
    });

    const cleaned = content
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error("无法从 AI 返回中提取 JSON");
    }

    const draft: Record<string, unknown> = {};
    if (typeof parsed.contactName === "string") draft.contactName = parsed.contactName;
    if (parsed.invoiceType === "NORMAL" || parsed.invoiceType === "SPECIAL") draft.invoiceType = parsed.invoiceType;
    if (typeof parsed.contentSummary === "string") draft.contentSummary = parsed.contentSummary;
    if (typeof parsed.remark === "string") draft.remark = parsed.remark;
    if (Array.isArray(parsed.items)) {
      draft.items = parsed.items
        .filter((it: Record<string, unknown>) => typeof it.itemName === "string" && it.itemName)
        .map((it: Record<string, unknown>) => ({
          itemName: String(it.itemName),
          spec: typeof it.spec === "string" ? it.spec : null,
          unit: typeof it.unit === "string" ? it.unit : null,
          quantity: typeof it.quantity === "number" ? it.quantity : null,
          amount: typeof it.amount === "number" ? it.amount : 0,
        }));
    }

    return NextResponse.json({
      draft,
      summary: typeof parsed.summary === "string" ? parsed.summary : "AI 已生成草稿",
    });
  } catch (err) {
    console.error("Invoice draft AI error:", err);
    return NextResponse.json(
      { error: "AI 生成失败，请稍后重试" },
      { status: 500 },
    );
  }
}
