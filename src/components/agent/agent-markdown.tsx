"use client";

import type { MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import type { AgentResourceRequest } from "@/lib/agent-resources/types";

/**
 * Compact markdown renderer for agent chat bubbles.
 *
 * - GFM tables / lists / code / links
 * - No typography plugin dependency; styles are explicit and bubble-friendly
 * - In-app same-origin links: plain left-click opens in the Agent workspace
 *   Resource Panel/Sheet (when `onOpenResource` is provided); Cmd/Ctrl/middle
 *   click keeps the browser's native "open in new tab" behaviour.  External
 *   links always open in a new tab.
 * - Raw HTML is not rendered by react-markdown by default.
 */
export function AgentMarkdown({
  content,
  className,
  onOpenResource,
}: {
  content: string;
  className?: string;
  /**
   * If provided, same-origin path links are intercepted on plain left-click
   * and routed here so the resource opens inside the workspace.  When absent,
   * all links fall back to native browser behaviour (new tab).
   */
  onOpenResource?: (request: AgentResourceRequest) => void;
}) {
  if (!content) return null;

  function handleLinkClick(event: MouseEvent<HTMLAnchorElement>, href: string | undefined) {
    if (!href || !onOpenResource) return;
    // Only intercept unmodified left-clicks.  Cmd/Ctrl/Shift/middle-click
    // keep native behaviour (new tab / new window).  (docs §4.3)
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    // Only same-origin absolute-or-relative paths; leave full URLs to the browser.
    let pathname = href;
    try {
      const url = new URL(href, window.location.origin);
      if (url.origin !== window.location.origin) return;
      pathname = `${url.pathname}${url.search}`;
    } catch {
      // Not a valid URL — let the browser try.
      return;
    }
    event.preventDefault();
    onOpenResource({ type: "href", href: pathname });
  }

  return (
    <div className={cn("agent-md break-words text-[15px] leading-7 text-foreground", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Flat chat prose (no bubble). ChatGPT 风格：宽松行距、hairline 表格、无重彩容器。
          p: ({ children }) => <p className="mb-3 last:mb-0 whitespace-pre-wrap">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => (
            <ul className="mb-3 list-disc space-y-1.5 pl-5 last:mb-0 [&_li:has(>input[type=checkbox])]:-ml-4 [&_li:has(>input[type=checkbox])]:list-none [&_ol]:mt-1.5 [&_ul]:mt-1.5">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 list-decimal space-y-1.5 pl-5 last:mb-0 [&_li:has(>input[type=checkbox])]:-ml-4 [&_li:has(>input[type=checkbox])]:list-none [&_ol]:mt-1.5 [&_ul]:mt-1.5">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-7">{children}</li>,
          input: ({ checked, ...props }) => (
            <input
              {...props}
              checked={checked}
              readOnly
              className="mr-1.5 h-3.5 w-3.5 translate-y-px accent-primary"
            />
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => handleLinkClick(e, href)}
              className="font-medium text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => <h3 className="mb-2 mt-4 text-[17px] font-semibold first:mt-0">{children}</h3>,
          h2: ({ children }) => <h3 className="mb-2 mt-4 text-[16px] font-semibold first:mt-0">{children}</h3>,
          h3: ({ children }) => <h4 className="mb-1.5 mt-3 text-[15px] font-semibold first:mt-0">{children}</h4>,
          h4: ({ children }) => <h5 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">{children}</h5>,
          h5: ({ children }) => <h6 className="mb-1 mt-2 text-sm font-medium first:mt-0">{children}</h6>,
          h6: ({ children }) => <h6 className="mb-1 mt-2 text-sm font-medium text-muted-foreground first:mt-0">{children}</h6>,
          blockquote: ({ children }) => (
            <blockquote className="mb-3 border-l-2 border-border py-0.5 pl-3.5 text-muted-foreground last:mb-0">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-border/50" />,
          code: ({ className: codeClassName, children, ...props }) => {
            const isBlock = typeof codeClassName === "string" && codeClassName.includes("language-");
            if (isBlock) {
              return (
                <code className={cn("font-mono text-[12px] leading-5", codeClassName)} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded-md bg-muted px-1 py-0.5 font-mono text-[12.5px] text-foreground"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-3 overflow-x-auto rounded-xl border border-border/50 bg-muted/40 px-3.5 py-2.5 text-[12.5px] last:mb-0">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            /* ChatGPT 风格 hairline 表格：白卡 + 细边框，无重彩表头，行间细分割线 */
            <div className="mb-3 overflow-x-auto rounded-xl border border-border/60 bg-card last:mb-0">
              <table className="w-full min-w-[420px] border-collapse text-left text-[13px]">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-border/40 last:border-0">{children}</tr>,
          th: ({ children }) => (
            <th className="px-3 py-2 font-semibold text-foreground">{children}</th>
          ),
          td: ({ children }) => <td className="px-3 py-2 align-top text-foreground">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
