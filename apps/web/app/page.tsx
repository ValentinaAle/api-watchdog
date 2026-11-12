import { AppShell } from "../components/shell/app-shell";
import { Dashboard } from "../components/dashboard/dashboard";

export default function HomePage() {
  return (
    <AppShell>
      <Dashboard />
    </AppShell>
  );
}
