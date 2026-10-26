"use client";

import Image from "next/image";
import Link from "next/link";

export const List = () => {
    
    return (
        <li className="flex w-full justify-center">
          <Link href="/" aria-label="Мои доски" className="relative h-10 w-10 rounded-md bg-white p-1">
            <Image src="/logo.svg" alt="Rimo" width={32} height={32} />
          </Link>
        </li>
    );
};
