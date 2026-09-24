import { Suspense } from "react";
import { WorkbenchClient } from "../../../components/workbench-client";
export default function DashboardPage() {
  return (
    <div className="page-wrap">
      <Suspense>
        <WorkbenchClient />
      </Suspense>
    </div>
  );
}
