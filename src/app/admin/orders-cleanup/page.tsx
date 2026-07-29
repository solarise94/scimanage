import { redirect } from "next/navigation";

// 订单治理退到客户机构补绑之后：先补客户机构，再由机构推导代表与订单归属。
export default function Page() {
  redirect("/admin/governance?tab=org-bindings");
}
