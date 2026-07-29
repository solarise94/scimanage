import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

/**
 * T8.1a: canonical actor-aware template query shared by GET /api/contracts/templates
 * and Agent contracts.list_templates.
 * - 销售角色 → ForbiddenError；
 * - 默认只返回未归档模板，固定排序 [category asc, isDefault desc, createdAt desc]；
 * - DTO 保持 detectedVariables 原始 JSON 字符串（admin 页面直接 JSON.parse）；
 * - Agent shape 输出稳定 6 键并解析 detectedVariables（非法 JSON → []）。
 */
describe("T8.1a listContractTemplatesForActor", () => {
  it("gates sales roles, excludes archived by default, keeps stable order and DTO/agent shapes", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        listContractTemplatesForActor,
        shapeContractTemplateForAgent,
        safeParseJsonStringArray,
      } = await import("@/lib/contracts/application/query-contract-templates");
      const { ForbiddenError } = await import("@/lib/application/errors");

      const admin = await prisma.user.create({
        data: { email: "t81a-tpl-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const repUser = await prisma.user.create({
        data: { email: "t81a-tpl-rep@example.com", name: "Rep", password: "h", role: "REPRESENTATIVE" },
      });
      const rmUser = await prisma.user.create({
        data: {
          email: "t81a-tpl-rm@example.com",
          name: "RM",
          password: "h",
          role: "REGIONAL_MANAGER",
        },
      });

      const adminActor = { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email };
      const repActor = { userId: repUser.id, role: "REPRESENTATIVE", name: "Rep", email: repUser.email };
      const rmActor = { userId: rmUser.id, role: "REGIONAL_MANAGER", name: "RM", email: rmUser.email };

      const mkTemplate = (data: {
        name: string;
        category: string;
        isDefault?: boolean;
        archived?: boolean;
        detectedVariables?: string | null;
        createdAt?: string;
      }) =>
        prisma.contractTemplate.create({
          data: {
            name: data.name,
            category: data.category,
            fileUrl: `/uploads/contract-templates/t81a/${encodeURIComponent(data.name)}/template.docx`,
            fileName: `${data.name}.docx`,
            isDefault: data.isDefault ?? false,
            archived: data.archived ?? false,
            detectedVariables: data.detectedVariables ?? null,
            createdById: admin.id,
            ...(data.createdAt ? { createdAt: new Date(data.createdAt) } : {}),
          },
        });

      const seqDefault = await mkTemplate({
        name: "测序默认",
        category: "SEQUENCING",
        isDefault: true,
        detectedVariables: JSON.stringify(["sellerName", "buyerName", "totalAmount"]),
        createdAt: "2026-01-01",
      });
      const seqNew = await mkTemplate({
        name: "测序新版",
        category: "SEQUENCING",
        detectedVariables: "not-a-json-array",
        createdAt: "2026-01-02",
      });
      const equip = await mkTemplate({ name: "设备合同", category: "EQUIPMENT" });
      const nda = await mkTemplate({ name: "保密协议", category: "NDA" });
      // 与 seqNew 同类别同 isDefault，createdAt 更晚 → 验证 createdAt desc 第三排序键
      const seqNewer = await mkTemplate({
        name: "测序最新",
        category: "SEQUENCING",
        createdAt: "2026-01-03",
      });
      const archivedSeq = await mkTemplate({
        name: "测序已归档",
        category: "SEQUENCING",
        archived: true,
      });

      // 销售角色（REP / REGIONAL_MANAGER）→ Forbidden
      await expect(listContractTemplatesForActor(repActor, {})).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listContractTemplatesForActor(rmActor, {})).rejects.toBeInstanceOf(ForbiddenError);

      // 默认：未归档 + 排序 [category asc, isDefault desc, createdAt desc]
      const { templates } = await listContractTemplatesForActor(adminActor, {});
      expect(templates.map((t) => t.id)).toEqual([
        equip.id, // EQUIPMENT
        nda.id, // NDA
        seqDefault.id, // SEQUENCING，isDefault 优先
        seqNewer.id, // SEQUENCING，非默认中最新
        seqNew.id, // SEQUENCING，非默认中较早
      ]);
      expect(templates.map((t) => t.id)).not.toContain(archivedSeq.id);

      // includeArchived：归档模板也返回
      const withArchived = await listContractTemplatesForActor(adminActor, { includeArchived: true });
      expect(withArchived.templates.map((t) => t.id)).toContain(archivedSeq.id);
      expect(withArchived.templates).toHaveLength(6);

      // category 过滤
      const seqOnly = await listContractTemplatesForActor(adminActor, { category: "SEQUENCING" });
      expect(seqOnly.templates.map((t) => t.id)).toEqual([seqDefault.id, seqNewer.id, seqNew.id]);

      // Web DTO 逐字节保持：detectedVariables 为原始 JSON 字符串，含 createdBy/全部列
      expect(typeof templates[0]?.detectedVariables === "string" || templates[0]?.detectedVariables === null).toBe(true);
      expect(seqDefault.detectedVariables).toBe(JSON.stringify(["sellerName", "buyerName", "totalAmount"]));
      expect(templates[0]?.createdBy).toEqual({ id: admin.id, name: "Admin" });
      expect(templates[0]).toHaveProperty("createdById", admin.id);
      expect(templates[0]).toHaveProperty("updatedAt");

      // Agent shape：稳定 6 键 + detectedVariables 解析（非法 JSON → []）
      const agentDefault = shapeContractTemplateForAgent(seqDefault);
      expect(agentDefault).toEqual({
        id: seqDefault.id,
        name: "测序默认",
        category: "SEQUENCING",
        isDefault: true,
        detectedVariables: ["sellerName", "buyerName", "totalAmount"],
        fileName: "测序默认.docx",
      });
      expect(shapeContractTemplateForAgent(seqNew).detectedVariables).toEqual([]);

      // safeParseJsonStringArray 边界
      expect(safeParseJsonStringArray(null)).toEqual([]);
      expect(safeParseJsonStringArray(JSON.stringify({ a: 1 }))).toEqual([]);
      expect(safeParseJsonStringArray(JSON.stringify(["x", 1, "y"]))).toEqual(["x", "y"]);
    });
  }, 120_000);
});
