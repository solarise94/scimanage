"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectDisplay,
} from "@/components/ui/select";
import { contractKeys } from "@/lib/contracts/query-keys";
import {
  CONTRACT_CATEGORY_LABELS,
} from "@/lib/contracts/constants";
import { TEMPLATE_VARIABLES } from "@/lib/contracts/template-variables";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "sonner";
import {
  Plus,
  Download,
  Pencil,
  Archive,
  Loader2,
  FileText,
} from "lucide-react";

export default function ContractTemplatesPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [categoryFilter, setCategoryFilter] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [showVariables, setShowVariables] = useState(false);

  // 上传表单
  const [upName, setUpName] = useState("");
  const [upCategory, setUpCategory] = useState("SEQUENCING");
  const [upDesc, setUpDesc] = useState("");
  const [upIsDefault, setUpIsDefault] = useState(false);
  const [upFile, setUpFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // 编辑表单
  const [edName, setEdName] = useState("");
  const [edCategory, setEdCategory] = useState("");
  const [edDesc, setEdDesc] = useState("");
  const [edIsDefault, setEdIsDefault] = useState(false);
  const [edArchived, setEdArchived] = useState(false);
  const [saving, setSaving] = useState(false);

  const params: Record<string, unknown> = {};
  if (categoryFilter) params.category = categoryFilter;

  const { data, isLoading, refetch } = useQuery({
    queryKey: contractKeys.templates.list(params),
    queryFn: async () => {
      const sp = new URLSearchParams();
      if (categoryFilter) sp.set("category", categoryFilter);
      const res = await fetch(`/api/contracts/templates?${sp.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch templates");
      return res.json();
    },
    enabled: status === "authenticated" && session?.user?.role === "ADMIN",
  });

  // 权限检查
  if (status === "loading") return null;
  if (status === "unauthenticated") {
    router.push("/login");
    return null;
  }
  if (session?.user?.role !== "ADMIN") {
    router.push("/");
    return null;
  }

  const templates = (data?.templates || []) as Array<Record<string, unknown>>;

  const handleUpload = async () => {
    if (!upFile || !upName.trim()) {
      toast.error("请填写模板名称并选择文件");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", upFile);
      fd.append("name", upName.trim());
      fd.append("category", upCategory);
      if (upDesc) fd.append("description", upDesc.trim());
      if (upIsDefault) fd.append("isDefault", "true");

      const res = await fetch("/api/contracts/templates", {
        method: "POST",
        body: fd,
      });
      const result = await res.json();
      if (!res.ok) {
        if (result.unknown?.length > 0) {
          toast.error(
            `模板含未知变量: ${result.unknown.join(", ")}。请检查占位符拼写。`
          );
        } else {
          throw new Error(result.error || "上传失败");
        }
        return;
      }
      toast.success("模板上传成功");
      setUploadOpen(false);
      setUpName("");
      setUpDesc("");
      setUpIsDefault(false);
      setUpFile(null);
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const handleEdit = async () => {
    if (!editTarget) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/contracts/templates/${editTarget.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: edName.trim(),
            category: edCategory,
            description: edDesc.trim() || null,
            isDefault: edIsDefault,
            archived: edArchived,
          }),
        }
      );
      if (!res.ok) throw new Error("更新失败");
      toast.success("模板已更新");
      setEditOpen(false);
      setEditTarget(null);
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新失败");
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (id: string) => {
    try {
      const res = await fetch(`/api/contracts/templates/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("归档失败");
      toast.success("模板已归档");
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "归档失败");
    }
  };

  const handleDownload = (id: string) => {
    window.open(`/api/contracts/templates/${id}/download`, "_blank");
  };

  const openEdit = (t: Record<string, unknown>) => {
    setEditTarget(t);
    setEdName((t.name as string) || "");
    setEdCategory((t.category as string) || "SEQUENCING");
    setEdDesc((t.description as string) || "");
    setEdIsDefault(!!t.isDefault);
    setEdArchived(!!t.archived);
    setEditOpen(true);
  };

  return (
    <PageShell>
      <PageHeader
        title="合同模板管理"
        description="维护 .docx 合同模板库，系统根据模板变量字典自动校验占位符"
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowVariables(!showVariables)}
            >
              <FileText className="mr-1 h-4 w-4" />
              变量字典
            </Button>
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              <Plus className="mr-1 h-4 w-4" />
              上传模板
            </Button>
          </div>
        }
      />

      {/* 变量字典面板 */}
      {showVariables && (
        <Card className="p-4 mb-4">
          <h3 className="font-medium mb-2 text-sm">可用变量字典</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 text-sm">
            {TEMPLATE_VARIABLES.map((v) => (
              <div key={v.key} className="flex items-center gap-2">
                <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">
                  {"{" + v.key + "}"}
                </code>
                <span className="text-muted-foreground">{v.label}</span>
                {v.required && (
                  <Badge variant="outline" className="text-[10px] h-4">
                    必填
                  </Badge>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            行项目循环内可用：{"{index}"} {"{itemName}"} {"{spec}"}{" "}
            {"{quantity}"} {"{unit}"} {"{unitPrice}"} {"{amount}"}
          </p>
        </Card>
      )}

      {/* 类型筛选 */}
      <div className="flex gap-2 mb-4">
        <Button
          variant={!categoryFilter ? "default" : "outline"}
          size="sm"
          onClick={() => setCategoryFilter("")}
        >
          全部
        </Button>
        {Object.entries(CONTRACT_CATEGORY_LABELS).map(([value, label]) => (
          <Button
            key={value}
            variant={categoryFilter === value ? "default" : "outline"}
            size="sm"
            onClick={() => setCategoryFilter(value)}
          >
            {label}
          </Button>
        ))}
      </div>

      {/* 模板列表 */}
      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : templates.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <FileText className="mx-auto h-10 w-10 mb-2 opacity-30" />
          <p>暂无合同模板</p>
          <p className="text-xs mt-1">
            点击上方&ldquo;上传模板&rdquo;添加 .docx 模板文件
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {templates.map((t) => (
            <Card key={t.id as string} className="p-4">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">
                      {t.name as string}
                    </span>
                    <Badge variant="outline" className="text-[10px] h-4">
                      {
                        CONTRACT_CATEGORY_LABELS[
                          (t.category as string) || ""
                        ] || (t.category as string)
                      }
                    </Badge>
                    {t.isDefault ? (
                      <Badge className="text-[10px] h-4 bg-success-bg text-success border-success-border">
                        默认
                      </Badge>
                    ) : null}
                    {t.archived ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] h-4 text-muted-foreground"
                      >
                        已归档
                      </Badge>
                    ) : null}
                  </div>
                  {(t.description as string) && (
                    <p className="text-xs text-muted-foreground">
                      {t.description as string}
                    </p>
                  )}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>
                      文件名: {t.fileName as string}
                    </span>
                    <span>
                      变量数:{" "}
                      {t.detectedVariables
                        ? JSON.parse(t.detectedVariables as string).length
                        : 0}
                    </span>
                    <span>创建时间: {(t.createdAt as string)?.slice(0, 10)}</span>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleDownload(t.id as string)}
                    title="下载模板"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => openEdit(t)}
                    title="编辑"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {!t.archived && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      onClick={() => handleArchive(t.id as string)}
                      title="归档"
                    >
                      <Archive className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* 上传弹窗 */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>上传合同模板</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <Label>模板名称 *</Label>
              <Input
                value={upName}
                onChange={(e) => setUpName(e.target.value)}
                placeholder="如：标准测序服务合同"
                className="h-9 mt-1"
              />
            </div>
            <div>
              <Label>合同类型</Label>
              <Select value={upCategory} onValueChange={(v) => { if (v) setUpCategory(v); }}>
                <SelectTrigger className="h-9 mt-1">
                  <SelectDisplay
                    label="类型"
                    valueLabel={CONTRACT_CATEGORY_LABELS[upCategory] || upCategory}
                  />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CONTRACT_CATEGORY_LABELS).map(
                    ([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>描述</Label>
              <Input
                value={upDesc}
                onChange={(e) => setUpDesc(e.target.value)}
                placeholder="可选"
                className="h-9 mt-1"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="upIsDefault"
                checked={upIsDefault}
                onChange={(e) => setUpIsDefault(e.target.checked)}
              />
              <Label htmlFor="upIsDefault">设为该类型的默认模板</Label>
            </div>
            <div>
              <Label>.docx 文件 *</Label>
              <Input
                type="file"
                accept=".docx"
                onChange={(e) => setUpFile(e.target.files?.[0] || null)}
                className="h-9 mt-1"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setUploadOpen(false)}
                disabled={uploading}
              >
                取消
              </Button>
              <Button onClick={handleUpload} disabled={uploading}>
                {uploading && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                上传
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 编辑弹窗 */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>编辑模板</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <Label>模板名称</Label>
              <Input
                value={edName}
                onChange={(e) => setEdName(e.target.value)}
                className="h-9 mt-1"
              />
            </div>
            <div>
              <Label>合同类型</Label>
              <Select value={edCategory} onValueChange={(v) => { if (v) setEdCategory(v); }}>
                <SelectTrigger className="h-9 mt-1">
                  <SelectDisplay
                    label="类型"
                    valueLabel={CONTRACT_CATEGORY_LABELS[edCategory] || edCategory}
                  />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CONTRACT_CATEGORY_LABELS).map(
                    ([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>描述</Label>
              <Input
                value={edDesc}
                onChange={(e) => setEdDesc(e.target.value)}
                className="h-9 mt-1"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="edIsDefault"
                checked={edIsDefault}
                onChange={(e) => setEdIsDefault(e.target.checked)}
              />
              <Label htmlFor="edIsDefault">设为该类型的默认模板</Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="edArchived"
                checked={edArchived}
                onChange={(e) => setEdArchived(e.target.checked)}
              />
              <Label htmlFor="edArchived">归档（软删除）</Label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setEditOpen(false)}
                disabled={saving}
              >
                取消
              </Button>
              <Button onClick={handleEdit} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
