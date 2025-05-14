"use client";

import React, { useState } from "react";
import TypeWriterComponent from "typewriter-effect";
import { Button } from "./ui/button";
import { SignInButton, useAuth } from "@clerk/clerk-react";
import Link from "next/link";

export const RimoHero = () => {
  const { isSignedIn } = useAuth();
  const [coords, setCoords] = useState({ x: "50%", y: "50%" });

  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setCoords({ x: `${x}%`, y: `${y}%` });
  };
  return(
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
                className="relative overflow-hidden rounded-full px-8 py-3 text-lg font-semibold border-2 border-white"

                onMouseMove={handleMouseMove}
                style={{
                  background: `radial-gradient(circle at ${coords.x} ${coords.y}, rgba(255,255,255,0.15), transparent 40%)`,
                  transition: "background 0.3s ease-out",
                }}
              >
                <span className="relative z-10">Попробовать бесплатно</span>
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