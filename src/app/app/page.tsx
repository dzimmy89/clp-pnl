import type { Metadata } from "next";
import { Dashboard } from "@/components/dashboard";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default function AppPage() {
  return <Dashboard />;
}
