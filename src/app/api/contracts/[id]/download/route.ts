import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { businessActorFromSessionUser } from "@/lib/application/actor";
import { ApplicationError, ConflictError, NotFoundError } from "@/lib/application/errors";
import { prisma } from "@/lib/prisma";
import { assertContractCoverageReadableForActor } from "@/lib/contracts/application/get-contract-detail";
import { resolveContractFilePath } from "@/lib/contracts/storage";
import fs from "fs/promises";

// T8.4 起走 canonical application service：全覆盖 scope fail-closed（C2），
// partial/none -> 404（不以 403 泄露存在性）；PENDING_FILE -> 409；文件缺失 -> 404。
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const actor = businessActorFromSessionUser(session.user);
    const { id } = await params;

    // 加载合同覆盖订单 + GENERATED 附件（取第一个）
    const contract = await prisma.contractDocument.findUnique({
      where: { id },
      include: {
        orderCoverage: { select: { orderId: true } },
        attachments: {
          where: { source: "GENERATED" },
          select: { fileUrl: true, fileName: true },
          take: 1,
        },
      },
    });
    if (!contract) throw new NotFoundError();

    // 全覆盖 scope fail-closed（partial/none -> NotFound，不泄露存在性）
    await assertContractCoverageReadableForActor(
      actor,
      contract.orderCoverage.map((oc) => oc.orderId),
    );

    // 授权后暴露状态信息
    if (contract.status === "PENDING_FILE") {
      throw new ConflictError("合同文件尚未归档完成，请稍后重试");
    }

    const attachment = contract.attachments[0];
    if (!attachment?.fileUrl) {
      throw new NotFoundError("合同文件不存在");
    }

    const absPath = resolveContractFilePath(attachment.fileUrl);
    try {
      const buffer = await fs.readFile(absPath);
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(attachment.fileName || `${contract.contractNo}.docx`)}"`,
        },
      });
    } catch {
      return NextResponse.json({ error: "合同文件读取失败" }, { status: 500 });
    }
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}
