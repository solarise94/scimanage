import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import PizZip from "pizzip";
import { Prisma } from "@prisma/client";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { computeFactDigest, type ContractRenderFacts } from "@/lib/contracts/fact-digest";
import { sortOrdersByInputIds } from "@/lib/contracts/ordering";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

/**
 * T8 review P1-1/P1-2 + P2 闭环测试：
 * 1. computeFactDigest 纯函数：覆盖完整渲染事实集（行项/买方/卖方/模板内容/首单项目/金额/orderIds），
 *    且 lines 顺序参与 digest（sortOrder 交换必须 mismatch）。
 * 2. sortOrdersByInputIds 纯函数（P2）：多订单按 input.orderIds 确定重排，消除
 *    preflight/tx 两次 findMany 返回顺序不一致导致的假性 digest mismatch。
 * 3. 写事务内权威授权复核（P1-1）：profile 归属改派后 -> Forbidden + 零落库（delta）。
 * 4. 写事务内完整事实 digest（P1-2）：OrderLine 变化 / 模板文件内容变化 / sortOrder 交换 /
 *    ADMIN 路径订单软删除 -> Conflict + 零落库（delta）。
 * 5. 多项目关联（P2）：isPrimary 确定选取（附件 projectId 落主关联）+ isPrimary 翻转竞态
 *    -> Conflict + 零落库。
 * 6. happy path：USER 直生成 -> GENERATED + docx/snapshot 落盘。
 *
 * e2e 全部在单个 withTempSmokeDb 内执行（prisma 全局单例不跨 withTempSmokeDb 重置，
 * 与既有测试文件 1:1 惯例一致）。每个场景用独立 profile/order/line/template 实体，
 * 零落库用 delta（前后 count 相等）断言，不受其他场景残留影响。
 *
 * ⚠️ 纯函数 describe 只能静态导入 prisma-free 模块（fact-digest / ordering）：
 * 在 withTempSmokeDb 之外 import 传递依赖 @/lib/prisma 的模块会提前实例化全局单例，
 * 使 e2e 写入真实 dev.db（已发生过污染事故，见 T8 迁移记忆 gotcha）。
 *
 * 竞态注入：$transaction 是 expected digest 计算之后、tx 复核之前的第一个 prisma 调用，
 * intent-less（Web）路径下 generateContract 只调用一次 $transaction（Phase 2）。
 * spy 在 real(fn) 前对真实 prisma 提交 mutate，使漂移落在 preflight 与事务复核之间。
 */

// ─── 最小可渲染 .docx（复制自 scripts/smoke-test-contract-generation.ts:145-174） ───
function buildTestDocx(placeholders: string[]): Buffer {
  const zip = new PizZip();
  const bodyText = placeholders.join(" ");
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t xml:space="preserve">${bodyText}</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  zip.file("word/document.xml", docXml);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  return Buffer.from(zip.generate({ type: "nodebuffer" }));
}

const TEMPLATES_DIR = path.join(process.cwd(), "public", "uploads", "contract-templates", "integrity-test");
/**
 * 合同文件根经 env 注入为进程专属临时目录（generate.ts contractsUploadRoot()
 * 运行时读取）：测试永不触碰真实 public/uploads/contracts——竞态场景 tx 回滚
 * 后渲染目录会残留，但残留在自己的临时根里，afterEach 整体删除只影响本测试。
 * 后缀区分其他同样注入的测试文件（即使共 worker 进程也不互删）。
 */
const TEST_CONTRACTS_DIR = path.join(os.tmpdir(), `scimanage-contracts-integrity-${process.pid}`);
const CONTRACT_UPLOADS_DIR_BEFORE = process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR;
const CONTRACTS_BASE = TEST_CONTRACTS_DIR;

const BASE_FACTS: ContractRenderFacts = {
  orderIds: ["order-1"],
  lines: [
    { itemName: "测序", spec: "PE150", quantity: 1, unit: "项", unitPrice: 100000, amount: 100000 },
    { itemName: "分析", spec: "", quantity: 2, unit: "份", unitPrice: 5000, amount: 10000 },
  ],
  totalCents: 110000,
  buyer: {
    buyerName: "张三",
    buyerOrgName: "测试单位",
    buyerTaxId: "91330000XXX",
    buyerAddress: "地址",
    buyerPhone: "13800000000",
    buyerEmail: "buyer@example.com",
  },
  seller: {
    id: "seller-1",
    name: "开票主体",
    taxId: "91330000YYY",
    bankName: "银行",
    bankAccount: "6228",
    address: "卖方地址",
    phone: "13900000000",
    legalRepresentative: "李四",
    archived: false,
  },
  template: { category: "SEQUENCING", archived: false, fileHash: "hash-v1" },
  primaryOrderProjectId: null,
};

