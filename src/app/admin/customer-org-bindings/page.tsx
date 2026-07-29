import { redirect } from "next/navigation";

// G5：旧路由收口到统一数据治理中心（C3 无机构客户）。
export default function Page() {
  redirect("/admin/governance?tab=org-bindings");
}
