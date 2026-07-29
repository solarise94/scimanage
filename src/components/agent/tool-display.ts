/**
 * 工具调用的简短中文标签（聊天流内嵌紧凑行用）。
 * 覆盖高频工具；未命中时回退为原始 actionKey。
 */
const TOOL_DISPLAY_LABELS: Record<string, string> = {
  "orders.search": "搜索订单",
  "orders.list_pending_receipts": "查询待回款订单",
  "orders.get_finance_snapshot": "读取订单财务摘要",
  "finance.get_invoice_detail": "查看发票详情",
  "orders.get_detail": "读取订单详情",
  "orders.create": "新建订单",
  "orders.update": "更新订单",
  "crm.search_customers": "搜索客户",
  "crm.search_customers_by_pinyin": "拼音搜索客户",
  "crm.resolve_customer_name": "解析客户姓名",
  "crm.get_customer_context": "读取客户档案",
  "crm.create_interaction": "记录沟通",
  "crm.prepare_visit_checkin": "准备签到",
  "crm.create_visit_checkin": "拜访签到",
  "crm.create_followup_task": "创建跟进任务",
  "projects.search": "搜索项目",
  "projects.get_summary": "读取项目摘要",
  "finance.register_issued_invoice": "登记已开发票",
  "agent.recall_memory": "召回记忆",
  "agent.save_memory": "记录偏好",
  "agent.web_search": "联网搜索",
};

export function friendlyToolLabel(toolName: string, fallback?: string): string {
  return TOOL_DISPLAY_LABELS[toolName] || fallback || toolName;
}