describe("computeFactDigest 字段覆盖（纯函数）", () => {
  it("相同事实 -> 相同 digest", () => {
    expect(computeFactDigest(BASE_FACTS)).toBe(computeFactDigest({ ...BASE_FACTS }));
  });

  it("lines 顺序参与 digest（渲染/itemsJson 顺序敏感，sortOrder 交换须 mismatch）", () => {
    const reversed = { ...BASE_FACTS, lines: [...BASE_FACTS.lines].reverse() };
    expect(computeFactDigest(reversed)).not.toBe(computeFactDigest(BASE_FACTS));
  });

  it.each([
    ["orderIds", { ...BASE_FACTS, orderIds: ["order-1", "order-2"] }],
    ["lines content", { ...BASE_FACTS, lines: [{ ...BASE_FACTS.lines[0], amount: 999 }] }],
    ["totalCents", { ...BASE_FACTS, totalCents: BASE_FACTS.totalCents + 1 }],
    ["buyer.buyerName", { ...BASE_FACTS, buyer: { ...BASE_FACTS.buyer, buyerName: "X" } }],
    ["buyer.buyerOrgName", { ...BASE_FACTS, buyer: { ...BASE_FACTS.buyer, buyerOrgName: "X" } }],
    ["buyer.buyerTaxId", { ...BASE_FACTS, buyer: { ...BASE_FACTS.buyer, buyerTaxId: "X" } }],
    ["seller.name", { ...BASE_FACTS, seller: { ...BASE_FACTS.seller, name: "X" } }],
    ["seller.taxId", { ...BASE_FACTS, seller: { ...BASE_FACTS.seller, taxId: "X" } }],
    ["seller.bankAccount", { ...BASE_FACTS, seller: { ...BASE_FACTS.seller, bankAccount: "X" } }],
    ["seller.legalRepresentative", { ...BASE_FACTS, seller: { ...BASE_FACTS.seller, legalRepresentative: "X" } }],
    ["template.category", { ...BASE_FACTS, template: { ...BASE_FACTS.template, category: "EQUIPMENT" } }],
    ["template.fileHash", { ...BASE_FACTS, template: { ...BASE_FACTS.template, fileHash: "hash-v2" } }],
    ["primaryOrderProjectId", { ...BASE_FACTS, primaryOrderProjectId: "proj-X" }],
  ])("变化 %s -> 不同 digest", (_name, mutated) => {
    expect(computeFactDigest(mutated as ContractRenderFacts)).not.toBe(computeFactDigest(BASE_FACTS));
  });
});

