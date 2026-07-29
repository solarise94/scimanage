/**
 * 发票四要素查询 API（腾讯云市场）
 *
 * 查询企业开票信息：单位名称、税号、地址、电话、开户行、账号。
 * 凭据从 invoice-api.conf（mode 0600）读取。
 *
 * 云市场 V2 签名：
 *   signStr = "x-date: " + datetime
 *   sign = HMAC-SHA1(secretKey, signStr) → base64
 *   Authorization = JSON {"id":"<secretId>", "x-date":"<datetime>", "signature":"<sign>"}
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

interface InvoiceApiConfig {
  secretId: string;
  secretKey: string;
  host: string;
  endpoint: string;
}

interface OrgInvoiceInfo {
  unitName: string;
  unitTaxNo: string;
  unitAddress: string;
  unitPhone: string;
  bankName: string;
  bankNo: string;
}

let cachedConfig: InvoiceApiConfig | null = null;

function loadConfig(): InvoiceApiConfig {
  if (cachedConfig) return cachedConfig;

  // Search locations (in priority order):
  //  1. process.cwd()/invoice-api.conf  — runtime dir (rsync-excluded, survives deploys)
  //  2. <dirname of DATABASE_URL>/invoice-api.conf  — persistent config dir next to the DB
  //  3. repo root (local dev)
  const candidatePaths = [
    path.join(process.cwd(), "invoice-api.conf"),
  ];
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const dbPath = dbUrl.replace(/^file:/, "");
    candidatePaths.push(path.join(path.dirname(dbPath), "invoice-api.conf"));
  }

  const confPath = candidatePaths.find((p) => fs.existsSync(p));
  if (!confPath) {
    throw new Error("invoice-api.conf not found — invoice API unavailable");
  }

  const raw = fs.readFileSync(confPath, "utf-8");
  const config: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    config[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }

  cachedConfig = {
    secretId: config.SECRET_ID || "",
    secretKey: config.SECRET_KEY || "",
    host: config.HOST || "ap-shanghai.cloudmarket-apigw.com",
    endpoint: config.ENDPOINT || "/service-rf059r1j/getInvocieInfo",
  };

  if (!cachedConfig.secretId || !cachedConfig.secretKey) {
    throw new Error("invoice-api.conf missing SECRET_ID or SECRET_KEY");
  }

  return cachedConfig;
}

/**
 * 发起签名请求并返回 JSON
 */
async function callInvoiceApi(name: string): Promise<OrgInvoiceInfo[]> {
  const config = loadConfig();

  // 云市场 V2 签名
  const datetime = new Date().toUTCString();
  const signStr = "x-date: " + datetime;
  const sign = crypto.createHmac("sha1", config.secretKey).update(signStr).digest("base64");
  const auth = JSON.stringify({ id: config.secretId, "x-date": datetime, signature: sign });

  const url = `https://${config.host}${config.endpoint}`;
  const body = `name=${encodeURIComponent(name)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": auth,
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Invoice API HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const json = (await res.json()) as { code?: number; msg?: string; data?: unknown };
  if (json.code !== 0) {
    throw new Error(`Invoice API error ${json.code}: ${json.msg || "未知错误"}`);
  }

  // API 按 frequency 降序返回；未命中的单位会返回相似名称的结果，调用方需自行过滤
  const list = Array.isArray(json.data) ? (json.data as Record<string, unknown>[]) : [];
  return list.map((item) => ({
    unitName: (item.unitName as string) || "",
    unitTaxNo: (item.unitTaxNo as string) || "",
    unitAddress: (item.unitAddress as string) || "",
    unitPhone: (item.unitPhone as string) || "",
    bankName: (item.bankName as string) || "",
    bankNo: (item.bankNo as string) || "",
  }));
}

/**
 * 按单位名称查询开票信息
 */
export async function lookupOrgByName(name: string): Promise<OrgInvoiceInfo[]> {
  if (!name.trim()) return [];
  return callInvoiceApi(name.trim());
}

/**
 * 按税号查询开票信息
 *
 * 该云市场服务仅提供按名称查询接口（getInvocieInfo），不支持按税号直查。
 * 此函数保留以兼容调用方签名，内部仍走名称查询——调用方应优先用 lookupOrgByName。
 * 若未来云市场提供按税号接口，在此切换即可。
 */
export async function lookupOrgByTaxId(taxId: string): Promise<OrgInvoiceInfo[]> {
  // 当前服务不支持按税号查询，返回空（避免误导调用方）
  void taxId;
  return [];
}
