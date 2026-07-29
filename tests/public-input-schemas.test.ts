/**
 * P1-1 测试：public tool 输入 Zod 严格校验。
 *
 * 覆盖：
 *  - 未知字段被拒 / 缺必填被拒 / 非法枚举被拒 / 空字符串被拒 / 超长文本被拒；
 *  - 金额边界（0、负数、超上限）；
 *  - propose_invoice：orderId+projectId 同给被拒、都不给被拒、只给一个通过；
 *  - 模型提交 internal action key 作为 publicToolKey 仍被拒（UNKNOWN_PUBLIC_TOOL）；
 *  - manifest↔Zod parity（properties key 集 + required 集一致）。
 *
 * 纯 schema / executor 安全门测试无需数据库（executor 在 schema 校验失败时 fail-closed，
 * 不会进入需要 prisma 的 facade handler）。manifest↔Zod parity 也是纯结构断言。
 *
 * ⚠️ 顶层只允许 type-only import：executePublicTool 经 registry → @/lib/prisma，
 * 必须在动态 import 之前不触碰 prisma 单例。本文件的 executePublicTool 用例只走 schema
 * 失败路径，handler 永不执行；但 import 链仍会触发 prisma 实例化，故用动态 import 隔离。
 */
import { describe, expect, it } from "vitest";
import {
  PUBLIC_INPUT_SCHEMAS,
  PROPOSE_INVOICE_INPUT,
  MAX_PUBLIC_AMOUNT_YUAN,
  formatZodIssueMessage,
} from "@/lib/agent-actions/public/input-schemas";
import { PUBLIC_TOOL_MANIFEST } from "@/lib/agent-actions/public/manifest";
import { z } from "zod";

// ── 纯 schema 级别测试（无 prisma） ──

describe("public input schemas — basic rejection cases", () => {
  it("rejects unknown fields (strict)", () => {
    const r = PUBLIC_INPUT_SCHEMAS.get_customer!.safeParse({ customerId: "c1", bogus: 1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].code).toBe("unrecognized_keys");
    }
  });

  it("rejects missing required field", () => {
    const r = PUBLIC_INPUT_SCHEMAS.get_customer!.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].code).toBe("invalid_type");
      expect(r.error.issues[0].path).toEqual(["customerId"]);
    }
  });

  it("rejects invalid enum value", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.find_orders as z.ZodType).safeParse({
      financialView: "bogus_view",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // zod v4: invalid_value（含 values 数组）
      const issue = r.error.issues[0];
      expect(issue.code).toBe("invalid_value");
    }
  });

  it("rejects empty string for id field", () => {
    const r = PUBLIC_INPUT_SCHEMAS.get_customer!.safeParse({ customerId: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].code).toBe("too_small");
      expect(r.error.issues[0].path).toEqual(["customerId"]);
    }
  });

  it("rejects overly long text (propose_project.name max 2000)", () => {
    const longText = "x".repeat(2001);
    const r = (PUBLIC_INPUT_SCHEMAS.propose_project as z.ZodType).safeParse({
      name: longText,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].code).toBe("too_big");
      expect(r.error.issues[0].path).toEqual(["name"]);
    }
  });

  it("rejects overly long content (propose_ticket_reply max 5000)", () => {
    const longText = "x".repeat(5001);
    const r = (PUBLIC_INPUT_SCHEMAS.propose_ticket_reply as z.ZodType).safeParse({
      ticketId: "t1",
      content: longText,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].code).toBe("too_big");
      expect(r.error.issues[0].path).toEqual(["content"]);
    }
  });

  it("accepts valid maximal text boundary (propose_ticket_reply 5000)", () => {
    const maxText = "x".repeat(5000);
    const r = (PUBLIC_INPUT_SCHEMAS.propose_ticket_reply as z.ZodType).safeParse({
      ticketId: "t1",
      content: maxText,
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty orderIds array", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.prepare_contract as z.ZodType).safeParse({ orderIds: [] });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].code).toBe("too_small");
      expect(r.error.issues[0].path).toEqual(["orderIds"]);
    }
  });

  it("rejects orderIds array with >50 elements", () => {
    const ids = Array.from({ length: 51 }, (_, i) => `o${i}`);
    const r = (PUBLIC_INPUT_SCHEMAS.prepare_contract as z.ZodType).safeParse({ orderIds: ids });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].code).toBe("too_big");
    }
  });

  it("rejects empty-string element in orderIds", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.prepare_contract as z.ZodType).safeParse({ orderIds: ["ok", ""] });
    expect(r.success).toBe(false);
  });

  it("rejects non-array orderIds", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.prepare_contract as z.ZodType).safeParse({ orderIds: "o1" });
    expect(r.success).toBe(false);
  });
});