describe("sortOrdersByInputIds 确定重排（纯函数，P2）", () => {
  // ⚠️ 只能静态导入 prisma-free 的 @/lib/contracts/ordering：在 withTempSmokeDb 之外
  // import 任何传递依赖 @/lib/prisma 的模块（如 generate.ts）会提前实例化全局单例，
  // 把后续 e2e 写入钉死在真实 dev.db 上（已发生过污染事故）。
  it("按 orderIds 指定顺序重排乱序查询结果；缺失项不产生占位", () => {
    const orders = [{ id: "b" }, { id: "a" }, { id: "c" }];
    expect(sortOrdersByInputIds(orders, ["a", "b", "c"]).map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(sortOrdersByInputIds(orders, ["c", "a"]).map((o) => o.id)).toEqual(["c", "a"]);
    expect(sortOrdersByInputIds(orders, ["a", "missing"])).toEqual([{ id: "a" }]);
    expect(sortOrdersByInputIds([], ["a"])).toEqual([]);
  });

  it("相同 (结果集合, orderIds) -> 相同输出顺序（preflight/tx 两次 findMany 返回乱序也一致）", () => {
    const q1 = [{ id: "x", tag: 1 }, { id: "y", tag: 2 }];
    const q2 = [{ id: "y", tag: 2 }, { id: "x", tag: 1 }]; // 模拟 findMany 返回顺序不同
    const ids = ["x", "y"];
    expect(sortOrdersByInputIds(q1, ids)).toEqual(sortOrdersByInputIds(q2, ids));
  });
});

// ─── e2e fixture ───

type PrismaSingleton = typeof import("@/lib/prisma")["prisma"];

type Common = {
  admin: { id: string };
  userA: { id: string; name: string; email: string };
  userB: { id: string };
  seller: { id: string };
  userAActor: { userId: string; role: string; name: string; email: string };
};

type Scenario = {
  profile: { id: string };
  order: { id: string };
  line: { id: string };
  line2: { id: string };
  template: { id: string };
  templateAbs: string;
};

async function setupCommon(prisma: PrismaSingleton): Promise<Common> {
  const admin = await prisma.user.create({
    data: { email: "integ-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
  });
  const userA = await prisma.user.create({
    data: { email: "integ-usera@example.com", name: "UserA", password: "h", role: "USER" },
  });
  const userB = await prisma.user.create({
    data: { email: "integ-userb@example.com", name: "UserB", password: "h", role: "USER" },
  });
  const seller = await prisma.billingProfile.create({
    data: { name: "开票主体", taxId: "91330000XXX", isDefault: true },
  });
  return {
    admin,
    userA,
    userB,
    seller,
    userAActor: { userId: userA.id, role: "USER", name: userA.name, email: userA.email },
  };
}

/** 每个场景独立 profile/order/line/template（+ docx），互不污染。userA 经 profile 归属拥有订单 scope。 */
async function setupScenario(prisma: PrismaSingleton, common: Common, label: string): Promise<Scenario> {
  const profile = await prisma.crmCustomerProfile.create({
    data: { name: `完整性客户-${label}`, ownerUserId: common.userA.id, assignmentStatus: "ASSIGNED" },
  });
  const order = await prisma.order.create({
    data: {
      orderNo: `INTEG-${label}`,
      source: "MANUAL",
      profileId: profile.id,
      title: `INTEG-${label}`,
      createdById: common.admin.id,
      totalAmount: 100_000,
      status: "CONFIRMED",
      category: "SERVICE",
    },
  });
  const line = await prisma.orderLine.create({
    data: {
      orderId: order.id,
      itemName: "测序服务",
      quantity: 1,
      unit: "项",
      unitPrice: 100_000,
      amount: 100_000,
      sortOrder: 0,
    },
  });
  // 第二行：供 sortOrder 交换竞态；金额合计仍 100_000（与 order.totalAmount 一致）
  const line2 = await prisma.orderLine.create({
    data: {
      orderId: order.id,
      itemName: "分析服务",
      quantity: 1,
      unit: "份",
      unitPrice: 0,
      amount: 0,
      sortOrder: 1,
    },
  });
  const fileUrl = `/uploads/contract-templates/integrity-test/${label}/template.docx`;
  const template = await prisma.contractTemplate.create({
    data: {
      name: `测序合同-${label}`,
      category: "SEQUENCING",
      fileUrl,
      fileName: "template.docx",
      isDefault: false,
      createdById: common.admin.id,
    },
  });
  const templateAbs = path.join(process.cwd(), "public", fileUrl);
  await fs.mkdir(path.dirname(templateAbs), { recursive: true });
  await fs.writeFile(templateAbs, buildTestDocx(["{sellerName}", "{buyerName}", "{contractNo}", "{totalAmount}"]));
  return { profile, order, line, line2, template, templateAbs };
}

async function listContractDirs(): Promise<string[]> {
  const entries = await fs.readdir(CONTRACTS_BASE).catch(() => [] as string[]);
  return entries.filter((e) => e.startsWith("ct_")).map((e) => path.join(CONTRACTS_BASE, e));
}

/**
 * 清理安全：合同文件只写进程专属临时根（TEST_CONTRACTS_DIR，env 注入），
 * afterEach 整体删除只影响本测试自己——永不扫描/删除真实 contracts 目录
 * （旧「目录名快照」方案在 readdir 失败/快照为空时会把真实 contracts 根下
 * 全部 ct_ 目录当本测试新建删除；且竞态场景 tx 回滚后的残留目录拿不到
 * contractId，任何基于 ID 所有权的方案都覆盖不全）。
 */
beforeEach(() => {
  process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR = TEST_CONTRACTS_DIR;
});

afterEach(async () => {
  await fs.rm(TEMPLATES_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(TEST_CONTRACTS_DIR, { recursive: true, force: true }).catch(() => {});
  // 恢复原值：全局 env 不能泄漏给同 worker 进程后续加载的其他测试文件
  if (CONTRACT_UPLOADS_DIR_BEFORE === undefined) {
    delete process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR;
  } else {
    process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR = CONTRACT_UPLOADS_DIR_BEFORE;
  }
});

function injectMutationBeforeTx(prisma: PrismaSingleton, mutate: () => Promise<void>) {
  const real = prisma.$transaction.bind(prisma) as typeof prisma.$transaction;
  const spy = vi.spyOn(prisma, "$transaction");
  spy.mockImplementationOnce(
    (async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      await mutate();
      return real(fn);
    }) as unknown as typeof prisma.$transaction,
  );
  return spy;
}

describe("generateContractForActor 写事务内复核（TOCTOU）", () => {
  it("happy + 竞态：授权撤销 / OrderLine / 模板 / sortOrder / ADMIN 软删除 / 多项目关联", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { generateContractForActor } = await import("@/lib/contracts/application/generate-contract");
      const { ForbiddenError, ConflictError } = await import("@/lib/application/errors");
      const common = await setupCommon(prisma);
      const adminActor = {
        userId: common.admin.id,
        role: "ADMIN",
        name: "Admin",
        email: "integ-admin@example.com",
      };

      const counts = async () => ({
        doc: await prisma.contractDocument.count(),
        cov: await prisma.orderContractCoverage.count(),
        att: await prisma.contractAttachment.count(),
      });

      // ── happy path：USER 直生成 -> GENERATED + 文件落盘 ──
      {
        const s = await setupScenario(prisma, common, "happy");
        const before = await counts();
        const result = await generateContractForActor(common.userAActor, {
          orderIds: [s.order.id],
          templateId: s.template.id,
          sellerProfileId: common.seller.id,
        });
        const after = await counts();
        expect(result.contractId).toBeTruthy();
        expect(result.docxBuffer).toBeInstanceOf(Buffer);
        expect(after.doc).toBe(before.doc + 1);
        expect(after.cov).toBe(before.cov + 1);
        expect(after.att).toBe(before.att + 1);
        const doc = await prisma.contractDocument.findUnique({ where: { id: result.contractId } });
        expect(doc?.status).toBe("GENERATED");
        expect(doc?.totalAmount).toBe(100_000);
        const docxPath = path.join(CONTRACTS_BASE, result.contractId, `${result.contractNo}.docx`);
        const snapshotPath = path.join(CONTRACTS_BASE, result.contractId, "template-snapshot.docx");
        await expect(fs.access(docxPath)).resolves.toBeUndefined();
        await expect(fs.access(snapshotPath)).resolves.toBeUndefined();
      }

      // ── P1-1 scope 撤销：profile 改派 -> Forbidden + 零落库 ──
      {
        const s = await setupScenario(prisma, common, "scope");
        const before = await counts();
        const spy = injectMutationBeforeTx(prisma, async () => {
          await prisma.crmCustomerProfile.update({
            where: { id: s.profile.id },
            data: { ownerUserId: common.userB.id },
          });
        });
        await expect(
          generateContractForActor(common.userAActor, {
            orderIds: [s.order.id],
            templateId: s.template.id,
            sellerProfileId: common.seller.id,
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        const after = await counts();
        expect(after.doc).toBe(before.doc);
        expect(after.cov).toBe(before.cov);
        expect(after.att).toBe(before.att);
        spy.mockRestore();
      }

      // ── P1-2 OrderLine 变化 -> Conflict + 零落库 ──
      {
        const s = await setupScenario(prisma, common, "line");
        const before = await counts();
        const spy = injectMutationBeforeTx(prisma, async () => {
          await prisma.orderLine.update({
            where: { id: s.line.id },
            data: { amount: 200_000 },
          });
        });
        await expect(
          generateContractForActor(common.userAActor, {
            orderIds: [s.order.id],
            templateId: s.template.id,
            sellerProfileId: common.seller.id,
          }),
        ).rejects.toBeInstanceOf(ConflictError);
        const after = await counts();
        expect(after.doc).toBe(before.doc);
        expect(after.cov).toBe(before.cov);
        expect(after.att).toBe(before.att);
        spy.mockRestore();
      }

      // ── P1-2 模板文件内容变化 -> Conflict + 零落库（快照写自 templateBuffer，渲染/快照仍一致） ──
      {
        const s = await setupScenario(prisma, common, "tpl");
        const before = await counts();
        const spy = injectMutationBeforeTx(prisma, async () => {
          await fs.writeFile(s.templateAbs, buildTestDocx(["{changed}"]));
        });
        await expect(
          generateContractForActor(common.userAActor, {
            orderIds: [s.order.id],
            templateId: s.template.id,
            sellerProfileId: common.seller.id,
          }),
        ).rejects.toBeInstanceOf(ConflictError);
        const after = await counts();
        expect(after.doc).toBe(before.doc);
        expect(after.cov).toBe(before.cov);
        expect(after.att).toBe(before.att);
        spy.mockRestore();
      }

      // ── P1-2 sortOrder 交换：展示顺序变但行内容不变 -> Conflict + 零落库 ──
      {
        const s = await setupScenario(prisma, common, "sort");
        const before = await counts();
        const spy = injectMutationBeforeTx(prisma, async () => {
          await prisma.orderLine.update({
            where: { id: s.line.id },
            data: { sortOrder: 1 },
          });
          await prisma.orderLine.update({
            where: { id: s.line2.id },
            data: { sortOrder: 0 },
          });
        });
        await expect(
          generateContractForActor(common.userAActor, {
            orderIds: [s.order.id],
            templateId: s.template.id,
            sellerProfileId: common.seller.id,
          }),
        ).rejects.toBeInstanceOf(ConflictError);
        const after = await counts();
        expect(after.doc).toBe(before.doc);
        expect(after.cov).toBe(before.cov);
        expect(after.att).toBe(before.att);
        spy.mockRestore();
      }

      // ── P1-2 ADMIN 路径软删除：scope 跳过，靠 freshOrders deleted:false 数量不符 -> Conflict + 零落库 ──
      {
        const s = await setupScenario(prisma, common, "del");
        const before = await counts();
        const spy = injectMutationBeforeTx(prisma, async () => {
          await prisma.order.update({
            where: { id: s.order.id },
            data: { deleted: true },
          });
        });
        await expect(
          generateContractForActor(adminActor, {
            orderIds: [s.order.id],
            templateId: s.template.id,
            sellerProfileId: common.seller.id,
          }),
        ).rejects.toBeInstanceOf(ConflictError);
        const after = await counts();
        expect(after.doc).toBe(before.doc);
        expect(after.cov).toBe(before.cov);
        expect(after.att).toBe(before.att);
        spy.mockRestore();
      }

      // ── P2 多项目关联：isPrimary 确定选取（附件落主关联）+ isPrimary 翻转竞态 -> Conflict + 零落库 ──
      {
        const s = await setupScenario(prisma, common, "link");
        const projA = await prisma.project.create({ data: { name: "P2 关联项目 A（先建，非主）" } });
        const projB = await prisma.project.create({ data: { name: "P2 关联项目 B（后建，主）" } });
        await prisma.orderProjectLink.create({ data: { orderId: s.order.id, projectId: projA.id } });
        await prisma.orderProjectLink.create({
          data: { orderId: s.order.id, projectId: projB.id, isPrimary: true },
        });

        // happy：一笔订单两个项目关联，附件 projectId 确定落在 isPrimary 的 B（不依赖创建/物理顺序）
        const before = await counts();
        const result = await generateContractForActor(common.userAActor, {
          orderIds: [s.order.id],
          templateId: s.template.id,
          sellerProfileId: common.seller.id,
        });
        const afterHappy = await counts();
        expect(afterHappy.att).toBe(before.att + 1);
        const att = await prisma.contractAttachment.findFirst({
          where: { contractDocumentId: result.contractId },
        });
        expect(att?.projectId).toBe(projB.id);

        // 竞态：preflight 与 tx 之间翻转 isPrimary（A 变主）-> 首单项目事实进入 digest -> Conflict + 零落库
        const mid = await counts();
        const spy = injectMutationBeforeTx(prisma, async () => {
          await prisma.orderProjectLink.updateMany({
            where: { orderId: s.order.id, projectId: projA.id },
            data: { isPrimary: true },
          });
          await prisma.orderProjectLink.updateMany({
            where: { orderId: s.order.id, projectId: projB.id },
            data: { isPrimary: false },
          });
        });
        await expect(
          generateContractForActor(common.userAActor, {
            orderIds: [s.order.id],
            templateId: s.template.id,
            sellerProfileId: common.seller.id,
          }),
        ).rejects.toBeInstanceOf(ConflictError);
        const after = await counts();
        expect(after.doc).toBe(mid.doc);
        expect(after.cov).toBe(mid.cov);
        expect(after.att).toBe(mid.att);
        spy.mockRestore();
      }
    });
  }, 120_000);
});
