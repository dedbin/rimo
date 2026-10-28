"use client";

import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";
import useSWR from "swr";
import Image from "next/image";
import localFont from "next/font/local";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { requestJson } from "@/lib/api-client";
import { BoardSummary } from "@/types/service";
import { useBoardRole, useBoardRuntime, useBoardSnapshot, useConnectionState, useSelection } from "@/lib/collaboration/react";
import { Hint } from "@/components/hint";
import { useRenameModal } from "@/store/use-rename-modal";
import { BoardCopyLinkAction } from "@/components/copy-link";
import { BoardShareButton } from "@/components/board-share-button";
import { BoardArchiveActions } from "@/components/board-archive-actions";
import { BoardExportDialog } from "@/components/board-export-dialog";
import { useTranslation } from "@/hooks/use-translation";

const font = localFont({
  src: "../../../../node_modules/@fontsource/poppins/files/poppins-latin-600-normal.woff2",
  weight: "600",
  display: "swap",
});

interface BoardInfoProps {
  boardId: string;
}

const TabSeparator = () => {
  return <div className="text-neutral-300 px-1.5">|</div>;
};

export const BoardInfo = ({ boardId }: BoardInfoProps) => {
  const { handleOpen } = useRenameModal();
  const { t } = useTranslation();

  const runtime = useBoardRuntime();
  const role = useBoardRole();
  const snapshot = useBoardSnapshot();
  const selection = useSelection();
  const connection = useConnectionState();
  const result = useSWR(`/api/boards/${encodeURIComponent(boardId)}`, requestJson<{ board: BoardSummary }>, {
    fallbackData: { board: runtime.session.board },
  });
  const data = result.data?.board ?? runtime.session.board;

  return (
    <div className="absolute flex top-2 left-2 h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4">
      <Hint label={t("boardInfo.goHome")} side="bottom" sideOffset={10}>
        <Button asChild variant="board" className="px-2">
          <Link href="/">
            <div className="flex items-center">
              <Image
                src="/logo.svg"
                alt="logo"
                width={40}
                height={40}
                priority
                className="w-8 h-8 rounded-full"
              />
              <span
                className={cn(
                  "font-semibold text-xl ml-2 text-black",
                  font.className
                )}
              >
                rimo
              </span>
            </div>
          </Link>
        </Button>
      </Hint>
      <TabSeparator />
      <Hint
        label={t("boardInfo.editTitle")}
        side="bottom"
        sideOffset={10}
      >
        <Button
          variant="board"
          className="px-2 text-base font-normal"
          disabled={role !== "owner"}
          onClick={() => handleOpen(data.id, data.title)}
        >
          {data.title}
        </Button>
      </Hint>
      <TabSeparator />
      <BoardCopyLinkAction boardId={data.id}>
        {role === "owner" && <BoardArchiveActions boardId={data.id}
          revision={connection.revision} disabled={!connection.saved || !connection.connected} />}
      </BoardCopyLinkAction>
      {role === "owner" && <BoardShareButton boardId={data.id} />}
      <BoardExportDialog boardId={data.id} revision={connection.revision}
        saved={connection.saved && connection.connected} canEdit={runtime.board.canEdit}
        selection={selection} snapshot={snapshot}
        onCreateFrame={(frame) => { runtime.board.createFrame(frame); }}
        onRenameFrame={(id, name) => runtime.board.updateFrame(id, { name })}
        onRemoveFrame={(id) => runtime.board.removeFrame(id)}
        onFrameOrderChange={(ids) => runtime.board.reorderFrames(ids)} />
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
