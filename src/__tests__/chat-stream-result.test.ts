/**
 * chat-stream 409 分类与回滚纯函数单测（docs Part 1 §1.4）。
 *
 * 覆盖 classifyChatStream409 全分支 + removeOptimisticTurn（双删 / 幂等）+
 * restoreGenericQueueAfterConflict（本轮发出项置 error / 原有 error 项原样 /
 * 未发出项原样）。
 */
import { describe, expect, it } from "vitest";
import {
  classifyChatStream409,
  removeOptimisticTurn,
  restoreGenericQueueAfterConflict,
} from "@/lib/agent/chat-stream-result";

describe("classifyChatStream409", () => {
  it("RUNTIME_NOT_PI → runtime_not_pi", () => {
    expect(classifyChatStream409("RUNTIME_NOT_PI")).toBe("runtime_not_pi");
  });

  it("undefined（旧服务端兼容）→ runtime_not_pi", () => {
    expect(classifyChatStream409(undefined)).toBe("runtime_not_pi");
  });

  it("ATTACHMENT_CHANGED → attachment_conflict", () => {
    expect(classifyChatStream409("ATTACHMENT_CHANGED")).toBe("attachment_conflict");
  });

  it("ATTACHMENT_BOUND_TO_ANOTHER_SESSION → attachment_conflict", () => {
    expect(classifyChatStream409("ATTACHMENT_BOUND_TO_ANOTHER_SESSION")).toBe("attachment_conflict");
  });

  it("未知 code → attachment_conflict（fail-closed）", () => {
    expect(classifyChatStream409("SOMETHING_NEW")).toBe("attachment_conflict");
    expect(classifyChatStream409("")).toBe("attachment_conflict");
  });
});

describe("removeOptimisticTurn", () => {
  const mk = (id: string, role: "user" | "assistant") => ({ id, role, content: "x" });

  it("删除本轮 user + assistant 占位，其他消息原样保留", () => {
    const messages = [
      mk("u1", "user"),
      mk("a1", "assistant"),
      mk("u2", "user"),
      mk("a2", "assistant"),
    ];
    const result = removeOptimisticTurn(messages, "u2", "a2");
    expect(result.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("幂等：id 不存在时不报错、不影响其他消息", () => {
    const messages = [mk("u1", "user"), mk("a1", "assistant")];
    const result = removeOptimisticTurn(messages, "nonexistent", "also-nope");
    expect(result.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("返回新数组，不就地修改原数组", () => {
    const messages = [mk("u1", "user"), mk("a1", "assistant")];
    const snapshot = [...messages];
    removeOptimisticTurn(messages, "u1", "a1");
    expect(messages).toEqual(snapshot);
  });
});

describe("restoreGenericQueueAfterConflict", () => {
  const mk = (stagingFileId: string, uploadError?: string) => ({
    stagingFileId,
    fileName: `${stagingFileId}.png`,
    uploadError,
  });

  it("本轮发出项置 uploadError，原有 error 项与未发出项原样保留", () => {
    const previousQueue = [
      mk("sent-1"), // 本轮发出
      mk("sent-2"), // 本轮发出
      mk("err-old", "旧错误"), // 原有 error 项（未发出，不应被覆盖）
      mk("idle"), // 队列里但本轮未发出
    ];
    const pendingStagingFileIds = new Set(["sent-1", "sent-2"]);
    const result = restoreGenericQueueAfterConflict(previousQueue, pendingStagingFileIds, "已失效，请重新添加");

    expect(result).toEqual([
      { stagingFileId: "sent-1", fileName: "sent-1.png", uploadError: "已失效，请重新添加" },
      { stagingFileId: "sent-2", fileName: "sent-2.png", uploadError: "已失效，请重新添加" },
      { stagingFileId: "err-old", fileName: "err-old.png", uploadError: "旧错误" },
      { stagingFileId: "idle", fileName: "idle.png", uploadError: undefined },
    ]);
  });

  it("空 pendingStagingFileIds 时不修改任何项", () => {
    const previousQueue = [mk("a"), mk("b", "err")];
    const result = restoreGenericQueueAfterConflict(previousQueue, new Set(), "已失效，请重新添加");
    expect(result).toEqual(previousQueue);
  });

  it("返回新数组，不就地修改原数组项", () => {
    const previousQueue = [mk("sent-1")];
    const snapshot = [{ ...previousQueue[0] }];
    restoreGenericQueueAfterConflict(previousQueue, new Set(["sent-1"]), "x");
    expect(previousQueue).toEqual(snapshot);
  });
});
