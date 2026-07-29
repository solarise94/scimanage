// 中文金额大写转换
const DIGITS = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
const BIG_UNITS = ["", "万", "亿"];

/**
 * 四位以内的数字转大写
 * 返回值：{ text, hasContent } —— hasContent 表示该段是否有非零输出
 */
function section4ToWords(n: number, needLeadingZero: boolean): { text: string; hasContent: boolean } {
  if (n === 0) return { text: "", hasContent: false };

  const q = Math.floor(n / 1000);
  const b = Math.floor((n % 1000) / 100);
  const s = Math.floor((n % 100) / 10);
  const g = n % 10;

  let text = "";
  let pendingZero = needLeadingZero;

  // 千位
  if (q > 0) {
    if (pendingZero) { text += "零"; pendingZero = false; }
    text += DIGITS[q] + "仟";
  } else {
    if (text) pendingZero = true; // 已有输出但千位为零
  }

  // 百位
  if (b > 0) {
    if (pendingZero) { text += "零"; pendingZero = false; }
    text += DIGITS[b] + "佰";
  } else {
    if (text) pendingZero = true;
  }

  // 十位
  if (s > 0) {
    if (pendingZero) { text += "零"; pendingZero = false; }
    text += DIGITS[s] + "拾";
  } else {
    if (text) pendingZero = true;
  }

  // 个位
  if (g > 0) {
    if (pendingZero) { text += "零"; pendingZero = false; }
    text += DIGITS[g];
  }
  // g === 0 时不输出，pendingZero 保持不变，给下一组用

  return { text, hasContent: true };
}

function integerToWords(intPart: number): string {
  if (intPart === 0) return "零";

  const sections: number[] = [];
  let n = intPart;
  while (n > 0) {
    sections.push(n % 10000);
    n = Math.floor(n / 10000);
  }

  const parts: string[] = [];
  let skippedZeroSection = false; // 跳过了零段

  for (let i = sections.length - 1; i >= 0; i--) {
    const sec = sections[i];
    if (sec === 0) {
      skippedZeroSection = true;
      continue;
    }

    // 决定是否需要前导零：
    // 1. 跳过了零段 → needLeadingZero
    // 2. 前一段有输出且当前段千位为零（组间间隙，如 10001 中万→个跳过了千）
    const thousands = Math.floor(sec / 1000);
    const needLeadingZero = skippedZeroSection || (parts.length > 0 && thousands === 0);

    const { text } = section4ToWords(sec, needLeadingZero);
    if (text) {
      parts.push(text + BIG_UNITS[i]);
      skippedZeroSection = false;
    }
  }

  let result = parts.join("");
  // 合并连续零
  result = result.replace(/零+/g, "零");
  if (result.endsWith("零")) result = result.slice(0, -1);
  return result || "零";
}

export function amountToChineseWords(yuanAmount: number): string {
  if (yuanAmount === 0) return "零元整";

  const totalCents = Math.round(yuanAmount * 100);
  const intPart = Math.floor(totalCents / 100);
  const jiao = Math.floor((totalCents % 100) / 10);
  const fen = totalCents % 10;

  const intWords = integerToWords(intPart);

  if (jiao === 0 && fen === 0) {
    return intWords + "元整";
  }

  let decimalStr = "";
  if (jiao > 0) {
    decimalStr += DIGITS[jiao] + "角";
  } else if (fen > 0) {
    decimalStr += "零";
  }
  if (fen > 0) {
    decimalStr += DIGITS[fen] + "分";
  }
  if (fen === 0) {
    decimalStr += "整";
  }

  return intWords + "元" + decimalStr;
}
