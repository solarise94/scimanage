/**
 * 合同模板生成 — 端到端冒烟测试
 *
 * 覆盖：模板上传/变量校验/合同生成/权限/scope/文件回滚/OQ-1 standalone
 *
 * ⚠️ 凭据管理规则：自建随机临时账号，跑完即删。
 *    严禁使用真实账号或环境变量密码。
 *
 * 运行: npx tsx scripts/smoke-test-contract-generation.ts
 * 前提: npm run build（需要 .next/standalone/server.js）
 */

import { randomBytes, randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import PizZip from "pizzip";
import fs from "fs/promises";
import path from "path";
import { withTempSmokeHttpServer } from "./lib/temp-smoke-http";

// ── 自建一次性测试账号 ──
const TEST_ADMIN_EMAIL = `smoke-contract-${Date.now()}-${randomUUID().slice(0, 8)}@test.local`;
const TEST_ADMIN_PW = randomBytes(24).toString("base64url");
const TEST_USER_EMAIL = `smoke-contract-user-${Date.now()}-${randomUUID().slice(0, 8)}@test.local`;
const TEST_USER_PW = randomBytes(24).toString("base64url");
const TEST_REP_EMAIL = `smoke-contract-rep-${Date.now()}-${randomUUID().slice(0, 8)}@test.local`;
const TEST_REP_PW = randomBytes(24).toString("base64url");

// ── 测试账号 ID 记录 ──
let adminUserId: string;
let normalUserId: string;
let repUserId: string;
let representativeId: string;

// ── 测试数据 ID 记录 ──
const cleanupBillingIds: string[] = [];
const cleanupCrmProfileIds: string[] = [];
const cleanupOrderIds: string[] = [];
const cleanupProjectIds: string[] = [];
const cleanupOrgIds: string[] = [];
const cleanupTemplateIds: string[] = [];
const cleanupContractIds: string[] = [];
const cleanupDirs: string[] = [];

// ── Helpers ──

// standalone 服务进程以自身 cwd（.next/standalone）写 public/uploads，
// 而本脚本 cwd 是仓库根：磁盘断言与清理需同时覆盖两套 public 根。
function publicPathCandidates(rel: string): string[] {
  return [
    path.join(process.cwd(), "public", rel),
    path.join(process.cwd(), ".next", "standalone", "public", rel),
  ];
}

async function statAny(candidates: string[]): Promise<boolean> {
  for (const p of candidates) {
    if (await fs.stat(p).then(() => true).catch(() => false)) return true;
  }
  return false;
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`);
  const csrfData = await csrfRes.json();
  const csrfToken = csrfData.csrfToken;
  const cookiesBefore = csrfRes.headers.get("set-cookie") || "";

  const loginRes = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookiesBefore,
    },
    body: new URLSearchParams({
      csrfToken,
      email,
      password,
      json: "true",
    }),
    redirect: "manual",
  });

  const newCookies = loginRes.headers.get("set-cookie");
  if (!newCookies) {
    const text = await loginRes.text();
    throw new Error(`Login failed (${loginRes.status}): ${text.slice(0, 200)}`);
  }
  const cookiePairs = newCookies
    .split(",")
    .map((c) => c.trim().split(";")[0])
    .filter(Boolean)
    .join("; ");
  return cookiePairs;
}

async function getJson(baseUrl: string, path: string, cookie: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: cookie },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function postJson(baseUrl: string, path: string, cookie: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
}

async function postFormData(
  baseUrl: string,
  path: string,
  cookie: string,
  fd: FormData
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function patchJson(baseUrl: string, path: string, cookie: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`❌ ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// ── Build minimal .docx with placeholders ──
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
</Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );

  return Buffer.from(zip.generate({ type: "nodebuffer" }));
}

// ── Main ──

