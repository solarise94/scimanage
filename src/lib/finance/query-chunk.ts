export const FINANCE_QUERY_CHUNK_SIZE = 250;

export function chunkArray<T>(items: T[], size = FINANCE_QUERY_CHUNK_SIZE): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function collectByChunks<T>(
  items: string[],
  query: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const result: T[] = [];
  for (const chunk of chunkArray(items)) {
    if (chunk.length === 0) continue;
    result.push(...await query(chunk));
  }
  return result;
}
