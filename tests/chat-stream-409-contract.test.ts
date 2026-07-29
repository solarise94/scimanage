/**
 * chat-stream 409 `code` 字段契约测试（docs Part 1 §1.4）。
 *
 * 锁死三类 409 的 code 字段，防止漂移：
 *  - A 类（runtime 未配置）→ RUNTIME_NOT_PI：通过在临时 SQLite 中实际执行 POST
 *    断言（mock next-auth session + isPiAgentRuntimeEnabled=false，路由会在任何
 *    prisma/registry 副作用之前返回）。
 *  - B/C 类（附件冲突）→ ATTACHMENT_CHANGED / ATTACHMENT_BOUND_TO_ANOTHER_SESSION：
 *    这两条路径需要完整的附件 staging 事务 + agent-runtime 注入，单测 seed 成本
 *    过高且与 409 治理无关；此处用源码契约断言锁死 code 字面量，等价于"路由里
 *    这两个 code 必须存在且拼写不变"。413 的 ATTACHMENT_TOO_LARGE 顺带锁。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

// ── mock next-auth（路由用 getServerSession） ──
type SessionUser = { id: string; role: string; name: string; email: string };
type MockSession = { user: SessionUser };
const sessionState = vi.hoisted(() => ({ current: null as MockSession | null }));

vi.mock("next-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));

// isPiAgentRuntimeEnabled 默认 false（触发 A 类 409）。
vi.mock("@/lib/agent-runtime/config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPiAgentRuntimeEnabled: () => false,
}));

describe("chat-stream 409 code 契约", () => {
  it("A 类：runtime 未配置 → 409 { code: RUNTIME_NOT_PI }", async () => {
    await withTempSmokeDb(async () => {
      sessionState.current = {
        user: { id: "user-1", role: "ADMIN", name: "Test", email: "t@e.com" },
      };
      const { POST } = await import("@/app/api/agent/chat-stream/route");
      const { NextRequest } = await import("next/server");

      const req = new NextRequest("http://localhost/api/agent/chat-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("RUNTIME_NOT_PI");
    });
  });

  it("B 类 / C 类 / 413：code 字面量在 runner 源码中存在（契约锁）", () => {
    // Phase 3：409/413 附件错误码已从 route 迁入 AgentTurnRunner
    // (src/lib/agent-runtime/agent-turn-runner.ts)，route 只做 HTTP mapping。
    // 契约锁改读 runner 源码，保证 code 字面量不漂移。
    const src = readFileSync(
      resolve(process.cwd(), "src/lib/agent-runtime/agent-turn-runner.ts"),
      "utf8",
    );
    // B 类：通用附件校验失败 / 去重失败（AgentActionError 的第三参数 = code）。
    expect(src).toContain('"ATTACHMENT_CHANGED"');
    // C 类：commitAgentChatUserMessage 抛 StagingError 时透传 err.code
    // （src/lib/agent-attachments 统一为 ATTACHMENT_BOUND_TO_ANOTHER_SESSION）。
    expect(src).toContain("err instanceof StagingError");
    expect(src).toContain("err.code");
    // 413：每消息总量超限（不在本次治理范围，顺带锁防回归）。
    expect(src).toContain('"ATTACHMENT_TOO_LARGE"');
  });
});
