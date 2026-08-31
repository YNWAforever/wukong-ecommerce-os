import { CapabilityRegistryPanel } from "../../../components/capability-registry-panel";

// Deliberately no role gate here (unlike /admin/page.tsx's redirect for
// non-admins) -- /system-map is open to any authenticated workspace member,
// matching /jobs's and /catalog's existing precedent. Authentication (not
// authorization) is enforced by apps/web/middleware.ts's session-cookie
// check; CapabilityRegistryPanel itself has no role check baked in either.
export default function SystemMapPage() {
  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            System map <span>ECOMMERCE OS CONTROL PLANE</span>
          </p>
          <h1>系統能力現況，公開透明。</h1>
          <p className="lede">
            每項功能的真實狀態 -- 已上線、試行中、規劃中或已封鎖 --
            與 /admin 的「系統真相」分頁完全一致，同一份資料來源。
          </p>
        </div>
      </div>
      <CapabilityRegistryPanel />
    </div>
  );
}
