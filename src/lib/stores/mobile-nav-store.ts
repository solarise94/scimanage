import { create } from "zustand";

interface MobileNavStore {
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  setDrawerOpen: (open: boolean) => void;
}

export const useMobileNavStore = create<MobileNavStore>((set) => ({
  drawerOpen: false,
  openDrawer: () => set({ drawerOpen: true }),
  closeDrawer: () => set({ drawerOpen: false }),
  setDrawerOpen: (open) => set({ drawerOpen: open }),
}));
