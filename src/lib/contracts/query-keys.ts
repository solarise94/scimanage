export const contractKeys = {
  all: ["contracts"] as const,
  lists: () => [...contractKeys.all, "list"] as const,
  list: (params: Record<string, unknown>) =>
    [...contractKeys.lists(), params] as const,
  details: () => [...contractKeys.all, "detail"] as const,
  detail: (id: string) => [...contractKeys.details(), id] as const,
  templates: {
    all: ["contract-templates"] as const,
    lists: () => [...contractKeys.templates.all, "list"] as const,
    list: (params: Record<string, unknown>) =>
      [...contractKeys.templates.lists(), params] as const,
  },
};
