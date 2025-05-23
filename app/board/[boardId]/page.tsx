import { Room } from "@/components/room";
import { BoardCanvas } from "./_components/canvas";
import { CanvasLoading } from "./_components/canvas-loading";


export default async function BoardIdPage({
  params,
}: {
  params: Promise<{ boardId: string }>;
}) {
  const { boardId } = await params;

  return (
    <Room roomId={boardId} fallback={<CanvasLoading />}>
      <BoardCanvas boardId={boardId} />
    </Room>
  );
}