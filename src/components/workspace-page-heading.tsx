import type { ReactNode } from "react";

export function WorkspacePageHeading({ title, description, actions }: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return <div className="console-page-heading workspace-page-heading">
    <div><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className="heading-actions">{actions}</div>}
  </div>;
}
