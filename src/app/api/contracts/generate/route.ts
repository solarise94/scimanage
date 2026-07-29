import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { businessActorFromSessionUser } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import { isSalesRole } from "@/lib/role-guards";
import { generateContractForActor } from "@/lib/contracts/application/generate-contract";

// T8.2b 起走 canonical application service（intent-less 直生成路径，C5）。
// 保留 route 层：session、销售角色 403（自定义消息）、parse 400、binary docx 响应、错误映射。
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // 销售角色（REPRESENTATIVE/REGIONAL_MANAGER）不能生成合同
  if (isSalesRole(session.user.role)) {
    return NextResponse.json(
      { error: "Forbidden: 销售角色无权生成合同" },
      { status: 403 },
    );
  }

  const body = await req.json();
  const { orderIds, templateId, sellerProfileId, buyerOverrides, remark } = body;

  // parse 校验（route 层保留历史 400 文案）
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return NextResponse.json({ error: "至少选择一个订单" }, { status: 400 });
  }
  if (!templateId || !sellerProfileId) {
    return NextResponse.json({ error: "缺少模板或开票主体" }, { status: 400 });
  }

  try {
    const actor = businessActorFromSessionUser(session.user);
    const result = await generateContractForActor(actor, {
      orderIds,
      templateId,
      sellerProfileId,
      buyerOverrides,
      remark,
    });

    if (!result.docxBuffer) {
      return NextResponse.json({ error: "合同文件生成失败" }, { status: 500 });
    }

    return new NextResponse(new Uint8Array(result.docxBuffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(result.contractNo)}.docx"`,
      },
    });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    const msg = err instanceof Error ? err.message : "生成失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
