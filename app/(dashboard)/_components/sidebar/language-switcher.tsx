'use client';

import { useTranslation } from '@/hooks/use-translation';
import { Globe } from 'lucide-react';
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger 
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export const LanguageSwitcher = () => {
  const { t, changeLanguage, currentLanguage } = useTranslation();

  return (
    <div>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button 
                className="h-[48px] w-[48px] flex items-center justify-center rounded-md hover:bg-white/10 transition"
                aria-label={t('sidebar.language')}
              >
                <Globe className="h-5 w-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent 
              side="right" 
              align="start" 
              className="ml-2 p-2"
            >
              <DropdownMenuItem 
                onClick={() => changeLanguage('en')}
                className={`cursor-pointer ${currentLanguage === 'en' ? 'font-bold' : ''}`}
              >
                {currentLanguage === 'en' && '✓ '}{t('sidebar.english')}
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => changeLanguage('ru')}
                className={`cursor-pointer ${currentLanguage === 'ru' ? 'font-bold' : ''}`}
              >
                {currentLanguage === 'ru' && '✓ '}{t('sidebar.russian')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipTrigger>
        <TooltipContent side="right" className="flex items-center">
          {t('sidebar.language')}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};
