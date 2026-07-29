export function buildRepAssignedNotifications(repName: string, projectName: string) {
  const subject = "【SciManage】您已被指定为项目代表: " + projectName;
  const text = "您好 " + repName + "，\n\n您已被指定为项目 \"" + projectName + "\" 的代表。\n\n---\nSciManage";
  const html = "<p>您好 <strong>" + repName + "</strong>，</p>\n<p>您已被指定为项目 <strong>\"" + projectName + "\"</strong> 的代表。</p>\n<hr />\n<p style=\"color:#999;font-size:12px;\">SciManage</p>";
  return [{ subject, text, html }];
}
