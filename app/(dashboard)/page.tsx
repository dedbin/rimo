"use client";
import { useSearchParams } from "next/navigation";
import { BoardList } from "./_components/board-list";

export default function DashboardPage() {
  const params = useSearchParams();
  const search = params.get("search") ?? undefined;
  const favorites = params.get("favorites") ?? undefined;

  return (
    <div className="flex-1 h-[calc(100%-80px)] p-6">
        <BoardList
            query={{ search, favorites }}
        />
        
    </div>
  );
}
