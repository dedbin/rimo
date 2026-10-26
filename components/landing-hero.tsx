"use client";

import React from "react";
import TypeWriterComponent from "typewriter-effect";
import { Button } from "./ui/button";
import { SignInButton } from "@/components/auth/sign-in-button";
import { authClient } from "@/lib/auth-client";
import Link from "next/link";
import { usePointerGlow } from "@/hooks/use-pointer-glow";

export const RimoHero = () => {
  const { data: session } = authClient.useSession();
  const isSignedIn = !!session;
  usePointerGlow();

  return (
    <div className="text-white font-bold py-36 text-center space-y-5">
      <div className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl space-y-5 font-extrabold">
        <h1>
          Лучший инструмент для <span className="text-emerald-500">совместной работы</span> на виртуальной доске для
        </h1>
        <div className="text-transparent bg-clip-text bg-gradient-to-r from-purple-500 to-pink-600 py-4">
          <TypeWriterComponent
            options={{
              strings: [
                "генерации идей.",
                "командного планирования.",
                "дистанционного обучения.",
                "дизайн-спринтов.",
              ],
              autoStart: true,
              loop: true,
            }}
          />
        </div>
        <div className="text-sm md:text-xl font-light text-zinc-400">
          Сотрудничайте в режиме реального времени, где угодно
        </div>
        <div>
          {isSignedIn ? (
            <Link href="/">
              <Button variant="default" size="lg" className="md:text-lg p-4 md:p-6 rounded-full font-semibold">
                Перейти к доскам
              </Button>
            </Link>
          ) : (
            <SignInButton>
              <Button
                variant="default"
                size="lg"
                data-glow
                className="rounded-full px-8 py-3 text-lg font-semibold border-2 border-white"
              >
                <span>Попробовать бесплатно</span>
              </Button>
            </SignInButton>
          )}
        </div>
        <div className="text-zinc-400 text-xs md:text-sm font-normal">
          Бесплатно для команд любого размера
        </div>
      </div>
    </div>
  );
};
