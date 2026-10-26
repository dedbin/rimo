"use client";

import { UserButton } from "@/components/auth/user-button";
import { SearchInput } from "./sidebar/search-input";
import { BoardArchiveActions } from "@/components/board-archive-actions";
import { authClient } from "@/lib/auth-client";

export const Navbar = () => {
    const { data: session } = authClient.useSession();

    return (
        <div className="flex items-center gap-x-4 p-5">
            <div className="hidden lg:flex lg:flex-1 ">
               <SearchInput/>
            </div>
            <div className="block lg:hidden flex-1">
                <span className="font-semibold">Rimo</span>
            </div>
            {session && !session.user.isAnonymous && <BoardArchiveActions />}
            <UserButton/>
        </div>
    );
}
