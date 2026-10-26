"use client";

import { UserButton } from "@/components/auth/user-button";
import { SearchInput } from "./sidebar/search-input";

export const Navbar = () => {

    return (
        <div className="flex items-center gap-x-4 p-5">
            <div className="hidden lg:flex lg:flex-1 ">
               <SearchInput/>
            </div>
            <div className="block lg:hidden flex-1">
                <span className="font-semibold">Rimo</span>
            </div>
            <UserButton/>
        </div>
    );
}
