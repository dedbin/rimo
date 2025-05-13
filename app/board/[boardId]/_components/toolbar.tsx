export const BoardToolbar = () => {
    return (
        <div className="absolute top-1/2 left-2 transform -translate-y-1/2 flex flex-col gap-4">
            <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col gap-y-1 items-center">
                <div>
                    pencil
                </div>
                <div>
                    circle
                </div>
                <div>
                    square
                </div>
                <div>
                    triangle
                </div>
            </div>
            <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col items-center">
                <div>
                    undo
                </div>
                <div>
                    undo
                </div>
            </div>
        </div>
    );
};

export const BoardToolbarSkeleton = () => {
    return (
        <div className="absolute top-1/2 left-2 transform -translate-y-1/2 flex flex-col gap-4">
            <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col gap-y-2 items-center">
                {[...Array(4)].map((_, i) => (
                    <div key={`tool-skel-${i}`} className="h-8 w-8 bg-muted animate-pulse rounded" />
                ))}
            </div>
            <div className="bg-white rounded-md shadow-md p-1.5 flex flex-col gap-y-2 items-center">
                {[...Array(2)].map((_, i) => (
                    <div key={`action-skel-${i}`} className="h-8 w-8 bg-muted animate-pulse rounded" />
                ))}
            </div>
        </div>
    );
};