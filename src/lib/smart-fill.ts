export interface SmartFillResult {
  name?: string;
  description?: string;
  organization?: string;
  client?: string;
  representative?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  progress?: number;
  projectType?: string;
  projectContent?: string;
  quantity?: number;
  procurementSource?: string;
  brand?: string;
  techSupport?: string;
  budgetAmount?: number;
  budgetCost?: number;
}

export function normalizeSmartFillProjectType(raw: string): string {
  if (/商品|货物|产品/.test(raw)) return "商品";
  if (/服务|技术|实验/.test(raw)) return "服务";
  if (raw === "SERVICE") return "服务";
  if (raw === "PRODUCT") return "商品";
  return raw;
}

function splitLine(line: string): string[] {
  // Try tab first, then multiple spaces
  if (line.includes("\t")) {
    return line.split("\t").map((s) => s.trim());
  }
  // Split by 2+ spaces
  return line.split(/\s{2,}/).map((s) => s.trim());
}

function convertDate(dateStr: string): string | undefined {
  if (!dateStr) return undefined;
  // Support YYYY/MM/DD and YYYY-MM-DD
  const normalized = dateStr.replace(/\//g, "-");
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return undefined;
  const [, y, m, d] = match;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function mapStatus(statusStr: string): string | undefined {
  const map: Record<string, string> = {
    "预实验": "NOT_STARTED",
    "未开始": "NOT_STARTED",
    "进行中": "IN_PROGRESS",
    "已交付": "COMPLETED",
    "已完成": "COMPLETED",
    "暂停": "ON_HOLD",
    "终止": "TERMINATED",
  };
  return map[statusStr] || undefined;
}

function parseNumber(s: string): number | undefined {
  if (!s) return undefined;
  const cleaned = s.replace(/[%¥￥,\s元]/g, "").trim();
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function parseProgress(s: string): number | undefined {
  if (!s) return undefined;
  // Handle "30%" or plain number
  const cleaned = s.replace(/%/g, "").trim();
  const n = Number(cleaned);
  if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
  return undefined;
}

export function parseSmartFill(text: string): SmartFillResult {
  const lines = text.trim().split(/\n/).filter((l) => l.trim());
  if (lines.length === 0) throw new Error("请输入文本内容");

  const firstLine = lines[0];
  const cols = splitLine(firstLine);

  // Need at least 8 columns to be meaningful
  if (cols.length < 8) {
    throw new Error("文本格式不正确，至少需要8列数据");
  }

  const result: SmartFillResult = {};

  // Column mapping (Feishu export):
  // 0: (was orderNumber, now ignored), 1: internal code, 2: organization, 3: client, 4: representative,
  // 5: techSupport, 6: projectType, 7: projectContent, 8: quantity,
  // 9: procurementSource, 10: brand, 11: progress/status,
  // 12: startDate, 13: endDate, 14: (unused),
  // 15: budgetAmount, 16-17: progress payments, 18: budgetCost

  // Column 0 (orderNumber) is deliberately skipped — orderNumber is set from order side only
  if (cols[2]) result.organization = cols[2];
  if (cols[3]) result.client = cols[3];
  if (cols[4]) result.representative = cols[4];
  if (cols[5]) result.techSupport = cols[5];
  if (cols[6]) {
    result.projectType = normalizeSmartFillProjectType(cols[6]);
  }
  if (cols[7]) result.projectContent = cols[7];
  if (cols[8]) result.quantity = parseNumber(cols[8]);
  if (cols[9]) result.procurementSource = cols[9];
  if (cols[10]) result.brand = cols[10];

  // Build project name from projectContent (preferred) or fallback
  const contentStr = cols[7] || "";
  if (contentStr) {
    result.name = contentStr;
    const typeStr = cols[6] || "";
    const parts: string[] = [];
    if (typeStr) parts.push(`类型：${typeStr}`);
    if (result.quantity != null) parts.push(`数量：${result.quantity}`);
    if (parts.length > 0) {
      result.description = parts.join("，");
    }
  } else {
    // Legacy fallback: name from col 7 of old template
    const oldName = cols[7] || "";
    if (oldName) {
      result.name = oldName;
      const oldType = cols[6] || "";
      if (oldType) {
        result.description = `类型：${oldType}${cols[8] ? `，数量：${cols[8]}` : ""}${cols[9] ? `，规格：${cols[9]}` : ""}`;
      }
    }
  }

  // Col 11: could be progress (number/percentage) or status text
  if (cols[11]) {
    const progress = parseProgress(cols[11]);
    if (progress !== undefined) {
      result.progress = progress;
    } else {
      const mapped = mapStatus(cols[11]);
      if (mapped) result.status = mapped;
    }
  }

  // Date handling: cols 12 and 13
  const dateStart = convertDate(cols[12]);
  if (dateStart) result.startDate = dateStart;
  const dateEnd = convertDate(cols[13]);
  if (dateEnd) result.endDate = dateEnd;

  // Budget fields (cols 15, 18)
  if (cols[15]) result.budgetAmount = parseNumber(cols[15]);
  if (cols[18]) result.budgetCost = parseNumber(cols[18]);

  return result;
}
