import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { AppShell } from "../../../components/shell/app-shell";
import { normalizeProjectId } from "../../../lib/projects/project-id";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
};

export default async function ProjectLayout({ children, params }: LayoutProps) {
  const { projectId } = await params;
  const normalizedProjectId = normalizeProjectId(projectId);
  if (!normalizedProjectId) notFound();

  return <AppShell projectId={normalizedProjectId}>{children}</AppShell>;
}
