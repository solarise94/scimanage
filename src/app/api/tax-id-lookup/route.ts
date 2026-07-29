import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isRepresentative } from "@/lib/permissions";
import { lookupOrgByName } from "@/lib/invoice-org-api";

/**
 * 税号/发票四要素查询接口。
 *
 * 用机构名调用云市场发票 API（lookupOrgByName），返回候选列表（含税号 + 四要素），
 * 供前端 TaxIdLookupInput 组件展示候选、由 ADMIN 人工确认选用。
 *
 * 候选按 API 返回的 frequency 降序排列（frequency 越高越可能是目标单位）。
 */

export interface TaxIdCandidate {
  name: string;
  taxId: string;
  /** 发票四要素（API 命中时填齐） */
  unitAddress: string;
  unitPhone: string;
  bankName: string;
  bankNo: string;
  /** 置信度：按 frequency 归一化到 0-1，最高频=1.0 */
  confidence: number;
  source: string;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isRepresentative(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { query } = body as { query?: string };
  if (!query?.trim()) {
    return NextResponse.json({ error: "请输入机构名称" }, { status: 400 });
  }

  const q = query.trim();

  try {
    let results: Awaited<ReturnType<typeof lookupOrgByName>> = [];
    try {
      results = await lookupOrgByName(q);
    } catch {
      // invoice API 不可用（未配置凭据 / 网络错误）
      return NextResponse.json({ error: "发票查询服务不可用", candidates: [] }, { status: 503 });
    }

    if (results.length === 0) {
      return NextResponse.json({ candidates: [] });
    }

    // frequency 最高的作为基准，归一化 confidence
    const maxFreq = Math.max(...results.map((r) => (r as { frequency?: number }).frequency ?? 1), 1);

    const candidates: TaxIdCandidate[] = results.slice(0, 8).map((r) => {
      const freq = (r as unknown as { frequency?: number }).frequency ?? 1;
      return {
        name: r.unitName,
        taxId: r.unitTaxNo,
        unitAddress: r.unitAddress,
        unitPhone: r.unitPhone,
        bankName: r.bankName,
        bankNo: r.bankNo,
        confidence: Math.round((freq / maxFreq) * 100) / 100,
        source: "发票API",
      };
    });

    return NextResponse.json({ candidates });
  } catch (err) {
    console.error("Tax ID lookup error:", err);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }
}
