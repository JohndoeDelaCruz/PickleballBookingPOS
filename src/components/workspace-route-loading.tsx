"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { workspaceView } from "@/lib/workspace";
import { useWorkspace } from "./workspace-context";
import { WorkspaceSkeleton } from "./workspace-skeleton";

export function WorkspaceRouteLoading() {
  const path = usePathname();
  const params = useSearchParams();
  const workspace = useWorkspace();
  const view = workspaceView(path, params.get("tab"));
  const skeleton = <WorkspaceSkeleton view={view}
    courtCount={view === "finance" ? workspace?.totalCourtCount : workspace?.courtCount} totalCourtCount={workspace?.totalCourtCount} />;
  if (workspace) return path === "/staff" ? <div className={`console-content${view === "pos" ? " pos-content" : ""}`}>{skeleton}</div> : skeleton;
  return <main id="main" className="container content-page">{skeleton}</main>;
}
