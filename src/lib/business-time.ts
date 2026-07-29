/**
 * 业务时区工具（代表运营周报、今日/本周 KPI 窗口）
 *
 * 业务日始终按 Asia/Shanghai 解释，不依赖进程 TZ。
 */

export const BUSINESS_TIME_ZONE = "Asia/Shanghai";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 将瞬时时间转为 Asia/Shanghai 的年月日时分秒（不依赖 Intl 时区数据缺失时的回退） */
export function getShanghaiParts(instant: Date): {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Sun ... 6=Sat
} {
  // 用 UTC 时刻 + 固定 +08 得到上海墙钟（中国无夏令时）
  const shifted = new Date(instant.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

/** 构造 Asia/Shanghai 墙钟时刻对应的 UTC Date */
export function shanghaiWallTimeToUtc(parts: {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  ms?: number;
}): Date {
  const utcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
    parts.ms ?? 0,
  );
  return new Date(utcMs - SHANGHAI_OFFSET_MS);
}

export function formatShanghaiDate(instant: Date): string {
  const p = getShanghaiParts(instant);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * 业务周窗口：上海时区周一 00:00:00（含）→ 下周一 00:00:00（不含）
 * 返回 UTC Date 供数据库查询。
 */
export function getBusinessWeekWindow(now: Date = new Date()): {
  start: Date;
  end: Date;
  periodKey: string;
  periodStartDate: string;
  periodEndDate: string;
} {
  const p = getShanghaiParts(now);
  // 当天 00:00 上海
  const todayStart = shanghaiWallTimeToUtc({
    year: p.year,
    month: p.month,
    day: p.day,
  });
  const day = p.weekday; // 0 Sun
  const diff = day === 0 ? -6 : 1 - day;
  const start = new Date(todayStart.getTime() + diff * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    start,
    end,
    periodKey: formatShanghaiDate(start),
    periodStartDate: formatShanghaiDate(start),
    periodEndDate: formatShanghaiDate(end),
  };
}

/** 业务月窗口：上海时区当月 1 日 00:00 → 下月 1 日 00:00 */
export function getBusinessMonthWindow(now: Date = new Date()): {
  start: Date;
  end: Date;
  periodKey: string;
} {
  const p = getShanghaiParts(now);
  const start = shanghaiWallTimeToUtc({ year: p.year, month: p.month, day: 1 });
  const nextYear = p.month === 12 ? p.year + 1 : p.year;
  const nextMonth = p.month === 12 ? 1 : p.month + 1;
  const end = shanghaiWallTimeToUtc({ year: nextYear, month: nextMonth, day: 1 });
  return {
    start,
    end,
    periodKey: `${p.year}-${String(p.month).padStart(2, "0")}`,
  };
}

/** 最近 count 个上海时区自然月窗口（含当月，时间升序），用于趋势聚合 */
export function getRecentBusinessMonthWindows(
  now: Date = new Date(),
  count = 6,
): Array<{ key: string; label: string; start: Date; end: Date }> {
  const p = getShanghaiParts(now);
  const windows = [];
  for (let i = count - 1; i >= 0; i--) {
    const total = p.year * 12 + (p.month - 1) - i;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    const start = shanghaiWallTimeToUtc({ year, month, day: 1 });
    const end = month === 12
      ? shanghaiWallTimeToUtc({ year: year + 1, month: 1, day: 1 })
      : shanghaiWallTimeToUtc({ year, month: month + 1, day: 1 });
    windows.push({ key: `${year}-${String(month).padStart(2, "0")}`, label: `${month}月`, start, end });
  }
  return windows;
}

/** 业务日窗口：上海时区当天 00:00 → 次日 00:00 */
export function getBusinessDayWindow(now: Date = new Date()): {
  start: Date;
  end: Date;
  dateKey: string;
} {
  const p = getShanghaiParts(now);
  const start = shanghaiWallTimeToUtc({
    year: p.year,
    month: p.month,
    day: p.day,
  });
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    start,
    end,
    dateKey: formatShanghaiDate(start),
  };
}