describe("public input schemas — amount boundaries", () => {
  it("rejects zero amount", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.propose_receipt as z.ZodType).safeParse({
      organizationId: "o1",
      amountYuan: 0,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(["amountYuan"]);
    }
  });

  it("rejects negative amount", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.propose_receipt as z.ZodType).safeParse({
      organizationId: "o1",
      amountYuan: -100,
    });
    expect(r.success).toBe(false);
  });

  it("rejects amount above MAX_PUBLIC_AMOUNT_YUAN (10_000_000)", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.propose_receipt as z.ZodType).safeParse({
      organizationId: "o1",
      amountYuan: MAX_PUBLIC_AMOUNT_YUAN + 0.01,
    });
    expect(r.success).toBe(false);
  });

  it("accepts amount exactly at MAX_PUBLIC_AMOUNT_YUAN (boundary inclusive)", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.propose_receipt as z.ZodType).safeParse({
      organizationId: "o1",
      amountYuan: MAX_PUBLIC_AMOUNT_YUAN,
    });
    expect(r.success).toBe(true);
  });

  it("rejects non-number amount (string)", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.propose_receipt as z.ZodType).safeParse({
      organizationId: "o1",
      amountYuan: "100",
    });
    expect(r.success).toBe(false);
  });

  it("accepts tiny positive amount", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.propose_receipt as z.ZodType).safeParse({
      organizationId: "o1",
      amountYuan: 0.01,
    });
    expect(r.success).toBe(true);
  });

  it("rejects budgetAmountYuan above max for propose_project", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.propose_project as z.ZodType).safeParse({
      name: "p",
      budgetAmountYuan: MAX_PUBLIC_AMOUNT_YUAN + 1,
    });
    expect(r.success).toBe(false);
  });
});

// ── propose_invoice XOR（orderId XOR projectId）──

describe("propose_invoice — orderId XOR projectId", () => {
  it("rejects when both orderId and projectId provided", () => {
    const r = PROPOSE_INVOICE_INPUT.safeParse({
      orderId: "o1",
      projectId: "p1",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // refine → custom code；消息含中文可读描述。
      const msg = formatZodIssueMessage(PROPOSE_INVOICE_INPUT, r.error.issues[0]);
      expect(msg).toContain("二选一");
    }
  });

  it("rejects when neither orderId nor projectId provided", () => {
    const r = PROPOSE_INVOICE_INPUT.safeParse({ amountYuan: 100 });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatZodIssueMessage(PROPOSE_INVOICE_INPUT, r.error.issues[0]);
      expect(msg).toContain("二选一");
    }
  });

  it("rejects when both empty strings", () => {
    const r = PROPOSE_INVOICE_INPUT.safeParse({ orderId: "", projectId: "" });
    expect(r.success).toBe(false);
  });

  it("accepts when only orderId provided", () => {
    const r = PROPOSE_INVOICE_INPUT.safeParse({ orderId: "o1" });
    expect(r.success).toBe(true);
  });

  it("accepts when only projectId provided", () => {
    const r = PROPOSE_INVOICE_INPUT.safeParse({ projectId: "p1" });
    expect(r.success).toBe(true);
  });

  it("accepts orderId with optional amountYuan and invoiceType", () => {
    const r = PROPOSE_INVOICE_INPUT.safeParse({
      orderId: "o1",
      amountYuan: 1000,
      invoiceType: "VAT_SPECIAL",
    });
    expect(r.success).toBe(true);
  });
});

