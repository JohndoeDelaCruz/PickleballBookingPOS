"use client";

import { createContext, useContext } from "react";

export const WorkspaceContext = createContext<{
  courtCount?: number;
  totalCourtCount?: number;
  setPendingCount: (count: number) => void;
} | null>(null);

export function useWorkspace() {
  return useContext(WorkspaceContext);
}
