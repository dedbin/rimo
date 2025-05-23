'use client';

import { List } from './list';
import { NewButton } from './new-button';
import { LanguageSwitcher } from './language-switcher';

export const Sidebar = () => {
  return (
    <aside className="fixed left-0 h-screen w-[60px] bg-blue-800 text-white flex flex-col">
      <div className="flex-1 overflow-y-auto w-full flex flex-col items-center pt-4 gap-y-4">
        <ul className="w-full space-y-4">
          <List />
        </ul>
        <NewButton />
      </div>
      <div className="pb-4 flex justify-center">
        <LanguageSwitcher />
      </div>
    </aside>
  );
};