// ── find_contracts：orderId/customerId 至少提供一个 ──

describe("find_contracts — at least one of orderId/customerId", () => {
  it("rejects when neither orderId nor customerId provided", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.find_contracts as z.ZodType).safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatZodIssueMessage(PUBLIC_INPUT_SCHEMAS.find_contracts!, r.error.issues[0]);
      expect(msg).toContain("至少提供一个");
    }
  });

  it("accepts when only orderId provided", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.find_contracts as z.ZodType).safeParse({ orderId: "o1" });
    expect(r.success).toBe(true);
  });

  it("accepts when only customerId provided", () => {
    const r = (PUBLIC_INPUT_SCHEMAS.find_contracts as z.ZodType).safeParse({ customerId: "c1" });
    expect(r.success).toBe(true);
  });
});

// ── manifest↔Zod parity ──

describe("manifest ↔ Zod parity", () => {
  it("every manifest public tool has a matching Zod schema", () => {
    for (const entry of PUBLIC_TOOL_MANIFEST) {
      expect(PUBLIC_INPUT_SCHEMAS[entry.publicTool], `missing schema for ${entry.publicTool}`).toBeDefined();
    }
  });

  it("no Zod schema exists for an unknown public tool key", () => {
    expect(PUBLIC_INPUT_SCHEMAS["totally_made_up_tool"]).toBeUndefined();
  });

  it("properties key set matches between manifest JSON Schema and Zod schema for every tool", () => {
    for (const entry of PUBLIC_TOOL_MANIFEST) {
      const schema = PUBLIC_INPUT_SCHEMAS[entry.publicTool]!;
      const manifestProps = Object.keys(entry.publicInput.properties ?? {}).sort();
      // 提取 Zod object 的顶层字段名
      const zodProps = Object.keys((schema as z.ZodObject).shape).sort();
      expect(zodProps, `properties mismatch for ${entry.publicTool}`).toEqual(manifestProps);
    }
  });

  it("required key set matches between manifest JSON Schema and Zod schema for every tool", () => {
    for (const entry of PUBLIC_TOOL_MANIFEST) {
      const schema = PUBLIC_INPUT_SCHEMAS[entry.publicTool]!;
      const manifestRequired = ((entry.publicInput.required as string[] | undefined) ?? []).slice().sort();
      // Zod required = 字段不是 optional 的
      const shape = (schema as z.ZodObject).shape as Record<string, z.ZodType>;
      const zodRequired = Object.entries(shape)
        .filter(([, v]) => !v.isOptional())
        .map(([k]) => k)
        .sort();
      expect(zodRequired, `required mismatch for ${entry.publicTool}`).toEqual(manifestRequired);
    }
  });
});

// ── formatZodIssueMessage —— 中文可读输出 ──

