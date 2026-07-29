/**
 * shouldShowAssistantActions 单测（docs Part 2 §2.3）。
 *
 * 抽出的纯函数（在 agent-message-helpers.ts），覆盖：
 * - streaming 状态 → 不显示（操作行不能在生成中点击）；
 * - legacy 消息 state === undefined → 显示（normalizeAssistantText 非空时）；
 * - 空 content / 仅空白 → 不显示；
 * - error 状态且非空 content → 显示。
 */
import { describe, expect, it } from "vitest";
import { shouldShowAssistantActions } from "@/components/agent/agent-message-helpers";

describe("shouldShowAssistantActions", () => {
  it("streaming → false（生成中不显示复制 / 分享）", () => {
    expect(shouldShowAssistantActions({ state: "streaming", content: "hi" })).toBe(false);
  });

  it("done 且非空 content → true", () => {
    expect(shouldShowAssistantActions({ state: "done", content: "你好" })).toBe(true);
  });

  it("legacy state === undefined 且非空 content → true（旧消息也能复制）", () => {
    expect(shouldShowAssistantActions({ state: undefined, content: "历史消息" })).toBe(true);
  });

  it("无 state 字段（键缺失）→ 按 undefined 处理，content 非空则 true", () => {
    expect(shouldShowAssistantActions({ content: "历史消息" })).toBe(true);
  });

  it("空 content → false", () => {
    expect(shouldShowAssistantActions({ state: "done", content: "" })).toBe(false);
  });

  it("纯空白 content（normalizeAssistantText 去掉首尾空白后为空）→ false", () => {
    expect(shouldShowAssistantActions({ state: "done", content: "   \n\n  " })).toBe(false);
  });

  it("content 为 undefined → false", () => {
    expect(shouldShowAssistantActions({ state: "done" })).toBe(false);
  });

  it("error 状态且非空 content → true（错误消息也能复制）", () => {
    expect(shouldShowAssistantActions({ state: "error", content: "出错了" })).toBe(true);
  });
});
