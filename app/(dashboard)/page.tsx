"use client";
import { useSearchParams } from "next/navigation";
import { useOrganization } from "@clerk/nextjs";
import { EmptyOrg } from "./_components/empty-org";
import { BoardList } from "./_components/board-list";

export default function DashboardPage() {
  const params = useSearchParams();
  const search = params.get("search") ?? undefined;
  const favorites = params.get("favorites") ?? undefined;
  const { organization } = useOrganization();

  return (
    <div className="flex-1 h-[calc(100%-80px)] p-6">
      {!organization ? <EmptyOrg /> : 
        <BoardList
            orgId={organization.id}
            query={{ search, favorites }}
        />
        
    }
    </div>
  );
}
