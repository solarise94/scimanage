/**
 * 复制 / 分享工具函数（docs Part 2 §2.3）。
 *
 * 双端共享（desktop workbench / mobile shell 共用同一份消息操作行）。
 * 关键约束：
 * - HTTP 部署无安全上下文（非 HTTPS），`navigator.clipboard` 在非安全上下文下
 *   为 undefined 或抛错 → 必须兜底 `textarea + execCommand("copy")`。
 * - HTTPS 部署走标准 AsyncClipboard API。
 * - `navigator.share` 的 AbortError 是「用户取消」，必须安静结束，不 toast、
 *   不回退复制；其余失败（不支持 / 真实错误）回退复制 + toast「已复制，可粘贴分享」。
 */

export type ShareOutcome = "shared" | "cancelled" | "fallback_copy";

/**
 * 把文本写入剪贴板。
 *
 * 优先 `navigator.clipboard.writeText`（安全上下文）；失败或不可用时回退到
 * 临时 textarea + `document.execCommand("copy")`（非安全上下文兜底）。
 *
 * @returns true 表示复制成功，false 表示两条路径都失败。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  // 显式走 globalThis，避免 vitest/SSR 模块作用域下裸 `navigator`/`document`
  // 解析不一致（测试桩写在 globalThis 上）。
  const g = globalThis as {
    navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } };
    document?: Document;
  };

  // 路径 1：标准 AsyncClipboard API（仅安全上下文可用）。
  const writeText = g.navigator?.clipboard?.writeText;
  if (typeof writeText === "function") {
    try {
      await writeText.call(g.navigator!.clipboard, text);
      return true;
    } catch {
      // 权限拒绝 / 非安全上下文 / 文档失焦等 → 落到 execCommand 兜底。
    }
  }

  // 路径 2：execCommand 兜底（适用于 http demo 等非安全上下文）。
  const doc = g.document;
  if (doc && typeof doc.execCommand === "function") {
    try {
      const textarea = doc.createElement("textarea");
      textarea.value = text;
      // 防止在移动端唤起键盘 / 触发滚动：移出视口并置只读。
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "-9999px";
      textarea.style.left = "-9999px";
      doc.body.appendChild(textarea);
      // iOS Safari 需要先创建 Range 选中才能 execCommand 成功。
      const selection = doc.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(textarea);
      selection?.removeAllRanges();
      selection?.addRange(range);
      textarea.setSelectionRange(0, textarea.value.length);
      const ok = doc.execCommand("copy");
      doc.body.removeChild(textarea);
      // 清理选区，避免残留。
      selection?.removeAllRanges();
      if (ok) return true;
    } catch {
      // 兜底也失败：返回 false 让调用方决定如何提示。
    }
  }

  return false;
}

/**
 * 分享文本。三态语义：
 * - "shared": `navigator.share` 调用成功。
 * - "cancelled": 用户取消（AbortError）—— 调用方应安静结束，不 toast、不回退复制。
 * - "fallback_copy": 不支持 share 或真实失败 —— 调用方应复制 + toast「已复制，可粘贴分享」。
 *
 * @param payload.title 分享卡片标题（部分平台显示）。
 * @param payload.text  分享正文（必填）。
 */
export async function shareText(payload: { title?: string; text: string }): Promise<ShareOutcome> {
  const { title, text } = payload;
  if (!text) return "fallback_copy";

  // 显式走 globalThis.navigator（与 copyTextToClipboard 一致，便于单测桩）。
  const g = globalThis as { navigator?: { share?: (data: { title?: string; text: string }) => Promise<void> } };
  const share = g.navigator?.share;

  // navigator.share 仅在安全上下文 + 多数移动端浏览器可用。
  if (typeof share !== "function") {
    return "fallback_copy";
  }

  try {
    await share.call(g.navigator, { title, text });
    return "shared";
  } catch (error) {
    // 用户取消（含手动关闭系统分享面板）：安静结束。
    if (error instanceof DOMException && error.name === "AbortError") {
      return "cancelled";
    }
    // 其余失败（AbortError 之外的 DOMException、NotAllowedError 等）：回退复制。
    return "fallback_copy";
  }
}
