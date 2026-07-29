import { redirect } from "next/navigation";

export default async function CustomerPoolRedirectPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) ?? {};
  const target = new URLSearchParams();

  const pick = (key: string) => {
    const v = sp[key];
    return typeof v === "string" ? v : undefined;
  };

  const organizationId = pick("organizationId");
  const search = pick("search");
  const siteId = pick("siteId");

  if (organizationId) target.set("organizationId", organizationId);
  if (search) target.set("search", search);
  if (siteId) target.set("siteId", siteId);

  const qs = target.toString();
  redirect(`/crm/organization-flow${qs ? `?${qs}` : ""}`);
}
