import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { VARIABLE_KEYS, LINES_CHILD_KEYS } from "./template-variables";

export interface ScanResult {
  ok: boolean;
  found: string[]; // parser 收集到的所有 tag
  recognized: string[]; // 字典里认得的
  unknown: string[]; // 字典里没有的（错误，会被拦截）
  inLines: string[]; // {#lines}...{/lines} 循环块子变量
  missingRequired: string[]; // 必填变量模板里没用到（警告）
}

// 用 docxtemplater 的 parser 钩子收集模板里所有 tag
// parser 在模板解析阶段被调用，对每个 {tag} 触发一次，
// 不受 Word 拆 run / 页眉页脚影响——这是权威的变量发现方式
export async function scanDocxTemplate(
  fileBuffer: Buffer
): Promise<ScanResult> {
  const zip = new PizZip(fileBuffer);
  const docXml = zip.file("word/document.xml");
  if (!docXml) {
    throw new Error("无效的 .docx 文件：缺少 word/document.xml");
  }

  // 收集所有 tag 名（parser 对每个占位符调用一次）
  const foundSet = new Set<string>();
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: "{", end: "}" },
    // parser 钩子：模板里每个 {tag} 解析时调用一次
    parser: (tag: string) => {
      // 去掉循环/条件前缀（# / + -），收集实际变量名
      const cleanTag = tag.replace(/^[#/+/-]/, "").trim();
      if (cleanTag) foundSet.add(cleanTag);
      // 必须返回一个 getter，否则 docxtemplater 报错
      return { get: () => "" };
    },
  });

  // render 触发解析（data 传空对象；parser 已在解析阶段收集了所有 tag）
  try {
    doc.render({});
  } catch {
    // 忽略 render 错误——我们只需要 parser 收集的 tag 列表
  }

  const found = [...foundSet];
  const recognized: string[] = [];
  const unknown: string[] = [];
  const inLines: string[] = [];

  for (const v of found) {
    if (VARIABLE_KEYS.has(v)) {
      recognized.push(v);
    } else if (LINES_CHILD_KEYS.has(v)) {
      // lines 循环块子变量（白名单放行）
      inLines.push(v);
    } else {
      unknown.push(v); // 字典里没有 → 拦截
    }
  }

  return {
    ok: unknown.length === 0,
    found,
    recognized,
    unknown,
    inLines,
    missingRequired: [], // 可选：检查 required 变量是否都在 found 里
  };
}
