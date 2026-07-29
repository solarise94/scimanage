import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { businessActorFromSessionUser } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import {
  projectListFiltersFromSearchParams,
  resolveProjectListWhere,
} from "@/lib/projects/application/query-projects";

/**
 * 项目列表/计数的共享筛选条件构建（薄适配层）。
 *
 * 权限、deleted/archived、search 与筛选口径由
 * `src/lib/projects/application/query-projects.ts` 统一实现；本模块仅把
 * Session + URLSearchParams 转成 BusinessActor + filters。
 *
 * - 无权限（无可读项目）时返回 `{ empty: true }`
 * - `ignoreStatus`：count 接口需要按状态分组，必须忽略 status 参数
 */
export async function buildProjectWhere(
  searchParams: URLSearchParams,
  session: Session,
  options?: { ignoreStatus?: boolean },
): Promise<{ where: Prisma.ProjectWhereInput } | { empty: true }> {
  try {
    const filters = projectListFiltersFromSearchParams(searchParams);
    return resolveProjectListWhere(businessActorFromSessionUser(session.user), {
      ...filters,
      ignoreStatus: options?.ignoreStatus ?? false,
    });
  } catch (err) {
    if (err instanceof ApplicationError) {
      throw new ProjectQueryError(err.httpStatus, err.message);
    }
    throw err;
  }
}

/** buildProjectWhere 抛出的错误（携带 HTTP 状态码，供 route handler 转成 NextResponse）。 */
export class ProjectQueryError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ProjectQueryError";
  }
}
