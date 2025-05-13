import { BoardCanvas } from "./_components/canvas";

interface BoardIdPageProps {
    params:{
        boardId: string;
    };
};

const BoardIdPage = ({params}: BoardIdPageProps) => {
    return ( 
        <div className="h-screen">
            <h1>Board  Page</h1>
            <BoardCanvas boardId={params.boardId}/>
        </div>
     );
}
 
export default BoardIdPage;