describe("formatZodIssueMessage — Chinese actionable output", () => {
  it("formats unknown-field error with allowed-keys hint", () => {
    const schema = PUBLIC_INPUT_SCHEMAS.get_customer!;
    const r = schema.safeParse({ customerId: "c1", bogus: 1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatZodIssueMessage(schema, r.error.issues[0]);
      expect(msg).toContain("未知字段");
      expect(msg).toContain("bogus");
      expect(msg).toContain("允许的字段");
    }
  });

  it("formats missing-required error", () => {
    const schema = PUBLIC_INPUT_SCHEMAS.get_customer!;
    const r = schema.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatZodIssueMessage(schema, r.error.issues[0]);
      expect(msg).toContain("customerId");
      expect(msg).toContain("缺失");
    }
  });

  it("formats empty-string error", () => {
    const schema = PUBLIC_INPUT_SCHEMAS.get_customer!;
    const r = schema.safeParse({ customerId: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatZodIssueMessage(schema, r.error.issues[0]);
      expect(msg).toContain("customerId");
      expect(msg).toContain("空字符串");
    }
  });

  it("formats enum error with allowed values", () => {
    const schema = PUBLIC_INPUT_SCHEMAS.find_orders as z.ZodType;
    const r = schema.safeParse({ financialView: "nope" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatZodIssueMessage(schema, r.error.issues[0]);
      expect(msg).toContain("financialView");
      expect(msg).toContain("枚举值");
      expect(msg).toContain("any");
      expect(msg).toContain("pending_receipt");
      expect(msg).toContain("settled");
    }
  });

  it("formats amount-too-large error", () => {
    const schema = PUBLIC_INPUT_SCHEMAS.propose_receipt as z.ZodType;
    const r = schema.safeParse({ organizationId: "o1", amountYuan: MAX_PUBLIC_AMOUNT_YUAN + 1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatZodIssueMessage(schema, r.error.issues[0]);
      expect(msg).toContain("amountYuan");
      expect(msg).toContain("过大");
    }
  });

  it("formats custom refine message verbatim", () => {
    const schema = PROPOSE_INVOICE_INPUT;
    const r = schema.safeParse({ orderId: "o1", projectId: "p1" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatZodIssueMessage(schema, r.error.issues[0]);
      expect(msg).toContain("二选一");
    }
  });
});

// ── executor 安全门：internal action key 被拒 ──

describe("executePublicTool — internal action key still rejected (UNKNOWN_PUBLIC_TOOL)", () => {
  it("rejects raw internal action key as publicToolKey", async () => {
    // 动态 import：executePublicTool 经 registry → @/lib/prisma。
    // 本用例在 manifest 查不到 key 即返回，不会触发 prisma；但 import 链仍会执行。
    // 安全起见仍用动态 import（与 phase-b 习惯一致）。
    const { executePublicTool } = await import("@/lib/agent-actions/public/public-executor");
    const outcome = await executePublicTool({
      actor: { userId: "u1", role: "ADMIN" },
      invocation: { channel: "agent" },
      publicToolKey: "orders.search", // internal action key，非 public tool
      publicInput: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("UNKNOWN_PUBLIC_TOOL");
      expect(outcome.status).toBe(404);
    }
  });

  it("rejects totally unknown publicToolKey", async () => {
    const { executePublicTool } = await import("@/lib/agent-actions/public/public-executor");
    const outcome = await executePublicTool({
      actor: { userId: "u1", role: "ADMIN" },
      invocation: { channel: "agent" },
      publicToolKey: "totally_made_up",
      publicInput: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("UNKNOWN_PUBLIC_TOOL");
    }
  });
});

// ── 500 兜底：未知错误不泄露 err.message（问题 5） ──

describe("executePublicTool — 500 fallback does not leak internal error message", () => {
  it("returns generic message + PUBLIC_TOOL_ERROR when facade throws non-ApplicationError", async () => {
    const {
      executePublicTool,
      registerPublicFacade,
      __clearPublicFacadeRegistryForTests,
    } = await import("@/lib/agent-actions/public/public-executor");

    __clearPublicFacadeRegistryForTests();

    // 注册一个会抛「敏感内部错误」的 facade（模拟 canonical service 抛 raw Error 含内部细节）。
    const SENSITIVE = "Database connection failed: postgres://user:secret@internal-host:5432/db";
    registerPublicFacade("prepare_order", async () => {
      throw new Error(SENSITIVE);
    });

    const outcome = await executePublicTool({
      actor: { userId: "u1", role: "ADMIN" },
      invocation: { channel: "agent" },
      publicToolKey: "prepare_order",
      publicInput: { customerId: "c1" },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(500);
      expect(outcome.code).toBe("PUBLIC_TOOL_ERROR");
      // 对外固定通用消息，不含敏感内部字样
      expect(outcome.error).not.toContain(SENSITIVE);
      expect(outcome.error).not.toContain("postgres://");
      expect(outcome.error).not.toContain("secret");
      expect(outcome.error).not.toContain("internal-host");
      // 仍是可读的中文通用消息
      expect(outcome.error.length).toBeGreaterThan(0);
    }

    __clearPublicFacadeRegistryForTests();
  });
});
