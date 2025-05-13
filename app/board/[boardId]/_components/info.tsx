"use client";

import { Skeleton } from "@/components/ui/skeleton";

export const BoardInfo = () => {
    return (
        <div className="absolute flex top-2 left-2 h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4">
            <h1>todo: inform about the board</h1>
        </div>
    );
};

export const BoardInfoSkeleton = () => {
    return (
        <div className="absolute flex top-2 left-2 h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4 gap-3 w-[300px]">
            <Skeleton className="h-6 w-6 rounded" /> 
            <Skeleton className="h-4 w-40 rounded" /> 
        </div>
    );
};