"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { animate, useInView, useReducedMotion } from "motion/react";

interface UseCountUpOptions {
  /** 目标值 */
  value: number;
  /** 动画时长 ms，默认 800 */
  duration?: number;
  /** 小数位数，默认 0 */
  decimals?: number;
  /** 动画行为："always"=每次 value 变化都滚动（默认）；"once"=只滚首次，后续瞬变 */
  mode?: "always" | "once";
}

/**
 * 数字滚动。用 Intl.NumberFormat 一次生成终态字符串（不依赖 toLocaleString，
 * 避免 zh-CN 千分位在某些环境产出窄不换行空格 \u202F 导致字符串解析出错）。
 *
 * 动画语义（务必读懂，避免维护期误判）：
 * - useInView { once: true } 的 once 控制的是"视口进出是否重复触发 inView"，
 *   一旦进入视口 inView 永久 true——这与"value 变化是否重滚"是两件事。
 * - 因此 value 在视口内被刷新（如 KPI 重新拉数）时，effect 仍会再跑一次动画滚到新值。
 *   这通常符合直觉（用户看到数字跳到新值），若想要"只滚首次、后续瞬变"传 mode:"once"。
 * - mode:"once" 用 hasAnimatedRef 做 ref-guard：首次动画后置 true，后续 value 变化直接 setDisplay(value)。
 *
 * 尊重 prefers-reduced-motion：命中直接返回目标值，不跑 animate()。
 * useReducedMotion 在 motion@12 仍叫这个名字（已核实，未改名 usePrefersReducedMotion），
 * 但为防未来 minor 变动，下面有 matchMedia 兜底。
 */
export function useCountUp({ value, duration = 800, decimals = 0, mode = "always" }: UseCountUpOptions) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -40px 0px" });
  // 兜底：若 motion 未来改名，回退到 matchMedia；两者都为真才算 reduce
  const motionReduce = useReducedMotion();
  const [mqReduce, setMqReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMqReduce(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const reduceMotion = !!motionReduce || mqReduce;
  const hasAnimatedRef = useRef(false);
  const [display, setDisplay] = useState(0);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!inView) return;
    if (reduceMotion) { setDisplay(value); hasAnimatedRef.current = true; return; }
    if (mode === "once" && hasAnimatedRef.current) { setDisplay(value); return; }
    const controls = animate(0, value, {
      duration: duration / 1000,
      ease: "easeOut",
      onUpdate: (v) => setDisplay(v),
    });
    hasAnimatedRef.current = true;
    return () => controls.stop();
  }, [inView, value, duration, reduceMotion, mode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 用 Intl.NumberFormat 生成终态字符串，避免 toLocaleString 的千分位空格问题
  const formatter = useMemo(() => new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }), [decimals]);
  const formatted = formatter.format(display);

  return { ref, formatted };
}
