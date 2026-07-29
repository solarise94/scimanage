/**
 * clipboard-share 工具单测（docs Part 2 §2.3）。
 *
 * 覆盖：
 * - copyTextToClipboard：clipboard API 成功 / 抛错后 execCommand 兜底 / 两者都失败返回 false。
 * - shareText：navigator.share 成功 / AbortError 静默 cancelled / 不支持或非 AbortError 失败 → fallback_copy。
 *
 * vitest 默认 environment: node；navigator/document 在 Node 中是只读 getter，
 * 用 Object.defineProperty 重定义（而非赋值）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard, shareText } from "@/lib/agent/clipboard-share";

function defineGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

function deleteGlobal(name: string) {
  try {
    // @ts-expect-error 动态删除全局
    delete globalThis[name];
  } catch {
    defineGlobal(name, undefined);
  }
}

/** 直接把整个 navigator 对象写到 globalThis 上。 */
function stubNavigator(nav: Record<string, unknown>) {
  defineGlobal("navigator", nav);
}

function stubDocument(opts: { execCommand?: (cmd: string) => boolean } = {}) {
  const selection = {
    removeAllRanges: vi.fn(),
    addRange: vi.fn(),
  };
  const fakeDoc = {
    createElement: vi.fn(() => ({
      value: "",
      setAttribute: vi.fn(),
      setSelectionRange: vi.fn(),
      style: {},
    })),
    body: {
      appendChild: vi.fn(),
      removeChild: vi.fn(),
    },
    execCommand: opts.execCommand ?? vi.fn(() => true),
    getSelection: vi.fn(() => selection),
    createRange: vi.fn(() => ({ selectNodeContents: vi.fn() })),
  };
  defineGlobal("document", fakeDoc);
  return { fakeDoc, selection };
}

const hasNavigator = typeof (globalThis as { navigator?: unknown }).navigator !== "undefined";
const hasDocument = typeof (globalThis as { document?: unknown }).document !== "undefined";

afterEach(() => {
  // 还原 / 清空全局，避免污染同 worker 后续测试。
  if (hasNavigator) {
    // Node 18+ 自带 navigator 只读 getter：保持现状即可。
  } else {
    deleteGlobal("navigator");
  }
  if (hasDocument) {
    // 同上
  } else {
    deleteGlobal("document");
  }
});

describe("copyTextToClipboard", () => {
  beforeEach(() => {
    // 默认清空 navigator/document，每个用例自行 stub。
    deleteGlobal("navigator");
    deleteGlobal("document");
  });

  it("clipboard API 成功时直接返回 true，不走 execCommand", async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator({ clipboard: { writeText } });
    stubDocument({ execCommand: vi.fn(() => { throw new Error("不应调用"); }) });

    const ok = await copyTextToClipboard("hello");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("clipboard API 抛错 → execCommand 兜底成功 → 返回 true", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("non-secure context");
    });
    const execCommand = vi.fn(() => true);
    stubNavigator({ clipboard: { writeText } });
    stubDocument({ execCommand });

    const ok = await copyTextToClipboard("hello");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("无 navigator.clipboard（非安全上下文）→ 走 execCommand 兜底", async () => {
    const execCommand = vi.fn(() => true);
    stubNavigator({ clipboard: undefined });
    stubDocument({ execCommand });

    const ok = await copyTextToClipboard("hello");
    expect(ok).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("两条路径都失败 → 返回 false", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    const execCommand = vi.fn(() => false);
    stubNavigator({ clipboard: { writeText } });
    stubDocument({ execCommand });

    const ok = await copyTextToClipboard("hello");
    expect(ok).toBe(false);
  });

  it("无 document（如 SSR）且无 clipboard → 返回 false", async () => {
    stubNavigator({ clipboard: undefined });
    // document 仍是 undefined（beforeEach 已清空）
    const ok = await copyTextToClipboard("hello");
    expect(ok).toBe(false);
  });
});

describe("shareText", () => {
  beforeEach(() => {
    deleteGlobal("navigator");
    deleteGlobal("document");
  });

  it("navigator.share 成功 → 返回 \"shared\"", async () => {
    const share = vi.fn(async () => undefined);
    stubNavigator({ share });

    const outcome = await shareText({ title: "SciManage Agent", text: "hi" });
    expect(outcome).toBe("shared");
    expect(share).toHaveBeenCalledWith({ title: "SciManage Agent", text: "hi" });
  });

  it("navigator.share AbortError（用户取消）→ 安静返回 \"cancelled\"", async () => {
    const share = vi.fn(async () => {
      throw new DOMException("user canceled", "AbortError");
    });
    stubNavigator({ share });

    const outcome = await shareText({ text: "hi" });
    expect(outcome).toBe("cancelled");
  });

  it("navigator.share 非 AbortError 失败 → 返回 \"fallback_copy\"", async () => {
    const share = vi.fn(async () => {
      throw new DOMException("not allowed", "NotAllowedError");
    });
    stubNavigator({ share });

    const outcome = await shareText({ text: "hi" });
    expect(outcome).toBe("fallback_copy");
  });

  it("navigator.share 不存在（桌面浏览器 / 非安全上下文）→ 返回 \"fallback_copy\"", async () => {
    stubNavigator({});

    const outcome = await shareText({ text: "hi" });
    expect(outcome).toBe("fallback_copy");
  });

  it("空 text → 直接返回 \"fallback_copy\"，不调用 share", async () => {
    const share = vi.fn(async () => undefined);
    stubNavigator({ share });

    const outcome = await shareText({ text: "" });
    expect(outcome).toBe("fallback_copy");
    expect(share).not.toHaveBeenCalled();
  });
});
