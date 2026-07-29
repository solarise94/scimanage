"use client";

import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * Observe an element's border-box height via ResizeObserver.
 * Useful for floating composers that need matching scroll padding.
 */
export function useElementHeight(
  ref: RefObject<HTMLElement | null>,
  fallback = 96,
): number {
  const [height, setHeight] = useState(fallback);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const next = Math.ceil(el.getBoundingClientRect().height);
      if (next > 0) setHeight(next);
    };

    update();

    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return height;
}
