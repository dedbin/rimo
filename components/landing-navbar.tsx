"use client";

import Link from "next/link";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import React from "react";
import { SignInButton, UserButton, useAuth } from "@clerk/clerk-react";
import { usePointerGlow } from "@/hooks/use-pointer-glow";

export const RimoNavbar = () => {
  const { isSignedIn } = useAuth();
  usePointerGlow();
  return (
    <nav className="p-4 bg-transparent flex items-center justify-between">
      <Link href="/" className="flex items-center">
        <div className="relative h-10 w-10 mr-4 text-green-500">
          <Image
            src="/logo.svg"
            alt="Логотип Rimo"
            fill
            priority
            className="object-contain [filter:invert(52%)_sepia(93%)_saturate(4276%)_hue-rotate(136deg)_brightness(102%)_contrast(94%)]"
          />
        </div>
        <h1 className={cn("text-2xl font-bold text-white")}>Rimo</h1>
      </Link>
      <div className="flex items-center gap-x-4">
        {isSignedIn ? (
          <>
            <Link href="/boards">
              <Button className="rounded-full">Мои доски</Button>
            </Link>
            <UserButton />
          </>
        ) : (
          <SignInButton>
            <Button
              data-glow
              className="rounded-full px-8 py-3 text-lg"
            >
              <span>Войти</span>
            </Button>
          </SignInButton>
        )}
      </div>
    </nav>
  );
};
