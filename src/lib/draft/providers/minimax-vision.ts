import type { VisionProvider } from "./types";
import { readFile } from "fs/promises";
import { extname } from "path";

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || "";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1";

function mimeFromExt(ext: string): string {
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

/**
 * Convert a local file path to a base64 data URL.
 * Only accepts local file paths — no HTTP URLs or data URLs.
 * This prevents SSRF: the vision provider never fetches arbitrary URLs.
 */
async function toDataUrl(localPath: string): Promise<string> {
  if (localPath.startsWith("http://") || localPath.startsWith("https://") || localPath.startsWith("data:")) {
    throw new Error("Vision provider 仅接受本地文件路径，不允许外部 URL");
  }

  const buf = await readFile(localPath);
  const mime = mimeFromExt(extname(localPath).toLowerCase());
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export class MinimaxVisionProvider implements VisionProvider {
  async extractText(params: { imageUrl: string; prompt: string }): Promise<{ text: string }> {
    const baseHost = MINIMAX_BASE_URL.replace(/\/v1\/?$/, "");
    const imageUrl = await toDataUrl(params.imageUrl);

    const res = await fetch(`${baseHost}/v1/coding_plan/vlm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MINIMAX_API_KEY}`,
      },
      body: JSON.stringify({ prompt: params.prompt, image_url: imageUrl }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MiniMax VLM 请求失败 (${res.status}): ${text}`);
    }

    const data = await res.json();
    const baseResp = data.base_resp;
    if (baseResp?.status_code !== 0) {
      throw new Error(`MiniMax VLM 错误 [${baseResp?.status_code}]: ${baseResp?.status_msg}`);
    }

    const content = data.content;
    if (!content) throw new Error("MiniMax VLM 未返回内容");
    return { text: content };
  }
}
