# Portals 目录（设计文档 §2.3）

按 Portal 边界渐进整理的页面壳、导航与流程 orchestration。**领域服务禁止复制到这里**
——所有写操作必须调用 `src/lib/{orders,finance,crm,supply-chain,...}` 中的共享 canonical service。

目录约定：

- `shared/`：两门户共享的页面壳、表格、表单组件（纯展示，不含部门/门户判断）。
- `field-sales/`：地推门户（31080）专属页面、导航项、流程编排。
- `online-ops/`：网络运营门户（32080）专属页面、导航项、流程编排。

差异收敛方式（设计 §2.3）：避免在页面里散布 `process.env.PORTAL_CODE === ...`，
集中到 `src/lib/portal/config.ts` 的 capability 与本目录下的 registry。

当前状态（模块 D6）：
- `online-ops/` 已落地客服账号管理（P1）与销量看板（P2）的页面组件与导航。
- `field-sales/` 现有页面仍在 `src/app/**` 下，未做大爆炸重构；本目录暂为骨架。
