import { Room } from "@/components/room";
import { BoardCanvas } from "./_components/canvas";
import { CanvasLoading } from "./_components/canvas-loading";

interface BoardIdPageProps {
    params:{
        boardId: string;
    };
};

const BoardIdPage = ({params}: BoardIdPageProps) => {
    return ( 
        <Room roomId={params.boardId} fallback={<CanvasLoading/>}>
            <BoardCanvas boardId={params.boardId}/>
        </Room>
     );
}
 
export default BoardIdPage;