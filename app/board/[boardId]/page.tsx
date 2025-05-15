import { Room } from "@/components/room";
import { BoardCanvas } from "./_components/canvas";
import { CanvasLoading } from "./_components/canvas-loading";

interface BoardIdPageProps {
    params:{
        boardId: string;
    };
};

async function BoardIdPage ({params}: BoardIdPageProps) {
    const { boardId } = await params;
    return ( 
        <Room roomId={boardId} fallback={<CanvasLoading/>}>
            <BoardCanvas boardId={boardId}/>
        </Room>
     );
}
 
export default BoardIdPage;