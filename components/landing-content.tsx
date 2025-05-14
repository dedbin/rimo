"use client";

import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

const features = [
  {
    title: "Совместная работа в режиме реального времени",
    description: "Мгновенно видьте курсоры коллег и правки прямо на доске.",
  },
  {
    title: "Бесконечное полотно",
    description: "Рисуйте, добавляйте фигуры и расширяйте пространство без ограничений.",
  },
  {
    title: "Библиотека шаблонов (в разработке)",
    description: "Начинайте работу быстро с готовыми шаблонами для мозговых штурмов, ретроспектив и не только.",
  },
  {
    title: "Интеграции (в разработке)",
    description: "Интегрируйтесь со Slack, Teams и другими инструментами для бесшовного рабочего процесса.",
  },
];

export const RimoContent = () => (
  <div className="px-10 pb-20">
    <h2 className="text-4xl font-extrabold text-white text-center mb-10">
      Ключевые возможности
    </h2>
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {features.map((f) => (
        <Card key={f.title} className="bg-zinc-800 text-white">
          <CardHeader>
            <CardTitle className="text-lg">{f.title}</CardTitle>
            <CardContent className="pt-4 px-0">{f.description}</CardContent>
          </CardHeader>
        </Card>
      ))}
    </div>
  </div>
);