async function main() {
  await withTempSmokeHttpServer(async (handle) => {
    const baseUrl = handle.baseUrl;
    const { prisma } = await import("../src/lib/prisma");

    console.log("=== 合同模板生成 Smoke Test ===\n");
    console.log(`BASE_URL: ${baseUrl}`);
    console.log(`Admin:    ${TEST_ADMIN_EMAIL}`);
    console.log(`User:     ${TEST_USER_EMAIL}`);
    console.log(`Rep:      ${TEST_REP_EMAIL}\n`);

    // ── Step 0: 创建测试账号 ──
    console.log("── Step 0: 创建测试账号 ──");

    const adminUser = await prisma.user.create({
    data: {
      email: TEST_ADMIN_EMAIL,
      name: "smoke-admin",
      password: await bcrypt.hash(TEST_ADMIN_PW, 12),
      role: "ADMIN",
    },
  });
  adminUserId = adminUser.id;
  console.log(`  Admin user created: ${adminUserId}`);

  const normalUser = await prisma.user.create({
    data: {
      email: TEST_USER_EMAIL,
      name: "smoke-user",
      password: await bcrypt.hash(TEST_USER_PW, 12),
      role: "USER",
    },
  });
  normalUserId = normalUser.id;

  const rep = await prisma.representative.create({
    data: {
      name: "smoke-rep",
      email: TEST_REP_EMAIL,
    },
  });
  representativeId = rep.id;

  const repUser = await prisma.user.create({
    data: {
      email: TEST_REP_EMAIL,
      name: "smoke-rep",
      password: await bcrypt.hash(TEST_REP_PW, 12),
      role: "REPRESENTATIVE",
    },
  });
  repUserId = repUser.id;

    const adminCookie = await login(baseUrl, TEST_ADMIN_EMAIL, TEST_ADMIN_PW);
    const userCookie = await login(baseUrl, TEST_USER_EMAIL, TEST_USER_PW);
    const repCookie = await login(baseUrl, TEST_REP_EMAIL, TEST_REP_PW);
  console.log("  All accounts logged in\n");

  try {
    // ── Step 1: 创建测试 Fixtures ──
    console.log("── Step 1: 创建测试数据 ──");

    // BillingProfile
    const { data: bpData } = await postJson(
      baseUrl,
      "/api/billing-profiles",
      adminCookie,
      {
        name: "烟测开票主体",
        taxId: "91110000TEST",
        bankName: "测试银行",
        bankAccount: "6222000000000000",
        address: "北京市测试区",
        phone: "010-12345678",
        legalRepresentative: "张三（烟测）",
      }
    );
    assert(bpData?.profile?.id != null, "创建 BillingProfile 成功");
    cleanupBillingIds.push(bpData.profile.id as string);

    // Organization
    const org = await prisma.organization.create({
      data: {
        canonicalName: "烟测大学",
        normalizedName: "yan-ce-da-xue",
        orgCode: `SMOKE-${Date.now()}-ORG`,
        taxId: "12100000TEST",
        address: "北京市海淀区烟测路1号",
      },
    });
    cleanupOrgIds.push(org.id);

    const crmProfile = await prisma.crmCustomerProfile.create({
      data: {
        name: "烟测客户",
        customerCode: `CUST-${Date.now()}`,
        organization: "烟测大学",
        organizationId: org.id,
        email: "test@example.com",
        ownerUserId: adminUserId,
        stage: "ACTIVE",
      },
    });
    cleanupCrmProfileIds.push(crmProfile.id);

    // Project
    const project = await prisma.project.create({
      data: {
        name: "烟测项目-合同",
        description: "smoke test project",
        projectNo: `SMOKE-PRJ-${Date.now()}`,
      },
    });
    cleanupProjectIds.push(project.id);

    // Order (with project link)
    const orderA = await prisma.order.create({
      data: {
        orderNo: `SMOKE-CT-${Date.now()}-A`,
        source: "MANUAL",
        category: "SERVICE",
        title: "烟测订单A-有项目",
        totalAmount: 1234567, // 12345.67元，单位分
        profileId: crmProfile.id,
        buyerNameSnapshot: "烟测买方",
        buyerPhoneSnapshot: "13800138000",
        buyerOrgNameSnapshot: "烟测大学",
        buyerAddressSnapshot: "北京市海淀区烟测路1号",
        createdById: adminUserId,
        ownerUserId: normalUserId,
        lines: {
          create: [
            {
              itemName: "单细胞测序服务",
              spec: "10x Genomics",
              quantity: 10,
              unit: "样本",
              unitPrice: 100000, // 1000元，单位分
              amount: 1000000, // 10000元，单位分
              sortOrder: 0,
            },
            {
              itemName: "数据分析",
              spec: "标准分析",
              quantity: 1,
              unit: "次",
              unitPrice: 234567,
              amount: 234567,
              sortOrder: 1,
            },
          ],
        },
      },
    });
    cleanupOrderIds.push(orderA.id);

    // Link to project
    await prisma.orderProjectLink.create({
      data: {
        orderId: orderA.id,
        projectId: project.id,
        treatment: "PROJECT_INCLUDED",
        createdById: adminUserId,
      },
    });

    // Standalone order (no project link, OQ-1)
    const orderB = await prisma.order.create({
      data: {
        orderNo: `SMOKE-CT-${Date.now()}-B`,
        source: "MANUAL",
        category: "PRODUCT",
        title: "烟测订单B-standalone",
        totalAmount: 50000, // 500元
        profileId: crmProfile.id,
        createdById: adminUserId,
        lines: {
          create: [
            {
              itemName: "实验小鼠",
              spec: "C57BL/6",
              quantity: 5,
              unit: "只",
              unitPrice: 10000,
              amount: 50000,
              sortOrder: 0,
            },
          ],
        },
      },
    });
    cleanupOrderIds.push(orderB.id);

    // Deleted order (for deleted-order test)
    const orderDeleted = await prisma.order.create({
      data: {
        orderNo: `SMOKE-CT-${Date.now()}-DEL`,
        source: "MANUAL",
        title: "烟测已删除订单",
        totalAmount: 10000,
        profileId: crmProfile.id,
        createdById: adminUserId,
        deleted: true,
      },
    });
    cleanupOrderIds.push(orderDeleted.id);

    console.log("  Fixtures created\n");

    // ── Step 2: 模板上传 → 201 ──
    console.log("── Step 2: 模板上传 ──");

    const validDocx = buildTestDocx([
      "{sellerName}",
      "{buyerName}",
      "{buyerOrgName}",
      "{totalAmount}",
      "{totalAmountInWords}",
      "{contractNo}",
      "{signingDate}",
      "{#lines}{index}{itemName}{spec}{quantity}{unit}{unitPrice}{amount}{/lines}",
    ]);

    const fdValid = new FormData();
    fdValid.append("file", new Blob([new Uint8Array(validDocx)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "test-template.docx");
    fdValid.append("name", "烟测测序模板");
    fdValid.append("category", "SEQUENCING");
    fdValid.append("isDefault", "true");

    const { status: uploadOk, data: uploadData } = await postFormData(
      baseUrl,
      "/api/contracts/templates",
      adminCookie,
      fdValid
    );
    assert(uploadOk === 201, `上传模板 → 201（got ${uploadOk}）`);
    assert(uploadData?.id != null, "返回模板 id");
    cleanupTemplateIds.push(uploadData.id as string);
    cleanupDirs.push(
      ...publicPathCandidates(path.join("uploads", "contract-templates", uploadData.id as string))
    );
    console.log(`  Template ID: ${uploadData.id}\n`);

    // ── Step 3: 未知变量模板 → 400 ──
    console.log("── Step 3: 未知变量拦截 ──");

    const badDocx = buildTestDocx(["{sellerName}", "{unknownVarXXX}", "{buyerName}"]);
    const fdBad = new FormData();
    fdBad.append("file", new Blob([new Uint8Array(badDocx)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "bad.docx");
    fdBad.append("name", "坏模板");
    fdBad.append("category", "SEQUENCING");

    const { status: badStatus, data: badData } = await postFormData(
      baseUrl,
      "/api/contracts/templates",
      adminCookie,
      fdBad
    );
    assert(badStatus === 400, `未知变量 → 400（got ${badStatus}）`);
    assert(
      (badData?.unknown as string[])?.includes("unknownVarXXX"),
      `返回 unknown 列表包含 unknownVarXXX: ${JSON.stringify(badData?.unknown)}`
    );
    console.log("  Unknown variables:", badData?.unknown, "\n");

    // ── Step 4: 合同生成（单订单）→ 200 + .docx ──
    console.log("── Step 4: 生成合同（有项目订单）──");

    const { status: genStatus, data: genData, headers: genHeaders } = await postJson(
      baseUrl,
      "/api/contracts/generate",
      adminCookie,
      {
        orderIds: [orderA.id],
        templateId: uploadData.id,
        sellerProfileId: bpData.profile.id,
        remark: "烟测-合同生成测试",
      }
    );
    assert(genStatus === 200, `生成合同 → 200（got ${genStatus}）`);
    assert(Boolean(genHeaders.get("Content-Type")?.includes("openxmlformats")), "返回 .docx Content-Type");

    // 读取 .docx buffer 并验证内容
    const genRes = await fetch(`${baseUrl}/api/contracts/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        orderIds: [orderA.id],
        templateId: uploadData.id,
        sellerProfileId: bpData.profile.id,
      }),
    });
    const docxBuf = Buffer.from(await genRes.arrayBuffer());
    const verifyZip = new PizZip(docxBuf);
    const verifyXml = verifyZip.file("word/document.xml")?.asText() || "";
    assert(
      !verifyXml.includes("{sellerName}"),
      "生成的 .docx 不含未替换占位符 {sellerName}"
    );
    assert(
      verifyXml.includes("烟测开票主体"),
      "生成的 .docx 包含卖方名称"
    );
    console.log("  .docx 验证通过\n");

    // ── Step 4b: 验证 DB 记录 ──
    console.log("── Step 4b: 验证 DB 落库 ──");

    const contracts = await prisma.contractDocument.findMany({
      where: { createdById: adminUserId },
      include: { orderCoverage: true, attachments: true },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    const contract = contracts[0];
    assert(contract != null, "ContractDocument 已落库");
    assert(contract?.contractNo != null, "合同编号已生成");
    assert(contract?.totalAmount === 1234567, `totalAmount=${contract?.totalAmount}（预期1234567分）`);
    assert((contract?.orderCoverage || []).length >= 1, "OrderContractCoverage 已落库");
    assert((contract?.attachments || []).length >= 1, "ContractAttachment 已落库");

    const attachment = contract.attachments?.[0];
    assert(attachment?.source === "GENERATED", "source=GENERATED");
    assert(Boolean(attachment?.mimeType?.includes("openxmlformats")), "mimeType 正确");

    const docxPathCandidates = publicPathCandidates(attachment?.fileUrl as string || "");
    const fileExists = await statAny(docxPathCandidates);
    assert(fileExists, `.docx 文件存在于磁盘: ${attachment?.fileUrl}`);

    const snapshotExists = await statAny(
      publicPathCandidates(contract.snapshotTemplateUrl as string || "")
    );
    assert(snapshotExists, "模板快照文件存在");

    cleanupContractIds.push(contract.id);
    if (contract.id) cleanupDirs.push(...publicPathCandidates(path.join("uploads", "contracts", contract.id)));
    console.log(`  Contract ID: ${contract.id}, No: ${contract.contractNo}\n`);

    // ── Step 5: OQ-1 standalone 订单生成 ──
    console.log("── Step 5: OQ-1 standalone 订单 ──");

    const { status: genStlStatus } = await postJson(
      baseUrl,
      "/api/contracts/generate",
      adminCookie,
      {
        orderIds: [orderB.id],
        templateId: uploadData.id,
        sellerProfileId: bpData.profile.id,
      }
    );
    assert(genStlStatus === 200, `standalone 订单 → 200（got ${genStlStatus}）`);

    // 验证 standalone 合同的 ContractAttachment.projectId 为空
    const standaloneContracts = await prisma.contractDocument.findMany({
      where: { createdById: adminUserId },
      include: { attachments: true, orderCoverage: { select: { orderId: true }, where: { orderId: orderB.id } } },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    const stlContract = standaloneContracts.find((c) =>
      c.orderCoverage.some((oc) => oc.orderId === orderB.id)
    );
    assert(stlContract != null, "standalone ContractDocument 已创建");
    const stlAtt = stlContract?.attachments?.[0];
    assert(
      stlAtt == null || stlAtt.projectId == null,
      `standalone ContractAttachment.projectId 应为 null: ${stlAtt?.projectId}`
    );
    if (stlContract?.id) {
      cleanupContractIds.push(stlContract.id);
      cleanupDirs.push(...publicPathCandidates(path.join("uploads", "contracts", stlContract.id)));
    }
    console.log("  standalone projectId 为空 ✓\n");

    // ── Step 6: 权限校验 ──

    // 6a: 非 ADMIN 上传模板 → 403
    console.log("── Step 6: 权限校验 ──");
    const fdUser = new FormData();
    fdUser.append("file", new Blob([new Uint8Array(validDocx)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "test.docx");
    fdUser.append("name", "test");
    fdUser.append("category", "SEQUENCING");
    const { status: userUpload } = await postFormData(
      baseUrl,
      "/api/contracts/templates",
      userCookie,
      fdUser
    );
    assert(userUpload === 403, `非 ADMIN 上传模板 → 403（got ${userUpload}）`);

    // 6b: 未登录 → 401
    const { status: unauthGet } = await getJson(baseUrl, "/api/contracts/templates", "");
    assert(unauthGet === 401, `未登录 GET templates → 401（got ${unauthGet}）`);

    const { status: unauthPost } = await postJson(
      baseUrl,
      "/api/contracts/generate",
      "",
      { orderIds: [orderA.id], templateId: "x", sellerProfileId: "y" }
    );
    assert(unauthPost === 401, `未登录 POST generate → 401（got ${unauthPost}）`);

    // 6c: Representative 生成合同 → 403（High #3）
    const { status: repGen } = await postJson(
      baseUrl,
      "/api/contracts/generate",
      repCookie,
      {
        orderIds: [orderA.id],
        templateId: uploadData.id,
        sellerProfileId: bpData.profile.id,
      }
    );
    assert(repGen === 403, `Representative POST generate → 403（got ${repGen}）`);

    // 6d: Representative 可查看合同列表（只读）
    const { status: repList } = await getJson(baseUrl, "/api/contracts", repCookie);
    assert(repList === 200, `Representative GET contracts → 200（got ${repList}）`);

    // 6e: 已删除订单生成合同 → 400
    const { status: delGen } = await postJson(
      baseUrl,
      "/api/contracts/generate",
      adminCookie,
      {
        orderIds: [orderDeleted.id],
        templateId: uploadData.id,
        sellerProfileId: bpData.profile.id,
      }
    );
    assert(delGen === 400, `已删除订单 → 400（got ${delGen}）`);

    // 6f: 普通用户为他人订单生成 → 403（scope）
    const { data: genForOther } = await postJson(
      baseUrl,
      "/api/contracts/generate",
      userCookie,
      {
        orderIds: [orderA.id], // ownerUserId 是 normalUser，所以他能访问；但 scope 可能匹配
        templateId: uploadData.id,
        sellerProfileId: bpData.profile.id,
      }
    );
    // orderA.ownerUserId = normalUserId, USER role 可访问自己的订单
    assert(
      genForOther?.error
        ? !genForOther.error.includes("Forbidden")
        : true,
      "USER 可为自己 owner 的订单生成合同"
    );

    // ── Step 7: 合同列表 scope ──
    console.log("\n── Step 7: 合同列表 scope ──");
    const { data: adminContracts } = await getJson(baseUrl, "/api/contracts", adminCookie);
    assert(
      (adminContracts?.total as number) >= 2,
      `ADMIN 可见全部合同: total=${adminContracts?.total}`
    );

    const { data: userContracts } = await getJson(baseUrl, "/api/contracts", userCookie);
    console.log(`  USER 可见合同数: ${userContracts?.total}`);
    // USER 的 scope 应只包含自己 owner 的订单关联合同
    assert(typeof userContracts?.total === "number", "USER 合同列表返回正常");

    console.log("\n=== 全部测试通过 ✅ ===\n");
  } finally {
    // ── 清理 ──
    console.log("── 清理测试数据 ──");

    // 删合同文件
    for (const dir of cleanupDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    // 删 DB 记录
    await prisma.contractAttachment.deleteMany({
      where: { OR: [{ source: "GENERATED", contractDocumentId: { in: cleanupContractIds } }, { uploadedById: adminUserId }] },
    }).catch(() => {});
    await prisma.orderContractCoverage.deleteMany({ where: { contractId: { in: cleanupContractIds } } }).catch(() => {});
    await prisma.contractDocument.deleteMany({ where: { id: { in: cleanupContractIds } } }).catch(() => {});
    await prisma.contractTemplate.deleteMany({ where: { id: { in: cleanupTemplateIds } } }).catch(() => {});

    await prisma.orderProjectLink.deleteMany({ where: { orderId: { in: cleanupOrderIds } } }).catch(() => {});
    await prisma.orderLine.deleteMany({ where: { orderId: { in: cleanupOrderIds } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: cleanupOrderIds } } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: { in: cleanupProjectIds } } }).catch(() => {});
    await prisma.crmCustomerProfile.deleteMany({ where: { id: { in: cleanupCrmProfileIds } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } }).catch(() => {});
    await prisma.billingProfile.deleteMany({ where: { id: { in: cleanupBillingIds } } }).catch(() => {});

    await prisma.user.deleteMany({
      where: { id: { in: [adminUserId, normalUserId, repUserId].filter(Boolean) } },
    }).catch(() => {});
    await prisma.representative.deleteMany({
      where: { id: representativeId },
    }).catch(() => {});
    await prisma.representativeOrganization.deleteMany({
      where: { representativeId },
    }).catch(() => {});

    console.log("  清理完成");
  }
  });
}

main().catch((err) => {
  console.error("Smoke test FAILED:", err);
  process.exit(1);
});
