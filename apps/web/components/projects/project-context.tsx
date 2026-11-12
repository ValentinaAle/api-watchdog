"use client";

import { createContext, useContext, type ReactNode } from "react";

const ProjectIdContext = createContext<string | undefined>(undefined);

export function ProjectIdProvider({ children, projectId }: { children: ReactNode; projectId?: string }) {
  return <ProjectIdContext.Provider value={projectId}>{children}</ProjectIdContext.Provider>;
}

export function useProjectId() {
  return useContext(ProjectIdContext);
}
