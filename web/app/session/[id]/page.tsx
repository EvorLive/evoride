import Sidebar from "@/components/Sidebar";
import SessionView from "./SessionView";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="flex h-full flex-1 overflow-hidden">
      <Sidebar activeId={id} />
      <SessionView sessionId={id} />
    </div>
  );
}
