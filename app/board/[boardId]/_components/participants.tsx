import { Skeleton } from "@/components/ui/skeleton";

export const BoardParticipants = () => {
    return (
        <div className="absolute flex top-2 right-2 h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4">
            <h1>todo: inform about the participants</h1>
        </div>
    );
};

BoardParticipants.Skeleton = function ParticipantsSkeleton() {
    return (
        <div className="absolute flex top-2 right-2 h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4 gap-2">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-4 w-20 rounded" />
        </div>
    );
};